# viz — system design

Status: draft 2 (revised after independent review; see `REVIEW.md`). Date: 2026-11-18.
Evidence for every claim is in `research/`; numbers marked *modelled* are estimates that
`VERIFICATION.md` turns into experiments.

## 1. What viz is

A multi-tenant observability backend and frontend that runs entirely on Cloudflare:

- metrics, logs and traces stored as Apache Iceberg tables (Parquet on R2), readable by any
  Iceberg engine;
- PromQL and TraceQL (plus a LogQL subset and SQL passthrough) over that store;
- authenticated push (OTLP/HTTP, Prometheus Remote Write) and pull (scrape, adapters);
- dashboards that agents and people both write and read;
- monitors: rules, anomaly detection, and agent-run investigations;
- a cost floor of the $5 Workers Paid plan when idle (*modelled*: about $5.20 at hobby scale,
  about $250/month for 1M series + 100 GB logs/day + 500M spans/day).

## 2. The shape in one page

**Every row lives in exactly one of two places, and one number says which.**

1. **The tail.** A row that was acknowledged but is not yet in a committed Iceberg snapshot is
   held by exactly one *shard* (a Durable Object with a SQLite write-ahead log).
2. **The lake.** Everything else is in immutable Parquet files referenced by the current
   Iceberg snapshot.
3. **The seam.** Each snapshot records, per shard, the highest sequence number it contains
   (the *watermark*). A query reads one snapshot and asks each relevant shard for rows with a
   sequence number above that snapshot's watermark. Lake ∪ tail is exact: no gap, no double
   count, regardless of where a flush or commit is in flight.

Everything else follows from holding that line:

- **R2 is the only durable home of telemetry.** Durable Objects hold what has not reached R2
  yet, plus small metadata. Caches hold nothing that cannot be recomputed.
- **One mutator per table.** A single committer object serialises appends, compactions and
  retention deletes for a table. Cloudflare's managed compaction is turned off.
- **Stateless everything else.** Ingest gateways, query coordinators, query leaves, the UI and
  the MCP endpoint are plain Workers.
- **One engine.** A Rust core (parse, plan, Parquet encode/decode, evaluate) with no I/O of its
  own. It runs as WASM in Workers and Durable Objects, natively in Containers for oversized
  work, and inside a deterministic simulator in CI.

```
 senders ──► edge Worker ──► Shard DO ──flush──► R2 (Parquet) ──► Committer DO ──► Iceberg catalog
 (push/pull)  auth, decode    WAL, tail          immutable files   one per table     snapshot + watermarks
                               ▲   │ rules on                                   │
                               │   ▼ the write path                             ▼
 browser / agent ──► app Worker ──► query Worker ──► leaf Workers ──► lake files + shard tails
 (UI, API, MCP)                      plan, prune        scan, partial aggregate, Arrow out
```

## 3. Components

Five Workers and five Durable Object classes. Nothing else is stateful.

| Component | Kind | Responsibility | State |
|---|---|---|---|
| `edge` | Worker | Authenticate, decode OTLP / Remote Write to columnar batches (WASM), route to a shard, render protocol responses | none |
| `Shard` | DO, many per tenant | WAL, dedup, quotas, tail reads, flush to R2, write-path rule inputs | SQLite WAL segments |
| `Committer` | DO, one per table per cell | Ledger of flushed files, Iceberg commits, compaction and retention commits, publishes the table head | SQLite ledger |
| `Tenant` | DO, one per tenant | Config, API keys, shard map, dashboards and revisions, rule definitions, retention policy | SQLite |
| `Ruler` | DO, one per ~1k rules | One alarm tick, rule evaluation, alert state machine, notification outbox | SQLite |
| `Scraper` | DO, one per target group | Pull ingest on alarms, stale markers | SQLite |
| `query` | Worker | Parse, plan, prune, fan out, merge | none (Cache API) |
| `leaf` | Worker | Scan a bounded set of row groups, evaluate, return partial results as Arrow IPC | none (Cache API) |
| `app` | Worker + static assets | UI, REST API, stateless MCP endpoint, OAuth | none |
| `jobs` | Workflows (+ Containers) | Compaction, rollups, retention, orphan sweep, scrubbing, agent investigations | Workflow state |

**Cells.** A cell is one R2 bucket, one catalog warehouse and its committers. Tenants are
assigned to a cell; every object name carries the cell. Small tenants share a cell and its
tables; a large or regulated tenant gets its own cell (own bucket, own tables, optionally an
EU-jurisdiction bucket with the self-managed catalog in §5.5). Cells bound blast radius and
keep each committer's workload finite.

