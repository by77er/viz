import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { answerLine, errorKind } from '../api/errors'
import { listMonitors, READ_SCOPE, type Monitor, type MonitorFilter, type MonitorList } from '../api/monitors'
import { useWaiting } from '../explore/waiting'
import { useCommands } from '../shell/commands'
import { useSession } from '../shell/session'
import { filterOf, listText, receiverWords, sortMonitors, stateWords, valueWords, type MonitorsSearch } from './model'
import { Ago, Status } from './Status'

/** The key of a list as the query cache holds it; a monitor's page reads its name and state from it before its own answer. */
export const listKey = (connectionId: string, filter: MonitorFilter) => ['monitors', connectionId, filter] as const

const FILTER_WORDS: Record<MonitorFilter, string> = { attention: 'Needs attention', silenced: 'Silenced', all: 'All' }
const COUNT_WORDS: [string, string][] = [
  ['firing', 'firing'],
  ['no_data', 'without data'],
  ['error', 'cannot be evaluated'],
  ['pending', 'pending'],
  ['warming', 'warming up'],
  ['unknown', 'not evaluated yet'],
  ['ok', 'not firing'],
]

export function MonitorsListPage({ search }: { search: MonitorsSearch }) {
  const navigate = useNavigate()
  const { client, connectionId, signOut } = useSession()
  const filter = filterOf(search)
  const [textOpen, setTextOpen] = useState(false)
  const setFilter = (next: MonitorFilter) => void navigate({ to: '/monitors', search: next === 'attention' ? {} : { filter: next }, replace: true })

  const list = useQuery<MonitorList, Error>({
    queryKey: listKey(connectionId, filter),
    queryFn: ({ signal }) => listMonitors(client, filter, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })

  useCommands(
    'monitors',
    [
      { id: 'm-attention', group: 'View', title: 'Show the monitors that need attention', keywords: 'firing pending alerts', run: () => setFilter('attention') },
      { id: 'm-silenced', group: 'View', title: 'Show the silenced monitors', keywords: 'muted', run: () => setFilter('silenced') },
      { id: 'm-all', group: 'View', title: 'Show every monitor', keywords: 'all alerts rules', run: () => setFilter('all') },
    ],
    'static',
  )

  const waiting = list.isFetching
  const wait = useWaiting(waiting)
  const error = list.isError ? list.error : null
  const data = error ? undefined : list.data
  const now = data?.nowMs ?? Date.now()
  const rows = useMemo(() => (data ? sortMonitors(data.monitors) : []), [data])
  const forbidden = error !== null && errorKind(error) === 'scope'
  const firstRun = !!data && data.total === 0
  const counts = data ? COUNT_WORDS.filter(([k]) => (data.counts[k] ?? 0) > 0).map(([k, w]) => `${data.counts[k]} ${w}`) : []
  const stale = list.isPlaceholderData

  return (
    <div className="vz-page" data-testid="monitors-list">
      <header className="vz-page-head">
        <div>
          <h1 className="vz-page-title">Monitors</h1>
          <p className="vz-page-sub" data-testid="monitors-sub">
            {data && data.total > 0 ? (
              <>
                <span className="vz-qty">{data.total}</span> monitors: {counts.join(', ')}.{' '}
                {data.lastEvaluationMs ? (
                  <>
                    Evaluated <Ago ms={data.lastEvaluationMs} />.
                  </>
                ) : null}
              </>
            ) : (
              ' '
            )}
          </p>
        </div>
        {!forbidden && !firstRun && (
          <div className="vz-controls">
            <div className="vz-segmented" role="group" aria-label="Which monitors" data-testid="monitors-filter">
              {(['attention', 'silenced', 'all'] as const).map((f) => (
                <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)} data-filter={f}>
                  {FILTER_WORDS[f]}
                </button>
              ))}
            </div>
          </div>
        )}
      </header>

      <section className="vz-panel-body" aria-label="Monitors" aria-busy={waiting} data-testid="monitors-region">
        {wait.shown && (
          <div className="vz-progress" data-unmeasured="" data-testid="monitors-progress">
            <div className="vz-progress-text">
              <span role="status">Asking the API for the monitors.</span>
              <span className="vz-qty" aria-hidden="true">
                {(wait.elapsedMs / 1000).toFixed(1)} s
              </span>
            </div>
          </div>
        )}
        {error ? (
          forbidden ? (
            <NoMonitorPermission error={error} onSignIn={() => signOut('left')} />
          ) : (
            <div className="vz-empty" role="alert" data-testid="monitors-error">
              <p className="vz-empty-title">
                <span className="vz-mark" data-state="critical" />
                The monitors could not be listed
              </p>
              <p data-testid="monitors-error-message">{error.message}</p>
              <p>
                {answerLine(error)} {errorKind(error) === 'auth' ? 'The API no longer accepts the key this tab signed in with. Sign in again.' : 'Nothing was changed. Ask again; if it keeps failing, note the time and report it.'}
              </p>
              <div className="vz-controls">
                {errorKind(error) === 'auth' ? (
                  <button className="vz-button" data-size="sm" onClick={() => signOut('refused')}>
                    Sign in again
                  </button>
                ) : (
                  <button className="vz-button" data-size="sm" onClick={() => void list.refetch()} aria-busy={waiting} data-testid="monitors-retry">
                    Ask again
                  </button>
                )}
              </div>
            </div>
          )
        ) : firstRun ? (
          <section className="vz-start" data-testid="monitors-first-run" aria-labelledby="no-monitors">
            <h2 className="vz-section-title" id="no-monitors">
              No monitors yet
            </h2>
            <p>A monitor watches one query against a threshold and tells its receiver when the query stays past it. Once one exists it is listed here with its state, owner and receiver.</p>
            <ol className="vz-steps">
              <li>
                <p>
                  This app cannot make a monitor yet. Create one through the monitors API (<span className="vz-qty">POST /api/v1/monitors</span>, with a key that has the <span className="vz-qty">monitors:write</span> scope), or import a Prometheus rule file.
                </p>
              </li>
            </ol>
          </section>
        ) : data && rows.length === 0 ? (
          <div className="vz-empty" role="status" data-testid="monitors-empty">
            <p className="vz-empty-title">{filter === 'silenced' ? 'No monitor is silenced' : 'Nothing needs attention'}</p>
            <p>
              {filter === 'silenced' ? 'No monitor has every alert silenced. ' : 'No monitor is firing, pending, without data or failing to evaluate. '}
              There {data.total === 1 ? 'is 1 monitor' : `are ${data.total} monitors`} in all.
            </p>
            <div className="vz-controls">
              <button className="vz-button" data-size="sm" onClick={() => setFilter('all')} data-focus-after="[data-filter=all]" data-testid="monitors-show-all">
                Show every monitor
              </button>
            </div>
          </div>
        ) : data ? (
          <>
            <p className="vz-table-caption" data-testid="monitors-caption">
              {filter === 'all' ? (
                <>
                  <span className="vz-qty">{rows.length}</span> monitors, attention first
                </>
              ) : (
                <>
                  <span className="vz-qty">{rows.length}</span> of <span className="vz-qty">{data.total}</span> monitors {filter === 'silenced' ? 'are silenced' : 'need attention'}, firing first
                </>
              )}
              {stale ? '. Showing the previous filter' : ''}.
            </p>
            <div className="vz-table-wrap">
              <table className="vz-table" data-fold="wide" role="table">
                <thead>
                  <tr role="row">
                    <th role="columnheader" className="vz-label">
                      Monitor
                    </th>
                    <th role="columnheader" className="vz-label" data-priority="1">
                      State
                    </th>
                    <th role="columnheader" className="vz-label">
                      Value
                    </th>
                    <th role="columnheader" className="vz-label">
                      Threshold
                    </th>
                    <th role="columnheader" className="vz-label">
                      Owner
                    </th>
                    <th role="columnheader" className="vz-label">
                      Notifies
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <Row key={m.id} m={m} now={now} />
                  ))}
                </tbody>
              </table>
            </div>
            <details className="vz-details" data-testid="monitors-text" onToggle={(e) => setTextOpen((e.target as HTMLDetailsElement).open)}>
              <summary>Text form</summary>
              {textOpen && (
                <pre className="vz-query code-scroll is-prose" tabIndex={0} aria-label="Text form of the monitors" data-testid="monitors-digest">
                  {listText(rows, filter, data.total, now)}
                </pre>
              )}
            </details>
          </>
        ) : null}
      </section>
    </div>
  )
}

