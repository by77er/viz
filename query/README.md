# Query

The read path as a service: a Worker that answers the Prometheus HTTP API for one
tenant from that tenant's Parquet files on R2 and the rows still held by its shards, and
the `Leaf` Durable Object it reads files through.

```
 client ─► query Worker ──plan──► engine (WASM)            which matchers, which time ranges
 (Grafana,     │ ──plan x2──────► Ledger (the tenant's)    ONE version: live files + watermarks
  the app)     │ ──scanRows─────► engine                   which files to skip, how much would be decoded
               │ ──read (≤6)────► Leaf pool ──GET──► R2    whole objects, through the Cache API
               │ ──tailRead─────► Shards                   rows above each stream's watermark
               └─ evaluate ─────► engine                   PromQL over (lake files, tail batches)
```

| File | Contents |
|---|---|
| `src/index.ts` | The Worker: routing, authentication, CORS, envelopes, cost headers |
| `src/params.ts` | Prometheus parameter parsing: timestamps, durations, `match[]`, form bodies |
| `src/coordinator.ts` | Plan, one ledger version, pruning, leaf fan-out, tail reads with the fence, evaluation |
| `src/leaf.ts` | `Leaf`: a stateless Durable Object that reads up to six objects from R2 |
| `src/config.ts` | Bindings, per-tenant limits (`limits:<tenant>` in KV) and their defaults |
| `wrangler.jsonc` | The production shape (never deployed) |
| `test/stack.ts`, `test/wrangler.jsonc` | One script for tests: edge + Shard + Ledger + Flush + query + Leaf |
| `test/*.test.ts` | @@TESTS@@ tests in workerd, 8 files |
| `test/measure.bench.ts` | The local measurement (`npm run measure`) |
| `test/fixtures/` | The workload two tenants write, the query table, and the expected results |
| `tools/gen-fixtures.mjs` | Regenerates the fixtures (expected results come from a native reference tool) |
| `tools/mutants.mjs` | The mutation check |

```
(cd ../engine/wasm && ./build.sh)         # the write path's module (flush needs it; owned by engine/wasm)
(cd ../engine/wasm-query && ./build.sh)   # the read path's module
npm install
npm test                                   # @@TESTS@@ tests in workerd, 8 files, about 35 s
npx tsc --noEmit                           # clean
npm run measure                            # the local measurement, about 2 minutes
node tools/mutants.mjs                     # the mutation check, about 20 minutes
node tools/gen-fixtures.mjs                # only when the workload or the query table changes
```

## What a client can do

Point Grafana (a Prometheus data source), the app's API client, or `curl` at the Worker
with an API key that has the `read` scope, as `Authorization: Bearer viz_…` or as the
password of Basic auth.

| Endpoint | Methods | Notes |
|---|---|---|
| `/api/v1/query` | GET, POST | `query`, `time` (default: now), `timeout` |
| `/api/v1/query_range` | GET, POST | `query`, `start`, `end`, `step`, `timeout` |
| `/api/v1/labels` | GET, POST | `match[]` (repeatable), `start`, `end` |
| `/api/v1/label/<name>/values` | GET | `match[]`, `start`, `end`; the name is URL-decoded |
| `/api/v1/series` | GET, POST | `match[]` (at least one), `start`, `end` |
| `/api/v1/metadata` | GET | always `{}`: no metric metadata is stored. Present because the app's client calls it |
| `/api/v1/status/buildinfo` | GET | minimal: `version` is `0.1.0-viz`, the other fields empty |
| `/healthz` | GET, HEAD | no key |

- **Parameters as Prometheus parses them.** Times are Unix seconds (`1795003200`,
  `1795003200.123`, `1.7950032e9`) or RFC 3339 with fraction and offset. `step` and
  `timeout` are a number of seconds (`15`, `0.5`) or a Prometheus duration (`15s`,
  `1m30s`, `1h`, `500ms`; units in descending order, as Prometheus requires). POST bodies
  are `application/x-www-form-urlencoded`, merged with the URL's parameters. Decimal
  seconds become milliseconds on the digits, with no float multiplication.
- **The envelope.** `{"status":"success","data":…}` or
  `{"status":"error","errorType":…,"error":…}`. The `data` of a query is the engine's
  JSON text, passed through unparsed: sample values never become JavaScript numbers.

| `errorType` | HTTP | When |
|---|---|---|
| `bad_data` | 400 | parse errors, bad parameters, `end` before `start`, a step of zero, more than 11,000 steps, a `match[]` that is not a selective series selector |
| `unauthorized` | 401 | no key, a malformed, unknown, wrong or disabled key (with `WWW-Authenticate`) |
| `forbidden` | 403 | a valid key without the `read` scope |
| `execution` | 422 | PromQL evaluation errors with Prometheus' wording, and every limit |
| `unsupported` | 422 | valid PromQL the engine does not implement. Not a Prometheus error type |
| `internal` | 500 | a corrupt file or batch |
| `unavailable` | 503 | the seam could not be closed (below), a data file is missing, a leaf failed twice, the ledger kept changing, the isolate is over its byte budget, a limits or pool-map record is invalid |
| `timeout` | 503 | the tenant's time limit, or a lower `timeout` parameter |
| `not_found`, `method_not_allowed` | 404, 405 | |

