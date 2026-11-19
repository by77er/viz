# 11 — Prior art and architectural lessons for viz

Research date: 2026-11-18. Author role: distributed-systems architecture research for the viz design.

## Research method and confidence

- Web access worked, but **the session's shared web-search budget ran out partway through**. Page fetches kept working, so the Cloudflare-specific material was read from primary sources. Several non-Cloudflare systems could not be re-checked in 2026 sources.
- Every claim is tagged:
  - **[V]** — verified this session against a primary source (vendor blog, docs, GitHub).
  - **[V2]** — seen this session only in a secondary source (InfoQ, aggregator, search-result summary). Check before relying on it.
  - **[TK]** — training knowledge (cutoff mid-2026), not re-verified this session.
- Not covered by any search this session, so entirely [TK]: Bufstream, AutoMQ internals, Confluent Freight, Redpanda Cloud Topics, Neon, Quickwit, LanceDB, Chroma distributed, Snowflake, MotherDuck/DuckLake, InfluxDB 3, GreptimeDB, Oxide, OTel entities, Cloudflare's ClickHouse/TimescaleDB posts.
- Not found at all: a public description of the Workers Logs / Workers Observability storage backend; any indie project that runs hyparquet/icebird/DuckDB-WASM *inside a Worker* against an Iceberg catalog.

---

## 1. What changed on Cloudflare in 2026 (read this first)

These four findings alter the viz design space more than anything else in this note.

### 1.1 The Cloudflare Data Platform is GA, renamed "Basin" [V]

- On **2026-10-01** Cloudflare announced general availability of Cloudflare Basin. Pipelines, R2 Data Catalog and R2 SQL became **Basin Pipelines, Basin Catalog, Basin SQL**. Existing resources keep working.
- **Basin Pipelines**: ingest over HTTP, Worker binding or Logpush; SQL transforms; sinks to Iceberg (Basin Catalog) or raw Parquet/JSON in R2. The blog states up to 3 GB/s per stream (the docs changelog says 1 GB/s, up from 5 MB/s; the two disagree). Docs claim "exactly-once delivery to R2". Roadmap, so absent today: custom partitioning, schema migrations, updatable configuration, Iceberg V3 / Variant, stateful processing (streaming aggregations, joins, materialized views).
- **Basin Catalog**: managed Iceberg REST catalog with automatic compaction, snapshot expiration, orphan-file cleanup and manifest consolidation. Roadmap: sort/cluster-aware compaction, finer-grained auth per namespace/table, jurisdictions.
- **Basin SQL**: no longer filter-only. It now has GROUP BY/HAVING, approximate aggregates, joins (inner/outer/semi/anti), subqueries, window functions, CTEs, set operations, 190+ functions, EXPLAIN. Joins and subqueries landed 2026-05-14.
- **Pricing** (from the Basin docs):

| Component | Included per month | Then |
|---|---|---|
| Pipelines stream ingress | unlimited | free |
| Pipelines SQL transforms | 50 GB | $0.04/GB |
| Pipelines sink delivery | 50 GB shared | $0.03/GB JSON, $0.06/GB Parquet or Iceberg |
| Catalog operations | 1M | $9 per million |
| Catalog compaction (opt-in) | 10 GB and 1M objects | $0.005/GB, $2 per million objects |
| SQL scan | 10 GB compressed | $0.0025/GB, 10 MB minimum per query |

  Pipelines is billed on uncompressed volume; SQL on compressed bytes read. Billing was switched on 2026-08-03.

### 1.2 A recurring, unexplained catalog-corruption bug [V]

GitHub issue `cloudflare/workers-sdk#12774`:

- A Pipeline-fed Iceberg table became unqueryable: every SELECT returned `50408: Corrupted Catalog`.
- The reporter's diagnosis: sink metadata commits silently stopped (last commit 2026-01-29) while the pipeline kept writing files; compaction then deleted manifest-lists that the last committed metadata still referenced.
- The pipeline's error metric showed nothing during the failure.
- The issue was closed 2026-03-10 with no root cause. Other users reported recurrences on 2026-07-24/26 (queries failing for 9+ hours) and 2026-09-15 (new tables failing after the first sink roll). The thread shows no fix and no reopening.
- The reporter's only recovery path was to create a new table and backfill from their own source database.

This is the single most important maturity signal for viz: the managed writer and the managed maintainer can disagree about table state, and the user cannot see it happening.

### 1.3 Cloudflare is building the same product [V]

"8 major updates to Cloudflare Observability" (2026-10-02):

- A unified Logs home that merges Workers Observability and Log Explorer.
- Cloudflare Traces (open beta) with OTel export and W3C context propagation.
- A unified SQL API (beta), with a Workers binding, a `cf` CLI and an Observability MCP server.
- Custom alerts (beta): threshold, anomaly and SLO conditions over SQL datasets.
- Custom dashboards.
- Volume-based pricing from **2026-12-01**: 50 GB ingest and 10 GB-month storage included on paid plans, then **$0.25/GB ingested and $0.10/GB-month stored**. Free plan: 0.5 GB/day, 7-day retention.

What it does not offer, per the post: no PromQL or TraceQL, metrics export only "coming soon", and nothing described about ingesting third-party OTLP as a general backend. That gap is viz's opening. The price points are the benchmark viz must beat or justify.

### 1.4 Log Explorer's architecture is public and is the closest precedent [V]

Log Explorer went GA 2026-03-11. From the GA post:

- Three roles: **ingestors** (write batches to R2 as Parquet), **compactors** (merge small files), **queriers** (SQL).
- Table format is **Delta Lake** (delta-rs), not Iceberg. Query engine is **Apache DataFusion**.
- Storage is isolated per customer.
- Small files are avoided at three levels: upstream buffering in an internal system (Buftee), squashing several staged commits into one transaction-log entry, then background compaction.
- **The compaction lesson**: stock size-based bin-packing scattered each time range across many merged files, so a time-bounded query still touched hundreds or thousands of files. Cloudflare replaced it with an algorithm that merges batches in order of minimum log timestamp. Overlap between merged files fell by about 100x, and some minute-long queries dropped to seconds.

