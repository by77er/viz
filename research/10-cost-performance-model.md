# 10 — Quantitative cost and performance model for viz

Date: 2026-11-18. Author role: performance engineering / FinOps research.

**Web access status.** Cloudflare pricing and limits pages were fetched live on 2026-11-18 and are marked **[V]** (verified). Competitor price pages were fetched live and are also **[V]**. The web *search* budget ran out part-way through, so most **performance** figures (codec throughput, Parquet decode speed, R2 latency distributions, cold-start time) could not be re-verified and are marked **[T]** (training knowledge / community anecdote, treat as hypotheses to benchmark). Two pages returned 404 (Workers CompressionStream doc, Basin Catalog/SQL `platform/limits` under the old R2 paths). The AWS S3 price table did not render; S3 figures other than the GET price are **[T]**.

**Naming change that affects every other research doc.** On 2026-10-01 Cloudflare renamed its data platform to **Cloudflare Basin** (GA): Pipelines → *Basin Pipelines*, R2 Data Catalog → *Basin Catalog*, R2 SQL → *Basin SQL*. Old names/APIs still work and "will be deprecated in the future". Billing for all three was switched on **2026-08-03**. [V]

---

## 0. Headline numbers

| Tier | Uncompressed ingest / month | viz monthly cost (optimized design) | viz naive design | Cheapest managed comparator (list) |
|---|---|---|---|---|
| Hobby (10k series, 1 GB/d logs, 1M spans/d) | 131 GB | **≈ $5.20** | ≈ $10 (if Basin Pipelines is the ingest path) | Grafana Cloud Free $0; Axiom Personal $0 |
| Team (1M series, 100 GB/d, 500M spans/d) | 45 TB | **≈ $245–265** steady state (≈ $150 in month 1) | ≈ $570 | Axiom ≈ $1.2k (logs+traces only); Grafana Cloud ≈ $12k |
| Scale (100M series, 10 TB/d, 50B spans/d) | 4,506 TB | **≈ $18k–25k** | ≈ $56k (≈ $270k if everything goes through Basin Pipelines) | Grafana Cloud list ≈ $1.2M; self-hosted LGTM on AWS ≈ $150k–250k [T] |

Unit economics of the optimized design (derived in §3):

- **Logs:** ≈ $0.004 per GB ingested (uncompressed), 30-day retention.
- **Traces:** ≈ $0.0055 per GB ingested, 30-day retention.
- **Metrics:** ≈ $0.0008–0.001 per million samples, 13-month raw retention.
- **CPU price anchor:** $0.02 per million CPU-ms = **$0.072 per CPU-core-hour**, billed only on active CPU, no idle. [V arithmetic]
- **One always-in-memory Durable Object costs $4.15/month** in duration (the included 400,000 GB-s covers 1.2 such objects). This single number determines whether the $5 floor survives multi-tenancy.

Dominant cost drivers, in order, at scale: (1) R2 storage of long-retention metrics, (2) DO duration for always-on buffer shards, (3) Worker CPU for decode/encode, (4) DO SQLite rows written if used as a per-request WAL, (5) compaction. Request fees, R2 operations and query compute are second-order *if* batching and caching are done; each becomes first-order if they are not.

---

## 1. Verified pricing table (fetched 2026-11-18)

All prices USD. "Included" = monthly allotment on the Workers Paid plan ($5/month account minimum) unless stated.

| Service | Meter | Included | Overage | Notes |
|---|---|---|---|---|
| **Workers** [V] | Requests | 10M | $0.30 / M | Static asset requests free and unlimited |
| | CPU time | 30M CPU-ms | $0.02 / M CPU-ms | No charge for wall-clock duration; no egress fee |
| | CPU limit | — | — | 30 s default, configurable to 5 min per request; 15 min for Cron (≥1 h interval) and Queue consumers |
| **Durable Objects** [V] | Requests (HTTP, RPC sessions, alarms; WS inbound at 20:1) | 1M | $0.15 / M | |
| | Duration | 400,000 GB-s | $12.50 / M GB-s | Billed at 128 MB while the object is active; hibernation-eligible idle objects are not billed |
| | SQLite rows read | 25 B | $0.001 / M | |
| | SQLite rows written | 50 M | $1.00 / M | Deletes count as rows written; each `setAlarm()` is one row written |
| | SQLite stored data | 5 GB-month | $0.20 / GB-month | SQLite storage billing live since 2026-01-07 (page text still says "will be enabled"; changelog lists the date) |
| | KV-backend (legacy) | 1M read units / 1M write / 1 GB | $0.20 / M read (4 KB units), $1.00 / M write, $0.20 / GB-month | Not recommended for new classes |
| **R2 Standard** [V] | Storage | 10 GB-month | $0.015 / GB-month | |
| | Class A (PUT, COPY, LIST, multipart create/part/complete) | 1M | $4.50 / M | |
| | Class B (GET, HEAD) | 10M | $0.36 / M | |
| | Delete, egress | — | free | |
| **R2 Infrequent Access** [V] | Storage / A / B / retrieval | none | $0.01 / GB-month; $9.00 / M; $0.90 / M; $0.01 / GB retrieved | 30-day minimum storage duration |
| **Basin Catalog** (ex R2 Data Catalog) [V] | Catalog operations | 1M | $9.00 / M | Billing since 2026-08-03 |
| | Compaction data | 10 GB | $0.005 / GB processed | Only when compaction is enabled for a table |
| | Compaction objects | 1M | $2.00 / M objects | Target file size 64–512 MB, default 128 MB; Parquet only |
| **Basin SQL** (ex R2 SQL) [V] | Data scanned (compressed bytes read) | 10 GB | $0.0025 / GB ($2.50 / TB) | 10 MB minimum per query; failed queries and EXPLAIN/SHOW/DESCRIBE free |
| **Basin Pipelines** [V] | Stream ingress | unlimited | free | |
| | SQL transforms | 50 GB | $0.04 / GB | |
| | Sink delivery | 50 GB | $0.03 / GB (JSON), **$0.06 / GB (Parquet / Iceberg)** | Measured on **uncompressed** data |
| **Queues** [V] | Operations (per 64 KB chunk; write + read + delete = 3 ops/message) | 1M | $0.40 / M | Retention 4 days default, up to 14 |
| **Workers KV** [V] | Reads / writes / deletes / lists / storage | 10M / 1M / 1M / 1M / 1 GB | $0.50 / M; $5.00 / M; $5.00 / M; $5.00 / M; $0.50 / GB-month | |
| **D1** [V] | Rows read / rows written / storage | 25 B / 50 M / 5 GB | $0.001 / M; $1.00 / M; $0.75 / GB-month | |
| **Workflows** [V] | Requests / CPU | shared with Workers | $0.30 / M; $0.02 / M CPU-ms | |
| | Steps | 500,000 | $0.80 / 100,000 | Step and storage billing since 2026-08-10 |
| | Storage | 1 GB-month | $0.20 / GB-month | |
| **Containers** [V] | Memory | 25 GiB-hours | $0.0000025 / GiB-s | Provisioned, billed per 10 ms while running |
| | CPU | 375 vCPU-min | $0.000020 / vCPU-s (= $0.072 / vCPU-hour) | Active usage only |
| | Disk | 200 GB-hours | $0.00000007 / GB-s | |
| | Egress | 1 TB (NA+EU) | $0.025 / GB NA+EU; $0.04–0.05 elsewhere | Instance types `lite` (1/16 vCPU, 256 MiB) … `standard-4` (4 vCPU, 12 GiB, 20 GB disk) |
| **Analytics Engine** [V] | Data points written / read queries | 10M / 1M | $0.25 / M; $1.00 / M | Page still says "you will not be billed" at present |
| **Workers Logs** [V] | Log events | 20M | $0.60 / M | 7-day retention. **Moves to Cloudflare Observability pricing on 2026-12-01** |
| **Cloudflare Observability** (from 2026-12-01) [V] | Ingestion / storage | 50 GB / 10 GB-month | **$0.25 / GB ingested**, $0.10 / GB-month | Covers Workers Logs, Workers Traces, Containers logs, R2 access logs, AI Gateway logs. 7-day retention; 30/90/365-day options "planned" |
| **Cache API** | — | — | no per-operation charge [T] | 512 MB max object; 1,000 Cache calls per request on Paid [V] |
| **Workers AI** | Neurons | 10,000 / day [T] | $0.011 / 1,000 neurons [T] | Not fetched; irrelevant to the core data path |
| **Workers Logpush** [V] | Requests | 10M | $0.05 / M | |

