import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { substitute } from '../../../dashboard/src/index.ts'
import { PromApiError } from '../api/client'
import { answerLine, errorKind } from '../api/errors'
import type { DashboardDocument, DashboardList, DashboardSummary } from '../api/types'
import { CopyButton } from '../explore/CopyButton'
import { RangeControls, TimeRangeField } from '../explore/TimeRangeField'
import { useWaiting } from '../explore/waiting'
import type { QueryWindow } from '../lib/step'
import type { TimeSpec } from '../lib/time'
import { momentText } from '../lib/timeInput'
import { useCommands } from '../shell/commands'
import { useSession } from '../shell/session'
import { actorWords, agentOf, AgentBy, DashboardsListPage, NoPermission } from './DashboardsListPage'
import { DashboardColours } from './colours'
import { dashboardText, digestOf, labelValuesOf, parseDashboardsSearch, rangeOf, rangeWords, readSpec, resolveFor, sectionsOf, variablesOf, windowOf, type Dashboard, type DashboardsSearch, type ResolvedDashboard, type Variable } from './model'
import { PanelView } from './PanelView'
import { DashboardStore } from './store'
import { panelSentences, type AgentName } from './textForm'

const route = getRouteApi('/dashboards')

/** `/dashboards`: the list, or the dashboard the address names with `id`. */
export function DashboardsPage() {
  const raw = route.useSearch()
  const search = useMemo(() => parseDashboardsSearch(raw as Record<string, unknown>), [raw])
  // A dashboard's page is made anew for another dashboard: nothing of one is ever shown as another's.
  return search.id ? <DashboardPage key={search.id} id={search.id} search={search} /> : <DashboardsListPage search={search} />
}

/** The variable values as one key, whatever order the address gives them in. */
const keyOfVariables = (values: Record<string, string>) => JSON.stringify(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1)))
/** What one load asks: the same key twice is one load (the press sends it; the address that follows does not send it again). */
const loadKey = (revision: string, from: TimeSpec, to: TimeSpec, variables: string, runId: number, w: QueryWindow) => JSON.stringify([revision, from, to, variables, runId, w.start, w.end, w.step])

/** Runs `fn` in a task after the next frame is drawn: what was rendered before it is on screen first. */
function afterFrame(fn: () => void): void {
  requestAnimationFrame(() => setTimeout(fn, 0))
}

/** The dashboard's name and intent as a list already in this tab has them, to show before its own answer arrives. */
function cachedSummary(lists: [unknown, DashboardList | undefined][], id: string): DashboardSummary | null {
  for (const [, list] of lists) {
    const hit = list?.items.find((d) => d.id === id)
    if (hit) return hit
  }
  return null
}

