# Edge

The ingest Worker: it authenticates a sender, decodes Prometheus Remote Write or OTLP
metrics into `VZB1` batches (`contracts/BATCH.md`), routes them to shard slots and answers
only once every shard has durably appended. For now it ships in one script with the shard
(`src/index.ts` re-exports `Shard`, bound as `SHARD`), so the tests run against the real
Durable Object.

| File | Contents |
|---|---|
| `src/index.ts` | Routes, body reading with size limits, gzip, protocol responses |
| `src/auth.ts` | API keys: parsing, KV lookup with a short cache, constant-time check, scopes |
| `src/batch.ts` | Canonical labels, series ids, `Collector` (validation shared by all decoders), `VZB1` encoder and batch splitting |
| `src/prw.ts` | Remote Write 1.0 decoder |
| `src/otlp.ts` | OTLP metrics decoders (protobuf, JSON), OpenTelemetry → Prometheus mapping, response bodies |
| `src/route.ts` | Pool maps, routing, concurrent appends, epoch refetch |
| `src/pb.ts`, `src/snappy.ts` | Protobuf wire reader and snappy block decompressor; no dependencies |
| `src/limits.ts` | Limits and the accept window, with defaults |
| `src/meter.ts` | Decode limits counted before anything is built: values per item, JSON structural characters (D71) |
| `src/recorded.ts` | `RecordedSamples`: the entrypoint the ruler writes recording-rule samples to over a service binding (contracts/ingest.ts) |

There are no runtime dependencies. `snappyjs` and `protobufjs` are dev dependencies, used
only to cross-check the hand-written codecs.

## Endpoints

| | |
|---|---|
| `POST /api/v1/write` | Remote Write 1.0: snappy block-compressed `prometheus.WriteRequest` |
| `POST /v1/metrics` | OTLP/HTTP metrics, `application/x-protobuf` or `application/json`, optionally `Content-Encoding: gzip` |
| `GET /healthz` | `200 ok` |

And one RPC entrypoint, reachable only through a service binding (never over HTTP):

| Entrypoint | Method |
|---|---|
| `RecordedSamples` (contracts/ingest.ts) | `write(tenant, batches: SampleBatch[]): Promise<void>`: the ruler's recording-rule output |

Bindings: `SHARD` (Durable Object namespace), `CONFIG` (KV), `DEFAULT_POOL` (JSON `PoolMap`
for tenants without their own), and optionally `INGEST_LIMITS` (JSON overriding any field
of `Limits`).

KV layout:

- `key:<keyId>` → `{ "tenant": "...", "secretSha256": "<hex>", "scopes": ["write"], "disabled": false }`
- `pool:<tenant>` → a `PoolMap` (`{ pool, slots, spread, epoch }`)

## What is implemented

**Auth.** Keys are `viz_<keyId>_<secret>` (`keyId` alphanumeric; `secret` 8–256 characters
of `A-Z a-z 0-9 _ -`), sent as `Authorization: Bearer <key>` or as the password of HTTP
Basic (any username). The SHA-256 of the secret is compared with the stored hash without
an early exit, and is computed even when the key id is unknown. The tenant is the one in
the key record; nothing in the request can change it. A record whose tenant id does not
match `TENANT_ID` authenticates nobody (review R-9): its rows could never be flushed or read. Records are cached in memory for
60 s and unknown key ids for 10 s. 401 for a missing, malformed, unknown, wrong, disabled
or unreadable key; 403 for a key without `write`. Nothing logs or echoes a credential.

**Remote Write 1.0.** Labels are hashed and copied straight from the decompressed body and
sample values are copied as their 8 wire bytes, so NaN payloads (the staleness marker
included) survive bit for bit. Labels are canonicalised: empty values dropped, sorted by
name in UTF-8 byte order, so an unsorted sender gets the same series id as a sorted one. A
series is rejected for a missing `__name__`, a duplicate name, an empty name, a NUL byte,
invalid UTF-8, too many labels, or a name or value over the length limit. Native
histograms are counted as rejected; exemplars and metadata are ignored. Remote Write 2.0
gets 415 with `Accept` hints so a sender can fall back.

**OTLP metrics.** Gauges and cumulative sums become samples. Monotonic sums get `_total`;
non-monotonic sums are gauges. Metric names are sanitised and get a unit suffix
(`s` → `_seconds`, `By` → `_bytes`, `1` → `_ratio` on gauges, `a/b` → `a_per_b`,
`{annotations}` dropped). `service.name` (prefixed by `service.namespace/` when set)
becomes `job` and `service.instance.id` becomes `instance`. Every other resource attribute
and every point attribute becomes a label with a sanitised name; a point attribute
replaces a resource attribute of the same name, and two attributes that sanitise to one
name are joined with `;`. A point flagged `NO_RECORDED_VALUE` becomes a staleness marker.
Timestamps are floored from nanoseconds to milliseconds exactly. Histograms, exponential
histograms, summaries, delta sums, sums without a temporality and points without a value
are counted in `partial_success`, with the reasons in `error_message`.

**Limits** (defaults, all overridable through `INGEST_LIMITS`):

