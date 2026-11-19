/**
 * Digests: the text form of a panel ("one model, three readers"). An agent
 * or a screen reader gets, per series, the numbers a person would read off
 * the chart: current value, range, trend, whether it is an outlier among
 * its peers, threshold state, and gaps.
 *
 * Timestamps are Unix seconds, as in the Prometheus HTTP API.
 */
import type { Panel, PromMatrix, PromVector, Reducer, Threshold, ThresholdState } from './types.ts'
import type { ResolvedDashboard } from './resolve.ts'

export type PromData = PromMatrix | PromVector

export interface DigestOptions {
  /** Panel id, copied into the digest. */
  id?: string
  /** Series kept per panel, most important first. Default 5. */
  topK?: number
  /** Expected sample spacing in seconds; inferred from the data (median spacing) when absent. */
  step?: number
  /** Range start/end in Unix seconds; enables leading-gap and staleness detection. */
  start?: number
  end?: number
  /** Legend templates by query id (or one template for all), e.g. `{{route}}`. */
  legends?: Record<string, string> | string
  /** Robust z-score above which a series is an outlier. Default 3.5. */
  outlierZ?: number
  /** Relative change of the fitted line below which the trend is "flat". Default 0.05. */
  flatTolerance?: number
}

export interface Trend {
  direction: 'up' | 'down' | 'flat'
  /** Least-squares slope in units per second. */
  slope: number
  /** (last − first) / |first|; null when first is 0. */
  relChange: number | null
}

export interface SeriesDigest {
  name: string
  labels: Record<string, string>
  query?: string
  /** Finite samples. */
  points: number
  /** The panel's reduced value (stat/table `reduce`, default last); thresholds are evaluated on it. */
  value: number | null
  first: number | null
  last: number | null
  lastTs: number | null
  min: number | null
  max: number | null
  mean: number | null
  trend: Trend | null
  /** Robust z-score of this series' mean among all series of the panel; null with fewer than 4 series. */
  z: number | null
  outlier: boolean
  /** Threshold state of `value`; null if the panel has no thresholds. */
  state: ThresholdState | null
  /** Worst threshold state reached anywhere in the window. */
  worst: ThresholdState | null
  /** The threshold that sets `state`, as text, e.g. `>0.01`. */
  breached?: string
  gaps: { count: number; missing: number; longest: number }
  /** Seconds between the last sample and the end of the range, when more than 1.5 steps. */
  stale?: number
  nonFinite: number
}

export interface PanelDigest {
  id: string
  kind: Panel['kind']
  title: string
  description?: string
  unit?: string
  seriesCount: number
  /** Top-k series by importance: breaching first, then outliers, then largest value. */
  series: SeriesDigest[]
  /** Series not listed, with how many of them breach. */
  omitted: { count: number; crit: number; warn: number; outliers: number }
  /** Worst current state over ALL series (not only the listed ones); null without thresholds. */
  state: ThresholdState | null
  worst: ThresholdState | null
  outliers: number
  /** The queries returned nothing. A first-class warning, never hidden. */
  noData: boolean
  range?: { start: number; end: number; step: number }
  /** Text panels: the content. */
  text?: string
}

const SEVERITY: Record<ThresholdState, number> = { ok: 0, info: 1, warn: 2, crit: 3 }

/** State of `v` under `thresholds`: the most severe breached level, or `ok`. */
export function thresholdState(v: number | null, thresholds: readonly Threshold[] | undefined): { state: ThresholdState; breached?: string } | null {
  if (!thresholds || thresholds.length === 0) return null
  if (v === null || !Number.isFinite(v)) return { state: 'ok' }
  let state: ThresholdState = 'ok'
  let breached: string | undefined
  for (const t of thresholds) {
    const hit = 'above' in t ? v > t.above : v < t.below
    if (hit && SEVERITY[t.level] > SEVERITY[state]) {
      state = t.level
      breached = 'above' in t ? `>${t.above}` : `<${t.below}`
    }
  }
  return breached === undefined ? { state } : { state, breached }
}

