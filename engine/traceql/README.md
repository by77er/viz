# viz-traceql

A TraceQL engine as a Rust library: lexer, parser and validator, a read planner that tells
storage what a query reads, and evaluators for search and metrics queries over a span
source shaped like `contracts/TRACES.md`, with results in Tempo's HTTP API JSON. No I/O, no
clock, no randomness; native and `wasm32-unknown-unknown`.

**Clean-room.** Grafana Tempo (the reference implementation) is AGPL-3.0 and viz is
Apache-2.0. This crate was written from Tempo's public documentation and from Tempo's
behaviour observed by running it as a black box; Tempo's source was not read.
`CLEANROOM.md` lists every source consulted. Tempo's example list and Tempo itself are
fetched at test time and never stored here.

**Parser choice.** Hand-written lexer and recursive-descent / precedence-climbing parser,
no parser crate or generator: there is no permissively licensed TraceQL grammar to reuse,
and a hand-written parser carries no grammar tables into the WASM module (the PromQL
parser's tables are about 90% of `viz-promql`'s module) and reports positions directly.
The only runtime dependency is `regex` (MIT/Apache-2.0).

```rust
use viz_traceql::{search, query_range, plan, MemSource, RangeRequest, SearchRequest, Trace};

let src = MemSource::new(traces);                       // Vec<Trace>: spans + trace summary
let r = search(&src, r#"{ resource.service.name = "api" } >> { status = error }"#, &SearchRequest::default())?;
r.to_json();                                            // body of Tempo's /api/search
let m = query_range(&src, "{ } | rate() by (resource.service.name)", &RangeRequest::range(start, end, step))?;
m.to_json();                                            // body of /api/metrics/query_range
let p = plan(query, start, end)?;                       // columns, predicates, time window, full_traces
```

## Public API

| Item | Purpose |
|---|---|
| `parse(query) -> RootExpr` | Parse and validate. Errors: `Parse{pos,line,col,msg}`, `Validation{…}`, `Unsupported(msg)` |
| `search(source, query, &SearchRequest) -> SearchResponse` | `limit` (default 20, most recent traces first), `spans_per_spanset` (default 3; `matched` counts all), optional `[start, end]` window (traces that overlap it) |
| `query_range(source, query, &RangeRequest)`, `query_range_with(…, &Limits)` | Metrics over `(start, end]` at `step`; `RangeRequest::instant(start, end)` for `/api/metrics/query`. `Limits`: series per query (10,000), points (11,000) |
| `query_instant(source, query, start, end)` | One point at `end` covering `(start, end]` |
| `plan(query, start, end) -> ReadPlan` | What a query reads, from the text alone: `columns` (intrinsics and attributes by scope), `span_filter` (spans failing it can be dropped), `trace_filter` (traces with no span passing it can be dropped; `And` across different spans), `trace_window` (search), `span_window` (metrics; prunes spans only when `span_local`), `full_traces` (structural operators, `span:childCount`) |
| `trait SpanSource { fn traces(&self, &ReadPlan, visit) }` | The only data seam. A source may return more than the plan admits, never less (contract in the doc comment) |
| `MemSource` | In-memory source; `.pruning(true)` applies the plan as storage would (used to test that pruning never changes a result) |
| `align_request(&RangeRequest)` | Tempo's query-frontend alignment of range requests, as observed |
| `SearchResponse::to_json`, `MetricsResponse::to_json` | Tempo's HTTP JSON (protobuf-JSON: 64-bit integers as strings, `AnyValue` objects, empty fields omitted) |
| `matching_spansets(query, &Trace)` | Spansets of one trace (for storage-side checks) |

## Implemented

Everything here is covered by `tests/api.rs` and the differential run unless noted.

- **Spanset filters** `{ … }` with `&&`, `||`, `!`, parentheses; comparisons `= != > >= < <=`,
  regex `=~ !~` (Rust `regex`, RE2-like, fully anchored `^(?s:…)$`), arithmetic `+ - * / % ^`,
  unary `-`; literals: int, float, duration (`ns us µs ms s m h`, compound `1h30m`), string
  (Go escapes), `true`/`false`, `nil`, status (`ok error unset`), kind (`server client
  producer consumer internal unspecified`), `minInt`, `maxInt`.
