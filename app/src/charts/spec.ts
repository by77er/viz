/**
 * From a result to what the design system's chart takes (charts/systemChart.ts), and the one
 * number format the result's other forms share with it. Pure: no page.
 *
 * The chart draws a regular grid of values in one unit and formats its own times in UTC. The
 * app's results are Float64Arrays with NaN gaps, in the unit the query implies, and the app
 * shows local time. So a spec is built from a result here: gaps become null, values are moved
 * into a unit the chart knows, and times are moved by the local offset so that the chart's
 * clock reads local time.
 */
import type { AlignedData } from '../lib/series'
import type { UnitId } from '../lib/units'
import type { ChartRules, ChartSpec, SpecSeries } from './systemChart'

/** The aggregate the chart's text form would print after "every N min"; replaced as a whole (Chart.tsx, `fixText`). */
export const NO_AGGREGATE = 'instant'

/** The name the chart is given for a unit, and what a value is multiplied by first. */
export interface ChartUnit {
  name: string
  scale: number
}

const BYTE_RATES = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'] as const

/**
 * The chart scales bytes (`B`) and seconds (`s`) itself and keeps every other unit's name.
 * Bytes per second are scaled here, in binary steps, because the chart would give them a
 * decimal "k"; a ratio is shown as a percentage.
 */
export function chartUnit(unit: UnitId, maxAbs: number): ChartUnit {
  switch (unit) {
    case 'seconds':
      return { name: 's', scale: 1 }
    case 'bytes':
      return { name: 'B', scale: 1 }
    case 'bytes/s': {
      let i = 0
      while (i < BYTE_RATES.length - 1 && maxAbs >= 1024 ** (i + 1)) i++
      return { name: BYTE_RATES[i]!, scale: 1 / 1024 ** i }
    }
    case 'percentunit':
      return { name: '%', scale: 100 }
    case 'percent':
      return { name: '%', scale: 1 }
    case 'rps':
      return { name: '/s', scale: 1 }
    case 'cores':
      return { name: 'cores', scale: 1 }
    case 'none':
      return { name: '', scale: 1 }
  }
}

/** The largest magnitude among the values of a result (0 when it has none). */
export function largest(data: AlignedData): number {
  let max = 0
  for (const s of data.series) {
    const v = s.values
    for (let i = 0; i < v.length; i++) {
      const a = Math.abs(v[i]!)
      if (a > max) max = a // NaN (a gap) compares false
    }
  }
  return max
}

/**
 * A series the API returned with no labels (`sum(rate(x[5m]))`) has nothing to be named by,
 * and the chart names a legend row by its labels. Its one true name is the query it is the
 * value of, so that is the label it is given.
 */
export function chartLabels(labels: Record<string, string>, query: string): Record<string, string> {
  for (const k in labels) if (labels[k] !== '') return labels
  return { query }
}

export interface SpecInput {
  data: AlignedData
  /** Epoch seconds and the step in seconds, as queried. */
  start: number
  step: number
  unit: UnitId
  /** The query the result answers: the name of a series that has no labels. */
  query: string
  /** Added to every time, in ms, so that the chart's UTC clock reads local time (lib/timeInput `zoneShiftMs`). */
  shiftMs: number
  /** The chart's unit when the caller knows it by another name than a `UnitId` (a dashboard panel declares its unit: dashboards/model.ts `chartUnitOf`). */
  as?: ChartUnit
}

export function toSpec({ data, start, step, unit, query, shiftMs, as }: SpecInput): { spec: ChartSpec; unit: ChartUnit } {
  // Only bytes per second are scaled by size here (the chart scales bytes and seconds itself): no pass over the values for the others.
  const u = as ?? chartUnit(unit, unit === 'bytes/s' ? largest(data) : 0)
  const series: SpecSeries[] = data.series.map((s) => {
    const src = s.values
    const values = new Array<number | null>(src.length)
    for (let i = 0; i < src.length; i++) {
      const v = src[i]!
      values[i] = Number.isFinite(v) ? v * u.scale : null
    }
    return { labels: chartLabels(s.labels, query), values }
  })
  return { spec: { unit: u.name, agg: NO_AGGREGATE, t0: Math.round(start * 1000) + shiftMs, step: Math.round(step * 1000), series }, unit: u }
}

/**
 * The format the chart gives a result's figures while every series is drawn, for the forms
 * that show the same figures without the chart (the table): the unit the chart picks from the
 * largest value (`scaleUnit`) and one decimal place more than the place of the leading digit
 * of its value axis's step (`valueTicks`, `numberFormat`). A chart of the standard height has
 * four intervals at most, which is what `plotH` and `lineH` say here.
 */
export function figureFormat(rules: ChartRules, unit: ChartUnit, lo: number, hi: number): { unit: string; value: (raw: number | null) => string } {
  const big = Math.max(Math.abs(lo), Math.abs(hi)) * unit.scale
  const scaled = rules.scaleUnit(unit.name, big)
  const ax = rules.valueTicks({ lo: Math.min(0, lo * unit.scale) / scaled.div, hi: Math.max(0, hi * unit.scale) / scaled.div, plotH: 8, lineH: 1, binary: scaled.binary })
  const fmt = rules.numberFormat(ax.step, scaled.suffix, scaled.div)
  return { unit: scaled.unit, value: (raw) => (raw == null || !Number.isFinite(raw) ? '' : fmt.value(raw * unit.scale)) }
}
