# Edge

The ingest Worker: it authenticates a sender, decodes Prometheus Remote Write or OTLP
metrics into `VZB1` batches (`contracts/BATCH.md`), routes them to shard slots and answers
only once every shard has durably appended. Stage 1 of traces and logs (2026-11-19): OTLP
traces, OTLP logs and Loki push decode into `VZB1` signals 2 and 3, behind `INGEST_SIGNALS`
("Traces and logs" below). For now it ships in one script with the shard
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
| `src/recorded.ts` | `RecordedSamples`: the entrypoint the ruler writes recording-rule samples to over a service binding (contracts/ingest.ts) |
| `src/otel.ts` | What OTLP traces and logs share: AnyValue and KeyValue decoding (protobuf, JSON), canonical OTLP JSON and plain JSON text, the typed attribute list encoding, a byte writer, partial-success bodies |
| `src/spans.ts` | OTLP/HTTP traces (protobuf, JSON) → validated spans → `VZB1` signal 2 batches |
| `src/logs.ts` | OTLP/HTTP logs (protobuf, JSON) and Loki push (protobuf, JSON) → validated log records → `VZB1` signal 3 batches; the OTLP-to-labels mapping |
| `scripts/otel-corpus.mjs` | The cross-language corpus: random requests encoded with protobufjs, decoded by this code into batches, with the expected rows (`engine/storage/readback`) |
| `bench/otel.mjs` | Decode CPU per request for traces, logs and Loki push |

There are no runtime dependencies. `snappyjs` and `protobufjs` are dev dependencies, used
only to cross-check the hand-written codecs.

## Endpoints

| | |
|---|---|
| `POST /api/v1/write` | Remote Write 1.0: snappy block-compressed `prometheus.WriteRequest` |
| `POST /v1/metrics` | OTLP/HTTP metrics, `application/x-protobuf` or `application/json`, optionally `Content-Encoding: gzip` |
| `POST /v1/traces` | OTLP/HTTP traces, as `/v1/metrics`; only when `INGEST_SIGNALS` contains `traces` (else 404) |
| `POST /v1/logs` | OTLP/HTTP logs, as `/v1/metrics`; only when `INGEST_SIGNALS` contains `logs` |
| `POST /loki/api/v1/push` | Loki push: `application/x-protobuf` with a snappy block body, or `application/json` optionally gzipped; only when `INGEST_SIGNALS` contains `logs` |
| `GET /healthz` | `200 ok` |

And one RPC entrypoint, reachable only through a service binding (never over HTTP):

| Entrypoint | Method |
|---|---|
| `RecordedSamples` (contracts/ingest.ts) | `write(tenant, batches: SampleBatch[]): Promise<void>`: the ruler's recording-rule output |

Bindings: `SHARD` (Durable Object namespace), `CONFIG` (KV), `DEFAULT_POOL` (JSON `PoolMap`
for tenants without their own), optionally `INGEST_LIMITS` (JSON overriding any field
of `Limits`), and optionally `INGEST_SIGNALS` (`traces`, `logs` or `traces,logs`; unset in
every deployment: stage 2 drains those shards and stage 3 routes their paths through the
gateway, but the flag goes on only as "Needed changes" 2 says).

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
| Shard error, no pool, or a pool map naming a pool outside `POOL_NAME` (D38) or a pool ending in `/traces` or `/logs` (contracts/BATCH.md, "Streams per signal") | 503 with `Retry-After` | same |
| Malformed body | 400 with a short reason | 400, body is a `Status` in the request's encoding |
| Too large | 413 | 413 |

A 2xx is sent only after every append has returned `ok`.

## Traces and logs (stage 1, behind `INGEST_SIGNALS`)

What `/v1/traces`, `/v1/logs` and `/loki/api/v1/push` do when enabled. Contracts:
`contracts/BATCH.md` (signals 2 and 3, routing, "Streams per signal"), `contracts/TRACES.md`,
`contracts/LOGS.md` §1; decisions D57 (batches and per-signal shards) and D58 (OTLP stream
labels). Not enabled anywhere: since stage 2 flush drains these shards and the ledger lists
their files, but the publisher must read those tables first ("Needed changes" 2).