- **Intrinsics**, scoped and unscoped: `span:name|status|statusMessage|duration|kind|id|parentID|childCount`,
  `trace:duration|rootName|rootService|id`, `event:name|timeSinceStart`, `link:spanID|traceID`,
  `instrumentation:name|version`; legacy `name status statusMessage duration kind traceDuration
  rootName rootServiceName`.
- **Attributes** by scope: `span.`, `resource.`, `event.`, `link.`, `instrumentation.`, and
  unscoped `.x` (span, then resource); quoted names (`span."a b"`, `\"` and `\\` escapes);
  typed values including arrays (`=`, `=~`, orderings: any element; `!=`, `!~`: no element,
  as documented).
- **Spanset operators**: `&&`, `||`; structural `>`, `>>`, `<`, `<<`, `~`; negated `!>`,
  `!>>`, `!<`, `!<<`, `!~`; union `&>`, `&>>`, `&<`, `&<<`, `&~`; wrapped pipelines on both
  sides (`({…} | count() > 1) >> ({…} | …)`).
- **Pipelines**: filters, aggregates `count() avg() min() max() sum()` compared with a
  constant (constant arithmetic folded, integer division kept), `by(expr)`, `coalesce()`,
  `select(fields…)`; a pipeline may start with any stage but `coalesce()`.
- **Metrics**: `rate`, `count_over_time`, `sum/min/max/avg_over_time`,
  `quantile_over_time(expr, q…)`, `histogram_over_time`, each with `by (…)`; second stages
  `topk(k)`, `bottomk(k)` and comparisons (`> 10`, `>= 1s`) in any order; arithmetic
  between metrics queries and with scalars (`+ - * /`, label matching and broadcast of an
  unlabelled side, division by zero is NaN); instant queries.
- **Hints** `with(…)`: `sample`, `span_sample`, `trace_sample` are accepted and ignored (the
  answer is exact), `most_recent` is accepted (results are always most recent first),
  `exemplars` is accepted (no exemplars are returned), unknown hints are ignored.
- **Search JSON**: `traceID` (hex without leading zeros, as Tempo prints it),
  `rootServiceName`, `rootTraceName`, `startTimeUnixNano`, `durationMs`, `spanSet` (first
  spanset) and `spanSets`, `matched`, spanset `attributes` (`count()`, `avg(.n)`,
  `by(resource.service.name)`, …), span `attributes` echoing the fields the query reads,
  `serviceStats`, `metrics.inspectedTraces/inspectedSpans`.
- **Metrics JSON**: `series[].labels` (typed `AnyValue`; `__name__` without `by`; `p` for
  quantiles, `__bucket` for histograms), `samples[].timestampMs` (string) and `value`; NaN
  samples left out.

### Semantics settled by observing Tempo (where the documentation is silent)

