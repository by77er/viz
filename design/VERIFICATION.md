# viz — how the work is verified

Two questions: how was *this design* checked, and how will the *system* be checked as it is
built. Detail and sources: `research/12-verification-strategy.md`.

## 1. Checking the research and the design (done in this pass)

| Check | What it caught or established |
|---|---|
| Twelve independent researchers, each fetching primary sources | Facts reached independently by several (platform rename and GA, catalog pricing, Pipelines limits, isolate memory, six-connection rule) are treated as established |
| Every claim tagged verified / secondary / training knowledge | Non-Cloudflare system internals are mostly training knowledge and are not load-bearing in the design |
| Disagreements listed and resolved explicitly | Six conflicts between researchers; see `research/README.md` and `DECISIONS.md` |
| Two independent adversarial reviews of the draft | Findings and dispositions in `REVIEW.md` |
| Every modelled number mapped to an experiment | Section 4 below |

What this pass did **not** do: run any code, measure any latency, or exercise any Cloudflare
service. Every performance and cost figure is a model.

## 2. Invariants

The system is correct when these hold. Full, precise statements are in `research/12` §2
(I1–I28); the ones the architecture is built around:

| # | Invariant | Enforced by |
|---|---|---|
| I1 | An acknowledged row is in durable shard storage or a committed snapshot | Ack after WAL transaction |
| I2 | No acknowledged row is lost | WAL replay; truncate only after confirmed commit |
| I3 | No row is visible more often than it was accepted | Batch fingerprints; `(shard, seq range)` keys; watermarks |
| I4 | Visibility is monotonic; no gap or double count at the tail/lake seam | One snapshot + its watermarks per query; truncation grace |
| I5 | A WAL segment is deleted only after its snapshot is confirmed by re-reading the catalog | Committer confirm step |
| I7 | Overload produces a retryable error, never acknowledge-and-drop | Bounded shard buffers |
| I8 | Compaction preserves the multiset of rows, sort order and field ids | Content checksums before and after |
| I9 | Retention deletes exactly what policy says, and only that tenant's files | Tenant-pure files, partition-aligned deletes |
| I10 | Snapshot history is a single chain | One committer per table; managed maintenance off |
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
| Protocol model | Quint specification of flush / commit / truncate / compact / retain with crash, duplicate, commit-unknown and stale-head actions; traces replayed against the code | per change to the protocol |
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
| Production | A canary tenant writes known data and reads it back continuously; a row-count ledger reconciles ingest → snapshot; viz monitors itself from a separate tenant | always |

## 4. Assumptions to falsify first

Each is a spike with a pass/fail threshold. They are ordered so that the cheapest experiment
that could invalidate the most design comes first.

| # | Assumption | Experiment | If it fails |
|---|---|---|---|
| S1 | A Worker / Durable Object can commit to the managed Iceberg catalog over REST, and DuckDB + PyIceberg read the result | Write one Parquet file, commit, read back; repeat under 409s and injected "commit unknown" | Use the R2-native catalog as primary |
| S2 | The Rust core fits: WASM size, < 1 s startup, < 128 MB while encoding a 32 MB segment or decoding a 32 MB row group | Build a minimal encode/decode/aggregate core; measure in `workerd` | Smaller segments and row groups; pure-JS Parquet; more Container use |
| S3 | A shard sustains ≥ 300 durable acknowledgements/s and ≥ 5 MB/s with group commit | Load test one object; measure p99 ack and row-write billing | Smaller shards, more of them; revisit cost model |
| S4 | Fan-out to 50–200 leaves works within the six-connection rule | Tree vs early-header streaming via service bindings; measure wall time | Deeper tree; fewer, larger leaves |
| S5 | R2 range reads from a Worker are fast enough: p50 and p99 TTFB, with and without hedging | Measure in-region and cross-region, cached and uncached | Larger coalesced reads; more caching; Smart Placement |
| S6 | Flat samples compress to ≤ 3 bytes each and scan fast enough | Real Prometheus data → flat rows vs chunk-blob rows; size and decode time | Chunk-blob rows per series-window |
| S7 | Decode cost ≤ 20–40 CPU-ms per uncompressed MB for OTLP and Remote Write | Benchmark the WASM decoders | Defer validation to the shard; revise cost model |
| S8 | Tail reads do not starve ingest on a busy shard | Mixed load on one object | Read replicas of the open segment; shorter segments |
| S9 | Planning stays at 3–5 subrequests with footer bundles, at 1k and 100k files | Synthetic table at both sizes | Coarser bundles; planner-side index object |
| S10 | Time-clustered compaction keeps ≤ ~30 files per day-partition query and fits a Workflow + leaf budget | Run on a week of synthetic data | Container compaction by default |

## 5. Evidence required per milestone

| Milestone | Required evidence |
|---|---|
| Design accepted | Invariants agreed; Quint model checks and catches a seeded bug; S1–S5 run and recorded |
| Prototype (metrics only) | I1–I5 hold under simulated faults; upstream PromQL corpus pass rate published; cost golden files in CI; hobby tier measured ≤ modelled +25% |
| Alpha (three signals, dashboards, rules) | I1–I22 in CI; drift suite green for two weeks; canary tenant and ledger live; storage-location invariance holds across compaction |
| GA | Soak at team scale for 30 days with zero ledger discrepancy; published supported-subset documents; injection corpus and tenant fuzz clean; SLO targets met or restated |
