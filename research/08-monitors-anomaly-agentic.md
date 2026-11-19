# 08 — Monitors, alerting, anomaly detection, and agentic monitoring

Research date: 2026-11-18. Scope: how viz should model, schedule, evaluate, and notify on monitors; which anomaly detectors to ship; what the 2025–2026 "AI SRE" state of the art implies for an *agentic monitor* primitive on Cloudflare.

**Evidence labels used throughout**

- **[V]** — verified this session against a web source (URL in Sources). "[V-2nd]" means verified only through a secondary source or search-result summary, not the primary page.
- **[T]** — from training knowledge, not re-verified this session. Treat as likely-correct background, confirm before depending on exact numbers.
- **[E]** — my own estimate or design inference.

**Web access note.** Web search and fetch worked, but the session's search budget ran out before every topic was covered. Not re-verified online (so [T]): Prometheus/Alertmanager/Mimir/Grafana alerting internals beyond what is cited, Datadog monitor option details, most classical anomaly-detection literature, Cloudflare Workflows instance/concurrency limits, the exact Durable Object idle-billing rule, Cloudflare Containers unit prices. Pricing for Durable Objects, Workflows, Workers AI, and Claude models *was* fetched from primary pages.

---

## 1. Executive summary

1. **Evaluate rules where the data already is.** The cost of a rule engine on Cloudflare is dominated by (a) SQLite row writes ($1.00/M) and (b) per-evaluation fan-out requests and R2 reads, not by CPU. A design that gives each rule its own Durable Object alarm costs roughly $60 per 1k rules-month at a 1-minute interval; a design that batches about 1k rules into one per-tenant shard DO and evaluates against the ingest hot buffer costs roughly $0.35–0.50 per 1k rules-month [E, from [V] prices]. That is the single most important architectural decision in this document.
2. **Keep Prometheus and Alertmanager semantics, drop their distributed-systems machinery.** `for`, `keep_firing_for`, group-consistent evaluation timestamps, routing tree, grouping, inhibition, and silences are worth copying exactly, because users and existing rule files depend on them. Gossip-based HA dedup, ruler rings, and for-state restoration exist to work around the lack of a single consistent owner; a Durable Object *is* that owner.
3. **Anomaly detection should be tiered, and the cheap tiers should carry almost all of the load.** Independent benchmarks (TSB-AD, NeurIPS 2024) find simple statistical methods often match or beat deep models for anomaly detection [V]. Time-series foundation models (Toto 2.0, Chronos-2, TimesFM 2.5) are now strong zero-shot forecasters, but none is in the Workers AI catalog [V], so they belong in an optional tier, not on the per-sample path.
4. **AI SRE agents are useful and not reliable.** Published benchmarks put frontier-agent root-cause accuracy between about 10% and 60% depending on realism (ORCA-bench best 25.3% on realistic inputs; ITBench-AA best 46.7%; SREGym best about 60.7% without noise, dropping 7–30% with noise) [V / V-2nd]. Hallucinated root causes appear in 7–40% of reports on ORCA-bench [V]. The product consequence: an agentic monitor must be gated by deterministic guard conditions, must produce evidence-linked findings with an explicit "inconclusive" outcome, and must be replayable against past incidents.
5. **Vendor convergence on architecture.** Datadog moved from a multi-phase multi-agent orchestration to a simpler tool-calling loop plus code execution over its MCP server, and reports cost per investigation falling from about $25 to about $4 and duration from about 11 minutes to about 2 minutes [V]. Honeycomb describes its agent as an off-the-shelf model calling tools in a loop [V-2nd]. The durable lessons are hypothesis-scoped evidence, server-side pre-aggregation of tool results, and continuous replay evaluation; elaborate orchestration is not one of them.
6. **Agentic monitors cost three to four orders of magnitude more per unit than classical rules** (roughly $0.03–$2 per investigation depending on model [E]) and need their own budget model. Classical rules should be effectively free at the margin; agent runs should be metered, capped, and attributable.

---

## 2. Classical alerting: the semantics worth copying

### 2.1 Prometheus alerting and recording rules

- **Rule groups.** Rules live in groups; rules within a group run sequentially at a regular interval with the same evaluation timestamp [V]. Sequential order is what lets a recording rule's output be consumed by a later rule in the same group at the same timestamp [T]. Different groups run independently and concurrently [T].
- **Alert lifecycle.** An alerting expression returns a vector; each element (label set) is one alert instance. Instances go `inactive → pending → firing`. `for:` is the time the condition must hold before firing. `keep_firing_for:` keeps the alert firing for a duration after the condition was last met; without it, the alert deactivates on the first evaluation where the condition is not met [V]. `keep_firing_for` is the built-in hysteresis against flapping caused by brief gaps or threshold oscillation.
- **Interval and `for` interplay.** `for` is only checked at evaluations, so a group evaluated every 5 minutes with `for: 1m` fires on the second consecutive matching evaluation, 5 minutes later [V]. viz should validate `for >= interval` or warn.
- **`query_offset` / `rule_query_offset`.** Shifts a group's evaluation timestamp into the past to tolerate late-arriving samples, at the price of slower detection [V]. This matters more for viz than for Prometheus, because viz ingest is remote-write/OTLP push with network and batching lag.
- **Concurrent evaluation within a group.** Experimental `concurrent-rule-eval` evaluates rules that have no dependency on each other in parallel, bounded by a global concurrency cap, at the cost of more query load [V]. Prometheus derives dependencies by analysing which rules read which recorded series [T].
- **Missed evaluations.** If an evaluation takes longer than the interval, later iterations are skipped and counted (`prometheus_rule_group_iterations_missed_total`) rather than queued [T]. There is no back-fill of alert state.
- **Restart behaviour.** `for` state is restored from the `ALERTS_FOR_STATE` series, subject to an outage tolerance (default 1h) and a grace period (default 10m) [T].
- **Delivery to Alertmanager.** Prometheus re-sends firing alerts periodically (default resend delay 1m) with an `endsAt` a few intervals in the future; an alert that stops being re-sent expires in Alertmanager [T]. This is a heartbeat-with-TTL protocol; resolution is implicit.
- **Staleness and absence.** A series with no sample in the lookback window (5m by default) disappears from instant vectors, so `up == 0` cannot detect a target that vanished entirely; `absent()` / `absent_over_time()` are the workaround and they lose labels [T]. This is the root of the "no data" problem that Grafana and Datadog model explicitly.

### 2.2 Alertmanager [T unless marked]

- **Routing tree.** Alerts enter at the root route and descend; each route has matchers, a receiver, `continue`, and grouping parameters. First matching child wins unless `continue: true`.
- **Grouping.** `group_by` labels define a notification group. `group_wait` (default 30s) delays the first notification to batch co-firing alerts; `group_interval` (default 5m) is the minimum gap between notifications about changes to a group; `repeat_interval` (default 4h) re-sends an unchanged firing group.
- **Inhibition.** A firing "source" alert suppresses "target" alerts when both match their matcher sets and agree on the `equal` labels. Classic use: a cluster-down alert mutes per-service alerts.
- **Silences.** Time-bounded matcher sets, created by API/UI, applied at notification time. Mute time intervals and active time intervals add calendar-based suppression per route.
- **Dedup and HA.** Multiple Alertmanagers gossip silences and a notification log. Each instance delays by its position in the peer list times a peer timeout, then checks the log before sending. This is best-effort; network partitions produce duplicate notifications. The whole mechanism exists because there is no single owner of group state.
- **Design lesson.** The valuable part is the *model* (labels in, routing tree, grouping, inhibition, silence). The fragile part is the replication. viz can keep the former and replace the latter with one consistent per-tenant owner.

### 2.3 Grafana Unified Alerting [T]

- A rule is a small dataflow: one or more datasource queries, then server-side expressions (reduce, math, threshold, classic condition), with one node marked as the condition. Multi-dimensional rules produce one alert instance per label set.
- States: Normal, Pending, Alerting, plus explicit **NoData** and **Error**, each with a configurable mapping (treat as Alerting, NoData, Normal/OK, or keep last state). Recent versions add a "Recovering" state implementing keep-firing-for.
- Notification policies are an Alertmanager routing tree; contact points are receivers; mute timings are time intervals. Grafana-managed rules are evaluated by Grafana's scheduler against any datasource; datasource-managed rules are delegated to a Mimir/Loki ruler.
- Lessons: explicit NoData/Error handling per rule is something Prometheus lacks and users want; the query-then-expression split lets one rule span datasources; evaluating arbitrary datasource queries per rule is what makes Grafana alerting expensive at scale (Grafana documents performance limits and advises keeping evaluation interval well below the pending period [V]).

### 2.4 Mimir ruler [T]

- Rule groups are stored per tenant in object storage and sharded across ruler replicas via a hash ring (optionally shuffle-sharded per tenant). Each ruler runs the Prometheus rule manager for the groups it owns.
- Two evaluation modes: internal (the ruler embeds a querier and ingester client) and **remote** (the ruler sends queries to the query-frontend, gaining query sharding, splitting, and results caching, and isolating rule load from the ruler process).
- Per-tenant limits cap rule groups and rules per group. Recording rule results are written back through the distributors.
- Lessons: rule evaluation at scale is a *query scheduling* problem; the engine that wins is the one that shares caching and work across rules. The ring exists only to assign ownership, which a Durable Object name gives for free.

### 2.5 Datadog monitor taxonomy [T]

| Monitor type | What it evaluates | Notes relevant to viz |
|---|---|---|
| Metric — threshold | Aggregated query vs. alert/warning thresholds, with separate recovery thresholds | Recovery thresholds are explicit hysteresis |
| Metric — change | Absolute or percent change vs. N minutes ago | A special case of comparing two windows |
| Metric — anomaly | Deviation from a seasonal band; algorithms `basic`, `agile`, `robust` | See section 4 |
| Metric — outlier | One group member behaving unlike its peers; DBSCAN or MAD (plus scaled variants) | Cross-sectional, needs group-by |
| Metric — forecast | Predicted crossing of a threshold within a horizon; linear or seasonal | Disk-full style alerts |
| Composite | Boolean combination of other monitors' states | Requires a monitor-state bus |
| Log | Count or measure over a log search, grouped | |
| APM / trace analytics | Latency, error rate, throughput per service or span query | |
| SLO | Error budget remaining, or burn rate | |
| Others | Event, host, process, service check, synthetics, RUM, CI, error tracking, Watchdog | |

Cross-cutting options worth copying: "notify on missing data after N minutes" versus "evaluate as zero" versus "show last known status"; evaluation delay; `require_full_window`; new-group delay (do not alert on a series for its first N seconds); renotification interval; per-group ("multi alert") versus aggregate ("simple alert") notification; message templating with conditional blocks.

### 2.6 SLOs and multi-window multi-burn-rate alerts [T]

- Burn rate = observed error ratio divided by the error budget ratio (1 − SLO). Burn rate 1 spends exactly the budget over the SLO window.
- The Google SRE Workbook recommendation for a 30-day window:

| Severity | Long window | Short window | Burn rate | Budget consumed when it fires |
|---|---|---|---|---|
| Page | 1h | 5m | 14.4 | 2% |
| Page | 6h | 30m | 6 | 5% |
| Ticket | 1d | 2h | 3 | 10% |
| Ticket | 3d | 6h | 1 | 10% |

  Both windows must exceed the threshold. The long window gives significance; the short window gives fast reset, so the alert stops soon after the problem does.
- Known weaknesses: low-traffic services (a handful of errors trips a 14.4× rate), which is usually handled with a minimum-request-count guard; and the cost of evaluating long ranges on every tick, which is why Sloth and Pyrra generate *recording rules* for each window's error ratio and alert on those.
- **OpenSLO** is a vendor-neutral YAML spec (SLO, SLI, AlertPolicy, AlertCondition, DataSource). **Sloth** and **Pyrra** compile a short SLO definition into Prometheus recording and alerting rules implementing the table above.
- Implication: SLO is a first-class monitor kind whose compiler emits incremental window aggregates, not a user-authored PromQL expression over `[3d]`.

### 2.7 No-data, flapping, hysteresis, and fatigue

- **No-data** has at least four distinct meanings: the series never existed, the series stopped (target died), the query returned empty because the filter matches nothing at present (for example no errors, which is good), and the evaluation failed. Conflating them is the commonest source of both missed and false alerts. Each needs a per-monitor policy.
- **Flap control** techniques, in increasing strength: `for` (debounce onset), `keep_firing_for` (debounce recovery), separate recovery threshold (hysteresis band), flap detection (state-change rate over a window, as in Nagios [T]) that holds a single "flapping" notification, and grouping intervals at the notification layer.
- **Alert fatigue.** The practitioner consensus [T, not re-verified]: page only on symptoms that are urgent, actionable, and user-visible; route everything else to tickets or dashboards; prefer SLO burn alerts to cause-based thresholds; review alerts by precision (what fraction led to action). A useful product metric for viz: per-monitor counts of notifications, acknowledgements, time-to-resolve, and auto-resolved-within-N-minutes, exposed as a "monitor quality" view, and available to agents as a tool.

### 2.8 Notification channels and escalation [T]

| Channel | Dedup / idempotency handle | Resolve semantics |
|---|---|---|
| PagerDuty Events API v2 | `dedup_key` with `trigger` / `acknowledge` / `resolve` actions | Explicit resolve event |
| Opsgenie (Atlassian has announced its wind-down in favour of Jira Service Management / Compass; confirm timeline) | `alias` | Explicit close |
| incident.io alert sources | Deduplication key on alert events | Status field |
| Slack | None for `chat.postMessage`; store the returned `ts` and update/thread | Edit or thread reply |
| Microsoft Teams | Workflows/Power Automate webhooks (legacy O365 connectors retired); no idempotency | New card |
| Email | `Message-ID` / threading headers | New mail in thread |
| Generic webhook | Send an `Idempotency-Key` header and a stable event id; sign with HMAC | Payload `status` |

Escalation policies and on-call schedules are a product of their own (PagerDuty, incident.io, Grafana IRM). viz should integrate with them first and offer only a minimal built-in escalation (re-notify to a second receiver if not acknowledged within N minutes), which the grouping engine can express as a timed route.

---

## 3. Scheduling and evaluating millions of rules serverlessly

### 3.1 Cloudflare primitives and their prices

| Primitive | Semantics relevant here | Price (Workers Paid) |
|---|---|---|
| Durable Object requests | Includes alarm invocations, RPC, HTTP | 1M included, then $0.15/M [V] |
| Durable Object duration | Billed on 128 MB while active | 400k GB-s included, then $12.50/M GB-s [V] |
| DO SQLite storage | Each `setAlarm()` is billed as one row written | Rows written 50M included then $1.00/M; rows read 25B included then $0.001/M; 5 GB included then $0.20/GB-month [V] |
| DO alarms | One alarm per object; at-least-once; retried with exponential backoff from 2s, up to 6 retries [V] | As requests + one row write per `setAlarm` |
| Workflows | Durable steps with retries; sleeping instances incur no CPU, only storage | Steps 500k included then $0.80 per 100k; storage 1 GB included then $0.20/GB-month; billing started 2026-08-10 [V] |
| Queues | At-least-once delivery, batches, retries, DLQ | $0.40/M operations; about 3 operations per delivered message [V-2nd] |
| Cron Triggers | Per-account limit: 250 on Paid, 5 on Free [V-2nd] | Worker invocation |
| Workers | Stateless compute | 10M requests included then $0.30/M; 30M CPU-ms included then $0.02/M ms [V, from the Workflows pricing table which shares these units] |
| Agents SDK | Agent = Durable Object with SQLite, `schedule()` / `scheduleEvery()` (delay, date, cron; persisted; idempotent for recurring jobs), fibers (`runFiber`, `startFiber` with idempotency keys, `stash()` checkpoints, `onFiberRecovered`), sub-agents, MCP client and server [V] | DO pricing |

Consequences:

- **Cron Triggers cannot be the per-rule scheduler** (250 per account). One cron is useful only as a safety-net sweeper that re-arms shard alarms that have gone missing.
- **A Workflow instance per rule is the wrong tool.** Two steps per tick at a 1-minute interval is 86.4M steps per 1k rules-month, about $690 [E]. Workflows are right for rare, long, multi-step jobs (investigations, back-tests, notification escalations).
- **A DO alarm per rule is too expensive** because each re-arm is a billed row write (see 3.6).
- **The DO alarm is the right tick source when shared**: one alarm per shard, many rules per shard.

### 3.2 Recommended scheduling shape: per-tenant rule shards

- `RuleShard` Durable Object, named `tenant/{id}/rules/{shard}`. Holds up to a configured number of rules (start at about 1,000 rules or a CPU budget per tick, whichever is hit first) grouped into Prometheus-style groups.
- One alarm per shard, armed for the next due group boundary. Evaluation timestamps are **grid-aligned and deterministic**: `ts = floor(now / interval) * interval − query_offset`, with a per-group phase offset derived from a hash of the group id to spread load (Prometheus does the same [T]).
- Rules are placed into shards by tenant, then by the hot-buffer shard(s) their selectors touch, so that one batched RPC per tick per data shard evaluates many rules.
- Shards split when tick CPU time or rule count exceeds a threshold; the tenant's control DO owns the shard map. Small tenants have exactly one shard, which hibernates between ticks; a tenant with zero rules has zero cost.

### 3.3 Evaluate on the write path against the hot buffer

Assumption (owned by the ingest/storage design): recent samples live in memory or DO SQLite in ingest shard DOs for some window before being compacted to Parquet on R2. Rules should be evaluated against that buffer.

Why: an R2 `GET` is a billed Class B operation and Parquet decode is CPU-heavy. A rule that touches five objects per evaluation costs about $78 per 1k rules-month at a 1-minute interval in R2 reads alone at $0.36/M Class B [E; R2 price is T]. Detection latency also improves, since the evaluator does not wait for flush and commit.

Three evaluation classes, chosen by the rule compiler:

1. **Streamable (the majority).** Lookback no greater than the hot window, and built from operators with small incremental state: `rate`/`increase`/`delta` (first and last sample per series in window), `sum/avg/min/max/count _over_time` (ring of sub-buckets), `histogram_quantile` over rates, `absent`, comparisons, label-preserving aggregations. Evaluated by a batched RPC to the hot buffer at each tick. Optionally, the hot buffer maintains a **selector index** (series id → interested rules) so that per-rule window state is updated as samples arrive and the tick only reads finished aggregates.
2. **Long-window (SLO burn, week-over-week baselines, forecasts).** Compiled into **incremental rollups**: fixed-width buckets (for example 1m or 5m sums of good/total) maintained at ingest and persisted, so that a 3-day ratio is a sum over stored buckets, not a scan. This is what Sloth/Pyrra recording rules achieve by hand.
3. **Cold / ad hoc.** Anything else (arbitrary PromQL over hours of history, TraceQL search monitors, cross-tenant queries). Evaluated through the normal query path with a minimum interval (for example 5 minutes), a results cache keyed on the normalized expression and aligned step, and a per-tenant concurrency budget. The UI should tell the author which class a rule landed in and why.

"Alerting at ingest" has precedent: stream aggregation in VictoriaMetrics' agent, Mimir's remote evaluation with cached and split queries, and rule engines in streaming systems [T]. What is specific here is that the hot buffer and the evaluator are separated only by an in-colo RPC and the buffer's owner is single-threaded, so incremental state needs no locking.

### 3.4 Sharing computation across rules

- **Normalize and hash expressions.** Identical sub-expressions across rules in a tenant (very common with templated rules per service) are evaluated once per tick. Hash the PromQL AST after constant folding and matcher sorting.
- **Selector sharing.** Many rules select the same series with different thresholds. Evaluate the vector once, apply N comparisons.
- **Recording rules as the user-visible sharing mechanism**, plus automatic materialization of hot sub-expressions shared by many rules.
- **Dependency DAG.** Recording rules consumed by other rules are ordered topologically within the tick and their outputs are written to the hot buffer at the evaluation timestamp, preserving Prometheus's "same timestamp, visible to later rules" guarantee. Independent rules evaluate concurrently.
- **Batching.** One RPC per (rule shard, data shard, tick) carries all expressions. Per-rule subrequests would cost about $6.50–$20 per 1k rules-month in request fees alone [E].

### 3.5 Alert state machine, storage, and catch-up

State per alert instance (fingerprint = hash of monitor id and label set):

```
            cond true            held >= for
  OK ───────────────▶ PENDING ───────────────▶ FIRING
   ▲                     │ cond false              │ cond false
   │                     ▼                         ▼
   └──────────────────── OK ◀── keep_firing_for ── RECOVERING
                                    elapsed          │ cond true
                                                     └────────▶ FIRING

  NODATA and ERROR are separate states entered per the monitor's policy:
  nodata_policy:  ok | nodata | alerting | keep_last   (plus a grace period)
  error_policy:   error | alerting | keep_last
```

- **Storage rule: write on transition, not on evaluation.** In-memory state is authoritative between ticks; SQLite holds (a) rule definitions, (b) one row per *non-OK* alert instance, updated only when state or annotations change, (c) a transactional outbox of notifications, and (d) one shard cursor row (`last_evaluated_ts`). Writing `lastEval` per rule per tick would cost $43 per 1k rules-month at 1-minute intervals [E]; the cursor makes it $0.04.
- **Recovery after eviction or deploy.** On wake, the shard reloads non-OK instances from SQLite. `PENDING` instances carry `active_since`, so `for` survives restarts without an `ALERTS_FOR_STATE` side channel.
- **Missed-evaluation catch-up.** Because evaluation timestamps are grid-aligned and data is still in the hot buffer, a late alarm can **replay missed ticks in order** up to a bound (for example the lesser of 10 ticks or the hot window). Beyond the bound, skip to the present, count the gap in a metric, and extend `for` timers conservatively (do not fire on a condition that was not observed continuously; do not resolve on an unobserved gap). This is stricter than Prometheus, which just skips.
- **Late data.** Default `query_offset` per tenant derived from observed ingest lag (for example p99 lag plus a margin), overridable per group.
- **Sweeper.** A single Cron Trigger periodically asks each tenant control DO to verify that every shard has an armed alarm. Alarm retries stop after 6 attempts [V], so a persistent failure otherwise silently stops evaluation.
- **Meta-monitoring.** Every shard emits `viz_rule_evaluations_total`, `..._missed_total`, `..._duration_seconds`, and last-evaluation age into the tenant's own metrics, and a platform-level dead-man's-switch monitor alerts when any shard's last-evaluation age exceeds twice its interval.

