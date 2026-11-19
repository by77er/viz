# 04 — Trace and log storage/retrieval on object storage: state of the art and a design for viz

Research date: 2026-11-18. Author role: tracing / log-storage research for the viz design.

**Web access note.** Web search and fetch worked for most of the session, but the shared web-search
budget ran out before the last few lookups. Not searched as a result: Tempo's structural-operator
internals, arrow-rs/WASM Variant reader status, OpenObserve's trace-ID bloom post, SigNoz/Uptrace
schema details, and Quickwit hotcache internals. Everything in this document is tagged:

- **[V]** verified this session against a primary source (URL in Sources).
- **[V2]** seen this session only in a secondary source or a search-result summary.
- **[TK]** training knowledge, not re-verified. Treat as a hypothesis.

---

## 0. Executive summary

1. **The industry has converged on "Kafka-ish WAL, then columnar objects, then stateless query fan-out".**
   Tempo 3.0 (June 2026) and Loki 4.0 (RC, November 2026) both dropped replicated ingesters for a
   durable log plus block builders, write one copy to object storage, and query with stateless
   workers [V]. viz's Durable Object (WAL/buffer) → R2 Parquet → Worker fan-out is the same shape.
2. **Nobody serious relies on a heavyweight inverted index on object storage any more, except Quickwit/OpenObserve (tantivy).**
   Loki retired its n-gram bloom experiment, pivoted to structured-metadata blooms, then deprecated
   those [V]. Its replacement is a columnar format plus an optional compact probabilistic
   "needle in a haystack" index [V]. Datadog Husky uses zone maps, hashed n-gram posting bitsets
   per fragment, and aggressive caches [V]. ClickHouse shipped a sequential-read inverted index
   designed for object storage (GA March 2026) [V].
3. **The key layout decision for spans is sort order: trace-clustered (Tempo) or service-clustered (ClickHouse family).**
   Jaeger's 2026 ClickHouse work measured both on the same data. Sorted by `trace_id`, trace
   retrieval took about 27 ms and search about 880 ms. Sorted by `(service_name, name, start_time)`
   with a bloom on `trace_id`, retrieval took about 100 ms and most searches under 50 ms [V].
   They chose the latter. For viz, where compute is the scarce resource, I recommend the same
   choice plus a small trace-clustered `trace_index` rollup table.
4. **Flat one-row-per-span beats Tempo's nested one-row-per-trace for viz.**
   A flat table removes trace assembly from the write path, fits Iceberg and SQL engines, and
   matches where Tempo is heading (vParquet5's "span-only fetch layer" for metrics) [V].
   The cost is structural TraceQL (`>`, `>>`, `~`), which becomes a self-join. That is bounded
   and acceptable (see §5.4).
5. **Attributes: promoted typed columns plus a residual map now; Variant later.**
   Iceberg v3 Variant with shredding is real in 2026 (Iceberg 1.10–1.12, Snowflake, S3 Tables) [V/V2].
   I could not confirm support in Cloudflare's SQL engine or in a Workers-compatible reader.
   The design keeps a planner rule ("promoted column if the file has it, else residual") that
   lets the residual become VARIANT without changing queries.
6. **Index sidecars: use Parquet-native features first.**
   Sort order, page index, and per-row-group bloom filters on `trace_id` come first. Custom
   sidecars (token index, file-level fuse filters) come only where measurements demand them.
   Iceberg secondary indexes in Puffin are still a draft as of this week [V2], so viz must own
   sidecar lifecycle, and therefore its own compaction.
7. **Logs: expose a LogQL subset plus SQL, both compiled to one internal plan IR shared with TraceQL.**
   Do not invent a third public language in v1.

---

## 1. Grafana Tempo

### 1.1 Architecture: classic (≤2.x) and Tempo 3.0 "Project Rhythm"

Classic Tempo [TK]: distributor (hash by trace ID, replication factor 3) → ingesters (WAL, trace
assembly, head block, flush) → object storage; compactor merges and deduplicates the RF3 copies;
query-frontend shards queries across queriers; metrics-generator is fed by the distributor.

Tempo 3.0, released 2026-06-01 [V]:

| Component | Role in 3.0 |
|---|---|
| Distributor | Shards by trace ID and writes to a Kafka-compatible log. Kafka is the durable WAL. |
| Block-builder | Consumes a partition and writes Parquet blocks to object storage. Defaults: `consume_cycle_duration` 5m, `max_block_bytes` 20 MiB [V]. |
| Live-store | Consumes the same stream and serves recent data (about the last 30–60 min) for search, trace-by-ID, and TraceQL metrics. Defaults: `max_trace_idle` 5s, `max_trace_live` 30s, `max_block_duration` 30s, `max_block_bytes` 50 MiB [V]. |
| Backend-scheduler and backend-worker | Replace the compactor: compaction, retention, blocklist maintenance, redaction jobs [V]. |
| Metrics-generator | Optional. Now consumes from Kafka. TraceQL metrics no longer depend on it [V]. |
| Querier and query-frontend | Roles unchanged. The frontend gained AST rewrites and an optional MCP server [V]. |

Other verified points:

- **RF1.** One copy is stored instead of three. The previous design stored "3 to 3.5 times the
  actual volume of tracing data" [V].
- **Fail-closed recent data.** Tempo fails search and metrics requests when a live-store cannot
  guarantee complete results, instead of returning partial results [V2].
- **Monolithic mode needs no Kafka.** The distributor pushes in-process to the live-store [V2].
- **Removed in 3.0:** ingesters, compactors, the local-blocks processor, the v2 block format,
  and the scalable-single-binary target [V].
- **TraceQL metrics are GA** and on by default. Functions: `rate`, `count_over_time`,
  `sum/min/max/avg_over_time`, `quantile_over_time`, `histogram_over_time`, `compare`,
  `topk/bottomk`, plus arithmetic between queries. Exemplars are available on all range queries [V].
- **Smaller 3.0 features:** DRAIN-based span-name sanitizer, per-label cardinality limiting with
  HyperLogLog demand estimation, sampling compensation via `span_multiplier_key` or W3C
  tracestate, and `tempo-cli redact` [V].

**What this means for viz.** A Durable Object with durable storage plays Kafka's role (ordered,
durable, per-shard). The block-builder is a DO alarm that flushes Parquet to R2. The live-store
is the DO answering queries over its unflushed tail. The fail-closed rule for the recent window
is worth copying.

### 1.2 Block format: vParquet4 → vParquet5

vParquet5 is the default block version [V] (config reference; the dedicated-columns page says
Tempo 3.1 writes it by default).

**Shape.** The schema is fully nested, with one row per trace [V]:

```
Trace
  TraceID (bytes), TraceIDText, StartTimeUnixNano, EndTimeUnixNano, DurationNano,
  RootServiceName, RootSpanName, ServiceStats[] {ServiceName, SpanCount, ErrorCount}
  rs[] (ResourceSpans)
    Resource { ServiceName, Attrs[], DedicatedAttributes, DroppedAttributesCount }
    ss[] (ScopeSpans)
      Scope { Name, Version, Attrs[] }, SpanCount
      Spans[]
        SpanID, ParentSpanID, ParentID(int32), NestedSetLeft(int32), NestedSetRight(int32),
        ChildCount(int32), Name, Kind, TraceState, StartTimeUnixNano, DurationNano,
        StatusCode, StatusMessage, Attrs[], DedicatedAttributes,
        StartTimeRounded15 / 60 / 300 / 3600 (uint32),
        Events[] { TimeSinceStartNano, Name, Attrs[], DedicatedAttributes }
        Links[]  { TraceID, SpanID, TraceState, Attrs[] }
```

(Field names and tags are from `tempodb/encoding/vparquet5/schema.go` on main [V].)

Verified details:

- **The trace ID is not stored per span.** It appears once per row [V].
- **Trace-level columns are computed at ingest** (root service, root span name, duration,
  `ServiceStats`). The result list and duration filters never need to locate the root span [V].
- **Generic attributes** are a repeated group `{Key, IsArray, Value[], ValueInt[], ValueDouble[],
  ValueBool[], ValueUnsupported}`, typed and one column per type [V].
