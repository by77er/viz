/**
 * Counterexamples found by the property tests (locally and in CI), kept as deterministic tests.
 * Every detector's state must hold only finite, JSON-safe numbers (no NaN, ±Infinity or −0),
 * so that a Durable Object row restores it exactly.
 */
import { describe, expect, it } from 'vitest'
import { threshold, ewma, robustZ, seasonal, burnRate, stl, cusum, peltDetector, detectSeasonality, fitStl } from '../src/index.ts'
import type { DetectResult, Series } from '../src/index.ts'

/** Every number in the value is finite and not −0; returns the offending path or null. */
function badNumber(v: unknown, path = 'state'): string | null {
  if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0) ? null : `${path} = ${String(v)}${Object.is(v, -0) ? ' (-0)' : ''}`
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const b = badNumber(v[i], `${path}[${i}]`); if (b) return b } return null }
  if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) { const b = badNumber(x, `${path}.${k}`); if (b) return b } return null }
  return null
}

const withTotal = (s: Series): Series => ({ ...s, total: Float64Array.from(s.values, (v) => (Number.isFinite(v) ? 10 * Math.abs(v) + 50 : 50)) } as Series)

const RUNS: Record<string, (s: Series, st?: unknown) => DetectResult<unknown>> = {
  threshold: (s, st) => threshold.detect(s, { above: 1 }, st as never),
  ewma: (s, st) => ewma.detect(s, {}, st as never),
  robust_z: (s, st) => robustZ.detect(s, {}, st as never),
  robust_z_quantile: (s, st) => robustZ.detect(s, { spread: 'quantile' }, st as never),
  seasonal: (s, st) => seasonal.detect(s, { periodMs: 600_000, stepMs: 60_000, minSeasons: 1, minResiduals: 2 }, st as never),
  seasonal_defaults: (s, st) => seasonal.detect(s, { periodMs: 86_400_000 }, st as never),
  burn_rate: (s, st) => burnRate.detect(withTotal(s) as never, {}, st as never),
  burn_rate_small: (s, st) => burnRate.detect(withTotal(s) as never, { stepMs: 60_000, rules: [{ severity: 'page', longMs: 600_000, shortMs: 120_000, burnRate: 2 }], objective: 0.9 }, st as never),
  stl: (s, st) => stl.detect(s, { periodMs: 3_600_000 }, st as never),
  cusum: (s, st) => cusum.detect(s, { warmupPoints: 3, relearnPoints: 1 }, st as never),
  pelt: (s) => peltDetector.detect(s),
}

const CASES: [string, number[], number[]][] = [
  // CI, ewma_defaults, fast-check seed -1295174040: the step between these overflowed to Infinity
  ['ci-ewma-step-overflow', [-1.0977121702440959e293, 0, 1.7976931348623147e308], [NaN, NaN, NaN]],
  // local, burn_defaults: (2.1e293 + 1.8e308) / 2 overflowed in the median of the gaps
  ['local-burn-median-overflow', [-2.0956323250114558e293, 1767571200000, 1.7976931348623137e308], [0, 0, 0]],
  // local, burn_rate: ts − origin overflowed to an infinite slot
  ['local-burn-infinite-slot', [-1.4968802321510399e293, 1.7976931348623143e308], [0, 0]],
  // local, seasonal: Math.round of a tiny negative gave a −0 slot
  ['local-seasonal-negative-zero-slot', [0, -5e-324], [NaN, 5e-324]],
  // local, ewma_defaults: squares of 1e154 overflowed the variance
  ['local-ewma-variance-overflow', [0, 5e-324], [8.871751543763582e154, -1.2115863718939114e148]],
  // local, -0 timestamps and values
  ['local-negative-zero', [-0, 60_000, 120_000], [-0, -0, NaN]],
  // timestamps at and beyond the Date range
  ['date-range-edges', [-8.64e15, 0, 8.64e15, 8.64e15 + 1, Infinity], [1, 2, 3, 4, 5]],
]

describe('regressions: state stays finite and JSON-safe', () => {
  for (const [name, ts, values] of CASES) {
    for (const [det, run] of Object.entries(RUNS)) {
      it(`${name} × ${det}`, () => {
        const s: Series = { ts: Float64Array.from(ts), values: Float64Array.from(values) }
        const r = run(s)
        expect(badNumber(r.state)).toBeNull()
        expect(JSON.parse(JSON.stringify(r.state))).toEqual(r.state)
        for (const p of r.points) expect(Number.isFinite(p.score) && p.score >= 0).toBe(true)
        // and it restores: the next call gives the same from the restored state as from the original
        const next: Series = { ts: Float64Array.from([1767571260000, 1767571320000]), values: Float64Array.from([1, 2]) }
        const a = run(next, r.state)
        const b = run(next, JSON.parse(JSON.stringify(r.state)))
        expect(b.points).toEqual(a.points)
        expect(b.state).toEqual(a.state)
        expect(badNumber(a.state)).toBeNull()
      })
    }
  }
  it('the CI counterexample: EWMA refuses the out-of-range timestamps and stores no step', () => {
    const r = ewma.detect({ ts: Float64Array.from([-1.0977121702440959e293, 0, 1.7976931348623147e308]), values: Float64Array.from([NaN, NaN, NaN]) })
    expect(r.state!.stepMs).toBe(0)
    expect(r.points.map((p) => p.status)).toEqual(['missing', 'missing', 'missing'])
  })
  it('timestamps beyond ±8.64e15 ms are missing points, and do not enter step inference', () => {
    const r = ewma.detect({ ts: Float64Array.from([0, 60_000, 9e15, 1e300]), values: Float64Array.from([1, 2, 3, 4]) })
    expect(r.points.map((p) => p.status)).toEqual(['warming', 'warming', 'missing', 'missing'])
    expect(r.state!.stepMs).toBe(60_000)
    expect(detectSeasonality({ ts: Float64Array.from([0, 1e300]), values: Float64Array.from([1, 2]) }).stepMs).toBe(0)
    expect(fitStl({ ts: Float64Array.from([0, 1e300]), values: Float64Array.from([1, 2]) }, { periodMs: 3_600_000 })).toBeNull()
  })
  it('a stored or passed step beyond the Date range is ignored', () => {
    const r = ewma.detect({ ts: Float64Array.from([0, 60_000]), values: Float64Array.from([1, 2]) }, { stepMs: 1e300 })
    expect(r.state!.stepMs).toBe(60_000)
  })
})
