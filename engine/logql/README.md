# viz-logql

A LogQL engine as a Rust library: it parses, validates, plans and evaluates log queries and
metric queries. No I/O, no async, no clock, no randomness: the same code runs natively, as
WASM in a Worker, and in a deterministic simulator. Written clean-room from Loki's
documentation and black-box observation of Loki v3.7.10 (`CLEANROOM.md`); Loki itself is
AGPL-3.0 and nothing of it is in this crate.

Semantics follow Grafana Loki **v3.7.10**, checked three ways: Loki's own test tables used as
a behavioural oracle, a differential run against Loki's engine on generated data, and
property tests.

```rust
use viz_logql::{query_range, LogRow, LogStream, MemSource, Options};

let src = MemSource::new(vec![LogStream {
    labels: vec![("app".into(), "web".into())],          // stream labels
    rows: vec![LogRow { ts_ns: 1_000_000_000, line: "level=error msg=boom".into(), metadata: vec![] }],
}]);
let r = query_range(&src, r#"sum by (level) (count_over_time({app="web"} | logfmt [1m]))"#,
                    1_000_000_000, 61_000_000_000, 60_000_000_000, &Options::default())?;
r.data_json();   // {"resultType":"matrix","result":[...],"stats":{...}}: Loki's HTTP API `data`
```

## Public API