function median(sorted: number[]): number {
  const n = sorted.length
  const mid = n >> 1
  return n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Robust z-scores (Iglewicz–Hoaglin): 0.6745·(x − median)/MAD. When MAD is 0
 * (more than half the values identical) it falls back to the mean absolute
 * deviation: (x − median)/(1.253314·meanAD).
 */
export function robustZ(xs: readonly number[]): number[] {
  if (xs.length === 0) return []
  const med = median([...xs].sort((a, b) => a - b))
  const dev = xs.map((x) => Math.abs(x - med))
  const mad = median([...dev].sort((a, b) => a - b))
  if (mad > 0) return xs.map((x) => (0.6745 * (x - med)) / mad)
  const meanAD = dev.reduce((a, b) => a + b, 0) / dev.length
  if (meanAD > 0) return xs.map((x) => (x - med) / (1.253314 * meanAD))
  return xs.map(() => 0)
}

function formatLegend(template: string, labels: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, k: string) => labels[k] ?? '')
}

function reduce(values: number[], how: Reducer): number | null {
  if (values.length === 0) return null
  switch (how) {
    case 'last': return values[values.length - 1]!
    case 'min': return Math.min(...values)
    case 'max': return Math.max(...values)
    case 'sum': return values.reduce((a, b) => a + b, 0)
    case 'mean': return values.reduce((a, b) => a + b, 0) / values.length
  }
}

interface RawSeries {
  query?: string
  labels: Record<string, string>
  samples: [number, string][]
}

function normalize(data: PromData | Record<string, PromData> | undefined | null): RawSeries[] {
  const out: RawSeries[] = []
  const one = (d: PromData | undefined | null, query?: string) => {
    if (!d || !Array.isArray(d.result)) return
    for (const s of d.result) {
      const samples = d.resultType === 'matrix' ? (s as PromMatrix['result'][number]).values : [(s as PromVector['result'][number]).value]
      out.push({ ...(query !== undefined ? { query } : {}), labels: s.metric ?? {}, samples: samples ?? [] })
    }
  }
  if (!data) return out
  if ('resultType' in data && typeof data.resultType === 'string') one(data as PromData)
  else for (const [q, d] of Object.entries(data as Record<string, PromData>)) one(d, q)
  return out
}

/**
 * Digest one panel's data. `data` is a Prometheus matrix or vector, or a map
 * of them by query id for panels with several queries.
 */
