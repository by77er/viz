import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { PromApiError } from '../api/client'
import { answerLine, busyLine, errorAdvice, errorKind, retryDelayMs, shouldRetry } from '../api/errors'
import type { ParsedMatrix } from '../api/matrix'
import type { ApiCost } from '../api/types'
import { Chart, figureFormat, toSpec, type ShownRange } from '../charts'
import { reservedStyle } from '../charts/Chart'
import { chartRules } from '../charts/systemChart'
import type { PromqlEditorHandle } from '../editor/PromqlEditor'
import { describeResult, identify, type ResultIdentity, type ResultRequest } from '../lib/describe'
import { nameSeries } from '../lib/naming'
import { countRender } from '../lib/renders'
import { alignSeries, seriesStats } from '../lib/series'
import { alignWindow, autoStep, bucketWidth, type QueryWindow } from '../lib/step'
import { parseDuration, resolveTimeSpec, stepWords } from '../lib/time'
import { dayPrefix, LOCAL, momentText, zoneShiftMs } from '../lib/timeInput'
import { inferUnit, UNITS } from '../lib/units'
import { parseExploreSearch, type ExploreSearch, type ResultView } from '../lib/urlState'
import { useBackendInfo } from '../shell/AppShell'
import { MOD, useCommands } from '../shell/commands'
import { useSession } from '../shell/session'
import { Age, shorterRange, useWaiting, WAIT } from './waiting'
import { JsonView } from './JsonView'
import { ResultTable, type TableRow } from './ResultTable'
import { TextView } from './TextView'
import { PRESETS, presetWords, RangeControls, StepField, TimeRangeField } from './TimeRangeField'

const exploreRoute = getRouteApi('/explore')
const PromqlEditor = lazy(() => import('../editor/PromqlEditor'))

const VIEWS: [ResultView, string][] = [
  ['chart', 'Chart'],
  ['table', 'Table'],
  ['text', 'Text'],
  ['json', 'JSON'],
]

const MOCK_EXAMPLES: { title: string; q: string }[] = [
  { title: 'Request rate by service', q: 'sum by (service) (rate(http_requests_total[5m]))' },
  { title: 'p95 latency by service', q: 'histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[5m])))' },
  { title: 'Error ratio (5xx)', q: 'sum(rate(http_requests_total{status="500"}[5m])) / sum(rate(http_requests_total[5m]))' },
  { title: 'CPU by pod (with a gap)', q: 'pod_cpu_usage_cores{service="checkout"}' },
  { title: 'Memory by pod', q: 'pod_memory_working_set_bytes' },
]

/** How long after the last change of form the address bar is brought up to date, in ms. */
const VIEW_URL_DELAY = 300

/** The colour map and the reserved height of this view's chart are kept under this name for the tab's session. */
const CHART_VIEW = 'explore'
const TEXT_FORM = 'explore-text'

/**
 * A result carries what is needed to describe it (lib/describe, design review B1): the
 * request it answers, the window, the unit its query implies and when it arrived. Everything
 * the page writes about data on screen is derived from this object, never from `search`.
 */
interface RangeResult extends ResultIdentity {
  /** The response, read into typed arrays as it arrived (api/matrix.ts). */
  matrix: ParsedMatrix
  warnings: string[]
  /** What the API said the query cost (`X-Viz-*`); kept with the result, not shown yet. */
  cost: ApiCost
  elapsedMs: number
}

/**
 * The query row. The editor owns the text being typed; this component and the page read it
 * only when the query is run, so a keystroke renders nothing here.
 */
const QueryRow = memo(function QueryRow({
  committed,
  loading,
  run,
  client,
  editorRef,
  rangeRef,
  onEditorReady,
}: {
  committed: string
  loading: boolean
  run: () => void
  client: ReturnType<typeof useSession>['client']
  editorRef: React.RefObject<PromqlEditorHandle | null>
  rangeRef: React.RefObject<{ start: number; end: number } | null>
  onEditorReady: () => void
}) {
  countRender('QueryRow')
  return (
    <div className="vz-controls">
      {/* The editor is a chunk of its own; until it has loaded the well shows the query as text, at the same height. */}
      <div className="vz-query query-well" onClick={() => editorRef.current?.focus()} data-testid="query-well">
        <Suspense fallback={<div>{committed || '\u00a0'}</div>}>
          <PromqlEditor value={committed} onRun={run} client={client} handleRef={editorRef} rangeRef={rangeRef} onReady={onEditorReady} />
        </Suspense>
      </div>
      <button className="vz-button" data-tone="blue" onClick={run} aria-busy={loading} data-testid="run" aria-keyshortcuts="Control+Enter Meta+Enter">
        Run query
      </button>
    </div>
  )
})

