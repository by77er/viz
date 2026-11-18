# Monitoring viz with viz

Status: **proposal**, 2026-11-18. A future goal; nothing here is built. It draws on
`research/02` §1.6, `research/07` (Cloudflare-native sources), `research/08` §3.5 and
principle 15, `research/12` §12, the measured spikes in `spikes/`, and the components as
they exist today.

## 1. The goal, and the problem with it

viz should be operated with viz: its own metrics, logs and traces stored in it, its own
dashboards drawn by it, its own alerts evaluated by its ruler, and its own incidents
investigated by its agents. That is the strongest test of the product, and it is what a
customer will assume.

The problem is **shared fate**. If ingest is down, viz cannot ingest the telemetry saying
ingest is down. If the ruler is stuck, the rule that would notice is stuck with it. A
system can monitor itself only for failures that leave the monitoring path working, so
self-monitoring has to be layered, with each layer depending on less of viz than the one
above it.

## 2. Three lines

| Line | Watches | Depends on | Catches |
|---|---|---|---|
| **1. viz on viz** | Everything, in depth: per stage, per cell, per tenant | A healthy *meta cell* of viz | Degradation, saturation, slow drift, correctness auditing, anything a person investigates |
| **2. A watcher outside the data path** | A few vital signs of each cell, including the meta cell | Cloudflare's own analytics and one small Worker that shares no code or storage with viz | viz's ingest, query or ruler being down or wrong, including the meta cell itself |
| **3. Off-platform** | That line 2 is alive | Something not on Cloudflare | Cloudflare-wide outages, and line 2 dying |

A page reaches a person from whichever line sees the problem first. Lines 2 and 3 are
deliberately small: a handful of checks that rarely change.

## 3. Line 1: viz on viz

### 3.1 A separate meta cell

viz's own telemetry goes to a tenant `viz-internal` in a **cell of its own**: its own R2
bucket, shard pool, ledgers, publisher and ruler, deployed from the same code. A failure
in a production cell's storage or shards then does not take out the cell that reports it,
and the meta cell's own load is small and predictable. The meta cell reports on itself
too; for that it relies on line 2.

### 3.2 Where the telemetry comes from

| Source | What it gives | Cost and limits | Use |
|---|---|---|---|
| **White-box metrics emitted by viz components** | The signals only viz knows: lag, backlog, watermarks, fence refusals, audit results | Whatever viz charges itself; designed below to be small | The core of line 1 |
| **Cloudflare GraphQL analytics** (Workers invocations, Durable Object invocations and duration, R2 operations; used by every spike so far) | Platform-measured requests, errors, CPU, wall time, memory overruns (`exceededMemory` appeared in S2), billed duration, R2 operation counts | Free to read; data appeared within about two to three minutes in the spikes; account-wide token | Pulled every minute by an **ingest adapter** into the meta tenant. This is also the first real user of viz's pull/adapter path |
| **Workers OTel export** | Traces and logs of every Worker invocation, sent as OTLP/JSON to an endpoint (`research/02` §1.6) | From 2026-12-01 Workers logs and traces bill at $0.25/GB beyond 50 GB; head sampling is configurable | Point it at the meta cell's own OTLP endpoint once traces ingest exists. Sample: errors always, the rest at a low rate |
| **Tail Workers** | Exceptions, `console` output, outcome of every invocation, in-process | Billed on CPU | For exceptions and outcomes when OTel export is not enough |
| **Workers Analytics Engine** | Cheap, high-cardinality counters written from any Worker, queried by SQL, sampled at high volume | 20 columns, fixed retention, sampling (`research/01`) | Per-tenant metering (usage per key, bytes per tenant), where cardinality would be awkward as metrics. Not for alerting inputs, because it samples silently |
| **Logpush** (zone HTTP logs) | Requests to `vis.bitcru.sh` as Cloudflare saw them | $0.03/GB to R2 | Request-level logs at the edge, including requests that never reached a Worker |

### 3.3 How components emit metrics without feeding back on themselves

Workers cannot be scraped, and a component that sent one ingest request per event would
multiply its own load. The rule:

- **Aggregate in the component, flush on a timer.** Each Worker isolate and Durable Object
  keeps counters, gauges and histograms in memory (fixed bucket boundaries) and flushes them
  as one Remote Write request to the meta cell at most once every 15 s, or at the end of
  an alarm or request when nothing else is pending. Lost increments on eviction are
  acceptable for line 1; correctness signals use the durable mechanisms of §3.6 instead.
- **Self-telemetry never blocks or fails the real work.** It is sent with
  `ctx.waitUntil`, bounded by a small timeout, dropped on error, and never retried more
  than once. A full or failing meta cell causes gaps in viz's own charts, not slower
  ingest for customers.
- **The meta cell does not monitor itself through itself.** Its components write their
  self-metrics to Analytics Engine, not to their own ingest path, so a stuck meta shard
  cannot hide its own state. Line 2 reads those.
- **Bounded cardinality.** A `tenant` label appears only on a short list of metrics (ingest
  volume, rejections, query cost) and only for the top tenants by volume, with the rest
  summed into `tenant="other"`. Shard and leaf identifiers appear as labels; request ids
  never do.

Volume, modelled: about 40 metric families × a few labels × (shards + leaves + rulers +
ledgers). A cell with 50 shards and 32 leaves emits roughly 10,000 series at 15 s, about
670 samples per second. That is a fraction of one shard's measured capacity (S3: about
11,000–133,000 samples per second depending on batching) and well inside the floor cost.

### 3.4 The signals

Named in Prometheus style, consistent with the self-monitoring dashboard already in
`dashboard/examples/viz-ingest-pipeline.json`. Each is mapped to the invariant or budget it
protects (`design/VERIFICATION.md` §2, `design-system` budgets).

| Stage | Metric | Type | Labels | Protects |
|---|---|---|---|---|
| edge | `viz_ingest_requests_total` | counter | cell, signal, protocol, status | availability |
| edge | `viz_ingest_samples_total` | counter | cell, signal, outcome (accepted, rejected), reason | I7, rejection visibility |
| edge | `viz_ingest_ack_duration_seconds` | histogram | cell, signal | ack budget (p50 < 80 ms, p99 < 500 ms) |
| edge | `viz_ingest_decode_cpu_seconds` | histogram | protocol | cost model (13–45 ms per MB measured) |
| shard | `viz_shard_buffer_bytes`, `viz_shard_buffer_limit_bytes` | gauge | cell, shard | backpressure before 503 (S3) |
| shard | `viz_shard_requests_inflight`, `viz_shard_appends_total` | gauge, counter | cell, shard | the 230–290 requests/s ceiling (S3) |
| shard | `viz_shard_oldest_unflushed_seconds` | gauge | cell, shard | freshness, I2 |
| shard | `viz_shard_active_series` | gauge | cell, shard, tenant (top-k) | series limit |
| shard | `viz_shard_tail_reads_total` | counter | cell, outcome (ok, stale_watermark, incarnation_mismatch) | the fence, I4 |
| flush | `viz_flush_duration_seconds`, `viz_flush_failures_total` | histogram, counter | cell, stage (read, encode, put, add_unit, recorded) | flush health |
| flush | `viz_flush_bytes_total`, `viz_flush_files_total` | counter | cell, table | cost, file count |
| ledger | `viz_ledger_outbox_depth`, `viz_ledger_logged_lag_seconds` | gauge | cell, tenant (top-k) | I5; the planned batched log (`contracts/LEDGER-LOG.md`) |
| ledger | `viz_ledger_add_unit_duration_seconds`, `viz_ledger_live_files` | histogram, gauge | cell | S4's one-unit-per-second defect, plan size |
| compaction | `viz_compaction_pending_files`, `viz_compaction_bytes_total`, `viz_compaction_conflicts_total` | gauge, counter | cell, level | file counts that make queries slow |
| retention | `viz_retention_lag_seconds`, `viz_deleted_objects_total`, `viz_orphans_found_total` | gauge, counter | cell | I9, I11 |
| publisher | `viz_publish_lag_seconds`, `viz_publish_verify_failures_total` | gauge, counter | cell, table | external readers' freshness; `verify()` |
| query | `viz_query_duration_seconds` | histogram | cell, endpoint, class (instant, range, metadata) | query budgets |
| query | `viz_query_cost_*` (files, bytes, samples, leaves, shards) | histogram | cell, endpoint | the cost headers already returned per query |
| query | `viz_query_refused_total` | counter | cell, limit | limits doing their job |
| query | `viz_query_replans_total` | counter | cell | fence pressure |
| ruler | `viz_rule_evaluations_total`, `viz_rule_evaluation_failures_total`, `viz_rule_last_evaluation_age_seconds`, `viz_rule_skipped_ticks_total` | counter, gauge | cell, ruler | evaluation completeness (research/08 §3.5) |
| notifier | `viz_notifications_total`, `viz_notification_outbox_depth`, `viz_notification_oldest_undelivered_seconds`, `viz_notification_dead_letters` | counter, gauge | receiver kind | delivery |
| control | `viz_control_key_revocations_total`, `viz_kv_publish_failures_total` | counter | | revocation propagation |
| agents | `viz_agent_runs_total`, `viz_agent_run_cost_dollars`, `viz_agent_tokens_total` | counter | monitor, outcome | agent spend |