Basin Catalog's own sort-aware compaction is still on the roadmap, so viz would not get this behaviour from managed compaction today.

---

## 2. Object-storage-native systems: the shared pattern

Almost every system below converges on the same four-part shape. That convergence is the main lesson.

1. **Stateless compute** that any node can run for any tenant.
2. **Immutable files** in object storage as the only durable data.
3. **One small, strongly consistent metadata store** that says which files are live. This is the only stateful piece, and the only thing that needs careful correctness work.
4. **Background compaction** that rewrites files and swaps metadata atomically.

The cost paid everywhere is write latency: durability waits for an object-store PUT, so writes are batched for 100 ms to several seconds.

### 2.1 Streaming / log systems

| System | Core idea | Lesson for viz | Status |
|---|---|---|---|
| **WarpStream** | Stateless Agents talk only to object storage and a Cloud Metadata Store. No local disk. Any Agent serves any partition. The metadata store is a replicated state machine that journals every operation. A Virtual Cluster is an isolated metadata namespace. | Tenancy is a metadata namespace, not a deployment. Data plane and control plane are separate, with few dependencies. | [V] docs |
| **Kafka KIP-1150** (diskless topics) | Brokers batch produce requests into shared objects; a coordinator assigns offsets. | The direction was accepted 2026-03-02 (9 binding votes). KIP-1163 (core) and KIP-1164 (coordinator) were not yet accepted and nothing has shipped. Even the incumbents now treat a sequencer plus object storage as the target design. Aiven's Inkless is a fork that implements it. | [V2] |
| **AutoMQ** | Kafka-compatible; WAL on a small block volume or object storage, data in S3. | A small low-latency WAL in front of object storage buys latency back. | [TK] |
| **Bufstream** | Kafka-compatible, object storage plus a metadata store; Jepsen-tested; writes Iceberg directly from topics. | The stream and the table can be the same files. Avoids a second copy. | [TK] |
| **Confluent Freight**, **Redpanda Cloud Topics** | Incumbents offering a cheaper, higher-latency, object-storage-backed tier. | Latency classes are a product decision; offer them explicitly. | [TK] |
| **S2** | Stream store on object storage. Listed as a SlateDB user. Runs deterministic simulation tests on every PR. | See section 6. | [V] |

### 2.2 Storage engines and databases

- **SlateDB** [V]: an embedded LSM key-value engine on object storage (Apache 2.0, about 3.6k stars). Single writer, many readers. The single writer is enforced by a manifest fencing protocol the project describes as formally verified. Compaction can run in a separate process. The site lists S3, **R2**, GCS as supported, and bindings for Go, Java, Node.js and Python. Listed users include Dropbox, Prisma, S2, Goldsky and Gadget.
  - **Has it been run inside Workers or Durable Objects? Not found.** No WASM target is mentioned, and the Node binding is a native (uniffi) package, which does not load in workerd. Treat "SlateDB in a Worker" as not available. It would be usable from Cloudflare Containers pointed at R2.
  - What viz should copy is the protocol, not the binary: manifest updated by compare-and-swap, writer epochs to fence zombies, a separate compactor epoch.
- **turbopuffer** [V]: object storage is the source of truth; NVMe and memory are caches; compute nodes hold no durable state.
  - Each namespace is a prefix holding its WAL, indexes and metadata.
  - A write is acknowledged only after it is in object storage. Concurrent writes are group-committed into one WAL entry; **one WAL entry per namespace per second**. p50 is 165 ms for a 500 kB write.
  - Committed-but-unindexed data is still queryable by scanning recent WAL entries. This closes the freshness gap without a separate hot store.
  - Strong consistency by default; eventual consistency is opt-in for lower latency.
  - Indexes are designed for few round trips: a cold query takes three or four, each about 100 ms.
  - A [V2] source says turbopuffer runs no consensus service and relies on object-store conditional writes.
- **Neon** [TK]: separates compute from a multi-tenant storage service; a Paxos-replicated WAL service (safekeepers) gives low-latency durability, and page servers materialise from WAL into object storage. Lesson: a tiny replicated WAL is what makes scale-to-zero compute safe. On Cloudflare, SQLite-backed Durable Objects are exactly this primitive.
- **Snowflake** [TK]: immutable micro-partitions, a metadata service on FoundationDB, pruning by per-partition min/max. The original "metadata is the database" design.
- **MotherDuck / DuckLake** [TK]: DuckLake puts all table metadata in a SQL database rather than in manifest files, so a commit is one transaction and no manifest-list reads are needed at plan time. Relevant because a per-tenant SQLite Durable Object could be a DuckLake-style catalog. The trade is giving up Iceberg-REST interoperability unless both are maintained.
- **LanceDB, Chroma distributed, Quickwit** [TK]: all use immutable segments on object storage plus a metastore. Quickwit's detail worth copying: the split's time range and tag set live in the metastore, so most pruning needs no object-store read.
- **Oxide** [TK]: not object-storage-native; relevant for engineering culture (written RFDs, a small set of explicit design values).

### 2.3 Observability backends