| Topic | Rule | Evidence (black-box probe or differential case) |
|---|---|---|
| `&&` / `||` inside a filter | one precedence level, left-associative: `{ a \|\| b && c }` is `(a \|\| b) && c` | `{ name="GET /" \|\| name="db" && kind=client }` returned only the client `db` spans |
| spanset operators | `&&`, `\|\|` one level, left-assoc; structural operators bind tighter, left-assoc | `{ } \|\| { name="nope" } > { }` returned every span; `{a} > {} > {}` children of children |
| comparisons with a missing value | false for every operator; only a literal `nil` tests presence | `{ span.cached != false }` does not match spans without `cached` |
| numbers | int, float, duration compare and combine by value; int/int division truncates (`5/2 = 2`) | `{ .n / 2 = 2 }` matched n=5; `{ .n * 1.0 > 4 }` matched 4.5 |
| `resource.service.name` | a missing one reads as `""`; `= nil` is a validation error | `by(resource.service.name)` gave `""` for a resource without it |
| event and link fields | the whole filter is evaluated per event (link); one event must satisfy it | `{ event:name = "log" && event.exception.message = "boom" }` empty when the two are on different events |
| structural operators | only spans connected to a root take part; several roots are siblings | trace with a dangling parent: `{ } > { }` skipped the orphan subtree |
| result keys | scoped span/trace intrinsics print by legacy name: `kind`, `duration`, `rootServiceName`, `traceDuration` | `by(span:kind)` → label `kind`; `sum(span:duration)` → `sum(duration)` |
| metrics grid | points are multiples of the step in Unix time, from the first after `start` to the first at or after `end`; point `t` covers `(t − step, t]`; spans count if `start < ts ≤ end`; instant = one point at `end` | probes with steps 1 s, 3 s, 7 s and unaligned starts |
| `rate` | count / step seconds (instant: / range) | same |
| empty points | `count_over_time`, `rate`, quantiles, histograms: 0; `sum/min/max/avg_over_time`: no sample | same |
| `by` labels in metrics | a missing value is left out of the labels; a series left with none gets `first_by = "nil"` | `count_over_time() by (.foo, resource.service.name)` |
| quantiles, histograms | integer values ≥ 2 (durations in ns) go to bucket `2^ceil(log2 v)` (through f64); floats and smaller values are not counted; quantile rank `ceil(p·N)` clamped to `[1, N]`, interpolated exponentially from the previous non-empty bucket's bound (half its own for the first); durations reported in seconds | 9 probe groups (`tests/api.rs`, `quantiles_and_histograms_use_log2_buckets`) |
| `topk`/`bottomk` | per point; ties broken by labels (Tempo: arbitrary) | |
| search order | most recent trace first, then trace id (Tempo: first found) | |

## Not implemented

Each returns `Error::Unsupported`, or a parse error where Tempo also rejects it.

- `compare()` (Unsupported; its misuse with second stages and arithmetic is rejected as
  Tempo does).
- The `parent.` scope and the `parent` intrinsic; the undocumented `nestedSetLeft`,
  `nestedSetRight`, `nestedSetParent` intrinsics (type-checked, then Unsupported).
- Scalar filters other than `aggregate op constant`: aggregate against aggregate,
  arithmetic on aggregates, arithmetic between wrapped scalar pipelines (Tempo reports
  these as unsupported too).
- `with(extrapolate=true)` (sampling weights are not stored yet; `contracts/TRACES.md`).
- Exemplars; the `metrics.*` byte and job counters of Tempo's search response.
- `/api/traces/<id>` (trace by id), tag and tag-value search, `/api/v2/traces` filtering:
  those are storage lookups, not TraceQL evaluation.
- Default `step` when a request has none: the caller must choose (Tempo's observed choices:
  1 h → 15 s, 6 h → 1 min, 24 h → 5 min, 7 d → 40 min).
- Search attribute echo matches Tempo's keys but not its quirks (Tempo also echoes `nil`
  for missing fields, repeats keys, and echoes the matched array element).
- Span ids are compared without leading zeros on both sides (Tempo did not match
  `span:id` for ids with a leading zero byte).

## Verification

Measured here: Linux x86-64, 4 cores and 16 GB shared with other builds (load average
9–19 during these runs), rustc 1.97.0, Go toolchain 1.27.3 (fetched), Node 22.23. Not on
Cloudflare. `CARGO_TARGET_DIR` was outside the repository.

```sh
tools/fetch_tempo_tests.sh                  # oracle list into testdata/upstream (git-ignored)
cargo test -j 2                             # api, conformance, props, unit
PROPTEST_CASES=2000 cargo test --release --test props
python3 -I tools/mutate.py $SCRATCH         # mutants, on a copy
```

### 1. Conformance against Tempo's example list (behavioural oracle)

`tests/conformance.rs` reads Tempo's `pkg/traceql/test_examples.yaml` at v3.1.1 (fetched by
`tools/fetch_tempo_tests.sh`, git-ignored) and uses only which list each query is in.

| Tempo's list | queries | viz accepts | viz rejects as Tempo (same category) | viz: other error | viz: Unsupported |
|---|---:|---:|---:|---:|---:|
| `valid` | 284 | **282** | – | 0 | 2 (`nestedSetLeft…`, undocumented) |
| `parse_fails` | 87 | 0 | 86 parse | 0 | 1 (`min(parent) = nil`; Tempo: parse error) |
| `validate_fails` | 70 | 0 | 70 validation | 0 | 0 |
| `unsupported` | 22 | 0 | – | 0 | **22** |

