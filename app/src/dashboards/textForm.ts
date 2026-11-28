/**
 * A panel's figures and text form as a person reads them (D-M1 of the third design review): the
 * model's structured digest (`digestPanel`, ../../../dashboard/src) written as sentences in the
 * page's own units and time format, every series included, never the model's Markdown. The
 * Markdown digest (`renderDigest`) is kept for one use only: "Copy the digest for an agent".
 *
 * Formatting is the chart's (`figureFormat` over the system's rules), so a figure here reads as
 * the chart and the table write it. Runs in the page (the rules are the chart script's).
 */
import { chartRules, chartUnit, figureFormat } from '../charts'
import { seriesKey } from '../lib/series'
import type { QueryWindow } from '../lib/step'
import { stepWords } from '../lib/time'
import { inferUnit } from '../lib/units'
import { chartUnitOf, queryWords, rangeWords, type PanelDigest, type ResolvedDashboard, type ResolvedPanel } from './model'
import { notePlain } from './Note'

type Unit = Parameters<typeof chartUnitOf>[0]
type SeriesDigest = PanelDigest['series'][number]
type Level = 'info' | 'warn' | 'crit'

/** A figure and its unit as one piece of text: "8.4%", "312 req/s", "12". */
export const withUnit = (text: string, unit: string) => (unit === '' ? text : unit === '%' ? `${text}%` : `${text} ${unit}`)

const finite = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v)
/** One formatter for the page: `toLocaleString` with options builds a new one on every call, which a profile found costly (D-B2). */
const WHOLE = new Intl.NumberFormat('en-US')
const EXACT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 })

/** One number format for a set of figures in a unit, as the chart would write them (the unit it picks for the largest, its decimals). */
export function formatFor(unit: Unit, values: readonly (number | null | undefined)[]): { unit: string; value: (v: number | null | undefined) => string } {
  const vs = values.filter(finite)
  if ((unit === undefined || unit === 'none' || unit === 'count') && vs.every((v) => Number.isInteger(v))) return { unit: '', value: (v) => (finite(v) ? WHOLE.format(v) : 'no value') }
  const lo = Math.min(0, ...vs)
  const hi = Math.max(0, ...vs)
  const f = figureFormat(chartRules(), chartUnitOf(unit, Math.max(Math.abs(lo), Math.abs(hi))), lo, hi)
  return { unit: f.unit, value: (v) => (finite(v) ? withUnit(f.value(v), f.unit) : 'no value') }
}

/** A value a person wrote (a threshold) in the unit a figure is read in, with no more digits than it has: "2%", "1 s", "8 GiB". */
export function exactFigure(unit: Unit, v: number): string {
  const cu = chartUnitOf(unit, Math.abs(v))
  const scaled = chartRules().scaleUnit(cu.name, Math.abs(v) * cu.scale)
  const n = (v * cu.scale) / scaled.div
  return withUnit(`${EXACT.format(Number(n.toPrecision(3)))}${scaled.suffix}`, scaled.unit)
}

export const LEVEL_WORDS: Record<Level, string> = { info: 'information', warn: 'warning', crit: 'critical' }

