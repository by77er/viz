# 01 - Cloudflare storage and data services (research for viz)

Research date: 2026-11-18.

## Method and reliability notes (read first)

- **Web access partly worked.** `WebFetch` against `developers.cloudflare.com` (docs, per-product changelogs) and `blog.cloudflare.com` worked. `WebSearch` was unavailable for the whole session (shared search budget exhausted), so nothing here comes from search results, third-party blogs, community threads or GitHub issues.
- Pages were read through a summarising fetch tool, not as raw text. Numbers below were reported by that tool from the live page; they agree across pages where cross-checkable (e.g. pricing page vs. changelog), but **spot-check any number a design decision hinges on**.
- Tags used:
  - **[docs]** read from live Cloudflare docs/changelog/blog on 2026-11-18.
  - **[training]** from training knowledge (cutoff mid-2026), not verified today.
  - **[inference]** my own reasoning/arithmetic from the above.
- The docs themselves contain a few inconsistencies; these are called out inline rather than resolved silently.

## 0. Headline: the data platform was renamed "Basin" and went GA on 2026-10-01

[docs, changelog] On **2026-10-01** Cloudflare announced "Cloudflare Basin is now generally available" (formerly "Cloudflare Data Platform"):

| Old name | New name | Docs root |
|---|---|---|
| R2 Data Catalog | **Basin Catalog** | `/basin-catalog/` |
| R2 SQL | **Basin SQL** | `/basin-sql/` |
| Cloudflare Pipelines | **Basin Pipelines** | `/basin-pipelines/` |

Existing resources, APIs, wrangler commands and config keys (`r2-data-catalog` sink type, `pipelines` binding) keep working "and will be deprecated in the future". New CLI namespace: `npx wrangler basin {catalog|sql|pipelines} ...`. All three are **GA and billed** (billing enabled 2026-08-03 for non-enterprise accounts). The old names are used interchangeably below.

---

## 1. R2 (object storage)

**Status:** GA. S3-compatible API + Workers binding.

### Pricing [docs]

| | Standard | Infrequent Access |
|---|---|---|
| Storage | $0.015 / GB-month | $0.01 / GB-month |
| Class A ops (writes, lists) | $4.50 / million | $9.00 / million |
| Class B ops (reads, heads) | $0.36 / million | $0.90 / million |
| Retrieval | none | $0.01 / GB |
| Minimum storage duration | none | 30 days |
| Egress | free | free |

- Free tier (Standard only): 10 GB-month, 1M Class A, 10M Class B per month.
- Class A: ListObjects, PutObject, CopyObject, Create/CompleteMultipartUpload, UploadPart, UploadPartCopy, ListParts, lifecycle tier transitions, bucket config puts.
- Class B: HeadObject, GetObject (including ranged GET), bucket config gets.
- **Free:** DeleteObject, DeleteBucket, AbortMultipartUpload.
- Unauthorised requests are not billed. Buckets: first 100,000 included, then $0.10/bucket/month.

### Limits [docs]

| Limit | Value |
|---|---|
| Buckets per account | default 100,000 (unlimited at $0.10/month each beyond) |
| Object size | 5 TiB |
| Single-part upload | 5 GiB |
| Multipart | 10,000 parts, 4.995 TiB (page has a GiB/TiB typo in a footnote) |
| Key length | 1,024 bytes |
| Object metadata | 8,192 bytes |
| **Concurrent writes to the same key** | **1 per second** (429 above) |
| Bucket management ops | 50/s per bucket (not object reads/writes) |
| Cloudflare REST API (not S3 API) | 1,200 req / 5 min per account |
| Custom domains per bucket | 100 |
| Lifecycle rules per bucket | 1,000 |
| Event notification rules per bucket | 100 |
| `r2.dev` public URL | rate-limited ("hundreds of req/s"), dev only |
| Objects / bytes per bucket | unlimited |
| Workers binding `list()` | max 1,000 keys per call |
| Workers binding `delete()` | max 1,000 keys per call |

No published per-bucket object read/write rate limit other than the same-key write limit. [docs]

### Consistency [docs]

- **Strongly consistent** globally for read-after-write, overwrite, delete and list. Only exception: API token/IAM changes (up to ~1 min).
- Concurrent unconditional writes to a key: last writer to complete wins.
- **Conditional writes are atomic and serialised per key.** `PutObject` supports `If-Match`, `If-None-Match`, `If-Modified-Since`, `If-Unmodified-Since`; so does `CompleteMultipartUpload` (`If-None-Match: *` = create-if-absent). Conditions on `CreateMultipartUpload` are *not* re-evaluated at completion.
- Workers binding: `put(key, value, { onlyIf: { etagMatches | etagDoesNotMatch | uploadedBefore | uploadedAfter } })` returns `null` when the precondition fails.
- Documented subtlety: a 404 read does not prove an in-flight `PutObject` will not land later; use `If-None-Match: *` rather than read-then-write.
- Cache in front of a public bucket/custom domain relaxes all of this (stale objects, cached 404s). Worker binding and S3 API bypass cache.

**This makes R2 a legitimate compare-and-swap primitive** (ETag CAS on a small pointer object), bounded by the 1 write/s/key limit.

### Features [docs]

