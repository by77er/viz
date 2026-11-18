import type { PromMatrixData } from '../api/types'

export type Labels = Record<string, string>

/** Canonical identity of a label set: keys sorted, JSON-escaped. Stable across reloads. */
export function seriesKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${JSON.stringify(labels[k])}`)
    .join(',')
}

/** Prometheus display form: `name{a="b", c="d"}`. */
export function seriesName(labels: Labels): string {
  const name = labels.__name__ ?? ''
  const rest = Object.keys(labels)
    .filter((k) => k !== '__name__')
    .sort()
    .map((k) => `${k}=${JSON.stringify(labels[k])}`)
  if (rest.length === 0) return name || '{}'
  return `${name}{${rest.join(', ')}}`
}

/** Parse a Prometheus sample value ("1.5", "NaN", "+Inf"). NaN is kept as NaN. */
export function parseSampleValue(v: string): number {
  if (v === '+Inf' || v === 'Inf') return Infinity
  if (v === '-Inf') return -Infinity
  return Number(v)
}

export interface AlignedSeries {
  key: string
  labels: Labels
  name: string
  /** One entry per grid timestamp; null where the series has no sample (a gap). */
  values: (number | null)[]
}

export interface AlignedData {
  /** Epoch seconds, ascending. */
  xs: number[]
  series: AlignedSeries[]
}

/**
 * Put a range-query matrix on the regular evaluation grid `start, start+step, ... end`.
 *
 * Prometheus omits steps where a series is stale, so a missing step must become an explicit
 * null — otherwise the line would be drawn straight across the hole. Samples that are not on
 * the grid (a backend that ignores `step`) fall back to the union of observed timestamps.
 * Non-finite values (NaN, ±Inf) cannot be drawn and are treated as gaps.
 */
export function alignMatrix(data: PromMatrixData, start: number, end: number, step: number): AlignedData {
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

export interface SeriesStats {
  last: number | null
  lastAt: number | null
  min: number | null
  max: number | null
  mean: number | null
  count: number
}

export function seriesStats(xs: number[], values: (number | null)[]): SeriesStats {
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let count = 0
  let last: number | null = null
  let lastAt: number | null = null
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v == null) continue
    if (v < min) min = v
    if (v > max) max = v
    sum += v
    count++
    last = v
    lastAt = xs[i] ?? null
  }
  if (count === 0) return { last: null, lastAt: null, min: null, max: null, mean: null, count: 0 }
  return { last, lastAt, min, max, mean: sum / count, count }
}

/**
 * Short display names for a set of series: labels whose value is identical on every series
 * (including the metric name) are dropped, leaving what tells the series apart. Used where
 * space is tight (tooltips); the legend keeps full names.
 */
export function distinguishingNames(all: readonly Labels[]): string[] {
  if (all.length < 2) return all.map(seriesName)
  const first = all[0]!
  const common = new Set(Object.keys(first).filter((k) => all.every((l) => l[k] === first[k])))
  return all.map((labels) => {
    const rest: Labels = {}
    for (const k of Object.keys(labels)) if (!common.has(k)) rest[k] = labels[k]!
    return Object.keys(rest).length === 0 ? seriesName(labels) : seriesName(rest)
  })
}
