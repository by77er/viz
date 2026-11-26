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

import type { SignalTable, Table } from './ledger'

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

/**
 * One Parquet file of the span and log tables (contracts/TRACES.md, contracts/LOGS.md),
 * produced from a sealed segment of signal 2 or 3 batches by `SignalFlushEngine`, or from
 * files of one table and partition by `SignalMergeEngine` (compaction). Added 2026-11-19
 * (stage 2 of traces and logs); additive.
 *
 * `minTs`/`maxTs` are Unix MILLISECONDS, as for every `FileEntry` the ledger lists: the
 * floor of `minNs`/`maxNs`, so a plan's millisecond range overlaps the file exactly when its
 * nanosecond range does (`[a, b]` in ms covers `[a·10⁶, b·10⁶ + 999,999]` in ns). The exact
 * nanosecond bounds cross as decimal strings (a Unix nanosecond does not fit a JS number):
 *
 *   spans        smallest and largest `start_unix_nano`
 *   trace_index  smallest `min_start_unix_nano`, largest `max_end_unix_nano`
 *   logs         smallest and largest `ts`
 */
export interface EncodedSignalFile extends Omit<EncodedFile, 'table'> {
  table: SignalTable
  /** `spans` only: the UTC hour (0 to 23) of `day` that every row's start time falls in; null for the other tables. */
  hour: number | null
  minNs: string
  maxNs: string
}

/**
 * Flush of span and log batches (added 2026-11-19, ABI 3 of `engine/wasm`). Metrics are
 * unchanged: `Engine.encodeSegment` is still the only encoder of signal 1.
 */
export interface SignalFlushEngine {
  /**
   * A sealed segment's span batches (`VZB1` signal 2, sequence order) as `spans` files, one
   * per UTC hour of start time (hours ascending), then `trace_index` files, one per UTC day of
   * the fragments' first start. The later of two rows with one `(trace_id, span_id)` wins.
   * Throws for a batch that is not signal 2.
   */
  encodeSpans(batches: Uint8Array[]): EncodedSignalFile[]
  /**
   * A sealed segment's log-record batches (`VZB1` signal 3) as `logs` files, one per UTC day
   * of `ts`. Rows equal on `(stream_id, ts, line, metadata)` are one row. Throws for a batch
   * that is not signal 3.
   */
  encodeLogs(batches: Uint8Array[]): EncodedSignalFile[]
}

/**
 * Compaction of the span and log tables (contracts/TRACES.md "Compaction", contracts/LOGS.md
 * §4 "Compaction"; design/DECISIONS.md D68). Added 2026-11-19, ABI 4 of `engine/wasm`
 * (`viz_merge_signal_files`; ABI 3 lacks it). Additive: `Engine.mergeFiles` still merges the
 * metric tables only. An engine may lack this operation; compaction checks for it at run time
 * and then merges the metric tables only.
 */
