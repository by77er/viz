# Clean room: Tempo's and Loki's HTTP APIs in `query/`

viz is Apache-2.0; Grafana Tempo and Loki are AGPL-3.0 (AGENTS.md, "Licensing"). The trace and
log endpoints of the query Worker (`src/sigroutes.ts`, `src/signals.ts`, `src/sigparams.ts`) and
the result writers they use in `engine/wasm-query` (`src/traces.rs`, `src/logs.rs`) were written
from public documentation only. No Tempo or Loki source was read, fetched or run for this work
(the engines' own black-box differential runs are recorded in `engine/traceql/CLEANROOM.md` and
`engine/logql/CLEANROOM.md`).

## What was consulted (2026-11-19)

| Source | What it was used for |
|---|---|
| grafana.com/docs/tempo/latest/api_docs/ (the HTTP API reference, "Query", "Query V2", "Search", "Search tags", "Search tags V2", "Search tag values", "Search tag values V2", "TraceQL Metrics", "Instant") | Paths; parameters and their units (`start`/`end` in Unix seconds for search, tags and trace by ID; seconds, nanoseconds or RFC 3339 for metrics; `since`, `step`, `limit`, `spss`, `scope`, `q`); defaults (`limit` 20, `spss` 3, `since` one hour); the response field names quoted in the page's examples (`traces`, `traceID`, `rootServiceName`, `rootTraceName`, `startTimeUnixNano`, `durationMs`, `spanSets`, `matched`, `metrics`, `tagNames`, `scopes`, `name`, `tags`, `tagValues`, `type`, `value`); the intrinsic tag list of the v2 tags example; that trace by ID answers "mostly compatible OpenTelemetry JSON" and v2 a "Query response with a OpenTelemetry JSON trace"; that filtered tag values ignore a `q` that does not parse |
| grafana.com/docs/grafana/v12.4/datasources/tempo/traces-in-grafana/json-trace-file.md (Grafana's documentation of the trace JSON its Tempo data source imports) | That the trace JSON names its list of resource spans `batches`, writes trace and span ids in base64 and the span kind by name (`SPAN_KIND_SERVER`), and 64-bit times as strings |
| grafana.com/docs/loki/latest/reference/loki-http-api/ ("Query logs at a single point in time", "Query logs within a range of time", "Query labels", "Query label values", "Query streams", "Timestamps") | Paths and methods; parameters (`query`, `limit` default 100, `time`, `start`, `end`, `since`, `step`, `interval`, `direction` default backward, `match[]`); defaults (range: one hour; labels: six hours); the timestamp formats (integers are nanoseconds, a float is seconds, RFC 3339); that instant queries refuse log queries with 400; the response envelope `{"status":"success","data":…}` and the shapes of `streams`, `matrix`, `vector`, labels and series |
| opentelemetry.io OTLP specification and opentelemetry-proto (Apache-2.0), as already used by `edge/` and `engine/storage` | The OTLP JSON names of span fields (`traceId`, `spanId`, `parentSpanId`, `traceState`, `startTimeUnixNano`, `events`, `links`, `droppedAttributesCount`, `status.code`, …) and the `AnyValue` forms |

## Where the documentation is silent, and what viz does

- **Status codes** for a trace that is not found: 404 with a plain-text body (Tempo's errors are
  plain text in the documentation's examples of failed calls; the page lists no codes).
- **The v2 trace-by-ID wrapper**: `{"trace": <the v1 body>}`. The page names a "Query response"
  with a trace in it and no field names.
- **How the metrics API tells seconds from nanoseconds**: an integer of 13 or more digits is
  nanoseconds.
- **The default `step`** of both APIs ("dynamic"): the range over 250 points, rounded up to a
  whole second.
- **The default window** of Tempo's search, tags and tag values without `start`/`end` (Tempo
  then reads only its live store): the last hour.
- **Tag values of v1**: string values of span and resource attributes with that key.