## 4. Write path

### 4.1 Push

1. `edge` verifies the API key (prefix lookup, hashed secret, cached at the edge; revocation is
   checked by the shard), resolves the tenant's shard map (KV, cached; stale-tolerant), and
   decodes the body in WASM straight into a columnar batch. One internal batch model serves
   every protocol.
2. Rows are routed by hash: metrics by `series_id`, spans by `trace_id`, logs by resource
   fingerprint. Each series, trace and log stream therefore lives in exactly one shard, which
   is what makes per-series functions and `topk` decomposable later.
3. The shard appends the batch to its WAL. Batches arriving within a short window share one
   SQLite transaction (group commit). The response is sent only after that transaction is
   durable. A batch fingerprint makes client retries idempotent.
4. When bounds are hit (bytes buffered, series quota, rate), the shard answers 429 with
   `Retry-After`. It never acknowledges and drops.

Launch protocols: OTLP/HTTP (protobuf and JSON) and Prometheus Remote Write 1.0/2.0. Later:
Loki push, Logpush, OTLP/gRPC when Workers gRPC is generally available. Not planned: UDP
protocols.

### 4.2 Pull and adapters

- **Scrape.** A `Scraper` object per target group wakes on an alarm, fetches targets,
  synthesises staleness markers, and sends batches down the same path as push. Private
  targets use an agent that pushes; Workers VPC later.
- **Adapters.** One contract, two directions, Arrow as the currency:
  - *ingest adapters* poll an external system (CloudWatch, a bucket, a queue) and emit batches;
    the platform owns cursors and schedules;
  - *query adapters* expose an external store at query time through `schema()` and
    `scan(pushdown) → Arrow batches`, negotiated the way Prometheus remote-read and DataFusion
    table providers do.
  Tenant-supplied adapter code runs in Dynamic Workers with only the bindings it is granted
  and mediated egress.

### 4.3 Flush and commit

1. A shard seals a segment when it reaches about 16–32 MB or 60 s. It sorts the segment by
   the table's sort order, encodes a tenant-pure Parquet file, and PUTs it to a deterministic
   key `{cell}/{table}/{tenant}/{day}/{shard}-{seq_lo}-{seq_hi}.parquet`.
2. It reports `{key, stats, seq range}` to the table's `Committer`, which records it in its
   ledger.
3. The committer commits when it has pending files and at least 60 s have passed (sooner
   never; later when quiet). One commit appends every pending file across all tenants, writes
   the new per-shard watermarks into the snapshot summary, and merges into per-day manifests.
   If nothing is pending it does nothing, so an idle table costs nothing.
4. After a commit the committer re-reads catalog state to confirm it, then publishes the new
   **table head**: snapshot id, partition → manifest map, and watermarks.
5. Shards learn the new watermark and may delete WAL segments at or below it, but only after
   a grace period longer than the maximum age of any cached table head. Until then a sealed
   segment is answered from its R2 file rather than from SQLite.

Failure handling is uniform: every step is idempotent and keyed by `(shard, seq range)`.
A flush retry overwrites the same key with the same bytes. A commit whose outcome is unknown
is resolved by reading the snapshot summary. A shard that crashes replays its WAL.

### 4.4 Sizing

- Budget 200–500 requests/s and about 5 MB/s per shard (*modelled*). Tenants start with one
  shard for all three signals; the shard map grows by doubling, and a new map takes effect at
  a sequence boundary so routing stays deterministic.
- Shards are placed near the sender with a location hint. No shard is ever global.
- WAL rows are whole encoded batches, never one row per sample (row writes are billed).

## 5. Storage layout

Iceberg format v2, append-only data, Parquet with zstd. Types stay v2-compatible until v3
support in the managed catalog is confirmed. All tables are shared within a cell and
partitioned `identity(tenant_id), day(ts)`; files are tenant-pure.

### 5.1 Tables

| Table | Grain | Sort order | Notes |
|---|---|---|---|
| `metric_series` | one row per series per day | `metric_name, series_id` | ~12 promoted label columns + full `labels` map; serves matchers, `/labels`, `/series` |
| `metric_samples` | one row per sample | `metric_name, series_id, ts` | `value` (byte-stream-split), `stale`, `start_ts`; six columns, tiny footers |
| `metric_histograms` | one row per histogram sample | same | native histograms and NHCB |
| `metric_rollup_5m`, `_1h` | one row per series per window | same | count, sum, min, max, last, counter-reset-aware increase, quantile sketch |
| `spans` | one row per span | `service_name, span_name, start_time` | promoted attribute columns + residual maps; bloom filter on `trace_id` |
| `trace_index` | one row per trace per day | `trace_id` | root service and name, start, duration, span and error counts; makes trace-by-ID a point lookup |
| `logs` | one row per record | `service_name, resource_fp, ts` | severity, body, promoted attributes, residual map; optional token → row-group sidecar written at compaction |

