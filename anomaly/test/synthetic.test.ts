/** Known-answer tests on synthetic series: spike, step, seasonal anomaly, drift, gaps, NaN, constant, too short. */
import { describe, expect, it } from 'vitest'
import { threshold, ewma, robustZ, seasonal, cusum, stl, peltDetector, DETECTORS, MAD_TO_SIGMA } from '../src/index.ts'
import type { Series } from '../src/index.ts'
import { anomalies, DAY, gauss, HOUR, make, MIN, rng, T0 } from './helpers.ts'

const noise = (seed: number, n: number, step = 5 * MIN, mean = 100, sd = 1, t0 = T0) => {
  const r = rng(seed)
  return make(n, step, () => mean + sd * gauss(r), t0)
}

describe('threshold with hysteresis', () => {
  const s = make(7, MIN, (i) => [100, 600, 480, 460, 440, 300, 520][i]!)
  it('fires above, holds above the recovery level, recovers below it', () => {
    const r = threshold.detect(s, { above: 500, recoverAbove: 450 })
    expect(anomalies(r)).toEqual([1, 2, 3, 6])
    expect(r.points[2]!.explanation!.text).toContain('alert holds')
    expect(r.points[1]!.explanation!.facts.onset).toBe(1)
    expect(r.points[2]!.explanation!.facts.onset).toBe(0)
  })
  it('without hysteresis, recovers as soon as the value is back under', () => {
    expect(anomalies(threshold.detect(s, { above: 500 }))).toEqual([1, 6])
  })
  it('below threshold', () => {
    const r = threshold.detect(make(4, MIN, (i) => [10, 2, 4, 9][i]!), { below: 3, recoverBelow: 5 })
    expect(anomalies(r)).toEqual([1, 2])
  })
  it('a missing point keeps the alert; a stale gap clears it', () => {
    const v = [600, NaN, 470]
    const r = threshold.detect(make(3, MIN, (i) => v[i]!), { above: 500, recoverAbove: 450 })
    expect(anomalies(r)).toEqual([0, 2])
    expect(r.points[1]!.status).toBe('missing')
    const gap: Series = { ts: Float64Array.from([T0, T0 + MIN, T0 + 2 * HOUR]), values: Float64Array.from([100, 600, 470]) }
    expect(anomalies(threshold.detect(gap, { above: 500, recoverAbove: 450, staleAfterMs: 10 * MIN }))).toEqual([1])
    expect(anomalies(threshold.detect(gap, { above: 500, recoverAbove: 450 }))).toEqual([1, 2])
  })
})

describe('EWMA', () => {
  it('flags a spike and only the spike', () => {
    const s = noise(1, 500)
    s.values[300] = 120
    expect(anomalies(ewma.detect(s, { stepMs: 5 * MIN }))).toEqual([300])
  })
  it('flags a step, then absorbs it (clip still lets a lasting shift in)', () => {
    const s = noise(2, 800)
    for (let i = 300; i < 800; i++) s.values[i]! += 10
    const r = ewma.detect(s, { stepMs: 5 * MIN })
    expect(r.points[300]!.anomalous).toBe(true)
    expect(anomalies(r).filter((i) => i > 600)).toEqual([])
    expect(r.state!.mean).toBeGreaterThan(108)
  })
  it('warms up for minPoints', () => {
    const r = ewma.detect(noise(3, 50), { minPoints: 30 })
    expect(r.points.slice(0, 30).every((p) => p.status === 'warming')).toBe(true)
    expect(r.points[31]!.status).toBe('ok')
  })
  it('a long gap restarts the warm-up when staleAfterMs is set', () => {
    const s = noise(4, 100)
    for (let i = 50; i < 100; i++) s.ts[i]! += DAY
    const r = ewma.detect(s, { staleAfterMs: HOUR, minPoints: 10, stepMs: 5 * MIN })
    expect(r.points[50]!.status).toBe('warming')
    expect(r.points[60]!.status).toBe('ok')
  })
})