export interface SignalMergeEngine {
  /**
   * Merge whole files of ONE table and ONE partition into one file with the table's schema,
   * sort order, page and statistics rules and a fresh index fragment. The partition is one UTC
   * hour of one day for `spans` and one UTC day for `trace_index` and `logs`. Inputs are given
   * in ascending precedence (contracts/ledger.ts `LiveFile`), and the later input wins:
   *
   *   spans        rows equal on `(trace_id, span_id)` are one row, the later input's
   *                (within one input, the later row)
   *   trace_index  the rows of one `trace_id` are one row, merged as TRACES.md "Merging
   *                fragments" merges fragments (the later input's root when two claim the
   *                same root span; at most 64 services, then `services_truncated`)
   *   logs         rows equal on `(stream_id, ts, line, metadata)` are one row, the later
   *                input's (within one input, the later row)
   *
   * The output is an `EncodedSignalFile` as `encodeSpans`/`encodeLogs` give one: `table` is
   * `table`, `hour` the partition's hour for `spans` (0 to 23) and null otherwise, `minNs`/`maxNs`
   * the exact nanosecond bounds and `minTs`/`maxTs` their floor in milliseconds. A `logs` output
   * carries its token filter inside the file, located by the fragment's `tok` (LOGS.md §6, D65),
   * unless it holds more than 524,288 distinct tokens.
   *
   * Limits. Output row groups are cut at 2 MiB of data (flush cuts at 16 MiB; both within the
   * contracts' caps). Inputs and output are held in memory, so the caller bounds the bytes it
   * passes in: compaction passes at most 8 files and 16 MiB a merge (compact/ `DEFAULT_POLICY`),
   * which peaked at 62 MB (spans) and 81 MB (logs) of WASM memory, measured locally, not on
   * Cloudflare (engine/wasm/README.md, "ABI 4: merges of spans, trace_index and logs").
   *
   * Errors. Throws, leaving the engine usable, for no inputs, inputs that hold no rows, a file
   * that is not of `table`, rows of more than one partition (two hours of `spans`, two days
   * otherwise) and an input that is not sorted. A `table` that is not a `SignalTable` is a
   * `RangeError`, thrown before the engine is called.
   */
  mergeSignalFiles(table: SignalTable, files: Uint8Array[]): EncodedSignalFile
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

// ─────────────────── the engine's span and log operations (ABI 6; 7 and 8 additive) ───────────────────

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
 * What a span or log call may hold, and (traces) which spans are its data (D62; ABI 7 of
 * `engine/wasm-query`, 2026-11-19, additive: an optional last argument; ABI 8, the same day,
 * widened what `maxBytes` counts and gave it to `lqLabels`: design/reviews/signals-end-to-end-r2.md
 * R2-M1, R2-M2).
 * `maxBytes`: the bytes one call may hold, as the engine counts them, charged as each thing is
 * made and refused BEFORE the thing that would pass it is built, never after: decoded rows (a
 * resource once per distinct resource of the call); what the evaluation derives from them as it
 * grows (trace extents and the ids the margin needs, TraceQL metric series with every point and
 * histogram bucket, one output series per quantile or bucket, tag-name and tag-value sets, LogQL
 * series and the label sets `regexp`, `label_format` and the other stages make, the streams, names
 * and values of the label calls); and the answer, four times its length, before it is written.
 * Past it an `execution` error whose limit is `max_decoded_bytes`. The charge is the engine's
 * estimate, set at or above measured growth; what one row or value takes before it is charged,
 * and the call's inputs, are not part of it (`engine/wasm-query/README.md`, "Memory"). Default:
 * the engine's (32 MiB). `bound`: a span whose start lies outside `[lo, hi]` (nanoseconds,
 * inclusive) is not part of the call's data and is dropped before de-duplication; `tqExtent`
 * counts only fragments that overlap it and tail spans that start in it, and cuts the hull,
 * ranges and hours to it. Default: all time. Calls without spans ignore `bound`.
 */
export interface SignalBudget {
  maxBytes?: number
  bound?: { lo: bigint; hi: bigint }
}

/**
 * The span and log half of the read path's engine. Files are whole Parquet files or the byte
 * ranges a `SignalFilePlan` read (a sparse file container), passed in ascending precedence
 * (`contracts/ledger.ts` `LiveFile`); tail batches are `VZB1` signal 2 (spans) or 3 (logs)
 * in sequence order, after the files. The later of two rows with one row key wins
 * (`contracts/BATCH.md`). `maxSpans`/`maxRows` bound the rows HELD, never the rows decoded: a
 * span outside `bound`, a span of another trace than the one `tqTrace` asks for, a span that
 * starts outside a tag call's `[lo, hi]`, and a log row no selector reads are read and passed
 * over, not held and not counted. `budget.maxBytes` bounds the bytes of what is held, derived
 * and answered (`SignalBudget`). Past either, an `execution` error naming the limit. Errors are
 * typed as for PromQL (`bad_data`, `execution`, `unsupported`, `internal`).
 */
