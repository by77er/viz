import { memo, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { PromApiError } from '../api/client'
import { answerLine, errorKind } from '../api/errors'
import { Chart, toSpec } from '../charts'
import { reservedStyle } from '../charts/Chart'
import { Age, useWaiting, WAIT } from '../explore/waiting'
import { alignSeries, seriesKey, type AlignedData, type SampleColumns } from '../lib/series'
import { stepWords, type TimeSpec } from '../lib/time'
import { LOCAL, zoneShiftMs } from '../lib/timeInput'
import type { DashboardColours } from './colours'
import { chartUnitOf, digestOf, exploreSearch, isDrawn, queryWords, rangeWords, type PanelDigest, type ResolvedDashboard, type ResolvedPanel, type Span } from './model'
import { drawSoon, nearNow } from './drawSoon'
import { Note } from './Note'
import { NotSent, type DashboardStore, type PanelResult, type PanelState } from './store'
import { bucketsOf, formatFor, panelSentences, tableOf, thresholdWords, withUnit, type AgentName } from './textForm'

/** The series a stat panel shows as figures; the rest are in its text form, and the panel says how many. */
const STAT_FIGURES = 4
/** Rows a table panel reserves before its first answer when the spec gives no limit. */
const TABLE_ROWS = 5
const KIND_WORDS: Record<string, string> = { heatmap: 'heatmap', text: 'text note' }

/**
 * A chart is drawn in the task its answer arrives when its panel is within ten screens of the
 * window; the others wait in their reserved place (the height their chart draws) and are drawn as
 * they come near, when the page is idle, or at once in the frame that brings them into view,
 * whichever comes first (`drawSoon.ts`: D-B2 of the third design review, D-B3 of the fourth).
 */
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
  /** The agent that wrote the dashboard while no person has saved over it (D-B1): its words are marked as the agent's. */
  agent: AgentName
  /** The dashboard's one colour per series identity (D-M2). */
  colours: DashboardColours
  /** The range the page asks for now, as words: what the head would say of it while a later one waits. */
  rangeNow: string
}

/**
 * One panel. Everything it says about data (its queries, range, step, age, figures and text
 * form) comes from the answer that is drawn (`state.result`), never from what the page asks now;
 * while the two differ the head says "Showing the previous range".
 */