0 failures: no rejected query is accepted and no accepted query is rejected. The 2 + 1
Unsupported answers are listed above; `testdata/conformance_known_failures.txt` is empty.
Without the fetched file the test prints `SKIPPED` and passes.

### 2. Differential run against Tempo v3.1.1 (black box)

`tests/differential.rs` generates data sets and queries (`tests/common`), evaluates them
with viz and writes a case file; `tools/godiff` evaluates the same cases with Tempo's engine
over a real vParquet5 block; `tools/compare.py` compares and classifies every difference.
Data: 10 data sets of 10–58 traces, 1–120 spans each, chains, fans and random trees (every
third data set also with extra roots and dangling parents), 7 services plus a resource
without `service.name`, 10 span attribute keys of every type (string, int, float, bool,
string array, int array) present on about half the spans, resource attributes, 0–2 events
and some links per span, instrumentation scopes, durations 0, 1, 2 ns, powers of two and
up to 3 s, floats including NaN, ±Inf, ±0.0, 1e-300 and ints up to 2^53+1. Queries: every
feature in "Implemented"; search with limit 100,000 and spss 100,000; metrics with steps
30 s, 60 s, 7 s (unaligned end) and instant.

Four final runs, all on the final code (the comparison rules were last changed after
these runs and re-applied to the same outputs):

| Run | Seed | Queries | Data sets | Cases | Agree | Both reject | Classified | **Unexplained** |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| A | 1 | one feature per query | 10 | 600 | 382 | 79 | 139 | **0** |
| B | 2 | nested (operators, pipelines, arithmetic combined) | 10 | 600 | 385 | 86 | 126 | **3** |
| C | 3 | one feature per query | 20 | 1,200 | 741 | 145 | 310 | **4** |
| D | 4 | nested | 20 | 1,200 | 712 | 185 | 298 | **5** |
| **total** | | | 60 | **3,600** | **2,220** | **495** | **873** | **12** |

Every one of viz's 3,105 JSON answers decoded strictly into Tempo's `SearchResponse` /
`QueryRangeResponse` protobuf types (unknown fields rejected); none failed.

Classified differences, by rule (all four runs): `ambiguous_root` 264, `event_link_values`
119 (+52 metrics), `tempo_negation_pushdown` 95 (+14 metrics), `tempo_typed_pushdown` 62,
`tempo_unscoped_nil` 59, `unrooted_structure` 51 (+18 metrics), `tempo_union_structural` 41
(+6 metrics), `tempo_sum_missing_value` 33, `tempo_metrics_intrinsic_arithmetic` 23,
`tempo_after_select` 16, `tempo_avg_negative_int` 9, `tempo_regex_error` 4,
`tempo_meta_missing` 3, `infinite_average` 1, `tempo_zero_span_ids` 1,
`tempo_missing_trace_id` 1, `ambiguous_root_metrics` 1.

**The 12 unexplained differences are not resolved.** They are reported, not hidden; each
may be a viz bug. Targeted probes did not reproduce them in isolation (a bare boolean in
`||`, for example, behaves the same in both engines on small data).

| Run, case | Query |
|---|---|
| B 320 | `{ (span.n > 200 \|\| span:kind != unspecified) && trace:id = "4d57…4f44" } !< { span:kind = unspecified } \| min_over_time(span:duration) by (span:kind, span.n)` |
| B 350 | `{ (span.cached \|\| span.retries > -1) && span:name != "render" && kind = internal } \| count_over_time()` |
| B 542 | `{ rootServiceName = "cache" \|\| status = ok } \| avg_over_time(span.n) by (span:kind, status)` |
| C 368 | `{ .rint > 0 } << { span.tags != nil } \| rate()` |
| C 593 | `{ } \| avg_over_time(span.f) by (span:kind) \| bottomk(2)` |
| C 677 | `{ span.n <= -1 } && { .ratio != 1.5 } \| max_over_time(span.n) by (span.n) \| topk(2)` |
| C 772 | `{ span.http.status_code > -1 } !>> { span.tags != nil } \| { trace:id = "475f…323e" }` |
| D 595 | `{ kind != internal } \| { (instrumentation:version = "0.9" \|\| span.http.route = nil) && span.http.route != "b" }` |
| D 828 | `{ instrumentation:version = "1.2.0" \|\| .cached } \| select(span:kind, .http.status_code)` |
| D 911 | `({ span.n > 0 } \|\| { span:duration < 0 } \| histogram_over_time(duration) by (resource.service.name, .env)) - 0.5` |
| D 1103 | `{ span:duration <= 2.5s } !<< { instrumentation:version = "" } \| avg_over_time(span.f)` |
| D 1143 | `{ .region = "GET" } << { !(span:childCount > 2) && resource.rint < -1 } !~ { … } \| coalesce() \| select(…)` |