Not included in the $5 floor and not needed: Hyperdrive, Vectorize, Images, Stream.

### Limits that shape the cost model

| Limit | Value | Source |
|---|---|---|
| Subrequests per invocation | 10,000 default on Paid, configurable up to 10M | [V] |
| Simultaneous open connections | 6 per invocation "waiting for response headers"; counts `fetch`, KV, Cache, R2, Queues, TCP; "Workers triggered via Service bindings share the same connection limit" | [V] |
| Memory per isolate | 128 MB | [V] |
| Worker bundle | 64 MiB uncompressed, no compressed limit | [V] (was 10 MB compressed in older docs) |
| Startup (global scope) | 1 second | [V] |
| DO soft throughput limit | 1,000 requests/s per object | [V] |
| DO SQLite storage per object | 10 GB; row/BLOB max 8 MB as reported by the fetched page (older docs said 2 MB — confirm) | [V, with caveat] |
| DO idle behaviour | Hibernates after 10 s idle if hibernation-eligible; otherwise evicted after 70–140 s idle | [V] |
| R2 | 1 write/s to the same key; 5 GiB single PUT; 10,000 multipart parts; no documented per-bucket object-op rate limit | [V] |
| Queues | 128 KB message; 100 messages or 256 KB per `sendBatch`; 5,000 messages/s per queue; max batch wait 60 s; 250 concurrent consumers; 25 GB backlog | [V] |
| Basin Pipelines | **20 streams, 20 sinks, 20 pipelines per account**; 1 GB/s per stream (raised from 5 MB/s on 2026-10-01); 5 MB per ingestion request | [V] |
| Basin SQL | HTTP API and Wrangler only (no Workers binding found); `LIMIT` max 10,000, default 500; ORDER BY restricted to partition-key columns per the 2025 deep-dive; heavy joins can 502/time out | [V/partly dated] |
| Workers Logs | 5 B events/day/account then 1% sampling; 256 KB per event | [V] |

---

## 2. Model assumptions (change these first when re-deriving)

Month = 30 days = 2,592,000 s.

| Parameter | Value | Status |
|---|---|---|
| Metric sample, uncompressed remote-write v1 / OTLP | 200 B (labels repeated per series per request) | [T] RW 2.0 symbol tables cut this by roughly half or more |
| Metric sample on the wire (snappy/zstd) | 20 B | [T] |
| Metric sample stored (Parquet, zstd, sorted by series) | 3 B incl. label dictionary and footer overhead | [T] Prometheus TSDB achieves ~1.3 B; 3 B is deliberately conservative |
| Log line | 250 B average → 4M lines per GB | assumption |
| Log compression in Parquet+zstd | 8× ; on the wire (gzip) 6× | [T] |
| Span | 500 B uncompressed OTLP → 2M spans per GB | assumption |
| Span compression stored | 6× ; on the wire 5× | [T] |
| Ingest CPU (decompress + protobuf decode + validate + columnar encode + zstd) | **40 CPU-ms per uncompressed MB** (25 MB/s per core) | [T] — top benchmark priority |
| Retention | metrics 13 months raw; logs 30 days; traces 30 days | assumption |
| Query fan-out | 16 Class B reads and 50 CPU-ms per dashboard query after footer caching; 5 Worker invocations per query (coordinator + 4 leaves) | assumption |
| Alert rule | 1 evaluation per minute = 43,200 per rule-month | assumption |

Derived volumes:

| | Hobby | Team | Scale |
|---|---|---|---|
| Samples / month | 10,000/60 × 2.592M = **432 M** | 1M/15 × 2.592M = **172.8 B** | **17.28 T** |
| Metrics uncompressed | 86.4 GB | 34,560 GB | 3,456 TB |
| Logs uncompressed | 30 GB | 3,000 GB | 300 TB |
| Spans / month; uncompressed | 30 M; 15 GB | 15 B; 7,500 GB | 1.5 T; 750 TB |
| **Total uncompressed** | **131.4 GB** | **45,060 GB** | **4,506 TB** |
| Total on the wire | 16.6 GB | 5,456 GB | 545.6 TB |
| New stored / month (metrics / logs / traces) | 1.3 / 3.75 / 2.5 GB | 518 / 375 / 1,250 GB | 51.8 / 37.5 / 125 TB |
| Steady-state stored (13 mo / 30 d / 30 d) | 23.1 GB | 8,364 GB | 836.4 TB |

---

## 3. Workload models

### 3.1 Hobby — target: stay at the $5 floor

Assumed agent behaviour: one OTel Collector / Prometheus flushing each signal every 10 s → 3 × 259,200 = **0.78 M requests/month**.

| Component | Arithmetic | Usage vs included | Cost |
|---|---|---|---|
| Workers Paid base | | | $5.00 |
| Ingest requests | 0.78 M | 10 M included | $0 |
| Ingest CPU | 131.4 GB × 40,000 ms/GB = 5.3 M ms | 30 M included | $0 |
| Buffer DO requests | 0.78 M | 1 M included | $0 |
| Buffer DO duration | worst case one always-on object: 0.128 GB × 2,592,000 s = 331,776 GB-s | 400,000 included | $0 |
| DO SQLite rows (one row per request + delete) | 1.55 M | 50 M included | $0 |
| R2 Class A | flush every 5 min: 3 signals × 8,640 × ~3 objects (data, manifest, manifest list) = 78 k | 1 M included | $0 |
| Catalog operations | 26 k commits | 1 M included | $0 |
| R2 storage | 23.1 GB steady − 10 GB free = 13.1 GB × $0.015 | | **$0.20** |
| Compaction (Basin) | 7.5 GB × 1.5 passes = 11.3 GB | 10 GB included | $0.01 |
| Query | 72,000 queries (1 user, 2 h/day, 10 panels, 30 s refresh): 1.15 M Class B, 3.6 M CPU-ms, 0.36 M requests | all inside included | $0 |
| Alerts | 20 rules × 43,200 = 0.86 M evaluations, evaluated in the buffer DO on its alarm | inside included | $0 |
| **Total** | | | **≈ $5.20** |