- **Datadog Husky** [V2]: event store over object storage. Fragment metadata lives in FoundationDB behind a metadata service. Compaction is atomic because one transaction makes the new fragments visible and the old ones invisible. Exactly-once ingestion is done by committing event IDs in the same transaction as the fragment metadata. FoundationDB's five-second transaction limit shapes the design.
- **Datadog Monocle** [V2]: a separate Rust real-time engine for metrics (sixth generation), LSM-like, storing `<series_id, timestamp, value>`. Datadog runs events and metrics on different engines.
- **Honeycomb Retriever** [V2]: recent data on local SSD fed from Kafka; older data in S3, queried by fanning out to AWS Lambda per segment (about 1 GB each), with results merged with the hot nodes. Reported limits: Lambda burst concurrency and response-size caps.
- **Axiom** [V]: regional edge proxies, a distributed WAL, then immutable columnar blocks in S3. Queries are compiled to a plan, blocks are pruned by statistics, **ephemeral serverless workers** read column data in parallel, and a coordinator merges results and spills large results to object storage behind signed URLs. Background compaction builds "superblocks". Axiom runs a separate **MetricsDB** format for metrics beside EventDB. The docs do not name Lambda.
- **InfluxDB 3** [TK]: rebuilt on Arrow, DataFusion and Parquet with an ingester, querier, compactor and catalog. Lesson: the querier must merge unpersisted ingester data with Parquet, or fresh data is invisible.
- **GreptimeDB** [TK]: unified metrics, logs and traces engine on object storage; metric engine maps many logical tables to few physical ones to survive high table counts.
- **ClickStack** [V]: see section 7.

### 2.4 What the survey says about the three hard parts

- **Freshness.** Every system needs an answer for "data written 2 seconds ago". The options are: query the WAL (turbopuffer), query the ingester (InfluxDB 3, Retriever), or accept minutes of lag (otlp2pipeline reports about 5 minutes).
- **Small files.** Every system batches before writing and compacts after. None relies on compaction alone.
- **Metadata scale.** The metadata store is where systems fall over, not the data files.

---

## 3. What Cloudflare itself has built, and how

### 3.1 Baselime on Cloudflare [V]

Baselime (acquired April 2024) moved from AWS to Cloudflare in under three months with three engineers:

- Receptors and the processor are Workers, connected by JS RPC; transformation runs in `ctx.waitUntil`.
- **Durable Objects**: one per error type for error tracking and notification state; also log-pattern detection; **alerting runs entirely in DO alarm handlers**, replacing EventBridge Scheduler, SQS, DynamoDB and several Lambdas.
- Telemetry went to **Workers Analytics Engine**, replacing a self-hosted ClickHouse on EC2. D1 holds configuration; KV holds fast lookups; Queues carried transactional events.
- Cost fell from about $708k/year to about $119k/year (83%). The Workers figure is the post's estimate, not a bill.
- Migration method: strangler-fig, outside-in, 30 days of dual-writing to both stores.

Lesson: "one DO per monitor, evaluated by its own alarm" is a proven design at a billion events a day. The storage choice (Analytics Engine) is sampled, so it is not a model for viz's primary store.

### 3.2 Workers Analytics Engine and ABR [V]

- Two sampling stages. At write time, data is sampled when too much is written to one index; "equitable sampling" aims for a similar number of stored events per index value. At query time, Adaptive Bit Rate reads from pre-built lower-resolution tables so every query stays inside a fixed scan budget.
- Each row carries `_sample_interval`; every aggregate must be weighted by it.
- Documented accuracy limits: individual records are not guaranteed retrievable, rare non-index values may vanish, cross-index queries may be inaccurate.
- The 2020 ABR post describes writing the same data at multiple resolutions into separate ClickHouse tables. [V2 — only the search summary was read.]

Lesson: bounded query cost through multi-resolution storage is a strong idea for dashboards. Silent sampling is unacceptable for logs, traces and alert evaluation. viz should adopt the mechanism as explicit rollup tables, and always report the resolution used.

### 3.3 Basin SQL (R2 SQL) internals [V]

- The planner walks Iceberg metadata top-down: manifest list (partition stats), then manifests (per-file column stats), then Parquet footers (row groups).
- Planning and execution are a **streaming pipeline**: work units are emitted as soon as they are found.
- Work is ordered to match `ORDER BY`, enabling provably correct **early termination** for `ORDER BY … LIMIT K`. At the time of the post this worked only for partition-key ordering.
- A coordinator distributes row-group batches to query workers, and ships the Parquet metadata with them so workers never re-read footers.
- Workers run **DataFusion**; results return as Arrow IPC over gRPC.
- The 2025 post says this runs on "Cloudflare's distributed network" without naming a runtime; the 2026 Basin post says tasks are distributed "across Workers".

Lesson: "latest N logs matching X" is the dominant observability query, and time-ordered files plus early termination make it cheap. This only works if files are time-clustered, which ties back to the Log Explorer compaction lesson.

### 3.4 Pipelines internals [V]

- A control plane does accounting, shard tracking and lifecycle. The data path is a scalable set of **Durable Object shards**.
- A Coordinator DO keyed by `pipeline_id` hands out an execution plan, which callers cache.
- Records are persisted immediately to the DO's embedded SQLite, then batched, compressed and written to R2.
- **Backpressure is explicit at every hop**; when unwritten bytes cross a threshold the pipeline returns HTTP 429.
- Files are named with ULIDs and Hive-partitioned by time.
- A config update creates a new deployment; the old one drains its DO storage first.
- Arroyo 0.15 added a two-phase commit for Iceberg sinks. [V2] How this composes with the DO buffer into end-to-end exactly-once was not found.

### 3.5 Queues: the canonical DO scaling story [V]

| | v1 (beta) | v2 (GA) |
|---|---|---|
| Design | one DO per queue | Storage Shard DOs in every region, Consumer Shard DOs, one Coordinator DO per queue |
| Throughput per queue | about 400 msg/s | about 5,000 msg/s |
| p50 send latency | about 200 ms | about 60 ms |
| Consumer concurrency | about 20 | about 250 |

- The Coordinator owns a **Shard Map** and publishes it to Workers KV. Broker Workers read the map from KV and pick a shard at random. The Coordinator is never on the hot path.
- Shards heartbeat their load to the Coordinator, which adds shards.
- v1 also pinned every DO to one region (near the config API), which caused the latency.

### 3.6 SQLite-backed Durable Objects, D1, Workflows [V]

