/**
 * Property tests (fast-check):
 *  - incremental and batch agree, with state round-tripped through JSON between calls;
 *  - a constant time shift changes nothing but the timestamps;
 *  - scaling values by a power of two scales expected/bands and leaves scores and flags alone
 *    (powers of two are exact in floating point, so equality is exact);
 *  - a NaN point is the same as no point;
 *  - nothing throws, scores are finite and ≥ 0, and state survives JSON unchanged.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { threshold, ewma, robustZ, seasonal, cusum, burnRate, stl, peltDetector, detectGroup } from '../src/index.ts'
import type { DetectResult, Point, Series } from '../src/index.ts'
import { chunked, MIN, numeric, T0 } from './helpers.ts'

type Run = (s: Series, st: unknown) => DetectResult<unknown>

const STEP = MIN
const burnRules = [
  { severity: 'page' as const, longMs: 10 * MIN, shortMs: 2 * MIN, burnRate: 2 },
  { severity: 'ticket' as const, longMs: 30 * MIN, shortMs: 5 * MIN, burnRate: 1 },
]
/** Burn-rate input: values = bad events, total = 10 × |value| + 50 per bucket (bad ≤ total). */
const withTotal = (s: Series): Series => ({ ...s, total: Float64Array.from(s.values, (v) => (Number.isFinite(v) ? 10 * Math.abs(v) + 50 : v)) } as Series)
const burnInput = (s: Series): Series => {
  const b = withTotal(s) as Series & { total: Float64Array }
  return { ts: b.ts, values: Float64Array.from(s.values, (v) => (Number.isFinite(v) ? Math.abs(v) : v)), total: b.total } as Series
}

const INCREMENTAL: Record<string, Run> = {
  threshold: (s, st) => threshold.detect(s, { above: 50, below: -50, recoverAbove: 30, recoverBelow: -30, stepMs: STEP, staleAfterMs: 5 * MIN }, st as never),
  ewma: (s, st) => ewma.detect(s, { stepMs: STEP, halfLifePoints: 8, minPoints: 5, k: 2, staleAfterMs: 10 * MIN }, st as never),
  robust_z: (s, st) => robustZ.detect(s, { stepMs: STEP, windowPoints: 20, minPoints: 5, k: 2 }, st as never),
  seasonal: (s, st) => seasonal.detect(s, { stepMs: STEP, periodMs: 10 * MIN, seasons: 3, minSeasons: 1, minResiduals: 3, k: 2, residualWindowMs: 15 * MIN }, st as never),
  seasonal_agile: (s, st) => seasonal.detect(s, { stepMs: STEP, periodMs: 10 * MIN, seasons: 2, minSeasons: 1, minResiduals: 3, k: 2, adapt: 'agile', agileWindowMs: 3 * MIN, decay: 0.5 }, st as never),
  cusum: (s, st) => cusum.detect(s, { stepMs: STEP, warmupPoints: 8, relearnPoints: 4, h: 3, staleAfterMs: 10 * MIN }, st as never),
  burn_rate: (s, st) => burnRate.detect(burnInput(s) as never, { stepMs: STEP, rules: burnRules, objective: 0.9 }, st as never),
}

const ALL: Record<string, (s: Series) => DetectResult<unknown>> = {
  ...Object.fromEntries(Object.entries(INCREMENTAL).map(([k, f]) => [k, (s: Series) => f(s, null)])),
  stl: (s) => stl.detect(s, { stepMs: STEP, periodMs: 6 * MIN, k: 2 }),
  pelt: (s) => peltDetector.detect(s, { minSegment: 3 }),
}

/** Regular 1-minute series with optional gaps and NaNs. */
const seriesArb = (minLength = 0, maxLength = 160) =>
  fc
    .array(
      fc.record({
        // no tiny magnitudes: their squares (variances) underflow, and scaling subnormals by 2^-10
        // flushes them to 0 — floating point, not the detector
        v: fc.oneof({ weight: 8, arbitrary: fc.double({ min: -100, max: 100, noNaN: true }).map((x) => (Math.abs(x) < 1e-100 ? 0 : x)) }, { weight: 1, arbitrary: fc.constant(NaN) }, { weight: 1, arbitrary: fc.integer({ min: -3, max: 3 }) }),
        gap: fc.oneof({ weight: 12, arbitrary: fc.constant(1) }, { weight: 1, arbitrary: fc.integer({ min: 2, max: 40 }) }),
        // timestamps jitter around the grid (scrapes are never exactly on time); < half a step
        jitter: fc.oneof({ weight: 3, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.integer({ min: -25_000, max: 25_000 }) }),
      }),
      { minLength, maxLength },
    )
    .map((rows) => {
      const ts = new Float64Array(rows.length)
      const values = new Float64Array(rows.length)
      let t = T0
      rows.forEach((r, i) => {
        t += r.gap * STEP
        ts[i] = t + r.jitter
        values[i] = r.v
      })
      return { ts, values } as Series
    })

