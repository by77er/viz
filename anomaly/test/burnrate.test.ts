/**
 * Multi-window, multi-burn-rate alerting against the Google SRE Workbook, chapter 5
 * "Alerting on SLOs" (sre.google/workbook/alerting-on-slos, read 2026-11-18). Every expected
 * number below is quoted from the chapter, with the rounding the chapter uses.
 */
import { describe, expect, it } from 'vitest'
import {
  burnRate, evaluateWindows, SRE_WORKBOOK_RULES, budgetConsumed, burnRateFor, timeToExhaustionMs, errorRatioFor,
  detectionTimeMs, ruleDetectionTimeMs, resetTimeMs, type BurnRule,
} from '../src/index.ts'

const S = 1000, MIN = 60 * S, H = 60 * MIN, D = 24 * H
const P30 = 30 * D
const SLO = 0.999

describe('error-budget arithmetic: the workbook worked numbers', () => {
  it('Table 5-4: burn rate, error rate for a 99.9% SLO, time to exhaustion', () => {
    expect(timeToExhaustionMs(1, P30)).toBe(30 * D)
    expect(timeToExhaustionMs(2, P30)).toBe(15 * D)
    expect(timeToExhaustionMs(10, P30)).toBe(3 * D)
    expect(timeToExhaustionMs(1000, P30) / MIN).toBeCloseTo(43.2, 10) // "43 minutes"
    expect(errorRatioFor(1, SLO)).toBeCloseTo(0.001, 15)
    expect(errorRatioFor(2, SLO)).toBeCloseTo(0.002, 15)
    expect(errorRatioFor(10, SLO)).toBeCloseTo(0.01, 15)
    expect(errorRatioFor(1000, SLO)).toBeCloseTo(1, 12)
  })
  it('Table 5-6: burn rates for 2% in 1 h, 5% in 6 h, 10% in 3 d', () => {
    expect(burnRateFor(0.02, H, P30)).toBeCloseTo(14.4, 12)
    expect(burnRateFor(0.05, 6 * H, P30)).toBeCloseTo(6, 12)
    expect(burnRateFor(0.1, 3 * D, P30)).toBeCloseTo(1, 12)
  })
  it('Table 5-8 (and the 24h/2h ticket row of its expressions): budget consumed when each rule fires', () => {
    const consumed = SRE_WORKBOOK_RULES.map((r) => [r.severity, r.longMs / H, r.shortMs / MIN, r.burnRate, Math.round(1000 * budgetConsumed(r.burnRate, r.longMs, P30)) / 10])
    expect(consumed).toEqual([
      ['page', 1, 5, 14.4, 2],
      ['page', 6, 30, 6, 5],
      ['ticket', 24, 120, 3, 10],
      ['ticket', 72, 360, 1, 10],
    ])
    // the workbook's guideline: short window = 1/12 of the long one
    for (const r of SRE_WORKBOOK_RULES) expect(r.longMs / r.shortMs).toBe(12)
  })
  it('approach 1 (10-minute window at the SLO): 0.6 s detection for a total outage; 0.02% of the budget; 144 alerts a day', () => {
    expect(detectionTimeMs(1, SLO, 10 * MIN, 1 - 1e-12)).toBeCloseTo(0.6 * S, 3)
    expect(100 * budgetConsumed(1, 10 * MIN, P30)).toBeCloseTo(0.0231, 4) // "only 0.02%"
    expect(D / (10 * MIN)).toBe(144)
  })
  it('approach 2 (36-hour window): 5% of the budget; "2 minutes and 10 seconds" for a complete outage', () => {
    expect(budgetConsumed(1, 36 * H, P30)).toBeCloseTo(0.05, 12)
    expect(detectionTimeMs(1, SLO, 36 * H, 1 - 1e-12) / S).toBeCloseTo(129.6, 3)
  })
  it('approach 3: a 1-hour total outage spends "140%" of the budget; one 5-minute spike "almost 12%", three "35%"', () => {
    expect(budgetConsumed(1 / (1 - SLO), H, P30)).toBeCloseTo(1.3889, 4)
    expect(budgetConsumed(1000, 5 * MIN, P30)).toBeCloseTo(0.1157, 4)
    expect(3 * budgetConsumed(1000, 5 * MIN, P30)).toBeCloseTo(0.3472, 4)
  })
  it('approach 4 (burn rate 36 over 1 h): 5% budget, "58 minutes" reset, a 35× burn never alerts but empties the budget in "20.5 hours"', () => {
    expect(burnRateFor(0.05, H, P30)).toBeCloseTo(36, 12)
    expect(resetTimeMs(H, 36, SLO) / MIN).toBeCloseTo(57.84, 10)
    expect(detectionTimeMs(errorRatioFor(35, SLO), SLO, H, 36)).toBe(Infinity)
    expect(timeToExhaustionMs(35, P30) / H).toBeCloseTo(20.571, 3)
  })
  it('low-traffic section: 10 requests/hour, one failure → 13.9% of the budget; seven failures allowed in 30 days', () => {
    const requests = 10 * 30 * 24
    expect(requests * (1 - SLO)).toBeCloseTo(7.2, 10) // "only seven failed requests"
    const burn = 0.1 / (1 - SLO)
    // The workbook calls this a "1,000x burn rate"; 10% / 0.1% is 100×, and 100× for one
    // hour is exactly the 13.9% it quotes, so the 1,000 is a slip in the text.
    expect(burn).toBeCloseTo(100, 10)
    expect(100 * budgetConsumed(burn, H, P30)).toBeCloseTo(13.89, 2)
    expect(100 / 7.2).toBeCloseTo(13.89, 2)
  })
  it('extreme goals: a 90% SLO consumes "1.4%" per hour of total outage so 14.4× can never fire; 99.999% empties in "26 seconds"; a 1% canary at 1% errors leaves "43 minutes"', () => {
    expect(100 * budgetConsumed(1 / 0.1, H, P30)).toBeCloseTo(1.389, 3)
    expect(1 / 0.1).toBeLessThan(14.4)
    expect(ruleDetectionTimeMs(1, 0.9, SRE_WORKBOOK_RULES[0]!)).toBe(Infinity)
    expect(timeToExhaustionMs(1 / 1e-5, P30) / S).toBeCloseTo(25.92, 10)
    expect(timeToExhaustionMs(0.01 / 1e-5, P30) / MIN).toBeCloseTo(43.2, 10)
  })
})

