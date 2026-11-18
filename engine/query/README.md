# viz-query

The query half of the viz engine as a Rust library: PromQL (`viz-promql`) evaluated over
lake Parquet files and shard tail batches (`viz-storage`), with query limits, a fetch
plan, and the metadata calls of the Prometheus HTTP API.

No I/O, no async, no clock, no randomness: every function is a pure function of its
arguments, so the same code runs as WASM in a Worker, natively in a Container, and in a
deterministic simulator. Nothing panics on input. Builds for the host and for
`wasm32-unknown-unknown`.

```
export CARGO_TARGET_DIR=$PWD/target
cargo test                                                  # 34 tests, about 3 minutes
cargo test --test corpus -- --nocapture                     # upstream corpus through storage, per file
cargo build --release --target wasm32-unknown-unknown       # the library
(cd wasm && cargo build --release --target wasm32-unknown-unknown) && node tools/wasm_check.mjs
cargo run --release --example bench                         # the benchmark
python3 tools/mutants.py                                    # mutation check
```

```rust
use viz_query::{plan, query_range, ScanInput};

// 1. What to fetch: ask the ledger for files and the shards for tails covering these.
let ranges = plan("sum by (job) (rate(http_requests_total[5m]))", start_ms, end_ms, 15_000)?;
// [FetchRange { matchers: [__name__="http_requests_total"], min_ts: start_ms - 299_999, max_ts: end_ms }]

// 2. Evaluate over the bytes that came back.
let input = ScanInput { series_files, sample_files, tail_batches };
let json = query_range(&input, "sum by (job) (rate(http_requests_total[5m]))", start_ms, end_ms, 15_000)?;
// {"resultType":"matrix","result":[{"metric":{"job":"api"},"values":[[1700006400,"12.5"],…]}]}
```

## What is implemented

| API | What it does |
|---|---|
| `StorageSource` | `viz_promql::SeriesSource` over a `viz_storage::ScanInput`. One instance per query; counts what it loads and enforces the limits. |
| `plan(query, start_ms, end_ms, step_ms) -> Vec<FetchRange>` | What to fetch before evaluating: `(matchers, min_ts, max_ts)`, inclusive, Unix ms. The selector ranges of `viz-promql` (range window, lookback, `offset`, `@`, subquery step grids), clamped to the timestamps storage can hold, with ranges of the same matcher set merged when they overlap or touch. `start == end` plans an instant query. |
| `selectors(query, start_ms, end_ms, step_ms)` | The raw per-selector ranges (`contracts/engine.ts` `selectors`), exactly the `select` calls evaluation makes. |
| `query_range(input, query, start_ms, end_ms, step_ms) -> String` | Prometheus `query_range`; returns the `data` object as JSON (`PromMatrix`). |
| `query_instant(input, query, time_ms) -> String` | Prometheus instant `query`; `vector`, `scalar`, `string`, or `matrix` for a top-level range vector. |
| `query_range_with`, `query_instant_with` | The same, typed (`Matrix` / `Value`), with `Options { limits, eval }`, returning `Stats { selects, series, samples, output_points }` (DESIGN §6.5: what a query read is returned with every result). |
| `label_names(input, matchers, min_ts, max_ts)` | `/api/v1/labels`. Sorted, unique. |
| `label_values(input, name, matchers, min_ts, max_ts)` | `/api/v1/label/<name>/values`. |
| `series(input, matcher_sets, min_ts, max_ts)` | `/api/v1/series`: sorted, unique label sets matching any set. Refuses, as Prometheus does, no sets and a set whose matchers all match the empty string. |
| `parse_selector(text)` | A `match[]` string to matchers; anything but a bare series selector is `bad_data`. |
| `Limits`, `Limits::check_query`, `estimate_depth` | The limits below. |
| `QueryError { error_type, message, limit }`, `to_json()` | Errors with a Prometheus `errorType` and the API's error body. |
| `to_json`, `labels_to_json` | Serialisation of results. |

### Who owns what between the three crates

Decided once, documented on `src/source.rs`, and checked by the tests named in the last
column, so that nothing is done twice and nothing is left out.

