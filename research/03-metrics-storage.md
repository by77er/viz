# 03 — Metrics storage and data management: state of the art (Nov 2026)

Research date: 2026-11-18. Scope: how metrics are stored, indexed, compacted, downsampled and served
in current systems, and what that implies for **viz** (Workers + Durable Objects + R2, Iceberg/Parquet, PromQL).

## Research caveats (read first)

- **Web access worked only partially.** Direct page fetches worked for most primary sources. The shared
  web-search budget for this session ran out part-way through, so several areas (VictoriaMetrics internals,
  M3, Monarch, Honeycomb, Chronosphere, QuestDB, SigNoz, Coralogix, Mimir downsampling, GreptimeDB Mito
  internals) could **not** be re-verified and are written from training knowledge. One host (`tldrecap.tech`)
  was blocked by the session network policy.
- Every claim is tagged:
  - **[V]** = verified this session against the cited source (fetched page, spec, changelog or source file).
  - **[T]** = training knowledge, not re-verified this session. Treat as probably right, check before relying on it.
  - **[E]** = my own engineering estimate or inference. Not measured. Needs a benchmark.
- No public, primary-source benchmark of "Parquet vs TSDB blocks" was found. The only numbers surfaced are a
  third-party recap of a PromCon talk that I could not open. The Parquet projects' own docs give no figures.
- All bytes/sample figures for viz in this document are **[E]** estimates.

---

## 1. Executive summary

1. **The ecosystem is converging on "series rows in Parquet, chunks as opaque blobs".** Cortex, Thanos and
   Mimir all experimented in 2025 with one shared library (`prometheus-community/parquet-common`): a *labels*
   Parquet file (one row per series, one column per label name) plus a *chunks* Parquet file (same row order,
   Prometheus XOR chunks in 8-hour columns). Cortex ships it as experimental "parquet mode"; Thanos has a
   separate gateway that originated as a **Cloudflare** proof of concept; Mimir's work lives on a
   `parquet-main` branch and appears to have slowed in 2026. [V]
2. **The motivation is the read path, not compression.** TSDB's index forces many small random reads against
   object storage and a stateful store-gateway with index-headers; a Cortex maintainer reports fetched vs
   touched chunk bytes of 20:1. Parquet replaces postings with columnar label scans and removes the
   index-header. [V]
3. **Parquet is not obviously the end state for time-series values.** InfluxDB 3 Enterprise replaced its
   Parquet engine with a custom columnar format (`.pt`, "PachaTree") in 2026, citing single-series query speed
   and bounded compaction memory. Polar Signals moved from Parquet to Vortex because Parquet-to-Arrow decode
   dominated CPU. Thanos is considering an ALP-based chunk type. ClickHouse's TimeSeries engine moved from one
   row per sample to one row per series per time bucket. Parquet itself gained an **ALP** float encoding
   (Preview, Aug 2026). [V]
4. **Storage bytes are not viz's binding constraint.** At R2 prices, 1M active series at 15 s is single-digit
   dollars per month whether we spend 1.4 or 3 bytes/sample [E]. The binding constraints are object-store
   request count, bytes scanned per query, per-isolate memory, and catalog commit count. Layout should be
   chosen to minimise those.
5. **Recommendation:** a normalised, narrow layout in Iceberg:
   a per-day **series table** (labels, the index) and a **flat samples table** `(metric_name, series_id, ts, value)`
   sorted by `(metric_name, series_id, ts)`, partitioned by `(tenant, day)`, plus 5-minute and 1-hour rollup
   tables. Expected 2–3 bytes/sample compacted [E]. The main alternative is chunk-blob rows
   (≈1.3–1.6 bytes/sample [E]) which should be benchmarked against it before committing.

---

## 2. Prometheus TSDB (baseline everyone is compatible with)

### 2.1 Structure [T]

- **Head block**: in-memory, holds roughly the most recent 2–3 h. Series live in a striped hash map; each
  series has an open head chunk that is cut at ~120 samples or the chunk range boundary and then memory-mapped
  from disk.
- **WAL**: 128 MB segments, records for series, samples, exemplars, histograms, metadata; periodic
  checkpoints drop records for series that no longer exist. Out-of-order samples go to a separate OOO head
  with its own write-behind log (WBL).
- **Persistent blocks**: immutable directories named by ULID, containing `meta.json`, `index`, `chunks/NNNNNN`
  (segment files up to 512 MB) and `tombstones`. 2 h blocks are compacted into larger ones (up to 31 d or
  10% of retention).
- **Index**: symbol table (deduplicated strings), series section (label set as symbol refs plus chunk
  metadata: min/max time and file offset), label index, **postings** (for every `name=value` pair a sorted
  list of series refs) and a postings offset table. Query = intersect/union postings, then look up series,
  then fetch chunks.
- **Chunk encoding ("XOR", Gorilla-derived)**: timestamps as delta-of-delta with variable-length bit buckets,
  values as XOR against the previous value with leading/trailing zero windows. Prometheus documents 1–2
  bytes/sample; ~1.3 is the commonly quoted production average; the Gorilla paper reports 1.37.

### 2.2 What changed in Prometheus 3.x [V unless marked]

Latest release at research time: **3.16.0 (2026-11-04)**; 3.13 is the LTS line.

| Area | State | Source |
|---|---|---|
| Native histograms | Declared stable in 3.8.0 (2025-11-28); still opt-in per scrape config via `scrape_native_histograms`. "No longer experimental" in 3.9.0. | changelog |
| NHCB (native histograms with custom buckets) | Supported in TSDB and PromQL; RW 2.0 "stateless" modes require NHCB instead of classic `_bucket` series; OpenMetrics 2.0 parser converts classic histograms to NHCB directly (3.16). | changelog, RW2 spec |
| Created timestamp → **start timestamp (ST)** | Renamed with RW 2.0-rc.4 (3.8.0). `st-storage` flag (3.11) stores ST per sample through WAL, TSDB and RW2. ST for histograms behind `histograms-st-encoding` (3.14). `use-start-timestamps` makes `rate()`/`increase()`/`resets()` ST-aware (3.12+). `st-synthesis` synthesises missing STs. All still experimental. | feature flags, changelog |
| **XOR2** float chunk encoding | New in 3.11 (flag), selectable by config in 3.13, **stabilised in 3.15.0** (2026-09-24), further compression/append improvements in 3.16. Described as "optimized for scraped data" and able to carry start timestamps. No bytes/sample figures published in the PR. | changelog, PR #18062 |
| OTLP ingestion | Native OTLP receiver; continued fixes (target_info dedup, attribute collisions, label caching). Delta temporality: `otlp-deltatocumulative` (stateful conversion) or `otlp-native-delta-ingestion` (store raw deltas, query with `sum_over_time`), both experimental and mutually exclusive. | feature flags |
| Type and unit | `type-and-unit-labels` injects reserved `__type__` and `__unit__` labels. Experimental. | feature flags |
| UTF-8 names | Metric and label names may be arbitrary UTF-8 since 3.0 [T]; 3.16 adds unquoted Unicode letters and dots behind a flag. | changelog |
| Stale series | Experimental early compaction of stale series (3.10). | changelog |
| Out-of-order | Supported via OOO head; many OOO data-loss fixes in 3.14–3.16, which is a hint at how subtle OOO is in a head/WAL design. | changelog |

