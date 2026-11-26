import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AlignedData } from '../lib/series'
import { fixRowName, fixText } from './fixups'
import { chartLabels, chartUnit, figureFormat, largest, NO_AGGREGATE, toSpec } from './spec'
import type { ChartRules } from './systemChart'

/** The design system's own rules, from the file the app bundles (no page: the script's `window` and `document` are stand-ins). */
function loadRules(): ChartRules {
  const code = readFileSync(new URL('../../../design-system/dist/viz-chart.js', import.meta.url), 'utf8')
  const win: { vzChartRules?: ChartRules } = {}
  const doc = { readyState: 'complete', querySelectorAll: () => [], addEventListener: () => {} }
  new Function('window', 'document', code)(win, doc)
  return win.vzChartRules!
}
const rules = loadRules()

const data = (...series: number[][]): AlignedData => ({
  xs: series[0]!.map((_, i) => 1000 + i * 15),
  series: series.map((v, i) => ({ key: `s=${i}`, labels: { s: String(i) }, name: `{s="${i}"}`, values: Float64Array.from(v) })),
})

describe('a result as the system\'s chart takes it', () => {
  it('a gap, NaN and an infinity are null: the chart breaks the line there', () => {
    const { spec } = toSpec({ data: data([1, NaN, 3, Infinity, -Infinity, 6]), start: 1000, step: 15, unit: 'none', query: 'q', shiftMs: 0 })
    expect(spec.series[0]!.values).toEqual([1, null, 3, null, null, 6])
  })
  it('times are milliseconds, moved by the zone\'s offset so that the chart\'s UTC clock reads local time', () => {
    const { spec } = toSpec({ data: data([1, 2]), start: 1_795_000_000, step: 15, unit: 'none', query: 'q', shiftMs: 3_600_000 })
    expect(spec.t0).toBe(1_795_000_000_000 + 3_600_000)
    expect(spec.step).toBe(15_000)
    expect(spec.agg).toBe(NO_AGGREGATE)
  })
  it('hands the chart a unit it knows, and scales what it does not', () => {
    expect(chartUnit('seconds', 0.2)).toEqual({ name: 's', scale: 1 })
    expect(chartUnit('bytes', 5e8)).toEqual({ name: 'B', scale: 1 })
    expect(chartUnit('rps', 100)).toEqual({ name: '/s', scale: 1 })
    expect(chartUnit('cores', 2)).toEqual({ name: 'cores', scale: 1 })
    expect(chartUnit('none', 2)).toEqual({ name: '', scale: 1 })
    expect(chartUnit('percent', 50)).toEqual({ name: '%', scale: 1 })
    // A ratio is shown as a percentage: 0.0421 is 4.21%.
    expect(chartUnit('percentunit', 0.5)).toEqual({ name: '%', scale: 100 })
    // Bytes per second in binary steps, which the chart would otherwise give a decimal k.
    expect(chartUnit('bytes/s', 100)).toEqual({ name: 'B/s', scale: 1 })
    expect(chartUnit('bytes/s', 3 * 1024 ** 2)).toEqual({ name: 'MiB/s', scale: 1 / 1024 ** 2 })
    // The steps are 1024, not 1000: 1000 B/s is still B/s, and a million is 977 KiB/s, not 1 MiB/s.
    expect(chartUnit('bytes/s', 1000)).toEqual({ name: 'B/s', scale: 1 })
    expect(chartUnit('bytes/s', 1024)).toEqual({ name: 'KiB/s', scale: 1 / 1024 })
    expect(chartUnit('bytes/s', 1e6)).toEqual({ name: 'KiB/s', scale: 1 / 1024 })
    expect(chartUnit('bytes/s', 1024 ** 5)).toEqual({ name: 'TiB/s', scale: 1 / 1024 ** 4 })
  })
  it('values are multiplied into the chart\'s unit', () => {
    const { spec, unit } = toSpec({ data: data([0.0421, 0.5]), start: 0, step: 15, unit: 'percentunit', query: 'q', shiftMs: 0 })
    expect(unit.name).toBe('%')
    expect(spec.series[0]!.values[0]).toBeCloseTo(4.21, 10)
    expect(spec.series[0]!.values[1]).toBe(50)
  })
  it('the largest magnitude ignores gaps and counts values below zero', () => {
    expect(largest(data([1, NaN, -7, 3]))).toBe(7)
    expect(largest({ xs: [], series: [] })).toBe(0)
  })
  it('a series with no labels is named by the query it is the value of', () => {
    expect(chartLabels({}, 'sum(rate(x[5m]))')).toEqual({ query: 'sum(rate(x[5m]))' })
    expect(chartLabels({ __name__: '' }, 'up')).toEqual({ query: 'up' })
    expect(chartLabels({ job: 'api' }, 'up')).toEqual({ job: 'api' })
    // The chart then has a name for the row: its first label that is not the metric name.
    expect(rules.distinguish([{ labels: chartLabels({}, 'sum(up)') }]).order).toEqual(['query'])
  })
})