- **Range reads:** S3 `Range` and `PartNumber` on GetObject; binding `get(key, { range: { offset, length } | { suffix } })`. Each ranged GET is one Class B op.
- **Multipart:** from Workers via `createMultipartUpload` / `resumeMultipartUpload`; parts must be uniform size except the last; incomplete uploads auto-aborted after 7 days. A `ReadableStream` passed to `put()` must have known length.
- **Checksums:** MD5 default for non-multipart; SHA-1/256/384/512 via binding; CRC32/CRC32C/CRC64NVME via S3 API.
- **Event notifications:** `object-create` (Put, Copy, CompleteMultipartUpload) and `object-delete` (Delete, LifecycleDeletion) to a **Queue**; prefix/suffix filters; 100 rules/bucket; bounded by the queue's 5,000 msg/s. Delivery guarantee not stated on the page (Queues itself is at-least-once).
- **Lifecycle rules:** expire after N days or on a date, transition Standard -> IA, abort incomplete multipart; prefix filter; 1,000 rules/bucket; whole-day granularity; objects "typically removed within 24 hours" of expiry. Lifecycle deletes are free; each IA transition costs a Class A op.
- **Storage classes:** Standard, Infrequent Access (settable per object on write, `storageClass`).
- **Location hints** (best effort): wnam, enam, weur, eeur, apac, oc. **Jurisdictions** (hard guarantee, fixed at creation): `eu`, `fedramp`, and **`us` (new 2026-08-17)**. Jurisdictional buckets need a `jurisdiction` field on the binding or a jurisdiction-specific S3 endpoint.
- **Local Uploads** (open beta 2026-02-03): writes land near the client and replicate asynchronously while staying strongly consistent; no extra cost; not available for jurisdictional buckets. Recommended in the catalog docs for lower-latency writes.
- **Data Access Logs** GA 2026-09-04 (best-effort audit of object ops, into Workers Observability).
- **Not implemented:** object versioning, object lock, object tagging, SSE-KMS (SSE-C is supported). No versioning means no "undelete"; accidental deletes are permanent.

### Fit for viz

Excellent as the long-term store and as the only storage whose idle cost is purely per-GB. Zero egress makes "bring your own engine" (DuckDB, Spark, Trino) viable for tenants. The main cost lever is **Class A ops**, i.e. the number of files written, not bytes.

---

## 2. Basin Catalog (R2 Data Catalog) - managed Iceberg REST catalog

**Status:** GA (2026-10-01). Open beta since 2025-04-10. [docs]

### What it is [docs]

A managed Apache Iceberg **REST catalog** enabled per R2 bucket (`npx wrangler basin catalog enable <bucket>` returns a catalog URI and warehouse name). One bucket = one warehouse. Standard Iceberg REST interface; documented engines: PyIceberg, Spark (Scala/PySpark), Snowflake, DuckDB (>= 1.4.0, read and write), Trino, StarRocks. Terraform resource `cloudflare_r2_data_catalog` (provider v5.19.0+).

### Auth [docs]

- Cloudflare API token (bearer) carrying **both** catalog and R2 storage permissions.
- Read-only tokens supported since 2026-07-13 ("Workers R2 Data Catalog Read" + "Workers R2 Storage Bucket Item Read"); commits need the Write equivalents ("Admin Read & Write").
- **Vended credentials:** the catalog returns SigV4 credentials that inherit the token's R2 storage permissions.
- Tokens are account/bucket scoped. **There is no per-namespace or per-table authorization documented**, so tenant isolation cannot be delegated to the catalog; viz must never hand catalog tokens to tenants unless a tenant has its own bucket.

### Table maintenance [docs]

- **Compaction** (since 2025-09-25; per-table since 2025-10-06): opt-in per catalog or per table; target file size **64-512 MB** (default 128). Parquet only. Output files get a `compacted-` prefix. Since 2026-07-13 compaction also **rewrites/clusters manifests** by partition as a best-effort pre-step. The launch blog said "only small-file compaction"; whether it applies merge-on-read delete files or sorts data is not documented.
- **Snapshot expiration** (since 2025-12-18): `--older-than-days` (default 30) and `--retain-last` (default 5); a snapshot expires only when both conditions hold. Since **2026-04-22 it also deletes data files no longer referenced** by retained snapshots. It is free.
- **Orphan files** (never referenced by any snapshot, e.g. from failed commits) are **not** cleaned up by the service.
- Manual "Queue maintenance" per table (2026-09-16) with a daily accepted-request limit (value undocumented; error `42901`) and an executor-conflict error (`40903`). The automatic schedule/frequency is not documented.
- Deletes must go through the catalog; deleting files directly in the bucket can corrupt tables (dashboard and wrangler now warn). `DROP TABLE` keeps data files; `PURGE` removes them.
- Metrics via GraphQL Analytics API: `r2CatalogDataOperationsAdaptiveGroups` (operations such as `load-table`, `list-namespaces`, `commit-table`, with status and duration) and `r2CatalogTableMaintenanceAdaptiveGroups`.

### Pricing [docs] (billing live since 2026-08-03)

| Dimension | Included / month | Then |
|---|---|---|
| Catalog operations (every Iceberg REST request) | 1 million | **$9.00 / million** |
| Compaction data processed | 10 GB | $0.005 / GB |
| Compaction objects processed | 1 million | $2.00 / million |

Plus normal R2 storage and ops. Cloudflare's own example: 20 MB/s streaming ingest = ~$759 storage + ~$253 compaction per month, with catalog ops (347k) inside the free allowance.

### Limits [docs: none published]

No published limits for number of namespaces, tables, snapshots, commit rate, or request rate. The only hard restriction stated: **"Basin Catalog does not currently support R2 buckets in a non-default jurisdiction"** (so no `eu`/`us`/`fedramp` buckets), and the Pipelines Iceberg sink has the same restriction.

### Not verified today

- **Iceberg spec version.** No docs page or changelog entry states it. [training] At beta it supported Iceberg v1 and v2 tables; v3 (deletion vectors, variant, row lineage) was not supported. Treat v3 as unavailable until proven.
- Catalog URI shape. [training] `https://catalog.cloudflarestorage.com/{account_id}/{bucket}`, warehouse `{account_id}_{bucket}`.
- Views, multi-table transactions, server-side scan planning, catalog-level rate limiting: not mentioned anywhere I could read.