- SQLite runs in the same thread as application code. Each object is single-threaded.
- **Output gates**: a response is held until its writes are durable. No client sees a false success.
- **Storage Relay Service**: each commit's log goes to five followers in different data centres and needs three acknowledgements. Logs are uploaded to object storage every 10 seconds or 16 MB. Thirty-day point-in-time recovery is on by default.
- D1 is built on this. So is Workflows: one Account Controller DO per account plus one Engine DO per workflow instance. The Workflows post says this confines bugs and inconsistent state to a single account, and allows gradual rollout.

### 3.7 Rules of Durable Objects (published 2025-12-15) [V]

The rules that bear directly on viz:

- Model a DO around the **atom of coordination**. A single global DO is the named anti-pattern, as is a global rate-limiter DO.
- **Throughput per DO**: about 1,000 req/s for pass-through, 500–750 with JSON parsing, **200–500 with storage writes**. The soft platform limit is 1,000 req/s per object. Shard count = total rate / per-DO rate.
- Use deterministic names (`getByName`) so routing needs no lookup.
- Use parent/child DOs for hierarchy; children stay hibernated when only the parent is needed.
- Persist to SQLite, never memory only. There are no shutdown hooks.
- Synchronous writes with no `await` between them commit atomically. Any non-storage I/O (`fetch`, R2, KV) lets other requests interleave, so use check-and-set.
- Never hold `blockConcurrencyWhile` across external I/O.
- **Alarms can fire more than once; handlers must be idempotent.**

### 3.8 Hard platform limits [V]

| Limit | Value |
|---|---|
| Worker / DO memory per isolate | 128 MB (heap plus WASM) |
| CPU per request | 30 s default, up to 5 min |
| Subrequests per request (paid) | 10,000 default, configurable higher |
| Simultaneous outgoing connections | 6 |
| SQLite storage per DO | 10 GB |
| DO request rate | 1,000 req/s soft limit |
| Row / value size | 8 MB |
| Columns per table | 100 |
| Alarm wall time | 15 min |
| DO classes per account | 500 |
| Worker bundle | 64 MiB uncompressed, 1 s startup |

The 128 MB ceiling and six concurrent connections are the binding constraints for any in-Worker query engine or Parquet writer.

### 3.9 Not found or not verified

- **Workers Logs backend**: no public architecture post found. The 2026 unified-observability post gives no storage detail.
- **Cloudflare's ClickHouse estate and TimescaleDB work** [TK]: Cloudflare has long run very large ClickHouse clusters for HTTP analytics, and published in 2025 on using TimescaleDB for some analytics workloads. Not re-read.

---

## 4. Indie and open-source projects on Cloudflare

The ecosystem is thin. No project was found that implements a full observability backend on Workers, DOs and R2.

| Project | What it does | What it shows | Tag |
|---|---|---|---|
| **smithclay/otlp2pipeline** | OTLP → Worker → Pipelines → R2 Data Catalog (Iceberg), with DOs for real-time RED metrics and a live `tail` over WebSocket. ClickHouse-inspired schema. Queried with DuckDB. | The exact path viz is considering works end to end. Data is queryable after about 5 minutes. Service registry capped at 10,000; payloads at 10 MB. 9 stars, 19 commits. As of June 2026 the README points to `duckdb-otlp` as the preferred way to write to Iceberg catalogs. | [V] |
| **fiberplane/otel-worker** | Rust OTLP/HTTP collector on Workers storing traces in **D1**, DOs for WebSockets. | Fine for dev tooling. Archived 2025-07-10. D1 as a trace store does not scale past a single database's limits. | [V2] |
| **evanderkoogh/otel-cf-workers** | Client-side OTel instrumentation for Workers. | An ingest source for viz, not a backend. | [V2] |
| **danthegoodman1/DurableStreams** | Each stream is a SQLite-backed DO, with data in R2. | Direct precedent for "DO as sequencer and WAL, R2 as bulk store". | [V2] |
| **bherbruck/silodb** | Hot writes in SQLite, closed time buckets tiered to immutable Parquet, one logical table. | The hot/cold split viz needs, on libSQL rather than DOs. | [V2] |
| DuckDB-WASM over R2 Parquet (A. Wheeler, 2025) | Browser-side DuckDB reading Parquet from R2. | Works from a browser. Not from inside a Worker. | [V2] |

What hit limits:

- **128 MB memory.** Community reports show Workers failing when a whole file is buffered; one write-up traces a crash on a 20 MB file to base64 plus double allocation. Parquet encode and decode must stream, row group by row group. [V2]
- **Freshness** of minutes when relying on Pipelines roll intervals.
- **Catalog corruption** (section 1.2).
- **D1 as an analytics store.**

No evidence either way was found for hyparquet or icebird running inside a Worker against Basin Catalog. This is an open question that needs a spike.

---

## 5. Durable Object patterns for viz

Drawn from sections 3.4–3.7.

1. **Coordinator plus shards plus cached map.** A per-tenant Coordinator DO owns the shard map and publishes it to KV. Stateless Workers route from the cached map. The Coordinator is consulted on change, never per request. Precedents: Queues v2, Pipelines.
2. **DO as sequencer and WAL.** An ingest-shard DO appends batches to SQLite (durable through the five-follower relay), acknowledges through the output gate, and flushes Parquet to R2 on a size or time trigger. Precedents: Pipelines, DurableStreams, turbopuffer's WAL, Neon's safekeepers.
3. **DO as commit point.** One DO per table (or per tenant) serialises Iceberg commits. Because a DO is single-threaded, optimistic-concurrency retries disappear inside it. Precedents: SlateDB's manifest CAS, Husky's single transaction. Caveat: the DO does I/O to R2 and the catalog during a commit, so requests can interleave; guard with an epoch and check-and-set.
4. **DO per monitor with alarms.** Precedent: Baselime. Handlers must be idempotent because alarms can repeat.
5. **Parent/child for hierarchy.** Account → tenant → table/shard, mirroring Workflows' Account Controller and Engine.
6. **Size shards from the published numbers.** Budget 200–500 writes/s per DO. At 10,000 ingest requests/s for one tenant, that is 20–50 shard DOs. Batch at the client and in the routing Worker so a request carries many records.
7. **Never a global DO.** No global tenant registry, global rate limiter or global sequencer.
8. **Regional placement.** Queues v1 pinned DOs to one region and paid 200 ms. Use location hints and regional shards.

