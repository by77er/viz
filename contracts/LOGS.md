# Logs table (`logs`)

**Status (2026-11-19): the file layout, the ingest mapping and the batch are settled and
written; reading, flushing, the ledger and the token filter are proposed.**
`engine/storage` (`src/logs.rs`) writes `logs` files from log-record batches
(`contracts/BATCH.md`, signal 3) exactly as below and reads them back; `edge` decodes OTLP
logs and Loki push into those batches. No flush, ledger, query or publisher path uses them
yet (stage 2). The LogQL engine (`engine/logql`, `viz-logql`) evaluates over an in-memory
source shaped like this contract, and a test reads files written here through its
`LogSource` seam and gets the same answers (`engine/storage/readback`). Everything still
marked *proposed* may change, here first, before code.

Sources: `design/DESIGN.md` §5.1 and §6.4, `design/DECISIONS.md` D6 (flat rows), D10
(per-signal tables), D57 (streams per signal) and D58 (OTLP stream labels), `research/04-traces-logs-storage.md`
§3.1, §4.2 and §6.4, Loki's documentation of its OTLP mapping
(grafana.com/docs/loki/latest/send-data/otel, read 2026-11-19).

## 1. What a row is

One row per log record, flat (D6). A **stream** is a tenant plus a set of stream labels;
every row belongs to exactly one stream.

**Label-name rule.** Stream label names and structured-metadata names match
`[A-Za-z_][A-Za-z0-9_]*` and are at most 1,024 bytes; values are non-empty (empty values
are dropped, as for metrics), at most 8,192 bytes, with no NUL byte.

**Loki push** (`/loki/api/v1/push`, protobuf with snappy, or JSON optionally gzipped):

- the stream labels are the pushed stream's labels (the protobuf `labels` string is parsed
  as a Prometheus label set, `{name="value", …}` with Go string escapes); a stream whose
  labels break the name rule, repeat a name or are left empty is refused with all its
  entries;
- the timestamp is the entry's (protobuf `Timestamp`: seconds and nanos; JSON: a decimal
  string of nanoseconds);
- structured metadata is the entry's structured metadata (JSON: the optional third element,
  an object of strings); an entry whose metadata breaks the name rule or repeats a name is
  refused. The protobuf `parsed` field is ignored.

**OTLP logs** (`/v1/logs`, protobuf or JSON, optionally gzipped):

- **Stream labels** are the resource attributes whose keys are in this list, with their
  names made by the name mapping below, plus `service_name = "unknown_service"` when the
  resource has no `service.name`:
  `service.name`, `service.namespace`, `deployment.environment.name`, `cloud.region`,
  `cloud.availability_zone`, `k8s.cluster.name`, `k8s.namespace.name`,
  `k8s.container.name`, `container.name`, `k8s.replicaset.name`, `k8s.deployment.name`,
  `k8s.statefulset.name`, `k8s.daemonset.name`, `k8s.cronjob.name`, `k8s.job.name`.
  This is Loki's documented default list without `k8s.pod.name` and
  `service.instance.id`, which Loki's documentation itself no longer recommends as labels
  (cardinality); with them out, a stream has at most 16 OTLP labels. (D58.)
- **Structured metadata** is every other resource attribute, every instrumentation-scope
  attribute, and every log-record attribute, with names made by the same mapping. When two
  attributes of one list map to one name their values are joined with `;` in arrival
  order; across lists the more specific wins (record over scope over resource). A
  key-value-list value is flattened: `{a: {b: 1}}` gives `a_b = "1"`, at any depth.
- **Name mapping**: every character that is not `[A-Za-z0-9_]` becomes `_` (so
  `service.name` is `service_name`), and a name that starts with a digit gets a `_` in
  front. An attribute with an empty key refuses its record (for a resource or scope
  attribute: every record of that resource or scope).
- **Values** are the attribute's plain JSON text (`contracts/BATCH.md`): a string as is,
  `true`, `42`, `1.5`, `["a",1]`, base64 for bytes. Empty values are dropped.
- **Line**: a string body is the line; any other body is its plain JSON text; no body, or
  a body with no value set, is `""`.
- **Timestamp**: `time_unix_nano`, else `observed_time_unix_nano`. A record with neither is
  refused (Loki would use the time of ingestion; viz does not, because a retried request
  would then store the record again under a new timestamp).
- `observed_ts`, `severity_number` (1–24; 0 is absent, anything above 24 refuses the
  record), `severity_text`, `trace_id`, `span_id` (all-zero or empty is absent; another
  length than 16 or 8 refuses the record) and `flags` (0 is absent) go to their columns.
- Not stored: `event_name`, the scope's name and version, `schema_url`, dropped attribute
  counts.

The tenant is never a column: files are tenant-pure and the tenant is part of every object
key (`TABLES.md`, "Object keys"), and tail batches belong to one tenant. Every read names
the tenant, which comes from the credential.