### Fit for viz

Good fit for the **long-term, compacted, queryable tier** and for giving tenants/BI tools open access. Poor fit as the *only* store, because commit cadence is minutes not seconds, and because every commit and every table load is a billed operation.

---

## 3. Basin SQL (R2 SQL) - serverless distributed query engine

**Status:** GA (2026-10-01); open beta 2025-09-25; billing since 2026-08-03. [docs]

### Architecture [docs, blog "R2 SQL deep dive"]

- Coordinator plans by walking Iceberg metadata top-down (manifest list partition ranges -> manifest column stats -> Parquet footer row-group stats). Planning is **streamed**: work units are dispatched while planning continues.
- Execution fans out to query workers across Cloudflare's network; each worker runs **Apache DataFusion**, one partition per row group, column-pruned **R2 ranged reads**, filter pushdown; results return as Arrow IPC over gRPC.
- Top-K early termination for `ORDER BY <partition column> ... LIMIT n`.

### SQL surface [docs]

Read-only. Supported as of November 2026: `SELECT`, `WHERE`, `GROUP BY`, `HAVING`, `QUALIFY`, `ORDER BY`, `LIMIT`, `OFFSET` (2026-10-21); joins (INNER/LEFT/RIGHT/FULL/CROSS, since 2026-05-15); subqueries, CTEs; window functions with inline `OVER` (2026-06-22); `UNION/INTERSECT/EXCEPT`; `GROUPING SETS/ROLLUP/CUBE`; 190+ functions including JSON functions, struct/array/map access; approximate aggregates (`approx_distinct`, `approx_percentile_cont`, `approx_median`, `approx_top_k`); `EXPLAIN [FORMAT JSON]`, `SHOW`, `DESCRIBE`.

Not supported: any DDL/DML, `UNNEST`, `PIVOT`, `LATERAL`, named `WINDOW`, nested joins, `PERCENTILE_DISC`, time travel / snapshot selection (not documented), non-Parquet files.

### Limits [docs]

- **`LIMIT` must be 1-10,000; default 500.** There is no documented way to stream a larger result set (OFFSET paging re-runs the query).
- Budget-gated functions (exact median/percentile, `ARRAY_AGG`, `STRING_AGG`, DISTINCT aggregates, window functions) are memory-estimated up front and rejected with HTTP 400 if over budget. Budget value undocumented.
- Heavy queries "may time out" / return 502. **No timeout, concurrency, result-size or rate limits are published.**
- `now()` is quantised to 10 ms and forced to UTC.
- Unpartitioned tables supported, but partitioning recommended beyond ~1,000 files.

### Access [docs]

- Wrangler: `npx wrangler basin sql query <warehouse> "<sql>"`.
- **HTTP API:** `POST https://api.sql.cloudflarestorage.com/api/v1/accounts/{ACCOUNT_ID}/basin-sql/query/{BUCKET_NAME}` with `Authorization: Bearer <token>` and body `{"query": "..."}`. Token needs catalog read, R2 storage and Basin SQL read. Response schema is not documented.
- **No Workers binding exists** (the wrangler configuration page lists none for Basin SQL or Basin Catalog). A Worker can still call the HTTP API with `fetch()` and a stored secret; it is an ordinary subrequest. [inference]

### Pricing [docs]

- **$0.0025 / GB ($2.50 / TB) of compressed data scanned**; 10 GB/month included.
- **10 MB minimum billed per query.** Failed queries and `EXPLAIN/SHOW/DESCRIBE` are free.
- Catalog and R2 request charges apply on top.

### Fit for viz

Useful as an ad-hoc / long-range analytics path (logs search over cold data, trace search, tenant "SQL explorer"). **Not suitable as the primary PromQL/TraceQL execution path:**

1. 10,000-row result cap. PromQL range queries commonly need millions of raw samples.
2. 10 MB minimum per query. [inference] One always-open dashboard with 20 panels refreshing every 30 s = 1.73M queries/month = 17,280 GB billed minimum = **~$43/month per open dashboard** before any real scanning.
3. No published latency or concurrency numbers; "may time out".
4. PromQL semantics (lookback delta, `rate` with counter resets, staleness) do not map cleanly onto SQL; they would need window functions, which are budget-gated.
5. No tenant isolation: a token grants the whole warehouse, so tenant filters must be injected by viz and raw SQL can never be exposed to tenants against a shared bucket.

---

## 4. Basin Pipelines (Cloudflare Pipelines)

**Status:** GA (2026-10-01). Requires Workers Paid. Rebuilt on Arroyo in September 2025. [docs]

### Model [docs]

- **Stream**: durable buffered queue. Ingest via Worker binding (`env.STREAM.send([...])`; the promise resolves "when records are confirmed as ingested"), an optional HTTP endpoint `https://{stream-id}.ingest.cloudflare.com` (JSON array body, optional bearer token with "Pipelines Send" permission, CORS settings), or Logpush (since 2026-04-20).
- **Pipeline**: SQL of the form `INSERT INTO <sink> SELECT ... FROM <stream> [WHERE ...]`; several INSERT statements in one pipeline can fan one stream out to multiple sinks. **Stateless only** (filter, reshape, cast, compute, JSON/regex/hash functions). Aggregations, joins and windows are "future" and may be priced separately.
- **Sink**: R2 files (NDJSON or Parquet) or Basin Catalog (Iceberg, Parquet only).

### Guarantees and behaviours [docs]