Budget consumption at Hobby: requests ~12% of 10 M (ingest + query), CPU ~40% of 30 M ms once compaction is included, DO duration up to 83% of 400,000 GB-s, R2 Class B ~12%. **DO duration is the tightest allotment.** A second always-on DO (for example a separate object per signal, or a coordinator that never hibernates) adds $4.15/month each and nearly doubles the hobby bill.

What breaks the floor:

| Design choice | Extra cost at Hobby |
|---|---|
| Basin Pipelines as the ingest path | (131.4 − 50) GB × $0.06 = **+$4.88** |
| One DO per signal, all kept warm | 2 extra × $4.15 = **+$8.30** |
| Flush every 10 s instead of 5 min, 3 objects + 1 catalog op each | 777 k Class A + 259 k commits per signal ×3 → still inside free tier for one tenant, but see multi-tenant note below |
| Alert rules run as R2-backed queries every minute | 3.5 M Class B — inside free tier at 20 rules; scales badly |
| Workers Logs left at 100% sampling with a log line per request | fine at Hobby; at Team it is the Observability $0.25/GB meter |

**Multi-tenant floor.** If viz hosts many hobby tenants in one account, the included allotments are shared. Marginal cost of one more always-active hobby tenant with *dedicated* table commits every 60 s: 3 signals × 43,200 commits × ($9/M catalog + 3 × $4.50/M Class A) = **$2.92/tenant-month** in pure commit overhead; at a 10-minute flush it is $0.29; with shared multi-tenant tables (tenant as partition/sort key, one commit covering all tenants) it tends to zero. A dedicated always-warm DO adds $4.15. Design target: marginal idle tenant = $0, marginal active hobby tenant < $0.50.

### 3.2 Team

| Component | Default-agent / naive design | Optimized design | Lever |
|---|---|---|---|
| Workers base | $5.00 | $5.00 | |
| Ingest requests | metrics 172.8 B / 2,000 per send = 86.4 M; logs 3,000 GB / 1 MB = 3 M; spans 15 B / 1,000 = 15 M → 104.4 M → (104.4 − 10) × $0.30 = **$28.32** | metrics at 10,000 samples per send = 17.3 M → 35.3 M total → **$7.58** | client batch size |
| Ingest CPU | 45,060 GB × 40,000 ms = 1,802 M ms → (1,802 − 30) × $0.02 = **$35.45** | same; RW 2.0 or label interning could halve it | protocol, WASM decoder |
| Buffer DO requests | (104.4 − 1) × $0.15 = $15.51 | (35.3 − 1) × $0.15 = $5.14 | batching |
| Buffer DO duration | 8 always-on shards × 331,776 = 2.65 M GB-s → (2.65 − 0.4) × $12.50 = **$28.18** | same | shard count |
| DO SQLite rows written | row per request + delete = 208.8 M → **$158.80** | 1-second group commit into a ring of reused slots: 8 × 2.592 M = 20.7 M (inside 50 M) → **$0** | group commit, no deletes |
| R2 Class A | 8 shards × 43,200 flushes × 3 objects = 1.04 M → $0.17 | same | |
| Catalog operations | 345,600 commits (inside 1 M) → $0 | $0 | |
| R2 storage (steady) | (8,364 − 10) GB × $0.015 = **$125.31** (month 1: $32.00) | same; ≈ $45 with 5-minute rollups after 30 days | downsampling, retention |
| Compaction (Basin) | 2,143 GB × 1.5 passes = 3,215 GB → $16.03 | same | |
| Query | 2.5 M queries (10 concurrent users, 8 h × 22 days, 12 panels, 30 s refresh): Class B 40 M → $10.80; CPU 125 M ms → $2.50; requests 12.5 M → $3.75 = **$17.05** | lower with result caching; kept as is | Cache API, step alignment |
| Alerts | 2,000 rules → 86.4 M evaluations as R2 queries: Class B 345.6 M → $124.42; CPU 864 M ms → $17.28; requests $0.26 = **$141.96** | evaluated on the write path in the buffer DO: 86.4 M × 2 ms → **$3.46** | write-path rules |
| UI | static assets free; API calls counted in query | | |
| **Total** | **≈ $572** | **≈ $243** (+ ~$20 contingency for metadata, KV, self-telemetry) | |

Alternatives for the buffering tier at Team scale:

| Buffer design | Monthly cost | Comment |
|---|---|---|
| Durable Object shards (above) | $33 (requests + duration) | lowest cost, read-your-writes freshness from the DO |
| Queues | 5,456 GB wire / 64 KB = 85.3 M chunks × 3 ops = 255.8 M ops → **$101.90** | 128 KB message cap forces splitting; no query on buffered data |
| Basin Pipelines → Iceberg | (45,060 − 50) GB × $0.06 = **$2,700.60** | billed on uncompressed bytes; 20 streams per account; ~11× the entire rest of the bill |

### 3.3 Scale

Sharding assumption: 1,000 buffer shards (1.74 MB/s uncompressed and ~0.2 MB/s wire each; ~7% CPU each at 40 ms/MB). This is conservative; 250 shards would cut duration to ~$1,000 at the price of 50 MB buffered per shard per minute against a 128 MB isolate.

| Component | Default-agent / naive | Optimized | Lever |
|---|---|---|---|
| Ingest requests | 10.44 B → **$3,129** | metrics 50,000 samples per send (~1 MB wire), spans 4,000 per send → 1.02 B → **$303** | client batching |
| Ingest CPU | 4,506,000 GB × 40,000 ms = 180,240 M ms → **$3,604** | same ($1.2k–1.8k if the per-MB cost halves) | decode efficiency |
| Buffer DO requests | $1,566 | $153 | batching |
| Buffer DO duration | 1,000 × 331,776 = 331.8 M GB-s → **$4,142** | same (≈ $1,000 with 250 shards) | shard sizing |
| DO SQLite rows written | 20.9 B → **$20,830** | one upsert per request into a ring, no deletes: 1.02 B → **$971**; $0 if acks are not durable before flush | WAL strategy |
| R2 Class A | 1,000 shards × 43,200 × 3 = 129.6 M → $579 | $116 at a 5-minute flush | flush interval |
| Catalog operations | 43.2 M commits → $380 | ≈ $1 if a committer batches all shards into one commit per table per minute | commit batching |
| R2 storage (steady) | 836,420 GB × $0.015 = **$12,546** (month 1: $3,215) | 5-minute rollups after 30 days: raw 51.8 TB + 12 × 10.4 TB = 176 TB, plus 162.5 TB logs/traces = 338.8 TB → **$5,082** | downsampling |
| Compaction (Basin) | 321,510 GB × $0.005 + 43.2 M objects × $2/M = **$1,692** | same; fewer, larger flushes cut the object fee | file size at flush |
| Query | 100 M queries: Class B 1.6 B → $572; CPU 5,000 M ms → $100; requests 500 M → $150 = **$822** | same | caching |
| Alerts | 100,000 rules → 4.32 B evaluations: Class B 17.3 B → $6,221; CPU $864; requests $13 = **$7,098** | write-path: 8,640 M ms → **$173** | write-path rules |
| **Total** | **≈ $56,400** | **≈ $25,400** raw retention; **≈ $17,900** with downsampling | |

