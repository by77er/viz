/**
 * Tier 1: STL — Seasonal-Trend decomposition using LOESS (Cleveland, Cleveland, McRae &
 * Terpenning, J. Official Statistics 6(1), 1990), with residual-based anomalies.
 *
 * This is real LOESS-based STL, not a simplified substitute: a port of the reference Fortran
 * (stl.f: stlest, stless, stlss, stlfts, stlma, stlstp, stlrwt) with all jumps = 1, following
 * the same defaults as statsmodels' STL (itself a port of stl.f): seasonal window 7, trend
 * window = next odd ≥ 1.5·P / (1 − 1.5/ns), low-pass window = next odd > P, degree 1
 * everywhere; robust: 2 inner and 15 outer iterations with bisquare weights, else 5 and 0.
 * test/stl.test.ts compares it with statsmodels on fixtures (an independent implementation).
 * Why real STL: it is the decomposition the design names, its robustness weights stop the
 * anomalies themselves from bending the seasonal and trend estimates, and it can be checked
 * against an independent implementation number for number.
 *
 * The detector uses R's default LOESS strides (ceil(window/10)) and fits at most the last
 * `maxPeriods` (8) periods and `maxSlots` (20,000) slots, so one fit costs O(slots × window/10).
 * The period must be at least 4 steps. Missing grid slots are linearly interpolated for the
 * fit only (STL needs a complete grid) and are never scored. Anomaly score: |residual − median(residuals)| / (1.4826 · MAD).
 *
 * Use as the design intends (§7: refit on a schedule, score online): `detect` without state
 * fits the series and scores it in-sample, returning the fitted model as state; `detect` with
 * that state scores new points against the model (level + seasonal profile) without refitting.
 */
import type { Detector, DetectResult, Point, Series } from '../types.ts'
import { COMMON_DEFAULTS, type CommonParams, length, merge, missingPoint, mod, resolveStep, sideOk, summarize, warmingPoint, val, tsv } from '../base.ts'
import { deviation, duration } from '../explain.ts'
import { finiteScore, robust, spreadFloor } from '../stats.ts'
import { toGrid } from './seasonality.ts'

// ───────────────────────────── stl.f, 1-based positions as in the Fortran ─────────────────────────────

/** stlest: LOESS fit at position xs from y[nleft..nright] (1-based). Returns NaN if it cannot. */
function est(y: Float64Array, n: number, len: number, ideg: number, xs: number, nleft: number, nright: number, w: Float64Array, userw: boolean, rw: Float64Array): number {
  const range = n - 1
  let h = Math.max(xs - nleft, nright - xs)
  if (len > n) h += Math.floor((len - n) / 2)
  const h9 = 0.999 * h
  const h1 = 0.001 * h
  let a = 0
  for (let j = nleft; j <= nright; j++) {
    w[j - 1] = 0
    const r = Math.abs(j - xs)
    if (r <= h9) {
      if (r <= h1) w[j - 1] = 1
      else { const q = r / h, t = 1 - q * q * q; w[j - 1] = t * t * t } // not `**`: V8 runs x ** 3 about 50× slower here (measured)
      if (userw) w[j - 1]! *= rw[j - 1]!
      a += w[j - 1]!
    }
  }
  if (a <= 0) return NaN
  for (let j = nleft; j <= nright; j++) w[j - 1]! /= a
  if (h > 0 && ideg > 0) {
    let am = 0
    for (let j = nleft; j <= nright; j++) am += w[j - 1]! * j
    let b = xs - am
    let c = 0
    for (let j = nleft; j <= nright; j++) { const d = j - am; c += w[j - 1]! * d * d }
    if (Math.sqrt(c) > 0.001 * range) {
      b /= c
      for (let j = nleft; j <= nright; j++) w[j - 1] = w[j - 1]! * (b * (j - am) + 1)
    }
  }
  let ys = 0
  for (let j = nleft; j <= nright; j++) ys += w[j - 1]! * y[j - 1]!
  return ys
}