- "Sinks provide **exactly-once** delivery guarantees, ensuring events are never duplicated or dropped." Mechanism is undocumented. This covers stream -> sink; **a client retrying `send()` after a timeout can still create duplicates** unless viz dedups. [inference]
- **Schema-invalid events are accepted, then silently dropped** during processing (visible only through dropped-event metrics / `pipelinesUserErrorsAdaptiveGroups`). Validate before sending.
- Structured streams have a fixed schema (string, int32/64, float32/64, bool, timestamp, json, binary, list, struct); unstructured streams put everything in a single `value` column.
- **Immutability:** stream schemas, pipeline SQL and sinks cannot be modified after creation; change = delete and recreate.
- **A Basin Catalog sink cannot target an existing Iceberg table**; it creates namespace and table itself.

### Roll (commit) cadence [docs]

| Sink | Roll interval default | Minimum |
|---|---|---|
| Basin Catalog (Iceberg) | 300 s | **60 s** ("to prevent compaction issues") |
| R2 files (Parquet/JSON) | 300 s | 10 s |

Also `--roll-size` (MB) and `--target-row-group-size`; compression zstd (default), snappy, gzip, lz4. R2 file sink partitioning is **time-based only** (strftime pattern, default `year=%Y/month=%m/day=%d`), files are UUID-named. Custom partitioning for the Iceberg sink is not documented. Inconsistency: the Basin SQL get-started tutorial reportedly uses a 10 s roll interval on an Iceberg sink.

### Limits [docs]

| Limit | Value |
|---|---|
| Streams per account | **20** |
| Sinks per account | **20** |
| Pipelines per account | **20** |
| Payload per ingest request | 5 MB |
| Ingest rate per stream | **1 GB/s** (raised from 5 MB/s on 2026-10-01) |

Stream retention/backlog duration is not documented.

### Pricing [docs] (billing since 2026-08-03)

| Dimension | Included (Workers Paid) | Then |
|---|---|---|
| Stream ingress | unlimited | free |
| SQL transforms | 50 GB / month | $0.04 / GB |
| Sink to R2 JSON | 50 GB / month | $0.03 / GB |
| Sink to R2 Parquet / Iceberg | 50 GB / month | $0.06 / GB |

Sink volume is measured **uncompressed**. So a transform + Iceberg sink path costs about **$0.10 per uncompressed GB** ($100/TB), plus catalog ops, compaction and R2. No idle charge.

### Fit for viz

A very attractive "no code" durable ingest buffer plus Iceberg writer with exactly-once delivery and zero idle cost. Constraints that shape the design: 20 streams/sinks account-wide means **shared multi-tenant tables with a `tenant_id` column**, never per-tenant streams; schemas are rigid and immutable (labels/attributes must be a `json` column, a list of structs, or pre-declared columns); 1-5 minute freshness; no control over sort order or partition spec; silent drops.

---

## 5. Queues

**Status:** GA. [docs]

| Limit | Value |
|---|---|
| Message size | 128 KB |
| `sendBatch` | 100 messages or 256 KB |
| Consumer batch | up to 100 messages, max wait 60 s |
| Throughput | 5,000 msg/s per queue |
| Backlog | 25 GB per queue |
| Retention | 4 days default, up to 14 (24 h on Free) |
| Concurrent consumer invocations | 250 |
| Consumer wall time / CPU | 15 min / 30 s default, up to 5 min |
| Retries | up to 100; `delaySeconds` up to 24 h |
| Queues per account | 10,000 included, then $0.10 each |

- Pricing: **$0.40 per million operations**, 1M/month included; an operation is one 64 KB chunk written, read or deleted, so a delivered message is typically 3 ops (**~$1.20 per million messages**, double for messages over 64 KB). Free plan: 10,000 ops/day.
- **At-least-once** delivery, no ordering guarantee stated. Pull consumers over HTTP are available.

**Fit:** fine for control-plane events (R2 event notifications -> "new file" handlers, compaction jobs, alert notifications, retention sweeps). Poor as the telemetry write-ahead buffer: 128 KB messages, 5,000 msg/s per queue and 256 KB per `sendBatch` cap throughput at roughly 100-600 MB/s in theory but far less in practice, and the per-message cost is much higher than Pipelines' free ingress.

---

## 6. Durable Objects

**Status:** GA; SQLite-backed storage is the default and the only backend for new namespaces on Free. [docs]

### Limits [docs]

| Limit | Value |
|---|---|
| Storage per SQLite DO | **10 GB** (page table; an FAQ line says 1 GB on Free) |
| Storage per account | unlimited (Paid), 5 GB (Free) |
| Row / BLOB / string | 8 MB (2 MB in D1) |
| SQL statement | 100 KB; 100 bound params; 100 columns |
| Throughput per object | soft limit ~1,000 req/s, single-threaded |
| CPU per request | 30 s default, up to 5 min |
| Memory | 128 MB per isolate |
| Alarm handler wall time | 15 min |
| Classes per account | 500 (Paid), 100 (Free) |
| Objects | unlimited |
| KV-style API | 128 keys per multi-key call |

SQLite extensions: **FTS5**, JSON, math functions.

### Pricing [docs]

- Requests: 1M/month included, then **$0.15 / million** (WebSocket messages billed 20:1; an RPC session is one request).
- Duration: 400,000 GB-s included, then **$12.50 / million GB-s**, charged at 128 MB while the object is active. A hibernatable idle object is not billed. One DO awake 24x7 = ~331,776 GB-s/month, i.e. about one always-on DO fits in the allowance, and each additional one costs ~$4.15/month. [inference]
- SQLite storage: rows read 25B/month included then $0.001/M; **rows written 50M/month included then $1.00/M** (index updates count as extra rows written; `setAlarm()` = 1 row written); stored data 5 GB included then **$0.20 / GB-month**.
- The pricing page still words SQLite storage billing as starting "January 2026"; assume it is live.