export function digestPanel(panel: Panel, data: PromData | Record<string, PromData> | undefined | null, opts: DigestOptions = {}): PanelDigest {
  const id = opts.id ?? ''
  const base: PanelDigest = {
    id,
    kind: panel.kind,
    title: panel.title,
    seriesCount: 0,
    series: [],
    omitted: { count: 0, crit: 0, warn: 0, outliers: 0 },
    state: null,
    worst: null,
    outliers: 0,
    noData: false,
  }
  if (panel.description !== undefined) base.description = panel.description
  if (panel.kind === 'text') {
    base.text = panel.content
    return base
  }
  if (panel.unit !== undefined) base.unit = panel.unit
  const thresholds = panel.kind === 'heatmap' ? undefined : panel.thresholds
  const reducer: Reducer = (panel.kind === 'stat' || panel.kind === 'table' ? panel.options?.reduce : undefined) ?? 'last'
  const topK = Math.max(0, Math.floor(opts.topK ?? 5))
  const zLimit = opts.outlierZ ?? 3.5
  const flat = opts.flatTolerance ?? 0.05

  const raw = normalize(data)
  const multiQuery = new Set(raw.map((r) => r.query)).size > 1

  // labels that distinguish series (others are noise in a name)
  const labelKeys = new Set<string>()
  for (const r of raw) for (const k of Object.keys(r.labels)) labelKeys.add(k)
  const varying = [...labelKeys].filter((k) => new Set(raw.map((r) => r.labels[k])).size > 1)

  // step: given, or the median spacing over all series
  let step = opts.step
  if (step === undefined) {
    const deltas: number[] = []
    for (const r of raw) for (let i = 1; i < r.samples.length; i++) deltas.push(r.samples[i]![0] - r.samples[i - 1]![0])
    if (deltas.length) step = median(deltas.sort((a, b) => a - b))
  }

  const all: SeriesDigest[] = raw.map((r) => {
    const ts: number[] = []
    const vs: number[] = []
    let nonFinite = 0
    for (const [t, v] of r.samples) {
      const x = Number(v)
      if (Number.isFinite(x)) {
        ts.push(t)
        vs.push(x)
      } else nonFinite++
    }
    const n = vs.length
    const legend = typeof opts.legends === 'string' ? opts.legends : r.query !== undefined ? opts.legends?.[r.query] : undefined
    let name = legend ? formatLegend(legend, r.labels) : ''
    if (!name) {
      const keys = (varying.length ? varying : Object.keys(r.labels)).filter((k) => k in r.labels)
      const metric = r.labels.__name__
      const rest = keys.filter((k) => k !== '__name__').map((k) => `${k}=${r.labels[k]}`).join(',')
      name = varying.length ? (keys.includes('__name__') && metric ? metric + (rest ? `{${rest}}` : '') : rest) : metric ?? rest
      if (!name) name = r.query ?? 'value'
    }
    if (multiQuery && r.query !== undefined && !legend) name = `${r.query}: ${name}`

    const d: SeriesDigest = {
      name,
      labels: r.labels,
      points: n,
      value: reduce(vs, reducer),
      first: n ? vs[0]! : null,
      last: n ? vs[n - 1]! : null,
      lastTs: n ? ts[n - 1]! : null,
      min: n ? Math.min(...vs) : null,
      max: n ? Math.max(...vs) : null,
      mean: n ? vs.reduce((a, b) => a + b, 0) / n : null,
      trend: null,
      z: null,
      outlier: false,
      state: null,
      worst: null,
      gaps: { count: 0, missing: 0, longest: 0 },
      nonFinite,
    }
    if (r.query !== undefined) d.query = r.query

    // trend: least-squares line through the finite samples
    if (n >= 2 && ts[n - 1]! > ts[0]!) {
      const tMean = ts.reduce((a, b) => a + b, 0) / n
      let num = 0
      let den = 0
      for (let i = 0; i < n; i++) {
        num += (ts[i]! - tMean) * (vs[i]! - d.mean!)
        den += (ts[i]! - tMean) ** 2
      }
      const slope = den > 0 ? num / den : 0
      const change = slope * (ts[n - 1]! - ts[0]!)
      const scale = Math.max(Math.abs(d.mean!), Math.abs(d.min!), Math.abs(d.max!))
      const direction = scale === 0 || Math.abs(change) <= flat * scale ? 'flat' : change > 0 ? 'up' : 'down'
      const first = vs[0]!
      const last = vs[n - 1]!
      d.trend = { direction, slope, relChange: first !== 0 ? (last - first) / Math.abs(first) : last === 0 ? 0 : null }
    }

    // gaps
    if (step !== undefined && step > 0 && n > 0) {
      const limit = step * 1.5
      const note = (delta: number) => {
        if (delta > limit) {
          d.gaps.count++
          d.gaps.missing += Math.max(1, Math.round(delta / step!) - 1)
          d.gaps.longest = Math.max(d.gaps.longest, delta)
        }
      }
      if (opts.start !== undefined) note(ts[0]! - opts.start + step)
      for (let i = 1; i < n; i++) note(ts[i]! - ts[i - 1]!)
      if (opts.end !== undefined && opts.end - ts[n - 1]! > limit) d.stale = opts.end - ts[n - 1]!
    }

    // thresholds
    const now = thresholdState(d.value, thresholds)
    if (now) {
      d.state = now.state
      if (now.breached) d.breached = now.breached
      let worst = now.state
      for (const x of [d.min, d.max]) {
        const s = thresholdState(x, thresholds)!.state
        if (SEVERITY[s] > SEVERITY[worst]) worst = s
      }
      d.worst = worst
    }
    return d
  })

  // outliers: robust z-score of each series' mean among its peers
  const withMean = all.filter((s) => s.mean !== null)
  if (withMean.length >= 4) {
    const zs = robustZ(withMean.map((s) => s.mean!))
    withMean.forEach((s, i) => {
      s.z = zs[i]!
      s.outlier = Math.abs(zs[i]!) > zLimit
    })
  }

  const sev = (s: ThresholdState | null) => (s === null ? 0 : SEVERITY[s])
  const ranked = all
    .map((s, i) => ({ s, i }))
    .sort(
      (a, b) =>
        sev(b.s.state) - sev(a.s.state) ||
        Number(b.s.outlier) - Number(a.s.outlier) ||
        sev(b.s.worst) - sev(a.s.worst) ||
        Math.abs(b.s.value ?? -Infinity) - Math.abs(a.s.value ?? -Infinity) ||
        a.i - b.i,
    )
    .map((x) => x.s)

  base.seriesCount = all.length
  base.noData = all.every((s) => s.points === 0)
  base.series = ranked.slice(0, topK)
  const rest = ranked.slice(topK)
  base.omitted = {
    count: rest.length,
    crit: rest.filter((s) => s.state === 'crit').length,
    warn: rest.filter((s) => s.state === 'warn').length,
    outliers: rest.filter((s) => s.outlier).length,
  }
  base.outliers = all.filter((s) => s.outlier).length
  if (thresholds?.length) {
    base.state = all.reduce<ThresholdState>((w, s) => (sev(s.state) > SEVERITY[w] ? s.state! : w), 'ok')
    base.worst = all.reduce<ThresholdState>((w, s) => (sev(s.worst) > SEVERITY[w] ? s.worst! : w), 'ok')
  }
  if (step !== undefined && all.length) {
    const firsts = raw.flatMap((r) => (r.samples.length ? [r.samples[0]![0]] : []))
    const lasts = raw.flatMap((r) => (r.samples.length ? [r.samples[r.samples.length - 1]![0]] : []))
    if (firsts.length) base.range = { start: opts.start ?? Math.min(...firsts), end: opts.end ?? Math.max(...lasts), step }
  }
  return base
}

