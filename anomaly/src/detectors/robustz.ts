/**
 * Tier 0: robust z-score against the median and MAD of a trailing time window.
 *
 *   z = |x − median(W)| / σ̂(W),  σ̂ = 1.4826 · MAD(W)
 *
 * W holds the valid points with ts in (t − windowMs, t), not the current point. The 1.4826
 * factor makes σ̂ a consistent estimate of σ for normal data, so `k` and the explanation
 * mean "standard deviations" (Iglewicz & Hoaglin's modified z-score uses 0.6745 = 1/1.4826
 * for the same reason; their suggested cut-off is 3.5). If more than half the window is one
 * value (MAD = 0), σ̂ falls back to 1.2533 · mean absolute deviation from the median.
 *
 * The window is by time, so gaps shrink it rather than being read as zeros; when it holds
 * fewer than `minPoints` valid points the point is `warming`. The window includes earlier
 * anomalies: the median tolerates up to half the window being contaminated.
 * State: the window's points (2 numbers each). Scale-invariant.
 */
import type { Detector, DetectResult, Point, Series } from '../types.ts'
import { COMMON_DEFAULTS, type CommonParams, length, merge, missingPoint, resolveStep, sideOk, summarize, warmingPoint } from '../base.ts'
import { deviation, duration } from '../explain.ts'
import { finiteScore, MAD_TO_SIGMA, MEANAD_TO_SIGMA, medianInPlace, spreadFloor } from '../stats.ts'

export interface RobustZParams extends CommonParams {
  /** Trailing window. 0 = windowPoints × step. */
  windowMs: number
  windowPoints: number
  /** Cut-off in robust standard deviations. */
  k: number
  minPoints: number
}

export interface RobustZState {
  v: 1
  lastTs: number | null
  stepMs: number
  /** Window points, oldest first. */
  t: number[]
  x: number[]
}

export const robustZDefaults: RobustZParams = { ...COMMON_DEFAULTS, windowMs: 0, windowPoints: 288, k: 3.5, minPoints: 20 }

/** A time window with a sorted copy of its values, for median and MAD. */
class Window {
  t: number[] = []
  x: number[] = []
  head = 0
  sorted: Float64Array
  size = 0
  scratch: Float64Array
  constructor(cap: number) {
    this.sorted = new Float64Array(Math.max(16, cap))
    this.scratch = new Float64Array(Math.max(16, cap))
  }
  private grow() {
    const s = new Float64Array(this.sorted.length * 2)
    s.set(this.sorted)
    this.sorted = s
    this.scratch = new Float64Array(s.length)
  }
  private lowerBound(v: number) {
    let lo = 0, hi = this.size
    while (lo < hi) {
      const m = (lo + hi) >>> 1
      if (this.sorted[m]! < v) lo = m + 1
      else hi = m
    }
    return lo
  }
  push(ts: number, v: number) {
    this.t.push(ts)
    this.x.push(v)
    if (this.size === this.sorted.length) this.grow()
    const at = this.lowerBound(v)
    this.sorted.copyWithin(at + 1, at, this.size)
    this.sorted[at] = v
    this.size++
  }
  evict(before: number) {
    while (this.head < this.t.length && this.t[this.head]! <= before) {
      const v = this.x[this.head]!
      const at = this.lowerBound(v)
      this.sorted.copyWithin(at, at + 1, this.size)
      this.size--
      this.head++
    }
    if (this.head > 1024 && this.head * 2 > this.t.length) {
      this.t = this.t.slice(this.head)
      this.x = this.x.slice(this.head)
      this.head = 0
    }
  }
  median(): number {
    const n = this.size
    const h = n >>> 1
    return n % 2 ? this.sorted[h]! : (this.sorted[h - 1]! + this.sorted[h]!) / 2
  }
  /** σ̂ and the raw MAD, with the mean-absolute-deviation fallback. */
  sigma(med: number): { sigma: number; mad: number; from: 'mad' | 'meanad' | 'none' } {
    const n = this.size
    let sum = 0
    for (let i = 0; i < n; i++) {
      const d = Math.abs(this.sorted[i]! - med)
      this.scratch[i] = d
      sum += d
    }
    const mad = medianInPlace(this.scratch, n)
    if (mad > 0) return { sigma: MAD_TO_SIGMA * mad, mad, from: 'mad' }
    if (sum > 0) return { sigma: (MEANAD_TO_SIGMA * sum) / n, mad: 0, from: 'meanad' }
    return { sigma: 0, mad: 0, from: 'none' }
  }
}

