/**
 * Between the `viz.dashboard/v1` model (../../../dashboard/src: validation, variable and
 * fragment resolution, digests) and this app's views. Pure: no page, no client. Nothing of the
 * model is written again here: a spec is valid when the model's `validate` says so, a panel's
 * queries are what its `resolve` wrote, and a panel's text form is its `renderDigest`.
 */
import {
  digestPanel,
  renderDigest,
  resolve,
  validate,
  type Dashboard,
  type Issue,
  type PanelDigest,
  type PromMatrix,
  type ResolvedDashboard,
  type ResolvedLayout,
  type ResolvedPanel,
  type Unit,
  type Variable,
} from '../../../dashboard/src/index.ts'
import { chartUnit, type ChartUnit } from '../charts/spec'
import type { SampleColumns } from '../lib/series'
import { alignWindow, autoStep, type QueryWindow } from '../lib/step'
import { absoluteSpec, formatDuration, isValidTimeSpec, resolveTimeSpec, type TimeSpec } from '../lib/time'
import { LOCAL, readRange, type Zone } from '../lib/timeInput'

export type { Dashboard, Issue, PanelDigest, ResolvedDashboard, ResolvedPanel, Variable }

/** The kinds of panel this app draws. Every other kind of the model's catalog is shown as its text digest, and says so. */
export const DRAWN_KINDS = ['timeseries', 'stat', 'table'] as const
export type DrawnKind = (typeof DRAWN_KINDS)[number]
export const isDrawn = (kind: string): kind is DrawnKind => (DRAWN_KINDS as readonly string[]).includes(kind)

/** A spec as it arrived from the API: the model's own validation decides whether it is a dashboard. */
export function readSpec(raw: unknown): { ok: true; spec: Dashboard } | { ok: false; errors: Issue[] } {
  const v = validate(raw)
  return v.ok ? { ok: true, spec: raw as Dashboard } : { ok: false, errors: v.errors }
}

// ---- the address

/** What `/dashboards` reads from its address: the list's search and tag, or one dashboard's id, range and variable values. */
export interface DashboardsSearch {
  id?: string
  from?: TimeSpec
  to?: TimeSpec
  q?: string
  tag?: string
  [variable: `var.${string}`]: string | undefined
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined)

/** Untrusted search parameters as a dashboards address. Unknown keys are dropped; a time that is not one is dropped. */
export function parseDashboardsSearch(raw: Record<string, unknown>): DashboardsSearch {
  const out: DashboardsSearch = {}
  const id = str(raw.id)
  if (id && /^[a-z][a-z0-9_]{0,47}$/.test(id)) out.id = id
  const from = str(raw.from)
  const to = str(raw.to)
  if (from && isValidTimeSpec(from)) out.from = from
  if (to && isValidTimeSpec(to)) out.to = to
  const q = str(raw.q)
  if (q) out.q = q.slice(0, 200)
  const tag = str(raw.tag)
  if (tag) out.tag = tag.slice(0, 80)
  for (const [k, v] of Object.entries(raw)) {
    const s = str(v)
    if (k.startsWith('var.') && /^var\.[a-z][a-z0-9_]{0,47}$/.test(k) && s !== undefined) out[k as `var.${string}`] = s.slice(0, 200)
  }
  return out
}

/** The variable values an address carries, by variable name. */
export function variablesOf(search: DashboardsSearch): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(search)) if (k.startsWith('var.') && typeof v === 'string') out[k.slice(4)] = v
  return out
}

// ---- time

/** A time of a spec (`now`, `now-6h`, RFC 3339) in the form the app's time fields and addresses use; `fallback` when it is none of them. */
export function timeSpecOf(text: string | undefined, fallback: TimeSpec): TimeSpec {
  if (text === undefined) return fallback
  if (isValidTimeSpec(text) && !/^\d+$/.test(text)) return text
  const at = /^\d{4}-\d{2}-\d{2}T/.test(text) ? Date.parse(text) : NaN
  return Number.isFinite(at) ? String(at) : fallback
}

/** The range a dashboard is shown over: the address's when it gives one, else the spec's own, else the last hour. */
export function rangeOf(spec: Pick<Dashboard, 'time'> | null, search: DashboardsSearch): { from: TimeSpec; to: TimeSpec } {
  return { from: search.from ?? timeSpecOf(spec?.time?.from, 'now-1h'), to: search.to ?? timeSpecOf(spec?.time?.to, 'now') }
}