| Limit | Default | Over the limit |
|---|---|---|
| `maxBodyBytes` (as received) | 8 MiB | 413 |
| `maxDecompressedBytes` | 8 MiB (was 32 MiB; D71) | 413; checked before snappy allocates and while gzip inflates |
| `maxDecodedBytes` | 16 MiB (D71) | 413, nothing appended: the series table (Remote Write and OTLP), counted as it is built |
| `maxJsonTokens` | 1,048,576 (D71) | 413 before parsing: structural characters (`{ [ , :`) of a JSON body outside strings |
| values per item (constant, `DECODE.maxValues`) | 65,536 key-value entries and array elements of an OTLP resource or data point, as received | that data point is rejected ("label set too large to fit one batch"); a resource over it rejects all its points. Counted before anything is built ("Memory per request") |
| `maxSeries` per request | 100,000 | 413 |
| `maxSamples` per request | 500,000 | 413 |
| `maxLabelsPerSeries` | 128 (the contract's ceiling; cannot be raised) | that series is rejected |
| `maxLabelNameBytes` / `maxLabelValueBytes` | 1,024 / 8,192 (the contract's ceilings; cannot be raised) | that series is rejected |
| `acceptBackMs` / `acceptAheadMs` | 1 h / 5 min, always clamped to 0..253,402,300,799,999 | that sample is rejected |
| `maxBatchBytes` | `MAX_BATCH_BYTES` = 1 MiB, imported from `shard/src/shard.ts` (cannot be raised) | the slot's rows are split into several batches |

**Contracts v2** (`contracts/BATCH.md`), all through `src/limits.ts` `CONTRACT`:

- **Batch cap.** The 1 MiB cap is one constant, `MAX_BATCH_BYTES`, exported by the shard
  and imported here; `INGEST_LIMITS` can lower it, not raise it. A label set that could
  not fit one batch with a single row is rejected at validation ("label set too large to
  fit one batch") instead of producing a batch the shard would refuse. If a shard still
  answers `too_large` (its cap was configured lower), the request is split again at the
  shard's `maxBytes`, once; if that is refused too the whole request gets 503 and
  `Retry-After`, never 2xx.
- **Labels.** Byte limits as above; names non-empty; no NUL byte; valid UTF-8; sorted in
  **UTF-8 byte order** (the sort always compared bytes; there is now a test with an
  astral-plane name, where JavaScript string order differs).
- **Timestamps** outside 0..253,402,300,799,999 are rejected whatever the accept window is
  configured to, so a UTC day is always `YYYY-MM-DD`.
- **OTLP routing labels.** `job` and `instance` come only from `service.namespace` /
  `service.name` and `service.instance.id`. Any other attribute that lands on those names,
  on a data point or on the resource, becomes `exported_job` / `exported_instance`, so it
  cannot change which shard a sender's rows go to.
- **Whole-request retry.** Unchanged and re-verified: any refused or failed append gives
  429 or 503 for the whole request; `partial_success` and Remote Write's 400 are only for
  rows a retry would not fix: rejected by validation, or new series over the active-series
  limit.

**Routing and append.** The routing key of a series is `job=<job>\0instance=<instance>`.
Rows are grouped by `slotFor(map, tenant, key)`, each slot gets its batches in arrival
order, and slots are appended concurrently. The fingerprint is the SHA-256 hex of the
batch bytes. The pool map comes from `pool:<tenant>`, else `DEFAULT_POOL`, cached for 30 s.
A tenant whose own map is present but unreadable gets 503 rather than falling back to the
shared pool.

**Responses.**

| Outcome | Remote Write | OTLP |
|---|---|---|
| Everything appended | 204, `X-Prometheus-Remote-Write-Samples-Written` | 200, empty `ExportMetricsServiceResponse` in the request's encoding |
| Some rows invalid, the rest appended | 400 with counts and reasons, plus the written-count header | 200 with `partial_success` |
| Any slot's buffer is full (`backpressure`, scope `tenant` or `shard`) | 429, `Retry-After` in seconds, for the whole request | same |
| Any slot is overloaded (`backpressure`, scope `overload`), or every slot of the tenant refused so within its `Retry-After` | 503 with the shard's `Retry-After` (senders must retry 5xx); in the second case before the body is read or decoded | same |
| New series over the active-series limit | 400 naming the limit (below); the rest is written | 200 with `partial_success` |
| A shard status this code does not know, a newer key record, pool map or limits record | 503 with `Retry-After`; never counted as stored, never authenticated on a guess | same |
| `stale_epoch` | map refetched once and the request re-routed; otherwise 503 with `Retry-After` | same |
| Shard error, no pool, or a pool map naming a pool outside `POOL_NAME` (D38) | 503 with `Retry-After` | same |
| Malformed body | 400 with a short reason | 400, body is a `Status` in the request's encoding |
| Too large | 413 | 413 |

A 2xx is sent only after every append has returned `ok`.

## Recorded samples over a service binding (contracts/ingest.ts, D45)

`RecordedSamples` is a named `WorkerEntrypoint` export of the ingest Worker (re-exported by
`stack/src/index.ts`, so viz-ingest has it). The ruler reaches it through a service binding
whose config names the entrypoint and carries `props: { caller: "viz-ruler" }`; no API key is
involved.

- **Who may call.** Only a binding of this account that names the entrypoint: the internet
  reaches only the default export's `fetch`, and the gateway binds only the default entrypoint.
  `ctx.props.caller` must be in `RECORDED_SAMPLES_CALLERS` (`viz-ruler`); any other binding, or
  one without props, is refused `unauthorized`.
- **Whose samples.** The tenant is the explicit first argument, never anything in a body;
  it must match `TENANT_ID`, and every batch id must start with `<tenant>/` (a `SampleBatch` id
  is `<tenant>/<shard>/<group>/<rule key>@<time>`), so a caller that mixed tenants up is refused
  and nothing is written.
- **The same path as Remote Write after decoding**: the same `Collector` (labels canonical and
  validated, the accept window, the series and sample limits), routing, appends, early refusal,
  active-series limit. Values are Prometheus' text form (`+Inf`, `Inf`, `-Inf`, `NaN`, a decimal;
  not hex, not empty, no whitespace).
- **Fails closed.** The promise resolves only when every sample is durably appended (a 204);
  otherwise it rejects with a message starting with the refusal word (`invalid`,
  `series_limit`, `too_large`, `backpressure`, `overloaded`, `unavailable`, `unauthorized`).
  Unlike Remote Write, a call with any invalid sample writes nothing at all. Re-sending is safe:
  identical batches are recognised by their fingerprint.

## Active-series limit

Every batch `edge` appends carries `seriesIds`, the `series_id` of each series table entry
(read back from the entries it already built), and `seriesLimit`, the shard's share of
the tenant's limit: `limits:<tenant>` in KV = `{ "active_series": N }`, default
1,000,000, cached 30 s like the pool map; a record that cannot be read means the default,
not "no limit". The share is the limit divided evenly over the tenant's slots, rounded up.

When a shard answers `series_limit` it has stored nothing of that batch and names the new
series that do not fit. `edge` marks those series, rebuilds its batches without them and
appends again (at most three rounds, then the request is answered 429 for a retry). So a
tenant at its limit keeps writing the series it has; only new series are dropped. Batches
that come out byte-identical are recognised by their fingerprint; the rest are stored
again and de-duplicated on read, as with any retry. The sender is told:

| Protocol | Answer |
|---|---|
| Remote Write | **400** (not retried by senders), `X-Prometheus-Remote-Write-Samples-Written`, and a body naming the limit, the shard's share, the active count, how many new series and samples were refused and how many were written. Not 429: a sender that retries 429 would resend the same new series for ever and fall behind on the series it has (review R-4; D21 rewritten) |
| OTLP | **200** with `partial_success`: `rejected_data_points` includes the refused points and `error_message` carries the same text |

Why the shard returns ids and `edge` filters, rather than `edge` splitting batches per
series: `design/DECISIONS.md` D21. `test/limit.test.ts` (6 tests); mutants in
`stack/scripts/mutants.mjs limit`.

## Memory per request (decode limits, D71; review M-3)

What a metrics request holds is bounded whatever its body's shape (`contracts/BATCH.md`,
"Decode limits"). Ported from the development branch (commit `2afd7c5`), which applies the same
limits to OTLP traces and logs and Loki push; only the metrics part is here.

- **Counted before built.** The OTLP metrics decoders (protobuf and JSON) count each key-value
  entry and array element of a resource or a data point, at any depth, against it
  (`src/meter.ts`) before building it. At 65,536 the item is refused ("label set too large to
  fit one batch"; a resource refuses all its points), the decoder builds nothing more of it and
  reads the rest only to check the wire (lengths, wire types, nesting, UTF-8), so a malformed
  body is still 400. Items under the limit are checked exactly as before. `BUILT` counts what the
  decoders build, for the tests. Remote Write was already bounded per series: its labels are
  read into a fixed scratch and copied from the body as bytes.
- **No offsets per child.** A protobuf level is read twice (first its scalar fields and how many
  children it has, then the children), so nothing is kept per resource, metric or point between
  the two passes.
- **The series table** counts against `maxDecodedBytes` as it is built, and its buffer does not
  double past it. A resource's labels are copied into every series of it, so before this a valid
  157 KiB body (one 96 KiB resource, 2,000 points) built a 498 MiB table (below). `index.ts` lets
  the body go once it is decoded, before the shards are written.
- **A point's attribute names** are found in a `Map`, not with `indexOf`, which was quadratic in a
  point's attributes.
- **JSON** is refused (413) above `maxJsonTokens` structural characters before `JSON.parse`, which
  builds every value at once; realistic OTLP JSON has one per 10 to 35 bytes (measured on the
  development branch's realistic bodies), hostile JSON one per 1.5.

**The model.** While it decodes, a request holds its body as received (at most `maxBodyBytes`,
8 MiB) and decompressed (at most 8 MiB; gzip inflates through chunks of up to as much again), the
series table so far (at most `maxDecodedBytes`, 16 MiB, in a buffer at most one series larger),
and V8 heap: for protobuf, the item being decoded (at most 65,536 values; every protobuf body
below peaks at 6.0 MiB or less in workerd), for JSON, the parse tree (28.2 MiB at the token limit,
the worst shape found, measured on the development branch with a body of empty objects;
`JSON.parse` builds that tree before any decoder sees it) and the body's text (up to 8 MiB more,
modelled). While the shards are written it holds the series table and its batches (about as
large again) and no body. All but the V8 heap are ArrayBuffers. With every limit reached at once
that is about 50 MiB for protobuf and 80 MiB for JSON (modelled from the parts); two such requests
do not fit one 128 MB isolate. Realistic requests of 8,200 points (measured here) peak at 3.2 MiB
of V8 heap as protobuf and 8.8 MiB as JSON in workerd, and decode into 2.14 MiB.

**Measured here** (2026-11-19, one run per case, on this branch's `src/` and, for "before", on
`origin/main`'s at `9e56957`; the development branch's `bench/memory.mjs`, copied in for the run
and not committed here, with its span and log imports left out). workerd 2026-11-17 local, V8
heap only, from `--trace-gc`: "peak" is the largest heap a GC saw before collecting, garbage
included. Node 22 alongside; Node does not compress pointers, so its heap is about twice
workerd's, and only Node reports ArrayBuffers (bodies, the series table, batches) retained after
the request. Hostile bodies are review M-3's shapes and those found while fixing them; realistic
ones have 8,200 points in the shape of an instrumented HTTP service.

| Body | Size | workerd peak, MiB: before → after | Node peak, MiB: before → after | Node ArrayBuffers retained, MiB: before → after | Outcome: before → after | Node decode time, ms: before → after |
|---|---|---|---|---|---|---|
| metrics: resource of empty KeyValues | 4.00 MiB | 119.7 → **6.0** | 181.2 → 7.8 | 0.0 → 0.0 | 0 stored → 0 stored | 774 → 44 |
| metrics: resource attribute, array of empty values | 4.00 MiB | 43.1 → **1.3** | 71.4 → 1.5 | 4.0 → 4.0 | 0 stored → 0 stored | 197 → 25 |
| metrics: a 96 KiB resource copied into 2,000 series | 157 KiB | 1.4 → **1.1** | 1.3 → 1.2 | **498.0 → 0.0** | 2,000 stored → 413 | 965 → 132 |
| metrics: point of distinct attribute keys | 229 KiB | 2.8 → **3.2** | 4.4 → 5.1 | 0.0 → 0.3 | 0 stored, 1 refused → 0 stored, 1 refused | 262 → 41 |
| metrics JSON: resource of empty attributes | 4.00 MiB | 135.4 → **0.0** | 222.0 → 0.1 | 0.0 → 0.0 | 0 stored → 413 | 718 → 14 |
| realistic metrics, 8,200 points | 1.34 MiB | 3.2 → **3.2** | 4.1 → 4.1 | 5.3 → 5.3 | 8,200 stored → 8,200 stored | 104 → 138 |
| realistic metrics JSON, 8,200 points | 3.06 MiB | 8.5 → **8.8** | 18.1 → 18.2 | 5.7 → 5.7 | 8,200 stored → 8,200 stored | 105 → 122 |

The fan-out row is the one live on `main` with a valid body: its V8 heap is small, and the 498 MiB
are the series table, an ArrayBuffer, grown from a 157 KiB body. Two outcomes change, both as the
contract now says: the fan-out and the hostile JSON body are 413. Every other outcome is the same,
and so are the batches of every realistic body ("Verification"). A second run of the "after" column
(`--check`) gave 5.2 MiB for the first row and within 0.4 MiB for the rest; every case was under
its heap budget (16 MiB for protobuf, 32 MiB in workerd and 64 MiB in Node for JSON). Node decode
time is wall time of one synchronous run on a shared machine at load 7 to 8. The same measurements
on the development branch, with the span and log rows, are in its `edge/README.md`.

Not measured: anything on Cloudflare (the isolate's memory as Workers reports it, under concurrent
requests); ArrayBuffers in workerd (no API).

## Not implemented

- Remote Write 2.0 (415), native histograms, exemplars, metadata.
- OTLP histograms, exponential histograms, summaries and delta sums (reported in
  `partial_success`). Scope attributes, `target_info`, start timestamps and exemplars
  are ignored. zstd is refused with 415.
- OTLP traces and logs, OTLP/gRPC.
- Per-tenant limits: `INGEST_LIMITS` applies to every tenant of the deployment.
- Rate limiting at the edge. Quotas are the shard's job; the edge relays its backpressure
  and, while every shard of a tenant is inside an overload `Retry-After`, refuses that
  tenant's requests before decoding (an isolate-local hint, not a limit).
- Key revocation faster than the 60 s cache, and any tooling to create keys.
- Metrics about the edge itself (rejections by reason, bytes per tenant).
- Decoding without building: an item's attributes are still JavaScript objects while it is
  decoded (at most 65,536 values, 6.0 MiB at worst measured), not written from the wire to
  their stored form; a JSON body is still parsed whole (bounded by `maxJsonTokens`). D71 has the
  alternatives.
- Truncating an item over the decode limits instead of refusing it, and naming every rule an item
  over them breaks (a point is named for the values limit once its metric's checks pass).

## Verification

```
npm install
npx vitest run --maxWorkers=2   # 84 tests in 10 files, in workerd, against the real Shard
npm run typecheck               # clean
node scripts/mutants.mjs        # 63 mutants, on a copy outside the git checkout (the script refuses to run in it)
npm run bench       # decode throughput, in Node
npm run fixtures    # regenerate test/fixtures.json with protobufjs + snappyjs
```

Last run, 2026-11-19: **62 passed, 0 failed**; `tsc --noEmit` clean.

**With the recorded-samples entrypoint (2026-11-19): 71 passed, 0 failed** (9 files);
`tsc --noEmit` clean. `test/recorded.test.ts` (9 tests) calls the entrypoint the way the ruler
will, through service bindings that `wrangler.jsonc` points at this script itself (as
`viz-ruler`, as `viz-mcp`, and without props): seven samples in two batches with `1.5`, `+Inf`,
`-Inf`, `NaN`, `-0`, `1e3` and `Inf`, labels unsorted and one empty, read back from the shards
bit for bit with canonical labels and the contract's series ids, and the same call again stores
nothing new; the `viz-mcp` binding and the bare one are refused and write nothing; five bad
tenant ids, a non-string tenant, another tenant's batch, a batch id that only starts with the
tenant's name and one without an id are refused and write nothing to either tenant; nine kinds
of bad sample (not a value, hex, empty, no `__name__`, too old, too new, a fractional time, a NUL,
a non-string label value) each refuse the whole call with nothing written; a full shard buffer is
`backpressure`, never a success, and the same call succeeds once there is room; a tenant at its
active-series limit gets `series_limit` naming one new series, with the existing series written;
every refusal word is one the contract lists; the value parser accepts exactly Prometheus' text
form. On Cloudflare: `deploy/README.md`, Trial 3.

What the tests establish:

- **Round trip.** Remote Write bodies and OTLP protobuf and JSON bodies are sent through
  the Worker, read back with `tailRead`, and decoded by a `VZB1` decoder in
  `test/helpers.ts` that shares no code with the encoder. The stored samples equal the
  sent ones exactly, including `-0`, ±Infinity, a NaN with a payload and the staleness
  marker. Every stored series entry is checked for sorted unique labels, `__name__`, no
  empty values and a correct series id.
- **Series ids.** Five vectors were computed in Python with arbitrary-precision integers
  and pasted into `test/helpers.ts` (`PY_VECTORS`), including non-ASCII labels. The BigInt
  function, the hot-path function and the test's own implementation all reproduce them,
  and the hot path equals the BigInt function on 2,000 random label sets that include
  characters whose UTF-16 and UTF-8 orders differ.
- **Independent codecs.** `snappyjs` runs inside workerd: the decompressor inverts its
  output on ten inputs up to 200 KB, and `snappyjs` accepts the test compressor's output.
  `test/fixtures.json` holds a 54,751-byte `WriteRequest` (300 series, 600 samples,
  10,657 bytes compressed) and a 491-byte OTLP request, both encoded by `protobufjs` from
  `.proto` text in Node, compressed by `snappyjs` and `node:zlib`; the Worker stores
  exactly the expected samples from each.
- **Hostile input.** Truncated, overlong and out-of-range snappy and protobuf are refused
  with 400, a 4 GiB length declaration and a gzip bomb with 413, and 3,000 random byte
  strings produce nothing but 400 or 413.
- **Tenancy.** Two keys for two tenants writing to the same shard object each read back
  only their own rows. Five tenant-looking headers, a query string and labels naming
  another tenant do not move a write.
- **Backpressure and idempotency.** With `tenantMaxBytes: 16` on one of two slots the
  request gets 429 and `Retry-After: 1` while the healthy slot commits its batch. After
  the cap is lifted, the identical request gets 204 and each slot holds exactly one batch;
  a further duplicate changes nothing (`nextSeq` stays 2).
- **Acknowledgement order.** With a stand-in shard namespace whose appends resolve on
  command, the response is still pending after one of two appends has resolved.
- **Epochs.** A cached map at epoch 3 against a shard at epoch 5 gives 503 while KV still
  says 3, and 204 after exactly one KV read once KV says 5.
- **Splitting.** A 25,000-series request for one slot is stored as several batches of at
  most 1 MiB, in order.
- **Contracts v2** (`test/contract.test.ts`, 7 tests, and one rewritten in `codec.test.ts`).
  A series with labels named U+FFFF and U+10000 is stored with U+FFFF first, has the id of
  the byte-sorted label set and not the id JavaScript's order would give, and is one series
  whichever order the sender used. 128 labels, a 1,024-byte name (also 512 two-byte
  characters) and an 8,192-byte value are accepted; one more of each is rejected, as is a
  NUL in a name or value, and `INGEST_LIMITS` cannot loosen any of it. A 1,054,112-byte
  label set is rejected while the rest of the request is stored. Every timestamp in
  0..253,402,300,799,999 is written exactly; `-1`, the first millisecond of year 10000,
  ±2^53, `NaN` and ±Infinity are rejected even with an unlimited accept window. With a
  shard capped at 4,096 bytes the request succeeds in batches of at most 4,096 bytes; with
  a cap no row fits, it gets 503 and `Retry-After` and nothing is stored. Forty OTLP points
  with 39 different `job`/`instance` attributes all land in the one slot the resource
  routes to, carrying `exported_job` / `exported_instance`, in protobuf and in JSON.

Also checked by hand: `wrangler deploy --dry-run` bundles (69 KiB), and under
`wrangler dev` a 500-series body made by `protobufjs` + `snappyjs` sent with `curl`
returned 204 with `Samples-Written: 500`, and an OTLP/JSON body with one histogram
returned 200 with `rejectedDataPoints: "1"`.

### Mutation checks

`scripts/mutants.mjs` applies each change below on its own, runs the suite and restores
the file. Every one makes at least one test fail.

| # | Mutant |
|---|---|
| 1 | Tenant taken from the `X-Scope-OrgID` header |
| 2 | Response sent before the appends complete |
| 3 | Fingerprint random instead of derived from the batch |
| 4 | Fingerprint the same for every batch |
| 5 | Routing key built from `job` only |
| 6 | Routing by series instead of by sender |
| 7 | Expired timestamps accepted |
| 8 | Far-future timestamps accepted |
| 9 | 2xx on backpressure |
| 10 | 2xx on a shard error |
| 11 | No map refetch on `stale_epoch` |
| 12 | `stale_epoch` ignored |
| 13 | Secret not checked |
| 14 | Disabled keys accepted |
| 15 | Scope not checked |
| 16 | Labels not sorted |
| 17 | Empty-valued labels kept |
| 18 | Series id without the separator after the value |
| 19 | Series id without the carry between its two halves |
| 20 | OTLP histograms dropped without being counted |
| 21 | Delta sums stored as if cumulative |
| 22 | Remote Write 204 despite rejected samples |
| 23 | Sample value passed through a JS number (NaN payload lost) |
| 24 | Batches not split at the size limit |
| 25 | Snappy decompressed-size limit not enforced |
| 26 | Snappy copy bounds not checked |
| 27 | Labels sorted in JavaScript string order instead of UTF-8 bytes |
| 28 | Timestamps before 1970 accepted |
| 29 | Timestamps after year 9999 accepted |
| 30 | `INGEST_LIMITS` may loosen the contract label limits |
| 31 | `INGEST_LIMITS` may raise the batch cap |
| 32 | Label set larger than a batch not rejected |
| 33 | OTLP point attribute `job`/`instance` not renamed |
| 34 | `too_large` from a shard treated as success |
| 35 | No re-split after `too_large` |

**Review fixes, early refusal, compatibility, names** (`test/overload.test.ts`, 7 tests;
`test/limit.test.ts`). An overloaded shard gives Remote Write and OTLP 503 with
`Retry-After`, stores nothing, and the retry after it clears is stored once; once every shard
of the tenant has refused, the next request is refused before its body is read; a status
edge does not know is 503, never 2xx; a key record with a tenant id outside `TENANT_ID`
authenticates nobody (R-9); key records, pool maps and limits records of a newer `v` are
503 unless this isolate holds the last good value, and a limit is never loosened to the
default; a pool map naming a pool with `_` is 503 and nothing is stored (D38); Remote Write
over the active-series limit is 400 and the existing series are written, also at the limit
(R-4).

**Mutation check of 2026-11-19** (`node scripts/mutants.mjs` on a copy of `contracts/`,
`shard/` and `edge/` in a scratch directory; each mutant against the whole suite): **41 of
43 killed.** The eight added here and the test that failed for each: R-4 answered 429 again
(limit.test "Remote Write: 400 (not retried)…"); R-9 tenant ids not checked (overload.test
"…R-9"); overload answered 429, and overload without the shard's `Retry-After` (overload.test
"Remote Write and OTLP get 503 with Retry-After…"); no refusal before decoding, and an
overload not remembered (overload.test "…refused before its body is read or decoded"); a pool
outside `POOL_NAME` used (overload.test "a pool map naming a pool outside POOL_NAME…"). **Two
survive, both equivalent:** "2xx on shard error" (mutant 10) and "a shard status edge does not
know counts as stored" each remove one of the layers that refuse a failed or unknown append;
the last check of `appendAll` ("only `ok` counts as stored; anything not handled above
refuses the request") still answers 503, so behaviour does not change. The property has no
single point of failure; a mutant removing every layer at once was not run.

**Mutants of the entrypoint (2026-11-19)**, `node scripts/mutants.mjs recorded` on a copy of
the tree in a scratch directory (each against the whole suite, after the copy's unmutated
suite passed 71 of 71): **7 of 7 killed**. `node scripts/mutants.mjs --check`: all 50 patterns
apply (the earlier 43 were not re-run here).

| Mutant | Killed by |
|---|---|
| any service binding may write (caller not checked) | refuses a binding that does not name the ruler; every refusal word is one the contract lists |
| the tenant argument is not validated | takes the tenant only from its argument, validated; every refusal word … |
| batches of another tenant are accepted | takes the tenant only from its argument, validated (another tenant's batch) |
| invalid samples are dropped and the rest written | a call with any sample the HTTP API would reject writes nothing at all |
| a full buffer resolves (acknowledged, not written) | a full shard buffer is a retryable refusal, never a success |
| new series over the limit resolve | new series over the tenant's active-series limit are refused (series_limit) |
| values parsed with `Number()` (hex, empty accepted) | writes nothing at all (hex, empty); parses exactly Prometheus' text form |

### Decode limits and memory (2026-11-19, review M-3, D71)

```
npx tsc --noEmit
npx vitest run --maxWorkers=2       # test/decode-metrics.test.ts is new
node scripts/mutants.mjs decode:    # on a copy outside the git checkout
```

The memory and differential harnesses are the development branch's (`bench/memory.mjs`,
`bench/memory-run.mjs`, `bench/bodies.mjs`, `bench/differential.mjs`). They were copied into this
tree for the runs below and are not committed here: they also build and decode spans and logs,
which this tree does not have (for the runs, the copies skip those).

**Last run** (2026-11-19): `npx vitest run --maxWorkers=2` **84 passed, 0 failed** (10 files: the
71 before and 13 new); `npx tsc --noEmit` clean. New: `test/decode-metrics.test.ts`, with request
bodies written byte by byte in `test/wire.ts`, sharing nothing with `src/`:

- **Each hostile shape is refused, cheaply**: a resource of empty `KeyValue`s, a data point of
  empty attributes followed by a valid point, a point attribute that is an array of empty values
  (protobuf), and a point of empty attributes followed by a valid point (JSON), each at 4N and 8N
  entries (2N and 4N for JSON). Each is refused with "label set too large to fit one batch", the
  valid point after it is stored, and `BUILT` (every entry and element a decoder creates, counted
  apart from the meters) stays at most N + 64 and the same for both sizes: building stopped at
  the limit.
- **At the limit**: a data point of exactly 65,536 values (16 labels, each an array of 4,095
  integers) is stored with every value read back from its batch, and one more is refused; exactly
  `maxDecodedBytes` of series is accepted and a byte less is 413; exactly `maxJsonTokens` is
  accepted and one less is 413.
- **The rest is still read**: past the limit, invalid UTF-8 in a key (an overlong form) and in
  a value (a surrogate) and a value nested 18 deep are still 400; JSON still checks every value's
  type.
- **Through the Worker**: a point over the limit is answered 200 with `partial_success` (1
  rejected, with its reason) and the valid point is stored; a resource copied into more series
  bytes than `maxDecodedBytes` is 413 with nothing stored, and all 50 series are stored under a
  larger limit; a JSON body over `maxJsonTokens` is 413 with nothing stored.
- `validUtf8` agrees with a fatal `TextDecoder` on 20,000 random byte strings biased to the edges
  of multi-byte forms (more than 5,000 of them invalid, as the test checks).

**Unchanged answers.** `node bench/differential.mjs origin/main`, run on this tree: **605 of 605
metrics requests identical** to `main`'s decoders at `9e56957` (batches byte for byte, series ids,
counts, refusal reasons): `test/fixtures.json` (Remote Write, and OTLP protobuf and gzip, encoded
by protobufjs, snappyjs and `node:zlib`; 606 rows), the two realistic metrics bodies (8,200 points,
protobuf and JSON), and 300 random OTLP metrics requests in protobuf and in JSON (every AnyValue
kind, nested, repeated and colliding keys, empty values, NaN, unicode, every temporality,
histograms, staleness flags; 5,618 points refused for their reasons, the same before and after).
Its six span, log and Loki bodies were skipped: `main` has no decoder for them.

**Memory**: the table in "Memory per request" (`node bench/memory.mjs --json metrics`, and with
`MEM_SRC` at `origin/main`'s `edge/src` for "before"); `node bench/memory.mjs --check metrics`
passes: every metrics case under its heap budget.

**Mutants** (`node scripts/mutants.mjs` on a copy of `contracts/`, `shard/` and `edge/` in a
scratch directory, after the copy's suite passed 84 of 84; each mutant against the whole suite;
afterwards the copy's sources were compared with this tree byte for byte: equal). `--check`: all
63 patterns apply. **Last run: 61 of 63 killed**; the two survivors are the equivalent ones
described above ("2xx on shard error", "a shard status edge does not know counts as stored"). The
13 new ones, all killed (11 are the development branch's metrics mutants; the two marked * are
the metrics counterparts of its span mutants):

| Mutant (`decode:`) | Killed by (one of) |
|---|---|
| data point attributes built without the meter and counted afterwards | metrics: point of empty attributes, then a valid point: refused on its own, built no further than the limit however large it is |
| array elements built past the limit (the check after the build) * | metrics: point attribute, an array of empty values: refused on its own, built no further than the limit … |
| the meter is not incremented | metrics: resource of empty KeyValues: refused on its own, built no further than the limit … |
| array elements not counted | metrics: point attribute, an array of empty values: …; stores a data point of exactly 65,536 values, and refuses one more |
| off by one: an item of exactly the limit refused | stores a data point of exactly 65,536 values, and refuses one more |
| off by one: an item one over the limit accepted | the same; refuses through the Worker with a partial success, and stores the rest |
| a value past the limit not read (a malformed body accepted) * | still reads the rest of a point it has stopped building: a malformed body is 400 |
| invalid UTF-8 in a key not built goes unchecked | the same |
| overlong three-byte UTF-8 accepted | `validUtf8` agrees with a fatal TextDecoder on 20,000 random byte strings … |
| UTF-8 surrogates accepted | still reads the rest of a point it has stopped building: a malformed body is 400 |
| JSON tokens off by one (a body of exactly the limit refused) | JSON bodies: more than maxJsonTokens structural characters is 413 before parsing, as many is accepted; counts JSON structure outside strings only |
| JSON structure inside strings counted | the same |
| series labels past maxDecodedBytes accepted | metrics: a resource copied into more series bytes than maxDecodedBytes is refused whole (413), nothing stored; takes exactly maxDecodedBytes of series, and refuses a byte less |

"Histograms silently dropped" was re-anchored (the decoder now counts points instead of keeping
their offsets) with the same intent, and is killed as before. Not carried: the development
branch's "JSON tokens counted after parsing", which no test can kill (the status is the same by
construction) and which its `bench/memory.mjs --check` kills; it is a span mutant there.

### Decode throughput

`npm run bench`, Node 22 on a shared and noisy development machine; medians of 15 runs,
ranges over four invocations. This is V8 but not the Workers runtime or its CPU.

| Workload | Size | CPU | Per decompressed MB |
|---|---|---|---|
| Remote Write, 2,000 series × 1 sample, 11 labels (a default Prometheus send) | 625 KB, 97 KB snappy | 8–15 ms total: snappy 1.3–2.0, decode and series ids 4.5–6.4, batches 0.4–1.0, SHA-256 0.4 | 13–24 ms |
| Remote Write, 50,000 series × 1 sample | 15.7 MB, 2.4 MB snappy | 270–415 ms total | 18–28 ms |
| OTLP protobuf, 50,000 points, one resource | 7.7 MB | 227–327 ms decode and mapping | 30–45 ms |
| OTLP JSON, same points | 16.3 MB | 270–320 ms parse, decode and mapping | 17–21 ms |

So roughly 4–7 µs of CPU per sample, or roughly 100–150 ms per megabyte of snappy on the wire.
Most of it is the series id: FNV-1a is one multiply per byte in a serial chain, about
3.6 ms per MiB of label bytes here.

## Known risks

- **A refused recorded-sample write is an `exception` in viz-ingest's metrics** (Trial 3 on
  Cloudflare, `deploy/README.md`): the caller received each refusal in 2–4 ms and nothing was
  written, but the callee's invocation ended "canceled … hung". Not understood; not seen in
  workerd here. Successful writes end `ok`.

- **A retry is idempotent only if it produces the same batch bytes.** The same body, map
  and limits always do. A sample that leaves the accept window between the first attempt
  and the retry changes the batch, so the rows that had already been appended are stored
  again. The exposure is a retry that straddles the one-hour boundary.
- **A re-split after `too_large` double-stores.** Batches that had been appended before
  the refusal are stored again under new fingerprints. Readers and flush de-duplicate on
  `(series_id, ts)` (tested end to end in `stack/`), so results are unaffected; the cost is
  storage until the next flush.
- **Re-routing after `stale_epoch` can double-store.** If some slots accepted a request
  under the old map and the new map sends those series elsewhere, the new shard has no
  fingerprint for them. The design closes this with fingerprint handover on a map change,
  which the shard does not do yet.
- **A slot's batches are not atomic.** A request split into several batches for one slot
  can be refused part-way; the committed prefix stays and the full retry skips it by
  fingerprint.
- **Remote Write 400 after a partial write.** When some samples are invalid the valid
  ones are stored and the sender is told 400, which Prometheus does not retry. Its logs
  show the reason, but a sender far behind real time loses everything older than an hour.
- **CPU.** A request at the default limits (8 MiB decompressed) costs up to a few hundred
  ms of CPU by the numbers above (modelled from Node). Nothing has been measured on
  Cloudflare, and nothing has been run under concurrent load.
- **Memory.** Bounded per request ("Memory per request", D71): about 50 MiB (protobuf) or 80 MiB
  (JSON) with every limit reached at once (modelled from measured parts), 3.2 to 8.8 MiB of V8
  heap for realistic requests (measured here, local workerd). Two requests at every limit do not
  fit one 128 MB isolate; nothing was measured on Cloudflare or under concurrent requests.
- **413 drops a sender's batch.** OTLP senders do not retry 413 (training knowledge: the
  Collector treats it as permanent and does not split the batch). A Collector whose batches
  exceed 8 MiB decompressed, or decode into more than 16 MiB, loses them and logs why; set its
  batch processor's `send_batch_max_size` (8,200 points are 1.3 MiB as protobuf and 3.1 MiB as
  JSON here). Metrics whose resources carry many attributes come closest to the decoded limit,
  because each series copies its resource: a Kubernetes resource of about 25 attributes makes
  8,192 points about 11.5 MiB of series table (modelled), near the 16 MiB cap.