Flat one-row-per-span storage removes write-time trace assembly and keeps row groups small
enough for a 128 MB isolate. Flat samples cost an estimated 2–3 bytes each against about 1.4
for chunk blobs; the difference is a few dollars per million series per month, and flat rows
stay readable by every Iceberg engine. This is benchmarked before it is frozen.

### 5.2 Files

- Flush files: 1–32 MB, row groups of at most ~100k rows.
- Compacted files: 128 MB target, row groups 16–32 MB, pages 64–256 KB, column and offset
  indexes on, bloom filters on `trace_id` and `series_id`.
- A **footer bundle** per tenant-day partition: one small object holding every file's
  row-group offsets, key-column statistics and page-index locations, so planning never issues
  one footer read per file.

### 5.3 Compaction, rollups, retention

- **Compaction** is time-clustered and sort-preserving: flush files → hourly → daily, as a
  k-way merge of already-sorted inputs. Small merges run in leaf Workers under a Workflow;
  merges that exceed isolate limits run the same Rust core in a Container. Results are
  committed as a `replace` snapshot by the same committer, so compaction cannot race appends.
- **Rollups** (5 m, 1 h) are written during compaction, never by a separate pipeline, so they
  cover exactly the data that was compacted. Every query result states its resolution.
- **Retention** is per tenant and per signal. Because files are tenant-pure and partitions
  are `(tenant, day)`, expiry is a metadata-only delete of whole partitions through the
  committer. Snapshot expiry runs at 1–3 days. Tenant erasure is the same operation with a
  wider range.
- **Orphan sweep.** The committer ledger knows every file viz ever wrote; a sweeper deletes
  files that are unreferenced and older than a grace period. The managed catalog does not do
  this.

### 5.4 Catalog independence

The managed catalog (Basin Catalog) is used behind a five-method interface: load table,
commit, list snapshots, expire, drop. Three safeguards answer the reported corruption bug:

- the committer ledger plus R2 is sufficient to rebuild any table's metadata;
- a scrubber continuously checks that every file in the live snapshot exists with the
  recorded length and that the snapshot lineage is linear;
- a second implementation of the interface keeps Iceberg metadata directly on R2, using
  conditional writes as the compare-and-swap. It serves EU-jurisdiction cells, which the
  managed catalog does not support, and it is the fallback if the managed catalog misbehaves.

### 5.5 What viz deliberately does not use

| Service | Why not on the main path | Where it still fits |
|---|---|---|
| Basin Pipelines | 20 streams per account, no custom partitioning or sort, 60 s floor, silent drops, about $0.06–0.10/GB | none at launch |
| Basin SQL | 10,000-row cap, per-query minimum charge, HTTP only | ad-hoc SQL over the same tables |
| Managed compaction | not documented to preserve sort order or indexes; a second mutator | none |
| Queues | the shard WAL already gives durable, ordered, idempotent hand-off | notification fan-out |
| D1 / Analytics Engine | wrong shape for telemetry at this scale | none |

## 6. Read path

### 6.1 Languages and plan

PromQL, TraceQL and the LogQL subset each parse to their own AST and lower to one logical
plan: `scan(table, time range, predicates, projection) → per-series or per-trace operators →
aggregate → merge`. PromQL parsing reuses the `promql-parser` crate; evaluation semantics are
ported from the Go reference with the upstream test corpus as the loop. TraceQL's grammar is
ported from Tempo's.

Tenant scope is not a predicate a caller can omit: the planner takes the tenant from the
authenticated session and injects it into every scan. Label-based access rules are injected
at the same place.

### 6.2 Planning in a handful of requests

1. Read the table head (snapshot, manifest map, watermarks). It is published on each commit
   and cached for a few seconds; it never requires a catalog call.
2. Fetch the manifests for the touched tenant-days (immutable, Cache API).
3. Fetch the footer bundles for those partitions (immutable, Cache API).
4. For metrics, resolve matchers against `metric_series` to a set of `series_id`s.
5. Prune to row groups and pages, then cut the work into splits by time and by series-hash
   bucket.