- **Dedicated attribute columns.** vParquet4 had hard-coded well-known columns (`Cluster`,
  `Namespace`, `Pod`, `K8s*`, `HttpMethod`, `HttpStatusCode`, `HttpUrl`) plus 10 string spares
  per scope. vParquet5 removed the hard-coded ones and "relies on dynamically assigned dedicated
  columns only" [V]. It allows 20 string and 5 integer spares per scope, for resource, span, and
  (new) event scopes, with `array` and `blob` options [V].
  - `blob` is for high-cardinality or long values where dictionary encoding fails, when the
    dictionary exceeds about 4 MiB per row group. Blob columns use zstd and no dictionary [V].
  - Integer columns are recommended only when the attribute appears on at least 5% of rows [V].
  - Selection guidance: pick the attributes that contribute most to block size, even if rarely
    queried, because shrinking the generic key/value list is what speeds everything up [V].
- **vParquet5 optimization fields:** `ChildCount`, the four `StartTimeRounded*` columns (bucketed
  start times for cheap `rate()` step alignment), and `ServiceStats` as a list [V].
- **Encodings:** snappy everywhere, dictionary on strings, delta on times and durations [V].
- **Tempo does not use Parquet bloom filters.** It has its own sharded bloom per block [V].
- **Defaults:** `parquet_row_group_size_bytes` 250 MB (main-branch docs [V]; I recall 100 MB in
  older releases [TK]). `bloom_filter_false_positive` 0.01. `bloom_filter_shard_size_bytes`
  100 KiB. Compaction `max_block_bytes` 100 GiB, `compaction_window` 1h, retention 336h [V].

**Sorting** [TK]: rows (traces) within a block are sorted by trace ID. Block metadata carries
min/max trace ID and the time range. A row group holds whole traces.

### 1.3 Nested set model and structural operators

- Each span carries `NestedSetLeft`, `NestedSetRight`, and `ParentID`. `NestedSetLeft` doubles as
  a trace-local numeric span ID, and it fills the `ParentID` of child spans [V].
- The numbers are not in OTLP. They are calculated when a trace is finalized into a block
  (`finalizeTrace`: "calculating service stats, nested set model bounds") [V]. They must be
  recomputed when compaction merges fragments of the same trace [TK].
- Evaluation [TK], once both sides' spans for a trace are fetched:
  - descendant `A >> B`: `A.left < B.left && B.right < A.right`
  - child `A > B`: `B.parentID == A.left`
  - sibling `A ~ B`: `A.parentID == B.parentID`
  The engine only needs spans that matched either side plus three int32 columns. It never walks
  the tree.
- Operators shipped in 2.2 (`>>`, `>`, `~`) and 2.3 (`<<`, `<`, and experimental negated forms
  that can return false positives) [V2].
- In vParquet5, TraceQL metrics use a span-only fetch layer that "processes individual spans
  instead of full traces". Queries with structural operators fall back to the standard
  trace-level fetch [V]. Even in Tempo, structural queries are the expensive path, and a
  span-at-a-time model is the fast path.

### 1.4 Trace-by-ID and search

- **Trace by ID.** For every block in the tenant's blocklist within the time range, Tempo checks
  the block's bloom filter, then reads the block if it passes. "Tempo does in fact check every
  block" (maintainer, GitHub discussion) [V2]. Blooms are sharded into about 100 KiB objects so
  one lookup fetches one shard per block. They are heavily cached in memcached/redis [V2/TK].
  Inside a block, sortedness by trace ID gives a row-group binary search [TK].
- **Search** is a brute-force columnar scan over all blocks in the time range, parallelized by
  the query-frontend into per-block, per-row-group jobs. Pruning comes from the block time
  range, dictionary pages, and trace-level and resource-level columns. Resource-level columns
  are "very small (one row per batch)" [V]. There is no inverted index.
- **Why this is a poor fit for Workers.** Tempo assumes multi-GB queriers and 100–250 MB row
  groups. Search cost grows with the tenant's total volume in the window, not with selectivity.

### 1.5 What to take from Tempo

- Take: TraceQL semantics (scoped attributes `resource.`, `span.`, `event.`, `link.`; intrinsics),
  dedicated/promoted columns chosen by size contribution, precomputed trace-level rollups,
  rounded start-time columns for metrics, the DRAIN span-name sanitizer, fail-closed recent data.
- Leave: one-row-per-trace nesting, 250 MB row groups, the bespoke bloom sharding, and the
  dependence on big queriers.

---

## 2. Alternatives: traces

### 2.1 Jaeger v2 + ClickHouse

- Jaeger v2 is built on the OTel Collector (released November 2024) [V2]. Native ClickHouse
  storage arrived as alpha in v2.18.0 behind the feature gate `storage.clickhouse`. The schema
  is explicitly unstable [V2].
- Schema, per the CNCF post of 2026-06-23 [V]:
  - A single flat `spans` table.
  - Attributes as a ClickHouse `Nested` column per primitive type (Bool, Int64, Float64, String,
    complex), repeated at span, event, link, resource, and scope level.
  - A `bloom_filter` skip index on `trace_id`.
  - Materialized views for service names, operations, an `attribute_metadata` table (which
    types and levels a key has been seen under), and `trace_id_timestamps`, which gives each
    trace's time bounds so `GetTraces` can prune partitions and granules.
- **Sort-order experiment** [V]: sorted by `trace_id`, retrieval about 27 ms and search about
  880 ms. They chose `(service_name, name, start_time)`: retrieval about 100 ms, most searches
  under 50 ms, complex ones about 140 ms.
- Compression 8.6× (about 6 GiB to about 722 MiB for 10M spans); ingest above 50k spans/s on a
  single node [V].

### 2.2 ClickStack / HyperDX

- `otel_traces` [V2, ClickHouse docs]: `PARTITION BY toDate(Timestamp)`,
  `ORDER BY (ServiceName, SpanName, toDateTime(Timestamp))`. Attributes are
  `Map(LowCardinality(String), String)`. Earlier versions had `tokenbf_v1` on span name; current
  docs use a `text` index. There is a min/max index on duration.
- `otel_logs`: `ORDER BY (toStartOfFiveMinutes(Timestamp), ServiceName, Timestamp)` [V2].
- The classic OTel-exporter schema also has a trace-ID → min/max timestamp materialized view
  (`otel_traces_trace_id_ts`) and bloom filters on map keys and values [TK].
- ClickHouse full-text ("text") index went GA 2026-03-10 in 26.2+ [V]. See §4.2.

### 2.3 SigNoz and Uptrace

- SigNoz `signoz_index_v3` [V2]: more than 30 columns, plus a `resource_fingerprint` (hash of all
  resource attributes) used with a separate resource table `traces_v3_resource`. Queries first
  resolve resource filters to fingerprints, then scan spans by fingerprint.
- [TK]: ordering key approximately `(ts_bucket_start, resource_fingerprint, has_error, name,
  timestamp)` with 30-minute buckets; typed attribute maps (`attributes_string/number/bool`);
  materialized columns for hot attributes; a `trace_summary` table for trace time bounds.
- Uptrace [TK]: split "index" table (narrow, typed, sorted for filtering) and "data" table
  (full span payload keyed by trace).

The pattern to steal is the **resource fingerprint**. Resource attributes repeat across millions
of spans. Clustering by a hash of them makes resource columns nearly free (RLE) and gives
min/max pruning for any resource-attribute filter through a small side lookup.

### 2.4 Quickwit

- A search engine built on tantivy with indexes on object storage. Acquired by Datadog in
  January 2025; the OSS project continues under Apache 2.0 [V2].
- A **split** is an immutable index piece identified by UUID, containing index files plus a
  **hotcache**. "Thanks to the hotcache, opening a split on Amazon S3 only takes 60ms" [V].
- A PostgreSQL metastore holds split metadata, including the min/max timestamp used to prune.
  The root node picks splits and assigns them to leaf nodes by rendezvous hashing, for cache
  affinity [V].
- [TK]: the hotcache is a small blob listing byte ranges of every file in the split bundle plus
  the bytes needed on every open, so a term query costs about one GET for the hotcache plus a
  few range GETs. Mature splits target about 10M docs. Tag fields allow split pruning by tenant.
- Costs: indexing CPU is high, the row-oriented docstore is larger than Parquet, and it is not
  an open table format. A WASM tantivy inside a 128 MB isolate is plausible only for small splits.

### 2.5 OpenObserve

- Parquet on object storage, queried with DataFusion. Tantivy is the inverted-index library,
  used for full-text fields and for "secondary index" fields; on by default [V2].
- A published tuning case had 170 Parquet files with about 14.6 GB of tantivy index. Reducing
  file count through `ZO_COMPACT_MAX_FILE_SIZE` cut the S3 requests needed to open indexes [V2].
  The lesson: index open cost is per file, so fewer and larger files matter.
