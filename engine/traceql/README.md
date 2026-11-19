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
Its recursion and the trees it builds are bounded, so no query can exhaust the stack
("Limits" below; D40). Runtime dependencies: `engine/goregex` (viz's Go regex dialect, shared
with viz-logql) and `regex` (MIT/Apache-2.0).

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
| `nesting(query)` | How deep a query nests as `MAX_DEPTH` counts it (to measure real queries against the limit) |

## Implemented

Everything here is covered by `tests/api.rs` and the differential run unless noted.

- **Spanset filters** `{ … }` with `&&`, `||`, `!`, parentheses; comparisons `= != > >= < <=`,
  regex `=~ !~` (Go's dialect as Tempo uses it: ASCII `\w \d \s \b`, `\Q…\E`, octal escapes,
  Go's refusals; fully anchored, `.` matching a newline; translated by `engine/goregex`,
  section 8), arithmetic `+ - * / % ^`,
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
| empty arrays | neither `= nil` nor `!= nil`; no element compares | `{ span.ea != nil }` and `{ span.ea = nil && name = "query" }` both empty |
| NaN | unequal to every number; skipped by `sum/avg/min/max_over_time` | `{ span.r != 1.5 }` matched r = NaN; `avg_over_time` over `[1.5, NaN, 2.5]` is 2 |
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
| `=~`, `!~` | Go's `regexp` dialect, anchored on the parsed pattern with `.` matching `\n`: `\w \d \s \b` ASCII, `(?i)` simple case folding, `\Q…\E` (unterminated: literal to the end), octal, `\<` literal, `x{,5}` literal, counts above 1000 refused | 289 patterns on 70 subjects (`testdata/regex_dialect.json`, section 8); `a.b` matched `a\nb`, `a\|ab` matched `ab`, `\Qa)` matched `a)` |

### Limits: refused with an error, never a crash

A stack overflow is not an error a caller can handle: natively it aborts the process, in
WebAssembly it traps the instance. Every recursive pass (parser, validation, conversion,
planning, evaluation, dropping the tree) recurses over the query's syntax tree, so `parse`
bounds that tree and nothing else needs a guard. A query past a limit gets
`Error::Validation` with a position.