Whole-pipeline through Basin Pipelines at this scale: 4,506,000 GB × $0.06 = **$270,357/month** — more than ten times the entire optimized bill, and the 20-stream account limit rules out per-tenant streams. Queues: 25.6 B ops → $10,230.

Optimized cost per unit at Scale: $25,400 / 4,506,000 GB = **$0.0056 per uncompressed GB**; 0.57 ¢.

### 3.4 Per-unit derivation

**Logs, per uncompressed GB:** request (1 MB batches → 1,000 requests: $0.0003 Worker + $0.00015 DO) + CPU (40,000 ms → $0.0008) + storage (0.125 GB × $0.015 × 1 month = $0.0019) + compaction (0.125 × 1.5 × $0.005 = $0.0009) = **≈ $0.004**.

**Traces, per uncompressed GB:** requests (0.5 MB batches → 2,000: $0.0009) + CPU $0.0008 + storage (0.167 GB × $0.015 = $0.0025) + compaction $0.00125 = **≈ $0.0055**.

**Metrics, per million samples:** requests (100 at 10,000 per send: $0.000045) + CPU (200 MB × 40 ms = 8,000 ms → $0.00016) + storage (3 MB × 13 months × $0.015/GB = $0.000585) + compaction $0.00002 = **≈ $0.0008**. Storage is 72% of it.

### 3.5 Cost drivers and levers

| Driver | Sensitivity | Lever |
|---|---|---|
| Worker + DO request fees ($0.45 per million ingest requests end to end) | linear in request count; a 2,000-sample remote-write default costs 5× a 10,000-sample batch | Document recommended agent settings; accept large bodies (100 MB limit); reject or warn on tiny batches; per-tenant request metering so the cost is visible |
| DO duration ($4.15 per always-on object-month) | linear in number of *warm* objects, not in data | Never keep a per-tenant object warm for an idle tenant; no `setTimeout`/open I/O so objects are hibernation-eligible; shared shards for small tenants; alarms instead of timers |
| DO SQLite rows written ($1/M) | linear in rows, independent of row size | One BLOB row per group commit; overwrite ring slots instead of insert+delete; choose per tenant whether acks are durable |
| R2 Class A + catalog commits ($9/M commits + ~3 × $4.50/M PUTs ≈ $22.50 per million commits) | ∝ shards × tables ÷ flush interval | Size- or time-triggered flush (whichever first); serve fresh data from the DO head so flush interval is not the freshness SLO; one commit per table per interval across shards and tenants |
| R2 Class B ($0.36/M) | ∝ queries × files × ranges | Compaction to 128–512 MB files; cache Parquet footers and Iceberg manifests (Cache API / DO / KV); coalesce adjacent column-chunk ranges into one GET; cache step-aligned query results |
| R2 storage ($15/TB-month) | ∝ retention × bytes/sample | Downsampling; sort order (series, time) to maximize encoding; zstd level; Infrequent Access only for data that is almost never read (retrieval $0.01/GB and Class B $0.90/M erase the saving quickly) |
| Worker CPU ($0.072/core-hour) | ∝ uncompressed bytes | WASM decoders, avoiding JS object materialization, RW 2.0 / OTLP-Arrow, passing compressed blocks through untouched where possible |
| Alert evaluation | ∝ rules × frequency × (R2 reads if query-path) | Evaluate on the write path against the in-DO head; group rules by tenant/shard; only fall back to R2 queries for long-range rules |
| Compaction | $0.005/GB (Basin) vs ~$0.001–0.003/GB DIY CPU [T] | Flush larger files so fewer passes are needed; Basin compaction is cheap enough that DIY is justified only for custom sort/downsample logic |
| Self-observability | Cloudflare Observability at $0.25/GB from 2026-12-01 | Sample Worker logs (`head_sampling_rate`), emit metrics to viz itself or Analytics Engine |

---

## 4. Comparison with other platforms

List prices fetched 2026-11-18 unless marked [T]. "viz" is the optimized design.

### 4.1 Unit prices

| Platform | Logs $/GB ingested | Traces $/GB or per event | Metrics | Minimum |
|---|---|---|---|---|
| **viz (modelled)** | ≈ $0.004 (30 d) | ≈ $0.0055/GB (30 d) | ≈ $0.0008 per M samples ≈ **$0.14 per 1k series-month at 15 s** | $5 |
| Cloudflare Observability (own telemetry only) [V] | $0.25 + $0.10/GB-month | same meter | none | 50 GB included in Workers Paid |
| Grafana Cloud Pro [V] | $0.05 process + $0.40 write (+ $0.10 retention) ≈ $0.45–0.55 | same | **$6.50 per 1k series** (Enterprise "as low as $3") = $0.0376 per M samples at 15 s | $19 + usage; free tier 10k series, 50 GB logs, 50 GB traces, 14 d |
| Datadog [V] | $0.10 ingest + **$1.70 per M events indexed (15 d)**; Flex storage $0.05 per M events | $0.10/GB ingested + $1.70 per M indexed spans; APM host $31 | **$5 per 100 custom metrics** = $50 per 1k series ≈ $0.29 per M samples at 15 s | host fees $15+ |
| Honeycomb [V] | events | Pro "starting at $150" for 50 M events (up to 750 M) ≈ $3 per M events at entry | metrics allowance 250 M–3.75 B data points on Pro | Free 20 M events/month |
| Axiom [V] | $0.12/GB (first 1,000 GB/month free), falling to $0.06 at ≥5 PB; storage $0.03/GB-month compressed; query $0.20 → $0.08 per GB-hour | same meter | not published on the page | $25 platform fee; Personal free 500 GB |
| ClickHouse managed observability (beta) [V] | $0.10/GB (list $0.20), 30 d included | same | $0.05 per M data points (list $0.10) | none |
| ClickHouse Cloud self-managed ClickStack [V] | compute $0.218–0.390 per unit-hour (8 GiB, 2 vCPU), storage $25.30/TB-month; worked example 5 TB/month ingest = $449.60 ≈ $0.09/GB | same | same cluster | 2-replica cluster |
| Self-hosted Mimir/Loki/Tempo on AWS [T] | S3 $0.023/GB-month, PUT $0.005/1k, GET $0.0004/1k [V], internet egress $0.09/GB, cross-AZ $0.01/GB each way; compute ≈ $35/vCPU-month on-demand | | Mimir sizing rule: ~1 core per 25k samples/s (distributor) + ~1 core and 2.5 GB per 300k in-memory series × replication 3 | several always-on nodes |

Object-store price ratio worth remembering: R2 PUT $4.50/M vs S3 $5.00/M; R2 GET $0.36/M vs S3 $0.40/M; R2 storage $0.015 vs S3 $0.023; R2 egress $0 vs $0.09/GB. The structural advantages are zero egress/cross-AZ fees and zero idle compute, not cheaper operations.

### 4.2 Monthly bill at the three tiers

