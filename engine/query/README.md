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
normally spans two days), NaNs, staleness markers, timestamps rewritten with a different
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

**Result: identical everywhere.** The default run is 48 cases: 48 histories x 106 queries
x 4 placements x 2 query forms = **40,704 evaluations through storage, 0 differences**.
A soak run with `VIZ_PROPTEST_CASES=300` (254,400 evaluations) also had 0 differences,
as did `plan_is_sound` at 300 cases.

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

`python3 tools/mutants.py` applies one source change at a time, runs the suite (property
tests at 8 cases, corpus left out), restores the file, and reports the failing tests. It
confirms first that the unmutated suite passes and tells a failing test from a build
error. **31 of 31 mutants were killed**; none survived. `engine/storage` is another
component under concurrent edit and was not mutated; storage-side faults (5, 7) are
emulated in the adapter. Mutant 9 is in `engine/promql/src/api.rs`.

| # | Mutant | Killed by (examples; the script prints all) |
|---|---|---|
| 1 | Tail data dropped | `results_do_not_depend_on_where_rows_live`, `source_returns_the_reference_series`, `duplicates_between_lake_and_tail_…`, 14 more |
| 2 | Lake data dropped | `results_do_not_depend_on_where_rows_live`, `plan_is_sound`, `metadata_calls`, 15 more |
| 3 | Range end off by one (`max_ts - 1`) | `both_boundaries_of_a_range_matter`, `a_marker_ends_the_series_exactly_at_its_timestamp`, `max_samples`, 10 more |
| 4 | Range start off by one (`min_ts + 1`) | `both_boundaries_of_a_range_matter`, `without_the_marker_the_series_lives_for_the_lookback`, `metadata_calls`, 2 more |
| 5 | Staleness markers from Parquet ignored | `a_marker_ends_the_series_exactly_at_its_timestamp`, `results_do_not_depend_on_where_rows_live`, 5 more |
| 6 | NaN payloads canonicalised (marker becomes a plain NaN) | `the_source_hands_the_marker_bits_over_untouched`, `a_marker_ends_…`, `results_do_not_depend_…`, 3 more |
| 7 | No de-duplication between lake and tail | `duplicates_between_lake_and_tail_appear_once_and_the_tail_wins`, `results_do_not_depend_…`, 17 more |
| 8 | Wrong unit: sample timestamps in seconds | `range_query_json_times_are_seconds_and_inputs_are_milliseconds`, `results_do_not_depend_…`, 14 more |
| 9 | Wrong unit: JSON timestamps in milliseconds | `instant_query_result_types`, `a_marker_ends_…`, 3 more |
| 10 | `max_samples` does not fire | `max_samples`, `metadata_respects_limits` |
| 11 | `max_samples` per selector instead of per query | `max_samples`, `baseline_reads_what_the_tests_below_assume` |
| 12 | `max_samples` fires one early (`>=`) | `max_samples` |
| 13 | `max_series` does not fire | `max_series`, `metadata_respects_limits` |
| 14 | `max_step_points` does not fire | `max_step_points` |
| 15 | `max_step_points` ignores subquery step grids | `max_step_points` |
| 16 | `max_output_points` does not fire | `max_output_points` |
| 17 | `max_query_bytes` does not fire | `max_query_bytes` |
| 18 | `max_depth` does not fire | `max_depth` |
| 19 | Depth estimate ignores operators | `estimated_depth_bounds_the_syntax_tree`, `max_depth`, `a_query_at_the_depth_limit_fits_the_stack` |
| 20 | Depth estimate forgets closed groups | same three |
| 21 | Plan: range end one millisecond short | `both_boundaries_of_a_range_matter`, `ranges_are_exact`, 3 more |
| 22 | Plan: range start one millisecond late | same |
| 23 | Plan: keeps only the first range of a matcher set | `ranges_of_one_matcher_set_merge_only_when_they_meet` |
| 24 | Plan: merges ranges that are apart | `ranges_of_one_matcher_set_merge_only_when_they_meet` |
| 25 | Plan: not clamped to storable timestamps | `ranges_are_clamped_to_what_storage_can_hold` |
| 26 | Parse errors reported as `execution` | `errors_carry_prometheus_error_types`, `results_do_not_depend_…`, 1 more |
| 27 | `unsupported` reported as `execution` | `errors_carry_prometheus_error_types`, `results_do_not_depend_…` |
| 28 | Limit error loses its cause | `max_samples`, `max_series`, `max_step_points` |
| 29 | `label_values` ignores the matchers | `metadata_calls` |
| 30 | `series()` accepts a set that matches everything | `metadata_calls` |
| 31 | `!~` translated as `=~` | `results_do_not_depend_…`, `source_returns_the_reference_series` |