| Limit | Value | What counts |
|---|---|---|
| `MAX_QUERY_BYTES` | 128 KiB | query text |
| `MAX_DEPTH`, parser recursion | 100 | counted on the way down: braces, unary operators, the right side of `^`, each precedence level entered, parentheses two levels each |
| `MAX_DEPTH`, tree height | 100 | counted on the way up: a chain `a && b && c`, `x + y + z` or `{ } >> { } >> { }` is parsed by a loop but builds a tree one level deeper per operator |
| `REGEX_NEST_LIMIT` | 64 | nesting in the translated pattern as the regex parser counts it (each group, repetition, alternation, concatenation, bracketed class; a Go `\d` or `\b` becomes a class or group, one level); the regex compiler recurses over it |
| `REGEX_SIZE_LIMIT` | 1 MiB per regex | compiled size (`.{1000}` fits, four of them do not; Go's own bound of 1000 per count applies first) |
| `REGEX_DFA_SIZE_LIMIT` | 256 KiB per regex | lazy-DFA cache |
| `MAX_REGEXES` | 16 per query | with the two above, at most about 26 MiB of a 128 MB isolate (measured: a regex at the size limit holds about 1.3 MiB) |

In practice: 48 nested parentheses, 97 operators in one chain, about 95 unary operators.
`tests/common/shapes.rs` lists 25 shapes with the exact largest accepted `n`. Long flat
queries are not nesting: 5,000 pipeline stages, `topk` stages, `by` fields, quantiles or
hints run. How this was verified is in Verification, section 7.

The bound is 100, as viz-logql's and `engine/query`'s for PromQL (D40; it was 200). Measured
with `nesting()`: Tempo's 284 examples that parse nest at most 10 levels and the 3,600
generated differential queries at most 12, so 100 refuses nothing seen, with 8 times the
headroom of the deepest; it halves the stack a query at the limit needs (section 7).

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
- Queries past the limits above: nesting deeper than 100 levels, more than 16 regexes, a
  regex nested deeper than 64 levels or compiling to more than 1 MiB. Tempo (Go, growable
  stacks) accepts them; viz refuses them with `Error::Validation` rather than risk the
  isolate.
- Unicode classes in regexes (`\pL`, `\p{Greek}`, `\P…`): `Error::Unsupported`. Tempo
  supports them (`\p{Greek}+` matched the Greek subjects); Go's and Rust's names and script
  semantics differ (`engine/goregex/README.md`), so viz refuses rather than answer differently.

## Verification

Measured here: Linux x86-64, 4 cores and 16 GB shared with other builds (load average
9–19 during these runs), rustc 1.97.0, Go toolchain 1.27.3 (fetched), Node 22.23. Not on
Cloudflare. `CARGO_TARGET_DIR` was outside the repository.

**What `cargo test -j 2` runs** (as CI does, `deploy/ci/matrix.mjs`): offline, with no Go
and no network: `tests/api.rs` (14 tests), `tests/props.rs` (6 properties, 48 cases each),
`tests/limits.rs` (4 tests and 2 properties, section 7), `tests/regex_dialect.rs` (1 test:
289 patterns against Tempo's recorded answers, section 8), `tests/conformance.rs` (prints
`SKIPPED: … not found` and passes when the Tempo list has not been fetched), and the
differential exporter, which is `#[ignore]`d. Nothing in the default run needs Tempo, its
corpus or Go. Verified on the final code of 2026-11-19 (regex dialect and `MAX_DEPTH` 100
included) with `testdata/upstream/` moved away, Go removed from `PATH` and
`cargo test -j 2 --offline`: api 14 passed, props 6 passed, limits 6 passed, regex_dialect 1
passed, conformance 1 passed (skips), differential 1 ignored, exit 0, no warnings (10 s with a
warm build directory). The checks that do need them are explicit commands:

| Check | Command (from `engine/traceql`) | Needs |
|---|---|---|
| Conformance against Tempo's example list | `tools/fetch_tempo_tests.sh && cargo test --test conformance -- --nocapture` | network (raw.githubusercontent.com); the file lands in git-ignored `testdata/upstream/` |
| Differential run against Tempo | the commands in `tools/godiff/README.md` | Go and the Go module proxy (fetches Tempo v3.1.1 and toolchain go1.27.3, about 1.1 GB, outside the repository) |
| Black-box probes | `VIZ_TQ_WORK=$SCRATCH python3 -I tools/probes/probe.py <queries.txt> [search\|range\|instant]` | the godiff binary in `$SCRATCH/bin` |
| Regex probes against Tempo (re-record the answers `tests/regex_dialect.rs` checks) | `VIZ_TQ_WORK=$SCRATCH python3 -I tools/probes/regex_dialect.py testdata/regex_dialect.json [--record]` | the godiff binary in `$SCRATCH/bin` |
| The regex translator against Go's `regexp` | `engine/goregex/README.md` | Go (standard library only) |
| Long property run | `PROPTEST_CASES=2000 cargo test --release --test props` (and `--test limits`) | |
| Mutation checks | `python3 -I tools/mutate.py $SCRATCH` (copies the crate; never edits it) | |
| WASM size, load and limits | `tools/wasm-probe`: `cargo build --release --target wasm32-unknown-unknown` with the flags below, then `node check.mjs <module>` (exits non-zero on imports or any limit failure; add `node --stack-size=128` and `-C link-arg=-zstack-size=131072` for the margin check) | Node, the `wasm32-unknown-unknown` target |
| Benchmark | `cargo run --release --example bench -- 20000 5` | |

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
Without the fetched file the test prints `SKIPPED` and passes. Unchanged after the regex and
nesting changes of 2026-11-19 (same table). The test also prints how deep the examples nest
as `MAX_DEPTH` counts it (`nesting()`): of the 284 that parse, the deepest is 10 levels
(`{ !("test" != .c || ((true && .b) || 3 < .a)) }`), and all 284 are at 10 or less.

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

Four final runs on the final code:

| Run | Seed | Queries | Data sets | Cases | Agree | Both reject | Classified | **Unexplained** |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| A | 1 | one feature per query | 10 | 600 | 381 | 79 | 140 | **0** |
| B | 2 | nested (operators, pipelines, arithmetic combined) | 10 | 600 | 386 | 86 | 128 | **0** |
| C | 3 | one feature per query | 20 | 1,200 | 743 | 145 | 312 | **0** |
| D | 4 | nested | 20 | 1,200 | 715 | 185 | 300 | **0** |
| **total** | | | 60 | **3,600** | **2,225** | **495** | **880** | **0** |

Every one of viz's 3,105 JSON answers decoded strictly into Tempo's `SearchResponse` /
`QueryRangeResponse` protobuf types (unknown fields rejected); none failed.

Classified differences, by rule (all four runs): `ambiguous_root` 264 (+1 metrics),
`event_link_values` 119 (+53 metrics), `tempo_negation_pushdown` 94 (+13 metrics),
`tempo_typed_pushdown` 62, `tempo_unscoped_nil` 59, `unrooted_structure` 51 (+18 metrics),
`tempo_union_structural` 41 (+2 metrics), `tempo_sum_missing_value` 33,
`tempo_metrics_intrinsic_arithmetic` 22, `tempo_after_select` 15, `tempo_avg_negative_int` 9,
`tempo_field_read_under_condition` 8, `tempo_regex_error` 4, `infinite_average` 3,
`tempo_bare_bool_or` 3, `tempo_meta_missing` 3, `tempo_zero_span_ids` 1,
`tempo_missing_trace_id` 1, `tempo_nil_ne_missing` 1. (A case counts under the first rule
that explains it, in the order of `tools/compare.py`.)

An earlier pass of these four runs left 12 cases unexplained. Each was settled by a probe
(`tools/probes/`, Tempo on a small hand-made data set):

| Case | Cause | Settled by |
|---|---|---|
| C 368, C 772 | Tempo treats an empty array as neither `= nil` nor `!= nil`; viz treated it as present | **viz fixed** (`nil_test`); regression asserts in `regex_is_anchored_and_arrays_match_elements` |
| D 1103 | Tempo's `avg_over_time` (and `min/max`) skip NaN values; viz propagated NaN | **viz fixed**: sums and averages skip NaN; regression asserts in `metrics_values_and_labels` |
| B 320, B 542, C 677, D 911 | Tempo reads a field used by `by()` or the metrics function only where a filter condition on it held (`{ .n > 0 } \|\| { duration < 0 } \| histogram_over_time(duration)` returned nothing) | rule `tempo_field_read_under_condition` |
| B 350, D 828, D 1143 | a bare boolean attribute in `\|\|` requires the attribute to exist in Tempo | rule `tempo_bare_bool_or` |
| D 595 | a missing attribute satisfies `!=` in Tempo when the same filter also tests it against `nil` | rule `tempo_nil_ne_missing` |
| C 593 | an infinite average (viz) is NaN in Tempo and shifts which series `bottomk` keeps | rule `infinite_average`, extended to `topk`/`bottomk` at those points |

**Re-run on 2026-11-19, after the regex dialect and the nesting bound changed** (Tempo v3.1.1
rebuilt in scratch): viz's four case files are byte-identical to those of the code before the
change (exported from a scratch copy with the old regex compilation), and the comparison gives
the table above exactly (2,225 / 495 / 880 / **0** unexplained; 3,105 answers decoded by
Tempo's types). 479 of the 3,600 cases use `=~` or `!~`, but the generated data are ASCII and
the generated patterns simple (`x.*`, `a|b`), so the dialect cannot change their answers;
section 8 tests the dialect. The exporter prints the deepest nesting of the generated
queries: 10, 12, 10 and 11 levels for runs A to D.

To reproduce: the commands in `tools/godiff/README.md` with `VIZ_DIFF_SEED=1..4`,
`VIZ_DIFF_DEPTH=0` (A, C) or `1` (B, D), `VIZ_DIFF_DATASETS=10` (A, B) or `20` (C, D),
`VIZ_DIFF_QUERIES=60`; `tools/compare.py --show N` prints any unexplained case.

**viz bugs found by the differential run and fixed** (each has a test in `tests/api.rs`):
a missing attribute satisfied `!=`; an aggregate over no values satisfied `!=`; `NaN != x`
was false; metrics points were offsets from `start` instead of multiples of the step;
`nil` grouping values were kept in labels; quantile interpolation started at half the
bucket bound instead of the previous bucket; `2^53+1` was bucketed above `2^53`; result
keys used `span:kind` instead of `kind`; `&&` bound tighter than `||` in filters and
structural operators bound as loosely as `&&`/`||`; spanset operators accepted a wrapped
pipeline next to a plain filter; quantile series without countable values were returned;
an empty array satisfied `!= nil`; NaN values poisoned `sum/avg_over_time`.
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
| `infinite_average` | Tempo defect | ±Inf in a bucket: viz's exact sum gives ±Inf for `avg_over_time`; Tempo's running mean depends on order (`[inf, 3]` → no sample, `[3, inf]` → Inf), which can also change what `topk`/`bottomk` keep |
| `tempo_field_read_under_condition` | Tempo defect | a field used by `by()` or the metrics function is read only where a filter condition on that field held: `{ name != "zzz" \|\| span.n > 4 } \| count_over_time() by (span.n)` grouped n = 1..4 under `nil`; with `\|\| status = ok` and an attribute-reading function, error spans lost `status` |
| `tempo_bare_bool_or` | Tempo defect | `{ instrumentation:version = "1.0" \|\| .b }` matched only spans that have `b`; `... \|\| .b = true` matched every 1.0 span |
| `tempo_nil_ne_missing` | Tempo defect | `{ (name = "zzz" \|\| span.foo = nil) && span.foo != "bar" }` matched spans without `foo`; `{ name = "query" && span.foo != "bar" }` did not |

Echoed span attributes are compared separately. Keys only one side echoes are counted per
kind, not as differences (across the four runs: viz only 50,620 — viz echoes every field
the query reads; Tempo only `nil` 21,480 and other 1,952). Differing echoed values (2,967)
count as a difference; a case whose only differences are echoed values is classified only
when they are event or link fields (`echo_event_choice`).

### 3. Property tests

`tests/props.rs` (proptest; generated data and the query generator of the differential
run, 4–14 queries per case). `cargo test` runs 48 cases per property; the final run used
`PROPTEST_CASES=2000` (release build; 36.5 s of tests, 74 s with compilation, load average
about 10, after the last fixes): all six pass. Again after the limits were added, with
`tests/limits.rs`: props 6 pass (21.9 s), limits 6 pass (7.2 s), 102 s with compilation at
load average 5–7.

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

`python3 -I tools/mutate.py <scratch> [--only N,…]` copies the crate, and `engine/goregex`
next to it, to a scratch directory, applies one change at a time to the copies, runs `api`,
`regex_dialect`, `conformance`, `props` and `limits` (48 cases per property), plus the
regex crate's own tests (`goregex`) for mutants of that crate, and removes the copies. The
source tree is never modified. A suite that dies of a stack overflow is reported as
"aborted"; that is how a missing limit shows.

| # | Mutant | Caught by |
|---:|---|---|
| 1 | a missing attribute satisfies `!=` | api (`filters_compare_typed_values`, `regex_is_anchored_and_arrays_match_elements`) |
| 2 | regex not anchored (`Wrap::DotNl` instead of `Wrap::Anchored`) | api (`regex_is_anchored_and_arrays_match_elements`), regex_dialect, limits |
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
| 17 | tree height not bounded (chains build trees of any height) | limits (aborted: stack overflow) |
| 18 | tree-height bound off by one (`> MAX_DEPTH + 1`) | limits (`each_shape_runs_at_its_limit_and_is_refused_one_past_it`) |
| 19 | parser recursion not bounded | api (aborted), limits (aborted: stack overflow) |
| 20 | unary minus before a spanset or number recurses uncounted (the defect found) | limits (aborted: stack overflow) |
| 21 | field parentheses count one level, not two | limits (`each_shape_runs_at_its_limit_and_is_refused_one_past_it`) |
| 22 | regex nesting at the regex crate's default (250) | limits (`regexes_are_bounded_in_nesting_size_and_number`) |
| 23 | regex size at the regex crate's default (10 MiB) | limits (`regexes_are_bounded_in_nesting_size_and_number`) |
| 24 | regexes per query not counted | limits (`regexes_are_bounded_in_nesting_size_and_number`) |
| 25 | nesting limit loosened back to 200 | limits (`each_shape_runs_at_its_limit_and_is_refused_one_past_it`) |
| 26 | Unicode classes back on: the pattern compiled untranslated, as before | regex_dialect (`regexes_answer_as_tempo_does`), limits |
| 27 | Unicode classes back on: `\d \w \s` passed to Rust as written (in `engine/goregex`) | regex_dialect, goregex (`ascii_classes`, `named_groups`) |
| 28 | Unicode word boundary (`\b` passed as written) | regex_dialect, goregex (`ascii_classes`) |
| 29 | Go's bound on nested counted repetitions dropped | regex_dialect, goregex (`counted_repetitions_follow_gos_bound`) |
| 30 | a `{` that starts no repetition is an error, not a literal | regex_dialect, goregex (`go_only_escapes_and_literals`) |
| 31 | an unmatched `)` passed through | **not caught** (equivalent, below) |
| 32 | parentheses not balanced at all (unmatched `)` passed, unclosed `(` allowed) | regex_dialect, goregex (`what_go_refuses_is_refused`) |

**31 of 32 caught** on the final run of 2026-11-19 (final code: regex dialect, `MAX_DEPTH`
100); the copies were restored and re-run green after each, then deleted. Mutants 1–24 are
the earlier ones, re-run; 2, 17, 18, 22 and 23 were re-targeted where the code they change
moved (anchoring is now `Wrap::Anchored`; the regex limits are a `Limits` value; the
tree-height check gained the `nesting()` measurement line). Mutant 31 survives because it is
equivalent: an unmatched `)` can only be rebalanced by the anchoring wrapper if an unclosed
`(` follows it, and the translator refuses that separately (or Rust refuses the result), so
removing one of the two checks changes no answer; mutant 32 removes both and is caught. Mutant
4 is also caught by `regex_dialect` (its structural form). Mutant 2 is also caught
by `limits`. The lazy-DFA cache limit has no mutant: it bounds memory and has no observable
output to test. The first run of mutants 1–16 caught 13: mutant 3 then filtered the left side only, which is
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
| `.wasm` | **1,275,756 B** (2026-11-19, with `engine/goregex` and `MAX_DEPTH` 100; 1,284,354 B before) |
| gzip -9 (Node `zlib`, as `check.mjs` reports) | **428,833 B** (436,541 B before) |
| imports | **0** (instantiates with `{}`) |
| exports | `memory`, `viz_tq_alloc`, `viz_tq_free`, `viz_tq_run` |
| `new WebAssembly.Instance(module, {})` | 0.33 and 0.51 ms in two runs of the 2026-11-19 build at load average about 10; before, 0.23 ms at load average 5.5, 0.24–0.34 ms and 2.2 ms at 8–19 (means of 200) |
| linear memory (peak; it never shrinks) | 2.0 MiB after the six queries below; 18 MiB after all the limit checks of section 7 (128 KiB queries, 16 regexes) |

The dependencies are `engine/goregex` and `regex` with `std`, `perf` and `unicode-case`
only: Go's `\w \d \s` are ASCII, so the Unicode Perl-class tables are no longer linked (the
module is 8.6 KB smaller net, with the translator in); no `wasm-bindgen`, `js-sys` or clock
code is linked. The probe answered a search, a structural
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

### 7. Nesting and regex limits

**The defect, shown before fixing it.** On a scratch copy of the previous code (debug
build, 8 MiB main thread), `parse` aborted with `stack overflow` on `- - - … { }` (20,000
signs, 40 KB) and on 15,000-term `&&`, `>>` and `+` chains (under 128 KiB). Parentheses
and `!` were already refused at 200 levels. Unary minus before a spanset or number recursed
without being counted, and operator chains are parsed by loops that the recursion counter
never saw, but that build trees every later pass recurses over.

**Tests** (`tests/limits.rs`, shapes in `tests/common/shapes.rs`). Every query runs on a
thread with a bounded stack (4 MiB in the debug build, 512 KiB in release) through `parse`,
`plan`, `search`, `matching_spansets`, `query_range`, `query_instant` and the JSON writers.
An overflow aborts the test binary, so a regression cannot pass quietly.

| Test | Checks |
|---|---|
| `each_shape_runs_at_its_limit_and_is_refused_one_past_it` | 25 nesting shapes (field parentheses, `!`, unary minus, `&&` `\|\|` `+` `*` `^` and comparison chains, spanset parentheses and chains, `>>` chains, nested `>`, nested pipelines, metrics parentheses, `+` chains and unary minus, thresholds, scalar-filter constants, aggregate, `by()` and metrics arguments, a 64-level regex inside parentheses): the largest accepted `n` equals the recorded one, that query evaluates, `n + 1` gets the depth error |
| `far_past_the_limit_is_refused_not_crashed` | each shape repeated to fill 128 KiB (up to 65,000 levels): the depth error |
| `long_flat_queries_are_not_nesting` | 5 flat shapes repeated 5,000 times run |
| `regexes_are_bounded_in_nesting_size_and_number` | 64-level pattern accepted, 65 refused, 65,000 refused; `.{1000}` accepted and four of them (which compile under the regex crate's default 10 MiB) refused for size; `x{100000}` refused by Go's count bound; 16 regexes run, 17 refused |
| `random_deep_nesting_never_crashes` (property) | random stacks of 7 field, 7 spanset and 4 metrics wrappers, 0 to 3,000 deep each: accepted queries evaluate, the rest get Parse, Validation or Unsupported. In a run of 300 cases at `MAX_DEPTH` 100, 132 were accepted and evaluated and 168 refused for depth |
| `repeated_token_soup_never_crashes` (property) | a random 1–3 token unit from 28 tokens (unbalanced brackets, operators, strings, calls) repeated up to 30,000 times: no crash, no evaluation error |

**Stack needed at the limit** (measured here: the smallest thread stack, found by bisection
in 1 KiB steps, on which the at-limit query runs through every entry point; a scratch
program running each attempt in its own process, built with this crate's profiles):

| Shape at its limit | `MAX_DEPTH` 100: debug | release | `MAX_DEPTH` 200 (before): debug | release |
|---|---:|---:|---:|---:|
| `rate() + rate() + …` (99 terms; 199 before) | 1,320 KiB | 144 KiB | 2,621 KiB | 278 KiB |
| field parentheses around a 64-level regex (48; 98) | 945 KiB | 133 KiB | 1,597 KiB | 224 KiB |
| spanset parentheses (48; 98) | 772 KiB | 114 KiB | 1,526 KiB | 219 KiB |
| field parentheses (48; 98) | 675 KiB | 103 KiB | 1,328 KiB | 195 KiB |
| spanset `&&` chain (97 terms; 197) | 515 KiB | 68 KiB | 1,016 KiB | 129 KiB |
| field `&&` chain (97 terms; 197) | 242 KiB | 31 KiB | 462 KiB | 52 KiB |

Halving the bound about halved the stack, except where the regex compiler's own recursion
(the 64-level pattern, unchanged) dominates. Field parentheses first needed 638 KiB in
release at 197 levels. Two changes brought them down: error construction, regex compilation
and function-call parsing were moved out of the recursive functions (`#[inline(never)]`,
379 KiB), and a parenthesis now counts two levels, as spanset parentheses already did
(195 KiB at 98).

**In WebAssembly** (`tools/wasm-probe/check.mjs`, Node 22, release module). Every shape at
its limit runs, one past it and filled to 128 KiB gets the depth error, and the flat
shapes and regex limits behave as natively. At `MAX_DEPTH` 100 there are 0 traps with V8's
stack cut to 96 KB (`node --stack-size=96`) and the module's own stack linked at 128 KiB
(`-C link-arg=-zstack-size=131072`), both at once; at 200 the regex-in-parentheses shape
trapped at 96 KB. It still traps at 64 KB of V8's stack (`RangeError`) or a 64 KiB module
stack (`memory access out of bounds`), the only shape that does. The defaults are about 984 KB
and 1 MiB, so the margin is at least 8× (10× for V8's). A shadow-stack overflow traps (the
stack is placed first in memory), it does not corrupt data.

**Nothing else changed.** The four differential exports (A–D, 3,600 cases, 530 regex
matches) were produced by the code before and after this change: viz's answers are
byte-identical, so the comparison with Tempo (0 unexplained) still holds. Tempo's example
list gives the same table (282 accepted, 0 failures). The same held again when the bound went
from 200 to 100 (section 2).

### 8. Regex dialect against Tempo (black box)

`tools/probes/regex_dialect.py` builds one trace, a root and 70 child spans, each holding one
subject string as `span.s` (ASCII, Latin, Greek, Arabic-Indic digits, CJK, the Kelvin sign,
long s, ß and ẞ, final sigma, the Ohm sign, titlecase digraphs, dotted and dotless i, control
characters, NBSP, em space, U+FFFD, 1,000 `x`). It runs 289 patterns through Tempo v3.1.1
(`tools/godiff`) in four forms: `{ span.s =~ P }`, `{ span.s =~ P || span.zz = 1 }`,
`{ name = "root" } > { span.s =~ P }` and `{ span.s !~ P }`, with `P` as a backtick string.
All four forms agreed on every pattern, so Tempo's storage-side and evaluator-side matching
are the same. The answers are recorded in `testdata/regex_dialect.json`;
`tests/regex_dialect.rs` runs the same forms through viz (and a search with pruning on) and
requires Tempo's answer. What Tempo does, and what changed:

| Case | Tempo v3.1.1 (observed) | viz before | viz now |
|---|---|---|---|
| `\w \d \s \b` and their negations | ASCII-only: `\w+` does not match `é`, `日本` or the Kelvin sign; `\d` does not match `١`; `\s` is space, `\t \n \f \r` (not `\v`, NBSP, em space); `.*\bfoo\b.*` matches `éfooé` | Unicode-aware: matched all of those | as Tempo |
| `(?i)` | simple case folding: `k K` and the Kelvin sign; `s S ſ`; `ß ẞ`; `σ ς Σ`; `ω` and the Ohm sign; `ǅ ǆ Ǆ`; `i I` but not `İ ı`; `(?i)\w` includes the Kelvin sign and `ſ`, `(?i)\W` excludes them; a flag lasts across later alternatives (`a(?i)b\|c` matches `C`) | the same folding, applied to Unicode classes | as Tempo |
| anchoring | full, with `.` matching `\n` (`ab`, `bc`, `b` do not match `abc`; `a.b` matches `a\nb`, `(?-s:a.b)` does not), on the parsed pattern: `a\|ab` matches `ab`, `\Qa)` matches `a)`, `a)\|(b` is refused | `^(?s:…)$` around the text: `a)\|(b` was accepted and became `^a` or `b$` | as Tempo |
| Go-only syntax | `\Q…\E`; octal `\101`, `\0`, `\17` (`\08` is NUL then `8`); `\<a\>` is literal; `x{,5}`, `x{01}`, `a{`, `{` are literal; `a\b{start}` is a boundary then `{start}`; `[a&&b]`, `[a~~b]`, `[[a]` have literal members; `(?ii)`, `(?i-i)` (clears), `(?)`; `a(?i)*` repeats `a`; `^*`; `\x{D800}` matches U+FFFD | refused, or matched differently (`\<`, `\b{start}`, `&&`, `~~`) | as Tempo |
| what Go refuses | `\1`, `\8`, `\18`, `\u` and `\U` escapes, `\e`, `\Z`, `\cA`, `\N`, `\C`, `(?x)`, `(?u)`, `(?i-)`, `x**`, `x{2}{3}`, `x*??`, `a++`, `x{1001}`, `(?:a{10}){101}`, `(?:a{2,}){600}`, `[\b]`, `[\Q]\E]`, `[a-\d]`, `[[:foo:]]`, `(?P<a.b>x)`, `(?'n'x)`, `a)(b` are refused | most were accepted | refused |
| Unicode classes | supported: `\pL`, `\p{Greek}`, `\PL`, `\pN`, `\pZ` (`\p{greek}` is an error, raised by Tempo's storage rather than its parser) | a compile error in the release build (no Unicode tables), Rust's semantics in test builds (their dev-dependencies enable the tables) | `Error::Unsupported` (`engine/goregex/README.md`) |

Against the recorded answers, the code before this change (a scratch copy with the old regex
compilation) gave a different answer for 98 of the 278 patterns other than Unicode classes:
28 matched different subjects, 37 were refused where Tempo accepts and 33 accepted where Tempo
refuses. It now gives Tempo's answer for all 278 (207 accepted, 71 refused), and the 11
Unicode-class patterns are Unsupported. The translator is also checked against Go's
own `regexp` on 100,000 generated patterns (`engine/goregex/README.md`: 0 differences, apart
from surrogate escapes, on which Go itself is inconsistent).

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

- **Tempo compatibility is not equality.** Seventeen kinds of Tempo behaviour that viz does
  not reproduce are listed above; clients that depend on them (for example on
  `{ !(…) }` returning nothing) will see different answers. Where the documentation states
  the behaviour, viz follows the documentation.
- **Precedence of `&&`/`||`** follows Tempo's observed behaviour, which differs from most
  languages; a later Tempo release may change it.
- **Memory**: evaluation holds one trace at a time plus the search results and the metrics
  accumulators (series × points); `Limits` bounds series and points; nothing bounds span
  count per trace or result size beyond `limit`/`spss`.
- **Regex dialect**: Go's, checked against Tempo on 289 patterns (section 8) and the
  translator against Go's `regexp` on 100,000. Not covered: Unicode classes (refused; Tempo
  accepts them), surrogate escapes (Go's own answer depends on the pattern's shape; viz
  applies one rule), and case folding of characters assigned between Unicode 15.0 (Go 1.24's
  tables) and 16.0 (`regex-syntax` 0.8.12's).
- **Stack in Workers**: the limits leave at least 8× headroom on the module's 1 MiB stack and
  10× on Node's default V8 stack. The stack size of a Workers isolate was not measured.
- **Work per query**: a query within the limits can still be expensive. Each metrics
  function in an arithmetic expression scans the source once, and parentheses allow
  thousands of them in 128 KiB. Structural operators cost about |left| × |right| × depth
  per trace. Nothing bounds CPU time; the caller's deadline must.
- **Lazy-DFA cache** of 256 KiB per regex (the regex crate's default is 2 MiB, read from its
  source): ordinary patterns fit, but a pathological one may fall back to slower matching.
  Not measured.
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
tests/limits.rs           nesting and regex limits; tests/common/shapes.rs: the nesting shapes
tests/regex_dialect.rs    regexes against Tempo's recorded answers (testdata/regex_dialect.json)
tests/differential.rs     exporter for the differential run (ignored test)
tools/godiff/             Tempo black-box harness (AGPL, test-only; see its README)
tools/compare.py          comparison and classification
tools/probes/             the black-box probes behind the "observed" rules (regex_dialect.py: section 8)
tools/mutate.py           mutation checks on a scratch copy
tools/wasm-probe/         WASM size, load and limits check
examples/bench.rs         benchmark
```

The crate has its own `[workspace]` table so that it builds standalone.