// ---- dashboard digest and rendering ----

export interface DashboardDigest {
  id: string
  title: string
  intent: string
  revision?: string
  range?: { start: number; end: number }
  variables?: Record<string, string>
  /** Absolute deep link to this view (range and variables pinned), if the caller has one. */
  link?: string
  panels: PanelDigest[]
}

/** Digest every panel of a resolved dashboard. `data` maps panel id → query id → result. */
export function digestDashboard(
  resolved: ResolvedDashboard,
  data: Record<string, Record<string, PromData> | undefined>,
  opts: Omit<DigestOptions, 'id' | 'legends'> & { link?: string } = {},
): DashboardDigest {
  const ids = [...resolved.order, ...Object.keys(resolved.panels).filter((p) => !resolved.order.includes(p))]
  const panels = ids.map((id) => {
    const panel = resolved.panels[id]!
    const legends: Record<string, string> = {}
    if (panel.kind !== 'text') for (const q of panel.queries) if (resolved.queries[q]?.legend) legends[q] = resolved.queries[q]!.legend!
    return digestPanel(panel, data[id], { ...opts, id, legends })
  })
  const out: DashboardDigest = { id: resolved.metadata.id, title: resolved.metadata.title, intent: resolved.metadata.intent, revision: resolved.revision, panels }
  const vars = Object.entries(resolved.variables)
  if (vars.length) out.variables = Object.fromEntries(vars.map(([k, v]) => [k, v.all ? '*' : v.values.join('|')]))
  if (opts.start !== undefined && opts.end !== undefined) out.range = { start: opts.start, end: opts.end }
  if (opts.link) out.link = opts.link
  return out
}

