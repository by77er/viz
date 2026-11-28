import { useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ControlApiError, PromApiError } from '../api/client'
import { answerLine, errorKind } from '../api/errors'
import type { Actor, DashboardList, DashboardSummary } from '../api/types'
import { formatAge, useWaiting } from '../explore/waiting'
import { useSession } from '../shell/session'
import type { DashboardsSearch } from './model'

/** How long after the last keystroke the list is asked for again, in ms. A wait, not a motion. */
const SEARCH_DELAY = 250
/** The most dashboards one request returns (control's limit). */
const PAGE = 200

/** The key of the list as the query cache holds it; the dashboard page reads a name from it before its own answer arrives. */
export const listKey = (connectionId: string, q: string, tag: string) => ['dashboards', connectionId, q, tag] as const

/** Who changed something, as the list says it: the name, and that it was an agent when it was one (Words: an agent's work says so). */
export function actorWords(by: Actor): string {
  const name = by.name ?? by.subject
  return by.kind === 'agent' ? `${name} (agent)` : name
}

/** "24 Nov, 16:12" or "14 min ago", for a time the API gave as ISO text. */
export function changedWords(iso: string, nowMs: number): { n: string; rest: string } | null {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return null
  // To the minute: a change is not read to the second.
  return formatAge(Math.max(0, (nowMs - at) / 1000), Math.floor(at / 60_000) * 60, nowMs)
}