| Platform | Hobby | Team | Scale |
|---|---|---|---|
| **viz** | **$5.20** | **≈ $250** | **≈ $18k–25k** |
| Grafana Cloud | $0 (fits the free tier exactly at 10k series; 14-day retention, 3 users) | 1M series $6,500 + logs 3,000 GB × $0.50 = $1,500 + traces 7,500 GB × $0.50 = $3,750 + 50 users × $8 + $19 ≈ **$12,200** | list ≈ $650k + $150k + $375k ≈ **$1.18M**; at "$3 per 1k" metrics and negotiated discounts perhaps $400k–600k |
| Datadog | 10k custom metrics $500 + logs (30 GB × $0.10 + 120 M events × $1.70/M = $207) ≈ **$700+** | metrics $50,000 + logs ($300 + 12 B events × $1.70/M = $20,400) + spans $750 ingest ≈ **$71k** before host fees | not meaningful at list |
| Honeycomb | 150 M events/month exceeds Free (20 M) → Pro ≥ $150 | 27 B events/month → Enterprise, not published | Enterprise |
| Axiom | $0 (Personal) for logs + traces | (10,500 − 1,000) GB × $0.12 + $25 + ~1.6 TB compressed × $0.03 ≈ **$1,210** + query compute; metrics extra | 1.05 PB/month at $0.07–0.085/GB ≈ **$80k** logs + traces only |
| ClickHouse managed obs (beta price) | 45 GB × $0.10 + 432 M points × $0.05/M ≈ **$26** | $1,050 + 172,800 M × $0.05/M = $8,640 ≈ **$9,700** | ≈ $105k + $864k ≈ **$970k** |
| Cloudflare Observability (logs + traces only, 7 d) | $0 (45 GB < 50 GB included) | 10,450 GB × $0.25 ≈ **$2,600** | ≈ $262k |
| Self-hosted LGTM on AWS [T] | ≈ $60–150 (one small HA-less node + S3) | ≈ $2k–3.5k infrastructure + on-call | Mimir alone ≈ 1,400 vCPU ≈ $49k + S3 674 TB ≈ $15k + cross-AZ replication traffic ≈ $7k+; with Loki and Tempo ≈ **$150k–250k** + a platform team |

Reading: viz is 1–2 orders of magnitude below SaaS list price at Team and Scale, and roughly 5–10× below a well-run self-hosted stack at Scale, *provided the 40 ms/MB CPU assumption and the 3 B/sample storage assumption hold within about 3×*. Even at 5× worse CPU and 3× worse storage the Scale bill is about $65k. At Hobby, viz cannot beat free tiers on price; it competes on retention (13 months vs 14 days) and on having no series cap.

---

## 5. Performance facts for design

### 5.1 Verified platform facts

| Fact | Value |
|---|---|
| Worker startup limit | 1 s to parse and run global scope; 64 MiB uncompressed bundle |
| Warm-request rate | Cloudflare reported enterprise warm rate rising from 99.9% to 99.99% after Worker sharding ("Shard and Conquer"); same post states startup CPU limit was raised 200 → 400 ms at the time (docs now say 1 s) |
| CPU price | $0.02 per M CPU-ms = $0.072 per core-hour; I/O wait is free |
| Connection limit | 6 simultaneous connections waiting for response headers per invocation; R2, KV, Cache, Queues and `fetch` all count; service-binding callees "share the same connection limit" |
| Subrequests | 10,000 default, up to 10M configurable |
| DO throughput | soft limit 1,000 requests/s per object |
| DO lifecycle | hibernation after 10 s idle when eligible; eviction after 70–140 s when not; constructor re-runs on wake; in-memory state lost |
| DO SQLite write latency (third-party, Lumenize 2026) | output-gate flush ≈ 10–13 ms per transaction; ~410 transactions/s peak on one object at 128 concurrent clients; ~2–3 ms serial CPU per transaction; 56 ms round trip of which ~40 ms network |
| Queues | 5,000 messages/s per queue; ≤ 60 s batch wait; 250 concurrent consumers |
| Smart Placement | can take up to 15 minutes to decide; only affects `fetch` handlers, not RPC methods or named entrypoints; explicit placement hints exist (`region` such as `aws:us-east-1`, experimental `host`/`hostname` probing); docs say nothing about R2 as a placement target |
| Basin Pipelines | 1 GB/s per stream; "exactly-once delivery to R2" claimed; roll interval 60 s and 100 MB file size appear as setup defaults |
| Basin SQL | DataFusion-based, row group = partition, prunes via Iceberg manifest stats then Parquet footer stats; "results in seconds"; no published latency numbers |
| hyparquet | pure JS, dependency-free, < 10 kB min-zipped (per search summary), Snappy built in, other codecs via `hyparquet-compressors`; designed for HTTP range reads; `byteLength` hint avoids a HEAD |
| parquet-wasm | ~1.2 MB brotli / 5.9 MB unpacked; README recommends it over hyparquet when Arrow output and throughput matter, hyparquet when latency/bundle size matter |

### 5.2 Unverified planning numbers [T] — every row is a benchmark item

| Operation | Planning figure | Basis |
|---|---|---|
| Isolate cold start | ~5 ms for a small script; 50–300 ms when a multi-MB WASM module must be compiled/instantiated | historical Cloudflare claim; WASM cost is the risk for arrow-rs bundles |
| Protobuf decode in JS (protobuf-es / protobufjs) | 50–150 MB/s; object allocation dominated | community benchmarks |
| Protobuf decode in Rust→WASM (prost) | 200–500 MB/s | native is ~1 GB/s; WASM typically 1.5–3× slower |
| Snappy decompress | pure JS ~150–300 MB/s; WASM ~500–1,000 MB/s | |
| zstd (WASM) | decompress 300–700 MB/s; compress level 1–3 at 80–200 MB/s | |
| gzip via native `DecompressionStream` | decompress 200–400 MB/s; compress 30–80 MB/s | native code, no WASM boundary; formats documented as gzip/deflate/deflate-raw — zstd and brotli support in the Workers stream API not confirmed (doc page 404) |
| Parquet encode (arrow-rs in WASM, zstd-1) | 30–80 MB/s of uncompressed input | drives the 40 ms/MB assumption together with decode |
| Parquet decode (arrow-rs WASM) | 200–500 MB/s decoded for numeric columns, less for strings | |
| Parquet decode (hyparquet JS) | 50–200 MB/s decoded | |
| DuckDB-WASM | ~35 MB WASM; fits the 64 MiB bundle limit but needs >128 MB memory for non-trivial queries, has a multi-hundred-ms instantiate, and no threads in an isolate. Realistic only inside Containers | |
| R2 GET TTFB, Worker in the bucket's region | p50 20–60 ms, p99 200–600 ms | anecdotes range from "26 ms p99 for 1 MB" (dev.to benchmark) to "400–600 ms for ~10% of requests after idle" (2024 community thread) and 263 ms p99 (competitor-published) |
| R2 GET cross-region | add inter-region RTT (70–250 ms) per request | |
| R2 range read | same TTFB as a full GET; throughput 50–200 MB/s per stream | |
| R2 PUT (≤ 10 MB) | p50 60–150 ms, p99 0.5–1.5 s | |
| DO cold wake | 5–50 ms plus constructor work; SQLite-backed objects open lazily | |
| DO in-memory request handling | 1–3 ms CPU for a small RPC; an object saturates on CPU at ~300–1,000 requests/s | consistent with the Lumenize measurement |
| Queues end-to-end latency | 100 ms–1 s typical with `max_batch_timeout` 0–1 s; up to the configured wait otherwise | |
| Cache API hit | 1–10 ms; per-colo, not replicated; no tiered cache for `cache.put` | |
| Worker → DO in the same region | 1–5 ms; cross-continent 100–250 ms | |

