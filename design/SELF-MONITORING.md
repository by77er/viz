# Monitoring viz with viz

Status: **proposal**, revised 2026-11-18 after the owner's direction: keep it simple, use
the one deployment, and aim it at understanding scaling and nominal performance. Nothing
here is built.

## 1. The goal

Use viz to see how viz behaves under real load: throughput, latency, saturation, and cost
per operation at each stage, so that capacity limits and performance regressions are
visible from viz's own dashboards rather than from one-off spikes.

It is not, for now, an alerting system for viz's own outages. That changes what matters:

- **Shared fate is acceptable.** When viz is broken, its view of itself goes dark too.
  That is fine for this goal; Cloudflare's own dashboard and analytics remain available
  for diagnosis, and building a second watcher can wait until viz carries production
  traffic someone depends on.
- **Rates, distributions and costs matter more than correctness probes.** Correctness has
  its own tests (`design/VERIFICATION.md`); here the question is "how fast, how much, how
  close to a limit".

## 2. Shape

- **One deployment.** viz's own telemetry goes to a tenant named `viz-internal` in the same
  cell as everything else. No meta cell, no second watcher, no off-platform dependency.
- **Three sources**, all landing in that tenant:
  1. **Component metrics** emitted by viz's own Workers and Durable Objects (§3).
  2. **Cloudflare's analytics** for the same Workers and objects, pulled once a minute:
     billed CPU, wall time, requests, errors, memory overruns, Durable Object duration and
     R2 operations. This is what every spike so far has measured with, and it is the
     ground truth for cost. It also makes this the first real user of viz's pull path.
  3. **One freshness prober**: every 15 s it writes a known sample through Remote Write
     and polls the query API until it appears, recording write-to-queryable time and
     acknowledgement time. Nominal performance as a customer sees it.
- **Dashboards in the `viz.dashboard/v1` format**, starting from the one that already
  exists (`dashboard/examples/viz-ingest-pipeline.json`), plus one for queries and one for
  cost.

## 3. Component metrics

### How they are emitted

Workers cannot be scraped, and one ingest request per event would add load to the thing
being measured. So:

- Each Worker isolate and Durable Object keeps counters, gauges and fixed-bucket
  histograms in memory and sends them as **one Remote Write request every 15 s at most**,
  to its own deployment's ingest endpoint, under the `viz-internal` key.
- Sending is **fire-and-forget** (`ctx.waitUntil`, a short timeout, no retry beyond one,
  drop on error). Self-telemetry can lose a point; it can never slow or fail a customer's
  request.
- Increments lost when an object is evicted are acceptable: this is for trends and
  distributions, not accounting.
- The `viz-internal` tenant gets its own small series and rate limits, so a fault that
  multiplies its telemetry cannot crowd out customers.
- **Bounded cardinality**: shard, leaf and ruler identifiers are labels; a `tenant` label
  appears only on ingest volume, rejections and query cost, and only for the top tenants by
  volume, with the rest as `tenant="other"`.

Modelled volume: a cell with 50 shards and 32 leaves emits roughly 10,000 series at 15 s,
about 670 samples per second, a small fraction of one shard's measured capacity (S3).

### What they measure

Grouped by the question each answers. Names follow the existing dashboard example.

**How much load, and how close to a limit?**

| Metric | Limit it shows the distance to |
|---|---|
| `viz_ingest_requests_total`, `viz_ingest_samples_total` (by signal, outcome) | throughput per cell and per shard |
| `viz_shard_appends_total`, `viz_shard_requests_inflight` | one shard's measured ceiling, 230–290 requests/s (S3) |
| `viz_shard_buffer_bytes` / `viz_shard_buffer_limit_bytes` | backpressure |
| `viz_shard_active_series` | the per-tenant series limit |
| `viz_ledger_add_unit_duration_seconds`, `viz_ledger_outbox_depth` | the ledger's admission rate (S4) |
| `viz_compaction_pending_files` | the file counts that make queries slow |
| `viz_query_cost_*` (files, bytes, samples, leaves) | the per-query limits |

**How fast?**

| Metric | Budget |
|---|---|
| `viz_ingest_ack_duration_seconds` | p50 < 80 ms, p99 < 500 ms |
| prober write-to-queryable | p99 < 10 s |
| `viz_flush_duration_seconds` by stage (read, encode, put, add_unit) | where flush time goes |
| `viz_query_duration_seconds` by class | query budgets |
| `viz_rule_last_evaluation_age_seconds` | rule interval + 15 s |

**At what cost?**

| Source | What it gives |
|---|---|
| Cloudflare analytics | billed CPU per invocation, Durable Object duration, R2 operations, by Worker and class |
| `viz_ingest_decode_cpu_seconds`, `viz_flush_bytes_total`, `viz_flush_files_total` | the inputs to the cost model, per unit of work |

The cost dashboard divides the analytics figures by the work done (samples ingested,
queries served, rules evaluated) to give **cost per million samples, per query and per
thousand rules**, measured, next to the modelled figures in `design/DESIGN.md` §11.

## 4. What it answers that spikes cannot

The spikes measured one thing at a time for a few minutes. With this running continuously:

- how acknowledgement time and shard saturation change as a tenant grows;
- where flush and query time goes at real data shapes, not synthetic ones;
- whether compaction keeps pace with ingest over days;
- what a month actually costs per unit of work, and which stage dominates;
- whether a change made anything slower, by comparing before and after on the same
  dashboards.

## 5. What already exists

| Piece | Where |
|---|---|
| A self-monitoring dashboard spec with these metric names | `dashboard/examples/viz-ingest-pipeline.json` |
| Per-query cost headers | `query/` |
| Ruler `health()` and skipped ticks; notifier outbox depth | `ruler/` |
| Ledger `outboxDepth()`; shard `describe()` | `ledger/`, `shard/` |
| Reading Cloudflare analytics by GraphQL | `spikes/s0-do-billing/read.mjs`, `spikes/s2-engine-in-worker/` |
| Remote Write ingest, the query API, dashboards model | `edge/`, `query/`, `dashboard/` |

## 6. Steps

1. A small shared **metrics module** (counters, gauges, histograms; 15 s flush; fire-and-
   forget) and its use in edge, shard, flush, ledger, query and ruler.
2. The **analytics adapter**: a scheduled job that pulls the last minute of Cloudflare
   analytics for viz's own Workers and writes it to `viz-internal`.
3. The **freshness prober**.
4. **Dashboards**: ingest (exists), query, cost.

All four need viz deployed under `viz.bitcru.sh` first; none needs anything else.

## 7. Measure before relying on it

1. The overhead the metrics module adds to an ingest request and a shard append, against
   the S3 baseline. It should be under a millisecond; if not, flush less often.
2. How long Cloudflare's analytics take to show a minute's data. The spikes saw two to three
   minutes; measure it properly before reading the cost dashboard as live.
3. That an overloaded cell's self-telemetry does not make it worse.

## 8. Later, if viz carries traffic someone depends on

The earlier version of this proposal described what to add then: a watcher outside viz's
data path that pages directly, an off-platform heartbeat, canary tenants that check
isolation, a reconciliation audit, and traces across stages. None is needed for
understanding performance, and each can be added without changing the above.