export interface RenderOptions {
  format: 'markdown' | 'tsv'
  /** Approximate budget; 1 token ≈ 4 characters. The output never exceeds `maxTokens * 4` characters. */
  maxTokens: number
  /** Continue from a previous call's `cursor`. */
  cursor?: string
  /**
   * Write the truncation footer (default true): the line naming the next cursor, or saying that
   * series were omitted. A caller with its own cursors and wording passes false; `truncated` and
   * `cursor` in the result still say what was left out, and the footer's space is not reserved.
   */
  continuation?: boolean
}

export interface RenderedDigest {
  text: string
  /** Estimated tokens of `text` (characters / 4, rounded up). */
  tokens: number
  /** Something was left out or abbreviated to fit the budget. */
  truncated: boolean
  /** Pass to the next call to continue with the panels not yet shown in full. */
  cursor?: string
  /** Panels rendered in full in this call, and in total. */
  panelsShown: number
  panelsTotal: number
}

/** Compact number: 4 significant digits, exponent form for very large or small. */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '-'
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs >= 1e7 || abs < 1e-4) return n.toExponential(2).replace(/\.?0+e/, 'e').replace('e+', 'e')
  return String(Number(n.toPrecision(4)))
}

function trendText(t: Trend | null): string {
  if (!t) return '-'
  if (t.relChange === null) return t.direction
  const pct = t.relChange * 100
  return `${t.direction} ${pct >= 0 ? '+' : ''}${Math.abs(pct) >= 100 ? pct.toFixed(0) : Number(pct.toPrecision(2))}%`
}

function flags(s: SeriesDigest): string {
  const f: string[] = []
  if (s.outlier) f.push(`outlier z=${formatNumber(s.z)}`)
  if (s.worst && s.state && s.worst !== s.state) f.push(`reached ${s.worst}`)
  if (s.gaps.count) f.push(`${s.gaps.count} gap${s.gaps.count > 1 ? 's' : ''}`)
  if (s.stale !== undefined) f.push(`stale ${formatNumber(s.stale)}s`)
  if (s.points === 0) f.push('no data')
  return f.join('; ')
}

function stateText(s: SeriesDigest): string {
  if (s.state === null) return '-'
  return s.state === 'ok' ? 'ok' : `${s.state.toUpperCase()} ${s.breached ?? ''}`.trim()
}

function badge(p: PanelDigest): string {
  if (p.noData) return 'NO DATA'
  if (p.state && p.state !== 'ok') return p.state.toUpperCase()
  if (p.outliers) return 'OUTLIER'
  return p.state === 'ok' ? 'ok' : ''
}

const clean = (s: string) => s.replace(/[\t\r\n|]+/g, ' ').trim()
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s)

/** Rank of a panel in the rendering order (lower first). */
function importance(p: PanelDigest): number {
  if (p.state === 'crit') return 0
  if (p.state === 'warn') return 1
  if (p.state === 'info') return 2
  if (p.outliers > 0) return 3
  if (p.noData) return 4
  if (p.worst && p.worst !== 'ok') return 5
  return p.kind === 'text' ? 7 : 6
}

/**
 * The order `renderDigest` writes panels in, as indices into `panels`: crit, warn, info,
 * panels with outliers, no data, panels that reached a threshold within the window, the rest,
 * text panels last; ties keep the given (layout) order. A `cursor` "o:N" from `renderDigest`
 * means the first N entries of this order have been consumed.
 */
export function panelOrder(panels: readonly PanelDigest[]): number[] {
  return panels.map((p, i) => ({ r: importance(p), i })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.i)
}

function omittedText(p: PanelDigest, shown: number): string {
  const hidden = p.seriesCount - shown
  if (hidden <= 0) return ''
  const extra = p.series.slice(shown)
  const crit = p.omitted.crit + extra.filter((s) => s.state === 'crit').length
  const warn = p.omitted.warn + extra.filter((s) => s.state === 'warn').length
  const parts = [`${hidden} more series not shown`]
  if (crit) parts.push(`${crit} crit`)
  if (warn) parts.push(`${warn} warn`)
  return parts.join(', ')
}