To reproduce: the commands in `tools/godiff/README.md` with `VIZ_DIFF_SEED=1..4`,
`VIZ_DIFF_DEPTH=0` (A, C) or `1` (B, D), `VIZ_DIFF_DATASETS=10` (A, B) or `20` (C, D),
`VIZ_DIFF_QUERIES=60`; `tools/compare.py --show N` prints each unexplained case.

**viz bugs found by the differential run and fixed** (each has a test in `tests/api.rs`):
a missing attribute satisfied `!=`; an aggregate over no values satisfied `!=`; `NaN != x`
was false; metrics points were offsets from `start` instead of multiples of the step;
`nil` grouping values were kept in labels; quantile interpolation started at half the
bucket bound instead of the previous bucket; `2^53+1` was bucketed above `2^53`; result
keys used `span:kind` instead of `kind`; `&&` bound tighter than `||` in filters and
structural operators bound as loosely as `&&`/`||`; spanset operators accepted a wrapped
pipeline next to a plain filter; quantile series without countable values were returned.
The typed-literal rule first copied from Tempo's storage path was replaced by Tempo's
evaluator rule (below).

**Classification rules** (`tools/compare.py`; each states the evidence it checks):

| Rule | Kind | What happens |
|---|---|---|
| `ambiguous_root` (+`_metrics`) | ambiguity | a trace with several root spans: Tempo and viz pick different ones (viz: `contracts/TRACES.md`). Checked: every differing trace has >1 root |
| `unrooted_structure` (+`_metrics`) | ambiguity | structural operators over spans with a missing parent: Tempo keeps some and drops others; viz drops all. Checked: every differing trace has an unconnected span or several roots |
| `event_link_values` (+`_metrics`), `echo_event_choice` | Tempo defect | unless its storage applies a plain conjunction itself, Tempo looks each event field up separately: `{ event.ev = 2 \|\| name = "nope" }` failed where the second event has `ev=2`, and `{ event:name = "log" && event.ev = 1 } > { }` matched though no event has both. Checked: every differing trace has a span with ≥2 events/links |
| `tempo_negation_pushdown` (+`_metrics`) | Tempo defect | a lone negated condition returns nothing (`{ !(status = error) }`); checked: Tempo's answer ⊆ viz's |
| `tempo_typed_pushdown` | Tempo defect | Tempo's storage compares only values of the literal's type (`.n > 4.0` ignores int `n`), its evaluator compares by value (`.retries != 1.5` matched ints inside a structural query): the answer depends on Tempo's plan; viz always compares by value |
| `tempo_unscoped_nil` | Tempo defect | `.key = nil` matches when the key is missing from either span or resource (so spans that have it on the span) |
| `tempo_union_structural` (+`_metrics`) | Tempo defect | `&>>` etc. return only some left-hand spans (ancestors of one match out of six); checked: Tempo ⊆ viz |
| `tempo_metrics_intrinsic_arithmetic` | Tempo defect | metrics ignore filters with arithmetic on `duration`: `{ duration * 1 > 200ms } \| count_over_time()` counted 212 spans, `{ duration > 200ms }` 98 (Python recount: 98) |
| `tempo_sum_missing_value` | Tempo defect | `sum_over_time` restarts after a span lacking the attribute: buckets `[7, missing, 1]` → 1, `[3, missing]` → no sample (avg/min/max skip it) |
| `tempo_avg_negative_int` | Tempo defect | spanset `avg()` reads negative ints as unsigned 64-bit (2.635e18 where the mean is −285613) |
| `tempo_zero_span_ids` | Tempo defect | span ids returned as all zeros when `span:id` is in a disjunction |
| `tempo_after_select` | Tempo defect | stages after `select(…)` see the fields it did not name as missing: `{ } \| select(name) \| by(.foo)` put every span under `nil`, `{ } \| select(.n) \| { .foo = "bar" }` matched nothing |
| `tempo_regex_error` | Tempo defect | "unexpected numbers of pre-compiled regexp" on a valid query |
| `tempo_missing_trace_id` | Tempo defect | a result trace without `traceID` |
| `tempo_meta_missing` | Tempo defect | `rootTraceName`/`durationMs` empty after `coalesce()` |
| `infinite_average` | precision | ±Inf in a bucket: viz's exact sum gives ±Inf, Tempo's running mean NaN |