export const PanelView = memo(function PanelView({ id, span, resolved, store, from, to, level, onSignIn, agent, colours, rangeNow }: Props) {
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

  // The model's structured digest: every series (the text form leaves none out), computed for a figure, a table, a kind not drawn, or an open text form.
  const digest = useMemo(() => (result && (textOpen || !drawn || panel.kind !== 'timeseries') ? digestOf(result.resolved, id, result.data, result.window, 100_000) : null), [result, textOpen, drawn, panel.kind, id])
  const sentences = useMemo(() => (result && digest && textOpen ? panelSentences(result.resolved, id, digest, result.window, Date.now(), agent) : null), [result, digest, textOpen, id, agent])
  const sectionRef = useRef<HTMLElement>(null)
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
  else if (!result) body = <Reserved panel={current} view={viewName(resolved, id)} agent={agent} />
  else if (!drawn) body = <NotDrawn panel={panel} digest={digest} result={result} now={now} level={level} agent={agent} />
  else if (empty) body = <Empty result={result} now={now} chart={panel.kind === 'timeseries'} />
  else if (panel.kind === 'timeseries') body = <DeferredChart id={id} result={result} panel={panel} colours={colours} place={sectionRef} />
  else if (panel.kind === 'stat' && digest) body = <StatBody digest={digest} panel={panel} result={result} now={now} agent={agent} />
  else if (panel.kind === 'table' && digest) body = <TableBody digest={digest} panel={panel} />
  else body = null

  const queries = current.kind === 'text' ? [] : current.queries

  return (
    <section ref={sectionRef} className="vz-panel" data-span={span === 6 ? undefined : span} aria-labelledby={titleId} aria-busy={state.waiting} data-testid="panel" data-panel={id} data-kind={panel.kind} data-state={state.waiting ? 'waiting' : failed ? 'failed' : result ? 'answered' : 'idle'}>
      <div className="vz-panel-head">
        <Heading className={agent ? 'vz-panel-title vz-agent' : 'vz-panel-title'} id={titleId} data-testid="panel-title">
          {agent && <span className="vz-sr">The agent's title: </span>}
          {panel.title}
        </Heading>
        {/*
          The meta has one place for both things it can say, as wide and as tall as the longer of them, so the head is the same
          height before the first answer, with an answer, and while a new range waits: nothing under it moves when the words change.
        */}
        <span className="meta-hold">
          {state.stale && result && !failed ? (
            <span className="vz-panel-meta" data-testid="panel-meta">
              <span className="vz-panel-note" data-testid="panel-stale">
                Showing {rangeWords(result.window.start, result.window.end, now)}, the previous range
              </span>
            </span>
          ) : (
            // The words it would say, at their length: the answer's own range once there is one, else the range asked for now.
            <span className="vz-panel-meta is-reserved" aria-hidden="true">
              <span className="vz-panel-note">Showing {result ? rangeWords(result.window.start, result.window.end, now) : rangeNow}, the previous range</span>
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
      {'description' in panel && panel.description ? (
        agent ? (
          <p className="vz-panel-desc vz-agent" data-testid="panel-desc">
            Agent: {panel.description} Not verified.
          </p>
        ) : (
          <p className="vz-panel-desc" data-testid="panel-desc">
            {panel.description}
          </p>
        )
      ) : null}
      <div className="vz-panel-body" data-view={panel.kind === 'timeseries' ? 'chart' : panel.kind}>
        {progress}
        {body}
      </div>
      {/* Its place is kept before the first answer (not seen, not reachable), so the panel is as tall waiting as answered. */}
      {drawn && !failed && !result && (
        <div className="vz-details is-reserved" aria-hidden="true">
          <summary>Text form</summary>
        </div>
      )}
      {drawn && result && !failed && (
        <details className="vz-details" onToggle={(e) => setTextOpen((e.target as HTMLDetailsElement).open)} data-testid="panel-text">
          <summary>Text form</summary>
          {sentences !== null && <Sentences lines={sentences} label={`Text form of ${panel.title}`} />}
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
function Reserved({ panel, view, agent }: { panel: ResolvedPanel; view: string; agent: AgentName }) {
  if (panel.kind === 'timeseries') return <div className="vz-chart" style={reservedStyle(view)} data-testid="panel-reserved" />
  if (panel.kind === 'stat')
    // The figure's place, and the thresholds' line (the spec's, so known before the answer): the panel is as tall waiting as answered.
    return (
      <div className="vz-stack" data-testid="panel-reserved">
        <div className="vz-stat is-reserved" aria-hidden="true">
          <span className="vz-stat-value">0</span>
          <span className="vz-stat-context">Last value</span>
        </div>
        <Thresholds panel={panel} agent={agent} />
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

/** A chart drawn at once when its panel is on screen; else in its reserved place, at the height it draws, until `drawSoon` draws it. */
function DeferredChart({ id, result, panel, colours, place }: { id: string; result: PanelResult; panel: ResolvedPanel; colours: DashboardColours; place: RefObject<Element | null> }) {
  // Where the panel is now, read in the render of its answer, not where an observer last said: a jump in this task (a key, a
  // link) is not known to one yet. Near the window (`drawSoon.ts`): the chart is drawn in this render, in the answer's task.
  const [show, setShow] = useState(() => nearNow(place.current))
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (show) return
    const withdraw = drawSoon(ref.current!, () => flushSync(() => setShow(true)))
    // Near after all (it came near between the render and this effect): drawn in this task, before the frame.
    if (withdraw === null) setShow(true)
    return withdraw ?? undefined
  }, [show])
  if (!show) return <div ref={ref} className="vz-chart" style={reservedStyle(viewName(result.resolved, id))} data-testid="panel-deferred" />
  return <ChartBody id={id} result={result} panel={panel} colours={colours} />
}

const ChartBody = memo(function ChartBody({ id, result, panel, colours }: { id: string; result: PanelResult; panel: ResolvedPanel; colours: DashboardColours }) {
  const drawn = useMemo(() => {
    const aligned = alignedOf(result, panel)
    const shiftMs = zoneShiftMs(LOCAL, result.window.end * 1000)
    const queries = panel.kind === 'text' ? [] : panel.queries
    // A series with no labels is named by what the dashboard calls its query ("p95") when it gives it a fixed name, else by the query itself, as in Explore.
    const first = result.resolved.queries[queries[0] ?? '']
    const query = first?.legend && !first.legend.includes('{{') ? first.legend : (first?.expr ?? panel.title)
    let max = 0
    if (panel.kind === 'timeseries' && panel.unit === 'bytes/s') for (const s of aligned.series) for (let i = 0; i < s.values.length; i++) if (Math.abs(s.values[i]!) > max) max = Math.abs(s.values[i]!)
    const unit = chartUnitOf(panel.kind === 'timeseries' ? panel.unit : undefined, max)
    // One colour per series across the dashboard: the panel's chart is handed the dashboard's map before it first draws (D-M2).
    colours.seed(viewName(result.resolved, id), aligned, query)
    return { ...toSpec({ data: aligned, start: result.window.start, step: result.window.step, unit: 'none', as: unit, query, shiftMs }), shiftMs }
  }, [result, panel, colours, id])
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
  const f = formatFor(unit, [v])
  const text = f.value(v)
  return f.unit === '' ? { text, unit: '' } : { text: text.slice(0, text.length - (f.unit === '%' ? 1 : f.unit.length + 1)), unit: f.unit }
}

function StatBody({ digest, panel, result, now, agent }: { digest: PanelDigest; panel: ResolvedPanel; result: PanelResult; now: number; agent: AgentName }) {
  if (panel.kind !== 'stat') return null
  const shown = digest.series.slice(0, STAT_FIGURES)
  const reducer = REDUCER_WORDS[panel.options?.reduce ?? 'last'] ?? 'Last value'
  const w = result.window
  return (
    <div className="vz-stack" data-testid="panel-stat">
      <div className="vz-controls">
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
                          : {s.breached.startsWith('>') ? 'above' : 'below'} <span className="vz-qty">{withUnit(limit.text, limit.unit)}</span>
                        </>
                      ) : null}
                    </span>
                  </span>
                )}
              </span>
            </div>
          )
        })}
      </div>
      <Thresholds panel={panel} agent={agent} />
      {digest.seriesCount > shown.length && (
        <p className="vz-secondary" data-size="sm">
          <span className="vz-qty">{digest.seriesCount - shown.length}</span> more series are in the text form.
        </p>
      )}
    </div>
  )
}

/** What a stat's state is measured against, from the spec: a status names its thresholds (d1), and an agent's are said to be the agent's (D-B1). */
function Thresholds({ panel, agent }: { panel: ResolvedPanel; agent: AgentName }) {
  const limits = useMemo(() => thresholdWords(panel), [panel])
  if (!limits) return null
  return (
    <p className={agent ? 'vz-stat-context vz-agent' : 'vz-stat-context'} data-testid="stat-thresholds">
      {agent ? `Agent's thresholds: ${limits}. Not verified.` : `Thresholds: ${limits}.`}
    </p>
  )
}

function TableBody({ digest, panel }: { digest: PanelDigest; panel: ResolvedPanel }) {
  const table = useMemo(() => tableOf(digest, panel), [digest, panel])
  // The rows the spec cuts are a press away (d8), as in Explore's table.
  const [all, setAll] = useState(false)
  if (!table) return null
  const rows = all ? table.rows : table.shown
  const more = table.total - table.shown.length
  return (
    <div data-testid="panel-table">
      <p className="vz-table-caption" data-testid="panel-table-caption">
        <span className="vz-qty">{rows.length}</span> of <span className="vz-qty">{table.total}</span> rows, {table.order}.
      </p>
      {/* What follows the table is a stack with it, clear of its last row with either pointer (as Explore's "Show 50 more", the v9 review's B2). */}
      <div className={more > 0 ? 'vz-stack' : undefined}>
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
            {rows.map((r) => (
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
      {more > 0 && (
        <div className="vz-controls panel-more">
          <button className="vz-button" data-size="sm" onClick={() => setAll((a) => !a)} data-testid="panel-table-more">
            {all ? `Show the first ${table.shown.length}` : `Show ${more} more`}
          </button>
        </div>
      )}
      </div>
    </div>
  )
}

/** A panel's text form: sentences, wrapped at the measure (the system's text form), never a well that scrolls sideways. */
function Sentences({ lines, label }: { lines: string[]; label: string }) {
  return (
    <div className="vz-text-form" aria-label={label} role="region" data-testid="panel-sentences">
      <ul>
        {lines.map((l, i) => (
          <li key={i} className={l.startsWith('Agent') ? 'vz-agent' : undefined}>
            {l}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * A kind of panel the app does not draw: said so, and its data as the system shows data that is
 * not a picture (D-M1). A heatmap's buckets are a table (bound, last, lowest, highest), without
 * the model's statistical notes; a note is its Markdown as text. Never drawn as another kind.
 */
function NotDrawn({ panel, digest, result, now, level, agent }: { panel: ResolvedPanel; digest: PanelDigest | null; result: PanelResult; now: number; level: 2 | 3; agent: AgentName }) {
  if (panel.kind === 'text')
    return (
      <div className={agent ? 'vz-agent' : undefined} data-testid="panel-not-drawn">
        <Note markdown={panel.content} level={level} lead={agent ? <p className="vz-claim-by"><span>Agent's note</span> <span className="vz-status">Not verified</span></p> : undefined} />
      </div>
    )
  const kind = KIND_WORDS[panel.kind] ?? panel.kind
  const buckets = digest ? bucketsOf(digest, panel, result.resolved) : null
  const range = rangeWords(result.window.start, result.window.end, now)
  const fmt = digest && !buckets ? formatFor('unit' in panel ? panel.unit : undefined, digest.series.flatMap((s) => [s.last, s.min, s.max])) : null
  return (
    <div className="vz-stack" data-testid="panel-not-drawn">
      <p className="vz-secondary">
        This panel is a {kind}, a kind this app does not draw yet. {buckets ? `Its ${buckets.rows.length} buckets over ${range}, as a table:` : `Its series over ${range}, as a table:`}
      </p>
      {buckets ? (
        <div data-testid="panel-buckets">
          <p className="vz-table-caption">
            <span className="vz-qty">{buckets.rows.length}</span> buckets, shortest first. Each counts what took at most its duration, so each includes the rows above it.
          </p>
          <div className="vz-table-wrap">
            <table className="vz-table">
              <thead>
                <tr>
                  <th scope="col" className="vz-label">
                    At most
                  </th>
                  {['Last', 'Lowest', 'Highest'].map((h) => (
                    <th key={h} scope="col" className="vz-label vz-right">
                      {buckets.valueUnit ? `${h}, ${buckets.valueUnit}` : h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {buckets.rows.map((r) => (
                  <tr key={r.le}>
                    <td className="vz-num" data-key="">
                      {r.bound}
                    </td>
                    <td className="vz-num vz-right">{buckets.value(r.last)}</td>
                    <td className="vz-num vz-right">{buckets.value(r.min)}</td>
                    <td className="vz-num vz-right">{buckets.value(r.max)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : digest && fmt ? (
        <div className="vz-table-wrap">
          <table className="vz-table">
            <thead>
              <tr>
                <th scope="col" className="vz-label">
                  Series
                </th>
                {['Last', 'Lowest', 'Highest'].map((h) => (
                  <th key={h} scope="col" className="vz-label">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {digest.series.map((s) => (
                <tr key={seriesKey(s.labels) + (s.query ?? '')}>
                  <td className="vz-num" data-key="">
                    {s.name}
                  </td>
                  <td className="vz-num">{fmt.value(s.last)}</td>
                  <td className="vz-num">{fmt.value(s.min)}</td>
                  <td className="vz-num">{fmt.value(s.max)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}

function Empty({ result, now, chart }: { result: PanelResult; now: number; chart: boolean }) {
  // In a chart's place, at the chart's height (Empty): the panel is as tall with nothing in it as with something.
  // One sentence (d7): what was asked and over which range. What nothing means is the panel's own explanation, above; Explore is linked below.
  return (
    <div className={chart ? 'vz-chart' : undefined}>
      <div className="vz-empty" role="status" data-testid="panel-empty">
        <p className="vz-empty-title">No series matched</p>
        <p>
          Nothing matched this panel's {Object.keys(result.data).length > 1 ? 'queries' : 'query'} from {rangeWords(result.window.start, result.window.end, now)}.
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
