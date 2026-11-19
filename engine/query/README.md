# viz-query

The query half of the viz engine as a Rust library: PromQL (`viz-promql`) evaluated over
lake Parquet files and shard tail batches (`viz-storage`), with query limits, a fetch
plan, the metadata calls of the Prometheus HTTP API, **split execution** (leaves evaluate
partial aggregates over disjoint sets of series; a coordinator merges them, with results
identical byte for byte to one place) and the **cardinality report**.

No I/O, no async, no clock, no randomness: every function is a pure function of its
arguments, so the same code runs as WASM in a Worker, natively in a Container, and in a
deterministic simulator. Nothing panics on input. Builds for the host and for
`wasm32-unknown-unknown`.

```
export CARGO_TARGET_DIR=$PWD/target
cargo test -j 2 --no-fail-fast -- --test-threads 2          # 55 tests, about 12 minutes on a loaded machine
cargo test --test corpus -- --nocapture                     # upstream corpus through storage, per file
cargo build --release --target wasm32-unknown-unknown       # the library
(cd wasm && cargo build --release --target wasm32-unknown-unknown) && node tools/wasm_check.mjs
cargo run --release --example bench                         # the benchmark
cargo run -j 2 --release --example cardinality -- 10000 100000 1000000   # high cardinality (query/CARDINALITY.md)
python3 tools/mutants.py                                    # mutation check, on a scratch copy (never edits this tree)
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
| `label_names(input, matchers, min_ts, max_ts)` | `/api/v1/labels`. Sorted, unique. **A series-only read** (CARDINALITY.md item 3, 2026-11-19): series files and tail series tables, never sample files; "in the range" decided per file (below). |
| `label_values(input, name, matchers, min_ts, max_ts)` | `/api/v1/label/<name>/values`. The same read. |
| `series(input, matcher_sets, min_ts, max_ts)` | `/api/v1/series`: sorted, unique label sets matching any set. The same read. Refuses, as Prometheus does, no sets and a set whose matchers all match the empty string. |
| `parse_selector(text)` | A `match[]` string to matchers; anything but a bare series selector is `bad_data`. |
| `files_needed(indexes, ranges)` | For each ledger index fragment (`viz_storage::FileIndex` JSON): `false` if the file provably holds nothing the fetch ranges read. A row group can contribute to a range only if it overlaps it in time and, when the range has an equality matcher on `__name__`, the name lies in the row group's `[min_name, max_name]`. Nothing else prunes; a fragment that does not parse keeps its file. |
| `scan_rows(indexes, ranges)` | The same decision with a number: an upper bound on the rows the ranges decode from each file (each row group once per range that may read it), `Some(0)` for "skip", `None` for a fragment that does not parse. Lets a caller refuse a query that would decode too much before fetching anything. |
| `Limits`, `Limits::check_query`, `estimate_depth` | The limits below. |
| `QueryError { error_type, message, limit }`, `to_json()` | Errors with a Prometheus `errorType` and the API's error body. |
| `to_json`, `labels_to_json` | Serialisation of results. |
| `reference_range`, `reference_instant` | One-place evaluation over any `SeriesSource` with this crate's aggregations: the reference of the tests (and of `query/`'s fixtures). |
| `agg`: `partial`, `Partial::merge`, `finish`, `Canonical` | Aggregations whose result does not depend on how the input is split or ordered (below). `Canonical` is the `viz_promql::EvalHooks` every evaluation here uses. |
| `exact`: `ExactSum`, `ExactVariance` | Exact sums and variances of `f64`, rounded once. |
| `split_plan(query, opts) -> SplitPlan` | Split over leaves (`fragments`, `SplitKey`) or one place, and why. |
| `split::extract`, `split::split_tails`, `split::Gathered`, `split::leaf_evaluate`, `split::merge_range`, `split::merge_instant` | The pieces of split execution: a reader's rows of one part, the tail cut by part, a leaf's data and its evaluation into partials, the coordinator's merge. |
| `catalog::for_each_series`, `for_each_series_with` | A series-only read of `metric_series` files (whole, or a sparse file of the row groups fetched); `_with` decodes a row group's `labels` only when it holds an id the caller has not seen. |
| `file_plan(indexes, ranges, gap)` | **Reading part of a file**: per fragment, the row groups the ranges can touch by name and time (exactly `scan_rows`), as a `FilePlan`: skip, the whole object, or byte ranges (the footer and those row groups, joined under `gap`; whole when they would cover half the file or the fragment has no `foot`). |
| `sample_plan(series_files, indexes, reads, part, gap)` | **Series-level pruning** (CARDINALITY.md item 2): resolve each read's matchers against the series files, keep a split part's series if asked, and plan each sample file to read only the row groups whose key range can hold a selected series (`viz_storage::RowGroupIndex::may_hold`). Returns the plans, the exact series count (per file in each read's window, summed over reads), and a **carrier** batch of the selected series to evaluate with instead of the series files. A series whose labels carry a `without` label is placed by its labels (found without a parse: `"name":` occurs in canonical JSON only as a key). |
| `part_plan`, `part_sids` | One split part's row groups from the fragments alone: its `series_id` range (`part_sids`: exactly the ids `SplitKey::part_of` gives it, one or two intervals in `i64` order). |
| `cardinality::State`, `Summary` | The cardinality report: one part's counts, merged, rendered as `/api/v1/status/tsdb` and `/api/v1/status/cardinality`. |

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

### Order-independent aggregations

Split execution adds the values of a group in a different order than one evaluation over
all series, so every aggregation here is computed so that the order cannot matter
(`src/agg.rs`, `src/exact.rs`), in one place as in split execution:

| Operator | State per group and step | Merge | Exact because |
|---|---|---|---|
| `sum` | exact sum: every finite `f64` is an integer multiple of 2^-1074, so the sum is a big integer (positive and negative parts), rounded to nearest-even once | add | integer arithmetic |
| `avg` | count and exact sum; the mean is the rounded sum divided by the count (scaled by 2^64 first if the rounded sum overflows) | add both | the same |
| `count`, `group`, `count_values` | count | add | integers |
| `min`, `max` | the extreme so far | the extreme of both | a total order: NaN only if all are NaN; between `-0` and `+0`, `-0` for `min` and `+0` for `max` |
| `stddev`, `stdvar` | count, exact sum, exact sum of squares (units of 2^-2148) | add | `(nΣx² − (Σx)²)/n²` in integers, rounded once (then `sqrt`) |
| `topk`, `bottomk` | the best `k` (value, series) of the part, per group and step | union, then the best `k` | the ranking is a total order (NaN last, ties to the smaller label set), and a series in the overall best `k` is in its own part's best `k`: the series that rank before it in its part are a subset of those that rank before it overall, fewer than `k` |

Infinities and NaN follow IEEE 754 as a sequential sum would (NaN if any NaN or both
infinities; else the infinity). **What changes against Prometheus** (and against
`viz-promql` without the hook): a sum can differ from Prometheus' compensated (Neumaier)
sum in the last bit, and is the correctly rounded one (Prometheus' own result depends on
its storage order); `MAX + MAX − MAX` is `MAX`, where a running sum stays at `+Inf`;
`stddev`/`stdvar` are exact instead of Welford's running formula (in `query/`'s fixtures
the `stddev` query changed in the 16th or 17th significant digit, nothing else changed);
an aggregation's output is in label order instead of first-seen order (visible only in
instant vectors; Prometheus' order is unspecified); `min`/`max` break the `-0`/`+0` tie by
sign. `quantile` keeps `viz-promql`'s code (it never splits), and so does every
aggregation under delayed name removal. The engine's own `viz-promql` defaults are
unchanged: the hook is passed by this crate.

### Split execution

`src/split.rs`, design §6.2. The query Worker (`query/`) does the I/O; this crate decides
and computes.

**What runs where.** A *fragment* is an aggregation whose operator decomposes (`sum`,
`avg`, `count`, `group`, `min`, `max`, `stddev`, `stdvar`, `topk`, `bottomk`,
`count_values`), that is not inside a subquery, and whose argument is *series-local*: one
selector, through range functions (`rate`, `increase`, `irate`, `delta`, `deriv`,
`predict_linear`, `*_over_time` except `absent_over_time`, also over a subquery of a
series-local expression), element-wise functions (`abs`, `round`, `clamp*`, `timestamp`,
date functions of a vector, …), `label_replace`, `label_join`, `sort`, unary minus, and
binary operators with a scalar that reads no data (literals, `time()`, `pi()`). A
`topk`/`bottomk` parameter must read no data; `count_values` needs a valid label literal.
A query is split when **every selector is inside a fragment**; the leaves evaluate the
fragments and everything above them runs at the coordinator over the merged fragments:
binary operators between aggregates, `histogram_quantile` over `sum by (le)`, `quantile`,
`scalar`, `sort`, `absent` of an aggregate, an aggregation of aggregations. Otherwise
(`rate(x[5m])` alone, `quantile(0.9, x)`, `sum(a + b)`, `sum(x) / x`, an aggregation in a
subquery, `limitk`, a top-level range vector, delayed name removal) the query runs in one
place and `split_plan` says why.

**The split key: by series.** A series' key is the FNV-1a hash of its labels without
`SplitKey::without` — exactly its `series_id` when it carries none of them — and part `j`
of `L` owns keys in `[j·2^64/L, (j+1)·2^64/L)`. Every sample of a series reaches one leaf,
so `rate` and every per-series function see the whole series. `without` holds the labels a
fragment's argument may change: `label_replace`/`label_join` targets, and `__type__`,
`__unit__` (and `__name__` unless the selector pins it with `=`) when a function drops
them. Two series can only collide inside a fragment (the evaluator's "same labelset"
merge or error) if they agree on every other label, so colliding series share a leaf and
its evaluator merges or refuses them exactly as one place does.

**How a part's rows are found, and what it costs.** Files are cut by time, not by series,
so every part needs every file. A *reader* ([`split::extract`]) is given a group of sample
files (with the `metric_series` files written with them) and a part: it reads the series
files with `catalog` (a series-only read), keeps the part's series that a plan range can
select, and hands `viz_storage::select` a *carrier* batch whose series table holds exactly
those series (its rows sit at a timestamp no range covers, so `select` never returns them)
instead of the series files. So `select` decodes the `ts` and `value` columns only of row
groups that hold one of the part's series and keeps only their samples; it still reads
every row group's `series_id` column. Cost: each file is read and its `series_id` column
decoded once **per part** (`L` times), and with whole-file reads of ten-minute flush files
every row group holds some of every part's series, so the `ts`/`value` decode is also
`L`-fold. Memory per reader: its files plus `1/L` of their samples. The extract travels as
one `VZB1` batch (20 bytes a row).

**The tail and I17.** The coordinator cuts the shard tails by part
([`split::split_tails`], rows outside the plan's ranges dropped, batch and row order kept)
and sends each part's batches to its leaf. A leaf ([`split::Gathered`]) merges extracts
and tail batches per series by precedence: file groups in the ledger's precedence order,
then tail batches in order, a higher rank winning on an equal timestamp. That is
`viz_storage::select`'s rule (later file wins, any tail batch wins over the lake), so a
`rate` window that straddles lake and tail is computed over one ordered, de-duplicated
stream, whatever order the extracts arrive in.

**Partial results.** A leaf evaluates each fragment with a hook that captures the
aggregation's `agg::Partial` instead of finishing it ([`split::leaf_evaluate`]), and
answers with the partials, the series and samples each `select` loaded, any evaluation
error, or that it stopped at its budget, in a binary form (`LeafOutput::encode`; partials
hold exact sums as their words, a few tens of bytes per group and step). The coordinator
([`split::merge_range`], [`split::merge_instant`]) replays the query's limits on the
summed counts in the order one place checks them (series, samples, step points per
`select`, in evaluation order, then output points), so an over-limit query gets the same
error message as in one place; returns the first fragment's error (all leaves give the
same one); merges the partials; and evaluates the query with each fragment replaced by its
merged value (`viz_promql::EvalHooks::replace`) and every other aggregation done as in one
place. A selector reached at the coordinator is an error, never an empty answer.

**Early abort.** A leaf gets a budget, its share of the query's (`LeafBudget`). Gathering
stops as soon as the leaf holds more distinct samples (or series) than its share: both
counts are lower bounds of what evaluation would load, because every sample held lies in
some selector's range. During evaluation each `select` is checked against the share too.
So a leaf never materialises much more than its share: the overshoot is one extract (one
group of at most six files' worth of its part) while gathering, or one selector's part in
evaluation. The coordinator weighs the stopped leaves (see `query/` README, "Split
execution"). What remains, inside `viz_storage::select`, is in "Not implemented".

### Foreign series in a split extract (2026-11-19, ABI 5)

`split::Extract::foreign`: the series some range selects whose `series_id` is in the part's
range but whose split key is another part's. A reader that reads the series files by its id
range cannot see its own strays (series of its part whose id lies elsewhere); each of them is a
foreign series of the part its id is in, so if no part reports one there is none, and the
query Worker then trusts id-range reads (`query/README.md`, D59). `tests/series_ranges.rs`
(property and two directed tests) and `examples/series_ranges.rs` (the measurement: at
1,000,000 series over 32 parts, 640.7 MiB and 36.4 s of reader CPU by name and time, 82.5 MiB
and 9.9 s by id range, identical extracts). Mutant (scratch copy): `foreign` never counted,
**killed** by `a_series_whose_key_is_not_its_id_is_foreign_to_the_part_its_id_is_in`.

### The label calls over parts (2026-11-19)

`src/meta.rs` (`label_names_part`, `label_values_part`, `series_part`, `MetaPart`), for
`query/`'s label endpoints over leaves. A listing restricted to the series whose `series_id`
(unsigned) is in one part of a split (`SplitKey::part_of`, the cardinality report's parts), in
files and in tail batches, with the `series_id`s of the series it listed. Parts are disjoint in
series, so their listings union to the whole and their series add up to the whole's; the ids
let a caller list a part's files in several calls (waves) and count distinct series exactly
together. `max_series` bounds each call. Tested by `tests/meta_parts.rs` (a property over
random histories, layouts, windows, 1 to 8 parts and five matcher sets: unions, sums and ids
equal the whole's; `/series` refuses a non-selective set in every part; a part over its own cap
is refused). Mutants (on a scratch copy, 2026-11-19): the part filter dropped for tail series,
and for file rows: each **killed** by both tests.

### Series-level pruning and the series-only read (2026-11-19)

`src/prune.rs`, `src/meta.rs`; `contracts/TABLES.md` "The index fragment" and "Reading part of
a file"; `design/DECISIONS.md` D41; numbers in `query/CARDINALITY.md`.

- **What a caller fetches.** `file_plan` from the fragments alone (name and time);
  `sample_plan` once the series files are in hand (series); `part_plan` for a split part
  before (its id range). Each gives byte ranges: the footer region and whole row groups. The
  engine takes them as a sparse file container wherever it takes a file.
- **What the engine decodes.** Inside a row group `viz_storage::select` decodes `series_id`,
  then only the pages of `ts` and `value` that hold a selected series' rows.
- **The carrier.** When every read selects by more than a name, `sample_plan` returns a batch
  of exactly the selected series, with one row each at a time no read covers (the extract's
  carrier of split execution). Evaluating with it first among the tail batches and no series
  files gives the same answer (tested), without resolving the series twice or holding the
  series files.
- **The label calls** read series files and tail series tables only. A series is listed if a
  series-file row's `[min_ts, max_ts]` overlaps the window, or a tail row lies in it: per
  file, as Prometheus decides per block, so a series with samples in one file on both sides of
  the window and none inside is listed (a query would not see it). `max_series` bounds the
  series listed; no sample is loaded, so `max_samples` does not apply (before 2026-11-19 these
  calls went through `select`, loaded samples, and listed exactly the series with a sample in
  the window). A row group's `labels` column is decoded only if it holds a series not seen in
  an earlier file.

### Cardinality

`src/cardinality.rs`. From `metric_series` files (`catalog`) and tail batches' series
tables, never samples. **Exact counting with caps**: series de-duplicated by `series_id`,
label pairs and (metric, label, value) triples by their text; `Caps::max_series` bounds
distinct series seen and `Caps::max_pairs` distinct pairs plus triples; above a cap the
report is refused (`execution`, naming the cap), never approximated, so below the caps the
error is zero. A series is in `[start, end]` if a `metric_series` row (first and last
sample in that file) or a tail row overlaps it, and *created* if its first sample seen
(reading from `start − lookback`) is at or after `start`. Parts own `series_id` ranges, so
they are disjoint in series: counts add, pairs and triples are unions (`Summary::merge`).
`Summary::report` renders Prometheus' `TSDBStatus` object in its field order and viz's
own report.

## What is not implemented

- **The engine does not fetch.** `plan` says what to fetch; reading the ledger, R2 and
  the shards is the caller's job (`query/` does it). `file_plan`, `sample_plan` and
  `part_plan` say which byte ranges (row groups and the footer); pages are not fetched, only
  skipped in memory (D41).
- **Split execution, what is left** (DESIGN §6.2): partials travel in this crate's
  binary form, not Arrow IPC; readers read every series file whole for every part (their sample files only in their
  part's id range since 2026-11-19); `quantile`, binary operators between vectors and aggregations in
  subqueries are not split (one place); leaf partials are not cached (§6.3).
- **An early abort inside storage.** `viz_storage::select` still materialises one
  selector's matching samples (one part's, under split execution) before a limit can be
  checked; a budget inside `select` is a storage change (`query/` README, "Needed
  changes").
- **Tenant injection and label-based access rules** (DESIGN §6.1). A `ScanInput` is
  assumed to hold one tenant's bytes; nothing here adds matchers on behalf of a policy.
- **Caching** (DESIGN §6.3), including within a query: a selector that appears twice is
  read from storage twice (and counted twice by the limits).
- **A time limit.** The engine has no clock, so there is no timeout; the bounds are on
  samples, series, steps and points instead.
- **The Prometheus `limit` parameter of the label endpoints.** (The series-only read itself
  is implemented, 2026-11-19.)
- **Series files read in part by key.** `sample_plan` and the split readers read the series
  files whole (by name and time): a part's series cannot be found in a key range of them,
  because a series whose key leaves a label out is not where its id is. Every split part reads
  every series file (`query/CARDINALITY.md` has what that costs).
- **A sort key that clusters a label.** A selection spread over the id space (`namespace=…`)
  needs every row group of the metric (D19, D41).
- **Annotations** (warnings and infos), exemplars, `/api/v1/metadata`, `/targets`,
  `/rules`, `/alerts`, `/status/*` other than the cardinality report, remote read.
- **Approximate cardinality** (HyperLogLog): counting is exact and refused above its caps.
- **The result's `stats` object** in JSON. `Stats` is returned typed only.
- **TraceQL and LogQL.**
- **The product's JavaScript binding.** `wasm/` is a size probe and load proof with its
  own small C ABI. The bindings are `engine/wasm` (write half) and `engine/wasm-query`
  (query half: this crate behind a C ABI, used by the `query/` Worker).
- Everything `viz-promql` lists as not implemented (native histograms, `limitk`,
  `anchored`/`smoothed`, …): those queries return `unsupported` or `bad_data`.

## How it was verified

All numbers measured here (Linux x86-64, 4 cores shared with other builds, rustc
1.97.0, Node 22.23), not on Cloudflare.

**2026-11-19, the label calls over parts:** `cargo test -j 2`: **57 tests, all passing** in 11
targets (the 55 below and `tests/meta_parts.rs`, 2), 06:47 to 06:52 UTC at a load average of 7.7
to 7.9, against `engine/storage` as it was at 06:41 (`src/*.rs` SHA-256 `f55f874a7f4df43c…`).

**2026-11-19, series-level pruning and the series-only read:** `cargo test -j 2` with two
test threads: **55 tests, all passing** (lib 2, api 10, corpus 1, invariance 3, limits 10,
plan 5, prune 3, pruning 8, split 8, staleness 5), from 05:06 to 05:21 UTC at a load average of
10 to 16. That run first found a bug in this work: `pruning`'s property failed for part 1 of 3
of `count(label_join(n, …))`, because `split::extract` returned early, with no `strays`, when
it was given no sample file, so a reader whose id range held nothing would have taken "no
strays" for an answer and missed a relabelled series' rows. The count is now made before that
return; `pruning` and `split` were run again and pass, and so do `staleness`, `api` and `lib`
(the others do not reach `extract`). New tests (`tests/pruning.rs`): `the_sample_plan_never_changes_a_result`
(property, 32 cases, I14): every query of the pool and three relabelled ones, over the files
read as `sample_plan` (with and without file pairs) and `file_plan` say, gives the same JSON and
statistics as over whole files, also when evaluated with the carrier instead of the series
files, and loads no more lake samples than the planned rows; and for split parts 1 and 3,
the extract over planned files (and over the id-range plan wherever it covers) is identical;
`label_calls_list_exactly_the_series_in_the_window_per_file` (property, I17): in every placement
the label calls equal a reference computed from the history and the layout alone, include every
series a query over the window sees, and do not change without the sample files;
`part_sids_are_the_parts_key_range` (property, 256 cases); directed tests for one series of a
20-row-group file (one row group and the footer), a part's key range, older and broken
fragments, a sample "file" that is not Parquet, and inclusive windows.

`cargo test`: **47 tests, all passing** (lib 2, api 10, corpus 1, invariance 3, limits 10,
plan 5, prune 3, split 8, staleness 5), run on 2026-11-18 with `-j 2` and two test threads
on a machine with a load average of 6 to 20 (6 min), and again on 2026-11-19 from 00:43 to
00:49 UTC after a container restart (load average 1.0 at the start, 10.7 at the end): 47
passed, `min_by_group_over_signed_zeros_regression` and the two split properties included.
`src/agg.rs` was checked to be the correct version (`canon_min` keeps `-0` on a tie,
`canon_max` `+0`), and every mutant of the table below was checked NOT to be applied: each
mutant's original text is in the source exactly once and its mutated text is not (mutants
35 and, in `query/`, 19 and 39 have mutated text that is a substring of unmutated code).
The read path's WASM module rebuilt from that source has the same SHA-256 as before.
After `examples/cardinality.rs` was added (no file under `src/` or `tests/` changed),
`cargo test` again at 02:00 to 02:04 UTC (load average 7): 47 passed, the example built. Seven are property tests. The
references of the invariance tests (and of `query/`'s fixtures) are `viz-promql` over its
in-memory source **with this crate's aggregations** (`reference_range`), since every
evaluation here uses them; with that change all 37 earlier tests pass unchanged.

### 0. Split execution equals one place

`tests/split.rs` (new):

- `split_equals_one_place` (property, 24 cases): random write histories (the generator
  of section 1) in random lake/tail placements; every query of the 106-query pool and of
  46 aggregation-heavy queries (`sum`, `avg`, `count`, `min`, `max`, `group`, `stddev`,
  `stdvar`, `topk`, `bottomk`, `count_values` with and without `by`/`without`, over
  selectors, `rate`, `increase`, `*_over_time`, arithmetic, `label_replace`/`label_join`
  (with collisions), unpinned `__name__` (with collisions), `@`, `offset`, a subquery
  inside the argument, and above them ratios, `histogram_quantile`, `quantile`, `scalar`,
  `sort_desc`, `absent`, `topk` of a sum, a time-varying `k`), as range and instant
  query, at 1, 2, 7, 32 or a random 3 to 11 parts, with the lake read by readers in 1 to 4
  groups whose extracts arrive in reverse order and the answers sent through their
  encoding: **every split result equals one place byte for byte (or the same error), and
  so do the statistics.** About 180 split evaluations per case; 24 cases (soak runs are
  in "How it was verified" of `query/`).
- `partials_merge_exactly` (property, 256 cases): for 14 aggregations and random vectors
  with signed zeros, NaN, infinities, `1e±300`, subnormals and arbitrary bit patterns,
  three disjoint parts merged in two orders (one through the encoding) finish to the same
  bits as the partial of the whole.
- `which_queries_split_and_why_not`: 46 queries split, 13 do not and give their reason;
  the split key of six queries; delayed name removal is not split; key ranges.
- `a_leaf_stops_at_its_budget_and_a_rerun_with_the_rest_is_identical`: a budget of 10
  samples stops every leaf while gathering (no `select` made, no partial); the merge
  refuses an aborted leaf; a series budget stops it too; a re-run with the rest is
  identical to one place.
- `the_query_limits_are_replayed_exactly_on_the_summed_counts`: each of four limits at
  what the query loads and one below (and two far below), over 3 parts: the same answer
  or the same error message as one place (6 errors, 4 answers).
- `results_do_not_depend_on_the_order_extracts_arrive_in`: a sample rewritten in a later
  file and again in the tail reads back as the last write whatever order a leaf receives
  its batches in.
- `signed_zeros_give_the_same_bits_in_any_order`: `-0` and `+0` in different parts or
  orders give the same bits for `min`, `max`, `sum`, `avg`.
- `min_by_group_over_signed_zeros_regression`: the input CI's run of
  `partials_merge_exactly` reported (`min by (g)` over `1e-300`, `-0`, `+0`), split four
  ways and merged in three orders. That CI run tested a snapshot of the tree taken while
  the mutation check had mutant 36 applied (the mutation tools edit sources in place and
  restore them): the property caught the mutant, which is its job; the source was right.
  **Do not snapshot or build `engine/query` or `query/` while a mutation run is going.**
- `exact::tests` (unit): correct rounding on cancellation, ties to even, sticky bits,
  subnormals, overflow, infinities; variance of small integers equals the rational value.

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

### 4b. File pruning

`tests/prune.rs` (added with `query/`, the Worker that uses it).

- `skipping_files_never_changes_a_result` (property, 32 cases x 106 queries, range and
  instant): every batch flushed as its own segment (many small files), 0 to 2 of them
  also in the tail, row groups of 1 to 6 rows or the default. Evaluating over only the
  files `files_needed` keeps gives the same result, or the same error, as evaluating
  over all of them. In the same cases, the samples `viz_storage::select` loads from the
  lake for the plan's ranges never exceed the sum of `scan_rows`.
- `files_are_skipped_by_time_and_by_name_and_only_then`: inclusive time bounds on both
  sides; names outside `[min_name, max_name]` skipped, the two bounds and a name between
  them kept; `=~`, `!=`, `!~` on the name and equality on another label prune nothing;
  several ranges; no ranges; row counts, with a row group counted once per range.
- `a_fragment_that_does_not_parse_keeps_its_file`: empty text, broken JSON, another
  version: kept, with an unknown row count.

Mutation (run from `query/tools/mutants.mjs`, mutant 8, which rebuilds the WASM module):
comparing the name with `<` instead of `<=` against `max_name` is caught by the directed
test here and by the query Worker's end-to-end tests.

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

**Series-level pruning and the series-only read (2026-11-19, mutants 42 to 51, on a scratch
copy, with `--test pruning`; 04:29 to 04:52 UTC, load average 8 to 10): 10 of 10 killed**, the
shared tree's files unchanged. A part's plan keeping the other parts' series
(`a_part_reads_its_key_range`, `the_sample_plan_never_changes_a_result`); a series carrying a
`without` label placed by its id, not its key (`the_sample_plan…`, through the relabelled
queries added for it); a read without a name keeping a row group only if it may hold every
wanted name (`one_series_of_a_large_file…`, `the_sample_plan…`; its pattern had gone stale
after a change to `sample_plan` and was fixed before this run); `part_sids`' upper end running
into the next part (`part_sids_are_the_parts_key_range`, `the_sample_plan…`); a part's id-range
plan reading the next part's range (`the_sample_plan…`); the carrier's rows inside a read's
range (`the_sample_plan…`); a file's row in the window one millisecond late
(`the_label_calls_never_open_a_sample_file`); the tail not read
(`label_calls_list_exactly_the_series_in_the_window_per_file`); `max_series` not firing in the
series-only read (`the_label_calls_never_open…`). **One survived the first run**: a tail row
exactly at the window's start left out (`t > min_ts`); the property's windows rarely start on a
tail sample. `the_window_is_inclusive_at_both_ends_in_files_and_in_the_tail` was added, and kills
it. The storage side (the predicate, the index writer, partial reads) is in
`engine/storage/README.md` (18 of 18) and the Worker side in `query/README.md`.

`python3 tools/mutants.py` applies one source change at a time, runs the suite (property
tests at 8 cases, corpus left out, `-j 2`, two test threads), restores the file, and
reports the failing tests. **Since 2026-11-19 it works on a scratch copy**: it copies
`engine/query` and `engine/promql` into a new temporary directory (`VIZ_MUTANTS_DIR` picks
where), links `engine/storage`, builds there with its own target directory, and never
writes to the shared tree; at the end it compares the shared copies of the mutated files
with their state at the start. (Before, it edited `src/` in place, and a CI snapshot taken
during a run tested mutant 36; see `min_by_group_over_signed_zeros_regression`.) First run
in that mode, 2026-11-19 01:54 to 02:00 UTC (load average 7 to 9), mutants 32, 36 and 40:
**3 of 3 killed** (36 by `min_by_group_over_signed_zeros_regression` and
`signed_zeros_give_the_same_bits_in_any_order`); the unmutated suite passed before and
after; the shared files hashed the same before and after. The other 38 were not re-run:
no file under `src/` changed since the in-place run that killed all 41. It
confirms first that the unmutated suite passes and tells a failing test from a build
error. **41 of 41 mutants were killed** (31 before split execution, all re-run where the
source they mutate changed; 10 new for split execution and exact aggregation, run on
2026-11-19 with `split` and the unit tests in the suite); none survived in the end. `engine/storage` is another
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
| 32 | **Split by file, not by series**: a reader keeps every series of its files (a series' rows end up in several leaves, and partials count it twice) | `split_equals_one_place`, `a_leaf_stops_at_its_budget_…`, `the_query_limits_are_replayed_…` |
| 33 | **`topk`/`bottomk` merged with `k` one too small** | `split_equals_one_place` |
| 34 | **`avg` merged as the mean of the parts' means** | `split_equals_one_place` |
| 35 | **A non-decomposable query split anyway** (a binary operation between two vectors taken as series-local) | `which_queries_split_and_why_not` |
| 36 | **Merge order dependence**: `min` keeps whichever of `-0`, `+0` came first | `signed_zeros_give_the_same_bits_in_any_order` (it **survived** the first run, where only the random property could catch it and 8 cases never drew both zeros in one group; the directed test was written for it, and kills it) |
| 37 | **Merge order dependence**: the parts' sums added as floats | `split_equals_one_place` |
| 38 | A leaf lets the batch that arrives last win, not the one of higher precedence | `results_do_not_depend_on_the_order_extracts_arrive_in` |
| 39 | The coordinator does not replay `max_samples` on the summed counts | `the_query_limits_are_replayed_exactly_on_the_summed_counts` |
| 40 | **A leaf's budget is not enforced while gathering** | `a_leaf_stops_at_its_budget_and_a_rerun_with_the_rest_is_identical` |
| 41 | Exact sums truncated instead of rounded to nearest | `exact::tests::rounding_is_exact_on_known_cases` |

Mutant 28 was rewritten for the new call it mutates (`query_range_expr` with the
aggregation hook) and is killed as before, now also by the limit replay test. Partial
results counted twice on a retry, the tail evaluated apart from the lake, a per-leaf
budget not passed, and the cardinality mutants live in the Worker and are in `query/`'s
mutation check.

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
`engine/storage`. Three additive hooks in `engine/promql`, each tested there, all of its
tests green (27, was 26; it was 24 before the first two):

1. `SelectorInfo` gained `pub steps: usize`, the number of evaluation steps of the
   (sub)query the selector belongs to (`src/api.rs`, set in `src/lib.rs`
   `walk_selectors`). Not serialised. Needed for `max_step_points`.
   Test: `selectors_report_the_step_count_of_their_subquery`.
2. `promqltest::run_script_with_source(script, opts, factory)` and the type
   `SourceFactory` (`src/promqltest.rs`): run a test script through any `SeriesSource`
   built from the loaded series. `run_script` is unchanged in behaviour (it calls the
   same code with no factory). Needed to run the corpus through storage.
   Test: `test_scripts_can_run_through_another_source`.
3. `EvalHooks` (`replace` a node's value, supply an aggregation's result), `SeriesV` made
   public, `parse_query`, `query_range_expr`, `query_instant_expr`
   (`src/eval.rs`, `src/lib.rs`). With no hooks the evaluator is unchanged. Needed for the
   order-independent aggregations and for finishing a split query at the coordinator.
   Test: `evaluation_hooks_replace_nodes_and_aggregations`.

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

- **A resolved query parses labels twice in a split.** The coordinator's `sample_plan` parses
  every label set of the metric in the window, and each split reader's extract parses its
  series files' again; one place avoids the second parse with the carrier, a split does not.
- **Partial reads rest on the planners.** A row group left out of a sparse file is skipped
  without an error; `may_hold`, `part_sids` and `strays` are what make that safe (property
  tests and mutants above and in `engine/storage`).

- **Split execution reads whole files per part** (see "Split execution": `L`-fold reads and
  `series_id` decodes). Fine for a few parts; the fix is row-group reads by key range.
- **The cardinality merge is quadratic in parts.** `Summary::merge` rebuilds its hash maps
  for every part it merges: measured natively at 1,000,000 unique label values, 5.3 s over 8
  parts and 18.6 s over 32, 280 to 288 MiB. The query Worker's caps keep it far below that
  (`maxCardinalityPairs` 400,000); a streaming merge of sorted summaries is the fix
  (`query/CARDINALITY.md`).
- **`catalog.rs` reads a format storage owns.** If `metric_series` changes, both readers
  must; `split_equals_one_place` would catch a divergence for queries.
- **Exact sums are wider than floats.** A partial's sum of values spread over many powers
  of two holds more words (at most 34; sums of squares 67); measured sizes are in
  `query/` README.
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
src/prune.rs      files_needed, scan_rows: file pruning from the ledger's index fragments
src/error.rs      QueryError, ErrorType, Limit
src/agg.rs        order-independent aggregations: partial, merge, finish, Canonical, binary encoding
src/exact.rs      exact sums and variances of f64 (big integers, rounded once)
src/split.rs      split execution: split_plan, extract, split_tails, Gathered, leaf_evaluate, merge
src/catalog.rs    series-only read of metric_series files
src/cardinality.rs  the cardinality report (exact counting with caps)
tests/split.rs       split equals one place (property), partial merge (property), rules, budgets, limit replay
tests/common/     write histories, storage layouts, generators, the query pool
tests/invariance.rs  storage-location invariance (property), source equality, pool liveness
tests/staleness.rs   markers in the tail and in Parquet
tests/corpus.rs      upstream promqltest corpus through storage
tests/plan.rs        exact ranges, soundness (property), tightness
tests/prune.rs       file pruning: soundness (property), exact rules, unparsable fragments
tests/limits.rs      every limit, pathological nesting, depth estimate (property)
tests/api.rs         JSON shapes and units, errors, metadata, de-duplication
examples/bench.rs    the benchmark (timed loop, counting allocator)
examples/stack_probe.rs  stack needed for a nested query
examples/reference.rs    expected results for query/'s end-to-end tests: viz-promql over its in-memory source
wasm/             whole-engine cdylib (size probe, load proof)
patches/          web-time, js-sys, wasm-bindgen stand-ins for a glue-free module
tools/wasm_check.mjs   loads the module with an empty import object and runs queries
tools/wasm_sizes.mjs   code size by crate from an unstripped build
tools/mutants.py       mutation check (on a scratch copy)
examples/cardinality.rs  high cardinality: storage, the cardinality report and a query at 10k, 100k, 1M series
```

The crate has its own `[workspace]` table so that it builds standalone next to its
siblings.