describe('robust z-score', () => {
  it('score is |x − median| / (1.4826 · MAD) exactly', () => {
    // window 1..21: median 11, MAD 5
    const s = make(22, MIN, (i) => (i < 21 ? i + 1 : 11 + 40))
    const r = robustZ.detect(s, { windowPoints: 100, minPoints: 21, stepMs: MIN })
    const p = r.points[21]!
    expect(p.expected).toBe(11)
    expect(p.score).toBeCloseTo(40 / (MAD_TO_SIGMA * 5), 12)
    expect(p.anomalous).toBe(true)
    expect(p.explanation!.facts.mad).toBe(5)
  })
  it('estimates σ of normal noise (the 1.4826 constant is needed)', () => {
    const r = robustZ.detect(noise(5, 3000, MIN, 0, 1), { windowPoints: 500, stepMs: MIN })
    const sig = r.points.filter((p) => p.status === 'ok').map((p) => (p.upper! - p.expected!) / 3.5)
    const mean = sig.reduce((a, b) => a + b, 0) / sig.length
    expect(mean).toBeGreaterThan(0.93)
    expect(mean).toBeLessThan(1.07)
  })
  it('flags a spike exactly', () => {
    const s = noise(6, 600)
    s.values[400] = 110
    expect(anomalies(robustZ.detect(s, { stepMs: 5 * MIN }))).toEqual([400])
  })
  it('MAD = 0 falls back to the mean absolute deviation', () => {
    const v = Array.from({ length: 40 }, (_, i) => (i % 10 === 0 ? 101 : 100))
    v.push(103)
    const r = robustZ.detect(make(v.length, MIN, (i) => v[i]!), { windowPoints: 40, minPoints: 30, stepMs: MIN })
    const p = r.points[40]!
    expect(p.anomalous).toBe(true)
    expect(p.explanation!.spreadLabel).toContain('mean absolute deviation')
    expect(Number.isFinite(p.score)).toBe(true)
  })
  it('missing points are not zeros', () => {
    // every other point missing; if NaN were read as 0 the median would collapse
    const s = noise(7, 800, MIN, 100, 1)
    for (let i = 0; i < 800; i += 2) s.values[i] = NaN
    const r = robustZ.detect(s, { windowPoints: 100, stepMs: MIN, k: 5 })
    expect(anomalies(r)).toEqual([])
    const ok = r.points.filter((p) => p.status === 'ok')
    expect(ok.length).toBeGreaterThan(300)
    expect(ok.every((p) => Math.abs(p.expected! - 100) < 1)).toBe(true)
    expect(r.points[0]!.status).toBe('missing')
    expect(r.points[0]!.value).toBeNull()
  })
})