### Semantics [docs]

- Single-threaded, strongly consistent, transactional storage co-located with compute; input/output gates; write coalescing; `transactionSync()`.
- **Alarms:** one per object, at-least-once, automatic retry with exponential backoff (from 2 s, up to 6 retries).
- **PITR:** `getCurrentBookmark()`, `getBookmarkForTime()`, `onNextSessionRestoreBookmark()`; restore to any point in the **last 30 days**.
- **WebSocket hibernation** removes duration charges for idle connections.
- **Placement:** created near the first caller; does not move afterwards. Location hints (wnam, enam, sam, weur, eeur, apac, apac-ne, apac-se, oc, afr, me) and jurisdictions (`eu`, `us`, `fedramp`).

### Fit for viz

The natural **coordination and hot-tier primitive**: per-tenant (or per-tenant-shard) single writer that buffers recent samples in memory, persists a compact WAL, flushes Parquet to R2, serialises Iceberg commits, and schedules itself with alarms. Scales to zero. The traps are cost shape: $1 per million rows written and $0.20/GB-month (13x R2) mean **store batches as BLOB rows (up to 8 MB), never one row per sample**, and keep only minutes-to-hours of data there.

---

## 7. D1

**Status:** GA. Read replication: status not stated on the docs page (launched as public beta in 2025). [docs]

- Limits: **10 GB per database**; 1,000,000 databases per account (100,000 included, then $0.10 each); 1 TB per account (raisable); 2 MB max row/BLOB; 30 s max query; 50 MB max result (enforced from 2026-11-04); 1,000 queries per Worker invocation; 100 KB statement; 100 bound params. Single-threaded per database (~1,000 qps at 1 ms queries).
- Time Travel (PITR): 30 days (7 on Free).
- Pricing: rows read 25B/month included then $0.001/M; rows written 50M included then $1.00/M; storage 5 GB included then **$0.75/GB-month**. No compute charge when idle; no charge for replicas.
- Read replication: asynchronous replicas in all six regions; Sessions API (`withSession()`, bookmarks) gives sequential consistency; Worker binding only.

**Fit:** control-plane relational data that must be queried across tenants (tenant registry, API-key hashes, dashboards, alert rule definitions, billing/usage). Not for telemetry. D1 is itself a DO, so a per-tenant SQLite DO is equivalent for tenant-local state; D1 wins when a global view or the HTTP API is needed.

---

## 8. Workers KV

**Status:** GA. [docs]

- **Eventually consistent**: writes visible elsewhere after ~60 s or more; negative lookups are cached too; minimum `cacheTtl` 30 s (default 60 s). 1 write/s per key. Value 25 MiB, key 512 bytes, metadata 1,024 bytes; 1,000 operations per Worker invocation.
- Pricing: reads 10M/month included then $0.50/M; **writes, deletes and lists 1M included then $5.00/M**; storage 1 GB then $0.50/GB-month.
- A "KV Instant" variant is in private beta (1 MB per namespace, 10,000 keys, 1 write/s per namespace) - not usable yet.

**Fit:** read-mostly, staleness-tolerant edge lookups: API-key -> tenant mapping and tenant limits on the ingest hot path (with a revocation delay of about a minute to design around). Not for anything needing read-your-writes.

---

## 9. Workers Analytics Engine (WAE)

**Status:** GA; **still not billed** ("Currently, you will not be billed"). Published future prices: 10M data points/month included then $0.25/M written; 1M queries included then $1.00/M. [docs]

- Per data point: 1 index (96 bytes), 20 blobs (16 KB total), 20 doubles. **250 data points per Worker invocation.** **Retention fixed at 3 months.**
- **Sampled:** equitable sampling at write time per index value, adaptive resolution at read time; every query must weight by `_sample_interval`. Individual events and exact sequences cannot be recovered reliably.
- Query: SQL API over HTTP (`/accounts/{id}/analytics_engine/sql`), plus the new **Analytics SQL Workers binding** (`analytics` config key, Wrangler >= 4.145.0, `env.ANALYTICS_SQL.query({query, params})`) which can read WAE datasets as `events.analyticsEngine."<dataset>"` with no API token. That binding does **not** cover Basin/Iceberg tables.

**Fit:** not a tenant data store (sampling, 20-column shape, fixed retention, no deletes, no configurable retention). Good for **viz's own platform metering**: per-tenant ingest volume, query counts, billing estimates, self-observability - effectively free today.

---

## 10. Hyperdrive

**Status:** GA. Connection pooler + query cache between Workers and an external PostgreSQL/MySQL. Limits: 25 configs (Paid), ~100 origin connections per config, 60 s max query, 50 MB max cached response. [docs]

**Fit: none.** It requires an origin database outside Cloudflare, which violates "purely Cloudflare" and "very low idle cost".

---

## 11. Vectorize

**Status:** GA. Limits: 20,000,000 vectors per index, 1,536 dimensions, 50,000 namespaces per index, 10 metadata indexes, topK 100 (50 with values/metadata), 50,000 indexes per account. Pricing: $0.01 per million queried dimensions (50M included), $0.05 per 100M stored dimensions (10M included). [docs]

**Fit: none for the core.** Optional later feature (semantic log search, similar-trace lookup). Label/attribute indexes should be inverted or bloom/min-max indexes stored as R2 objects.

---

## 12. Workers Cache API, Tiered Cache, Cache Reserve

[docs]