### 5.3 The six-connection rule and fan-out

The limit counts connections *waiting for response headers*. An R2 `get()` occupies a slot only until headers arrive (TTFB), so one invocation can start roughly 6 / TTFB GETs per second: about 150–200 GETs/s at 30–40 ms TTFB. Body streaming is not limited by this rule but is limited by the 128 MB isolate and single-threaded decode.

Service-binding callees share the caller's connection budget according to the docs, so fanning out to stateless Workers via service bindings does **not** obviously multiply R2 parallelism (must be measured). Durable Object invocations have their own limit of 6, and separate top-level requests (via `fetch` to the Worker's own route) definitely do. Practical fan-out unit: a leaf invocation handling 4–8 files with CPU-parallelism of one core; the coordinator fans out to as many leaves as needed, limited by the 10,000-subrequest default.

### 5.4 Dashboard query latency model

For a panel touching N Parquet files with warm metadata:

```
T ≈ T_edge→region + T_plan + waves × (TTFB_R2 + T_transfer + T_decode) + T_merge
waves = ceil(ranges_per_leaf / 6); leaves run in parallel
```

With T_plan = 10 ms (manifest and footers cached), TTFB 40 ms, transfer + decode 20 ms per wave, merge 10 ms, 30 ms edge→region:

| N files | Leaves | p50 | p95/p99 driver | p95 estimate |
|---|---|---|---|---|
| 1 | 0 (inline) | ~110 ms | one GET tail | ~300 ms |
| 8 | 2 | ~150 ms | P(at least one of 16 GETs in its p99 tail) = 1 − 0.99^16 = 15% | ~450–700 ms |
| 64 | 8–16 | ~250 ms | 1 − 0.99^128 = 72%: the query p50 *is* the GET p99 | ~0.8–1.5 s |
| 500 (uncompacted or 30-day range on raw data) | 60+ | 0.6–1.5 s | tail + CPU | 2–5 s |

Consequences: (a) the number of GETs per query must stay in the tens, which is a compaction and rollup requirement, not a compute one; (b) hedged GETs (issue a duplicate after ~p90 latency) are worth their ~10% extra Class B cost; (c) cold metadata adds 2–4 sequential R2/catalog round trips (100–300 ms), so manifests and footers must be cached; (d) a 12-panel dashboard issuing 12 independent queries multiplies everything — batch the panels of one dashboard into one request and share file reads.

---

## 6. Latency and throughput budget (proposed SLOs)

| SLO | Target | Achievable? | Required optimizations |
|---|---|---|---|
| Ingest ack p99 | < 500 ms (p50 < 80 ms) for a 1 MB batch | Yes with in-memory or group-commit buffering: edge Worker 5–20 ms CPU for 1 MB at 40 ms/MB is too slow for p50 — budget is ~40 ms CPU, so decode must be ≤ 20 ms/MB or validation must be deferred to the DO. DO hop 1–5 ms in-region, group-commit wait ≤ 250 ms, output-gate flush ~12 ms | Shard DOs with a location hint near the tenant's senders; group commit window 100–250 ms; no R2 PUT on the ack path; back-pressure with 429 + Retry-After when a shard exceeds its memory watermark |
| Ingest throughput per shard | ≥ 5 MB/s uncompressed sustained, ≥ 300 requests/s | Likely; bounded by single-threaded CPU and 128 MB | Parse in the stateless Worker, hand the DO pre-encoded column chunks; flush at 32–64 MB buffered or on interval |
| Data freshness (time to queryable) | p99 < 10 s | Only if queries read the DO head. Via R2 alone it is flush interval + PUT + commit ≈ 65–90 s at a 60 s flush | Query path merges R2 files with a head read from each relevant shard (one RPC per shard); keep the head addressable by time range and series/trace hash |
| Dashboard query | p50 < 300 ms, p95 < 1.5 s for ≤ 24 h ranges; p95 < 4 s for 30 d | p50 yes; p95 depends on R2 tail (unmeasured) | Footer/manifest cache; ≤ ~30 files per query through compaction and rollups; hedged reads; step-aligned result cache (Cache API, 15–60 s TTL); one request per dashboard; query Worker placed in the bucket region |
| Trace by ID | p95 < 1 s for traces < 14 days old | Yes if lookup is O(1–3 files): otherwise a scan of every file in the time window | Partition or bucket by `hash(trace_id)`; sort by trace_id within files; Parquet bloom filters or page index; a compact trace-ID → file index for the unflushed and recently flushed window in DO SQLite |
| Log search (needle in 24 h for one tenant at Team) | p95 < 5 s | Uncertain; 100 GB/day ≈ 12.5 GB compressed per day → full scan is 12.5 GB of GETs and ~60–120 CPU-seconds across leaves | Per-file token bloom / n-gram skip index, sort by (service, time), massive leaf fan-out (100+ leaves), or delegate to Basin SQL ($0.0025/GB → $0.03 per full-day scan) |
| Alert evaluation delay | rule interval + ≤ 15 s; no missed evaluations | Yes on the write path; DO alarms are at-least-once | Rules compiled into the shard that owns the series; cross-shard rules evaluated by a ruler DO over head reads; R2-backed evaluation only for ranges longer than the head window |
| Query concurrency | 100 concurrent dashboards per tenant | Yes; stateless leaves scale horizontally | Per-tenant concurrency and bytes-scanned limits to bound cost |
| Cold-start impact | < 1% of requests over 100 ms extra | Probably; depends on WASM bundle size | Keep ingest Worker small (no query engine in it); lazy-instantiate WASM; separate Workers per role |

Throughput sanity check at Scale: 6.67 M samples/s + 4.6 M log lines/s + 0.58 M spans/s = 1.74 GB/s uncompressed. At 40 ms/MB this is 70 CPU-cores of continuous Worker CPU (180 B CPU-ms/month ÷ 2.592 B ms), which the platform absorbs without capacity planning; request rate is ~400–4,000 requests/s depending on batching, also trivial for Workers. The constraint is the stateful tier: ≥ 250–1,000 shards, each well under the 1,000 requests/s soft limit and under ~30% of one core.

---

## 7. Benchmark plan (prioritized)

P0 — these decide the architecture; run before writing the real ingest path.

