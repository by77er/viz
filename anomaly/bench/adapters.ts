/**
 * How each detector is run on a NAB file, and the parameter grids searched on the tuning fold.
 *
 * Every adapter is causal: a point's score depends only on points at or before it (NAB's
 * rule). Tier-1 batch detectors are run the way the design runs them: STL is refit once per
 * period on the trailing 4 periods and new points are scored against the stored model; PELT
 * re-segments the trailing window every 12 points and reports a new changepoint at the time
 * of that run (so its detection delay is honest).
 *
 * Each adapter returns a continuous score (≥ 0, the detector's own unit) and the detector's
 * own anomalous flags at the given parameters.
 */
import {
  threshold, ewma, robustZ, seasonal, cusum, fitStl, stl, pelt, detectSeasonality,
  DAY_MS, type Series, type Point, type StlModel,
} from '../src/index.ts'
import { probationaryLength, type NabFile } from './nab.ts'
import { inferStep } from '../src/stats.ts'

export interface Run { scores: Float64Array; flags: Uint8Array }
export interface Ctx { stepMs: number; prob: number; periodMs: number | null; seasonalityText: string }
export interface Config { detector: string; label: string; params: Record<string, number | string>; run: (f: NabFile, c: Ctx) => Run }

export function context(f: NabFile): Ctx {
  const prob = probationaryLength(f.values.length)
  const stepMs = inferStep(f.ts)
  // seasonality is detected on the probationary period only (no peeking at scored data)
  const head: Series = { ts: f.ts.subarray(0, Math.floor(prob)), values: f.values.subarray(0, Math.floor(prob)) }
  const s = detectSeasonality(head, { stepMs })
  return { stepMs, prob, periodMs: s.periodMs, seasonalityText: s.text }
}

const series = (f: NabFile): Series => ({ ts: f.ts, values: f.values })

function fromPoints(points: Point[]): Run {
  const scores = new Float64Array(points.length)
  const flags = new Uint8Array(points.length)
  points.forEach((p, i) => { scores[i] = p.score; flags[i] = p.anomalous ? 1 : 0 })
  return { scores, flags }
}

// ───────────────────────────── adapters ─────────────────────────────

/** Plain static threshold set from the probationary period: [min − m·range, max + m·range]. */
export function runThreshold(f: NabFile, c: Ctx, m: number, recover = 0): Run {
  const p = Math.floor(c.prob)
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < p; i++) { const v = f.values[i]!; if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v) } }
  const range = hi > lo ? hi - lo : Math.max(Math.abs(hi), 1)
  const above = hi + m * range, below = lo - m * range
  const r = threshold.detect(series(f), { above, below, recoverAbove: above - recover * range, recoverBelow: below + recover * range, stepMs: c.stepMs })
  const out = fromPoints(r.points)
  // continuous score for threshold sweeps: exceedance beyond the probation range, in ranges
  for (let i = 0; i < f.values.length; i++) {
    const v = f.values[i]!
    out.scores[i] = Number.isFinite(v) ? Math.max(0, (v - hi) / range, (lo - v) / range) : 0
  }
  return out
}

export function runSeasonal(f: NabFile, c: Ctx, params: Record<string, number | string>, fallback: 'robust_z' | 'daily'): Run {
  const periodMs = c.periodMs ?? (fallback === 'daily' ? DAY_MS : null)
  if (periodMs === null) return fromPoints(robustZ.detect(series(f), { k: Number(params.k), stepMs: c.stepMs }).points)
  return fromPoints(seasonal.detect(series(f), { ...params, periodMs, stepMs: c.stepMs } as never).points)
}

/** STL refit every period on the trailing `fitPeriods` periods; points scored against the latest model. */
export function runStl(f: NabFile, c: Ctx, k: number, fitPeriods: number): Run {
  const n = f.values.length
  const scores = new Float64Array(n)
  const flags = new Uint8Array(n)
  const P = c.periodMs ?? DAY_MS
  const step = c.stepMs
  let model: StlModel | null = null
  let nextFit = f.ts[0]! + 2 * P
  let from = 0 // first index not yet scored
  let lo = 0 // start of fit window
  for (let i = 0; i <= n; i++) {
    const t = i < n ? f.ts[i]! : Infinity
    if (t >= nextFit || i === n) {
      // score [from, i) with the current model
      if (model && i > from) {
        const r = stl.detect({ ts: f.ts.subarray(from, i), values: f.values.subarray(from, i) }, { periodMs: P, stepMs: step, k }, model)
        r.points.forEach((p, j) => { scores[from + j] = p.score; flags[from + j] = p.anomalous ? 1 : 0 })
      }
      from = i
      if (i === n) break
      // refit on (t − fitPeriods·P, t)
      while (lo < i && f.ts[lo]! < t - fitPeriods * P) lo++
      const fit = fitStl({ ts: f.ts.subarray(lo, i), values: f.values.subarray(lo, i) }, { periodMs: P, stepMs: step })
      if (fit) model = fit.model
      while (nextFit <= t) nextFit += P
    }
  }
  return { scores, flags }
}

