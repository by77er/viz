/** Helpers shared by the detectors. */
import type { Point, Series, Summary } from './types.ts'
import { inferStep } from './stats.ts'

export interface CommonParams {
  /** Series resolution. 0 = inferred from the timestamps (median spacing), then kept in state. */
  stepMs: number
  /** Only flag deviations at least this large in absolute units (0 = any). */
  minDeviation: number
  /** Which side counts. */
  direction: 'both' | 'above' | 'below'
  /** Absolute floor for the spread estimate (0 = scale-relative floor only). */
  minSpread: number
  /** Printed after numbers in explanations, e.g. "ms". */
  unit: string
}

export const COMMON_DEFAULTS: CommonParams = { stepMs: 0, minDeviation: 0, direction: 'both', minSpread: 0, unit: '' }

/**
 * Largest magnitude a detector accepts. Beyond it a value is treated as missing: squaring it
 * would overflow, and an Infinity in state cannot be written as JSON. Also turns -0 into 0, so
 * state survives a JSON round trip unchanged.
 */
export const MAX_ABS = 1e150
export const val = (v: number): number => (Math.abs(v) <= MAX_ABS ? v + 0 : NaN)
/** Timestamps: -0 → 0 (JSON cannot keep -0). */
export const tsv = (t: number): number => t + 0

export const length = (s: Series) => Math.min(s?.ts?.length ?? 0, s?.values?.length ?? 0)

/** Merge user params over defaults, dropping undefined and non-finite numbers where a number is expected. */
export function merge<P extends object>(defaults: P, params: Partial<P> | undefined): P {
  const out = { ...defaults } as Record<string, unknown>
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue
      const d = (defaults as Record<string, unknown>)[k]
      if (typeof d === 'number' && (typeof v !== 'number' || Number.isNaN(v))) continue
      out[k] = v
    }
  }
  return out as P
}

export function missingPoint(ts: number, value: number): Point {
  return {
    ts,
    value: Number.isFinite(value) ? value : null,
    expected: null,
    lower: null,
    upper: null,
    score: 0,
    anomalous: false,
    status: 'missing',
  }
}

export function warmingPoint(ts: number, value: number, expected: number | null = null): Point {
  return { ts, value, expected, lower: null, upper: null, score: 0, anomalous: false, status: 'warming' }
}

/**
 * Step: explicit param, else the state's, else inferred from this batch (median spacing), else
 * the gap from the state's last point to this batch's first (0 if still unknown).
 * Pass `stepMs` explicitly for reproducible incremental runs: an inferred step depends on
 * which points the first call happened to see.
 */
export function resolveStep(paramStep: number, stateStep: number | undefined, series: Series, lastTs?: number | null): number {
  if (paramStep > 0 && Number.isFinite(paramStep)) return paramStep
  if (stateStep && stateStep > 0) return stateStep
  const n = length(series)
  const inferred = inferStep(series.ts.subarray(0, n))
  if (inferred > 0) return inferred
  if (lastTs !== null && lastTs !== undefined) {
    for (let i = 0; i < n; i++) {
      const t = series.ts[i]!
      if (Number.isFinite(t) && t > lastTs) return t - lastTs
    }
  }
  return 0
}

/** UTF-8 bytes of the JSON form of a state (what a Durable Object row would hold). */
export function stateBytes(state: unknown): number {
  if (state === null || state === undefined) return 0
  return new TextEncoder().encode(JSON.stringify(state)).length
}

/** Direction filter. */
export function sideOk(direction: CommonParams['direction'], diff: number): boolean {
  if (direction === 'above') return diff > 0
  if (direction === 'below') return diff < 0
  return true
}

export function summarize(detector: string, points: Point[], state: unknown, extra?: Record<string, unknown>, notEnough?: string): Summary {
  let scored = 0, missing = 0, warming = 0, anomalies = 0
  for (const p of points) {
    if (p.status === 'ok') scored++
    else if (p.status === 'missing') missing++
    else warming++
    if (p.anomalous) anomalies++
  }
  const s: Summary = {
    detector,
    status: notEnough !== undefined && scored === 0 ? 'not_enough_history' : 'ok',
    points: points.length,
    scored,
    missing,
    warming,
    anomalies,
    stateBytes: stateBytes(state),
  }
  if (notEnough !== undefined && (scored === 0 || warming > 0)) s.message = notEnough
  if (extra) s.extra = extra
  return s
}

/** Never hand NaN/Infinity to JSON: replace with null (only used for diagnostics). */
export const jsonNum = (x: number): number | null => (Number.isFinite(x) ? x : null)

/** Round a slot index; the ring buffers are indexed by slot = round((ts - origin) / step). */
export const slotOf = (ts: number, origin: number, step: number) => Math.round((ts - origin) / step)

export const mod = (a: number, n: number) => ((a % n) + n) % n