### 2.3 Remote Write 2.0 [V]

- Spec status: **2.0-rc.6, Experimental, October 2026.** It has not gone final.
- `io.prometheus.write.v2.Request`: a `symbols` string table (index 0 is the empty string) and `timeseries`
  whose `labels_refs` index into it. Each series carries `samples` **or** `histograms`, plus `exemplars` and
  `metadata` (type, help, unit). Samples carry an optional `start_timestamp`.
- Snappy block compression is mandatory. Receivers must return
  `X-Prometheus-Remote-Write-{Samples,Histograms,Exemplars}-Written` headers.
- Samples must be in order within a series. Receivers may ask for whole-request retries, so **ingestion must be
  idempotent**. Partial writes return non-2xx.
- New `mode=none|stateless|stateless-st` content-type parameter. `stateless` requires metadata type and NHCB;
  `stateless-st` additionally requires start timestamps on cumulative types.

**Implication:** an ingester that receives RW2 `stateless-st` gets type, unit and start timestamp with every
sample. That removes the need for per-series ingestion state (reset detection, type guessing), which is exactly
what a serverless ingest path wants.

---

## 3. Cortex, Mimir, Thanos

### 3.1 Architecture [T unless marked]

- **Write path (classic)**: distributor (validation, HA dedup, hash ring) → ingesters with replication factor
  3. Each ingester runs a per-tenant Prometheus TSDB head and WAL, cuts 2 h blocks and uploads them.
- **Read path**: query-frontend (range splitting by day, results cache, query sharding by series hash) →
  query-scheduler → queriers → ingesters for recent data and **store-gateways** for blocks.
- **Store-gateway**: downloads an *index-header* per block (symbols and postings offset table), lazily fetches
  postings, series and chunks by byte range, and leans on memcached for index and chunk caches.
- **Compactor**: vertical and horizontal compaction, deduplication of the RF-3 copies, retention. Mimir uses
  *split-and-merge* compaction to shard very large tenants into N output blocks so that no single block's index
  exceeds limits.
- **Thanos**: sidecar or Receive for ingestion, Store Gateway, Querier with query-time dedup by replica label,
  a singleton Compactor per block stream that also downsamples.

### 3.2 Mimir 3.0 "ingest storage" [V]

- Distributors write to **Kafka** (or any Kafka-compatible system such as WarpStream); the write is
  acknowledged when Kafka has it. Ingesters became read-path-only consumers, one partition each.
- Replication factor dropped from 3 to 2 and reads use quorum 1, because partition consumption is gapless.
- Strong read-after-write is opt-in: `X-Read-Consistency: strong` makes the query-frontend fetch the latest
  partition offsets and ingesters wait until they have consumed that far (up to 20 s by default).
- Grafana reports a **25% TCO reduction** in Grafana Cloud and describes classic ingesters as "a big
  distributed single point of failure" because read load could take down the write path.

### 3.3 Pain points

| Pain point | Evidence |
|---|---|
| TSDB index needs random reads; each becomes an object-store request; merging requests causes **overfetch** | Cortex proposal [V] |
| Chunk overfetch of **20:1** (fetched vs touched bytes) on store-gateway | Cortex PR #6712 comment [V] |
| Store-gateway needs local disk for index-headers, large memory, slow initial sync, complex sharding | Cortex proposal [V] |
| mmap of index-headers caused slow or unresponsive store-gateways; removed in Mimir 2.6–2.12 | Mimir release notes/blog [V] |
| Each block processed by one goroutine | Cortex proposal [V] |
| Thanos compactor is a singleton per stream, **halts** on data errors, needs ~2× largest compaction range of disk; if it stalls, retention is not enforced | Thanos docs [V] |
| Downsampling **adds** storage (two extra blocks per raw block, up to ~3×) | Thanos docs [V] |
| Ingesters couple read and write paths; RF-3 cost | Grafana [V] |
| Label names/values calls are expensive enough that Mimir's Parquet store-gateway added a flag to disable them | Mimir PR #13488 title [V] |
| High-cardinality postings bottleneck | Cortex proposal [V] |

---

## 4. The Parquet movement

### 4.1 Timeline and actors [V]

- **Shopify** (Filip Petkovski, Thanos maintainer): talk "Deep Dive into Long Term Metrics for Planet-Scale
  Commerce" described retrofitting Parquet into Thanos. This is cited by every later project as the trigger.
  I could not retrieve the talk's numbers.
- **Cloudflare** (Michael Hoffmann): `cloudflare/parquet-tsdb-poc`, "POC for a parquet based TSDB in object
  storage" that converts TSDB blocks to Parquet and serves PromQL to backfill a Thanos deployment.
- **thanos-io/thanos-parquet-gateway**: the continuation of that POC. Its schema constants still carry the
  `___cf_meta_` prefix. The Feb 2026 Thanos update says it is "still in rapid development" and "a few
  companies have already adopted it"; it will move into the main repository after stabilising.