/** Constant traffic; error ratio `e` from t = 0 for `durationMs`, then 0. Returns when the alert first fired and last fired. */
export function simulate(e: number, rules: BurnRule[], bucketMs: number, durationMs: number, horizonMs: number, objective = SLO) {
  const warm = Math.max(...rules.map((r) => r.longMs))
  const n = Math.round((warm + horizonMs) / bucketMs)
  const ts = new Float64Array(n), bad = new Float64Array(n), total = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const t = i * bucketMs - warm // bucket covers (t - bucket, t]
    ts[i] = t
    total[i] = 1e6
    const inside = Math.max(0, Math.min(t, durationMs) - Math.max(t - bucketMs, 0))
    bad[i] = (1e6 * e * inside) / bucketMs
  }
  const r = burnRate.detect({ ts, values: bad, total } as never, { objective, rules, stepMs: bucketMs })
  let first: number | null = null, last: number | null = null, firstRule: string | null = null
  r.points.forEach((p) => {
    if (!p.anomalous) return
    if (first === null) { first = p.ts; firstRule = `${p.explanation!.facts.severity} ${(p.explanation!.facts.longWindowMs as number) / H}h` }
    last = p.ts
  })
  return { first, last, firstRule, points: r.points }
}

describe('burn-rate detector, simulated against the formulas', () => {
  const page1h = [SRE_WORKBOOK_RULES[0]!]
  it('Figure 5-6: 15% errors for 10 minutes, 1h/5m at 14.4×', () => {
    const bucket = 10 * S
    const sim = simulate(0.15, page1h, bucket, 10 * MIN, 2 * H)
    // fires when the long window crosses: 0.0144/0.15 × 60 min = 5.76 min ("after 5 minutes")
    expect(sim.first!).toBeGreaterThanOrEqual(5.76 * MIN)
    expect(sim.first!).toBeLessThanOrEqual(5.76 * MIN + bucket)
    // stops when the short window falls: 10 + 4.52 min ("5 minutes after the errors stop")
    expect(sim.last!).toBeGreaterThanOrEqual(14.52 * MIN - bucket)
    expect(sim.last!).toBeLessThan(14.52 * MIN + bucket)
    // without the short window the alert would have lasted until 64.24 min (the workbook's
    // "60 minutes after" is the window length; the threshold is crossed 4.24 min earlier)
    const longOnly = simulate(0.15, [{ ...page1h[0]!, shortMs: H }], bucket, 10 * MIN, 2 * H)
    expect(longOnly.last!).toBeGreaterThanOrEqual(64.24 * MIN - bucket)
    expect(longOnly.last!).toBeLessThan(64.24 * MIN + bucket)
  })
  it.each([1, 0.1, 0.02, 0.01, 0.005, 0.002])('error ratio %s: first alert at the formula time, by the formula rule', (e) => {
    const bucket = MIN
    const expected = Math.min(...SRE_WORKBOOK_RULES.map((r) => ruleDetectionTimeMs(e, SLO, r)))
    const sim = simulate(e, SRE_WORKBOOK_RULES, bucket, 4 * D, 4 * D)
    expect(sim.first!).toBeGreaterThanOrEqual(expected)
    expect(sim.first!).toBeLessThanOrEqual(expected + bucket)
    // at 0.5% (5×) the 24h/2h and 3d/6h ticket rules tie at 14.4 h; either may be reported
    const tied = SRE_WORKBOOK_RULES.filter((r) => ruleDetectionTimeMs(e, SLO, r) === expected).map((r) => `${r.severity} ${r.longMs / H}h`)
    expect(tied).toContain(sim.firstRule)
  })
  it('a 100% outage pages after 51.8 s (1h/5m at 14.4×), having spent exactly the 2% of Table 5-8', () => {
    expect(ruleDetectionTimeMs(1, SLO, SRE_WORKBOOK_RULES[0]!) / S).toBeCloseTo(51.84, 6)
    // 1-second buckets: only the 1-hour rule (a 3-day ring of 1 s buckets exceeds MAX_RING)
    const sim = simulate(1, page1h, S, 5 * MIN, 10 * MIN)
    expect(sim.first! / S).toBeGreaterThanOrEqual(51.84)
    expect(sim.first! / S).toBeLessThanOrEqual(52.84)
    expect(100 * budgetConsumed(1 / (1 - SLO), ruleDetectionTimeMs(1, SLO, SRE_WORKBOOK_RULES[0]!), P30)).toBeCloseTo(2, 10)
    // and so for any error ratio above the threshold: e · t_detect / ((1 − SLO) · period) = window · burn / period
    for (const e of [0.5, 0.1, 0.02]) expect(100 * budgetConsumed(e / (1 - SLO), ruleDetectionTimeMs(e, SLO, SRE_WORKBOOK_RULES[0]!), P30)).toBeCloseTo(2, 10)
  })
  it('a rate just under every threshold never alerts', () => {
    const sim = simulate(0.000999, SRE_WORKBOOK_RULES, 5 * MIN, 4 * D, 4 * D)
    expect(sim.first).toBeNull()
  })
  it('explanation: the real windows, burn rates and budget', () => {
    const sim = simulate(1, SRE_WORKBOOK_RULES, MIN, H, H)
    const e = sim.points.find((p) => p.anomalous)!.explanation!
    expect(e.text).toMatch(/^error budget burning at [\d.]+× over 1 hour and [\d.]+× over 5 minutes \(page threshold 14\.4×\); [\d.]+% of the 30 days budget for a 99\.9% objective was spent in the last 1 hour$/)
    expect(e.facts.longWindowMs).toBe(H)
    expect(e.facts.shortWindowMs).toBe(5 * MIN)
    expect(e.facts.budgetConsumedPercent).toBeCloseTo((100 * (e.facts.longBurn as number) * H) / P30, 10)
  })
})

