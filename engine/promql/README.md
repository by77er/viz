# viz-promql

A PromQL evaluator as a Rust library. No I/O, no async, no clock, no randomness: the same
code runs natively, as WASM in a Worker, and in a deterministic simulator. Parsing is done by
the `promql-parser` crate (0.11.1); this crate plans and evaluates.

Semantics follow the Prometheus reference implementation at **v3.8.0** (`promql/engine.go`,
`functions.go`, `quantile.go`), checked three ways: the upstream `promqltest` corpus, a
differential run against the Prometheus Go engine itself, and property tests.

```rust
use viz_promql::{query_range, query_instant, selectors, MemSource, Series};

let src = MemSource::from_series(vec![Series {
    labels: vec![("__name__".into(), "up".into())],   // sorted, includes __name__
    ts: vec![0, 15_000, 30_000],                       // Unix ms, ascending, unique
    values: vec![1.0, 1.0, 0.0],
}]);
let matrix = query_range(&src, "up == 0", 0, 30_000, 15_000)?;
serde_json::to_string(&matrix)?;
// {"resultType":"matrix","result":[{"metric":{"__name__":"up"},"values":[[30,"0"]]}]}
```

## Public API

| Item | Purpose |
|---|---|
| `query_range(source, query, start_ms, end_ms, step_ms) -> Matrix` | Range query; series sorted by labels. |
| `query_instant(source, query, time_ms) -> Value` | Instant query: `Vector`, `Scalar`, `String`, or `Matrix` for a top-level range vector such as `m[5m]`. |
| `selectors(query, start_ms, end_ms, step_ms) -> Vec<SelectorInfo>` | Each selector's matchers and the inclusive `[min_ts, max_ts]` it reads (range, lookback, offset, `@`, subquery geometry included). Pass `start == end` for an instant query. |
| `*_with(…, &EvalOptions)` | Same, with `lookback_delta_ms` (default 5m), `delayed_name_removal` (default off, as in Prometheus), `subquery_default_step_ms` (default 1m), `max_steps` (default 11 000). |
| `trait SeriesSource { fn select(&self, matchers, min_ts_ms, max_ts_ms) -> Result<Vec<Series>, Error> }` | The only data-access seam. Contract is in the trait's doc comment. |
| `MemSource` | In-memory source with Prometheus matcher semantics (regexes fully anchored, a missing label equals `""`). |
| `Error::{Parse, Unsupported, Eval, Source}` | `Unsupported` is returned for anything not implemented, never a wrong answer. |
| `promqltest::run_script` | Runner for the upstream test-script format. |

`SelectorInfo` also carries `steps`, the number of evaluation steps of the (sub)query the
selector belongs to (not serialised). The evaluator materialises one cell per returned series
per step, so a caller can bound `series x steps` per selector; `viz-query` does.
`promqltest::run_script_with_source(script, opts, factory)` runs a test script through any
`SeriesSource` built from the loaded series; `viz-query` uses it to run the upstream corpus
through Parquet files and tail batches. Both were added for `engine/query` and are covered by
`selectors_report_the_step_count_of_their_subquery` and
`test_scripts_can_run_through_another_source` in `tests/api.rs`.