- A blog post titled "bloom filter 2.6s to 89ms" exists, but I could not fetch it. The subject
  (presumably a trace-ID or needle lookup) is unverified.

### 2.6 Parseable

Stateless Rust nodes; local staging, then Parquet on object storage in about one-minute windows.
Described as index-free, with optional on-demand indexing and a local NVMe hot tier [V2,
third-party mirrors]. Closest in spirit to viz's low minimum cost goal. It relies on brute-force
DataFusion scans.

### 2.7 Honeycomb Retriever

- Custom column-per-file format in segments. A segment rolls at 1M events, 1 GB, or 12h [V2].
- Recent data sits on local SSD. Older segments on S3 are queried by Lambda fan-out, originally
  one Lambda per roughly 1 GB segment, later one per about 8 segments. Results merge at
  retriever nodes [V2].
- Segments are indexed by timestamp only. There is no other index. `trace_id` is an ordinary
  column [V2].
- Lambda's 6 MB response limit forced spilling results to S3 and passing a link [V2].
- For viz: Worker fan-out over R2 is the same pattern. It works because queries are time-bounded
  aggregations, with trace-ID fetch being time-hinted. Plan to spill large intermediate results
  to R2.

### 2.8 Datadog Husky

From the query-architecture post [V]:

- Writers consume Kafka and upload **fragments** in a custom columnar format. Metadata lives in
  FoundationDB.
- Fragment metadata includes time bounds and **zone maps**. Zone-map pruning removes "up to 60%
  for structured events and around 30% on average".
- **Locality compaction** generates "pruning regexes" kept in the metadata service. About 300 of
  1,000 sampled fragment queries were pruned at the metadata service before touching storage.
- Row groups are "just a few hundred rows" so they fit CPU caches, with per-row-group min/max
  and skip lists. Predicates are evaluated lazily in cost order.
- **Text search:** per-fragment segments where "each term — whether a full word or an n-gram —
  maps to two posting lists (stored as bitsets)". N-grams are hashed to bound size. False
  positives are accepted because the index only narrows the search.
- **Caches do most of the work.** Result cache per fragment, about 80% hit rate. Blob-range cache
  about 70%. Predicate cache (bitsets for the most expensive predicates) about 3% hit rate but
  about 10× payoff. Only 3.4% of fragment queries scan real data and 0.4% reach blob storage.

For viz: immutable files make per-file result caches and predicate caches trivially correct.
Cloudflare's Cache API or KV keyed by `(file, plan-fragment hash)` is the equivalent.

### 2.9 Axiom, Oodle

- Axiom [V, vendor docs]: edge proxies → distributed WAL → custom columnar immutable blocks on
  object storage. Compaction produces "superblocks". Queries run on "ephemeral, serverless
  workers" that fetch only the needed columns. Results are cached in object storage. Large
  results reach clients through signed URLs.