Echoed span attributes are compared separately. Keys only one side echoes are counted per
kind, not as differences (across the four runs: viz only 50,620 — viz echoes every field
the query reads; Tempo only `nil` 21,480 and other 1,952). Differing echoed values (2,967)
count as a difference; a case whose only differences are echoed values is classified only
when they are event or link fields (`echo_event_choice`).

### 3. Property tests

`tests/props.rs` (proptest; generated data and the query generator of the differential
run, 4–14 queries per case). `cargo test` runs 48 cases per property; the final run used
`PROPTEST_CASES=2000` (release build, 54 s): all six pass.

| Property | |
|---|---|
| `span_order_invariance`: shuffling traces and spans within traces changes no search or metrics JSON | pass |
| `pruning_on_off_identical`: `MemSource::pruning(true)` (trace predicate, span predicate, time window) gives byte-identical JSON | pass |
| `split_range_merge_equals_whole`: a range split at a step boundary gives the same samples as the whole (queries without `topk`/`bottomk` or arithmetic, whose zero-filled series differ by design; zero samples left out) | pass |
| `limits_cut_the_unlimited_answer`: `limit` and `spss` cut the unlimited answer; `matched` unchanged | pass |
| `token_soup_never_panics`: valid queries with tokens spliced in (`1e400`, `9223372036854775808`, unterminated strings, …) through parse, plan, search and metrics | pass |
| `query_pool_is_live`: >200 of 300 generated queries parse and >120 return data (the properties are not vacuous) | pass |

The properties found three order dependencies, all fixed: spansets after `by()` came out in
span order (now sorted); `min`/`max` of `0.0` and `-0.0`, and with NaN, kept the first seen
(now `-0.0` is the smaller and NaN never wins); spanset `sum()`/`avg()` used plain float
addition (now exact: i128 for integers, Shewchuk partials for floats, as metrics sums).

### 4. Mutation checks

`python3 -I tools/mutate.py <scratch>` copies the crate to a scratch directory, applies one
change at a time to the copy, runs `api`, `conformance` and `props` (48 cases), and removes
the copy. The source tree is never modified.

| # | Mutant | Caught by |
|---:|---|---|
| 1 | a missing attribute satisfies `!=` | api (`filters_compare_typed_values`, `regex_is_anchored_and_arrays_match_elements`) |
| 2 | regex not anchored | api (`regex_is_anchored_and_arrays_match_elements`) |
| 3 | unconnected spans take part in structural operators (right side) | api (`spanset_operators`) |
| 4 | child relation reversed | api (`spanset_operators`) |
| 5 | `>>` binds looser than `&&` and `\|\|` | api (`spanset_operators`) |
| 6 | `&&` binds tighter than `\|\|` inside filters | api (`and_or_share_one_precedence_level`) |
| 7 | metrics points by floor instead of ceil | api (`metrics_grid_counts_and_rates`, `metrics_values_and_labels`, `second_stages_and_arithmetic`) |
| 8 | a span starting exactly at `start` is counted | api (4 tests) |
| 9 | quantile interpolates from half the bucket bound | api (`quantiles_and_histograms_use_log2_buckets`) |
| 10 | `rate` does not divide by the step | api (`metrics_grid_counts_and_rates`) |
| 11 | `nil` group values kept as labels | api (`metrics_values_and_labels`) |
| 12 | an aggregate over no values passes `!=` | api (`pipelines_aggregates_by_coalesce_select`) |
| 13 | spansets left in evaluation order | props (`span_order_invariance`) |
| 14 | a negated structural operator prunes traces without left-hand matches | api (`plans_say_what_a_query_reads`), props (`pruning_on_off_identical`) |
| 15 | trace id printed with leading zeros | api (`search_json_has_tempo_shape`, `pipelines_aggregates_by_coalesce_select`) |
| 16 | unscoped attribute looks at the resource first | api (`intrinsics_and_scopes`) |