describe('stateless evaluation and guards', () => {
  it('evaluateWindows: both windows must exceed; strict >', () => {
    const w = (bad: number, total: number) => ({ bad, total })
    const at = (long: number, short: number) => evaluateWindows({}, new Map([[H, w(long, 1000)], [5 * MIN, w(short, 1000)]]))[0]!
    expect(at(15, 15).firing).toBe(true) // 1.5% = 15×
    expect(at(15, 14).firing).toBe(false) // short at 14×
    expect(at(14, 15).firing).toBe(false)
    // exactly at the threshold is not "> threshold". 14.4 × 0.001 is not exact in binary, so
    // use numbers that are: objective 0.75 (budget 0.25), threshold 2×, error ratio 0.5 → 2× exactly
    const rule = { severity: 'page' as const, longMs: H, shortMs: 5 * MIN, burnRate: 2 }
    const exact = (bad: number) => evaluateWindows({ objective: 0.75, rules: [rule] }, new Map([[H, w(bad, 100)], [5 * MIN, w(bad, 100)]]))[0]!
    expect(exact(50).longBurn).toBe(2)
    expect(exact(50).firing).toBe(false)
    expect(exact(51).firing).toBe(true)
  })
  it('minEvents: a handful of errors on low traffic does not page', () => {
    const m = new Map([[H, { bad: 1, total: 10 }], [5 * MIN, { bad: 1, total: 2 }]])
    expect(evaluateWindows({}, m)[0]!.firing).toBe(true)
    expect(evaluateWindows({ minEvents: 100 }, m)[0]!.firing).toBe(false)
  })
  it('missing buckets are left out of both sums and reported through coverage', () => {
    const rules = [{ severity: 'page' as const, longMs: 10 * MIN, shortMs: 2 * MIN, burnRate: 2 }]
    const n = 30
    const ts = Float64Array.from({ length: n }, (_, i) => i * MIN)
    const total = new Float64Array(n).fill(100)
    const bad = new Float64Array(n).fill(0)
    for (let i = 20; i < n; i++) bad[i] = 1 // 1% errors from minute 20; budget 0.1% → 10×
    for (let i = 21; i < 28; i++) { bad[i] = NaN; total[i] = NaN }
    const r = burnRate.detect({ ts, values: bad, total } as never, { rules, stepMs: MIN, objective: 0.999 })
    // at minute 28: present buckets in the long window are 19, 20, 28 → (0 + 1 + 1) / 300
    expect(r.points[28]!.explanation!.facts.longBurn).toBeCloseTo(((0 + 1 + 1) / 300) / 0.001, 10)
    const strict = burnRate.detect({ ts, values: bad, total } as never, { rules, stepMs: MIN, objective: 0.999, minCoverage: 0.5 })
    expect(strict.points[28]!.anomalous).toBe(false)
  })
})
