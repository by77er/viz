/**
 * Text digest of a query result: the "text form" of a view (DESIGN §8). Pure and narrow on
 * purpose — the dashboard package will replace this module; callers depend only on
 * `digestSeries` and `renderDigest`.
 */

export interface DigestInput {
  /** Epoch seconds, ascending, shared by all series. */
  xs: readonly number[]
  series: readonly { name: string; values: readonly (number | null)[] }[]
}

export type Trend = 'rising' | 'falling' | 'flat' | 'unknown'

export interface SeriesDigest {
  name: string
  points: number
  /** Number of runs of missing samples inside the series' own extent. */
  gaps: number
  first: number | null
  last: number | null
  min: number | null
  max: number | null
  mean: number | null
  trend: Trend
  /** Fitted change over the window relative to the mean magnitude (0.1 = +10%). */
  change: number | null
}

export interface Digest {
  from: number | null
  to: number | null
  seriesCount: number
  series: SeriesDigest[]
}

/** A fitted change smaller than this fraction of the mean magnitude reads as "flat". */
export const FLAT_THRESHOLD = 0.05

export function digestOne(xs: readonly number[], name: string, values: readonly (number | null)[]): SeriesDigest {
  let n = 0
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let sumAbs = 0
  let first: number | null = null
  let last: number | null = null
  let gaps = 0
  let inGap = false
  // Least squares of value against time, with time centred on the first point for accuracy.
  const x0 = xs[0] ?? 0
  let sx = 0
  let sxx = 0
  let sxy = 0
  let xFirst = 0
  let xLast = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v == null || !Number.isFinite(v)) {
      if (n > 0) inGap = true
      continue
    }
    if (inGap) {
      gaps++
      inGap = false
    }
    const x = (xs[i] ?? 0) - x0
    if (n === 0) {
      first = v
      xFirst = x
    }
    last = v
    xLast = x
    n++
    if (v < min) min = v
    if (v > max) max = v
    sum += v
    sumAbs += Math.abs(v)
    sx += x
    sxx += x * x
    sxy += x * v
  }
  if (n === 0) {
    return { name, points: 0, gaps: 0, first: null, last: null, min: null, max: null, mean: null, trend: 'unknown', change: null }
  }
  const mean = sum / n
  let trend: Trend = 'unknown'
  let change: number | null = null
  const denom = n * sxx - sx * sx
  if (n >= 3 && denom > 0) {
    const slope = (n * sxy - sx * sum) / denom
    const fitted = slope * (xLast - xFirst)
    const scale = sumAbs / n
    change = scale > 0 ? fitted / scale : 0
    trend = Math.abs(change) < FLAT_THRESHOLD ? 'flat' : change > 0 ? 'rising' : 'falling'
  }
  return { name, points: n, gaps, first, last, min, max, mean, trend, change }
}

export function digestSeries(input: DigestInput): Digest {
  const xs = input.xs
  return {
    from: xs.length ? xs[0]! : null,
    to: xs.length ? xs[xs.length - 1]! : null,
    seriesCount: input.series.length,
    series: input.series.map((s) => digestOne(xs, s.name, s.values)),
  }
}

export interface RenderOptions {
  /** Value formatter (unit-aware). */
  format: (v: number | null) => string
  /** Title line, typically the query. */
  title?: string
  /** Series beyond this many are summarised in one line (token budget). */
  maxSeries?: number
}

const ARROW: Record<Trend, string> = { rising: 'rising', falling: 'falling', flat: 'flat', unknown: 'trend n/a' }

function pct(change: number | null): string {
  if (change == null) return ''
  const p = change * 100
  if (Math.abs(p) < 0.05) return ''
  const abs = Math.abs(p)
  return ` ${p >= 0 ? '+' : '-'}${abs >= 10 ? abs.toFixed(0) : abs.toFixed(1)}%`
}

export function renderSeriesLine(s: SeriesDigest, format: (v: number | null) => string): string {
  if (s.points === 0) return `${s.name}: no data`
  const gaps = s.gaps > 0 ? `, ${s.gaps} gap${s.gaps === 1 ? '' : 's'}` : ''
  return `${s.name}: last ${format(s.last)}, min ${format(s.min)}, max ${format(s.max)}, mean ${format(s.mean)}, ${ARROW[s.trend]}${s.trend === 'unknown' ? '' : pct(s.change)}${gaps}`
}

/** Compact plain-text rendering, one line per series, for screen readers and agents. */
export function renderDigest(d: Digest, opts: RenderOptions): string {
  const lines: string[] = []
  if (opts.title) lines.push(opts.title)
  if (d.seriesCount === 0) {
    lines.push('No series.')
    return lines.join('\n')
  }
  const iso = (t: number | null) => (t == null ? '?' : new Date(t * 1000).toISOString().replace('.000Z', 'Z'))
  const counts = { rising: 0, falling: 0, flat: 0, unknown: 0 }
  for (const s of d.series) counts[s.trend]++
  const mix = (['rising', 'falling', 'flat'] as const).filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${k}`)
  lines.push(
    `${d.seriesCount} series, ${iso(d.from)} to ${iso(d.to)}${mix.length ? ` (${mix.join(', ')})` : ''}`,
  )
  const max = opts.maxSeries ?? 50
  // Most significant first: by largest absolute last value.
  const ordered = [...d.series].sort((a, b) => (b.last == null ? -1 : Math.abs(b.last)) - (a.last == null ? -1 : Math.abs(a.last)))
  for (const s of ordered.slice(0, max)) lines.push(`- ${renderSeriesLine(s, opts.format)}`)
  if (ordered.length > max) lines.push(`- … ${ordered.length - max} more series not shown`)
  return lines.join('\n')
}
