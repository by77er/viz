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

Since this section was written, spikes S0–S5 were run on Cloudflare (§4), S3 and S4 were run
again against the rebuilt shard and ledger, a staged copy of the whole deployment was upgraded
and rolled back under load (`deploy/README.md`), and the protocol model was built and checked
(`spec/README.md`). Figures labelled "modelled" in the component READMEs are still models.

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
| S0 (**done**: ran 2026-11-18 19:04 to 2026-11-19 21:04 UTC and stopped by itself, `spikes/s0-do-billing/`; 24 hours measured on Cloudflare: wakes bill 20–24 ms by alarm and 34–47 ms by request, 0.033% and 0.057% duty at 60 s, so the kill criterion is not met and per-minute ticks are affordable; each wake wrote 3 SQLite rows, which at list price cost more than its duration) | Durable Object duration billing: one object woken every 1, 5, 15 and 60 s, by alarm and by request; read billed GB-s after 24 h | The cost floor; whether per-minute ruler and publisher ticks are affordable | A 60 s wake bills above ~25% duty → fold ticks into fewer objects, lengthen intervals for small tenants |
| S1 (**done** 2026-11-18, `spikes/s1-fanout-r2/`: service-bound leaves share the caller's six-connection budget, Durable Object leaves do not; a range read is about 45 ms) | Connection semantics and R2 latency: range-read parallelism from one invocation, through service bindings and through object stubs; p50/p99 TTFB in and out of region, with hedging | Leaf topology; where `query` runs | Six-slot budget shared across the tree → leaves become separate top-level requests |
| S2 (**measured** 2026-11-18, `spikes/s2-engine-in-worker/`: Rust 10–18× cheaper than JS in billed CPU; 128 MB not enforced at allocation) | Engine in an isolate: WASM size, startup under 1 s, peak memory while merging and encoding a sealed segment and while decoding a row group; acknowledgement latency while a flush runs | Whether the Rust core is viable; segment and row-group sizes | Does not fit → smaller segments, pure-JS Parquet, more Container use |
| S3 (**measured** 2026-11-18, `spikes/s3-ingest-throughput/`: 60 ms median acknowledgement; one shard saturates at 230–290 requests/s, below the 300 target; 133k samples/s with large batches; **re-run** 2026-11-19 after early refusal and group commit: 864–1,056 acknowledged requests/s per shard (n = 3), p99 under 150 ms at 64 clients, overload refused in 0–7 ms) | Ingest path: real Remote Write and OTLP bodies through `edge` to shards; object requests per ingest request, rows written per month at 50 / 250 / 1,000 ms commit windows, acknowledgement latency, decode CPU per MB | Routing key, commit window, ingest cost | More than ~2 object requests per ingest request → change routing key |
| S4 (**measured** 2026-11-18, `spikes/s4-ledger-scale/`: **defect found** — the ledger admits about one unit per second because each change waits on its own R2 write of about 0.4 s; plan is 276 ms at 7,000 files; **re-run** 2026-11-19 with the batched segment log: 234–422 units/s with eight writers against 1.7–3.3 for the old ledger the same day, n = 3 each; rebuild from 104 segments, 5,008 changes, in 5.4 s, against 28.7 s for 608 per-change objects; 300k files not reached on Cloudflare. Since then checkpoints are written in parts and a rebuild streams into SQLite (D47), so the ledger's own limit is 300 MiB, about 300,000 files (`contracts/LEDGER-LOG.md` "Size"): a rebuild of that size took 20 s in local workerd. The publisher re-bases such a state in bounded memory (D55; 8–17 s, a first publication 27–38 s, local workerd). Production keeps a ledger's state at 16 MiB, about 15,800 files (`stack/wrangler.jsonc`). **Measured on Cloudflare since** (S11, `spikes/s11-large-ledger/`, 2026-11-19, CPU from the analytics API): a rebuild after a storage loss and a publisher's first publication at 16, 64 and 150 MiB all completed within the 30 s default CPU limit (rebuild 1.2, 14.2 and 16.4–18.6 s; publication 2.1, 5.6 and 14.0 s); 300 MiB was not run and extrapolates to 32–37 s and 28–32 s, over the limit. S11 recommends lifting production to 64 MiB and no further; **not done**, the cap is still 16 MiB (`design/reviews/d47-d48-d55.md`, P-3)) | Ledger at scale: 1,000 flush units/min into one ledger; plan-call latency with 300k live files; rebuild from the R2 log | Ledger sizing; when to split a ledger | Plan call over ~50 ms or adds over ~10 ms p99 → ledger per shard group |
| S9 (was planned as S5; renamed because `spikes/s5-r2-writes/` took that name) | One vertical read slice on synthetic team-scale data before any PromQL breadth: `sum by (pod) (rate(http_requests_total{namespace="x"}[5m]))` over 1 h, 24 h (today and yesterday) and 30 d; count reads, bytes, CPU, wall time; flat rows vs chunk-blob rows; hashed vs locality-prefixed series ids | Row shape, sort key, compaction cadence, rollup placement, latency targets | First-load 24 h p95 over 3 s after tuning → chunk-blob rows or a different sort |
| S6 | Trace by ID and one structural TraceQL query at 500M spans/day; a log needle search at 100 GB/day over 1 h, 24 h and 7 d | Span partitioning; whether the flush-time token filter suffices | Trace-by-ID p95 over 1 s → bucket by trace id |
| S7 | Tail reads under ingest and rule load on one shard | Whether tail-class rules and 10 s freshness hold | Ingest p99 degrades more than 2× → rules read flush files only |
| S8 (first half **done**: R2-native metadata read back by DuckDB and PyIceberg, `publisher/README.md`; second half **blocked** 2026-11-19, `spikes/s8-managed-catalog/`: the token lacks Workers R2 Data Catalog Write, so the managed catalog was not reached and nothing is decided; committer, driver and readers built and tested; R2-native baseline measured: linear chains under 2–8 writers, about 0.5 commits/s per table, 2 of 80 commits starved at 8) | Iceberg publication: R2-native metadata read back by DuckDB and PyIceberg; then commits to the managed catalog from a Worker under 409s and unknown outcomes | Whether managed-catalog publication ships | Unreliable → stay R2-native |

Additional measurement: **S5** (`spikes/s5-r2-writes/`, 2026-11-18): an R2 write takes
0.17–0.26 s at the median up to 1 MB, writes share the six-in-flight limit, and 32 Durable
Objects wrote 192 objects in 0.85 s.

Spikes run since under numbers this table does not use, each with its README:

- **S9** (`spikes/s9-oauth-key-rollback/`, measured on Cloudflare 2026-11-19; not the read
  slice the table calls S9, which is still to run): a rollback across the release that created
  viz-control's OAuth key is allowed and leaves OAuth without a key; across a rotation
  Cloudflare refuses it (D53, D69).
- **S10** (`spikes/s10-signals-trial/`, measured on Cloudflare 2026-11-19, on the build before
  D62's second rewrite): traces and logs end to end with both flags on. Held: per-signal pools,
  the decode limits (D71), the query memory budget, publication read by three outside readers.
  Open: one compaction run killed at the 30 s CPU limit; every trace query refused above about
  240,000 spans in an hour; a 4 KB body costing 1.4–3.4 s of edge CPU to decode; a stage's
  timers running on after its expiry. A rerun of its realistic and fat shapes on the current
  build (ABI 8) is one of the three things `QUERY_SIGNALS` waits for, with a Grafana run and the
  owner's acceptance of D62's stated ceilings; the narrow re-check of D62 is done and approves it
  (`reviews/signals-end-to-end-r3.md`).
- **S11** (`spikes/s11-large-ledger/`): the S4 row above.
- **S12** (`spikes/s12-reload-on-a-phone/`, deployed 2026-11-26): the design system's pages on
  a public address, to see whether a phone loses its scroll position on reload as the emulator
  did in the v9 review. For the interface, which is on the development branch, not on `main`.
- **S13** (`spikes/s13-upgrade-trial/`): the first release over production, on a stage.
  **Prepared, not run**: the session's permission check refused the stage deploy twice, and it
  waits for the owner. Until it runs, nobody has seen Cloudflare accept viz-control's six Rate
  Limiting bindings at upload, or read them back from its version API (review of D69, round 2,
  M2-2).
- **S14** (`spikes/s14-app-preview/`, deployed 2026-11-27): the web app's build with the app's
  mock API on a workers.dev address, for the owner to look at before the gateway serves the real
  one (D74). Synthetic data only, bound to no viz resource; it answers 410 after 2026-12-04. For
  the interface, which is on the development branch, not on `main`.

## 5. Evidence required per milestone

| Milestone | Required evidence |
|---|---|
| Design accepted | Invariants agreed; Quint model checks and catches a seeded bug; S0–S5 run and recorded |
| Prototype (metrics only) | I1–I5 hold under simulated faults; upstream PromQL corpus pass rate published; cost golden files in CI; hobby tier measured ≤ modelled +25% |
| Alpha (three signals, dashboards, rules) | I1–I22 in CI; drift suite green for two weeks; canary tenant and ledger live; storage-location invariance holds across compaction |
| GA | Soak at team scale for 30 days with zero audit discrepancy; published supported-subset documents; injection corpus and tenant fuzz clean; SLO targets met or restated |
