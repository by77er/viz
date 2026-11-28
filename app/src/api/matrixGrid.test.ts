// The parser's grid (design-system/reviews/chart-speed): a series placed on the grid as it is read
// must give exactly what `alignSeries` gives without it, however the body is cut into pieces, on the
// grid or off it, with gaps, NaN and ±Inf, and for a grid the series was not placed on.
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { MatrixParser, type MatrixGrid } from './matrix'
import { alignSeries, placeOnGrid, type AlignedData } from '../lib/series'

/** Every element equal, NaN to NaN and -0 to -0. */
function same(a: AlignedData, b: AlignedData): string | null {
  if (JSON.stringify(a.xs) !== JSON.stringify(b.xs)) return 'xs'
  if (a.series.length !== b.series.length) return 'count'
  for (let i = 0; i < a.series.length; i++) {
    const x = a.series[i]!
    const y = b.series[i]!
    if (x.key !== y.key || x.name !== y.name || JSON.stringify(x.labels) !== JSON.stringify(y.labels)) return `names ${i}`
    if (x.values.length !== y.values.length) return `length ${i}`
    for (let k = 0; k < x.values.length; k++) if (!Object.is(x.values[k], y.values[k])) return `value ${i} ${k}: ${x.values[k]} vs ${y.values[k]}`
  }
  return null
}

function parse(text: string, cuts: number[], grid?: MatrixGrid) {
  const at = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b)
  const p = new MatrixParser(grid)
  let from = 0
  for (const c of at) {
    p.push(text.slice(from, c))
    from = c
  }
  p.push(text.slice(from))
  return p.finish()
}

const steps = [15, 30, 60, 0.5, 0.001, 1]
const body = fc
  .record({
    stepAt: fc.integer({ min: 0, max: steps.length - 1 }),
    n: fc.integer({ min: 1, max: 40 }),
    startAt: fc.integer({ min: 0, max: 100_000 }),
    series: fc.array(
      fc.record({
        pod: fc.integer({ min: 0, max: 5 }),
        samples: fc.array(fc.tuple(fc.integer({ min: -2, max: 45 }), fc.constantFrom('1', '-2.5', '0', 'NaN', '+Inf', '-Inf', '3.25', '1e-9', '-0'), fc.integer({ min: 0, max: 20 })), { maxLength: 45 }),
      }),
      { maxLength: 8 },
    ),
    cuts: fc.array(fc.nat(), { maxLength: 12 }),
    otherGrid: fc.boolean(),
  })
  .map((b) => {
    const step = steps[b.stepAt]!
    const start = 1795000000 + b.startAt * step
    const end = start + (b.n - 1) * step
    const result = b.series.map((s, i) => {
      // ascending, distinct times; one in twenty is off the grid
      const seen = new Set<number>()
      const values = s.samples
        .filter(([k]) => !seen.has(k) && seen.add(k))
        .sort((x, y) => x[0] - y[0])
        .map(([k, v, odd]) => [Number((start + k * step + (odd === 0 ? step / 3 : 0)).toFixed(3)), v])
      return { metric: { __name__: 'm', pod: 'p' + s.pod, i: String(i) }, values }
    })
    return { text: JSON.stringify({ status: 'success', data: { resultType: 'matrix', result } }), start, end, step, cuts: b.cuts, otherGrid: b.otherGrid }
  })

describe('MatrixParser with a grid', () => {
  it('places each series as alignSeries does, so alignSeries gives the same either way', () => {
    let placed = 0
    let off = 0
    fc.assert(
      fc.property(body, ({ text, start, end, step, cuts, otherGrid }) => {
        const plain = parse(text, cuts)
        // the grid the parser is given: the query's, or (to see that a stale one is not used) another
        const g = otherGrid ? { start: start + step, end, step } : { start, end, step }
        const gridded = parse(text, cuts, g)
        for (const s of gridded.series) {
          expect(s.onGrid).toBeDefined()
          if (s.onGrid!.values) placed++
          else off++
        }
        expect(same(alignSeries(gridded.series, start, end, step), alignSeries(plain.series, start, end, step))).toBeNull()
      }),
      { numRuns: 400 },
    )
    expect(placed).toBeGreaterThan(200)
    expect(off).toBeGreaterThan(20)
  })

  it('places a series with no grid nowhere, and gives NaN for a gap, NaN and ±Inf', () => {
    expect(placeOnGrid(Float64Array.of(10, 30), Float64Array.of(1, Infinity), 10, 40, 10)).toEqual(Float64Array.of(1, NaN, NaN, NaN))
    expect(placeOnGrid(Float64Array.of(15), Float64Array.of(1), 10, 40, 10)).toBeNull()
    expect(parse('{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"values":[[10,"1"]]}]}}', []).series[0]!.onGrid).toBeUndefined()
  })
})