- **Decode limits name the values limit first.** A point over 65,536 values is refused for it
  even when it also breaks a label rule or the accept window; a repeated key (which OTLP
  forbids) and entries that the mapping drops (empty values) count like any other.
- **Caches are per isolate.** A disabled key keeps working for up to 60 s in each isolate
  that has it cached, and KV's own propagation delay comes on top.
- **OTLP labels.** Resource attributes are copied onto every series rather than into
  `target_info`, which the compatibility spec prefers; high-cardinality resources make
  wide series. The `;` join of colliding attribute names follows arrival order, not the
  spec's sorted order.
- **Series ids use a hand-written 64-bit multiply.** The contract's BigInt form exists as
  `fnv1a64` and the tests hold the two equal, but the hot path is the integer one.

## Contract issues

Issues 1 to 5 are **resolved in contracts v2** and implemented here (see "Contracts v2"
above): a stated batch size and `too_large`; label byte rules and limits; UTF-8 byte order;
OTLP routing labels with `exported_job` / `exported_instance`; retryable statuses instead
of `partial_success` for a failed shard. Issue 6 stands; issue 7 is resolved for overload.
The original list:

1. **`BATCH.md`: "one batch per shard slot" cannot always hold.** Cloudflare documents a
   2 MB cap on a value in a SQLite-backed Durable Object, and the shard stores a batch as
   one BLOB. The edge therefore splits a slot's rows into batches of at most 1 MiB. Local
   workerd did not enforce the cap (a 3 MB append succeeded), so this is untested against
   the real limit. The contract should state a maximum batch size, and `Shard.append`
   should say what it returns for an oversized payload.
