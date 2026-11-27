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
import { actorWords, DashboardsListPage, NoPermission } from './DashboardsListPage'
import { dashboardText, digestOf, labelValuesOf, parseDashboardsSearch, rangeOf, readSpec, resolveFor, sectionsOf, variablesOf, windowOf, type Dashboard, type DashboardsSearch, type ResolvedDashboard, type Variable } from './model'
import { PanelView } from './PanelView'
import { DashboardStore } from './store'

const route = getRouteApi('/dashboards')

/** `/dashboards`: the list, or the dashboard the address names with `id`. */
export function DashboardsPage() {
  const raw = route.useSearch()
  const search = useMemo(() => parseDashboardsSearch(raw as Record<string, unknown>), [raw])
  // A dashboard's page is made anew for another dashboard: nothing of one is ever shown as another's.
  return search.id ? <DashboardPage key={search.id} id={search.id} search={search} /> : <DashboardsListPage search={search} />
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

  useEffect(() => {
    document.title = title ? `${title} · Dashboards · viz` : 'Dashboards · viz'
  }, [title])

  // ---- what is asked: the range (the address's, else the spec's own), the variable values, and when.
  const { from, to } = rangeOf(spec, search)
  const variables = useMemo(() => variablesOf(search), [search])
  const variablesKey = JSON.stringify(variables)
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
  useEffect(() => () => store.dispose(), [store])
  useEffect(() => {
    if (resolved && window_) store.load(resolved, window_, JSON.stringify([revision, from, to, variablesKey]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, resolved, window_])
  const summary = useSyncExternalStore(
    (fn) => store.subscribeSummary(fn),
    () => store.summary(),
  )

  const setSearch = useCallback((patch: DashboardsSearch) => void navigate({ to: '/dashboards', search: (prev) => ({ ...prev, ...patch }), resetScroll: false }), [navigate])
  const onRange = useCallback((f: TimeSpec, t: TimeSpec) => setSearch({ from: f, to: t }), [setSearch])
  const refresh = useCallback(() => setRunId((n) => n + 1), [])
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
        <div>
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
                  <VariableField key={name} name={name} def={def} resolved={resolved} window={window_} store={store} onChange={(value) => setSearch({ [`var.${name}`]: value } as DashboardsSearch)} />
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
            <DashboardText resolved={resolved} store={store} summaryKey={`${summary.answered}/${summary.failed}/${summary.waiting}`} />
          ) : (
            <div className="vz-dashboard" data-testid="dashboard-panels">
              <div className="vz-sections">
                {sections.map((s, i) => (
                  <section className="vz-section" key={i} aria-label={s.title ?? `Row ${i + 1}`}>
                    {s.title && <h2 className="vz-section-title">{s.title}</h2>}
                    <div className="vz-grid">
                      {s.items.map((p) => (
                        <PanelView key={p.panel} id={p.panel} span={p.span} resolved={resolved} store={store} from={from} to={to} level={s.title ? 3 : 2} onSignIn={onSignIn} />
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

/** The whole dashboard as text: the model's digest of every panel that has answered, and which have not. */
function DashboardText({ resolved, store, summaryKey }: { resolved: ResolvedDashboard; store: DashboardStore; summaryKey: string }) {
  const { text, left } = useMemo(() => {
    const digests = []
    const missing: string[] = []
    let w: QueryWindow | null = null
    for (const id of resolved.order) {
      const s = store.get(id)
      if (s.result && !s.error && !s.halted && !s.waiting && !s.stale) {
        digests.push(digestOf(s.result.resolved, id, s.result.data, s.result.window))
        w = s.result.window
      } else missing.push(resolved.panels[id]!.title)
    }
    return { text: dashboardText(resolved, digests, w), left: missing }
    // summaryKey: the text is written again whenever a panel answers or fails.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, store, summaryKey])
  return (
    <section data-testid="dashboard-text" aria-label="Text form of the dashboard">
      <p className="vz-table-caption">
        The dashboard as the model writes it for a reader that cannot see the panels.
        {left.length > 0 ? ` Not in it, because ${left.length === 1 ? 'it has' : 'they have'} no answer for this range: ${left.join(', ')}.` : ''}
      </p>
      <pre className="vz-query code-scroll" tabIndex={0} aria-label="Text form of the dashboard" data-testid="dashboard-digest">
        {text}
      </pre>
      <div className="vz-controls">
        <CopyButton text={() => text} label="Copy text" />
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