**Evaluation hooks** (added for split execution in `engine/query`, additive: with no
hooks nothing changes). `parse_query(text)` returns the syntax tree (with the same
duration guard as every entry point); `query_range_expr` and `query_instant_expr`
evaluate a tree with an optional `&dyn EvalHooks`, whose two methods default to `None`:
`replace(node, start, end, step)` may supply a node's value (an instant vector of
`SeriesV`: labels, the name-drop flag, one optional value per step) instead of evaluating
it, and `aggregate(&AggregateInput)` may supply an aggregation's result once its parameter
and argument are evaluated (the input carries the operator, `by`/`without`, the sorted
grouping, the evaluated parameter, the argument and the step grid). `engine/query` uses
the first to finish a split query at its coordinator and the second for aggregations whose
result does not depend on input order. Covered by
`evaluation_hooks_replace_nodes_and_aggregations` in `tests/api.rs`: no hooks equals the
ordinary entry points for four queries; `replace` substitutes exactly the given node;
`aggregate` sees the operator, grouping (with `count_values`' label), parameter, argument
size and grid of three aggregations and its result is used; `None` keeps the evaluator's.

`Matrix`, `Value` and `SelectorInfo` implement `serde::Serialize` and produce the `data` object
of the Prometheus HTTP API: values are `[unix_seconds, "string"]`, floats are the shortest
decimal that round-trips, never an exponent, with `NaN`, `+Inf`, `-Inf`.

`selectors()` is exact: a test (`evaluator_reads_exactly_what_selectors_reports`) records every
`select` call of the evaluator and requires it to equal the prediction. The evaluator calls
`select` once per selector per (sub)query evaluation; a Parquet-backed source can prefetch from
`selectors()` and answer those calls from memory.

## Implemented

Everything in this list is covered by passing upstream cases or by the differential run.

- **Selectors.** Instant vector selectors with a left-open lookback window `(t - 5m, t]`;
  staleness markers (NaN with bits `0x7ff0000000000002`) end a series and are skipped inside
  range vectors; plain NaN is an ordinary value. Matchers `=`, `!=`, `=~`, `!~`.
- **Range vectors.** Left-open, right-closed windows `(t - range, t]` (Prometheus 3.x).
- **Modifiers.** `offset` (positive and negative), `@ <ts>`, `@ start()`, `@ end()`, on
  selectors, range selectors and subqueries.
- **Subqueries.** `expr[range:step]` and `expr[range:]`; inner steps aligned to absolute
  multiples of the resolution.
- **Range functions.** `rate`, `increase`, `delta` (Prometheus' extrapolation, counter-reset
  correction, no extrapolation below zero for counters), `irate`, `idelta`, `resets`, `changes`,
  `deriv`, `predict_linear`, `avg_over_time`, `sum_over_time`, `min_over_time`,
  `max_over_time`, `count_over_time`, `last_over_time`, `first_over_time`, `stddev_over_time`,
  `stdvar_over_time`, `quantile_over_time`, `present_over_time`, `absent_over_time`; and the
  experimental `mad_over_time`, `ts_of_min_over_time`, `ts_of_max_over_time`,
  `ts_of_first_over_time`, `ts_of_last_over_time`, `double_exponential_smoothing`.
- **Aggregations.** `sum`, `avg`, `min`, `max`, `count`, `group`, `stddev`, `stdvar`, `topk`,
  `bottomk`, `quantile`, `count_values`, each with `by` / `without`. Compensated (Neumaier)
  summation as in Prometheus; `avg` switches to an incremental mean on overflow.
- **Binary operators.** `+ - * / % ^ atan2`; `== != > < >= <=` with and without `bool`;
  `and`, `or`, `unless`. Scalar/scalar, vector/scalar, vector/vector with `on` / `ignoring`,
  `group_left` / `group_right` with label lists, and the error cases (duplicate series on the
  "one" side, many-to-one without grouping, non-unique grouped results) with Prometheus' messages.
- **Functions.** `abs`, `ceil`, `floor`, `round`, `clamp`, `clamp_min`, `clamp_max`, `exp`,
  `ln`, `log2`, `log10`, `sqrt`, `sgn`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `sinh`,
  `cosh`, `tanh`, `asinh`, `acosh`, `atanh`, `deg`, `rad`, `pi`, `scalar`, `vector`, `time`,
  `timestamp`, `absent`, `label_replace`, `label_join`, `sort`, `sort_desc`, `sort_by_label`,
  `sort_by_label_desc`, `histogram_quantile` over classic `le` buckets, `day_of_month`,
  `day_of_week`, `day_of_year`, `days_in_month`, `hour`, `minute`, `month`, `year`.
- **Metric name.** Dropped by functions, arithmetic, `bool` comparisons and unary minus; kept by
  filter comparisons, set operators, `topk`/`bottomk`, `last_over_time`, `first_over_time`.
  Colliding label sets are the error `vector cannot contain metrics with the same labelset`.
  `delayed_name_removal` reproduces the `promql-delayed-name-removal` feature flag.
- **Literals.** Numbers (decimal, hex, `Inf`, `NaN`, durations as numbers such as `1h`),
  strings, duration literals.

## Not implemented

Each of these returns `Error::Unsupported("…")`, or `Error::Parse` where the parser itself
rejects the syntax.

- Native histograms: sample type, and `histogram_count`, `histogram_sum`, `histogram_avg`,
  `histogram_stddev`, `histogram_stdvar`, `histogram_fraction` (also for classic buckets),
  `histogram_quantiles`.
- `limitk`, `limit_ratio`.
- `anchored` and `smoothed` modifiers (parse error from `promql-parser` 0.11).
- `fill()`, `fill_left()`, `fill_right()` binary modifiers.
- `info()`, `integral()`, `start_timestamp()`, `min_of()`, `max_of()`, duration expressions
  (`step()`, `range()`, arithmetic in durations; parse error).
- `or` inside a label matcher list (`{a="b" or c="d"}`).
- Annotations (warnings and infos such as "metric might not be a counter"). Queries return the
  same values as Prometheus but without them.
- Query limits other than step counts: there is no sample budget and no timeout in this crate.
  `viz-query` (`engine/query`) adds them around it: samples, series, step points, output
  points, query length and nesting depth. A caller that uses this crate directly must bound
  series and range itself.
- Recursion depth is not limited here: an expression nested thousands of levels deep can
  exhaust the stack in the parser or the evaluator. `viz-query` refuses such queries from
  their text before parsing (`Limits::max_depth`).

## Verification

All commands are run in `engine/promql` with `CARGO_TARGET_DIR=$PWD/target`. Numbers are
measured here (Linux x86-64, rustc 1.97.0), not on Cloudflare.

### 1. Upstream `promqltest` corpus

The corpus **was fetched** unmodified with curl from `raw.githubusercontent.com/prometheus/prometheus/v3.8.0/promql/promqltest/testdata/`
(13 files, 1103 `eval` cases, kept in `testdata/upstream/`). `src/promqltest.rs` implements
`load`, `load_with_nhcb`, `clear`, `eval instant at`, `eval range from … to … step`, the
deprecated `eval_fail` / `eval_ordered` forms, `expect fail [msg:|regex:]`, `expect ordered`,
`expect string`, `expect range vector`, and series descriptions with `_`, `_xN`, `stale`,
`a+bxN`, `a-bxN`, `axN`. As upstream does, each instant case is also re-run with every selector
pinned by `@` at five other evaluation times, and as the middle step of a range query, so one
case is up to twelve evaluations. Values are compared with upstream's relative tolerance of 1e-6.

`cargo test --test upstream -- --nocapture`, with the options the upstream test engine uses
(delayed name removal on):

| file | passed | failed | skipped | skipped: native histogram / unsupported / parser |
|---|---:|---:|---:|---|
| aggregators.test | 151 | 0 | 9 | 7 / 2 / 0 |
| at_modifier.test | 45 | 0 | 0 | |
| collision.test | 2 | 0 | 0 | |
| functions.test | 330 | 1 | 39 | 39 / 0 / 0 |
| histograms.test | 52 | 0 | 109 | 47 / 62 / 0 |
| literals.test | 25 | 0 | 0 | |
| name_label_dropping.test | 21 | 0 | 0 | |
| operators.test | 198 | 0 | 7 | 7 / 0 / 0 |
| range_queries.test | 12 | 0 | 1 | 1 / 0 / 0 |
| selectors.test | 31 | 0 | 0 | |
| staleness.test | 17 | 0 | 0 | |
| subquery.test | 32 | 0 | 2 | 2 / 0 / 0 |
| trig_functions.test | 19 | 0 | 0 | |
| **total** | **935** | **1** | **167** | 103 / 64 / 0 |

How to read the columns:

- **Failed (1):** `functions.test:523`, `label_replace(testmetric, "\xff", "", "src", "(.*)")`
  must fail because `\xff` is not valid UTF-8. `promql-parser` decodes `\xff` to U+00FF, a valid
  string, so the invalid name cannot be detected here. Listed in `testdata/known_failures.txt`.
- **Skipped, native histogram (103):** the expected result contains native histograms, or the
  result depends on histogram samples that this engine does not store.
- **Skipped, unsupported (64):** the query returned `Unsupported`: `histogram_fraction` 55,
  `histogram_count` 2, `histogram_sum` 2, `histogram_avg` 1, `histogram_stddev` 1,
  `histogram_stdvar` 1, `limitk` 1, `limit_ratio` 1.
- **Passed includes 159 cases** (28 aggregators, 66 functions, 65 operators) whose `load` block
  also holds a native-histogram series that the query selects. Upstream wrote them to show that
  float functions ignore histogram samples; here the histogram samples are simply absent, and
  the case counts as passed only when the float result is exactly the expected one. Without
  those, 776 cases pass on data with no histogram involvement at all.
- No case is skipped silently: `testdata/expected_skips.txt` pins all 167 with their reason,
  and the test fails if a case becomes skipped or stops being skipped.
- `expect warn` / `expect info` / `expect no_warn` / `expect no_info` lines (370 in these
  files) are parsed and **not checked**, because annotations are not implemented.

The same corpus with the engine's default options (delayed name removal off, what production
uses): 930 passed, 6 failed, 167 skipped. The five additional failures are
`name_label_dropping.test:55, 60, 65, 70, 85`, which expect the feature flag's behaviour; stock
Prometheus without the flag returns the same duplicate-labelset error
(`testdata/known_failures_default_options.txt`).