- **Cache API** (`caches.default`, `caches.open()`): **per data center, not replicated**, incompatible with Tiered Cache, `cache.delete()` only purges locally. GET only; no 206 responses; no `stale-while-revalidate`; eviction at any time. Needs a custom domain to function (no-op in the dashboard editor). Max object 512 MB (5 GB Enterprise). No per-operation charge is listed. [training: free]
- **Tiered Cache / Smart Tiered Cache:** applies to `fetch()` subrequests through the CDN, not to `cache.put`. [training: Smart Tiered Cache is free on all plans.]
- **Cache Reserve:** R2-backed persistent cache tier; R2-equivalent prices ($0.015/GB-month, $4.50/M writes, $0.36/M reads); requires TTL >= 10 hours and `Content-Length`; R2 public buckets linked to a zone bypass it. Not useful here.

**Fit:** the Cache API is an opportunistic, zero-idle-cost cache for **immutable** things: Parquet footers and index blocks keyed by object key + ETag, and query results for fully-closed time ranges keyed by (tenant, query hash, aligned step window). It must only ever be an optimisation; the tenant id has to be part of every cache key.

---

## 13. Workers runtime limits that bound all of the above [docs]

128 MB memory per isolate; CPU 30 s default / 5 min max per request (Paid); 10,000 subrequests per request by default (configurable up to 10M); 6 simultaneous open connections; request body 100 MB (Free/Pro zone), 200 MB (Business); 250 Cron Triggers per account; 15 min wall time for cron, queue consumers and alarms; 500 Workers per account.

Implication: Parquet encoding/decoding in a Worker or DO must be streaming and row-group sized well under 128 MB; query fan-out is limited by 6 concurrent connections per isolate, so scale out across isolates/DOs, not within one.

---

## 14. Recommendation matrix

| viz need | Primary choice | Why | Alternatives / when | Risks and gotchas |
|---|---|---|---|---|
| **Write-ahead buffer (durable ingest)** | **Option A: Basin Pipelines stream** (shared, per signal). **Option B: per-tenant-shard Durable Object** WAL (batched BLOB rows) flushing to R2. | A: free ingress, 1 GB/s per stream, exactly-once to R2, zero code, zero idle. B: full control of schema/sort/partitioning and second-level freshness. | Queues only for control-plane events. | A: 20 streams account-wide; immutable schema; silent drops; 60-300 s rolls; ~$0.10/GB uncompressed; no ack that data reached R2. B: $1/M rows written, 10 GB per DO, ~1,000 req/s per DO so shard hot tenants; you own exactly-once. |
| **Hot recent-data tier (seconds-fresh, alerting)** | **Durable Objects** (in-memory head block + SQLite WAL), per tenant shard | Only strongly-consistent stateful compute; alarms drive rule evaluation; hibernates to zero. | Small un-catalogued Parquet "L0" files in R2, listed via a manifest object, for minutes-old data. | 128 MB memory; DOs never relocate; always-awake DOs cost ~$4/month each; per-sample rows are ruinous. Pipelines/Iceberg alone cannot meet sub-minute alerting. |
| **Catalog / table metadata** | **Basin Catalog** for the compacted long-term tables; **DO or R2-CAS manifest** for the hot/L0 file set | Managed compaction, manifest rewrite, snapshot expiry, open ecosystem access. | Self-managed Iceberg metadata on R2 with ETag CAS (no $9/M ops, works in EU/US jurisdictions) at the price of writing your own maintenance. | $9/M catalog ops (every load-table counts); no jurisdiction support; no published limits; no per-table auth; spec version unverified; orphan files not cleaned. |
| **Tenant config and control plane** | **D1** (global registry, keys, dashboards, alert rules) + **KV** as edge read cache for auth | Relational, PITR 30 days, scale-to-zero; KV gives fast auth lookups. | Per-tenant SQLite DO for tenant-local state. | KV staleness ~60 s for key revocation; D1 10 GB per DB and single-threaded - keep telemetry-derived data out. |
| **Query-result cache** | **Workers Cache API** for immutable/closed windows; in-DO memory for the live window | Free, no idle cost. | R2 objects for expensive long-range results (lifecycle-expired after 1 day); KV for small shared results. | Per-colo and evictable; GET-only keys; never cache open time windows without short TTL; tenant id must be in the key. |
| **Index storage** (series/label index, trace-id lookup, log token blooms) | **R2 objects** alongside data (sidecar index files, Parquet page indexes/bloom filters), cached at edge; small "recent series" index in the tenant DO (SQLite + FTS5) | Cheapest per GB, range-readable, immutable, zero idle. | D1 only for small global indexes. | Each lookup is a Class B op ($0.36/M) - design for few range reads per query; Basin compaction rewrites data files and knows nothing about sidecar indexes, so prefer indexes embedded in Parquet or indexes keyed by snapshot. |
| **Long-term store** | **R2 Standard, Parquet, Iceberg tables** | $0.015/GB-month, zero egress, strong consistency, open format. | IA class for data older than ~30 days that is rarely queried. | IA has $0.01/GB retrieval, 2.5x read ops price, 30-day minimum - a single wide scan can cost more than it saved. Retention should be Iceberg deletes/partition drops + snapshot expiry, **not** R2 lifecycle rules on catalog-managed prefixes. |
| **Platform self-metering** | **Workers Analytics Engine** | Unbilled today, SQL + Worker binding. | - | Sampled; 250 points/invocation; 3-month retention. |
| **Ad-hoc / long-range SQL** | **Basin SQL** over HTTP from a Worker | Serverless, $2.50/TB, no idle. | Tenant-run DuckDB/Spark against a tenant-dedicated bucket. | 10k row cap, 10 MB minimum per query, no binding, no tenant isolation, undocumented timeouts. |

