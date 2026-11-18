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

There are no runtime dependencies. `snappyjs` and `protobufjs` are dev dependencies, used
only to cross-check the hand-written codecs.

## Endpoints

| | |
|---|---|
| `POST /api/v1/write` | Remote Write 1.0: snappy block-compressed `prometheus.WriteRequest` |
| `POST /v1/metrics` | OTLP/HTTP metrics, `application/x-protobuf` or `application/json`, optionally `Content-Encoding: gzip` |
| `GET /healthz` | `200 ok` |

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
the key record; nothing in the request can change it. Records are cached in memory for
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
| `maxDecompressedBytes` | 32 MiB | 413; checked before snappy allocates and while gzip inflates |
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
  rows rejected by validation.

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
| Any slot answers backpressure | 429, `Retry-After` in seconds, for the whole request | same |
| `stale_epoch` | map refetched once and the request re-routed; otherwise 503 with `Retry-After` | same |
| Shard error or no pool | 503 with `Retry-After` | same |
| Malformed body | 400 with a short reason | 400, body is a `Status` in the request's encoding |
| Too large | 413 | 413 |

A 2xx is sent only after every append has returned `ok`.

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
| Remote Write | **429**, `Retry-After: 60`, `X-Prometheus-Remote-Write-Samples-Written`, and a body naming the limit, the shard's share, the active count, how many new series and samples were refused and how many were written |
| OTLP | **200** with `partial_success`: `rejected_data_points` includes the refused points and `error_message` carries the same text |

Why the shard returns ids and `edge` filters, rather than `edge` splitting batches per
series: `design/DECISIONS.md` D21. `test/limit.test.ts` (6 tests); mutants in
`stack/scripts/mutants.mjs limit`.

## Not implemented

- Remote Write 2.0 (415), native histograms, exemplars, metadata.
- OTLP histograms, exponential histograms, summaries and delta sums (reported in
  `partial_success`). Scope attributes, `target_info`, start timestamps and exemplars
  are ignored. zstd is refused with 415.
- OTLP traces and logs, OTLP/gRPC.
- Per-tenant limits: `INGEST_LIMITS` applies to every tenant of the deployment.
- Rate limiting at the edge. Quotas are the shard's job; the edge only relays its
  backpressure.
- Key revocation faster than the 60 s cache, and any tooling to create keys.
- Metrics about the edge itself (rejections by reason, bytes per tenant).

## Verification

```
npm install
npm test            # 55 tests in 7 files, in workerd, against the real Shard
npm run typecheck   # clean
npm run mutants     # 35 mutants, all killed (26 original + 9 for contracts v2); re-run 2026-11-18 after
                    # mutant 35's pattern was updated for the series-limit change: 35 of 35
npm run bench       # decode throughput, in Node
npm run fixtures    # regenerate test/fixtures.json with protobufjs + snappyjs
```

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
- **CPU.** A request at the default limits (32 MiB decompressed) costs up to about a
  second of CPU by the numbers above. Nothing has been measured in workerd or on
  Cloudflare, and nothing has been run under concurrent load.
- **Memory.** A request holds the compressed body, the decompressed body, the series
  table and the batches at once: about three times the decompressed size, around 100 MB
  at the default limits in a 128 MB isolate. Two such requests in one isolate would not
  fit; `maxDecompressedBytes` should come down to 8–16 MiB before real traffic.
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
of `partial_success` for a failed shard. Issues 6 and 7 stand. The original list:

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
   same to the sender.
