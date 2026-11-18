# 06 — Query engine state of the art (PromQL, TraceQL, serverless execution)

Research date: 2026-11-18. Scope: what viz needs to know to build a PromQL + TraceQL (+ LogQL-ish) query engine that runs in Cloudflare Workers over Iceberg/Parquet on R2.

**Web access note.** Web search and fetch worked for most of the session, then the shared search budget ran out. Everything tagged **[V]** was confirmed against a page fetched today (source listed at the end). Everything tagged **[TK]** is training knowledge (cutoff mid-2026) that I could not re-verify today; treat it as a strong prior, not a fact. Topics that ended up entirely [TK] because the budget ran out: Starling/Lambada/Flock paper details, Snowflake pruning paper numbers, Tempo's internal fetch-layer API, Loki internals, OpenObserve/Parseable/Databend/CnosDB/Oxla PromQL status, Cloudflare Containers cold-start times and pricing.

---

## 0. Decision summary

1. **Write the engine in Rust, compile to WASM for Workers and natively for Containers.** One crate, two targets. TypeScript only for the orchestration shell (routing, auth, fan-out, caching, DO coordination).
2. **Do not embed DataFusion or DuckDB in the Worker.** Build a small purpose-built operator set (MQE-style series-at-a-time streaming at the leaves, Thanos-style partial-aggregate pushdown across leaves) on `arrow-rs`/`parquet` + the `promql-parser` crate. DataFusion is the right tool in a Container, and Basin SQL (formerly R2 SQL) already offers DataFusion-over-Iceberg as a managed service for ad-hoc SQL.
3. **Reuse the PromQL parser, build the evaluator.** `promql-parser` 0.9.x tracks Prometheus 3.8+ syntax. No reusable PromQL evaluator exists in Rust or TS outside GreptimeDB's DataFusion-coupled one.
4. **TraceQL has no Rust parser; write one** (hand-written Pratt parser ported from Tempo's `expr.y`). `@grafana/lezer-traceql` covers editor needs only.
5. **Two-level execution: coordinator → leaf scan workers returning partial aggregates** as Arrow IPC. Shard by time split × series-hash bucket. Anything not decomposable falls back to a Container running the same engine natively.
6. **Iceberg immutability makes leaf results perfectly cacheable.** Cache partial aggregates keyed on (plan-fragment hash, data-file set, step-aligned time split); this is a better cache than the Mimir-style extent cache alone.
7. **Compliance is a test-harness problem, solved early.** Port the `promqltest` DSL runner to Rust, run `prometheus/compliance` (539 queries) differentially against a real Prometheus 3.x, add generated-query fuzzing. GreptimeDB's 3-year curve (13% → 82% → ~95% ignoring `__name__`) is the realistic trajectory for a from-scratch engine.
8. **Latency target for a dashboard panel:** p50 ≤ 300 ms warm, p95 ≤ 1.5 s, with the budget dominated by R2 range-read TTFB, not CPU.

---

## 1. PromQL semantics that drive implementation

### 1.1 Data model and evaluation model

- Four value types: scalar, string, instant vector, range vector. Only instant vectors (and scalars) can be returned from a range query. [TK]
- A **range query is defined as N independent instant queries** at `start, start+step, …, ≤ end`. Every optimization (step batching, streaming, sharding, caching) must be observationally equivalent to that definition. [TK]
- **Instant vector selector** at time T returns, per series, the most recent sample at or before T, only if it is less than the lookback period old. Default lookback is 5 minutes; configurable per server (`--query.lookback-delta`) and per request (`lookback_delta` parameter). [V]
- **Staleness.** A series that disappears is marked stale and stops being returned immediately rather than lingering for the lookback period. [V] The marker is a specific NaN bit pattern (`0x7ff0000000000002`), distinct from the ordinary NaN. [TK] Implementation consequences for viz:
  - The value column must preserve NaN payload bits end to end. Any layer that canonicalizes NaN (some Parquet writers, JS `Float64Array` round trips through `Number` are safe, JSON is not) destroys staleness.
  - Parquet min/max statistics on a column containing NaN are unreliable, so never prune on the value column.
  - OTLP-ingested data has no scrape loop, so staleness markers only exist if the ingest path synthesizes them. Without them, every disappearing series lingers for 5 minutes in instant selectors. Decide this at ingest design time.
- **Range selectors are left-open, right-closed** since Prometheus 3.0: `m[5m]` at T selects samples in `(T-5m, T]`. [V] A sample exactly on the left boundary is excluded. Getting this wrong fails many compliance cases.

### 1.2 Step alignment

- Prometheus does not align `start` to `step`; it evaluates exactly at `start + k·step`. [TK] Grafana aligns start/end to multiples of step before sending, which is what makes result caching effective. [TK]
- Cache-friendly frontends (Cortex, Mimir, Thanos query-frontend) only cache/split when the request is step-aligned, or optionally align it themselves (a visible semantic change). [TK]
- Prometheus 3.15 fixed subqueries evaluating past the parent's last step when `end` is not aligned to `step`. [V] This is the kind of edge the compliance corpus exercises.

### 1.3 rate / increase / delta

- `rate()` computes the per-second average increase over the window, adjusts for counter resets, and **extrapolates to the window edges**. `increase()` is `rate() × window seconds`, so it returns non-integers for integer counters. [V]
- Extrapolation rule [TK]: with first/last sample at `t_first`/`t_last` in the window, extrapolate to each boundary if the gap to that boundary is less than 1.1× the average sample interval, otherwise by half an average interval; for counters, never extrapolate below zero. Requires ≥ 2 samples in the window.
- **Counter reset**: any decrease between adjacent samples adds the previous value to a running correction. [TK] For native histograms the reset logic also looks at bucket-level decreases and the counter-reset hint. [TK]
- **New in 2026: `anchored` and `smoothed` modifiers are stable and always on as of Prometheus 3.16.0 (2026-11-04).** [V]
  - `anchored`: uses the most recent sample within the lookback delta at the range start (or the first in-range sample), and the last in-range sample at the end; no extrapolation or interpolation. Valid with `resets`, `changes`, `rate`, `increase`, `delta`. `increase` on integer floats returns integers. [V]
  - `smoothed`: linearly interpolates at both boundaries using the samples before and after, so it needs a sample *after* the evaluation interval. Valid with `rate`, `increase`, `delta` on range selectors, and on instant selectors. Not supported for subqueries. [V]
  - Engine consequence: the sample fetch window is no longer `(T-range, T]`. Anchored needs `lookback` extra on the left; smoothed needs lookback on both sides. The leaf scan contract must take an explicit `(left_pad, right_pad)` rather than deriving it from range alone.
- **Start timestamps** (`use-start-timestamps` flag, 3.16): counter-reset detection from created/start timestamps, overridable per request with `X-Prometheus-Use-Start-Timestamps`. [V] viz ingests OTLP, which carries `StartTimeUnixNano` on every cumulative point, so storing it is cheap and future-proof.
- **Delta temporality** (`otlp-native-delta-ingestion`): upstream guidance is to query deltas with `sum_over_time()`, not `rate()`. [V] viz must record temporality per series (the `__type__`/`__unit__` reserved labels from `type-and-unit-labels` are the upstream direction [V]).

### 1.4 Modifiers and subqueries

- `offset` shifts evaluation time (negative offsets look ahead). `@ <ts>` pins evaluation time; `@ start()` / `@ end()` resolve to the range bounds and are constant across steps. Order of `@` and `offset` does not matter; offset is relative to the `@` time. [V]
- **`@` makes a subexpression step-invariant**: evaluate once, broadcast across steps. Prometheus wraps such nodes in a `StepInvariantExpr`. [TK] It also breaks time-splitting and extent caching for that subtree, so the planner must detect it.
- **Subquery** `<expr>[range:resolution]`: evaluates the inner instant expression at timestamps aligned to *absolute multiples of the resolution* (not to the outer step), producing a range vector. [TK] Resolution defaults to the global evaluation interval. [V] Subqueries are the main source of non-streamable, memory-hungry plans; 3.16 added a targeted optimization that selects only the fixed window for `@`-modified subqueries. [V]
- **Duration expressions**: arithmetic in durations, `step()`, `range()`, `min_of()`, `max_of()` (the functions are experimental). Not allowed in `@`. [V]

### 1.5 Vector matching and aggregation

- Binary operators between vectors: one-to-one by default on all labels; `on()`/`ignoring()` restrict the match key; `group_left`/`group_right` allow many-to-one with optional label copying. Duplicate matches on the "one" side are an error. Set operators `and`/`or`/`unless`. Comparison operators filter unless `bool` is given. [TK]
- New experimental `fill()`, `fill_left()`, `fill_right()` modifiers supply defaults for missing matches (`promql-binop-fill-modifiers`). [V]
- `__name__` is dropped by most functions and arithmetic. `promql-delayed-name-removal` defers that to the end of evaluation. [V] GreptimeDB's compliance table shows how much this single behavior matters: 54% pass including `__name__`, 95% ignoring it. [V]
- Aggregations: `sum, avg, min, max, count, group, stddev, stdvar, topk, bottomk, quantile, count_values`, plus `limitk` and `limit_ratio` [TK for the last two; `promql-parser` 0.9.0 lists them as supported, V].
- Float summation: Prometheus uses Kahan/Neumaier compensated summation in `sum`/`avg`. [TK] A distributed engine that sums partials in a different order produces last-bit differences; the compliance tester compares with a small tolerance, but `promqltest` expectations can be exact. Use compensated summation at every level and carry the compensation term in the partial.

### 1.6 Histograms

- **Classic histograms**: `histogram_quantile(φ, sum by (le, …)(rate(x_bucket[5m])))`. Requires grouping all `le` series of one histogram together, linear interpolation inside the bucket, monotonicity fix-ups, and special cases for `+Inf`. [TK]
- **Native histograms are stable since Prometheus 3.8** (scraping is opt-in via `scrape_native_histograms`; the old feature flag is a no-op from 3.9). [V] Exponential schemas, custom-bucket (NHCB) schema, float and integer flavors, counter-reset hints. [TK]
- Functions: `histogram_quantile`, `histogram_quantiles` (experimental), `histogram_fraction`, `histogram_avg`, `histogram_count`, `histogram_sum`, `histogram_stddev`, `histogram_stdvar`. [V] A third-party post reports 3.11 added `</` and `>/` trim operators for native histograms. [V, secondary source]
- Engine consequence: the sample value type is a sum type (float | histogram) from day one, even if the histogram arm is unimplemented at first. Retrofitting it into kernels later is expensive. ClickHouse's 2026 PromQL preview shipped without native histograms and lists them as planned [V], which is a reasonable phase-1 precedent.

### 1.7 Experimental surface (as of 3.16)

Behind `promql-experimental-functions` [V]: `info()`, `start()`, `end()`, `range()`, `step()`, `double_exponential_smoothing()`, `integral()` (new in 3.16), `histogram_quantiles()`, `min_of()`, `max_of()`, `sort_by_label()`, `sort_by_label_desc()`, `mad_over_time()`, `ts_of_{min,max,first,last}_over_time()`. `first_over_time()` has been promoted to stable. [V]

`info(v, {selector})` joins `target_info` (or another info metric) on `job`/`instance` and adds its data labels. It remains experimental and may change or be removed. [V] It matters to viz more than to most systems: OTLP resource attributes become `target_info` in Prometheus's model, and viz stores resource attributes natively, so `info()` can be a cheap dictionary lookup rather than a join.

Other flags worth tracking: `promql-unquoted-utf8-names`, `promql-per-step-stats`, `query-cost`. [V]

### 1.8 HTTP API surface

All under `/api/v1` [V]:

| Endpoint | Notes for viz |
|---|---|
| `GET/POST /query` | `query, time, timeout, limit, lookback_delta, stats`. With `query-cost`: `cost`, `max_series`, `max_samples_read`, `max_query_duration`. |
| `GET/POST /query_range` | plus `start, end, step`. |
| `/query_cost`, `/query_range_cost` | New, behind `query-cost`: returns `seriesTouched`, `samplesRead` estimate without executing. A natural fit for a metadata-driven planner. |
| `/format_query` | Pure parser round trip; `promql-parser` has a prettifier. |
| `/parse_query` | Experimental; AST as JSON for the UI. |
| `/query_exemplars` | Experimental; `query, start, end`. |
| `/series` | `match[]` required, `start, end, limit`. |
| `/labels`, `/label/<name>/values` | `match[], start, end, limit`; UTF-8 names escaped with `U__`. |
| `/metadata` | `metric, limit, limit_per_metric`. |
| `/search/{metric_names,label_names,label_values}` | Experimental (`search-api`), NDJSON streaming, fuzzy matching. |
| `/status/buildinfo`, `/status/tsdb`, `/features` | Grafana probes `buildinfo`; `/features` (3.8+) advertises capabilities. |
| `/rules`, `/alerts` | Only if viz runs a ruler. |
| `POST /read` | Remote read (snappy protobuf; streamed chunk variant). Low priority; needed only for federation into Thanos-like systems. |
| `POST /write`, `/otlp/v1/metrics` | Ingest side. |

Minimum for Grafana's Prometheus datasource: `query`, `query_range`, `series`, `labels`, `label/…/values`, `metadata`, `status/buildinfo`, `query_exemplars`. [TK]

Response format: JSON `{"status","data":{"resultType","result"},"warnings","infos"}`; sample values are strings; native histograms use a nested bucket-array form. [TK] Annotations (warnings/infos) are part of the compliance surface in `promqltest`.

### 1.9 Compliance tooling

- **`prometheus/compliance` (`promql/`)**: the former PromLabs tester, donated to the Prometheus project. Runs each query against a reference Prometheus and the target, then diffs results. [V] The current corpus is 539 queries (per GreptimeDB's published table). [V]
- **`promqltest`**: Prometheus's own test DSL (`load 5m` series notation, `eval instant at …`, `eval range from … to … step …`, `expect` annotations/ordering) and the `.test` files under `promql/promqltest/testdata`. [TK] Thanos-engine and Mimir both run this corpus against their engines. [TK]
- **"promql-compat"**: GreptimeDB's docs cite a tool by this name (revision `1203cd8`) that reports three suites: the Prometheus test corpus (2,243 cases, 1,391 excluded for them), the 539 compliance queries, and ~2,000 generated queries. [V] I could not locate the repository today; find it before building an equivalent.
- Historical scores for context (PromLabs, 2021): Thanos 100%, VictoriaMetrics 74%. [V] No current public scoreboard was found.

---

## 2. Engines

### 2.1 Prometheus engine

Tree-walking evaluator. For a range query it selects all series for all selectors up front, then evaluates the expression across all steps, materializing a `Matrix` per node. [TK] Simple and the reference for semantics, but peak memory is proportional to (series × steps) per node. Limits: `--query.max-samples` (50M default), `--query.timeout`, `--query.max-concurrency`. [TK] 3.16 adds experimental cost estimation and enforced `query_max_series` / `query_max_samples_read` / `query_max_duration`. [V]

### 2.2 thanos-io/promql-engine

- Volcano/iterator model, multi-threaded. A query compiles to a physical plan of operators; each `Next()` returns a batch of **step vectors** (all series' samples at one timestamp). [V]
- Samples are decoded and held in batches of steps, so peak memory depends on batch width, not range length. `Series()` gives every operator its output label sets up front, enabling integer-indexed series. [V]
- Inter-operator parallelism plus intra-operator selector sharding merged by a coalesce exchange. [V]
- Logical plan with pluggable optimizers (some default, some opt-in) and user-defined operators. [V]
- **Distributed execution**: an optimizer rewrites the query into remote partial aggregations plus a local aggregation; remote engines are discovered per query. [V] Unsupported expressions return an "unimplemented" error so callers can fall back to the Prometheus engine. [V] Cortex has a proposal to run plan fragments on queriers this way, falling back to the Prometheus engine for unsupported fragments. [V]
- Gaps per README: `quantile_over_time` and `predict_linear` with non-constant arguments. [V] In Thanos it is still experimental and not the default. [V]

### 2.3 Mimir Query Engine (MQE)

- **Default in Mimir 3.0 (Nov 2025) for queriers and query-frontends.** [V] Grafana claims up to 92% lower peak memory than the Prometheus engine; an earlier talk reported ~80% faster and ~70% less memory. Vendor numbers. [V]
- Streaming: loads only the samples needed at each point rather than the whole selection. [V] Operators are **series-at-a-time**: each operator first declares its output series, then yields one series' data across all steps at a time, with per-query memory tracking and a hard memory limit. [TK]
- Since 3.0, planning happens in the frontend with MQE (pruning middleware moved into the engine, common-subexpression elimination exposed via metrics). [V] Sharding and splitting are moving from string rewriting to plan-level transformations with remote execution of plan fragments. [TK]

**Why MQE's shape matters for viz:** if Parquet files are sorted by `(metric, series_id, timestamp)`, a leaf worker can evaluate `rate(x[5m])` by streaming one series at a time with O(steps + window) memory, never holding more than one series' samples. The step-vector model needs all series' samples for a step batch at once, which fights that sort order.

### 2.4 VictoriaMetrics / MetricsQL

Independent implementation, not derived from Prometheus code. [V] Deliberate deviations: no extrapolation in `rate`/`increase` (uses the sample before the window instead), optional window (`rate(m)`), scalars treated as label-less vectors, NaNs dropped from output. [V] Internally uses per-series rollup functions over a time window with a rollup result cache. [TK]

Lesson: "PromQL-compatible with improvements" caps compliance around 75% and creates a long tail of dashboard and alert discrepancies. Its anchored-like `increase` semantics have now effectively been adopted upstream as an explicit `anchored` modifier, so viz can offer both behaviors while staying compliant.

### 2.5 GreptimeDB: PromQL → DataFusion logical plans

- Fully re-implements PromQL in Rust on Arrow/Parquet/DataFusion/OpenDAL. Binary operators become joins, range vectors become array slices, filters become `WHERE`, aggregations become `GROUP BY`. PromQL and SQL lower to the same logical plan, so `TQL` can be combined with SQL via CTEs. [V]
- Custom plan nodes (`SeriesNormalize`, `InstantManipulate`, `RangeManipulate`, `SeriesDivide`, …) implement lookback, range windows and per-series partitioning as DataFusion extension operators. [TK]
- **Compliance trajectory** [V]: 13% (Feb 2023) → 33% → 54% → 67% → 82% (Dec 2023). v1.3.0 against Prometheus 3.15: 94.8% of the 539 compliance queries ignoring `__name__` differences, 54% including them; 88.5% of the counted Prometheus test corpus; 93% of generated queries. Known gaps: `first_over_time`, `vector(time())`, `scalar()` as parameter, selectors without a metric name, millisecond-only timestamps, several validation differences.
- **`promql-parser` crate** [V]: pure Rust port of the Prometheus yacc grammar; 0.7.0 added Prometheus 3 syntax (UTF-8 names); 0.7.4 declares compatibility with Prometheus 3.8; 0.9.0 adds `fill*()` binop modifiers, `limitk`/`limit_ratio`, a mutable visitor and declarative function definitions. Used by GreptimeDB and OpenObserve; >300k downloads.

Lessons: the SQL-plan route gives an optimizer, `EXPLAIN ANALYZE` and distribution for free, but name handling, validation errors and annotations take years to converge. The table-per-metric model is the root of the "selector without metric name" gap.

### 2.6 ClickHouse native PromQL (new in 2026)

- Private preview on ClickHouse Cloud announced 2026-09-16; experimental in ClickStack since mid-2026. [V]
- PromQL is evaluated inside the server on the `TimeSeries` table engine, shared by the Prometheus HTTP API, remote read, a `promql` dialect in `clickhouse-client`, and `prometheusQuery()` / `prometheusQueryRange()` SQL table functions. [V]
- Stated approach: convert PromQL into "performant SQL"; details deferred. Coverage "above 85%". Not yet supported: native histograms, `count_values`, remote-write v2, OTLP into `TimeSeries`, PromQL alerting. [V]

### 2.7 Others

| System | Status | Tag |
|---|---|---|
| InfluxDB 3 | DataFusion-based SQL + InfluxQL. No evidence of a PromQL engine found today. | [V: nothing found] |
| OpenObserve | Rust, uses `promql-parser`; own evaluator over DataFusion-read record batches. | [V] for parser use, [TK] for the rest |
| Chronosphere / M3 | M3Query was an independent Go implementation; Chronosphere later moved to upstream-engine-derived evaluation for compatibility. | [TK] |
| Parseable, Databend, CnosDB, Oxla | Not verified today. I am not aware of production-grade PromQL in any of them. | unverified |
| oteldb (go-faster) | Go; runs PromQL/TraceQL/LogQL over ClickHouse; uses a fork of thanos promql-engine and its own TraceQL parser; maintains a compliance-tester fork. | [V] for parser/fork existence |
| Coremetry | Go PromQL evaluator over a ClickHouse-backed store. | [V, existence only] |

**"PromQL to SQL" translation** as a general approach: feasible for the selector → range function → aggregation core (window functions or array slicing by step bucket), poor for lookback/staleness, extrapolation, subqueries, vector matching errors and annotations. Every serious implementation ends up with custom operators inside the SQL engine (GreptimeDB, ClickHouse) rather than plain SQL text. [TK, consistent with the V facts above]

### 2.8 Parsers and JS/TS implementations

| Component | Language | Use for viz |
|---|---|---|
| `promql-parser` (GreptimeTeam) | Rust | **Reuse.** AST + prettifier, Prometheus 3.8+ syntax. Check coverage of 3.16 syntax (anchored/smoothed, duration expressions, unquoted UTF-8) before committing; fork if behind. |
| `@prometheus-io/lezer-promql`, `@prometheus-io/codemirror-promql` | TS | **Reuse in the UI** (highlighting, linting, autocomplete). Lezer gives a concrete syntax tree, not a typed AST; unsuitable as the engine front end. |
| `rusty-promql-parser` (nom), `rust-promql-parser` (pest) | Rust | Alternatives; less complete. |
| `metricsql` (ccollie) | Rust | MetricsQL port; useful reference for rollup kernels. |
| JS/TS PromQL **evaluator** | — | **None found.** Only parsers, builders (`tsqtsq`) and editor tooling. |
| Prometheus engine compiled to WASM (Go → wasm) | Go | Possible in principle, but Go WASM binaries are large, GC-heavy, and the engine assumes the `storage.Querier` pull model with everything in memory. Not recommended as the production path; viable as an **in-CI oracle**. [TK] |

### 2.9 Which approach fits WASM-in-Worker

Constraints, all verified today against the Workers limits page [V]: 128 MB per isolate including WASM memory; CPU 30 s default, up to 5 min; 64 MiB uncompressed bundle; **global scope must start within 1 second**; 10,000 subrequests default (configurable to 10M since Feb 2026); **only six connections may be waiting for response headers at once per invocation**.

| Option | Fit | Why |
|---|---|---|
| DataFusion in Worker WASM | Poor | Builds for `wasm32-unknown-unknown` exist (`datafusion-wasm`, DataFusion's `wasmtest`), but only the in-memory object store works there, compression codecs are awkward to cross-compile, and no one publishes a size. [V] Expect tens of MB and a real risk against the 1 s startup limit. [TK estimate] Its hash-aggregate/join operators assume memory headroom viz does not have. |
| DuckDB-WASM in Worker | Poor | ~36 MB binary (~12 MB gzipped) per one packaging project. [V, third-party] No PromQL; memory model not built for 128 MB. |
| chDB | No | Native only; Containers at best. [TK] |
| Polars | Poor | Compression codecs hard to build for wasm32. [V] |
| Go engines (Prometheus, Thanos, MQE) → WASM | Poor | Size, GC, goroutine runtime. [TK] |
| **Custom Rust operators on `arrow-rs` + `parquet`** | **Good** | `parquet` and `object_store` build on wasm32 since arrow-rs PR #2896. [V] Small (low single-digit MB achievable with a trimmed feature set [TK estimate]), explicit memory control, same crate runs natively. |
| TypeScript evaluator | Mediocre | No WASM boundary and easy to debug, but no SIMD, GC pressure on Float64 paths, no existing Parquet decoder of `arrow-rs` quality, and it cannot be reused natively in a Container. |

Recommendation: **MQE's execution shape, Thanos's distributed rewrite, GreptimeDB's parser, hand-built in Rust.**

---

## 3. Query frontends

What Cortex/Mimir/Thanos/Loki frontends do, and how each piece maps to viz.

### 3.1 Time splitting

Split a range query at fixed interval boundaries (24 h by default in Mimir), run pieces in parallel, concatenate. [V for Mimir's `split-queries-by-interval`] Correct because each step is an independent instant query. Pieces must start on step-aligned boundaries, and each piece's *sample fetch* extends left by range + offset + lookback (and right, for `smoothed`). Not applicable to subtrees pinned with `@`. [TK]

viz: split boundaries should coincide with the Iceberg time partition (hour or day) so a split maps to a file set.

### 3.2 Result caching

- **Step-aligned extent cache** (Cortex/Mimir/Thanos): key = tenant + query + step (+ split interval index); value = list of extents `[start, end]` with data. On a request, reuse covered extents, query the gaps, merge, write back. Only for step-aligned requests. Skip the most recent window (Mimir `max-cache-freshness`, default 10 m) because out-of-order and late data still arrive. [TK]
- Mimir also caches cardinality estimates, label queries, and (newer) results of split instant-query pieces. [TK]

viz can do better because the data layer is immutable:

1. **Leaf partial cache**: key = hash(plan fragment, step, aligned split, *set of data-file paths*). A compacted or newly committed partition changes the file set and thereby the key; no TTL, no invalidation logic. Hit rate for dashboards on auto-refresh approaches 100% for everything except the newest split.
2. **Final result cache** for identical requests within a short TTL (dashboard viewed by many users).
3. **Negative/empty cache**: "no series match in this split".

Cloudflare placement: the Cache API is per-colo and best-effort [TK]; R2 is global and strongly consistent; KV is global, eventually consistent. Use Cache API as L1 (free, near the leaf) and R2 (or KV for small values) as L2. Cache API limits: 512 MB per object, calls count against the subrequest quota. [V]

### 3.3 Sharding by series hash

Mimir rewrites each shardable portion into N partial queries carrying `__query_shard__="i_of_N"`, runs them in parallel and merges with a `concat` step. Controls: `query-sharding-total-shards`, `query-sharding-max-sharded-queries` (default 128, applied after time splitting: an 8-day query with 24 h splits gets 16 shards per day). [V] Shard count can be reduced using cached **cardinality estimates** (`query-sharding-target-series-per-shard`), experimental; estimates only ever reduce the count. [V]

viz: make the shard physical. An Iceberg `bucket(N, series_id)` partition (or files sorted and range-split by series hash) turns `i_of_N` into a file-set selection. No per-series hash filter at read time.

### 3.4 Aggregation pushdown: what is decomposable

Assumption for the table: **each series lives in exactly one shard** (hash sharding), and time splits never divide a step's window.

| Operator | Leaf partial | Merge | Exact? |
|---|---|---|---|
| `sum` | sum (+ Kahan compensation) | sum | Yes, modulo float order; carry compensation |
| `count`, `group` | count / presence | sum / or | Yes |
| `min`, `max` | min / max | min / max | Yes (NaN rules must match) |
| `avg` | (sum, count) | sum/sum | Yes; never average averages. Mimir lists `avg` as shardable. [V] |
| `stddev`, `stdvar` | (count, mean, M2) or (n, Σx, Σx²) | Welford merge | Yes mathematically; Σx² form loses precision |
| `count_values` | map value→count | add maps | Yes; unbounded cardinality |
| `topk` / `bottomk` over raw series | per-shard top-k per step | top-k of union | Yes, *only* because each series is in one shard. Per-step evaluation means the union across steps can be large. |
| `topk(k, sum by (g)(…))` | inner `sum by (g)` partials | merge sums, then top-k | Yes; pushing top-k below the merge is wrong unless shards are partitioned by `g` |
| `quantile` | — | — | **Not decomposable.** Options: ship all group members' values per step to the coordinator (exact, bounded by series count); or sketches (t-digest/DDSketch/KLL), which are approximate and break compliance. Default to exact; offer sketches as an opt-in hint. |
| `histogram_quantile(φ, sum by (le,…)(rate(…)))` | inner `sum by (le, …)` | merge, then quantile at coordinator | Yes. Mimir does exactly this. [V] |
| Native histogram `sum` | histogram partials | bucket-wise add with schema reconciliation | Yes [TK] |
| `absent`, `absent_over_time`, `sort`, `sort_desc` | inner parts only | coordinator | Mimir marks these not shardable as whole queries. [V] |
| Binary op `A / B` | shard A and B independently | join at coordinator | Each side sharded separately. [V] Pushing the join down requires both sides co-partitioned on the match key; skip in v1. |
| Subqueries, `@`-pinned subtrees | — | — | Do not shard/split in v1; evaluate at coordinator or in a Container. |
| `label_replace`/`label_join` under an aggregation | fine at leaf | — | Yes, they are per-series |

Loki additionally shards some non-decomposable operators probabilistically (count-min sketch for `topk`) as opt-in approximations. [TK]

### 3.5 Instant-query splitting

Mimir splits instant queries with large range selectors (e.g. `sum(rate(x[7d]))`) into per-interval partials for functions that compose over time: `sum_over_time`, `count_over_time`, `min/max_over_time`, `rate`/`increase` (as sums of increases with careful boundary handling), `avg_over_time` via sum/count. [TK] Useful for viz because SLO-style queries over 7–30 days would otherwise make one leaf scan weeks of data. The rewrite is not exact for extrapolated `rate`; use it only where exact (the `*_over_time` family) unless the query uses `anchored`, where boundary samples make window composition exact. [TK reasoning]

### 3.6 Limits, fairness, blocking

Standard set [TK unless marked]:

- Per-tenant: max series per query, max samples/chunks/bytes fetched, max query length (time range), max lookback, max partial queries (parallelism), max concurrent queries, query timeout, max output points per series (Prometheus caps range queries at 11,000 points).
- Fairness: per-tenant queues with round-robin dequeue in the scheduler; Mimir adds querier shuffle-sharding and separate queues by query component.
- **Query blocking**: per-tenant list of exact or regex query patterns rejected at the frontend (Mimir `blocked_queries`), plus Loki's blocked queries by hash. 
- **Cost estimation before execution**: Prometheus 3.16's `query_cost` endpoints return `seriesTouched`/`samplesRead` estimates and enforce `query_max_series`, `query_max_samples_read`, `query_max_duration`. [V] Basin SQL bills on compressed bytes scanned ($2.50/TB, 10 MB minimum per query). [V]

viz has an advantage: Iceberg manifests give row counts and byte sizes per file before reading any data, so the planner can compute an upper bound on bytes scanned and rows touched for free and reject or downgrade (coarser step, sampling) before fan-out. Enforce limits in three places: planner (bytes/files/leaves), leaf (rows decoded, CPU ms, memory high-water mark), coordinator (series × steps cells).

Fairness on Cloudflare: one Durable Object per tenant as the admission controller (token bucket on concurrent leaves and bytes scanned per minute). It keeps tenants from starving each other on the account-wide subrequest and R2 rate ceilings.

---

## 4. TraceQL

### 4.1 Language [TK unless marked]

- **Spanset filter** `{ … }`: boolean expression over one span. A query returns traces with the matching spans (spanset) per trace.
- **Scopes**: `span.`, `resource.`, `event.`, `link.`, `instrumentation.`; unscoped `.attr` searches span and resource (slower; always scope attributes [V]).
- **Intrinsics**: `span:duration`, `span:name`, `span:status`, `span:statusMessage`, `span:kind`, `span:id`, `span:parentID`, `span:childCount` (native storage in 2.10 [V]), `trace:duration`, `trace:rootName`, `trace:rootService`, `trace:id`, `event:name`, `event:timeSinceStart`, `link:traceID`, `link:spanID`, `instrumentation:name`, `instrumentation:version`. Legacy unscoped forms (`duration`, `name`, `status`, `kind`, `rootName`, …) still parse.
- **Operators**: `= != > >= < <= =~ !~`, arithmetic, `&& ||`; `= nil` / `!= nil` for attribute absence and `minInt`/`maxInt` constants (2.10 [V]). In Tempo 3.0, on arrays `!=` means NOT IN and `!~` means MATCH NONE (breaking change) [V].
- **Spanset combinators**: `{A} && {B}` (both exist in the trace), `{A} || {B}`.
- **Structural**: `>` child, `>>` descendant, `<` parent, `<<` ancestor, `~` sibling; negated `!>`, `!>>`, `!<`, `!<<`, `!~`; union forms `&>`, `&>>`, `&<`, `&<<`, `&~` (return both sides).
- **Pipelines**: `{…} | count() > 3`, `avg(span:duration)`, `min/max/sum(…)`, `by(attr)`, `coalesce()`, `select(attr, …)`.
- **Hints**: `with(most_recent=true)`, `with(exemplars=…)`, sampling hints below.

### 4.2 TraceQL metrics

GA in Tempo 3.0 (2026-06-01), enabled by default, no longer depends on the metrics-generator. [V]

- First stage [V]: `rate()`, `count_over_time()`, `sum_over_time()`, `min_over_time()`, `max_over_time()`, `avg_over_time()`, `quantile_over_time(attr, q…)`, `histogram_over_time(attr)`, `compare()`, each with optional `by(…)`.
- Second stage [V]: `topk(k)`, `bottomk(k)` (evaluated per data point, so more than k series can be returned overall), comparison filters (`> >= < <= = !=`, added in 3.0), and arithmetic between parenthesized metrics queries (`({…}|rate()) / ({…}|rate())`). Division by zero yields NaN; integer-only scalar arithmetic stays integer.
- `compare({selection}, topN, start, end)` [V]: splits spans into selection vs. baseline and returns per-attribute value counts labelled `__meta_type` = `selection`/`baseline`; `topN` 1–1000 (default 10); overflow signalled by `__meta_error="__too_many_values__"`. Usually an instant query; drives Traces Drilldown. Cannot be combined with arithmetic, comparisons or topk.
- Sampling hints [V]: `with(sample=true)` (adaptive), `with(sample=0.x)`, `with(span_sample=0.x)`, `with(trace_sample=0.x)`. Tempo 3.1 (2026-09-30) adds experimental `with(extrapolate=true)`, scaling each span by 1/sampling-probability from W3C tracestate.
- Limits [V]: default max range 24 h for metrics queries (168 h for search); `query_backend_after` (15 m) separates live-store from object storage.
- `quantile_over_time` is computed from log-scale histogram buckets (a `__bucket` label) so partials merge exactly as counters; the final quantile is interpolated at the frontend. [TK] This is the pattern to copy: a mergeable representation chosen by the language designers.
- Exemplars: leaves attach a bounded number of (trace ID, span ID, value, timestamp) per series; the frontend thins them. [TK]

### 4.3 How Tempo executes TraceQL

Verified today: the engine parses the query and extracts **flattened conditions** that the storage layer can act on; queries made only of `&&` conditions can be pushed down entirely into the Parquet layer and are much faster than queries with `||` or structural operators; only referenced columns are read; trace-level intrinsics and `resource.*` attributes live in much smaller columns; well-known attributes have dedicated columns (vParquet5: up to 20 string and 5 integer dedicated columns per scope); a 3.0 AST optimizer rewrites repeated conditions on one attribute into an array operation. [V]

From training knowledge of the code (`pkg/traceql`, `tempodb/encoding/vparquet*`) [TK]:

1. **Parse** (goyacc grammar `expr.y`) → AST → validate/type-check.
2. **Extract conditions**: each `(attribute, op, operands)` becomes a `Condition` in a `FetchSpansRequest`, with an **`AllConditions`** flag. True means every condition must hold on the same span (pure-AND query), so the storage layer may treat conditions as a conjunction and return exact matches. False means conditions are only hints (an OR-superset); storage returns candidate spans with the needed attribute values and the engine re-evaluates the full expression.
3. **Fetch layer** builds a tree of Parquet column iterators: per-column predicate iterators joined on (row number, definition level) with `JoinIterator` / `LeftJoinIterator`, ordered resource → span → attribute so cheap, selective columns drive the join. Dictionary-page and row-group statistics are used to skip pages. Output: spansets grouped by trace.
4. **Engine** evaluates the pipeline over spansets: full boolean logic, structural operators using the **nested-set model** (`nestedSetLeft`/`nestedSetRight`/`parentID` columns written at ingest, vParquet3+), aggregates, `by`, `coalesce`.
5. **Second pass**: only for spansets that survive, fetch the extra columns needed for `select()` and result metadata (root service/name, start, duration). This is late materialization applied to traces.
6. **Frontend** shards a search into jobs by block and row-group/page ranges (target bytes per job), dispatches to queriers, merges, and **stops early** once `limit` traces are found. Results stream to the client over gRPC as incremental diffs. `most_recent=true` forces deterministic newest-first results at the cost of scanning more.
7. **Metrics**: jobs sized by `target_bytes_per_job` with `concurrent_jobs` [V]; three aggregation tiers (raw at querier → sum at frontend merge → final), so partials are plain mergeable series. [TK]
8. **Trace by ID**: per-block trace-ID bloom filters (sharded) plus min/max ID to select blocks; inside a block, rows are sorted by trace ID, so row-group min/max and page index locate the trace; partial traces across blocks are combined and deduplicated. [TK]

Tempo 3.0 architecture [V]: distributors → Kafka → block-builders (Parquet blocks to object storage, RF1) and live-stores (recent data for queries); backend scheduler/worker replace compactors. TraceQL metrics read only RF1 blocks.

### 4.4 Parsers available

| Parser | Language | Notes |
|---|---|---|
| `grafana/tempo/pkg/traceql` (`expr.y`, goyacc + hand-written lexer) | Go | Reference. |
| `qualithm/traceql-syntax` | Go | Fork of Tempo's parser stripped of runtime dependencies. [V] |
| `go-faster/oteldb/internal/traceql` | Go | Independent parser + AST. [V] |
| `@grafana/lezer-traceql` | TS (Lezer) | Based on `expr.y`; v0.0.25; for editors. Maintenance looks thin. [V] |
| Rust | — | **None found** (the `trql` crate is unrelated). [V] |

Build a Rust parser: the grammar is small (roughly 150 productions), expression precedence is conventional, and the lexer's only subtlety is attribute names with dots/quotes and duration literals. Test it by running Tempo's `test_examples.yaml` and parser unit tests as a corpus. [TK for the corpus file name]

### 4.5 LogQL, briefly [TK]

- Log queries: stream selector `{app="x"}` + pipeline of line filters (`|=`, `!=`, `|~`, `!~`), parsers (`json`, `logfmt`, `pattern`, `regexp`, `unpack`), label filters, `line_format`/`label_format`, `drop`/`keep`, `decolorize`.
- Metric queries: `rate`, `count_over_time`, `bytes_rate`, `bytes_over_time`, `sum_over_time`/`avg_over_time`/`quantile_over_time`/`first|last_over_time` over `| unwrap`, then PromQL-style vector aggregations and binary operators.
- Structured metadata (Loki 3.x) maps well onto OTLP log attributes as columns.
- Execution: frontend splits by time and shards by stream; range aggregations are embarrassingly parallel per stream; `limit` + direction gives early termination, the same ORDER BY/LIMIT pattern as Basin SQL's planner.
- For viz: LogQL's metric half can share the PromQL vector-aggregation operators; its log half is a scan + filter + top-N-by-time, i.e. the simplest leaf. Parser: Loki's goyacc grammar; `@grafana/lezer-logql` for editors; no Rust parser I know of.

---

## 5. Serverless / disaggregated query execution

### 5.1 Research systems [TK]

- **Starling** (SIGMOD 2020): query execution on AWS Lambda with S3 as the only shared medium. Key ideas: a coordinator invokes stateless function tasks per stage; shuffles go through S3 objects (with a combining stage to reduce the reads×writes product); **straggler mitigation by duplicating slow S3 reads and writes** when a request exceeds its expected time; tuning tasks-per-stage trades cost against latency; competitive with provisioned warehouses for sporadic workloads.
- **Lambada** (SIGMOD 2020): purely serverless analytics. Key ideas: **tree-shaped invocation** so thousands of workers start in seconds (the driver invokes a first generation which invokes the rest); a scan operator tuned for S3 (few large range requests, column chunk level, connection reuse); exchange through S3 with careful file-count management.
- **Flock** (2021–22): Rust, DataFusion on Lambda for streaming SQL; passes Arrow batches as function payloads, function-to-function, avoiding external shuffle storage for small data.

Transferable rules: (1) no worker-to-worker shuffle if the plan can be shaped as scan → partial aggregate → merge; (2) two-level fan-out when the fan-out is wide; (3) hedge slow object reads; (4) the coordinator is the only stateful party.

### 5.2 Honeycomb Retriever

Time-ordered columnar segments (~1 GB), with min/max timestamps per segment for pruning; older segments live on S3. [V] For S3-resident data, Retriever fans out to Lambda: each function reads a group of segments, computes a **local partial result**, and returns it for merging. One source says one Lambda per segment, another roughly eight segments per Lambda; likely different eras. [V, conflicting] This is the closest production analogue to viz's design.

### 5.3 Snowflake-style pruning [TK]

Micro-partitions with per-column min/max metadata held in a separate metadata store, so pruning happens before any data file is opened. The 2025 SIGMOD paper "Pruning in Snowflake: Working Smarter, Not Harder" describes four techniques: filter pruning, **LIMIT pruning** (stop when fully-matching partitions already satisfy the limit), **top-k pruning** (maintain a boundary value from already-seen rows and skip partitions whose max cannot beat it), and join pruning (use build-side values to prune the probe side). It reports that the vast majority of micro-partitions are pruned across customer workloads.

Mapped to observability: filter pruning on (tenant, metric, time, series-hash bucket); LIMIT/top-k pruning for log and trace search ordered by time; join pruning for "trace IDs from a spanset filter → fetch full traces".

### 5.4 Engines one could embed or call

- **DataFusion / Ballista**: DataFusion is the standard embeddable Rust engine (InfluxDB 3, GreptimeDB, Basin SQL, OpenObserve all use it [V]). Ballista is its distributed scheduler/executor layer, built for long-lived executors and shuffle files; not a fit for isolates. [TK]
- **DuckDB**: `httpfs` + `iceberg` extensions read Iceberg tables from S3-compatible storage including R2 Data Catalog; excellent in a Container; the WASM build is large and single-threaded. [TK] DuckDB-WASM guidance is to stream results and project narrowly to stay within memory. [V]
- **chDB**: in-process ClickHouse; native only. If ClickHouse's native PromQL matures, `chDB` in a Container could become an off-the-shelf PromQL evaluator, but it expects the `TimeSeries` engine's own layout, not arbitrary Iceberg. [TK speculation]
- **Polars**: fast lazy engine; WASM build is not a supported path. [V for the codec issue]

### 5.5 Search systems on object storage

- **Quickwit**: each split carries a **hotcache**, a small blob containing exactly the byte ranges needed to open the index, and the split footer offset is stored in the metastore; searchers open a split in under 60 ms and stay stateless. [V] Their Lambda benchmark found that caching partial requests mattered more than caching split footers, because footer-cache gains were lost in S3 latency variance; a histogram aggregation averaged ~700 ms. [V]
- **turbopuffer**: object storage as source of truth, NVMe + memory cache in front; design goal of **at most ~3 object-storage round trips** for a cold query; published cold latency around 350–500 ms p50 on 1M documents vs single-digit ms warm. [V, mix of vendor and third-party numbers]

Transferable rules: store the metadata needed to plan a read *outside* the data file (Iceberg manifest + a footer sidecar); count round trips, not bytes; cold p50 of a few hundred ms is the realistic floor for object-storage-only reads.

### 5.6 Basin SQL (formerly R2 SQL)

**Renamed on 2026-10-01 at Basin GA**: "Basin SQL, formerly R2 SQL", querying Iceberg tables in Basin Catalog (formerly R2 Data Catalog). [V]

Architecture, from the September 2025 deep-dive [V]:

- **Planner** walks Iceberg metadata top-down: snapshot → manifest list (partition stats prune manifests) → manifests (column min/max/null counts prune files) → Parquet footers (row-group stats). Output: a list of (file, row group) **work units**.
- **Planning and execution overlap**: work units stream to executors as they are discovered.
- **ORDER BY … LIMIT early termination**: manifests are processed in order-by order; the coordinator keeps a bounded heap of the best N rows and a high-water mark derived from metadata of unprocessed files; when no remaining file can beat the heap, the pipeline stops.
- **Coordinator → query workers** over Cloudflare's network, selecting healthy servers, with **serialized Parquet metadata shipped alongside each batch** so workers never re-read footers.
- **Workers run Apache DataFusion**, one row group per DataFusion partition, column projection via R2 ranged reads, filter pushdown into the Parquet reader.
- **Results return as Arrow IPC** over gRPC.
- The post does not say whether workers run in the Workers runtime or elsewhere, and describes no caching layer.

Since then [V]: 190+ functions, CTEs, JSON functions, `EXPLAIN FORMAT JSON`, unpartitioned tables, joins and subqueries (May 2026), set operations, window functions, `QUALIFY`, grouping sets, exact and approximate aggregates (June 2026), `OFFSET` (Oct 2026). Pricing $2.50/TB compressed scanned, 10 GB/month included, 10 MB minimum per query, billing live since Aug 2026.

Implications: (a) Cloudflare itself chose the coordinator + metadata-shipping + Arrow-IPC shape, which validates the design; (b) Basin SQL can serve ad-hoc SQL over viz's Iceberg tables with zero engine work; (c) it cannot serve PromQL/TraceQL semantics, and per-query minimum billing plus seconds-level latency make it wrong for dashboards.

### 5.7 Workers fan-out patterns

Verified platform facts [V]: 128 MB; CPU 30 s default, 5 min max, I/O wait not counted; 10,000 subrequests default, up to 10M; **six connections waiting for headers at once**, the seventh queues; Workers invoked through service bindings share that connection limit; Cache API calls share the subrequest quota; Containers go up to 4 vCPU / 12 GiB / 20 GB disk.

Patterns:

1. **Flat fan-out with early headers.** The six-connection limit counts connections *waiting for response headers*. If each leaf returns headers immediately and streams its body, the coordinator can have many leaves in flight. This must be tested: whether service-binding RPC calls count the same way is the single most important platform unknown for this design.
2. **Tree fan-out (Lambada).** Coordinator → up to ~6–32 mid-tier mergers → leaves. Mid-tier merges partials, so the coordinator's memory is bounded regardless of leaf count. Costs one extra hop (~5–15 ms) and gives a natural place for the leaf-partial cache.
3. **Durable Object as query coordinator** only when a query needs state beyond one request (streaming search with cursor, cancellation, long traces export). Plain Workers otherwise; DOs are single-threaded and regional.
4. **Per-tenant DO as admission controller** (limits, fairness, in-flight accounting).
5. **Container fallback** for non-decomposable or oversized plans, running the same Rust engine natively.

### 5.8 Data skipping

| Technique | Where | Use in viz |
|---|---|---|
| Partition pruning | Iceberg manifest list | tenant (table or partition), time (hour/day), `bucket(series_id)` / `bucket(trace_id)` |
| File min/max, null counts | Iceberg manifests | time range, metric name/ID range, series-hash range, trace-ID range |
| Row-group stats, **page index** (column + offset index) | Parquet footer | within-file seek to (metric, series) and time ranges when sorted |
| **Sort-key pruning** | writer discipline | metrics sorted `(metric_id, series_id, ts)`; traces sorted `(trace_id, span_id)` plus a time-partition; logs sorted `(stream_id, ts)` |
| Bloom filters | Parquet split-block bloom per column chunk, or sidecar | trace-ID lookup, high-cardinality equality (`span.http.url`, request IDs) |
| Dictionary pruning | dictionary page | check predicate against the dictionary before decoding data pages (Tempo does this [TK]) |
| Inverted label index | sidecar (postings: label=value → series IDs) per partition | **PromQL selector resolution**: resolve matchers to series IDs *before* touching sample data; without it, regex matchers scan label columns |
| Late materialization | reader | evaluate predicates on narrow columns, fetch wide columns (log body, span attributes) only for surviving rows; Tempo's second pass |
| Zone maps on derived keys | sidecar | min/max duration per row group for `span:duration > 5s` |

The series/label index is the piece observability needs that generic lakehouse engines lack. Series metadata (labels) should be a separate small table/file per partition, with samples referencing a `series_id`; the planner reads only the series table to resolve selectors and to produce the cardinality estimate that sizes shards.

### 5.9 Cold start and tail latency

- Workers isolates start in single-digit ms, but **WASM module instantiation** is paid per isolate; keep the module small and avoid heavy static initializers (1 s startup limit [V]).
- **Hedged requests** ("The Tail at Scale"): send a duplicate after the p95 latency for that request class has elapsed, take the first response, cancel the other. Applies at two levels: R2 range reads (Starling's read-straggler mitigation [TK]) and leaf invocations. Budget ~5% extra requests. R2 reads are idempotent, so hedging is always safe.
- **Coalesce range reads**: merge nearby column-chunk ranges into one GET when the gap is below a threshold (e.g. 256 KB–1 MB), to cut round trips; `object_store`/`parquet` readers support this pattern. [TK]
- **Speculative prefetch**: start fetching the first data page ranges while the plan for later splits is still being built (Basin SQL's overlapped plan/execute).
- **Smart Placement** or explicit location hints so coordinators and leaves run near the R2 bucket's region rather than near the user. [TK]
- Containers have cold starts measured in seconds [TK, unverified]; keep them off the dashboard path.

### 5.10 Caching layers

| Layer | Key | Store | Notes |
|---|---|---|---|
| Iceberg metadata (current snapshot pointer) | table | DO memory / KV, short TTL or push-invalidated on commit | Only mutable item in the whole read path |
| Manifests, manifest lists | object path (immutable) | Cache API L1, in-isolate LRU | Immutable forever |
| Parquet footers + page index | file path | Cache API; better, a **footer sidecar per partition** written at ingest/compaction | Ship parsed metadata to leaves in the work unit, as Basin SQL does |
| Series/label index | partition + snapshot | Cache API | Hot for dashboards |
| Column chunk / page bytes | (file, byte range) | Cache API with synthetic URLs | Per-colo; helps repeated dashboards; 512 MB object cap [V] |
| Leaf partial aggregates | (fragment hash, file set, split, step) | Cache API L1 + R2/KV L2 | Immutable; highest value |
| Final results | (tenant, query, start, end, step) | Cache API, short TTL | Dedup across concurrent viewers; also coalesce identical in-flight queries (singleflight) in the tenant DO |

Quickwit's finding applies: cache what removes round trips (partials, page bytes), not just footers. [V]

---

## 6. Intermediate representation and memory-bounded execution

### 6.1 Between stages

- **Arrow IPC stream** is the default: self-describing, zero-copy readable in Rust, readable in TS (`apache-arrow`) for debugging, and what Basin SQL uses. [V]
- Shape for PromQL partials: one record batch per chunk of groups, columns = `group_id: u32`, `step_index` implied by a `FixedSizeList<f64>[n_steps]` (dense) or `(step: u32, value: f64)` (sparse), plus a validity bitmap for absent steps and a second list for compensation/count where the aggregate needs two fields. A dictionary batch maps `group_id` → label set. Dense step arrays compress very well and merge with SIMD-friendly loops.
- Avoid JSON between stages; produce Prometheus JSON only at the edge, streamed series by series.
- Leaf responses should be **streamed** (headers first, then batches), which also addresses the six-connection limit.
- Partial-aggregate schema is a versioned contract (`fragment_version`), since coordinator and leaves deploy independently.

### 6.2 Streaming partial aggregates

Leaves emit partials incrementally by group range; the merger combines batches as they arrive and can forward upstream when a group range is complete across all inputs (requires leaves to emit groups in a canonical order, e.g. by group-label hash). This gives pipelined merge with bounded memory and enables progressive results for TraceQL search and log tailing.

### 6.3 Fitting in 128 MB

Budget per isolate (engineering targets): ~10 MB WASM code + runtime, ~10 MB JS heap, **≤ 64 MB engine working set**, the rest headroom. WASM linear memory never shrinks once grown [TK], so a single large query bloats the isolate until it is recycled; enforce the cap inside the engine's allocator, fail fast, and let the planner re-split.

Techniques:

1. **Row-group-at-a-time, page-at-a-time decode.** Writers must cap row-group size (e.g. ≤ 16–32 MB uncompressed, ≤ 1M rows) and use the page index. This is a storage-format requirement imposed by the query engine.
2. **Series-at-a-time evaluation (MQE style).** With `(metric_id, series_id, ts)` order, a leaf holds one series' window buffer (a ring buffer of samples covering range + pads) and one accumulator array per output group (`n_steps × 8–16 bytes`). Memory = `groups × steps × 16 B` + one series. 1,000 groups × 1,000 steps ≈ 16 MB.
3. **Per-series k-way merge.** Uncompacted partitions hold several overlapping files. Merge K sorted streams on `(series_id, ts)` with a loser tree, deduplicating equal timestamps. Memory = K × one decoded page per needed column. Bound K by a compaction invariant (e.g. ≤ 8 overlapping files per series bucket per time partition) and have the planner send higher-K partitions to a Container.
4. **Dictionary/RLE awareness.** With sorted data, `metric_id` and `series_id` columns are RLE runs; the reader should surface runs so series boundaries cost O(1) and whole runs are skipped when the series is not selected.
5. **No hash joins at leaves.** Vector matching happens at the coordinator on already-aggregated, small inputs. If both sides are large, it is a Container plan.
6. **"Spill" = re-partition, not disk.** Workers have no local disk. On a memory-limit error the leaf returns `RESOURCE_EXHAUSTED` with a suggested split factor; the coordinator re-issues the work unit split by series-hash sub-range or by time. For genuinely large intermediate state (high-cardinality `by`), write partials to R2 temp objects (Starling-style) and merge in a tree.
7. **Coordinator bound.** Output cells = series × steps. 10,000 series × 1,000 steps × 8 B = 80 MB, which does not fit. Enforce a cell limit (e.g. 4M cells), merge in a tree, and stream final JSON per series rather than building the matrix.
8. **Limits as part of the plan.** Each work unit carries `max_rows`, `max_series`, `max_groups`, `cpu_ms`, `mem_bytes`.

---

## 7. Recommended query architecture for viz

### 7.1 Pipeline

```
client (Grafana: Prometheus / Tempo / Loki datasources)
  │
  ▼
API Worker (TS shell + engine.wasm)                      ── "frontend + coordinator"
  1. authn/tenant, API-compat layer (Prom/Tempo/Loki HTTP shapes)
  2. parse:   PromQL (promql-parser) | TraceQL (own) | LogQL (own)      → language AST
  3. lower:   AST → viz logical plan (typed operator tree)
  4. rewrite: step-invariant detection, CSE, time split, shard, partial-agg pushdown
  5. admission: tenant DO (limits, fairness, singleflight, blocked queries)
  6. final-result cache lookup
  7. prune:   Iceberg snapshot → manifests → series index → (file, row-group) work units
              + cost estimate (bytes, rows, series) → reject / downgrade / route to Container
  8. dispatch fragments (service binding, streamed Arrow IPC), hedged
  9. merge partials (tree if wide), evaluate non-pushed operators, format, stream
  │
  ├──► Leaf Worker × N (engine.wasm)                    ── stateless
  │      leaf-partial cache lookup → R2 ranged reads (coalesced, hedged, Cache API)
  │      → page decode → k-way merge → series-at-a-time kernels → partial aggregate
  │
  ├──► Ingest tail (DOs holding not-yet-committed data)  ── same fragment contract
  │
  └──► Container (same Rust engine, native; optionally DataFusion)  ── fallback
         non-decomposable plans, large subqueries, heavy joins, exports
```

Recent data that has not reached Iceberg must be queryable through the same fragment contract (Tempo's live-store and Mimir's ingesters play that role [V/TK]). The planner treats "the tail" as one more leaf with a time bound.

### 7.2 Shared logical plan: share the bottom, not the top

A single relational plan for all three languages (GreptimeDB style) buys SQL interop at the price of semantic friction. Recommended instead:

- **Shared**: scan operators (`SeriesScan`, `SpanScan`, `LogScan` with projections, predicates, time bounds, pads), the pruner, work-unit and fragment serialization, the exchange/merge framework, partial-aggregate kernels, limits, caching, Arrow schemas.
- **Shared mid-layer for anything that yields time series**: `RangeFunction`, `Aggregate(partial|final)`, `BinaryOp`, `TopK`, `HistogramQuantile`. PromQL uses all of it; TraceQL metrics and LogQL metric queries use `Aggregate`, second-stage `TopK`, arithmetic and comparisons.
- **Language-specific**: PromQL subqueries/`@`/vector matching; TraceQL spanset evaluation and structural operators; LogQL pipelines.

Plan nodes carry an explicit output kind (`Series{labels, steps}`, `Spansets`, `LogLines`, `Scalar`) and a `distribution` property (`PerSeriesShardable`, `MergeablePartial`, `CoordinatorOnly`), which is what the rewriter keys on.

### 7.3 Implementation language

**Rust → WASM for the engine; TypeScript for the shell.**

- Rust: `promql-parser`, `arrow-rs`, `parquet` (async reader over a custom `AsyncFileReader` backed by R2 range reads), deterministic memory, SIMD (`wasm32` simd128), and the same crate builds natively for Containers, CI oracles and benchmarks.
- TS: Workers bindings, routing, auth, DO classes, Cache API, fan-out, streaming responses. Keep R2 I/O in JS and hand `Uint8Array`s into WASM (or use `workers-rs` if the boundary cost shows up in profiles).
- WASM hygiene: `opt-level="s"`/`z` + LTO + `wasm-opt`, only the codecs actually written (zstd or lz4 + snappy), no `tokio` runtime, an arena/bump allocator per query with a hard cap, panics mapped to structured errors.

### 7.4 Build vs. reuse

| Piece | Decision |
|---|---|
| PromQL parser/prettifier | **Reuse** `promql-parser`; upstream or fork for 3.16 syntax |
| PromQL evaluator (kernels, matching, annotations) | **Build**, porting semantics function by function from `prometheus/promql/functions.go` with the `promqltest` corpus as the spec |
| Distributed rewrite rules | **Build**, modelled on Thanos `logicalplan` and Mimir sharding docs |
| TraceQL parser + engine | **Build** (port `expr.y`; conditions/AllConditions/second-pass design from Tempo) |
| LogQL | **Build**, later; share metric operators |
| Parquet/Arrow | **Reuse** `parquet`, `arrow-*` crates (trimmed features) |
| Iceberg metadata reading | **Reuse** `iceberg-rust` types if they fit wasm; otherwise a thin Avro manifest reader. Planner-side only |
| Editor grammars | **Reuse** `@prometheus-io/codemirror-promql`, `@grafana/lezer-traceql`, `@grafana/lezer-logql` |
| Ad-hoc SQL | **Reuse** Basin SQL over the same tables; do not build |
| Heavy/fallback execution | Same engine natively in a Container; add DataFusion there only if SQL-ish needs appear |

### 7.5 Caching

As in §5.10. Order of implementation: (1) immutable metadata + footer sidecar; (2) leaf partials; (3) final results + singleflight; (4) page bytes. Never cache anything derived from the uncommitted tail beyond a few seconds.

### 7.6 Limits (defaults to start from, per tenant, all overridable)

| Limit | Default (proposal) |
|---|---|
| Max range × resolution | 11,000 points per series (Prometheus parity) |
| Max series resolved per query | 100k (planner, from series index) |
| Max bytes scanned per query | 2 GB compressed on the Worker path; above → Container or reject |
| Max leaves per query | 256 (Mimir's default is 128 partial queries [V]) |
| Max output cells at coordinator | 4M |
| Leaf memory / CPU | 64 MB engine cap / 5 s CPU |
| Query timeout | 30 s dashboards, 120 s API, longer for async exports |
| Concurrent queries per tenant | 20, queued fairly in the tenant DO |
| Blocked queries | per-tenant exact/regex list; plus automatic block of a fingerprint after repeated limit hits |

Expose Prometheus-compatible `stats` and the 3.16 `cost` fields so users can see series touched and samples read.

### 7.7 Compliance testing

1. **`promqltest` runner in Rust.** Parse the `.test` DSL, load series into an in-memory source implementing the scan trait, evaluate, compare values, ordering and annotations. Vendor the upstream testdata at a pinned Prometheus tag; track a pass-rate dashboard and an explicit allowlist of known failures. This runs in milliseconds and is the inner development loop.
2. **Storage-path variant.** Same corpus, but data written through the real Parquet writer and read through the real leaf path, with forced splits/shards (1, 2, 7 shards; split at awkward boundaries) to prove distributed equivalence. Property: `eval(single-node) == eval(any split × shard configuration)`.
3. **`prometheus/compliance` differential test.** Reference Prometheus 3.x in a container fed the same remote-write/OTLP data; run the 539 queries against both. Report both "including `__name__`" and "ignoring `__name__`" numbers, as GreptimeDB does.
4. **Generated-query fuzzing** (promqlsmith-style [TK] / the "generated queries" mode of promql-compat [V, tool not located]) against the reference, seeded and minimized on failure.
5. **Production shadowing.** Sample a small fraction of real queries, replay them against a Prometheus-engine oracle in a Container reading the same data through a remote-read shim, diff asynchronously, alert on drift.
6. **TraceQL**: Tempo's parser test corpus for syntax; for semantics, differential tests against a Tempo monolithic container loaded with the same OTLP traces.
7. Publish the scores. Target: ≥ 95% of the compliance suite before GA, 100% for every function viz claims to support (unsupported functions must return a clear error, never a wrong answer).

### 7.8 Latency budget

Reference query: one Grafana panel, `sum by (pod)(rate(http_requests_total{namespace="x"}[5m]))`, last 6 h, step 30 s (720 steps), ~500 matching series, ~50 output groups, 4 time-partition files + tail. These are **design targets and estimates, not measurements**; R2 TTFB numbers in particular must be measured in the target region.

| Stage | Warm p50 | Cold-ish p95 | Notes |
|---|---|---|---|
| Edge → API Worker, auth, tenant DO admission | 5 ms | 25 ms | DO hop is regional |
| Parse + plan + rewrite (WASM) | 1 ms | 5 ms | |
| Final-result cache lookup | 3 ms | 15 ms | hit ends here: ~10–40 ms total |
| Metadata prune (snapshot, manifests, series index) | 5 ms | 80 ms | cached vs. 1–2 R2 reads |
| Dispatch to leaves | 5 ms | 20 ms | service bindings |
| Leaf: partial-cache lookup | 3 ms | 15 ms | hit for all closed splits on refresh |
| Leaf: R2 ranged reads (1–3 coalesced GETs) | 40 ms | 300 ms | dominant term; hedge at p95 |
| Leaf: decode + merge + kernels | 15 ms | 80 ms | ~0.5–2M samples |
| Leaf → coordinator stream | 5 ms | 20 ms | Arrow IPC, tens of KB |
| Coordinator merge + final ops | 2 ms | 10 ms | |
| JSON encode + response | 5 ms | 20 ms | 50 series × 720 points |
| **Total** | **~90–150 ms** | **~500–700 ms** | leaves run in parallel |

Targets by scenario:

| Scenario | p50 | p95 |
|---|---|---|
| Auto-refresh of an open dashboard (only newest split uncached) | ≤ 100 ms | ≤ 400 ms |
| First load, warm metadata | ≤ 300 ms | ≤ 1.5 s |
| First load, fully cold (new tenant/colo) | ≤ 800 ms | ≤ 3 s |
| 30-day SLO query (instant-split, cached partials) | ≤ 1 s | ≤ 5 s |
| Trace by ID | ≤ 200 ms | ≤ 1 s |
| TraceQL search, last 1 h, selective `&&` conditions | first results ≤ 500 ms (streamed) | ≤ 3 s to limit |
| Log search, last 1 h, one stream + line filter, limit 1000 | ≤ 500 ms | ≤ 3 s |

A 20-panel dashboard issues 20–40 queries at once: admission control must allow that burst per user, and identical subplans across panels should be coalesced.

---

## 8. Design implications for viz

1. **Storage layout is a query-engine decision.** Sort metrics by `(metric_id, series_id, ts)`, cap row groups, write page indexes, bucket by series hash, keep a separate series/label index per partition, and write a footer sidecar. Without these the streaming leaf design does not hold.
2. **Preserve NaN payloads** and decide whether ingest synthesizes staleness markers for OTLP series.
3. **Store OTLP start timestamps and temporality**; upstream PromQL is growing first-class uses for both (3.16).
4. **Leaf scan contract takes explicit left/right pads**, because `anchored`/`smoothed` (stable since 3.16) change the fetch window.
5. **Value type is float | histogram from the start**; ship classic histograms first, native histograms second.
6. **Each series in exactly one shard** is the invariant that makes `topk`, `count`, and per-series functions decomposable; state it in the table spec.
7. **Exact by default, approximate by hint.** Quantile sketches, sampling (`with(sample=…)`-style) and step coarsening are opt-in and labelled in the response.
8. **Fall back, do not fail**: every plan the Worker path cannot run within limits should have a Container route, using the identical engine.
9. **Test the six-connection limit behaviour before fixing the fan-out topology** (flat with early headers vs. tree).
10. **Adopt Basin SQL for ad-hoc SQL** and keep viz's engine focused on PromQL/TraceQL/LogQL semantics.
11. **Make cost visible**: bytes scanned and series touched are known before execution; expose them (Prometheus `query_cost` shape) and bill/limit on them.
12. **Budget for a multi-year compliance tail.** GreptimeDB needed ~10 months to reach 82% and still has name-handling gaps after three years. Porting semantics directly from the Go source with the upstream test corpus as the loop should be faster than rediscovering them through SQL operators, but it is still the largest single engineering item in the query path.
13. **TraceQL needs trace-grouped storage** (spans of a trace co-located, nested-set columns written at ingest/compaction, dedicated columns for hot attributes) or structural operators become distributed joins.

---

## 9. Open questions / unverified

Platform:
- Do service-binding/RPC calls count against the six-simultaneous-connections limit in the same way as `fetch`, and does returning headers early free the slot? Needs a spike.
- Real WASM size and instantiate time for `parquet` + `arrow` + engine under the 1 s startup limit; per-isolate memory after a large query (linear memory does not shrink).
- R2 ranged-read TTFB distribution (p50/p95/p99) from Workers in the bucket's region and from remote colos; effect of Smart Placement.
- Cache API semantics for synthetic keys at high cardinality (eviction, per-colo hit rates). [TK that it is per-colo]
- Cloudflare Containers cold-start time, pricing and GA status were not verified today.
- Whether Basin SQL workers run on the Workers runtime; whether Basin exposes anything (planner API, pruned file lists) that viz could reuse.

PromQL:
- Does `promql-parser` 0.9.x parse all of 3.16 (anchored/smoothed, duration expressions, unquoted UTF-8, `fill*`)? 0.9.0 lists `fill*`, `limitk`, `limit_ratio`; the rest is unconfirmed.
- Where "promql-compat" lives and whether its generated-query mode is reusable.
- Exactness of instant-query splitting for `rate` under `anchored` semantics (my reasoning, not a cited result).
- Whether per-step `topk` over shards stays within memory for wide dashboards; Mimir's exact treatment of `topk`/`quantile` sharding was not on the page fetched.
- How much of MQE's planner (CSE, remote fragment execution) is documented; the architecture page 404'd today.
- Native histogram storage encoding in Parquet (struct of spans/deltas vs. decoded bucket lists) and its effect on kernel design.

TraceQL / LogQL:
- Tempo's fetch-layer details (`AllConditions`, second pass, iterator join order, metrics aggregation tiers, log-bucket quantiles) are from training knowledge of the source; the public architecture page no longer describes them. Re-read `pkg/traceql` and `tempodb/encoding/vparquet5` at the 3.1 tag before designing the span schema.
- Whether any Rust TraceQL or LogQL parser appeared in 2026 (none found in one search).
- Loki's current columnar/"data object" engine direction and bloom-filter status: not checked.

Engines:
- OpenObserve, Parseable, Databend, CnosDB, Oxla, Chronosphere PromQL internals: not verified today.
- ClickHouse's PromQL→SQL design is unpublished; revisit when the promised technical post appears.
- Starling/Lambada/Flock and Snowflake-pruning details are from memory of the papers.

---

## 10. Sources

Verified today (fetched or returned by search on 2026-11-18):

Cloudflare
- R2 SQL deep dive: https://blog.cloudflare.com/r2-sql-deep-dive/
- Basin changelog (rename, SQL features, pricing): https://developers.cloudflare.com/changelog/product/basin/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Subrequest limit change (Feb 2026): https://developers.cloudflare.com/changelog/2026-02-11-subrequests-limit
- Containers limits: https://developers.cloudflare.com/containers/platform-details/limits/

Prometheus
- Releases (3.15, 3.16): https://github.com/prometheus/prometheus/releases/
- Feature flags: https://prometheus.io/docs/prometheus/latest/feature_flags/
- Querying basics (lookback, range boundaries, anchored/smoothed, modifiers): https://prometheus.io/docs/prometheus/latest/querying/basics/
- Functions: https://prometheus.io/docs/prometheus/latest/querying/functions/
- HTTP API: https://prometheus.io/docs/prometheus/latest/querying/api/
- Native histograms spec: https://prometheus.io/docs/specs/native_histograms/
- 3.8.0 announcement (native histograms stable): https://groups.google.com/g/prometheus-announce/c/NqC1FhcgA-s
- Conformance program: https://prometheus.io/blog/2021/05/03/introducing-prometheus-conformance-program/
- Compliance repo: https://github.com/prometheus/compliance
- PromLabs vendor compatibility round three: https://promlabs.com/blog/2021/10/14/promql-vendor-compatibility-round-three

Engines
- thanos-io/promql-engine README: https://github.com/thanos-io/promql-engine
- Thanos distributed execution proposal: https://thanos.io/tip/proposals-done/202301-distributed-query-execution.md/
- Cortex distributed query execution proposal: https://cortexmetrics.io/docs/proposals/distributed-query-execution/
- Mimir 3.0 release notes: https://grafana.com/docs/mimir/latest/release-notes/v3.0/
- Mimir 3.0 blog: https://grafana.com/blog/grafana-mimir-3-0-release-all-the-latest-updates/
- MQE talk (80% faster, 70% less memory): https://2025.everythingopen.au/schedule/presentation/91/
- Mimir query sharding: https://grafana.com/docs/mimir/latest/references/architecture/query-sharding/
- MetricsQL: https://docs.victoriametrics.com/victoriametrics/metricsql/
- GreptimeDB PromQL docs (compatibility table): https://docs.greptime.com/user-guide/query-data/promql
- GreptimeDB PromCon recap: https://greptime.com/blogs/2026-01-14-promcon-engage-prometheus-in-rust
- promql-parser crate: https://docs.rs/crate/promql-parser/latest and https://github.com/GreptimeTeam/promql-parser
- ClickHouse PromQL announcement: https://clickhouse.com/blog/introducing-promql
- ClickHouse `prometheusQuery`: https://clickhouse.com/docs/reference/functions/table-functions/prometheusQuery
- oteldb TraceQL package: https://pkg.go.dev/github.com/go-faster/oteldb/internal/traceql
- DataFusion wasm: https://www.npmjs.com/package/datafusion-wasm ; arrow-rs wasm32 support: https://github.com/apache/arrow-rs/pull/2896
- DuckDB-WASM troubleshooting: https://duckdb.org/docs/current/clients/wasm/troubleshoot.html
- Polars wasm codec issue: https://github.com/pola-rs/polars/issues/16729

Tempo / TraceQL
- TraceQL metrics functions: https://grafana.com/docs/tempo/latest/traceql/metrics-queries/functions/
- TraceQL metrics operations: https://grafana.com/docs/tempo/latest/operations/traceql-metrics/
- Tune TraceQL queries: https://grafana.com/docs/tempo/latest/traceql/tune-traceql-queries/
- Tempo 3.0 release: https://grafana.com/blog/tempo-3-0-release-all-the-latest-features
- Tempo 3.1 release: https://grafana.com/blog/tempo-3-1-release-all-the-latest-features/
- Tempo 2.10 release: https://grafana.com/blog/tempo-2-10-release-all-the-latest-features
- lezer-traceql: https://www.npmjs.com/package/@grafana/lezer-traceql
- traceql-syntax (Go fork): https://pkg.go.dev/github.com/qualithm/traceql-syntax

Serverless / search
- Honeycomb, secondary storage on S3 + Lambda: https://www.honeycomb.io/blog/secondary-storage-to-just-storage
- Honeycomb serverless (InfoQ): https://www.infoq.com/news/2022/10/honeycomb-serverless/
- Honeycomb virtualizing storage engine: https://www.honeycomb.io/blog/virtualizing-storage-engine
- Quickwit architecture: https://quickwit.io/docs/overview/architecture
- Quickwit Lambda search performance: https://quickwit.io/blog/quickwit-lambda-search-performance
- turbopuffer architecture: https://turbopuffer.com/architecture and https://turbopuffer.com/docs/concepts

Not fetched today (training knowledge; URLs for follow-up)
- Starling (Perron et al., SIGMOD 2020): https://arxiv.org/abs/1911.11727
- Lambada (Müller et al., SIGMOD 2020): https://arxiv.org/abs/1912.00937
- Flock: https://github.com/flock-lab/flock
- Pruning in Snowflake (SIGMOD 2025): https://arxiv.org/abs/2504.11540
- The Tail at Scale (Dean & Barroso, CACM 2013): https://research.google/pubs/the-tail-at-scale/
- Tempo source: https://github.com/grafana/tempo/tree/main/pkg/traceql
- Prometheus promqltest: https://github.com/prometheus/prometheus/tree/main/promql/promqltest
- Mimir streaming engine package: https://pkg.go.dev/github.com/grafana/mimir/pkg/streamingpromql
