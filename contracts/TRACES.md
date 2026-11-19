# Trace tables

Status: **proposed.** No component writes or reads these tables yet. The query engine
(`engine/traceql`) evaluates over an in-memory span source that has the logical shape
described here (`Span`, `TraceSummary` in its API), so storage can be built to this contract
without changing the engine. Where a rule below is not yet implemented anywhere it says
"proposed"; nothing here is "built".

Sources: `design/DESIGN.md` §5.1 and §6.4, decisions D3 (tenant-pure files), D6 (flat rows),
D10 (per-signal tables), and `research/04-traces-logs-storage.md` §5–6. The metric tables'
rules in `TABLES.md` apply unless this file says otherwise.

## Rules common to both tables

- **Tenancy.** Files are tenant-pure, as for metrics. The tenant is not a column of the data
  files: it is in the object key and, in the Iceberg tables, an optional `tenant` column
  filled from the partition tuple (`identity(tenant)`), as `publisher/` does for metrics.
  Tenant identity comes only from the credential; the engine is handed one tenant's rows.
- **Format.** Parquet, format v2 data pages, snappy for now (zstd once the WASM build is
  proven), statistics and the page index written for every column listed as "sorted" or
  "pruned". Row groups hold at most 100,000 rows and at most 16 MiB of uncompressed data,
  whichever comes first (research 04 §6.2: Tempo's 250 MB row groups do not fit an isolate).
- **Identifiers** are stored as raw bytes, never hex: `trace_id` FIXED_LEN_BYTE_ARRAY(16),
  span ids FIXED_LEN_BYTE_ARRAY(8). An all-zero `parent_span_id` from OTLP is stored as null.
  Hex is produced only at the API boundary (lower case).
- **Times** are Unix nanoseconds as INT64, the exact OTLP values. `start_time` is the same
  instant truncated to microseconds as an Iceberg `timestamptz`, so that Iceberg can derive
  hour partitions from it (the metric tables lack such a column; see `publisher/README.md`,
  contract issue 6). Spans whose start is outside years 1970–9999 never reach a table; a
  span whose end is before its start is stored with `end_unix_nano = start_unix_nano` and
  the attribute `viz.clamped_end = true` (proposed: `edge` does this at ingest).
- **Attribute values are typed.** OTLP `AnyValue` kinds map to: string, int (i64), double
  (f64), bool, and "other" (arrays, key-value lists, bytes). A key appears at most once per
  scope per span; if OTLP sends a key twice, the last value wins (proposed: `edge`).
- **Canonical OTLP JSON** (used for "other" values and for event and link attributes) is the
  OTLP/JSON encoding of a `KeyValue` list, keys sorted by UTF-8 bytes, no whitespace,
  `intValue` as a decimal string, `bytesValue` as base64, exactly as OTLP/JSON specifies.
  Any OTLP-aware reader can decode it.

## `spans`

One row per span (D6). Partitioned by tenant and **hour of `start_time`** (DESIGN §5.1);
sorted by `service_name, span_name, start_unix_nano` (research 04 §6.2: the ClickStack and
Jaeger choice, measured far better for search than trace-id order).

| Column | Parquet type | Null | Encoding | Notes |
|---|---|---|---|---|
| `trace_id` | FIXED_LEN_BYTE_ARRAY(16) | required | plain, **bloom filter** per row group (about 1% false positives) | never dictionary |
| `span_id` | FIXED_LEN_BYTE_ARRAY(8) | required | plain | |
| `parent_span_id` | FIXED_LEN_BYTE_ARRAY(8) | optional | plain | null for a root span |
| `trace_state` | BYTE_ARRAY (UTF8) | optional | dictionary | W3C tracestate |
| `flags` | INT32 | optional | | OTLP span flags |
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
| `resource_attrs_str` | MAP<UTF8, UTF8> | optional | dictionary keys | residual resource attributes by type |
| `resource_attrs_int` | MAP<UTF8, INT64> | optional | | |
| `resource_attrs_dbl` | MAP<UTF8, DOUBLE> | optional | | NaN and ±Inf preserved |
| `resource_attrs_bool` | MAP<UTF8, BOOLEAN> | optional | | |
| `resource_attrs_other` | BYTE_ARRAY (UTF8) | optional | plain | canonical OTLP JSON of the arrays, key-value lists and bytes |
| `span_attrs_str`, `_int`, `_dbl`, `_bool`, `_other` | as for resource | optional | | residual span attributes |
| `scope_attrs` | BYTE_ARRAY (UTF8) | optional | plain | canonical OTLP JSON of the instrumentation scope's attributes (rare) |
| `events` | LIST<STRUCT<`time_unix_nano` INT64, `name` UTF8, `attrs` UTF8>> | optional | | `attrs` is canonical OTLP JSON; events in OTLP order |
| `links` | LIST<STRUCT<`trace_id` FLBA(16), `span_id` FLBA(8), `trace_state` UTF8, `attrs` UTF8>> | optional | | links in OTLP order |
| `dropped_attributes_count`, `dropped_events_count`, `dropped_links_count` | INT32 | optional | | null when zero |
| `nested_left`, `nested_right`, `parent_local_id` | INT32 | optional | | **proposed, phase 2**: nested-set numbers written only by compaction of a sealed hour, see below |

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
| `r_deployment_environment` | resource `deployment.environment.name`, else `deployment.environment` (the older key keeps its own name in the logical view) | string |
| `r_k8s_namespace_name` | resource `k8s.namespace.name` | string |
| `r_k8s_pod_name` | resource `k8s.pod.name` | string |
| `r_cloud_region` | resource `cloud.region` | string |
| `s_http_request_method` | span `http.request.method` | string |
| `s_http_response_status_code` | span `http.response.status_code` | int |
| `s_http_route` | span `http.route` | string |
| `s_db_system_name` | span `db.system.name` | string |
| `s_rpc_service` | span `rpc.service` | string |
| `s_error_type` | span `error.type` | string |

Per-tenant promotion beyond this set (chosen by bytes contributed to the residual maps,
measured at compaction, capped at about 20–30 per scope) is **proposed**.

**Logical view.** Whatever the physical layout, a reader hands the engine, per span: the
intrinsic columns above; the resource attributes as one typed list (promoted columns
included, `service.name` included); the span attributes as one typed list; the scope name,
version and attributes; events and links with typed attributes. `engine/traceql`'s `Span`
type is exactly this view. The engine never sees which keys were promoted, so promotion
changes cost, never results.

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

One row per (trace, data file) fragment, written by flush next to the `spans` file it
describes and re-aggregated by compaction. Partitioned by tenant and **day** of
`min_start_unix_nano`; sorted by `trace_id` with the page index on, so trace-by-id is a
binary search (DESIGN §6.4, research 04 §6.3).

| Column | Parquet type | Null | Notes |
|---|---|---|---|
| `trace_id` | FIXED_LEN_BYTE_ARRAY(16) | required | sorted |
| `min_start_unix_nano` | INT64 | required | earliest span start in this fragment |
| `max_end_unix_nano` | INT64 | required | latest span end in this fragment |
| `span_count` | INT32 | required | |
| `error_count` | INT32 | required | spans with `status_code = 2` |
| `root_service_name` | BYTE_ARRAY (UTF8) | optional | set only if the fragment holds the root span (a span with null `parent_span_id`) |
| `root_span_name` | BYTE_ARRAY (UTF8) | optional | as above |
| `root_start_unix_nano` | INT64 | optional | start of that root span |
| `services` | LIST<STRUCT<`name` UTF8, `spans` INT32, `errors` INT32>> | optional | per-service counts in this fragment, at most 64 services, then truncated with `services_truncated = true` |
| `services_truncated` | BOOLEAN | required | |
| `hours` | LIST<INT32> | required | the `spans` hour partitions (hours since the epoch) holding this fragment's spans; logical references survive compaction |

**Merging fragments** (at query time and at compaction): `min` of starts, `max` of ends,
sums of counts, per-service sums, union of `hours`; the root fields come from the fragment
that has them. If two fragments both claim a root, the one with the earlier
`root_start_unix_nano` wins, then the smaller span id (a trace with two parentless spans has
no single root; this rule makes the answer deterministic). The engine's `TraceSummary`
(`start`, `end`, root service and name, per-service counts) is this merged row.

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

The `VZB1` batch (`BATCH.md`) is defined for metrics only. A span batch format is not
defined yet; when it is, it goes in `BATCH.md` with its own signal number.