**16 of 16 caught** on the final run; the copy was restored and re-run green after each,
then deleted. The first run caught 13: mutant 3 then filtered the left side only, which is
an equivalent mutant (an unconnected span can relate only to unconnected spans, and the
right side is filtered), so it was moved to the right side; mutants 5 and 16 survived
because no test covered `>>` precedence or a key present on both span and resource, and
`spanset_operators` and `intrinsics_and_scopes` gained those cases. The conformance suite
caught none of these (it checks acceptance only).

### 5. WebAssembly

`cargo build --release --target wasm32-unknown-unknown` builds the crate (an `rlib`). To
measure it as a module, `tools/wasm-probe` (a `cdylib` with a C ABI: `viz_tq_alloc`,
`viz_tq_free`, `viz_tq_run`) was built with the profile of `engine/AGENTS.md` (fat LTO,
one codegen unit, `opt-level = 3`, `panic = "abort"`, stripped,
`RUSTFLAGS="-C target-feature=+simd128,+bulk-memory"`) and loaded by `tools/wasm-probe/check.mjs`
under Node 22:

| | |
|---|---:|
| `.wasm` | **1,284,736 B** (final build) |
| gzip -9 | **437,995 B** |
| imports | **0** (instantiates with `{}`) |
| exports | `memory`, `viz_tq_alloc`, `viz_tq_free`, `viz_tq_run` |
| `new WebAssembly.Instance(module, {})` | 0.34 ms and 2.2 ms (means of 200, two runs at load average 15–19) |
| linear memory after the run | 2 MiB |

The only dependency is `regex` (Unicode tables trimmed as in `viz-promql`); no
`wasm-bindgen`, `js-sys` or clock code is linked. The probe answered a search, a structural
search, two metrics queries, a parse error and an Unsupported query; its timings include
generating 2,000 spans inside the module and are not a benchmark.

### 6. Benchmark (native, measured here)

`cargo run --release --example bench -- 20000 5`: 20,000 generated traces, 207,894 spans in
a `MemSource`; median of 5 runs; single-threaded; **load average 18.9 → 17.9 on 4 cores**
(other builds running), so absolute numbers are pessimistic and noisy. Peak RSS 668 MB
(data held twice, for the pruning column). Scaled to stay under 1.5 GB.

| Query | ms, pruning off | Mspans/s |
|---|---:|---:|
| `{ resource.service.name = "db" && span.http.status_code >= 500 }` | 254 | 0.82 |
| `{ span.http.method = "GET" } && { status = error }` | 334 | 0.62 |
| `{ resource.service.name = "frontend" } >> { status = error }` | 294 | 0.71 |
| `{ } \| by(resource.service.name) \| count() > 3` | 388 | 0.54 |
| `{ name =~ "GET.*\|POST.*" && duration > 1s }` | 266 | 0.78 |
| `{ } \| rate() by (resource.service.name)` (600 s at 30 s) | 249 | 0.84 |
| `{ status = error } \| count_over_time() by (name)` | 127 | 1.64 |
| `{ } \| quantile_over_time(duration, 0.5, 0.99) by (resource.service.name)` | 266 | 0.78 |
| `{ } \| histogram_over_time(duration)` | 120 | 1.74 |
| `({ status = error } \| rate()) / ({ } \| rate())` | 145 | 1.44 |

