/**
 * The JavaScript face of the Rust/WASM engine. The engine does no I/O: callers hand it
 * bytes and get bytes back. See contracts/BATCH.md and contracts/TABLES.md.
 *
 * Numbers across this boundary:
 * - Times going IN are Unix milliseconds as JS numbers (integers, exact below 2^53; the
 *   engine uses i64). Times in Prometheus-shaped RESULTS (`PromMatrix`, `PromVector`,
 *   `PromScalar`) are Unix seconds as floats, exactly as the Prometheus HTTP API returns.
 * - Sample values cross as raw bytes. A binding copies them into a `Float64Array` and
 *   nothing on the JS side may read an element and write it back: JavaScript engines can
 *   rewrite a NaN's payload, which would destroy staleness markers. Staleness is
 *   interpreted only inside the engine; query results never contain a marker.
 * - Traces and logs (added 2026-11-19, ABI 6 of `engine/wasm-query`): nanosecond times cross
 *   as `bigint` going in and as decimal STRINGS in results (a Unix nanosecond does not fit a
 *   JS number exactly). Trace ids cross as 16 raw bytes going in and as lowercase hex (search)
 *   or base64 (OTLP JSON) in results. Result shapes are the bodies of Tempo's and Loki's HTTP
 *   APIs; the engines write them as JSON text and an HTTP layer passes the text through
 *   unparsed (as for PromQL), so the types below describe text a client parses.
 */

import type { Table } from './ledger'

/** One Parquet file produced from a sealed segment. */
export interface EncodedFile {
  table: Table
  /** UTC day, `YYYY-MM-DD`. */
  day: string
  bytes: Uint8Array
  rows: number
  minTs: number
  maxTs: number
  /** Row-group index fragment for the ledger (opaque JSON string). */
  index: string
}

/** Prometheus-style label matcher. */
export interface Matcher {
  name: string
  op: '=' | '!=' | '=~' | '!~'
  value: string
}

/** One series' samples, time-ordered, de-duplicated. */
export interface SeriesData {
  labels: Record<string, string>
  ts: Float64Array
  values: Float64Array
}

export interface ScanInput {
  /** Whole `metric_series` files for the range. Must include the series file that was written with each sample file. */
  seriesFiles: Uint8Array[]
  /** Whole `metric_samples` files for the range, in ascending precedence (`Plan.files` order; contracts/ledger.ts `LiveFile`): a later file wins a duplicate. */
  sampleFiles: Uint8Array[]
  /** `VZB1` batches from shard tails, in sequence order. */
  tailBatches: Uint8Array[]
}

export interface Engine {
  /**
   * Turn a sealed segment's batches (sequence order) into sorted Parquet files:
   * one `metric_samples` and one `metric_series` file per UTC day present.
   * Later batches win on duplicate `(series_id, ts)`.
   */
  encodeSegment(batches: Uint8Array[]): EncodedFile[]

  /**
   * Select series matching all matchers with samples in `[minTs, maxTs]`, merging lake
   * files and tail batches into one ordered, de-duplicated stream per series (tail wins).
   * A series that matches but has no sample in the range is not returned.
   */
  select(input: ScanInput, matchers: Matcher[], minTs: number, maxTs: number): SeriesData[]

  /**
   * Compaction: merge whole files of ONE table and one tenant-day into one file with the
   * same schema, sort order and row-group cap, and a fresh index fragment.
   *
   * `metric_samples`: rows with the same `(metric_name, series_id, ts)` collapse to one; the
   * row of the LATER file in `files` wins, so callers pass inputs in ascending precedence
   * (contracts/ledger.ts `LiveFile`). `metric_series`: rows with the same
   * `(metric_name, series_id)` collapse to one, with the labels of the later file, the
   * smallest `min_ts` and the largest `max_ts`. The output therefore holds exactly the
   * de-duplicated rows of its inputs: a `select` over the output (with the series file
   * merged from the matching series inputs) returns what it returned over the inputs.
   *
   * Throws for no rows, for inputs that are not sorted, and for rows of more than one UTC
   * day. The caller bounds the bytes it passes in: inputs and output are held in memory.
   */
  mergeFiles(table: Table, files: Uint8Array[]): EncodedFile