/** stless: LOESS smooth of y[0..n) into ys, evaluated every `njump` points and linearly interpolated between. */
function ess(y: Float64Array, n: number, len: number, ideg: number, njump: number, userw: boolean, rw: Float64Array, ys: Float64Array, w: Float64Array) {
  if (n < 2) { ys[0] = y[0]!; return }
  const newnj = Math.max(1, Math.min(njump, n - 1))
  let nleft = 0, nright = 0
  const at = (i: number) => {
    const v = est(y, n, len, ideg, i, nleft, nright, w, userw, rw)
    ys[i - 1] = Number.isNaN(v) ? y[i - 1]! : v
  }
  if (len >= n) {
    nleft = 1
    nright = n
    for (let i = 1; i <= n; i += newnj) at(i)
  } else if (newnj === 1) {
    const nsh = Math.floor((len + 1) / 2)
    nleft = 1
    nright = len
    for (let i = 1; i <= n; i++) {
      if (i > nsh && nright !== n) { nleft++; nright++ }
      at(i)
    }
  } else {
    const nsh = Math.floor((len + 1) / 2)
    for (let i = 1; i <= n; i += newnj) {
      if (i < nsh) { nleft = 1; nright = len }
      else if (i >= n - nsh + 1) { nleft = n - len + 1; nright = n }
      else { nleft = i - nsh + 1; nright = len + i - nsh }
      at(i)
    }
  }
  if (newnj !== 1) {
    for (let i = 1; i <= n - newnj; i += newnj) {
      const delta = (ys[i + newnj - 1]! - ys[i - 1]!) / newnj
      for (let j = i + 1; j <= i + newnj - 1; j++) ys[j - 1] = ys[i - 1]! + delta * (j - i)
    }
    const k = Math.floor((n - 1) / newnj) * newnj + 1
    if (k !== n) {
      at(n)
      if (k !== n - 1) {
        const delta = (ys[n - 1]! - ys[k - 1]!) / (n - k)
        for (let j = k + 1; j <= n - 1; j++) ys[j - 1] = ys[k - 1]! + delta * (j - k)
      }
    }
  }
}

/** stlss: smooth each cycle-subseries, extrapolating one point at each end → length n + 2np. */
function ss(y: Float64Array, n: number, np: number, ns: number, isdeg: number, nsjump: number, userw: boolean, rw: Float64Array, season: Float64Array) {
  const k0 = Math.floor((n - 1) / np) + 1
  const work1 = new Float64Array(k0)
  const work2 = new Float64Array(k0 + 2)
  const work3 = new Float64Array(k0)
  const work4 = new Float64Array(k0)
  const tmp = new Float64Array(k0)
  for (let j = 1; j <= np; j++) {
    const k = Math.floor((n - j) / np) + 1
    for (let i = 1; i <= k; i++) work1[i - 1] = y[(i - 1) * np + j - 1]!
    if (userw) for (let i = 1; i <= k; i++) work3[i - 1] = rw[(i - 1) * np + j - 1]!
    ess(work1, k, ns, isdeg, nsjump, userw, work3, tmp, work4)
    for (let i = 0; i < k; i++) work2[i + 1] = tmp[i]!
    const nright = Math.min(ns, k)
    let v = est(work1, k, ns, isdeg, 0, 1, nright, work4, userw, work3)
    work2[0] = Number.isNaN(v) ? work2[1]! : v
    const nleft = Math.max(1, k - ns + 1)
    v = est(work1, k, ns, isdeg, k + 1, nleft, k, work4, userw, work3)
    work2[k + 1] = Number.isNaN(v) ? work2[k]! : v
    for (let m = 1; m <= k + 2; m++) season[(m - 1) * np + j - 1] = work2[m - 1]!
  }
}

/** stlma: moving average of length len; output length n − len + 1. */
function ma(x: Float64Array, n: number, len: number, ave: Float64Array) {
  const newn = n - len + 1
  let v = 0
  for (let i = 0; i < len; i++) v += x[i]!
  ave[0] = v / len
  let k = len, m = 0
  for (let j = 1; j < newn; j++) {
    v = v - x[m]! + x[k]!
    ave[j] = v / len
    k++
    m++
  }
}

export interface StlOptions {
  /** ns: seasonal LOESS window (odd ≥ 3). */
  seasonal: number
  /** nt: 0 = default. */
  trend: number
  /** nl: 0 = default. */
  lowPass: number
  seasonalDeg: number
  trendDeg: number
  lowPassDeg: number
  robust: boolean
  /** 0 = 2 if robust else 5. */
  inner: number
  /** -1 = 15 if robust else 0. */
  outer: number
  /**
   * LOESS evaluation strides (stl.f's nsjump, ntjump, nljump); 1 = every point (statsmodels'
   * default), -1 = ceil(window / 10) (R's stl default), which cuts the cost about tenfold.
   */
  seasonalJump: number
  trendJump: number
  lowPassJump: number
}