*Modelled*: 3–5 subrequests cold, 1 warm, for a one-hour single-tenant query.

### 6.3 Execution

- Leaves stream one row group at a time, evaluate series-at-a-time, and return **partial
  aggregates** (sum/count/min/max decompose exactly; `avg` as sum+count; `topk` per shard then
  merged; quantiles from sketches only when asked, and labelled approximate).
- Results travel as Arrow IPC. The coordinator merges streams and never materialises raw
  series it does not need.
- The tail is one more leaf input: the planner asks each relevant shard for rows above the
  watermark. A shard answers with rows from its open segment and with references to sealed
  files that are flushed but not yet committed, so the shard itself stays light.
- Fan-out respects the six-connections-awaiting-headers rule with a two-level tree and
  early-header streaming. Slow range reads are hedged.
- A plan that cannot be decomposed within isolate limits (large subqueries, exact quantiles
  over huge groups, big joins) is routed to a Container running the identical engine. It is
  slower to start, never different in result.

### 6.4 Caching

Files are immutable, so a leaf's partial result for `(plan fragment, file set, split)` is
valid forever and is cached without invalidation. On top: a step-aligned result cache for
closed time ranges. Only the most recent window is recomputed on dashboard refresh.

### 6.5 Trace and log specifics

- **Trace by ID:** `trace_index` → files and row groups → bloom-filtered reads; plus the tail.
- **TraceQL search:** phase one finds matching spans using sort order and promoted columns;
  structural operators (`>`, `>>`, `~`) fetch the candidate traces by ID and evaluate in
  memory per trace. Nested-set columns can be added at compaction later if descendant queries
  dominate.
- **Logs:** sort order and statistics first; the token sidecar is advisory, and a missing or
  stale index always falls back to a scan with the same result.

### 6.6 Limits and cost visibility

Series touched and bytes to scan are known after planning and before execution. They are
returned with every result, enforced per tenant, and exposed to agents by `validate_query`.

## 7. Monitors

### 7.1 Rules

- Prometheus alerting and recording rule semantics (`for`, `keep_firing_for`, groups).
- A tenant's rules are packed into `Ruler` objects of about 1,000 rules. One alarm tick
  evaluates a whole group; state is persisted only on transitions. *Modelled* cost: about
  $0.35–0.50 per 1,000 rules per month, against about $60 with one object per rule and about
  $690 with one Workflow per rule.
- Rules read the same query path. Short windows are answered almost entirely from shard
  tails and rollups, so evaluation rarely touches R2.
- Notifications go through a transactional outbox with deterministic ids, which gives
  exactly-once delivery attempts and replaces Alertmanager's gossip. Grouping, inhibition and
  silences keep Alertmanager's semantics.
- Alarms are at-least-once, so a cron sweeper re-arms missed rulers and a dead-man's-switch
  alert is built in.

### 7.2 Anomaly detection, in tiers

| Tier | Method | Runs | Cost |
|---|---|---|---|
| 0 | Robust z-score / MAD against a seasonal baseline taken from rollups; EWMA; multi-window burn rate for SLOs | in the ruler tick | effectively free |
| 1 | Seasonal decomposition, changepoint detection (CUSUM, E-Divisive), cross-series outliers, log-template frequency shift | scheduled Workflow | cents |
| 2 | Time-series foundation model (Toto or Chronos class) | Container, opt-in | metered |

Statistics first: published benchmarks show simple methods often beat deep models, and
Workers AI hosts no time-series models today.

### 7.3 Agentic monitors

An agentic monitor is a natural-language objective with a deterministic guard and a budget.

- **Trigger:** a rule firing, a tier-0/1 anomaly, a schedule, or a person. The agent never
  decides whether to page; rules do.
- **Run:** a Workflow per investigation (durable steps, replayable), with an Agents SDK object
  for identity and memory, and AI Gateway for spend caps and logging.
- **Tools:** the same read-only, tenant-scoped tool surface as external agents (§8.3), plus
  code execution in a Dynamic Worker for bulk analysis.
- **Output:** a report in which every claim links to the query that supports it, an annotated
  draft dashboard, and a confidence statement. Published root-cause accuracy for such agents
  is 25–60%, so reports are advisory and people rate them; ratings feed a replay evaluation.
- **Safety:** telemetry is untrusted input. Log lines can carry instructions, so safety is
  architectural: no write tools, no cross-tenant handles, no egress, and an injection corpus
  in CI.

## 8. Frontend and agent surface