Upstream files not fetched, because the whole file is out of scope: `native_histograms.test`,
`limit.test`, `duration_expression.test`, `extended_vectors.test`, `info.test`,
`type_and_unit.test`, `fill-modifier.test`.

### 2. Differential run against the Prometheus Go engine

Go 1.24 is available here, so `tools/godiff` evaluates the same data and queries with
`github.com/prometheus/prometheus v0.308.0` (the Go module of Prometheus 3.8.0) and compares.
It also decodes this crate's JSON with `prometheus/common/model`, an independent reader of the
HTTP API shape.

```
VIZ_DIFF_ROUNDS=600 VIZ_DIFF_OUT=/tmp/cases.json cargo test --release --test props export_differential_cases -- --ignored
cd tools/godiff && VIZ_CASES=/tmp/cases.json go test -v -count=1 -run TestDiff .
```

Result: **219 600 evaluations (600 random data sets × 184 queries, as range and as instant
query, half the data sets with delayed name removal), 219 600 agree, 0 mismatches**; 8 707 of them are cases where both engines
return an error. Values are compared with a relative tolerance of 1e-9, labels and timestamps
exactly. For `topk`/`bottomk` only the selected values per step are compared, because ties are
broken differently (see deviations).

The first run of this harness had 408 mismatches and found two bugs that the upstream corpus
does not exercise; both are fixed and have regression tests (`differential_regressions`):

