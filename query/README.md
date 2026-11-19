# Query

The read path as a service: a Worker that answers the Prometheus HTTP API for one
tenant from that tenant's Parquet files on R2 and the rows still held by its shards, and
the `Leaf` Durable Object it reads files through.

```
 client ─► query Worker ──plan──► engine (WASM)            which matchers, which time ranges; split or one place
 (Grafana,     │ ──plan x2──────► Ledger (the tenant's)    ONE version: live files (in precedence order) + watermarks
  the app)     │ ──scanRows─────► engine                   which files to skip, how much would be decoded
               │ ──tailRead─────► Shards                   rows above each stream's watermark
   one place:  │ ──read (≤6)────► Leaf pool ──GET──► R2    whole objects, through the Cache API
               │ └ evaluate ────► engine                   PromQL over (lake files, tail batches)
   split:      │ ──evaluate ────► L split leaves           each owns a range of series keys, gets its part of the tail
               │                   └─extract (≤6 files)──► reader leaves ──GET──► R2: the part's rows, as one batch
               │                   └ gather + evaluate ──► partial aggregates
               └─ merge ────────► engine                   partials merged, the rest of the query finished
```

| File | Contents |
|---|---|
| `src/index.ts` | The Worker: routing, authentication, CORS, envelopes, cost headers |
| `src/params.ts` | Prometheus parameter parsing: timestamps, durations, `match[]`, form bodies |
| `src/coordinator.ts` | Plan, one ledger version, pruning, leaf fan-out, tail reads with the fence, evaluation; split execution (`runSplit`); the cardinality report |
| `src/leaf.ts` | `Leaf`: a stateless Durable Object that reads up to six objects from R2, extracts one part's rows from them (a reader), evaluates one part of a split query (a split leaf), and summarises one part's series for the cardinality report |
| `src/config.ts` | Bindings, per-tenant limits (`limits:<tenant>` in KV) and their defaults |
| `wrangler.jsonc` | The production shape (never deployed) |
| `test/stack.ts`, `test/wrangler.jsonc` | One script for tests: edge + Shard + Ledger + Flush + query + Leaf |
| `test/*.test.ts` | 75 tests in workerd, 10 files (`split.test.ts` and `cardinality.test.ts` are new) |
| `test/measure.bench.ts` | The local measurement (`npm run measure`) |
| `test/fixtures/` | The workload two tenants write, the query table, and the expected results |
| `tools/gen-fixtures.mjs` | Regenerates the fixtures (expected results come from a native reference tool) |
| `tools/mutants.mjs` | The mutation check |

