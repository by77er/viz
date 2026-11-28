// The chart's typed form (design/DECISIONS.md D76): `toSpec(…, typed: true)` gives the same spec as
// the first form, with NaN where that has null, and copies nothing when the unit is not scaled.
import { describe, expect, it } from 'vitest'
import { alignSeries } from '../lib/series'
import { toSpec } from './spec'

const lcg = (seed: number) => {
  let s = seed >>> 0
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
}

describe('toSpec, typed', () => {
  it('is the first form with NaN for null, for every unit', () => {
    const r = lcg(1128)
    for (let c = 0; c < 300; c++) {
      const step = [15, 60, 0.5][Math.floor(r() * 3)]!
      const n = 1 + Math.floor(r() * 50)
      const start = 1795000000
      const end = start + (n - 1) * step
      const series = Array.from({ length: 1 + Math.floor(r() * 10) }, (_, i) => {
        const times: number[] = []
        const values: number[] = []
        for (let k = 0; k < n; k++) {
          if (r() < 0.15) continue
          times.push(start + k * step)
          values.push(r() < 0.05 ? NaN : r() < 0.03 ? -Infinity : r() < 0.02 ? -0 : (r() - 0.3) * 1e6)
        }
        const metric: Record<string, string> = r() < 0.1 ? {} : { __name__: 'm', pod: 'p' + i }
        return { metric, times: Float64Array.from(times), values: Float64Array.from(values) }
      })
      const unit = (['none', 'seconds', 'percentunit', 'bytes', 'bytes/s', 'rps'] as const)[Math.floor(r() * 6)]!
      const data = alignSeries(series, start, end, step)
      const first = toSpec({ data, start, step, unit, query: 'q', shiftMs: 3600000 })
      const typed = toSpec({ data, start, step, unit, query: 'q', shiftMs: 3600000, typed: true })
      expect(typed.unit).toEqual(first.unit)
      expect({ ...typed.spec, series: [] }).toEqual({ ...first.spec, series: [] })
      expect(typed.spec.series.length).toBe(first.spec.series.length)
      typed.spec.series.forEach((s, i) => {
        const f = first.spec.series[i]!
        expect(s.labels).toEqual(f.labels)
        expect(s.values).toBeInstanceOf(Float64Array)
        expect(s.values.length).toBe(f.values.length)
        for (let k = 0; k < s.values.length; k++) {
          const want = f.values[k]
          if (want === null) expect(s.values[k]).toBeNaN()
          else expect(Object.is(s.values[k], want)).toBe(true)
        }
        // not scaled: the result's own array, not a copy
        if (typed.unit.scale === 1) expect(s.values).toBe(data.series[i]!.values)
      })
    }
  })
})