- **Tenant** only from the credential, as for metrics (`authenticate`). A resource attribute,
  a stream label or structured metadata named `tenant`, Loki's `X-Scope-OrgID`, other headers
  and the query string are never read.
- **Decoding.** Hand-written protobuf readers (fields in any order; unknown fields skipped;
  `key_strindex` and `string_value_strindex`, which are for profiles, ignored) and OTLP/JSON
  readers (lowerCamelCase, hex ids case-insensitive, 64-bit integers as strings or numbers,
  enums as integers and also as names). Strings are decoded leniently: invalid UTF-8 becomes
  U+FFFD, as the OTLP specification recommends ("UTF-8 String Handling"). Doubles keep their
  8 wire bytes. `gzip` for OTLP and Loki JSON; Loki protobuf is a snappy block body.
- **Canonical form** (what flush copies): attributes typed and sorted by key in UTF-8 order,
  the last of a repeated key kept; arrays, key-value lists, bytes and empty values as
  canonical OTLP JSON; event and link attributes as canonical OTLP JSON lists; `resource_fp`
  = FNV-1a 64 over the canonical resource list; `stream_id` = `series_id`'s function of the
  stream labels.
- **Spans.** One batch entry per (resource, scope). A span whose end is before its start is
  stored with `end = start` and `viz.clamped_end = true`. Routed per resource by
  `job=<namespace/name>\u0000instance=<service.instance.id>` to the tenant's slot in
  `{pool}/traces`.
- **OTLP logs.** Stream labels from the default resource attributes of D58 (`service_name =
  "unknown_service"` when absent), metadata from everything else (flattened, named, joined),
  timestamp `time_unix_nano` else `observed_time_unix_nano`, line = string body or plain
  JSON. Routed per resource, as spans, to `{pool}/logs`.
- **Loki push.** Labels parsed from `{name="value", …}` (Go escapes, `\xHH`, `\u`, octal,
  trailing comma) or the JSON `stream` object; structured metadata from the protobuf field or
  the JSON third element. Routed by the stream's `job` and `instance` labels.
- **Batches** of at most `MAX_BATCH_BYTES` per slot in arrival order, fingerprinted with
  SHA-256, appended with the same `appendAll` as metrics (whole-request retry, backpressure,
  overload, `stale_epoch`, `too_large` re-split), without `seriesIds` (not metered).