/** PELT re-run every `every` points on the trailing `window` points; new changepoints reported when found. */
export function runPelt(f: NabFile, minShift: number, window = 576, every = 12): Run {
  const n = f.values.length
  const scores = new Float64Array(n)
  const flags = new Uint8Array(n)
  let lastCp = -Infinity
  const minSeg = 5
  for (let t = every; t <= n; t += every) {
    const a = Math.max(0, t - window)
    const xs: number[] = []
    const idx: number[] = []
    for (let i = a; i < t; i++) if (Number.isFinite(f.values[i]!)) { xs.push(f.values[i]!); idx.push(i) }
    if (xs.length < 4 * minSeg) continue
    const seg = pelt(xs, { minSegment: minSeg })
    const bounds = [0, ...seg.changepoints, xs.length]
    for (let s = 1; s + 1 < bounds.length; s++) {
      const cp = idx[bounds[s]!]!
      // only changes in the recent half that are new
      if (cp <= lastCp + minSeg || bounds[s]! < xs.length / 2) continue
      let m0 = 0, m1 = 0
      for (let i = bounds[s - 1]!; i < bounds[s]!; i++) m0 += xs[i]!
      for (let i = bounds[s]!; i < bounds[s + 1]!; i++) m1 += xs[i]!
      m0 /= bounds[s]! - bounds[s - 1]!
      m1 /= bounds[s + 1]! - bounds[s]!
      const shift = Math.abs(m1 - m0) / seg.sigma
      const at = t - 1 // reported when this run happens
      scores[at] = Math.max(scores[at]!, shift)
      if (shift >= minShift) flags[at] = 1
      lastCp = cp
    }
  }
  return { scores, flags }
}

// ───────────────────────────── grids ─────────────────────────────

const grid = (detector: string, axes: Record<string, (number | string)[]>, make: (p: Record<string, number | string>) => Config['run']): Config[] => {
  let combos: Record<string, number | string>[] = [{}]
  for (const [k, vs] of Object.entries(axes)) combos = combos.flatMap((c) => vs.map((v) => ({ ...c, [k]: v })))
  return combos.map((params) => ({ detector, label: `${detector}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})`, params, run: make(params) }))
}

export const GRIDS: Record<string, Config[]> = {
  threshold: grid('threshold', { m: [0, 0.05, 0.1, 0.25, 0.5, 1] }, (p) => (f, c) => runThreshold(f, c, Number(p.m))),
  ewma: grid('ewma', { halfLifePoints: [10, 30, 100], k: [3, 4, 6, 8] }, (p) => (f, c) => fromPoints(ewma.detect(series(f), { ...p, stepMs: c.stepMs } as never).points)),
  robust_z: grid('robust_z', { windowPoints: [50, 288, 1000], k: [3.5, 5, 7, 10] }, (p) => (f, c) => fromPoints(robustZ.detect(series(f), { ...p, stepMs: c.stepMs } as never).points)),
  seasonal: grid('seasonal', { seasons: [1, 3], k: [4, 6, 9], adapt: ['robust', 'agile'] }, (p) => (f, c) => runSeasonal(f, c, p, 'robust_z')),
  seasonal_daily: grid('seasonal_daily', { seasons: [1, 3], k: [4, 6, 9], adapt: ['robust', 'agile'] }, (p) => (f, c) => runSeasonal(f, c, p, 'daily')),
  stl: grid('stl', { k: [4, 6, 9] }, (p) => (f, c) => runStl(f, c, Number(p.k), 4)),
  cusum: grid('cusum', { k: [0.5, 1], h: [5, 10, 20] }, (p) => (f, c) => fromPoints(cusum.detect(series(f), { ...p, stepMs: c.stepMs } as never).points)),
  pelt: grid('pelt', { minShift: [2, 4, 8] }, (p) => (f) => runPelt(f, Number(p.minShift))),
  // Added after the first run showed robust z and seasonal far below zero (routine spikes on
  // heavy-tailed series score 20+ robust σ). Post hoc: reported separately, not as the result.
  robust_z_posthoc: grid('robust_z_posthoc', { windowPoints: [50, 288, 1000], k: [15, 25, 40] }, (p) => (f, c) => fromPoints(robustZ.detect(series(f), { ...p, stepMs: c.stepMs } as never).points)),
  seasonal_posthoc: grid('seasonal_posthoc', { seasons: [1, 3], k: [15, 25, 40], adapt: ['robust', 'agile'] }, (p) => (f, c) => runSeasonal(f, c, p, 'robust_z')),
}

/** Defaults for the NAB-protocol table (no tuning; threshold swept over the corpus as NAB does). */
export const DEFAULT_CONFIGS: Config[] = [
  { detector: 'threshold', label: 'threshold(m=0)', params: { m: 0 }, run: (f, c) => runThreshold(f, c, 0) },
  { detector: 'ewma', label: 'ewma(defaults)', params: {}, run: (f, c) => fromPoints(ewma.detect(series(f), { stepMs: c.stepMs }).points) },
  { detector: 'robust_z', label: 'robust_z(defaults)', params: {}, run: (f, c) => fromPoints(robustZ.detect(series(f), { stepMs: c.stepMs }).points) },
  { detector: 'seasonal', label: 'seasonal(auto period, else robust_z)', params: {}, run: (f, c) => runSeasonal(f, c, { seasons: 3, k: 4, adapt: 'robust' }, 'robust_z') },
  { detector: 'seasonal_daily', label: 'seasonal(daily)', params: {}, run: (f, c) => runSeasonal(f, c, { seasons: 3, k: 4, adapt: 'robust' }, 'daily') },
  { detector: 'stl', label: 'stl(refit per period)', params: {}, run: (f, c) => runStl(f, c, 4, 4) },
  { detector: 'cusum', label: 'cusum(defaults)', params: {}, run: (f, c) => fromPoints(cusum.detect(series(f), { stepMs: c.stepMs }).points) },
  { detector: 'pelt', label: 'pelt(rolling)', params: {}, run: (f) => runPelt(f, 0) },
]