What the table shows about the tests: the off-by-one mutants on the source's range (3,
4) and on the plan (21, 22) are **not** caught by the random property tests, because
random millisecond timestamps almost never sit on a boundary. They are caught by the
directed boundary tests, which exist for that reason. At 8 cases `plan_is_sound` did not
catch 21 or 22 either.

### 7. WASM: the whole engine, and loading it without glue

`wasm/` links `viz-storage`, `viz-promql` and `viz-query` into one `cdylib` behind a
small C ABI (flush, merge, range and instant query, plan, the three metadata calls).
Release profile of `engine/AGENTS.md` (fat LTO, one codegen unit, `opt-level = 3`,
`panic = "abort"`, stripped) with `-C target-feature=+simd128,+bulk-memory`; no
`wasm-opt`.

| build of `wasm/` | `.wasm` | `gzip -9` | imports | exports |
|---|---:|---:|---:|---:|
| dependencies as published | 4,052,074 B | 1,116,824 B | 7 (`__wbindgen_placeholder__.*`, `__wbindgen_externref_xform__.*`) | 1,568, of which 1,552 are `wasm-bindgen`'s |
| with `patches/` (what is built by default) | **3,618,108 B** | **1,034,617 B** | **0** | 12: `memory` and the 11 functions of the C ABI |

(The first row was measured before the 4 KB `viz_probe_unlimited` export was added.)
For comparison, from the other READMEs: the storage probe alone is 2,775,281 B
(788,880 gzip) and a PromQL-only wrapper 2,394,658 B (669,829 gzip); the two share the
regex engine and std, so the whole is well under the sum.

**What dominates.** `tools/wasm_sizes.mjs` on an unstripped build of the same module:
the code section is 3.11 MB and the data section 0.50 MB (Unicode tables of `regex`,
the parser's grammar tables). Code bytes by crate (attribution after LTO inlining is
approximate; a generic function is charged to the first non-std crate in its symbol):