---

## 6. General principles and their exemplars

- **Single writer.** A DO, SlateDB's fenced writer, turbopuffer's one WAL commit per namespace per second, TigerBeetle's single-threaded state machine [TK]. Removing concurrent writers removes most of the correctness surface.
- **Separate metadata from data.** WarpStream, Snowflake, Husky, Iceberg itself. The metadata is small and needs transactions; the data is huge and needs none.
- **Immutable files, atomic manifest swap.** Iceberg, Delta, Husky's compaction, SlateDB. Readers never see a partial state, and a crash leaves only orphans.
- **Idempotent everything.** Husky's event-ID dedup; DO alarms that may repeat; Workflows' idempotent steps. Name files deterministically from (shard, sequence range) so a retried flush overwrites rather than duplicates.
- **Deterministic simulation testing.**
  - WarpStream [V] ran its whole SaaS under Antithesis. A data race that tens of thousands of CI hours with the Go race detector had missed surfaced in 233 seconds. A flush-retry refactor that briefly marked failed flushes as successful (potential data loss) was triggered about once per hour. They credit the data/control-plane split and minimal dependencies for making simulation practical.
  - S2 [V] controls execution, entropy, time and I/O with Turmoil plus libc overrides, re-runs each seed and compares traces byte for byte, and found 17 notable bugs. Its emulators for metadata and object storage sit behind minimal interfaces.
  - FoundationDB and TigerBeetle [TK] are the origin of the practice.
  - turbopuffer: no DST claim could be verified.
  - Implication: viz's core (WAL, flush, commit, compaction) must be written against narrow interfaces for clock, randomness, object store and catalog, so it can run in a seeded simulator outside workerd.
