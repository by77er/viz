/**
 * Tier 1: automatic seasonality detection over the candidates that occur in operations data
 * (research 08 §4.2): hourly, daily, weekly. No general period search.
 *
 * For each candidate period P (in steps p):
 *  1. Put the series on a regular grid (slot means); missing slots stay missing.
 *  2. Remove the trend with a centred moving average of length p (2×p for even p, the
 *     classical-decomposition filter), which removes a P-periodic component from the trend
 *     estimate and so leaves it in the residual.
 *  3. Autocorrelation of the residual at lag p and at lag p/2, over pairs where both slots are
 *     present (missing is never zero).
 *  4. Seasonal if acf(p) ≥ minAcf, acf(p) exceeds acf(p/2) by `minPeak` (a peak, not the
 *     slow decay of autocorrelated noise), acf(p) > 3/√pairs (beyond white-noise sampling
 *     error), and the series covers at least `minCycles` periods.
 * Choice: the shortest seasonal candidate, unless a longer one beats it by `preferLongerBy`
 * (a weekly pattern also correlates at one day; a daily one correlates equally at a week).
 * Confidence = acf at the chosen lag (0..1).
 */
import type { Series } from '../types.ts'
import { length, val } from '../base.ts'
import { duration, fmt } from '../explain.ts'
import { inferStep } from '../stats.ts'

export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000
export const WEEK_MS = 7 * DAY_MS

export interface SeasonalityParams {
  candidatesMs: number[]
  stepMs: number
  minAcf: number
  minPeak: number
  minCycles: number
  preferLongerBy: number
}

export const seasonalityDefaults: SeasonalityParams = {
  candidatesMs: [HOUR_MS, DAY_MS, WEEK_MS],
  stepMs: 0,
  minAcf: 0.3,
  minPeak: 0.1,
  minCycles: 2,
  preferLongerBy: 0.1,
}

export interface Candidate {
  periodMs: number
  testable: boolean
  cycles: number
  acf: number | null
  acfHalf: number | null
  pairs: number
  seasonal: boolean
  reason: string
}

export interface SeasonalityResult {
  status: 'ok' | 'not_enough_history'
  periodMs: number | null
  confidence: number
  candidates: Candidate[]
  stepMs: number
  text: string
}

/** Regular grid of slot means; NaN where nothing was observed. */
export function toGrid(series: Series, stepMs: number): { start: number; values: Float64Array } {
  const n = length(series)
  let first = NaN, last = NaN
  for (let i = 0; i < n; i++) {
    const t = series.ts[i]!
    if (!Number.isFinite(t) || !Number.isFinite(val(series.values[i]!))) continue
    if (!(t >= first)) first = Number.isFinite(first) ? Math.min(first, t) : t
    if (!(t <= last)) last = Number.isFinite(last) ? Math.max(last, t) : t
  }
  if (!Number.isFinite(first) || !(stepMs > 0)) return { start: 0, values: new Float64Array(0) }
  const m = Math.round((last - first) / stepMs) + 1
  if (m > 5_000_000) return { start: first, values: new Float64Array(0) }
  const sum = new Float64Array(m)
  const cnt = new Float64Array(m)
  for (let i = 0; i < n; i++) {
    const t = series.ts[i]!, v = val(series.values[i]!)
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue
    const s = Math.round((t - first) / stepMs)
    sum[s]! += v
    cnt[s]! += 1
  }
  const values = new Float64Array(m)
  for (let s = 0; s < m; s++) values[s] = cnt[s]! > 0 ? sum[s]! / cnt[s]! : NaN
  return { start: first, values }
}

/** Centred moving average of length p (2×p filter for even p) over present values; NaN where less than half the window is present. */
function centredMA(x: Float64Array, p: number): Float64Array {
  const n = x.length
  const out = new Float64Array(n).fill(NaN)
  // weights: odd p → p equal weights; even p → p+1 weights with halves at the ends
  const half = Math.floor(p / 2)
  const w = (j: number) => (p % 2 === 1 ? 1 : j === -half || j === half ? 0.5 : 1)
  // prefix sums over present values and counts make this O(n) for odd p; handle even p via ends
  const ps = new Float64Array(n + 1), pc = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    const v = x[i]!
    ps[i + 1] = ps[i]! + (Number.isFinite(v) ? v : 0)
    pc[i + 1] = pc[i]! + (Number.isFinite(v) ? 1 : 0)
  }
  for (let i = half; i < n - half; i++) {
    let s = ps[i + half + 1]! - ps[i - half]!
    let c = pc[i + half + 1]! - pc[i - half]!
    if (p % 2 === 0) {
      for (const j of [-half, half]) {
        const v = x[i + j]!
        if (Number.isFinite(v)) { s -= (1 - w(j)) * v; c -= 1 - w(j) }
      }
    }
    // at least half the window present (weights count as present weight)
    if (c >= 0.5 * p) out[i] = s / c
  }
  return out
}

