# 05 — Apache Iceberg + Parquet for streaming observability data on Cloudflare

Research date: 2026-11-18. Audience: viz designers.

**Web access note.** WebFetch worked throughout. WebSearch worked for the first ~20 queries and then hit the shared per-turn search budget, so several topics could not be searched. Evidence labels used below:

- **[V]** verified this session against a fetched page (source listed at the end).
- **[V2]** verified only against a secondary source (vendor blog, community explainer, search-result summary).
- **[T]** training knowledge (cutoff mid-2026), not re-verified today. Treat as a hypothesis to check.

Topics that are mostly [T] because the search budget ran out: DataFusion-in-WASM sizes, iceberg-rust WASM blockers in detail, Lance/Vortex/Nimble/F3 current status, DuckLake data inlining, Tansu/Moonlink/Bufstream/WarpStream internals, Delta/Hudi/Paimon specifics, most Parquet tuning defaults.

---

## 0. Executive summary

1. **Cloudflare's lakehouse stack was renamed "Basin" and went GA on 2026-10-01** [V]: R2 Data Catalog → Basin Catalog, R2 SQL → Basin SQL, Pipelines → Basin Pipelines. Old names and APIs still work. Basin Catalog has managed compaction (64–512 MB target, default 128 MB), snapshot expiration (default 30 days / retain last 5), and manifest consolidation. **Iceberg v3 is listed as "planned"** for Pipelines and Basin SQL, so design for **format v2 today**, v3-ready.
2. **Iceberg v4 is not real yet** [V2]: single-file commits, adaptive metadata tree, Parquet manifests, column-stats overhaul are proposals; spec draft targeted late 2026, production late 2027 at the earliest. Do not design around it. Iceberg Java 1.11 (2026-05-19) and 1.12 only contain v4 groundwork types.
3. **A v2 commit writes at least 3 metadata objects and rewrites metadata.json in full**, so commit cadence is bounded by metadata growth, not by the catalog. Practical range is 1–5 minutes per table. Basin Pipelines itself enforces a **60 s minimum roll interval "to prevent compaction conflicts"**, default 300 s [V]. Sub-minute freshness must come from a hot tier outside Iceberg.
4. **Catalog operations cost $9 per million after 1M free/month** [V]. That makes table-per-tenant expensive at the low end and argues for a few shared tables with a single committer per table, and for keeping the catalog off the query path.
5. **In Workers, the pure-JS stack is the pragmatic choice**: hyparquet (14 KB gz, async range reads, page index, bloom filters, ALP) + hyparquet-writer (bloom filters, column/offset index, delta and byte-stream-split encodings, variant shredding) + icebird (~32 KB; reads v1/v2/v3, experimental v2/v3 writes, REST catalog, manifest merging, rewrite, expire) [V]. **iceberg-rust has no WASM support** (issue closed "not planned" by stale-bot 2026-10-07) and still lacks RewriteFiles/RowDelta/Overwrite as of 0.10 [V]. DuckDB fits the 64 MiB bundle cap (49.6 MiB uncompressed Workers build) but leaves little of the 128 MB isolate [V].
6. **Planning can be held to about 3–5 subrequests** if viz (a) has its committer Durable Object publish the current snapshot pointer so queries skip the catalog, (b) keeps manifests aligned to day partitions and caches them as immutable objects, and (c) writes a per-partition "footer bundle" sidecar so queries do not fetch one Parquet footer per file. Cloudflare's own engine does (c) in spirit: the coordinator ships serialized Parquet metadata to workers so they never fetch footers [V].

---

## 1. Iceberg spec versions

### 1.1 v2 (what viz should write today)

[T] v2 is the universally supported baseline: sequence numbers, row-level deletes (position and equality delete files), hidden partitioning, partition and schema evolution, sort orders, snapshot refs (branches/tags). Timestamps are microsecond precision. No variant type; semi-structured data must be a string, a `map<string,string>`, or a struct.

### 1.2 v3 (ratified 2025; engine support still uneven)

[T] for the feature list, [V]/[V2] for implementation status:

| Feature | What it is | Relevance to viz | Status notes |
|---|---|---|---|
| Variant + shredding | Binary semi-structured type; shredded sub-columns get typed Parquet columns and stats | High: log/span attributes | Parquet announced native Variant Feb 2026 [V2]. Spark 4.0/4.1 write shredded variant in Iceberg 1.11 [V]; Flink, Kafka Connect and generic writers shred in 1.12 [V2]. hyparquet-writer writes VARIANT with shredding [V]. Basin: "planned" [V]. |
| Deletion vectors | Roaring bitmap per data file, stored as a `deletion-vector-v1` Puffin blob; replaces position delete files | Low: viz is append-only | iceberg-rust 0.11 reads DVs [V2]; icebird reads and writes DVs [V]. Trino read/write, DV-aware compaction incomplete [V2]. |
| Row lineage | `_row_id`, `_last_updated_sequence_number` | Low | iceberg-rust 0.11 and icebird materialize them [V/V2]. |
| Default values | `initial-default` / `write-default` for added columns | Medium: cheap schema evolution | [T] |
| Nanosecond timestamps | `timestamp_ns`, `timestamptz_ns` | Medium: OTLP is nanosecond | Parquet side universally supported [V]. In v2 use microseconds plus an optional `nanos_remainder` int column, or an int64 column for raw nanos. |
| Geometry / geography | WKB logical types | None | Wired through Iceberg 1.12 [V2]. |
| Multi-argument transforms, unknown type, encryption keys | | Low | [T] |

