/** Cross-series outliers, seasonality detection, cost classes, and the purity rules for src/. */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  detectGroup, detectGroupWindow, detectSeasonality, classify, threshold, ewma, robustZ, seasonal, burnRate, stl, cusum, peltDetector,
  HOUR_MS, DAY_MS, WEEK_MS, MAD_TO_SIGMA,
} from '../src/index.ts'
import { gauss, HOUR, make, MIN, rng } from './helpers.ts'

describe('cross-series outliers', () => {
  it('one pod out of fifty', () => {
    const r = rng(1)
    const out = detectGroup(Array.from({ length: 50 }, (_, i) => ({ id: `pod-${i}`, value: i === 17 ? 200 : 100 + 5 * gauss(r) })))
    expect(out.outliers).toEqual(['pod-17'])
  })
  it('median/MAD, not mean/sd: six bad pods do not hide each other', () => {
    const r = rng(2)
    const vals = Array.from({ length: 50 }, (_, i) => (i < 6 ? 1000 : 100 + 5 * gauss(r)))
    const out = detectGroup(vals.map((v, i) => ({ id: `p${i}`, value: v })))
    expect(out.outliers).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5'])
    const sorted = [...vals].sort((a, b) => a - b)
    expect(out.median).toBe((sorted[24]! + sorted[25]!) / 2)
    // with mean and standard deviation they would hide: z ≈ 2.7 < 3.5
    const mean = vals.reduce((a, b) => a + b) / 50
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / 50)
    expect((1000 - mean) / sd).toBeLessThan(3.5)
    const p0 = out.members[0]!
    const mad = [...vals].map((v) => Math.abs(v - out.median!)).sort((a, b) => a - b)
    expect(p0.score).toBeCloseTo((1000 - out.median!) / (MAD_TO_SIGMA * ((mad[24]! + mad[25]!) / 2)), 9)
  })
  it('MAD = 0 (49 pods with zero errors): falls back and still flags the one with errors', () => {
    const out = detectGroup(Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, value: i === 3 ? 5 : 0 })))
    expect(out.outliers).toEqual(['p3'])
    expect(Number.isFinite(out.members[3]!.score)).toBe(true)
  })
  it('missing members do not take part; too few present → not_enough_history', () => {
    const out = detectGroup([{ id: 'a', value: 1 }, { id: 'b', value: NaN }, { id: 'c', value: 2 }])
    expect(out.status).toBe('not_enough_history')
    expect(out.members[1]!.status).toBe('missing')
  })
  it('over a window: sustained outliers only', () => {
    const r = rng(3)
    const group = Array.from({ length: 20 }, (_, k) => ({
      id: `p${k}`,
      series: make(30, MIN, (i) => 100 + 3 * gauss(r) + (k === 4 && i % 10 < 7 ? 80 : 0) + (k === 9 && i === 5 ? 80 : 0)),
    }))
    const out = detectGroupWindow(group, { minFraction: 0.5 })
    expect(out.outliers).toEqual(['p4'])
    expect(out.members.find((m) => m.id === 'p9')!.fraction).toBeLessThan(0.1)
  })
})