### 3.6 Exactly-once notification (in practice: effectively-once)

- Alarms and Queues are at-least-once [V]. True exactly-once delivery to third parties is impossible; the goal is **no lost notifications and idempotent duplicates**.
- **Transactional outbox.** The state transition and the outbox row are written in the same DO storage transaction. A crash after commit re-drives the outbox; a crash before commit re-evaluates the tick.
- **Deterministic notification id**: `hash(tenant, receiver, group_key, group_state_version)`. Delivery workers record sent ids (in the router DO) and skip repeats; receivers get the id as `dedup_key` (PagerDuty), `alias` (Opsgenie), or an `Idempotency-Key` header (webhooks). For Slack, the stored message `ts` turns a duplicate into an update.
- **Pipeline.** `RuleShard` → (RPC) → per-tenant `AlertRouter` DO (routing tree, grouping timers, inhibition, silences, mute timings; one alarm for the next group flush) → Queue → stateless delivery Worker per integration with retry, backoff, and a dead-letter queue surfaced in the UI. The router is the single consistent owner that replaces Alertmanager's gossip.
- **Resolve semantics.** Unlike Prometheus's heartbeat-with-`endsAt`, viz evaluators send explicit transitions to the router, and the router expires instances only if the owning shard has been silent beyond a TTL (so a dead evaluator produces a "monitor evaluation stalled" alert, not a false resolve).
- **Compatibility.** Accept Alertmanager v2 `POST /api/v2/alerts` so that external Prometheus servers and other tools can use viz's router, and accept Alertmanager routing YAML for import.

---

## 4. Anomaly detection

### 4.1 Method survey, judged for cheap per-series streaming

| Method | Idea | State per series | Streaming cost | Strengths | Weaknesses |
|---|---|---|---|---|---|
| EWMA / EWMVar (z-score) | Exponentially weighted mean and variance | 2–3 floats | O(1) | Trivial, adapts | No seasonality; contaminated by the anomaly itself; assumes roughly Gaussian |
| Robust z-score (median / MAD) | Median and median absolute deviation over a window | Window or quantile sketch | O(log n) or sketch update | Outlier-resistant | Window memory unless sketched |
| Seasonal robust baseline | Median/MAD (or quantile sketch) per hour-of-week bucket | 168 × 2 floats (about 1.3 KB) | O(1) | Handles daily and weekly seasonality with tiny state; interpretable | Needs 2–3 weeks warm-up; no trend |
| Holt-Winters / ETS | Level, trend, seasonal components with exponential smoothing | Season length floats (288 for daily at 5m; 2,016 for weekly at 5m) | O(1) | Trend plus one seasonality, online | Parameter sensitivity; one seasonal period (double-seasonal variants exist) |
| STL / MSTL | Loess decomposition into trend, seasonal(s), remainder | Batch over history | Batch, periodically refit | Robust decomposition; MSTL handles multiple seasonalities | Not streaming; refit hourly or daily and score residuals online |
| S-H-ESD (Twitter, 2014) | STL-like decomposition with median, then generalized ESD test on residuals | Batch | Batch | Good on seasonal series with spikes | Batch; superseded in practice by decomposition plus robust residual score |
| Prophet | Additive regression: piecewise trend, Fourier seasonality, holidays | Model fit | Expensive fit | Handles holidays, missing data | Heavy; slow; often beaten by simpler seasonal baselines on ops data |
| SARIMA | Seasonal ARIMA | Model fit | Expensive fit, cheap forecast | Datadog's `agile` is described as SARIMA-based [T] | Fitting cost; fragile automation |
| Random Cut Forest | Isolation-style forest over shingled points, online updates | Trees (tens to hundreds of KB) | O(trees × log n) | Streaming, multivariate, no distribution assumption | Heavier state; scores need calibration; less interpretable |
| Matrix profile | Nearest-neighbour distance of every subsequence; discords = anomalies | O(n) | STUMPI incremental is O(n) per point | Finds shape anomalies | Too heavy per series at scale; good as an on-demand tool |
| CUSUM / Page-Hinkley | Cumulative sum of deviations; alarm on drift | 2 floats | O(1) | Detects small sustained level shifts quickly | Needs a reference mean and tuning |
| BOCPD (Adams & MacKay, 2007) | Bayesian posterior over run length | Run-length distribution (prunable) | O(run lengths kept) | Online changepoint probability | Model assumptions; more state |
| PELT (Killick et al., 2012) | Exact offline optimal segmentation with pruning | Batch | Linear-ish offline | Accurate offline segmentation | Offline |
| E-Divisive (Matteson & James) | Non-parametric energy-statistic changepoints | Batch | Offline, quadratic-ish | Distribution-free; used for performance regression detection (MongoDB, Netflix) [T] | Offline |

Industry practice [T]:

- **Datadog**: `basic` (rolling quantiles, no seasonality), `agile` (seasonal, adapts fast to level shifts), `robust` (seasonal-trend decomposition, stable, slow to adapt); a `bounds` multiplier; hourly/daily/weekly seasonality. The three-way choice is a clear expression of the stability-versus-adaptivity trade-off.
- **Grafana**: Grafana Cloud ML forecasting and outlier detection (DBSCAN / MAD); also a published approach of computing anomaly bands *purely in PromQL recording rules* (moving average ± k × stddev, with seasonal offsets). The latter is attractive for viz because it needs no new engine, only recording rules.
- **Elastic ML**: per-bucket Bayesian models with automatic periodicity and trend detection, anomaly scores normalized to 0–100, and "influencers" that attribute anomalies to field values.
- **Netflix** (robust PCA, later E-Divisive for regressions), **LinkedIn** (Luminol, ThirdEye), **Uber** (forecast-based alerting at very large series counts), **Twitter** (S-H-ESD), **AWS** (Random Cut Forest in several services).
- **Honeycomb Anomaly Detection** (2026) explicitly uses statistical models, not LLMs, building a per-service baseline, and can auto-start an agent investigation when it fires [V-2nd].

Independent evidence: TSB-AD (NeurIPS 2024) reports that simpler architectures and statistical methods often perform better than advanced neural models for time-series anomaly detection, with neural models doing well on multivariate cases and foundation models on point anomalies; a follow-up (TSB-AutoAD) says foundation models have yet to deliver one-size-fits-all detection [V]. This supports a statistics-first design.

### 4.2 Baselines from sketches, and seasonality detection

- Keep per-(series, hour-of-week) **quantile sketches** (DDSketch or t-digest) to derive median and robust spread; DDSketch's relative-error guarantee suits latency. If the platform already stores native histograms or DDSketches, baselines are a merge away.
- **HyperLogLog** for cardinality anomalies (sudden growth of distinct label values, users, or error fingerprints); **count-min / top-k** for heavy-hitter shifts in logs.
- **Seasonality detection** does not need a general period search. Test only the candidates that occur in operations data (1 day, 1 week): compare the autocorrelation at those lags, or the variance explained by an hour-of-day versus hour-of-week bucket mean, against a threshold; pick none, daily, or weekly. Re-test weekly.
- **Contamination control.** Do not update the baseline with points flagged anomalous (or down-weight them), and freeze learning during known incidents and silences. Otherwise the detector learns the outage.

### 4.3 Cross-sectional outliers

- Datadog's outlier monitors use DBSCAN or MAD across the members of a group [T]. For a group of N series at one timestamp, the MAD version is O(N log N) and stateless: flag members whose value deviates from the group median by more than k × MAD for a sustained fraction of the window.
- This fits the batched hot-buffer evaluator well: it is a pure function of an instant or short-range vector.

### 4.4 Correlation and root-cause hints

- **Honeycomb BubbleUp**: for a selected set of events (for example slow requests) versus the baseline, compare the value distribution of every attribute and rank attributes by how different the distributions are [T]. This is the highest-value RCA primitive for wide events and spans, and is now also exposed to agents through Honeycomb's MCP server [V-2nd].
- **Dimension contribution** for metrics: for a change in an aggregate, compute each label value's share of the delta, and rank by explanatory power and surprise (Adtributor, HotSpot, and Squeeze are the academic lineage [T]). A simple, robust version: for each label key, compute Jensen-Shannon divergence between the baseline and current distributions of the measure over that key's values, and report the top values by contribution.
- **Datadog Watchdog**: always-on detection across services without configuration, with correlated "stories" and root-cause/impact analysis [T].
- **Change correlation**: deploys, config changes, feature flags, and scaling events aligned to anomaly onset. Cheap and very often the answer; it requires viz to ingest change events as a first-class signal.

### 4.5 Logs and traces

- **Logs**: online template mining with **Drain** (fixed-depth parse tree; Drain3 is the maintained implementation [T]) at ingest, storing a template id per line. Detection then works on small-cardinality counts: new template never seen before for this service, template rate change versus seasonal baseline, and error-level template ratio. This also gives agents a compact log summary (templates with counts and one exemplar each) instead of raw lines.
- **Traces**: per (service, operation) latency sketch compared to baseline using quantile shift or a distribution distance over DDSketch bins; error-rate change; **new error fingerprints** (hash of exception type plus normalized top frames or status message); structural changes such as a new downstream dependency or a jump in span count per trace.

### 4.6 Time-series foundation models

| Model | Origin | Size / release facts | Licence | Notes |
|---|---|---|---|---|
| Toto (Open-Base-1.0) | Datadog, May 2025 | 151M parameters; trained largely on observability data; Student-t mixture head for heavy tails [V] | Apache 2.0 [V] | Released with BOOM, a benchmark of 350M observations across 2,807 real production series [V] |
| Toto 2.0 | Datadog, 2026-05-14 | Five sizes: 4M, 22M, 313M, 1B, 2.5B; single-pass forecasting; 4,096-step training context [V] | Apache 2.0 [V] | Vendor-reported BOOM CRPS rank: 2.5B 3.88, 313M 4.25, 22M 5.52, 4M 7.17, versus Toto 1.0 6.94 and Chronos-2 7.39. The 22M model beats Chronos-2 on Datadog's own observability benchmark; the 4M model is pitched for edge deployment; CPU latency is not published [V] |
| Chronos-2 | Amazon, Oct 2025 | 28M and 120M variants; univariate, multivariate, and covariates via group attention; about 300 series/s on one A10G GPU [V-2nd] | Apache 2.0 [V-2nd] | Ranked first among pre-trained models on GIFT-Eval at an April 2026 snapshot [V-2nd] |
| Chronos-Bolt | Amazon | Small, fast patch-based variants down to a few million parameters [T] | Apache 2.0 [T] | CPU-friendly sizes exist [T] |
| TimesFM 2.5 | Google | 200M parameters, decoder-only [V-2nd] | Apache 2.0 [V-2nd] | One independent bench: 86 ms per warm call versus 3.7–6.5 ms for Chronos-2 on the same GPU [V-2nd] |
| Moirai / Moirai 2 | Salesforce | Any-variate masked encoder [T] | Check per release [T] | |
| Lag-Llama | Academic | Small decoder-only probabilistic model [T] | Apache 2.0 [T] | Largely superseded |
| TimeGPT | Nixtla | Closed, API-only [T] | Proprietary | An external SaaS dependency, contrary to the "purely Cloudflare" goal |