1. **Ingest CPU per MB.** Worker that accepts Prometheus remote-write v1/v2 and OTLP (logs, traces) and produces Parquet/Arrow buffers. Variants: JS protobuf vs Rust→WASM; snappy JS vs WASM; zstd level 1 vs 3; hyparquet-writer vs arrow-rs. Measure CPU-ms per uncompressed MB from Workers analytics (`cpuTime`), peak memory, and bundle/startup time. Load: `avalanche` + Prometheus/Alloy for metrics, `telemetrygen` for OTLP, `k6` (xk6-client-prometheus-remote) or `vegeta` with recorded bodies for rate control. Pass: ≤ 40 ms/MB; stretch ≤ 15 ms/MB.
2. **DO duration billing under periodic traffic.** One DO receiving a request every 1 s, 5 s, 15 s, 60 s, with and without alarms, timers and in-flight I/O; read billed GB-s from the GraphQL analytics API after 24 h. Confirms whether an "active" tenant costs $4.15/month or near zero.
3. **DO buffering throughput and durability cost.** Requests/s and MB/s per object for: in-memory only; one SQLite BLOB row per request; group commit at 100 ms / 250 ms / 1 s; ring-slot overwrite vs insert+delete (verify billing rows). Record ack latency distribution, output-gate flush time, behaviour at the 128 MB limit, and `overloaded` errors. Tools: `k6` with constant-arrival-rate, `vegeta`.
4. **R2 latency distributions from Workers.** GET (full, 64 KB range, 1 MB range, 8 MB range), HEAD, PUT (100 KB, 5 MB, 50 MB), multipart; Worker in-region vs cross-region vs Smart Placement vs explicit placement hint; warm vs after 10 min idle; concurrency 1/6/32. Report p50/p95/p99/p99.9 TTFB and throughput. This calibrates §5.4.
5. **Connection-limit semantics.** Measure effective R2 GET parallelism from (a) one invocation, (b) fan-out via service binding, (c) fan-out via DO stubs, (d) fan-out via self-`fetch`. Decide the leaf topology.

P1 — needed to size the query path and choose libraries.

6. **Parquet read path.** hyparquet vs parquet-wasm vs arrow-rs custom build: footer parse time, decode MB/s for metric (dictionary + delta), log (strings) and span schemas, memory high-water mark, with zstd and snappy. Include row-group and page-index pruning effectiveness.
7. **End-to-end dashboard query.** Synthetic tenant at Team scale; PromQL `rate`/`sum by` over 1 h, 24 h, 7 d, 30 d with 1, 8, 64, 500 files; cold vs warm metadata; with and without hedging and result cache. Tools: `k6` driving the Prometheus HTTP API, Grafana k6 dashboards replay, `prombench`-style query mixes; `tsbs` (devops use case) to generate comparable metric data and queries.
8. **Trace-by-ID and TraceQL search.** `telemetrygen` / `xk6-tracing` to load 100 M–1 B spans; measure lookup p50/p95 with hash-bucket partitioning vs bloom filters vs DO index.
9. **Log search.** A ClickBench-style fixed query set for observability (needle search, top-K by service, error-rate over time, regex) over a 100 GB/day corpus (e.g. `flog` or the Loki `logcli`/`xk6-loki` generators); compare viz leaf fan-out against Basin SQL on the same Iceberg tables, in latency and $ per query.
10. **Flush and commit path.** Iceberg commit latency and conflict rate against Basin Catalog with 1, 10, 100, 1,000 concurrent committers per table; catalog operations billed per commit and per `loadTable`; any undocumented rate limits (note the "daily accepted-request limit" error on manual maintenance requests).
11. **Compaction.** Basin-managed compaction lag, output file sizes and billed GB/objects on a steady stream of 5 MB files; DIY compaction in a Worker/Workflow (streaming row groups inside 128 MB) vs a Container; cost per compressed GB for each.

P2 — scale-out and operational behaviour.

12. **Macro soak tests.** Hobby profile for 7 days to confirm the invoice is ≈ $5; Team profile for 48 h with the OTel Collector load generator (`testbed`), `avalanche` at 1M series, and 100 GB/day logs; compare invoice line items with §3.
13. **Alert evaluation on the write path.** 2,000 and 100,000 rules; CPU per evaluation, alarm jitter, evaluation delay distribution, behaviour during DO eviction and deploys.
14. **Cold starts and deploy disruption.** p99 latency during rollout; DO reset frequency; cost of constructor re-hydration from SQLite.
15. **Queues and Pipelines as alternatives.** Queue end-to-end latency at 1,000–5,000 messages/s with 100 KB messages; Basin Pipelines time-to-R2 and actual billed GB for a metrics-shaped stream, to confirm the model's rejection of both for the hot path.
16. **Cache API.** Hit ratio and latency for footers/manifests per colo; compare with a metadata DO and with KV.
17. **Multi-tenant fairness.** One noisy tenant at 10× its limit; verify shard isolation, 429 behaviour, and cost attribution accuracy.

Every benchmark should record the billed quantities (requests, CPU-ms, GB-s, rows, Class A/B, catalog ops) alongside latency so the cost model can be recalibrated from the same run.

---

## 8. Design implications for viz

1. **Durable Objects are the buffer; Basin Pipelines and Queues are not on the hot path.** Pipelines costs $0.06 per uncompressed GB — roughly 10× everything else combined at Team and Scale — and allows only 20 streams per account. Queues cost ~3× the DO design and cannot serve fresh reads. Pipelines remains a reasonable optional sink for low-volume or bring-your-own-table use.
2. **Treat warm DO count as a budgeted resource.** $4.15 per always-on object-month. Idle tenants must cost nothing: no timers, no per-tenant alarms when there is no data, shared shards for small tenants, dedicated shards only above a throughput threshold.
3. **Decouple freshness from flush interval.** Queries merge R2 with the DO head. This allows 1–10 minute, size-triggered flushes, which removes Class A, catalog and small-file compaction costs simultaneously.
4. **Batch commits across shards and tenants.** A committer per table performs one Iceberg commit per interval. Prefer shared multi-tenant tables partitioned by tenant bucket and time over table-per-tenant; per-tenant tables cost about $22.50 per million commits and multiply catalog metadata.
5. **Durability policy for acks is a cost knob.** Row-per-request WAL is the single largest naive cost ($159 at Team, $20.8k at Scale). Use group commit with one BLOB row into reused slots, and offer "ack after memory" for tenants who accept a bounded loss window.
6. **Push batching to the client and make it visible.** Document recommended `max_samples_per_send` (≥ 10,000) and OTLP batch sizes (1–4 MB); a tenant using defaults costs ~5× more in request fees.
7. **Evaluate alert and recording rules on the write path.** Query-path evaluation costs $142 at Team and $7.1k at Scale versus $3.5 and $173.
8. **Storage is the long-run bill; design the metric file format accordingly.** Sort by (metric, series, time), aim for ≤ 3 B/sample, and build downsampling early: it cuts the Scale storage bill from $12.5k to $5.1k and also reduces files per long-range query.
9. **Keep the number of GETs per query in the tens.** Compaction to 128–512 MB, cached footers/manifests, coalesced ranges, hedged reads, and one request per dashboard.
10. **Separate Workers by role.** A small ingest Worker (fast cold start, minimal WASM), a query coordinator/leaf Worker with the Parquet reader, and a UI Worker serving free static assets. Place query Workers in the bucket's region.
11. **Basin SQL is a cheap escape hatch for large scans** ($2.50/TB, no compute to manage) but is HTTP-only, has a 10 MB minimum per query ($0.000025), restricted ORDER BY and no latency guarantees — suitable for ad-hoc log analytics and long-range reports, not for dashboard panels or PromQL.
12. **Do not run DuckDB-WASM in isolates.** If a general SQL engine is needed beyond Basin SQL, use Containers (scale-to-zero, $0.072/vCPU-hour) for batch work such as heavy compaction or backfills.
13. **Meter per tenant from day one** (requests, uncompressed bytes, stored bytes, bytes scanned). The platform's own cost is linear in these, so a pass-through price of, say, $0.05/GB and $0.50 per 1k series would carry a >80% margin and still be 5–10× below the market.
14. **Watch the self-observability bill.** From 2026-12-01 Workers Logs/Traces are billed at $0.25/GB beyond 50 GB; one log line per ingest request at Scale would cost more than the ingest itself. Sample aggressively and dogfood viz for its own telemetry.