```
(cd ../engine/wasm && ./build.sh)         # the write path's module (flush needs it; owned by engine/wasm)
(cd ../engine/wasm-query && ./build.sh)   # the read path's module
npm install
npx vitest run --maxWorkers=2              # 75 tests in workerd, 10 files, about 5 minutes on a loaded machine (`npm test` uses every core)
npx tsc --noEmit                           # clean
npm run measure                            # the local measurement, about 2 minutes
node tools/mutants.mjs                     # the mutation check, about 7 minutes
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
| `/api/v1/status/tsdb` | GET | Prometheus' cardinality statistics, over a window of the tenant's data (default the last day; `start`, `end` or `range`, viz extensions), `limit` items per list (default 10, at most 10,000). "Cardinality report" below |
| `/api/v1/status/cardinality` | GET | viz's report: `range` (default `1d`) before `end` (default now), `lookback` (default the range), `limit`: top metrics with the labels behind their cardinality, top label names and pairs, series created in the range |
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
| `X-Viz-Execution` | `single` (one place) or `split` (over leaves) |
| `X-Viz-Split-Reason` | why a query was evaluated in one place (`… does not decompose`, `a selector outside any aggregation`, `the query fits in one place`, …) |
| `X-Viz-Split-Leaves` | parts the series were split into (one split leaf each) |
| `X-Viz-Reader-Calls` | calls split leaves made to readers (one per group of at most six files, per leaf) |
| `X-Viz-Rpc-Bytes` | bytes of a split query that crossed RPC: extracts, tail parts, leaf answers |
| `X-Viz-Leaf-Peak-Wasm-Bytes`, `X-Viz-Leaf-Max-Samples` | the largest engine memory a split leaf reported, and the most samples one held |
| `X-Viz-Leaf-Reruns` | split leaves run again after stopping at their share of the budget |

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
   wins on a duplicate `(series, timestamp)`), in the order of the **precedence the ledger
   assigns** (`contracts/ledger.ts` `LiveFile`, design D22): `plan` lists files in
   ascending precedence, and `inPrecedenceOrder` re-states that order from the
   `precedence` field (a stable sort that leaves a correct plan untouched). Split
   execution hands the readers the files in the same order and ranks their extracts by it.
   (This replaces `byPrecedence`, which derived an order from the keys: key order is
   text order, where `…-10-12-…` sorts before `…-2-9-…`, and a sample rewritten in a
   stream's 11th flush lost to its 2nd. That wrong answer, found by a test here, is what
   made the ledger assign precedence.)

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
| `splitAboveSamples` | 1,500,000 | (not an error) a query that decomposes is split above this scan bound |
| `maxQuerySamples`, `maxQuerySeries` | 64,000,000, 640,000 | a split query, over all leaves: 422 `… max_samples: [at least] N samples loaded, the limit is M …` (`M` is `min(this, leaves x maxSamples)`) |
| `maxQueryScanSamples` | 100,000,000 | a split query: 422 `query exceeded limit max_query_scan_samples: …` |
| `maxQueryFetchBytes`, `maxQueryFiles` | 512 MiB, 20,000 | a split query: 422 `… max_query_fetch_bytes …`, `… max_query_files …` |
| `maxLeaves` | 32 | (not an error) the most parts a query is split into |
| `maxCardinalitySeries`, `maxCardinalityPairs` | 1,000,000, 2,000,000 | the cardinality report: 422 `cardinality report exceeded limit max_series` / `max_pairs` |

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

### Split execution

A query that decomposes (`engine/query` README, "Split execution": every selector inside an
aggregation such as `sum`, `avg`, `count`, `min`, `max`, `group`, `stddev`, `stdvar`,
`topk`, `bottomk`, `count_values` over a series-local argument) is **split over leaves by
series** when one place is not enough: its scan bound is above `splitAboveSamples`
(1,500,000, three quarters of `maxSamples`), or its files are over `maxFetchBytes` or
`maxFiles`. Otherwise it runs in one place, which is cheaper (every part of a split reads
every file). A query that does not decompose always runs in one place under the
one-place limits. `X-Viz-Execution` and `X-Viz-Split-Reason` say which and why.

1. **Leaves.** `L = ceil((scan bound + tail bytes / 20) / (0.75 x maxSamples))`, at least
   2, at most `maxLeaves` (32) and the pool. Part `j` owns series keys in
   `[j·2^64/L, (j+1)·2^64/L)` (the key is the `series_id` unless the query can change
   labels); every sample of a series reaches one leaf.
2. **The tail** is read by the coordinator with the usual fence (refusals re-read the
   ledger), cut by part in the engine (`splitTails`), and each part goes to its leaf.
   So every series' lake rows and tail rows meet in one leaf (I17: a `rate` window that
   straddles them sees one stream). Only the tail is held at the coordinator.
3. **Split leaves** (`Leaf.evaluate`, `leaf/<cell>/<n>` objects chosen from the query id)
   call **readers** (`Leaf.extract`, other objects of the same pool) for every group of at
   most six files (sample files in precedence order, each with its series file), all at
   once. A reader reads its files (Cache API, then R2) and returns its part's rows as one
   batch. The leaf gathers extracts as they arrive (each ranked by its group's position)
   and its tail batches, then evaluates the query's aggregations into partials.
4. **The coordinator** merges the answers (`mergeJson`) and finishes the query. Limits are
   replayed on the summed counts in the order one place checks them.

**Budgets.** The query may load `min(maxQuerySamples, L x maxSamples)` samples and
`min(maxQuerySeries, L x maxSeries)` series; each leaf gets a share, and the shares add up
to the query's budget (so no leaf may hold more than one isolate's `maxSamples`). A leaf
stops **while gathering** as soon as it holds more than its share (what it holds is a
lower bound of what it would load), or at a `select` over its share, and says so. Then:
if the leaves' counts already prove the query over its budget, it is refused (422
`query exceeded limit max_samples: at least N samples loaded, the limit is M (over L
leaves)`); otherwise a leaf the uneven spread pushed over its share is run again once with
what the others left (`X-Viz-Leaf-Reruns`), and if it stops again the query is refused.
When no leaf stopped, a query over its budget gets one place's exact message.

**Failures.** A reader or a split leaf that throws is retried once on the next object of
the pool; a second failure fails the query (503). A file a reader cannot find sends the
query back to the ledger, as for one place, three times at most. A leaf's answer is used
once whatever happened to a retried call.

**Cost.** Each file is read once per part (from the Cache API after the first) and its
`series_id` column decoded once per part; a part's samples are decoded by its own readers
only. Extracts cross RPC at 20 bytes a row (`X-Viz-Rpc-Bytes`). See "Measurements".

### Cardinality report

`/api/v1/status/tsdb` and `/api/v1/status/cardinality`: one ledger version of the tenant's
`metric_series` files over `[start − lookback, end]` (pruned by time) and every shard's
tail, with the same fence as a query, read by the tenant of the key and nothing else.
Counted in one place, or over leaves (each owning a range of `series_id`s and reading
every series file) when the series files are over `maxFetchBytes`. No sample is read.

- **Counting is exact, with caps** (`maxCardinalitySeries` 1,000,000 series seen;
  `maxCardinalityPairs` 2,000,000 label pairs plus (metric, label, value) triples). Above a
  cap the report is refused with 422 `cardinality report exceeded limit max_series: …`;
  below them the error is zero. Over leaves each part has the whole cap.
- **`/status/tsdb`** answers Prometheus' `TSDBStatus` shape, in its field order, checked
  against the Prometheus HTTP API documentation (read 2026-11-18): `headStats`
  (`numSeries`: series in the window; `numLabelPairs`: distinct pairs, a field of
  Prometheus' struct that the documentation's example omits; **`chunkCount` is `null`**:
  viz has no chunks; `minTime`/`maxTime`: first and last sample seen in the window,
  `null` when there is none), `seriesCountByMetricName`, `labelValueCountByLabelName`,
  `memoryInBytesByLabelName` (the documented definition: the lengths of a label's
  distinct values added up; viz's real memory use is not that), and
  `seriesCountByLabelValuePair` (`"name=value"`), each largest first, ties by name. These
  describe the window, not a head block.
- **`/status/cardinality`** adds `seriesCreated` (series whose first sample seen, reading
  from `start − lookback`, is in the range: churn), per metric its series, created series
  and its labels by distinct values (the labels that make its cardinality), label names
  with values and bytes, label pairs, and created series by metric.
- "In the window" is decided from a series file's first and last sample per file: a
  series that has samples in a file on both sides of the window but none inside counts as
  in it (at most one file's span at each edge: ten minutes for flush files).

### Release skew (contracts/COMPATIBILITY.md)

- **Every shard status is handled by name.** `tailRead` answers `ok`, `stale_watermark`
  and `incarnation_mismatch` are handled as before; `schema_too_new`, any status this
  release does not know, and an `ok` without batches are a retryable 503 (`unavailable`,
  `Retry-After: 1`), never an empty tail and never a stream to re-read
  (`fence.test.ts`, "release skew", through a test hook that replaces the shard's answer).
  A ledger that throws `schema_too_new` is a 503 with `Retry-After: 5`.
- **Leaves keep no storage** (no SQLite, no alarm), so they have no schema to open through
  `contracts/schema.ts`.
- **An engine that does not load is a 500**, not a retryable 503: the binding throws
  `EngineLoadError` (instantiation failed, or the module's ABI is not the binding's), the
  Worker answers `internal`, and a split leaf whose engine does not load fails its query
  with 500 too (`http.test.ts`).
- Not done: the coordinator–leaf RPC arguments (`EvaluateRequest`, `ExtractRequest`, the
  cardinality request) carry no `v` field. The leaves' answers are versioned by their
  magic (`VZL1`, `VZC1`, `VZB1`) and the module by its ABI number, but an answer with an
  unknown magic is reported as `internal` (500), not as a retryable refusal. During a
  gradual deployment a coordinator of one release can call a leaf of the other; both are
  in the same script, so this needs a `v` on the requests and an `unsupported_version`
  answer before either format changes.

## Not implemented

- **Split execution, what is left.** Queries that do not decompose (`quantile` or
  `absent` over raw series, binary operators between vectors below an aggregation,
  aggregations inside subqueries, a selector outside every aggregation) still run in one
  place and are bounded by one isolate. Partials travel in the engine's binary form, not
  Arrow IPC. Readers read whole files, so every part reads every file of the range
  (`L`-fold reads and `series_id` decodes; "Needed changes", 2). The tail is cut by part
  at the coordinator, not filtered at the shards. Leaf partials are not cached. Evaluation
  in time slices (which would split queries that do not decompose by series) is not built.
- **Range reads by row group** (the seam is described above).
- **Result caching, and caching leaf partials** (design §6.3). Only immutable files are
  cached.
- **A Container fallback** for plans that do not fit an isolate (split execution covers
  the ones that decompose).
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
- **A plan-only endpoint** (asked for by the MCP builder): the bytes, files and scan bound
  a query would read, and whether it would split, without evaluating. Everything it would
  return is computed before any file is read (the cost headers of a refused query show
  it), so it is `gather` stopping after the ledger read; not built.
- **Metric metadata** (type, unit, help; also asked for by the MCP builder):
  `/api/v1/metadata` answers `{}` because nothing stores it; the write path drops
  Remote Write metadata and OTLP descriptions.
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
workerd through `@cloudflare/vitest-plugin` 1.8), on 2026-11-18 and 19. Nothing ran on
Cloudflare.

**After split execution and the cardinality report (2026-11-19, about 01:00 UTC, load
average near 20):** `npx vitest run --maxWorkers=2`: **78 tests, all passing**, in 10 files
(102 s): the 62 earlier ones, 8 in `split.test.ts`, 5 in `cardinality.test.ts`, 2 release-
skew tests in `fence.test.ts` and 1 in `http.test.ts`. `npx tsc --noEmit`: clean.
`engine/query`: `cargo test`, 47 passed; a soak of its two split properties at 120 cases
each passed. `engine/promql`: 27 passed, 1 ignored. `node
../engine/wasm-query/tools/check.mjs`: 12 of 12. `node tools/gen-fixtures.mjs` was re-run
with the reference's new aggregations: `workload.json` is byte-identical, `expected.json`
changed only in the `stddev` query (16th and 17th significant digits, both tenants).
Two things in other components changed under these tests and were followed here: the
ledger now lists files by precedence (`leaves.test.ts`), and flush tells a shard
`recorded` only at the ledger's logged watermark, so `flushAll` in `test/world.ts` runs the
ledger's alarm and flushes again (without it no shard discarded, and four tests that need
an all-lake moment failed).

Before (2026-11-18): `npm test`: 62 tests, all passing, in 8 files, in five full runs that
day (39 to 45 s); `engine/query` 37 passed; `engine/promql` 26 passed, 1 ignored.

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
first run of the comparison caught as `115.46` against `115.46000000000001`.) It is the same PromQL
evaluator the Worker runs, so these tests check everything between HTTP and the evaluator
(fetching, the seam, storage, WASM, the envelope), not PromQL semantics; those are checked
against the upstream test corpus and the Prometheus Go engine in `engine/promql`.

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
| `max_fetch_bytes` (lake + tail; lake alone), `max_scan_samples`, `max_files` | `limits.test.ts` | the documented messages; the last three refuse with 0 shard calls and 0 leaf calls, and the refusal still reports the files listed and the scan bound in its cost headers |
| The tenant's time limit; an untrustworthy limits record | `limits.test.ts` | 503 `timeout`, not raisable by the parameter; 503 `unavailable` for six kinds of bad record |
| **Concurrency.** 50 queries at once, two tenants, lake + tail | `concurrency.test.ts` | all 50 equal the reference |
| 50 at once while everything is sealed, flushed and discarded underneath | `concurrency.test.ts` | all 50 equal the reference; 35 of them re-planned in the last run (39 in an earlier one) |
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
| **Split equals one place.** The 69 queries of the table and 32 aggregation-heavy queries (as range and instant: 64 more), tenant a at 1, 2, 7 and 32 leaves and tenant b at 7, at the three moments of the invariance test (all tail; lake + an overlapping tail that rewrites samples; all lake) | `split.test.ts` | **every response byte-identical to one place** (the table's also equal to the reference); split answers report the same samples and series loaded; at least 296 split answers per moment (the rest fall back and say why). 133 queries x 5 evaluations x 2 tenants x 3 moments, about 100 s |
| Fallback: 8 queries that do not decompose, with splitting forced | `split.test.ts` | evaluated in one place, `X-Viz-Split-Reason` names why, results equal the reference; a small query that decomposes stays in one place ("fits in one place") |
| Splitting by itself above `splitAboveSamples` | `split.test.ts` | split over 2 leaves, the same bytes; reader calls, RPC bytes and leaf memory reported |
| **Per-leaf budgets.** Shares of exactly the query's size (2 leaves; and 7 leaves, one at a time); one sample less; shares of 20 samples; a series budget of 1 | `split.test.ts` | the same bytes, with leaves run again (`X-Viz-Leaf-Reruns` > 0 at 7); 422 naming `max_samples` with no data; with tiny shares every leaf stops while gathering, holding far fewer samples than the query (`X-Viz-Leaf-Max-Samples`), 422 `… at least N samples loaded, the limit is 40 (over 2 leaves)`; 422 `max_series` |
| Failures: a reader that fails once, a split leaf that fails once, a split leaf that keeps failing | `split.test.ts` | retried: the same bytes and the same samples loaded (not counted twice), 4 leaf calls for 3 parts; 503 |
| A listed file missing from R2 and the cache, with splitting forced | `split.test.ts` | 503 after 4 ledger reads, no partial answer; the same query answers again once the object is back |
| Lake + overlapping tail at 1, 2, 7 leaves, explicitly (I17) | `split.test.ts` | equal to the reference; a `max` over the rewritten series equals one place |
| **File order follows the ledger's precedence.** Unit: `inPrecedenceOrder` and reader groups over files whose precedence order is not their key order; end to end: 11 flushes of one sample | `leaves.test.ts` | the engine (one place) and the readers (split over 2) receive the files in exactly `Plan.files` order, which is not key order; the latest write is read back |
| **Cardinality, known data.** 75 series in the window (5 that existed before it), 66 label pairs, lake + tail | `cardinality.test.ts` | `/status/tsdb` equal to the expected object, in Prometheus' field order; the same bytes over 2, 3 and 7 leaves; `limit` cuts every list (default 10); bad limits are 400 |
| Churn and per-metric label cardinality | `cardinality.test.ts` | 70 created (not the 5 seen 90 minutes before the window); without the look-back all 75 count as created; a window holding only an old series; per metric the labels by distinct values; the same over 4 leaves |
| Caps | `cardinality.test.ts` | at 76 series seen and 135 pairs + triples it answers; one below, 422 naming the cap |
| **Cardinality isolation.** Two tenants on the same shards, lake and tail; a parameter and headers naming the other tenant | `cardinality.test.ts` | the other tenant's metric, label and values never appear, one place and over leaves; a tenant with no data gets zeros and nulls |
| The lake alone after the shards discard | `cardinality.test.ts` | the same report |

**The independent client.** The app's API client (`app/src/api/client.ts`) used to be
the independent consumer; `app/` is not on `main`, so `http.test.ts` now uses
`test/client.ts`, a small Prometheus API client written from the API documentation (GET
with parameters, a bearer key, the `{status, data}` envelope, `PromApiError`). The tests
need nothing outside `query/` but the components they run (edge, shard, ledger, flush and
their test helpers).

The shapes were checked against the Prometheus HTTP API documentation
(`prometheus.io/docs/prometheus/latest/querying/api/`, read on 2026-11-18): the envelope
fields, 400 / 422 / 503, the parameters and methods of each endpoint, the four result
types, the label endpoints' arrays, and the six fields of `buildinfo` are asserted as that
page states them. The independent consumer is the app's client. **Grafana itself was not
run against the Worker**, and no response was compared with a running Prometheus.

### Mutation check

`node tools/mutants.mjs` applies one change to the source, runs the whole suite,
restores the source, and prints the failing tests. It first confirms that every mutant
applies and runs the unmutated suite; a test that fails there (another component
mid-edit) cannot kill a mutant, and a mutant is invalid only if it adds a type error that
the unmutated sources do not have (the tool compares with a baseline since a ledger edit
left type errors in `ledger/` for a while). Vitest runs with two workers. Mutant 8 changes
Rust and rebuilds the WASM module before and after. **The tool edits `src/` in place:
build, test or snapshot nothing from `query/` while it runs** (a CI snapshot taken during
`engine/query`'s mutation run tested a mutant; see that README).

Run 2026-11-18 for mutants 1 to 26 (before split execution; 10 since rewritten): **26 of 26
killed, none survived, none invalid**; the unmutated suite passed first; 6 min 54 s.
After the run every source was back (each mutant's text found exactly once again) and the
rebuilt module had the same SHA-256 as before the run.

| # | What the mutant breaks | Killed by (test file › test) |
|---:|---|---|
| 1 | **tenant from a header** (`X-Scope-OrgID` overrides the key's tenant) | isolation › fuzz (directed headers) |
| 2 | tenant from a `tenant` parameter | isolation › fuzz (directed parameters) |
| 3 | **the `read` scope is skipped** (any key that can write may query) | http › a key without the read scope is 403 on every endpoint |
| 4 | **the tail is skipped** (lake only) | invariance › 69 queries x 2 tenants identical in the three placements (and the cache test) |
| 5 | **`stale_watermark` is ignored** (treated as an empty tail) | fence › flush and discard between plan and tail read; the same with a watermark registered; a shard that discarded past the watermark for good |
| 6 | **series and sample files from different ledger versions** | fence › a flush between the two plan calls; a ledger that never stops changing |
| 7 | only the first slot of the pool map is asked for its tail | invariance › the three placements |
| 8 | **unsound name statistics** (Rust, `prune.rs`: `<` instead of `<=` against `max_name`; rebuilds the module) | invariance › the three placements; leaves › later flush wins, many files, skipping never changes a result (6 tests) |
| 9 | files pruned against the first fetch range only | leaves › many files; skipping by time and name |
| 10 | sample files read in the ledger's key order | leaves › a sample rewritten by a later flush wins |
| 11 | **more than six reads per leaf call** (the packer allows twelve) | leaves › packing property; many files in rounds; skipping (4 tests) |
| 12 | the leaf does not refuse a seventh read | leaves › refuses a seventh read; fence › a call a leaf refuses is 503 |
| 13 | **non-content cache key** (the `hash8` is dropped from the cache key) | leaves › caches by object key |
| 14 | cache key is the file name only (no tenant, no day) | leaves › caches by object key |
| 15 | **partial data**: a missing file is left out | fence › a data file the ledger lists but R2 does not have: 503 |
| 16 | **partial data on leaf failure**: a leaf that fails twice contributes nothing | fence › leaves that keep failing are 503 |
| 17 | **mis-parsed step**: a bare number is milliseconds | http › times and steps in every spelling, and 6 more |
| 18 | mis-parsed step: the `m` unit is milliseconds | http › times and steps in every spelling |
| 19 | times parsed as milliseconds, not seconds | http (11 tests) |
| 20 | the tenant's limits are not passed to the engine | limits › each engine limit |
| 21 | `max_fetch_bytes` not enforced | limits › max_fetch_bytes |
| 22 | `max_scan_samples` not enforced | limits › max_scan_samples and max_files |
| 23 | the isolate's byte budget not enforced | concurrency › a burst over the budget is a retryable 503 |
| 24 | CORS echoes any origin | http › CORS |
| 25 | the series files are not handed to the engine | invariance › the three placements |
| 26 | after the refusal bound the query answers from what it has | fence › discarded for good; a shard behind the ledger; a missing file (3 tests) |
| 27 | **split by file instead of by series** (each leaf reads some file groups and keeps every series in them) | split › the table + 64 at 1, 2, 7, 32 leaves; split by itself; budgets; reruns; … (7 tests) |
| 28 | **the tail evaluated apart from the lake** (each leaf gets another leaf's tail rows) | split › the same 7 tests |
| 29 | **a leaf's partial merged twice when a leaf was retried** | split › a reader or a split leaf that fails once is retried, nothing counted twice |
| 30 | **the per-leaf budget not enforced** | split › each leaf stops at its share; a leaf over its share is run again |
| 31 | **a query that does not decompose sent to the leaves anyway** | split › the table at 1, 2, 7, 32 leaves; the fallback test |
| 32 | reader groups of eight reads | leaves › files go to the readers in precedence order (groups of at most six); split › the table |
| 33 | **cardinality counts the tenant named by a `tenant` parameter** | cardinality › never counts another tenant's series |
| 34 | **churn counts series that existed before the range** (the look-back window is not read) | cardinality › churn; caps (2 tests) |
| 35 | a split query's result checked against one leaf's share instead of the query's budget | split › budgets; reruns (2 tests) |
| 36 | an unknown shard status falls through to the stream-mismatch path | fence › release skew: an unknown status or schema_too_new is a retryable 503 |
| 37 | an engine that does not load answered as a retryable 503 | http › an engine that does not load is a 500 |

Mutants 27 to 37 are new with split execution, the cardinality report and the
compatibility fixes; mutant 10 was rewritten for the precedence order (it now sorts by
key). **Run 2026-11-19 (mutants 10 and 27 to 37): 12 of 12 killed, none survived, none
invalid**; the unmutated suite was run first. The kinds of mutant asked for are rows 27 (by
file), 33 and 34 of this table, 29 (retry counted twice), 30 (budget), 31 (not
decomposable), 28 (tail apart from the lake), and, in `engine/query`'s table, 32 to 41
(`topk` k too small, `avg` as a mean of means, merge order, precedence, limit replay,
rounding).

The ten kinds of mutant the task names are rows 1, 4, 5, 6, 8, 11 and 12, 3, 13, 16 (and
15), 17 and 18. Fourteen mutants are caught by exactly one test (1 to 3, 10, 13 to 16, 18,
20 to 24). In particular the isolation fuzz is the only test that catches the two
tenant mutants, and the cache-key unit test the only one for the two cache-key mutants: a
behavioural cache test would need two objects whose keys differ only in their hash, which
the write path never produces.

### Measurements

#### With split execution (2026-11-19)

`npm run measure`, the same workload and query as below (`sum by (job)(rate(http_requests_total[5m]))`,
2,000 series, 24 h 5 min, flushed in ten-minute units on 2 shards, the last 10 minutes in
the tails), plus a third tenant with **5,000 series at 60 s for one day** (7.23 M samples),
the 7-day query scaled down by 7 because seven days through the local stack would not fit
the 1.5 GB this shared machine allows one process. **Local figures**, on 4 cores at a load
average near 20 (other engineers' builds): engine times were 1.2 to 2.9 times the
2026-11-18 run's for the same 1-hour query (96 and 234 ms against 81 to 145 ms).

Split leaves are run **one after another**, each from a fresh engine instance, so that each
memory figure is that leaf's own peak: locally every object shares one process, and eight
leaves at once held 1.6 GB of RSS together (sessions, readers' buffers, extracts in
flight), more than this machine allows; that first attempt was stopped. The figures below
are from a complete run at about 00:55 UTC (counts, memory, answers) and a second at about
01:10 (where the CPU goes; there the 24-hour 15 s query reached the default 30 s time
limit at 32.4 s with its leaves in series, though every leaf finished, so the bench now
gives its tenants 120 s).

| | 24 h, 15 s scrape, step 5 m | 24 h, 60 s scrape, step 5 m | 1 day of the 7-day query: 5,000 series, 60 s, step 30 m |
|---|---:|---:|---:|
| answer, default limits | **200** (was 422 `max_scan_samples`) | **200** (was 422 `max_samples` after decoding 76 MiB) | **200** |
| samples loaded / series | 11,560,000 / 2,000 | 2,890,000 / 2,000 | 7,225,000 / 5,000 |
| leaves (parts) | 8 | 2 (and 8, forced) | 5 |
| samples held per leaf | 1,051,960 to 1,907,400 | 1,361,190 and 1,528,810 | 1,199,350 to 1,748,450 |
| series per leaf (of 2,000 or 5,000) | 182 to 330 | 942 and 1,058 | 830 to 1,210 |
| **peak WASM memory per leaf** | **47.1 to 84.1 MiB** | 64.4 and 71.8 MiB (8 leaves: 13.7 to 23.5 MiB) | **53.6 to 77.4 MiB** |
| coordinator's WASM memory (merge) | 7.5 MiB | 3.8 MiB | 6.4 MiB |
| files listed / read (each by every leaf's readers) | 580 / 580 (27.8 MiB) | 580 / 580 (10.6 MiB) | 580 / 580 (26.0 MiB) |
| reader calls (97 file groups per leaf) | 776 | 194 | 485 |
| file reads (R2 + Cache API) | 4,640 (556 R2 GETs from R2 cold) | 1,160 | 2,900 |
| **bytes over RPC**: extracts to leaves | **234.9 MiB** | 70.1 MiB | 175.4 MiB |
| tail to leaves / answers to the coordinator | 0.96 MiB / under 1 MiB | 0.39 MiB / under 1 MiB | 0.97 MiB / under 1 MiB |
| local wall time, leaves in series, files from R2 / from the Cache API | 13.9 s / 13.9 s | 4.2 s | 18.9 s |
| per leaf (second run): its own engine (gather + evaluate) | 760 to 2,061 ms (median about 1,050) | | 582 to 1,400 ms |
| per leaf: its readers' engine time, sum (longest call) | 1,005 to 1,584 ms (37 to 240 ms) | | 1,632 to 2,967 ms (78 to 204 ms) |
| merge at the coordinator | 37 ms | 4 ms | 2 to 8 ms |
| response | 194,948 B | 172,808 B | 30,385 B |

- **Identical to one place at scale**: 24 hours at a 60 s scrape split over 2 leaves, over
  8 leaves, and evaluated in one place (with `maxSamples` raised to 3 M, peak 76.4 MiB)
  gave **byte-identical** responses. Every split result was also checked (20 jobs, every
  point within 15% of the expected rate) and is identical from R2 and from the cache.
- **Memory per leaf** is about 44 bytes a sample held: 20 in the gathering session (time,
  value, precedence), 16 in the copy `select` hands the evaluator (it could move instead),
  and the step grid. The leaf with the most series held 1.9 M samples (84 MiB), below its
  share (2 M) and 128 MB.
- **The spread of series over parts is uneven** (182 to 330 of an average 250): FNV-1a's
  high bits are not uniform for these label sets. A mixing step before taking the range
  would even it out but give up ranges of raw `series_id` (which row-group reads by key
  range want). Not changed; the budgets absorb it (a leaf over its share is re-run).
- **RPC carries 20 bytes a sample** (extracts as `VZB1`), about 8 times the Parquet bytes:
  235 MiB for the 24-hour query, in 776 messages of at most a few MiB.

**Production estimate (modelled), 24 hours at 15 s**, from these counts and the figures
measured on Cloudflare (spikes S1, S2, S4; DO call 10 to 70 ms; a round of up to six reads
55 to 203 ms; CPU twice local):

| step | arithmetic | ms |
|---|---|---:|
| ledger, 2 `plan` calls and 580 files | 2 x 10..70 + 580 x 0.025..0.04 | 35 to 163 |
| tail, 1 call deep | 10..70 | 10 to 70 |
| leaves: one DO call, then their 776 reader calls at once | 10..70 + **1 to 25 rounds** x 55..203 (1 if each call has its own six connections, 776 / 32 if calls to one object share them: not measured) | 65 to 5,145 |
| CPU on the critical path | 2 x (slowest leaf's own engine 2,061 + readers: longest call 240 .. all 10,105 ms over 32 objects = 316 + merge 37) | 4,676 to 4,828 |
| **total, warm objects** | | **about 4.8 to 10.2 s** |

With the median leaf instead of the slowest (1,050 ms own) and this machine's load taken
out (the same run's 1-hour query was 2.4 times its quiet-machine engine time), the CPU part
is nearer 1.5 to 2.5 s. First use of a leaf object adds 250 to 700 ms (S1).

**7 days at 60 s, 5,000 series (extrapolated from the one-day run, not run):** 50.6 M
samples, 4,060 files (ten-minute flush units), 181 MiB. Leaves: `ceil(50.6 M / 1.5 M)` = 34,
capped at `maxLeaves` = **32 leaves of about 1.58 M samples**, so about **70 MiB per leaf**
(the one-day run held 1.75 M in 77.4 MiB; the step grid is smaller with 156 series a leaf).
It fits the limits (scan bound 50.4 M of `maxQueryScanSamples` 100 M; 4,060 files of
`maxQueryFiles` 20,000; 181 MiB of `maxQueryFetchBytes` 512 MiB). **But with ten-minute
flush files it is not fast:** every leaf reads every file, so 32 x 677 file groups = about
21,700 reader calls and 130,000 file reads; at 1 to 677 rounds of 55 to 203 ms that is
0.1 to 137 s of I/O, and the readers decode every file's `series_id` column 32 times
(about 32 x 7 x 11 s / 5 of local reader time spread over 32 objects: 15 s each, 31 s at
twice local). Over the 30 s time limit. Compacted day files (16 MB, a handful per day)
cut the groups to about 10 per leaf; row-group reads by key range ("Needed changes", 2)
would cut each leaf's reading and decoding to its own part. Measured on Cloudflare: none
of this.

#### Before split execution (2026-11-18)

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

Two runs on 2026-11-18, at about 22:05 and 22:20 UTC, with other engineers' test suites running on
the same four cores (the second run was the busier one: loading tenant A took 114 s
against 56 s). Counts are identical in both runs except "leaves used", which depends on
the random query id; times are given as first run / second run.

| | 1 h, 15 s scrape | 24 h, 15 s scrape | 24 h, 60 s scrape | 1 h, 60 s scrape |
|---|---:|---:|---:|---:|
| range, step | 1 h, 15 s (241 steps) | 24 h, 5 min | 24 h, 5 min (289 steps) | 1 h, 60 s |
| limits | default | default | `maxSamples` raised to 3,000,000 | default |
| answer | **200** | **422** `max_scan_samples` (11,520,000 > 3,000,000) | **200** | **200** |
| ledger reads (2 `plan` calls each) | 1 | 1 | 1 | 1 |
| files listed / skipped / read | 24 / 0 / 24 | 580 / 0 / **0** | 580 / 0 / 580 | 24 / 0 / 24 |
| bytes of files read | 1.15 MiB | 0 | 10.55 to 10.60 MiB | 0.43 MiB |
| leaves used / leaf calls / rounds | 16 to 19 / same / 1 | 0 / 0 / 0 | 32 / 99 to 100 / 4 | 14 to 19 / same / 1 |
| R2 GETs, files from R2 | 24 | 0 | 580 | (not run cold) |
| R2 GETs, files from the Cache API | 0 (24 cache hits) | | 0 (580 cache hits) | 0 (24 hits) |
| shards asked / shard calls | 2 / 2 | **0 / 0** | 2 / 2 | 2 / 2 |
| tail read | 2 batches, 0.96 MiB | none | 2 batches, 0.39 MiB | 2 batches, 0.39 MiB |
| scan bound (lake samples) / samples loaded | 480,000 / 520,000 of 2,000 series | 11,520,000 / 0 | 2,880,000 / 2,890,000 | 120,000 / 130,000 |
| engine time, first query in the isolate | 139 / 243 ms | | 255 / 340 ms | |
| engine time, engine code warm | 81 / 145 ms | | 219 / 280 ms | 33 / 26 ms |
| **peak WASM memory** | **21.5 to 21.6 MiB** | 0 | **76.4 to 76.7 MiB** | 7.7 MiB |
| local wall time, files from R2, first query | 348 / 948 ms | 12 / 25 ms | 1,897 / 2,946 ms | |
| local wall time, files from the Cache API | 138 / 336 ms | | 523 / 923 ms | 89 / 82 ms |
| response | 162,722 B | 239 B | 172,808 B | 37,312 B |

- **24 hours at a 15 s scrape does not run.** 11.5 M samples are 176 MiB decoded, more
  than an isolate has; the query is refused from the ledger's row counts before a single
  file or shard is read, and says what to do. (Now split over leaves and answered: above.)
- **24 hours at a 60 s scrape ran only with `maxSamples` raised** (now it is split) to 3,000,000; with the
  default limits it is refused by the engine's `max_samples` (2,890,000 > 2,000,000), but
  only after all 580 files were read and decoded: 76.4 MiB of WASM memory for a refusal
  ("Known risks", materialise then refuse).
- The scan bound counts lake rows only; the tail's 40,000 (15 s) or 10,000 (60 s) samples
  are on top. Every result was checked: 20 jobs, every point within 15% of the expected
  rate, identical bytes from R2 and from the cache.

**Production estimate (modelled, not measured).** From the operation counts above and
figures measured on Cloudflare in spikes S1, S2 and S4. The ledger is read first, in two
sequential calls; shards and leaves then run in parallel; leaf rounds are sequential;
then the engine. `npm run measure` prints the same arithmetic (`ESTIMATE` lines).

Arithmetic, with the engine CPU at twice the local engine time (the two runs give the
range). "Warm" means leaf objects already created; first use of a leaf object adds 250 to
700 ms (S1).

| | ledger: 2 `plan` calls x 10 to 70 ms + files x 25 to 40 µs | then, in parallel: shards (1 call deep, 10 to 70 ms) and leaf rounds x 55 to 203 ms | engine CPU, 2 x local | **total** |
|---|---:|---:|---:|---:|
| 1 h, 15 s scrape, engine code warm | 20 + 24 x 0.025 = **21** to 140 + 24 x 0.04 = **141** ms | 1 x 55 to 203 = **55 to 203** ms | 2 x 81 to 2 x 145 = **162 to 290** ms | **238 to 634 ms** |
| the same, first query in an isolate | 21 to 141 ms | 55 to 203 ms | 2 x 139 to 2 x 243 = 278 to 486 ms | **354 to 830 ms** |
| 24 h, 15 s scrape (refused) | 20 + 580 x 0.025 = **35** to 140 + 580 x 0.04 = **163** ms | nothing | nothing | **35 to 163 ms**, then 422 |
| 24 h, 60 s scrape, engine code warm | **35 to 163** ms | 4 x 55 to 203 = **220 to 812** ms | 2 x 219 to 2 x 280 = **438 to 560** ms | **693 to 1,535 ms** |
| the same, first query in an isolate | 35 to 163 ms | 220 to 812 ms | 2 x 255 to 2 x 340 = 510 to 680 ms | **765 to 1,655 ms** |

Where the inputs come from. A **leaf round** costs at least one Durable Object call plus
one R2 read (45 ms median, S1 section 3), and at most what S1 measured for a whole round
of six reads on each of 16 warm leaf objects (203 ms; 173 ms on 32 leaves): a leaf never
gets more than six reads per round, so a round is one wave of reads. A **Durable Object
call** alone was not measured; 10 to 70 ms is bounded above by S1 (twelve parallel calls
to warm objects that each waited 300 ms took 368 ms). The **ledger `plan`** adds 25 to
40 µs per file returned (S4). **Engine CPU** is twice the local wall time (S2). The model
also uses the platform facts these spikes established: six R2 reads in flight per request,
the coordinator itself reads no R2 (only leaves, each with its own six), and no R2 write
is on the query path (a write costs about 0.4 s, S4). In operations, the 24 h query from R2
costs 580 R2 GETs, 100 leaf calls, 2 shard calls and 2 ledger calls; from the Cache API,
no GETs and the same calls.

What the estimate leaves out: key, limits and pool-map lookups in KV on a cold isolate;
first use of a leaf object (250 to 700 ms extra in spike S1, per object, until the pool
is warm); contention when many queries share leaves; the cost of a Cache API read
(unmeasured; assumed below an R2 read); transfer of the bytes from leaf to coordinator
(1.2 to 11 MiB here, through RPC); response time to the client. The experiment that would settle it is
`design/VERIFICATION.md` S1 extended with this Worker: the same two queries on Cloudflare,
cold and warm.

## Needed changes in other components

Nothing outside `query/`, `engine/wasm-query/`, `engine/query` and `engine/promql` (an
additive, tested hook: `EvalHooks`) was edited. These are for their owners.

1. **Done by `ledger/` (was: "the order of files is text order").** The ledger now assigns
   every file a precedence and `plan` lists files in it (contracts/ledger.ts `LiveFile`,
   design D22). This Worker follows it (`inPrecedenceOrder`) and no longer derives an order
   from keys (`byPrecedence` is gone). Nothing left here.
2. **`engine/storage`: a sample budget inside `select`, row-group reads by key range, and a
   series-only read.**
   - A budget inside `select`, so that a selector is abandoned while rows are gathered and
     not after (today one selector's matching samples, one part's under split execution,
     are materialised before any limit can fire). With it, `maxScanSamples` could go, and
     a split leaf would stop inside a reader's `select` instead of after its extract.
   - `select` over a file given as footer plus the row groups a key range needs, and
     flush/compaction files whose row groups are cut by `series_id` within a metric (the
     sort order already is `metric_name, series_id`). Then a split part would read and
     decode only its key range of each file instead of every file whole (today each file
     is read and its `series_id` column decoded `L` times; "Measurements"). The split key
     is already a `series_id` range for every query whose argument cannot change labels.
   - A series-only read for the label endpoints and the cardinality report.
     `engine/query/src/catalog.rs` reads `metric_series` files as `contracts/TABLES.md`
     defines them in the meantime; a format change there must be made in both places.
3. **`shard/`: `tailRead` needs paging and a filter.** A tenant may hold up to 64 MiB in
   a shard (`tenantMaxBytes`), and one RPC message is limited to 32 MiB: a tail above
   that cannot be read at all (the query fails with 503). It needs a `maxBytes` and a
   continuation, and a time-range and series-key-range filter: split execution now cuts
   the tail by key range at the coordinator (`splitTails`), which a shard could do for
   each leaf directly. Today the whole tail is returned and counted against
   `maxFetchBytes` whatever the query's range.
4. **`shard/`: a way to read "the current stream from sequence 0"** without first asking
   for the incarnation. The coordinator calls `tailRead(tenant, 0, 0)` and uses the
   `incarnation_mismatch` answer to learn it, which costs a second call for every stream
   the ledger has not registered. (`describe` returns more than a reader should see.)
5. **`ledger/`: one `plan` call for both tables** (one version by construction, half the
   calls), accepting several ranges, and paged or index-free above a size (spike S4: a
   plan is 0.8 KB per file because each entry carries its index fragment). A 7-day split
   query lists about 4,000 files.
6. **`edge/`: move `auth.ts` and `poolMap` to a shared place.** The query Worker imports
   them from `../edge/src` as instructed; `route.ts` pulls `batch.ts` into the query
   bundle's dependency graph, and edge's in-memory caches (60 s for keys) become the
   query Worker's revocation delay without edge knowing it has a second user.
7. **`design/`**: the decisions listed below, and DESIGN §6.2 updated to what is built
   (leaves pull their rows from readers; partials are not Arrow IPC; exact aggregations).
8. **`engine/wasm`**, **`app/`**: none.

## Contract issues

`contracts/` was not edited.

1. **`contracts/engine.ts` has no place for the read path's needs**: errors with a type,
   limits, statistics, `plan`, the metadata calls, `parseSelectors`, `scanRows`. The list
   is in `engine/wasm-query/README.md`. `Engine` is now implemented by two modules.
2. **File precedence: resolved.** The contract now gives every live file a precedence
   and `Plan.files` comes in that order (contracts/ledger.ts, TABLES.md, D22); this Worker
   follows it. (It used to depart from "the later key wins" on purpose.)
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

9. **`contracts/engine.ts` has no split execution**: `splitPlan`, `extract`,
   `splitTails`, the gathering session, `mergeJson` and the cardinality calls are in
   `engine/wasm-query/js/index.ts` only.
10. **The cardinality report reads `metric_series` directly** (`engine/query`
    `catalog.rs`), as `contracts/TABLES.md` defines the table; storage has no
    series-only read.

Decisions made here that belong in `design/DECISIONS.md` (not written there: `design/`
was out of bounds): a second WASM module for the read path; the fetch cap of 16 MiB and
the scan cap; leaves return bytes and the coordinator evaluates (for queries that do not
decompose); the cache key is the object key; 503 after three refusals per shard.
New with split execution, each with its alternative:
- **Aggregations are exact and order-independent everywhere** (one place included), so
  that a split result is byte-identical to one place; the alternative, shipping every
  series' values to the coordinator, is not compact, and keeping Neumaier sums cannot be
  exact under a different order. Would change if Prometheus-identical last bits matter
  more than split-invariance.
- **Split by series key, readers pull for leaves** (each part's leaf asks readers for its
  rows of every file group); alternatives: each leaf reading every file itself (six
  reads in flight per object: about 100 sequential waves for a day of flush files), or
  readers shuffling through the coordinator (all rows through one isolate). Would change
  with row-group reads by key range.
- **Split only above `splitAboveSamples`**: one place is cheaper below it.
- **The tail is cut by part at the coordinator** and sent to the owning leaf (exact for
  I17); the alternative, the coordinator evaluating the tail's contribution itself, is
  wrong for windows that straddle lake and tail.
- **Per-leaf budgets are shares of the query's, each at most one isolate's
  `maxSamples`**; a leaf over its share stops while gathering and is run again once with
  what the others left; refused when the counts prove the query over.
- **Cardinality counting is exact with caps**, not HyperLogLog: zero error below the
  caps, a refusal above.

## Known risks

- **Split execution reads every file once per part.** With whole-file reads of
  ten-minute flush files, `L` parts mean `L` reads of each file (Cache API hits after the
  first) and `L` decodes of its `series_id` column; whether calls to one leaf object
  share its six connections (which would serialise reader calls per object) was not
  measured. See "Measurements" and "Needed changes", 2.
- **Leaves share an engine instance per isolate** (`leafEngine`, separate from the
  coordinator's): a split leaf's gathering session lives in it, so it is never reset
  while a session is open, and a trap in one call (it drops the instance) fails every
  open session in that isolate, which their coordinators retry once.
- **One isolate evaluates a query that does not decompose.** Everything such a query reads is in the coordinator's memory
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
- **Edge and the engines changed while this was built.** The last full run (62 passed,
  22:27 UTC) was against these sources, fingerprinted before and after it (the first 16
  hex digits of the SHA-256 of each tree's files concatenated in path order): `edge/src`
  `dde7320deef5980e`, `shard/src` `7a7fb509988cc335`, `ledger/src` `57a9e39060010934`,
  `flush/src` `e2054f5d15d581aa`, `engine/wasm/js` `58e4ed5622b05972`,
  `edge/test/helpers.ts` `5166bc3e078a7bf5`, `engine/wasm/test/vzb1.ts`
  `b2bb54353d668f33`, `app/src/api` `5f2442f7c1b97d4f`. The tests import the last three
  as helpers; a change to them can break this suite without a change here.