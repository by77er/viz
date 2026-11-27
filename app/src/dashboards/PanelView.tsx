import { memo, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { PromApiError } from '../api/client'
import { answerLine, errorKind } from '../api/errors'
import { Chart, figureFormat, toSpec } from '../charts'
import { reservedStyle } from '../charts/Chart'
import { chartRules } from '../charts/systemChart'
import { Age, useWaiting, WAIT } from '../explore/waiting'
import { alignSeries, seriesKey, type AlignedData, type SampleColumns } from '../lib/series'
import { stepWords, type TimeSpec } from '../lib/time'
import { LOCAL, zoneShiftMs } from '../lib/timeInput'
import { chartUnitOf, digestOf, exploreSearch, isDrawn, panelText, queryWords, rangeWords, type PanelDigest, type ResolvedDashboard, type ResolvedPanel, type Span } from './model'
import { NotSent, type DashboardStore, type PanelResult, type PanelState } from './store'

/** The series a stat panel shows as figures; the rest are in its text form, and the panel says how many. */
const STAT_FIGURES = 4
/** Rows a table panel reserves before its first answer when the spec gives no limit. */
const TABLE_ROWS = 5
const KIND_WORDS: Record<string, string> = { heatmap: 'heatmap', text: 'text note' }

interface Props {
  id: string
  span: Span
  /** The dashboard as it is resolved now: what the panel is while it has no answer yet. */
  resolved: ResolvedDashboard
  store: DashboardStore
  /** The dashboard's range as its address writes it: what "Open in Explore" carries. */
  from: TimeSpec
  to: TimeSpec
  /** `h2` under the page's title, `h3` under a row's heading. */
  level: 2 | 3
  onSignIn: () => void
}

/**
 * One panel. Everything it says about data (its queries, range, step, age, figures and text
 * form) comes from the answer that is drawn (`state.result`), never from what the page asks now;
 * while the two differ the head says "Showing the previous range".
 */
export const PanelView = memo(function PanelView({ id, span, resolved, store, from, to, level, onSignIn }: Props) {
  const state = useSyncExternalStore(
    (fn) => store.subscribe(id, fn),
    () => store.get(id),
  )
  const result = state.result
  // What is drawn is described by its own resolution; before any answer, by the current one.
  const shown = result?.resolved ?? resolved
  const panel = (shown.panels[id] ?? resolved.panels[id])!
  const current = resolved.panels[id]!
  const wait = useWaiting(state.waiting)
  const [textOpen, setTextOpen] = useState(false)
  const drawn = isDrawn(panel.kind)
  const titleId = `panel-${id.replace(/\./g, '-')}`
  const Heading = level === 2 ? 'h2' : 'h3'

  const digest = useMemo(() => (result && (textOpen || !drawn || panel.kind !== 'timeseries') ? digestOf(result.resolved, id, result.data, result.window, panel.kind === 'timeseries' ? 5 : 1000) : null), [result, textOpen, drawn, panel.kind, id])
  const text = useMemo(() => (result && digest && (textOpen || !drawn) ? panelText(result.resolved, digest) : null), [result, digest, textOpen, drawn])
  const seriesCount = useMemo(() => (result ? Object.values(result.data).reduce((n, s) => n + s.length, 0) : 0), [result])
  const hasQueries = current.kind !== 'text' && current.queries.length > 0
  const empty = !!result && hasQueries && seriesCount === 0

  const error = state.error
  const halted = state.halted
  const failed = error !== null || halted !== null
  const now = Date.now()

  const progress = wait.shown ? (
    <div className="vz-progress" data-unmeasured="" data-testid="panel-progress">
      <div className="vz-progress-text">
        <span role="status">{current.kind !== 'text' && current.queries.length > 1 ? `Waiting for ${current.queries.length} queries.` : 'Waiting for the query.'}</span>
        <span className="vz-qty" aria-hidden="true">
          {(wait.elapsedMs / 1000).toFixed(1)} s
        </span>
        {wait.elapsedMs >= WAIT.cancelAfter && state.waiting && (
          <button className="vz-progress-action" onClick={() => store.cancelPanel(id)} data-testid="panel-cancel" data-focus-after={`#${titleId}-retry`}>
            Cancel
          </button>
        )}
      </div>
    </div>
  ) : null

  let body: ReactNode
  if (failed && !state.waiting) body = <PanelError error={error} halted={halted} kind={panel.kind} retryId={`${titleId}-retry`} onRetry={() => store.reload(id)} onSignIn={onSignIn} />
  else if (!result) body = <Reserved panel={current} view={viewName(resolved, id)} />
  else if (!drawn) body = <NotDrawn kind={panel.kind} text={text ?? ''} />
  else if (empty) body = <Empty result={result} now={now} chart={panel.kind === 'timeseries'} />
  else if (panel.kind === 'timeseries') body = <ChartBody id={id} result={result} panel={panel} />
  else if (panel.kind === 'stat' && digest) body = <StatBody digest={digest} panel={panel} result={result} now={now} />
  else if (panel.kind === 'table' && digest) body = <TableBody digest={digest} panel={panel} />
  else body = null

  const queries = current.kind === 'text' ? [] : current.queries

  return (
    <section className="vz-panel" data-span={span === 6 ? undefined : span} aria-labelledby={titleId} aria-busy={state.waiting} data-testid="panel" data-panel={id} data-kind={panel.kind} data-state={state.waiting ? 'waiting' : failed ? 'failed' : result ? 'answered' : 'idle'}>
      <div className="vz-panel-head">
        <Heading className="vz-panel-title" id={titleId}>
          {panel.title}
        </Heading>
        {/*
          The meta has one place for both things it can say, as wide and as tall as the longer of them, so the head is the same
          height before the first answer, with an answer, and while a new range waits: nothing under it moves when the words change.
        */}
        <span className="meta-hold">
          {state.stale && result && !failed ? (
            <span className="vz-panel-meta" data-testid="panel-meta">
              <span className="vz-panel-note" data-testid="panel-stale" title={rangeWords(result.window.start, result.window.end, now)}>
                Showing the previous range<span className="vz-sr">: {rangeWords(result.window.start, result.window.end, now)}</span>
              </span>
            </span>
          ) : (
            <span className="vz-panel-meta is-reserved" aria-hidden="true">
              <span className="vz-panel-note">Showing the previous range</span>
            </span>
          )}
          {result && !failed && !state.stale && hasQueries ? (
            <span className="vz-panel-meta" data-testid="panel-meta">
              <span>
                every <span className="vz-qty">{stepWords(result.window.step)}</span>
              </span>
              <Age at={result.receivedAt} />
            </span>
          ) : (
            <span className="vz-panel-meta is-reserved" aria-hidden="true">
              <span>every 30 s</span>
              <span>· updated just now</span>
            </span>
          )}
        </span>
      </div>
      {'description' in panel && panel.description ? <p className="vz-panel-desc">{panel.description}</p> : null}
      <div className="vz-panel-body" data-view={panel.kind === 'timeseries' ? 'chart' : panel.kind}>
        {progress}
        {body}
      </div>
      {drawn && result && !failed && (
        <details className="vz-details" onToggle={(e) => setTextOpen((e.target as HTMLDetailsElement).open)} data-testid="panel-text">
          <summary>Text form</summary>
          {text !== null && (
            <pre className="vz-query code-scroll" tabIndex={0} aria-label={`Text form of ${panel.title}`} data-testid="panel-digest">
              {text}
            </pre>
          )}
        </details>
      )}
      {queries.length > 0 && (
        <ul className="vz-links" data-testid="panel-links">
          {queries.map((qid) => {
            const q = resolved.queries[qid]
            if (!q || q.error || q.lang !== 'promql') return null
            return (
              <li key={qid}>
                <Link to="/explore" search={exploreSearch(q.expr, from, to)} className="vz-link" data-testid="open-in-explore" data-query={qid}>
                  {queries.length > 1 ? `Open ${queryWords(current, qid, q.legend)} in Explore` : 'Open in Explore'}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
})

/** The name a panel's chart keeps its colours and its reserved height under, for the tab's session. */
const viewName = (resolved: ResolvedDashboard, id: string) => `dashboard:${resolved.metadata.id}:${id}`

/** A panel's place before its first answer: the height its body will have, with nothing drawn in it. */
function Reserved({ panel, view }: { panel: ResolvedPanel; view: string }) {
  if (panel.kind === 'timeseries') return <div className="vz-chart" style={reservedStyle(view)} data-testid="panel-reserved" />
  if (panel.kind === 'stat')
    return (
      <div className="vz-stat is-reserved" aria-hidden="true" data-testid="panel-reserved">
        <span className="vz-stat-value">0</span>
        <span className="vz-stat-context">Last value</span>
      </div>
    )
  if (panel.kind === 'table') {
    const rows = panel.options?.limit ?? TABLE_ROWS
    return <div className="panel-rows" style={{ '--rows': rows } as React.CSSProperties} data-testid="panel-reserved" />
  }
  return <div data-testid="panel-reserved" />
}

/** The series of every query of a panel on the window's grid, as the chart takes them. */
function alignedOf(result: PanelResult, panel: ResolvedPanel): AlignedData {
  const w = result.window
  const queries = panel.kind === 'text' ? [] : panel.queries
  const several = queries.length > 1
  let out: AlignedData | null = null
  for (const qid of queries) {
    const q = result.resolved.queries[qid]
    // Several queries in one chart: each series also says which query it answers, by the query's own name for it.
    const name = queryWords(panel, qid, q?.legend)
    const series: SampleColumns[] = (result.data[qid] ?? []).map((s) => (several ? { ...s, metric: { ...s.metric, query: name } } : (s as SampleColumns)))
    const a = alignSeries(series, w.start, w.end, w.step)
    if (!out) out = a
    else if (a.xs.length === out.xs.length) out = { xs: out.xs, series: [...out.series, ...a.series] }
  }
  return out ?? { xs: [], series: [] }
}

const ChartBody = memo(function ChartBody({ id, result, panel }: { id: string; result: PanelResult; panel: ResolvedPanel }) {
  const drawn = useMemo(() => {
    const aligned = alignedOf(result, panel)
    const shiftMs = zoneShiftMs(LOCAL, result.window.end * 1000)
    const queries = panel.kind === 'text' ? [] : panel.queries
    const query = result.resolved.queries[queries[0] ?? '']?.expr ?? panel.title
    let max = 0
    if (panel.kind === 'timeseries' && panel.unit === 'bytes/s') for (const s of aligned.series) for (let i = 0; i < s.values.length; i++) if (Math.abs(s.values[i]!) > max) max = Math.abs(s.values[i]!)
    const unit = chartUnitOf(panel.kind === 'timeseries' ? panel.unit : undefined, max)
    return { ...toSpec({ data: aligned, start: result.window.start, step: result.window.step, unit: 'none', as: unit, query, shiftMs }), shiftMs }
  }, [result, panel])
  return <Chart spec={drawn.spec} shiftMs={drawn.shiftMs} stepWords={stepWords(result.window.step)} view={viewName(result.resolved, id)} textFormId={`chart-text-${id}`} error={null} parked={false} />
})

const REDUCER_WORDS: Record<string, string> = { last: 'Last value', mean: 'Mean', min: 'Lowest value', max: 'Highest value', sum: 'Sum' }
const STATE: Record<string, { state: string; words: string }> = {
  ok: { state: 'ok', words: 'Within its thresholds' },
  info: { state: 'info', words: 'Past its information threshold' },
  warn: { state: 'warn', words: 'Past its warning threshold' },
  crit: { state: 'critical', words: 'Past its critical threshold' },
}

/** A figure in a panel's unit, as the chart would write it: the unit the chart picks for its size, and the chart's number format. */
function figure(unit: Parameters<typeof chartUnitOf>[0], v: number | null): { text: string; unit: string } {
  if (v === null || !Number.isFinite(v)) return { text: 'no value', unit: '' }
  // A count that is whole is written whole: "12", not "12.0".
  if ((unit === 'count' || unit === 'none' || unit === undefined) && Number.isInteger(v)) return { text: v.toLocaleString('en-US'), unit: '' }
  const u = chartUnitOf(unit, Math.abs(v))
  const f = figureFormat(chartRules(), u, Math.min(0, v), Math.max(0, v))
  return { text: f.value(v), unit: f.unit }
}

function StatBody({ digest, panel, result, now }: { digest: PanelDigest; panel: ResolvedPanel; result: PanelResult; now: number }) {
  if (panel.kind !== 'stat') return null
  const shown = digest.series.slice(0, STAT_FIGURES)
  const reducer = REDUCER_WORDS[panel.options?.reduce ?? 'last'] ?? 'Last value'
  const w = result.window
  return (
    <div className="vz-controls" data-testid="panel-stat">
      {shown.map((s) => {
        const f = figure(panel.unit, s.value)
        const st = s.state ? STATE[s.state] : null
        const limit = s.breached ? figure(panel.unit, Number(s.breached.slice(1))) : null
        return (
          <div className="vz-stat" key={seriesKey(s.labels) + (s.query ?? '')}>
            {digest.seriesCount > 1 && <span className="vz-label">{s.name}</span>}
            <span className="vz-stat-value" data-testid="stat-value">
              {f.text}
              {f.unit && <span className="vz-stat-unit">{f.unit}</span>}
            </span>
            <span className="vz-stat-context" data-testid="stat-context">
              {reducer} of {rangeWords(w.start, w.end, now)}.{' '}
              {st && (
                <span className="vz-status" data-state={st.state} data-testid="stat-state">
                  <span>
                    {st.words}
                    {limit && s.breached ? (
                      <>
                        : {s.breached.startsWith('>') ? 'above' : 'below'}{' '}
                        <span className="vz-qty">
                          {limit.text}
                          {limit.unit === '%' ? '%' : limit.unit ? ` ${limit.unit}` : ''}
                        </span>
                      </>
                    ) : null}
                  </span>
                </span>
              )}
            </span>
          </div>
        )
      })}
      {digest.seriesCount > shown.length && (
        <p className="vz-secondary" data-size="sm">
          <span className="vz-qty">{digest.seriesCount - shown.length}</span> more series are in the text form.
        </p>
      )}
    </div>
  )
}

function TableBody({ digest, panel }: { digest: PanelDigest; panel: ResolvedPanel }) {
  const table = useMemo(() => {
    if (panel.kind !== 'table') return null
    const columns = panel.options?.columns?.length ? panel.options.columns : panel.queries.map((q) => ({ query: q, title: undefined, unit: undefined }))
    // One row per label set; each query fills its column with the value the model reduced.
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
      return { query: c.query, title, head: format.unit ? `${title}, ${format.unit}` : title, value: format.value }
    })
    const sortTitle = heads.find((h) => h.query === sortBy)?.title
    const order = sortBy ? `${dir === 1 ? 'lowest' : 'highest'} ${sortTitle ?? sortBy} first` : `by ${keys.join(', ') || 'name'}`
    return { shown, total: all.length, keys, heads, order }
  }, [digest, panel])
  if (!table) return null
  return (
    <div data-testid="panel-table">
      <p className="vz-table-caption" data-testid="panel-table-caption">
        <span className="vz-qty">{table.shown.length}</span> of <span className="vz-qty">{table.total}</span> rows, {table.order}.
      </p>
      <div className="vz-table-wrap">
        <table className="vz-table">
          <thead>
            <tr>
              {table.keys.map((k) => (
                <th key={k} scope="col" className="vz-label">
                  {k}
                </th>
              ))}
              {table.heads.map((h) => (
                <th key={h.query} scope="col" className="vz-label vz-right">
                  {h.head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.shown.map((r) => (
              <tr key={seriesKey(r.labels)}>
                {table.keys.map((k, i) => (
                  <td key={k} className="vz-num" data-key={i === 0 ? '' : undefined}>
                    {r.labels[k] ?? 'none'}
                  </td>
                ))}
                {table.heads.map((h) => (
                  <td key={h.query} className="vz-num vz-right">
                    {r.values[h.query] == null ? 'none' : h.value(r.values[h.query]!)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** A kind of panel the app does not draw: said so, with the model's own text for it. Never drawn as another kind. */
function NotDrawn({ kind, text }: { kind: string; text: string }) {
  return (
    <div className="vz-stack" data-testid="panel-not-drawn">
      <p className="vz-secondary">
        This panel is a {KIND_WORDS[kind] ?? kind}, a kind this app does not draw yet. This is its text form.
      </p>
      <pre className={kind === 'text' ? 'vz-query code-scroll is-prose' : 'vz-query code-scroll'} tabIndex={0} aria-label="Text form of the panel" data-testid="panel-digest">
        {text}
      </pre>
    </div>
  )
}

function Empty({ result, now, chart }: { result: PanelResult; now: number; chart: boolean }) {
  // In a chart's place, at the chart's height (Empty): the panel is as tall with nothing in it as with something.
  return (
    <div className={chart ? 'vz-chart' : undefined}>
      <div className="vz-empty" role="status" data-testid="panel-empty">
        <p className="vz-empty-title">No series matched</p>
        <p>
          Nothing matched this panel's {Object.keys(result.data).length > 1 ? 'queries' : 'query'} in {rangeWords(result.window.start, result.window.end, now)}. Open it in Explore to check the metric name and the label
          matchers, or choose another time range.
        </p>
      </div>
    </div>
  )
}

function advice(error: unknown): string {
  if (error instanceof NotSent) return 'The query was not sent. The dashboard needs changing, which this app cannot do yet.'
  switch (errorKind(error)) {
    case 'network':
      return 'Check the connection, then run the panel again.'
    case 'auth':
      return 'The API no longer accepts the key this tab signed in with. Sign in again with a key that is valid now.'
    case 'scope':
      return 'The key this tab signed in with cannot read metrics. Sign in again with a key that has the read scope.'
    case 'busy':
      return 'The API was busy. Run the panel again in a moment.'
    case 'timeout':
      return 'The API stopped the query at its time limit. Choose a shorter time range, then run the panel again.'
    case 'limit':
    case 'resolution':
      return 'The query asks for more than the API allows over this range. Choose a shorter time range.'
    case 'unsupported':
      return 'viz does not run this part of PromQL yet. The dashboard\'s query needs changing, which this app cannot do yet.'
    case 'query':
      return 'The dashboard\'s query needs changing, which this app cannot do yet. Open it in Explore to see what the API refuses.'
    case 'server':
      return 'The API failed on its side. Run the panel again; if it keeps failing, note the time and report it.'
    default:
      return 'The answer was not an API response. Run the panel again.'
  }
}

/** This panel's failure, in this panel: the other panels are not touched by it. */
function PanelError({ error, halted, kind, retryId, onRetry, onSignIn }: { error: unknown; halted: 'cancelled' | 'stopped' | null; kind: string; retryId: string; onRetry: () => void; onSignIn: () => void }) {
  const k = errorKind(error)
  const again = (
    <button className="vz-button" data-size="sm" onClick={onRetry} id={retryId} data-testid="panel-retry">
      Run this panel again
    </button>
  )
  if (halted)
    return (
      <div className={kind === 'timeseries' ? 'vz-chart' : undefined}>
        <div className="vz-empty" role="status" data-testid="panel-halted">
          <p className="vz-empty-title">{halted === 'cancelled' ? 'Cancelled' : 'Stopped after 60 s without an answer'}</p>
          <p>{halted === 'cancelled' ? 'This panel\'s request was cancelled before it was answered.' : 'This panel\'s request was stopped. A shorter time range is answered sooner.'}</p>
          <div className="vz-controls">{again}</div>
        </div>
      </div>
    )
  const api = error instanceof PromApiError ? error : null
  return (
    <div className={kind === 'timeseries' ? 'vz-chart' : undefined}>
      <div className="vz-empty" role="alert" data-testid="panel-error" data-kind={error instanceof NotSent ? 'not-sent' : k}>
        <p className="vz-empty-title">
          <span className="vz-mark" data-state="critical" />
          This panel's query could not run
        </p>
        <p data-testid="panel-error-message">{error instanceof Error ? error.message : String(error)}</p>
        <p>
          {api ? `${answerLine(api)} ` : ''}
          {advice(error)}
        </p>
        {k === 'auth' || k === 'scope' ? (
          <div className="vz-controls">
            <button className="vz-button" data-size="sm" onClick={onSignIn}>
              Sign in again
            </button>
          </div>
        ) : error instanceof NotSent || k === 'unsupported' || k === 'query' ? null : (
          <div className="vz-controls">{again}</div>
        )}
      </div>
    </div>
  )
}

export type { PanelState }