| Concern | Owner | The adapter | Checked by |
|---|---|---|---|
| Matchers (`=`, `!=`, `=~`, `!~`; a missing label is `""`; regexes anchored `^(?s:…)$`) | `viz-storage::select`. The evaluator never re-applies a matcher. | translates the operator enum | `source_returns_the_reference_series`, mutant 31 |
| `__name__` | an ordinary label in storage; `viz-promql` turns `metric{…}` into a `__name__` matcher and decides when results drop the name | passes it through | `range_query_json_…`, corpus `name_label_dropping.test` |
| Label order | storage returns labels sorted by name in UTF-8 byte order (the batch contract); the evaluator verifies in O(labels) and would sort | nothing | `labels_come_out_sorted_whatever_order_they_went_in` |
| Series order | the evaluator sorts by label set; storage's order is irrelevant | nothing | invariance tests |
| Time range | inclusive `[min, max]` in Unix ms as `i64` on both sides; the evaluator computes it | passes two numbers through | `both_boundaries_of_a_range_matter`, mutants 3, 4 |
| Units | milliseconds as `i64` from batch to typed result; Prometheus JSON seconds only in `viz-promql`'s serialiser | nothing | `range_query_json_times_are_seconds_…`, mutants 8, 9 |
| De-duplication on `(series, ts)`: tail over lake, later over earlier | `viz-storage::select`, once | nothing; vectors move without a copy | `duplicates_between_lake_and_tail_…`, mutant 7 |
| Staleness markers | storage keeps the bits `0x7ff0000000000002`; the evaluator interprets them | moves the `Vec<f64>`; no arithmetic touches a value | `tests/staleness.rs`, mutants 5, 6 |
| Limits | this crate | counts what storage returned | `tests/limits.rs`, mutants 10 to 20 |

### Limits

`viz-promql` bounds only the number of steps. `Limits` bounds the rest. Exceeding one is
an `execution` error whose message names the limit, the number reached and the limit's
value, for example `query exceeded limit max_samples: 2000123 samples loaded, the limit
is 2000000`; `QueryError::limit` carries the same three as data. Nothing is truncated.
All counts are taken after storage has merged and de-duplicated, so whether a query is
over a limit does not depend on where its rows are stored (the invariance test compares
`Stats` across placements).

| Limit | Default | Counts |
|---|---:|---|
| `max_samples` | 2,000,000 | samples loaded from storage, summed over every selector of the query (32 MB of samples) |
| `max_series` | 20,000 | series loaded, summed over every selector |
| `max_step_points` | 1,000,000 | for any one selector, series returned times the evaluation steps of the (sub)query it is in. The evaluator materialises that grid at 24 bytes a cell, so this is what bounds memory for queries such as `sum(m)` over many series and steps, whose output is small. |
| `max_output_points` | 500,000 | points in the result |
| `max_query_bytes` | 16,384 | length of the query text |
| `max_depth` | 100 | nesting depth: an upper bound on the depth of the syntax tree, computed from the text with no recursion before the parser runs |
| `EvalOptions::max_steps` (in `viz-promql`) | 11,000 | steps of a range query; reported here as `bad_data`, as the Prometheus API does |

Where they live: samples, series and step points in `StorageSource` (it wraps every
`select`); output points after evaluation; query bytes and depth in
`Limits::check_query`, which every entry point calls first. `max_depth` is the
recursion guard: the parser's checks, the evaluator and `Drop` of the syntax tree all
recurse once per level, and a 16 KB query can nest 16,000 levels. The estimate counts
brackets and operators (`a + b + c` is 3, `f(a + b, c + d)` is 4 where the tree is 3
deep); a property test checks it is never below the real depth of what the parser
produces.

Two small hooks were added to `viz-promql` for this (see "Changes in the other crates").
The limits themselves are here and not in `viz-promql`, because they are about what
storage hands over.

### Errors

| `errorType` | When | HTTP in Prometheus |
|---|---|---|
| `bad_data` | parse errors, invalid regular expressions, `end < start`, `step <= 0`, too many steps, not a series selector, an unselective `match[]` | 400 |
| `execution` | PromQL evaluation errors with Prometheus' wording (many-to-many matching, duplicate series, a string in a range query), and every limit | 422 |
| `unsupported` | valid PromQL this engine does not implement (native histograms, `limitk`, …). Never a wrong answer. | not a Prometheus type; suggest 422 |
| `internal` | the input is broken: a corrupt Parquet file, a wrong-schema file, an invalid `VZB1` batch | 500 |

## What is not implemented