export const robustZ: Detector<RobustZParams, RobustZState> = {
  name: 'robust_z',
  tier: 0,
  mode: 'incremental',
  defaults: robustZDefaults,
  history(params, stepMs) {
    const p = merge(robustZDefaults, params)
    const w = p.windowMs > 0 ? p.windowMs : p.windowPoints * stepMs
    return {
      lookbackMs: w,
      resolutionMs: 0,
      minPoints: p.minPoints,
      incremental: true,
      tickLookbackMs: 0,
      reason: `Median and MAD of the trailing ${duration(w)}; state holds that window's points.`,
    }
  },
  detect(series: Series, params?: Partial<RobustZParams>, state?: RobustZState | null): DetectResult<RobustZState> {
    const p = merge(robustZDefaults, params)
    const stepMs = resolveStep(p.stepMs, state?.stepMs, series, state?.lastTs)
    const windowMs = p.windowMs > 0 ? p.windowMs : p.windowPoints * stepMs
    let lastTs = state && state.v === 1 ? state.lastTs : null
    const win = new Window(p.windowPoints + 8)
    if (state && state.v === 1) for (let i = 0; i < state.t.length; i++) win.push(state.t[i]!, state.x[i]!)
    const n = length(series)
    const points: Point[] = new Array(n)
    const label = `the median of the last ${duration(windowMs)}`
    for (let i = 0; i < n; i++) {
      const ts = series.ts[i]!
      const x = series.values[i]!
      if (!Number.isFinite(ts) || !Number.isFinite(x) || (lastTs !== null && ts <= lastTs)) {
        points[i] = missingPoint(ts, x)
        continue
      }
      lastTs = ts
      win.evict(windowMs > 0 ? ts - windowMs : -Infinity)
      if (win.size < Math.max(1, p.minPoints)) {
        points[i] = warmingPoint(ts, x, win.size > 0 ? win.median() : null)
      } else {
        const med = win.median()
        const s = win.sigma(med)
        const sd = spreadFloor(s.sigma, med, p.minSpread)
        const diff = x - med
        const score = finiteScore(Math.abs(diff) / sd)
        const anomalous = score > p.k && Math.abs(diff) >= p.minDeviation && sideOk(p.direction, diff)
        const pt: Point = { ts, value: x, expected: med, lower: med - p.k * sd, upper: med + p.k * sd, score, anomalous, status: 'ok' }
        if (anomalous) {
          pt.explanation = deviation({
            detector: 'robust_z',
            kind: 'deviation',
            value: x,
            reference: med,
            referenceLabel: label,
            deviations: score,
            spread: sd,
            spreadLabel: s.from === 'mad' ? '1.4826 × median absolute deviation' : '1.2533 × mean absolute deviation (MAD was 0)',
            spreadWord: 'robust standard deviations',
            at: ts,
            unit: p.unit,
            facts: { windowPoints: win.size, mad: s.mad, k: p.k },
          })
        }
        points[i] = pt
      }
      win.push(ts, x)
    }
    win.evict(lastTs !== null && windowMs > 0 ? lastTs - windowMs : -Infinity)
    const out: RobustZState = { v: 1, lastTs, stepMs, t: win.t.slice(win.head), x: win.x.slice(win.head) }
    return { points, state: out, summary: summarize('robust_z', points, out, undefined, `needs ${p.minPoints} points in the last ${duration(windowMs)} before scoring`) }
  },
}