describe('seasonal baseline', () => {
  // hourly points, daily sine 100 ± 50, noise σ = 2
  const daily = (seed: number, days: number) => {
    const r = rng(seed)
    return make(days * 24, HOUR, (_, t) => 100 + 50 * Math.sin((2 * Math.PI * (t - T0)) / DAY) + 2 * gauss(r))
  }
  it('flags a value normal for the day but wrong for its hour; a non-seasonal detector does not', () => {
    const s = daily(11, 14)
    const at = 10 * 24 + 18 // 18:00, where the sine is at its trough (50)
    s.values[at] = 145 // the daily peak level
    const r = seasonal.detect(s, { periodMs: DAY, seasons: 4, stepMs: HOUR })
    expect(anomalies(r)).toEqual([at])
    expect(r.points[at]!.expected!).toBeCloseTo(50, -1)
    const flat = robustZ.detect(s, { windowMs: DAY, stepMs: HOUR })
    expect(flat.points[at]!.anomalous).toBe(false)
  })
  it('blends exactly the k most recent seasons, at the same phase', () => {
    // one point per day at the same hour: 10, 20, 30, 40, 50, then the scored point
    const vals = [10, 20, 30, 40, 50, 1000]
    const s: Series = { ts: Float64Array.from(vals, (_, i) => T0 + i * DAY), values: Float64Array.from(vals) }
    const base = { periodMs: DAY, stepMs: HOUR, minSeasons: 1, minResiduals: 0, contamination: 'keep' as const }
    const w = seasonal.detect(s, { ...base, seasons: 4, minResiduals: 0 })
    expect(w.points[5]!.expected).toBe(35) // median(20, 30, 40, 50)
    expect(seasonal.detect(s, { ...base, seasons: 2 }).points[5]!.expected).toBe(45) // median(40, 50)
    expect(seasonal.detect(s, { ...base, seasons: 4, blend: 'mean', decay: 0.5 }).points[5]!.expected).toBeCloseTo((50 + 40 * 0.5 + 30 * 0.25 + 20 * 0.125) / 1.875, 12)
  })
  it('a missing slot in an earlier season is left out, not read as zero', () => {
    const vals = [10, 20, NaN, 40, 50, 60]
    const s: Series = { ts: Float64Array.from(vals, (_, i) => T0 + i * DAY), values: Float64Array.from(vals) }
    const r = seasonal.detect(s, { periodMs: DAY, stepMs: HOUR, seasons: 4, minSeasons: 1, minResiduals: 0 })
    expect(r.points[5]!.expected).toBe(40) // median(20, 40, 50)
  })
  it('agile adapts to a level shift; robust keeps alerting', () => {
    const s = daily(12, 16)
    for (let i = 10 * 24; i < s.values.length; i++) s.values[i]! += 40
    const common = { periodMs: DAY, seasons: 4, stepMs: HOUR, k: 4 }
    const rob = anomalies(seasonal.detect(s, { ...common, adapt: 'robust' }))
    const agi = anomalies(seasonal.detect(s, { ...common, adapt: 'agile', agileWindowMs: 3 * HOUR }))
    expect(rob.filter((i) => i >= 11 * 24).length).toBeGreaterThan(20)
    expect(agi.filter((i) => i >= 11 * 24).length).toBe(0)
    expect(agi).toContain(10 * 24)
  })
  it('weekly seasonality at 1-hour rollups: state fits a Durable Object row', () => {
    const r = rng(13)
    const s = make(6 * 7 * 24, HOUR, (i) => 100 + (i % 168 < 120 ? 50 : 0) + gauss(r))
    const out = seasonal.detect(s, { periodMs: 7 * DAY, seasons: 4, stepMs: HOUR })
    expect(out.summary.stateBytes).toBeLessThan(20_000)
    expect(out.summary.stateBytes).toBe(new TextEncoder().encode(JSON.stringify(out.state)).length)
  })
})

describe('CUSUM', () => {
  it('detects a 3σ step within a few points and explains it', () => {
    const s = noise(21, 400)
    for (let i = 200; i < 400; i++) s.values[i]! += 3
    const r = cusum.detect(s, { stepMs: 5 * MIN })
    const a = anomalies(r)
    expect(a.length).toBe(1)
    expect(a[0]!).toBeGreaterThanOrEqual(200)
    expect(a[0]!).toBeLessThan(206)
    const e = r.points[a[0]!]!.explanation!
    expect(e.reference).toBeCloseTo(100, 0)
    expect(e.value).toBeCloseTo(103, 0)
    expect(Math.abs(e.at - s.ts[200]!)).toBeLessThanOrEqual(3 * 5 * MIN)
    expect(e.text).toMatch(/^mean shifted from 100 to 10[23]/)
  })
  it('detects a slow drift', () => {
    const s = noise(22, 1500, 5 * MIN, 100, 1)
    for (let i = 300; i < 1500; i++) s.values[i]! += (i - 300) * 0.01
    const a = anomalies(cusum.detect(s, { stepMs: 5 * MIN }))
    expect(a.length).toBeGreaterThan(0)
    expect(a[0]!).toBeGreaterThan(300)
  })
  it('rarely alarms on independent noise (measured in-control run length)', () => {
    let alarms = 0
    let points = 0
    for (let seed = 0; seed < 20; seed++) {
      const r = cusum.detect(noise(100 + seed, 2030, MIN, 0, 1), { stepMs: MIN })
      alarms += anomalies(r).length
      points += 2000
    }
    // two-sided k = 0.5, h = 5 has an in-control ARL of about 465 points for known μ and σ;
    // with μ, σ estimated from 60 points (and μ from 30 after each alarm) it measures about 195
    expect(points / Math.max(alarms, 1)).toBeGreaterThan(150)
  })
})