- **What the query cost** (design §6.5), as response headers on every answer, errors
  included, and exposed to browsers through `Access-Control-Expose-Headers`:

| Header | Meaning |
|---|---|
| `X-Viz-Files-Read`, `X-Viz-Bytes-Read` | data files handed to the engine, and their bytes |
| `X-Viz-Files-Listed`, `X-Viz-Files-Skipped` | files the ledger listed for the time range, and those skipped from their index fragments |
| `X-Viz-Scan-Samples` | upper bound on the lake samples the engine decodes, from the row groups' row counts |
| `X-Viz-Shards-Asked`, `X-Viz-Shard-Calls` | shards asked for their tail, and calls made to them |
| `X-Viz-Tail-Batches`, `X-Viz-Tail-Bytes` | what the shards returned |
| `X-Viz-Samples-Loaded`, `X-Viz-Series-Loaded` | what the engine loaded, after de-duplication, summed over selectors |
| `X-Viz-Engine-Ms` | wall time inside the engine |
| `X-Viz-Cache-Hits`, `X-Viz-R2-Gets` | reads answered by the Cache API, and reads that went to R2 |
| `X-Viz-Leaves-Used`, `X-Viz-Leaf-Calls`, `X-Viz-Leaf-Rounds` | leaf objects used, calls to them, rounds |
| `X-Viz-Plan-Attempts` | ledger reads: 1, plus one per refusal by a shard, missing file or version mismatch |
| `X-Viz-Ledger-Version` | the ledger version the answer reflects |
| `X-Viz-Wasm-Memory-Bytes` | the engine instance's linear memory after the query |

## What is implemented

### Authentication and tenancy

`authenticate` is imported from `../edge/src/auth.ts` (not copied) and called with the
`read` scope. The tenant is the `tenant` of the key's record and nothing else. No header,
path segment, parameter or body field is read for it; there is no way for a request to
name a tenant. Every ledger, shard and file read is addressed by that tenant: the ledger
object is `idFromName(tenant)`, `tailRead` takes the tenant, and file keys come only from
that tenant's ledger.

**CORS.** `CORS_ORIGINS` is a comma-separated allow-list. A request whose `Origin` is on
it gets that origin echoed, with `Vary: Origin`; any other origin gets no CORS headers.
`*` is never sent (and is ignored if it is put on the list), and
`Access-Control-Allow-Credentials` is never sent: the API is authenticated by a bearer
key, not by cookies. A preflight (`OPTIONS`) is answered from the list without a key.

### Planning

1. The engine's `plan` gives the fetch ranges (matchers and inclusive millisecond ranges:
   range windows, the lookback, `offset`, `@`, subquery grids). A query with no selector
   (`1 + 1`) reads nothing and wakes nothing.
2. **One ledger version.** `ledger.plan` is called for `metric_series` and then for
   `metric_samples`, over the hull of the ranges. If the two answers differ in `version`
   or `ledgerIncarnation`, both are read again (at most 5 times, then 503). The series
   plan is read first: with a flush in between, an unchecked mix would pair new sample
   files and new watermarks with old series files and drop every newly flushed sample
   without any error (mutant 6 shows it).
3. **Pruning.** The engine's `scanRows` (in `engine/query/src/prune.rs`, exposed through
   `engine/wasm-query`) reads each file's index fragment. A file is skipped when no row
   group overlaps a fetch range in time and, where the range has an equality matcher on
   `__name__`, no row group's `[min_name, max_name]` contains the name. Nothing else
   prunes; a fragment that does not parse keeps its file.
4. **The scan bound.** The same call returns, per file, the rows of the row groups the
   reads touch. Summed over the reads evaluation will make (one per selector), that is an
   upper bound on the lake samples the engine decodes, known before anything is fetched.
   It is checked against `maxScanSamples`. The reason is in "Limits".