### 8.1 Dashboard model: `viz.dashboard/v1`

A small, closed JSON Schema in the shape Grafana v2 and Perses converged on: a map of panels
keyed by stable id, a separate layout tree, named queries, variables, and reusable fragments.
Each panel requires a unit and a description; each dashboard requires an intent. Edits are
RFC 6902 patches against a base revision. Every write is dry-run first against real data, so
"this panel returns nothing" is caught before it is saved. Revisions record who or what made
them. Importers cover Grafana and Perses.

### 8.2 One model, three readers

Every view has a visual form, a text form and a structured form generated from the same spec
and data. The text form is a **digest**: per panel, the current value, range, trend, outliers
and threshold state. Agents read digests instead of raw series or screenshots, and the same
digest is the accessible view.

### 8.3 Agent tool surface

A stateless MCP endpoint on the `app` Worker with OAuth scopes. About twelve tools:
`search_telemetry`, `describe_metric`, `validate_query`, `query`, `search_dashboards`,
`get_dashboard`, `read_dashboard`, `get_schema`, `write_dashboard`, `list_revisions`,
`annotate`, and `show_panel` (an MCP App that renders a live panel inside the agent host).
Results default to compact text within a token budget, with a cursor. The REST API and the
in-app assistant call the same operations.

### 8.4 Stack

React 19 single-page app on Workers static assets with the Cloudflare Vite plugin; Hono for
the API; TanStack Router and Query; CodeMirror 6 with PromQL and TraceQL grammars; uPlot
behind an internal chart interface for time series; custom canvas for heatmaps, flame graphs
and the trace waterfall; Observable Plot for the long tail. Arrow IPC for large results, JSON
for small ones; a hibernating WebSocket for live tail. Coarse data renders first and refines
in place.

## 9. Auth, tenancy, limits

- **Machines:** opaque prefixed API keys, hashed at rest, scoped (write, read, admin),
  cached at the edge, revocable at the shard.
- **People and agents:** OAuth through `workers-oauth-provider`; SSO via OIDC. Roles plus
  label-matcher policies applied in the planner.
- **Isolation:** tenant id comes only from the credential. Files are tenant-pure. Shards,
  rulers and the tenant object are per tenant. Cross-tenant reads are an invariant with its
  own fuzz suite.
- **Quotas:** enforced exactly in the shard (samples/s, active series, bytes/day, label
  limits); rejection reasons are visible to the tenant. Metering is taken at commit time.

## 10. Service levels (targets; *modelled* until benchmarked)

| Path | Target |
|---|---|
| Ingest acknowledgement | p50 < 80 ms, p99 < 500 ms for a 1 MB batch |
| Time to queryable | p99 < 10 s (served from the tail) |
| Dashboard panel, ≤ 24 h range | p50 < 300 ms, p95 < 1.5 s |
| Trace by ID | p95 < 1 s |
| Rule evaluation delay | interval + 15 s, no missed evaluations |

## 11. Cost (*modelled*; arithmetic in `research/10`)

| Scale | viz | Main drivers |
|---|---|---|
| Hobby: 10k series, 1 GB logs/day, 1M spans/day | ≈ $5.20/month | plan fee; R2 storage |
| Team: 1M series, 100 GB logs/day, 500M spans/day | ≈ $250/month | R2 storage, ingest CPU |
| Scale: 100M series, 10 TB logs/day, 50B spans/day | ≈ $18–25k/month | long-retention storage, shard duration |

Levers, in order of effect: rollups for long retention; batching WAL writes; rules on the
tail rather than on R2; client-side batching; flush interval. The threats to the floor are
objects kept awake by timers and commits made when nothing changed; the design has neither.
A tenant that sends data every few seconds keeps one shard awake (about $4/month of duration
at list price, inside the included allowance for a single tenant).

## 12. Risks

| Risk | Mitigation |
|---|---|
| Managed catalog corruption or undocumented limits | Interface, ledger, scrubber, R2-native fallback (§5.4) |
| WASM core too large or too slow for 128 MB / 1 s startup | Spike first; split Workers by role; Container fallback; pure-JS Parquet as plan B |
| PromQL compliance is a long tail | Port from the reference with the upstream corpus; publish the supported subset |
| Cloudflare ships a competing product | Differentiate on open formats, PromQL/TraceQL, external sources, agent surface |
| Platform-wide outage | Accepted for a Cloudflare-only product; data stays readable as plain Iceberg |
| Committer as a per-table bottleneck | Off the request path; cells bound its load; commit batches are large |