- **Cortex** (AWS: Alan Protasio, Ben Ye): design proposal April 2025, experimental **parquet mode** with a
  converter, a parquet queryable in the querier, and (since PR #7046, Nov 2025) Parquet support in the
  store-gateway.
- **prometheus-community/parquet-common**: shared Go library ("early development – expect breaking changes"),
  plus a `parquet-wg` working group and a `#prometheus-parquet-dev` CNCF Slack channel.
- **Grafana Mimir**: a `parquet-main` branch with `parquet-converter` and "parquet store-gateway" PRs merged
  Oct–Nov 2025 using parquet-common. Several follow-up drafts were closed in April 2026, while January 2026
  PRs work on an "index-header bucket reader" and a WIP "index-header in a parquet key-value-style format".
  **[E] inference:** Mimir has not shipped Parquet blocks and seems to be exploring a narrower fix for the
  index-header instead. Not confirmed by any statement.
- **PromCon EU 2025** (Munich, 21 Oct 2025): "Beyond TSDB: Unlocking Prometheus with Parquet for Modern Scale"
  by Vazquez (Grafana), Protasio (AWS), Hoffmann (Cloudflare). The abstract frames the motivation as high
  cardinality from OpenTelemetry and slow object-storage queries.

### 4.2 Schemas (from source) [V]

**parquet-common / Cortex**

| Column | Type | Encoding | File | Notes |
|---|---|---|---|---|
| `l_<label name>` (one per label name in the block) | optional string | RLE_DICTIONARY | labels | null where a series lacks the label |
| `s_col_indexes` | byte array | DELTA_BYTE_ARRAY | labels | bitmap/list of which label columns the row populates |
| `s_series_hash` | byte array | default | labels | hash of all labels |
| `s_data_<n>` | byte array | DELTA_LENGTH_BYTE_ARRAY | chunks | encoded Prometheus chunks for `[n·d, (n+1)·d)` |

- Two files per shard: `<name>/<shard>.labels.parquet` and `<name>/<shard>.chunks.parquet`, **same row order**,
  so the join is positional. The stated reason for two files is that labels and chunks have different sizes and
  read patterns and want different reader buffer settings.
- Defaults in the converter: **1,000,000 rows per row group**, **8 h column duration** (3 data columns per
  24 h block), sort by `__name__`, bloom filter on `__name__`, zstd `SpeedBetterCompression`. Sort labels and
  bloom-filter labels are configurable. Page statistics are skipped for hash, index and data columns.
- File metadata keys: `data_col_duration_ms`, `minT`, `maxT`.
- A TSDB chunk that straddles a column boundary is split and re-encoded.
- Cortex guide example config: per-tenant `parquet_converter_sort_columns`, `max_rows_per_row_group`,
  per-query limits (`parquet_max_fetched_row_count`, `..._chunk_bytes`, `..._data_bytes`), and separate
  caches for labels and chunks.

**thanos-parquet-gateway**

| Column | Type | Encoding |
|---|---|---|
| `___cf_meta_label_<name>` | optional string | RLE_DICTIONARY |
| `___cf_meta_index` | byte array | DELTA_LENGTH_BYTE_ARRAY |
| `___cf_meta_hash` | int64 | PLAIN |
| `___cf_meta_chunk_0..2` | byte array | DELTA_LENGTH_BYTE_ARRAY |

- Three chunk columns of 8 h each per day. Everything zstd.
- Format versions tell a story: V0 kept a map from `__name__` to that metric's columns; **V1** added the index
  column so queries need not carry a `__name__` matcher; **V2** added a hash column so that *label projection*
  (loading only the labels a query needs) still lets the engine join series. The hash lives in the chunks
  file "because the random hash values would bloat the labels file".
- The converter takes repeated `--convert.sorting.label` flags (example: `__name__`, `namespace`).

### 4.3 How a query runs [V for structure, T for detail]

1. Use row-group and page statistics (and bloom filters) on the sort columns to narrow to row ranges for the
   `__name__` matcher.
2. Read only the label columns named in matchers, evaluate them, and produce a row selection.
3. Materialise the remaining label columns for surviving rows (or only projected ones).
4. Read the `s_data_n` columns that overlap the query time range, at the same row positions.

Projection pushdown therefore works on two axes: which labels, and which 8 h window.

### 4.4 Reported results

- Cortex docs and proposal: qualitative only (fewer requests, stateless, parallelism by row group). [V]
- Thanos issue #8285: one user reports "excellent performance improvements"; another asks, unanswered, why this
  beats an inverted index. [V]
- A third-party recap of the PromCon talk lists 80–90% faster queries, 70% less memory and 90% fewer GetRange
  calls "compared with the original library". **Unverified**: I could not open the recap, and the baseline is
  unclear (it may compare library versions rather than Parquet vs TSDB).

### 4.5 Problems they ran into [V]

- **Statelessness hurts caching.** Cortex first put the Parquet reader in the stateless querier; cache hit
  rates were poor and remote-cache traffic heavy, so they moved it into the store-gateway with files or
  footers cached on local disk (issue #6940).
- **Conversion lag and dual storage.** Parquet is produced *from* TSDB blocks, so it arrives late, queries
  must fall back to TSDB, and both copies are stored. Only blocks larger than 2 h are converted.
- **Query sharding** initially materialised all chunks and filtered afterwards (Mimir PR #13362).
- **Label names/values** calls are costly on a wide labels file (Mimir PR #13488).
- **Wide, dynamic schemas.** One column per label name means a different schema per block and potentially
  thousands of columns. That is workable for standalone Parquet files and a poor fit for a single Iceberg
  table schema. [E]

---

## 5. Other metrics stores

### 5.1 VictoriaMetrics

- Storage design borrows from ClickHouse MergeTree. [V]
- Data is buffered in memory and flushed every 5 s by default (`-inmemoryDataFlushInterval`); an unclean
  shutdown can lose that window. [V]
- Per-month partitions with background merges. Deleted series are reclaimed only by later merges. [V]
- `indexdb` (the "mergeset" inverted index) is rotated with retention and has a **per-day index** to cope with
  churn; it can be disabled for low-churn workloads. In Kubernetes, indexdb can reach about 2× the data size. [V]
- Deduplication keeps the last sample per series per `-dedup.minScrapeInterval`; downsampling (Enterprise) is
  described as the same mechanism with an offset. Neither shrinks the index. [V]
- No limit on out-of-order or backfilled data within retention. [V]
- Lossy for floats with more than 12 significant decimal digits. [V]
- Claims "up to 7× less storage than Prometheus, Thanos or Cortex". [V as a vendor claim]
- Parts are columnar: separate files for timestamps, values, a block index and metaindex; rows sorted by TSID
  then timestamp; TSID is a composite (metric group, job, instance, metric ID) so related series are adjacent;
  values are converted to scaled integers then delta or delta-of-delta encoded and zstd-compressed; typical
  0.4–0.8 bytes/sample. [T]
- It deliberately uses block storage, not object storage. [V]

### 5.2 InfluxDB 3 (IOx lineage)

- Core write path: WAL flushed to object storage **every second**; a queryable in-memory buffer; every 10
  minutes the oldest data is persisted as Parquet, with the most recent ~5 minutes kept in memory; recently
  persisted Parquet files are cached in memory. Enterprise buffers up to 900 WAL files (~15 min). [V]
- Query engine is DataFusion over Arrow; tags are dictionary columns; Last Value Cache and Distinct Value Cache
  exist specifically to answer "latest value" and metadata queries without touching Parquet. [V that they
  exist, T for internals]
- **Enterprise moved off Parquet in 2026.** The upgraded engine stores `.pt` files sorted by column-family
  key, series key and timestamp, with delta-delta RLE for timestamps, Gorilla for floats and dictionary for
  low-cardinality strings. Stated reasons: faster single-series queries, bounded CPU and memory during
  persistence and compaction, wide and sparse tables without rewrites. Parquet remains an export format for
  compacted data. [V]

### 5.3 GreptimeDB

- **Metric engine**: many *logical* tables (one per metric) share one *physical* table and its regions; each
  physical region group has a data region and a metadata region holding the logical-to-physical column
  mapping. Writes tag each row with its logical table; reads add that filter. Stated benefits are lower
  per-table overhead and better columnar compression. [V]
- **Mito** engine: LSM with WAL, memtables, immutable SSTs in **Parquet** on local disk or S3/GCS/Azure, with a
  tiered local cache for remote SSTs. [V]
- PromQL is implemented in Rust on DataFusion. Remote Write 2.0 is not yet supported (May 2026). [V]
- Labels are columns of the wide physical table; a sparse primary-key encoding avoids materialising every
  label column per row; SSTs carry an inverted index sidecar. [T]

### 5.4 ClickHouse TimeSeries engine [V]

Private preview on ClickHouse Cloud (Sept 2026 blog). PromQL is evaluated inside the server (>85% coverage);
ingestion is remote-write v1 only; native histograms, RW2, rules and downsampling are not yet supported.

| Table | Row | Engine / order | Notable |
|---|---|---|---|
| samples | **one row per series per time bucket** (1 h default) holding `Array(Tuple(timestamp, value))` | AggregatingMergeTree, `ORDER BY (id, bucket)`, monthly partitions | codecs: timestamps Delta+T64+ZSTD, values **ALP**+ZSTD |
| recent samples | same shape, 15 min buckets, TTL ~4 d | 5-hour partitions | separate hot shape |
| tags | one row per series | ReplacingMergeTree, `ORDER BY (metric_name, id)` | `tags Map(LowCardinality(String), String)` plus optional promoted columns via `tags_to_columns`; text index on the map |
| time ranges | `id, min_time, max_time` | AggregatingMergeTree | series liveness kept apart from tags |
| metric families | family, type, unit, help | ReplacingMergeTree | |

- `id` is `Tuple(sipHash64(metric_name), sipHash128(tags))`, so sorting by id groups a metric's series.
- **Schema version 10 and earlier stored one sample per row; version 11 switched to bucketed arrays.** That is
  a strong data point about which row shape a columnar engine prefers for PromQL.

### 5.5 Datadog

- **Monocle** (real-time metrics engine, Rust): shard-per-core, each shard owns a private memtable and its own
  LSM with tiered compaction; custom SSTable-like files with per-file min/max time and bloom filters on series
  key; encoding moved from Gorilla-like to a SIMD codec; first-class scalar, **DDSketch** and HyperLogLog
  types. The real-time DB stores `<series_id, ts, value>`; a **separate index database** stores
  `<series_id, tags>`. Datadog says it is reconsidering that separation. [V]
- **Index**: moved from query-log-driven materialised indexes to an inverted index on every tag
  (`metric;tag → series ids` in RocksDB). Lesson stated: prefer predictable cost over optimal cost; same
  hardware handled 20× higher cardinality and timeouts fell 99%. About 30% of written data is ever queried. [V]
- **Husky** (events, logs, traces): schemaless columnar fragments in object storage in a custom format,
  writers fed from Kafka, fragment metadata in FoundationDB, background compaction. [V]

### 5.6 Others (all [T], not re-verified)

- **M3 (Uber)**: M3TSZ (Gorilla variant, ~1.45 bytes/datapoint), 2 h filesets, per-block FST-based inverted
  index, namespaces with different resolution and retention, M3 Aggregator doing rollups at ingest.
- **Monarch (Google, VLDB 2020)**: in-memory zonal leaves, schematised tables (typed target and metric
  schemas), "field hints index" for pruning leaves, distribution value type with exemplars, query pushdown
  through a three-level hierarchy.
- **Chronosphere**: M3-derived store with a control plane whose core product idea is **shaping at ingest**
  (drop, roll up, aggregate away labels) so stored cardinality is a deliberate choice.
- **Honeycomb Retriever**: per-dataset columnar segments, one file per column, recent data on local disk and
  older segments in S3 queried by fan-out to **serverless functions**. The closest production precedent for
  viz's query model. Metrics are stored as wide events.
- **QuestDB**: per-column files in time partitions, WAL with out-of-order merge, `symbol` dictionary type;
  older partitions can be converted to Parquet and tiered to object storage.
- **SigNoz on ClickHouse**: `samples` `(metric_name, fingerprint, unix_milli, value)` ordered by that key, a
  `time_series` table of `(fingerprint, labels)` in several time-bucket granularities (6 h, 1 d, 1 w), and
  pre-aggregated 5 m and 30 m sample tables. This is essentially the design recommended below.
- **"Observability 2.0" / wide events**: store one wide structured event per unit of work and derive metrics at
  query time (Honeycomb, ClickStack, Husky-style stores). The cost model differs: you pay scan cost per query
  instead of aggregation cost at ingest. Pre-aggregated metrics remain far cheaper for alerting and
  long-range dashboards, so the pragmatic unification is a **shared substrate** (Iceberg + Parquet + one
  catalog) with signal-specific schemas, not a single table.

---

## 6. Design space for metrics in Parquet/Iceberg

### 6.1 Row shape

| Shape | Who | Bytes/sample | Pros | Cons |
|---|---|---|---|---|
| **A. One row per sample** `(series_id, ts, value)` | InfluxDB IOx, GreptimeDB, SigNoz, ClickHouse TimeSeries ≤ v10 | 2–3 [E] | Plain SQL for any engine; generic Iceberg compaction, dedup and deletes just work; out-of-order is trivial; same shape as logs and spans; native histograms fit as struct columns | Parquet has no delta-of-delta or XOR; many rows to decode; time pruning inside a series needs help from the sort key |
| **B. One row per series per window, opaque chunk blob** | parquet-common, Cortex, Thanos gateway | 1.3–1.6 [E] | Best compression; 100–500× fewer rows; reuses Prometheus chunk codecs including histogram chunks | Opaque to SQL engines; merge means decode and re-encode; ties storage to Prometheus chunk formats (XOR → XOR2 churn) |
| **C. One row per series per window, typed arrays** | ClickHouse TimeSeries v11 | ≈ A [E] | Few rows, still readable with `UNNEST`; natural place for per-window aggregates | Parquet list leaves are the same concatenated sequence as A, so no encoding gain; generic compaction will not merge two rows for the same window |

### 6.2 Labels

| Option | Notes |
|---|---|
| One column per label name | parquet-common. Best pushdown; dynamic and wide schema; column names must escape UTF-8 label names; unsuitable for one shared Iceberg schema. |
| `MAP<string,string>` | Fixed schema, UTF-8 safe. No stats pushdown on entries; needs a full column read for the selected row range. |
| Promoted columns + map | ClickHouse `tags_to_columns`. Hot labels get dictionary columns with stats, page index and bloom filters; the rest stay in the map. |
| Variant (Iceberg v3, shredded) | Promising but support in Cloudflare's catalog and SQL engine is unconfirmed. |
| Labels inline in sample rows | Cheap on disk when sorted (RLE), but repeats the map per sample and makes label APIs scan sample files. |
| **Separate series table keyed by `series_id`** | Datadog, ClickHouse, VictoriaMetrics, SigNoz, and effectively Cortex's labels file. Label APIs touch only this small table. |

### 6.3 Sort order and time pruning

- `(metric_name, series_id, ts)` gives one contiguous byte range per metric and long per-series runs, which is
  what Parquet's encodings need.
- `series_id` should not be a purely random hash if it is the sort key: rows of similar series (same job,
  different instance) compress better adjacent. VictoriaMetrics' composite TSID and ClickHouse's
  `(hash(metric), hash(tags))` tuple both exist for this reason. Thanos notes random hashes bloat the labels
  file. [V for the Thanos and ClickHouse facts]
- Page statistics on `ts` cannot prune within a series unless a page is smaller than a series run. Time
  selectivity therefore comes from (a) file time partitioning and (b) optionally a time bucket inside the sort
  key. Cortex and Thanos do (b) in *column space* with 8 h chunk columns.

### 6.4 Encodings available in Parquet today [V]

| Encoding | Types | Use |
|---|---|---|
| RLE_DICTIONARY | all | metric name, series id, labels, constant-valued gauges |
| DELTA_BINARY_PACKED | int32/int64 | timestamps. Blocks of ≥128 values with **one min-delta per block** and a bit width per miniblock |
| DELTA_LENGTH_BYTE_ARRAY / DELTA_BYTE_ARRAY | byte arrays | chunk blobs, sorted strings |
| BYTE_STREAM_SPLIT | float, double, int32, int64, fixed | float values before zstd |
| **ALP** | float, double | decimal-scaled float compression. **Preview as of 2026-08-01**: spec final, implementations may be incomplete, writers should opt in |

A consequence of the DELTA_BINARY_PACKED layout [E]: every block that contains a series boundary (timestamp
jumps backwards) gets a large min-delta, so *all* deltas in that block need ~20+ bits. With long runs (a
series-day is 5,760 samples at 15 s, 45 blocks) the overhead is ~2%. With short runs (4 samples per series in a
one-minute flush file) every block pays it. **Timestamps compress well only in compacted files with long
per-series runs.** This is the main reason raw flush files will be several times larger per sample than
compacted files.

### 6.5 Expected bytes per sample

| System / layout | Bytes per sample | Status |
|---|---|---|
| Gorilla paper | 1.37 | T |
| Prometheus XOR chunks | 1–2, typically ~1.3 | T |
| Prometheus XOR2 | "better compression", no figure published | V (no number) |
| M3TSZ | ~1.45 | T |
| VictoriaMetrics | 0.4–0.8 typical; vendor claims up to 7× less than Prometheus-family | T / V (claim) |
| Parquet with XOR chunk blobs (shape B) | ≈ TSDB chunks plus a labels file smaller than a TSDB index | E |
| Parquet flat rows, sorted, BYTE_STREAM_SPLIT + zstd, compacted daily (shape A) | **2–3** (timestamps 0.2–0.6, values 1–3, ids ~0.05) | E |
| Same with ALP for values | plausibly 1.5–2.5 | E |
| Shape A in uncompacted minute-level flush files | 5–8 | E |

### 6.6 Index, cardinality and churn

- Inverted indexes on object storage are the part of TSDB that works worst there (section 3.3). The Parquet
  projects replace postings with **sorted, dictionary-encoded label columns plus page indexes and bloom
  filters**, i.e. scan a narrow column instead of intersecting posting lists.
- Churn (pods, deploys) inflates any global index. The working answer everywhere is a **time-scoped index**:
  VictoriaMetrics' per-day index, Cortex's labels file per block, SigNoz's bucketed series tables.
- Metadata APIs (`/api/v1/labels`, `/label/<n>/values`, `/series`) should be answerable from the series
  table alone. For a dictionary-encoded promoted column, the distinct values in a row group are literally its
  dictionary page, which is a very cheap read. [E]
- Exemplars: Prometheus keeps them in a fixed-size in-memory ring plus WAL [V]; long-term stores keep them as
  separate rows keyed by series and time. A separate small table is the obvious Iceberg mapping.

### 6.7 Downsampling, staleness, out-of-order, dedup

| Topic | State of the art | Source |
|---|---|---|
| Thanos downsampling | raw → 5 m after 40 h → 1 h after 10 d. Five aggregates per chunk: count, sum, min, max, counter. Native histograms keep counter, count, sum. Adds storage rather than saving it unless raw retention is shortened. | V |
| VictoriaMetrics | keep last sample per interval; same mechanism as dedup | V |
| ClickHouse | plans downsampling as "compaction rather than coarser copies" | V |
| Recording rules / ingest-time aggregation | M3 Aggregator, Chronosphere shaping, VictoriaMetrics stream aggregation, Mimir rules | T |
| Sketches | Datadog DDSketch as a first-class type; OTel exponential histograms and Prometheus native histograms are mergeable relative-error sketches across series and time, so they downsample without an extra sketch type | V (Datadog), T |
| Staleness | Prometheus writes a special NaN "stale marker" and uses a 5 min lookback; OTLP has a no-recorded-value flag instead | T |
| Out-of-order | Prometheus OOO head + WBL with a configured window; VictoriaMetrics accepts anything within retention; LSM-style stores get OOO for free | T / V |
| Dedup | HA-pair dedup at the distributor (Cortex/Mimir HA tracker), query-time by replica label (Thanos), compaction-time "penalty" or one-to-one (Thanos), interval-based (VictoriaMetrics) | T / V |

### 6.8 Serving the most recent minutes

| System | Mechanism | Durability of the hot tail |
|---|---|---|
| Prometheus / Cortex / Mimir classic | in-memory head in ingesters, WAL on local disk, RF 3 | replicas + WAL |
| Mimir 3.0 | Kafka is the durable log; ingesters replay it and serve reads; typically <1 s ingestion delay; optional offset-based read-your-writes | Kafka [V] |
| Thanos | sidecar proxies queries to Prometheus for the last ~2 h; "can lose up to 2 hours" per VictoriaMetrics' FAQ | local Prometheus [V claim] |
| InfluxDB 3 | WAL file to object storage every 1 s, queryable buffer in memory, Parquet every 10 min | object storage [V] |
| VictoriaMetrics | in-memory parts flushed every 5 s | up to 5 s loss [V] |
| Datadog | Kafka intake → Monocle memtables/LSM for the real-time window | Kafka [V] |
| Husky | writers buffer briefly, upload small fragments, commit to metadata store; compactors merge | object storage [V] |
| ClickHouse TimeSeries | separate "recent samples" table with smaller buckets and a TTL | MergeTree parts [V] |

The pattern for object-storage-native systems is the same: **a durable log or tiny durable files first, a small
queryable buffer, then background merge into the long-term layout.**

---

## 7. Design implications for viz

### 7.1 What actually constrains us

1. **Catalog commits cost money.** Cloudflare's catalog (renamed **Basin Catalog** on 2026-10-01, GA) bills
   $9.00 per million catalog operations; managed compaction is $0.005/GB plus $2.00 per million objects. [V]
   One Iceberg commit per tenant per flush does not scale to many tenants; commits must be batched.
2. **Managed compaction is generic.** Target file size is 64–512 MB; the docs do not say whether it sorts or
   honours the table sort order. [V] Our layout depends on sort order, so assume viz runs its own compaction
   until proven otherwise.
3. **Isolate memory (~128 MB) bounds row-group size for writers and readers.** A writer must flush a row group
   long before it holds 128 MB; a reader must be able to work page by page.
4. **A wide or dynamic schema is the enemy.** Footer size and parse cost scale with columns × row groups, and
   one Iceberg table has one schema. Labels-as-columns (parquet-common) does not transplant.
5. **Stateless readers cache badly** (Cortex's lesson). Footers and page indexes should be cached (Cache API,
   or a Durable Object per table/partition holding parsed metadata), or summarised in a sidecar index.
6. **Bytes are cheap, requests and scanned bytes are not.** Design for few, coalescible range reads.

### 7.2 Recommended schema

Types are Iceberg v2-compatible on purpose (no Variant, no nanosecond timestamps) because v3 support in Basin
is unconfirmed.

**`metrics_series`** — the index. One row per series per tenant per day in which it had samples.

| Column | Type | Encoding hint | Purpose |
|---|---|---|---|
| `tenant_id` | string | dict | partition |
| `day` | date | | partition |
| `metric_name` | string | dict | first sort key; UTF-8 as received |
| `series_id` | long | plain | xxhash64 of the canonical sorted label set including name |
| `job`, `instance`, `namespace`, `cluster`, `pod`, `container`, `le`, … (≈12 fixed promoted labels) | string, nullable | dict | pushdown for the hot matchers |
| `labels` | map<string,string> | dict keys and values | complete label set (source of truth) |
| `metric_type` | string | dict | counter, gauge, histogram, summary, native histogram, unknown |
| `unit` | string | dict | |
| `temporality` | string | dict | cumulative or delta |
| `first_ts`, `last_ts` | timestamptz | | liveness within the day |

- Partition: `identity(tenant_id), identity(day)`. Sort: `metric_name, job, instance, series_id`.
- Bloom filter on `series_id`; page index on `metric_name`.
- Coarser copies for the rollup tiers (per week or month) so a one-year query does not open 365 partitions.

**`metrics_samples`** — raw float samples.

| Column | Type | Encoding hint | Notes |
|---|---|---|---|
| `tenant_id` | string | dict | partition |
| `metric_name` | string | dict | sort 1 |
| `series_id` | long | dict (RLE runs) | sort 2 |
| `ts` | timestamptz (ms precision) | DELTA_BINARY_PACKED | sort 3; partition source via `day(ts)` |
| `value` | double, nullable | BYTE_STREAM_SPLIT + zstd; ALP when implementations mature | null when `stale` |
| `stale` | boolean | RLE | explicit staleness marker instead of a NaN payload that a generic engine might canonicalise |
| `start_ts` | timestamptz, nullable | dict/RLE | start timestamp; constant between resets so nearly free |

- Partition: `identity(tenant_id), day(ts)`. Sort order: `metric_name, series_id, ts`.
- Five to seven columns, so footers stay tiny regardless of tenant label diversity.

**`metrics_histograms`** — native histograms and NHCB, same keys and sort, with `schema`, `zero_threshold`,
`zero_count`, `count`, `sum`, positive and negative spans and bucket lists, `custom_bounds`, reset hint. Convert
classic histograms to NHCB at ingest where the sender allows it; this is the direction Prometheus and RW2 are
taking and it removes the per-bucket series explosion.

**`metrics_rollup_5m`, `metrics_rollup_1h`** — one row per series per bucket:
`tenant_id, metric_name, series_id, bucket_ts, count, sum, min, max, last, last_ts, resets, start_ts`.
`last` preserves exact PromQL semantics for counters and instant selectors (VictoriaMetrics' approach);
`min/max/sum/count` serve the `*_over_time` family (Thanos' approach); `resets` plus `last` reconstruct
counter increase across buckets.

**`metrics_exemplars`** — `tenant_id, metric_name, series_id, ts, value, trace_id, span_id, labels`;
same partitioning and sort.

**`metrics_label_index`** (derived at compaction, optional but cheap) —
`tenant_id, day, label_name, label_value, metric_name, series_count`, sorted by `label_name, label_value`.
Serves `/labels`, `/label/<n>/values` and a cardinality explorer without touching the series table's map column.

### 7.3 File and page sizing [E]

| Parameter | Value | Reason |
|---|---|---|
| Compacted file size | 64–128 MB | within Basin's allowed range; small enough to produce from a bounded, streaming k-way merge |
| Row group | 16–32 MB compressed (≈5–10 M sample rows) | writer memory bound; keeps `series_id` dictionaries under ~1 MB |
| Data page | ~20,000 rows (≈50 KB compressed) | a series-day (5,760 rows at 15 s) sits in one or two pages |
| Column index + offset index | always | page-level selection by `metric_name` and `series_id` |
| Bloom filters | `series_id` in the series table only | samples are located by sort order, not bloom |
| Compression | zstd level 3 for compacted, level 1 for flush files | CPU budget at ingest |
| Files split by | `metric_name` key ranges | Iceberg file-level bounds prune to 1–2 files per metric per day; no hash bucketing needed |

### 7.4 Compaction, downsampling, retention

| Level | Produced | Contents | Sort | Lifetime |
|---|---|---|---|---|
| L0 | every 10–60 s or ~8–16 MB per ingest shard (Durable Object) | whatever arrived, any timestamps | `metric_name, series_id, ts` | until merged |
| L1 | hourly, per tenant | merge of the hour's L0 files, exact-duplicate removal on `(series_id, ts)` | same | until daily merge |
| L2 | daily, after `day end + out-of-order window` | merge of 24 hourly sets, key-range split into 64–128 MB files; also writes the day's `metrics_series`, `metrics_label_index` and the 5 m and 1 h rollups | same | raw retention |

- **Compaction jobs must be small and idempotent.** Split each merge by `metric_name` key range so that one
  task reads one range from each input and writes one output file. That fits Worker CPU and memory limits and
  makes retries safe. Commit all outputs of a tenant-day in one Iceberg commit.
- **Out-of-order**: accepted up to a per-tenant window (default 1–2 h). Late rows simply land in a new L0 file
  in the correct day partition. A partition that receives data after its rollup is marked dirty and its
  rollup task re-runs.
- **Dedup**: HA-replica election at ingest (per-tenant Durable Object, Cortex-style tracker); exact-duplicate
  removal at L1; query-time last-write-wins for anything still uncompacted. RW2 requires idempotent
  receivers, and this gives it. [V for the requirement]
- **Retention tiers** (defaults, per tenant): raw 30 d, 5 m 13 months, 1 h multi-year. Because partitions are
  `(tenant, day)`, expiry is a metadata-only file drop, never a rewrite.
- **Resolution selection at query time**: follow Thanos — pick the coarsest tier whose resolution is at most
  about one fifth of the query step, and never answer `rate(x[r])` from a tier coarser than `r`.

### 7.5 Hot path

- Ingest Worker validates and routes to a per-tenant (or tenant-shard) Durable Object, which appends to its
  durable storage (the WAL) and acknowledges.
- The Durable Object flushes L0 Parquet to R2 on a size or time trigger and records the file in a small L0
  manifest it owns. A coordinator batches many L0 files across tenants into **one Iceberg commit per minute or
  so**, keeping catalog operations bounded.
- Queries for recent time read: Iceberg snapshot ∪ uncommitted L0 manifest ∪ (optionally) the Durable Object's
  unflushed tail by RPC. Start without the third; a 10–30 s freshness lag is acceptable for most alerting, and
  it can be added later without changing storage.
- An idle tenant costs nothing: no Durable Object running, no files written, no commits.

### 7.6 Query path sketch

1. Plan from Iceberg metadata: partitions by tenant and day, then files by `metric_name` bounds.
2. Resolve matchers against `metrics_series` for the days in range, reading only `metric_name` pages, promoted
   columns named in matchers, and the map only when a non-promoted label is matched. Output: `series_id` set
   and labels.
3. For each sample file, fetch the tail (footer + page indexes) once and cache it; compute page ranges for
   `(metric_name, series_id ∈ set)`; issue coalesced range reads for `ts` and `value`.
4. Fan out by file or by `series_id` range to sub-Workers and push partial aggregation down (the same idea as
   Mimir query sharding and Thanos' distributed engine).

### 7.7 Alternatives and when to pick them

| Alternative | Pick it if | Cost |
|---|---|---|
| **Chunk-blob rows** (shape B): `series_id, window_start, min_ts, max_ts, count, encoding, data` with XOR/XOR2 or histogram chunks, 2 h windows | the benchmark shows flat rows cost more than ~2× in bytes fetched or decode CPU, or native histograms prove awkward as columns | not readable by SQL engines; needs a chunk codec in the Worker (a Rust `rusty-chunkenc` crate exists); merges re-encode |
| **Typed-array window rows** (shape C) | we want per-window aggregates beside raw data and fewer rows, while staying SQL-readable | generic compaction will not merge windows; no encoding gain over flat |
| **Time bucket in the sort key** `(metric_name, bucket_6h(ts), series_id, ts)` | narrow-range queries on old days turn out to be common | 4 runs per series per day; slightly worse timestamp compression |
| **Labels inline, no series table** | never for viz | label APIs scan sample files; map repeated per row |
| **Per-tenant promoted "slots"** (`p1..p8` with a per-tenant name mapping) | large tenants have hot labels outside the fixed set | mapping must be versioned per partition; harder to reason about |
| **Table per tenant** | a tenant is large enough to need its own compaction cadence, or needs hard isolation | more catalog objects and commits; decide in the tenancy design |
| **Managed (Basin) compaction** | it is confirmed to preserve sort order | $0.005/GB; less control over file splitting |

### 7.8 Rough storage cost [E]

For 1 M active series at a 15 s interval: 5.76 billion samples/day.

| Tier | Bytes per raw sample | GB/day | 30-day GB |
|---|---|---|---|
| Raw, compacted, flat rows | 2.5 | 14.4 | 432 |
| Raw, chunk-blob alternative | 1.4 | 8.1 | 242 |
| 5 m rollup | ~0.6 | 3.5 | 104 |
| 1 h rollup | ~0.06 | 0.35 | 10 |
| Series table + label index | ~0.01 | 0.05 | 1.5 |

At R2 standard storage pricing of roughly $0.015/GB-month [T], the flat-row raw tier for 30 days is about
$6.50/month and the difference between the two row shapes is under $3/month per million active series. That
is why this document recommends optimising for simplicity and read cost first.

---

## 8. Open questions / unverified

1. **No measured bytes/sample or query latency for any viz layout.** Build a benchmark from a real Prometheus
   block: flat rows (BYTE_STREAM_SPLIT vs ALP) versus chunk-blob rows; measure bytes, range-read count and
   WASM decode CPU for a single-series query, a 10k-series aggregation, and a label-values call.
2. **Does Basin Catalog compaction preserve the Iceberg sort order?** The docs do not say. If not, managed
   compaction must stay off for metrics tables.
3. **Iceberg spec version and feature support in Basin** (v3, Variant, deletion vectors, sort-order metadata,
   commit rate limits, table-count limits). Not found in the changelog.
4. **ALP in Parquet** is Preview. Which writer and reader libraries usable from Workers (Rust to WASM, or JS)
   implement it, and do Basin SQL and other engines read it?
5. **Workers limits** (memory, CPU time per invocation, subrequest count) were not re-verified this session.
6. **PromCon 2025 Parquet numbers** (80–90% faster, 70% less memory, 90% fewer range requests) are from an
   unopened third-party recap; baseline unknown. The slides or recording should be checked.
7. **Shopify's Parquet/Thanos results** were not retrievable (video only).
8. **Mimir's Parquet direction** is inferred from PR titles, not from a statement.
9. **XOR2 compression ratio**: no published figure found.
10. **Delta temporality**: store OTLP deltas natively (and teach the query layer) or convert to cumulative at
    ingest (stateful)? Prometheus itself has two competing experimental flags.
11. **`series_id` width and locality**: 64-bit hash scoped by tenant and metric is collision-safe at realistic
    sizes [E], but a locality-preserving id (e.g. prefix from `job`/`service`) may compress better. Measure.
12. **NaN handling**: confirm that every writer and compactor in the path preserves or avoids NaN payloads;
    the explicit `stale` column is a hedge.
13. **Training-knowledge sections** (VictoriaMetrics part format and bytes/sample, M3, Monarch, Honeycomb,
    Chronosphere, QuestDB, SigNoz schema, GreptimeDB sparse primary key, Prometheus TSDB internals, R2 price)
    should be spot-checked before being quoted in a design document.
14. **Freshness target for alerting**: is 10–30 s lag (L0 files only) acceptable, or is the Durable Object
    tail read required from day one?

---

## 9. Sources

Verified this session (fetched):

- Cortex — Parquet-based Storage proposal: https://cortexmetrics.io/docs/proposals/parquet-storage/
- Cortex — Parquet Mode guide: https://cortexmetrics.io/docs/guides/parquet-mode/
- Cortex — issue #6940 "Support Parquet Store Gateway": https://github.com/cortexproject/cortex/issues/6940
- Cortex — issue #7140 (hybrid mode): https://github.com/cortexproject/cortex/issues/7140
- Cortex — PR #6712 (proposal discussion, 20:1 overfetch comment): https://github.com/cortexproject/cortex/pull/6712
- parquet-common README: https://github.com/prometheus-community/parquet-common
- parquet-common `schema/schema.go`: https://raw.githubusercontent.com/prometheus-community/parquet-common/main/schema/schema.go
- parquet-common `schema/schema_builder.go`: https://raw.githubusercontent.com/prometheus-community/parquet-common/main/schema/schema_builder.go
- parquet-common `convert/convert.go`: https://raw.githubusercontent.com/prometheus-community/parquet-common/main/convert/convert.go
- Prometheus Parquet working group: https://github.com/prometheus-community/parquet-wg
- thanos-parquet-gateway README: https://github.com/thanos-io/thanos-parquet-gateway
- thanos-parquet-gateway `schema/schema.go`: https://raw.githubusercontent.com/thanos-io/thanos-parquet-gateway/main/schema/schema.go
- cloudflare/parquet-tsdb-poc: https://github.com/cloudflare/parquet-tsdb-poc
- Thanos project updates, Feb 2026: https://thanos.io/blog/2026-02-19-thanos-project-updates/
- Thanos issue #8285 (Parquet tracking): https://github.com/thanos-io/thanos/issues/8285
- Thanos compactor docs (downsampling, retention, halting): https://thanos.io/tip/components/compact.md/
- Grafana Mimir PRs mentioning Parquet: https://github.com/grafana/mimir/issues?q=parquet
- Grafana Mimir PR #13362: https://github.com/grafana/mimir/pull/13362
- Grafana — Mimir next-gen architecture (Kafka): https://grafana.com/blog/mimir-s-next-gen-architecturekafka-in-the-middle-object-storage-underneath-and-a-whole-lot-less-coupling
- Grafana Mimir — ingest storage architecture docs: https://grafana.com/docs/mimir/latest/get-started/about-grafana-mimir-architecture/about-ingest-storage-architecture/
- PromCon EU 2025 talk page: https://promcon.io/2025-munich/talks/beyond-tsdb-unlocking-prometheus-with-parquet-for-modern-scale/
- PromCon EU 2025 recap (Gardener): https://gardener.cloud/blog/2025/11/11-13-promcon-eu-2025/
- PromCon EU 2025 recap (Talk::Overflow): https://talkoverflow.substack.com/p/talkoverflow-22-promcon-eu-2025
- Prometheus CHANGELOG (3.8–3.16): https://raw.githubusercontent.com/prometheus/prometheus/main/CHANGELOG.md
- Prometheus feature flags (3.12): https://prometheus.io/docs/prometheus/3.12/feature_flags/
- Prometheus PR #18062 (st-storage, XOR2): https://github.com/prometheus/prometheus/pull/18062
- Remote Write 2.0 spec: https://prometheus.io/docs/specs/prw/remote_write_spec_2_0/
- Apache Parquet encodings (incl. ALP): https://raw.githubusercontent.com/apache/parquet-format/master/Encodings.md
- DataFusion — external Parquet indexes: https://datafusion.apache.org/blog/2025/08/15/external-parquet-indexes/
- Polar Signals — From Parquet to Vortex: https://blog.polarsignals.com/blog/posts/2025/11/25/interface-parquet-vortex
- InfluxDB 3 Enterprise storage engine: https://docs.influxdata.com/influxdb3/enterprise/reference/internals/storage-engine/
- InfluxDB 3 Core durability: https://docs.influxdata.com/influxdb3/core/reference/internals/durability/
- GreptimeDB metric engine: https://docs.greptime.com/contributor-guide/datanode/metric-engine
- GreptimeDB and Prometheus 3: https://greptime.com/blogs/2026-05-09-prometheus-3-and-greptimedb
- ClickHouse — Introducing PromQL: https://clickhouse.com/blog/introducing-promql
- ClickHouse TimeSeries engine docs: https://clickhouse.com/docs/engines/table-engines/special/time_series
- Datadog — Rust timeseries engine (Monocle): https://www.datadoghq.com/blog/engineering/rust-timeseries-engine/
- Datadog — Timeseries indexing at scale: https://www.datadoghq.com/blog/engineering/timeseries-indexing-at-scale/
- Datadog — Introducing Husky: https://www.datadoghq.com/blog/engineering/introducing-husky/
- VictoriaMetrics single-node docs: https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/
- VictoriaMetrics FAQ: https://docs.victoriametrics.com/victoriametrics/faq/
- Cloudflare R2 Data Catalog / Basin Catalog: https://developers.cloudflare.com/r2/data-catalog/
- Cloudflare catalog changelog: https://developers.cloudflare.com/changelog/product/r2-data-catalog/
- Cloudflare table maintenance: https://developers.cloudflare.com/r2/data-catalog/table-maintenance/
- Cloudflare catalog pricing: https://developers.cloudflare.com/r2/data-catalog/platform/pricing/

Found but not opened (unverified):

- PromCon Parquet talk recap with numbers (host blocked): https://tldrecap.tech/posts/2025/promcon-eu/prometheus-parquet-query-performance/