Logs: structured JSON, one line per failure and per state change, never per request.
Traces: one trace per ingest request and per query, spanning edge, shard, flush, ledger,
leaves; this is what makes a slow query explainable ("which leaf, which file").

### 3.5 Alerts and SLOs

The meta tenant's ruler holds:

- **SLOs with multi-window burn-rate alerts** (the anomaly library implements the SRE
  workbook's windows): ingest availability, acknowledgement latency, time to queryable,
  query latency per class, rule evaluation lateness.
- **Saturation alerts that fire before customers notice**: shard buffer above 50% of its
  limit, shard in-flight requests above 200 per second sustained, ledger logged lag above a
  minute, compaction backlog growing for an hour, publish lag above its target.
- **Correctness alerts that should never fire**: audit imbalance (§3.6) non-zero, a fence
  refusal that did not lead to a re-plan, a cross-tenant canary marker found, `verify()`
  failing. Each pages immediately.
- **Anomaly detection** on volume per tenant (a sudden drop is often a customer outage
  worth telling them about) and on query cost.

### 3.6 Probers and auditors

Correctness is not visible in rates and latencies, so line 1 includes three active checks,
all from `research/12` §12, each running as a scheduled job in the meta cell:

1. **Canary tenants (black-box probers).** One per cell. Every 15 s a prober writes
   samples whose values are a deterministic function of (prober, sequence, time) through
   Remote Write and OTLP, then reads them back through the public query API at several
   ages: 5 s, 1 min, 1 h, 1 day, and around retention. It reports freshness (write to
   queryable), exactness (every value present, none duplicated), and, by planting a unique
   marker in each canary and querying every *other* canary for it, tenant isolation.
   These are the only signals that test the system the way a customer uses it.
2. **Reconciliation audit (I28).** Counts of rows accepted per tenant, signal and minute at
   the shard, rows flushed per unit, rows admitted by the ledger, and rows after
   compaction must balance. An auditor compares them per closed hour and alerts on any
   difference.
3. **Scrubber.** Samples published files, re-reads them with an independent reader,
   recomputes checksums and statistics against the ledger's index entries (I11, I13), and
   runs the publisher's `verify()`.

## 4. Line 2: the outside watcher

A single small Worker, `viz-watch`, with no bindings to any viz storage and no shared code
beyond a copy of the probe logic. Every minute it:

- reads Cloudflare GraphQL analytics for each cell's Workers and Durable Objects (error
  rate, `exceededMemory`, `exceededCpu`, invocation counts, duration) and R2 operation
  errors;
- runs one end-to-end probe per cell through the public endpoints (write one sample, read
  it back, check the answer and the latency);
- reads the meta cell's Analytics Engine self-metrics (§3.3);
- checks that the meta cell's dead-man's-switch alert arrived in the last two minutes (the
  ruler already has a built-in always-firing rule; its notification goes to `viz-watch`);
- keeps its state in one Durable Object and notifies on-call directly (webhook or paging
  provider), not through viz's notifier.

