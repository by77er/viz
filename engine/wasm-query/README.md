# viz-engine-wasm-query

The read path's WebAssembly module: `viz-query` (which brings `viz-storage` and
`viz-promql`) behind a plain C ABI, and the TypeScript binding that implements the query
half of `contracts/engine.ts`. Since ABI 6 (2026-11-19) the same module also links
`viz-traceql` and `viz-logql` and answers the span and log operations of `contracts/engine.ts`
`SignalEngine` (one module for the read path, not a second one: `viz-logql` evaluates its
vector operations on `viz-promql`, which was linked already).

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
| `src/sigfiles.rs` | ABI 6: index fragments of the span and log tables and the file plans made from them; the `spans`, `trace_index` and `logs` readers (row group by row group, record API, whole or sparse files); the signal 2 and 3 batch decoders |
| `src/traces.rs`, `src/logs.rs` | ABI 6: the TraceQL and LogQL operations over those readers (the engines' read seams: `SpanSource` through `MemSource`, `LogSource`) and the results Tempo's and Loki's APIs answer |
| `examples/signal_fixtures.rs` | The query tests' fixtures and their expected answers from the engines' in-memory sources (`query/tools/gen-signal-fixtures.sh`) |
| `examples/signal_bench.rs` | Synthetic span and log files for `query/test/signals.bench.ts` |
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
| `filePlan(indexes, ranges, gap?)` | `viz_q_file_plan` | How to read each file from its fragment, by name and time: `{rows, read}` with `read` `'skip'`, `'whole'` or `[[offset, length], …]` (the footer and the row groups needed) |
| `samplePlan(seriesFiles, indexes, reads, part?, pairs?, gap?)` | `viz_q_sample_plan` | Series-level pruning: the reads' matchers resolved against the series files; per sample file its plan (for the series of its own series file when `pairs` says which), the exact series count, and a `carrier` batch of the selected series to evaluate with instead of the series files |
| `partPlan(indexes, ranges, part, parts, gap?)` | `viz_q_part_plan` | A split part's plans from the fragments alone: the row groups of its `series_id` range |
| `metaPart(kind, input, name, match, minTs, maxTs, part, parts, limits?)` | `viz_q_meta_part` | ABI 4: one part of a label call over leaves (`'names'`, `'values'`, `'series'`): what the call lists of the series whose `series_id` is in the part (`engine/query` `MetaPart`), as JSON text, and per `match[]` set the `series_id`s of the series listed, so that a part's files can be listed in several calls and counted exactly together |
| `sparseFile(size, segments)`, `planBytes(plan, size)`, `RANGE_GAP` | (JavaScript only) | A sparse file container (`VZS1`) of the ranges read, which every call accepts in place of a whole file; the bytes a plan reads; the join distance (64 KiB) |
| `memoryBytes()`, `instances()`, `reset()` | | The instance's linear memory (its high-water mark), how many instances were created, and dropping the instance so the memory can be reclaimed |

### Traces and logs (ABI 6, 2026-11-19)

| Binding call (`SignalEngine`) | C ABI operation | What it does |
|---|---|---|
| `tqPlan(kind, query, start, end, step)` | `viz_q_tq_plan` | What a TraceQL query reads, from its text: whether every span of a candidate trace is needed (`complete`: search, structural operators, `span:childCount`, trace-level intrinsics, pipelines that are not span-local), the window of span starts or trace extents, and a metrics request as Tempo's frontend aligns it (`viz_traceql::align_request`) |
| `tqFilePlan(table, fragments, lo, hi, traceId?, ranges?)` | `viz_q_tq_file_plan` | Per `spans` file the row groups whose span starts overlap `[lo, hi]` (and, ABI 8, one of `ranges`: a trace query's pieces); per `trace_index` file those whose fragments overlap it and, with an id, whose `[min_tid, max_tid]` holds it; byte ranges with the footer (as `filePlan`) |
| `tqProbe(table, fragments, lo, hi, traceId, ranges, blooms)` | `viz_q_tq_probe` | ABI 9 (D81): `tqFilePlan`'s plans without the row groups whose `trace_id` bloom filter (located by the fragment's `bf`, handed in as a sparse container of the plan's `bloom` ranges) rules the id out; a group with no filter named, not handed over, or not parsing is kept. `tqFilePlan` with an id lists `bloom`; `spans` and log plans carry `certain` (rows certain to be held); the span calls' budget carries `ranges` (a span starting outside them is passed over) |
| `tqExtent(indexFiles, tail, lo, hi, traceId?, budget?)` | `viz_q_tq_extent` | The traces whose extent overlaps the window (or the one id), from the `trace_index` fragments and tail spans inside the bound (ABI 7): how many, the hull of their extents, the `spans` hours holding them and (ABI 8) the ranges their pieces cover, all cut to the bound. ABI 8 finds them in passes over the id and time columns, holding the window's traces and the ids after the window, not every trace of the bound (D62 2.) |
| `tqSearch(spanFiles, tail, query, req)` | `viz_q_tq_search` | Tempo's `/api/search` body (`viz_traceql::search`) over the spans read; spans decoded and traces |
| `tqMetrics(spanFiles, tail, query, req)` | `viz_q_tq_metrics` | Tempo's `/api/metrics/query_range` or `/query` body; a span-local plan keeps only the spans that start in the window (ABI 8: cut before de-duplication, the window is its bound); series, buckets and the answer charged as they are made (`viz_traceql::metrics::Meter`) |
| `tqTrace(spanFiles, tail, id, version, maxSpans)` | `viz_q_tq_trace` | One trace as OTLP JSON in Tempo's form (`{"batches":[…]}`; v2 `{"trace":…}`), or null; ABI 8 passes over other traces' spans before decoding them, so `maxSpans` counts the trace's own; each span's text is charged before it is written |
| `tqTags`, `tqTagValues` | `viz_q_tq_tags`, `viz_q_tq_tag_values` | Tag names (v1 `tagNames`, v2 `scopes`) and values (v1 strings, v2 `{type, value}`; a `q` filter through `viz_traceql::matching_spansets`) of the spans that start in the window (ABI 8: cut before de-duplication; the sets charged as they grow, the answer by its exact length first) |
| `lqPlan(kind, query, start, end, step)` | `viz_q_lq_plan` | `viz_logql::selectors`: matchers and half-open ranges per selector; an instant log query is `bad_data` |
| `lqFilePlan(fragments, selectors)` | `viz_q_lq_file_plan` | Per `logs` file the row groups some selector reads: by time, and by the fragment's stream list (labels matched with Go's dialect, as LogQL does) when it has one, else by `service_name` bounds |
| `lqQuery(logFiles, tail, query, req)` | `viz_q_lq_query` | Loki's `data` object (`viz_logql::query_range` / `query_instant`); rows of streams no selector matches, or outside every selector's range, are dropped before they are held |
| `lqLabels(kind, name, selectors, start, end, fragments, logFiles, tail, budget?)` | `viz_q_lq_labels` | Loki's `/labels`, `/label/<name>/values`, `/series` arrays, from the fragments' stream lists, the `labels` and `ts` columns of files without one, and the tail; ABI 8: under `budget.maxBytes` (texts read, what is kept, the answer), refused past it, never cut |

- **One logical view, wherever rows live.** Spans and log rows are rebuilt as the contracts'
  logical views (`contracts/TRACES.md` "Logical view", `contracts/LOGS.md` §3) from Parquet
  (promoted columns and residual maps merged) and from `VZB1` batches alike, and de-duplicated
  on their row keys with the later row winning: files in the order given (ascending
  precedence), then tail batches in order. A trace's summary is computed from the spans read,
  never from `trace_index` counts (which over-count retried spans); fragments only say what to
  read.
- **Strict about signals.** A span operation fed a log or metric batch, or a log operation fed
  anything but signal 3, is an `internal` error: the decoders check the header.
- **Limits**: `max_spans`, `max_rows` bound the rows held (files and tail; since ABI 7 a span
  outside the call's bound, or a log row no selector reads, is read, dropped and not counted;
  since ABI 8 also a span of another trace than trace by ID's, and a span-local call's bound is
  its window); `max_bytes` bounds the bytes of what is held, of what the evaluation derives from
  it and of the answer, each charged BEFORE it is made (ABI 8; ABI 7 charged derived series per
  point and the answer once written, and the label calls not at all: review r2, R2-M1, R2-M2);
  past any of them, an `execution` error naming the limit (the binding's `QueryError.limit`), with
  a text that names what was being made and what would help. TraceQL's series and points limits
  and LogQL's steps and series are passed per call.
- **Existing operations are byte-compatible.** No request or answer of ABI 5 changed;
  `tools/check.mjs` passes unchanged. The ABI number moved to 6 because operations were added
  (a binding of one version refuses a module of the other, as for ABI 3 and 4).
- `serde_json` is built with `float_roundtrip`: doubles inside canonical OTLP JSON (arrays,
  key-value lists) parse to the value written. Without it one value of the read-back corpus
  (`-2.25e-300`) parsed one ulp off.

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

- **ABI version 7** (2026-11-19; was 6; the review of spans and logs end to end, M-1 and M-2,
  `design/reviews/signals-end-to-end.md`; D62): the span and log operations gained a byte
  budget and the trace operations a bound. Requests changed (the binding's optional last
  argument, `SignalBudget`, fills them): `viz_q_tq_search`, `_tq_metrics` and `_tq_trace` take
  `u64 max_bytes, i64 bound_lo, i64 bound_hi` after `max_spans`; `viz_q_tq_extent` takes the
  bound and `u64 max_bytes` after the id; `viz_q_tq_tags`, `_tq_tag_values` and `viz_q_lq_query` take `max_bytes`.
  What the calls do:
  - **The budget** (`src/sigfiles.rs` `Mem`): each row held is charged a fixed overhead and
    the length of every string it keeps (a span 512 bytes and 56 per attribute; a log row 192
    bytes, its line and its metadata twice), a stream's labels once per file or batch, a
    resource once per distinct resource, a metric series 48 bytes a point, and the answer four
    times its length; past `max_bytes`, `max_decoded_bytes`. Measured (Node, this module): the
    charges are at or above the growth of linear memory for realistic spans (1.72 KiB charged,
    1.64 KiB grown) and log rows (about 0.8 and 0.64 KiB); `query/README.md` "Memory".
  - **Resources held once** (`Resources`): a span's resource is interned per call, from files
    and tail alike, and its TraceQL form made once (`viz_traceql::Span.resource` is now a shared
    `Resource`, an `Arc`). 2,000 spans with a 180 KB resource: 349 MiB of linear memory before,
    6.0 MiB after.
  - **The bound** (`traces.rs` `Budget`): a span whose start lies outside it is dropped as it is
    read, before de-duplication, so what a call sees does not depend on which files outside the
    bound were read; `tqExtent` counts only fragments that overlap the bound and tail spans that
    start in it, cuts the hull's end and the hours to it, and selects traces by their merged
    extent. Spans of tail batches are read for `tqExtent` without being held
    (`batch_span_times`).
  - `max_spans` and `max_rows` count rows held, not decoded.
  Tests: `src/sigtests.rs` (9, `cargo test -j 2 --lib`): the bound before de-duplication with
  and without the out-of-bound file, extents across units and the tail, extents charged by trace
  (3,000 fragments in under 1 MiB; `trace_index` rows are not spans), a fat resource held once
  from files and tail and fat attributes refused, trace by ID's answer charged as written, fat
  log lines and their answer refused, a LogQL and a TraceQL metric query's series refused by the budget before they are made, and the
  budget's exact boundary.
  - `viz_q_tq_extent` also takes `u64 max_bytes` after the bound: each trace it holds is charged
    192 bytes and each hour 32. Through the Worker: `query/test/completeness.test.ts`,
  `memory.test.ts`.
- **A module that does not load** (instantiation fails, or its ABI number is not the
  binding's) throws `EngineLoadError`, whose message starts with `ENGINE_LOAD_PREFIX`
  (so it is recognisable after an RPC boundary). The query Worker answers it with 500:
  retrying in the same deployment cannot help (`query/test/http.test.ts`).
- **ABI version 5** (2026-11-19; was 4): `viz_q_extract`'s answer gained `u64 foreign` after
  `strays` (series in the part's id range whose key is another part's: query/ D59). Built
  against `engine/storage` as it was at 07:23 UTC (`src/*.rs` SHA-256 `66398f8443a2e765…`).
- **ABI version 4** (2026-11-19; was 3): `viz_q_meta_part` was added (the label endpoints
  over leaves, `query/README.md`); no other operation changed. Built against `engine/storage`
  as it was at 06:41 UTC (`src/*.rs` concatenated in name order, SHA-256 `f55f874a7f4df43c…`;
  another engineer was changing its log and trace modules, which the read path does not call).
- **ABI version 3** (2026-11-19; was 2): `viz_q_file_plan`, `viz_q_sample_plan` and
  `viz_q_part_plan` were added, and any file of a `scan` may be a sparse file container. No
  operation changed its request; the label calls (`viz_q_label_names`, `_values`,
  `viz_q_series`) now ignore sample files (a series-only read, `engine/query` README). The
  binding and the module must be built together: a binding of one version refuses a module of
  the other with `EngineLoadError` (500), which is what a stale `js/viz_query.wasm` gives
  under `wrangler dev` until `./build.sh` is run.
- **ABI version 2** (was 1: split execution and the cardinality report were added; none changed). A gathering
  session lives in the instance: if the instance is dropped (a trap, or `reset()`), its
  sessions are gone and the next `gatherAdd` fails (`internal`), so the query Worker's
  leaves never reset their engine while a session is open.

### Traces and logs, ABI 8 (2026-11-19: the re-review of D62, R2)

The changes are D62's second rewrite (`design/DECISIONS.md`) and `query/README.md` "The re-review";
`contracts/engine.ts` was changed first. What this crate does differently:
- `sigfiles::Mem` refuses BEFORE a charge passes the budget, releases what is let go, and carries
  a stage and a help text per call, so a refusal says what was being made and what would help.
- `viz_traceql::metrics::Meter` (in `engine/traceql`, `Limits::max_bytes`) and `viz_logql::Meter`
  (`engine/logql`, `Options::max_bytes`) charge the evaluations' derived structures as they grow;
  this crate passes them what its budget leaves once the rows are held, and maps their
  `Error::Memory` to `max_decoded_bytes`.
- The label calls take `max_bytes` (request layout: after `end_ns`).
- `viz_q_tq_extent` reads `trace_index` projected to its id and time columns (and `hours` in the
  last pass) and returns `ranges`; `viz_q_tq_file_plan` takes them.
- Span reads decide from a span's trace id and start, before decoding it, whether it is part of the
  call's data; trace by ID and the span-local calls use it (the trace's spans; the window).
- Answers of search, metrics, tags and labels are charged by their exact length before they are
  written (`json_len` in `engine/traceql`; a length pass here).

**Tested natively** (`cargo test -j 2 --lib`, `src/sigtests.rs`, 22 tests, all passing): the
review's reproductions, and the cases the per-call measurement and the mutants found, with a heap
counter around each call (a `#[global_allocator]` in the test binary that counts this thread's
bytes): every call peaked within the budget (32 MiB) plus 8 MiB beyond its request, on the 64-bit
target (structures are smaller on wasm32). Peaks (bytes beyond the request): `/series` of 300 fat
streams 31.5 M and of 60 15–21 M (both refused, the second at its answer), `/labels` 11.5 M;
histogram 2.5 M and 100 quantiles 2.1 M (refused before their series exist); `rate() by` 10.7 M
(refused at the answer); tag values of one trace's 500 × 60 KB 33.4 M and tag names of 400 × 60 KB
33.4 M (refused as the sets grow); a search echoing 250 and 500 × 60 KB 30.2 and 33.5 M (refused
at the answer and as results are made; 60.3 M before the results were charged); 150 log lines of
200 KB kept 33.4 M (refused); the LogQL `label_format` query 32.6 M (refused); a log query over
30,000 lines with a label set each 23.3 M (answers); the extent pass at 12 traces/s 3.6 M
(answers); trace by ID in a 20,000-span row group 2.4 M (answers); and D72 review m-2 (tags, tag
values and a span-local count the same with and without a later copy outside the window). In
WASM, through the binding with the reviewer's scripts: `query/README.md` "The re-review".
`tools/check.mjs` passes; the module is ABI 8.

## What is not implemented

- **Traces and logs** (ABI 6): column projection by the TraceQL plan's columns (every span is
  decoded whole, every attribute held: the main memory cost; the tag calls hold whole records for
  their keys or one value); the trace id bloom filters and a
  page-level read for trace by ID (a row group is decoded whole to find one trace); split
  execution (partials) for TraceQL or LogQL; the logs token filter (no builder exists); a
  streaming LogQL source (every row a query reads is held until it is evaluated); nested-set
  columns; a native test of these operations below the ABI (they are tested through the
  binding in workerd, and the in-memory oracle is native).
- **The write half** (`encodeSegment`, `mergeFiles`): that is `engine/wasm`.
- **Page reads.** A plan reads whole row groups and the footer; pages are skipped in memory
  (`engine/storage`, DECISIONS D41).
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
| exports | 28 since ABI 4: `memory`, `viz_alloc`, `viz_free`, `viz_q_abi_version` and twenty-four operations (24 with twenty operations before ABI 3) |

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

### 2026-11-19: traces and logs (ABI 6)

Rebuilt with `./build.sh` (`-j 2`), measured here:

| | ABI 5 (before) | ABI 6 (after) |
|---|---:|---:|
| `js/viz_query.wasm` | 3,165,021 | **4,442,611** (+1,277,590) |
| `gzip -9` | 988,820 | **1,423,375** (+434,555) |
| imports | 0 | **0** |
| exports | 28 | **40** (twelve operations added) |

For comparison, the engines' own probes: `viz-traceql` alone 1,275,756 B (428,833 gzip),
`viz-logql` with `viz-promql` 2,436,954 B (762,419 gzip). Linked into this module they add
1.28 MB (0.43 MB gzip): `viz-promql`, `promql-parser`, the `regex` engine and the Parquet
reader were here already; what is new is the two engines' own code, `engine/goregex`, the
`parquet` crate's record API that the span and log readers use, and exact float parsing.
`wrangler deploy --dry-run` was not re-run (no deploy in this work); at about 1.4 MB gzip the
module stays well under the Workers script size limits.

**Memory on a large read** (measured here, local workerd through the whole query Worker,
`query/test/signals.bench.ts`, each call on a fresh instance so the figure is its peak of
linear memory; load average about 3): see `query/README.md`, "Traces and logs",
"Measurements". In short: about 1.5 KiB of WASM memory per span held (a search over 40,000 spans
peaked at 62 MiB, files included), about 1 KiB per log row held (83 MiB for 80,000 rows; a query
selecting one stream of the same files, 15 MiB); trace by ID holds one trace but decodes every
span of the row groups its hours name (37 MiB at 40,000 spans an hour). These set the query
Worker's `maxSpans` (40,000) and `maxLogRows` (60,000) defaults then; the review of spans and
logs showed that rows do not bound memory (a 180 KB resource repeated on every span), and ABI 7
bounds bytes instead (above; the caps are now 18,000 and 30,000).

`node tools/check.mjs`: every check passes (no new check: the span and log operations are
exercised through the binding in workerd by `query/test/signals.test.ts`, 18 tests, and
`query/test/signals.e2e.test.ts`, 2 tests over files the real flush wrote, against the engines'
in-memory answers). `query/test/engine.test.ts` asserts the 40 exports and ABI 6.

### 2026-11-19: foreign series in the extract (ABI 5)

Rebuilt with `./build.sh` (`-j 2`): **3,165,021 bytes, 988,820 gzip**, SHA-256
`c4d7080a69911196…`. `node tools/check.mjs`: every check passes.

### 2026-11-19: the label endpoints over leaves (ABI 4)

Rebuilt with `./build.sh` (`-j 2`): **3,165,181 bytes, 988,705 gzip**, SHA-256
`2f181edc670513d4…` (was 3,152,742 and 983,968). `node tools/check.mjs`: every check passes,
two new: `metaPart` over 1, 2, 3 and 8 parts unions to `labelNames`, `labelValues` and `series`
and its series ids add up to the whole's; a part over its cap is a typed `max_series` error.
`engine/query`: `cargo test -j 2`, 57 passed in 11 targets (new: `tests/meta_parts.rs`, 2).

### 2026-11-19: series-level pruning (ABI 3)

Rebuilt with `./build.sh` (`-j 2`) from the tree of this change: **3,152,742 bytes, 983,968
gzip**, SHA-256 `0bea92296051781e…` (was 3,078,525 and 958,971: +74 KB, +25 KB gzip for the
planners and the sparse reader). `viz_q_extract`'s answer gained `u64 strays` before the batch. `node tools/check.mjs`: **17 of 17 checks pass** (12 before, plus `filePlan` by name
and time with an unparsable fragment kept whole; `partPlan` reading one row group and the
footer for the part holding the smallest ids; `samplePlan` selecting nothing without series
files and keeping an unknown fragment whole; a malformed sparse file an `internal` error with
no trap; and the label calls answering with a sample "file" that is not Parquet). The module's
other calls are tested through the binding in workerd by `query/` (86 tests, among them
`test/pruning.test.ts` and `test/engine.test.ts`, which asserts the 27 exports and ABI 3).

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

Against `contracts/engine.ts`. Since 2026-11-19 the contract has the span and log operations of
this module (`SignalEngine`) and the TraceQL and LogQL result shapes (contracts first, in their
own change); the PromQL items below still stand. The first five repeat `engine/query/README.md`
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
7. **Closed 2026-11-19: `contracts/engine.ts` has `SignalBudget`, the budget argument and (ABI 8,
   changed in the contract before this module) `lqLabels`' budget, `tqExtent`'s `ranges` and
   `tqFilePlan`'s `ranges`; the binding imports them, and `QueryEngine` no longer redeclares the
   span and log operations.** (Was: `SignalEngine` had no budget or bound, ABI 7.)
6. **`FileEntry.index` is "opaque to the ledger"**, and now has a second consumer (the
   query planner, through `scanRows`). Its format is still only `FileIndex` in
   `engine/storage`; a version bump there must keep `scan_rows` returning "unknown" for
   what it cannot read, which is what it does for anything but `"v":1`.