- **Wiring for stage 2** (2026-11-19, the only edge change of it): the derived pool's name comes
  from `signalPool` in `shard/src/pool.ts` (`signalMap` keeps its 503 for a name outside
  `POOL_NAME`), and `INGEST_SIGNALS` is read by `enabledSignals` there, so flush's full sweep and
  the stack derive the same names and the same flag. `scripts/otel-corpus.mjs --requests` also
  writes the requests it encodes, for the stack's end-to-end run through the real Worker
  (`stack/tools/signals_readback.mjs`); without the flag its output is as before. Run after it
  (2026-11-19): `npx vitest run`, **91 passed, 0 failed** (11 files); `tsc --noEmit` clean; the
  corpus at seed 1 (no `--requests`) writes the same batches and expected rows as before (the
  generator's draws are unchanged: requests are written after they are built).

**Base pools (stage 3, 2026-11-19).** A pool map whose pool ends in `/traces` or `/logs`
(`pool:<tenant>` or `DEFAULT_POOL`) is refused like one outside `POOL_NAME`: 503 with
`Retry-After: 30`, for every signal, metrics included, and nothing is stored (`validBasePool` in
`src/route.ts`; `contracts/BATCH.md`, "Streams per signal", changed first). Otherwise the metric
shard `{pool}/{slot}` of a pool `p/logs` would be the very object, under the very name, of the log
shard `p/logs/{slot}` of a pool `p`, and `query/` (which tells a shard's signal by its name, D62)
would read it as a log shard. Names that only look alike are pools like any other (`…/tracesx`,
`…/traces-1`, `…/logs/a`, `traces`). `query/` reads pool maps through this module's `poolMap`, so
it refuses such a tenant's reads with 503 too (`stack/README.md`, "Through the gateway").

**Per-item refusals.** A span or record that breaks a rule is refused on its own; the rest is
stored. OTLP answers 200 with `partial_success` (`rejected_spans` / `rejected_log_records`
and an `error_message` naming each reason with its count, at most 2,048 characters), as the
OTLP specification requires ("OTLP/HTTP Response", "Partial Success": "the server MUST
respond with HTTP 200 OK … MUST set the respective rejected_spans … or rejected_log_records
field with the number of … it rejected"; "The client MUST NOT retry the request when it
receives a partial success response"; read from opentelemetry-proto `docs/specification.md`
on 2026-11-19). Loki push answers 400 with the counts and how many entries were written (as
Remote Write: valid entries are stored, the sender does not retry 4xx). A body that does not
decode is 400 (OTLP: a `google.rpc.Status` in the request's encoding); too large is 413.

| Item | Refused when |
|---|---|
| span | `trace_id` not 16 bytes or all zero; `span_id` not 8 bytes or all zero; `parent_span_id` not 0 or 8 bytes; kind not 0–5; status code not 0–2; start or end past 2^63−1 ns; start outside the accept window (24 h back, 5 min ahead); name, trace_state, status message, event name or link trace_state over 8,192 bytes; more than 128 attributes in a list, an empty key, a key over 1,024 bytes, a value over 65,536 bytes; more than 128 events or links; a link id of the wrong length or all zero; an event time past 2^63−1; the span over 256 KiB |
| all spans of a resource and scope | a resource or scope attribute list breaking the attribute rules; scope name or version over 8,192 bytes; the entry over 256 KiB |
| log record | no timestamp; timestamp past 2^63−1 or outside the accept window (24 h back, 5 min ahead); severity number over 24; `trace_id` not 0 or 16 bytes, `span_id` not 0 or 8; line over 256 KiB; severity text over 1,024 bytes; a metadata name breaking `[A-Za-z_][A-Za-z0-9_]*` or over 1,024 bytes, a value over 8,192 bytes or with NUL, a repeated name (Loki), more than 128 entries or 64 KiB; an attribute with an empty key |
| all records of a stream (or OTLP resource and scope) | a label name breaking the rule or repeated, a value over 8,192 bytes or with NUL, more than 32 labels, no labels; Loki labels that do not parse |
| the request (413) | more than `maxSpans` / `maxLogRecords` (200,000 each), or the body limits of metrics |

New limits (`INGEST_LIMITS` may set them): `maxSpans`, `maxLogRecords`, `spanAcceptBackMs`,
`spanAcceptAheadMs`, `logAcceptBackMs`, `logAcceptAheadMs`. The contract's ceilings (attribute
and field sizes) are constants and cannot be raised.

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
- **Every error it sees carries a word** (review of D52, m-8; 2026-11-19). `writeRecorded` turns
  anything thrown into a refusal (`asRefusal`): a refusal stays as it is, a request over the
  limits (413) is `too_large`, and anything else (the limits configuration, the pool map or KV
  unreadable, a shard unreachable, an unexpected error) is `unavailable`. A rejection without a
  word therefore comes only from the platform (no entrypoint, the callee's CPU or memory limit, a
  lost connection), which is when the ruler falls back to Remote Write (D52).

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

## Not implemented

- Remote Write 2.0 (415), native histograms, exemplars, metadata.
- OTLP histograms, exponential histograms, summaries and delta sums (reported in
  `partial_success`). Scope attributes, `target_info`, start timestamps and exemplars
  are ignored. zstd is refused with 415.
- OTLP/gRPC. OTLP traces and logs and Loki push are decoded and appended, but only behind
  `INGEST_SIGNALS` (off everywhere); stage 2 drains their shards into the ledger, `query/` reads
  them behind `QUERY_SIGNALS` (D62), the gateway routes both (stage 3), and the publisher reads
  them without publishing them (D64; "Needed changes" 2).
- For traces and logs: OTLP `schema_url`, the span `type` field (OTLP 1.12, development), event
  and link dropped-attribute counts, link flags, log `event_name`, resource `entity_refs`;
  Loki's service-name discovery (a Loki stream without `service_name` keeps none); Loki's
  `parsed` field; metering active log streams; truncating over-long values instead of
  refusing the item; a per-tenant choice of OTLP stream labels.
- Per-tenant limits: `INGEST_LIMITS` applies to every tenant of the deployment.
- Rate limiting at the edge. Quotas are the shard's job; the edge relays its backpressure
  and, while every shard of a tenant is inside an overload `Retry-After`, refuses that
  tenant's requests before decoding (an isolate-local hint, not a limit).
- Key revocation faster than the 60 s cache, and any tooling to create keys.
- Metrics about the edge itself (rejections by reason, bytes per tenant).

## Verification

```
npm install
npx vitest run --maxWorkers=2   # 62 tests in 8 files, in workerd, against the real Shard
npm run typecheck               # clean
node scripts/mutants.mjs        # 43 mutants, on a copy outside the git checkout (the script refuses to run in it)
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

**Registration before writes (D61).** A shard's `registering` refusal (the stream's
registration is not yet logged) is answered 503 with `Retry-After`, never 429, for Remote
Write and OTLP, and is not taken for an overloaded shard: the tenant's next request still
reaches the shard (`test/overload.test.ts`, "a stream being registered (D61)…"). Mutants,
run on a scratch copy and both caught by that test: `registering` answered 429 ("expected 429
to be 503"), and `registering` noted as overload ("expected 1 to be 2"). This is release A's
edge half of D61 (`shard/README.md`, "Needed changes elsewhere" 1).

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

### Stage 3 of traces and logs (2026-11-19)

The base-pool rule above. `npx vitest run --maxWorkers=2`: **92 passed, 0 failed** (11 files; one
new test in `test/overload.test.ts`: two bad pools (`…/traces`, `…/logs`) as the tenant's map and
as `DEFAULT_POOL`, each refused for Remote Write, OTLP metrics, OTLP traces and Loki push with
nothing in the shard it names or in its derived pools; six look-alike names accepted and stored;
the good map again stores spans in its traces pool). `npx tsc --noEmit` clean.
`node scripts/mutants.mjs --check`: all 73 patterns apply (one older pattern, "spans appended to
the metrics pool", no longer applied since stage 2 moved the derivation to `signalPool`; it now
mutates `signalMap` to return the metrics pool). Run on a copy of the tree in a scratch directory,
after the copy's suite passed 92 of 92, each against the whole suite:

| Mutant | Killed by |
|---|---|
| a base pool ending in `/logs` is accepted | a base pool ending in /traces or /logs is refused (503) … |
| a base pool ending in `/traces` or `/logs` is accepted | the same |
| a pool map whose pool is outside `POOL_NAME` is used (pattern moved into `validBasePool`) | a pool map naming a pool outside POOL_NAME is refused (503) …|
| spans appended to the metrics pool (retargeted at `signalMap`) | the base-pool test; stores every span exactly …; refuses each invalid span … |

Through the gateway, the same rule is also checked end to end and the first mutant killed again
there (`stack/README.md`, "Through the gateway").

### Every error of the recorded-samples entrypoint carries a refusal word (2026-11-19)

Review of D52, m-8: with any shard of the isolate marked hot, `writeRecorded` read the tenant's pool
map in `refuseEarly` outside any `try`, so an unreadable map (invalid, of a newer version, a KV
error) or a missing shared pool rejected with the bare error (`shard pool map is invalid`), and the
ruler took the entrypoint for one that did not answer and sent the same batches by Remote Write.
Errors other than 413 thrown while the samples were read were also rethrown bare. Now
`writeRecorded` wraps the whole call and maps every error (`asRefusal`; the three inner `try`
blocks it replaces mapped the same way). The `unavailable` row of `contracts/ingest.ts` now also
names an unreadable limits record and an unexpected error, and says that every error the
entrypoint sees carries a word (contract text first; no new word, since an older ruler would
take a new one for no answer and fall back).

Two tests in `test/recorded.test.ts`:

- **Through the binding** (`RULER_SINK`, the review's case): a shard sheds load (`maxInFlight: 0`)
  and the call is `overloaded`. The shard then takes load again, and a second `overloaded` proves
  the isolate serving the entrypoint holds a hot shard. Then four tenants whose `pool:` record is
  not JSON, names a pool outside `POOL_NAME`, names a pool ending in `/logs`, or is of a newer
  version are each `unavailable: shard pool map …`.
- **Each error path, with its word**, first with nothing hot and then with a shard hot: the limits
  configuration not JSON, KV failing while the pool map is read, no shard pool configured, an
  invalid pool map, a shard that cannot be reached, an unexpected error while the samples are read
  (a value whose text form throws, only possible in a direct call: such a value cannot cross a
  binding) are `unavailable`, more samples than a call may carry is `too_large`, and each word is
  one the contract lists. With `unauthorized`, `invalid`, `series_limit`, `backpressure` and
  `overloaded` tested above, every word is reached.

**Before the change** (the 859e201 `src/recorded.ts`, in a scratch copy): both new tests fail,
through the binding with exactly `expected 'shard pool map is invalid' to match /^unavailable:
shard pool map /`, the table at the unexpected error (`'injected: no text form'`). **After**: `npx
vitest run --maxWorkers=2`, **94 passed, 0 failed** (11 files); `npx tsc --noEmit` clean.

**Mutants** (`node scripts/mutants.mjs recorded:` on a copy of `contracts/`, `shard/` and `edge/` in
a scratch directory, after the copy's suite passed 94 of 94 and `--check` found all 76 patterns;
each against the whole suite; the copy's sources compared with the shared tree afterwards: equal):
**10 of 10 killed**, the seven earlier entrypoint mutants again (the three inner `try` blocks they
sit beside were removed) and three new ones:

| Mutant | Killed by |
|---|---|
| an error the entrypoint sees is rethrown without a refusal word | through the binding …; each error path …; every refusal word is one the contract lists |
| only HTTP errors get a refusal word (KV and unexpected errors pass bare) | each error path … |
| a request over the limits (413) is `unavailable`, not `too_large` | each error path …; every refusal word is one the contract lists |

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

### Traces and logs (2026-11-19)

```
npx vitest run --maxWorkers=2      # 90 tests in 11 files (19 new in test/traces.test.ts and test/logs.test.ts)
npx tsc --noEmit                   # clean
node scripts/mutants.mjs otel:     # on a copy outside the git checkout
node bench/otel.mjs                # decode CPU per request
node scripts/otel-corpus.mjs OUT 1 2   # then engine/storage/readback and tools/otel_independent_check.py
```

**Last run: 90 passed, 0 failed; `tsc --noEmit` clean.** The 71 metrics and entrypoint tests are
unchanged and pass. New, all through the Worker against the real Shard, with requests written by
test-side protobuf and JSON writers and batches read back by a test-side signal 2/3 decoder
that share no code with `src/` (`test/otelhelpers.ts`), compared with an oracle of the
contracts' mapping written separately:

- **Round trips (properties):** 40 random OTLP traces requests (1–3 resources, 1–2 scopes, 1–8
  spans each; attributes of every AnyValue kind with Unicode, astral characters, U+FFFF, NUL and
  control characters, empty strings, NaN, ±Inf, −0, nested arrays and key-value lists, bytes;
  events, links, clamped ends) and 36 OTLP logs requests, protobuf, JSON and gzip; 12 Loki
  pushes (protobuf with snappy, JSON, gzip). Every stored row equals the input under the
  contract's rules.
- **Refusals:** 15 kinds of invalid span and 11 kinds of invalid log record, each refused on its
  own with the rest stored, counted exactly in `partial_success` (protobuf and JSON bodies
  decoded and checked), a refused resource counting each of its spans; Loki: 7 refused of 9
  entries answered 400 with every reason and "2 written", unparseable labels, repeated label and
  metadata names; 413 above `maxSpans`; 400 with a `Status` for bodies that do not decode; 415.
- **Tenancy:** a resource attribute, stream label and metadata named `tenant`, `X-Scope-OrgID`,
  other headers and a query string naming another tenant move nothing.
- **Routing:** each resource's spans in the slot `slotFor` gives its `job`/`instance` key, the
  same slot number its metrics take; Loki streams by `job`/`instance`; nothing in the metrics
  pool; batches of at most 1 MiB in arrival order. A JSON request carrying the same spans as an
  earlier protobuf one produced the same batch bytes and was stored once (fingerprint).
- **Mapping:** OTLP labels, flattening, `;` joins, level precedence, `unknown_service`, body to
  line, observed time, column fields; `stream_id` equal to values computed in Python.
- **Flag:** 404 without `INGEST_SIGNALS`, and for the signal it does not name.

**Cross-language:** `scripts/otel-corpus.mjs` encodes random requests with **protobufjs**
(from .proto definitions; field numbers as in opentelemetry-proto and Loki's `pkg/push`, both
Apache-2.0) and snappyjs, runs this code's decoders, and `engine/storage`'s strict decoder
accepted every batch and re-encoded each to the same bytes; flushed, the files read back equal
the generator's expected rows in Rust, PyArrow and DuckDB, and TraceQL and LogQL answer the
same over them as over their in-memory sources (`engine/storage/README.md`, five seeds). That
run found a bug here: a double inside an array or key-value list was read from the wrong bytes
when the body was a Node `Buffer` (`slice` is a view there); fixed by copying.

**Mutants (2026-11-19)**, `node scripts/mutants.mjs otel:` on a copy of `contracts/`, `shard/` and
`edge/` in a scratch directory, each against the whole suite: **19 of 19 killed**; the two older
mutants whose patterns this change moved (`no map refetch on stale_epoch`, `no re-split after
too_large`) were updated and re-run: killed. `--check`: all 69 patterns apply.

| Mutant | Killed by (one of) |
|---|---|
| tenant from the body (OTLP traces: a resource attribute `tenant`) | takes the tenant from the credential only |
| tenant from the body (Loki push: a stream label `tenant`) | takes the tenant from the credential only (X-Scope-OrgID is ignored) |
| tenant from `X-Scope-OrgID` (Loki push) | same |
| partial success counts a refused resource once, not each span | refuses each invalid span on its own and counts it |
| partial success says whether, not how many | the same, and its JSON and logs counterparts |
| partial success omitted | the three partial-success tests |
| Loki push 204 despite refused entries | Loki push: invalid entries … refused with 400 |
| `stream_id` without the separator after each value | stream ids are series ids; Loki round trip; OTLP mapping |
| `stream_id` over values only | same |
| span attributes after the third dropped | stores every span exactly; round-trips random requests |
| resource and scope attributes dropped from log metadata | OTLP mapping; OTLP logs round trip |
| the first of a repeated key kept, not the last | logs and traces round trips |
| end before start stored as is | traces round trips; refusals test (the clamped span) |
| span accept window not applied | refuses each invalid span on its own |
| an attribute with an empty key accepted | same |
| OTLP log stream labels from every resource attribute | OTLP mapping; OTLP logs round trip |
| a record without a timestamp stored at 0 | OTLP mapping; OTLP record refusals |
| spans appended to the metrics pool | every test reading the signal pools |
| routes served without `INGEST_SIGNALS` | the two flag tests |

**Decode CPU per request** (`node bench/otel.mjs`, Node 22, V8 but not workerd or Cloudflare's
CPU; 4 shared cores at load average 7 to 9; median of 15 runs after 3 warm-ups, range in
brackets; decode, validation, mapping, batches and SHA-256, no gzip). Measured after removing
per-item allocations (a profile showed GC 30% and `TextEncoder.encode` 30% before; the same
table measured 2.5 to 4 times slower then):

| Request | Items | Body | CPU per request | Per item |
|---|---|---|---|---|
| OTLP traces, protobuf | 1,000 spans, 10 resources, 9 attributes each | 432 KiB | 18.0 ms (8.6–27.0) | 18 µs |
| OTLP traces, JSON | 1,000 | 892 KiB | 17.4 ms (14.4–45.9) | 17 µs |
| OTLP traces, protobuf | 8,000 | 3,440 KiB | 128 ms (103–225) | 16 µs |
| OTLP traces, JSON | 8,000 | 7,100 KiB | 173 ms (133–361) | 22 µs |
| OTLP logs, protobuf | 1,000 records, 3 attributes, trace ids | 268 KiB | 12.9 ms (6.3–16.6) | 13 µs |
| OTLP logs, JSON | 1,000 | 502 KiB | 15.6 ms (7.2–30.1) | 16 µs |
| OTLP logs, protobuf | 8,000 | 2,142 KiB | 83 ms (54–247) | 10 µs |
| OTLP logs, JSON | 8,000 | 3,995 KiB | 151 ms (71–225) | 19 µs |
| Loki push, protobuf + snappy | 1,000 entries, 10 streams | 47 KiB | 4.9 ms (3.1–20.0) | 5 µs |
| Loki push, JSON | 1,000 | 206 KiB | 2.8 ms (2.4–11.5) | 3 µs |
| Loki push, protobuf + snappy | 8,000 | 373 KiB | 37 ms (29–81) | 5 µs |
| Loki push, JSON | 8,000 | 1,637 KiB | 38 ms (22–90) | 5 µs |

Spans cost three to four times a metric sample (4–7 µs): attributes are canonicalised and
typed, and every request's resource is hashed over its canonical JSON.

## Known risks

- **`unavailable` also covers ingest's own bugs.** An unexpected error in the entrypoint is
  answered `unavailable` (retryable), so a bug that fails every call is retried by the ruler
  within each tick (3 attempts) instead of being reported as `invalid`; the message carries the
  error, and nothing is written. The alternative, a new word, would send every older ruler to
  Remote Write (see above).
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
- **Traces and logs CPU.** An 8,000-span request costs 100 to 230 ms of CPU here (Node, noisy);
  OTLP's recommended 64 MiB body would cost seconds. `maxDecompressedBytes` (32 MiB) bounds
  it; nothing was measured in workerd or on Cloudflare.
- **Traces and logs are refused, not truncated**, when an attribute or field is over its limit;
  senders with very long attribute values (SQL statements over 64 KiB) lose those spans and are
  told why.
- **Retries of logs and spans are safe only by row key**, as for metrics; a retry that falls on
  the other side of the accept window is partly refused the second time.
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

1. **ruler: write recorded samples through the entrypoint. Done for writes (2026-11-19,
   D52)**; the stored key remains for queries. The ruler binds `SINK` → viz-ingest's `RecordedSamples` with `props:
   { caller: "viz-ruler" }` (`ruler/wrangler.jsonc`; `deploy/configure.mjs` keeps `entrypoint`
   and `props` and refuses a release whose callee does not export the entrypoint), sends every
   flush with the Ruler object's own tenant, reports `unauthorized`, `invalid` and
   `series_limit` without retrying, splits on `too_large` and retries the rest after the hint
   (`ruler/src/recorded.ts`). For one release, a rejection with no refusal word (an ingest
   release without the entrypoint) goes through Remote Write over `INGEST` with the service key
   instead; `INGEST` goes once every ingest release that may run has the entrypoint (the
   ruler's README, "Needed changes"). The service key now writes only in that fallback; it needs
   `read` for queries until query has its own entrypoint. Since 2026-11-19 (review of D52, m-8)
   every error the entrypoint sees carries a word, so the fallback fires only for a missing
   entrypoint or a platform failure. Still open in the ruler, from the same finding: fall back at
   most once per tick (when the platform fails the call, each of a tick's 3 attempts costs one RPC
   plus one Remote Write).

2. **Traces and logs, stage 2.** The write side is **built** (2026-11-19): the shard's tail
   filter takes `signals` and never throws on a span or log batch (`shard/`); flush encodes a
   span segment into `spans` files by hour and `trace_index` files by day, a log segment into
   `logs` files by day, through `engine/wasm` ABI 3, one unit per segment (`flush/`); the ledger
   lists, plans, logs and expires those tables (`contracts/ledger.ts` `LedgerTable`, `ledger/`);
   the janitor expires them by `trace_days` / `log_days`, purges them and sweeps their orphans
   (`janitor/`); flush's full sweep lists the derived pools of the signals `INGEST_SIGNALS`
   enables. End to end through this Worker, and through viz-traceql and viz-logql:
   `stack/README.md`, "Traces and logs end to end". What remains before `INGEST_SIGNALS` is set
   in a deployment:
   - **publisher** (must come first wherever a publisher runs): it refuses a ledger change that
     adds or removes a file of a table it does not know (`publisher/src/log.ts` `check`,
     `unsupported`) and stops that tenant's publication there, metrics included; and it then
     releases none of the tenant's keys to the janitor. It needs at least to pass over the
     `spans`, `trace_index` and `logs` files (or to publish them: Iceberg tables with hour
     partitions from `start_time`, `contracts/TRACES.md`, `LOGS.md`), and its typecheck to name
     `MetricTable`/`Table` for its metric definitions as it does now (`contracts/ledger.ts`
     keeps `Table` the metric pair for that reason; `LedgerChange.removedFiles` stays typed
     `Table` until it reads the other tables, see the note there).
   - **query**: its metrics tail reads should pass `signals: [1]` (`TailFilter.signals`) and its
     span and log reads `[2]` / `[3]`; the readers over files (`query/src/signals.ts`) find the
     files listed now: `plan` answers for the three tables in milliseconds, the floor of the
     files' nanosecond bounds, as its `msRange` assumes.
   - **edge**: nothing; the mapping of `registering` to 503 (D61) already covers the derived
     pools' new streams.

   **Stage 3 (2026-11-19).** Done since: `query/` reads the tables and sends `signals` (D62); the
   gateway routes `/v1/traces`, `/v1/logs` and `/loki/api/v1/push` here and Tempo's and Loki's
   read paths to viz-query (`deploy/README.md`, "Topology and routes"); edge refuses base pools
   ending in `/traces` or `/logs` (query's "Needed changes elsewhere" 4); the publisher reads the
   tables without publishing them (D64, its README). What remains before the flag is set in
   production is listed once, in `deploy/README.md` ("Needed changes in components", stage 3):
   the publisher's rollback floor, a trial on Cloudflare, a client run.

3. **control (and `shard/src/pool.ts` `dedicatedPool`): a tenant named `traces` or `logs`.** Its
   dedicated pool is `tenant/traces` or `tenant/logs` (`control/src/ops-settings.ts` accepts
   exactly `tenant/<tenant>`), which edge now refuses (503 for every request of that tenant).
   Wanted: control refuses such a pool setting with a reason (or the dedicated pool gets a name
   that cannot end so, e.g. `tenant/<tenant>/p`, with a migration for existing records). No
   such tenant exists in any deployment; `TENANT_ID` allows the names.

## Contract issues (traces and logs, 2026-11-19)

What could not be settled here, or was settled in a way someone else must confirm:

1. **Per-signal pools are a naming convention**, not part of the pool map
   (`shard/src/pool.ts`, a contract this change does not own): `edge`, flush's sweep and query
   must all derive `{pool}/traces` and `{pool}/logs` the same way. A field in the pool map
   would be explicit (D57, "Would change if"). Since stage 3 the convention is unambiguous:
   `contracts/BATCH.md` forbids a base pool ending in `/traces` or `/logs`, and edge enforces it
   when it reads a map. `POOL_NAME` (`contracts/ledger.ts`) cannot say it (the derived pools end
   so), and its comment does not mention it: the file was another engineer's while this was done.
2. **`trace_index` counts over-count** a span stored by two units (`contracts/TRACES.md`,
   "Duplicates across units"). Exact counts need the de-duplicated spans or a compaction that
   re-aggregates fragments from them.
3. **`contracts/ledger.ts` `Table`** did not name the new tables. **Resolved in stage 2** as
   `LedgerTable` (`Table` stays the metric pair, for the code that maps every metric table).
4. **Loki push semantics** for a request with some invalid entries (400, the rest written)
   follow Remote Write and Loki's documentation; Loki's own behaviour was not observed here.
5. **The token filter** has a format (`contracts/LOGS.md` §6) but no builder, reader, or
   ledger fields for its object.
6. **Fields not carried** (listed in "Not implemented") would need new columns.

