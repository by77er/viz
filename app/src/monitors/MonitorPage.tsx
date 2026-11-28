import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { answerLine, errorKind } from '../api/errors'
import { getMonitor, setAcknowledged, silenceMonitor, undoSilence, ACK_SCOPE, RulerApiError, type Acknowledgement, type Monitor, type MonitorDocument, type MonitorList } from '../api/monitors'
import { Chart, toSpec } from '../charts'
import { reservedStyle } from '../charts/Chart'
import { windowOf } from '../dashboards/model'
import { RangeControls, TimeRangeField } from '../explore/TimeRangeField'
import { useWaiting } from '../explore/waiting'
import { alignSeries } from '../lib/series'
import { stepWords, type TimeSpec } from '../lib/time'
import { LOCAL, zoneShiftMs } from '../lib/timeInput'
import type { UnitId } from '../lib/units'
import { useCommands } from '../shell/commands'
import { useSession } from '../shell/session'
import { NoMonitorPermission } from './MonitorsListPage'
import { DEFAULT_RANGE, historyLines, lastChange, lastSilencer, lasted, mayAct, monitorText, ReadGuard, receiverWords, stateWords, undoLeftMs, undoOpen, valueWords, when, who, type MonitorsSearch, type Undo } from './model'
import { Ago, Status, Words } from './Status'

type Action = 'acknowledge' | 'unacknowledge' | 'silence' | 'undo'
const ACTION_WORDS: Record<Action, string> = { acknowledge: 'acknowledge the monitor', unacknowledge: 'take the acknowledgement back', silence: 'silence the monitor', undo: 'undo the silence' }
/** The choices of "Silence…": Prometheus durations, as the API takes them, and as they are read. */
const DURATIONS: { spec: string; words: string; ms: number }[] = [
  { spec: '15m', words: '15 min', ms: 15 * 60_000 },
  { spec: '1h', words: '1 h', ms: 3_600_000 },
  { spec: '4h', words: '4 h', ms: 4 * 3_600_000 },
]

/** What the last write said is now true, until a read made after it is on screen. */
interface Override {
  acknowledged?: Acknowledgement | null
  silencedUntil?: number | null
}

/** One monitor's document, read by this page: an answer to a read that started before the latest write is not painted (`ReadGuard`). */
function useMonitorDocument(id: string) {
  const { client } = useSession()
  const guard = useRef(new ReadGuard()).current
  const [doc, setDoc] = useState<(MonitorDocument & { receivedAt: number }) | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [reading, setReading] = useState(0)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const read = useCallback(async () => {
    const stamp = guard.stamp()
    setReading((n) => n + 1)
    try {
      const d = await getMonitor(client, id)
      if (!live.current || !guard.current(stamp)) return false
      setDoc({ ...d, receivedAt: Date.now() })
      setError(null)
      return true
    } catch (e) {
      if (live.current && guard.current(stamp)) setError(e as Error)
      return false
    } finally {
      if (live.current) setReading((n) => n - 1)
    }
  }, [client, id, guard])
  useEffect(() => {
    void read()
    // Kept fresh while open, without a waiting state (Automatic refresh never shows progress).
    const t = setInterval(() => void read(), 30_000)
    return () => clearInterval(t)
  }, [read])
  return { doc, error, reading: reading > 0, read, guard }
}