- **The engine does not fetch.** `plan` says what to fetch; reading the ledger, R2 and
  the shards is the caller's job. `plan` returns matchers and time ranges, not row
  groups or byte ranges: pruning to row groups from the ledger's index fragments
  (DESIGN §6.1) is not done here, and `select` is given whole files.
- **Split execution** (DESIGN §6.2): leaves returning partial aggregates as Arrow IPC,
  key-range splits, merging `topk`. A query is evaluated in one call over one input.
- **Tenant injection and label-based access rules** (DESIGN §6.1). A `ScanInput` is
  assumed to hold one tenant's bytes; nothing here adds matchers on behalf of a policy.
- **Caching** (DESIGN §6.3), including within a query: a selector that appears twice is
  read from storage twice (and counted twice by the limits).
- **A time limit.** The engine has no clock, so there is no timeout; the bounds are on
  samples, series, steps and points instead.
- **An early abort inside storage.** `max_samples` and `max_series` are checked after
  `viz_storage::select` has returned one selector's series, so one selector's matching
  samples are in memory before the limit can fire (see "Known risks").
- **A series-only read.** `label_names`, `label_values` and `series` go through
  `select` and load the samples of the series they list; storage has no cheaper call.
  The Prometheus `limit` parameter of these endpoints is not implemented.
- **Annotations** (warnings and infos), exemplars, `/api/v1/metadata`, `/targets`,
  `/rules`, `/alerts`, `/status/*`, remote read.
- **The result's `stats` object** in JSON. `Stats` is returned typed only.
- **TraceQL and LogQL.**
- **The product's JavaScript binding.** `wasm/` is a size probe and load proof with its
  own small C ABI; `engine/wasm` is the binding.
- Everything `viz-promql` lists as not implemented (native histograms, `limitk`,
  `anchored`/`smoothed`, …): those queries return `unsupported` or `bad_data`.

## How it was verified

All numbers measured here (Linux x86-64, 4 cores shared with other builds, rustc
1.97.0, Node 22.23), not on Cloudflare.

`cargo test`: **34 tests, all passing** (api 10, corpus 1, invariance 3, limits 10,
plan 5, staleness 5). Four are property tests.

### 1. Storage-location invariance

`tests/invariance.rs`, `results_do_not_depend_on_where_rows_live`. For each generated
case: a write history over 17 series (gauges, counters with resets, a classic histogram
in two jobs) with irregular spacing from five minutes before UTC midnight (so the lake
always spans two days), NaNs, staleness markers, timestamps rewritten with a different
value, arrival order jittered, cut into 1 to 7 batches. Every query of a pool of **106**
(8 selector forms, 8 with `offset`/`@`, 25 range functions, 16 aggregations, 18 binary
operator forms, 16 functions, 4 `histogram_quantile`, 7 subqueries, 4 that must fail) is
evaluated as a range query and as an instant query:

- (a) all rows in Parquet files,
- (b) all rows in tail batches,
- (c) split: a prefix flushed in 1 to 4 segments with row groups of 1 to 6 rows (or the
  default), optionally compacted per day with `merge_files`, and a tail that overlaps
  the flushed part by 0 to 3 batches,
- (d) lake only, in several files per day with small row groups, optionally compacted,
- (e) `viz-promql` over its in-memory source holding the history's meaning (last write
  per timestamp wins).

(a) to (d) must each produce **byte-identical JSON, or the same error type and
message**, as (e), and identical `Stats`.

**Result: identical everywhere.** INVARIANCE_NUMBERS

`source_returns_the_reference_series` checks one level down: for every selector range
of every pool query, the series the adapter hands the evaluator equal the reference's
bit for bit, staleness markers included. `query_pool_is_live` shows the property is not
vacuous: over 40 fixed histories every non-error query returns data, the two that must
fail always fail, and the generator emits staleness markers.

**No invariance failure was found in any of the three crates.**

### 2. Staleness at the storage boundary