2. **`BATCH.md`: label bytes are unconstrained.** A NUL inside a name or value makes the
   series id input ambiguous (`name 0 value 0`). The edge rejects such labels, empty
   names and invalid UTF-8; the contract should say so, and should state length limits
   (the format's `u16` allows 65,535 bytes).
3. **`BATCH.md`: "sorted by name (byte order)"** should say UTF-8 bytes. JavaScript's
   default string order is UTF-16 code units, which differs for characters above U+FFFF,
   and the engine has to agree with the edge.
4. **Routing key for OTLP.** `BATCH.md` builds it from the `job` and `instance` labels;
   `DESIGN.md` §4.1 says OTLP routes by resource attributes. The edge follows `BATCH.md`,
   so only `service.namespace`, `service.name` and `service.instance.id` take part, and a
   point attribute named `job` or `instance` changes the route of that point.
5. **`DESIGN.md` §4.2 step 3** suggests OTLP `partial_success` when one shard of several
   fails. `partial_success` tells the client not to retry, which would lose the rows. The
   edge answers 429 or 503 for the whole request instead.
6. **Fingerprint scope.** The fingerprint covers the batch bytes, so it depends on how the
   edge splits a request (map, limits, accept window). See the first two risks above; a
   fingerprint handed over on map changes, as §4.1 describes, is needed for the second.
7. **`Shard.append` reports `retryAfterMs: 1000` always**, and failures other than
   backpressure and `stale_epoch` arrive as exceptions. The edge maps every exception to
   503 with `Retry-After: 1`; an overloaded shard and a permanently failing one look the
   same to the sender. *Resolved for overload* (2026-11-19): the shard refuses early with
   scope `overload` and a real, jittered `Retry-After`, which edge passes through with 503;
   exceptions (an unreachable or reset object) are still 503 with `Retry-After: 1`.

## Needed changes

In components others own; not made here.

1. **ruler: write recorded samples through the entrypoint, with no stored key** (the ruler's
   README, "Needed changes" 2). The ruler already prefers a `SINK` binding
   (`ruler/src/ruler.ts`, `sink()`: `binding.write(this.tenant, batches)`, with the Ruler
   object's own tenant, derived from its name). The whole change is one binding in
   `ruler/wrangler.jsonc`, under `"services"`:

   ```jsonc
   // Recording rules: viz-ingest's RecordedSamples entrypoint (contracts/ingest.ts). The binding
   // is the credential; the tenant is the Ruler object's own.
   { "binding": "SINK", "service": "viz-ingest", "entrypoint": "RecordedSamples", "props": { "caller": "viz-ruler" } }
   ```

   and the same in `ruler/wrangler.test.jsonc` pointing at the test script's stand-in (or at a
   script exporting edge's `RecordedSamples`, as `edge/wrangler.jsonc` does for its tests), plus
   `SINK` in the ruler's `RulerEnv` health check if it should count. `deploy/configure.mjs`
   already maps `service: viz-ingest` per stage and keeps `entrypoint` and `props`; viz-ingest
   deploys before viz-ruler. Then:
   - a rejection is already "not written" to the ruler (it retries three times, then marks the
     rule `sink: <message>`), which is what this entrypoint promises; the message starts with
     the refusal word, so `invalid`, `series_limit` and `unauthorized` could be reported without
     the retries;
   - the service key needs only `read` (queries) until query has its own entrypoint (the
     ruler's "Needed changes" 1); after both, no stored key at all, and `INGEST` can go once no
     release that may run still uses it (callee first: keep `INGEST` for one release).