describe('every detector: NaN, constant, too short', () => {
  const run = (name: string, s: Series) => {
    const d = (DETECTORS as Record<string, { detect: (s: Series, p?: object) => { points: { score: number; anomalous: boolean; status: string }[]; summary: { status: string } } }>)[name]!
    const params: Record<string, object> = {
      threshold: { above: 1e9 }, seasonal: { periodMs: DAY }, stl: { periodMs: DAY }, burn_rate: {},
    }
    // burn rate reads values as bad events out of `total`: 42 bad in 100,000 is a 0.042% error ratio, inside a 99.9% SLO
    if (name === 'burn_rate') return d.detect({ ...s, total: new Float64Array(s.values.length).fill(100_000) } as Series, params[name])
    return d.detect(s, params[name] ?? {})
  }
  const names = Object.keys(DETECTORS)
  it.each(names)('%s: constant series gives no anomalies and finite scores', (name) => {
    const r = run(name, make(3 * 288, 5 * MIN, () => 42))
    expect(r.points.every((p) => Number.isFinite(p.score) && p.score >= 0)).toBe(true)
    expect(r.points.filter((p) => p.anomalous).length).toBe(0)
  })
  it.each(names.filter((n) => n !== 'threshold' && n !== 'burn_rate'))('%s: a series too short says not_enough_history', (name) => {
    const r = run(name, make(4, 5 * MIN, (i) => i))
    expect(r.summary.status).toBe('not_enough_history')
    expect(r.points.every((p) => !p.anomalous && p.status !== 'ok')).toBe(true)
  })
  it.each(names)('%s: all-NaN series: every point missing, nothing thrown', (name) => {
    const r = run(name, make(50, 5 * MIN, () => NaN))
    expect(r.points.every((p) => p.status === 'missing' && !p.anomalous && p.score === 0)).toBe(true)
  })
})

describe('tier-1 batch detectors on known answers', () => {
  it('PELT finds a step at its exact index and explains it', () => {
    const s = noise(31, 300, 5 * MIN, 120, 4)
    for (let i = 180; i < 300; i++) s.values[i]! += 190
    const r = peltDetector.detect(s, { unit: 'ms' })
    expect(anomalies(r)).toEqual([180])
    expect(r.points[180]!.explanation!.text).toMatch(/^mean shifted from 1[12]\d ms to 3[01]\d ms at 2026-01-05 15:00 UTC/)
  })
  it('STL flags a spike on a seasonal series in-sample and from a stored model', () => {
    const r = rng(41)
    const s = make(10 * 24, HOUR, (_, t) => 100 + 30 * Math.sin((2 * Math.PI * (t - T0)) / DAY) + gauss(r))
    s.values[150] = s.values[150]! + 15
    const fit = stl.detect(s, { periodMs: DAY })
    expect(anomalies(fit)).toEqual([150])
    // next day, scored against the stored model without refitting
    const next = make(24, HOUR, (_, t) => 100 + 30 * Math.sin((2 * Math.PI * (t - T0)) / DAY) + gauss(r), T0 + 10 * DAY)
    next.values[5] = next.values[5]! - 15
    const scored = stl.detect(next, { periodMs: DAY }, fit.state)
    expect(anomalies(scored)).toEqual([5])
    expect(scored.points[5]!.expected!).toBeCloseTo(100 + 30 * Math.sin((2 * Math.PI * 5) / 24), -0.5)
  })
})