  /** Prometheus `query_range`. Returns the `data` object of the HTTP API response. */
  queryRange(input: ScanInput, promql: string, startMs: number, endMs: number, stepMs: number): PromMatrix

  /** Prometheus instant `query` at `timeMs`. A range selector gives a matrix; a string literal a string. */
  queryInstant(input: ScanInput, promql: string, timeMs: number): PromVector | PromScalar | PromMatrix | PromString

  /** Selectors in a query, so the caller knows what to fetch before evaluating. */
  selectors(promql: string, startMs: number, endMs: number, stepMs: number): { matchers: Matcher[]; minTs: number; maxTs: number }[]
}

export interface PromMatrix {
  resultType: 'matrix'
  result: { metric: Record<string, string>; values: [number, string][] }[]
}
export interface PromVector {
  resultType: 'vector'
  result: { metric: Record<string, string>; value: [number, string] }[]
}
export interface PromScalar {
  resultType: 'scalar'
  result: [number, string]
}
export interface PromString {
  resultType: 'string'
  result: [number, string]
}

// ─────────────────────────────── traces (contracts/TRACES.md) ───────────────────────────────
// Added 2026-11-19 with ABI 6 of engine/wasm-query. Additive: nothing above changed.

/** An OTLP `AnyValue` in the protobuf JSON mapping (64-bit integers as strings, NaN and ±Infinity as strings). */
export type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number | 'NaN' | 'Infinity' | '-Infinity' }
  | { boolValue: boolean }
  | { arrayValue: { values?: OtlpAnyValue[] } }
  | { kvlistValue: { values?: OtlpKeyValue[] } }
  | { bytesValue: string }
  | Record<string, never>
export interface OtlpKeyValue {
  key: string
  value: OtlpAnyValue
}

/** One span of a search result (`spanSets[].spans[]`): ids in lowercase hex, times as strings. */
export interface TempoSpan {
  spanID: string
  name?: string
  startTimeUnixNano: string
  durationNanos: string
  /** The fields the query reads, as Tempo echoes them. */
  attributes?: OtlpKeyValue[]
}
export interface TempoSpanSet {
  spans: TempoSpan[]
  /** Spans the spanset matched; `spans` holds at most `spss` of them. */
  matched: number
  /** Results of `by()`, `count()`, … of the pipeline. */
  attributes?: OtlpKeyValue[]
}
/** One trace of a search result. */
export interface TempoTraceSummary {
  /** Hex, without leading zeros (as Tempo prints it). */
  traceID: string
  rootServiceName?: string
  rootTraceName?: string
  startTimeUnixNano: string
  durationMs?: number
  /** The first spanset (Tempo's older field), and all of them. */
  spanSet?: TempoSpanSet
  spanSets?: TempoSpanSet[]
  serviceStats?: Record<string, { spanCount: number; errorCount?: number }>
}
/** Body of Tempo's `GET /api/search`. Most recent trace first. */
export interface TempoSearchResponse {
  traces: TempoTraceSummary[]
  /** What the engine inspected (empty fields left out). */
  metrics: { inspectedTraces?: number; inspectedSpans?: string }
}
/** Body of Tempo's `GET /api/metrics/query_range` and `/api/metrics/query` (instant: one sample per series). */
export interface TempoMetricsResponse {
  series: {
    /** Typed labels (`__name__` without `by`, `p` for quantiles, `__bucket` for histograms). */
    labels: OtlpKeyValue[]
    /** NaN samples are left out. */
    samples: { timestampMs: string; value: number }[]
  }[]
  metrics: { inspectedTraces?: number; inspectedSpans?: string }
}