export function ExplorePage() {
  countRender('ExplorePage')
  const rawSearch = exploreRoute.useSearch()
  const search = useMemo(() => parseExploreSearch(rawSearch), [rawSearch])
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { client, connectionId, hasKey, signOut } = useSession()
  const backend = useBackendInfo()

  const setSearch = useCallback(
    (patch: Partial<ExploreSearch>, replace = false) =>
      void navigate({ to: '/explore', search: (prev) => ({ ...prev, ...patch }), replace }),
    [navigate],
  )

  // ---- query text: the URL holds the committed query; the editor owns the text being typed
  // and is read when the query is run. Nothing here changes on a keystroke.
  const editorRef = useRef<PromqlEditorHandle | null>(null)
  // The editor is a lazy chunk: an error state shown before it loaded asks it again once it has
  // (where the syntax error is). One render, at load; typing renders nothing.
  const [editorReady, setEditorReady] = useState(false)
  const onEditorReady = useCallback(() => setEditorReady(true), [])

  // ---- time window: resolved when the range, the step, the width or the run counter changes.
  const [runId, setRunId] = useState(0)
  const toolsRef = useRef<HTMLDivElement>(null)
  const [widthBucket, setWidthBucket] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = toolsRef.current
    if (!el) return
    const measure = () => setWidthBucket(bucketWidth(el.clientWidth))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const window_ = useMemo<QueryWindow | null>(() => {
    if (widthBucket === null) return null
    const now = Date.now() / 1000
    const start = resolveTimeSpec(search.from, now)
    const end = resolveTimeSpec(search.to, now)
    if (!(end > start)) return null
    const step = search.step === 'auto' ? autoStep(end - start, widthBucket) : (parseDuration(search.step) ?? autoStep(end - start, widthBucket))
    return alignWindow(start, end, step)
    // runId and the query text re-resolve "now" for relative ranges on every run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.from, search.to, search.step, search.q, widthBucket, runId])

  // Autocomplete looks up names and values in the window being queried (editor/promClient.ts).
  const lookupRange = useRef<{ start: number; end: number } | null>(null)
  lookupRange.current = window_ ? { start: window_.start, end: window_.end } : null

  const q = search.q.trim()
  /** What the page now wants answered. A result is compared with it, never described by it. */
  const current = useMemo<ResultRequest>(() => ({ q, from: search.from, to: search.to, step: search.step }), [q, search.from, search.to, search.step])
  // The token is deliberately not part of the key; connectionId changes when settings do.
  const queryKey = ['query_range', connectionId, q, window_?.start, window_?.end, window_?.step, runId]
  /** When the current wait began: retries count against the waiting table's 60 s stop. */
  const waitStartedAt = useRef(0)
  const query = useQuery<RangeResult, Error>({
    queryKey,
    enabled: q !== '' && window_ !== null,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    gcTime: 60_000,
    queryFn: async ({ signal }) => {
      const w = window_!
      const request = current
      const t0 = performance.now()
      const res = await client.queryRangeMatrix(request.q, w.start, w.end, w.step, { signal })
      // The result takes its own description with it: the request, the window, the unit, the time.
      return { ...identify(request, w, Date.now()), matrix: res.matrix, warnings: res.warnings, cost: res.cost, elapsedMs: performance.now() - t0 }
    },
    // A result is new every time and never edited: comparing it with the last one, field by
    // field, is work for nothing.
    structuralSharing: false,
    // A busy API (429, 502, 503 other than its time limit) is asked again after its Retry-After,
    // or 1, 2 and 4 s, at most three times and never past the 60 s stop (api/errors.ts).
    retry: (failures, error) => shouldRetry(error, failures, performance.now() - waitStartedAt.current, WAIT.stopAfter),
    retryDelay: (failures, error) => retryDelayMs(error, failures),
  })

  // ---- waiting: the button is busy at once; the progress line follows the waiting table.
  const loading = q !== '' && query.isFetching
  // When this wait began, and how long the last one lasted (an error reports it).
  const wasLoading = useRef(false)
  const lastWaitMs = useRef(0)
  if (loading && !wasLoading.current) waitStartedAt.current = performance.now()
  if (!loading && wasLoading.current) lastWaitMs.current = performance.now() - waitStartedAt.current
  wasLoading.current = loading
  /** Tries that failed busy in the current wait, and when the next one goes. */
  const failures = loading ? query.failureCount : 0
  const retryClock = useRef({ failures: 0, at: 0 })
  if (failures !== retryClock.current.failures)
    retryClock.current = { failures, at: failures > 0 ? performance.now() + retryDelayMs(query.failureReason, failures - 1) : 0 }
  const loadingRef = useRef(loading)
  loadingRef.current = loading
  const wait = useWaiting(loading)
  /** Why the last wait ended without a result, until the next run. */
  const [halted, setHalted] = useState<'cancelled' | 'stopped' | null>(null)
  const keyRef = useRef(queryKey)
  keyRef.current = queryKey
  const halt = useCallback(
    (why: 'cancelled' | 'stopped') => {
      setHalted(why)
      // Aborts the request through the AbortSignal the API client passes to fetch.
      void queryClient.cancelQueries({ queryKey: keyRef.current })
    },
    [queryClient],
  )
  useEffect(() => {
    if (!loading) return
    setHalted(null)
    const stop = setTimeout(() => halt('stopped'), WAIT.stopAfter)
    return () => clearTimeout(stop)
  }, [loading, halt])

  const committedRef = useRef(search.q)
  committedRef.current = search.q
  const run = useCallback(() => {
    // A second press while the query runs is ignored: the button is busy.
    if (loadingRef.current) return
    // The editor is asked for its text now, at the press; before it has loaded, the committed query stands.
    const next = (editorRef.current?.getValue() ?? committedRef.current).trim()
    setHalted(null)
    // A new query text changes the query key (and re-resolves "now") by itself once the URL
    // has it; bumping the run counter as well would first re-send the old text.
    if (next !== committedRef.current) setSearch({ q: next })
    else setRunId((n) => n + 1)
  }, [setSearch])

  // ---- the result on screen, and its description. `result` may be the previous query's
  // (kept while the next one waits, or after Cancel, the 60 s stop or an error): nothing below
  // this line may read `search.q` or `q` to describe it.
  const result = q === '' ? undefined : query.data
  const description = useMemo(() => (result ? describeResult(result, { unit: search.unit }, current) : null), [result, search.unit, current])
  const aligned = useMemo(
    () => (result ? alignSeries(result.matrix.series, result.window.start, result.window.end, result.window.step) : null),
    [result],
  )
  const hasData = !!aligned && aligned.series.length > 0
  const isEmpty = !!result && result.matrix.series.length === 0

  // ---- the chart: the design system's, given the result as it takes one (charts/spec.ts).
  // Its clock is UTC; the result's times are moved by the local offset at the window's end, so
  // it reads local time, the zone the time range fields state.
  const shiftMs = useMemo(() => (result ? zoneShiftMs(LOCAL, result.window.end * 1000) : 0), [result])
  const chart = useMemo(
    () =>
      hasData && result && description
        ? toSpec({ data: aligned!, start: result.window.start, step: result.window.step, unit: description.unit, query: result.request.q, shiftMs })
        : null,
    [hasData, aligned, result, description, shiftMs],
  )
  const [shownRange, setShownRange] = useState<ShownRange | null>(null)

  // ---- the table: the latest value of each series, in the chart's unit and number format.
  const naming = useMemo(() => nameSeries((aligned?.series ?? []).map((s) => s.labels)), [aligned])
  const table = useMemo(() => {
    if (!aligned || !chart) return null
    const stats = aligned.series.map((s) => seriesStats(aligned.xs, s.values))
    let lo = 0
    let hi = 0
    for (const s of stats) {
      if (s.min != null && s.min < lo) lo = s.min
      if (s.max != null && s.max > hi) hi = s.max
    }
    const format = figureFormat(chartRules(), chart.unit, lo, hi)
    const rows: TableRow[] = aligned.series.map((s, i) => ({ id: s.key, full: naming.names[i]!.full, labels: s.labels, last: stats[i]!.last, lastAt: stats[i]!.lastAt, text: format.value(stats[i]!.last) }))
    // The columns: the labels that differ, most distinguishing first. A single series shows every label.
    let columns = naming.distinguishing
    let common = naming.common
    if (columns.length === 0) {
      const keys = Object.keys(aligned.series[0]?.labels ?? {}).sort()
      columns = keys.includes('__name__') ? ['__name__', ...keys.filter((k) => k !== '__name__')] : keys
      common = {}
    }
    return { rows, unit: format.unit, columns, common }
  }, [aligned, chart, naming])

  const onRange = useCallback((from: string, to: string) => setSearch({ from, to }), [setSearch])

  // ---- keyboard & commands
  // The form of the result is local: it changes in this render and the URL follows.
  const [view, setViewState] = useState<ResultView>(search.view)
  /** The form last chosen here whose URL update is still on its way; the URL must not undo it. */
  const pushedView = useRef<ResultView | null>(null)
  useEffect(() => {
    if (pushedView.current !== null) {
      if (pushedView.current === search.view) pushedView.current = null
      return
    }
    setViewState(search.view)
  }, [search.view])
  // The new form is painted first. The address bar follows VIEW_URL_DELAY ms after the last
  // switch: a router navigation costs about 25 ms of main thread at 4x CPU, and run in the
  // next task it delayed the frame after the switch (design review B3). It is not lost on a
  // reload or a tab close (pagehide), and is dropped if the page is left first.
  const viewUrlTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingView = useRef<ResultView | null>(null)
  const urlView = useRef(search.view)
  urlView.current = search.view
  const flushViewUrl = useCallback(() => {
    if (viewUrlTimer.current !== null) clearTimeout(viewUrlTimer.current)
    viewUrlTimer.current = null
    const v = pendingView.current
    pendingView.current = null
    if (v === null) return
    // Switched away and back before the URL followed: it is already right, and nothing will
    // arrive to clear the guard, so it is cleared here.
    if (v === urlView.current) pushedView.current = null
    else setSearch({ view: v }, true)
  }, [setSearch])
  useEffect(() => {
    window.addEventListener('pagehide', flushViewUrl)
    return () => {
      window.removeEventListener('pagehide', flushViewUrl)
      if (viewUrlTimer.current !== null) clearTimeout(viewUrlTimer.current)
    }
  }, [flushViewUrl])
  const setView = useCallback(
    (v: ResultView) => {
      pushedView.current = v
      setViewState(v)
      pendingView.current = v
      if (viewUrlTimer.current !== null) clearTimeout(viewUrlTimer.current)
      viewUrlTimer.current = setTimeout(flushViewUrl, VIEW_URL_DELAY)
    },
    [flushViewUrl],
  )
  const toggleView = useCallback(() => setView(view === 'text' ? 'chart' : 'text'), [view, setView])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        run()
        return
      }
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return
      if (e.key === '/') {
        e.preventDefault()
        editorRef.current?.focus()
      } else if (e.key === 't' || e.key === 'T') {
        toggleView()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [run, toggleView])

  useCommands(
    'explore',
    [
      { id: 'q-run', group: 'Query', title: 'Run query', shortcut: `${MOD}+Enter`, keywords: 'execute refresh reload', run },
      { id: 'q-focus', group: 'Query', title: 'Focus the query editor', shortcut: '/', run: () => editorRef.current?.focus() },
      {
        id: 'q-link',
        group: 'Query',
        title: 'Copy a link to this view',
        keywords: 'share url permalink',
        run: () => void navigator.clipboard?.writeText(window.location.href).catch(() => {}),
      },
      { id: 'v-text', group: 'View', title: 'Switch between the chart and the text form', shortcut: 'T', keywords: 'toggle digest accessible agent show', run: toggleView },
      { id: 'v-table', group: 'View', title: 'Show the result as a table', run: () => setView('table') },
      { id: 'v-json', group: 'View', title: 'Show the raw JSON', run: () => setView('json') },
      ...PRESETS.map((p) => ({
        id: `t-${p}`,
        group: 'Time range' as const,
        title: `Show the last ${presetWords(p)}`,
        keywords: 'time range relative',
        run: () => onRange(`now-${p}`, 'now'),
      })),
    ],
    'static',
  )

  // ---- render
  const error = q !== '' && query.isError ? query.error : null
  const widest = search.to === 'now' && search.from === 'now-24h'
  const alternative = window_ ? shorterRange(window_.end - window_.start) : null
  /** Something of a result is on screen: its chart (under an error, its legend), its table, its text or its JSON. */
  const drawn = !!result && !!description && (hasData || isEmpty) && (!error || (hasData && view === 'chart'))
  const shown = drawn ? description : null
  const errorNode: ReactNode = error ? (
    <ErrorState
      error={error}
      tries={query.failureCount}
      elapsedMs={lastWaitMs.current}
      keySet={hasKey}
      autoStep={search.step === 'auto'}
      syntaxErrorAt={() => (editorReady ? (editorRef.current?.syntaxErrorAt(q) ?? null) : null)}
      onGoTo={(at) => editorRef.current?.focus(at)}
      onRetry={run}
      onSignIn={() => signOut('refused')}
      onAutoStep={() => setSearch({ step: 'auto' })}
    />
  ) : null
  const chartError = useMemo(() => (error && errorNode ? { title: error.message, node: errorNode } : null), [error, errorNode])
  const now = Date.now()

  /** The waiting line: over the strip of words every form of the result starts with (Panel). */
  const progress =
    halted && !loading ? (
      <div className="vz-progress" data-unmeasured="" data-testid="halted">
        <div className="vz-progress-text">
          <span role="status">
            {halted === 'cancelled' ? 'Cancelled.' : 'Stopped after 60 s without an answer.'}
            {drawn ? ' The previous result is shown.' : ''}
          </span>
          <button className="vz-progress-action" onClick={run} data-testid="retry" data-focus-after="[data-testid=run]">
            Retry
          </button>
        </div>
      </div>
    ) : wait.shown ? (
      <div className="vz-progress" data-unmeasured="" data-testid="progress">
        <div className="vz-progress-text">
          <span role="status" data-testid="progress-text">
            {failures > 0 && query.failureReason
              ? busyLine(query.failureReason, retryClock.current.at > performance.now() ? retryClock.current.at - performance.now() : null)
              : wait.elapsedMs >= WAIT.alternativeAfter
                ? 'Still waiting for the query.'
                : 'Waiting for the query.'}
          </span>
          <span className="vz-qty" aria-hidden="true" data-testid="progress-elapsed">
            {(wait.elapsedMs / 1000).toFixed(1)} s
          </span>
          {wait.elapsedMs >= WAIT.alternativeAfter && loading && alternative && (
            <button className="vz-progress-action" onClick={() => onRange(`now-${alternative.preset}`, 'now')} data-testid="alternative">
              Show the last {presetWords(alternative.preset)}
            </button>
          )}
          {wait.elapsedMs >= WAIT.cancelAfter && loading && (
            // When Cancel goes, Retry stands in the same place and takes the focus Cancel had.
            <button className="vz-progress-action" onClick={() => halt('cancelled')} data-testid="cancel" data-focus-after="[data-testid=retry]">
              Cancel
            </button>
          )}
        </div>
      </div>
    ) : null

  return (
    <div className="vz-page">
      <header className="vz-page-head">
        <div>
          <h1 className="vz-page-title">Explore</h1>
        </div>
      </header>

      <div className="vz-stack" ref={toolsRef}>
        {/* The query and the view's one blue button. */}
        <QueryRow committed={search.q} loading={loading} run={run} client={client} editorRef={editorRef} rangeRef={lookupRange} onEditorReady={onEditorReady} />
        <RangeControls from={search.from} to={search.to} onChange={onRange} shown={shownRange} />
        <div className="vz-dashboard">
          <div className="vz-grid">
            <TimeRangeField from={search.from} to={search.to} onChange={onRange} />
            <StepField value={search.step} auto={window_ && search.step === 'auto' ? window_.step : null} onChange={(step) => setSearch({ step })} />
            <div className="vz-field" data-span="3">
              <label className="vz-label" htmlFor="unit">
                Unit
              </label>
              <select id="unit" data-testid="unit" className="vz-select" value={search.unit} onChange={(e) => setSearch({ unit: e.target.value }, true)}>
                {/* "Automatic" names the unit of what is on screen while a result is shown, and of the query otherwise. */}
                <option value="auto">Automatic: {UNITS.find((u) => u.id === (shown && result ? result.inferredUnit : inferUnit(q)))?.label ?? 'number'}</option>
                {UNITS.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {q === '' && !result ? (
        <StartState mock={!!backend.data?.mock} />
      ) : (
        <section className="vz-panel" aria-labelledby="result-title" aria-busy={loading} data-testid="result">
          <div className="vz-panel-head">
            {/* The chart names itself, and titles its text form, with this element's text: the query is part of it, for a reader who cannot see the editor. */}
            <h2 className="vz-panel-title" id="result-title">
              Query result{shown ? <span className="vz-sr">: {shown.q}</span> : null}
            </h2>
            {shown && result && (
              <span className="vz-panel-meta" data-testid="result-meta">
                {/* While the result is not the answer to the current request, the head says so; everything else stays the result's. */}
                {shown.staleText && (
                  <span className="vz-panel-note" data-testid="stale">
                    {shown.staleText}
                  </span>
                )}
                <span data-testid="result-range">
                  {shown.staleText ? '· ' : ''}
                  {dayPrefix(result.window.start, result.window.end, now) ? `${dayPrefix(result.window.start, result.window.end, now)}, ` : ''}
                  {/* The chart writes the range it shows here, and again when it is zoomed (Chart, draw). */}
                  <span data-range="" className="vz-qty" />
                </span>
                <span data-testid="result-step">
                  · every <span className="vz-qty">{stepWords(result.window.step)}</span>
                </span>
                <Age at={result.receivedAt} />
              </span>
            )}
            <div className="vz-segmented" role="group" aria-label="Show the result as">
              {VIEWS.map(([v, label]) => (
                <button key={v} aria-pressed={view === v} onClick={() => setView(v)} data-testid={`view-${v}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {shown && (
            // The query the data on screen answers, which is not always the one in the editor: it may have been edited since, or be waiting.
            <p className="vz-panel-desc result-query" aria-hidden="true" title={shown.q} data-testid="result-query">
              <span className="vz-qty">{shown.q}</span>
            </p>
          )}
          {shown && result && <Warnings warnings={result.warnings} />}

          <div className="vz-panel-body region" data-view={view}>
            {progress}
            {chart && result && (
              <Chart
                spec={chart.spec}
                shiftMs={shiftMs}
                stepWords={stepWords(result.window.step)}
                view={CHART_VIEW}
                textFormId={TEXT_FORM}
                error={view === 'chart' ? chartError : null}
                onShownRange={setShownRange}
                parked={view !== 'chart' || !drawn}
              />
            )}
            {error && !(hasData && view === 'chart') ? (
              // Nothing of an earlier result is on screen: the error takes the plot's place, at its height.
              <div className="vz-chart">{errorNode}</div>
            ) : isEmpty && shown && result ? (
              <div className="vz-chart">
                <div className="vz-empty" data-testid="empty-state" role="status">
                  <p className="vz-empty-title">No series matched</p>
                  <p>
                    Nothing matched <span className="vz-qty">{shown.q}</span> between <span className="vz-qty">{momentText(result.window.start, now)}</span> and{' '}
                    <span className="vz-qty">{momentText(result.window.end, now)}</span>. Check the metric name and the label matchers, or widen the time range.
                  </p>
                  {!widest && (
                    <div className="vz-controls">
                      <button className="vz-button" data-size="sm" onClick={() => onRange('now-24h', 'now')} data-focus-after="[data-testid=time-from]">
                        Show the last 24 h
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : !result && !error ? (
              // Waiting for the first result: the chart's place, at the height its last result had in this tab.
              <div className="vz-chart" style={reservedStyle(CHART_VIEW)} data-testid="chart-reserved" />
            ) : null}
            {drawn && table && view === 'table' && <ResultTable rows={table.rows} unit={table.unit} columns={table.columns} common={table.common} nowMs={now} />}
            {/* The chart writes its text form into this element whenever it draws, so it is always here. */}
            <TextView id={TEXT_FORM} hidden={!(drawn && hasData && view === 'text')} />
            {drawn && hasData && result && view === 'json' && <JsonView data={result.matrix} elapsedMs={result.elapsedMs} />}
          </div>
        </section>
      )}
    </div>
  )
}

/**
 * Prometheus' `warnings`: the API answered, but says the result may not be whole (a partial
 * response from a store that did not answer, an approximation). The banner says so before the
 * API's own words. The viz API sends none today (README, "Needed changes in query/").
 */
function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null
  return (
    <div role="status" className="vz-banner" data-testid="warnings">
      <span className="vz-mark" data-state="warn" />
      <p>
        {warnings.length === 1 ? 'The API sent a warning with this result' : `The API sent ${warnings.length} warnings with this result`}, so it may be
        incomplete: {warnings.join(' ')}
      </p>
    </div>
  )
}

function ErrorState({
  error,
  tries,
  elapsedMs,
  keySet,
  autoStep,
  syntaxErrorAt,
  onGoTo,
  onRetry,
  onSignIn,
  onAutoStep,
}: {
  error: Error
  /** How many times the query was sent before this error (busy answers are retried). */
  tries: number
  /** How long those tries took, in ms. */
  elapsedMs: number
  /** Whether this tab holds an API key: a 401 without one asks for a key, not a valid one. */
  keySet: boolean
  /** Whether the step is the automatic one. */
  autoStep: boolean
  /** Where the editor's own parser finds the first syntax error in the query, when the API gives no position. */
  syntaxErrorAt: () => number | null
  onGoTo: (at: number) => void
  onRetry: () => void
  /** Back to the sign-in form: the key was refused. */
  onSignIn: () => void
  /** Clears an explicit step: the fix for a step too small for the range (running it again would be refused again). */
  onAutoStep: () => void
}) {
  const api = error instanceof PromApiError ? error : null
  const kind = errorKind(error)
  // Parse errors carry "line:column" from Prometheus; queries are one line, so the column is
  // the character. The viz API gives no position (README, "Needed changes in query/"): the
  // editor's parser, which underlines the same error, says where it is.
  const at = /\b1:(\d+): parse error/.exec(error.message)
  const fromEditor = !at && kind === 'query' && /parse error/.test(error.message) ? syntaxErrorAt() : null
  const character = at ? Number(at[1]) : fromEditor !== null ? fromEditor + 1 : null
  return (
    <div className="vz-empty" role="alert" data-testid="error-state" data-kind={kind}>
      <p className="vz-empty-title">
        <span className="vz-mark" data-state="critical" />
        The query could not run
      </p>
      <p data-testid="error-message">{error.message}</p>
      {api && (
        <p data-testid="error-advice">
          {/* The API's own error type and status when it sent its error envelope; otherwise what came back (api/errors.ts answerLine). */}
          {api.errorType !== 'network' && api.errorType !== 'http' && api.errorType !== 'parse' && api.status ? (
            <>
              The API answered{' '}
              <span data-testid="error-type">
                <span className="vz-qty">{api.errorType}</span> with HTTP <span className="vz-qty">{api.status}</span>
              </span>
              .
            </>
          ) : (
            answerLine(api)
          )}{' '}
          {errorAdvice(error, Math.max(1, tries), elapsedMs, MOD, { keySet, autoStep })}
        </p>
      )}
      <div className="vz-controls">
        {character !== null ? (
          <button className="vz-button" data-size="sm" onClick={() => onGoTo(character - 1)} data-testid="error-fix">
            Go to character {character}
          </button>
        ) : kind === 'auth' || kind === 'scope' ? (
          <button className="vz-button" data-size="sm" onClick={onSignIn} data-testid="error-fix">
            Sign in again
          </button>
        ) : kind === 'resolution' && !autoStep ? (
          <button className="vz-button" data-size="sm" onClick={onAutoStep} data-testid="error-fix" data-focus-after="[data-testid=run]">
            Use the automatic step
          </button>
        ) : (
          <button className="vz-button" data-size="sm" onClick={onRetry} data-testid="error-fix" data-focus-after="[data-testid=run]">
            Run the query again
          </button>
        )}
      </div>
    </div>
  )
}

/** Before any query in this view: what will appear, and how to ask (FirstRun). */
function StartState({ mock }: { mock: boolean }) {
  return (
    <section className="vz-start" data-testid="start-state" aria-labelledby="start-title">
      <h2 className="vz-section-title" id="start-title">
        No query yet
      </h2>
      <p>The answer to a PromQL query appears here as a chart, with a table, a text form and the API's JSON beside it.</p>
      <ol className="vz-steps">
        <li>
          <p>Type a query in the field above. Metric names, label names and label values complete from the data in the time range.</p>
        </li>
        <li>
          <p>
            Press Run query, or <span className="vz-kbd">{MOD}</span> <span className="vz-kbd">Enter</span>.
          </p>
        </li>
      </ol>
      {mock && (
        <>
          <p>Or open one of these on the mock's data:</p>
          <ul className="vz-links">
            {MOCK_EXAMPLES.map((ex) => (
              <li key={ex.q}>
                <Link to="/explore" search={{ q: ex.q }} className="vz-link" data-focus-after="[data-testid=run]">
                  {ex.title}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
