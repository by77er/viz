# Trace tables

Status (2026-11-19): **the file layout is settled and written; reading, flushing and
publishing are proposed.** `engine/storage` (`src/spans.rs`) writes `spans` and
`trace_index` files from span batches (`contracts/BATCH.md`, signal 2) exactly as below, and
reads them back for tests; `edge` decodes OTLP traces into those batches. No flush, ledger,
query or publisher path uses them yet (stage 2). The query engine (`engine/traceql`)
evaluates over an in-memory span source with the logical shape described here (`Span`,
`TraceSummary`), and a test reads files written here into that shape and gets the same
answers (`engine/storage/readback`). What stays proposed is marked "proposed".

Sources: `design/DESIGN.md` §5.1 and §6.4, decisions D3 (tenant-pure files), D6 (flat rows),
D10 (per-signal tables), and `research/04-traces-logs-storage.md` §5–6. The metric tables'
rules in `TABLES.md` apply unless this file says otherwise.

## Rules common to both tables

- **Tenancy.** Files are tenant-pure, as for metrics. The tenant is not a column of the data
  files: it is in the object key and, in the Iceberg tables, an optional `tenant` column
  filled from the partition tuple (`identity(tenant)`), as `publisher/` does for metrics.
  Tenant identity comes only from the credential; the engine is handed one tenant's rows.