export function DashboardsListPage({ search }: { search: DashboardsSearch }) {
  const navigate = useNavigate()
  const { client, connectionId, signOut } = useSession()
  const q = search.q ?? ''
  const tag = search.tag ?? ''

  useEffect(() => {
    document.title = 'Dashboards · viz'
  }, [])

  const list = useQuery<DashboardList, Error>({
    queryKey: listKey(connectionId, q, tag),
    queryFn: ({ signal }) => client.dashboards({ q, tag, limit: PAGE }, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
  // The tags to choose from are those of every dashboard, not of the ones the search left.
  const all = useQuery<DashboardList, Error>({
    queryKey: listKey(connectionId, '', ''),
    queryFn: ({ signal }) => client.dashboards({ limit: PAGE }, { signal }),
    staleTime: 30_000,
  })
  const tags = useMemo(() => [...new Set((all.data?.items ?? []).flatMap((d) => d.tags))].sort(), [all.data])

  // ---- the search field: typed here, asked for a moment after the last keystroke.
  const [typed, setTyped] = useState(q)
  const sent = useRef(q)
  useEffect(() => {
    // The address changed elsewhere (Back, a link): the field follows it.
    if (q !== sent.current) {
      sent.current = q
      setTyped(q)
    }
  }, [q])
  useEffect(() => {
    const next = typed.trim()
    if (next === sent.current) return
    const timer = setTimeout(() => {
      sent.current = next
      void navigate({ to: '/dashboards', search: (prev) => ({ ...prev, q: next || undefined }), replace: true })
    }, SEARCH_DELAY)
    return () => clearTimeout(timer)
  }, [typed, navigate])
  const setTag = (next: string) => void navigate({ to: '/dashboards', search: (prev) => ({ ...prev, tag: next || undefined }), replace: true })
  const clear = () => {
    sent.current = ''
    setTyped('')
    void navigate({ to: '/dashboards', search: {}, replace: true })
  }

  const waiting = list.isFetching
  const wait = useWaiting(waiting)
  const error = list.isError ? list.error : null
  const data = error ? undefined : list.data
  const filtered = q !== '' || tag !== ''
  // Every dashboard is here: in order of name. Some are not: in the API's order (by id), and the caption says so.
  const whole = !!data && data.items.length === data.total
  const rows = useMemo(() => (data ? (data.items.length === data.total ? [...data.items].sort((a, b) => a.name.localeCompare(b.name, 'en')) : data.items) : []), [data])
  const now = Date.now()
  const forbidden = error instanceof PromApiError && error.status === 403
  const firstRun = !!data && data.total === 0 && !filtered && !list.isPlaceholderData

  return (
    <div className="vz-page" data-testid="dashboards-list">
      <header className="vz-page-head">
        <div>
          <h1 className="vz-page-title">Dashboards</h1>
        </div>
      </header>

      {!forbidden && !firstRun && (
        <div className="vz-controls" role="search">
          <label className="vz-field">
            <span className="vz-label">Search</span>
            <input
              className="vz-input"
              size={28}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="checkout"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              aria-describedby="search-help"
              data-testid="dashboards-search"
            />
          </label>
          {tags.length > 1 && (
            <label className="vz-field">
              <span className="vz-label">Tag</span>
              <select className="vz-select" value={tag} onChange={(e) => setTag(e.target.value)} data-testid="dashboards-tag">
                <option value="">Any tag</option>
                {tags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="vz-sr" id="search-help">
            Searches names, ids, intents, owners and tags.
          </span>
        </div>
      )}

      <section className="vz-panel-body" aria-label="Dashboards" aria-busy={waiting} data-testid="dashboards-region">
        {wait.shown && (
          <div className="vz-progress" data-unmeasured="" data-testid="list-progress">
            <div className="vz-progress-text">
              <span role="status">Asking the API for the dashboards.</span>
              <span className="vz-qty" aria-hidden="true">
                {(wait.elapsedMs / 1000).toFixed(1)} s
              </span>
            </div>
          </div>
        )}
        {error ? (
          forbidden ? (
            <NoPermission error={error} onSignIn={() => signOut('left')} />
          ) : (
            <div className="vz-empty" role="alert" data-testid="list-error">
              <p className="vz-empty-title">
                <span className="vz-mark" data-state="critical" />
                The dashboards could not be listed
              </p>
              <p data-testid="list-error-message">{error.message}</p>
              <p>
                {answerLine(error)} {errorKind(error) === 'auth' ? 'The API no longer accepts the key this tab signed in with. Sign in again.' : 'Nothing was changed. Ask again; if it keeps failing, note the time and report it.'}
              </p>
              <div className="vz-controls">
                {errorKind(error) === 'auth' ? (
                  <button className="vz-button" data-size="sm" onClick={() => signOut('refused')}>
                    Sign in again
                  </button>
                ) : (
                  <button className="vz-button" data-size="sm" onClick={() => void list.refetch()} aria-busy={waiting} data-testid="list-retry">
                    Ask again
                  </button>
                )}
              </div>
            </div>
          )
        ) : firstRun ? (
          <section className="vz-start" data-testid="list-first-run" aria-labelledby="no-dashboards">
            <h2 className="vz-section-title" id="no-dashboards">
              No dashboards yet
            </h2>
            <p>A dashboard is a set of panels over this tenant's metrics, with the question it answers written on it. Once one exists it is listed here with its owner and its last change.</p>
            <ol className="vz-steps">
              <li>
                <p>
                  This app reads dashboards and cannot make one yet. Create one through the control API (<span className="vz-qty">POST /api/v1/control/dashboards</span>, with a key that has the{' '}
                  <span className="vz-qty">dashboards:apply</span> scope), or have an agent propose one.
                </p>
              </li>
            </ol>
          </section>
        ) : data && data.total === 0 ? (
          <div className="vz-empty" role="status" data-testid="list-empty">
            <p className="vz-empty-title">No dashboard matched</p>
            <p>
              Nothing has {q !== '' ? <span className="vz-qty">{q}</span> : null}
              {q !== '' ? ' in its name, id, intent, owner or tags' : ''}
              {q !== '' && tag !== '' ? ' and ' : ''}
              {tag !== '' ? (
                <>
                  the tag <span className="vz-qty">{tag}</span>
                </>
              ) : null}
              . {all.data ? `There ${all.data.total === 1 ? 'is 1 dashboard' : `are ${all.data.total} dashboards`} in all.` : ''}
            </p>
            <div className="vz-controls">
              <button className="vz-button" data-size="sm" onClick={clear} data-focus-after="[data-testid=dashboards-search]" data-testid="list-clear">
                Show every dashboard
              </button>
            </div>
          </div>
        ) : data ? (
          <>
            <p className="vz-table-caption" data-testid="list-caption">
              {whole ? (
                <>
                  <span className="vz-qty">{rows.length}</span> {filtered ? `of ${all.data?.total ?? rows.length} dashboards match` : rows.length === 1 ? 'dashboard' : 'dashboards'}, by name
                </>
              ) : (
                <>
                  <span className="vz-qty">{rows.length}</span> of <span className="vz-qty">{data.total}</span> dashboards, the first by id. Search to narrow the list
                </>
              )}
              {list.isPlaceholderData ? '. Showing the previous search' : ''}.
            </p>
            <div className="vz-table-wrap">
              <table className="vz-table" data-fold="wide" role="table">
                <thead>
                  <tr role="row">
                    <th role="columnheader" className="vz-label">
                      Name
                    </th>
                    <th role="columnheader" className="vz-label">
                      Intent
                    </th>
                    <th role="columnheader" className="vz-label">
                      Tags
                    </th>
                    <th role="columnheader" className="vz-label">
                      Owner
                    </th>
                    <th role="columnheader" className="vz-label" data-priority="1">
                      Changed
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <Row key={d.id} d={d} now={now} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </section>
    </div>
  )
}

function Row({ d, now }: { d: DashboardSummary; now: number }) {
  const changed = changedWords(d.lastChangedAt, now)
  return (
    <tr role="row" data-testid="dashboard-row">
      <td role="cell" data-key="">
        <Link to="/dashboards" search={{ id: d.id }} className="vz-link" data-testid={`open-${d.id}`}>
          {d.name}
        </Link>
      </td>
      <td role="cell" data-label="Intent" className="cell-wrap">
        {d.intent}
      </td>
      <td role="cell" data-label="Tags">
        {d.tags.length ? d.tags.join(', ') : 'none'}
      </td>
      <td role="cell" data-label="Owner">
        {d.owner ?? 'nobody'}
      </td>
      <td role="cell" data-label="Changed" data-priority="1" className="cell-wrap">
        {changed ? (
          <>
            {changed.n !== '' && <span className="vz-qty">{changed.n}</span>}
            {changed.rest}
            <span className="vz-phrase"> by {actorWords(d.lastChangedBy)}</span>
          </>
        ) : (
          `by ${actorWords(d.lastChangedBy)}`
        )}
      </td>
    </tr>
  )
}

/** The key may not read dashboards: what the API said, what it needs, and the way to another key. */
export function NoPermission({ error, onSignIn }: { error: Error; onSignIn: () => void }) {
  const { session } = useSession()
  const scopes = session.status === 'in' ? (session.identity?.scopes ?? null) : null
  return (
    <div className="vz-empty" role="alert" data-testid="no-permission">
      <p className="vz-empty-title">
        <span className="vz-mark" data-state="critical" />
        This key cannot read dashboards
      </p>
      <p data-testid="no-permission-message">
        {error.message}
        {scopes ? (
          <>
            {' '}
            The key this tab signed in with has {scopes.length ? <span className="vz-qty">{scopes.join(', ')}</span> : 'no scopes'}.
          </>
        ) : null}
      </p>
      <p>{error instanceof ControlApiError && error.fix ? 'Explore still works with this key. To see dashboards, sign in with a key that has the dashboards:read scope.' : 'Sign in with a key that has the dashboards:read scope.'}</p>
      <div className="vz-controls">
        <button className="vz-button" data-size="sm" onClick={onSignIn} data-testid="no-permission-sign-in">
          Sign in with another key
        </button>
      </div>
    </div>
  )
}