/**
 * The columns a panel's chart is asked for. One step for the whole dashboard, so every panel is
 * on the same grid: the automatic step of a chart this many pixels wide (lib/step).
 */
export const CHART_COLUMNS = 600

/** The window every panel of a dashboard is queried over, or null when the range is empty. */
export function windowOf(from: TimeSpec, to: TimeSpec, nowSec: number): QueryWindow | null {
  const start = resolveTimeSpec(from, nowSec)
  const end = resolveTimeSpec(to, nowSec)
  if (!(end > start)) return null
  return alignWindow(start, end, autoStep(end - start, CHART_COLUMNS))
}

/** The model's built-in variables for a window: the rate window covers at least four steps (and five minutes), the interval is the step. */
export function builtinsFor(w: QueryWindow): { __rate: string; __interval: string; __range: string } {
  return { __rate: formatDuration(Math.max(300, Math.ceil(w.step * 4))), __interval: formatDuration(w.step), __range: formatDuration(Math.round(w.end - w.start)) }
}

/** The model's resolution of a spec for the values an address carries and a window. */
export function resolveFor(spec: Dashboard, variables: Record<string, string>, w: QueryWindow | null): ResolvedDashboard {
  return resolve(spec, { variables, ...(w ? { builtins: builtinsFor(w) } : {}) })
}

// ---- layout

/** The widths the design system's dashboard grid has, in twelfths. */
export type Span = 3 | 4 | 6 | 12
export interface Placed {
  panel: string
  span: Span
}
/** A row of panels in the grid, under an optional heading. */
export interface Section {
  title?: string
  items: Placed[]
}

/** A width in twelfths as the grid has it: the nearest of 3, 4, 6 and 12. */
export function gridSpan(twelfths: number): Span {
  if (twelfths <= 3) return 3
  if (twelfths <= 4) return 4
  if (twelfths <= 8) return 6
  return 12
}

/**
 * A resolved layout as the sections the page draws, in the model's reading order. A row is a
 * section; a nested layout (a fragment instance) ends the row it is in and continues as its own
 * rows; an explicit grid is one section, its items in reading order (top to bottom, then left
 * to right), each as wide as its share of the grid's columns.
 */
export function sectionsOf(layout: ResolvedLayout): Section[] {
  if (layout.kind === 'grid') {
    const items = [...layout.items].sort((a, b) => a.y - b.y || a.x - b.x).map((it) => ({ panel: it.panel, span: gridSpan((it.w / layout.columns) * 12) }))
    return items.length ? [{ items }] : []
  }
  const out: Section[] = []
  for (const row of layout.rows) {
    let titled = row.title === undefined
    let current: Placed[] = []
    const take = (s: Section) => {
      if (!titled && s.title === undefined) s.title = row.title
      titled = true
      out.push(s)
    }
    const flush = () => {
      if (current.length) take({ items: current })
      current = []
    }
    const equal = gridSpan(12 / Math.max(1, row.items.length))
    for (const item of row.items) {
      if ('panel' in item) current.push({ panel: item.panel, span: item.span !== undefined ? gridSpan(item.span) : equal })
      else {
        flush()
        for (const s of sectionsOf(item.layout)) take(s)
      }
    }
    flush()
  }
  return out
}

// ---- units

/** A unit of the model as the chart takes it: the name it is given and what a value is multiplied by first (charts/spec.ts). */
export function chartUnitOf(unit: Unit | undefined, maxAbs = 0): ChartUnit {
  switch (unit) {
    case undefined:
    case 'none':
    case 'count':
      return { name: '', scale: 1 }
    case 'ratio':
      return { name: '%', scale: 100 }
    case 'percent':
      return { name: '%', scale: 1 }
    case 's':
      return { name: 's', scale: 1 }
    case 'ms':
      return { name: 'ms', scale: 1 }
    case 'us':
      return { name: 's', scale: 1e-6 }
    case 'ns':
      return { name: 's', scale: 1e-9 }
    case 'bytes':
      return { name: 'B', scale: 1 }
    case 'bytes/s':
      return chartUnit('bytes/s', maxAbs)
    case 'celsius':
      return { name: '°C', scale: 1 }
    case 'usd':
      return { name: 'USD', scale: 1 }
    default:
      // bits, bits/s, req/s, ops/s, events/s, rows/s, errors/s, cores: the name as the model writes it.
      return { name: unit, scale: 1 }
  }
}