**Basin Catalog and v3.** The GA post lists "Iceberg V3/Variant" as planned for Pipelines and "VARIANT and geospatial types" as planned for Basin SQL; it does not mention deletion vectors, and no doc page states a supported format version [V]. I could not confirm whether the catalog itself accepts `format-version: 3` tables from external writers. Assume v2 only until tested.

### 1.3 v4 proposals

All [V2] (community explainers from Aug–Sep 2026; the Snowflake summit recap returned 403):

- **Single-file commits + adaptive metadata tree.** A "root manifest" replaces the manifest list and can hold data-file entries inline; small commits write one metadata node plus a catalog pointer swap. Goal: per-commit metadata I/O drops from O(manifests) to O(1). Today a commit writes at least metadata.json + manifest list + one manifest.
- **Parquet manifests** instead of Avro, enabling column-projected manifest reads. Contested on planning memory.
- **Column stats overhaul** ("content stats"): typed, columnar per-file stats instead of the `map<int, bytes>` bounds; partition tuple folded into stats. Least mature; earliest Q1 2027.
- **Relative paths** (could ship before v4), **column families**, Delta 5.0 convergence on the same tree.
- **Timeline:** spec draft late 2026, experimental implementations mid-2027, production late 2027 at the earliest. Iceberg 1.11 added `TrackedFile`, `TrackingInfo`, `ContentInfo`, `ManifestStats` types and 1.12 adds Parquet/Avro manifest writers for v4, but "no V4 tables yet" [V/V2].

Implication: v4 will eventually make minute-level (or faster) commits cheap. Until then, viz must absorb the commit cost by batching.

---

## 2. Metadata tree and query-planning cost

### 2.1 Structure

[T] `catalog pointer → metadata.json → manifest list (Avro, one per snapshot) → manifests (Avro) → data files`. The manifest list carries, per manifest, partition-field summaries (lower/upper bound, contains-null) and added/existing/deleted counts. Each manifest entry carries the partition tuple, record count, file size, and per-column value counts, null counts, lower and upper bounds, plus `split_offsets` (row-group offsets) and optional `sort_order_id`.

### 2.2 Object reads per plan (client-side planning)

| Step | Requests | Notes |
|---|---|---|
| Load table | 1 REST call | With a REST catalog the `loadTable` response embeds the full table metadata, so there is no separate metadata.json GET [T]. Iceberg 1.11 added ETag-based loads returning 304 when unchanged [V]. Each call is a billed catalog operation on Basin ($9/M after 1M free) [V]. |
| Manifest list | 1 GET | Immutable per snapshot. |
| Manifests | M GETs, M = manifests surviving partition-summary pruning | Immutable; cache forever by path. |
| Parquet footers | 1 range GET per surviving data file | Only needed for row-group/page pruning; file-level pruning uses manifest stats. |
| Page index / bloom filter | 0–2 range GETs per file | Only for selective predicates. |

So the floor is **3 requests + one per data file**. The R2 SQL deep dive describes exactly this walk and adds two refinements: planning is streamed (work units emitted as found) and manifests are visited in ORDER BY-friendly order to allow top-k early termination [V].

### 2.3 What inflates planning

- **metadata.json size.** It lists every retained snapshot and is rewritten on every commit. A secondary source estimates ~500 KB at ~2,000 retained snapshots and >25 MB at 100,000 [V2]. At one commit per minute, Basin's default expiration (30 days, retain 5) retains ~43,000 snapshots: a multi-megabyte JSON on every `loadTable`, which is hostile to a 128 MB isolate. Mitigations: aggressive snapshot expiration (hours to a day), and the REST `snapshots=refs` load option [T].
- **Manifest count.** Fast-append adds one manifest per commit. Without merging, a day of minute commits gives 1,440 manifests. Basin Catalog advertises manifest consolidation and clustering by partition [V]; icebird merges manifests on commit and has `icebergRewriteManifests` [V].
- **Per-column stats on wide schemas.** Bounds for every column in every entry bloat manifests. Limit with `write.metadata.metrics.default=truncate(16)` and per-column `none`/`counts` modes [T].

### 2.4 Manifest caching

Manifests and manifest lists are immutable and content-addressed by path, so they are ideal for the Workers Cache API or an in-DO LRU, with no invalidation logic. Only the "current snapshot" pointer is mutable.

### 2.5 Server-side scan planning (REST)

- Finalized in the Iceberg 1.11 cycle [V/V2]. Endpoints: `POST .../tables/{t}/plan`, `GET .../plan/{plan-id}`, `DELETE` to cancel, `POST .../tasks` to page through large plans. Request carries `snapshot-id`, `select`, `filter` (JSON expression), `min-rows-requested`. Response returns `file-scan-tasks` with data file, delete files and residual filter.
- Implementers named: Gravitino (with plan cache), Unity Catalog, Snowflake Horizon; Polaris partial. Clients: Java 1.11, PyIceberg 0.11; iceberg-rust has an open PR; iceberg-go and DuckDB not yet [V2].
- **Cloudflare/Basin Catalog is not mentioned by any source as implementing it**, and the Basin docs index has no page for it [V]. Clients must check `GET /v1/config` for advertised endpoints and fall back.
- For viz this would be the ideal "one subrequest" plan, but it returns file-level tasks only (no row-group pruning) and adds a billed catalog call per query. Treat as a future optimization, not a dependency.

---

## 3. Commit protocol, concurrency, and cadence

### 3.1 Mechanics