Assessment:

- **Accuracy.** For zero-shot *forecasting*, current models are strong and improving, and the top of GIFT-Eval is statistically crowded (a 2026 paper notes that neighbouring top-ten entries are not separable) [V-2nd]. For *anomaly detection* the evidence that they beat tuned statistical baselines is mixed [V]. All headline numbers for Toto are vendor-reported.
- **Runnable on Workers AI?** No. The Workers AI catalog fetched today lists text-generation and embedding models and no time-series models [V]. Options within Cloudflare: (a) Cloudflare Containers running ONNX/PyTorch on CPU (Containers reached GA in April 2026 per secondary sources [V-2nd]); (b) ONNX Runtime compiled to WebAssembly inside a Worker for the smallest models (a 4M-parameter model is about 16 MB in float32, which is plausible within Worker memory limits, but unproven [E]); (c) bring-your-own-model on Workers AI where the account has access to it [T]. None of these is turnkey.
- **Cost.** Per-sample scoring with a transformer for millions of series is not economical. Hourly or on-demand forecasting for a subset of monitors is.
- **Where they fit in viz.** (1) Monitor creation: zero-shot forecast band preview and back-test with no warm-up, which removes the cold-start problem of seasonal baselines. (2) Forecast monitors evaluated hourly (capacity, saturation). (3) A tool for agents ("is this series behaving unusually given its history?"). (4) Optional second-opinion scoring on points already flagged by tier 1, to cut false positives.

### 4.7 Recommended tiered detector design

| Tier | Runs | Methods | State and cost | Purpose |
|---|---|---|---|---|
| 0 — inline | Every tick, in the hot-buffer evaluator | Static thresholds; EWMA z-score; rate-of-change; group MAD outliers; CUSUM for level shifts | A few floats per series, in memory; flushed with the shard checkpoint | Catch gross deviations with zero warm-up |
| 1 — seasonal baseline | Scored every tick; baseline updated incrementally; decomposition refit daily in a Workflow | Hour-of-week robust baseline (median/MAD or quantile sketch); Holt-Winters where trend matters; MSTL refit for residual scale; changepoint (BOCPD online, PELT offline) to reset baselines after level shifts | About 1–8 KB per series, stored as one blob per shard in R2 or DO SQLite, written hourly | Datadog-style anomaly monitors with `agile` / `robust` personalities |
| 2 — foundation model (optional) | On demand, hourly, or on tier-1 flags | Toto 2.0 small sizes or Chronos-2 / Chronos-Bolt in a Container | Container CPU seconds; no per-series state | Cold start, forecast monitors, agent tool, false-positive filter |
| 3 — explanation | When an anomaly fires | Dimension contribution, BubbleUp-style attribute comparison, log template deltas, change-event correlation | Bounded queries against hot buffer and recent Parquet | Attach "what changed" to the alert, and hand the agent a head start |
| 4 — agentic | On firing alerts that opt in, within budget | LLM investigation (section 6) | Dollars per run | Narrative, cross-signal reasoning, judgement |

User-facing controls for anomaly monitors: sensitivity (band width), direction (above, below, both), seasonality (auto, none, daily, weekly), adaptivity (`agile` / `robust`), minimum deviation in absolute units (prevents alerts on tiny but statistically significant changes), and warm-up handling (do not alert until the baseline has N periods, unless tier 2 provides a band).

---

## 5. Agentic monitoring and AI SRE: state of the art, 2025–2026

### 5.1 Products

| Product | Status and facts | Architecture notes |
|---|---|---|
| **Datadog Bits AI SRE / Bits Investigation** | GA announced December 2025 [V-2nd]. Datadog reports cost per investigation about $25 at launch, about $6.50 with its second-generation architecture, about $4 by October 2026; duration about 11 minutes to about 2 minutes; internal quality score up 44% versus March 2026 [V]. Pricing page lists 6.5 AI credits per autonomous investigation; earlier pricing was about $500 per 20 conclusive investigations per month [V-2nd] | Gen 1: coordinated multi-agent phases (context, hypothesis generation, testing). Gen 2 and current: simpler ReAct loop per agent, model routing per task, and **code execution through the Datadog MCP Server** so one tool call queries several sources, correlates, and returns a summary [V] |
| **Datadog Scout 1.0** | Announced October 2026: an SRE-specialized model built on GLM-5.3 Flash, post-trained with reinforcement learning in investigation simulations; Datadog claims parity with frontier models at high effort and 12–19× lower cost at medium effort; limited availability [V-2nd] | Signals that a mid-size open model, specialized, is competitive for this task. GLM-5.3 Flash itself is in the Workers AI catalog at $0.15 / $0.50 per million tokens [V] |
| **Grafana Assistant and Assistant Investigations** | Assistant GA and Investigations public preview announced 2025-10-08; Investigations and Automations reported GA in July 2026 by a secondary source while some docs still say preview [V-2nd] | Multiple specialist agents (Prometheus, Loki, Tempo, Pyroscope, SQL) work in parallel, share findings in a workspace, and produce a report with hypotheses, source queries, and a confidence score; can be triggered by IRM webhooks; honours the user's RBAC [V-2nd] |
| **Honeycomb Intelligence** (MCP, Canvas, Anomaly Detection) | Hosted MCP server; Canvas agent with auto-investigations from trigger and SLO-burn alerts; statistical Anomaly Detection in beta/early access [V-2nd] | Described by Honeycomb staff as an off-the-shelf model calling tools in a loop; MCP server grounds queries with OpenTelemetry semantic conventions and exposes BubbleUp, heatmaps, histograms [V-2nd] |
| **incident.io AI SRE / Investigations** | Shipping; publishes a grading methodology [V] | Post-incident grading against the cause responders established: 100% bullseye, 65% on target, 35% miss, 0% nowhere near; plus "reach" (could the agent access the needed evidence), findings precision/recall/F1; back-testing on past incidents for regression checks and to measure the effect of adding a telemetry source [V] |
| **AWS DevOps Agent** | GA 2026-03-31; $0.0083 per agent-second (about $0.50/minute) of active time; credits tied to AWS Support tier [V-2nd] | Usage-based pricing by agent time |
| **Azure SRE Agent** | GA reported March 2026; billed in Azure Agent Units: a baseline of 4 AAU per agent-hour plus 0.25 AAU per second of active task (figures from a pricing page that may be stale) [V-2nd] | Always-on fee plus active usage |
| **Resolve.ai, Cleric, Traversal, Ciroos, Parity** | Venture-backed AI SRE startups. Third-party roundups: Resolve.ai and Cleric build knowledge graphs of the environment, Traversal emphasizes causal ML, Cleric is read-only by design, Resolve.ai pursues supervised write actions, Ciroos is multi-agent and infrastructure-graph-first [V-2nd, low confidence; no primary technical sources found] | Common theme: an environment/topology graph plus learned memory |
| **PagerDuty agents, New Relic AI, Dynatrace Davis, Observe agents** | Not researched this session | Dynatrace Davis is the long-standing example of deterministic topology-based causal analysis combined with generative summarization [T] |
| **HolmesGPT** | CNCF Sandbox project since 2025-10-08; Apache 2.0; co-maintained by Robusta and Microsoft [V-2nd] | Agentic loop with "toolsets" (Prometheus, Loki, Grafana, Datadog, Kubernetes, and more), runbooks, and MCP servers; one case study reports 20 minutes to under 2 minutes per alert and 40% of common cluster issues diagnosed autonomously [V-2nd, vendor-adjacent] |
| **k8sgpt** | Open-source Kubernetes analyser with LLM explanation [T] | Deterministic analysers first, LLM for explanation |

### 5.2 Benchmarks: what frontier agents can actually do

| Benchmark | Setup | Headline results |
|---|---|---|
| **OpenRCA** (ICLR 2025) | 335 failures from three enterprise systems, offline telemetry | Best at publication: 11.34% solved (Claude 3.5 with a purpose-built RCA agent) [V] |
| **ITBench** (IBM, ICML 2025) | Live SRE, CISO, FinOps scenarios | State-of-the-art agents resolved 11.4%–13.8% of SRE scenarios depending on paper version [V-2nd] |
| **ITBench-AA** (Artificial Analysis and IBM, May 2026) | 59 SRE tasks, 19 held out | All frontier models below 50%; best 46.7%, then 45.8% and 42.5% [V-2nd] |
| **SREGym** (arXiv 2605.07161, NeurIPS 2026) | 90 live problems with multi-layer, metastable, and correlated failures and ambient noise; distinguishes root cause from downstream victims and real mitigation from alert suppression | Best end-to-end about 60.7% without noise; agents lose 7–30% with noise; below 30% on novel hardware and metastable failures; when diagnosis is wrong, agents sometimes still mitigate by trial and error with more tool calls; human-versus-LLM grader agreement κ = 0.90 [V-2nd] |
| **ORCA-bench** (arXiv 2607.28545, July 2026) | 1,079 RCA tasks over six days of metrics, logs, and traces from an OpenTelemetry-instrumented system; agents query Prometheus, Jaeger, OpenSearch through Grafana | Best RCA accuracy 25.3% on realistic-input tasks and 10.0% on hard tasks; hallucinated root causes in 7%–40% of reports depending on model; removing source-code access lowers accuracy and raises hallucination for every model [V] |

Reading these together:

- Accuracy is improving quickly year over year but remains far from trustworthy for unattended conclusions, and it degrades sharply with noise, concurrent faults, and novel failure types.
- Confidently wrong answers are common. A design that presents an agent's conclusion without evidence and without calibrated uncertainty will erode trust fast. incident.io's observation that about 65% graded accuracy is where responders begin to engage rather than re-check everything is a useful product threshold [V].
- **Access to source code and change history materially helps** [V]. viz should plan for a repository/deploy connector as an agent tool, not treat telemetry as sufficient.
- LLM-as-judge grading calibrated against humans is workable (κ = 0.90 in SREGym; Datadog calibrates judge scores against human labels) [V / V-2nd].

### 5.3 What works