- **Cell-based architecture and blast-radius control.** Workflows' per-account DO; Cloudflare's post-incident split of the Workers runtime into customer cohorts [V]; AWS cells and shuffle sharding [TK]. In viz, the tenant is the cell.
- **Static stability** [TK, AWS Builders' Library]: the data plane keeps working on last-known-good state when the control plane is down. Cloudflare adopted this explicitly as "fail stale" after 2025 [V]. Queues' KV-cached shard map is an instance.
- **Backpressure.** Pipelines returns 429 when its buffer crosses a threshold [V]. Unbounded buffering in a 128 MB isolate is a crash.
- **Easy to reason about.** The exemplars get there the same way: few moving parts (WarpStream: one binary, one metadata store, one bucket), one source of truth (turbopuffer: object storage; everything else is cache), and operations that are safe to repeat.

---

## 7. One unified events table, or per-signal tables?

### The argument for unified wide events [V2]

Charity Majors' "Observability 2.0": 1.0 has three pillars and many sources of truth; 2.0 has one source of truth — wide structured events — from which metrics and traces are derived. Cost is controlled by sampling events, not by dropping context. She argues you cannot have both multiple pillars and a single source of truth. Third-party commentary (for example a Grafana event talk) calls it a north star more than a blueprint.

### What production systems actually do

- **ClickStack** [V], the stack most associated with wide events, uses **separate tables per signal**: `otel_logs`, `otel_traces`, five `otel_metrics_*` tables split by metric type, and `hyperdx_sessions`. Attributes are `Map` columns; hot attributes are materialised into real columns; each table has its own sort key (logs by time bucket then service; traces by service and span name; metrics by service, metric name, hour, attribute hash).
- **Datadog** runs Husky for events and Monocle for metrics [V2].
- **Axiom** runs EventDB and a separate MetricsDB [V].
- **Honeycomb** is the one single-store exemplar, and it does not offer a PromQL-compatible metrics product [TK].

### OpenTelemetry status

- Traces, metrics and logs are stable.
- **Profiles are still alpha** [V2]: public alpha was announced in March 2026; collector support arrived behind a feature gate; no GA date is committed. ClickStack does not yet support profiles natively.
- **Entities** [TK]: an in-progress effort to give resources stable identity and relationships (service, host, pod). Not re-verified.

### Recommendation

Per-signal physical tables, one logical model.

- **Spans and logs** are both wide events. They can share column conventions, the same resource/attribute encoding and the same sort strategy, in two tables (`spans`, `logs`). Merging them into one table is possible later; splitting one table is hard.
- **Metrics need their own layout.** PromQL selects by series and scans by time; the right sort key is (metric, series hash, time), and the sample row is narrow. Storing samples as wide events makes PromQL range queries scan far more bytes. Every system above reached the same conclusion.
- **Unify at the edges, not in the file layout**: one resource/entity dimension shared by all signals, trace and span IDs on logs, exemplars on metrics, and derived metrics computed from spans at ingest or compaction.
- **Do not build profiles yet.** Keep the resource model generic enough to add a `profiles` table when the signal stabilises.

---

## 8. Risks of a Cloudflare-only bet

### 8.1 Incident history

| Date | What happened | Relevance | Tag |
|---|---|---|---|
| 2025-02-06 | An abuse-remediation action disabled the R2 Gateway. R2 failed 100% for 59 minutes. Log delivery to R2 lost up to 13.6% of data. Admin tooling to revert depended on R2. No stored data was lost. | R2 outage = viz ingest flush and all queries down. A circular dependency slowed recovery. | [V] |
| 2025-06-12 | KV's central store failed because of a third-party cloud provider. About 2.5 hours. KV 90% errors; Access logins 100% failed; **SQLite-backed DOs and D1 peaked at 22% errors**. | A KV failure degrades DOs. viz's hot path must not require KV reads from origin. | [V] |
| 2025-11-18 | A ClickHouse permissions change doubled the Bot Management feature file past a hard-coded limit; the proxy panicked. HTTP 5xx across the network from 11:20 UTC, fully restored 18:06 UTC. | Global, not regional. Triggered by a config push, not a code deploy. | [V2] |
| 2025-12-05 | A global configuration flag change made while mitigating a React vulnerability. | Second global config-push outage in three weeks. | [V] |
| 2026-01-08, 2026-02-20 | 1.1.1.1 CNAME ordering change; a bug withdrew 25% of BYOIP prefixes over BGP. | Listed by a secondary aggregator only. | [V2] |
| 2026-02-06 | Third-party blog describes cascading failures affecting R2 and Workers. | Not confirmed against a Cloudflare post. | [V2] |
| 2026-08-07 to 08-14 | Third-party blog counts 13 incidents touching R2, DOs, KV and Workers AI, starting with an R2 failure in eastern North America. | Not confirmed. | [V2] |
| 2026-10-24 | Status aggregators list two incidents affecting DOs, R2, Workflows and D1; no post-mortem published. | Not confirmed. | [V2] |

Cloudflare's response, "Code Orange: Fail Small" (plan 2025-12-19, declared complete 2026-05-01) [V]: progressive config rollout with automated rollback (Snapstone), fail-stale then fail-open defaults, break-glass access for 18 services, removal of non-essential runtime dependencies, and Workers runtime split into customer cohorts. The post says the safer rollout applies "in most cases" and that cohort segmentation is still being extended.

### 8.2 Structural risks

- **Correlated failure.** An observability tool is needed most when things break. If a customer runs on Cloudflare and viz runs on Cloudflare, they fail together.
- **Global blast radius.** The two largest 2025 incidents were global. Multi-region inside Cloudflare does not help against a global config push.
- **Managed-component maturity.** Basin is weeks past GA, has a recurring unexplained corruption bug, and lacks custom partitioning, schema migration and sort-aware compaction.
- **Platform competition.** Cloudflare sells an overlapping product and controls the pricing of every primitive viz uses.
- **Hard ceilings.** 128 MB memory, 10 GB per DO, about 1,000 req/s per DO.
- **Opaque internals.** Basin SQL's execution, limits and failure modes are not user-controllable.

### 8.3 Mitigations

1. **Open formats are the exit.** Parquet and Iceberg in R2 are readable by any engine, and R2 has no egress fee. Never store anything only in a proprietary form.
2. **Own the durable log.** Keep the acknowledged ingest record (DO WAL, then raw batch files in R2) until the Iceberg commit is verified, so any table can be rebuilt without the customer's help. This is the direct answer to section 1.2.
3. **Verify the catalog independently.** After each commit and on a schedule, check that the current snapshot's manifest list and manifests exist. Alert on commit lag. The bug in 1.2 was invisible in Cloudflare's own metrics.
4. **Put a seam around the catalog and the query engine.** Basin Catalog is one implementation of "Iceberg REST catalog"; Basin SQL is one implementation of "scan planner and executor".
5. **Static stability.** Ingest must keep accepting and buffering when R2, the catalog or KV is unavailable, within explicit bounds, and then shed load with 429.
6. **Out-of-band alert path.** Offer alert delivery and a heartbeat ("viz is down" detection) from outside Cloudflare, even if it is a very small component. Whether this violates the "purely Cloudflare" goal is a product decision; see open questions.
7. **Senders retry.** OTLP exporters and collectors buffer and retry; document the required settings so a 30-minute outage loses nothing.

---

## 9. Design implications for viz

### 9.1 Principles to adopt

| # | Principle | Precedent |
|---|---|---|
| 1 | **R2 is the only source of truth for data; everything else is a cache or a pointer.** | turbopuffer; WarpStream |
| 2 | **Exactly one small transactional metadata authority per tenant**, and it is the only component needing deep correctness work. | WarpStream metadata store; Husky on FoundationDB; Snowflake |
| 3 | **Single writer per commit point.** A DO serialises commits for a table; epochs fence stale writers. | SlateDB fencing; DO model |
| 4 | **Acknowledge only after durability.** Ingest returns success once the batch is in the DO WAL. | DO output gates; turbopuffer; Pipelines |
| 5 | **Batch before writing, compact after, and cluster by time in both.** | Log Explorer's 100x overlap reduction |
| 6 | **Coordinator off the hot path.** Shard map published to KV and cached; routing is stateless. | Queues v2; Pipelines |
| 7 | **Shard from day one, sized at 200–500 writes/s per DO.** | Queues v1's 400 msg/s ceiling; Rules of DOs |
| 8 | **The tenant is the cell.** Per-tenant DOs, prefixes, tables and limits; a bug stays inside one tenant. | Workflows Account Controller; WarpStream virtual clusters; Log Explorer per-customer storage |
| 9 | **Idempotent, deterministic operations.** Deterministic file names, dedup keys, repeatable alarms. | Husky event IDs; Workflows steps; DO alarm semantics |
| 10 | **Queryable freshness without a second database.** Queries merge committed Parquet with the unflushed WAL tail held in ingest DOs. | turbopuffer WAL scan; InfluxDB 3; Retriever |
| 11 | **Metadata-first query planning with early termination.** Prune by manifest, file and row-group stats; order work by time; stop at LIMIT. | Basin SQL; Quickwit |
| 12 | **Per-signal tables, shared resource model.** | ClickStack; Datadog; Axiom |
| 13 | **Explicit backpressure and bounded buffers at every hop.** | Pipelines 429s; 128 MB limit |
| 14 | **Static stability: fail stale.** Data plane runs on last-known-good config. | Queues shard map; Cloudflare Fail Small |
| 15 | **Design for simulation.** Core logic behind narrow clock/random/storage/catalog interfaces, run under a seeded simulator in CI. | WarpStream with Antithesis; S2; FoundationDB |
| 16 | **Explicit resolution, never silent sampling.** Rollup tables for long ranges, with the resolution reported in every result. | Analytics Engine ABR (mechanism), minus its silent sampling |
| 17 | **Monitors are DOs with alarms.** | Baselime |

### 9.2 Anti-patterns to avoid

| Anti-pattern | Precedent |
|---|---|
| A global or per-product singleton DO on the hot path | Rules of DOs; Queues v1 |
| One DO per tenant for all ingest, with no shard plan | Queues v1 capped at about 400 msg/s |
| Pinning DOs to one region | Queues v1's 200 ms p50 |
| Writing one small Parquet file per request | Log Explorer: "direct writes would fragment storage" |
| Size-only compaction for time-series data | Log Explorer |
| Two components that both mutate table state without a shared commit protocol | Basin issue #12774: sink and compactor disagreed |
| Trusting a managed service's own metrics as the only health signal | Same issue: error metric showed nothing |
| Buffering whole files or result sets in an isolate | Community 128 MB crash reports |
| In-memory state not yet in SQLite; relying on shutdown hooks | Rules of DOs |
| `blockConcurrencyWhile` across R2 or catalog I/O | Rules of DOs: caps throughput, holds the lock on slow calls |
| Silent sampling of logs, traces or alert inputs | Analytics Engine's documented accuracy limits |
| D1 or a single SQLite database as the telemetry store | fiberplane/otel-worker (archived); 10 GB DO limit |
| One physical wide-events table for metrics too | Nobody in production does it, including ClickStack |
| Recovery tooling that depends on the thing that is down | R2 incident 2025-02-06 |
| Global, instant config pushes | Cloudflare 2025-11-18 and 2025-12-05 |
| Hot path depending on KV origin reads | KV incident 2025-06-12 took DOs to 22% errors |
| Building on a signal spec that is still alpha | OTel profiles |

### 9.3 The central build-versus-buy decision

Basin now covers ingest, catalog, compaction and SQL. The question is which parts viz delegates.

| Component | Delegate to Basin | Build in viz | Recommendation |
|---|---|---|---|
| **Catalog** (Iceberg REST) | Managed; interoperable with DuckDB, Spark, Snowflake | A DO-based catalog | **Use Basin Catalog**, behind an interface, with independent verification. Interoperability is a product feature. |
| **Ingest writer** | Basin Pipelines: 1–3 GB/s per stream, exactly-once claim, $0.06/GB for Iceberg | DO WAL shards writing Parquet and committing to the catalog | **Build.** Pipelines lacks custom partitioning and sort control, gives minutes of freshness, has no queryable tail, costs per GB, and is the component implicated in the corruption bug. The DO WAL is also what gives viz its rebuild path. |
| **Compaction** | Basin Catalog compaction: $0.005/GB, not sort-aware | Own time-clustered compactor | **Build, or at minimum disable managed compaction on tables viz writes**, so there is one mutator per table. Revisit when sort-aware compaction ships. |
| **Query execution** | Basin SQL: DataFusion, $0.0025/GB scanned | PromQL and TraceQL engines in Workers | **Build the PromQL/TraceQL planners; evaluate Basin SQL as a scan backend.** Whether PromQL can be pushed down to Basin SQL efficiently is unknown and needs a spike. |

This recommendation rests on judgement about a fast-moving product. The corruption bug is the main evidence for owning the write path, and it is unresolved rather than proven systemic.

---

## 10. Open questions / unverified

1. **Is the Basin catalog-corruption bug fixed?** No root cause is public. Ask Cloudflare directly before relying on Pipelines plus managed compaction together.
2. **Can a third-party writer commit safely alongside Basin Catalog's managed compaction?** The conflict semantics are undocumented in what was read.
3. **Basin Catalog limits**: commit rate per table, number of tables and namespaces per catalog, metadata size. The limits pages were not read. These determine whether table-per-tenant is viable.
4. **Does R2 support the conditional writes** (If-Match / If-None-Match on PUT) needed for a self-built manifest CAS? Believed yes [TK]; confirm semantics under concurrency.
5. **Can hyparquet, icebird or a WASM DataFusion build run useful queries inside 128 MB?** No public evidence either way. Needs a spike with realistic row-group sizes.
6. **What runtime do Basin SQL workers use**, and can a Worker call Basin SQL through a binding at low latency? The unified SQL API binding (beta) suggests yes.
7. **Pipelines throughput**: the Basin blog says 3 GB/s per stream; the docs changelog says 1 GB/s. Unresolved.
8. **Workers Logs storage backend**: not public. If Cloudflare uses Basin for it, that is a strong maturity signal; the Basin post says only that billing and infrastructure telemetry teams use it.
9. **2026 incident details** (Feb 6, Aug 7–14, Oct 24) come from third-party aggregators. Check cloudflarestatus.com history.
10. **SlateDB in workerd**: no evidence it runs. A WASM build would need to be tested.
11. **All [TK] entries in section 2**, in particular the current state of Bufstream, AutoMQ, Confluent Freight, Redpanda Cloud Topics, DuckLake and GreptimeDB.
12. **OTel entities and profiles**: profiles alpha is from secondary sources; entities status was not checked.
13. **Product question**: does "purely Cloudflare" permit a minimal out-of-band alert path? Without one, viz cannot tell customers it is down during a global Cloudflare outage.
14. **DO free-plan storage**: the limits page says 10 GB per object in one table and 1 GB on Free in its FAQ.

---

## 11. Sources

### Cloudflare — data platform and observability
- Introducing Cloudflare Basin (2026-10-01): https://blog.cloudflare.com/cloudflare-basin/
- Basin docs (full text): https://developers.cloudflare.com/basin/llms-full.txt
- R2 SQL deep dive (2025-09-25): https://blog.cloudflare.com/r2-sql-deep-dive/
- Cloudflare Data Platform announcement (2025): https://blog.cloudflare.com/cloudflare-data-platform
- Arroyo acquisition and Pipelines architecture: https://blog.cloudflare.com/cloudflare-acquires-arroyo-pipelines-streaming-ingestion-beta/
- R2 SQL joins and subqueries changelog (2026-05-14): https://developers.cloudflare.com/changelog/post/2026-05-14-joins-subqueries-multi-table-queries/
- Catalog corruption issue: https://github.com/cloudflare/workers-sdk/issues/12774
- 8 major updates to Cloudflare Observability (2026-10-02): https://blog.cloudflare.com/one-observability-platform
- Log Explorer GA: https://blog.cloudflare.com/logexplorer-ga/
- Log Explorer (beta design): https://blog.cloudflare.com/log-explorer/
- Log Explorer changelog: https://developers.cloudflare.com/log-explorer/changelog
- Baselime migration: https://blog.cloudflare.com/80-percent-lower-cloud-cost-how-baselime-moved-from-aws-to-cloudflare/
- Baselime acquisition: https://blog.cloudflare.com/cloudflare-acquires-baselime-expands-observability-capabilities/
- Analytics Engine sampling: https://developers.cloudflare.com/analytics/analytics-engine/sampling/
- Explaining Cloudflare's ABR analytics (2020): https://blog.cloudflare.com/explaining-cloudflares-abr-analytics/

### Cloudflare — Durable Objects and platform
- Rules of Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Durable Objects limits: https://developers.cloudflare.com/durable-objects/platform/limits/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- How we built Cloudflare Queues (10x speedup): https://blog.cloudflare.com/how-we-built-cloudflare-queues
- Zero-latency SQLite storage in every Durable Object: https://blog.cloudflare.com/sqlite-in-durable-objects/
- Building Workflows: https://blog.cloudflare.com/building-workflows-durable-execution-on-workers/

### Cloudflare — incidents
- 2025-11-18 outage: https://blog.cloudflare.com/18-november-2025-outage/
- 2025-06-12 KV outage: https://blog.cloudflare.com/cloudflare-service-outage-june-12-2025/
- 2025-02-06 R2 incident: https://blog.cloudflare.com/cloudflare-incident-on-february-6-2025/
- Code Orange: Fail Small (plan): https://blog.cloudflare.com/fail-small-resilience-plan/
- Code Orange: Fail Small is complete (2026-05-01): https://blog.cloudflare.com/code-orange-fail-small-complete/
- Post-mortem tag: https://blog.cloudflare.com/tag/post-mortem
- Secondary, unconfirmed: https://blog.codercops.com/blog/cloudflare-august-2026-incidents-uptime-lessons , https://blog.codercops.com/blog/cloudflare-outage-feb-2026-postmortem-architecture-lessons

### Object-storage-native systems
- WarpStream architecture: https://docs.warpstream.com/warpstream/overview/architecture
- WarpStream DST with Antithesis: https://www.warpstream.com/blog/deterministic-simulation-testing-for-our-entire-saas
- KIP-1150 accepted (Aiven, 2026-03-12): https://aiven.io/blog/kip-1150-accepted-and-the-road-ahead
- Diskless Kafka status (Instaclustr): https://www.instaclustr.com/support/documentation/announcements/apache-kafka/kafka-diskless-proposals-status-insights/
- SlateDB: https://slatedb.io/
- SlateDB manifest RFC: https://rust-digger.code-maven.com/src/slatedb-0.3.0/rfcs/0001-manifest.md
- S2 deterministic simulation testing: https://s2.dev/blog/dst
- turbopuffer architecture: https://turbopuffer.com/docs/architecture
- turbopuffer guarantees: https://turbopuffer.com/docs/guarantees
- Axiom architecture: https://axiom.co/docs/platform-overview/architecture
- Datadog Husky: https://www.datadoghq.com/blog/engineering/introducing-husky/
- Husky compaction: https://www.datadoghq.com/blog/engineering/husky-storage-compaction/
- Husky ingestion (InfoQ): https://www.infoq.com/news/2023/06/datadog-husky-data-ingestion
- Datadog Monocle (InfoQ): https://infoq.com/news/2025/09/datadog-monocle-timeseries-db
- Datadog Rust timeseries engine: https://www.datadoghq.com/blog/engineering/rust-timeseries-engine/
- Honeycomb Retriever on Lambda (InfoQ): https://www.infoq.com/news/2022/10/honeycomb-serverless/

### Wide events and OpenTelemetry
- Charity Majors, one key difference between Observability 1.0 and 2.0: https://charity.wtf/2024/11/
- Honeycomb, Observability 2.0: https://www.honeycomb.io/blog/why-observability-2-0-gamechanger
- ClickStack schemas: https://clickhouse.com/docs/use-cases/observability/clickstack/ingesting-data/schemas
- OTel profiles public alpha (ClickHouse): https://clickhouse.com/resources/engineering/otel-news-profiles-signal
- OTel profiles alpha (Elastic): https://www.elastic.co/observability-labs/blog/otel-profiling-alpha

### Indie projects on Cloudflare
- otlp2pipeline: https://github.com/smithclay/otlp2pipeline
- fiberplane/otel-worker (archived): https://github.com/fiberplane/otel-worker
- otel-cf-workers: https://github.com/evanderkoogh/otel-cf-workers
- DurableStreams: https://github.com/danthegoodman1/DurableStreams
- silodb: https://github.com/bherbruck/silodb
- DuckDB-WASM over R2: https://andrewpwheeler.com/2025/06/29/using-duckdb-wasm-cloudflare-r2-to-host-and-query-big-data-for-almost-free/
- 128 MB crash analysis: https://dev.to/morphinewan/cloudflare-worker-memory-overflow-analysis-how-20mb-file-crashed-128mb-runtime-412p