describe('the table\'s figures are the chart\'s (one format per result)', () => {
  it('request rates: whole numbers under a 200-step axis, the unit apart', () => {
    const f = figureFormat(rules, chartUnit('rps', 593), 75, 593)
    expect(f.unit).toBe('/s')
    expect(f.value(572.4)).toBe('572')
    expect(f.value(102)).toBe('102')
  })
  it('bytes: one binary unit from the largest value', () => {
    const MiB = 1024 ** 2
    const f = figureFormat(rules, chartUnit('bytes', 690 * MiB), 300 * MiB, 690 * MiB)
    expect(f.unit).toBe('MiB')
    expect(f.value(512 * MiB)).toBe('512')
  })
  it('seconds are moved to the unit the largest value reads in', () => {
    const f = figureFormat(rules, chartUnit('seconds', 0.3), 0.01, 0.3)
    expect(f.unit).toBe('ms')
    expect(f.value(0.0425)).toBe('43')
  })
  it('a value that would print as zero says which side of zero it is on', () => {
    const f = figureFormat(rules, chartUnit('cores', 3), 0.004, 3)
    expect(f.value(0.004)).toBe('< 0.1')
    expect(f.value(0)).toBe('0.0')
    expect(f.value(1.42)).toBe('1.4')
  })
  it('a ratio is a percentage in the table as in the chart', () => {
    const f = figureFormat(rules, chartUnit('percentunit', 0.05), 0.01, 0.05)
    expect(f.unit).toBe('%')
    expect(f.value(0.0421)).toBe('4.2')
  })
  it('no value is an empty cell, never "NaN"', () => {
    const f = figureFormat(rules, chartUnit('none', 10), 0, 10)
    expect(f.value(null)).toBe('')
    expect(f.value(NaN)).toBe('')
    expect(f.unit).toBe('')
  })
})

describe('the words the chart writes that a query result needs otherwise', () => {
  it('a step is said as it is, not as a fraction of a minute, and a range query has no aggregate', () => {
    expect(fixText(`Query result: up, cores, 09:30 to 12:30, every 0.25 min, ${NO_AGGREGATE}. 3 series.`, '15 s')).toBe('Query result: up, cores, 09:30 to 12:30, one value every 15 s. 3 series.')
    expect(fixText(`Query result: up, cores, 11 Nov 15:16 to 18 Nov 15:16, every 120 min, ${NO_AGGREGATE}. 36 series, 8 drawn separately and 28 as one band.`, '2 h')).toBe(
      'Query result: up, cores, 11 Nov 15:16 to 18 Nov 15:16, one value every 2 h. 36 series, 8 drawn separately and 28 as one band.',
    )
  })
  it('a result with no unit leaves no empty place for one', () => {
    expect(fixText(`Query result: up, , 09:30 to 12:30, every 1 min, ${NO_AGGREGATE}. 12 series.`, '1 min')).toBe('Query result: up, 09:30 to 12:30, one value every 1 min. 12 series.')
  })
  it('a legend row is named by the words it shows, then its full label set', () => {
    expect(fixRowName('/product · catalog · 200', 'route="/product", service="catalog", status="200"')).toBe('/product · catalog · 200: route="/product", service="catalog", status="200"')
    // Already in the name: left alone, and so applied once only.
    expect(fixRowName('catalog', 'service="catalog"')).toBe('service="catalog"')
    const once = fixRowName('a · b', 'x="a", y="b"')
    expect(fixRowName('a · b', once)).toBe(once)
    expect(fixRowName('', 'x="a"')).toBe('x="a"')
    expect(fixRowName('Other 28 series', 'Other: 28 series as one band')).toBe('Other 28 series, as one band')
    expect(fixRowName('Other 28 series', 'Other 28 series, as one band')).toBe('Other 28 series, as one band')
  })
  it('other lines are left as the chart wrote them', () => {
    const line = '/product · catalog · 200: last 295, lowest 217, highest 312.'
    expect(fixText(line, '15 s')).toBe(line)
  })
})