export interface SignalEngine {
  tqPlan(kind: 'search' | 'range' | 'instant', query: string, startNs: bigint, endNs: bigint, stepNs: bigint): TraceReadPlan
  /**
   * Row groups of `spans` files whose span starts overlap `[lo, hi]`, or of `trace_index` files
   * whose fragments do (and hold `traceId`). With `ranges` (`spans`; ABI 8), only row groups that
   * also overlap one of them: the `ranges` a `tqExtent` gave (inclusive nanoseconds).
   */
  tqFilePlan(table: 'spans' | 'trace_index', indexes: string[], lo: bigint, hi: bigint, traceId?: Uint8Array, ranges?: { lo: bigint; hi: bigint }[]): SignalFilePlan[]
  /**
   * The traces overlapping `[lo, hi]` (or `traceId`) from `trace_index` files and the tail: how
   * many, their hull, the `spans` hours holding them, and (ABI 8) `ranges`: their fragments'
   * extents and tail spans, merged, ascending, disjoint and cut to `bound`, at most 256 (the
   * closest are joined beyond that). Every span of a found trace that starts inside `bound`
   * starts inside one of `ranges`, so a reader that plans `spans` by them (`tqFilePlan`) reads
   * every such span and not the hull's other units. A trace is found when its extent, merged over
   * every fragment and tail span inside `bound`, overlaps `[lo, hi]`; the call holds the traces
   * with a piece in `[lo, hi]` and the ids of those with a piece after it, not every trace of
   * `bound`. `ranges` is absent from an engine before ABI 8 (read the hull).
   */
  tqExtent(indexFiles: Uint8Array[], tailBatches: Uint8Array[], lo: bigint, hi: bigint, traceId?: Uint8Array, budget?: SignalBudget): { traces: number; lo?: string; hi?: string; hours: number[]; ranges?: [string, string][] }
  tqSearch(spanFiles: Uint8Array[], tailBatches: Uint8Array[], query: string, req: { limit: number; spss: number; startNs: bigint; endNs: bigint; maxSpans: number }, budget?: SignalBudget): { json: string; spans: number; traces: number }
  tqMetrics(spanFiles: Uint8Array[], tailBatches: Uint8Array[], query: string, req: { instant: boolean; startNs: bigint; endNs: bigint; stepNs: bigint; maxSpans: number; maxSeries: number; maxPoints: number }, budget?: SignalBudget): { json: string; spans: number; traces: number }
  /**
   * `json` is `OtlpTrace` (v1) or `{ trace: OtlpTrace }` (v2); null when no span of the trace was
   * read. `maxSpans` bounds the trace's spans held (ABI 8; before, every span of the row groups
   * read counted); `spans` is every span decoded, other traces' included.
   */
  tqTrace(spanFiles: Uint8Array[], tailBatches: Uint8Array[], traceId: Uint8Array, version: 1 | 2, maxSpans: number, budget?: SignalBudget): { json: string | null; spans: number }
  /** Tag names of the spans that start in `[lo, hi]`; `maxSpans` bounds those spans held (ABI 8). */
  tqTags(spanFiles: Uint8Array[], tailBatches: Uint8Array[], version: 1 | 2, scope: string, lo: bigint, hi: bigint, limit: number, maxSpans: number, budget?: SignalBudget): string
  /** Values of `tag` on the spans that start in `[lo, hi]`; the set of values is charged as it grows (ABI 8). */
  tqTagValues(spanFiles: Uint8Array[], tailBatches: Uint8Array[], version: 1 | 2, tag: string, q: string, lo: bigint, hi: bigint, limit: number, maxSpans: number, budget?: SignalBudget): string
  lqPlan(kind: 'range' | 'instant', query: string, startNs: bigint, endNs: bigint, stepNs: bigint): LogReadPlan
  lqFilePlan(indexes: string[], selectors: LogReadPlan['selectors']): SignalFilePlan[]
  /** `json` is `LokiData`. */
  lqQuery(logFiles: Uint8Array[], tailBatches: Uint8Array[], query: string, req: { kind: 'range' | 'instant'; startNs: bigint; endNs: bigint; stepNs: bigint; limit: number; direction: 'forward' | 'backward'; maxRows: number; maxSeries: number; maxSteps: number }, budget?: SignalBudget): { json: string; rows: number }
  /**
   * `json` is `LokiLabels` (names, values of `name`) or `LokiSeries`. Streams from fragments that
   * list them, from the files given whole or in part, and from the tail. `budget.maxBytes` (ABI
   * 8; before, nothing was counted) bounds the label texts read, the distinct streams, names or
   * values held, and the answer: past it `max_decoded_bytes`, never a shortened list (Loki's API
   * documents no `limit` for these calls). `bound` is ignored.
   */
  lqLabels(kind: 'names' | 'values' | 'series', name: string, selectors: string[], startNs: bigint, endNs: bigint, fragments: string[], logFiles: Uint8Array[], tailBatches: Uint8Array[], budget?: SignalBudget): string
}