describe('seasonality detection', () => {
  const r = rng(4)
  it('daily sine at 5-minute steps → daily, high confidence', () => {
    const s = make(7 * 288, 5 * MIN, (i) => 50 + 20 * Math.sin((2 * Math.PI * i) / 288) + gauss(r))
    const d = detectSeasonality(s)
    expect(d.periodMs).toBe(DAY_MS)
    expect(d.confidence).toBeGreaterThan(0.8)
  })
  it('weekday/weekend pattern on hourly data → weekly', () => {
    const s = make(5 * 168, HOUR, (i) => 100 + 30 * Math.sin((2 * Math.PI * i) / 24) + (i % 168 >= 120 ? -50 : 0) + 3 * gauss(r))
    expect(detectSeasonality(s).periodMs).toBe(WEEK_MS)
  })
  it('hourly sawtooth at 1-minute steps → hourly', () => {
    const s = make(24 * 60, MIN, (i) => (i % 60) + gauss(r))
    expect(detectSeasonality(s).periodMs).toBe(HOUR_MS)
  })
  it('white noise, AR(1) with φ = 0.95 and a random walk → none', () => {
    expect(detectSeasonality(make(7 * 288, 5 * MIN, () => gauss(r))).periodMs).toBeNull()
    let a = 0
    expect(detectSeasonality(make(7 * 288, 5 * MIN, () => (a = 0.95 * a + gauss(r)))).periodMs).toBeNull()
    let w = 0
    expect(detectSeasonality(make(7 * 288, 5 * MIN, () => (w += gauss(r)))).periodMs).toBeNull()
  })
  it('30% of points missing: still daily (pairs only where both are present)', () => {
    const s = make(7 * 288, 5 * MIN, (i) => 50 + 20 * Math.sin((2 * Math.PI * i) / 288) + gauss(r))
    for (let i = 0; i < s.values.length; i++) if (r() < 0.3) s.values[i] = NaN
    expect(detectSeasonality(s).periodMs).toBe(DAY_MS)
  })
  it('one day of data: not enough history for daily or weekly', () => {
    const d = detectSeasonality(make(288, 5 * MIN, (i) => Math.sin((2 * Math.PI * i) / 288)), { candidatesMs: [DAY_MS, WEEK_MS] })
    expect(d.status).toBe('not_enough_history')
    expect(d.text).toContain('needs 2 cycles')
  })
})

describe('history and cost class (the ruler classifies with these)', () => {
  const m5 = 5 * MIN
  it('declared history maps to tail / recent / rollup', () => {
    expect(classify(threshold.history({}, m5), MIN)).toMatchObject({ tick: 'tail', coldStart: 'tail' })
    expect(classify(ewma.history({}, m5), MIN)).toMatchObject({ tick: 'tail', coldStart: 'recent' })
    expect(classify(robustZ.history({}, m5), MIN)).toMatchObject({ tick: 'tail', coldStart: 'rollup' }) // 288 × 5 min = 24 h + the interval
    expect(classify(seasonal.history({ periodMs: WEEK_MS, seasons: 4 }, HOUR), MIN)).toMatchObject({ tick: 'tail', coldStart: 'rollup' })
    expect(classify(burnRate.history({}, MIN), MIN)).toMatchObject({ tick: 'tail', coldStart: 'rollup' })
    expect(classify(cusum.history({}, MIN), MIN)).toMatchObject({ tick: 'tail', coldStart: 'recent' })
    expect(classify(stl.history({ periodMs: DAY_MS }, m5), HOUR)).toMatchObject({ tick: 'rollup' })
    expect(classify(peltDetector.history({ lookbackMs: 6 * HOUR }, m5), HOUR)).toMatchObject({ tick: 'recent' })
  })
  it('seasonal history is k seasons plus the residual window', () => {
    const h = seasonal.history({ periodMs: WEEK_MS, seasons: 4 }, HOUR)
    expect(h.lookbackMs).toBe(4 * WEEK_MS + WEEK_MS)
    expect(h.resolutionMs).toBe(HOUR)
  })
})

describe('purity: src/ has no I/O, clock, randomness or eval', () => {
  const files: string[] = []
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.ts')) files.push(p)
    }
  }
  walk(new URL('../src', import.meta.url).pathname)
  it.each(files)('%s', (f) => {
    const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    for (const bad of [/Date\.now/, /new Date\(\)/, /Math\.random/, /performance\./, /process\./, /require\(/, /from '(node:|fs|path|os|crypto)/, /\beval\(/, /new Function/, /\bfetch\(/, /crypto\./]) {
      expect(code).not.toMatch(bad)
    }
    for (const m of code.matchAll(/from '([^']+)'/g)) expect(m[1]!.startsWith('.')).toBe(true) // no dependencies
  })
})
