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
  /**
   * One entry per grid timestamp; NaN where the series has no sample (a gap), and where its
   * sample cannot be drawn (NaN, ±Inf). A Float64Array: 144,000 samples of 200 series are
   * 1.2 MB of doubles, not 144,000 boxed numbers for the garbage collector (FIXES.md, B3).
   */
  values: Float64Array
}

/** Values of one series as the views read them: a gap is null or NaN (both forms are accepted). */
export type SeriesValues = ArrayLike<number | null>

export interface AlignedData {
  /** Epoch seconds, ascending. */
  xs: number[]
  series: AlignedSeries[]
}

/** One series as received: label set, then sample times and values in the order sent. */
export interface SampleColumns {
  metric: Labels
  times: ArrayLike<number>
  values: ArrayLike<number>
}

/**
 * Put a range-query matrix on the regular evaluation grid `start, start+step, ... end`.
 *
 * Prometheus omits steps where a series is stale, so a missing step must become an explicit
 * gap — otherwise the line would be drawn straight across the hole. Samples that are not on
 * the grid (a backend that ignores `step`) fall back to the union of observed timestamps.
 * Non-finite values (NaN, ±Inf) cannot be drawn and are treated as gaps.
 */
export function alignSeries(result: readonly SampleColumns[], start: number, end: number, step: number): AlignedData {
  const byName = (a: AlignedSeries, b: AlignedSeries) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const n = Math.floor((end - start) / step + 1e-9) + 1
  // A sample is on the grid when it is within 5 µs of a grid time. The API's times are whole
  // milliseconds; as doubles near 1.8e9 s they are off by about 0.2 µs, which for a 0.1 s step
  // is 2e-6 of a step (a tolerance in steps, as before, sent such results down the slow path).
  const tolerance = 5e-6 / step

  // The usual case, in one pass: every sample is on the grid, so its index is computed, not
  // looked up. The first sample off the grid abandons this pass for the general one below.
  if (n > 0 && n <= 1_000_000) {
    const series: AlignedSeries[] = []
    let onGrid = true
    outer: for (let s = 0; s < result.length; s++) {
      const r = result[s]!
      const times = r.times
      const vs = r.values
      const values = new Float64Array(n).fill(NaN)
      for (let k = 0; k < times.length; k++) {
        const pos = (times[k]! - start) / step
        const i = Math.round(pos)
        if (i < 0 || i >= n || Math.abs(pos - i) > tolerance) {
          onGrid = false
          break outer
        }
        // ±Inf and NaN cannot be drawn: gaps.
        const v = vs[k]!
        values[i] = v - v === 0 ? v : NaN
      }
      series.push({ key: seriesKey(r.metric), labels: r.metric, name: seriesName(r.metric), values })
    }
    if (onGrid) {
      series.sort(byName)
      return { xs: Array.from({ length: n }, (_, i) => start + i * step), series }
    }
  }

  // Samples off the grid (a backend that ignores `step`): the union of observed timestamps.
  const set = new Set<number>()
  for (const s of result) for (let k = 0; k < s.times.length; k++) set.add(s.times[k]!)
  const xs = [...set].sort((a, b) => a - b)
  const map = new Map(xs.map((t, i) => [t, i]))
  const series = result.map((s) => {
    const values = new Float64Array(xs.length).fill(NaN)
    for (let k = 0; k < s.times.length; k++) {
      const v = s.values[k]!
      const i = map.get(s.times[k]!) ?? -1
      if (i >= 0) values[i] = Number.isFinite(v) ? v : NaN
    }
    return { key: seriesKey(s.metric), labels: s.metric, name: seriesName(s.metric), values }
  })
  series.sort(byName)
  return { xs, series }
}

/** `alignSeries` of a matrix as JSON.parse gives it: values are strings ("1.5", "NaN", "+Inf"). */
export function alignMatrix(data: PromMatrixData, start: number, end: number, step: number): AlignedData {
  return alignSeries(
    data.result.map((r) => ({
      metric: r.metric,
      times: r.values.map((p) => p[0]),
      values: r.values.map((p) => parseSampleValue(p[1])),
    })),
    start,
    end,
    step,
  )
}

export interface SeriesStats {
  last: number | null
  lastAt: number | null
  min: number | null
  max: number | null
  mean: number | null
  count: number
}

export function seriesStats(xs: number[], values: SeriesValues): SeriesStats {
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let count = 0
  let last: number | null = null
  let lastAt: number | null = null
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    // A gap: null, or NaN in a Float64Array.
    if (v == null || v !== v) continue
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