function DashboardPage({ id, search }: { id: string; search: DashboardsSearch }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { client, connectionId, signOut } = useSession()

  const doc = useQuery<DashboardDocument, Error>({
    queryKey: ['dashboard', connectionId, id],
    queryFn: ({ signal }) => client.dashboard(id, { signal }),
    staleTime: 30_000,
  })
  const known = useMemo(() => doc.data?.dashboard ?? cachedSummary(queryClient.getQueriesData<DashboardList>({ queryKey: ['dashboards', connectionId] }), id), [doc.data, queryClient, connectionId, id])
  const read = useMemo(() => (doc.data ? readSpec(doc.data.spec) : null), [doc.data])
  const spec: Dashboard | null = read?.ok ? read.spec : null
  const title = spec?.metadata.title ?? known?.name ?? null
  const intent = spec?.metadata.intent ?? known?.intent ?? null
  // An agent wrote this revision and no person has saved over it: its words say so where they are read (D-B1).
  const agent: AgentName = known ? agentOf(known.lastChangedBy) : null

  useEffect(() => {
    document.title = title ? `${title} · Dashboards · viz` : 'Dashboards · viz'
  }, [title])

  // ---- what is asked: the range (the address's, else the spec's own), the variable values, and when.
  const { from, to } = rangeOf(spec, search)
  const variables = useMemo(() => variablesOf(search), [search])
  const variablesKey = keyOfVariables(variables)
  const [runId, setRunId] = useState(0)
  const revision = doc.data?.revision ?? ''
  const window_ = useMemo<QueryWindow | null>(
    () => (spec ? windowOf(from, to, Date.now() / 1000) : null),
    // runId re-resolves "now" for a relative range; the variables and the revision do too, so a panel's data and the range it states are one moment's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec, from, to, runId, variablesKey, revision],
  )
  const resolved = useMemo<ResolvedDashboard | null>(() => (spec ? resolveFor(spec, variables, window_) : null), [spec, variables, window_])

  // ---- the panels' data: one store for this page, emptied of its requests when the page is left.
  const store = useMemo(() => new DashboardStore(client), [client])
  const colours = useMemo(() => new DashboardColours(id), [id])
  useEffect(() => () => store.dispose(), [store])
  useEffect(() => {
    if (resolved && window_) store.load(resolved, window_, JSON.stringify([revision, from, to, variablesKey]), loadKey(revision, from, to, variablesKey, runId, window_))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, resolved, window_])
  const summary = useSyncExternalStore(
    (fn) => store.subscribeSummary(fn),
    () => store.summary(),
  )

  const setSearch = useCallback((patch: DashboardsSearch) => void navigate({ to: '/dashboards', search: (prev) => ({ ...prev, ...patch }), resetScroll: false }), [navigate])
  // The press's own frame says every panel waits for the new range (D-B2): the store marks them in the press's task, and the
  // address, the resolution and the requests follow once that frame is drawn. Changed in the same task, the router's change and
  // the page's resolution of the spec held that frame back by 100 to 150 ms (measured here).
  // After that frame, the requests are sent first, from the range pressed, and the address follows; the page's own load for the
  // new address is then the same load (`loadKey`) and sends nothing again.
  const askFor = useCallback(
    (f: TimeSpec, t: TimeSpec, values: Record<string, string>) => {
      if (!spec) return
      const w = windowOf(f, t, Date.now() / 1000)
      const vk = keyOfVariables(values)
      if (w) store.load(resolveFor(spec, values, w), w, JSON.stringify([revision, f, t, vk]), loadKey(revision, f, t, vk, runId, w))
    },
    [spec, store, revision, runId],
  )
  const onRange = useCallback(
    (f: TimeSpec, t: TimeSpec) => {
      if (f === from && t === to) return setSearch({ from: f, to: t })
      store.expect()
      afterFrame(() => {
        askFor(f, t, variables)
        setSearch({ from: f, to: t })
      })
    },
    [setSearch, store, from, to, askFor, variables],
  )
  // A second press while the panels are being asked is ignored: the button is busy (States).
  const refresh = useCallback(() => {
    if (store.summary().waiting === 0) setRunId((n) => n + 1)
  }, [store])
  const [form, setForm] = useState<'panels' | 'text'>('panels')
  const onSignIn = useCallback(() => signOut('refused'), [signOut])

  useCommands(
    'dashboard',
    [
      { id: 'd-refresh', group: 'View', title: 'Refresh this dashboard', keywords: 'reload run again now', run: refresh },
      { id: 'd-text', group: 'View', title: 'Switch between the panels and the text form', keywords: 'digest accessible agent', run: () => setForm((f) => (f === 'panels' ? 'text' : 'panels')) },
      { id: 'd-list', group: 'Navigation', title: 'Go to the list of dashboards', run: () => void navigate({ to: '/dashboards', search: {} }) },
    ],
    'static',
  )

  const sections = useMemo(() => (resolved ? sectionsOf(resolved.layout) : []), [resolved])
  const wait = useWaiting(doc.isFetching && !doc.data)
  const now = Date.now()
  const loading = summary.waiting > 0
  const rangeNow = window_ ? rangeWords(window_.start, window_.end, now) : ''

  // ---- the dashboard itself could not be read
  if (doc.isError && !doc.data) {
    const error = doc.error
    const missing = error instanceof PromApiError && error.status === 404
    return (
      <div className="vz-page" data-testid="dashboard-page">
        <header className="vz-page-head">
          <div>
            <h1 className="vz-page-title">{title ?? 'Dashboard'}</h1>
          </div>
        </header>
        {error instanceof PromApiError && error.status === 403 ? (
          <NoPermission error={error} onSignIn={() => signOut('left')} />
        ) : (
          <div className="vz-empty" role="alert" data-testid="dashboard-error">
            <p className="vz-empty-title">
              <span className="vz-mark" data-state="critical" />
              {missing ? 'There is no such dashboard' : 'The dashboard could not be read'}
            </p>
            <p data-testid="dashboard-error-message">
              {missing ? (
                <>
                  No dashboard of this tenant has the id <span className="vz-qty">{id}</span>. It may have been deleted, or the link may be another tenant's.
                </>
              ) : (
                error.message
              )}
            </p>
            {!missing && (
              <p>
                {answerLine(error)} {errorKind(error) === 'auth' ? 'Sign in again with a key that is valid now.' : 'Ask again; if it keeps failing, note the time and report it.'}
              </p>
            )}
            <div className="vz-controls">
              {!missing && errorKind(error) !== 'auth' && (
                <button className="vz-button" data-size="sm" onClick={() => void doc.refetch()} aria-busy={doc.isFetching}>
                  Ask again
                </button>
              )}
              {errorKind(error) === 'auth' && (
                <button className="vz-button" data-size="sm" onClick={onSignIn}>
                  Sign in again
                </button>
              )}
              <Link to="/dashboards" search={{}} className="vz-link" data-testid="to-list">
                See every dashboard
              </Link>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="vz-page" data-testid="dashboard-page" data-dashboard={id}>
      <header className="vz-page-head">
        <div className={agent ? 'vz-agent' : undefined} data-testid="dashboard-words">
          {agent && <AgentBy name={agent} what="dashboard" />}
          <h1 className="vz-page-title" data-testid="dashboard-title">
            {title ?? ' '}
          </h1>
          <p className="vz-page-sub" data-testid="dashboard-intent">
            {intent ?? ' '}
          </p>
        </div>
        <div className="vz-controls">
          <div className="vz-segmented" role="group" aria-label="Show the dashboard as">
            <button aria-pressed={form === 'panels'} onClick={() => setForm('panels')} data-testid="form-panels">
              Panels
            </button>
            <button aria-pressed={form === 'text'} onClick={() => setForm('text')} data-testid="form-text">
              Text
            </button>
          </div>
          <button className="vz-button" onClick={refresh} aria-busy={loading} data-testid="refresh">
            Refresh
          </button>
        </div>
      </header>

      {read && !read.ok ? (
        <div className="vz-empty" role="alert" data-testid="dashboard-invalid">
          <p className="vz-empty-title">
            <span className="vz-mark" data-state="critical" />
            This dashboard is not a valid viz.dashboard/v1
          </p>
          <p>The API returned a spec the dashboard model refuses, so nothing of it is drawn. The first problems:</p>
          <ul className="vz-text">
            {read.errors.slice(0, 3).map((e) => (
              <li key={e.path + e.code}>
                <span className="vz-qty">{e.path || '/'}</span> {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : !spec || !resolved ? (
        // Waiting for the dashboard's spec: nothing under 400 ms, then what is being waited for.
        <section className="vz-panel-body" aria-busy="true" data-testid="dashboard-waiting">
          {wait.shown && (
            <div className="vz-progress" data-unmeasured="">
              <div className="vz-progress-text">
                <span role="status">Asking the API for the dashboard.</span>
                <span className="vz-qty" aria-hidden="true">
                  {(wait.elapsedMs / 1000).toFixed(1)} s
                </span>
              </div>
            </div>
          )}
        </section>
      ) : (
        <>
          <p className="vz-secondary" data-size="sm" data-testid="dashboard-facts">
            {doc.data ? (
              <>
                Revision <span className="vz-qty">{doc.data.number}</span>, changed <ChangedAt iso={doc.data.dashboard.lastChangedAt} now={now} /> by {actorWords(doc.data.dashboard.lastChangedBy)}.{' '}
              </>
            ) : null}
            <span role="status" data-testid="load-summary">
              <span className="vz-qty">{summary.total}</span> {summary.total === 1 ? 'panel' : 'panels'}
              {summary.waiting > 0 ? (
                <>
                  , <span className="vz-qty">{summary.total - summary.waiting}</span> answered so far.
                </>
              ) : summary.failed > 0 ? (
                <>
                  , <span className="vz-qty">{summary.answered}</span> answered and <span className="vz-qty">{summary.failed}</span> not.
                </>
              ) : (
                ', all answered.'
              )}
            </span>
          </p>

          <div className="vz-stack">
            <RangeControls from={from} to={to} onChange={onRange} shown={null} />
            <div className="vz-dashboard">
              <div className="vz-grid">
                <TimeRangeField from={from} to={to} onChange={onRange} />
                {Object.entries(spec.variables ?? {}).map(([name, def]) => (
                  <VariableField key={name} name={name} def={def} resolved={resolved} window={window_} store={store} onChange={(value) => {
                      if (value === (variables[name] ?? '')) return setSearch({ [`var.${name}`]: value } as DashboardsSearch)
                      store.expect()
                      afterFrame(() => {
                        askFor(from, to, { ...variables, [name]: value })
                        setSearch({ [`var.${name}`]: value } as DashboardsSearch)
                      })
                    }} />
                ))}
              </div>
            </div>
          </div>

          {resolved.issues.length > 0 && (
            <div role="status" className="vz-banner" data-testid="dashboard-issues">
              <span className="vz-mark" data-state="warn" />
              <p>
                {resolved.issues
                  .slice(0, 2)
                  .map((i) => i.message)
                  .join(' ')}
                {resolved.issues.length > 2 ? ` And ${resolved.issues.length - 2} more.` : ''}
              </p>
            </div>
          )}

          {form === 'text' ? (
            <DashboardText resolved={resolved} store={store} summaryKey={`${summary.answered}/${summary.failed}/${summary.waiting}`} agent={agent} facts={doc.data ? `Revision ${doc.data.number}, changed by ${actorWords(doc.data.dashboard.lastChangedBy)}.` : null} />
          ) : (
            <div className="vz-dashboard" data-testid="dashboard-panels">
              <div className="vz-sections">
                {sections.map((s, i) => (
                  <section className="vz-section" key={i} aria-labelledby={s.title ? `row-${i}` : undefined} aria-label={s.title ? undefined : `Row ${i + 1}`}>
                    {s.title && (
                      <h2 className="vz-section-title" id={`row-${i}`}>
                        {s.title}
                      </h2>
                    )}
                    <div className="vz-grid">
                      {s.items.map((p) => (
                        <PanelView key={p.panel} id={p.panel} span={p.span} resolved={resolved} store={store} from={from} to={to} level={s.title ? 3 : 2} onSignIn={onSignIn} agent={agent} colours={colours} rangeNow={rangeNow} />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ChangedAt({ iso, now }: { iso: string; now: number }) {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return <>at an unknown time</>
  return (
    <time className="vz-qty" dateTime={iso}>
      {momentText(Math.floor(at / 60_000) * 60, now)}
    </time>
  )
}

/**
 * The whole dashboard as text (D-M1): every panel's own text form, in the page's order, as
 * sentences wrapped at the measure, in the page's units and dates. The model's compact digest is
 * not shown: it is what "Copy the digest for an agent" copies, and says so.
 */
function DashboardText({ resolved, store, summaryKey, agent, facts }: { resolved: ResolvedDashboard; store: DashboardStore; summaryKey: string; agent: AgentName; facts: string | null }) {
  const { panels, digest } = useMemo(() => {
    const now = Date.now()
    const digests: ReturnType<typeof digestOf>[] = []
    let w: QueryWindow | null = null
    const panels = resolved.order.map((id) => {
      const s = store.get(id)
      const title = resolved.panels[id]!.title
      if (s.result && !s.error && !s.halted && !s.waiting && !s.stale) {
        const d = digestOf(s.result.resolved, id, s.result.data, s.result.window, 100_000)
        digests.push(digestOf(s.result.resolved, id, s.result.data, s.result.window))
        w = s.result.window
        const all = panelSentences(s.result.resolved, id, d, s.result.window, now, agent)
        return { id, title, head: all[0]!, lines: all.slice(1) }
      }
      return { id, title, lines: [s.waiting ? 'Waiting for its answer.' : s.halted ? 'Its request was stopped before it was answered.' : 'It has no answer for this range: its query could not run.'], head: `${title}.` }
    })
    const wNow = w as QueryWindow | null
    return { panels, digest: () => dashboardText(resolved, digests, wNow), range: wNow }
    // summaryKey: the text is written again whenever a panel answers or fails.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, store, summaryKey, agent])
  const variables = Object.entries(resolved.variables)
  return (
    <section className="vz-stack" data-testid="dashboard-text" aria-label="Text form of the dashboard">
      <div className="vz-text-form" data-testid="dashboard-sentences">
        <ul>
          <li className={agent ? 'vz-agent' : undefined}>
            {agent ? 'Agent: ' : ''}
            {resolved.metadata.title}. {resolved.metadata.intent}
            {agent ? ' Not verified.' : ''}
          </li>
          {facts && <li>{facts}</li>}
          {variables.length > 0 && <li>Variables: {variables.map(([k, v]) => `${k} ${v.all ? 'all' : v.values.join(' or ')}`).join(', ')}.</li>}
        </ul>
      </div>
      {panels.map((p) => (
        <section key={p.id} className="vz-section" aria-labelledby={`text-${p.id}`} data-testid="dashboard-text-panel">
          <h2 className="vz-section-title" id={`text-${p.id}`}>
            {p.title}
          </h2>
          <div className="vz-text-form">
            <ul>
              <li>{p.head.slice(p.title.length + 2) || p.head}</li>
              {p.lines.map((l, i) => (
                <li key={i} className={l.startsWith('Agent') ? 'vz-agent' : undefined}>
                  {l}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ))}
      <p className="vz-secondary">The model's compact digest of the same dashboard, written for an agent to read, is not shown here; this copies it.</p>
      <div className="vz-controls">
        <CopyButton text={digest} label="Copy the digest for an agent" />
      </div>
    </section>
  )
}

const ALL = '*'

/**
 * One variable as a control. An enum's values are the spec's; a query variable's are asked of
 * the API (through the page's six-request limit) in the window on screen. Several values at
 * once are not offered: one value, or all.
 */
function VariableField({ name, def, resolved, window: w, store, onChange }: { name: string; def: Variable; resolved: ResolvedDashboard; window: QueryWindow | null; store: DashboardStore; onChange: (value: string) => void }) {
  const { client, connectionId } = useSession()
  const bound = resolved.variables[name]
  const value = bound?.all ? ALL : (bound?.values[0] ?? '')
  const label = def.label ?? name
  const id = `var-${name}`

  // A query variable's own expression, with the other variables written into it by the model.
  const lookup = useMemo(() => {
    if (def.kind !== 'query') return null
    const sub = substitute(def.query.expr, (n) => (resolved.variables[n] ? { values: resolved.variables[n]!.values, all: resolved.variables[n]!.all } : undefined), def.query.lang)
    return sub.errors.length ? null : labelValuesOf(sub.expr)
  }, [def, resolved.variables])
  // Whole hours, so the same values are not asked for again with every refresh.
  const start = w ? Math.floor(w.start / 3600) * 3600 : 0
  const end = w ? Math.ceil(w.end / 3600) * 3600 : 0
  const asked = useQuery<string[], Error>({
    queryKey: ['dashboard-variable', connectionId, resolved.metadata.id, name, lookup?.label, lookup?.match, start, end],
    enabled: def.kind === 'query' && lookup !== null && w !== null,
    staleTime: 60_000,
    queryFn: ({ signal }) => store.limiter.run((s) => client.labelValues(lookup!.label, { ...(lookup!.match ? { match: [lookup!.match] } : {}), start, end }, { signal: s }), signal),
  })

  if (def.kind === 'text')
    return (
      <div className="vz-field" data-span="3" data-testid={`variable-${name}`}>
        <span className="vz-label">{label}</span>
        <span className="vz-qty">{value || 'empty'}</span>
      </div>
    )

  const all = def.kind === 'query' || (def.kind === 'enum' && def.includeAll === true)
  const listed = def.kind === 'query' ? (asked.data ?? []) : def.values
  // The value in use is always among the options, also before a query variable's values arrive.
  const options = listed.includes(value) || value === ALL || value === '' ? listed : [value, ...listed]
  const unread = def.kind === 'query' && lookup === null
  // A choice among a few fixed values is a segmented control; a list whose length is the data's is a select (Field).
  if (def.kind !== 'query' && options.length + (all ? 1 : 0) <= 6)
    return (
      <div className="vz-field" data-span="3" data-testid={`variable-${name}`}>
        <span className="vz-label" id={id}>
          {label}
        </span>
        <div className="vz-segmented" role="group" aria-labelledby={id}>
          {all && (
            <button aria-pressed={value === ALL} onClick={() => onChange(ALL)} data-value={ALL}>
              All
            </button>
          )}
          {options.map((v) => (
            <button key={v} aria-pressed={value === v} onClick={() => onChange(v)} data-value={v}>
              {v}
            </button>
          ))}
        </div>
      </div>
    )
  return (
    <div className="vz-field" data-span="3" data-testid={`variable-${name}`}>
      <label className="vz-label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="vz-select" value={value} onChange={(e) => onChange(e.target.value)} aria-busy={asked.isFetching} aria-describedby={unread || asked.isError ? `${id}-help` : undefined}>
        {all && <option value={ALL}>All</option>}
        {options.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
      {(unread || asked.isError) && (
        <span className="vz-help" id={`${id}-help`} data-testid={`variable-${name}-help`}>
          {unread ? 'This variable\'s values come from a query this app cannot run yet; only the value in use is offered.' : `The values could not be listed: ${asked.error?.message}`}
        </span>
      )}
    </div>
  )
}
