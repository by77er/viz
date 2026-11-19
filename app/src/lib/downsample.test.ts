import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { columnOf, downsampleMinMax } from './downsample'

/** Reference: per pixel column, the set of non-null input values of one series. */
function buckets(xs: number[], values: (number | null)[], columns: number): Map<number, number[]> {
  const out = new Map<number, number[]>()
  const xMin = xs[0]!
  const xMax = xs[xs.length - 1]!
  xs.forEach((x, i) => {
    const v = values[i]
    if (v == null) return
    const c = columnOf(x, xMin, xMax, columns)
    if (!out.has(c)) out.set(c, [])
    out.get(c)!.push(v)
  })
  return out
}

const dataset = fc
  .record({
    n: fc.integer({ min: 1, max: 600 }),
    columns: fc.integer({ min: 1, max: 80 }),
    seriesCount: fc.integer({ min: 1, max: 4 }),
    irregular: fc.boolean(),
  })
  .chain(({ n, columns, seriesCount, irregular }) =>
    fc.record({
      columns: fc.constant(columns),
      // Strictly ascending timestamps, regular or with random spacing.
      xs: irregular
        ? fc.array(fc.integer({ min: 1, max: 50 }), { minLength: n, maxLength: n }).map((gaps) => {
            let t = 1_700_000_000
            return gaps.map((g) => (t += g))
          })
        : fc.constant(Array.from({ length: n }, (_, i) => 1_700_000_000 + i * 15)),
      series: fc.array(
        fc.array(fc.option(fc.double({ min: -1e9, max: 1e9, noNaN: true }), { nil: null, freq: 5 }), { minLength: n, maxLength: n }),
        { minLength: seriesCount, maxLength: seriesCount },
      ),
    }),
  )

describe('downsampleMinMax', () => {
  it('returns the input unchanged when it already fits', () => {
    const xs = [1, 2, 3, 4]
    const r = downsampleMinMax(xs, [[1, null, 3, 4]], 2)
    expect(r.downsampled).toBe(false)
    expect(r.xs).toEqual(xs)
    expect(r.series).toEqual([[1, null, 3, 4]])
  })

  it('keeps a one-sample spike that plain decimation would drop', () => {
    const n = 10_000
    const xs = Array.from({ length: n }, (_, i) => i)
    const values = xs.map(() => 1)
    values[4321] = 1000
    values[8765] = -500
    const r = downsampleMinMax(xs, [values], 100)
    expect(r.downsampled).toBe(true)
    expect(r.xs.length).toBeLessThanOrEqual(200)
    expect(Math.max(...(r.series[0] as number[]))).toBe(1000)
    expect(Math.min(...(r.series[0] as number[]))).toBe(-500)
    // Every 100th point (decimation) would have missed both.
    expect(xs.filter((_, i) => i % 100 === 0).map((i) => values[i])).not.toContain(1000)
  })

  it('orders min and max within a column as they occurred', () => {
    const xs = Array.from({ length: 8 }, (_, i) => i)
    // one column: rising then a column: falling
    const r = downsampleMinMax(xs, [[1, 2, 3, 9, 9, 3, 2, 1]], 2)
    expect(r.series[0]).toEqual([1, 9, 9, 1])
    expect(r.xs).toEqual([0, 3, 4, 7])
  })

  it('hands gaps given as NaN (Float64Array series) to the renderer as null, which it never bridges', () => {
    const xs = [0, 1, 2, 3, 4, 5]
    const values = Float64Array.from([1, NaN, 3, NaN, NaN, 6])
    // Fits: no downsampling, every NaN becomes null.
    expect(downsampleMinMax(xs, [values], 10).series[0]).toEqual([1, null, 3, null, null, 6])
    // Downsampled: a column of NaN only is a gap (null), and NaN never wins min or max.
    const big = Float64Array.from({ length: 400 }, (_, i) => (i >= 100 && i < 200 ? NaN : i % 7))
    const out = downsampleMinMax(Array.from({ length: 400 }, (_, i) => i), [big], 50)
    expect(out.downsampled).toBe(true)
    expect(out.series[0]!.some((v) => v !== null && Number.isNaN(v))).toBe(false)
    expect(out.series[0]!.filter((v) => v === null).length).toBeGreaterThan(0)
  })
  it('keeps gaps wider than a column as nulls', () => {
    const n = 1000
    const xs = Array.from({ length: n }, (_, i) => i)
    const values: (number | null)[] = xs.map((x) => (x >= 300 && x < 700 ? null : x))
    const r = downsampleMinMax(xs, [values], 10)
    const out = r.series[0]!
    expect(out.some((v) => v === null)).toBe(true)
    // Columns 3..6 are entirely inside the gap.
    r.xs.forEach((x, i) => {
      if (x >= 300 && x < 700) expect(out[i]).toBeNull()
    })
  })

  it('property: per-column min and max are preserved and no value is invented', () => {
    fc.assert(
      fc.property(dataset, ({ xs, series, columns }) => {
        const r = downsampleMinMax(xs, series, columns)
        // Shape.
        expect(r.series.length).toBe(series.length)
        for (const s of r.series) expect(s.length).toBe(r.xs.length)
        expect(r.sourceIndex.length).toBe(r.xs.length)
        // Output timestamps are input timestamps, strictly ascending.
        r.xs.forEach((x, i) => {
          expect(xs[r.sourceIndex[i]!]).toBe(x)
          if (i > 0) expect(x).toBeGreaterThan(r.xs[i - 1]!)
        })
        // Never more than two points per column.
        if (r.downsampled) expect(r.xs.length).toBeLessThanOrEqual(columns * 2)
        else expect(r.xs).toEqual(xs)

        series.forEach((values, k) => {
          const inB = buckets(xs, values, columns)
          // Output columns are computed against the *input* extent.
          const outB = new Map<number, number[]>()
          r.xs.forEach((x, i) => {
            const v = r.series[k]![i]
            if (v == null) return
            const c = columnOf(x, xs[0]!, xs[xs.length - 1]!, columns)
            if (!outB.has(c)) outB.set(c, [])
            outB.get(c)!.push(v)
          })
          // Same columns have data: gaps are neither created nor filled.
          expect([...outB.keys()].sort((a, b) => a - b)).toEqual([...inB.keys()].sort((a, b) => a - b))
          for (const [c, vals] of inB) {
            const got = outB.get(c)!
            // Numeric equality (=== / SameValueZero), so that -0 and +0 count as the same value.
            expect(Math.min(...got) === Math.min(...vals)).toBe(true)
            expect(Math.max(...got) === Math.max(...vals)).toBe(true)
            // Nothing invented: every output value occurs in the same input column.
            for (const g of got) expect(vals.includes(g)).toBe(true)
          }
        })
      }),
      { numRuns: 300 },
    )
  })
})
