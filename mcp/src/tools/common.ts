import {
  type Dashboard,
  type PanelDigest,
  type PromData as DigestData,
  type ResolvedDashboard,
  digestPanel,
  resolve,
} from '../../../dashboard/src/index.ts'
import { ArgError, autoStep, formatDuration, isoOf, parseStep, parseTime } from '../args'
import type { ControlResponse, PromData } from '../clients'
import type { CursorState } from '../page'
import { decodeCursor, CursorError } from '../page'
import { didYouMean } from '../suggest'
import { parsePromQL, selectorsOf } from '../promql'
import { type Session, mapBounded } from '../session'
import { ToolError } from '../tool'
import { clean, cleanLabels, MAX } from '../untrusted'

// ---- cursors and ranges ----

export function cursorOf(tool: string, args: Record<string, unknown>): CursorState | null {
  if (args.cursor === undefined) return null
  try {
    return decodeCursor(String(args.cursor), tool, args)
  } catch (e) {
    if (e instanceof CursorError) throw new ToolError('bad-cursor', e.message, 'Call again without "cursor" to start from the first page.')
    throw e
  }
}

export interface TimeRange {
  start: number
  end: number
  step: number
}

/**
 * The absolute range of a call: from the cursor when continuing (so later pages read the
 * same window), else from the arguments, else from the defaults.
 */
export function rangeOf(s: Session, args: Record<string, unknown>, c: CursorState | null, dflt: { from: string; to: string } = { from: 'now-1h', to: 'now' }): TimeRange {
  const p = c?.p as { s?: unknown; e?: unknown; st?: unknown } | undefined
  if (p && typeof p.s === 'number' && typeof p.e === 'number' && typeof p.st === 'number') return { start: p.s, end: p.e, step: p.st }
  try {
    const start = parseTime(args.from ?? dflt.from, s.now, '/from')
    const end = parseTime(args.to ?? dflt.to, s.now, '/to')
    if (end <= start) throw new ArgError('/to', 'must be after "from"')
    let step = args.step !== undefined ? parseStep(args.step, '/step') : autoStep(start, end)
    if ((end - start) / step + 1 > s.limits.maxPoints) {
      if (args.step !== undefined) throw new ArgError('/step', `gives more than ${s.limits.maxPoints} points over this range`, `Use a step of at least ${formatDuration(Math.ceil((end - start) / (s.limits.maxPoints - 1)))}.`)
      step = Math.ceil((end - start) / (s.limits.maxPoints - 1))
    }
    return { start, end, step }
  } catch (e) {
    if (e instanceof ArgError) throw new ToolError('invalid-arguments', `Argument ${e.path} ${e.message}.`, e.suggestion ?? 'Fix the argument and call again.')
    throw e
  }
}

export const pinRange = (r: TimeRange): Record<string, unknown> => ({ s: r.start, e: r.end, st: r.step })

export const rangeText = (r: TimeRange): string => `${isoOf(r.start)} → ${isoOf(r.end)}, step ${formatDuration(r.step)}`

/** The app's Explore view for one expression with the range pinned (app/README.md: q, from, to, step, unit as search params; times in ms). */
export function exploreLink(appUrl: string, expr: string, r: TimeRange, unit?: string): string {
  const p = new URLSearchParams({ q: expr, from: String(Math.round(r.start * 1000)), to: String(Math.round(r.end * 1000)), step: formatDuration(r.step) })
  if (unit && /^[a-z0-9/_-]{1,16}$/i.test(unit)) p.set('unit', unit)
  return `${appUrl.replace(/\/+$/, '')}/explore?${p}`
}

// ---- metric metadata, inferred where the query service has none ----

export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary' | 'unknown'

export function inferType(name: string, meta?: { type?: string }): { type: MetricType; source: 'metadata' | 'name' } {
  const t = meta?.type
  if (t === 'counter' || t === 'gauge' || t === 'histogram' || t === 'summary') return { type: t, source: 'metadata' }
  if (/_bucket$/.test(name)) return { type: 'histogram', source: 'name' }
  if (/_(total|count|sum)$/.test(name)) return { type: 'counter', source: 'name' }
  return { type: name.includes('_') ? 'gauge' : 'unknown', source: 'name' }
}

