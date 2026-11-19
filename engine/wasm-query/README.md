# viz-engine-wasm-query

The read path's WebAssembly module: `viz-query` (which brings `viz-storage` and
`viz-promql`) behind a plain C ABI, and the TypeScript binding that implements the query
half of `contracts/engine.ts`.

It is a separate module from `engine/wasm` on purpose. The write path (`edge`, `flush`,
compaction) encodes and merges Parquet and must not carry the PromQL parser and its
tables; the read path evaluates PromQL and does not need the Parquet writer.

```
./build.sh                    # release, fat LTO, 1 codegen unit, opt-level 3, panic=abort, +simd128,+bulk-memory; -j 2 (CARGO_BUILD_JOBS overrides)
node tools/check.mjs          # load proof and size report, in Node
(cd ../../query && npm test)  # the binding's tests run in workerd, in query/test/engine.test.ts
```

| File | Contents |
|---|---|
| `src/lib.rs` | The C ABI (documented at the top of the file) |
| `js/index.ts` | `createQueryEngine(module)`: the binding |
| `js/viz_query.wasm` | Build output (not committed; `./build.sh` writes it) |
| `js/wasm.d.ts` | Type of a `.wasm` import |
| `tools/check.mjs` | Loads the module in Node with an empty import object and runs queries through the binding |
| `build.sh`, `.cargo/config.toml` | Build settings; `CARGO_TARGET_DIR` is `./target` (about 300 MB, kept so rebuilds are incremental; `engine/query/target`, 3.7 GB, was deleted after its tests ran) |

## What is implemented

| Binding call | C ABI operation | What it does |
|---|---|---|
| `plan(promql, startMs, endMs, stepMs, limits?)` | `viz_q_plan` | What to fetch: `(matchers, minTs, maxTs)` ranges, merged per matcher set and clamped to storable timestamps. `startMs === endMs` plans an instant query |
| `selectors(…)` | `viz_q_selectors` | `contracts/engine.ts` `selectors`: one entry per selector, unmerged; exactly the reads evaluation makes |
| `queryRange(input, promql, startMs, endMs, stepMs, limits?)` | `viz_q_query_range` | `PromMatrix` |
| `queryRangeJson(…)` | the same | The `data` object as the JSON text the engine wrote, plus `stats {selects, series, samples, outputPoints}`. An HTTP layer passes the text through unparsed |
| `queryInstant(input, promql, timeMs, limits?)`, `queryInstantJson` | `viz_q_query_instant` | `PromVector`, `PromScalar`, `PromString`, or `PromMatrix` for a top-level range vector |
| `select(input, matchers, minTs, maxTs)` | `viz_q_select` | `contracts/engine.ts` `select`: series with `Float64Array` timestamps and values |
| `parseSelectors(strings)` | `viz_q_parse_selectors` | `match[]` strings to matchers; anything but a bare, selective series selector is `bad_data` |
| `labelNames(input, match, minTs, maxTs, limits?)` | `viz_q_label_names` | `/api/v1/labels`; the union over the `match[]` sets, or every series when there are none |
| `labelValues(input, name, match, minTs, maxTs, limits?)` | `viz_q_label_values` | `/api/v1/label/<name>/values` |
| `series(input, match, minTs, maxTs, limits?)` | `viz_q_series` | `/api/v1/series` |
| `scanRows(indexes, ranges)` | `viz_q_scan_rows` | For each ledger index fragment (`FileEntry.index`): an upper bound on the rows the ranges decode from that file; 0 = the file provably holds nothing the ranges read; `null` = the fragment does not parse (unknown, so read the file) |
| `filesNeeded(indexes, ranges)` | the same | `scanRows(…) !== 0` per file |
| `splitPlan(promql, limits?)` | `viz_q_split_plan` | Split over leaves (`fragments`, the labels left out of the split key) or one place, and why (`engine/query` `split_plan`) |
| `extract(seriesFiles, sampleFiles, without, part, parts, ranges)` | `viz_q_extract` | A reader: the rows of one part of a split query in a group of files, as one `VZB1` batch, with row and series counts |
| `splitTails(batches, without, parts, ranges)` | `viz_q_split_tails` | The coordinator: the tail batches cut by part (order kept; rows outside the ranges dropped) |
| `gatherNew(ranges, budget)`, `gatherAdd(handle, rank, batch)`, `gatherEval(handle, promql, grid, fragments, limits?)`, `gatherFree(handle)` | `viz_q_gather_*` | A split leaf: a gathering session kept in the instance (by handle) that takes extracts and tail batches in any order with their precedence, stops at the leaf's budget, and evaluates the fragments into the leaf's answer (bytes); `gatherEval` frees the session |
| `leafSummary(answer)` | (JavaScript only) | The fixed header of a leaf's answer: status, samples and series held and loaded |
| `mergeJson(answers, promql, grid, limits?)` | `viz_q_merge` | The coordinator: merge the leaves' answers, replay the limits, finish the query; `{ json, stats }` as `queryRangeJson` |
| `cardinalityPart(seriesFiles, tailBatches, startMs, endMs, part, parts, caps)`, `cardinalityReport(summaries, limit, startMs, endMs, lookbackStartMs, caps)` | `viz_q_card_part`, `viz_q_card_report` | The cardinality report: one part's summary, and the merged report as the `data` of `/api/v1/status/tsdb` and `/api/v1/status/cardinality` |
| `memoryBytes()`, `instances()`, `reset()` | | The instance's linear memory (its high-water mark), how many instances were created, and dropping the instance so the memory can be reclaimed |

