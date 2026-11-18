# viz — how the work is verified

Two questions: how was *this design* checked, and how will the *system* be checked as it is
built. Detail and sources: `research/12-verification-strategy.md`.

## 1. Checking the research and the design (done in this pass)

| Check | What it caught or established |
|---|---|
| Twelve independent researchers, each fetching primary sources | Facts reached independently by several (platform rename and GA, catalog pricing, Pipelines limits, isolate memory, six-connection rule) are treated as established |
| Every claim tagged verified / secondary / training knowledge | Non-Cloudflare system internals are mostly training knowledge and are not load-bearing in the design |
| Disagreements listed and resolved explicitly | Six conflicts between researchers; see `research/README.md` and `DECISIONS.md` |
| Two independent adversarial reviews of draft 2 | 57 findings; the write path, routing, cost table and spike order were rewritten; see `REVIEW.md` |
| Re-review of draft 3 | Core seam judged sound; 12 edge findings amended in draft 3.1. The amendments are unreviewed text |
| Every modelled number mapped to an experiment | Section 4 below |

One thing has been measured: the engine-language choice (`bench/README.md`), in a sandbox
and in local `workerd`. That is the first part of spike S2. Nothing has been run on
Cloudflare; every other performance and cost figure is a model.

## 2. Invariants

The system is correct when these hold. Full, precise statements are in `research/12` §2
(I1–I28); the ones the architecture is built around:

| # | Invariant | Enforced by |
|---|---|---|
| I1 | An acknowledged row is in durable shard storage or in a file listed in the ledger | Ack after WAL transaction |
| I2 | No acknowledged row is lost | WAL replay; truncate only after confirmed commit |
| I3 | No row is visible more often than it was accepted | Batch fingerprints; `(shard, seq range)` keys; watermarks |
| I4 | Visibility is monotonic; no gap or double count at the tail/lake seam | One ledger version + its watermarks per query; shards refuse stale watermarks |
| I5 | A WAL segment is discarded only after the ledger has acknowledged its flush unit | Contiguous-prefix watermark; ledger transaction |
| I7 | Overload produces a retryable error, never acknowledge-and-drop | Bounded shard buffers |
| I8 | Compaction preserves the multiset of rows, sort order and field ids | Content checksums before and after |
| I9 | Retention deletes exactly what policy says, and only that tenant's files | Tenant-pure files, partition-aligned deletes |
| I10 | Published Iceberg history is a single chain and equals the ledgers it claims to reflect | One publisher per cell; managed maintenance off; scrubber |
| I11 | No dangling references, no leaked files | Ledger, scrubber, orphan sweeper |
| I12 | Every snapshot is readable by two independent engines with identical content hashes | DuckDB and PyIceberg per PR |
| I14 | Results with pruning on equal results with pruning off | Differential test |
| I15/16 | PromQL and TraceQL results equal the reference implementations on the supported subset | Corpus + differential + fuzz |
| I17 | A result does not depend on whether rows are in the tail, flush files or compacted files | Storage-location invariance test |
| I19 | The native and WASM builds of the engine give identical results | Differential test in CI |
| I20 | No request can read another tenant's data | Planner-injected scope; authorisation matrix fuzz |
| I21 | Agents can only do what their capabilities allow, whatever the telemetry says | Read-only tools; injection corpus |
| I25/26 | Each query stays within declared R2 operations, subrequests and peak memory | Metering proxy; cost golden files |

## 3. Test layers

| Layer | Tooling | Runs |
|---|---|---|
| Protocol model | Quint specification of seal / flush / ledger-add / discard / compact / retain / publish with crash, duplicate, stale-watermark and map-epoch actions; traces replayed against the code | per change to the protocol |
| Deterministic simulation | The Rust core has no I/O; a seeded single-threaded simulator supplies storage, R2, catalog and clock, injects faults, checks invariants after every step, and includes queries with an oracle | every PR (minutes), long runs nightly |
| Workers integration | `@cloudflare/vitest-plugin`: `evictDurableObject`, `abortAllDurableObjects`, `runDurableObjectAlarm`, compiled-in failpoints; Docker Iceberg REST catalog (Lakekeeper or `iceberg-rest-fixture`) | every PR |
| Query conformance | Upstream `promqltest` corpus in process; `prometheus/compliance` differential against a real Prometheus; Tempo differential; PromQL fuzzing with metamorphic checks; split/shard equivalence | every PR; full suite nightly |
| Format validity | Read back every committed snapshot with DuckDB and PyIceberg (Spark, Trino, Basin SQL nightly); statistics-are-bounds checks | every PR / nightly |
| Platform drift | The same suite against real R2 and the real managed catalog | nightly |
| Performance | k6 with Remote Write and OTLP extensions, `avalanche`, `telemetrygen`; continuous benchmarks; a 128 MB ceiling test | nightly; gates on release |
| Cost | A metering proxy on every binding; per-query "cost golden files" that fail CI when a change adds R2 operations or subrequests | every PR |
| Security | Tenant-id fuzzing on every API; authorisation matrix; prompt-injection corpus for agentic monitors; adapter sandbox tests | every PR |
| Frontend | Playwright end-to-end and visual regression; data-to-geometry golden tests for charts; axe; dashboard-spec round-trip and schema tests | every PR |
| Agents | Golden tasks for dashboard authoring; replay of seeded incidents (OpenTelemetry Demo fault flags) for agentic monitors; rubric scoring; token and cost budgets | nightly |
| Production | A canary tenant writes known data and reads it back continuously; a row-count audit reconciles ingest → ledger → published snapshot; viz monitors itself from a separate tenant | always |