export function inferUnit(name: string, meta?: { unit?: string }): string {
  if (meta?.unit) return meta.unit
  const n = name.replace(/_(total|count|sum|bucket)$/, '')
  if (/_seconds$/.test(n)) return 's'
  if (/_milliseconds$|_ms$/.test(n)) return 'ms'
  if (/_bytes$/.test(n)) return 'bytes'
  if (/_ratio$/.test(n)) return 'ratio'
  if (/_percent$/.test(n)) return 'percent'
  if (/_celsius$/.test(n)) return 'celsius'
  if (/_cores$/.test(n)) return 'cores'
  return 'none'
}

export const looksLikeCounter = (name: string): boolean => /_(total|count|sum|bucket)$/.test(name)

// ---- the control plane's answers ----

/** A control-plane refusal as a ToolError. Its detail text can name tenant things, so it is shown as data. */
export function controlError(r: ControlResponse, what: string): ToolError {
  const b = (r.body ?? {}) as { code?: unknown; detail?: unknown; fix?: unknown; errors?: unknown }
  const code = typeof b.code === 'string' && /^[a-z0-9-]{1,40}$/.test(b.code) ? b.code : `control-${r.status}`
  const detail = [typeof b.detail === 'string' ? `detail: ${clean(b.detail, { max: MAX.error })}` : '', typeof b.fix === 'string' ? `fix: ${clean(b.fix, { max: MAX.error })}` : '']
    .filter(Boolean)
    .join('\n')
  const fixes: Record<number, string> = {
    401: 'Use a key that is enabled and not expired.',
    403: 'Use a key with the scope the control plane names in the detail, or propose the change instead.',
    404: 'Use an id from search_dashboards; ids of other tenants never resolve.',
    409: 'Read the dashboard again (get_dashboard) and rebuild the change against its current revision.',
    422: 'Fix what the detail lists and call again.',
  }
  return new ToolError(code, `The control plane refused to ${what} (HTTP ${r.status}).`, fixes[r.status] ?? 'Retry; if it keeps failing, report the time of the call.', {
    status: r.status >= 400 && r.status < 600 ? r.status : 502,
    ...(detail ? { detail } : {}),
  })
}

// ---- running a dashboard's panels ----

export interface PanelRun {
  id: string
  digest: PanelDigest
  /** Why the digest is incomplete, if it is. */
  problem?: { kind: 'error' | 'deadline' | 'limit' | 'unsupported' | 'substitution'; text: string }
  /** First promql expression, resolved, for the deep link. */
  expr?: string
  /** Metric names the panel's queries read that this tenant does not have. */
  unknownMetrics: { name: string; suggestions: string[] }[]
}

export function builtinsFor(r: TimeRange): Record<'__rate' | '__interval' | '__range', string> {
  return { __interval: formatDuration(r.step), __rate: formatDuration(Math.max(r.step + 15, 60)), __range: formatDuration(Math.max(1, Math.round(r.end - r.start))) }
}

export function resolveSpec(spec: Dashboard, variables: Record<string, string | string[]> | undefined, r: TimeRange): ResolvedDashboard {
  return resolve(spec, { variables: variables ?? {}, builtins: builtinsFor(r) })
}

const asDigestData = (d: PromData): DigestData | null => {
  if (d.resultType === 'matrix' || d.resultType === 'vector') return d as DigestData
  if (d.resultType === 'scalar') return { resultType: 'vector', result: [{ metric: {}, value: d.result }] }
  return null
}

/**
 * Evaluate the panels `ids` of a resolved dashboard: every PromQL query once (identical
 * queries are shared), at most `maxParallel` in flight, nothing started after the
 * deadline. Each panel gets a digest from `digestPanel` and, when something is missing, a
 * problem saying what and why. Never throws for a query failure.
 */