`MemSource` with pruning on evaluates the plan's predicates itself (as storage would) and
copies the kept spans, so it is slower in memory (1.0–1.4 s here); the plan pays off when
storage evaluates it on row-group statistics and skips I/O, which is not measured here.

## Integration (not part of this crate; what it needs)

- **Storage reader** (`engine/storage`): Parquet writer and reader for `spans` and
  `trace_index` per `contracts/TRACES.md`; a `SpanSource` over files and tail batches that
  applies `ReadPlan` (columns for projection, predicates on row-group statistics and the
  `trace_id` bloom filter, `full_traces` → fetch every span of candidate traces by
  `trace_id`), and the merged `TraceSummary` from `trace_index`. Test it with pruning on and
  off and rows split between files and tail, as `engine/AGENTS.md` requires.
- **Ingest**: an OTLP traces decoder in `edge` and a span batch format in `BATCH.md`
  (`contracts/TRACES.md`, "Ingest batch").
- **WASM binding**: operations in `engine/wasm-query` (C ABI like `viz_q_*`): search,
  query_range/instant and plan, with spans passed as batches or files, typed errors
  (`bad_data` for Parse/Validation, `unsupported`, `execution`), limits per call.
- **Query Worker**: `/api/search`, `/api/metrics/query_range`, `/api/metrics/query` (Tempo's
  parameters: `q`, `limit`, `spss`, `start`/`end` in seconds, `step`, `since`); apply
  `align_request` to range queries as Tempo's frontend does; choose a default `step`;
  `/api/traces/<id>` and tag search are lookups in storage.
- **Split execution**: search splits by trace id hash (spans of a trace must meet); metrics
  without structural operators split by span and merge per point (sums and counts add;
  min/max; quantiles merge histograms; `topk` after merging).

## Known risks

- **Tempo compatibility is not equality.** Fourteen kinds of Tempo behaviour that viz does
  not reproduce are listed above; clients that depend on them (for example on
  `{ !(…) }` returning nothing) will see different answers. Where the documentation states
  the behaviour, viz follows the documentation.
- **12 unexplained differences remain** in the differential run (section 2, 12 of 3,600
  cases); they may be viz bugs.
- **Precedence of `&&`/`||`** follows Tempo's observed behaviour, which differs from most
  languages; a later Tempo release may change it.
- **Memory**: evaluation holds one trace at a time plus the search results and the metrics
  accumulators (series × points); `Limits` bounds series and points; nothing bounds span
  count per trace or result size beyond `limit`/`spss`.
- **Regex dialect**: Rust `regex`, not Go `regexp`; both are RE2-like.
- **Performance**: about 0.5–1.7 M spans/s single-threaded here under heavy load; not
  measured in a Worker.

## Contract issues

- `contracts/engine.ts` defines no TraceQL shapes ("TraceQL and LogQL result shapes are not
  defined yet"). The binding should return the JSON text of `to_json()` as `viz-promql`'s
  `queryRangeJson` does.
- `contracts/TRACES.md` is new and proposed; storage does not implement it.

## Layout

```
src/lexer.rs, parser.rs   lexer, parser, validation (hand-written recursive descent / precedence climbing)
src/ast.rs                syntax tree
src/value.rs              values, comparison and arithmetic rules
src/eval.rs               spanset pipelines, structural operators, aggregates, result keys
src/metrics.rs            metrics functions, time grid, second stages, arithmetic
src/plan.rs               read plans and predicates
src/data.rs               Span, Trace, TraceSummary, SpanSource, MemSource
src/json.rs               Tempo HTTP API JSON
tests/api.rs              behaviour on a hand-made trace set (Tempo's observed answers)
tests/conformance.rs      Tempo's example list as an oracle (fetched at test time)
tests/props.rs            properties; tests/common: data and query generators
tests/differential.rs     exporter for the differential run (ignored test)
tools/godiff/             Tempo black-box harness (AGPL, test-only; see its README)
tools/compare.py          comparison and classification
tools/probes/             the black-box probes behind the "observed" rules
tools/mutate.py           mutation checks on a scratch copy
tools/wasm-probe/         WASM size and load check
examples/bench.rs         benchmark
```

The crate has its own `[workspace]` table so that it builds standalone.