`tests/staleness.rs`. A series with samples at T, T+15 s, T+30 s and a marker at
T+45 s (the last sample sits exactly on UTC midnight, so sample and marker are in the
second day's file), in six placements: marker in the tail with the samples in the tail
or in Parquet; marker in a Parquet file with nothing in the tail, with 1-row row groups
after compaction, duplicated in the tail, and with later writes in the tail. In every
placement, as Prometheus specifies:

- an instant query at T+44.999 s returns the sample; at T+45 s, T+45.001 s, T+60 s and
  T+5 min it returns nothing (without the marker it would return the T+30 s sample
  until T+5 min 30 s, which the control test shows);
- a range query has exactly three points;
- `count_over_time(up[1m])` at T+60 s is 2: the marker is not a sample in a range vector;
- a sample after the marker revives the series, and a plain NaN is an ordinary value;
- which value a timestamp has is decided by de-duplication before staleness is looked
  at: a marker overwritten by a later tail write is not a marker, and the reverse.

### 3. Upstream `promqltest` corpus through storage

`tests/corpus.rs` runs the 13 files of `../promql/testdata/upstream` (Prometheus
v3.8.0, 1103 cases, each up to twelve evaluations) with every `load` turned into `VZB1`
batches and placed three ways, and requires **each case** to have the outcome it has
with `viz-promql`'s in-memory source.

| file | viz-promql in memory (pass / fail / skip) | lake + tail | lake, compacted | tail only |
|---|---|---|---|---|
| aggregators.test | 151 / 0 / 9 | 151 / 0 / 9 | 151 / 0 / 9 | 151 / 0 / 9 |
| at_modifier.test | 45 / 0 / 0 | 45 / 0 / 0 | 45 / 0 / 0 | 45 / 0 / 0 |
| collision.test | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 |
| functions.test | 330 / 1 / 39 | 330 / 1 / 39 | 330 / 1 / 39 | 330 / 1 / 39 |
| histograms.test | 52 / 0 / 109 | 52 / 0 / 109 | 52 / 0 / 109 | 52 / 0 / 109 |
| literals.test | 25 / 0 / 0 | 25 / 0 / 0 | 25 / 0 / 0 | 25 / 0 / 0 |
| name_label_dropping.test | 21 / 0 / 0 | 21 / 0 / 0 | 21 / 0 / 0 | 21 / 0 / 0 |
| operators.test | 198 / 0 / 7 | 198 / 0 / 7 | 198 / 0 / 7 | 198 / 0 / 7 |
| range_queries.test | 12 / 0 / 1 | 12 / 0 / 1 | 12 / 0 / 1 | 12 / 0 / 1 |
| selectors.test | 31 / 0 / 0 | 31 / 0 / 0 | 31 / 0 / 0 | 31 / 0 / 0 |
| staleness.test | 17 / 0 / 0 | 17 / 0 / 0 | 17 / 0 / 0 | 17 / 0 / 0 |
| subquery.test | 32 / 0 / 2 | 32 / 0 / 2 | 32 / 0 / 2 | 32 / 0 / 2 |
| trig_functions.test | 19 / 0 / 0 | 19 / 0 / 0 | 19 / 0 / 0 | 19 / 0 / 0 |
| **total** | **935 / 1 / 167** | **935 / 1 / 167** | **935 / 1 / 167** | **935 / 1 / 167** |

"lake + tail": two thirds of the batches flushed in three segments with 13-row row
groups, the tail overlapping the lake by one batch. The corpus loads from Unix time 0
for up to days, so the lake has one file pair per UTC day. The one failure and the 167
skips are `viz-promql`'s own (its README explains each); they are the same cases here.
The corpus contains no series a batch cannot hold (no missing `__name__`, no empty label
value, no negative timestamp); the test fails loudly if one appears.

### 4. Fetch plan

`tests/plan.rs`.

- `plan_is_sound` (property, 48 cases x 106 queries, range and instant): fetch exactly
  the plan's ranges with `viz_storage::select`, put only that back into storage (half
  in the lake), evaluate: the result equals evaluation over all the data.
- `both_boundaries_of_a_range_matter`: with a sample exactly on each boundary of a
  planned range, fetching one millisecond less on either side changes the result, and
  samples one millisecond outside change nothing. So the plan is tight, and the
  property above cannot pass by over-fetching unnoticed.
- Exact ranges for the lookback, range windows, the last step (not `end`), `offset`,
  `@`, subquery grids, merging of overlapping and touching ranges, ranges a day apart
  staying apart, clamping at 0 and at the largest storable timestamp.

### 5. Limits