function acfAt(r: Float64Array, lag: number): { acf: number | null; pairs: number } {
  const n = r.length
  if (lag <= 0 || lag >= n) return { acf: null, pairs: 0 }
  let mean = 0, cnt = 0
  for (let i = 0; i < n; i++) if (Number.isFinite(r[i]!)) { mean += r[i]!; cnt++ }
  if (cnt < 3) return { acf: null, pairs: 0 }
  mean /= cnt
  let den = 0
  for (let i = 0; i < n; i++) if (Number.isFinite(r[i]!)) { const d = r[i]! - mean; den += d * d }
  den /= cnt
  let num = 0, pairs = 0
  for (let i = 0; i + lag < n; i++) {
    const a = r[i]!, b = r[i + lag]!
    if (Number.isFinite(a) && Number.isFinite(b)) { num += (a - mean) * (b - mean); pairs++ }
  }
  if (pairs < 3 || !(den > 0)) return { acf: null, pairs }
  return { acf: num / pairs / den, pairs }
}

export function detectSeasonality(series: Series, params?: Partial<SeasonalityParams>): SeasonalityResult {
  const p = { ...seasonalityDefaults, ...(params ?? {}) }
  const stepMs = p.stepMs > 0 ? p.stepMs : inferStep(series.ts.subarray(0, length(series)))
  const grid = toGrid(series, stepMs)
  const candidates: Candidate[] = []
  for (const P of p.candidatesMs) {
    const lag = stepMs > 0 ? Math.round(P / stepMs) : 0
    const cycles = lag > 0 ? grid.values.length / lag : 0
    if (lag < 4) { candidates.push({ periodMs: P, testable: false, cycles, acf: null, acfHalf: null, pairs: 0, seasonal: false, reason: `the step (${duration(stepMs)}) is too coarse for a ${duration(P)} period` }); continue }
    if (cycles < p.minCycles) { candidates.push({ periodMs: P, testable: false, cycles, acf: null, acfHalf: null, pairs: 0, seasonal: false, reason: `needs ${p.minCycles} cycles (${duration(p.minCycles * P)}), has ${fmt(cycles)}` }); continue }
    const trend = centredMA(grid.values, lag)
    const r = new Float64Array(grid.values.length)
    for (let i = 0; i < r.length; i++) r[i] = grid.values[i]! - trend[i]!
    const a = acfAt(r, lag)
    const h = acfAt(r, Math.round(lag / 2))
    const sig = a.pairs > 0 ? 3 / Math.sqrt(a.pairs) : 1
    const seasonal = a.acf !== null && h.acf !== null && a.acf >= p.minAcf && a.acf - h.acf >= p.minPeak && a.acf > sig
    const reason = a.acf === null ? 'too few present pairs'
      : seasonal ? `autocorrelation ${fmt(a.acf)} at ${duration(P)} (${fmt(h.acf!)} at half the lag)`
      : a.acf < p.minAcf ? `autocorrelation ${fmt(a.acf)} at ${duration(P)} is below ${fmt(p.minAcf)}`
      : `no peak at ${duration(P)}: ${fmt(a.acf)} versus ${fmt(h.acf ?? NaN)} at half the lag`
    candidates.push({ periodMs: P, testable: true, cycles, acf: a.acf, acfHalf: h.acf, pairs: a.pairs, seasonal, reason })
  }
  const seasonalOnes = candidates.filter((c) => c.seasonal).sort((x, y) => x.periodMs - y.periodMs)
  let chosen: Candidate | null = seasonalOnes[0] ?? null
  for (const c of seasonalOnes.slice(1)) if (chosen && c.acf! >= chosen.acf! + p.preferLongerBy) chosen = c
  const anyTestable = candidates.some((c) => c.testable)
  const text = chosen
    ? `${duration(chosen.periodMs)} seasonality, confidence ${fmt(chosen.acf!)} (${chosen.reason})`
    : anyTestable ? `no hourly, daily or weekly seasonality: ${candidates.filter((c) => c.testable).map((c) => c.reason).join('; ')}`
    : `not enough history to test any candidate: ${candidates.map((c) => c.reason).join('; ')}`
  return {
    status: anyTestable ? 'ok' : 'not_enough_history',
    periodMs: chosen ? chosen.periodMs : null,
    confidence: chosen ? Math.max(0, Math.min(1, chosen.acf!)) : 0,
    candidates,
    stepMs,
    text,
  }
}