const cutsArb = fc.array(fc.integer({ min: 1, max: 159 }), { maxLength: 6 })

const strip = (p: Point) => {
  const n = numeric(p) as Record<string, unknown>
  if (p.explanation) {
    const { text: _t, at: _a, ...rest } = p.explanation
    n.explanation = rest
  }
  return n
}

describe('incremental and batch agree (state through JSON)', () => {
  for (const [name, run] of Object.entries(INCREMENTAL)) {
    it(name, () => {
      fc.assert(
        fc.property(seriesArb(), cutsArb, (s, cuts) => {
          const whole = run(s, null).points
          const parts = chunked(run as never, s, cuts)
          expect(parts.map(numeric)).toEqual(whole.map(numeric))
          expect(parts.map((p) => p.explanation?.text)).toEqual(whole.map((p) => p.explanation?.text))
        }),
        { numRuns: 150 },
      )
    })
  }
  it('stl: scoring against a stored model is the same in chunks', () => {
    fc.assert(
      fc.property(seriesArb(30, 120), seriesArb(1, 80), cutsArb, (hist, next, cuts) => {
        const fit = stl.detect(hist, { stepMs: STEP, periodMs: 6 * MIN })
        if (!fit.state) return
        const off = hist.ts[hist.ts.length - 1]! - T0
        const later: Series = { ts: next.ts.map((t) => t + off), values: next.values }
        const whole = stl.detect(later, { stepMs: STEP, periodMs: 6 * MIN }, fit.state).points
        const parts = chunked((x, _st) => stl.detect(x, { stepMs: STEP, periodMs: 6 * MIN }, fit.state), later, cuts)
        expect(parts.map(numeric)).toEqual(whole.map(numeric))
      }),
      { numRuns: 60 },
    )
  })
})

describe('invariant to a constant time shift', () => {
  for (const [name, run] of Object.entries(ALL)) {
    it(name, () => {
      fc.assert(
        fc.property(seriesArb(), fc.integer({ min: -1e12, max: 1e12 }), (s, c) => {
          const a = run(s).points.map(strip)
          const shifted = run({ ts: s.ts.map((t) => t + c), values: s.values }).points.map(strip)
          expect(shifted).toEqual(a.map((p) => ({ ...p, ts: (p.ts as number) + c })))
        }),
        { numRuns: 80 },
      )
    })
  }
})

describe('scale-invariant where claimed (values × 2^k)', () => {
  const claimed = ['ewma', 'robust_z', 'seasonal', 'seasonal_agile', 'cusum', 'stl', 'pelt']
  for (const name of claimed) {
    it(name, () => {
      fc.assert(
        fc.property(seriesArb(), fc.constantFrom(2 ** -10, 2, 2 ** 10), (s, c) => {
          const run = ALL[name]!
          const a = run(s).points
          const b = run({ ts: s.ts, values: s.values.map((v) => v * c) }).points
          expect(b.map((p) => [p.score, p.anomalous, p.status])).toEqual(a.map((p) => [p.score, p.anomalous, p.status]))
          expect(b.map((p) => p.expected)).toEqual(a.map((p) => (p.expected === null ? null : p.expected * c)))
        }),
        { numRuns: 60 },
      )
    })
  }
  it('burn rate, with bad and total events scaled together', () => {
    fc.assert(
      fc.property(seriesArb(), fc.constantFrom(2 ** -10, 2, 2 ** 10), (s, c) => {
        const b = burnInput(s) as Series & { total: Float64Array }
        const scaled = { ts: b.ts, values: b.values.map((v) => v * c), total: b.total.map((v) => v * c) }
        const run = (x: Series) => burnRate.detect(x as never, { stepMs: STEP, rules: burnRules, objective: 0.9 }).points
        expect(run(scaled as Series).map((p) => [p.score, p.anomalous])).toEqual(run(b).map((p) => [p.score, p.anomalous]))
      }),
      { numRuns: 60 },
    )
  })
  it('threshold, with the thresholds scaled too', () => {
    fc.assert(
      fc.property(seriesArb(), fc.constantFrom(2 ** -10, 2, 2 ** 10), (s, c) => {
        const p = { above: 50, below: -50, recoverAbove: 30, recoverBelow: -30, stepMs: STEP }
        const a = threshold.detect(s, p).points
        const b = threshold.detect({ ts: s.ts, values: s.values.map((v) => v * c) }, { above: 50 * c, below: -50 * c, recoverAbove: 30 * c, recoverBelow: -30 * c, stepMs: STEP }).points
        expect(b.map((q) => [q.score, q.anomalous])).toEqual(a.map((q) => [q.score, q.anomalous]))
      }),
      { numRuns: 60 },
    )
  })
  it('cross-series', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: -1e3, max: 1e3, noNaN: true }).map((x) => (Math.abs(x) < 1e-200 ? 0 : x)), { minLength: 5, maxLength: 60 }), fc.constantFrom(2 ** -10, 2, 2 ** 10), (vals, c) => {
        const a = detectGroup(vals.map((v, i) => ({ id: `m${i}`, value: v })))
        const b = detectGroup(vals.map((v, i) => ({ id: `m${i}`, value: v * c })))
        expect(b.members.map((m) => [m.score, m.anomalous])).toEqual(a.members.map((m) => [m.score, m.anomalous]))
      }),
      { numRuns: 100 },
    )
  })
})