## 2. Columns

| Column | Parquet type | Encoding | Notes |
|---|---|---|---|
| `service_name` | BYTE_ARRAY (UTF8), required | dictionary | value of the `service_name` stream label, `""` if absent; first sort key |
| `stream_id` | INT64, required | DELTA_BINARY_PACKED | FNV-1a 64 over the stream labels, exactly as `series_id` in `BATCH.md` (sorted by name in UTF-8 byte order, `name 0x00 value 0x00`), with no `__name__` |
| `ts` | INT64, required | DELTA_BINARY_PACKED | Unix **nanoseconds** |
| `labels` | BYTE_ARRAY (UTF8), required | dictionary | canonical JSON (`TABLES.md`) of the stream labels; with the sort order a row group stores each stream's labels once |
| `line` | BYTE_ARRAY (UTF8), required | plain | the log line |
| `metadata` | MAP<UTF8, UTF8>, required (may be empty) | dictionary keys, dictionary values | structured metadata, keys unique and sorted by UTF-8 bytes |
| `observed_ts` | INT64, optional | DELTA_BINARY_PACKED | OTLP `observed_time_unix_nano` |
| `severity_number` | INT32, optional | dictionary | OTLP 1–24 |
| `severity_text` | BYTE_ARRAY (UTF8), optional | dictionary | |
| `trace_id` | FIXED_LEN_BYTE_ARRAY(16), optional | plain, bloom filter (1%) | |
| `span_id` | FIXED_LEN_BYTE_ARRAY(8), optional | plain | |
| `flags` | INT32, optional | dictionary | OTLP log record flags (the u32 bits) |

`metadata` is Parquet's standard `MAP` (`repeated group key_value { required key; required
value }`). Limits, enforced by `edge` on ingest and refused per record with a reason (built):
a line is at most 256 KiB; a stream has at most 32 labels; a row has at most 128 metadata
entries, together at most 64 KiB; `severity_text` is at most 1,024 bytes.

## 3. What LogQL sees

`viz-logql` takes rows as `LogStream { labels, entries: [LogRow { ts_ns, line, metadata }] }`.
The mapping from a row:

| LogQL | From |
|---|---|
| stream labels (`{…}` selectors match these) | `labels` |
| structured metadata (label filters and `drop`/`keep` see these after the stream labels) | `metadata`, plus, when present: `trace_id` and `span_id` as lowercase hex, `severity_text`, `severity_number` as decimal text, `observed_timestamp` as decimal nanoseconds, `flags` as decimal text. A `metadata` key with the same name wins over these. The result is sorted by name |
| timestamp | `ts` |
| line | `line` |

## 4. Sort order, partitioning, files

- **Sort order**: `service_name`, `stream_id`, `ts`, `line`, then `metadata` (its entries
  compared in order, name then value, as bytes) so that the order is total and a flush is
  deterministic. Stream-first, as Loki's dataobj, VictoriaLogs and Elastic logsdb (research
  04 §6.4): it compresses best and lets a stream selector prune by row-group statistics. The
  first three are declared as sorting columns.
- **Duplicates**: the row key is `(stream_id, ts, line, metadata)`. Rows equal on all four
  are one row; the later row wins for the other columns. A retried push stored twice is
  invisible in results and removed at flush and compaction, as `(series_id, ts)` is for
  metrics. Rows that differ in `line` or `metadata` at the same `ts` are all kept.
- **Partitioning and keys**: one tenant and one UTC day (of `ts`) per file, with the object
  keys and levels of `TABLES.md` and table name `logs`. Hour-level clustering comes from
  compaction levels as for metrics (*proposed*; research 04 suggests hour partitions for
  large tenants).
- **Row groups**: at most 100,000 rows and at most 16 MiB of data, a row counting 64 bytes
  plus its line, severity text, metadata bytes and its stream's label bytes.
- **Pages**: `line` data pages are at most 1 MiB uncompressed (the writer cuts a page at
  768 KiB and adds at most 256 KiB at a time), so a scan decodes one page at a time in a
  128 MB isolate; other columns as metrics (at most 20,000 rows, cut at about 256 KiB).
- **Statistics**: exact row-group min/max on every column except `labels`, `line` and
  `metadata`; the offset index on every column; no column index. Parquet bloom filter on
  `trace_id` (log-to-trace links). No Parquet bloom on `line`: a whole-value bloom cannot
  answer substring search.

## 5. Index fragment

Each file's index fragment (`FileEntry.index` in `ledger.ts`, produced and read only by the
engine) has the metrics fragment's shape (`TABLES.md`, "The index fragment"), plus a
bounded list of the file's streams:

```
{"v":1,"rg":[{"rows":N,"off":N,"len":N,"min_name":S,"max_name":S,"min_ts":N,"max_ts":N,"sid":[N,N]},…],
 "foot":[N,N],
 "streams":[[stream_id,labels,min_ts,max_ts,first_rg,last_rg],…]}