| share of code | bytes | crate |
|---:|---:|---|
| 44.1% | 1,371,119 | `parquet` (with `snap`, `bytes`, `thrift`, `half`, `num-*`, `twox-hash`) |
| 23.6% | 733,097 | `regex` (`regex-automata`, `regex-syntax`, `aho-corasick`) |
| 12.6% | 390,176 | `promql-parser` and its runtime (`lrpar`, `lrlex`, `lrtable`, `cfgrammar`, `bincode`, …) |
| 7.5% | 231,614 | `viz-promql` |
| 5.3% | 166,200 | `viz-storage` |
| 3.2% | 99,825 | Rust std |
| 1.0% | 30,460 | `viz-query` |
| 2.7% | | everything else (`memcpy`, `serde_json`, the probe's ABI) |

So Parquet is the largest part and the regex engine second; this crate is 1%.

**No JavaScript glue.** As published, two dependencies of `promql-parser` bind to
JavaScript on `wasm32-unknown-unknown`: `chrono` (default feature `wasmbind`, for
`Utc::now()` and `Local`) and `web-time` (through `lrpar`, for `performance.now()`).
Feature flags cannot remove them: a crate cannot switch off the default features of a
dependency's dependency, `lrpar`'s dependency is unconditional, and because features
are unified, `parquet`'s `chrono` gets `wasmbind` too. A small patch can:
`patches/` holds three stand-in crates applied through `[patch.crates-io]` (`web-time`
re-exporting `std::time`; `js-sys` with the five `Date` functions `chrono` names, each
a trap; `wasm-bindgen` with the one type `chrono` names), about 60 lines in total, no
third-party source copied or modified. `patches/README.md` has the reasoning and the
three lines a consuming crate adds. The engine never reads a clock, so none of the
replaced code can run; if it did it would trap, not return a made-up time.

Proof, `node tools/wasm_check.mjs` (Node 22.23), on the build in the table:

- `WebAssembly.Module.imports(module)` is empty and no export starts with `__wbindgen`.
- `new WebAssembly.Instance(module, {})`, an **empty import object**, succeeds
  (0.6 to 0.9 ms). No post-processing, no `wasm-bindgen` CLI, no `wasm-opt`.
- The script encodes `VZB1` batches in JavaScript (10,541 samples, 41 series, one of
  them ended by a staleness marker written as raw bits), flushes four of six batches to
  Parquet inside the module (two flushes, three sample files over two UTC days), keeps
  three in the tail (one overlapping), and runs
  `sum by (job) (rate(http_requests_total[5m]))` over an hour at 15 s: 4 series x 241
  points, each value checked against the rate computed in JavaScript, timestamps in
  seconds; the same rows all in the tail give the identical response; the series with
  the marker ends where it should; instant query, `plan`, the three metadata calls and
  `merge_files` answer; eight bad queries (six of them parse errors, which run the
  parser's error path, the only code that could have asked for a clock) come back as
  `bad_data` / `unsupported` / `execution` bodies with no trap; `day_of_week` works
  (chrono is linked without its bindings).
- First query 40 to 60 ms (it builds the parser's tables and decodes three files),
  repeat 11 to 40 ms on this loaded machine; WASM memory after everything 2.4 MiB.

`engine/wasm` (the product binding) does not link `viz-promql` yet. When it does, it
needs the same three `[patch.crates-io]` lines, or it will have the imports.

### 8. Benchmark

`cargo run --release --example bench`: a **simple timed loop** (15 runs after a first
call; not criterion), native x86-64, release profile, default limits on. Measured here
on 4 shared cores with a load average near 6, so read the spread, not one number.

Workload: `sum by (job) (rate(http_requests_total[5m]))`, one hour at a 15 s step (241
steps), 2,000 series in 20 jobs scraped every 15 s. 522,000 samples in 18 batches
(13.1 MiB) flushed by `encode_segment` to one `metric_samples` file of 1.14 MiB (6 row
groups) and one `metric_series` file of 0.04 MiB. The query reads 520,000 samples of
2,000 series and returns 20 series x 241 points (163 KB of JSON).

| | min | median | max | peak heap |
|---|---:|---:|---:|---:|
| **`query_range`, data in Parquet** | **49 ms** | **51 to 53 ms** | 72 to 74 ms | **20.2 MiB** |
| of which `viz_storage::select` from Parquet | 12 to 17 ms | 15 to 19 ms | 19 ms | 20.2 MiB |
| of which evaluation (`viz-promql` over the loaded series; the harness copies the samples once more than the real path) | 36 to 39 ms | 45 to 48 ms | 60 to 64 ms | 16.6 MiB |
| of which parse + plan | 0.01 ms | 0.01 ms | 0.06 ms | |
| of which JSON serialisation | 0.7 ms | 0.75 ms | 2.1 ms | 0.3 MiB |
| the same rows in tail batches instead | 52 to 57 ms | 57 to 74 ms | 63 to 86 ms | 22.5 MiB |

(Ranges are two consecutive runs of the benchmark.) The first call in a process took
51 to 64 ms: the parser's lazily built tables are in the noise at this size.

- **Where the time goes:** about a quarter in storage (opening the files, decoding
  `series_id`, `ts`, `value` for 522,000 rows, de-duplicating), about three quarters in
  the evaluator (482,000 `rate` windows of 20 samples, then the aggregation), parsing
  and serialising under 2%. This crate's own work is not measurable.
- **Peak memory:** 20.2 MiB of heap above the inputs, by a counting allocator: the
  selected samples (520,000 x 16 B = 7.9 MiB) plus the evaluator's step grid (2,000
  series x 241 steps x 24 B = 11.0 MiB). Both are what `max_samples` and
  `max_step_points` bound; this query uses 26% and 48% of the defaults. Peak RSS of the
  benchmark process was 68 MB, which includes the generated rows, the 13 MiB of batches
  and the files it holds throughout.
- The benchmark asserts that the tail-only run returns the same JSON as the Parquet run.

Not measured: WASM timings for this workload, a comparison with `bench/`, anything on
Cloudflare.

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

One thing seen and not explained: the first release build of the
benchmark (about 19:45 UTC on 2026-11-18) returned an empty result for the benchmark
query, in 5 ms. `engine/storage/src` (`encode.rs`, `day.rs`, `pq.rs`, `select.rs`,
`merge.rs`) was being modified by the concurrent work between 19:42 and 19:48; the
next build five minutes later, and every build since, returns the right result, and it
could not be reproduced. It is recorded as a build that caught storage in the middle of
a multi-file edit, not as a confirmed bug. The benchmark now asserts 20 result series,
so a recurrence would be loud.

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

Decisions made here that belong in `design/DECISIONS.md` (not written there, because
this work was confined to `engine/`): limits live in `viz-query`, not in `viz-promql`;
limits count after de-duplication so that they are location-invariant; the depth guard
is lexical and runs before the parser; the JavaScript bindings are removed by
`[patch.crates-io]` stand-ins instead of vendoring `promql-parser` or post-processing
the module; `internal` is a fourth error type.

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
  crates". The final test run was against the sources as of 20:27 UTC on 2026-11-18
  (`cat engine/storage/src/*.rs | sha256sum` begins `1ea53883d6fababf`); all 34 tests,
  the WASM check and the benchmark were re-run against that state.
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