Cloudflare's own Observability alerts (beta, `research/02` §1.6) on Workers error rate can
act as a second, configuration-only check of `viz-watch`'s targets. Whether those alerts
are available on this account's plan is unverified.

## 5. Line 3: off-platform

Two checks that need nothing from Cloudflare:

- an **external heartbeat**: `viz-watch` pings a dead-man's-switch service every minute;
  if the pings stop, that service pages. Any provider works; it must not run on Cloudflare.
- an **external synthetic check** of `vis.bitcru.sh` from outside Cloudflare's network
  (health endpoint plus one authenticated read), so a Cloudflare-wide outage or a DNS
  mistake is still noticed.

This is the one place the design deliberately leaves Cloudflare: a Cloudflare-only
product cannot detect a Cloudflare-wide failure from inside it.

## 6. What already exists to build on

| Piece | Where | State |
|---|---|---|
| Self-monitoring dashboard spec with these metric names | `dashboard/examples/viz-ingest-pipeline.json` | Written and validated; no data behind it |
| Per-query cost (files, bytes, samples, leaves, shards) | `query/` response headers | Built |
| Ruler `health()`, dead-man's-switch rule, skipped-tick counts | `ruler/` | Built |
| Notifier outbox depth, dead letters | `ruler/` | Built |
| Ledger `outboxDepth()`, `loggedWatermarks()` | `ledger/` | Built |
| Publisher `verify()`, `safeToDelete()` | `publisher/` | Built |
| Shard `describe()`, `seriesCount()` (in progress) | `shard/` | Partly |
| Audit log of control-plane changes | `control/` | Built |
| Reading Cloudflare analytics by GraphQL | `spikes/s0-do-billing/read.mjs`, `spikes/s2…` | Proven in spikes |
| Burn-rate and anomaly detectors | `anomaly/` | In progress |
| Traces ingest and TraceQL | `engine/traceql/` | In progress; ingest not started |

## 7. Phasing

| Phase | Contents | Needs first |
|---|---|---|
| A. Outside first | `viz-watch` (line 2) with GraphQL analytics and one probe per cell; the external heartbeat and synthetic check (line 3) | A deployment under `vis.bitcru.sh` |
| B. Metrics | The metrics module (in-memory aggregation, 15 s flush, `waitUntil`, drop on error) used by every component; the meta cell; the dashboard example backed by real data; saturation and SLO alerts | Phase A; the ledger's batched log, so self-ingest does not hit S4's ceiling |
| C. Correctness | Canary tenants with isolation markers; the reconciliation audit; the scrubber | Compaction and retention finished |
| D. Logs and traces | Workers OTel export to the meta cell; traces across edge, shard, flush and leaves | OTLP logs and traces ingest |
| E. Agents | An investigation agent on the meta tenant with runbooks, read-only, triggered by its alerts | The MCP server and agentic monitor runtime |

## 8. What to measure before committing

1. **GraphQL analytics freshness and completeness**: how long until a minute's
   invocations appear, and whether every failure kind (memory, CPU, exceptions, DO
   overload 503s seen in S3) is visible there. The spikes saw data within two to three
   minutes; not measured systematically.
2. **Self-metrics overhead**: CPU and wall time added to an ingest request and to a shard
   append by in-memory aggregation and the periodic flush, against the S3 baseline.
3. **Workers OTel export**: payload shape, batching, retry behaviour and whether an
   arbitrary OTLP/JSON endpoint is accepted (open question 6 in `research/07`).
4. **The feedback-loop guard**: drive a production cell to overload and confirm that its
   self-telemetry does not make it worse and that the meta cell stays healthy.
5. **Cost**: the meta cell's monthly cost at the modelled volume, and Workers Logs/Traces
   volume at the chosen sampling rate under the December 2026 pricing.

## 9. Decisions this asks for

- A **separate meta cell** rather than a tenant in a production cell: more to deploy,
  but no shared storage or shards with what it watches.
- An **off-platform** heartbeat and synthetic check, as the one exception to "purely
  Cloudflare".
- **Self-metrics as aggregated Remote Write**, not one request per event and not Analytics
  Engine, for everything except the meta cell's own vitals and per-tenant metering.