1. `histogram_quantile` with NaN bucket counts returned NaN where Prometheus returns the
   second-highest bucket bound.
2. One-to-one and `group_left` matching raised "duplicate series on the right hand-side" at
   steps where the left side was empty; Prometheus returns nothing at such a step.

It also showed one deviation that is kept (date functions on NaN, below).

### 3. Property tests

`cargo test --test props` (proptest, 400 cases each by default; also run once with
`PROPTEST_CASES=5000`, all passing). Data: up to 13 series with irregular spacing, NaN,
staleness markers, counters with resets and a classic histogram. Queries: a pool of 92 covering
every implemented function and operator class (the differential run adds 92 more: `@ start()`,
`@ end()`, error cases and edge parameters).

| property | status |
|---|---|
| `query_range` equals one `query_instant` per step (bit-identical values, same error-ness) | pass |
| result is independent of the order in which the source returns series (range JSON and instant JSON, including vector order) | pass |
| one `query_range` equals two adjacent `query_range` calls concatenated | pass |
| `query_pool_is_live`: every pool query evaluates and returns data on generated inputs, so the three above are not vacuous | pass |
| `token_soup_never_panics`: valid queries with random tokens spliced in, at extreme timestamps, return `Ok` or `Err` and never panic (also run 4 × 30 000 cases) | pass |

The no-panic property found a panic inside `promql-parser`: a bare number that is infinite, NaN
or huge in a duration position (`m[1e400]`, `m offset Inf`) reaches `Duration::from_secs_f64`.
`guard_durations` in `src/lib.rs` now rejects those from the parser's own token stream before
parsing.

### 4. Test strength

`python3 tools/mutate.py` applies one semantic change at a time, runs the three suites, and
restores the file. "Caught by" lists the suites that failed.