5. **File order.** Sample files go to the engine lowest precedence first (a later file
   wins on a duplicate `(series, timestamp)`): compaction outputs by level, then flush
   files by shard, incarnation and sequence range **as numbers**. The ledger's order is
   key order, which is text order, where `…-10-12-…` sorts before `…-2-9-…`. Left as it
   was, a sample rewritten in a stream's 11th flush lost to its 2nd: this was a real
   wrong answer, found by a test here that failed three runs out of four (see "Needed
   changes", 1).

### Fetching through leaves

- A pool of `Leaf` objects per cell, named `leaf/<cell>/<n>`, `LEAF_POOL_SIZE` of them
  (default 32; the tests use 8).
- The coordinator packs the files into **rounds**: at most one call per leaf per round,
  at most **six reads** and 24 MiB per call. A file starts at the leaf chosen by a hash
  of the query id and its key, and moves to the next leaf with room; when no leaf has
  room a new round starts. So 192 files are one round on 32 leaves, and concurrent
  queries start on different leaves.
- A leaf issues its reads in parallel and returns `Uint8Array`s. It refuses a call with
  more than six reads or more than 24 MiB with an explicit status.
- **The 32 MiB RPC limit.** The coordinator knows every file's size from the ledger. A
  file above 16 MiB is cut into range reads of at most 16 MiB (`{ key, offset, length }`),
  spread like any other read and put back together in order; a call's total stays under
  24 MiB. A read that returns a different number of bytes than the ledger recorded fails
  the query. The tests run the whole path with the cut-off lowered to 700 bytes.
- **The seam for row-group reads.** `ReadItem` already carries `offset` and `length`, and
  the index fragment carries each row group's offset and length. Whole-file reads are
  used today (a 1 MB read costs about what a 4 KB read costs: spike S1); reading only the
  footer and the row groups `scanRows` names is the next step, and needs the engine to
  accept a file as footer plus row groups.
- **Leaves hold no state**: no storage, no fields, no alarm. A leaf that fails is retried
  once on the next leaf of the pool; a second failure fails the query with 503.
- **A missing object** (the ledger lists it, R2 does not have it) is never left out: the
  ledger is read again (a plan older than a deletion), and after three such refusals the
  query fails with 503.

### The file cache

A leaf looks in the Workers Cache API before R2 and stores what it read there, with
`Cache-Control: max-age=FILE_CACHE_TTL_S` (default 3600 s), so that erased data ages out
(design §6.3). The cache key is the whole object key. That is safe because the key is
content-hashed (`hash8` of the bytes) and objects are written once, and it holds the
tenant, so one tenant's entry cannot answer for another's. A range read is cached under
the key plus its range. Hits are counted in `X-Viz-Cache-Hits`. Results are not cached.

### The tail, and the fence

The pool map is resolved by `poolMap` of `../edge/src/route.ts`, exactly as ingest does.
Asked are every slot the tenant may write to, and every shard the ledger has a watermark
for (so a stream on a shard that left the map is still read). Shard calls go straight
from the coordinator, in parallel with the leaves, strictly after the ledger was read.

| The ledger says | The shard answers | The coordinator |
|---|---|---|
| watermark `(incarnation, seq)` | `ok` | uses the rows above `seq` |
| watermark | `stale_watermark` (it has discarded above `seq`: a flush was recorded since the plan) | reads the ledger again and starts over |
| watermark | `incarnation_mismatch`, the shard's is newer | reads the ledger again; if it still has the older incarnation, the shard's stream is one the ledger never registered and is read from sequence 0 |
| watermark | `incarnation_mismatch`, the shard's is older | refusal: reads the ledger again; fails after the bound |
| no watermark for this shard | (asked with incarnation 0) `ok` with nothing: no stream | nothing to read |
| no watermark | `incarnation_mismatch` with the stream's incarnation | reads that stream from sequence 0; a `stale_watermark` there (a flush was recorded and discarded in between) sends it back to the ledger |

Each shard, and each missing file, may send a query back to the ledger **three times**;
the fourth refusal fails the query with 503 `unavailable`. Files fetched by an earlier
attempt are kept for the next. There is no path on which a refused shard contributes
"nothing" to an answer.

### Evaluation and limits

The coordinator evaluates in one call to the WASM engine over (series files, sample
files, tail batches), with the tenant's limits passed in.

Limits come from `limits:<tenant>` in KV (a JSON object; any field), over `QUERY_LIMITS`
(a deployment-wide JSON object), over the defaults. A record that is not valid JSON, or
has a limit that is not a non-negative integer, **refuses the query with 503**: guessing
could loosen a limit. Unknown fields are ignored. Records are cached for 30 s per isolate.

| Limit | Default | Error when exceeded |
|---|---:|---|
| `maxSamples` | 2,000,000 | 422 `query exceeded limit max_samples: N samples loaded, the limit is M` |
| `maxSeries` | 20,000 | 422 `… max_series: N series loaded, …` |
| `maxOutputPoints` | 500,000 | 422 `… max_output_points: N points in the result, …` |
| `maxStepPoints` | 1,000,000 | 422 `… max_step_points: N step points (series x steps) for one selector, …` |
| `maxQueryBytes` | 16,384 | 422 `… max_query_bytes: N bytes of query text, …` |
| `maxDepth` | 100 | 422 `… max_depth: N levels of nesting (brackets and operators), …` |
| `maxSteps` | 11,000 | 400 `exceeded maximum resolution of M points per timeseries. Try decreasing the query resolution (?step=XX)` |
| `maxFetchBytes` | 16 MiB | 422 `query exceeded limit max_fetch_bytes: … is N bytes, the limit is M. Narrow the time range, or select fewer metrics by name.` |
| `maxScanSamples` | 3,000,000 | 422 `query exceeded limit max_scan_samples: the data files in range hold N samples the query would decode, the limit is M. Narrow the time range, or select fewer metrics by name.` |
| `maxFiles` | 2,000 | 422 `query exceeded limit max_files: N data files to read, the limit is M. Narrow the time range.` |
| `timeoutMs` | 30,000 | 503 `timeout`. A `timeout` parameter can lower it, not raise it |

**Why the byte cap is 16 MiB and why there is a scan cap.** A cap near 64 MiB of Parquet
was considered first. Measured here, that is not safe, for two reasons.

- The isolate holds the fetched bytes **twice** while the engine runs: the buffers that
  arrived from the leaves, and their copy inside WASM linear memory.
- Parquet holds a sample in 2.5 to 4 bytes (in the measurement below, series files
  included: 1.15 MiB for 480,000 samples scraped every 15 s, 10.6 MiB for 2,880,000
  scraped every 60 s), and the engine holds a decoded sample in 16. The engine's own
  `max_samples` fires only **after** a
  selector's samples are in memory (`engine/query/README.md`, "Known risks"). So a byte
  cap alone lets a query expand five-fold or more before it is refused: measured below,
  a 24-hour query that is refused by `max_samples` still decoded 2.89 M samples from
  10.6 MiB of files and peaked at **76.7 MiB** of WASM memory on its way to the refusal.

`maxScanSamples` bounds the decode from the ledger's row counts, before anything is
fetched: 3,000,000 samples are 46 MiB. With `maxFetchBytes` at 16 MiB the worst case is
32 MiB of bytes plus 46 MiB of samples while loading, or 32 + 31 (`maxSamples`) + 23 (the
step grid at `maxStepPoints`) = 86 MiB while evaluating. The scan cap sits above
`maxSamples` because the bound counts whole row groups, of which a query may need a part.

`maxFetchBytes` is checked twice: against the files' sizes from the ledger before any
file or shard is read, and again once the tail's size is known.

**The isolate's budget.** Queries in flight in one isolate may hold 48 MiB of data files
between them. A query that would take the total past that while others are running is
refused with 503 before it fetches anything; a query alone always runs. After a query
that grew WASM memory past 48 MiB the engine instance is dropped, so the memory can be
reclaimed.

## Not implemented

- **Distributed partial aggregation** (design §6.2): leaves that scan row groups and tail
  rows for a key range, evaluate, and return partial aggregates as Arrow IPC, with `sum`,
  `count`, `min`, `max` decomposed, `avg` as sum and count, and `topk` per split and
  merged. This version evaluates in **one place**, the coordinator, so a query is bounded
  by one isolate: 24 hours of 2,000 series scraped every 15 s (11.5 M samples) is refused.
  What it would take: (a) a logical plan in the engine with a split point below the
  aggregation and a serialisable partial state; (b) splits by series-key range, so that
  all rows of a series reach one leaf whichever shard they came through, which needs
  tail reads filtered by key range; (c) the engine in the leaf (it already runs there:
  same module); (d) the invariance tests extended to "any split gives the same result".
- **Range reads by row group** (the seam is described above).
- **Result caching, and caching leaf partials** (design §6.3). Only immutable files are
  cached.
- **A Container fallback** for plans that do not fit an isolate.
- **Label-matcher access policies, OAuth and OIDC** (design §9): keys with the `read`
  scope see their whole tenant.
- **Revocation.** A deleted or disabled key keeps working for up to 60 s (edge's key
  cache), a changed limits record for 30 s, a changed pool map for 30 s.
- **A real time limit on the engine.** The engine has no clock; the deadline is checked
  between phases and a timer races the I/O. A query inside the engine runs to its end,
  bounded by the sample, step-point and scan limits.
- **Prometheus features**: the `limit`, `lookback_delta`, `stats` and `cost` parameters
  (and `max_series`, `max_samples_read`, `max_query_duration`), which are ignored,
  warnings and infos, exemplars, `/api/v1/metadata` content, `/targets`, `/rules`,
  `/alerts`, `/query_exemplars`, remote read, `DELETE` on series, native histograms.
  Everything `engine/promql/README.md` lists as not implemented returns `unsupported`
  (422) or `bad_data`.
- **Cheap label endpoints.** `labels`, `label values` and `series` load the samples of
  the series they list (the engine has no series-only read). With no `start` and `end`
  they cover all time, as in Prometheus, and are then bounded only by the limits.
- **Statistics for the label endpoints**: `X-Viz-Samples-Loaded` and `-Series-Loaded`
  are 0 for them.
- **Production wiring.** `wrangler.jsonc` binds `SHARD` and `LEDGER` by `script_name` to
  Workers that are themselves still combined scripts. Nothing was deployed, and the
  bindings were only exercised in the one-script composition. `wrangler deploy --dry-run`
  bundles (run with the Cloudflare credentials removed from its environment): 2,625.57 KiB
  to upload, 824.96 KiB gzip, of which 49 KB is JavaScript and the rest the WASM module.
- **Warm leaves.** Nothing keeps the pool warm; first use of a leaf costs a few hundred
  milliseconds on Cloudflare (spike S1).
- **Pinning near the bucket.** `placement: smart` is set in `wrangler.jsonc`; untested.
- **Metrics about itself** (query counts, latencies, refusals).
- Anything that depends on `contracts/LEDGER-LOG.md` (planned; the ledger's business).

## How it was verified

All measured here, locally (Linux x86-64, 4 cores shared with other builds, Node 22.23,
workerd through `@cloudflare/vitest-plugin` 1.8), on 2026-11-18. Nothing ran on
Cloudflare.

`npm test`: **@@TESTS@@ tests, all passing**, in 8 files, three consecutive runs.
`npx tsc --noEmit`: clean. `engine/query`: `cargo test`, @@CARGO@@.

### The reference

`tools/gen-fixtures.mjs` writes `test/fixtures/workload.json`: for each of two tenants,
two Remote Write requests (33 series, 4,257 samples, 30 minutes at 15 s; counters with a reset, gauges, a
classic histogram in two jobs, a series that goes down, goes stale and comes back,
`+Inf`, `-Inf` and `NaN` values, one series with byte-identical labels in both tenants,
and names, labels and values that exist in one tenant only). The second request overlaps
the first by two minutes and **rewrites** `temperature` there with different values.

Expected results come from **a small native tool**, `engine/query/examples/reference.rs`:
it evaluates the query table with `viz-promql` over its in-memory source (`MemSource`),
holding every write in order with the last one winning. It touches no storage code, no
Parquet, no batch, no WASM and no HTTP. (Numbers reach it as decimal text: `serde_json`'s
default float parser can be one unit in the last place off for 17-digit values, which the
first run of the comparison caught as `115.46` against `115.46000000000001`.)

The label endpoints' expected answers are computed in the test from the workload itself.

### The query table

69 queries: 9 selectors (`=`, `!=`, `=~`, `!~`, a regex on `__name__`, the rewritten and
the special-value series, a name that does not exist), 12 with `rate`, `irate`,
`increase`, `resets`, `changes`, `delta`, `deriv`, `predict_linear` and `*_over_time`,
7 aggregations (`sum`, `count by`, `avg without`, `topk`, `quantile`, `stddev`, over
NaN and infinities), 9 binary operators (scalar, ratio of aggregates, comparison, `bool`,
`group_left`, `and`, `or`, `unless`), 4 with `offset` and `@`, 2 subqueries,
3 on histograms (2 `histogram_quantile`), 8 functions and literals (`label_replace`,
`absent`, `time`, `vector`, `scalar`, another step, an odd start and step), 4 that must
fail (many-to-many, a parse error, a type error, `limitk`), and 11 instant queries
(vector, scalar, string, a top-level range vector, at an earlier time, at a moment when a
series is stale, an error). 64 succeed (2 of them with an empty result) and 5 fail, in
both tenants. Plus 10 label-endpoint calls per tenant.

### Results

| Property | Test | Result |
|---|---|---|
| **Invariance.** Every query and label call, both tenants, over HTTP, at three moments: (1) everything in shard tails, one sealed and unflushed segment and one unsealed, the ledgers knowing no stream; (2) the first segment flushed: lake + tail, the tail overlapping the lake in time and rewriting samples that are in it; (3) everything flushed and discarded by the shards: all lake | `invariance.test.ts` | 79 calls x 2 tenants x 3 moments = **474 responses, every one equal to the reference** (parsed JSON; values are strings, so exact), error type, message and HTTP status included; and the response **bytes are identical** across the three moments |
| The same from the Cache API only | `invariance.test.ts` | identical; every file a cache hit, 0 R2 GETs |
| The same table with the lake in 15 flush units per shard (one per metric name, then slices of time; up to 60 files), read in rounds on a pool of 8 leaves, with pruning in force; and the first 15 queries with every file read in 700-byte ranges | `leaves.test.ts` | identical |
| **Tenant isolation.** Two tenants sharing both shard objects (asserted), the bucket, the leaves and the cache. 14 calls covering every endpoint, each tenant, at the three moments: the other tenant's metric name, label name, label value and owner never appear, and the tenant's own do | `isolation.test.ts` | no leak. The series with identical labels returns `120` to one tenant and `1120` to the other at every moment |
| Directed: 14 tenant-looking headers and 11 parameters, each set to the victim's exact name, on 6 endpoints, GET and POST, with the attacker's valid key | `isolation.test.ts` | 200, the attacker's own data |
| Fuzz: 400 requests mixing those headers and parameters, 9 path prefixes and 6 suffixes naming the victim, the victim's key id with the attacker's secret, two keys in one header, form bodies | `isolation.test.ts` | more than 300 reach the Worker and more than 100 are answered; none contains a mark of the victim; the control with the victim's key does |
| A tenant with no data on the same shards | `isolation.test.ts` | empty everywhere |
| **The fence.** Flush + discard between the plan and the tail read, with no watermark registered and with one | `fence.test.ts` | the query re-plans (`X-Viz-Plan-Attempts: 2`) and returns the exact result; also with the shards and the ledger evicted in the window |
| A flush between the two `plan` calls | `fence.test.ts` | both tables read again at one version; exact |
| A ledger that changes on every read | `fence.test.ts` | 503 after 5 reads, not an answer from mixed versions |
| A shard that has discarded past the ledger's watermark for good | `fence.test.ts` | **503 `unavailable` after 4 ledger reads on every query and label endpoint, no `data`**; the other tenant on the same shard object is unaffected; a query with no selector still answers |
| A shard whose stream is newer than the ledger knows; one that is older | `fence.test.ts` | read from sequence 0 after one re-plan, exact; 503 |
| A listed data file deleted from R2 | `fence.test.ts` | 503 after 4 ledger reads; exact again once the object is back |
| A leaf that fails once; leaves that keep failing; a call a leaf refuses | `fence.test.ts` | retried on the next leaf, exact; 503; 503 |
| Leaves evicted between queries and before calls; their storage | `fence.test.ts` | results unchanged; no key, no alarm |
| **Limits.** Each of the five counted engine limits at the limit and one below; depth; steps; the label endpoints; the other tenant keeps its own | `limits.test.ts` | exactly at the limit answers with identical bytes; one below is the documented error, with no `data` |
| `max_fetch_bytes` (lake + tail; lake alone), `max_scan_samples`, `max_files` | `limits.test.ts` | the documented messages; the last three refuse with 0 shard calls and 0 leaf calls |
| The tenant's time limit; an untrustworthy limits record | `limits.test.ts` | 503 `timeout`, not raisable by the parameter; 503 `unavailable` for six kinds of bad record |
| **Concurrency.** 50 queries at once, two tenants, lake + tail | `concurrency.test.ts` | all 50 equal the reference |
| 50 at once while everything is sealed, flushed and discarded underneath | `concurrency.test.ts` | all 50 equal the reference; 39 of them re-planned (last run) |
| A burst over the isolate's byte budget | `concurrency.test.ts` | two run, two get a retryable 503 with nothing fetched; the budget is returned |
| **File order.** A sample written in a stream's 2nd flush and rewritten in its 11th and 12th | `leaves.test.ts` | the last write wins, although the ledger lists the 11th file before the 2nd (asserted) |
| **Pruning.** By name, by time, a regex (prunes nothing), a name outside every file, a name inside a file's range that it does not hold | `leaves.test.ts`, and `engine/query/tests/prune.rs` (a property over 106 queries) | skipped files never change a result; `Samples-Loaded` never exceeds `Scan-Samples` for lake-only data |
| Six reads per leaf call | `leaves.test.ts` | the packing never exceeds six reads or 24 MiB for 1 to 500 files on 1 to 32 leaves; observed calls of a query over every file (more than 24 files on 8 leaves) never exceed six and add up to the files read; the leaf refuses a seventh |
| The cache | `leaves.test.ts` | every cached body hashes to the `hash8` in its own key and has the ledger's size; `max-age` is the configured lifetime; a ttl of 0 neither reads nor fills it |
| **Prometheus compatibility.** The app's client (`app/src/api/client.ts`, unchanged, imported by the test) against the Worker: `queryRange`, `query` (vector, scalar, string, matrix, no time), `labels`, `labelValues` (also a name with a slash), `series`, `metadata`, `buildInfo`; errors as `PromApiError` | `http.test.ts` | every call parses; results equal the reference |
| Response shapes against the Prometheus HTTP API documentation: the keys of the envelope and of `data`, `matrix`/`vector`/`scalar`/`string`, samples as `[number, string]`, `+Inf`/`-Inf`/`NaN` spellings, label endpoints as arrays, `buildinfo`'s six fields | `http.test.ts` | as documented |
| Parameters: 5 spellings of a range x GET and POST, 4 of a step, 3 of an instant, URL + body merged, 21 kinds of bad request x methods, `timeout`, 404s, 405s with `Allow` | `http.test.ts` | as Prometheus answers |
| Authentication: 5 kinds of bad key and 2 keys without `read` on 7 endpoints; Basic auth; a read-only key cannot write | `http.test.ts` | 401 with `WWW-Authenticate`, 403, 200; the secret is never echoed |
| CORS: an allowed origin, 5 others, no origin, preflight, a refused request | `http.test.ts` | echoed only for the allow-list; never `*`; never credentials |
| The engine binding | `engine.test.ts` | see `engine/wasm-query/README.md` |

The shapes were checked against the Prometheus HTTP API documentation
(`prometheus.io/docs/prometheus/latest/querying/api/`, read on 2026-11-18): the envelope
fields, 400 / 422 / 503, the parameters and methods of each endpoint, the four result
types, the label endpoints' arrays, and the six fields of `buildinfo` are asserted as that
page states them. The independent consumer is the app's client. **Grafana itself was not
run against the Worker**, and no response was compared with a running Prometheus.

### Mutation check

`node tools/mutants.mjs` applies one change to the source, runs the whole suite,
restores the source, and prints the failing tests. It first confirms that every mutant
applies and that the unmutated suite passes, and counts a mutant that does not type-check
as invalid. Mutant 8 changes Rust and rebuilds the WASM module before and after.

@@MUTANTS@@

### Measurements

`npm run measure` (`test/measure.bench.ts`), with the production leaf pool size of 32.
Two tenants each write 24 h 5 min of `http_requests_total` for 2,000 series (20 jobs x
100 instances; counters growing by a pseudo-random 0 to 9 per scrape) through the edge
Worker as real Remote Write requests, one per 10 minutes of data. After each request the
segment is sealed and flushed, so the lake holds 144 ten-minute flush units per tenant on
each of 2 shards; the last 10 minutes stay in the shards' tails ("partly flushed").
Tenant A is scraped every 15 s (11,562,000 samples), tenant B every 60 s (2,892,000).
The query is `sum by (job)(rate(http_requests_total[5m]))`. The engine instance is
dropped before each measured query, so the WASM memory figure is that query's peak.

**These are local figures.** R2, the Cache API and Durable Objects are simulated in one
process and answer in well under a millisecond. Wall times say how much work the Worker
and the engine do, not how long a query takes on Cloudflare.

@@MEASURE@@

**Production estimate (modelled, not measured).** From the operation counts above and
the figures measured on Cloudflare: a Durable Object call 10 to 40 ms, an R2 read below
1 MB 45 to 55 ms with six in parallel per leaf (so one wave per leaf call; spike S1), a
ledger `plan` one such call plus 25 to 40 µs per file listed (spike S4), engine CPU twice
the local time (spike S2). The ledger is read first, in two sequential calls; shards and
leaves then run in parallel; leaf rounds are sequential; then the engine.

@@ESTIMATE@@

What the estimate leaves out: key, limits and pool-map lookups in KV on a cold isolate;
first use of a leaf object (250 to 700 ms extra in spike S1, per object, until the pool
is warm); contention when many queries share leaves; the cost of a Cache API read
(unmeasured; assumed below an R2 read); transfer of the bytes from leaf to coordinator
(1 to 11 MiB here); response time to the client. The experiment that would settle it is
`design/VERIFICATION.md` S1 extended with this Worker: the same two queries on Cloudflare,
cold and warm.

## Needed changes in other components

Nothing outside `query/`, `engine/wasm-query/`, `engine/query` and `engine/promql` was
edited. These are for their owners.

1. **`ledger/`, `compact/`, `flush/test/read.ts`: the order of files is text order, and
   it decides which duplicate wins.** `plan` returns files `ORDER BY key`; compaction
   merges its inputs in key order "which is the order a query reads them in"; the engine
   lets the later file win. `L0-<shard>-<inc>-10-12-…` sorts before `L0-<shard>-<inc>-2-9-…`,
   so from a stream's tenth batch on, an older flush can win over a newer one: a
   rewritten sample reverts. This Worker now orders flush files numerically
   (`byPrecedence`), but **compaction still bakes the wrong winner into its output**, and
   two compaction outputs holding the same sample have no defined order at all. Fix:
   give `FileEntry` an explicit precedence (for example the highest sequence, or the
   ledger version, of the newest input), have `plan` return files in that order, and
   have compaction merge in it. `leaves.test.ts`, "a sample rewritten by a later flush
   wins", reproduces the hazard at the ledger (it asserts the 11th file is listed before
   the 2nd).
2. **`engine/storage`: a sample budget inside `select`**, so that a selector is abandoned
   while rows are gathered and not after (the materialise-then-refuse case measured
   above), and **a series-only read** for the label endpoints. With the first, the
   Worker's `maxScanSamples` could be dropped.
3. **`shard/`: `tailRead` needs paging and a filter.** A tenant may hold up to 64 MiB in
   a shard (`tenantMaxBytes`), and one RPC message is limited to 32 MiB: a tail above
   that cannot be read at all (the query fails with 503). It needs a `maxBytes` and a
   continuation, and, for design §6.2, a time-range and key-range filter. Today the
   whole tail is returned and counted against `maxFetchBytes` whatever the query's range.
4. **`shard/`: a way to read "the current stream from sequence 0"** without first asking
   for the incarnation. The coordinator calls `tailRead(tenant, 0, 0)` and uses the
   `incarnation_mismatch` answer to learn it, which costs a second call for every stream
   the ledger has not registered. (`describe` returns more than a reader should see.)
5. **`ledger/`: one `plan` call for both tables** (one version by construction, half the
   calls), accepting several ranges, and paged or index-free above a size (spike S4: a
   plan is 0.8 KB per file because each entry carries its index fragment).
6. **`edge/`: move `auth.ts` and `poolMap` to a shared place.** The query Worker imports
   them from `../edge/src` as instructed; `route.ts` pulls `batch.ts` into the query
   bundle's dependency graph, and edge's in-memory caches (60 s for keys) become the
   query Worker's revocation delay without edge knowing it has a second user.
7. **`engine/wasm`**: none. (`flush` loads its module; the query Worker never does.)
8. **`app/`**: none needed. Its client calls `/api/v1/metadata`, which answers `{}`.

## Contract issues

`contracts/` was not edited.

1. **`contracts/engine.ts` has no place for the read path's needs**: errors with a type,
   limits, statistics, `plan`, the metadata calls, `parseSelectors`, `scanRows`. The list
   is in `engine/wasm-query/README.md`. `Engine` is now implemented by two modules.
2. **File precedence: this Worker departs from `contracts/TABLES.md` on purpose.**
   `TABLES.md` ("Object keys") now says that when files disagree about a
   `(series_id, ts)`, "the one later in key order wins, in a read and in a merge alike",
   and that across a compaction the survivor is not defined. For flush files of one
   stream that rule lets an older write win from the stream's tenth batch on, so a
   rewritten sample would change value when its rows move from the tail to the lake:
   results would depend on where rows live, which `engine/AGENTS.md` forbids. The Worker
   orders flush files by sequence number instead (`byPrecedence`); compaction outputs
   still go by level and key. `contracts/ledger.ts` `Plan.files` states no order and
   `FileEntry` has no precedence. Proposed contract change: a precedence on `FileEntry`
   (for example the highest sequence, or the ledger version, of the newest input),
   files listed in that order, and the read and merge rule stated in terms of it
   ("Needed changes", 1).
3. **`contracts/TABLES.md`, object keys**: the read path now parses flush-file keys for
   the sequence range. Compaction keys have another shape (`L{level}-{span}-{inputs16}-
   {hash8}`), which is only described in `compact/`; `TABLES.md` gives one format.
4. **`ScanInput.tailBatches` "in sequence order"** is defined within one shard. This
   Worker concatenates shards in name order, each in sequence order. A series lives on
   one shard, so it matters only after a pool-map change.
5. **The tail contract has no size bound** ("Needed changes", 3).
6. **`FileEntry.index` is "opaque to the ledger"** and now has a second reader besides
   the engine's `select`: the planner, through `scanRows`. It is still only read inside
   the engine.
7. **Design §6.1 says index objects are fetched separately**; the ledger returns them
   inline (spike S4 found the cost). The Worker uses them inline.
8. **`unsupported` and the 401/403 envelopes are not Prometheus'.** Prometheus has no
   `unsupported`, `unauthorized` or `forbidden` error type. The statuses are the
   standard ones; a client that switches on `errorType` sees three values it may not
   know.

Decisions made here that belong in `design/DECISIONS.md` (not written there: `design/`
was out of bounds): a second WASM module for the read path; the fetch cap of 16 MiB and
the scan cap; leaves return bytes and the coordinator evaluates; the cache key is the
object key; 503 after three refusals per shard; file order by numeric sequence in the
reader.

## Known risks

- **One isolate evaluates.** Everything a query reads is in the coordinator's memory
  twice. The limits keep one query within about 86 MiB in the worst case and the isolate
  budget keeps a burst from adding up, but those are arguments from two measurements,
  not a soak test, and an isolate over 128 MB can end other requests in it (spike S2).
- **Materialise, then refuse.** Below `maxScanSamples` a query can still decode up to
  3 M samples and then be refused by `maxSamples` (measured: 76.7 MiB, 580 files read
  for nothing). The fix is in `engine/storage` ("Needed changes", 2).
- **The scan bound is loose for large row groups.** It counts whole row groups. For
  ten-minute flush files it is tight; for a compacted day file, a one-hour query's bound
  is the day's rows for that metric, and the query may be refused although it would load
  a twenty-fourth of them. Range reads by row group and smaller row groups fix that; so
  compaction, as it is, can make queries fail that worked on uncompacted files.
- **Compacted files were never read by these tests.** The fixtures are flush files.
  `byPrecedence` puts compaction outputs before flush files, which is right when
  compaction only merges older files, and unverified here.
- **The whole tail is read for every query**, whatever its time range, and counts
  against `maxFetchBytes`: a tenant with 10 MiB unflushed pays 10 MiB per query, and one
  with more than 16 MiB cannot query until a flush.
- **Local simulators.** R2, KV, the Cache API, Durable Object eviction and RPC limits
  are miniflare's. The six-connection limit is not simulated at all: the tests prove the
  coordinator never asks a leaf for more than six reads, not that six is what the
  platform allows. Whether a Cache API read inside a Durable Object spends from the
  same budget is unknown.
- **One script hides binding mistakes** (as in `stack/`): the production `script_name`
  bindings have never run.
- **A query that times out keeps working in the background.** The client gets 503
  `timeout` at the deadline, but the request's fetches and its engine call run on until
  the next deadline check (between ledger reads, leaf rounds and before evaluating),
  holding their share of the isolate's byte budget until then.
- **Test hooks are in the production module** (`hooks` in `coordinator.ts`): empty
  unless a test sets them, and reachable only by code inside the Worker.
- **The label endpoints over all time** read every file of the tenant, or are refused
  by the limits. Grafana sends `start` and `end`; a client that does not may get 422.
- **Injected failures print errors.** The fence tests make leaves fail on purpose; the
  runtime logs those exceptions while the tests pass.
- **Edge and the engines changed while this was built.** The suite's last run was
  against the sources as they were at the end of this work.