| Item | Purpose |
|---|---|
| `query_range(source, query, start_ns, end_ns, step_ns, &Options) -> QueryResult` | `/loki/api/v1/query_range`. Log queries return entries with `start <= ts < end`, at most `limit`, in `direction`; metric queries are evaluated at `start`, `start + step`, … `<= end`. |
| `query_instant(source, query, time_ns, &Options)` | `/loki/api/v1/query`. Metric queries only (a log query is refused, as Loki's HTTP API does). |
| `selectors(query, start_ns, end_ns, step_ns) -> Vec<SelectorInfo>` | What each selector reads: matchers, the half-open nanosecond range (range, `offset` and step grid applied), `required` literal clauses for pruning (`contracts/LOGS.md` §6), and the line filters that run before any stage that rewrites the line. Exactly the `SelectRequest`s evaluation makes, in order (property-tested). |
| `parse(query) -> Expr` | Parse and validate. |
| `trait LogSource { fn select(&self, &SelectRequest, visit) }` | The read seam (`contracts/LOGS.md` §7): rows are pushed to a visitor, so storage can stream row groups. Contract in the trait's doc comment. |
| `MemSource` | In-memory source; `prune = true` makes it skip rows that fail `required`, as a token filter would. |
| `Options` | `limit` (default 100), `direction` (default backward), `max_steps` (11 000), `max_series` (500 000), `now_ns` (the caller's clock, for the `now` template function). |
| `QueryResult { data: Data, stats: Stats }`, `data_json()`, `response_json()`, `error_json(&Error)` | Loki's HTTP API JSON: `streams` (`[["<ns>","line"]]`), `matrix`, `vector`, `scalar` (`[<seconds>,"<value>"]`), and a `stats` object in the documented shape (lines and bytes read, entries after the pipeline, returned; times are the caller's to fill). |
| `Error::{Parse{msg,line,col}, Unsupported, Eval, Limit, Source}`, `error_type()` | `bad_data`, `unsupported`, `execution`, `internal`. Parse errors carry line and column. |

## Implemented

- **Stream selectors** `=`, `!=`, `=~`, `!~` (regexes fully anchored, `.` matches newline),
  with Loki's rule that a selector needs one matcher that does not match the empty string.
- **Line filters** `|=`, `!=`, `|~`, `!~` (unanchored, `.` matches newline), the pattern
  filters `|>` / `!>`, `ip("…")` with `|=` / `!=` (single address, range, CIDR, IPv4 and
  IPv6), and `or` chains (`|= "a" or "b"`; `!= "a" or "b"` keeps lines containing neither).
- **Parsers**: `json` (flattening with `_`, arrays and nulls skipped, numbers as written,
  members before a syntax error kept, Loki's `__error_details__` wording for the malformed
  shapes observed), `json name="path", other` (field and index access; objects and arrays as
  text; absent keys as empty labels), `logfmt` with `--strict`, `--keep-empty` and parameters,
  `regexp` (named groups), `pattern` (anchored, `<_>`), `unpack` (`_entry`). Extracted keys
  are sanitised (non `[A-Za-z0-9_]` to `_`, a leading digit prefixed with `_`); a key that is
  already a stream label or structured metadata becomes `<key>_extracted`; a repeated key
  keeps its first value.
- **Label filters** on strings (`=`, `!=`, `=~`, `!~`), numbers, durations (Go syntax plus
  `d`, `w`, `y`), byte sizes (`KB`, `KiB`, …), `ip()`, combined with `and`, `or`, `,`, a
  space, and parentheses (left to right). A value that does not convert keeps the line and
  sets `__error__="LabelFilterErr"` with Go's message; an absent label fails the predicate.
- **`line_format`, `label_format`** (rename and template forms) with a Go `text/template`
  subset (below), **`drop`, `keep`** (names and matchers; `keep` keeps the error labels),
  **`decolorize`** (CSI, OSC and character-set escapes), and **`__error__` / `__error_details__`**
  (the first error wins; within a run of label filters, `__error__` filters run last; line
  filters after `decolorize` see the line before it, as observed in Loki).
- **Structured metadata** (`LogRow.metadata`): visible to label filters, `drop`/`keep` and
  templates, and part of the result labels.
- **Log range aggregations**: `rate`, `count_over_time`, `bytes_rate`, `bytes_over_time`,
  `absent_over_time` (labels from the selector's equality matchers). Windows are
  `(t - range - offset, t - offset]`.
- **Unwrapped range aggregations**: `rate`, `rate_counter`, `sum_over_time`, `avg_over_time`,
  `min_over_time`, `max_over_time`, `stddev_over_time`, `stdvar_over_time`,
  `quantile_over_time`, `first_over_time`, `last_over_time`, `absent_over_time`;
  `unwrap label`, `unwrap duration(label)` / `duration_seconds(label)`, `unwrap bytes(label)`,
  label filters after `unwrap`; `by` / `without` where Loki allows them. The unwrapped label
  leaves the series labels; a value that does not convert is `SampleExtractionErr`.
- **Errors in metric queries**: a sample that still carries `__error__` fails the query with
  Loki's `pipeline error: '…' for series: '{…}'` message.
- **Vector aggregations** `sum`, `avg`, `min`, `max`, `stddev`, `stdvar`, `count`, `topk`,
  `bottomk` (grouping before or after the argument), `sort`, `sort_desc`; **binary operators**
  `+ - * / % ^`, comparisons with and without `bool` (between scalars they return 0 or 1),
  `and`, `or`, `unless`, with `on` / `ignoring` / `group_left` / `group_right`;
  **`label_replace`**, **`vector()`**, number literals (decimal and exponent; a sign only on
  literals; hex is refused as Loki does), ranges and **`offset`** in Prometheus duration syntax
  (`[1h30m]`, `[1d]`, also negative offsets), comments (`#`). Grouping keywords (`by`,
  `without`, `on`, …) are reserved and refused as label names, as in Loki.
- **Templates**: text and actions with `{{-`/`-}}`, comments, pipelines, fields and chains,
  variables (`:=`, `=`), literals, parentheses, `if`/`else if`/`else`, `range` (with `else`,
  `break`, `continue`), `with`. Functions: Go's `and or not len index slice print printf
  println html js urlquery eq ne lt le gt ge`; LogQL's documented `__line__ __timestamp__
  date duration duration_seconds now toDate toDateInZone unixEpoch unixEpochMillis
  unixEpochNanos unixToTime alignLeft alignRight b64enc b64dec bytes default fromJson lower
  indent nindent repeat printf replace substr title trim trimAll trimPrefix trimSuffix trunc
  upper urlencode urldecode contains eq hasPrefix hasSuffix add addf ceil div divf float64
  floor int max maxf min minf mul mulf mod round sub subf count regexReplaceAll
  regexReplaceAllLiteral`; and Go's `strings` functions Loki accepts under their Go names
  (`ToLower ToUpper Replace Trim TrimLeft TrimRight TrimPrefix TrimSuffix TrimSpace`).
  `addf`/`subf`/`mulf`/`divf` compute in decimal (division to 16 places), as Loki's do.
  Execution errors set `TemplateFormatErr` with Go's message format.
- **Regular expressions** use Go's RE2 dialect: `\d \w \s \b` are ASCII-only, `\Q…\E` and
  octal escapes work (translated for Rust's `regex`, `src/goregex.rs`).

## Not implemented

Each returns `Error::Unsupported` (or a parse error where Loki's grammar has no such form):

- `approx_topk` and the sketch functions behind it; `variants(...) of (...)` (multi-variant
  queries, behind a Loki feature flag).
- Template actions `define`, `template`, `block`, and the `call` function; Sprig functions
  that Loki's documentation does not list.
- `toDateInZone` with a zone other than UTC (the engine has no time-zone database; `Local`
  is UTC); `now` without `Options::now_ns` (a `TemplateFormatErr` on the line, as any
  function error).
- Unicode character classes in regexes (`\p{Greek}`): the regex fails to compile (an error,
  never a different match).
- Instant log queries (Loki's HTTP API refuses them too); `interval` for log range queries;
  live tail; the label, series, volume, patterns and detected-fields endpoints (the engine
  answers queries only).
- Query limits other than steps, series and nesting depth (200): no sample or byte budget
  and no timeout in this crate; a caller bounds input with `selectors()`.
- Query sharding and split execution (`engine/query`'s split for PromQL has no LogQL
  counterpart yet).

## Reuse of viz-promql

LogQL's vector operations share PromQL's semantics, so they are evaluated by `viz-promql`,
not reimplemented. After the range aggregations are computed on the step grid, the metric
expression is printed as PromQL whose leaves are placeholder selectors (`__logql_r0`, …)
(`src/eval.rs`, `to_promql`), parsed with `viz_promql::parse_query`, and evaluated with
`query_range_expr` / `query_instant_expr` on an abstract grid (`0..n` milliseconds) with an
`EvalHooks::replace` that supplies the placeholders' values. Two LogQL rules are applied in
the translation: a comparison between two scalars gets `bool` (LogQL returns 0 or 1), and
`label_replace`'s regex is translated to the Go dialect first. Also reused: `Matcher` /
`MatchOp` and `format_float`. No change to `engine/promql` was needed.

Cost: the dependency brings `promql-parser` (most of the module size, below) and needs the
three `[patch.crates-io]` stand-ins of `engine/query/patches` for a module without imports;
inside `engine/wasm-query`, which already links `viz-promql`, LogQL adds only its own code.

## Verification

All commands run in `engine/logql` with `CARGO_TARGET_DIR` outside the tree. Machine: Linux
x86-64, 4 cores and 16 GB shared with other builds (load average 7 to 15 during these runs),
rustc 1.97.0, Go 1.24.7 (and go1.26.10 for the harness), Node 22.23. Measured here, not on
Cloudflare, on 2026-11-19.

`cargo test` runs offline and needs no Go: unit tests (25), `tests/api.rs` (7),
`tests/semantics.rs` (10, rules observed in Loki), `tests/conformance.rs` (1; it reports
itself skipped unless `tools/oracle/fetch.sh` was run), `tests/props.rs` (7 properties) and
the doc test. The differential exporters in `tests/differential.rs` are `#[ignore]`d; the
oracle fetch, the Loki harness and the mutation run are explicit commands (below).

### (a) Conformance: Loki's test tables as a behavioural oracle

`tools/oracle/fetch.sh` fetches three test files of Loki v3.7.10 into the git-ignored
`testdata/loki-oracle/` and extracts their tables (`tools/oracle/extract.go`, standard
library only). `cargo test --test conformance -- --nocapture` runs every case as a query
over one stream (`{__oracle_stream__="1"} | <stage>`) and compares accepted/rejected, or
the result line and labels. Without the files the test says it is skipped and passes.

| table | pass | fail | skip | not extracted |
|---|---:|---:|---:|---:|
| `ParseTestCases` (accepted / rejected) | 194 | 1 | 3 | 0 |
| `TestParseSampleExpr_equalityMatcher` | 13 | 0 | 0 | 0 |
| `TestParseLogSelectorExpr_equalityMatcher` | 7 | 0 | 0 | 0 |
| `Test_jsonParser_Parse` | 11 | 4 | 0 | 1 |
| `TestJSONExpressionParser` | 27 | 0 | 0 | 2 |
| `TestLogfmtParser_parse` (non-strict and strict) | 21 | 3 | 0 | 1 |
| `TestLogfmtParser_keepEmpty` | 2 | 2 | 0 | 0 |
| `TestLogfmtExpressionParser` | 10 | 0 | 0 | 0 |
| `Test_regexpParser_Parse` | 5 | 0 | 0 | 0 |
| `Test_PatternParser` | 4 | 0 | 0 | 0 |
| `Test_unpackParser_Parse` | 9 | 0 | 0 | 1 |
| `Test_lineFormatter_Format` | 51 | 0 | 1 | 0 |
| `Test_labelsFormatter_Format` | 17 | 0 | 5 | 5 |
| **total** | **371** | **10** | **9** | **10** |

- **Fail** cases are pinned with their reason in `tests/conformance_known_failures.txt`; the
  test fails on any other failure, and on a pinned case that passes. 7 are invalid UTF-8 in
  the input (Rust strings cannot hold it; `contracts/LOGS.md` requires UTF-8, and the bytes
  arrive here as U+FFFD), 3 expect a label whose *name* is empty, which Loki's builder holds
  internally but its HTTP responses never carry (observed).
- **Skipped**: `approx_topk` and `variants` (unsupported); one case whose input label has an
  empty value (a stream cannot carry one); five `label_format` cases whose line and
  timestamp are set in the test body rather than the table.
- **Not extracted**: cases whose values are not plain data (parser hints that test an
  internal optimisation, JSON expressions built from variables, times built with
  `time.Unix`).
- Before fixes, the first run had 44 failures; the oracle found: line-filter regexes are
  validated at execution, not parse time; `d`/`w`/`y` durations in label filters; JSON keys
  that are only whitespace add no segment; field chains `.a.b` versus arguments `.a .b` in
  templates; Go's `strings` function names; decimal arithmetic in `addf`…`divf`; Go's
  "is not a method but has arguments" and "wrong number of args" contexts.

### (b) Differential run against Loki v3.7.10

`tools/lokidiff/` (README there; it links AGPL code and is test-only) runs Loki's engine on
the same data and queries. `tests/gen/mod.rs` generates the data (3 to 10 streams each, a
high-cardinality `pod` label, 10 to 70 rows per stream over minutes, nanosecond
timestamps; lines in logfmt, JSON with nesting and arrays and nulls, Unicode text, ANSI
colour codes, malformed JSON of eight shapes, nginx access lines; numeric, duration and
byte-size fields, some that do not convert) and queries covering the feature list (12 log
queries and 10 metric queries per data set, 40% of the metric ones also as instant queries,
plus literals). `tools/lokidiff/compare.py` compares and classifies.

Final run: five generator seeds (7, 11, 12, 21, 33) × 60 data sets = 300 data sets, 1,924
streams, 75,502 rows; a third of the streams put rows on whole seconds, so rows fall exactly
on window edges and on other streams' timestamps (ties at the log limit).

| queries | evaluations | agree | both fail | explained difference | unexplained |
|---|---:|---:|---:|---:|---:|
| log (range) | 3,600 | 3,564 | 12 | 24 | 0 |
| metric, range | 3,000 | 2,802 | 171 | 27 | 0 |
| metric, instant | 1,193 | 1,148 | 37 | 8 | 0 |
| literals | 102 | 102 | 0 | 0 | 0 |
| **total** | **7,895** | **7,616** | **220** | **59** | **0** |

"Both fail" is mostly metric queries whose samples carry errors (189: JSONParserErr 111,
SampleExtractionErr 37, LogfmtParserErr 25, LabelFilterErr 16), 5 many-to-one matches
without `group_left`, and 26 generated queries both reject (for example a grouping on
`sum_over_time`). Values agree within 1e-9 relative (labels, timestamps and log lines
exactly). Explained differences by class: `loki-empty-labels-without-label_replace` 30,
`oracle-merged-streams-unsorted` 13, `oracle-merged-streams` 11,
`loki-topk-ties-nondeterministic` 3, `loki-sum-ignores-parser-errors` 2.

Every difference is classified; none is unexplained. The classes (each a rule in
`compare.py` with its evidence):

| class | kind | what |
|---|---|---|
| `oracle-merged-streams-unsorted`, `oracle-merged-streams` | oracle artifact | `drop`/`keep` merges source streams into one label set; Loki's `NewMockQuerier` concatenates their entries (or returns one source) instead of merging by time as the HTTP API documents, and applies the limit in that order. Detected from the data. |
| `loki-sum-ignores-parser-errors` | Loki inconsistency | under `sum` (observed without grouping, and in one shape with `by`), Loki counts samples that carry parser or `line_format` errors instead of failing; the same range aggregation alone fails. viz fails, as the documentation says. |
| `loki-empty-labels-without-label_replace` | Loki bug | series with empty-valued labels (from `--keep-empty` or absent parser parameters) through `without (…)` or `label_replace`: Loki groups with the empty labels but outputs without them, so its result holds duplicate label sets (observed: `sum without (app)` returns two `{y="1"}` series). |
| `loki-topk-ties-nondeterministic` | Loki nondeterminism | `topk`/`bottomk` under another operation with tied values: the same query on the same data gave 8 distinct results in 10 runs of Loki. |

The first generated run (518 evaluations) had 41 mismatches and found these viz bugs, all
fixed: colons kept in sanitised keys; `| unpack != "x"` parsed as a label filter; absent
`logfmt`/`json` parameters must be empty labels (unless a label of that name exists); the
`Value is string, but can't find closing '"' symbol` and `Malformed JSON error` wording;
`|>` requires non-empty captures; `ip()` label filters search the value for addresses and
pass entries that already carry an error; `__error__` filters run after the other filters
of their run; line filters after `decolorize`. The run with whole-second rows found one
more: at the log limit, entries with equal timestamps go to the smaller label set in both
directions (viz had reversed it for backward queries). Earlier, hand-written probes (about 320
queries) fixed the window edges, `rate_counter`, error precedence, sanitising, pattern
anchoring and the instant/range shapes before the generated runs.

`rate_counter`: Loki v3.7.10 returns `increase / range × (sampled_ns + range_ms) / sampled_ns`
(it extends the sampled interval by the range in milliseconds, added as nanoseconds; with
no extrapolation to the window edges, unlike Prometheus' `rate`). viz reproduces it, so it
is not a difference; it looks like a unit slip in Loki and is noted here in case Loki fixes it.

### (c) Property tests

`PROPTEST_CASES=300 cargo test --test props` (each case is a generated data set and its
~30 queries; all pass):

| property | |
|---|---|
| storage pruning on and off (`MemSource::prune`, rows failing `required` skipped) give identical results | pass |
| rows sharing a timestamp, reversed: metric results identical, log results the same entries | pass |
| a metric range query split at a step into two adjacent queries equals the whole (values within 1e-12 relative) | pass |
| a range query equals one instant query per step (values within 1e-12 relative) | pass |
| evaluation reads exactly what `selectors()` reports | pass |
| random tokens spliced into valid queries never panic (query and `selectors()`) | pass |
| `query_pool_is_live`: of 524 generated queries, 514 evaluate and 245 return data, so the properties are not vacuous | pass |

The two value properties allow 1e-12 relative because `viz-promql`'s `stddev`/`stdvar` give
results that differ in the last bit when the input series arrive in another order, and `or`
orders its output differently when a series has no point at a step (a finding for
`engine/promql`, not changed here). Sample order within a series is fixed (by time, then
value), so sums and `first`/`last` do not depend on the order rows arrive in.

### (d) Mutation checks

`MUTATE_DIR=/scratch python3 -I tools/mutate.py --loki-cases cases7.json --loki loki7.json`
copies the crate to the scratch directory (never edits the shared tree), applies one
mutation at a time, runs the suites (`props` with 32 cases; `differential` re-exports seed 7
from the mutant and compares with the recorded Loki answers) and restores the copy.

FILL_MUTANTS

### (e) WASM

`wasm-check/` is a measurement wrapper (a 3-function C ABI over `MemSource`; not a product
module, see Integration), built with the profile `engine/AGENTS.md` asks for (fat LTO, one
codegen unit, `opt-level = 3`, `panic = "abort"`, stripped,
`RUSTFLAGS="-C target-feature=+simd128,+bulk-memory"`) and the `engine/query/patches`
stand-ins: `cargo build --release --target wasm32-unknown-unknown`. `node check.mjs <wasm>`:

FILL_WASM

### (f) Benchmark

`cargo run --release --example bench 1000000`: 1,000,000 rows (97.4 MB of lines, half
logfmt, half JSON) in 200 streams over one hour, `MemSource`, best of 3, one thread.
Measured with load average 13 to 15 on the 4 shared cores, so these are pessimistic;
peak RSS 471 MB (the data set is held in memory; the engine's own state is small except for
metric queries, which hold every selected sample, 16 bytes each).

| case | query | best ms | M rows/s read | MB/s read | rows read |
|---|---|---:|---:|---:|---:|
| needle, log query | `{env="prod"} \|= "trace=00000000deadbeef"` | 53 | 12.6 | 1,228 | 664,867 |
| filter + logfmt + label filter, log query | `{app="api"} \|= "error" \| logfmt \| status >= 500` | 171 | 1.5 | 143 | 249,950 |
| count by app | `sum by (app) (count_over_time({env=~".+"}[1m]))` | 80 | 12.5 | 1,218 | 1,000,000 |
| rate of errors, logfmt | `sum by (app) (rate({env="prod"} \| logfmt \| level="error" \| __error__="" [5m]))` | 1,774 | 0.4 | 37 | 665,000 |
| JSON unwrap quantile | `quantile_over_time(0.99, {app="web"} \| json \| unwrap latency_ms \| __error__="" [5m]) by (app)` | 474 | 0.5 | 51 | 250,000 |
| line_format | `{app="db"} \| logfmt \| line_format "{{.level \| upper}} {{.status}} {{.latency}}"` | 2,933 | 0.1 | 8 | 249,950 |

The fast path for pipelines of line filters only (labels pass through, the stream's series
is resolved once) took `count by app` from 972 ms to 80 ms and the needle search from 146 ms
to 53 ms. Pipelines with parsers allocate a label set per row; templates run at about
10 µs per line. Not scaled down: 1 M rows fit the memory budget.

## Differences from Loki (by design or undecidable)

- **Equal timestamps.** Across streams, entries that share a timestamp go to the smaller
  label set first in both directions (as observed in Loki); within a stream, arrival order
  (reversed for backward), which `contracts/LOGS.md` fixes as `(ts, line)`. Within a metric
  series, samples that share a timestamp are ordered by value, so sums and `first`/`last`
  do not depend on arrival order; Loki uses arrival order there.
- **Streams merged by `drop`/`keep`** are merged by time (the API's documented order).
- **Parser errors under `sum`** fail the query (see the differential class).
- **`topk`/`bottomk` ties** are broken by label set (viz-promql); Loki's choice varies.
- **Empty-valued labels** stay in series labels through `without` and `label_replace`.
- **Error wording.** `__error_details__` reproduces Loki's wording for the error shapes
  observed (JSON: unterminated object, string or array, missing colon, bad literal,
  non-object; logfmt; label filters; templates; unwrap); other malformations may be worded
  differently. Parse-error messages have Loki's `parse error at line L, col C:` prefix but
  not always its wording.
- **Time zones**: UTC only. **Regexes**: Go RE2 semantics translated to Rust's `regex`;
  constructs outside the translation (Unicode classes) fail to compile rather than match
  differently.

## Known risks

- Details learned by observing v3.7.10 (error wording, filter ordering, `rate_counter`,
  sanitising) can change in later Loki versions; the differential run is how to notice.
- Memory: a metric query holds every selected sample (16 bytes plus the series label set),
  and a log query buffers up to twice `limit` entries; there is no byte or sample budget in
  this crate, so the query Worker must bound input (`selectors()` gives the ranges).
- Templates: execution is bounded (1,000,000 steps, `repeat` output 1 MiB) but slow.
- A panic aborts a WASM isolate. The parser bounds nesting (200), the JSON reader depth
  (128/256), templates their steps; the token-soup property is random testing, not proof.
- The oracle cannot test structured metadata (the mock querier drops it).

## Integration (not done here)

- **Storage**: a `logs` table writer (flush, compaction) and a `LogSource` over Parquet row
  groups plus tail batches, per `contracts/LOGS.md` (stream-first sort, dedup on the row key,
  index fragments, the phase-2 token filter fed by `selectors().required`); the tail batch
  format for logs (`BATCH.md`, signal 2).
- **Ingest**: OTLP logs and Loki push (`/loki/api/v1/push`, JSON and protobuf) in `edge`,
  with the OTLP-to-labels mapping and limits of `contracts/LOGS.md`.
- **Query Worker**: `/loki/api/v1/query` and `query_range` (time parsing, `limit`,
  `direction`, `step` defaults, 400 for instant log queries), labels/series endpoints (need
  a stream index), `stats` timing, error mapping (`Error::error_type`). The engine should
  join `engine/wasm-query`'s module (it already links viz-promql) behind new C ABI
  operations rather than ship as a second module; `wasm-check/` shows the ABI shape.
- **Contracts**: `contracts/README.md` needs a row for `LOGS.md`; `contracts/engine.ts` says
  LogQL result shapes are not defined yet and needs them (this crate's `Data`).
- **Split execution and rules**: decomposable LogQL aggregations over leaves, and LogQL rule
  evaluation in the ruler.

## Layout

```
src/lexer.rs, parser.rs, ast.rs   tokens, recursive-descent parser and validation, syntax tree
src/pipeline.rs, labels.rs        compiled stages, stage order, label sets and error labels
src/json.rs, jsonwalk.rs          JSON reader; the json/unpack parsers with Loki's error wording
src/logfmt.rs, pattern.rs, ip.rs  logfmt scanner, pattern parser and filter, ip() matching
src/goregex.rs, text.rs           Go regex dialect, Go strings/durations/byte sizes/floats
src/template/                     text/template subset, functions, Go fmt, Go time layouts
src/eval.rs                       log queries, range aggregations, translation to viz-promql
src/source.rs, output.rs, lib.rs  LogSource and MemSource, Loki JSON, public API
tests/                            api, conformance (oracle), props, differential exporter, gen
tools/lokidiff/                   differential harness (AGPL, test-only) and compare.py
tools/oracle/                     fetch and extract Loki's test tables (git-ignored output)
tools/mutate.py                   mutation checks on a scratch copy
wasm-check/                       WASM measurement wrapper
```