export const stlOptionDefaults: StlOptions = { seasonal: 7, trend: 0, lowPass: 0, seasonalDeg: 1, trendDeg: 1, lowPassDeg: 1, robust: true, inner: 0, outer: -1, seasonalJump: 1, trendJump: 1, lowPassJump: 1 }

export interface Decomposition { seasonal: Float64Array; trend: Float64Array; resid: Float64Array; weights: Float64Array }

const odd = (x: number) => (x % 2 === 0 ? x + 1 : x)

/** STL of a complete, regularly spaced series y with period np (in samples). Requires n ≥ 2·np. */
export function stlDecompose(y: Float64Array, period: number, options?: Partial<StlOptions>): Decomposition {
  const o = { ...stlOptionDefaults, ...(options ?? {}) }
  const n = y.length
  const np = Math.max(2, Math.round(period))
  const ns = odd(Math.max(3, Math.round(o.seasonal)))
  const nt = odd(Math.max(3, o.trend > 0 ? Math.round(o.trend) : Math.ceil((1.5 * np) / (1 - 1.5 / ns))))
  const nl = odd(Math.max(3, o.lowPass > 0 ? Math.round(o.lowPass) : np + 1))
  const ni = o.inner > 0 ? o.inner : o.robust ? 2 : 5
  if (o.seasonalJump < 0) o.seasonalJump = Math.ceil(ns / 10)
  if (o.trendJump < 0) o.trendJump = Math.ceil(nt / 10)
  if (o.lowPassJump < 0) o.lowPassJump = Math.ceil(nl / 10)
  const no = o.outer >= 0 ? o.outer : o.robust ? 15 : 0
  const season = new Float64Array(n)
  const trend = new Float64Array(n)
  const rw = new Float64Array(n).fill(1)
  const w1 = new Float64Array(n + 2 * np)
  const c = new Float64Array(n + 2 * np)
  const w3 = new Float64Array(n + 2 * np)
  const w4 = new Float64Array(n + 2 * np)
  const lw = new Float64Array(n + 2 * np)
  let userw = false
  for (let k = 0; ; ) {
    // stlstp
    for (let j = 0; j < ni; j++) {
      for (let i = 0; i < n; i++) w1[i] = y[i]! - trend[i]!
      ss(w1, n, np, ns, o.seasonalDeg, Math.max(1, Math.round(o.seasonalJump)), userw, rw, c)
      // stlfts: three moving averages, then LOESS (nl)
      ma(c, n + 2 * np, np, w3)
      ma(w3, n + np + 1, np, w4)
      ma(w4, n + 2, 3, w3)
      ess(w3, n, nl, o.lowPassDeg, Math.max(1, Math.round(o.lowPassJump)), false, rw, w1, lw)
      for (let i = 0; i < n; i++) season[i] = c[np + i]! - w1[i]!
      for (let i = 0; i < n; i++) w1[i] = y[i]! - season[i]!
      ess(w1, n, nt, o.trendDeg, Math.max(1, Math.round(o.trendJump)), userw, rw, trend, lw)
    }
    k++
    if (k > no) break
    // stlrwt: bisquare weights on |y − fit| / (6 · median)
    const r = new Float64Array(n)
    for (let i = 0; i < n; i++) r[i] = Math.abs(y[i]! - trend[i]! - season[i]!)
    const sorted = Float64Array.from(r).sort()
    const mid1 = Math.floor(n / 2) + 1
    const mid2 = n - mid1 + 1
    const cmad = 3 * (sorted[mid1 - 1]! + sorted[mid2 - 1]!)
    const c9 = 0.999 * cmad, c1 = 0.001 * cmad
    for (let i = 0; i < n; i++) {
      const ri = r[i]!
      const u = ri / cmad, t = 1 - u * u
      rw[i] = ri <= c1 ? 1 : ri <= c9 ? t * t : 0
    }
    userw = true
  }
  if (no <= 0) rw.fill(1)
  const resid = new Float64Array(n)
  for (let i = 0; i < n; i++) resid[i] = y[i]! - season[i]! - trend[i]!
  return { seasonal: season, trend, resid, weights: rw }
}

// ───────────────────────────── the detector ─────────────────────────────

