/**
 * Tier 1: PELT changepoint detection for changes in mean (Killick, Fearnhead & Eckley,
 * JASA 2012), exact optimal segmentation with pruning.
 *
 * Cost of a segment: Σ (x − mean)² / σ², i.e. −2·log-likelihood of a normal segment with
 * known noise σ, up to a constant. σ is estimated robustly from first differences
 * (1.4826 · MAD(Δx) / √2), which level shifts barely affect.
 *
 * Penalty (stated): β = 2·ln(n) per changepoint, in the same σ² units — a BIC/SIC-style
 * penalty counting two parameters per change (its location and the new mean), each ln(n).
 * Override with `penalty`. A minimum segment length (default 5) stops single-point spikes
 * from being read as two changes.
 *
 * Minimises Σ cost(segments) + β·(number of changes). test/pelt.test.ts checks the result
 * against brute-force optimal partitioning (same objective, no pruning) and against the
 * `ruptures` Python package on fixtures.
 *
 * Batch: missing points are dropped before segmenting (gaps are not zeros) and changepoints
 * are reported at the first valid point of the new segment.
 */
import type { Detector, DetectResult, Point, Series } from '../types.ts'
import { COMMON_DEFAULTS, type CommonParams, length, merge, missingPoint, sideOk, summarize, warmingPoint } from '../base.ts'
import { duration, levelShift } from '../explain.ts'
import { finiteScore, spreadFloor } from '../stats.ts'
import { diffSigma } from './cusum.ts'

export interface PeltParams extends CommonParams {
  /** β in σ² units; 0 = 2·ln(n). */
  penalty: number
  minSegment: number
  /** Noise σ; 0 = estimated from first differences. */
  sigma: number
  /** Report a change only if |Δmean| ≥ minShift · σ. */
  minShift: number
  /** History the caller should fetch (for `history()` only). */
  lookbackMs: number
  /** Refuse (not_enough_history) above this many points: PELT's worst case is quadratic. */
  maxPoints: number
}

export const peltDefaults: PeltParams = { ...COMMON_DEFAULTS, penalty: 0, minSegment: 5, sigma: 0, minShift: 0, lookbackMs: 86_400_000, maxPoints: 200_000 }

export interface Segmentation {
  /** Indices (into x) where a new segment starts, excluding 0. */
  changepoints: number[]
  /** Optimal objective value Σ cost + β·#changes. */
  cost: number
  penalty: number
  sigma: number
}

/** PELT over a plain array of finite values. */
export function pelt(x: ArrayLike<number>, opts: { penalty?: number; minSegment?: number; sigma?: number } = {}): Segmentation {
  const m = x.length
  const minSeg = Math.max(1, Math.floor(opts.minSegment ?? 5))
  const sigma0 = opts.sigma && opts.sigma > 0 ? opts.sigma : diffSigma(Array.from(x))
  let mean = 0
  for (let i = 0; i < m; i++) mean += x[i]!
  mean = m ? mean / m : 0
  const sigma = spreadFloor(sigma0, mean, 0)
  const beta = opts.penalty && opts.penalty > 0 ? opts.penalty : 2 * Math.log(Math.max(m, 2))
  if (m < 2 * minSeg) return { changepoints: [], cost: segCostRaw(x, 0, m, mean) / (sigma * sigma), penalty: beta, sigma }
  // prefix sums, centred to limit cancellation
  const s1 = new Float64Array(m + 1)
  const s2 = new Float64Array(m + 1)
  for (let i = 0; i < m; i++) {
    const v = x[i]! - mean
    s1[i + 1] = s1[i]! + v
    s2[i + 1] = s2[i]! + v * v
  }
  const inv = 1 / (sigma * sigma)
  const cost = (a: number, b: number) => {
    const n = b - a
    const d1 = s1[b]! - s1[a]!
    return Math.max(0, s2[b]! - s2[a]! - (d1 * d1) / n) * inv
  }
  const F = new Float64Array(m + 1).fill(Infinity)
  const last = new Int32Array(m + 1).fill(-1)
  F[0] = -beta
  let R: number[] = [0]
  for (let t = minSeg; t <= m; t++) {
    let best = Infinity
    let arg = -1
    for (const tau of R) {
      if (t - tau < minSeg) continue
      const v = F[tau]! + cost(tau, t) + beta
      if (v < best) { best = v; arg = tau }
    }
    F[t] = best
    last[t] = arg
    // prune: τ can never be optimal again once F[τ] + C(τ, t) > F[t]   (K = 0 for this cost)
    const keep: number[] = []
    for (const tau of R) if (t - tau < minSeg || F[tau]! + cost(tau, t) <= F[t]!) keep.push(tau)
    const cand = t + 1 - minSeg
    if (cand >= minSeg && Number.isFinite(F[cand]!)) keep.push(cand)
    R = keep
  }
  const cps: number[] = []
  for (let t = m; t > 0; ) {
    const tau = last[t]!
    if (tau <= 0) break
    cps.push(tau)
    t = tau
  }
  cps.reverse()
  return { changepoints: cps, cost: F[m]!, penalty: beta, sigma }
}