function panelBlock(p: PanelDigest, format: 'markdown' | 'tsv', k: number): string {
  const b = badge(p)
  const shown = p.series.slice(0, k)
  const meta = [p.kind, p.unit].filter(Boolean).join(', ')
  if (format === 'tsv') {
    const lines = [`# ${p.id}\t${p.kind}\t${p.unit ?? ''}\t${b}\t${clean(p.title)}\t${p.seriesCount} series${p.outliers ? `, ${p.outliers} outlier` : ''}`]
    for (const s of shown) {
      lines.push([p.id, clean(s.name), formatNumber(s.value), formatNumber(s.min), formatNumber(s.max), formatNumber(s.mean), trendText(s.trend), stateText(s), flags(s)].join('\t'))
    }
    const om = omittedText(p, shown.length)
    if (om) lines.push(`# ${p.id}\t${om}`)
    return lines.join('\n') + '\n'
  }
  const lines = [`## ${b ? `[${b}] ` : ''}${clean(p.title)} — ${p.id} (${meta})`]
  if (p.description) lines.push(cut(clean(p.description), 240))
  if (p.kind === 'text') {
    if (p.text) lines.push(cut(clean(p.text), 400))
    return lines.join('\n') + '\n\n'
  }
  if (p.noData) {
    lines.push('No data returned for this range.')
    return lines.join('\n') + '\n\n'
  }
  const summary = [`${p.seriesCount} series`]
  if (p.outliers) summary.push(`${p.outliers} outlier${p.outliers > 1 ? 's' : ''}`)
  if (p.worst && p.worst !== 'ok' && p.worst !== p.state) summary.push(`reached ${p.worst} in window`)
  lines.push(summary.join(', ') + '.')
  if (shown.length) {
    lines.push('| series | value | min | max | mean | trend | state | notes |', '|---|---|---|---|---|---|---|---|')
    for (const s of shown) {
      lines.push(`| ${clean(s.name)} | ${formatNumber(s.value)} | ${formatNumber(s.min)} | ${formatNumber(s.max)} | ${formatNumber(s.mean)} | ${trendText(s.trend)} | ${stateText(s)} | ${flags(s)} |`)
    }
  }
  const om = omittedText(p, shown.length)
  if (om) lines.push(`(${om})`)
  return lines.join('\n') + '\n\n'
}

function panelLine(p: PanelDigest, format: 'markdown' | 'tsv'): string {
  const b = badge(p)
  const top = p.series[0]
  if (format === 'tsv') return `# ${p.id}\t${p.kind}\t${p.unit ?? ''}\t${b}\t${clean(p.title)}\t${p.seriesCount} series\n`
  const detail = p.kind === 'text' ? 'text' : p.noData ? 'no data' : `${p.seriesCount} series${top ? `, top ${clean(top.name)}=${formatNumber(top.value)}` : ''}`
  return `- ${b ? `[${b}] ` : ''}${clean(p.title)} (${p.id}): ${detail}\n`
}

/**
 * Render a dashboard digest as compact text within a token budget.
 *
 * Panels are ordered by importance: crit, warn, info, outliers, no data,
 * then the rest in layout order (`panelOrder`). Panels are written in full until one does
 * not fit; the remaining ones get a one-line summary while space lasts.
 * `cursor` continues from the first panel not shown in full. With `continuation: false`
 * no truncation footer is written; the caller says how to continue.
 */