export interface StlParams extends CommonParams {
  /** Season length; required; a multiple of the step. */
  periodMs: number
  /**
   * ns, odd ≥ 7. 0 = "periodic" as in R's stl(s.window = "periodic"): ns = 10·n + 1 with
   * seasonal degree 0, i.e. the same seasonal shape every cycle. Default 0: a small window
   * lets the seasonal component follow the noise (measured: residual σ 0.57 for noise σ 1 at
   * ns = 7 on 10 daily cycles), which makes in-sample residuals look too good and inflates scores.
   */
  seasonalWindow: number
  robust: boolean
  /** Band half-width in robust standard deviations of the residuals. */
  k: number
  /** When scoring against a model: hold the trend flat, or extend its last-period slope. */
  trendExtrapolation: 'flat' | 'linear'
  /** Fit at most this many grid slots (the most recent). */
  maxSlots: number
  /** Fit at most this many periods (the most recent). */
  maxPeriods: number
  /** Periods needed to fit. */
  minPeriods: number
}

export const stlDefaults: StlParams = { ...COMMON_DEFAULTS, periodMs: 0, seasonalWindow: 0, robust: true, k: 4, trendExtrapolation: 'flat', maxSlots: 20_000, maxPeriods: 8, minPeriods: 2 }

/** A fitted model: enough to score new points without refitting. */
export interface StlModel {
  v: 1
  kind: 'stl'
  periodMs: number
  stepMs: number
  /** Timestamp of the last fitted slot. */
  endTs: number
  /** Trend at endTs, and its slope per step over the last period. */
  level: number
  slope: number
  /** Seasonal component of the last P slots; season[P − 1] is at endTs. */
  season: number[]
  residualMedian: number
  sigma: number
  fittedSlots: number
}

export interface StlFit { model: StlModel; start: number; decomposition: Decomposition; interpolated: Uint8Array }

/** Fit STL to a series (the scheduled job). Null if there is not enough history. */
export function fitStl(series: Series, params?: Partial<StlParams>): StlFit | null {
  const p = merge(stlDefaults, params)
  const stepMs = resolveStep(p.stepMs, undefined, series)
  if (!(stepMs > 0) || !(p.periodMs > 0)) return null
  const P = Math.round(p.periodMs / stepMs)
  if (!(P >= 4) || 2 * P > p.maxSlots) return null
  let grid = toGrid(series, stepMs)
  let start = grid.start
  const cap = Math.min(p.maxSlots, Math.max(2, p.maxPeriods) * P)
  if (grid.values.length > cap) {
    const cut = grid.values.length - cap
    grid = { start: grid.start + cut * stepMs, values: grid.values.subarray(cut) }
    start = grid.start
  }
  const y = Float64Array.from(grid.values)
  const n = y.length
  let present = 0
  for (const v of y) if (Number.isFinite(v)) present++
  if (n < Math.max(2, p.minPeriods) * P || present < Math.max(2, p.minPeriods) * P * 0.5) return null
  // linear interpolation over missing slots (fit only)
  const interpolated = new Uint8Array(n)
  let prev = -1
  for (let i = 0; i <= n; i++) {
    if (i < n && !Number.isFinite(y[i]!)) continue
    if (i - prev > 1) {
      const a = prev >= 0 ? y[prev]! : i < n ? y[i]! : 0
      const b = i < n ? y[i]! : a
      for (let q = prev + 1; q < i; q++) {
        y[q] = prev >= 0 && i < n ? a + ((b - a) * (q - prev)) / (i - prev) : prev >= 0 ? a : b
        interpolated[q] = 1
      }
    }
    prev = i
  }
  const periodic = !(p.seasonalWindow > 0)
  const d = stlDecompose(y, P, { seasonal: periodic ? 10 * n + 1 : p.seasonalWindow, seasonalDeg: periodic ? 0 : 1, robust: p.robust, seasonalJump: -1, trendJump: -1, lowPassJump: -1 })
  const real: number[] = []
  for (let i = 0; i < n; i++) if (!interpolated[i]) real.push(d.resid[i]!)
  const rb = robust(real)
  const last = n - 1
  const model: StlModel = {
    v: 1,
    kind: 'stl',
    periodMs: p.periodMs,
    stepMs,
    endTs: start + last * stepMs,
    // + 0: no -0 in state, so it survives JSON unchanged
    level: d.trend[last]! + 0,
    slope: n > P ? (d.trend[last]! - d.trend[last - P]!) / P + 0 : 0,
    season: Array.from(d.seasonal.subarray(n - P), (v) => v + 0),
    residualMedian: Number.isFinite(rb.median) ? rb.median + 0 : 0,
    sigma: Number.isFinite(rb.sigma) ? rb.sigma + 0 : 0,
    fittedSlots: n,
  }
  return { model, start, decomposition: d, interpolated }
}

