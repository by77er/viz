# Logs table (`logs`)

**Status: proposed.** No storage component writes or reads this table yet. The LogQL engine
(`engine/logql`, `viz-logql`) evaluates over an in-memory source shaped like this contract,
so the shapes below are what it expects storage to hand it. Everything marked *proposed*
is a design that a storage implementation may still change, here first, before code.

Sources: `design/DESIGN.md` §5.1 and §6.4, `design/DECISIONS.md` D6 (flat rows) and D10
(per-signal tables), `research/04-traces-logs-storage.md` §3.1, §4.2 and §6.4.

## 1. What a row is

One row per log record, flat (D6). A **stream** is a tenant plus a set of stream labels;
every row belongs to exactly one stream.

- **Loki push** (`/loki/api/v1/push`): the stream labels are the pushed stream's labels,
  structured metadata is the entry's structured metadata.
- **OTLP logs** (*proposed*): the stream labels are the resource attributes, with every
  character that is not `[A-Za-z0-9_]` in a name replaced by `_` (so
  `service.name` becomes `service_name`), plus `service_name = "unknown_service"` when the
  resource has no `service.name`. Log-record attributes and scope attributes become
  structured metadata with the same name rule. Which resource attributes stay stream
  labels and which move to structured metadata (to bound stream cardinality) is a
  per-tenant setting that is not defined yet.

The tenant is never a column: files are tenant-pure and the tenant is part of every object
key (`TABLES.md`, "Object keys"), and tail batches belong to one tenant. Every read names
the tenant, which comes from the credential.

## 2. Columns

| Column | Parquet type | Notes |
|---|---|---|
| `service_name` | BYTE_ARRAY (UTF8), required | value of the `service_name` stream label, `""` if absent; first sort key; dictionary |
| `stream_id` | INT64, required | FNV-1a 64 over the stream labels, exactly as `series_id` in `BATCH.md` (sorted by name in UTF-8 byte order, `name 0x00 value 0x00`), with no `__name__` |
| `ts` | INT64, required | Unix **nanoseconds**; DELTA_BINARY_PACKED |
| `labels` | BYTE_ARRAY (UTF8), required | canonical JSON (`TABLES.md`) of the stream labels; dictionary-encoded, so with the sort order a file stores each stream's labels about once |
| `line` | BYTE_ARRAY (UTF8), required | the log line (OTLP: a string body; any other body as its JSON text) |
| `metadata` | MAP<UTF8, UTF8>, required (may be empty) | structured metadata, keys unique and sorted |
| `observed_ts` | INT64, optional | OTLP `observed_time_unix_nano` |
| `severity_number` | INT32, optional | OTLP 1–24 |
| `severity_text` | BYTE_ARRAY (UTF8), optional | |
| `trace_id` | FIXED_LEN_BYTE_ARRAY(16), optional | |
| `span_id` | FIXED_LEN_BYTE_ARRAY(8), optional | |
| `flags` | INT32, optional | OTLP trace flags |

Limits (*proposed*, enforced by `edge` on ingest and refused with a reason): a line is at
most 256 KiB; a stream has at most 32 labels; label and metadata names follow `BATCH.md`
(non-empty, at most 1,024 bytes) and values at most 8,192 bytes; a row has at most 128
metadata entries. Empty-valued stream labels are dropped, as for metrics.

## 3. What LogQL sees

`viz-logql` takes rows as `LogStream { labels, entries: [LogRow { ts_ns, line, metadata }] }`.
The mapping from a row:

| LogQL | From |
|---|---|
| stream labels (`{…}` selectors match these) | `labels` |
| structured metadata (label filters and `drop`/`keep` see these after the stream labels) | `metadata`, plus, when present: `trace_id` and `span_id` as lowercase hex, `severity_text`, `severity_number` as decimal text, `observed_timestamp` as decimal nanoseconds, `flags` as decimal text. A `metadata` key with the same name wins over these (*proposed*) |
| timestamp | `ts` |
| line | `line` |

## 4. Sort order, partitioning, files

- **Sort order**: `service_name`, `stream_id`, `ts`, `line`. Stream-first, as Loki's
  dataobj, VictoriaLogs and Elastic logsdb (research 04 §6.4): it compresses best and lets
  a stream selector prune by row-group statistics. `line` is last only to make the order
  total.
- **Duplicates**: the row key is `(stream_id, ts, line, metadata)`. Rows equal on all four
  are one row: a retried push stored twice is invisible in results and removed at flush
  and compaction, as `(series_id, ts)` is for metrics. Rows that differ in `line` or
  `metadata` at the same `ts` are all kept.
- **Partitioning and keys**: one tenant and one UTC day per file, with the object keys and
  levels of `TABLES.md` and table name `logs`. Hour-level clustering comes from compaction
  levels as for metrics (*proposed*; research 04 suggests hour partitions for large tenants).
- **Row groups**: at most 100,000 rows, and `line` data pages at most 1 MiB uncompressed,
  so a scan decodes one page at a time in a 128 MB isolate.
- **Statistics**: row-group statistics on `service_name`, `stream_id` and `ts`; Parquet bloom
  filter on `trace_id` (log-to-trace links). No Parquet bloom on `line`: a whole-value bloom
  cannot answer substring search.

## 5. Index fragment (*proposed*)

Each file's index fragment (`FileEntry.index` in `ledger.ts`, produced and read only by the
engine) lists, per row group: the distinct streams it holds (`stream_id` and labels) with
each stream's minimum and maximum `ts`. A planner prunes files and row groups with a stream
selector's matchers and a time range from the fragment alone, before any object read.

## 6. Line filters and the token filter (*proposed*, phase 2)

Phase 1 has no text index: rows are pruned by time, stream and statistics, then `line` is
scanned (research 04 §6.4). Phase 2 adds a per-file **token filter**, written at compaction
(never at flush), and always advisory: a missing or unreadable filter means "read the row
group", and results are identical with and without it.

- **Tokens** of a text are its maximal runs of ASCII letters, ASCII digits and non-ASCII
  characters, lowercased (ASCII only), of at least 4 bytes. A text's token set covers
  `line` and every structured-metadata value.
- The filter maps each token to the set of row groups that contain it (the format, a
  sorted front-coded dictionary with row-group bitsets as in research 04 §6.4, is defined
  with the first implementation).
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

## 8. Not defined here

- The tail-batch encoding for logs (a `VZB1` signal 2, or another format) belongs in
  `BATCH.md` once ingest is built.
- Retention and deletion by line filter (Loki's delete API) are not designed.
- Promoted metadata columns (`l_…`) for frequently filtered keys, the per-tenant choice of
  OTLP stream labels, and `template_id` (Drain patterns, research 04 §6.4) come later.