function segCostRaw(x: ArrayLike<number>, a: number, b: number, mean: number) {
  let s = 0
  for (let i = a; i < b; i++) s += (x[i]! - mean) ** 2
  return s
}

export const peltDetector: Detector<PeltParams, null> = {
  name: 'pelt',
  tier: 1,
  mode: 'batch',
  defaults: peltDefaults,
  history(params, stepMs) {
    const p = merge(peltDefaults, params)
    return { lookbackMs: p.lookbackMs, resolutionMs: stepMs, minPoints: 2 * p.minSegment, incremental: false, tickLookbackMs: p.lookbackMs, reason: `Segments the last ${duration(p.lookbackMs)} each run (scheduled job); no state.` }
  },
  detect(series: Series, params?: Partial<PeltParams>): DetectResult<null> {
    const p = merge(peltDefaults, params)
    const n = length(series)
    const points: Point[] = new Array(n)
    const idx: number[] = []
    const xs: number[] = []
    let lastTs: number | null = null
    for (let i = 0; i < n; i++) {
      const ts = series.ts[i]!, x = series.values[i]!
      if (!Number.isFinite(ts) || !Number.isFinite(x) || (lastTs !== null && ts <= lastTs)) { points[i] = missingPoint(ts, x); continue }
      lastTs = ts
      idx.push(i)
      xs.push(x)
    }
    const minSeg = Math.max(1, Math.floor(p.minSegment))
    if (xs.length < 2 * minSeg || xs.length > p.maxPoints) {
      for (const i of idx) points[i] = warmingPoint(series.ts[i]!, series.values[i]!)
      return { points, state: null, summary: summarize('pelt', points, null, undefined, xs.length > p.maxPoints ? `more than ${p.maxPoints} points; segment a shorter range` : `needs at least ${2 * minSeg} points`) }
    }
    const seg = pelt(xs, { penalty: p.penalty, minSegment: minSeg, sigma: p.sigma })
    const bounds = [0, ...seg.changepoints, xs.length]
    const means: number[] = []
    for (let s = 0; s + 1 < bounds.length; s++) {
      let a = 0
      for (let i = bounds[s]!; i < bounds[s + 1]!; i++) a += xs[i]!
      means.push(a / (bounds[s + 1]! - bounds[s]!))
    }
    const changes: { ts: number; from: number; to: number; shiftSigma: number }[] = []
    for (let s = 0; s + 1 < bounds.length; s++) {
      for (let i = bounds[s]!; i < bounds[s + 1]!; i++) {
        const j = idx[i]!
        const ts = series.ts[j]!, x = xs[i]!
        const pt: Point = { ts, value: x, expected: means[s]!, lower: null, upper: null, score: 0, anomalous: false, status: 'ok' }
        if (i === bounds[s]! && s > 0) {
          const from = means[s - 1]!, to = means[s]!
          const shift = Math.abs(to - from) / seg.sigma
          pt.score = finiteScore(shift)
          const diff = to - from
          if (shift >= p.minShift && Math.abs(diff) >= p.minDeviation && sideOk(p.direction, diff)) {
            pt.anomalous = true
            pt.explanation = levelShift({ detector: 'pelt', from, to, changeAt: ts, sigma: seg.sigma, unit: p.unit, facts: { penalty: seg.penalty, segmentPoints: bounds[s + 1]! - bounds[s]! } })
            changes.push({ ts, from, to, shiftSigma: shift })
          }
        }
        points[j] = pt
      }
    }
    return { points, state: null, summary: summarize('pelt', points, null, { changepoints: changes, penalty: seg.penalty, sigma: seg.sigma, segments: means.length }) }
  },
}