export async function runPanels(s: Session, resolved: ResolvedDashboard, ids: string[], r: TimeRange, opts: { topK: number; checkNames?: boolean }): Promise<PanelRun[]> {
  type Job = { expr: string; instant: boolean }
  const jobs = new Map<string, Job>()
  const keyOf = (j: Job) => `${j.instant ? 'i' : 'r'}:${j.expr}`
  for (const id of ids) {
    const p = resolved.panels[id]!
    if (p.kind === 'text') continue
    for (const q of p.queries) {
      const rq = resolved.queries[q]
      if (!rq || rq.error || rq.lang !== 'promql') continue
      const job = { expr: rq.expr, instant: rq.instant === true }
      jobs.set(keyOf(job), job)
    }
  }
  const list = [...jobs.values()]
  const settled = await mapBounded(list, s.limits.maxParallel, s.deadline, async (job, signal) => {
    s.usage.queries++
    s.usage.upstreamCalls++
    const timeout = Math.max(0.05, Math.min(s.limits.queryTimeoutMs, s.deadline - performance.now()) / 1000)
    return job.instant ? s.query.instant(job.expr, r.end, { timeout, signal }) : s.query.range(job.expr, r.start, r.end, r.step, { timeout, signal })
  })
  const results = new Map<string, (typeof settled)[number]>()
  list.forEach((j, i) => results.set(keyOf(j), settled[i]!))

  const names = opts.checkNames ? new Set(await s.metricNames()) : null
  const out: PanelRun[] = []
  for (const id of ids) {
    const p = resolved.panels[id]!
    const legends: Record<string, string> = {}
    const data: Record<string, DigestData> = {}
    let problem: PanelRun['problem']
    let expr: string | undefined
    const unknownMetrics: PanelRun['unknownMetrics'] = []
    if (p.kind !== 'text') {
      for (const q of p.queries) {
        const rq = resolved.queries[q]
        if (!rq) continue
        if (rq.legend) legends[q] = rq.legend
        if (rq.error) {
          problem ??= { kind: 'substitution', text: `query ${q}: ${rq.error}` }
          continue
        }
        if (rq.lang !== 'promql') {
          problem ??= { kind: 'unsupported', text: `query ${q} is ${rq.lang === 'traceql' ? 'TraceQL' : 'LogQL'}, which is not available yet` }
          continue
        }
        expr ??= rq.expr
        if (names) {
          try {
            for (const sel of [] as ReturnType<typeof selectorsOf>) {
              const n = sel.node.name
              if (n !== undefined && !names.has(n) && !unknownMetrics.some((u) => u.name === n)) unknownMetrics.push({ name: n, suggestions: didYouMean(n, names) })
            }
          } catch {
            /* the query service reports syntax errors */
          }
        }
        const res = results.get(keyOf({ expr: rq.expr, instant: rq.instant === true }))!
        if (!res.ok) {
          problem ??= res.reason === 'deadline' ? { kind: 'deadline', text: 'not evaluated: the call reached its deadline first' } : { kind: 'error', text: `query ${q} failed` }
          continue
        }
        if (!res.value.ok) {
          problem ??= res.value.errorType === 'timeout' && performance.now() >= s.deadline
            ? { kind: 'deadline', text: 'not evaluated: the call reached its deadline first' }
            : { kind: 'error', text: `query ${q} failed (${res.value.errorType}): ${res.value.error}` }
          continue
        }
        const d = asDigestData(res.value.data)
        if (d) {
          data[q] = d
          s.usage.series += d.result.length
          if (d.resultType === 'matrix') for (const x of d.result) s.usage.points += x.values.length
          else s.usage.points += d.result.length
        }
      }
    }
    const digest = digestPanel(p, Object.keys(data).length === 1 && p.kind !== 'text' && p.queries.length === 1 ? data[p.queries[0]!] : data, {
      id,
      topK: opts.topK,
      step: r.step,
      start: r.start,
      end: r.end,
      legends,
    })
    out.push({ id, digest, ...(problem ? { problem } : {}), ...(expr ? { expr } : {}), unknownMetrics })
  }
  return out
}

/** A panel digest with every string that came from the tenant cleaned, ready to render. */
export function cleanDigest(d: PanelDigest): PanelDigest {
  return {
    ...d,
    id: clean(d.id, { max: MAX.name }),
    title: clean(d.title, { max: MAX.title }),
    ...(d.description !== undefined ? { description: clean(d.description, { max: MAX.text }) } : {}),
    ...(d.text !== undefined ? { text: clean(d.text, { max: MAX.long }) } : {}),
    series: d.series.map((x) => ({ ...x, name: clean(x.name, { max: MAX.label }), labels: cleanLabels(x.labels), ...(x.query !== undefined ? { query: clean(x.query, { max: MAX.name }) } : {}) })),
  }
}

export function badgeOf(d: PanelDigest, problem?: PanelRun['problem']): string {
  if (problem && problem.kind !== 'limit') return problem.kind === 'error' ? 'QUERY FAILED' : problem.kind === 'deadline' ? 'NOT EVALUATED' : problem.kind === 'unsupported' ? 'NOT AVAILABLE' : 'QUERY INVALID'
  if (d.noData) return 'NO DATA'
  if (d.state && d.state !== 'ok') return d.state.toUpperCase()
  if (d.outliers) return 'OUTLIER'
  return d.state === 'ok' ? 'ok' : ''
}