export function MonitorPage({ id, search }: { id: string; search: MonitorsSearch }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { client, connectionId, session, signOut } = useSession()
  const { doc, error, reading, read, guard } = useMonitorDocument(id)
  const identity = session.status === 'in' ? session.identity : null
  const me = identity?.subject ?? null

  // The name and state a list in this tab already has, shown before the monitor's own answer.
  const cachedList = useMemo<{ monitor: Monitor; at: number } | null>(() => {
    for (const [, list] of queryClient.getQueriesData<MonitorList>({ queryKey: ['monitors', connectionId] })) {
      const hit = list?.monitors.find((m) => m.id === id)
      if (hit) return { monitor: hit, at: list!.nowMs }
    }
    return null
  }, [queryClient, connectionId, id])
  const cached = cachedList?.monitor ?? null
  // The head first, and the rest of the page in the next frame: opening a monitor paints its name, state and actions at once.
  const [bodyReady, setBodyReady] = useState(false)
  useEffect(() => {
    const r = requestAnimationFrame(() => setBodyReady(true))
    return () => cancelAnimationFrame(r)
  }, [])

  // ---- the two actions
  const [busy, setBusy] = useState<Action | null>(null)
  const [failure, setFailure] = useState<{ action: Action; error: Error } | null>(null)
  const [override, setOverride] = useState<Override | null>(null)
  const [undo, setUndo] = useState<Undo | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const [closedUndo, setClosedUndo] = useState<{ at: number; until: number | null } | null>(null)
  const [focusTo, setFocusTo] = useState<string | null>(null)
  const [tick, setTick] = useState(() => Date.now())
  const [textOpen, setTextOpen] = useState(false)
  const allowed = refused !== null ? false : mayAct(identity?.scopes ?? null)

  const base = doc?.monitor ?? cached
  const monitor = useMemo<Monitor | null>(() => (base && override ? { ...base, ...override } : base), [base, override])
  const firing = monitor ? monitor.alerts.filter((a) => a.state === 'firing') : []
  const now = doc ? doc.nowMs + (tick - doc.receivedAt) : tick

  useEffect(() => {
    document.title = monitor ? `${monitor.name} · Monitors · viz` : 'Monitors · viz'
  }, [monitor?.name])

  // The page's clock, for ages and the undo window: once a second, four times while an undo is open.
  useEffect(() => {
    const t = setInterval(
      () => {
        const n = Date.now()
        setTick(n)
        if (undo && !undoOpen(undo, id, n)) {
          setClosedUndo({ at: undo.undoUntil - undo.skewMs, until: undo.until })
          setUndo(null)
        }
      },
      undo ? 250 : 1000,
    )
    return () => clearInterval(t)
  }, [undo, id])

  useEffect(() => {
    if (!focusTo) return
    const el = document.querySelector<HTMLElement>(`[data-testid="${focusTo}"]`)
    if (el) {
      el.focus()
      setFocusTo(null)
    }
  }, [focusTo, override, undo, busy, doc])

  /** After a write: what it said is shown at once, the monitor is read again, and the lists are asked again when next shown. */
  const settle = useCallback(
    async (next: Override | null) => {
      guard.bump()
      setOverride(next)
      void queryClient.invalidateQueries({ queryKey: ['monitors', connectionId] })
      if (await read()) setOverride(null)
    },
    [guard, queryClient, connectionId, read],
  )

  const act = useCallback(
    async (action: Action, duration?: string) => {
      // Never sent: a key that may not act, an action already running, nothing to act on.
      if (allowed === false || busy !== null || !monitor) return
      if (action === 'undo' && !undoOpen(undo, monitor.id, Date.now())) return
      setBusy(action)
      setFailure(null)
      // A read in flight now describes the monitor before this write: it is not painted.
      guard.bump()
      try {
        if (action === 'acknowledge' || action === 'unacknowledge') {
          const r = await setAcknowledged(client, monitor.id, action === 'acknowledge')
          setFocusTo(action === 'acknowledge' ? 'unacknowledge' : 'acknowledge')
          // The first acknowledgement stands: one already there keeps who took it.
          await settle({ acknowledged: action === 'acknowledge' ? (monitor.acknowledged ?? { by: r.by, at: r.at }) : null })
        } else if (action === 'silence') {
          const r = await silenceMonitor(client, monitor.id, duration ?? '1h')
          const skew = doc ? doc.nowMs - doc.receivedAt : 0
          setClosedUndo(null)
          setUndo(r.undoToken && r.undoUntil ? { monitor: monitor.id, token: r.undoToken, undoUntil: r.undoUntil, until: r.until, skewMs: skew } : null)
          setFocusTo(r.undoToken ? 'undo' : 'silence')
          await settle({ silencedUntil: r.until ?? monitor.silencedUntil })
        } else if (action === 'undo' && undo) {
          await undoSilence(client, undo.token)
          setUndo(null)
          setFocusTo('silence')
          await settle({ silencedUntil: null })
        }
      } catch (e) {
        // Nothing on screen changes: the control comes back with the API's words under it.
        const err = e as Error
        setFailure({ action, error: err })
        if (err instanceof RulerApiError && err.status === 403) setRefused(err.message)
        if (action === 'undo' && err instanceof RulerApiError && err.status === 410 && undo) {
          setClosedUndo({ at: undo.undoUntil - undo.skewMs, until: undo.until })
          setUndo(null)
        }
      } finally {
        setBusy(null)
      }
    },
    [allowed, busy, monitor, undo, client, doc, guard, settle],
  )

  useCommands(
    'monitor',
    [
      ...(allowed !== false && firing.length > 0 && !monitor?.acknowledged ? [{ id: 'mon-ack', group: 'View' as const, title: 'Acknowledge this monitor', keywords: 'take ack', run: () => void act('acknowledge') }] : []),
      ...(allowed !== false && firing.length > 0 && monitor?.silencedUntil == null ? [{ id: 'mon-silence', group: 'View' as const, title: 'Silence this monitor for 1 h', keywords: 'mute snooze', run: () => void act('silence', '1h') }] : []),
      { id: 'mon-refresh', group: 'View', title: 'Read this monitor again', keywords: 'refresh reload', run: () => void read() },
      { id: 'mon-list', group: 'Navigation', title: 'Go to the list of monitors', run: () => void navigate({ to: '/monitors', search: {} }) },
    ],
    `${allowed}/${firing.length}/${!!monitor?.acknowledged}/${monitor?.silencedUntil ?? ''}/${busy}`,
  )

  const wait = useWaiting(reading && !doc)
  const from = search.from ?? DEFAULT_RANGE.from
  const to = search.to ?? DEFAULT_RANGE.to
  const onRange = useCallback((f: TimeSpec, t: TimeSpec) => void navigate({ to: '/monitors', search: (prev) => ({ ...prev, from: f, to: t }), resetScroll: false, replace: true }), [navigate])

  // ---- it could not be read at all
  if (error && !doc) {
    const missing = error instanceof RulerApiError && error.status === 404
    return (
      <div className="vz-page" data-testid="monitor-page">
        <header className="vz-page-head">
          <div>
            <h1 className="vz-page-title">{monitor?.name ?? 'Monitor'}</h1>
          </div>
        </header>
        {errorKind(error) === 'scope' ? (
          <NoMonitorPermission error={error} onSignIn={() => signOut('left')} />
        ) : (
          <div className="vz-empty" role="alert" data-testid="monitor-error">
            <p className="vz-empty-title">
              <span className="vz-mark" data-state="critical" />
              {missing ? 'There is no such monitor' : 'The monitor could not be read'}
            </p>
            <p data-testid="monitor-error-message">
              {missing ? (
                <>
                  No monitor of this tenant has the id <span className="vz-qty">{id}</span>. It may have been deleted, or the link may be another tenant's.
                </>
              ) : (
                error.message
              )}
            </p>
            {!missing && (
              <p>
                {answerLine(error)} {errorKind(error) === 'auth' ? 'Sign in again with a key that is valid now.' : 'Nothing was changed. Ask again; if it keeps failing, note the time and report it.'}
              </p>
            )}
            <div className="vz-controls">
              {!missing && errorKind(error) !== 'auth' && (
                <button className="vz-button" data-size="sm" onClick={() => void read()} aria-busy={reading} data-testid="monitor-retry">
                  Ask again
                </button>
              )}
              <Link to="/monitors" search={{}} className="vz-link" data-testid="to-list">
                See every monitor
              </Link>
            </div>
          </div>
        )}
      </div>
    )
  }

  const stateLine = monitor ? stateWords(monitor, now, true) : null
  const silencer = doc ? lastSilencer(doc) : null
  const changed = doc ? lastChange(doc.history.entries) : null
  const notified = firing.map((a) => a.lastNotifiedAt).filter((t): t is number => t !== null)
  const repeats = firing.map((a) => a.nextRepeatAt).filter((t): t is number => t !== null)
  const doneText = monitor?.acknowledged ? `Acknowledged by ${who(monitor.acknowledged.by, me)} at ${when(monitor.acknowledged.at, now)}` : null
  const undoShown = !!monitor && undoOpen(undo, monitor.id, tick)

  return (
    <div className="vz-page" data-testid="monitor-page" data-monitor={id}>
      <header className="vz-page-head">
        <div>
          <h1 className="vz-page-title" data-testid="monitor-title">
            {monitor?.name ?? ' '}
          </h1>
          <p className="vz-page-state" data-testid="monitor-state" data-state={monitor?.state}>
            {stateLine ? (
              <>
                <span className="vz-mark" data-state={stateLine.mark || undefined} data-testid="monitor-mark" />
                <Words words={stateLine} />
              </>
            ) : (
              ' '
            )}
          </p>
          <p className="vz-page-sub" data-testid="monitor-sub">
            {monitor ? (
              <>
                {firing.length > 0 && !monitor.acknowledged ? 'Not acknowledged. ' : ''}
                {notified.length ? (
                  <>
                    Notified {receiverWords(monitor)} at <time className="vz-qty">{when(Math.min(...notified), now)}</time>
                    {repeats.length && !monitor.acknowledged && !monitor.silencedUntil ? (
                      <>
                        ; repeats at <time className="vz-qty">{when(Math.min(...repeats), now)}</time>
                      </>
                    ) : monitor.acknowledged || monitor.silencedUntil ? '; no repeats while someone has it' : ''}
                    .{' '}
                  </>
                ) : (
                  <>Notifies {receiverWords(monitor)}. </>
                )}
                {doc || cachedList ? (
                  <>
                    Read <Ago ms={doc ? doc.receivedAt : cachedList!.at} />.
                  </>
                ) : null}
              </>
            ) : (
              ' '
            )}
          </p>
        </div>
        {monitor && (
          <div className="vz-notice-group" data-testid="monitor-actions">
            <div className="vz-controls">
              {firing.length > 0 && (
                <>
                  {monitor.acknowledged ? (
                    <span className="vz-done" data-testid="ack-done">
                      <span className="vz-status" data-state="ack" data-testid="ack-done-words">
                        {doneText}
                      </span>
                      <button className="vz-button" data-size="sm" onClick={() => void act('unacknowledge')} aria-busy={busy === 'unacknowledge'} aria-disabled={allowed === false || undefined} aria-describedby={allowed === false ? 'act-why' : undefined} data-testid="unacknowledge">
                        Unacknowledge
                      </button>
                    </span>
                  ) : (
                    <button className="vz-button" data-tone="green" onClick={() => void act('acknowledge')} aria-busy={busy === 'acknowledge'} aria-disabled={allowed === false || undefined} aria-describedby={allowed === false ? 'act-why' : undefined} data-testid="acknowledge">
                      Acknowledge
                    </button>
                  )}
                  {monitor.silencedUntil !== null ? (
                    <span className="vz-done" data-testid="silence-done">
                      <span className="vz-status" data-state="silenced" data-testid="silence-done-words">
                        Silenced{silencer ? ` by ${who(silencer, me)}` : ''} until {when(monitor.silencedUntil, now)}
                      </span>
                      {undoShown && (
                        <button className="vz-button" data-size="sm" onClick={() => void act('undo')} aria-busy={busy === 'undo'} data-testid="undo">
                          Undo
                        </button>
                      )}
                    </span>
                  ) : (
                    <SilenceMenu disabled={allowed === false} busy={busy === 'silence'} now={now} onSilence={(d) => void act('silence', d)} />
                  )}
                </>
              )}
              <button className="vz-button" onClick={() => void read()} aria-busy={reading} data-testid="refresh">
                Refresh
              </button>
            </div>
            {failure && (
              <div className="vz-notice" role="alert" data-testid="action-failure">
                <span className="vz-mark" data-state="critical" />
                <p>
                  Could not {ACTION_WORDS[failure.action]}. The API said: <span data-testid="action-failure-words">{failure.error.message}</span> ({answerLine(failure.error).replace(/^The API answered /, '').replace(/\.$/, '')}).{' '}
                  {failure.action === 'undo' && failure.error instanceof RulerApiError && failure.error.status === 410
                    ? `The undo window had closed, so the silence stays${monitor.silencedUntil ? ` until ${when(monitor.silencedUntil, now)}` : ''}.`
                    : failure.action === 'acknowledge'
                      ? 'Nothing changed: it is still not acknowledged.'
                      : failure.action === 'silence'
                        ? 'Nothing changed: it is not silenced and still notifies.'
                        : 'Nothing changed.'}
                </p>
                {!(failure.error instanceof RulerApiError && (failure.error.status === 403 || failure.error.status === 410)) && (
                  <button className="vz-button" data-size="sm" onClick={() => void act(failure.action)} data-testid="action-retry">
                    Try again
                  </button>
                )}
                <button className="vz-button" data-size="sm" data-quiet="" onClick={() => setFailure(null)} data-testid="action-dismiss">
                  Dismiss
                </button>
              </div>
            )}
            {allowed === false && firing.length > 0 && (
              <p className="vz-help" id="act-why" data-testid="act-why">
                This key cannot acknowledge or silence:{' '}
                {refused ? (
                  <>the API said &ldquo;{refused}&rdquo;</>
                ) : (
                  <>
                    it lacks the <span className="vz-qty">{ACK_SCOPE}</span> scope (it has {identity?.scopes.join(', ') || 'no scopes'})
                  </>
                )}
                . Sign in with an on-call key to act.
              </p>
            )}
            {undo && undoShown && (
              <p className="vz-help" data-testid="undo-window">
                Undo is open until <time className="vz-qty">{when(undo.undoUntil - undo.skewMs, tick)}</time> (<span className="vz-qty">{Math.floor(undoLeftMs(undo, tick) / 1000)} s</span> left).
              </p>
            )}
            {!undoShown && closedUndo && monitor.silencedUntil !== null && (
              <p className="vz-help" data-testid="undo-closed">
                The undo window closed at <time className="vz-qty">{when(closedUndo.at, tick)}</time>. The silence ends at <time className="vz-qty">{when(monitor.silencedUntil, now)}</time>; ending it early is not in this app yet.
              </p>
            )}
            {firing.length === 0 && (
              <p className="vz-help" data-testid="nothing-to-act">
                Nothing to acknowledge or silence: no alert of this monitor is firing.
              </p>
            )}
          </div>
        )}
      </header>

      {!monitor || !bodyReady ? (
        <section className="vz-panel-body" aria-busy="true" data-testid="monitor-waiting">
          {wait.shown && (
            <div className="vz-progress" data-unmeasured="">
              <div className="vz-progress-text">
                <span role="status">Asking the API for the monitor.</span>
                <span className="vz-qty" aria-hidden="true">
                  {(wait.elapsedMs / 1000).toFixed(1)} s
                </span>
              </div>
            </div>
          )}
        </section>
      ) : (
        <div className="vz-split">
          <div>
            <MonitorChart monitor={monitor} from={from} to={to} onRange={onRange} />
            <section className="vz-section" aria-labelledby="alerts-title" data-testid="monitor-alerts">
              <h2 className="vz-section-title" id="alerts-title">
                Alerts
              </h2>
              {monitor.alerts.length === 0 ? (
                <p className="vz-text">{monitor.state === 'error' ? 'None: the query cannot be evaluated, so nothing is compared with the threshold.' : 'None: the query is within its threshold.'}</p>
              ) : (
                <>
                  <p className="vz-table-caption">
                    <span className="vz-qty">{monitor.alerts.length}</span> {monitor.alerts.length === 1 ? 'alert' : 'alerts'}, oldest first.
                  </p>
                  <div className="vz-table-wrap">
                    <table className="vz-table" data-fold="wide" role="table">
                      <thead>
                        <tr role="row">
                          <th role="columnheader" className="vz-label">
                            Labels
                          </th>
                          <th role="columnheader" className="vz-label" data-priority="1">
                            State
                          </th>
                          <th role="columnheader" className="vz-label">
                            Value
                          </th>
                          <th role="columnheader" className="vz-label">
                            Acknowledged
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {monitor.alerts.map((a) => (
                          <tr role="row" key={a.fingerprint} data-testid="alert-row" data-fingerprint={a.fingerprint}>
                            <td role="cell" data-key="" className="cell-wrap">
                              {Object.entries(a.labels)
                                .filter(([k]) => k !== 'alertname')
                                .map(([k, v]) => `${k}=${v}`)
                                .join(', ') || 'no labels'}
                            </td>
                            <td role="cell" data-label="State" data-priority="1" className="cell-wrap">
                              <Status
                                words={{
                                  mark: a.silencedUntil ? 'silenced' : a.acknowledged ? 'ack' : a.state === 'firing' ? 'critical' : 'warn',
                                  parts: [{ text: a.state === 'firing' ? (a.noData ? 'No data, firing since ' : 'Firing since ') : 'Pending since ' }, { text: when(a.firingSince ?? a.activeAt, now), qty: true }, ...(a.silencedUntil ? [{ text: ', silenced until ' }, { text: when(a.silencedUntil, now), qty: true }] : [])],
                                }}
                              />
                            </td>
                            <td role="cell" data-label="Value">
                              {a.noData ? 'no data' : valueWords(a.value, monitor)}
                            </td>
                            <td role="cell" data-label="Acknowledged" data-testid="alert-ack">
                              {a.acknowledged ? `by ${who(a.acknowledged.by, me)} at ${when(a.acknowledged.at, now)}` : a.state === 'firing' ? 'not acknowledged' : 'not yet firing'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          </div>
          <div>
            <section className="vz-section" aria-labelledby="definition-title" data-testid="monitor-definition">
              <h2 className="vz-section-title" id="definition-title">
                What it watches
              </h2>
              <dl className="vz-kv">
                <dt>Message</dt>
                <dd>{monitor.message || 'none'}</dd>
                <dt>Description</dt>
                <dd>{monitor.description || 'none'}</dd>
                <dt>Runbook</dt>
                <dd>
                  {monitor.runbookUrl ? (
                    <a className="vz-link" href={monitor.runbookUrl} rel="noreferrer noopener" target="_blank" data-testid="runbook">
                      Open the runbook
                    </a>
                  ) : (
                    'none'
                  )}
                </dd>
                <dt>Threshold</dt>
                <dd data-testid="threshold-text">
                  <span className="vz-qty">{monitor.thresholdText ?? 'none: the query is the condition'}</span>
                </dd>
                <dt>For</dt>
                <dd>{monitor.forMs ? lasted(monitor.forMs) : 'at once'}</dd>
                <dt>If no data</dt>
                <dd>{monitor.noData === 'alerting' ? `it fires after ${lasted(monitor.noDataForMs || monitor.forMs || 60_000)}` : monitor.noData === 'keep' ? 'it keeps its last state' : 'it resolves'}</dd>
                <dt>Receiver</dt>
                <dd>{receiverWords(monitor)}</dd>
                <dt>Owner</dt>
                <dd>{monitor.owner || 'nobody'}</dd>
                <dt>Evaluated</dt>
                <dd>
                  every {lasted(monitor.intervalMs || 60_000)}
                  {monitor.lastEvaluationMs ? (
                    <>
                      , last at <time className="vz-qty">{when(monitor.lastEvaluationMs, now)}</time>
                    </>
                  ) : null}
                </dd>
                {monitor.lastError && (
                  <>
                    <dt>Last error</dt>
                    <dd data-testid="last-error">{monitor.lastError}</dd>
                  </>
                )}
                <dt>Changed</dt>
                <dd>{changed ? `${changed.kind === 'created' ? 'created' : 'changed'} by ${who(changed.by ?? 'someone', me)} at ${when(changed.at, now)}` : doc ? 'not in its history' : 'asking'}</dd>
              </dl>
            </section>
          </div>
        </div>
      )}
      {monitor && bodyReady && (
        // Under both columns: the history arrives with the monitor's own answer, and nothing that is already on screen is below it.
        <div className="vz-sections">
            <section className="vz-section" aria-labelledby="history-title" data-testid="monitor-history">
              <h2 className="vz-section-title" id="history-title">
                History, newest first
              </h2>
              {doc ? (
                <>
                  <ol className="vz-timeline">
                    {historyLines(doc, me).map((h, i) => (
                      <li key={`${h.at}-${i}`} data-testid="history-line">
                        <time className="vz-qty">{when(h.at, now)}</time>
                        <span className="vz-mark" data-state={h.mark || undefined} />
                        <p>{h.sentence}</p>
                      </li>
                    ))}
                  </ol>
                  {doc.history.dropped > 0 && <p className="vz-secondary">{doc.history.dropped} older entries were dropped: the API keeps 200 per monitor.</p>}
                </>
              ) : (
                <p className="vz-secondary">Asking the API for the history.</p>
              )}
            </section>
            {doc && (
              <details className="vz-details" data-testid="monitor-text" onToggle={(e) => setTextOpen((e.target as HTMLDetailsElement).open)}>
                <summary>Text form of this monitor</summary>
                {/* Written when opened: a closed disclosure holds no well to scroll or focus. */}
                {textOpen && (
                  <pre className="vz-query code-scroll is-prose" tabIndex={0} aria-label="Text form of this monitor" data-testid="monitor-digest">
                    {monitorText({ ...doc, monitor }, me, now, doneText)}
                  </pre>
                )}
              </details>
            )}
        </div>
      )}
    </div>
  )
}

/** "Silence…": a menu that confirms a cautionary choice (Menu): the durations, what will happen, and the yellow button that does it. */
function SilenceMenu({ disabled, busy, now, onSilence }: { disabled: boolean; busy: boolean; now: number; onSilence: (duration: string) => void }) {
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState(DURATIONS[1]!)
  const anchor = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        opener.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    anchor.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="vz-menu-anchor" ref={anchor}>
      <button
        ref={opener}
        className="vz-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={busy}
        aria-disabled={disabled || undefined}
        aria-describedby={disabled ? 'act-why' : undefined}
        onClick={() => {
          if (!disabled && !busy) setOpen((o) => !o)
        }}
        data-testid="silence"
      >
        Silence…
      </button>
      <div className="vz-menu" role="menu" aria-label="Silence for" data-open={open ? '' : undefined} data-testid="silence-menu">
        {DURATIONS.map((d) => (
          <button key={d.spec} role="menuitemradio" aria-checked={choice.spec === d.spec} onClick={() => setChoice(d)} data-duration={d.spec}>
            {d.words}
          </button>
        ))}
        <div role="separator" />
        <p className="vz-menu-note">
          Notifications stop until <span className="vz-qty">{when(now + choice.ms, now)}</span>. The monitor keeps evaluating and stays listed, and its history says who silenced it.
        </p>
        <div className="vz-controls">
          <button
            className="vz-button"
            data-tone="yellow"
            onClick={() => {
              setOpen(false)
              onSilence(choice.spec)
            }}
            data-testid="silence-confirm"
          >
            Silence for {choice.words}
          </button>
        </div>
      </div>
    </div>
  )
}

const UNIT_OF: Record<string, UnitId> = { s: 'seconds', seconds: 'seconds', bytes: 'bytes', B: 'bytes', '/s': 'rps', '%': 'percent' }

/** The monitor's query over a range around now, with its threshold, when it went above and when it fired. */
function MonitorChart({ monitor, from, to, onRange }: { monitor: Monitor; from: TimeSpec; to: TimeSpec; onRange: (f: TimeSpec, t: TimeSpec) => void }) {
  const { client, connectionId } = useSession()
  const query = monitor.query ?? monitor.expr
  const [asked, setAsked] = useState(() => Date.now())
  useEffect(() => setAsked(Date.now()), [from, to])
  const w = useMemo(() => windowOf(from, to, asked / 1000), [from, to, asked])
  const result = useQuery({
    queryKey: ['monitor-chart', connectionId, monitor.id, query, w?.start, w?.end, w?.step],
    enabled: w !== null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const r = await client.queryRangeMatrix(query, w!.start, w!.end, w!.step, { signal })
      return { series: r.matrix.series, window: w! }
    },
  })
  const wait = useWaiting(result.isFetching)
  const unit = UNIT_OF[monitor.condition?.unit ?? ''] ?? 'none'
  const activeAt = monitor.activeAt
  const firingSince = monitor.firingSince
  const condition = monitor.condition
  const drawn = useMemo(() => {
    const d = result.data
    if (!d || d.series.length === 0) return null
    const aligned = alignSeries(d.series, d.window.start, d.window.end, d.window.step)
    const shiftMs = zoneShiftMs(LOCAL, d.window.end * 1000)
    const { spec, unit: u } = toSpec({ data: aligned, start: d.window.start, step: d.window.step, unit, query: monitor.name, shiftMs })
    const nowMs = Date.now()
    const markers = [
      ...(activeAt !== null ? [{ t: activeAt + shiftMs, label: `Above ${when(activeAt, nowMs)}` }] : []),
      ...(firingSince !== null ? [{ t: firingSince + shiftMs, label: `Fired ${when(firingSince, nowMs)}` }] : []),
    ]
    return {
      spec: {
        ...spec,
        ...(condition ? { threshold: { value: condition.threshold * u.scale, label: `${condition.op} ${condition.threshold}${condition.unit ? ` ${condition.unit}` : ''} threshold` } } : {}),
        ...(firingSince !== null ? { spans: [{ from: firingSince + shiftMs, to: d.window.end * 1000 + shiftMs, label: `Firing since ${when(firingSince, nowMs)}` }] } : {}),
        markers,
      },
      shiftMs,
    }
  }, [result.data, unit, monitor.name, activeAt, firingSince, condition])
  const stale = result.isPlaceholderData
  const failed = result.isError ? result.error : null
  return (
    <section className="vz-panel" aria-labelledby="chart-title" aria-busy={result.isFetching} data-testid="monitor-chart" data-state={result.isFetching ? 'waiting' : failed ? 'failed' : drawn ? 'drawn' : result.data ? 'empty' : 'idle'}>
      <div className="vz-panel-head">
        <h2 className="vz-panel-title" id="chart-title">
          The query, with its threshold
        </h2>
        <span className="vz-panel-meta" data-testid="chart-meta">
          {stale ? (
            <span className="vz-panel-note">Showing the previous range</span>
          ) : result.data ? (
            <span>
              every <span className="vz-qty">{stepWords(result.data.window.step)}</span>
            </span>
          ) : (
            <span className="is-reserved">every 30 s</span>
          )}
        </span>
      </div>
      <div className="vz-stack">
        <RangeControls from={from} to={to} onChange={onRange} shown={null} />
        <div className="vz-dashboard">
          <div className="vz-grid">
            <TimeRangeField from={from} to={to} onChange={onRange} />
          </div>
        </div>
      </div>
      <pre className="vz-query code-scroll" tabIndex={0} aria-label="The monitor's query" data-testid="monitor-query">
        {query}
      </pre>
      <div className="vz-panel-body" data-view="chart">
        {wait.shown && (
          <div className="vz-progress" data-unmeasured="" data-testid="chart-progress">
            <div className="vz-progress-text">
              <span role="status">Waiting for the query.</span>
              <span className="vz-qty" aria-hidden="true">
                {(wait.elapsedMs / 1000).toFixed(1)} s
              </span>
            </div>
          </div>
        )}
        {failed && !drawn ? (
          <div className="vz-empty" role="alert" data-testid="chart-error">
            <p className="vz-empty-title">
              <span className="vz-mark" data-state="critical" />
              The query could not be drawn
            </p>
            <p data-testid="chart-error-message">{failed.message}</p>
            <p>{answerLine(failed)} The ruler runs the same query, which is why the monitor cannot be evaluated.</p>
          </div>
        ) : drawn ? (
          <Chart spec={drawn.spec} shiftMs={drawn.shiftMs} stepWords={stepWords(result.data!.window.step)} view={`monitor:${monitor.id}`} textFormId="monitor-chart-text" error={failed ? { title: 'The latest query failed', node: <p>{failed.message}</p> } : null} parked={false} />
        ) : result.data ? (
          <div className="vz-empty" role="status" data-testid="chart-empty">
            <p className="vz-empty-title">The query returned no series</p>
            <p>Nothing matched it in this range.{monitor.noData === 'alerting' ? ' This monitor counts no data as firing.' : ''}</p>
          </div>
        ) : (
          // One series reserved (a monitor's query usually draws one), or what this view drew last.
          <div className="vz-chart" style={{ '--legend-rows': 1, '--legend-notes': 0, ...reservedStyle(`monitor:${monitor.id}`) } as CSSProperties} data-testid="chart-reserved" />
        )}
      </div>
      {!monitor.condition && <p className="vz-secondary">The monitor is written as one expression, so no threshold line is drawn: what the chart shows is the series that meet the condition.</p>}
      <details className="vz-details" data-testid="chart-text">
        <summary>The chart as text</summary>
        <ul className="vz-text-form" id="monitor-chart-text" />
      </details>
      <ul className="vz-links">
        <li>
          <Link to="/explore" search={{ q: query, from, to }} className="vz-link" data-testid="open-in-explore">
            Open in Explore
          </Link>
        </li>
      </ul>
    </section>
  )
}