[T] Writers stage data files, write new manifest(s) and a manifest list, then ask the catalog to atomically swap the table's current metadata. With REST, the client sends `POST .../tables/{t}` containing `requirements` (for example `assert-ref-snapshot-id` on `main`) and `updates` (`add-snapshot`, `set-snapshot-ref`); the catalog writes the new metadata.json and returns 409 on a failed requirement. The loser re-reads metadata, rebases (for appends: re-writes only the manifest list and re-submits; data files and its own manifest are reusable), and retries. Iceberg 1.11 added an `Idempotency-Key` header so retried commits do not double-apply [V].

### 3.2 Why frequent commits hurt

- Each attempt re-pays the manifest-list and metadata.json rewrite; under contention writers can spend more time reconciling than writing [V2].
- Collision probability scales with writers × commit rate. Appends never logically conflict, but they still serialize on the pointer.
- Maintenance (compaction, expiration) is another writer. Basin Pipelines sets a **60 s minimum roll interval specifically to avoid compaction conflicts** [V]. Rewrites that lose a race must be redone; icebird does not retry rewrites or upserts on conflict [V].
- Write amplification: ~565 KB of metadata per commit on a young table, >25 MB on a table with 100k retained snapshots, regardless of data size [V2].

### 3.3 Practical cadence observed in the ecosystem

| System | Cadence | Evidence |
|---|---|---|
| Basin Pipelines Iceberg sink | default 300 s, minimum 60 s; roll size and row-group size configurable; zstd default | [V] |
| Flink sink | checkpoint-aligned, typically 10–60 s; end-to-end 10 s–2 min | [V2] |
| Spark Structured Streaming | one commit per trigger, 20 s–15 min | [V2] |
| Kafka Connect sink | minutes (5 min typical) | [V2] |
| Firehose → S3 Tables | tens of seconds to minutes | [V2] |
| Redpanda Iceberg Topics, Confluent Tableflow, WarpStream Tableflow | "minutes class" | [V2] |
| General guidance | commit every 1–5 min, 32–128 MB per commit, compaction every 30–60 min | [V2] |

### 3.4 Streaming-ingest patterns

- **Engine sinks (Flink, Kafka Connect, RisingWave)** [T]: buffer per checkpoint, write Parquet per partition, a single committer operator commits. RisingWave adds its own compaction and exactly-once sink.
- **Broker-native tables (Redpanda Iceberg Topics, Confluent Tableflow, WarpStream Tableflow, Bufstream, AutoMQ table topics, StreamNative Ursa)** [V2/T]: the log itself is periodically materialized to Parquet and committed; the broker also runs expiration/compaction. Bufstream and Ursa aim at "zero-copy" where the stored segment is the Parquet file.
- **Tansu** [T]: stateless Rust Kafka-compatible broker with pluggable storage that can write topics as Iceberg/Delta tables using a schema registry.
- **Moonlink (Mooncake Labs)** [T]: Rust ingestion engine that keeps an in-memory Arrow buffer with an index, flushes Parquet with deletion vectors, commits to Iceberg on an interval, and serves a **union read** of committed plus buffered state so readers get sub-second freshness.
- **SlateDB-based designs** [T]: an LSM on object storage acts as WAL/hot tier; SSTs are later converted to Parquet and committed.
- **Stream-table federation / union read** [V2]: query layer unions the uncommitted tail with committed Iceberg data; described as promising but young, with AutoMQ cited.

The common shape, and the one viz should copy: **durable buffer → immutable Parquet objects → low-frequency Iceberg commit → background compaction**, with the query layer unioning the not-yet-committed tail.

### 3.5 Small files and compaction