export const stl: Detector<StlParams, StlModel> = {
  name: 'stl',
  tier: 1,
  mode: 'batch',
  defaults: stlDefaults,
  history(params, stepMs) {
    const p = merge(stlDefaults, params)
    const need = Math.max(2, p.minPeriods) * p.periodMs
    return {
      lookbackMs: need,
      resolutionMs: stepMs,
      minPoints: stepMs > 0 ? Math.round(need / stepMs) : 0,
      incremental: false,
      tickLookbackMs: 0,
      reason: `Refit on a schedule over at least ${duration(need)}; between refits new points are scored against the stored model (${stepMs > 0 ? Math.round(p.periodMs / stepMs) : '?'} seasonal values).`,
    }
  },
  detect(series: Series, params?: Partial<StlParams>, state?: StlModel | null): DetectResult<StlModel> {
    const p = merge(stlDefaults, params)
    const n = length(series)
    const points: Point[] = new Array(n)
    const label = (P: number) => `the robust STL fit (trend + ${duration(P)} seasonal)`
    const usable = state && state.v === 1 && state.kind === 'stl' && state.periodMs === p.periodMs && (p.stepMs <= 0 || state.stepMs === p.stepMs)
    if (usable) {
      const m = state
      const P = m.season.length
      const sd = spreadFloor(m.sigma, m.level, p.minSpread)
      let lastTs: number | null = null
      for (let i = 0; i < n; i++) {
        const ts = tsv(series.ts[i]!), x = val(series.values[i]!)
        if (!Number.isFinite(ts) || !Number.isFinite(x) || (lastTs !== null && ts <= lastTs)) { points[i] = missingPoint(ts, x); continue }
        lastTs = ts
        const h = Math.round((ts - m.endTs) / m.stepMs)
        const expected = m.level + (p.trendExtrapolation === 'linear' ? m.slope * h : 0) + m.season[mod(P - 1 + h, P)]! + m.residualMedian
        points[i] = scorePoint(ts, x, expected, sd, p, label(m.periodMs), { stepsAfterFit: h })
      }
      return { points, state: m, summary: summarize('stl', points, m, { mode: 'model' }) }
    }
    const fit = fitStl(series, p)
    if (!fit) {
      for (let i = 0; i < n; i++) {
        const ts = tsv(series.ts[i]!), x = val(series.values[i]!)
        points[i] = Number.isFinite(ts) && Number.isFinite(x) ? warmingPoint(ts, x) : missingPoint(ts, x)
      }
      return { points, state: null, summary: summarize('stl', points, null, undefined, `needs ${Math.max(2, p.minPeriods)} full periods (${duration(Math.max(2, p.minPeriods) * p.periodMs)}) on a regular grid, at least half of it present`) }
    }
    const { model, start, decomposition: d } = fit
    const sd = spreadFloor(model.sigma, model.level, p.minSpread)
    let lastTs: number | null = null
    for (let i = 0; i < n; i++) {
      const ts = tsv(series.ts[i]!), x = val(series.values[i]!)
      if (!Number.isFinite(ts) || !Number.isFinite(x) || (lastTs !== null && ts <= lastTs)) { points[i] = missingPoint(ts, x); continue }
      lastTs = ts
      const s = Math.round((ts - start) / model.stepMs)
      if (s < 0 || s >= d.trend.length) { points[i] = warmingPoint(ts, x); continue }
      const expected = d.trend[s]! + d.seasonal[s]! + model.residualMedian
      points[i] = scorePoint(ts, x, expected, sd, p, label(model.periodMs), { trend: d.trend[s]!, seasonal: d.seasonal[s]!, robustnessWeight: d.weights[s]! })
    }
    return { points, state: model, summary: summarize('stl', points, model, { mode: 'fit', fittedSlots: model.fittedSlots }) }
  },
}

function scorePoint(ts: number, x: number, expected: number, sd: number, p: StlParams, label: string, facts: Record<string, number>): Point {
  const diff = x - expected
  const score = finiteScore(Math.abs(diff) / sd)
  const anomalous = score > p.k && Math.abs(diff) >= p.minDeviation && sideOk(p.direction, diff)
  const pt: Point = { ts, value: x, expected, lower: expected - p.k * sd, upper: expected + p.k * sd, score, anomalous, status: 'ok' }
  if (anomalous) {
    pt.explanation = deviation({
      detector: 'stl',
      kind: 'residual',
      value: x,
      reference: expected,
      referenceLabel: label,
      deviations: score,
      spread: sd,
      spreadLabel: '1.4826 × MAD of the fit residuals',
      spreadWord: 'robust standard deviations',
      at: ts,
      unit: p.unit,
      facts,
    })
  }
  return pt
}
