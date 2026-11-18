import { describe, expect, it } from 'vitest'
import { digestOne, digestSeries, renderDigest } from './digest'

const xs = [0, 60, 120, 180, 240]

describe('digest', () => {
  it('computes last/min/max/mean on hand-checked data', () => {
    const d = digestOne(xs, 'a', [2, 4, 6, 8, 10])
    expect(d).toMatchObject({ points: 5, gaps: 0, first: 2, last: 10, min: 2, max: 10, mean: 6, trend: 'rising' })
    // Fitted change = slope (2 per 60 s) * 240 s = 8; relative to mean |value| 6.
    expect(d.change).toBeCloseTo(8 / 6, 12)
  })
  it('classifies falling and flat series', () => {
    expect(digestOne(xs, 'f', [10, 8, 6, 4, 2]).trend).toBe('falling')
    expect(digestOne(xs, 'c', [5, 5, 5, 5, 5])).toMatchObject({ trend: 'flat', change: 0 })
    // +/-1% noise around 100 with no slope is flat.
    expect(digestOne(xs, 'n', [100, 101, 99, 101, 100]).trend).toBe('flat')
    // A constant zero series is flat, not NaN.
    expect(digestOne(xs, 'z', [0, 0, 0, 0, 0])).toMatchObject({ trend: 'flat', change: 0 })
  })
  it('ignores nulls, counts interior gaps and handles short series', () => {
    const d = digestOne(xs, 'g', [null, 1, null, 3, null])
    expect(d).toMatchObject({ points: 2, gaps: 1, first: 1, last: 3, min: 1, max: 3, mean: 2, trend: 'unknown', change: null })
    expect(digestOne(xs, 'e', [null, null, null, null, null])).toMatchObject({ points: 0, last: null, trend: 'unknown' })
  })
  it('trend follows the fitted slope, not the endpoints', () => {
    // Ends lower than it starts, but one outlier at the start: slope is still positive overall? Check by hand:
    // values 9,1,2,3,4 at x=0..4 (unit 60 s): mean x=2, mean y=3.8; Sxy = (-2)(5.2)+(-1)(-2.8)+0+(1)(-0.8)+(2)(0.2) = -8; slope<0.
    expect(digestOne(xs, 'o', [9, 1, 2, 3, 4]).trend).toBe('falling')
  })
  it('renders a compact text form', () => {
    const d = digestSeries({
      xs,
      series: [
        { name: '{service="a"}', values: [2, 4, 6, 8, 10] },
        { name: '{service="b"}', values: [100, 100, 100, 100, 100] },
        { name: '{service="c"}', values: [null, null, null, null, null] },
      ],
    })
    const text = renderDigest(d, { format: (v) => (v == null ? '–' : String(v)), title: 'Query: x' })
    expect(text.split('\n')).toEqual([
      'Query: x',
      '3 series, 1970-01-01T00:00:00Z to 1970-01-01T00:04:00Z (1 rising, 1 flat)',
      '- {service="b"}: last 100, min 100, max 100, mean 100, flat',
      '- {service="a"}: last 10, min 2, max 10, mean 6, rising +133%',
      '- {service="c"}: no data',
    ])
  })
  it('caps the number of series lines', () => {
    const series = Array.from({ length: 7 }, (_, i) => ({ name: `s${i}`, values: [i, i, i, i, i] }))
    const text = renderDigest(digestSeries({ xs, series }), { format: String, maxSeries: 3 })
    expect(text.split('\n').length).toBe(1 + 3 + 1)
    expect(text).toContain('… 4 more series not shown')
    expect(renderDigest(digestSeries({ xs, series: [] }), { format: String })).toBe('No series.')
  })
})