1. **Hypothesis-scoped evidence, not "gather everything then summarize".** Datadog's first design collected many tool results and asked for a summary; prompt size grew linearly, quality fell, and irrelevant but suspicious signals misled the conclusion (a Kafka-lag case with 12 tool calls where the right signal was present but upstream errors won). Tying each query to a specific hypothesis, then recursing on supported hypotheses and pruning unsupported ones, fixed this [V].
2. **Simple loops beat elaborate orchestration as models improve.** Datadog simplified from phased multi-agent to ReAct loops and got cheaper and faster [V]; Honeycomb describes a plain tool loop [V-2nd]. Parallelism is still useful, but as independent sub-investigations with isolated contexts and a shared findings store (Grafana's model [V-2nd]), not as a pipeline of specialized stages.
3. **Do the data reduction on the server.** Datadog's largest efficiency gain came from letting the agent write code that queries several sources, joins them, and returns only the summary [V]. The tool surface should return statistics, top-k, and exemplars, not raw series or log lines.
4. **Ground the agent in schema and semantics.** Honeycomb injects OpenTelemetry semantic conventions so generated queries reference real attributes [V-2nd]. Metric metadata (type, unit, help), label cardinalities, and the service graph should be discoverable by tool.
5. **Memory and runbooks.** Products emphasize learned environment knowledge and runbooks (Datadog follows runbooks; HolmesGPT supports them; incident.io feeds grading back into "telemetry memory") [V / V-2nd]. Practical form: per-tenant notes the agent can search and append to, with human review, plus past investigations indexed by service and symptom.
6. **Continuous replay evaluation.** Datadog replays archived telemetry from labelled real incidents and scores with a calibrated LLM judge; incident.io back-tests on closed incidents before shipping prompt or model changes and to quantify the value of a new data source [V].
7. **Read-only by default.** Most products investigate and recommend; write actions are supervised. SREGym's finding that agents sometimes "fix" an incident by suppressing the alert rather than the cause is the cautionary case [V-2nd].
8. **Cost control through routing.** Per-task model routing (cheap model for triage and summarization, strong model for reasoning), prompt caching, and specialized smaller models (Scout) are the levers vendors report [V / V-2nd].

### 5.4 MCP servers and tool-surface design

- **Grafana MCP (`grafana/mcp-grafana`)**: PromQL instant and range queries; metric name, label name, and label value discovery; LogQL queries; a Tempo-backed slow-request finder; many tool families are opt-in to limit context use [V-2nd].
- **Datadog MCP Server**: GA 2026-03-09; organized into **toolsets** that clients enable selectively "saving valuable context window space"; individual tools can be omitted; preview toolsets by name [V-2nd].
- **Honeycomb MCP**: hosted, OAuth, BubbleUp/heatmap/histogram tools, SLO creation, and a tool to invoke the Canvas agent [V-2nd].
- **Prometheus MCP**: no official upstream server was confirmed this session; community servers exist [T].
- **Cloudflare**: Agents SDK v0.20.0 (July 2026) adds client and server support for the MCP 2026-07-28 release candidate, and Workers can serve MCP tools, prompts, and resources without a transport session or Durable Object [V-2nd]. viz can therefore expose a stateless, tenant-scoped MCP server cheaply.

Design rules for viz's agent-facing tool surface (used by both the built-in agent and external agents through MCP):

1. **Discovery before query.** `search_metrics(text)` returning name, type, unit, help, series count, and top label keys with cardinalities; `label_values(metric, label)` returning top-k by series count or recent volume with a total; `describe_service(name)` returning dependencies from trace-derived topology, key metrics, monitors, recent deploys.
2. **Cardinality-safe queries.** Every query tool enforces a maximum number of returned series and points. Over the limit, it returns the top-k by a stated ranking, the total count, and a hint to add `topk` or aggregate. It never silently truncates.
3. **Summaries by default, raw on request.** `query_metrics` returns per-series summary statistics (min, max, mean, last, slope, and a short downsampled sparkline of at most a few dozen points using min/max-preserving downsampling) and a handle for the full result. `compare_windows(expr, current, baseline)` returns deltas directly.
4. **Purpose-built analytical tools.** `explain_change(expr, window)` (dimension contribution), `bubble_up(trace_filter, baseline_filter)` (attribute distribution comparison), `log_patterns(selector, window)` (Drain templates with counts, deltas, one exemplar each), `trace_summary(traceql)` (latency and error aggregates with exemplar trace ids), `get_trace(id)` (pruned to critical path and error spans), `list_changes(window, scope)` (deploys, config, flags), `monitor_history(id)`.
5. **Token budgets are part of the contract.** Each tool takes a `max_tokens` hint, reports its own size, and paginates by handle. Tool descriptions state units and limits.
6. **A code-execution tool** for multi-step data work: the agent submits a small script against a typed viz client, executed in a sandboxed isolate with the investigation's tenant scope, time range, and CPU/row limits; only the script's return value enters the context. This mirrors Datadog's most effective optimization [V].
7. **Structured terminal tools.** `record_finding(...)` and `conclude(...)` with schemas (claim, evidence query handles, confidence, status), so that output is machine-checkable and every claim links to a reproducible query.
8. **Tenant isolation and audit.** Tools run with the monitor's service identity and RBAC; every call is logged with cost and latency into the tenant's own traces, which makes agent runs observable in viz itself.

---

## 6. Agentic monitors as a product primitive

### 6.1 Definition

An **agentic monitor** is a monitor whose condition, investigation, or report includes LLM judgement, expressed in natural language, and bounded by deterministic guards and budgets.

```yaml
kind: agentic
name: checkout-health-watch
intent: >
  Watch checkout end to end. If latency or errors degrade, find out what
  changed and which customers are affected. Ignore the nightly batch window.
scope:                       # hard data boundary for tools
  services: [checkout, payments, cart]
  signals: [metrics, logs, traces, changes]
triggers:
  - on_alert: {monitors: [checkout-slo-burn, checkout-latency-anomaly]}
  - on_anomaly: {selector: 'service="checkout"', min_severity: medium}
  - schedule: {cron: "0 9 * * 1-5", task: daily_review}
  - on_demand: true
guards:                      # deterministic, evaluated by the rule engine
  preconditions:
    - expr: 'sum(rate(http_requests_total{service="checkout"}[5m])) > 1'
  suppress_during: [silences, maintenance_windows]
  cooldown: 30m
  dedupe_by: [service, alertname]
judgement:
  notify_when: "evidence supports customer impact or an ongoing regression"
  outcomes: [impact_confirmed, no_impact, inconclusive]
budget:
  per_run: {usd: 1.50, tool_calls: 40, wall_clock: 10m}
  per_day: {usd: 20, runs: 30}
  on_exhausted: report_partial
model_policy: {triage: small, investigate: default, escalate_to: strong}
outputs:
  - report: {attach_to: alert, format: markdown}
  - dashboard: {mode: annotated_snapshot}
  - notify: {receiver: checkout-oncall, only_if: impact_confirmed}
actions: read_only
```

### 6.2 Trigger types

| Trigger | Starts when | Typical use | Cost control |
|---|---|---|---|
| Alert-fired | A classical or SLO monitor transitions to firing | Triage and root-cause report attached to the page | One run per alert group, cooldown, dedupe |
| Anomaly-fired | Tier 0/1 detector flags a scoped series | Decide whether an anomaly matters before notifying anyone | Guard preconditions; severity floor |
| Schedule | Cron | Daily or weekly review, "anything unusual since yesterday?" | Deterministic digest first; LLM only if the digest changed or exceeds thresholds |
| On-demand | Human or API | "Investigate this panel / this trace" | Per-user budget |
| Follow-up | An earlier run asked to re-check after N minutes | Verify recovery; watch a suspected regression | Counts against per-day budget |

A pure "LLM polls telemetry every few minutes" trigger is deliberately absent. It is expensive (section 8.3) and strictly worse than a deterministic detector that wakes the agent.

### 6.3 Investigation loop

1. **Context assembly (deterministic).** Trigger payload; tier-3 explanation results (dimension contributions, log pattern deltas, recent changes); service topology neighbourhood; relevant memory and runbooks; similar past investigations. Bounded to a fixed token allowance.
2. **Triage (small model).** Decide: obviously benign (known pattern, inside maintenance), needs investigation, or needs a human immediately. Structured output.
3. **Hypothesis loop (default model).** Maintain an explicit hypothesis list with status (`open`, `supported`, `refuted`, `inconclusive`). Each tool call is tagged with the hypothesis it tests. Supported hypotheses spawn narrower children; refuted ones are pruned. Independent hypotheses may run as parallel sub-investigations with isolated contexts that return only structured findings.
4. **Verification.** Before concluding, re-run the key evidence queries, check that the proposed cause precedes the symptom in time, and check at least one disconfirming prediction. If verification fails, the outcome is `inconclusive`.
5. **Report.** Summary, impact, most likely cause with confidence, evidence (each item a reproducible query link and a rendered chart), what was ruled out, suggested next steps, and budget used.
6. **Judgement gate.** The deterministic guard decides *whether the agent may run and may notify at all*; the LLM decides *which outcome applies*; routing of the resulting notification is deterministic again. The LLM never selects receivers or severities outside what the monitor definition allows.

### 6.4 Budgets and cost caps

- Hard caps per run (dollars, tokens, tool calls, wall clock), per monitor per day, and per tenant per month, enforced by the runtime, with a model-visible budget so the agent can wrap up gracefully. On the Claude API, task budgets (beta) give the model a token countdown; it is advisory, so the runtime still enforces the hard stop.
- AI Gateway provides dollar-based spend limits that block or fall back when reached, plus caching, rate limits, logs, and unified billing across providers [V-2nd].
- Every run records model, tokens (including cache reads), tool calls, and cost as span attributes in the tenant's own telemetry.

### 6.5 Outputs

- **Investigation report** (structured JSON plus rendered markdown) attached to the alert and to the notification.
- **Annotated dashboard snapshot**: a generated dashboard spec containing the evidence panels with annotations at onset, change events, and anomalies, linked from the report. This connects directly to viz's "agent-first dashboards" goal.
- **Incident summary and timeline** maintained as the incident evolves (follow-up triggers).
- **Suggested monitors**: proposals for missing alerts or threshold changes, as reviewable diffs, never auto-applied.

### 6.6 Feedback, learning, and evaluation

- **Feedback capture.** Thumbs up/down with reason on each finding; "actual cause" recorded at alert resolution (free text or link to a postmortem); automatic grading afterwards on an incident.io-style four-level scale with reach and findings precision/recall [V].
- **Memory.** Per-tenant, per-service notes (known noisy patterns, ownership, runbook links, "last time this fired the cause was X"), written by the agent as proposals and confirmed by humans; retrieved at context assembly. Memory entries carry provenance and expiry.
- **Replay harness.** Because telemetry is retained in Iceberg, any past time window can be replayed: run the monitor's agent with tools pinned to "as of" the incident time, so no future data leaks, and score against the recorded cause. Uses: regression-test prompt, tool, and model changes; let a tenant measure a monitor before enabling notifications ("shadow mode"); build a cross-tenant-safe synthetic suite from public benchmarks (SREGym, ITBench, ORCA-bench) for platform-level evaluation. Batch APIs can halve replay cost where latency is irrelevant.
- **Quality metrics** shown per agentic monitor: graded accuracy, inconclusive rate, notification precision, cost per run, time to first finding.

### 6.7 Implementation on Cloudflare

| Concern | Choice | Reason |
|---|---|---|
| Identity, config, memory, schedule, chat | `MonitorAgent` — an Agents SDK agent (Durable Object) per agentic monitor | Built-in SQLite state, `schedule()` with cron, WebSocket for live investigation streaming, MCP client [V] |
| Each investigation | One **Workflow instance**, steps = triage, each model turn plus its tool batch, verification, report, notify | Per-step retries, independent of DO eviction and deploys, inspectable, can `sleep` for follow-ups or wait for human approval. At 40–60 steps a run costs about $0.0003–0.0005 in step fees [E from V prices] |
| Alternative for short runs | Agents SDK fiber (`startFiber` with an idempotency key, `stash()` checkpoints) | Lower overhead; but fibers have no automatic retries and recovery logic must be written in `onFiberRecovered` [V]. Prefer Workflows for anything that notifies |
| Parallel hypotheses | Child Workflow instances or sub-agents with isolated context, returning structured findings | Context isolation is the point |
| Model access | All calls through AI Gateway | Spend limits, logs, caching, provider fallback, unified billing (a fee of about 5% on credits per secondary sources) [V-2nd] |
| Tools | The same viz MCP server external agents use, called in-process via service bindings; code execution in a sandboxed isolate | One tool surface to test and secure |
| Artifacts | R2 (reports, snapshots), dashboard specs in the dashboards store | |
| Triggers | `RuleShard` / `AlertRouter` enqueue trigger events to a Queue consumed by the agent runtime; dedupe by `(monitor, group_key, window)` | Decouples paging path from agent availability |

**Model choice** (prices per million tokens, input / output):

| Option | Price | Role |
|---|---|---|
| Claude Opus 5.5 (`claude-opus-5-5`) | $4 / $20; cache read $0.20 | Strong default investigator |
| Claude Sonnet 5.5 (`claude-sonnet-5-5`) | $2 / $10; cache read $0.10 | Cost-balanced investigator |
| Claude Haiku 5.5 (`claude-haiku-5-5`) | $0.10 / $0.50 (prompts up to 100K tokens) | Triage, summarization, sub-agent reading |
| Claude Fable 5.2 (`claude-fable-5-2`) | $8 / $40; cache read $0.20 | Escalation tier for hard incidents; requires 30-day data retention (not available under zero data retention without authorization) |
| Workers AI: `glm-5.3-flash` | $0.15 / $0.50 | In-platform budget tier; the base model Datadog specialized into Scout [V / V-2nd] |
| Workers AI: `gpt-oss-120b`, `deepseek-v4.1-flash`, `kimi-k2.6`, `glm-5.3` | $0.35 / $0.75; $0.30 / $1.20; $0.95 / $4.00; $1.40 / $4.40 | Alternatives without leaving Cloudflare [V] |

Claude prices are from Anthropic's current model table (cached 2026-11-03) as supplied by the Claude API reference used in this session; Workers AI prices from Cloudflare's pricing page today [V].

Notes for the implementer: on current Claude models thinking is adaptive and controlled with `output_config.effort`; forced `tool_choice` is rejected on the newest models, so terminal structured output should use structured outputs or strict tools with `tool_choice: auto`; prompt caching depends on a byte-stable prefix (tools, system prompt, then messages), so keep the tool list and system prompt fixed per monitor version and put volatile context last; several current models can return a `refusal` stop reason that the loop must handle. Anthropic also offers hosted Managed Agents, but hosting the loop on Workers keeps viz within its "purely Cloudflare" runtime constraint with the model as the only external dependency.

Recommendation: make the model a per-tenant policy with three named slots (`triage`, `investigate`, `escalate`), ship a default mapping, and choose that mapping by measured cost per *correct* investigation on the replay suite, not by list price. Offer a Workers-AI-only mapping for tenants that require all data to stay on Cloudflare. Tenants may also bring their own provider keys through AI Gateway.

---

## 7. Recommended monitor architecture for viz

### 7.1 Rule model

One `Monitor` resource, compiled to a common intermediate representation:

| Kind | Source | Compiles to |
|---|---|---|
| `threshold` | PromQL, or TraceQL-metrics / log-count expressions | Streamable or cold evaluation plus comparison |
| `recording` | PromQL | Synthetic series written to the hot buffer at the evaluation timestamp |
| `absence` / `heartbeat` | Selector plus expected interval | Last-seen tracking in the hot buffer; preserves labels, unlike `absent()` |
| `anomaly` | Selector plus sensitivity, seasonality, adaptivity | Tier 0/1 scoring |
| `outlier` | Aggregation with group-by | Group MAD/DBSCAN on an instant vector |
| `forecast` | Selector plus horizon and threshold | Linear/seasonal fit, optionally tier 2 |
| `slo` | OpenSLO-style SLI (good/total or threshold) plus objective and window | Rollup buckets plus the four burn-rate conditions |
| `composite` | Boolean expression over monitor states | Evaluated in `AlertRouter` on state changes |
| `agentic` | Section 6.1 | Trigger subscriptions plus agent runtime |

Common fields: `interval`, `for`, `keep_firing_for`, `recovery_threshold`, `query_offset`, `nodata_policy` and grace, `error_policy`, `new_series_delay`, `min_samples` / minimum denominator, labels, annotations with templating, and `group` membership.

Compatibility: import and export Prometheus rule-group YAML and Alertmanager routing YAML; accept OpenSLO documents; serve the Prometheus `/api/v1/rules` and `/api/v1/alerts` shapes and Alertmanager v2 API so existing dashboards and tools work.

### 7.2 Components

```
                 remote-write / OTLP
                        │
                        ▼
            ┌────────────────────────┐   flush    ┌───────────────────┐
            │ Ingest shard DOs       │──────────▶ │ Parquet / Iceberg │
            │  hot buffer            │            │ on R2             │
            │  selector index        │            └─────────┬─────────┘
            │  rollup buckets        │                      │ cold queries
            │  tier-0/1 detectors    │                      │ (class 3 rules,
            └───────────▲────────────┘                      │  replay, agents)
       batched eval RPC │ one per tick                      │
            ┌───────────┴────────────┐                      │
            │ RuleShard DO (tenant)  │◀─────────────────────┘
            │  one alarm, grid ticks │
            │  DAG of rule groups    │
            │  alert state machine   │
            │  SQLite: non-OK state, │
            │  outbox, cursor        │
            └───────────┬────────────┘
        state transitions│ (RPC, idempotent)
            ┌───────────▼────────────┐        ┌──────────────────────┐
            │ AlertRouter DO (tenant)│──────▶ │ Queue: triggers      │
            │  routing tree, groups  │        └──────────┬───────────┘
            │  inhibition, silences  │                   ▼
            │  composites            │        ┌──────────────────────┐
            │  outbox                │        │ MonitorAgent DO      │
            └───────────┬────────────┘        │  + Workflow per run  │
                        │ Queue: notifications│  AI Gateway, viz MCP │
                        ▼                     └──────────┬───────────┘
            ┌────────────────────────┐                   │ report, snapshot
            │ Delivery Workers       │◀──────────────────┘
            │  Slack, PagerDuty, ... │
            │  retry, DLQ            │
            └────────────────────────┘
   Cron sweeper: verifies every shard alarm is armed; dead-man's-switch monitor.
```

- **Evaluator**: `RuleShard`, described in 3.2–3.5.
- **State**: in-memory authoritative between ticks; SQLite rows only for non-OK instances, the outbox, and one cursor. Alert history (transitions) is appended to the tenant's own log/event stream, so it lands in Iceberg with everything else and is queryable by PromQL-style `ALERTS` series and by agents.
- **Notifier**: `AlertRouter` plus Queue plus delivery Workers, described in 3.6.
- **Anomaly tiers**: section 4.7. Tier 0/1 live inside the ingest shard next to the data; tier 2 is an optional Container service; tier 3 is a set of query-layer functions also exposed as agent tools.
- **Agentic runtime**: section 6.7.

### 7.3 Why this is easy to reason about

- One owner per piece of state: a rule's state belongs to exactly one `RuleShard`; a notification group belongs to exactly one `AlertRouter`. No gossip, no rings, no leader election.
- Deterministic evaluation timestamps make evaluations replayable and testable: a monitor can be back-tested over history with the same code path, which also powers "preview this monitor against last week" in the UI.
- Three explicit evaluation classes with visible cost implications, chosen by a compiler, and surfaced to the user.
- LLM judgement is confined between deterministic guards and deterministic routing.

---

## 8. Cost model

All figures are estimates [E] computed from the Cloudflare and Anthropic list prices marked [V] above, for a 30-day month (43,200 one-minute ticks), *beyond* the included allowances of the $5 Workers Paid plan. The included allowances (1M DO requests, 400k GB-s, 50M rows written, 10M Worker requests) cover a small deployment entirely, so the minimum cost of the monitoring subsystem is zero on top of the base plan.

### 8.1 Classical rules: per 1,000 rules at a 1-minute interval

| Design | Main cost drivers | Approx. cost per 1k rules-month |
|---|---|---|
| **A. Recommended: one `RuleShard` per about 1k rules, batched hot-buffer evaluation** | 43.2k alarm requests ($0.006); 43.2k `setAlarm` row writes ($0.043); cursor writes ($0.043); about 180k transition/outbox/history rows at 2 transitions per rule-day ($0.18); 1–2 s active per tick ($0.07–0.14 duration); about 173k batched RPCs to 4 data shards ($0.026) | **$0.35–0.50** |
| A, shard kept permanently in memory (worst case) | Adds up to 331k GB-s ($4.15) | about $4.50 |
| A at 15-second interval | Tick-proportional terms × 4 | about $1.2–1.8 |
| A at 5-minute interval | Tick-proportional terms ÷ 5 | about $0.25 |
| **B. One Durable Object and alarm per rule** | 43.2M alarm requests ($6.48); 43.2M `setAlarm` row writes ($43.20); duration at 50 ms per wake ($3.46); per-rule query subrequests ($6.50 or more) | **about $60** |
| **C. Evaluate every rule against cold Parquet on R2** | 5 object reads per evaluation → 216M Class B operations (about $78 at $0.36/M [T price]) plus decode CPU, plus B or A scheduling | **$80 or more** |
| **D. One Workflow instance per rule, sleeping between ticks** | 2 steps per tick → 86.4M steps at $0.80 per 100k | **about $690** |
| E. Writing a per-rule `last_evaluated` row every tick (anti-pattern inside A) | 43.2M row writes | adds $43 |

Sensitivities:

- Design A's cost is nearly fixed per shard, so cost per rule falls as shards fill; the cap on rules per shard is CPU time per tick, not price.
- State churn is the variable term: a flapping fleet with 100 transitions per rule-day would add about $9 per 1k rules-month in row writes. Flap detection is a cost control as well as a UX feature.
- At one million rules, design A is roughly $350–500 per month for evaluation scheduling and state, versus roughly $60,000 for design B.

### 8.2 Notifications and anomaly tiers

| Item | Basis | Approx. cost |
|---|---|---|
| Notification delivery | 3 Queue operations ($1.20/M), one Worker request, 2–3 outbox row writes | about $4–5 per million notifications |
| Tier 0/1 anomaly scoring | CPU inside the already-running ingest shard; baseline blobs flushed hourly as one object per shard (720 writes per month) | cents per 1k monitors-month; storage about 1–8 KB per series |
| Daily MSTL refit | One Workflow per tenant shard per day, a handful of steps | negligible step fees; CPU proportional to series count |
| Tier 2 foundation model | Container CPU; unverified secondary figure of $0.00002 per vCPU-second [V-2nd]; assume 50–200 ms per forecast for a small model [E, unmeasured] | order of $1–5 per 1k hourly-forecast monitors-month, plus provisioned memory; must be measured |

### 8.3 Agentic monitors

Assumed investigation profile [E]: 25 model turns; context growing from 8k to 60k tokens (about 875k cumulative input tokens, of which about 815k are cache reads and about 60k are cache writes at a 1.25× write premium [T]); 30k output tokens including thinking; 30–40 tool calls.

| Model | Cache reads | Cache writes | Output | **Per investigation** |
|---|---|---|---|---|
| Claude Haiku 5.5 | about $0.01 (assuming reads at 10% of input [E]) | $0.008 | $0.015 | **about $0.03** |
| Workers AI `glm-5.3-flash` (cached-input rate not captured; assume no discount) | — | $0.13 input | $0.015 | **about $0.15** |
| Claude Sonnet 5.5 | $0.08 | $0.15 | $0.30 | **about $0.55** |
| Claude Opus 5.5 | $0.16 | $0.30 | $0.60 | **about $1.05** |
| Claude Fable 5.2 | $0.16 | $0.60 | $1.20 | **about $2.00** |

Platform overhead per investigation (Workflow steps, DO requests, Queue operations, tool-call CPU) is well under one cent. External reference points: Datadog reports about $4 internal cost per investigation and lists 6.5 credits per run [V / V-2nd]; AWS DevOps Agent's $0.0083 per agent-second is about $1 for a 2-minute run and about $5 for 10 minutes [V-2nd].

Per 1,000 agentic monitors per month:

| Scenario | Runs | Cost |
|---|---|---|
| Alert-triggered, 4 investigations per monitor-month, Sonnet 5.5 | 4,000 | about $2,200 |
| Same, Opus 5.5 | 4,000 | about $4,200 |
| Same, triage on Haiku 5.5 with 25% escalated to Opus 5.5 | 4,000 triage + 1,000 investigations | about $1,100–1,200 |
| Same, Workers AI `glm-5.3-flash` only | 4,000 | about $600 |
| Anti-pattern: LLM check every 15 minutes on Haiku 5.5 (20k input, 1k output per check, no investigation) | 2.88M checks | about $7,000 |

The last row is why scheduled agentic monitors must run a deterministic digest first and call a model only when it changes.

---

## 9. Failure modes

| Failure | Effect | Mitigation |
|---|---|---|
| Shard alarm stops (6 retries exhausted, bug, deploy) | Rules silently stop evaluating | Cron sweeper re-arms; last-evaluation-age metric; platform dead-man's-switch; `AlertRouter` raises "evaluation stalled" instead of resolving |
| Alarm delivered twice or late | Duplicate or late evaluation | Grid-aligned idempotent ticks keyed by timestamp; cursor check; bounded catch-up replay |
| DO evicted mid-tick | Lost in-memory state | Non-OK state and `active_since` in SQLite; tick re-runs; outbox is transactional |
| Hot buffer shard unavailable or slow | Evaluation errors | `error_policy` per monitor (default keep last state plus an `ERROR` signal after N failures); never treat error as OK |
| Late or out-of-order samples | False resolve or false no-data | `query_offset` from measured ingest lag; no-data grace; `new_series_delay` |
| Hot window shorter than a rule's lookback after a config change | Rule silently reads partial data | Compiler pins evaluation class; reclassify on change; reject or downgrade with a visible warning |
| Rule shard overload (too many or too heavy rules) | Missed ticks | Per-tick CPU accounting, automatic split, per-tenant rule and series limits, missed-iteration metric and alert |
| Cardinality explosion in an alert expression | Thousands of alert instances, row-write cost spike, notification storm | Per-monitor instance cap with an explicit "limit exceeded" alert; grouping; per-tenant notification rate limit |
| Flapping | Notification noise, write cost | `keep_firing_for`, recovery threshold, flap detection, group interval |
| Receiver outage or rate limit | Delayed or lost notifications | Queue retries with backoff, DLQ visible in UI, fallback receiver, delivery-failure meta-alert |
| Duplicate notification | Page fatigue | Deterministic notification ids, dedup keys, Slack message update by stored `ts` |
| Tenant mis-routes everything to nowhere | Silent alerts | Root route must have a receiver; "alerts with no successful delivery" meta-monitor |
| Baseline learns an incident | Anomaly detector goes blind | Exclude flagged points and silenced windows from updates; changepoint-triggered reset with human-visible annotation |
| Seasonal baseline cold start | No detection or false positives for 2–3 weeks | Tier 0 only until warm; optional tier 2 band; clear UI state |
| Low-traffic SLO | Burn-rate alerts on a handful of errors | Minimum denominator guard; longer windows |
| Agent hallucinated root cause | Misdirected responders, lost trust | Evidence-linked findings, verification step, explicit `inconclusive`, graded accuracy shown per monitor, shadow mode before notify |
| Agent runaway cost or loop | Bill shock | Hard per-run, per-day, per-tenant caps; AI Gateway spend limits; cooldown and dedupe on triggers |
| Model provider outage, rate limit, or refusal | No investigation | Classical alert still pages (the agent never sits in the paging path); AI Gateway fallback to another model; report "investigation unavailable" |
| Prompt injection through telemetry (log lines, span attributes, label values are attacker-controllable text) | Agent misled or tool misuse | Treat telemetry as untrusted data; read-only tools; scope-limited credentials; no tool that sends data outside the tenant; structured outputs; injection cases in the evaluation suite |
| Cross-tenant leakage through agent memory or tools | Data breach | Tenant-scoped DOs, credentials, and memory; no shared vector index across tenants; audit log of every tool call |
| Investigation storm during a large outage | Hundreds of parallel agent runs on one cause | Trigger dedupe at the `AlertRouter` group level; per-tenant concurrency cap; one "incident" run that absorbs related alerts |
| Agent evaluation drift after a model or prompt change | Silent quality regression | Replay suite gate before rollout; versioned monitor definitions pinned to prompt and model versions |

---

## 10. Design implications for viz

1. **Build the hot-buffer evaluator as part of the ingest design, not as a consumer of the query API.** The rule engine's economics depend on batched, in-colo evaluation against recent data. The ingest shard needs a selector index, incremental window state, rollup buckets, and an RPC that evaluates a batch of compiled expressions at a timestamp.
2. **Make "write on transition" a hard rule.** With SQLite row writes at $1.00/M and `setAlarm` billed as a write, per-evaluation persistence is the difference between cents and tens of dollars per 1k rules.
3. **One alarm per shard; grid-aligned ticks; bounded catch-up; cron sweeper.** No Cron Triggers per tenant, no Workflow per rule, no DO per rule.
4. **Adopt Prometheus rule and Alertmanager routing semantics verbatim, add explicit NoData/Error policies, recovery thresholds, and label-preserving heartbeat monitors.** Import and export the standard YAML.
5. **Implement Alertmanager's model in a single per-tenant `AlertRouter` DO with a transactional outbox and deterministic notification ids.** This removes the HA-dedup problem class.
6. **Treat SLOs as a compiled monitor kind backed by rollup buckets**, with the four standard burn-rate conditions and a minimum-traffic guard, and accept OpenSLO.
7. **Ship anomaly tiers 0, 1, and 3 first.** Seasonal robust baselines plus dimension-contribution explanations cover most of the value at negligible cost. Defer foundation models to an optional Container-hosted tier and decide after measuring CPU latency of Toto 2.0 (4M/22M) and Chronos-Bolt.
8. **Run Drain template mining and error fingerprinting at ingest.** They serve log/trace anomaly monitors and are the main way to make logs affordable in an agent's context.
9. **Ingest change events (deploys, config, flags) as a first-class signal** and plan a source-repository connector; benchmarks show code and change context materially improve agent accuracy.
10. **Design one tool surface for agents and expose it as a stateless MCP server.** Discovery tools, cardinality-capped queries, summary-first results with handles, analytical tools, and sandboxed code execution. The built-in agent should use the same surface.
11. **Agentic monitors are triggered, guarded, budgeted, and read-only.** They never sit in the paging path; the classical alert pages, the agent enriches. Notifications that depend on LLM judgement must be opt-in and backed by a shadow-mode track record.
12. **Run each investigation as a Workflow; keep monitor identity, memory, and schedule in an Agents SDK Durable Object; route all model calls through AI Gateway.**
13. **Build the replay harness early.** Deterministic "as of" queries over Iceberg make replay cheap for viz in a way it is not for most vendors; it underpins monitor preview, anomaly back-tests, agent regression testing, and tenant-visible accuracy.
14. **Price and meter agentic runs separately from classical rules**, and surface cost per run and per monitor in the product.
15. **Dogfood.** Rule evaluation, routing, delivery, and agent runs should all emit OpenTelemetry into a platform tenant, monitored by the same engine with an external dead-man's-switch as the last line.

---

## 11. Open questions / unverified

**Cloudflare platform**

- Exact Durable Object idle-billing behaviour between ticks (how long after the last event duration stops accruing) [T]. It moves design A's cost between about $0.4 and about $4.5 per shard-month.
- Durable Object per-invocation CPU limits and whether a 1k-rule tick fits comfortably; Workflows concurrency and instance-creation limits (the search for "Workflows v2" limits was cut off by the search budget).
- R2 Class A/B operation prices and Cloudflare Containers unit prices were not fetched from primary pages this session.
- Whether a small time-series model (Toto 2.0 4M, Chronos-Bolt tiny) can run via ONNX Runtime WebAssembly inside a Worker within memory and CPU limits, and its latency; otherwise Container cold-start and cost.
- AI Gateway unified-billing fee (about 5%) and zero-data-retention terms come from secondary sources; confirm in Cloudflare's docs. Claude Fable models require 30-day retention, which interacts with any ZDR promise viz makes to tenants.
- Agents SDK is moving quickly (v0.4 in February 2026 to v0.20 in July 2026); "Project Think" primitives are described as an evolving preview. Pin versions and re-check fibers, sub-agents, and scheduling semantics (maximum schedules per agent, retry policy) before committing.

**Semantics and design**

- How large can the hot window be, and what fraction of real-world rules are streamable under it? Needs a corpus study of public rule sets (kube-prometheus, mixins, Sloth output).
- Recording-rule output written into the hot buffer: ordering and visibility guarantees across ingest shards when a rule aggregates over several shards.
- Composite monitors and inhibition across tenants or across viz and external Alertmanagers.
- TraceQL and log-query monitors: which subset can be evaluated incrementally at ingest (TraceQL metrics over spans seems feasible; structural trace queries likely not).
- Prometheus details taken from training knowledge and not re-verified: for-state restoration defaults, resend delay and `endsAt` computation, the exact flag name for the concurrent-evaluation cap (sources disagree between `--rules.max-concurrent-evals` and `--rules.max-concurrent-rule-evals`), and whether concurrent evaluation is still behind a feature flag in the current release.
- Grafana "Recovering" state, Mimir remote-evaluation details, and the Datadog monitor option list are from training knowledge.
- Opsgenie's retirement timeline and Microsoft Teams connector status were not re-verified.

**Anomaly detection**

- No independent evidence was found that foundation models beat tuned seasonal baselines for *anomaly detection* on observability metrics; Toto's results are vendor-reported, and whether Toto runs in Datadog's production detectors is unconfirmed.
- Best default for adaptivity (when to reset a baseline after a level shift) needs back-testing on real tenant data.

**Agentic**

- Benchmark figures for SREGym and ITBench-AA come from secondary summaries; ORCA-bench and SREGym are 2026 preprints. Read the primary papers before quoting numbers externally.
- Datadog's Scout claims and the Bits cost figures are vendor-reported and compare against models whose names appear only in those vendor posts.
- Architecture details for Resolve.ai, Cleric, Traversal, Ciroos, and Parity come from third-party roundups; PagerDuty, New Relic, Dynatrace, and Observe agent offerings were not researched this session.
- The per-investigation token profile in 8.3 is an assumption. Measure it on a prototype; Datadog's reported $4 suggests real investigations may use several times more tokens than assumed here.
- Whether Workers AI open models reach acceptable investigation accuracy without fine-tuning is unknown; Scout suggests specialization is what makes a mid-size model competitive.
- Prompt-injection resistance of telemetry-reading agents has no established benchmark; viz needs its own red-team suite.
- Human-feedback loop design (who confirms memory entries, how ground truth is captured at resolution without adding toil).

---

## 12. Sources

**Cloudflare**

- Durable Objects pricing — https://developers.cloudflare.com/durable-objects/platform/pricing/
- Durable Objects alarms API — https://developers.cloudflare.com/durable-objects/api/alarms
- Durable Objects SQLite storage billing changelog — https://developers.cloudflare.com/changelog/2025-12-12-durable-objects-sqlite-storage-billing
- Workflows pricing — https://developers.cloudflare.com/workflows/reference/pricing/
- Workers AI pricing and model catalog — https://developers.cloudflare.com/workers-ai/platform/pricing/
- Queues pricing — https://developers.cloudflare.com/queues/pricing/
- Workers limits (Cron Triggers per account) — https://developers.cloudflare.com/workers/platform/limits
- Containers pricing — https://developers.cloudflare.com/containers/pricing/
- Agents SDK durable execution (fibers) — https://developers.cloudflare.com/agents/runtime/execution/durable-execution/index.md
- Agents SDK schedule tasks — https://developers.cloudflare.com/agents/api-reference/schedule-tasks/
- Agents changelog — https://developers.cloudflare.com/changelog/product/agents/index.md
- Agents SDK v0.14.0 — https://developers.cloudflare.com/changelog/post/2026-06-02-agents-sdk-v0.14.0/
- Agents SDK v0.17.0 — https://developers.cloudflare.com/changelog/post/2026-06-26-agents-sdk-v0.17.0/
- Agents SDK v0.20.0 (MCP SDK v2) — https://developers.cloudflare.com/changelog/post/2026-07-27-agents-sdk-v0.20.0-mcp-sdk-v2/
- Project Think — https://blog.cloudflare.com/project-think/
- AI Gateway unified billing — https://developers.cloudflare.com/ai-gateway/features/unified-billing/
- AI Gateway billing and model names changelog — https://developers.cloudflare.com/changelog/post/2026-09-01-billing-and-model-names/

**Prometheus, Grafana, Thanos**

- Prometheus alerting rules (3.9) — https://prometheus.io/docs/prometheus/3.9/configuration/alerting_rules/
- Prometheus rules package — https://pkg.go.dev/github.com/prometheus/prometheus/rules
- Thanos Rule (`query_offset`) — https://thanos.io/tip/components/rule.md/
- Prometheus developers thread on concurrent rule evaluation — https://groups.google.com/g/prometheus-developers/c/0wHMSkDGjvc
- Grafana alerting performance limitations — https://grafana.com/docs/grafana-cloud/observe-and-act/alert-and-measure-reliability/alerting/set-up/performance-limitations/
- Grafana alert rule queries and conditions — https://grafana.com/docs/plugins/grafana-prometheusalerting-app/latest/fundamentals/alert-rules/queries-conditions/
- Grafana Assistant GA and Assistant Investigations press release — https://grafana.com/press/2025/10/08/grafana-labs-revolutionizes-ai-powered-observability-with-ga-of-grafana-assistant-and-introduces-assistant-investigations/
- Understand Assistant investigations — https://www.grafana.com/docs/grafana-cloud/machine-learning/assistant/introduction/investigations
- Grafana, "Breaking the iron triangle" — https://grafana.com/blog/breaking-the-iron-triangle-how-ai-powered-investigations-change-the-economics-of-uptime
- Help Net Security on Grafana Assistant (July 2026) — https://www.helpnetsecurity.com/2026/07/28/grafana-assistant-ai-capabilities/
- Grafana MCP server — https://pkg.go.dev/github.com/grafana/mcp-grafana

**Datadog**

- Bits investigations: cost, speed, accuracy — https://www.datadoghq.com/blog/bits-investigations-cost-speed-accuracy/
- Building Bits AI SRE — https://www.datadoghq.com/blog/building-bits-ai-sre/
- Bits AI evaluation platform — https://datadoghq.com/blog/engineering/bits-ai-eval-platform
- Bits AI SRE launch press release — https://www.datadoghq.com/about/latest-news/press-releases/datadog-launches-bits-ai-sre-agent-to-resolve-incidents-faster/
- Introducing Scout — https://datadoghq.com/blog/ai/introducing-scout-sre-specialized-model-bits-ai
- InfoQ on Scout — https://infoq.com/news/2026/10/datadog-scout-sre-model
- Datadog pricing — https://www.datadoghq.com/pricing/
- Datadog MCP Server docs — https://docs.datadoghq.com/bits_ai/mcp_server.md
- Datadog MCP Server GA press release — https://investors.datadoghq.com/news-releases/news-release-details/datadog-launches-mcp-server-provide-ai-agents-secure-real-time
- Toto and BOOM — https://www.datadoghq.com/blog/ai/toto-boom-unleashed
- Toto 2.0 — https://www.datadoghq.com/blog/ai/toto-2/
- Toto paper, "This Time is Different" — https://arxiv.org/html/2505.14766v1

**Other AI SRE products**

- incident.io, measuring investigation accuracy — https://docs.incident.io/investigations/measuring-accuracy
- Honeycomb Intelligence docs — https://docs.honeycomb.io/get-started/honeycomb/honeycomb-intelligence.md
- Honeycomb Anomaly Detection docs — https://docs.honeycomb.io/notify/anomaly-detection
- Honeycomb, MCP, Canvas, agentic workflows — https://honeycomb.io/blog/ai-working-for-you-mcp-canvas-agentic-workflows-pt2
- Honeycomb, "It's the end of observability as we know it" — https://www.honeycomb.io/blog/its-the-end-of-observability-as-we-know-it-and-i-feel-fine
- AWS DevOps Agent GA — https://aws.amazon.com/about-aws/whats-new/2026/03/aws-devops-agent-generally-available
- InfoQ on AWS DevOps Agent GA — https://infoq.com/news/2026/04/aws-devops-agent-ga
- Azure SRE Agent pricing — https://azure.microsoft.com/pricing/details/sre-agent/
- Azure SRE Agent pricing and billing docs — https://learn.microsoft.com/azure/sre-agent/pricing-billing
- HolmesGPT, CNCF blog (January 2026) — https://www.cncf.io/blog/2026/01/07/holmesgpt-agentic-troubleshooting-built-for-the-cloud-native-era/
- HolmesGPT and CNCF tools case study (April 2026) — https://www.cncf.io/blog/2026/04/21/auto-diagnosing-kubernetes-alerts-with-holmesgpt-and-cncf-tools/
- Mezmo, 2026 AI SRE market map — https://www.mezmo.com/learn/the-2026-ai-sre-market-map-agents-harnesses-and-the-data-layer
- Cleric vs Resolve.ai vs Traversal comparison (third party) — https://prommer.net/en/tech/guides/cleric-vs-resolve-ai-vs-traversal/
- Ciroos overview (third party) — https://workos.com/blog/ciroos-ai-sre

**Benchmarks**

- OpenRCA (ICLR 2025) — https://iclr.cc/virtual/2025/poster/32093
- ITBench paper — https://arxiv.org/pdf/2502.05352
- ITBench repository — https://github.com/itbench-hub/ITBench
- ITBench-AA launch — https://artificialanalysis.ai/articles/itbench-aa-launch
- ITBench-AA, IBM Research on Hugging Face — https://huggingface.co/blog/ibm-research/itbench-aa
- SREGym — https://arxiv.org/abs/2605.07161
- SREGym leaderboard summary (third party) — https://benchmarklist.com/benchmarks/sregym/
- ORCA-bench — https://arxiv.org/pdf/2607.28545
- "How Far Can Root Cause Analysis Go on Real-World Telemetry Data?" (not read) — https://www.alphaxiv.org/abs/2607.13548.md

**Time-series models and anomaly-detection evaluation**

- TSB-AD (NeurIPS 2024) — https://thedatumorg.github.io/TSB-AD
- TSB-AD paper — https://proceedings.neurips.cc/paper_files/paper/2024/file/c3f3c690b7a99fba16d0efd35cb83b2c-Paper-Datasets_and_Benchmarks_Track.pdf
- TSB-AutoAD (PVLDB 2025) — https://www.vldb.org/pvldb/vol18/p4364-liu.pdf
- TimeSeriesBench — https://arxiv.org/html/2402.10802v1
- Chronos-2 paper — https://arxiv.org/html/2510.15821v1
- GIFT-Eval paper — https://arxiv.org/pdf/2410.10393
- "What a Forecasting Leaderboard Can Establish" (NeurIPS 2026) — https://neurips.cc/virtual/2026/175015
- Independent latency comparison of time-series foundation models — https://dev.classmethod.jp/en/articles/dgx-spark-timeseries-fm-3-bench/

**Model pricing**

- Claude model ids and prices: Anthropic model table cached 2026-11-03, via the Claude API reference available in this session (not a public URL fetched here; confirm at https://platform.claude.com/docs/en/about-claude/pricing).

**Background not re-verified this session (training knowledge)**

- Google SRE Workbook, "Alerting on SLOs" — https://sre.google/workbook/alerting-on-slos/
- Alertmanager configuration — https://prometheus.io/docs/alerting/latest/configuration/
- OpenSLO — https://openslo.com/ ; Sloth — https://sloth.dev/ ; Pyrra — https://github.com/pyrra-dev/pyrra
- Grafana Mimir ruler — https://grafana.com/docs/mimir/latest/references/architecture/components/ruler/
- Datadog anomaly monitors — https://docs.datadoghq.com/monitors/types/anomaly/ ; outlier monitors — https://docs.datadoghq.com/monitors/types/outlier/
- Drain3 — https://github.com/logpai/Drain3
- Adams & MacKay, Bayesian Online Changepoint Detection — https://arxiv.org/abs/0710.3742