- **No imports.** The crate applies the three `[patch.crates-io]` stand-ins of
  `../query/patches` (`web-time`, `js-sys`, `wasm-bindgen`), so the module has no
  `wasm-bindgen` imports and instantiates with an **empty import object**. No glue code,
  no `wasm-bindgen` CLI, no `wasm-opt`.
- **Number rules of the contract.** Times going in must be integers: a fractional or
  NaN time (or step, or limit) throws `RangeError` and is never rounded. They cross as
  `i64` written into the request buffer, so nothing depends on BigInt arguments. Sample
  values never pass through JavaScript arithmetic: query results are JSON written inside
  the engine with values as Prometheus-formatted strings, and `select` copies raw bytes
  from WASM memory into each `Float64Array`'s buffer.
- **Limits are passed with every call** (`QueryLimits`: samples, series, output points,
  step points, query bytes, depth, steps; `DEFAULT_LIMITS` are the engine's own). Nothing
  is stored on the instance. Exceeding one throws `QueryError` with `errorType:
  'execution'` and `limit: { name, max, reached }`; the step cap is `bad_data`, as in the
  Prometheus API.
- **Errors are typed**: `QueryError.errorType` is `bad_data`, `execution`, `unsupported`
  or `internal` (a corrupt file or batch). An engine error leaves the instance in use. Any
  other exception from a call (a trap, out of memory) drops the instance; the next call
  creates a new one.
- **Memory.** A request, files and batches included, is written straight into linear
  memory (one copy per input buffer); the result is copied out once and freed.

`scanRows` and `filesNeeded` are thin: the rule lives in `engine/query`
(`src/prune.rs`, `scan_rows` and `files_needed`), next to the format it reads.

- **A module that does not load** (instantiation fails, or its ABI number is not the
  binding's) throws `EngineLoadError`, whose message starts with `ENGINE_LOAD_PREFIX`
  (so it is recognisable after an RPC boundary). The query Worker answers it with 500:
  retrying in the same deployment cannot help (`query/test/http.test.ts`).
- **ABI version 2** (was 1: the operations above were added; none changed). A gathering
  session lives in the instance: if the instance is dropped (a trap, or `reset()`), its
  sessions are gone and the next `gatherAdd` fails (`internal`), so the query Worker's
  leaves never reset their engine while a session is open.

## What is not implemented

- **The write half** (`encodeSegment`, `mergeFiles`): that is `engine/wasm`.
- **Range reads.** Every file is handed over whole. `scanRows` reads the row groups'
  offsets and lengths that a range-read plan would need, but returns only row counts.
- **A lookback, subquery-step or name-removal option**: `EvalOptions` other than
  `maxSteps` are the defaults of `viz-promql`.
- **Statistics for the metadata calls.** `queryRangeJson` and `queryInstantJson` return
  what was read; `labelNames`, `labelValues` and `series` do not.
- **Limits per `match[]` set.** With several `match[]` the label calls evaluate one set
  at a time, each under the full limits, where `series` applies them to the sum.
- **A native test of the C ABI.** The ABI is exercised through the binding only (in
  workerd and in Node). `engine/wasm` has `tests/abi.rs`; this crate does not.
- **`wasm-opt`**, a zstd build, streaming a result out of WASM memory.
- Nothing was run on Cloudflare.

## How it was verified

All figures measured here (Linux x86-64, 4 cores shared with other engineers' builds and
test runs, load average 5 to 8 during these runs, rustc 1.97.0, Node 22.23, workerd
through `@cloudflare/vitest-plugin` 1.8), on 2026-11-18. Local, not on Cloudflare. Where
two numbers are given they are two runs; read the spread, not one figure.

Build: `./build.sh` with the settings above. **SIMD is in the module**: it is stripped, so
there is no `target_features` section to read; instead, parsing the code section, 212 of
its 3,672 functions declare `v128` locals (a module built without `+simd128` has none).
`wrangler deploy --dry-run` of `query/` bundles this module with 49 KB of JavaScript:
2,625.57 KiB to upload, 824.96 KiB gzip (well below the Workers script size limits).

### Size

| | bytes |
|---|---:|
| `js/viz_query.wasm` | **3,078,525** (was 2,639,443 before split execution and the cardinality report) |
| `gzip -9` | **958,971** (was 809,660) |
| imports | **0** |
| exports | 24: `memory`, `viz_alloc`, `viz_free`, `viz_q_abi_version` and the twenty operations |

For comparison: `engine/query/wasm` (the whole engine, write half included) is
3,618,108 bytes, 1,034,617 gzip. Leaving out the Parquet writer and the merge saves about
a megabyte raw. What remains is dominated by the Parquet reader and the regex engine
(`engine/query/README.md`, section 7, has the breakdown by crate).

### Instantiate time

| Where | `new WebAssembly.Instance(module, {})` plus one call into it |
|---|---|
| workerd (`query/test/engine.test.ts`, mean of 500; two runs) | **0.71 ms and 1.00 ms** |
| Node (`tools/check.mjs`, mean of 200) | **0.65 ms** |

Compiling the module happens once, when the Worker script is loaded, and is not in these
figures. The first query in a fresh isolate is slower than later ones because the engine's
code is not yet optimised by V8 (through the Worker, the query below spent 139 ms in the engine on its first run in a
fresh isolate and 81 ms on the next: `query/README.md`, "Measurements").

### Peak WASM memory and time: 1 hour, 2,000 series

`query/test/engine.test.ts`, "memory". `sum by (job)(rate(http_requests_total[5m]))` from
`end − 1 h` to `end` at a 15 s step (241 steps) over 2,000 series (20 jobs x 100
instances) scraped every 15 s: 522,000 samples in 18 batches, counters with pseudo-random
increments. Each run uses a fresh instance, so `memoryBytes()` afterwards is that query's
peak. The query reads 520,000 samples of 2,000 series and returns 20 series x 241 points
(163 KB of JSON).

| Where the rows are | Input | First call | Later calls (median of 5) | Peak WASM memory |
|---|---|---:|---:|---:|
| five sixths in Parquet, the rest in tail batches | 0.84 MiB in 2 files + 1.84 MiB in 3 batches | 135 ms, 155 ms | 63 ms, 69 ms | **22.2 MiB** |
| all in Parquet | 0.96 MiB in 2 files | 79 ms, 71 ms | 62 ms, 66 ms | **22.3 MiB** |

Both runs return byte-identical JSON. The peak is the selected samples (520,000 x 16 B =
7.9 MiB) plus the evaluator's step grid (2,000 x 241 x 24 B = 11.0 MiB) plus the input
copied into linear memory, which agrees with the native figure in
`engine/query/README.md` (20.2 MiB of heap above the inputs). Through the Worker, with
24 small files instead of 2 and the last ten minutes in two tail batches, the same query
peaked at 21.6 MiB (`query/README.md`, "Measurements").

### Tests

`query/test/engine.test.ts`, 10 tests in workerd:

| Test | What it asserts |
|---|---|
| imports nothing, exports only the C ABI, instantiates with an empty import object | `WebAssembly.Module.imports(wasm)` is `[]`; the export list is exactly the 14 names; 500 instances are created with `{}`; the engine is lazy |
| plan merges and clamps; selectors lists each selector | exact ranges for `rate(up[1m]) / up`, a range before 1970, a query with no selector, matcher operators |
| queryRange and queryInstant return the Prometheus data object | matrix, vector, scalar, string, a top-level range vector; times in seconds, values as strings; a staleness marker ends a series one millisecond after the last sample's lookback would have kept it; lake and tail give the same bytes; `stats` |
| select copies sample bytes | a staleness marker and a NaN with a payload come back bit for bit, from the tail and from Parquet |
| refuses times that are not integers | fractional and NaN times, steps and limits throw `RangeError`; the instance stays usable |
| metadata calls and `match[]` parsing | names, values, series, windows, unions over `match[]`, the three refusals of Prometheus |
| errors carry the Prometheus error type | parse errors, a bad regex, many-to-many matching, an unsupported function, a corrupt batch, a corrupt file, bad ranges: typed, and no new instance (no trap) |
| every limit is passed per call | for five limits: exactly at the limit succeeds, one below fails with `execution`, the limit's name, value and the number reached; depth; the step cap as `bad_data`; limits on `plan` and the metadata calls; nothing is remembered between calls |
| filesNeeded and scanRows | against fragments written by the flush engine: skipped by time and by name, not by a regex; row counts; an unparsable fragment is kept |
| memory | the table above, with every value of the result checked against the workload's mean rate |

The operations added for split execution and the cardinality report are exercised through
the binding in workerd by `query/test/split.test.ts` (8 tests: every query of the table and
32 aggregation-heavy ones at 1, 2, 7 and 32 leaves in three placements, budgets, failures)
and `query/test/cardinality.test.ts` (5 tests), and natively, below the ABI, by
`engine/query/tests/split.rs`. `engine.test.ts` asserts the 24 exports and ABI version 2.
`wrangler deploy --dry-run` was **not** re-run for the larger module.

`node tools/check.mjs`: **12 of 12 checks pass**: no imports, the export list, an empty import
object, a query whose every point is checked, the marker's bits, eight kinds of bad query
with no trap. Re-run on 2026-11-19 at 00:50 UTC after a container restart (load average
about 7), on a module rebuilt from the committed source: 12 of 12, and the rebuilt module's
SHA-256 (`2b3132a41bd9e0cf…`) equals the one built before the restart, so the module the
query tests load carried no mutant. Nothing in this crate changed since; the query Worker's
new behaviour on 2026-11-19 (series-sized splits, `/api/v1/plan`) uses existing calls
(`scanRows` over series files).

The rule behind `scanRows` is tested in `engine/query` (`tests/prune.rs`, 3 tests, one a
property over the 106-query pool: skipping files never changes a result, and the row
bound really bounds what a read loads). The crates this module links were tested on the
host the same day: `engine/query` `cargo test` 37 passed (3 min 9 s); `engine/promql`
`cargo test` 26 passed, 1 ignored (as before).

## Known risks

- **The patches are tied to dependency versions** (see `../query/patches/README.md`). A
  `chrono` or `lrpar` upgrade that uses more of the replaced crates fails the build; it
  cannot silently bring imports back.
- **A panic is a trap.** `panic = "abort"`: an input that panics the engine ends the
  call, the binding drops the instance, and the request fails. The engine's own tests are
  what keep that from happening; this crate adds a bounds-checked request reader and
  nothing else.
- **`max_samples` fires after the fact** (`engine/query/README.md`, "Known risks"): one
  selector's matching samples are decoded before the limit is checked. A caller bounds
  that beforehand with `scanRows` (the query Worker does).
- **Linear memory never shrinks.** After a large query the instance keeps its memory
  until `reset()`. The query Worker resets above 48 MiB.
- **`u64` statistics and limits become JavaScript numbers.** Exact below 2^53.
- **Workerd's clock** has millisecond resolution and does not advance during pure
  computation on Cloudflare, so the timings above cannot be reproduced there from inside
  a Worker; production CPU comes from Cloudflare's analytics (spike S2 used that).

## Contract issues

Against `contracts/engine.ts` (not edited). The first five repeat `engine/query/README.md`
because this binding is where they become visible to TypeScript.

1. **No error channel.** The contract's calls return results; this binding throws
   `QueryError { errorType, limit }`.
2. **No limits, statistics or `plan` in the contract.** `Engine.queryRange` has no
   `limits` argument and returns no statistics. The binding adds an optional last
   argument, and the `…Json` variants that return `{ json, stats }`.
3. **`selectors` vs `plan`.** Both exist; a fetcher wants `plan` (merged, clamped), the
   scan bound wants `selectors` (one per read).
4. **The metadata calls, `parseSelectors`, `filesNeeded` and `scanRows` are not in the
   contract.**
5. **`Engine` cannot be implemented by one module any more.** The write half lives in
   `engine/wasm` and the query half here; `QueryEngine` in `js/index.ts` is the interface
   this binding satisfies. The contract should be split the same way.
6. **`FileEntry.index` is "opaque to the ledger"**, and now has a second consumer (the
   query planner, through `scanRows`). Its format is still only `FileIndex` in
   `engine/storage`; a version bump there must keep `scan_rows` returning "unknown" for
   what it cannot read, which is what it does for anything but `"v":1`.