// ---- variables

/**
 * A query variable's expression as the request that answers it. The model leaves evaluating it
 * to the caller; this app reads the one form the examples use, `label_values(<selector>, <label>)`
 * or `label_values(<label>)`, and says so for any other.
 */
export function labelValuesOf(expr: string): { label: string; match: string | null } | null {
  const m = /^\s*label_values\(\s*(?:(.+),\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*$/s.exec(expr)
  if (!m) return null
  return { label: m[2]!, match: m[1]?.trim() || null }
}

// ---- the text form

/** A result as the model's digest takes it: a Prometheus matrix, sample values as text. */
export function toProm(series: readonly SampleColumns[]): PromMatrix {
  return {
    resultType: 'matrix',
    result: series.map((s) => {
      const values: [number, string][] = new Array(s.times.length)
      for (let i = 0; i < s.times.length; i++) {
        const v = s.values[i]!
        values[i] = [s.times[i]!, Number.isNaN(v) ? 'NaN' : v === Infinity ? '+Inf' : v === -Infinity ? '-Inf' : String(v)]
      }
      return { metric: s.metric, values }
    }),
  }
}

/** The model's digest of one panel's data (by query id) over a window. `topK` series are kept, most important first. */
export function digestOf(resolved: ResolvedDashboard, id: string, data: Record<string, readonly SampleColumns[]>, w: QueryWindow | null, topK = 5): PanelDigest {
  const panel = resolved.panels[id]!
  const legends: Record<string, string> = {}
  if (panel.kind !== 'text') for (const q of panel.queries) if (resolved.queries[q]?.legend) legends[q] = resolved.queries[q]!.legend!
  const prom = Object.fromEntries(Object.entries(data).map(([q, series]) => [q, toProm(series)]))
  return digestPanel(panel, prom, { id, topK, legends, ...(w ? { start: w.start, end: w.end, step: w.step } : {}) })
}

/**
 * A panel's text form: the block the model's `renderDigest` writes for it (heading, description,
 * and its series as a table of value, range, trend, state and notes), without the dashboard's
 * own header lines.
 */
export function panelText(resolved: ResolvedDashboard, digest: PanelDigest): string {
  const text = renderDigest({ id: resolved.metadata.id, title: resolved.metadata.title, intent: resolved.metadata.intent, panels: [digest] }, { format: 'markdown', maxTokens: 4000, continuation: false }).text
  const at = text.indexOf('## ')
  return (at >= 0 ? text.slice(at) : text).trimEnd()
}

/** The whole dashboard's text form, as the model renders it for a reader that cannot see the panels. */
export function dashboardText(resolved: ResolvedDashboard, digests: PanelDigest[], w: QueryWindow | null): string {
  const variables = Object.entries(resolved.variables)
  return renderDigest(
    {
      id: resolved.metadata.id,
      title: resolved.metadata.title,
      intent: resolved.metadata.intent,
      revision: resolved.revision,
      panels: digests,
      ...(w ? { range: { start: w.start, end: w.end } } : {}),
      ...(variables.length ? { variables: Object.fromEntries(variables.map(([k, v]) => [k, v.all ? '*' : v.values.join('|')])) } : {}),
    },
    { format: 'markdown', maxTokens: 6000 },
  ).text.trimEnd()
}

/** What "Open in Explore" carries: the resolved query and the dashboard's range. */
export function exploreSearch(expr: string, from: TimeSpec, to: TimeSpec): { q: string; from: TimeSpec; to: TimeSpec } {
  return { q: expr, from, to }
}

/** A window as the time fields read a range, without its length and zone: "18 Nov, 09:30 to 12:30", or both days when it spans two. */
export function rangeWords(startSec: number, endSec: number, nowMs: number, zone: Zone = LOCAL): string {
  return readRange(absoluteSpec(startSec), absoluteSpec(endSec), nowMs, zone).text.split(', ').slice(0, -2).join(', ')
}

/** What a panel calls one of its queries where a person reads it: a table column's title, a fixed legend ("p95"), else the query's id. */
export function queryWords(panel: ResolvedPanel, qid: string, legend: string | undefined): string {
  if (panel.kind === 'table') {
    const title = panel.options?.columns?.find((c) => c.query === qid)?.title
    if (title) return title
  }
  return legend && !legend.includes('{{') ? legend : qid
}