export type OtlpSpanKind = 'SPAN_KIND_UNSPECIFIED' | 'SPAN_KIND_INTERNAL' | 'SPAN_KIND_SERVER' | 'SPAN_KIND_CLIENT' | 'SPAN_KIND_PRODUCER' | 'SPAN_KIND_CONSUMER'
/** An OTLP span in the protobuf JSON mapping: ids base64, enums by name, 64-bit integers as strings, empty fields left out. */
export interface OtlpSpan {
  traceId: string
  spanId: string
  traceState?: string
  parentSpanId?: string
  flags?: number
  name: string
  kind: OtlpSpanKind
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes?: OtlpKeyValue[]
  droppedAttributesCount?: number
  events?: { timeUnixNano: string; name: string; attributes?: OtlpKeyValue[] }[]
  droppedEventsCount?: number
  links?: { traceId: string; spanId: string; traceState?: string; attributes?: OtlpKeyValue[] }[]
  droppedLinksCount?: number
  status: { message?: string; code?: 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR' }
}
/**
 * Body of Tempo's `GET /api/traces/<id>`: resource spans as `batches` (Tempo's "mostly
 * compatible" OpenTelemetry JSON), each resource once, its scopes in the order their first
 * span starts, spans in `(start, span id)` order. `/api/v2/traces/<id>` wraps it: `{ trace }`.
 */
export interface OtlpTrace {
  batches: { resource: { attributes?: OtlpKeyValue[] }; scopeSpans: { scope: { name?: string; version?: string; attributes?: OtlpKeyValue[] }; spans: OtlpSpan[] }[] }[]
}
/** Body of `GET /api/search/tags` (v1). */
export interface TempoTagNames {
  tagNames: string[]
  metrics: Record<string, string>
}
/** Body of `GET /api/v2/search/tags`. */
export interface TempoTagScopes {
  scopes: { name: 'resource' | 'span' | 'intrinsic' | 'event' | 'link' | 'instrumentation'; tags: string[] }[]
  metrics: Record<string, string>
}
/** Body of `GET /api/search/tag/<tag>/values` (v1: strings) and `/api/v2/search/tag/<tag>/values` (typed). */
export interface TempoTagValues {
  tagValues: string[] | { type: 'string' | 'int' | 'float' | 'bool' | 'keyword'; value: string }[]
  metrics: Record<string, string>
}

// ──────────────────────────────── logs (contracts/LOGS.md) ────────────────────────────────

/** Loki's `stats` object, in its documented shape; the fields this engine does not know are 0. */
export interface LokiStats {
  summary: { bytesProcessedPerSecond: number; linesProcessedPerSecond: number; totalBytesProcessed: number; totalLinesProcessed: number; execTime: number; queueTime: number; totalEntriesReturned: number }
  querier: { store: Record<string, unknown> }
  ingester: Record<string, unknown>
}
/**
 * The `data` object of Loki's `GET /loki/api/v1/query_range` and `/query`. Streams: entries
 * as `[nanoseconds as a string, line]`; matrix and vector: Prometheus' shapes (times in
 * seconds, values as strings).
 */
export type LokiData =
  | { resultType: 'streams'; result: { stream: Record<string, string>; values: [string, string][] }[]; stats: LokiStats }
  | { resultType: 'matrix'; result: { metric: Record<string, string>; values: [number, string][] }[]; stats: LokiStats }
  | { resultType: 'vector'; result: { metric: Record<string, string>; value: [number, string] }[]; stats: LokiStats }
  | { resultType: 'scalar'; result: [number, string]; stats: LokiStats }
/** The `data` of `/loki/api/v1/labels` and `/label/<name>/values` (sorted by UTF-8 bytes, unique). */
export type LokiLabels = string[]
/** The `data` of `/loki/api/v1/series`: the label sets of the matching streams, sorted. */
export type LokiSeries = Record<string, string>[]

// ─────────────────────── the engine's span and log operations (ABI 6) ───────────────────────

/** How to read one file, from its index fragment: skip it, whole, or these `[offset, length]` byte ranges (footer and row groups). */
export interface SignalFilePlan {
  /** Rows of the row groups chosen; null when the fragment does not parse (read whole). */
  rows: number | null
  read: 'skip' | 'whole' | [number, number][]
}

/** What a TraceQL query reads (`tqPlan`). Nanosecond times as decimal strings. */
export interface TraceReadPlan {
  /** Every span of each candidate trace must be read (search; metrics that are not span-local). */
  complete: boolean
  /** Span starts (metrics) or trace extents (search) that matter: `[lo, hi]`, inclusive. */
  lo: string
  hi: string
  /** Metrics: the request as Tempo's query frontend aligns it. */
  start?: string
  end?: string
  step?: string
}

/** What a LogQL query reads (`lqPlan`): one entry per selector, `[start, end)` in nanoseconds. */
export interface LogReadPlan {
  metric: boolean
  selectors: { matchers: Matcher[]; start: string; end: string }[]
}

/**
 * The span and log half of the read path's engine. Files are whole Parquet files or the byte
 * ranges a `SignalFilePlan` read (a sparse file container), passed in ascending precedence
 * (`contracts/ledger.ts` `LiveFile`); tail batches are `VZB1` signal 2 (spans) or 3 (logs)
 * in sequence order, after the files. The later of two rows with one row key wins
 * (`contracts/BATCH.md`). `maxSpans`/`maxRows` bound the rows decoded (an `execution` error
 * past them). Errors are typed as for PromQL (`bad_data`, `execution`, `unsupported`, `internal`).
 */
export interface SignalEngine {
  tqPlan(kind: 'search' | 'range' | 'instant', query: string, startNs: bigint, endNs: bigint, stepNs: bigint): TraceReadPlan
  /** Row groups of `spans` files whose span starts overlap `[lo, hi]`, or of `trace_index` files whose fragments do (and hold `traceId`). */
  tqFilePlan(table: 'spans' | 'trace_index', indexes: string[], lo: bigint, hi: bigint, traceId?: Uint8Array): SignalFilePlan[]
  /** The traces overlapping `[lo, hi]` (or `traceId`) from `trace_index` files and the tail: how many, their hull, and the `spans` hours holding them. */
  tqExtent(indexFiles: Uint8Array[], tailBatches: Uint8Array[], lo: bigint, hi: bigint, traceId?: Uint8Array): { traces: number; lo?: string; hi?: string; hours: number[] }
  tqSearch(spanFiles: Uint8Array[], tailBatches: Uint8Array[], query: string, req: { limit: number; spss: number; startNs: bigint; endNs: bigint; maxSpans: number }): { json: string; spans: number; traces: number }
  tqMetrics(spanFiles: Uint8Array[], tailBatches: Uint8Array[], query: string, req: { instant: boolean; startNs: bigint; endNs: bigint; stepNs: bigint; maxSpans: number; maxSeries: number; maxPoints: number }): { json: string; spans: number; traces: number }
  /** `json` is `OtlpTrace` (v1) or `{ trace: OtlpTrace }` (v2); null when no span of the trace was read. */
  tqTrace(spanFiles: Uint8Array[], tailBatches: Uint8Array[], traceId: Uint8Array, version: 1 | 2, maxSpans: number): { json: string | null; spans: number }
  tqTags(spanFiles: Uint8Array[], tailBatches: Uint8Array[], version: 1 | 2, scope: string, lo: bigint, hi: bigint, limit: number, maxSpans: number): string
  tqTagValues(spanFiles: Uint8Array[], tailBatches: Uint8Array[], version: 1 | 2, tag: string, q: string, lo: bigint, hi: bigint, limit: number, maxSpans: number): string
  lqPlan(kind: 'range' | 'instant', query: string, startNs: bigint, endNs: bigint, stepNs: bigint): LogReadPlan
  lqFilePlan(indexes: string[], selectors: LogReadPlan['selectors']): SignalFilePlan[]
  /** `json` is `LokiData`. */
  lqQuery(logFiles: Uint8Array[], tailBatches: Uint8Array[], query: string, req: { kind: 'range' | 'instant'; startNs: bigint; endNs: bigint; stepNs: bigint; limit: number; direction: 'forward' | 'backward'; maxRows: number; maxSeries: number; maxSteps: number }): { json: string; rows: number }
  /** `json` is `LokiLabels` (names, values of `name`) or `LokiSeries`. Streams from fragments that list them, from the files given whole or in part, and from the tail. */
  lqLabels(kind: 'names' | 'values' | 'series', name: string, selectors: string[], startNs: bigint, endNs: bigint, fragments: string[], logFiles: Uint8Array[], tailBatches: Uint8Array[]): string
}