`tests/limits.rs`. For each of the six limits: a query exactly at the limit succeeds
and one over it fails with `execution`, the limit's name, the number reached and the
limit in both the message and `QueryError::limit`. Also: budgets are per query, not per
selector; duplicates between lake and tail count once; a subquery's finer step grid is
what `max_step_points` sees; metadata calls obey the limits; ten pathological queries
(7,000 nested brackets, 7,000 unary minuses, 3,500-term chains, 600 nested
subqueries, unbalanced brackets) are refused on a 256 KiB stack, so nothing recursed;
queries at depth 100 of six shapes evaluate; `estimated_depth_bounds_the_syntax_tree`
(600 random nested expressions) checks the estimate against the parser's real tree.

Stack needed at depth 100, measured with `examples/stack_probe.rs` and
`tools/wasm_check.mjs`:

| build | worst shape (nested function calls) | all six shapes fit in |
|---|---|---|
| WASM release, 1 MiB stack | evaluates up to nesting 1,050 | about ten times the limit |
| native release | 256 KiB | 256 KiB |
| native debug | between 1 and 2 MiB | 2 MiB (test threads get 4 MiB in debug builds for this test) |

### 6. Mutation check

MUTANTS_SECTION

### 7. WASM: the whole engine, and loading it without glue

`wasm/` links `viz-storage`, `viz-promql` and `viz-query` into one `cdylib` behind a
small C ABI (flush, merge, range and instant query, plan, the three metadata calls).
Release profile of `engine/AGENTS.md` (fat LTO, one codegen unit, `opt-level = 3`,
`panic = "abort"`, stripped) with `-C target-feature=+simd128,+bulk-memory`; no
`wasm-opt`.

WASM_SECTION

### 8. Benchmark

BENCH_SECTION

## Changes in the other crates

No bug was found in `viz-storage` or `viz-promql`. Nothing was changed in
`engine/storage`. Two additive hooks in `engine/promql`, both tested there, all of its
tests green (26, was 24):

1. `SelectorInfo` gained `pub steps: usize`, the number of evaluation steps of the
   (sub)query the selector belongs to (`src/api.rs`, set in `src/lib.rs`
   `walk_selectors`). Not serialised. Needed for `max_step_points`.
   Test: `selectors_report_the_step_count_of_their_subquery`.
2. `promqltest::run_script_with_source(script, opts, factory)` and the type
   `SourceFactory` (`src/promqltest.rs`): run a test script through any `SeriesSource`
   built from the loaded series. `run_script` is unchanged in behaviour (it calls the
   same code with no factory). Needed to run the corpus through storage.
   Test: `test_scripts_can_run_through_another_source`.

`engine/promql/README.md` was updated for both and for the WASM import finding.

One thing seen and not explained: STORAGE_NOTE

## Contract issues

Against `contracts/engine.ts` and `contracts/BATCH.md` (not edited). These need a
decision by whoever owns `contracts/` and an entry in `design/DECISIONS.md`.

1. **No error channel.** `queryRange` returns `PromMatrix`. Callers need
   `{ errorType, error }` to answer with the right HTTP status; this crate returns
   `QueryError` and `to_json()` gives the Prometheus error body.
2. **`internal` is a fourth error type.** The brief names `bad_data`, `execution`,
   `unsupported`. Corrupt files and batches are none of these (not the request's fault,
   not an evaluation error), so they are `internal`, which is also Prometheus' name for
   it. `unsupported` is not a Prometheus error type; an HTTP layer must pick a status.
3. **Bad range parameters are `bad_data` here** (`end < start`, `step <= 0`, more than
   11,000 steps), as in the Prometheus HTTP API; `viz-promql` alone reports them as
   evaluation errors.
4. **No limits, options or statistics in the contract.** `Options` (limits, lookback
   delta, delayed name removal) and `Stats` have no place in `Engine`. DESIGN §6.5
   wants bytes scanned and shards touched; the engine can report series, samples and
   points, not bytes of objects it was never given.
5. **`selectors` vs `plan`.** The contract's `selectors` returns one entry per selector.
   A fetcher wants `plan` (merged, clamped). Both exist here with the same JSON shape;
   the contract should say which one a Worker calls.
6. **Metadata calls are not in the contract**: `labelNames`, `labelValues`, `series`,
   and a way to turn a `match[]` string into matchers.
7. **`ScanInput.tailBatches` "in sequence order" is only defined within one shard.**
   With tails from several shards the engine uses the order given: a later batch wins
   on a duplicate `(series_id, ts)`. A series lives on one shard by the routing key, so
   this matters only when the pool map changed between two writes of the same sample
   with different values; the contract should say what order a caller concatenates in.
