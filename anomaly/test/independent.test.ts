/**
 * Independent implementations: STL against statsmodels (a separate port of stl.f), PELT against
 * the `ruptures` package and against brute-force optimal partitioning.
 * Fixtures: scripts/make-fixtures.py.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { stlDecompose, pelt } from '../src/index.ts'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

describe('STL equals statsmodels', () => {
  const f = fixture('stl')
  type Case = { name: string; period: number; options: Record<string, number | boolean | undefined>; y: number[]; seasonal: number[]; trend: number[]; resid: number[]; weights: number[] }
  it.each((f.cases as Case[]).map((c) => [c.name, c] as [string, Case]))('%s', (_name, c) => {
    const o = c.options as Record<string, number | undefined> & { robust: boolean }
    const d = stlDecompose(Float64Array.from(c.y), c.period, {
      robust: o.robust, seasonal: o.seasonal ?? 7, seasonalDeg: o.seasonal_deg ?? 1,
      seasonalJump: o.seasonal_jump ?? 1, trendJump: o.trend_jump ?? 1, lowPassJump: o.low_pass_jump ?? 1,
    })
    let worst = 0
    for (let i = 0; i < c.y.length; i++) {
      worst = Math.max(worst, Math.abs(d.seasonal[i]! - c.seasonal[i]!), Math.abs(d.trend[i]! - c.trend[i]!), Math.abs(d.resid[i]! - c.resid[i]!), Math.abs(d.weights[i]! - c.weights[i]!))
    }
    expect(worst).toBeLessThan(1e-9)
  })
})

describe('PELT', () => {
  const f = fixture('pelt')
  type PCase = { name: string; x: number[]; sigma: number; minSegment: number; penalty: number; breakpoints: number[] }
  it.each((f.cases as PCase[]).map((c) => [c.name, c] as [string, PCase]))('equals ruptures Pelt(l2): %s', (_name, c) => {
    const s = pelt(c.x, { penalty: c.penalty, minSegment: c.minSegment, sigma: c.sigma })
    expect(s.changepoints).toEqual(c.breakpoints.slice(0, -1))
  })

  /** Optimal partitioning without pruning: O(n²), the same objective. */
  function brute(x: number[], beta: number, minSeg: number, sigma: number) {
    const n = x.length
    const cost = (a: number, b: number) => {
      let m = 0
      for (let i = a; i < b; i++) m += x[i]!
      m /= b - a
      let s = 0
      for (let i = a; i < b; i++) s += (x[i]! - m) ** 2
      return s / (sigma * sigma)
    }
    const F = new Array(n + 1).fill(Infinity)
    const last = new Array(n + 1).fill(-1)
    F[0] = -beta
    for (let t = minSeg; t <= n; t++) {
      for (let tau = 0; tau <= t - minSeg; tau++) {
        if (tau !== 0 && tau < minSeg) continue
        const v = F[tau] + cost(tau, t) + beta
        if (v < F[t]) { F[t] = v; last[t] = tau }
      }
    }
    const cps: number[] = []
    for (let t = n; t > 0 && last[t] > 0; t = last[t]) cps.push(last[t])
    const objective = (cp: number[]) => { const b = [0, ...cp, n]; let s = 0; for (let i = 0; i + 1 < b.length; i++) s += cost(b[i]!, b[i + 1]!); return s + beta * cp.length }
    return { cps: cps.reverse(), cost: F[n], objective }
  }

  it('finds an optimal segmentation (same objective as brute-force optimal partitioning)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -20, max: 20 }), { minLength: 0, maxLength: 70 }),
        fc.integer({ min: 1, max: 6 }),
        fc.double({ min: 0.5, max: 30, noNaN: true }),
        (xs, minSeg, beta) => {
          const x = xs.map((v, i) => v + (i % 7) * 0.01)
          const s = pelt(x, { penalty: beta, minSegment: minSeg, sigma: 1 })
          if (x.length < 2 * minSeg) { expect(s.changepoints).toEqual([]); return }
          const b = brute(x, beta, minSeg, 1)
          const tol = 1e-6 * Math.max(1, Math.abs(b.cost)) // prefix sums versus direct sums differ in rounding
          expect(Math.abs(s.cost - b.cost)).toBeLessThanOrEqual(tol)
          // PELT's own changepoints achieve that optimum (ties may break differently)
          expect(Math.abs(b.objective(s.changepoints) - b.cost)).toBeLessThanOrEqual(tol)
          const sizes = [0, ...s.changepoints, x.length].slice(1).map((e, i, a) => e - (i ? a[i - 1]! : 0))
          expect(Math.min(...sizes)).toBeGreaterThanOrEqual(minSeg)
        },
      ),
      { numRuns: 1000 },
    )
  })

  it('the penalty matters: none on pure noise, many without it', () => {
    let seed = 7
    const r = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const x = Array.from({ length: 400 }, () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()))
    expect(pelt(x).changepoints).toEqual([]) // β = 2 ln 400 ≈ 12
    expect(pelt(x, { penalty: 1e-9 }).changepoints.length).toBeGreaterThan(20)
  })
})