## 4. Assumptions to falsify first

Ordered so that the experiments that decide topology and the cost floor come first; the
catalog, which has a fallback, comes last. The order follows the platform review.

| # | Experiment | Decides | Kill criterion and consequence |
|---|---|---|---|
| S0 (running since 2026-11-18, `spikes/s0-do-billing/`; **first hour measured**: wakes bill 20–40 ms each, 0.04–0.09% duty at 60 s, so per-minute ticks are affordable) | Durable Object duration billing: one object woken every 1, 5, 15 and 60 s, by alarm and by request; read billed GB-s after 24 h | The cost floor; whether per-minute ruler and publisher ticks are affordable | A 60 s wake bills above ~25% duty → fold ticks into fewer objects, lengthen intervals for small tenants |
| S1 (**done** 2026-11-18, `spikes/s1-fanout-r2/`: service-bound leaves share the caller's six-connection budget, Durable Object leaves do not; a range read is about 45 ms) | Connection semantics and R2 latency: range-read parallelism from one invocation, through service bindings and through object stubs; p50/p99 TTFB in and out of region, with hedging | Leaf topology; where `query` runs | Six-slot budget shared across the tree → leaves become separate top-level requests |
| S2 (**measured** 2026-11-18, `spikes/s2-engine-in-worker/`: Rust 10–18× cheaper than JS in billed CPU; 128 MB not enforced at allocation) | Engine in an isolate: WASM size, startup under 1 s, peak memory while merging and encoding a sealed segment and while decoding a row group; acknowledgement latency while a flush runs | Whether the Rust core is viable; segment and row-group sizes | Does not fit → smaller segments, pure-JS Parquet, more Container use |
| S3 (**measured** 2026-11-18, `spikes/s3-ingest-throughput/`: 60 ms median acknowledgement; one shard saturates at 230–290 requests/s, below the 300 target; 133k samples/s with large batches) | Ingest path: real Remote Write and OTLP bodies through `edge` to shards; object requests per ingest request, rows written per month at 50 / 250 / 1,000 ms commit windows, acknowledgement latency, decode CPU per MB | Routing key, commit window, ingest cost | More than ~2 object requests per ingest request → change routing key |
| S4 (**measured** 2026-11-18, `spikes/s4-ledger-scale/`: **defect found** — the ledger admits about one unit per second because each change waits on its own R2 write of about 0.4 s; plan is 276 ms at 7,000 files) | Ledger at scale: 1,000 flush units/min into one ledger; plan-call latency with 300k live files; rebuild from the R2 log | Ledger sizing; when to split a ledger | Plan call over ~50 ms or adds over ~10 ms p99 → ledger per shard group |
| S5 | One vertical read slice on synthetic team-scale data before any PromQL breadth: `sum by (pod) (rate(http_requests_total{namespace="x"}[5m]))` over 1 h, 24 h (today and yesterday) and 30 d; count reads, bytes, CPU, wall time; flat rows vs chunk-blob rows; hashed vs locality-prefixed series ids | Row shape, sort key, compaction cadence, rollup placement, latency targets | First-load 24 h p95 over 3 s after tuning → chunk-blob rows or a different sort |
| S6 | Trace by ID and one structural TraceQL query at 500M spans/day; a log needle search at 100 GB/day over 1 h, 24 h and 7 d | Span partitioning; whether the flush-time token filter suffices | Trace-by-ID p95 over 1 s → bucket by trace id |
| S7 | Tail reads under ingest and rule load on one shard | Whether tail-class rules and 10 s freshness hold | Ingest p99 degrades more than 2× → rules read flush files only |
| S8 | Iceberg publication: R2-native metadata read back by DuckDB and PyIceberg; then commits to the managed catalog from a Worker under 409s and unknown outcomes | Whether managed-catalog publication ships | Unreliable → stay R2-native |

Additional measurement: **S5** (`spikes/s5-r2-writes/`, 2026-11-18): an R2 write takes
0.17–0.26 s at the median up to 1 MB, writes share the six-in-flight limit, and 32 Durable
Objects wrote 192 objects in 0.85 s.

## 5. Evidence required per milestone

| Milestone | Required evidence |
|---|---|
| Design accepted | Invariants agreed; Quint model checks and catches a seeded bug; S0–S5 run and recorded |
| Prototype (metrics only) | I1–I5 hold under simulated faults; upstream PromQL corpus pass rate published; cost golden files in CI; hobby tier measured ≤ modelled +25% |
| Alpha (three signals, dashboards, rules) | I1–I22 in CI; drift suite green for two weeks; canary tenant and ledger live; storage-location invariance holds across compaction |
| GA | Soak at team scale for 30 days with zero audit discrepancy; published supported-subset documents; injection corpus and tenant fuzz clean; SLO targets met or restated |