describe('a NaN point is the same as no point', () => {
  // burn rate excluded: there a NaN bucket and an absent bucket are both "missing", but an
  // absent bucket also has no output point; covered by the per-point comparison below anyway.
  for (const [name, run] of Object.entries(ALL)) {
    it(name, () => {
      fc.assert(
        fc.property(seriesArb(5), fc.array(fc.nat(), { maxLength: 20 }), (s, picks) => {
          const holes = new Set(picks.map((k) => k % s.ts.length))
          const withNaN: Series = { ts: s.ts, values: s.values.map((v, i) => (holes.has(i) ? NaN : v)) }
          const keep = [...s.ts.keys()].filter((i) => !holes.has(i))
          const without: Series = { ts: Float64Array.from(keep, (i) => s.ts[i]!), values: Float64Array.from(keep, (i) => s.values[i]!) }
          const a = run(withNaN).points
          const b = run(without).points
          expect(keep.map((i) => strip(a[i]!))).toEqual(b.map(strip))
          for (const i of holes) expect(a[i]!.status).toBe('missing')
        }),
        { numRuns: 80 },
      )
    })
  }
})

describe('never throws on any input', () => {
  const anyDouble = fc.oneof(fc.double(), fc.constantFrom(NaN, Infinity, -Infinity, -0, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE))
  const wild = fc.record({
    ts: fc.array(fc.oneof(fc.double(), fc.integer({ min: T0, max: T0 + 1e7 })), { maxLength: 80 }),
    values: fc.array(anyDouble, { maxLength: 80 }),
  }).map((r) => ({ ts: Float64Array.from(r.ts), values: Float64Array.from(r.values) }) as Series)
  const runs: Record<string, (s: Series) => DetectResult<unknown>> = {
    ...ALL,
    threshold_defaults: (s) => threshold.detect(s),
    ewma_defaults: (s) => ewma.detect(s),
    robust_z_defaults: (s) => robustZ.detect(s),
    seasonal_defaults: (s) => seasonal.detect(s, { periodMs: 86_400_000 }),
    cusum_defaults: (s) => cusum.detect(s),
    burn_defaults: (s) => burnRate.detect(withTotal(s) as never),
    stl_defaults: (s) => stl.detect(s, { periodMs: 3_600_000 }),
    pelt_defaults: (s) => peltDetector.detect(s),
  }
  for (const [name, run] of Object.entries(runs)) {
    it(name, () => {
      fc.assert(
        fc.property(wild, (s) => {
          const r = run(s)
          expect(r.points.length).toBe(Math.min(s.ts.length, s.values.length))
          for (const p of r.points) {
            expect(Number.isFinite(p.score) && p.score >= 0).toBe(true)
            expect(typeof p.anomalous).toBe('boolean')
            if (p.anomalous) expect(typeof p.explanation?.text).toBe('string')
          }
          expect(JSON.parse(JSON.stringify(r.state))).toEqual(r.state)
          expect(r.summary.stateBytes).toBe(r.state === null ? 0 : new TextEncoder().encode(JSON.stringify(r.state)).length)
        }),
        { numRuns: 150 },
      )
    })
  }
  it('cross-series', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ id: fc.string(), value: anyDouble }), { maxLength: 60 }), (members) => {
        const r = detectGroup(members)
        for (const m of r.members) expect(Number.isFinite(m.score) && m.score >= 0).toBe(true)
      }),
    )
  })
  it('garbage state is ignored, not trusted', () => {
    const s = { ts: Float64Array.from([T0, T0 + STEP]), values: Float64Array.from([1, 2]) }
    for (const bad of [{}, { v: 2 }, null, undefined]) {
      expect(() => ewma.detect(s, {}, bad as never)).not.toThrow()
      expect(() => robustZ.detect(s, {}, bad as never)).not.toThrow()
      expect(() => seasonal.detect(s, { periodMs: 10 * MIN }, bad as never)).not.toThrow()
      expect(() => cusum.detect(s, {}, bad as never)).not.toThrow()
      expect(() => threshold.detect(s, { above: 1 }, bad as never)).not.toThrow()
      expect(() => stl.detect(s, { periodMs: 10 * MIN }, bad as never)).not.toThrow()
    }
  })
})