| # | mutation | upstream corpus | tests/api.rs | tests/props.rs |
|---:|---|---|---|---|
| 1 | range window closed on the left | caught | caught (`source_may_return_extra_samples_and_unsorted_labels`) | not caught |
| 2 | no extrapolation in rate/increase/delta | caught | caught (`rate_extrapolates_and_drops_name`) | not caught |
| 3 | staleness markers ignored by instant selectors | caught | caught (`staleness_marker_ends_a_series_but_plain_nan_does_not`) | not caught |
| 4 | lookback 4m instead of 5m | caught | caught (`lookback_is_five_minutes_left_open`) | not caught |
| 5 | __name__ kept after rate and other range functions | caught | caught (`name_dropping_default_mode`, `rate_extrapolates_and_drops_name`, `source_may_return_extra_samples_and_unsorted_labels`, `staleness_marker_ends_a_series_but_plain_nan_does_not`) | not caught |
| 6 | `without` keeps the listed labels (only drops the name) | caught | not caught | not caught |
| 7 | counter resets not compensated in rate | caught | caught (`rate_extrapolates_and_drops_name`) | not caught |
| 8 | one-to-one matching accepts duplicate right-hand series | not caught | caught (`differential_regressions`, `vector_matching_error_cases`) | not caught |
| 9 | offset sign flipped | caught | caught (`selectors_report_ranges`) | not caught |
| 10 | subquery steps aligned to the outer start instead of absolute multiples | caught | not caught | caught (`range_equals_repeated_instant`, `split_range_concatenates`) |
| 11 | comparison without bool keeps non-matching samples | caught | not caught | not caught |
| 12 | @ modifier ignored on instant selectors | caught | not caught | not caught |
| 13 | many-to-one without group_left accepted silently | not caught | caught (`vector_matching_error_cases`) | not caught |
| 14 | group_left does not copy the listed labels | caught | caught (`vector_matching_error_cases`) | not caught |
| 15 | `and` behaves like `unless` | caught | caught (`name_dropping_default_mode`) | not caught |
| 16 | topk ignores `by` grouping | caught | not caught | not caught |
| 17 | histogram_quantile bucket search mishandles NaN counts | not caught | caught (`differential_regressions`) | not caught |
| 18 | duplicate check on the one side even when the other side is empty | not caught | caught (`differential_regressions`) | not caught |
| 19 | histogram_quantile does not interpolate inside the bucket | caught | not caught | not caught |
| 20 | stddev aggregation returns the variance | caught | not caught | not caught |

All 20 mutants are caught by at least one suite; the source was restored and the full suite re-run green after each run.

One mutant survived the first version of the tests and is the reason `vector_matching_error_cases`
exists: accepting duplicate series on the right-hand side of a one-to-one match passed the whole
upstream corpus (the 13 files contain no such failure case). The Go differential run is not part
of this table because it needs Go and network access to the module proxy.

### 5. WASM

`cargo build --release --target wasm32-unknown-unknown` succeeds (the crate is an `rlib`).
To measure what it costs in a module, a minimal `cdylib` wrapper (query text in, JSON out, over
`MemSource`, plus `serde_json`) was linked and run under Node 22:

| build | `.wasm` | gzip -9 |
|---|---:|---:|
| wrapper, `opt-level = 3`, fat LTO, 1 codegen unit, `panic = "abort"`, stripped (the profile `engine/AGENTS.md` asks for) | 2 394 658 B | 669 829 B |
| same with `opt-level = "s"` | 1 923 141 B | 577 240 B |
| for comparison: `promql_parser::parse` alone, `opt-level = "s"` | 1 734 815 B | 507 112 B |

So about 90% of the weight is the parser and what it pulls in (`lrpar`/`lrlex`/`cfgrammar`
grammar tables, `regex` with its default Unicode tables, `chrono`); the evaluator, `serde` and
`serde_json` add about 190 KB. `cargo tree` lists 52 crates for the WASM target, most of them
build-time. Direct dependencies: `promql-parser`, `lrpar` (same version the parser links),
`regex`, `serde`.

Two things the WASM consumer must know:

- **The module has `wasm-bindgen` imports unless the final crate patches them out.** `chrono`
  (default feature `wasmbind`) and `web-time` (via `lrpar`) pull `js-sys`/`wasm-bindgen` on
  `wasm32-unknown-unknown`, so the linked module imports `__wbindgen_placeholder__.*`. No
  feature flag of this crate can remove them. `engine/query/patches/` holds three small
  `[patch.crates-io]` stand-ins that do (see its README); with them the whole engine links
  with zero imports and loads with an empty import object (`engine/query/tools/wasm_check.mjs`).
  Without them the module must be post-processed with `wasm-bindgen`, or the imports stubbed. Under Node, with every import
  replaced by a stub that throws, all test queries (including parse errors, `@` and subqueries)
  ran and **no import was called**: the clock code is reachable only through `lrpar`'s error
  recovery, which `promql-parser` disables. This was measured on a handful of queries, not proven.
- First parse costs a few milliseconds (grammar tables are built lazily); later queries ran in
  0.05–1 ms in that Node run on tiny data.

## Known deviations from Prometheus

- **Annotations** are not produced (see Not implemented).
- **`topk` / `bottomk` ties** are broken by label set (smaller first), which makes the result
  independent of input order. Prometheus keeps whichever series its heap saw first.