---

## 15. Design implications for viz

1. **Two-tier storage is unavoidable.** Iceberg via Cloudflare's own writer has a 60 s floor (300 s default), and each commit is a billed catalog op. Alerting and "last 5 minutes" dashboards need a hot tier (Durable Objects and/or un-catalogued L0 files) that the query engine merges with the Iceberg tier.

2. **Can a Worker commit to Basin Catalog itself?** [inference] Nothing prevents it: the catalog is a plain HTTPS Iceberg REST API with bearer auth, and a Worker can `fetch()` it. But there is **no binding, no JS Iceberg client documented by Cloudflare, and no stated support** for this path. viz would need to (a) write Parquet in WASM under 128 MB, (b) write Avro manifests and manifest lists, (c) `POST` a commit with `assert-ref-snapshot-id` requirements and retry on 409. Feasible, but it is the highest-risk custom component. Lower-risk alternatives: let **Pipelines** be the only Iceberg writer, or keep viz's own manifest and treat Basin Catalog as a later/optional export.

3. **Single-writer discipline.** Iceberg commits are optimistic; concurrent committers to one table cause retries and wasted Class A writes, and Basin's compactor is itself a concurrent committer. Route all commits for a table through **one Durable Object** (or one Pipelines sink). Never mix a Pipelines sink and a custom committer on the same table (and a Pipelines sink cannot attach to a pre-existing table anyway).

4. **Minimum practical commit interval.** [inference] 60 s is the vendor's own floor "to prevent compaction issues". For a custom committer, cost is not the limit (one commit per 10 s on one table = 259k ops/month = ~$2.33) but snapshot/manifest growth and compaction conflicts are. Plan for **1-5 minutes per table**, batching all tenants into one commit.

5. **Shared tables, not per-tenant tables.** Per-tenant tables multiply commits: 1,000 tenants x 3 signals x 1 commit/min = 130M catalog ops/month = ~$1,160/month, and Pipelines allows only 20 sinks. Use a few shared tables partitioned by `tenant_id` (or tenant bucket) and time. Commit only when there is data so an idle platform costs nothing. Offer dedicated buckets/catalogs only to large or regulated tenants.

6. **Tenant isolation is viz's job.** Neither Basin Catalog nor Basin SQL has per-namespace/table authorization. All queries go through viz's query layer, which injects tenant predicates. Raw catalog or SQL tokens are only safe to hand out for a tenant-dedicated bucket.

7. **Data residency is a real gap.** Basin Catalog and the Pipelines Iceberg sink do not work with `eu`/`us`/`fedramp` jurisdiction buckets. R2 itself and Durable Objects do. If EU residency is a requirement, the design needs a path that does not depend on Basin Catalog (self-managed Iceberg metadata on a jurisdictional bucket using R2 conditional writes).

8. **Build the PromQL/TraceQL engine in Workers/DOs reading Parquet by range, not on Basin SQL.** Basin SQL's 10k row cap, 10 MB per-query minimum and absent latency guarantees rule it out for dashboards and rule evaluation. Use it for exploratory SQL and possibly for heavy scans where an aggregate pushdown returns few rows.

9. **Design for file count, not bytes.** Class A at $4.50/M: one tenant flushing one file every 10 s = 259k PUTs/month = ~$1.17/tenant/month; batching tenants into shared files removes this. On the read side, footers and index blocks should be cached (Cache API) because every range read is a Class B op.

10. **R2 ETag CAS is a viable metadata primitive** (atomic, serialised per key) with a hard 1 write/s/key ceiling. Good for a per-table or per-tenant manifest pointer updated every few seconds or slower; anything faster belongs in a DO.

11. **Idle cost floor.** [inference] Workers Paid $5/month covers the included allowances of Workers, DOs, D1, KV, Queues, Pipelines (50 GB), with R2 (10 GB), Basin Catalog (1M ops, 10 GB compaction) and Basin SQL (10 GB scanned) having their own free allowances. With no always-awake DOs and no timer-driven commits, an idle deployment costs ~$5/month plus stored bytes. The things that break scale-to-zero are cron/alarms that run regardless of traffic (alert rule evaluation!) and periodic empty commits.

12. **Retention.** Per-tenant configurable retention on shared tables means row/partition deletes through Iceberg (partition by tenant bucket + day so retention is a metadata-only partition drop), followed by snapshot expiration (which since 2026-04 deletes unreferenced data files). Defaults (30 days, retain 5) mean deleted data physically lingers up to 30 days unless tuned. R2 lifecycle rules are appropriate only for non-catalog prefixes (L0 files, WAL segments, cached results).

13. **Pipelines schema rigidity vs. observability data.** Arbitrary labels/attributes must be modelled up front (json column or list of key/value structs); a schema change means a new stream + sink + table. Decide the physical schema before adopting Pipelines, and validate client-side because invalid events vanish silently.

---

## 16. Open questions / unverified