- **Format.** Parquet, format v2 data pages, snappy for now (zstd once the WASM build is
  proven). Row groups hold at most 100,000 rows and at most 16 MiB of data, whichever comes
  first (research 04 §6.2: Tempo's 250 MB row groups do not fit an isolate). A row's size for
  this bound is 96 bytes plus the bytes its variable-length values and its resource entry
  occupy in the batch (`contracts/BATCH.md`, signal 2); `trace_index` rows count 64 bytes
  plus their strings. Data pages hold at most 20,000 rows and are cut at about 256 KiB, as
  for metrics. **Statistics:** exact row-group min/max for every scalar column; the page
  index (column index with page min/max, and the offset index) for every column listed as
  "sorted" or "pruned"; no statistics for the attribute maps, the JSON columns, `events` and
  `links`, whose values are large and never compared by range. The offset index is written
  for every column.
- **Identifiers** are stored as raw bytes, never hex: `trace_id` FIXED_LEN_BYTE_ARRAY(16),
  span ids FIXED_LEN_BYTE_ARRAY(8). An all-zero `parent_span_id` from OTLP is stored as null.
  Hex is produced only at the API boundary (lower case).
- **Times** are Unix nanoseconds as INT64, the exact OTLP values. `start_time` is the same
  instant truncated to microseconds as an Iceberg `timestamptz`, so that Iceberg can derive
  hour partitions from it (the metric tables lack such a column; see `publisher/README.md`,
  contract issue 6). Spans whose start or end is outside what an INT64 of nanoseconds holds
  (1970-01-01 to 2262-04-11; an earlier draft said "years 1970–9999", which INT64
  nanoseconds cannot hold) never reach a table, nor do spans outside the accept window. A
  span whose end is before its start is stored with `end_unix_nano = start_unix_nano` and
  the span attribute `viz.clamped_end = true` (`edge` does this at ingest).
- **Attribute values are typed.** OTLP `AnyValue` kinds map to: string, int (i64), double
  (f64), bool, and "other" (arrays, key-value lists, bytes, and an AnyValue with no value). A
  key appears at most once per scope per span; if OTLP sends a key twice, the last value wins
  (`edge`).
- **Canonical OTLP JSON** (used for "other" values and for event and link attributes) is
  defined exactly in `contracts/BATCH.md` ("Rules common to signals 2 and 3"): the
  OTLP/JSON encoding of a `KeyValue` list, keys sorted by UTF-8 bytes at every depth, no
  whitespace, `intValue` as a decimal string, `bytesValue` as base64. Any OTLP-aware reader
  can decode it. `edge` produces it; storage copies it.
- **Duplicates.** `(trace_id, span_id)` identifies a span; within a file it is unique, and
  across files the file of higher precedence wins (`contracts/BATCH.md`, signal 2, "Row key").
  Readers de-duplicate on it (proposed: no reader exists yet).

## `spans`

One row per span (D6). Partitioned by tenant and **hour of `start_time`** (DESIGN §5.1): one
file per hour of start time present in a flush. Sorted by `service_name` (nulls first),
`span_name`, `start_unix_nano`, then `trace_id` and `span_id` (bytes) so that the order is
total and a flush is deterministic (research 04 §6.2: the ClickStack and Jaeger choice,
measured far better for search than trace-id order). The first three are declared as the
row groups' sorting columns.

| Column | Parquet type | Null | Encoding | Notes |
|---|---|---|---|---|
| `trace_id` | FIXED_LEN_BYTE_ARRAY(16) | required | plain, **bloom filter** per row group (1% false positives, sized for the row group's distinct ids) | never dictionary |
| `span_id` | FIXED_LEN_BYTE_ARRAY(8) | required | plain | |
| `parent_span_id` | FIXED_LEN_BYTE_ARRAY(8) | optional | plain | null for a root span |
| `trace_state` | BYTE_ARRAY (UTF8) | optional | dictionary | W3C tracestate |
| `flags` | INT32 | optional | | OTLP span flags (the u32 bits as INT32); null when 0 |
| `start_unix_nano` | INT64 | required | DELTA_BINARY_PACKED | sorted (third key) |
| `end_unix_nano` | INT64 | required | DELTA_BINARY_PACKED | `>= start_unix_nano` |
| `duration_nano` | INT64 | required | DELTA_BINARY_PACKED | `end - start`; pruned |
| `start_time` | INT64 TIMESTAMP(MICROS, UTC) | required | DELTA_BINARY_PACKED | partition source, `hours(start_time)` |
| `service_name` | BYTE_ARRAY (UTF8) | optional | dictionary | resource `service.name` when it is a string; null when absent. Sorted (first key, nulls first) |
| `span_name` | BYTE_ARRAY (UTF8) | required | dictionary | may be `""`; sorted (second key) |
| `span_kind` | INT32 | required | dictionary | OTLP: 0 unspecified, 1 internal, 2 server, 3 client, 4 producer, 5 consumer |
| `status_code` | INT32 | required | dictionary | OTLP: 0 unset, 1 ok, 2 error |
| `status_message` | BYTE_ARRAY (UTF8) | optional | dictionary | null when empty |
| `scope_name`, `scope_version` | BYTE_ARRAY (UTF8) | optional | dictionary | instrumentation scope |
| `resource_fp` | INT64 | required | DELTA_BINARY_PACKED | FNV-1a 64 over the canonical OTLP JSON of the full resource attribute list (all keys, promoted ones included), as signed i64. Groups rows of one resource |
| `r_<key>` / `s_<key>` | per promoted key | optional | dictionary (string) or delta (int) | promoted attributes, see below |
| `resource_attrs_str` | MAP<UTF8, UTF8> | optional | dictionary keys and values | residual resource attributes by type; null when the resource has none of that type. Keys sorted by UTF-8 bytes |
| `resource_attrs_int` | MAP<UTF8, INT64> | optional | | |
| `resource_attrs_dbl` | MAP<UTF8, DOUBLE> | optional | | NaN and ±Inf preserved |
| `resource_attrs_bool` | MAP<UTF8, BOOLEAN> | optional | | |
| `resource_attrs_other` | BYTE_ARRAY (UTF8) | optional | dictionary | canonical OTLP JSON key-value list of the residual "other" attributes (arrays, key-value lists, bytes, empty values); null when none |
| `span_attrs_str`, `_int`, `_dbl`, `_bool`, `_other` | as for resource | optional | span maps: dictionary keys, plain values | residual span attributes |
| `scope_attrs` | BYTE_ARRAY (UTF8) | optional | dictionary | canonical OTLP JSON of the instrumentation scope's attributes (rare); null when none |
| `events` | LIST<STRUCT<`time_unix_nano` INT64, `name` UTF8, `attrs` UTF8>> | optional | | all struct fields required; `attrs` is canonical OTLP JSON (`[]` when none); events in OTLP order; null when the span has none |
| `links` | LIST<STRUCT<`trace_id` FLBA(16), `span_id` FLBA(8), `trace_state` UTF8, `attrs` UTF8>> | optional | | all struct fields required (`trace_state` may be `""`); links in OTLP order; null when none |
| `dropped_attributes_count`, `dropped_events_count`, `dropped_links_count` | INT32 | optional | | null when zero |
| `nested_left`, `nested_right`, `parent_local_id` | INT32 | optional | | **proposed, phase 2**: nested-set numbers written only by compaction of a sealed hour, see below. Flush files do not have these columns |

Lists and maps use Parquet's standard three-level forms (`LIST`: `repeated group list {
element }`; `MAP`: `repeated group key_value { key, value }`, keys required), so any Parquet
reader decodes them (`engine/storage/README.md`: PyArrow and DuckDB read every column).

**Promoted attributes** (research 04 §4.3, §6.2). A promoted key is written only to its
column, never also to the residual map, and only when the value has the column's type; a
value of another type goes to the residual map of its type. Promotion is an Iceberg
`ADD COLUMN`, metadata-only; older files read the column as null, and a reader therefore
resolves an attribute per file: the promoted column if the file has it, else the residual
maps. The initial set, chosen from the well-known OpenTelemetry semantic conventions:

| Column | Scope and key | Type |
|---|---|---|
| `service_name` | resource `service.name` | string |
| `r_service_namespace` | resource `service.namespace` | string |
| `r_deployment_environment` | resource `deployment.environment.name` | string |
| `r_k8s_namespace_name` | resource `k8s.namespace.name` | string |
| `r_k8s_pod_name` | resource `k8s.pod.name` | string |
| `r_cloud_region` | resource `cloud.region` | string |
| `s_http_request_method` | span `http.request.method` | string |
| `s_http_response_status_code` | span `http.response.status_code` | int |
| `s_http_route` | span `http.route` | string |
| `s_db_system_name` | span `db.system.name` | string |
| `s_rpc_service` | span `rpc.service` | string |
| `s_error_type` | span `error.type` | string |

The older key `deployment.environment` is not promoted: it stays in the residual map. (An
earlier draft put it in the same column when the newer key was absent; a reader could then
not tell which key a value came from, so the logical view could not be rebuilt.)

Per-tenant promotion beyond this set (chosen by bytes contributed to the residual maps,
measured at compaction, capped at about 20–30 per scope) is **proposed**.

**Logical view.** Whatever the physical layout, a reader hands the engine, per span: the
intrinsic columns above; the resource attributes as one typed list (promoted columns
included, `service.name` included); the span attributes as one typed list; the scope name,
version and attributes; events and links with typed attributes. `engine/traceql`'s `Span`
type is exactly this view. The engine never sees which keys were promoted, so promotion
changes cost, never results. Rebuilding it (as `engine/storage/readback` does):

- a list is the union of the promoted columns that are not null and the five residual maps,
  sorted by key; a promoted column's key is the one in the table above;
- an "other" value that is an array whose elements are all strings (all ints, all doubles,
  all bools) is the engine's typed array of that kind; an empty array is an empty string
  array; any other "other" value stays canonical OTLP JSON (`AttrValue::Other`);
- `parent_span_id` null is a root; `scope_name` and `scope_version` null read as `""`.

**Trace-level values are not span columns.** `trace:duration`, `trace:rootName` and
`trace:rootService` describe the whole trace, which no single flush sees. They come from
`trace_index` (below), merged across fragments, or are computed from every span of the
trace when the engine has them all.

**Nested-set numbers (proposed, phase 2).** Structural operators are evaluated from
`span_id` and `parent_span_id` of every span of a candidate trace (research 04 §5.4); no
extra columns are needed. Compaction of a sealed hour may later add `nested_left`,
`nested_right` and `parent_local_id` so that descendant checks need only the matched spans.
A file carries the Parquet key-value metadata `viz.nested_set_complete=true` only if every
trace in it was complete when numbered; otherwise readers must fall back to the join.

**Sampling weight (proposed).** A span's sampling probability, from W3C tracestate `ot=th:`,
is not stored as a column yet; TraceQL `with(extrapolate=true)` is unsupported until it is.

**How the engine reads these values** (`engine/traceql`, chosen to match Tempo; see its
README):

- A span without `service.name` reads as `resource.service.name = ""` (Tempo stores the
  service name in a column that cannot be null, and rejects `resource.service.name = nil`).
  Storage still writes null; the engine supplies the empty string.
- Structural operators (`>`, `>>`, `<`, `<<`, `~` and their `!`/`&` forms) consider only
  spans connected to a root span through `parent_span_id`. A span whose parent (or an
  ancestor's parent) is missing from the trace takes no part in them, on either side.
  Several parentless spans in one trace are each a root, and are siblings of one another.
- `span:childCount` counts the spans whose `parent_span_id` is the span's id, connected or
  not.

## `trace_index`

One row per (trace, flush unit) **fragment**: for every trace with a span in the unit, one
row describing that trace's spans in the unit's `spans` files (however many hours they
span), written by flush next to them and re-aggregated by compaction (proposed).
Partitioned by tenant and **day** of `min_start_unix_nano` (so a unit spanning midnight has
two `trace_index` files); sorted by `trace_id` (bytes) with the page index on, so
trace-by-id is a binary search (DESIGN §6.4, research 04 §6.3). Statistics and page index on
`trace_id`, `min_start_unix_nano`, `max_end_unix_nano`; row groups and pages as for `spans`.

| Column | Parquet type | Null | Notes |
|---|---|---|---|
| `trace_id` | FIXED_LEN_BYTE_ARRAY(16) | required | sorted |
| `min_start_unix_nano` | INT64 | required | earliest span start in this fragment |
| `max_end_unix_nano` | INT64 | required | latest span end in this fragment |
| `span_count` | INT32 | required | |
| `error_count` | INT32 | required | spans with `status_code = 2` |
| `root_service_name` | BYTE_ARRAY (UTF8) | optional | the root span's `service_name`; null when the fragment holds no root span (a span with null `parent_span_id`) or the root has no string `service.name` |
| `root_span_name` | BYTE_ARRAY (UTF8) | optional | set if and only if the fragment holds a root span (so it tells the two nulls above apart) |
| `root_start_unix_nano` | INT64 | optional | start of that root span |
| `root_span_id` | FIXED_LEN_BYTE_ARRAY(8) | optional | that root span's id (the merge rule below needs it) |
| `services` | LIST<STRUCT<`name` UTF8, `spans` INT32, `errors` INT32>> | required | per-service counts in this fragment (a span without a string `service.name` counts under `""`); at most 64: the 64 with the most spans (ties: the smaller name), listed by name in UTF-8 byte order, then `services_truncated = true` |
| `services_truncated` | BOOLEAN | required | |
| `hours` | LIST<INT32> | required | the `spans` hour partitions (hours since the epoch) holding this fragment's spans, ascending, distinct; logical references survive compaction |

**Merging fragments** (at query time and at compaction): `min` of starts, `max` of ends,
sums of counts, per-service sums, union of `hours`; the root fields come from the fragment
that has them. If two fragments both claim a root, the one with the earlier
`root_start_unix_nano` wins, then the smaller span id (a trace with two parentless spans has
no single root; this rule makes the answer deterministic). Within one fragment the same
rule picks the root. The engine's `TraceSummary` (`start`, `end`, root service and name,
per-service counts) is this merged row; merged `services` lists are exact only when no
fragment was truncated.

## Index fragments

`FileEntry.index` for these tables (produced by `engine/storage`, read only by the engine),
compact JSON, one `rg` entry per row group in file order, and `foot` as for metrics
(`contracts/TABLES.md`, "The index fragment": offset and length of everything after the
last row group):

```
spans:       {"v":1,"rg":[{"rows":N,"off":N,"len":N,"min_name":S,"max_name":S,"min_ts":N,"max_ts":N,"min_dur":N,"max_dur":N},…],"foot":[N,N]}
trace_index: {"v":1,"rg":[{"rows":N,"off":N,"len":N,"min_tid":H,"max_tid":H,"min_ts":N,"max_ts":N},…],"foot":[N,N]}
```

- `spans`: `min_name`/`max_name` are the row group's smallest and largest `service_name` in
  byte order, a null counting as `""` (so the range is conservative); `min_ts`/`max_ts`
  bound `start_unix_nano`, `min_dur`/`max_dur` bound `duration_nano`.
- `trace_index`: `min_tid`/`max_tid` are the first and last row's `trace_id` as 32 lowercase
  hex digits; `min_ts` is the smallest `min_start_unix_nano`, `max_ts` the largest
  `max_end_unix_nano`.
- Integers are 64-bit; a JavaScript reader must not read them as numbers.

## Object keys (proposed)

As in `TABLES.md`, with an hour level for `spans`:

```
{cell}/data/spans/tenant={tenant}/day={YYYY-MM-DD}/hour={HH}/L{level}-…-{hash8}.parquet
{cell}/data/trace_index/tenant={tenant}/day={YYYY-MM-DD}/L{level}-…-{hash8}.parquet
```

The stream and compaction parts of the name follow `TABLES.md`. A flush unit's `spans`
files and its `trace_index` file enter and leave the ledger in one change, like a metric
samples file and its series file.

## Reads (what the engine asks storage for)

`engine/traceql` exposes `plan(query, start, end)`, which returns, without touching data:

- the **time range** of span starts the query reads (search: the request's window; metrics:
  `[start, end)` aligned to the step);
- the **columns**: intrinsics and attributes (by scope and key; `.key` means span then
  resource) the query reads;
- a **span predicate**: a span that fails it can be dropped before evaluation, because it
  cannot change the result;
- a **trace predicate**: a trace none of whose spans satisfies it can be dropped whole;
- `full_traces`: whether evaluation needs every span of a candidate trace (structural
  operators, `span:childCount`, trace-level intrinsics without `trace_index`); then the span
  predicate is `true` and only the trace predicate prunes.

Predicates are trees of comparisons on single columns with `and`/`or`, conservative
(a reader may ignore any of them, or evaluate them on row-group statistics only). Results
must be identical with pruning on and off; the engine's property tests check this for its
in-memory source, and any storage reader must be tested the same way.

## Ingest batch

`VZB1` signal 2 (`contracts/BATCH.md`, "Spans, signal 2"), settled 2026-11-19. `edge` decodes
OTLP/HTTP traces (protobuf and JSON, optionally gzip) into it; spans go to the tenant's
`{pool}/traces` shards (proposed, `BATCH.md` "Streams per signal").

## What stays proposed

- Everything that reads or moves these files: flush, the ledger's tables, compaction and
  re-aggregation of `trace_index`, the query reader and its pruning, Iceberg publication, and
  the object keys above.
- Nested-set columns, per-tenant promotion, sampling weights, `with(extrapolate=true)`.
- The accept window for spans (`edge`'s default: start within 24 hours back and 5 minutes
  ahead) is a default, not a contract value.
