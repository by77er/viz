/**
 * Shared types for every detector.
 *
 * Conventions (all detectors):
 * - Times are Unix milliseconds. `ts` must be increasing; a point whose timestamp is not finite
 *   or not after the previous valid point is reported with status `missing` and changes nothing.
 * - A value that is NaN or ±Infinity is a missing point, never a zero. A gap (no point at all)
 *   is a gap: nothing is filled in.
 * - Counters must be turned into increments or rates by the caller, including counter resets
 *   (Prometheus' `rate()`/`increase()` semantics). Detectors see gauges.
 * - Nothing throws. Bad input yields `missing` points or `summary.status = 'not_enough_history'`.
 * - No clock, no randomness: the same input and state always give the same output.
 */

export interface Series {
  /** Unix milliseconds, increasing. */
  ts: Float64Array
  values: Float64Array
}

export type PointStatus =
  /** Scored. */
  | 'ok'
  /** Value or timestamp missing, non-finite or out of order; not scored, state untouched. */
  | 'missing'
  /** Valid value, but the detector has not seen enough history to score it yet. */
  | 'warming'

export interface Point {
  ts: number
  /** The input value; null when it was missing. */
  value: number | null
  /** What the detector expected; null when it has no expectation (warming, missing, or a plain threshold). */
  expected: number | null
  /** Band edges; a value outside [lower, upper] is anomalous (subject to hysteresis or `minDeviation`). */
  lower: number | null
  upper: number | null
  /**
   * How unusual the point is, in the detector's own unit (robust deviations, σ, burn-rate
   * multiples, CUSUM decision intervals). Always finite and ≥ 0; 0 when not scored.
   * Monotone in "more anomalous", so a caller may threshold it.
   */
  score: number
  anomalous: boolean
  status: PointStatus
  /** Present on anomalous points only. */
  explanation?: Explanation
}

/** A short true sentence plus the numbers it was built from, for agents. */
export interface Explanation {
  /** Built only from the fields below; see `explain.ts`. */
  text: string
  detector: string
  kind: 'threshold' | 'deviation' | 'seasonal' | 'level_shift' | 'burn_rate' | 'group_outlier' | 'residual'
  direction: 'above' | 'below'
  /** The observed value (or for a level shift, the new level). */
  value: number
  /** What it is compared with: threshold, median, EWMA, seasonal expectation, old level, group median. */
  reference: number
  /** What `reference` is, in words ("median of the same hour over the last 4 weeks"). */
  referenceLabel: string
  /** Deviations in units of `spread`, when the detector has a spread. */
  deviations?: number
  spread?: number
  spreadLabel?: string
  /** When it happened (the point, or the estimated change time for a level shift). */
  at: number
  /** Detector-specific numbers that appear in `text`. */
  facts: Record<string, number | string>
}

export interface Summary {
  detector: string
  status: 'ok' | 'not_enough_history'
  /** Why, when status is not ok; also set for partial warm-up. */
  message?: string
  points: number
  scored: number
  missing: number
  warming: number
  anomalies: number
  /** UTF-8 bytes of `JSON.stringify(state)`; 0 for stateless detectors. */
  stateBytes: number
  /** Detector-specific extras (changepoints, seasonality, model). */
  extra?: Record<string, unknown>
}

export interface DetectResult<S> {
  points: Point[]
  /**
   * Pass back on the next call to continue incrementally. JSON-serializable, contains no
   * NaN or Infinity, and is small enough for one Durable Object row (see `stateBytes`).
   * Batch detectors return the state needed for the next call too (a fitted model), or null.
   */
  state: S | null
  summary: Summary
}

/** Where the ruler must read history from to run a detector (design §7 cost classes). */
export interface HistoryNeed {
  /** How far before the first point to score the detector needs data (when called without state). */
  lookbackMs: number
  /** The resolution the detector is designed for (rollup step); 0 means "the series' own". */
  resolutionMs: number
  /** Minimum valid points before anything is scored. */
  minPoints: number
  /** Incremental detectors can run tick by tick from persisted state, needing only new points. */
  incremental: boolean
  /** Lookback needed per tick once state exists (0 for incremental detectors beyond the new points). */
  tickLookbackMs: number
  /** One sentence for a UI. */
  reason: string
}

export interface Detector<P, S> {
  name: string
  tier: 0 | 1
  mode: 'incremental' | 'batch'
  defaults: P
  /** History this configuration needs; `stepMs` is the series resolution. */
  history(params: Partial<P>, stepMs: number): HistoryNeed
  detect(series: Series, params?: Partial<P>, state?: S | null): DetectResult<S>
}
