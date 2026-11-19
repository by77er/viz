/**
 * Query step selection.
 *
 * A chart W pixels wide cannot show more than W columns, so the automatic step is the
 * smallest "nice" step that yields at most one point per pixel column, never finer than
 * the scrape interval. The width is bucketed so small layout changes reuse cached results.
 */

export const NICE_STEPS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800,
] as const

export const DEFAULT_MIN_STEP = 15
export const WIDTH_BUCKET = 100
/** Prometheus refuses range queries above this many points per series. */
export const MAX_POINTS = 11000

export function bucketWidth(widthPx: number): number {
  return Math.max(WIDTH_BUCKET, Math.ceil(widthPx / WIDTH_BUCKET) * WIDTH_BUCKET)
}

export function autoStep(rangeSec: number, widthPx: number, minStep: number = DEFAULT_MIN_STEP): number {
  const columns = bucketWidth(widthPx)
  const raw = Math.max(minStep, rangeSec / columns)
  for (const s of NICE_STEPS) if (s >= raw) return s
  // Beyond the table: whole days.
  return Math.ceil(raw / 86400) * 86400
}

export interface QueryWindow {
  /** Epoch seconds, aligned down to a multiple of step. */
  start: number
  end: number
  step: number
}

/**
 * Align a window to the step so that successive refreshes of a relative range hit the same
 * evaluation timestamps (stable lines, cacheable requests).
 *
 * In whole milliseconds, as the viz API (and Prometheus) evaluates: it rounds `start` and
 * `end` to the millisecond and floors `step` to one (query/src/params.ts), so a window
 * computed in fractional seconds (1794994200.0000002 for a 0.1 s step) asks for one grid and
 * receives another. Here start, end and step are whole milliseconds, and their decimal
 * forms (`String(ms / 1000)`) are read back by the API as exactly those milliseconds.
 */
export function alignWindow(startSec: number, endSec: number, step: number): QueryWindow {
  const stepMs = Math.max(1, Math.round(step * 1000))
  const startMs = Math.floor(Math.round(startSec * 1000) / stepMs) * stepMs
  const endMs = Math.max(startMs + stepMs, Math.floor(Math.round(endSec * 1000) / stepMs) * stepMs)
  return { start: startMs / 1000, end: endMs / 1000, step: stepMs / 1000 }
}