- Oodle [V2, founders' Show HN]: metrics in object storage, recent data in memory, "serverless
  functions (lambdas) for querying".

Both confirm that the viz architecture is commercially proven.

### 2.10 VictoriaTraces

- Built on VictoriaLogs storage [V2]. Still 0.x: v0.7.0 added start and end times to the
  trace-ID index, and v0.9.x through mid-2026 extended TraceQL and Tempo/Jaeger APIs [V2].
- The trace-ID index maps a trace ID to its time range, so the main store (stream- and
  time-organized) can be scanned narrowly. This is the same idea as Jaeger's
  `trace_id_timestamps`.
- Local disk only. Useful as a schema idea, not a deployment model.

### 2.11 OTel Arrow (OTAP)

- Phase 2 is a Rust dataflow engine that keeps telemetry in Arrow record batches end to end.
  It is incubation-stage: "production workloads are not recommended at this stage" [V].
- Benchmarks: one core reached 2.47M logs/s on OTAP against 121K on OTLP [V].
- [TK]: OTAP normalizes a batch into several record batches (resources, scopes, spans, and
  separate attribute tables joined by parent ID). That is good for transport and awkward as a
  single Iceberg table.
- A Parquet exporter exists in the repository [V2]. `otlp2parquet` says its schema will converge
  with OTAP when OTAP stabilizes [V2].
- For viz: accept OTLP now, with OTAP as a later ingest option. Do not adopt the OTAP
  multi-table layout as the storage schema.

### 2.12 Flat or nested: summary

| | Nested, row = trace (Tempo) | Flat, row = span (ClickHouse family, Husky, Honeycomb) |
|---|---|---|
| Trace assembly | Needed before write (live-store idle 5s, max 30s) and again at compaction | None. Assembled at read. |
| Late or out-of-order spans | Fragments are re-merged at compaction; nested-set numbers recomputed | Just more rows |
| Trace-by-ID | One row | N rows. Needs clustering or bloom. |
| Resource attributes | Stored once per batch | Repeated per span. Cheap if sorted by resource (RLE and dictionary). |
| Structural operators | Nested set on co-located spans | Self-join, or nested set added at compaction |
| SQL and Iceberg ergonomics | Poor (3–4 levels of repetition) | Good |
| Memory per decoded unit | A whole trace, which can be huge | One page of spans |
| Trace-level predicates (`traceDuration`, root name) | Free | Need a rollup table |

For 128 MB isolates and Iceberg, the flat schema is the right choice.

---

## 3. Alternatives: logs

### 3.1 Loki: chunks → blooms → dataobj

- **Classic** [TK]: label-indexed streams (TSDB index) pointing to compressed row-oriented
  chunks. Full-text queries are brute-force grep over chunks. Structured metadata (3.0) added
  per-line key/values without stream cardinality.
- **Blooms.** 3.0 introduced experimental n-gram bloom filters for line-filter acceleration.
  3.3 was "a major shift … pivoting from free-text search to harnessing the power of structured
  metadata", replacing the bloom-compactor with a planner and builder [V2]. Current docs mark
  bloom building and querying **deprecated, to be removed** [V2]. The reasons given informally
  were index size and build cost relative to benefit [TK]. I did not find an official
  post-mortem.
- **New architecture (4.0).** `v4.0.0-rc.2` is dated 2026-11-04. It removes SSD targets and the
  BoltDB/Cassandra/BigTable backends, and adds a dataobj indexer, a compactor, sort-schema
  support, and "stream-first" ordering [V]. One changelog line says "Unplug the V2 query engine
  from the config and modules". I could not resolve what that implies for the engine's GA status.
- **dataobj format** [V, `pkg/dataobj/README.md`]:
  - Container with magic `DOBJ`. File metadata sits in the header, and readers optimistically
    fetch the first 16 KB. Any range is reachable in two round trips.
  - Sections can be tenant-specific. One object can hold many tenants.
  - `logs` section: `stream_id`, `timestamp`, one column per structured-metadata key, `message`.
  - `streams` section: `stream_id`, min/max timestamp, one column per label, row count, size.
  - Pages are zstd-compressed, with plain, delta, and bitmap encodings and page-level min/max.
  - The builder accumulates one object per tenant per 12-hour window and writes an index object.
    A table of contents per window and tenant is how the metastore finds index objects.
- **GrafanaCON 2026 claims** [V]: in old chunks the log line is about 97% of the bytes. The
  columnar engine scans about 20× less data and is about 10× faster on analytical queries.
  Kafka-based RF1 saves up to 30% in the largest clusters. Open problems the speakers named:
  detected fields are still parsed at query time, LogQL has no way to say where a field lives,
  and file layout is unresolved (ingestion favors many small files, queries favor few large).
- **Needle-in-a-haystack index (Logline, acquired April 2026)** [V, Grafana Cloud docs]:
  - "A compact probabilistic index" that says which chunks may contain a match.
  - Accelerates `|=`, regexes with a required literal run, label and structured-metadata
    equality, and parsed-field equality.
  - Does not accelerate negations, numeric comparisons, `or`, filters after `line_format`, or
    metric queries.
  - Values and literals must be at least 6 characters.
  - "Queries that scan less than 10 GiB of log data are not accelerated."
  - Falls back to a normal scan on failure, with identical results.
  - Claimed overhead under 20% of storage. One example reduced 3.5 TB to about 8 GB [V, talk].

Lessons for viz: columnar plus stream-first sort does most of the work. A text index is an
optional accelerator for large scans only, must be advisory, and should ignore short tokens.

### 3.2 VictoriaLogs

- Groups logs of the same stream together; columnar per-field blocks; "uses bloom filters for
  skipping blocks without the given word or phrase"; sparse time index; all fields indexed
  automatically; claims up to 15× less disk than Elasticsearch [V, FAQ].
- [TK]: per-day partitions, blocks of at most about 2 MB uncompressed, one bloom per field per
  block over word tokens, special encodings for dictionary/const/IPv4/timestamp columns.
- Local disk only.

### 3.3 Elastic logsdb

- Index mode that sorts by `host.name` then `@timestamp` by default, with synthetic `_source`
  and doc-value-oriented codecs. GA in 8.17 [V2].
- Elastic attributes about 30% of the storage saving to sorting alone [V2].
- This is independent confirmation that sorting logs by source identity then time is the main
  compression and pruning lever.

### 3.4 ClickHouse text index

From the object-storage design post [V]:

- Three files per part: a sorted token dictionary in blocks of 512 with front-coding, a sparse
  index of the first token per block (kept in memory), and posting lists.
- Postings adapt to size: 6 or fewer row IDs are embedded in the dictionary entry, 7–12 are
  VarInt, more are Roaring bitmaps.
- In real log data 94.5% of tokens appear in 6 or fewer rows, and the median token cardinality
  is 2. So most lookups cost one dictionary-block read and no postings read.
- No FST. Designed for sequential reads and cheap merges. It replaced the earlier design
  specifically for object storage.
- No relevance scoring.

### 3.5 Summary table

| System | Format | Clustering | Text acceleration | Runs on object storage |
|---|---|---|---|---|
| Loki 4 | dataobj columnar | stream-first, time | Optional probabilistic NIAH index | Yes |
| VictoriaLogs | Custom columnar | stream, time | Token bloom per block | No |
| ClickStack | MergeTree | (5-min bucket, service, time) | Inverted text index | Yes (ClickHouse Cloud) |
| Elastic logsdb | Lucene doc values | host.name, time | Full inverted index | Frozen tier only |
| Quickwit | tantivy splits | time, tags | Full inverted index and hotcache | Yes |
| OpenObserve | Parquet plus tantivy | stream, hour partitions | tantivy sidecar | Yes |
| Husky | Custom columnar | sort schema plus locality compaction | Hashed term/n-gram bitsets per fragment | Yes |
| Parseable | Parquet | time | None or on-demand | Yes |

---

## 4. Cross-cutting techniques

### 4.1 Trace-ID lookup at scale

Trace IDs are uniformly random 128-bit values, so no sort key other than `trace_id` itself gives
min/max pruning. Options:

| Technique | Used by | Cost | Notes |
|---|---|---|---|
| Sort by `trace_id` plus min/max | Tempo (inside a block) | Free | One page per file. Destroys service and time clustering. |
| Bloom per block or file | Tempo (0.01 FP, 100 KiB shards) | About 10 bits per trace | One GET per file unless aggregated and cached |
| Bloom skip index per granule or row group | Jaeger-CH, ClickStack, Parquet-native SBBF | About 10–12 bits per distinct ID per row group | Standard in Parquet; engines such as DuckDB, Trino, and Spark use it [TK] |
| Xor / binary-fuse filter | — | About 9 bits per key at 0.4% FP, about 18 bits at 0.0015% [TK] | Immutable files suit static filters. Smaller and faster than bloom. Needs all keys at build time, which is fine at flush and compaction. |
| `bucket(N, trace_id)` partitioning | Iceberg idiom | Free | Prunes to 1/N files but multiplies file count by N. Bad for small tenants. |
| Trace-ID → time-range table | Jaeger `trace_id_timestamps`, VictoriaTraces, SigNoz, ClickHouse exporter | About 30 bytes per trace | Turns "ID without time" into "ID with time", then the main table's time pruning applies |
| Time hint from caller | Exemplars, log links, Grafana with time shift | Free | Always pass `start` and `end` when known |

### 4.2 Full-text search on Parquet and object storage

In order of increasing cost:

1. **No index.** Columnar scan of `body` after pruning by time, service, and severity. This is
   classic Loki. It is fine when the pruned set is small. Substring search runs at GB/s per
   core natively; in WASM assume several times slower [TK].
2. **Token bloom per row group** (VictoriaLogs, ClickHouse `tokenbf_v1`). Simple, about 1–3% of
   data size. Answers "may contain token". Useless for short or common tokens, and cannot serve
   substring matches without n-grams.
3. **N-gram bloom** (`ngrambf_v1`, Loki 3.0). Supports substrings but is large. Loki abandoned
   it [V2].
4. **Hashed term → row-group bitset** (Husky). Bounded size, exact for whole terms up to hash
   collisions, and supports AND/OR by bitset algebra before any data is read.
5. **Sorted dictionary plus postings** (ClickHouse text index) or **FST plus postings**
   (tantivy/Lucene, GreptimeDB's Puffin-stored inverted index [V2]). Exact, and supports
   prefix and range on tokens. Costs about 10–30% storage and real indexing CPU.
6. **Full tantivy split with hotcache** (Quickwit, OpenObserve). The most capable and heaviest.

The right granularity for an object-storage sidecar is the **row group or page**, not the row.
Postings become tiny bitsets, and the reader has to decode the page anyway.

### 4.3 Attributes: map, Variant, or promoted columns

| Approach | Pruning | Read cost for one key | Schema churn | Engine support |
|---|---|---|---|---|
| `map<string,string>` (ClickStack) | None in Parquet (stats on all keys and all values together) | Decode the whole map column | None | Universal |
| Typed key/value lists (Tempo generic, Jaeger Nested) | None | Decode keys plus one typed value column | None | Universal |
| Promoted or dedicated columns (Tempo, SigNoz materialized) | Full: stats, dictionary, bloom | One narrow column | Add column: metadata-only in Iceberg, by field ID | Universal |
| VARIANT, unshredded | None | Decode a binary blob | None | Iceberg v3 engines |
| VARIANT, shredded | Per shredded field: typed sub-columns with stats | One narrow column | None; the shredding schema is per file | Iceberg 1.10 read, 1.11 Spark shredded write, 1.12 (2026-09-30) shredding for Flink, Kafka Connect, and generic writers [V2]. Snowflake GA [V2]. S3 Tables since 2026-07-28 [V2]. |

Shredded Variant is the natural long-term fit for telemetry: the writer picks the top-K keys
per file, and there is no table-schema churn. Two things stop it from being the v1 choice:

- I could not confirm that Cloudflare's SQL engine reads Variant. Its limitations page lists
  Struct, Array, and Map, and does not mention Variant [V].
- I could not confirm a Workers-compatible (Rust/WASM) Parquet reader with shredded-Variant
  predicate pushdown [not searched].

Schema evolution for promoted columns in Iceberg [TK, spec semantics]: adding an optional column
is a metadata-only change. Old files lack the field ID and read as null. Because Iceberg tracks
columns by ID, renames are safe.

### 4.4 Iceberg Puffin and secondary indexes

- Puffin today carries NDV sketches (`apache-datasketches-theta-v1`) and, in v3, deletion
  vectors (`deletion-vector-v1`) [TK].
- A secondary-index framework is being drafted on the dev list. As of 2026-11-16 [V2]:
  - Indexes are catalog sub-resources of a table (draft REST routes `.../tables/{t}/indexes`).
  - An index snapshot is pinned to a table snapshot. Readers use it only if
    `source-table-snapshot-id` matches, otherwise they scan.
  - Bloom filters stored as Puffin blobs are the leading first index type.
  - A separate proposal covers file-scoped Puffin blobs that survive compaction when the data
    file survives.
  - Compaction invalidating indexes is unresolved. No release version is named; it is tied to
    v4 goals.
- Conclusion: there is no standard to conform to yet. Use Puffin as the container format so
  blobs can be registered later, and manage the lifecycle in viz.

### 4.5 Pattern extraction (Drain)

- Loki's pattern ingester uses Drain, and 4.0 can run pattern ingestion over Kafka [V].
- Tempo 3.0 uses Drain to sanitize high-cardinality span names [V].
- Drain is a fixed-depth parse tree keyed by token count and leading tokens. It is online, has
  bounded memory, and needs no training [TK]. CLP (YScope/Uber) takes the idea further by
  storing template ID plus variables as the encoding [TK].

### 4.6 Cloudflare platform facts relevant here

- The Cloudflare Data Platform (Pipelines, R2 Data Catalog, R2 SQL) appears to have been renamed
  **Basin** (Basin Catalog, Basin SQL, Basin Pipelines) and declared GA, with billing enabled
  for the SQL engine [V2, changelog snippets]. Confirm before using the names.
- Managed compaction targets 64–512 MB files and also optimizes manifests. Snapshot expiration
  removes unreferenced files [V2].
- The SQL engine supports aggregations (December 2025), joins, subqueries and CTEs (May 2026),
  window functions, and Struct/Array/Map columns. It is Parquet-only and read-only, rejects
  queries whose estimated memory is too high, and "may time out" on heavy ones [V].
- Not documented on the pages I read: Iceberg format version, whether sort orders are honored
  by managed compaction, bloom-filter use, Variant.

---

## 5. Trace-specific problems and how viz should handle them

### 5.1 Trace assembly

Spans of a trace arrive across batches, services, and minutes. The options:

- **Assemble before write** (Tempo live-store). Needs per-trace state keyed by trace ID, idle
  timers, and re-merge at compaction. In viz this would mean routing by trace ID to DOs and
  holding spans in memory. That is expensive and fragile.
- **Never assemble on write** (flat tables). Each span is an independent row. A trace is
  whatever `WHERE trace_id = ?` returns. Late spans need no special handling.

Recommendation: never assemble on write. Compaction may co-locate and enrich (rollups,
optionally nested-set numbers) for partitions older than a "sealed" horizon such as 15 minutes.

### 5.2 Sampling

- **Head sampling** happens in SDKs. viz should record the effective sample rate per span, from
  W3C tracestate `ot=th:` or a configured attribute, and weight TraceQL metrics by it. Tempo
  3.0 does the same with `span_multiplier_key` and `enable_tracestate_span_multiplier` [V].
- **Tail sampling** needs complete traces, which means a stateful buffer. On object storage a
  cheaper variant is available: **compaction-time sampling**. Write everything to L0. When a
  partition seals and is compacted, decide per trace (errors, slow, rare routes, 1-in-N of the
  rest) what is kept in the long-retention tier. Span metrics are computed before the drop, so
  RED metrics stay exact. This gives tail-sampling economics with no in-memory trace buffer.
  Offer it as a later feature, not v1.

### 5.3 Service graphs, span metrics, exemplars

- **Span metrics (RED).** Two sources that should agree:
  - Query-time TraceQL metrics over the spans table. With service-clustered sort,
    `rate() by (resource.service.name)` reads a few highly compressed columns.
  - Optional pre-aggregation at flush: the ingest DO emits
    `(service, span_name, kind, status, duration histogram)` rows into the metrics table,
    with exemplars. This serves long-range dashboards cheaply.
- **Service graph edges** need a client span paired with the server span whose
  `parent_span_id` equals the client's `span_id`. They are usually in different batches. Do it
  at compaction of a sealed partition: a self-join on `(trace_id, span_id) = (trace_id,
  parent_span_id)` restricted to `kind IN (CLIENT, PRODUCER)` joined with `kind IN (SERVER,
  CONSUMER)`. Emit a `service_edges` rollup (client service, server service, time bucket,
  count, errors, duration sketch). Tempo's generator does the pairing in memory with a wait
  window [TK]; compaction-time pairing is simpler and exact for sealed data.
- **Exemplars** are `(trace_id, span_id, timestamp)` on metric points and `trace_id`/`span_id`
  on logs. Always propagate the timestamp so trace fetch is time-hinted. Give the logs table a
  bloom on `trace_id` as well.

### 5.4 Structural operators on a flat span table

Without nested-set numbers, for `{A} op {B}`:

1. Evaluate `A` and `B` as independent span scans projecting
   `(trace_id, span_id, parent_span_id)` plus requested fields.
2. Semi-join on `trace_id` to keep only traces with both an A-match and a B-match. This usually
   shrinks the candidate set by orders of magnitude.
3. Apply the operator:
   - `A > B` (child): hash join `B.parent_span_id = A.span_id`. No extra I/O.
   - `A ~ B` (sibling): `A.parent_span_id = B.parent_span_id`, different spans. No extra I/O.
   - `A >> B` (descendant): walk B's ancestor chain. This needs `(span_id, parent_span_id)` for
     the intermediate spans of the candidate traces, which is one more fetch of two narrow
     columns by `trace_id` using blooms. For search, the default result limit (20 traces in
     Tempo [TK]) bounds this. For metrics queries with `>>` it is unbounded, and should either
     be rejected above a threshold or served from nested-set columns.
4. Optional later optimization: at sealed-partition compaction, compute `nested_left`,
   `nested_right`, and `parent_local_id` per trace and store them as three int32 columns. Then
   `>>` needs only the matched spans, as in Tempo. A late span arriving after sealing leaves
   the numbers stale, so the engine needs a per-file flag `nested_set_complete` and must fall
   back to the join when it is false.

Tempo also treats structural queries as the slow path [V], so the asymmetry is acceptable.

---

## 6. Design implications for viz

### 6.1 Principles

1. Flat fact tables: one row per span, one row per log record. No write-time assembly.
2. Cluster for the common query (service plus time). Buy point lookups with filters and a rollup.
3. Small row groups and pages with the page index, because isolates hold about 128 MB.
4. Parquet-native acceleration first (sort, statistics, page index, bloom, dictionary), so any
   Iceberg engine benefits. Custom sidecars are advisory and optional.
5. viz owns compaction. Managed compaction cannot be assumed to preserve sort order, bloom
   filters, or sidecars (see open questions).
6. Every index is advisory. A missing or stale index falls back to a scan with identical
   results, as Loki's NIAH index and the Iceberg index draft both require.
7. Per-file results are cacheable forever, because files are immutable (Husky's result cache).

Assumption: one Iceberg namespace per tenant with identical table definitions, so promoted
columns, retention, and deletion are per tenant. If a shared table is chosen elsewhere in the
design, prepend `tenant_id` to every partition spec and sort key below. Loki's dataobj shows
the other route to low minimum cost: tenant-specific sections inside shared objects [V].

### 6.2 `spans` table

```sql
CREATE TABLE spans (
  -- identity
  trace_id            fixed(16)      NOT NULL,
  span_id             fixed(8)       NOT NULL,
  parent_span_id      fixed(8),                 -- null for root
  trace_state         string,
  flags               int,

  -- time
  start_time          timestamptz    NOT NULL,  -- microseconds; partition and sort source
  start_unix_nano     long           NOT NULL,  -- exact OTLP value
  duration_nano       long           NOT NULL,

  -- intrinsics
  service_name        string         NOT NULL,  -- resource service.name, always promoted
  span_name           string         NOT NULL,
  span_kind           int            NOT NULL,
  status_code         int            NOT NULL,  -- 0 unset, 1 ok, 2 error
  status_message      string,
  scope_name          string,
  scope_version       string,

  -- resource identity
  resource_fp         long           NOT NULL,  -- hash of the full resource attribute set
  resource_attrs      map<string,string>,       -- residual, promoted keys removed

  -- span attributes
  span_attrs_str      map<string,string>,       -- residual
  span_attrs_num      map<string,double>,       -- residual numerics, so comparisons are typed
  span_attrs_other    string,                   -- JSON for arrays, kvlists, bytes; rare

  -- promoted columns, added per tenant by schema evolution. Examples:
  r_k8s_namespace_name    string,
  r_k8s_pod_name          string,
  r_deployment_environment string,
  s_http_request_method   string,
  s_http_response_status_code int,
  s_http_route            string,
  s_db_system_name        string,
  s_rpc_service           string,
  s_error_type            string,

  -- nested, rarely filtered
  events  list<struct<time_unix_nano long, name string,
                      attrs map<string,string>>>,
  links   list<struct<trace_id fixed(16), span_id fixed(8),
                      trace_state string, attrs map<string,string>>>,

  -- derived
  sample_weight       float,                    -- 1 / sampling probability; null means 1
  has_exception       boolean,                  -- any event named "exception"
  -- phase 2, filled only by sealed-partition compaction
  nested_left         int,
  nested_right        int,
  parent_local_id     int
)
PARTITIONED BY (hours(start_time))              -- days(start_time) for small tenants
-- Iceberg sort order:
--   service_name ASC, span_name ASC, start_time ASC
```

Layout:

- **Partition:** `hours(start_time)`. Use partition evolution to `days()` for tenants whose hour
  partitions would be far below the target file size. Do not add `bucket(trace_id)`; it
  multiplies file count and only helps ID lookups, which the filter and rollup cover.
- **Sort:** `(service_name, span_name, start_time)`. This is the ClickStack and Jaeger choice
  [V/V2]. Search by service and operation prunes by min/max at file, row-group, and page level.
  Resource columns become long runs and compress to almost nothing.
  - Variant to benchmark: `(service_name, resource_fp, span_name, start_time)`. It gives pruning
    for any resource-attribute filter through a fingerprint lookup (SigNoz), at the cost of
    weaker span-name clustering.
- **Row groups:** about 50k–100k spans, capped at roughly 16–32 MB uncompressed for the widest
  commonly projected column set. Data pages of about 64 KB or 5–10k rows, with column index and
  offset index written. Tempo's 250 MB row groups cannot be read in an isolate.
- **File size:** L0 is whatever the DO flushes (roughly 1–16 MB every 10–60 s). Compacted files
  target 64–128 MB. That is the low end of Cloudflare's 64–512 MB compaction range [V2], and it
  keeps footers small. Keep column count bounded (about 60–80 leaf columns), because footer
  parse cost grows with columns × row groups.
- **Encoding:** zstd level 3. Dictionary on `service_name`, `span_name`, promoted strings, and
  map keys. `DELTA_BINARY_PACKED` on times and durations. No dictionary on `trace_id` or
  `span_id`. For high-cardinality or long promoted values (URLs, SQL text), disable the
  dictionary, following Tempo's `blob` rule [V].
- **Parquet bloom filters:** on `trace_id` per row group, sized for the row group's distinct
  trace count at about 1% false positives. Optionally on one or two promoted high-cardinality
  columns that users search by equality (`user.id`, `request.id`). Not on anything else.

Promoted-attribute rule, borrowed from Tempo's exclusivity and using Iceberg schema evolution:

- A promoted key is written only to its column and never also to the residual map.
- Promotion is an `ADD COLUMN`. It is metadata-only, and old files read it as null.
- The planner resolves `span.http.route = "x"` per file. If the file's schema has the field ID,
  it filters on the column and uses its statistics. Otherwise it filters on
  `span_attrs_str['http.route']`.
- Type conflicts (the promoted type is int but a string arrives) send that value to the
  residual. Tempo does this too: a dedicated column "holds a value only when it matches the
  expected type" [V].
- Choose candidates as Tempo's `tempo-cli analyse blocks` does: by bytes contributed to the
  residual maps, measured at compaction, not only by query frequency [V]. Demotion means
  stopping writes to the column. Drop it after retention passes.
- Cap at about 20–30 promoted columns per scope per tenant.

### 6.3 `trace_index` rollup table

One row per (trace, data file) fragment, written at flush and re-aggregated at compaction.

```sql
CREATE TABLE trace_index (
  trace_id          fixed(16)   NOT NULL,
  min_start_time    timestamptz NOT NULL,
  max_end_time      timestamptz NOT NULL,
  span_count        int         NOT NULL,
  error_count       int         NOT NULL,
  root_service_name string,                 -- null until the root span has been seen
  root_span_name    string,
  services          list<string>            -- distinct services, capped
)
PARTITIONED BY (days(min_start_time))
-- sort order: trace_id ASC
```

What it serves:

- **Trace by ID without a time hint.** Files are sorted by `trace_id` with a page index, so the
  lookup is a binary search: about 2–3 range GETs per file per day. With a handful of compacted
  files per day and 30 days of retention, that is on the order of 100 parallel small GETs in
  the worst case. The result is a time range, after which the `spans` lookup is a normal
  time-pruned bloom-filtered read. A per-file binary-fuse filter in a Puffin sidecar can remove
  most of those GETs later if needed.
- **Trace-level TraceQL intrinsics** (`traceDuration`, `rootServiceName`, `rootName`) and the
  search result list, without touching the root span. These are the equivalents of Tempo's
  trace-level columns [V].
- **Compaction-time sampling decisions** (§5.2).

Size: about 30–60 bytes per trace fragment, dominated by the incompressible ID. Fragments for
the same trace in different files are merged at query time (min, max, sum, first non-null).

Trace-by-ID read path:

1. With a time hint (exemplar or log link), skip to step 3.
2. Look up `trace_index` to get `[min_start, max_end]`.
3. Plan `spans` files for those hours from Iceberg manifests.
4. For each file: read the footer (cached), then the `trace_id` bloom per row group (bloom
   blocks are contiguous near the footer, so one coalesced range GET), then for matching row
   groups read the `trace_id` pages and the projected columns for matching rows.
5. Also ask the ingest DOs for unflushed spans. If a DO cannot answer, fail the request
   rather than return a partial trace, as Tempo 3.0 does [V2].

### 6.4 `logs` table

```sql
CREATE TABLE logs (
  timestamp           timestamptz NOT NULL,   -- microseconds; falls back to observed time
  time_unix_nano      long        NOT NULL,
  observed_unix_nano  long,
  severity_number     int,                    -- OTLP 1..24
  severity_text       string,
  body                string,                 -- string bodies, or JSON text of structured ones
  body_kind           int,                    -- 0 string, 1 kvlist/JSON, 2 bytes
  event_name          string,
  trace_id            fixed(16),
  span_id             fixed(8),
  flags               int,

  service_name        string      NOT NULL,   -- defaults to "unknown_service"
  resource_fp         long        NOT NULL,   -- the "stream" identity
  resource_attrs      map<string,string>,
  scope_name          string,

  log_attrs_str       map<string,string>,
  log_attrs_num       map<string,double>,
  -- promoted columns, per tenant, same rule as spans
  r_k8s_namespace_name string,
  r_k8s_pod_name       string,
  r_host_name          string,
  l_http_route         string,

  template_id         long                    -- phase 2: Drain template hash
)
PARTITIONED BY (hours(timestamp))             -- days() for small tenants
-- sort order: service_name ASC, resource_fp ASC, timestamp ASC
```

- **Sort** `(service_name, resource_fp, timestamp)` is stream-first, as in Loki 4 dataobj [V],
  VictoriaLogs [V], and Elastic logsdb (`host.name`, `@timestamp`) [V2]. It gives the best body
  compression because similar lines are adjacent. Stream selectors prune by min/max. Time
  ranges within a stream prune at page level. Tail and context queries ("lines around this
  one") are contiguous reads.
- **Row groups** of about 50k–100k rows. `body` pages of at most about 1 MB uncompressed so a
  scan decodes one page at a time.
- **Bloom filters:** on `trace_id` (log-to-trace links). No Parquet bloom on `body`, because it
  would be a whole-value bloom and useless for token search.
- **OTLP mapping:** `Body` of AnyValue type string goes to `body`. A kvlist body goes to JSON in
  `body` with `body_kind = 1`, and its top-level scalar fields are also copied into
  `log_attrs_*`, so structured logs are filterable without parsing at query time. Loki's
  engineers named query-time parsing as an unsolved cost [V].

**Full-text strategy, in phases:**

- **Phase 1: no text index.** Prune by time, service, stream, severity, and promoted columns,
  then substring or regex scan of `body` pages in WASM. Cache per-file results. Apply a scan
  budget in bytes per query, with a clear error when exceeded. This is the Loki model, and it
  already runs on columnar, stream-sorted data.
- **Phase 2: per-file token index sidecar**, built at compaction only (L0 files are small and
  recent, so brute force is fine). Design, combining Husky and the ClickHouse text index:
  - Tokenize `body` and string attribute values on non-alphanumerics, lowercase, and keep
    tokens of length 4 or more (Loki's NIAH uses 6 [V]).
  - Store a sorted, front-coded token dictionary in blocks, a sparse index of block first
    tokens, and for each token a bitset or short list of **row-group or page ordinals**, not
    row IDs.
  - A term lookup costs the sidecar header (cacheable) plus one dictionary block. `AND` and
    `OR` of terms are bitset operations before any data page is read.
  - Substring or regex queries use the longest required literal. If it contains a whole token,
    use the index; otherwise scan.
  - Expected size is a few percent of the data, because most tokens are rare (the median token
    appears in 1–2 rows in ClickHouse's measurements [V]) and granularity is coarse.
  - Engage it only when the planned scan exceeds a threshold. Loki uses 10 GiB [V].
- **Not recommended:** n-gram blooms (Loki's retired path [V2]) and tantivy splits (heavy
  indexing CPU, a second copy of the data, and poor fit for 128 MB isolates).

**Pattern extraction (phase 2):** run Drain per `(service_name, severity)` in the ingest DO,
with bounded tree size, or at compaction. Store `template_id` and a small `log_patterns` table
(template text, first and last seen, count). This gives a patterns view, cheap "new pattern"
alerting, and an exact pruning column (`template_id = X` has good min/max and dictionary
behavior inside a stream).

### 6.5 Query languages

| Option | For | Against |
|---|---|---|
| LogQL subset | Grafana Loki datasource works unchanged; users know it | Stream/label model does not match OTLP; pipeline parsers are query-time; "no way to specify where a field lives" [V] |
| SQL | Free through Cloudflare's SQL engine; analysts know it | Poor for interactive log search and Grafana Explore; exposes the physical schema |
| TraceQL-like scoped syntax for logs | Consistent with OTel scopes (`resource.`, `log.`) and with traces | A new language; no client support |

Recommendation:

1. **TraceQL** for traces, including metrics functions and exemplars. Mark structural operators
   and their limits clearly.
2. **LogQL subset** as the public log language:
   - Stream selector `{service_name="x", k8s_namespace_name=~"prod.*"}` maps to `service_name`,
     promoted resource columns, then `resource_attrs`. Loki's OTLP label naming (dots to
     underscores) should be accepted.
   - Line filters `|=`, `!=`, `|~`, `!~`.
   - Label filters after the selector map to log attributes and promoted columns.
   - `| json` and `| logfmt` are accepted. They are no-ops when the fields already exist as
     attributes, and real parsers otherwise.
   - Metric queries: `rate`, `count_over_time`, `bytes_over_time`, `sum/avg/min/max/quantile by`,
     and limited `unwrap`.
   - Out of scope for v1: `line_format`-dependent filtering, `label_replace`, binary operations
     between log-metric vectors beyond basic arithmetic.
3. **SQL passthrough** to the Iceberg tables for analytics and export.
4. One internal logical plan (scan → filter → project → aggregate/group by time → topk) that
   TraceQL, LogQL, and PromQL-on-span-metrics all compile into. The pruning and promoted-column
   resolution logic then exists once. Internally, attributes are always scope-qualified, which
   fixes LogQL's field-location ambiguity without changing its surface.

### 6.6 Index strategy summary

| Need | Mechanism | Where it lives |
|---|---|---|
| Time pruning | Iceberg hour/day partitions and manifest bounds | Iceberg metadata |
| Service, operation, stream pruning | Sort order, row-group stats, page index | Parquet footer and page index |
| Promoted attribute filters | Typed columns with stats and dictionary | Parquet |
| Trace ID within a file | Parquet bloom per row group | Parquet |
| Trace ID across time | `trace_index` table, sorted by `trace_id` | Iceberg table |
| Trace ID across files (optional) | Binary-fuse filter per file or per partition | Puffin-format sidecar |
| Log full text (phase 2) | Token → row-group/page bitset index | Puffin-format sidecar per compacted file |
| Repeated queries | Per-file result cache keyed by (file, plan-fragment hash) | Cache API, KV, or R2 |

Sidecar lifecycle:

- Name sidecars deterministically from the data file (`<data-file-path>.idx.puffin`), so no
  extra catalog state is needed to find them and a missing sidecar is simply a cache miss.
- Write the sidecar before committing the Iceberg snapshot that adds the data file.
- Delete sidecars in the same job that deletes the data file after snapshot expiration.
- Use the Puffin container (blob type, offsets, properties in a footer) so that blobs can be
  registered with the catalog if the Iceberg index framework lands.

### 6.7 Alternatives and trade-offs

| Decision | Recommended | Alternative | When the alternative wins |
|---|---|---|---|
| Span row model | Flat, row per span | Nested, row per trace (Tempo) | If whole-trace fetch dominates and compute is plentiful. Neither holds for viz. |
| Spans sort | `(service_name, span_name, start_time)` | `(trace_id)` | If trace-by-ID and structural queries dominate search and metrics. Jaeger measured about 4× faster retrieval and about 18× slower search [V]. |
| Dual layout | Single table plus `trace_index` | Two full copies, one per sort | If storage is free and both query classes are hot. Doubles write and compaction cost. |
| Trace-ID partitioning | None | `bucket(16, trace_id)` | Very large tenants with heavy ID-lookup traffic and no time hints |
| Attributes | Promoted columns plus residual maps | Shredded VARIANT | Once Cloudflare's SQL engine and a Workers reader both support shredded Variant with pushdown. Migrate the residual maps only; promoted columns stay. |
| Events and links | Nested lists in the span row | Separate `span_events` table | If event search (for example on `exception.message`) becomes a primary workflow |
| Log text search | Scan, then token sidecar | Tantivy splits (Quickwit/OpenObserve) | If relevance ranking or sub-second needle search over months is required |
| Structural operators | Query-time join; nested set later | Nested set from day one | If structural queries inside metrics are a headline feature |
| Compaction | Owned by viz | Cloudflare managed compaction | If it is confirmed to preserve sort order and viz gives up blooms and sidecars |
| Span metrics | Query-time, with optional flush-time rollup | Always pre-aggregate (metrics-generator) | Long-range dashboards at very high span volume |

### 6.8 Costs to watch

- **GET count per query.** Each file costs a footer read plus bloom or page-index reads plus
  data ranges. Cache footers aggressively, since they are immutable. Keep file count per
  partition low through compaction. OpenObserve's tuning case is exactly this problem [V2].
- **L0 tail.** Between flush and compaction, many small unsorted-relative-to-each-other files
  exist. Each is internally sorted, and the count is bounded by flush interval × shards.
  Compaction should run within minutes for hot partitions.
- **Compaction memory.** Inputs are each sorted by the table sort key, so compaction is a k-way
  streaming merge with page-sized buffers. That fits an isolate. Computing nested sets or
  service edges needs a different grouping (by trace), which means an external sort over
  narrow ID tuples. That is another reason to defer nested sets.
- **Wide traces and huge attributes.** Tempo notes that large attributes caused querier
  out-of-memory failures [V]. Enforce per-attribute and per-span size limits at ingest and
  truncate with a marker.

---

## 7. Open questions / unverified

Platform (highest priority, because they change the design):

1. Does Cloudflare's managed compaction (R2 Data Catalog / "Basin Catalog") honor the Iceberg
   table sort order, preserve Parquet bloom filters, and write page indexes? If not, viz must
   own compaction or disable the managed one. Not documented on the pages I read.
2. Which Iceberg format version does the catalog support (v2 or v3)? This decides
   `timestamp_ns`, deletion vectors, and Variant. Not found.
3. Does the Cloudflare SQL engine use Parquet bloom filters and page indexes, and can it filter
   on `fixed(16)` columns ergonomically? Not documented.
4. The rename to "Basin" and its GA status come from changelog search snippets only.
5. Current Workers limits (memory, CPU time, subrequests per invocation, R2 operation pricing)
   were not re-checked in this document.

Formats and libraries:

6. Is there a Rust/WASM Parquet reader usable in Workers with shredded-Variant reads and
   predicate pushdown? Not searched (budget exhausted).
7. Parquet-native bloom filter size for `trace_id` at the proposed row-group size, and whether
   the chosen writer places bloom blocks contiguously, need measuring.
8. Binary-fuse filter figures (bits per key, false-positive rates) are from training knowledge.

Other systems:

9. Tempo structural-operator evaluation and the trace-by-ID row-group search are described from
   training knowledge. The search for confirmation did not run.
10. Tempo's `parquet_row_group_size_bytes` default reads 250 MB on the main-branch docs. I
    recall 100 MB for older releases and did not check which release changed it.
11. Loki 4.0 is a release candidate. Whether the new engine is default, and what "Unplug the V2
    query engine" means, is unresolved. I found no statement that bloom components are removed
    in 4.0, only that they are deprecated.
12. The internals of Loki's needle-in-a-haystack index are undisclosed.
13. SigNoz ordering key and bucket size, Uptrace's table split, Quickwit hotcache contents and
    split sizes, VictoriaLogs block sizes, and Drain/CLP details are training knowledge.
14. OpenObserve's trace-ID bloom post could not be fetched. Parseable facts come from
    third-party mirrors.
15. Iceberg secondary-index status comes from a single third-party write-up dated 2026-11-16.

Design questions for viz to settle by experiment:

16. Benchmark `(service_name, span_name, start_time)` against
    `(service_name, resource_fp, span_name, start_time)` and against `(trace_id)` on a real
    tenant: bytes read and GETs for search, trace-by-ID, `rate() by service`, and one
    structural query.
17. Is `trace_index` lookup latency acceptable at 30-day retention without a fuse-filter
    sidecar?
18. What fraction of real TraceQL usage is structural? This decides whether nested-set columns
    are worth the compaction cost.
19. Table-per-tenant or shared tables with `tenant_id`: interacts with catalog limits and
    minimum cost, and is out of scope here.
20. What WASM substring and regex throughput is achievable within Worker CPU limits? This sets
    the phase-1 scan budget and the threshold for the token index.

---

## 8. Sources

Tempo
- Tempo 3.0 release blog (2026-06-01): https://grafana.com/blog/tempo-3-0-release-all-the-latest-features
- Tempo 3.0 release notes: https://grafana.com/docs/tempo/latest/release-notes/v3-0/
- Migrate to 3.0: https://grafana.com/docs/tempo/latest/set-up-for-tracing/migrate-to-3/
- Parquet schema: https://grafana.com/docs/tempo/latest/operations/schema/
- vParquet5 `schema.go`: https://raw.githubusercontent.com/grafana/tempo/main/tempodb/encoding/vparquet5/schema.go
- Dedicated attribute columns: https://grafana.com/docs/tempo/latest/operations/dedicated_columns/
- Parquet configuration: https://grafana.com/docs/tempo/latest/configuration/parquet/
- Configuration reference (main): https://raw.githubusercontent.com/grafana/tempo/main/docs/sources/tempo/configuration/_index.md
- TraceQL metrics queries: https://grafana.com/docs/tempo/latest/traceql/metrics-queries/
- Tempo 2.2 structural operators: https://grafana.com/blog/grafana-tempo-2-2-release-traceql-structural-operators-are-here
- Tempo 2.3 release: https://grafana.com/blog/2023/11/01/grafana-tempo-2.3-release-faster-trace-queries-traceql-upgrades/
- Trace-by-ID discussion: https://www.github.com/grafana/tempo/discussions/3517

Loki
- Loki v4.0.0-rc.2 changelog: https://newreleases.io/project/github/grafana/loki/release/v4.0.0-rc.2
- dataobj README: https://raw.githubusercontent.com/grafana/loki/main/pkg/dataobj/README.md
- GrafanaCON 2026, Loki petabyte-scale architecture: https://grafana.com/events/grafanacon/2026/agenda/loki-petabyte-scale-logging-architecture
- Needle-in-a-haystack (Logline) docs: https://grafana.com/docs/grafana-cloud/send-data/logs/niah/
- Logline acquisition: https://grafana.com/blog/grafana-labs-acquires-logline
- Bloom filters (deprecated): https://grafana.com/docs/loki/next/operations/bloom-filters/
- Query acceleration blooms: https://grafana.com/docs/loki/next/operations/query-acceleration-blooms/
- Loki 3.3 release notes: https://grafana.com/docs/loki/latest/release-notes/v3-3/
- OpenShift Logging issue on Loki 4 dataobj: https://issues.redhat.com/browse/LOG-7350

Jaeger, ClickHouse family
- Jaeger ClickHouse backend (CNCF, 2026-06-23): https://cncf.io/blog/2026/06/23/building-jaegers-clickhouse-backend-8-6x-compression-on-10-million-spans
- Jaeger ClickHouse docs (2.18): https://www.jaegertracing.io/docs/2.18/storage/clickhouse/
- Jaeger ClickHouse design decisions: https://medium.com/jaegertracing/making-design-decisions-for-clickhouse-as-a-core-storage-backend-in-jaeger-62bf90a979d
- Jaeger v2 release: https://www.cncf.io/blog/2024/11/12/jaeger-v2-released-opentelemetry-in-the-core/
- ClickStack schemas: https://clickhouse.com/docs/clickstack/ingesting-data/schemas
- ClickStack performance tuning: https://clickhouse.com/docs/clickstack/managing/performance-tuning
- ClickHouse full-text search GA: https://clickhouse.com/blog/full-text-search-ga-release
- ClickHouse full-text search for object storage: https://clickhouse.com/blog/clickhouse-full-text-search-object-storage
- SigNoz traces schema: https://signoz.io/docs/userguide/writing-clickhouse-traces-query/

Other engines
- Datadog Husky query architecture: https://www.datadoghq.com/blog/engineering/husky-query-architecture/
- Introducing Husky: https://www.datadoghq.com/blog/engineering/introducing-husky/
- Husky deep dive: https://www.datadoghq.com/blog/engineering/husky-deep-dive/
- Quickwit architecture: https://quickwit.io/docs/overview/architecture
- Quickwit joins Datadog: https://quickwit.io/blog/quickwit-joins-datadog
- OpenObserve tantivy index: https://openobserve.ai/docs/user-guide/advanced/query-tuning/tantivy-index/
- OpenObserve tantivy tuning post: https://openobserve.ai/blog/openobserve-tantivy-49s-to-2s
- OpenObserve bloom post (not fetched): https://openobserve.ai/blog/openobserve-bloom-filter-2.6s-to-89ms/
- GreptimeDB indexing (Puffin, FST): https://docs.greptime.com/developer-guide/datanode/data-persistence-indexing
- Parseable case study: https://www.tigrisdata.com/blog/case-study-parseable/
- Honeycomb serverless (InfoQ): https://www.infoq.com/presentations/honeycomb-serverless
- Honeycomb storage engine: https://www.honeycomb.io/blog/virtualizing-storage-engine
- Honeycomb secondary storage: https://www.honeycomb.io/blog/secondary-storage-to-just-storage
- Axiom architecture: https://axiom.co/docs/platform-overview/architecture
- VictoriaLogs FAQ: https://docs.victoriametrics.com/victorialogs/faq/
- VictoriaTraces v0.7.0: https://newreleases.io/project/github/VictoriaMetrics/VictoriaTraces/release/v0.7.0
- VictoriaTraces v0.9.4: https://newreleases.io/project/github/VictoriaMetrics/VictoriaTraces/release/v0.9.4
- VictoriaMetrics January 2026 updates: https://victoriametrics.com/blog/victoriametrics-january-2026-ecosystem-updates/
- Elastic logsdb: https://www.elastic.co/search-labs/blog/elasticsearch-logsdb-index-mode
- Elastic logs data stream configuration: https://www.elastic.co/docs/manage-data/data-store/data-streams/logs-data-stream-configure
- OTel-Arrow phase 2: https://opentelemetry.io/blog/2026/otel-arrow-phase-2/
- otel-arrow repository: https://github.com/open-telemetry/otel-arrow
- otlp2parquet: https://lib.rs/crates/otlp2parquet

Iceberg, Variant, Cloudflare
- Variant in Apache Iceberg: https://iceberg.apache.org/blog/variant-in-apache-iceberg/
- Iceberg 1.12.0 overview (Dremio): https://www.dremio.com/blog/apache-iceberg-1-12-0-whats-new-breaking-changes-and-upgrade-guide
- S3 Tables Variant support: https://aws.amazon.com/about-aws/whats-new/2026/07/amazon-s3-tables-variant-iceberg-v3/
- Snowflake Iceberg v3 Variant: https://www.snowflake.com/en/blog/engineering/snowflake-iceberg-v3-variant-performance/
- Iceberg secondary indexes status (2026-11-16): https://iceberglakehouse.com/posts/iceberg-secondary-indexes-rest-puffin-lifecycle/
- Iceberg dev-list index threads: https://go.mail-archive.com/dev@iceberg.apache.org/msg12392.html
- Cloudflare SQL limitations and best practices: https://developers.cloudflare.com/basin-sql/reference/limitations-best-practices/
- Cloudflare joins and subqueries changelog: https://developers.cloudflare.com/changelog/post/2026-05-14-joins-subqueries-multi-table-queries/
- Cloudflare compaction changelog: https://developers.cloudflare.com/changelog/post/2025-09-25-data-catalog-compaction/
- Cloudflare compaction docs: https://developers.cloudflare.com/r2/data-catalog/about-compaction
- Cloudflare R2 Data Catalog changelog: https://developers.cloudflare.com/changelog/product/r2-data-catalog/
- Cloudflare Data Platform (InfoQ): https://www.infoq.com/news/2025/11/cloudflare-data-platform
- R2 SQL aggregations (InfoQ): https://www.infoq.com/news/2026/01/cloudflare-r2-sql-aggregations