---

## 9. Open questions / unverified

- The **40 ms per uncompressed MB** ingest CPU figure and all codec/Parquet throughput numbers in §5.2 are estimates. A 3× error moves the Scale CPU line between $1.2k and $10.8k.
- **Bytes per stored sample (3 B)** and compression ratios for logs (8×) and spans (6×) are assumptions; real ratios depend on cardinality and attribute shape.
- **DO duration billing** between closely spaced requests: is an object that receives a request every few seconds billed continuously, or only while executing? Docs say hibernation-eligible idle time is free, but the 10 s threshold suggests the object is billed while idle-in-memory for up to 10 s after each request. If so, any shard receiving traffic more often than every 10 s is billed 100% of wall time (the model assumes this for Team and Scale, and the Hobby case fits in the allotment either way).
- **DO row/BLOB size limit**: fetched page says 8 MB; earlier documentation said 2 MB. Whether overwriting a row and `DROP TABLE` are billed as rows written needs measurement.
- **Service-binding connection sharing**: exact semantics of "share the same connection limit" for fan-out.
- **R2 latency distributions** are anecdotal; no current first-party p50/p99 numbers were found. Undocumented R2 per-bucket or per-prefix rate limits are unknown.
- **Basin Catalog limits** (commit rate per table, tables per catalog, what exactly counts as a "catalog operation", daily maintenance request limit) were not found; the limits pages 404 under the old paths and the long-form docs were only partly read.
- **Basin SQL**: no Workers binding found, no concurrency or timeout numbers; whether the ORDER-BY-on-partition-key restriction from the 2025 deep-dive still applies after the 2026 feature releases is unconfirmed.
- **Basin compaction "GB processed"** is assumed to mean compressed bytes read; and the number of passes (1.5) is a guess.
- **Workers `DecompressionStream`** codec list (zstd, brotli) not verified; nor is `node:zlib` zstd support in workerd.
- **Analytics Engine** still documented as not billed; a start date is unknown.
- **Queues latency** figures are from memory.
- **Competitor numbers**: Grafana logs "retention $0.10/GB" semantics, Axiom metrics pricing, Honeycomb pricing above 750 M events, and Datadog host-bundled allotments were not resolved. AWS S3 storage/PUT/egress and EC2 prices and the Mimir sizing rules are from training knowledge.
- **Query workload assumptions** (16 Class B and 50 CPU-ms per query; 2.5 M queries/month for 50 users) are placeholders until §7 items 6–7 are run.
- The model ignores: index/metadata objects beyond three per commit, exemplars, native histograms, rollup compute, retries, and the cost of deletes/retention enforcement (R2 deletes are free; lifecycle transitions are Class A).

---

## 10. Sources

Cloudflare (fetched 2026-11-18):

- Workers pricing — https://developers.cloudflare.com/workers/platform/pricing/
- Workers limits — https://developers.cloudflare.com/workers/platform/limits/
- Durable Objects pricing — https://developers.cloudflare.com/durable-objects/platform/pricing/
- Durable Objects limits — https://developers.cloudflare.com/durable-objects/platform/limits/
- Durable Object lifecycle — https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- DO SQLite storage billing changelog — https://developers.cloudflare.com/changelog/2025-12-12-durable-objects-sqlite-storage-billing and https://developers.cloudflare.com/durable-objects/release-notes/
- R2 pricing — https://developers.cloudflare.com/r2/pricing/
- R2 limits — https://developers.cloudflare.com/r2/platform/limits/
- Basin Catalog (R2 Data Catalog) pricing — https://developers.cloudflare.com/r2/data-catalog/platform/pricing/ ; overview https://developers.cloudflare.com/r2/data-catalog/ ; full docs https://developers.cloudflare.com/basin-catalog/llms-full.txt
- Basin SQL (R2 SQL) pricing — https://developers.cloudflare.com/r2-sql/platform/pricing/ ; full docs https://developers.cloudflare.com/basin-sql/llms-full.txt
- Basin Pipelines pricing — https://developers.cloudflare.com/pipelines/platform/pricing/ ; limits https://developers.cloudflare.com/pipelines/platform/limits/ ; full docs https://developers.cloudflare.com/basin/llms-full.txt
- Basin GA announcement — https://blog.cloudflare.com/cloudflare-basin/ ; changelog https://developers.cloudflare.com/changelog/product/basin/ and https://developers.cloudflare.com/changelog/post/2026-10-01-basin-ga/
- R2 SQL deep dive — https://blog.cloudflare.com/r2-sql-deep-dive/
- Queues pricing — https://developers.cloudflare.com/queues/platform/pricing/ ; limits https://developers.cloudflare.com/queues/platform/limits/
- Workflows pricing — https://developers.cloudflare.com/workflows/reference/pricing/
- Containers pricing — https://developers.cloudflare.com/containers/pricing/
- Analytics Engine pricing — https://developers.cloudflare.com/analytics/analytics-engine/pricing/
- Workers Logs — https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- Cloudflare Observability pricing (effective 2026-12-01) — https://developers.cloudflare.com/observability/pricing/
- Placement / Smart Placement — https://developers.cloudflare.com/workers/configuration/placement/
- Eliminating cold starts 2: shard and conquer — https://blog.cloudflare.com/eliminating-cold-starts-2-shard-and-conquer/
- Zero-latency SQLite storage in every Durable Object — https://blog.cloudflare.com/sqlite-in-durable-objects (surfaced by search, not re-read)

Third-party performance:

- Lumenize, "What I got wrong about Durable Object throughput" — https://lumenize.com/blog/what-i-got-wrong-about-do-throughput
- hyparquet — https://github.com/hyparam/hyparquet
- parquet-wasm — https://github.com/kylebarron/parquet-wasm (via search summary)
- R2 latency anecdotes — https://www.answeroverflow.com/m/1201522809512394824 ; https://dev.to/johalputt/benchmark-aws-s3-express-one-zone-vs-cloudflare-r2-for-high-throughput-object-storage-3k9d ; https://filebase.com/cloudflare-r2-alternative (competitor-published)

Competitor pricing (fetched 2026-11-18):

- Grafana Cloud — https://grafana.com/pricing/
- Datadog — https://www.datadoghq.com/pricing/list/
- Honeycomb — https://www.honeycomb.io/pricing
- Axiom — https://axiom.co/pricing
- ClickHouse Cloud — https://clickhouse.com/pricing ; managed observability https://clickhouse.com/pricing/observability.md
- AWS S3 — https://aws.amazon.com/s3/pricing/ (only the GET price rendered; other figures from training knowledge)
