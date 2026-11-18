import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { PromMatrixData } from '../api/types'
import { alignMatrix, parseSampleValue, seriesKey, seriesName, type AlignedData } from './series'

/** The implementation before the one-pass rewrite (design review B3), kept as the reference. */
function reference(data: PromMatrixData, start: number, end: number, step: number): AlignedData {
  const n = Math.floor((end - start) / step + 1e-9) + 1
  let onGrid = n > 0 && n <= 1_000_000
  if (onGrid) {
    outer: for (const s of data.result) {
      for (const [t] of s.values) {
        const i = (t - start) / step
        if (i < -1e-6 || i > n - 1 + 1e-6 || Math.abs(i - Math.round(i)) > 1e-6) {
          onGrid = false
          break outer
        }
      }
    }
  }
  let xs: number[]
  let indexOf: (t: number) => number
  if (onGrid) {
    xs = Array.from({ length: n }, (_, i) => start + i * step)
    indexOf = (t) => Math.round((t - start) / step)
  } else {
    const set = new Set<number>()
    for (const s of data.result) for (const [t] of s.values) set.add(t)
    xs = [...set].sort((a, b) => a - b)
    const map = new Map(xs.map((t, i) => [t, i]))
    indexOf = (t) => map.get(t) ?? -1
  }
  const series = data.result.map((s) => {
    const values: (number | null)[] = new Array(xs.length).fill(null)
    for (const [t, v] of s.values) {
      const num = parseSampleValue(v)
      const i = indexOf(t)
      if (i >= 0) values[i] = Number.isFinite(num) ? num : null
    }
    return { key: seriesKey(s.metric), labels: s.metric, name: seriesName(s.metric), values }
  })
  series.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { xs, series }
}

describe('alignMatrix in one pass (B3)', () => {
  const value = fc.oneof(
    fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e12, max: 1e12 }).map(String),
    fc.constantFrom('NaN', '+Inf', '-Inf', 'Inf', '0', '-0', '1e-9', '', '1.5e300'),
  )
  const start = 1000
  const step = 15
  // Offsets in steps; a fraction now and then puts a sample off the grid.
  const offset = fc.oneof(fc.integer({ min: -2, max: 30 }), fc.integer({ min: 0, max: 30 }).map((i) => i + 0.4))
  const matrix = fc.array(
    fc.record({
      metric: fc.dictionary(fc.constantFrom('__name__', 'a', 'b'), fc.constantFrom('x', 'y', 'z', 'q"r')),
      values: fc.uniqueArray(fc.tuple(offset, value), { selector: ([o]) => o, maxLength: 25 }),
    }),
    { maxLength: 6 },
  )

  it('property: gives exactly what the previous implementation gave, on and off the grid', () => {
    fc.assert(
      fc.property(matrix, fc.integer({ min: 0, max: 28 }), (rows, steps) => {
        const data: PromMatrixData = {
          resultType: 'matrix',
          result: rows.map((r) => ({ metric: r.metric, values: [...r.values].sort((a, b) => a[0] - b[0]).map(([o, v]) => [start + o * step, v] as [number, string]) })),
        }
        const end = start + steps * step
        expect(alignMatrix(data, start, end, step)).toEqual(reference(data, start, end, step))
      }),
      { numRuns: 500 },
    )
  })
  it('turns every value that cannot be drawn into a gap', () => {
    const a = alignMatrix({ resultType: 'matrix', result: [{ metric: {}, values: [[0, 'NaN'], [15, '+Inf'], [30, '-Inf'], [45, '2.5'], [60, 'Inf']] }] }, 0, 60, 15)
    expect(a.series[0]!.values).toEqual([null, null, null, 2.5, null])
  })
})
