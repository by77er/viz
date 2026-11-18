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
 * - TraceQL and LogQL result shapes are not defined yet.
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
  /** Whole `metric_samples` files for the range. */
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