8. **What a query costs depends on the fetcher honouring `plan`.** `max_samples`
   counts samples inside the selector's range, so extra data in the input (a whole
   day's file for a five-minute query) does not count against the query, but is
   decoded by `select` row group by row group. Limits on bytes handed to the engine
   belong to the caller.
9. **Times.** The contract passes times as JS numbers; this crate and the probe ABI
   use `i64` (BigInt in JavaScript). Exact below 2^53 either way.

## Known risks

- **`max_samples` is enforced after the fact, per selector.** `viz_storage::select`
  returns a whole selector's series before the adapter can count them, so a single
  selector matching far more than the budget is materialised (16 bytes a sample plus
  labels) and only then refused. The fix is a limit inside `select` that aborts while
  gathering rows; it was not made because `engine/storage` was being edited by another
  engineer during this work, and because a raw-row count there (before
  de-duplication) is not location-invariant, so it has to be a separate, looser guard
  beside the exact one here. Until then the caller should bound what it fetches.
- **Whole files in memory, read once per selector.** Every `select` call opens every
  file in the input again and decodes the row groups its statistics do not exclude.
  A query with five selectors reads the lake five times.
- **`max_depth` is conservative.** It counts every operator character directly inside
  a bracket group, so a selector with more than about 98 matchers, or one bracket
  level with more than about 98 operators (`a + b + … ` with 100 terms), is refused
  although its tree is shallow or the evaluator could take it. Raise `max_depth` for
  such callers; the WASM stack takes about ten times the default.
- **`max_step_points` bounds selectors, not every node.** A node's output is at most
  the size of its inputs for every operator this engine has, so the selector grids
  bound the rest, but that is an argument, not a test.
- **The WASM patches are tied to dependency versions.** `patches/js-sys` implements
  the five functions `chrono` 0.4.45 names. A `chrono` or `lrpar` upgrade that uses
  more fails the build (it cannot silently restore the imports). `engine/wasm` does not
  apply the patches yet: when it links `viz-promql`, it gets the imports back unless it
  adds the three `[patch.crates-io]` lines.
- **The parser's clock path.** `lrpar` would read a clock during error recovery;
  `promql-parser` disables recovery, and `tools/wasm_check.mjs` runs six kinds of
  parse error without a trap. If recovery were ever enabled, the module would trap on
  a parse error instead of answering `bad_data`.
- **Regex dialect** is Rust's `regex`, not Go's RE2 (as in both other crates). Storage
  compiles matchers; `viz-promql` compiles `label_replace` patterns; both anchor the
  same way.
- **`engine/storage` changed while this was tested.** See "Changes in the other
  crates". The final test run was against the sources as of STORAGE_STAMP.
- Benchmark and stack numbers are from a shared machine, not from Cloudflare; the
  128 MB isolate limit was not exercised.

## Layout

```
src/lib.rs        entry points, Options, range validation, parse_selector
src/source.rs     StorageSource (the SeriesSource adapter), Stats, ownership table
src/limits.rs     Limits, the complexity guard (estimate_depth)
src/plan.rs       FetchRange, plan
src/meta.rs       label_names, label_values, series
src/error.rs      QueryError, ErrorType, Limit
tests/common/     write histories, storage layouts, generators, the query pool
tests/invariance.rs  storage-location invariance (property), source equality, pool liveness
tests/staleness.rs   markers in the tail and in Parquet
tests/corpus.rs      upstream promqltest corpus through storage
tests/plan.rs        exact ranges, soundness (property), tightness
tests/limits.rs      every limit, pathological nesting, depth estimate (property)
tests/api.rs         JSON shapes and units, errors, metadata, de-duplication
examples/bench.rs    the benchmark (timed loop, counting allocator)
examples/stack_probe.rs  stack needed for a nested query
wasm/             whole-engine cdylib (size probe, load proof)
patches/          web-time, js-sys, wasm-bindgen stand-ins for a glue-free module
tools/wasm_check.mjs   loads the module with an empty import object and runs queries
tools/wasm_sizes.mjs   code size by crate from an unstripped build
tools/mutants.py       mutation check
```

The crate has its own `[workspace]` table so that it builds standalone next to its
siblings.