1. **Iceberg spec version** supported by Basin Catalog (v2 only? v3 deletion vectors?) and whether compaction applies position/equality deletes. Not stated in any page read. Test: create a `format-version=3` table via PyIceberg.
2. **Basin Catalog rate limits** (commits/s per table, requests/s per catalog), table/namespace/snapshot count limits, the compaction schedule and the daily manual-maintenance cap. Undocumented.
3. **Committing from a Worker**: is the REST catalog reachable from Workers without egress quirks, are vended credentials usable with the S3 API from a Worker, and how does it behave under 409 conflict with the compactor? Needs a spike.
4. **Basin SQL operational limits**: query timeout, concurrency, max result bytes, response JSON schema, p50/p99 latency for small selective queries, and whether `ORDER BY` is still restricted to partition columns.
5. **Basin Pipelines internals**: stream retention/backlog limits, what `send()` resolution guarantees (durable across failures?), behaviour at the 1 GB/s limit (429 or backpressure), whether the Iceberg sink allows a custom partition spec/sort order, true minimum roll interval (60 s on the sink page vs. 10 s in a tutorial), and the exactly-once mechanism.
6. Whether **multiple pipelines can read one stream** (pricing page says yes; manage-pipelines page only shows multi-INSERT fan-out).
7. **Durable Object SQLite billing** wording is stale on the pricing page (says January 2026 "target"); Free-plan per-object storage is 1 GB or 10 GB depending on the paragraph.
8. **D1 read replication** GA status; typical replica lag.
9. **Cache API** pricing/quotas and Smart Tiered Cache availability (from training: both free) and whether Cache API works on `workers.dev` for this use.
10. **Workers Analytics Engine** billing start date; exact write-time sampling thresholds.
11. R2: any undocumented per-bucket or per-prefix request-rate ceilings at high QPS; delivery guarantee and latency of event notifications.
12. Catalog URI / warehouse naming format after the Basin rename (training-only knowledge of the old format).
13. No third-party or community sources were consulted (search unavailable), so real-world reports of reliability problems are missing from this document.

---

## 17. Sources (all fetched 2026-11-18)

R2
- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/r2/platform/limits/
- https://developers.cloudflare.com/r2/reference/consistency/
- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- https://developers.cloudflare.com/r2/api/s3/api/
- https://developers.cloudflare.com/r2/buckets/event-notifications/
- https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- https://developers.cloudflare.com/r2/reference/data-location/
- https://developers.cloudflare.com/r2/buckets/local-uploads/
- https://developers.cloudflare.com/changelog/product/r2/

Basin Catalog (R2 Data Catalog)
- https://developers.cloudflare.com/basin-catalog/ (redirect target of /r2/data-catalog/)
- https://developers.cloudflare.com/basin-catalog/get-started/
- https://developers.cloudflare.com/basin-catalog/manage-catalogs/
- https://developers.cloudflare.com/basin-catalog/table-maintenance/
- https://developers.cloudflare.com/basin-catalog/deleting-data/
- https://developers.cloudflare.com/basin-catalog/observability/metrics/
- https://developers.cloudflare.com/basin-catalog/platform/pricing/
- https://developers.cloudflare.com/basin-catalog/config-examples/pyiceberg/
- https://developers.cloudflare.com/basin-catalog/config-examples/duckdb/
- https://developers.cloudflare.com/changelog/product/basin-catalog/

Basin SQL (R2 SQL)
- https://developers.cloudflare.com/basin-sql/ (redirect target of /r2-sql/)
- https://developers.cloudflare.com/basin-sql/get-started/
- https://developers.cloudflare.com/basin-sql/query-data/
- https://developers.cloudflare.com/basin-sql/sql-reference/
- https://developers.cloudflare.com/basin-sql/reference/limitations-best-practices/
- https://developers.cloudflare.com/basin-sql/troubleshooting/
- https://developers.cloudflare.com/basin-sql/platform/pricing/
- https://developers.cloudflare.com/changelog/product/basin-sql/
- https://blog.cloudflare.com/r2-sql-deep-dive/

Basin Pipelines (Cloudflare Pipelines)
- https://developers.cloudflare.com/basin-pipelines/ (redirect target of /pipelines/)
- https://developers.cloudflare.com/basin-pipelines/streams/manage-streams/
- https://developers.cloudflare.com/basin-pipelines/streams/writing-to-streams/
- https://developers.cloudflare.com/basin-pipelines/pipelines/
- https://developers.cloudflare.com/basin-pipelines/pipelines/manage-pipelines/
- https://developers.cloudflare.com/basin-pipelines/sinks/
- https://developers.cloudflare.com/basin-pipelines/sinks/manage-sinks/
- https://developers.cloudflare.com/basin-pipelines/sinks/available-sinks/r2/
- https://developers.cloudflare.com/basin-pipelines/sinks/available-sinks/r2-data-catalog/
- https://developers.cloudflare.com/basin-pipelines/platform/limits/
- https://developers.cloudflare.com/basin-pipelines/platform/pricing/
- https://developers.cloudflare.com/changelog/product/basin-pipelines/
- https://blog.cloudflare.com/cloudflare-data-platform/

Other services
- https://developers.cloudflare.com/queues/platform/limits/
- https://developers.cloudflare.com/queues/platform/pricing/
- https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://developers.cloudflare.com/durable-objects/reference/data-location/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/best-practices/read-replication/
- https://developers.cloudflare.com/kv/platform/limits/
- https://developers.cloudflare.com/kv/platform/pricing/
- https://developers.cloudflare.com/kv/concepts/how-kv-works/
- https://developers.cloudflare.com/analytics/analytics-engine/limits/
- https://developers.cloudflare.com/analytics/analytics-engine/pricing/
- https://developers.cloudflare.com/analytics/analytics-engine/sampling/
- https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
- https://developers.cloudflare.com/analytics/sql-api/
- https://developers.cloudflare.com/analytics/sql-api/workers-binding/
- https://developers.cloudflare.com/hyperdrive/platform/limits/
- https://developers.cloudflare.com/vectorize/platform/limits/
- https://developers.cloudflare.com/vectorize/platform/pricing/
- https://developers.cloudflare.com/workers/runtime-apis/cache/
- https://developers.cloudflare.com/cache/advanced-configuration/cache-reserve/
- https://developers.cloudflare.com/cache/concepts/default-cache-behavior/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/wrangler/configuration/