function Row({ m, now }: { m: Monitor; now: number }) {
  return (
    <tr role="row" data-testid="monitor-row" data-monitor={m.id} data-state={m.state}>
      <td role="cell" data-key="">
        <Link to="/monitors" search={{ id: m.id }} className="vz-link" data-testid={`open-${m.id}`}>
          {m.name}
        </Link>
      </td>
      <td role="cell" data-label="State" data-priority="1" className="cell-wrap" data-testid="monitor-state">
        <Status words={stateWords(m, now)} />
      </td>
      <td role="cell" data-label="Value" className="vz-num">
        {m.state === 'no_data' ? 'no data' : m.state === 'error' ? 'none' : valueWords(m.value, m)}
      </td>
      <td role="cell" data-label="Threshold" className="vz-num">
        {m.thresholdText ?? 'the query is the condition'}
      </td>
      <td role="cell" data-label="Owner">
        {m.owner || 'nobody'}
      </td>
      <td role="cell" data-label="Notifies" className="cell-wrap">
        {receiverWords(m)}
      </td>
    </tr>
  )
}

/** The key may not read monitors (403): the ruler's words, the scopes the key has, and the way to another key. */
export function NoMonitorPermission({ error, onSignIn }: { error: Error; onSignIn: () => void }) {
  const { session } = useSession()
  const scopes = session.status === 'in' ? (session.identity?.scopes ?? null) : null
  return (
    <div className="vz-empty" role="alert" data-testid="monitors-no-permission">
      <p className="vz-empty-title">
        <span className="vz-mark" data-state="critical" />
        This key cannot read monitors
      </p>
      <p data-testid="monitors-no-permission-message">
        The API said: {error.message}.
        {scopes ? (
          <>
            {' '}
            The key this tab signed in with has {scopes.length ? <span className="vz-qty">{scopes.join(', ')}</span> : 'no scopes'}.
          </>
        ) : null}
      </p>
      <p>
        To see monitors, sign in with a key that has the <span className="vz-qty">{READ_SCOPE}</span> scope. Explore still works with this key if it has <span className="vz-qty">read</span>.
      </p>
      <div className="vz-controls">
        <button className="vz-button" data-size="sm" onClick={onSignIn} data-testid="monitors-sign-in">
          Sign in with another key
        </button>
      </div>
    </div>
  )
}