- **Date functions on NaN or out-of-range values** (`minute(v)` where `v` is NaN or ±Inf):
  Prometheus converts with Go's float-to-int conversion, whose result for such inputs depends on
  the CPU architecture (on x86-64 it produced minute 30 for NaN). This engine saturates (NaN → 0).
- **Regex dialect.** Matchers and `label_replace` use Rust's `regex` crate, not Go's RE2
  package. Both are linear-time and agree on common syntax; rare constructs may differ. Patterns
  are anchored as `^(?s:…)$`.
- **Invalid UTF-8 in label names** written with `\x` escapes cannot be detected (parser
  limitation; the one failing upstream case).
- **Experimental functions are always on** (`mad_over_time`, `ts_of_*_over_time`,
  `sort_by_label*`, `double_exponential_smoothing`); Prometheus requires a feature flag.
- **Limits.** A range query of more than `max_steps` steps (default 11 000, the HTTP API limit
  of Prometheus) and a subquery of more than 100 × that many inner steps are errors; bare-number
  durations above 1e15 seconds are parse errors.
- **JSON timestamps** with a fractional part are written as `1.5`, where Prometheus writes
  `1.500`. The numbers are equal.
- **Instant vector order** is the label order of the selector output unless a function defines
  an order (`sort`, `topk`). Prometheus returns storage order, which is unspecified.
- Sub-millisecond parts of durations and `@` timestamps are rounded to milliseconds.

## Known risks

- `promql-parser` is the largest dependency, is where the one panic was found, and lags
  upstream syntax (`anchored`, `smoothed`, duration expressions). A panic aborts a WASM isolate.
  The token-soup property test is the guard; it is random testing, not a proof.
- Memory is proportional to (series × steps) per expression node, at 16 bytes per point, plus
  the samples returned by `select`. Nothing is streamed, and there is no sample budget.
- The corpus cannot test what it skips: behaviour around native histograms is absent, not
  approximated.
- Float results may differ from Prometheus in the last bits for `exp`, `ln`, `^` and the
  trigonometric functions (different math libraries); the differential run allows 1e-9 relative.

## Contract issues

Against `contracts/engine.ts` (not edited):

- `selectors(promql, startMs, endMs)` has no `stepMs`. The exact answer depends on the last
  evaluated step, `start + floor((end - start) / step) * step`. A binding without a step can pass
  `step = 1 ms` and gets a safe superset (only `maxTs` grows, by less than one step). It also
  cannot pass a non-default lookback delta.
- `queryInstant` returns `PromVector | PromScalar`. PromQL instant queries can also return a
  string (`"foo"`) and a matrix (`m[5m]`); this crate returns both (`Value::String`,
  `Value::Matrix`), as the Prometheus API does. The contract needs those two shapes or a rule
  that they are errors.
- `SeriesData.labels` is an unordered `Record`, and `ts` a `Float64Array` of milliseconds; this
  crate wants label pairs sorted by name and `i64` milliseconds. The binding has to convert, and
  must keep values in a `Float64Array` (never JSON) so that staleness NaN payloads survive.
- No place for errors: callers need to tell "bad query" from "unsupported" from "evaluation
  failed" (`Error::Parse` / `Unsupported` / `Eval`), which map to different HTTP statuses.
- No place for engine options (lookback delta, delayed name removal) or for warnings.
- `Engine.select(input, matchers, minTs, maxTs)` matches `SeriesSource::select`, but
  `queryRange(input, …)` implies the engine scans `ScanInput` itself. Evaluation calls `select`
  once per selector per (sub)query, so the implementation behind it should decode once and
  answer several calls, or prefetch from `selectors()`.

## Layout

```
src/types.rs        Series, Matcher, SeriesSource, MemSource, Error, float formatting
src/eval.rs         evaluator (selectors, range vectors, subqueries, calls, binary ops, aggregations)
src/functions.rs    numeric kernels (rate extrapolation, *_over_time, quantiles, regression, calendar)
src/api.rs          result types and Prometheus HTTP API serialisation
src/lib.rs          public entry points, selectors(), duration guard
src/promqltest.rs   runner for the upstream test-script format
tests/upstream.rs   corpus run with pinned failures and skips
tests/api.rs        JSON shape, selector ranges, matching error cases, regressions
tests/props.rs      property tests, no-panic test, exporter for tools/godiff
tools/mutate.py     test-strength check
tools/godiff/       differential test against the Prometheus Go engine
testdata/upstream/  the fetched corpus (see its README for the ref)
```

The crate has its own `[workspace]` table so that it builds standalone next to its siblings.