- File count is `commits × partitions touched × writers`. 60 s commits over 24 hourly partitions = 1,440 files/day; 50 partitions at 30 s is >1M files/week [V2].
- Strategies [T]: **bin-pack** (concatenate small files to target size; cheapest), **sort** (rewrite with a global sort order within the rewritten group; restores clustering so min/max and page indexes prune well), **z-order / Hilbert** (multi-dimensional clustering; Iceberg 1.12 adds Hilbert to Spark's `rewrite_data_files` [V2]). For observability, a linear sort on `(tenant, service|metric, time)` beats z-order because queries almost always pin the leading keys.
- **Basin Catalog compaction** [V]: automatic, target 64–512 MB (default 128 MB; guidance 64–128 latency-sensitive, 128–256 streaming, 256–512 OLAP), Parquet only, output prefixed `compacted-`, manual queueing with a daily request limit. A sort/clustering method is **planned**, which implies today's compaction is bin-pack and may not preserve sort order, bloom filters or page-size choices (unverified). Pricing: $0.005/GB processed + $2 per million objects, 10 GB and 1M objects free monthly.
- **Snapshot expiration** [V]: Basin default older-than 30 days and retain-last 5 (both must hold); units down to seconds; removes unreferenced data files; free.
- **Orphan files** [V]: Basin does **not** clean files never referenced by a snapshot. viz must delete failed-commit leftovers itself (easy if the committer DO tracks every object it wrote).
- **Manifest rewriting** [V]: Basin reports a manifest-rewrite metric and "manifest consolidation and clustering by partition"; no knobs documented.

### 3.6 Partitioning, sort orders, retention

[T] unless marked.

- **Transforms:** `identity`, `bucket(N)`, `truncate(W)`, `year/month/day/hour`, `void`. Hidden partitioning means queries filter on `ts` and the planner derives partition predicates; no partition columns leak into SQL.
- **Evolution:** a spec change is metadata-only; old files keep the old spec and planning handles both. viz can start with `day(ts)` and move a hot table to `hour(ts)` without rewriting.
- **Over-partitioning is the main risk.** `tenant × hour` multiplies small files and manifest entries. Prefer coarse time partitions plus an in-file **sort order** on tenant and series keys; file-level min/max in manifests and page indexes then do the tenant pruning.
- **Sort order** is advisory metadata plus writer behaviour; nothing enforces it. Compaction must honour it or clustering decays.
- **Retention:** deleting with a predicate that aligns to whole partitions is a metadata-only delete (files are dropped from manifests; data removed at snapshot expiration). Basin docs confirm partition-aligned deletes are the fast path [V]. Per-tenant retention does not align to time partitions in a shared table; see §4.

---

## 4. Multi-tenancy

| Model | Pros | Cons |
|---|---|---|
| **Table per tenant** | Trivial isolation, retention, deletion, per-tenant schema; no noisy-neighbour in planning | Commits and maintenance scale with tenant count. At one commit/min a table makes ~43,800 commits/month; with three signals that is ~131k catalog ops ≈ **$1.18/tenant/month in commit calls alone** at $9/M (computed from [V] pricing), before `loadTable` calls and compaction object charges. Thousands of tiny tables also mean thousands of tiny files that never reach compaction targets. Basin table/namespace limits are undocumented [V]. |
| **Namespace per tenant** | Clean naming and (future) authorization boundary; Basin plans finer namespace/table auth [V] | Same cost profile as table-per-tenant. |
| **Shared tables, tenant as sort key (optionally `bucket(N, tenant_id)`)** | One commit stream per signal: 3 tables × 43,800 commits ≈ 131k ops/month total, inside the 1M free tier. Files fill to target size. One compaction stream. | Isolation is logical (must be enforced in the query layer). Per-tenant deletion and retention need rewrites or a retention-class dimension. A huge tenant can dominate files. |

Recommended hybrid: **shared tables per signal and retention class**, partitioned by `day(ts)`, sorted by `tenant_id` first; **graduate large tenants** to dedicated tables (or a dedicated bucket-partition) when their volume would fill 128 MB files on their own. Retention classes (for example 7/30/90/400 days) as separate tables or as an identity partition field make retention a pure partition drop. Tenant offboarding in a shared table is a copy-on-write rewrite of the affected files, or simply waits for retention.

---

## 5. Indexes: Puffin, Parquet-level structures

### 5.1 Puffin and Iceberg index proposals

- [T] Puffin is a blob container referenced from table metadata (statistics files). Standard blobs: `apache-datasketches-theta-v1` (NDV per column, for planners) and `deletion-vector-v1`.
- [V2] **Secondary index proposals (dev list, Jan–Mar 2026):** phase 1 is file-skipping **Bloom filter indexes stored in Puffin**, referenced from metadata, advisory and snapshot-bound, evaluated at planning time so files are pruned before being opened; sizing example ~12 KB per data file for ~10,000 values at 1% FPP. Open questions: whether definitions live in table metadata or an index catalog, and whether blooms are "indexes" or "extended stats". A separate vector-index proposal exists. No roadmap dates; nothing shipped. Iceberg 1.11 did ship a Content Stats API and a Partition Stats Scan API [V].
- Implication: there is no standard planning-time secondary index for viz to use. A viz-private sidecar (which can be a Puffin file for forward compatibility) is the realistic route.

### 5.2 Parquet structures (mostly [T]; implementation support [V])

- **Footer (FileMetaData, Thrift):** schema, row groups, per-column-chunk offsets, sizes, encodings, min/max/null-count stats. Must be parsed whole; size grows with columns × row groups. A footer redesign working group is active (FlatBuffers replacement, or a byte-offset directory that keeps Thrift); neither has shipped [V2].
- **Page index** = ColumnIndex (per-page min/max/null counts) + OffsetIndex (page offsets, first row index). Stored near the footer, read separately. Enables page-level pruning and, with sorted data, reading a few pages out of a column chunk. Supported by arrow-rs, parquet-java, hyparquet; DuckDB read-only [V].
- **Bloom filters:** split-block, xxHash, per column chunk; offset and length in column metadata, so a reader fetches it with one range request. Roughly 10 bits per distinct value at 1% FPP. Supported in arrow-rs, parquet-java, DuckDB, hyparquet; hyparquet-writer writes them with `fpp` and `maxBytes` caps [V].
- **Dictionary encoding:** per column chunk, falls back to plain when the dictionary grows too large. Excellent for service names, metric names, severity, attribute keys. Dictionary pages also allow predicate evaluation without decoding data pages.
- **Encodings:** `DELTA_BINARY_PACKED` (timestamps, monotonically increasing ints), `DELTA_LENGTH_BYTE_ARRAY` / `DELTA_BYTE_ARRAY` (strings, prefix-shared strings), `BYTE_STREAM_SPLIT` (floats; improves general-purpose compression), `RLE` (booleans, levels, dictionary indices). All supported by arrow-rs and hyparquet [V]. **ALP** (adaptive lossless floating point) was voted into the format in 2026 and is implemented only in arrow-rs 60 and hyparquet 1.32 so far [V/V2]; do not write it yet because Spark/Trino/DuckDB cannot read it.
- **Compression:** zstd is the default in Basin Pipelines [V]. Level 1–3 for ingest-time files, higher (6–9) for compacted files is the usual trade [T]. hyparquet-writer defaults to Snappy and takes custom compressor functions; the implementation table marks hyparquet zstd as read-only "(R)", so zstd writes need a supplied WASM compressor [V].
- **Nested vs flat:** nested columns cost repetition/definition levels, weaker stats, and poor page-index pruning. Flatten hot attributes into top-level columns; keep the long tail in a map or JSON string (v2) and move to shredded Variant when v3 is available end to end.
- **Sizing for HTTP range reads:** every skipped byte range is free, but every separate range is a subrequest. Smaller pages (tens of KB) help point lookups on sorted keys; larger pages compress better and reduce metadata. Row groups bound decode memory: a reader must hold at least one column chunk (or page run) at a time.

### 5.3 New formats

- **Parquet itself** (format 2.13 in spring 2026 [V2]): Variant and Geometry/Geography announced Feb 2026; ALP accepted; FSST, FIXED_SIZE_LIST, File type and footer redesign in discussion.
- **Lance** (random access, vector indexes, no row groups), **Nimble** (Meta, wide ML schemas), **Vortex** (Linux Foundation, compressed-domain execution, positioned as general successor), **F3** (research format with embedded WASM decoders) [V2 for Lance/Nimble/Vortex descriptions; F3 is [T]].
- **Iceberg support:** Iceberg 1.11 shipped the **File Format API** (FormatModel abstraction; Parquet, ORC, Avro, Arrow implement it) [V]. Vortex integration is in progress and a Lance proof-of-concept PR is open; neither is merged or in the spec's format list [V2]. Basin compaction is Parquet-only [V]. **Parquet is the only viable choice for viz.**

---

## 6. Implementations runnable in Cloudflare Workers

Platform limits [V]: 128 MB per isolate (all plans); CPU 30 s default, up to 5 min on paid; 10,000 subrequests per invocation by default, configurable up to 10M (Feb 2026 change); 6 simultaneous connections waiting for headers (R2 binding calls count); **Worker size 64 MiB uncompressed on all plans** (compressed limit removed Sept 2026); 1 s startup.

| Library | Runs in Workers? | Size | Read | Write | Notes |
|---|---|---|---|---|---|
| **hyparquet** | Yes (pure JS, zero deps) | 14 KB gz [V] | Async range reads, speculative footer fetch, parallel column-chunk ranges, row-group stats pruning; page index, bloom filters, variant, geometry, ALP per the Parquet implementation table [V] | — | zstd/brotli via `hyparquet-compressors` [V2]. No page CRC verification [V]. |
| **hyparquet-writer** | Yes | small; 1 dependency [V] | — | PLAIN, RLE, dictionary (auto, with byte cap), DELTA_BINARY_PACKED, BYTE_STREAM_SPLIT; stats with truncation (default 16 bytes); offset index on by default, column index and bloom filters opt-in; page target 1 MB; `rowGroupSize` default `[1000, 100000]` rows; VARIANT with shredding; kv metadata [V] | No documented incremental row-group streaming API: the whole file is built through a `ByteWriter` [V]. Field IDs (required by Iceberg) not documented in the README; icebird evidently sets them. |
| **icebird** | Yes (built on the two above) | ~32 KB [V] | v1/v2/v3; position/equality deletes and DVs; pruning via manifest-list summaries, file bounds, row-group stats; time travel; REST and file catalogs; SigV4 via Web Crypto for R2 [V] | **Experimental**: append, delete, upsert, create table, schema update, set ref, expire snapshots, `icebergRewrite` (sorted, non-overlapping compaction, v2), `icebergRewriteManifests`, manifest merging on commit [V] | Rewrites/upserts not retried on conflict. 131 stars; single-vendor project. No encryption, no compressed Puffin. R2 Data Catalog not explicitly listed as tested. |
| **squirreling** | Yes | 22 KB gz [V] | Streaming SQL over async generators with late materialization | — | Sort/group/aggregate use a buffered path [V]; not a distributed engine. |
| **arrow-rs `parquet` crate (WASM)** | Yes [T] | roughly 1–5 MB WASM depending on codecs [T] | Full-featured async reader with page index, bloom, row filters, late materialization | `ArrowWriter` flushes row group by row group; memory bounded by one row group [T] | Most complete and fastest; needs a JS↔WASM object-store shim for R2 ranges. `parquet-wasm` packages this for JS [T]. |
| **iceberg-rust** | **No WASM** [V] | — | Native: scans, REST catalog, DV reads and variant in 0.11 (RC stalled in Sept 2026) [V2] | Fast append, schema update, expire snapshots (0.10); **RewriteFiles, RowDelta, Overwrite not yet supported** [V] | WASM issue #1710 closed "not planned" by stale-bot [V]. Blockers are tokio/OpenDAL/reqwest assumptions [T]. |
| **icepick** | Yes (targets Workers + R2 Data Catalog) [V] | not stated | Scan with partition pruning and column stats | Commit existing Parquet files, bin-pack compaction, snapshot cleanup | Experimental, single maintainer; proves the Rust-in-Workers path is workable. |
| **DataFusion (WASM)** | Compiles to wasm32 [T] | tens of MB uncompressed [T] | Full SQL engine | — | Single-threaded in an isolate; memory budget is the issue, not the 64 MiB cap. Cloudflare runs DataFusion natively (not in Workers isolates) for Basin SQL execution [V]. `iceberg-datafusion` is moving to `apache/datafusion-iceberg` [V2]. |
| **DuckDB (Ducklings `@ducklings/workers`)** | Yes [V] | 49.6 MiB uncompressed, 12.3 MiB gz; +Iceberg ext 13.4 MiB gz [V] | httpfs range reads, Parquet, Iceberg extension | Possible but impractical | Asyncify roughly doubles size; single-threaded; examples set `memory_limit=100MB` inside a 128 MB isolate; HTTP bridge buffers whole responses [V]. Official duckdb-wasm core is ~8 MB gz [V]. |
| **apache-arrow JS** | Yes [T] | ~150–200 KB [T] | In-memory columnar + IPC | IPC | Useful for Arrow IPC between Workers; not needed if the engine is custom. |
| **Polars WASM** | Browser-oriented, large, lagging [T] | — | — | — | Not recommended. |

**Memory reality at 128 MB.** A JS engine holding decoded columns as typed arrays plus strings as JS objects will exhaust memory quickly; keep batches small (tens of thousands of rows), decode only projected columns, prefer dictionary-encoded strings kept as codes, and stream results. Fan out per file or per row-group batch to sub-invocations (service bindings or DOs) so each isolate holds one small unit of work. Compacted 128–512 MB files are fine to read (range requests) but cannot be rewritten in one isolate unless the writer streams row groups to an R2 multipart upload.

**Bounded-memory Parquet writes.** Options: (a) hyparquet-writer with files small enough to buffer (≤ ~16–32 MB) — simple, fits ingest; (b) arrow-rs `ArrowWriter` in WASM writing row groups into multipart parts (5 MiB minimum part size [T]) — needed for in-Worker compaction to 128 MB+.

---

## 7. Alternatives considered

| Option | Assessment for viz |
|---|---|
| **Delta Lake** [T] | JSON commit log + Parquet checkpoints; commits are single small objects (cheaper than Iceberg v2). Needs put-if-absent (R2 supports conditional writes). No Cloudflare-managed catalog or maintenance, no Workers-native library, weaker cross-engine neutrality than Iceberg REST. Delta 5.0 is converging with Iceberg v4's tree [V2]. |
| **DuckLake** | 1.0 released April 2026: all metadata in a SQL database, plain Parquet data, "unlimited snapshots without expensive compaction" [V]. Conceptually attractive (metadata in D1 or DO SQLite would make planning one SQL query) but the only real client is DuckDB, and it would forfeit Basin Catalog/SQL and third-party engines. Data inlining for tiny writes is [T]. |
| **Hudi** [T] | Timeline + MOR/COW, strong upsert story, JVM-centric. No fit. |
| **Paimon** [T] | LSM table format built for streaming upserts and changelogs, JVM-only, Iceberg-compatible snapshots possible. Its LSM idea is relevant (viz's hot tier is effectively L0), its implementation is not. |
| **Plain Parquet + custom manifest** | Lowest cost and total control; planning can be one object read. Loses interoperability, managed compaction/expiration, and Basin SQL. |
| **Custom manifest beside Iceberg** | Best of both: Iceberg is the system of record and interop surface; a small viz-owned manifest covers (1) the uncommitted hot tail and (2) query acceleration data that Iceberg lacks (row-group stats bundle, tenant→file maps, bloom sidecars). Must be strictly derivable from Iceberg + the hot log so it can be rebuilt. |

When the custom layer makes sense: whenever required freshness is below the safe commit interval (~60 s), and whenever per-file footer fetches would dominate planning. Both hold for viz.

---

## 8. Design implications for viz

### 8.1 Format and features

- **Iceberg format v2, append-only**, Parquet data, REST commits to Basin Catalog. No equality deletes, no MOR. Deletes only as partition-aligned metadata deletes (retention) or rare copy-on-write rewrites (tenant erasure).
- Be **v3-ready**: keep a single `attributes` column that can migrate to shredded Variant; store timestamps as `timestamptz` (micros) with raw nanos preserved in an int64 where needed; avoid nested structs for anything filtered on.
- Promote hot attributes (service, severity, metric name, span name, status, http route, k8s namespace) to top-level dictionary-encoded columns. Long tail in `map<string,string>` or JSON string for now.
- Set metrics modes: `truncate(16)` default, `none` for payload columns (log body, attribute blob), `full` for `ts` and `tenant_id`.
- Do not depend on v4, Puffin indexes, REST scan planning, or non-Parquet formats.

### 8.2 Table layout

- Tables: `logs`, `spans`, `metrics` (possibly split by metric type), each per retention class. Shared across tenants; large tenants graduate to dedicated tables.
- Partition spec: `day(ts)`; evolve to `hour(ts)` only for tables whose daily volume makes day-level manifests too large. Avoid tenant in the partition spec unless a `bucket(N, tenant_id)` is needed to parallelize writers.
- Sort order: logs `(tenant_id, service, ts)`; metrics `(tenant_id, metric_name, series_id, ts)`; spans `(tenant_id, ts)` with a bloom filter on `trace_id` (and consider a small trace-index table keyed by `trace_id → (day, file)` if trace lookups without a time hint are required).

### 8.3 File, row-group and page sizes

- **Ingest (L0) files:** flush at ~8–32 MB compressed or 30–60 s, whichever first, per writer shard. Row groups ≤ ~100k–250k rows (≈ 8–16 MB uncompressed per projected read) so a Worker can decode one row group comfortably.
- **Compacted files:** target **128 MB** (Basin default and its "latency-sensitive/streaming" guidance) rather than 512 MB; row groups ~16–32 MB compressed / ≤ 1M rows; data pages ~64–256 KB (smaller for sort-key and filter columns) with **column index + offset index on**; bloom filters on `trace_id` and other high-cardinality lookup keys with a byte cap.
- Encodings: `DELTA_BINARY_PACKED` for `ts` and integer ids; dictionary for low-cardinality strings; `DELTA_BYTE_ARRAY` or plain+zstd for bodies; `BYTE_STREAM_SPLIT` for float metric values (ALP later once readers catch up). zstd level 3 at ingest, higher at compaction.
- Keep footers small: bounded column count (no column-per-attribute explosion), bounded row groups per file (≤ ~16).

### 8.4 Commit cadence and concurrency

- **One committer Durable Object per table** (single writer ⇒ no optimistic-concurrency retries among viz's own writers; the only competitor is catalog maintenance).
- Commit every **60–300 s**, adaptive: commit when ≥ N files or ≥ X MB are pending or 5 min elapsed; never below 60 s (matches Basin Pipelines' floor for avoiding compaction conflicts).
- Each commit appends all pending L0 files across partitions in one snapshot; merge into existing per-day manifests rather than adding a manifest per commit.
- Use `Idempotency-Key` on commits if Basin honours it (unverified); otherwise make the committer's pending set durable in DO storage and reconcile by snapshot summary after an ambiguous failure.
- Snapshot expiration: **hours to 1 day, retain-last small** on hot tables to keep metadata.json small. The default 30 days is wrong for minute-level commits.
- Track every object written; delete objects from failed or abandoned commits (Basin does not clean orphans).

### 8.5 Hot tier (custom manifest beside Iceberg)

- Writers flush immutable L0 Parquet objects to R2 and register them with the committer DO (a row in DO SQLite: path, size, tenant set or min/max tenant, ts min/max, row-group stats).
- Queries ask the committer DO (or a read replica of its state) for: current Iceberg snapshot id + manifest-list path, and the list of **registered-but-uncommitted** files. Result = committed scan ∪ uncommitted files. Freshness becomes the flush interval, independent of commit cadence.
- Sub-flush freshness (last few seconds) can come from the ingest DOs' in-memory buffers if needed.
- Everything in the hot manifest is rebuildable from R2 listings plus Iceberg metadata.

### 8.6 Compaction

- Phase 1: enable **Basin Catalog managed compaction** at 128 MB. Cost is small ($0.005/GB, $2/M objects). Verify what it does to sort order, row-group/page sizes, bloom filters and page indexes.
- Phase 2 (if managed compaction degrades clustering or lacks indexes): viz-run **sort compaction per day partition**: k-way merge of sorted L0 files, streaming row groups through arrow-rs WASM (or icebird's `icebergRewrite`) into multipart uploads, committed as a `replace` snapshot by the same committer DO (so no conflicts with appends). Run once a partition is "closed" (for example an hour after the day/hour ends) plus an intermediate L0→L1 pass for the current day. Disable managed compaction on those tables to avoid dueling rewrites.
- Always follow with manifest rewrite so each day has one (or a few) manifests.

### 8.7 Keeping planning to a handful of subrequests

1. **Snapshot pointer + hot files: 1 subrequest** to the committer DO (cached a few seconds in the query Worker). No catalog call on the query path, so no per-query catalog-operation charge.
2. **Manifest list: 0–1.** Either cached (immutable) or skipped because the committer publishes a compact "partition → manifest path(s)" map alongside the pointer.
3. **Manifests: 1 per touched day**, fetched from Cache API when warm (immutable). Tenant and time pruning uses per-file bounds on `tenant_id` and `ts`.
4. **Footer bundle: 1 per touched day.** A viz-written sidecar (per manifest or per day) holding each file's row-group offsets and stats for the key columns, plus page-index locations — so no per-file footer GETs. Written at commit and at compaction; immutable; cacheable.
5. Then data reads: coalesced range requests per (file, row-group batch), fanned out to sub-Workers to stay within the 6-connection and 128 MB limits.

A one-hour query on one tenant should therefore plan in roughly **3–5 subrequests cold and 1 warm**.

### 8.8 Libraries

- **Read path:** hyparquet for Parquet decoding and range I/O; a thin viz planner over Iceberg metadata (icebird's manifest readers, or own Avro reader) plus the sidecars. Evaluate a small Rust/WASM kernel (arrow-rs `parquet` + arrow compute, no DataFusion) for decode-and-aggregate hot loops if JS throughput or memory is insufficient.
- **Write path:** hyparquet-writer for L0 files (with a WASM zstd compressor); icebird (or its primitives) for manifest/manifest-list Avro and REST commits, hardened with viz's own conflict handling. Do not adopt iceberg-rust in Workers.
- **Not on the main path:** DuckDB-WASM and DataFusion-WASM (memory), Basin Pipelines as primary ingest (20 streams/sinks per account, 60 s minimum roll, no custom partitioning yet, cannot sink into existing tables [V]). Basin SQL and external engines (DuckDB, Spark, Trino, Snowflake, PyIceberg) remain available over the same tables as a free interop benefit.

---

## 9. Open questions / unverified

1. Does Basin Catalog accept **format-version 3** tables from external writers today (variant, DVs, nanosecond timestamps)? Docs are silent; blog says "planned" for Pipelines/SQL.
2. Does Basin managed compaction **preserve sort order, bloom filters, column/offset indexes, page and row-group sizes, and zstd**? What are its trigger cadence and throughput limits? A sort/clustering mode is only "planned".
3. Basin Catalog **limits**: tables/namespaces per catalog, commit rate, request rate, whether a 304 ETag `loadTable` is billed, whether `Idempotency-Key`, `snapshots=refs` and multi-table commits are supported, and whether **REST scan planning** is offered. None documented on the pages fetched.
4. What counts as a "catalog operation" for billing (each REST call? credential vending?).
5. Does icebird work unmodified against Basin Catalog (auth token, vended credentials, warehouse prefix) and how robust are its experimental writes under concurrent managed maintenance?
6. hyparquet-writer: Iceberg field-id emission, zstd write path, memory profile for 32 MB files, and whether column index + bloom filter output is read correctly by Spark/Trino/DuckDB/Basin SQL.
7. Real numbers needed: JS decode throughput (rows/s per CPU-ms) for hyparquet in Workers vs arrow-rs WASM; peak isolate memory per row-group size; WASM bundle size of a minimal arrow-rs parquet kernel.
8. DataFusion-WASM binary size and viability in a 128 MB isolate (not verified this session).
9. Trace-id lookup design: Parquet bloom filters vs a dedicated index table vs `bucket(trace_id)` partitioning.
10. Per-tenant retention in shared tables: retention-class tables vs partition field; cost of tenant erasure rewrites.
11. iceberg-rust 0.11 final release status and whether RewriteFiles lands (relevant only for any native/off-Workers tooling).
12. v4 timeline could move; re-check after the spec draft is published.
13. All [T]-labelled items in §§1.1, 3.1, 3.6, 5.2, 6 and 7.

---

## 10. Sources

Cloudflare
- Introducing Cloudflare Basin (GA, 2026-10-01): https://blog.cloudflare.com/cloudflare-basin/
- Basin docs overview and changelog pointers: https://developers.cloudflare.com/basin/
- Basin Catalog overview: https://developers.cloudflare.com/basin-catalog/
- Basin Catalog table maintenance: https://developers.cloudflare.com/basin-catalog/table-maintenance/index.md
- Basin Catalog manage catalogs: https://developers.cloudflare.com/basin-catalog/manage-catalogs/index.md
- Basin Catalog deleting data: https://developers.cloudflare.com/basin-catalog/deleting-data/index.md
- Basin Catalog pricing: https://developers.cloudflare.com/basin-catalog/platform/pricing/index.md
- Basin Catalog docs index: https://developers.cloudflare.com/basin-catalog/llms.txt
- Basin Pipelines Iceberg sink: https://developers.cloudflare.com/basin-pipelines/sinks/available-sinks/r2-data-catalog/index.md
- Basin Pipelines limits: https://developers.cloudflare.com/basin-pipelines/platform/limits/index.md
- R2 SQL deep dive (planner and execution): https://blog.cloudflare.com/r2-sql-deep-dive/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/index.md
- Subrequest limit change (2026-02-11): https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/

Apache Iceberg
- Iceberg 1.11.0 release (2026-05-19): https://iceberg.apache.org/blog/apache-iceberg-1.11.0-release/
- Iceberg Rust 0.10.0 release: https://iceberg.apache.org/blog/apache-iceberg-rust-0.10.0-release/
- Preview of Iceberg 1.12 and iceberg-rust 0.11 (Dremio, 2026-09-18): https://www.dremio.com/blog/preview-of-upcoming-apache-iceberg-1-12-and-iceberg-rust-0-11-new-features-and-breaking-changes
- iceberg-rust WASM issue #1710: https://github.com/apache/iceberg-rust/issues/1710
- v4 roadmap explainer: https://datalakehousehub.com/blog/apache-iceberg-v4-roadmap-adaptive-metadata-delta-convergence
- Iceberg Summit 2026 v4 recap (Snowflake; fetch returned 403, cited via search summary only): https://www.snowflake.com/en/blog/engineering/iceberg-summit-2026-recap-v4-spec/
- REST scan planning explainer: https://datalakehousehub.com/blog/inside-iceberg-rest-scan-planning
- Hidden cost of tiny Iceberg commits: https://datalakehousehub.com/blog/hidden-cost-of-tiny-iceberg-commits
- State of streaming to Iceberg, July 2026: https://datalakehousehub.com/blog/streaming-to-iceberg-july-2026
- RisingWave on commit frequency (search summary): https://risingwave.com/blog/iceberg-commit-frequency/
- Secondary index dev-list threads (search summary): https://go.mail-archive.com/dev@iceberg.apache.org/msg13114.html , https://go.mail-archive.com/dev@iceberg.apache.org/msg12950.html
- Iceberg File Format API: https://iceberg.apache.org/blog/apache-iceberg-file-format-api/
- File format landscape (Dremio): https://www.dremio.com/blog/exploring-the-evolving-file-format-landscape-in-ai-era-parquet-lance-nimble-and-vortex-and-what-it-means-for-apache-iceberg/

Parquet
- Implementation status matrix: https://parquet.apache.org/docs/file-format/implementationstatus
- State of Apache Parquet 2026: https://datalakehousehub.com/blog/state-of-apache-parquet-2026
- FSST and ALP explainer (search summary): https://datalakehousehub.com/blog/fsst-alp-parquet-encodings

Libraries
- icebird: https://github.com/hyparam/icebird
- hyparquet-writer: https://github.com/hyparam/hyparquet-writer
- Hyperparam paper (hyparquet/squirreling/icebird sizes and benchmarks): https://arxiv.org/html/2605.27785
- icepick (Rust, WASM, R2 Data Catalog): https://docs.rs/crate/icepick/0.4.1/source/README.md
- Ducklings DuckDB for Workers: https://ducklings-api.pages.dev/Browser_vs_Workers
- DuckLake: https://ducklake.select/