export function renderDigest(d: DashboardDigest, opts: RenderOptions): RenderedDigest {
  const format = opts.format
  const budget = Math.max(0, Math.floor(opts.maxTokens * 4))
  const ordered = panelOrder(d.panels).map((i) => d.panels[i]!)
  const total = ordered.length
  const m = /^o:(\d+)$/.exec(opts.cursor ?? '')
  const offset = m ? Math.min(Number(m[1]), total) : 0

  const counts = { crit: 0, warn: 0, outlier: 0, nodata: 0 }
  for (const p of d.panels) {
    if (p.state === 'crit') counts.crit++
    else if (p.state === 'warn') counts.warn++
    if (p.outliers) counts.outlier++
    if (p.noData) counts.nodata++
  }
  const status = `${total} panels: ${counts.crit} crit, ${counts.warn} warn, ${counts.outlier} with outliers, ${counts.nodata} no data`
  let header: string
  if (format === 'tsv') {
    header = `# dashboard\t${d.id}\t${clean(d.title)}${d.revision ? `\trev ${d.revision.slice(0, 12)}` : ''}\n# ${status}\n`
    if (offset === 0 && d.variables) header += `# variables\t${Object.entries(d.variables).map(([k, v]) => `${k}=${v}`).join(' ')}\n`
    header += 'panel\tseries\tvalue\tmin\tmax\tmean\ttrend\tstate\tnotes\n'
  } else {
    header = `# ${clean(d.title)} (${d.id}${d.revision ? `, rev ${d.revision.slice(0, 12)}` : ''})\n`
    if (offset === 0) {
      header += cut(clean(d.intent), 300) + '\n'
      const ctx: string[] = []
      if (d.range) ctx.push(`range ${new Date(d.range.start * 1000).toISOString()} → ${new Date(d.range.end * 1000).toISOString()}`)
      if (d.variables) ctx.push('variables ' + Object.entries(d.variables).map(([k, v]) => `${k}=${v}`).join(' '))
      if (d.link) ctx.push(d.link)
      if (ctx.length) header += ctx.join('; ') + '\n'
    }
    header += status + '\n\n'
  }

  const footerFor = (next: number) =>
    format === 'tsv' ? `# truncated\tnext cursor o:${next}\t${total - next} of ${total} panels not shown in full\n` : `_Truncated: ${total - next} of ${total} panels not shown in full. Continue with cursor "o:${next}"._\n`
  const continuation = opts.continuation !== false
  const reserve = continuation ? footerFor(total).length + 2 : 0

  let text = header
  let full = 0
  let degraded = false
  const room = () => budget - reserve - text.length
  let i = offset
  for (; i < total; i++) {
    const p = ordered[i]!
    const block = panelBlock(p, format, p.series.length)
    if (block.length <= room()) {
      text += block
      full++
      continue
    }
    if (full === 0) {
      // Always make progress: abbreviate the first panel until it fits.
      degraded = true
      let placed = false
      for (let k = p.series.length - 1; k >= 0 && !placed; k--) {
        const b = panelBlock(p, format, k)
        if (b.length <= room()) {
          text += b
          placed = true
        }
      }
      if (!placed) {
        const line = panelLine(p, format)
        text += line.length <= room() ? line : cut(line.trimEnd(), Math.max(0, room() - 1)) + '\n'
      }
      full = 1
      i++
    }
    break
  }
  const next = offset + full
  // One-line summaries for what is left, while space lasts.
  let listed = 0
  if (next < total && format === 'markdown') {
    const lead = 'Also (summary only):\n'
    if (lead.length + panelLine(ordered[next]!, format).length <= room()) text += lead
    else listed = -1
  }
  for (let j = next; j < total && listed >= 0; j++) {
    const line = panelLine(ordered[j]!, format)
    if (line.length > room()) break
    text += line
    listed++
  }
  const truncated = degraded || next < total
  if (truncated && continuation) text += next < total ? footerFor(next) : format === 'tsv' ? '# truncated\tseries omitted to fit the budget\n' : '_Truncated: series omitted to fit the budget._\n'
  let cutOff = false
  if (text.length > budget) {
    text = text.slice(0, budget)
    cutOff = true
  }

  const out: RenderedDigest = { text, tokens: Math.ceil(text.length / 4), truncated: truncated || cutOff, panelsShown: degraded ? full - 1 : full, panelsTotal: total }
  if (next < total) out.cursor = `o:${next}`
  return out
}