/** A panel's thresholds as words, from its spec: "above 2% (warning) and above 5% (critical)"; null without any. */
export function thresholdWords(panel: ResolvedPanel): string | null {
  const ts = 'thresholds' in panel ? panel.thresholds : undefined
  if (!ts?.length) return null
  const unit = 'unit' in panel ? panel.unit : undefined
  const parts = ts.map((t) => `${'above' in t ? 'above' : 'below'} ${exactFigure(unit, 'above' in t ? t.above : t.below)} (${t.label ?? LEVEL_WORDS[t.level as Level] ?? t.level})`)
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** A table panel's rows: one per label set, one column per query, sorted and cut as the spec says. */
export interface PanelTable {
  rows: { labels: Record<string, string>; values: Record<string, number | null> }[]
  shown: { labels: Record<string, string>; values: Record<string, number | null> }[]
  total: number
  keys: string[]
  heads: { query: string; title: string; head: string; unit: string; value: (raw: number | null) => string }[]
  order: string
}

export function tableOf(digest: PanelDigest, panel: ResolvedPanel): PanelTable | null {
  if (panel.kind !== 'table') return null
  const columns = panel.options?.columns?.length ? panel.options.columns : panel.queries.map((q) => ({ query: q, title: undefined, unit: undefined }))
  const rows = new Map<string, { labels: Record<string, string>; values: Record<string, number | null> }>()
  for (const s of digest.series) {
    const labels = Object.fromEntries(Object.entries(s.labels).filter(([k]) => k !== '__name__'))
    const key = seriesKey(labels)
    let row = rows.get(key)
    if (!row) rows.set(key, (row = { labels, values: {} }))
    row.values[s.query ?? columns[0]!.query] = s.value
  }
  const all = [...rows.values()]
  const names = [...new Set(all.flatMap((r) => Object.keys(r.labels)))].sort()
  const labelColumns = names.filter((n) => new Set(all.map((r) => r.labels[n])).size > 1)
  const keys = labelColumns.length ? labelColumns : names.slice(0, 1)
  const sortBy = panel.options?.sortBy
  const dir = panel.options?.sortDir === 'asc' ? 1 : -1
  if (sortBy) all.sort((a, b) => dir * ((a.values[sortBy] ?? -Infinity) - (b.values[sortBy] ?? -Infinity)))
  else all.sort((a, b) => (seriesKey(a.labels) < seriesKey(b.labels) ? -1 : 1))
  const shown = all.slice(0, panel.options?.limit ?? all.length)
  const heads = columns.map((c) => {
    const unit = c.unit ?? panel.unit
    let lo = 0
    let hi = 0
    for (const r of all) {
      const v = r.values[c.query]
      if (v != null && Number.isFinite(v)) {
        lo = Math.min(lo, v)
        hi = Math.max(hi, v)
      }
    }
    const format = figureFormat(chartRules(), chartUnitOf(unit, Math.max(Math.abs(lo), Math.abs(hi))), lo, hi)
    const title = c.title ?? c.query
    return { query: c.query, title, head: format.unit ? `${title}, ${format.unit}` : title, unit: format.unit, value: format.value }
  })
  const sortTitle = heads.find((h) => h.query === sortBy)?.title
  const order = sortBy ? `${dir === 1 ? 'lowest' : 'highest'} ${sortTitle ?? sortBy} first` : `by ${keys.join(', ') || 'name'}`
  return { rows: all, shown, total: all.length, keys, heads, order }
}

/** A histogram's buckets (series with an `le` label), in bucket order, `+Inf` last. */
export interface Buckets {
  /** The values' unit, from the query: "/s" for a rate. */
  valueUnit: string
  /** `bound`: the bucket's upper bound with its own unit ("50 ms", "1 s"). */
  rows: { le: string; bound: string; last: number | null; min: number | null; max: number | null }[]
  value: (v: number | null | undefined) => string
}

export function bucketsOf(digest: PanelDigest, panel: ResolvedPanel, resolved: ResolvedDashboard): Buckets | null {
  if (!digest.series.length || !digest.series.every((s) => s.labels.le !== undefined)) return null
  const unit = 'unit' in panel ? panel.unit : undefined
  const expr = panel.kind === 'text' ? '' : (resolved.queries[panel.queries[0] ?? '']?.expr ?? '')
  const vu = chartUnit(inferUnit(expr), 0)
  const num = (le: string) => (le === '+Inf' ? Infinity : Number(le))
  const sorted = [...digest.series].sort((a, b) => num(a.labels.le!) - num(b.labels.le!))
  const fmt = formatFor(undefined, sorted.flatMap((s) => [s.last, s.min, s.max]))
  const values = sorted.flatMap((s) => [s.last, s.min, s.max]).filter(finite)
  const lo = Math.min(0, ...values)
  const hi = Math.max(0, ...values)
  const f = figureFormat(chartRules(), vu, lo, hi)
  return {
    valueUnit: f.unit,
    rows: sorted.map((s) => ({ le: s.labels.le!, bound: s.labels.le === '+Inf' ? 'any' : exactFigure(unit, Number(s.labels.le)), last: s.last, min: s.min, max: s.max })),
    value: vu.name === '' ? fmt.value : (v) => (finite(v) ? f.value(v) : 'no value'),
  }
}

const KIND: Record<string, string> = { timeseries: 'chart', stat: 'figure', table: 'table', heatmap: 'heatmap', text: 'note' }
const REDUCED: Record<string, string> = { last: 'last value', mean: 'mean', min: 'lowest value', max: 'highest value', sum: 'sum' }

function trendWords(s: SeriesDigest): string {
  const t = s.trend
  if (!t || t.direction === 'flat') return t ? ', about level over the range' : ''
  const pct = t.relChange !== null && Number.isFinite(t.relChange) ? ` by ${Math.round(Math.abs(t.relChange) * 100)}%` : ''
  return `, ${t.direction === 'up' ? 'rising' : 'falling'}${pct} over the range`
}

/** Who wrote a dashboard, when an agent did and no person has saved over it (D-B1): its name. */
export type AgentName = string | null

/**
 * A panel's text form as sentences: what it is and over which range, its explanation (marked as
 * the agent's when an agent wrote it), its thresholds, and every one of its series, rows or
 * buckets. `nowMs` is the page's clock for the range's words.
 */
export function panelSentences(resolved: ResolvedDashboard, id: string, digest: PanelDigest, w: QueryWindow, nowMs: number, agent: AgentName): string[] {
  const panel = resolved.panels[id]!
  const out: string[] = []
  const unit = 'unit' in panel ? panel.unit : undefined
  const range = rangeWords(w.start, w.end, nowMs)
  const n = digest.seriesCount
  if (panel.kind === 'text') {
    out.push(`${panel.title}. A note.`)
    const lines = notePlain(panel.content)
    if (agent) out.push(`Agent: ${lines.join(' ')} Not verified.`)
    else out.push(...lines)
    return out
  }
  const all = [...digest.series].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity))
  const f = formatFor(unit, all.flatMap((s) => [s.value, s.last, s.min, s.max]))
  const counted = panel.kind === 'table' ? '' : n === 1 ? ', one series' : `, ${n} series`
  out.push(`${panel.title}. A ${KIND[panel.kind] ?? panel.kind}${counted}${f.unit ? ` in ${f.unit}` : ''}, ${range}, every ${stepWords(w.step)}.`)
  if (panel.description) out.push(agent ? `Agent: ${panel.description} Not verified.` : panel.description)
  const th = thresholdWords(panel)
  if (th) out.push(agent ? `Agent's thresholds: ${th}. Not verified.` : `Thresholds: ${th}.`)
  if (digest.noData) {
    out.push(`No series matched in ${range}.`)
    return out
  }
  const state = (s: SeriesDigest) => (s.state && s.state !== 'ok' ? `; past its ${LEVEL_WORDS[s.state as Level]} threshold` : '')
  if (panel.kind === 'stat') {
    const reduced = REDUCED[panel.options?.reduce ?? 'last'] ?? 'last value'
    for (const s of all) out.push(`${n > 1 ? `${s.name}: ` : ''}${n > 1 ? reduced : reduced[0]!.toUpperCase() + reduced.slice(1)} ${f.value(s.value)}${s.state ? (s.state === 'ok' ? '; within its thresholds' : state(s)) : ''}.`)
    return out
  }
  if (panel.kind === 'table') {
    const t = tableOf(digest, panel)
    if (!t) return out
    out.push(`${t.total} rows, ${t.order}${t.shown.length < t.total ? `; the panel shows the first ${t.shown.length}` : ''}.`)
    for (const r of t.rows) out.push(`${t.keys.map((k) => r.labels[k] ?? 'none').join(' ')}: ${t.heads.map((h) => `${h.title} ${r.values[h.query] == null ? 'no value' : withUnit(h.value(r.values[h.query]!), h.unit)}`).join(', ')}.`)
    return out
  }
  if (panel.kind === 'heatmap') {
    const b = bucketsOf(digest, panel, resolved)
    if (b) {
      out.push(`${b.rows.length} buckets, shortest first. Each counts what took at most its duration, so each includes the ones before it.`)
      for (const r of b.rows) out.push(`${r.le === '+Inf' ? 'Any duration' : `At most ${r.bound}`}: last ${withUnit(b.value(r.last), b.valueUnit)}, lowest ${withUnit(b.value(r.min), b.valueUnit)}, highest ${withUnit(b.value(r.max), b.valueUnit)}.`)
      return out
    }
  }
  for (const s of all) out.push(`${s.name || queryWords(panel, s.query ?? '', undefined)}: last ${f.value(s.last)}, lowest ${f.value(s.min)}, highest ${f.value(s.max)}${trendWords(s)}${s.gaps.count > 0 ? '; no data for part of the range' : ''}${state(s)}.`)
  return out
}