```

- `min_name`/`max_name`: smallest and largest `service_name` of the row group; `min_ts`,
  `max_ts`: of `ts`, in nanoseconds; `sid`: the `stream_id` of the row group's first and
  last row. With the sort order a row group holds only keys `(service_name, stream_id)`
  between `(min_name, sid[0])` and `(max_name, sid[1])`, exactly as for metric names and
  series ids.
- `streams`: every stream of the file in file order, with its `labels` (canonical JSON, as
  a JSON string), its first and last `ts`, and the first and last row group holding it (a
  stream's rows are contiguous). Present only when the file has at most 256 streams and
  their labels total at most 16 KiB, so a fragment stays small in the ledger; when absent a
  planner prunes by `min_name`/`max_name`, `sid` and time, and resolves a selector by reading
  the file's `labels` and `stream_id` columns (their dictionary pages).

A planner prunes files and row groups with a stream selector's matchers and a time range
from the fragment alone, before any object read, when `streams` is present.

## 6. Line filters and the token filter (*proposed*, phase 2)

Phase 1 has no text index: rows are pruned by time, stream and statistics, then `line` is
scanned (research 04 §6.4). Phase 2 adds a per-file **token filter**, written at compaction
(never at flush), and always advisory: a missing or unreadable filter means "read the row
group", and results are identical with and without it.

- **Tokens** of a text are its maximal runs of ASCII letters, ASCII digits and non-ASCII
  characters, lowercased (ASCII only), of at least 4 bytes, and cut to their first 64 bytes
  (at a character boundary). A text's token set covers `line` and every structured-metadata
  value.
- **Format** (settled here, not implemented): a separate object next to the Parquet file,
  its key the file's with `.parquet` replaced by `.tokens`, written with `If-None-Match: *`:

  ```
  0   4  magic "VZT1"
  4   4  n_row_groups u32          the file's row groups, in order
  8   4  n_tokens u32
  12  4  n_blocks u32              ceil(n_tokens / 16)
  16  4  reserved 0
  20 ... block_off u32[n_blocks]   offset of each block from the start of the blocks
      ... blocks                   tokens in UTF-8 byte order, unique, 16 to a block (the last
                                   may hold fewer); in a block, each token is u8 shared-prefix
                                   length (0 for the block's first), u8 suffix length, suffix
      ... bitsets                  n_tokens × ceil(n_row_groups / 8) bytes, token-major:
                                   bit g (byte g/8, bit g%8, least significant first) set when
                                   row group g has the token
  ```

  A reader binary-searches the blocks' first tokens and scans one block. The object is
  immutable; its size and SHA-256 go in the ledger next to the file (proposed).
- **What a query may use.** The engine's `selectors()` reports, for each selector,
  `required`: a list of clauses, each an OR of literal substrings, such that every line the
  query can return or count contains, for every clause, at least one of its literals
  (case-sensitively, before any stage that rewrites the line). A row group may be skipped
  only if, for some clause, no literal of the clause can be present. A literal implies the
  tokens that lie **strictly inside** it: runs bounded on both sides by a non-token
  character within the literal (the first and last run may be partial tokens of the line).
  A literal with no such token says nothing and its clause cannot prune.
- Negative filters (`!=`, `!~`, `!>`), regular expressions, `ip()` and filters after
  `line_format` never prune (they are not in `required`). The engine re-checks every
  filter on every row it reads, so the filter only ever saves reads.

## 7. What the engine needs from storage

`viz-logql`'s `LogSource::select(&SelectRequest)` (see `engine/logql/README.md`) is the
read seam. For each request it must return every stream whose labels satisfy all of the
request's matchers (Prometheus matcher semantics: a missing label equals `""`, regexes
fully anchored), with **every** row whose `ts` lies in `[start_ns, end_ns)`, entries in
ascending `(ts, line)` order and duplicates already removed. It may additionally drop rows
that fail the request's `required` clauses (section 6), and it may return extra rows
outside the range or streams with no rows; the engine re-filters both. The engine's
property tests check that pruning on and off gives byte-identical results.

## 8. Not defined here, or still proposed

- Everything that reads or moves these files: flush, the ledger's `logs` table, compaction,
  the query reader and its pruning, Iceberg publication (*proposed*).
- The token filter's builder and reader (format settled above).
- Retention and deletion by line filter (Loki's delete API) are not designed.
- Promoted metadata columns (`l_…`) for frequently filtered keys, a per-tenant choice of
  OTLP stream labels (the list above is the default), Loki's service-name discovery (viz
  does not invent a `service_name` label for Loki push), metering active streams, and
  `template_id` (Drain patterns, research 04 §6.4) come later.
- The accept window for logs (`edge`'s default: 24 hours back, 5 minutes ahead) is a
  default, not a contract value.
