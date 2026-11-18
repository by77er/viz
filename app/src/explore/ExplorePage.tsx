import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { PromApiError } from '../api/client'
import type { PromMatrixData } from '../api/types'
import { TimeSeriesChart, type ChartSeries, type RenderInfo } from '../charts'
import type { PromqlEditorHandle } from '../editor/PromqlEditor'
import { assignStyles, slotToken } from '../lib/color'
import { digestSeries, renderDigest } from '../lib/digest'
import { alignMatrix, distinguishingNames, seriesStats } from '../lib/series'
import { alignWindow, autoStep, bucketWidth, type QueryWindow } from '../lib/step'
import { absoluteSpec, formatDateTime, formatDuration, parseDuration, resolveTimeSpec } from '../lib/time'
import { formatValue, inferUnit, isUnitId, UNITS, type UnitId } from '../lib/units'
import { parseExploreSearch, type ExploreSearch, type ResultView } from '../lib/urlState'
import { useBackendInfo } from '../shell/AppShell'
import { MOD, useCommands } from '../shell/commands'
import { useSettings } from '../shell/settings'
import { useTheme } from '../shell/theme'
import { Age, useWaiting, WAIT } from './waiting'
import { Legend, type LegendRow } from './Legend'
import { JsonView } from './JsonView'
import { ResultTable } from './ResultTable'
import { TextView } from './TextView'
import { PRESETS, spacedDuration, TimeRangePicker } from './TimeRangePicker'

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

interface RangeResult {
  data: PromMatrixData
  warnings: string[]
  window: QueryWindow
  elapsedMs: number
  /** Wall-clock time the response arrived (epoch ms), for the age in the panel head. */
  receivedAt: number
}

export function ExplorePage() {
  const rawSearch = exploreRoute.useSearch()
  const search = useMemo(() => parseExploreSearch(rawSearch), [rawSearch])
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { client, connectionId } = useSettings()
  const { resolved: theme } = useTheme()
  const backend = useBackendInfo()

  const setSearch = useCallback(
    (patch: Partial<ExploreSearch>, replace = false) =>
      void navigate({ to: '/explore', search: (prev) => ({ ...prev, ...patch }), replace }),
    [navigate],
  )

  // ---- query text: the URL holds the committed query, the editor a draft.
  const [draft, setDraft] = useState(search.q)
  useEffect(() => setDraft(search.q), [search.q])
  const editorRef = useRef<PromqlEditorHandle | null>(null)

  // ---- time window: resolved when the range, the step, the width or the run counter changes.
  const [runId, setRunId] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const [widthBucket, setWidthBucket] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = panelRef.current
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

  const q = search.q.trim()
  // The token is deliberately not part of the key; connectionId changes when settings do.
  const queryKey = ['query_range', connectionId, q, window_?.start, window_?.end, window_?.step, runId]
  const query = useQuery<RangeResult, Error>({
    queryKey,
    enabled: q !== '' && window_ !== null,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    gcTime: 60_000,
    queryFn: async ({ signal }) => {
      const w = window_!
      const t0 = performance.now()
      const res = await client.queryRange(q, w.start, w.end, w.step, { signal })
      return { data: res.data, warnings: res.warnings, window: w, elapsedMs: performance.now() - t0, receivedAt: Date.now() }
    },
  })

  // ---- waiting: the button is busy at once; the progress line follows the waiting table.
  const loading = q !== '' && query.isFetching
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

  const run = useCallback(() => {
    // A second press while the query runs is ignored: the button is busy.
    if (loadingRef.current) return
    const next = draft.trim()
    setHalted(null)
    // A new query text changes the query key (and re-resolves "now") by itself once the URL
    // has it; bumping the run counter as well would first re-send the old text.
    if (next !== search.q) setSearch({ q: next })
    else setRunId((n) => n + 1)
  }, [draft, search.q, setSearch])

  // ---- derived data
  const result = q === '' ? undefined : query.data
  const aligned = useMemo(
    () => (result ? alignMatrix(result.data, result.window.start, result.window.end, result.window.step) : null),
    [result],
  )
  const unit: UnitId = search.unit !== 'auto' && isUnitId(search.unit) ? search.unit : inferUnit(q)
  const format = useCallback((v: number | null) => formatValue(v, unit), [unit])
  const formatAxis = useCallback((v: number) => formatValue(v, unit, 4), [unit])

  const styles = useMemo(() => assignStyles(aligned?.series.map((s) => s.key) ?? []), [aligned])
  const chartSeries = useMemo<ChartSeries[]>(() => {
    const all = aligned?.series ?? []
    const short = distinguishingNames(all.map((s) => s.labels))
    // When the series differ in one label only, its value is the whole name: "checkout".
    const differing = Object.keys(all[0]?.labels ?? {}).filter((k) => all.some((s) => s.labels[k] !== all[0]!.labels[k]))
    const only = all.length > 1 && differing.length === 1 && all.every((s) => Object.keys(s.labels).length === Object.keys(all[0]!.labels).length) ? differing[0]! : null
    return all.map((s, i) => {
      return { id: s.key, label: s.name, shortLabel: short[i], directLabel: only ? s.labels[only] : undefined, colorVar: slotToken(styles.get(s.key)!.slot), other: styles.get(s.key)!.slot === null, values: s.values }
    })
  }, [aligned, styles])
  const rows = useMemo<(LegendRow & { labels: Record<string, string> })[]>(
    () =>
      (aligned?.series ?? []).map((s, i) => ({
        id: s.key,
        name: s.name,
        labels: s.labels,
        colorVar: chartSeries[i]!.colorVar,
        other: styles.get(s.key)!.slot === null,
        stats: seriesStats(aligned!.xs, s.values),
      })),
    [aligned, chartSeries, styles],
  )

  // ---- series isolation (local view state; pruned when the series set changes)
  const [isolated, setIsolated] = useState<ReadonlySet<string> | null>(null)
  const visible = useMemo(() => {
    if (!isolated || !aligned) return null
    const keep = new Set(aligned.series.filter((s) => isolated.has(s.key)).map((s) => s.key))
    return keep.size === 0 || keep.size === aligned.series.length ? null : keep
  }, [isolated, aligned])
  const toggleSeries = useCallback(
    (id: string, additive: boolean) => {
      const all = aligned?.series.map((s) => s.key) ?? []
      setIsolated((cur) => {
        const current = cur ?? new Set(all)
        if (additive) {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next.size === 0 || next.size === all.length ? null : next
        }
        // Plain click: isolate; clicking the only visible series shows everything again.
        return current.size === 1 && current.has(id) ? null : new Set([id])
      })
    },
    [aligned],
  )

  const [renderInfo, setRenderInfoState] = useState<RenderInfo | null>(null)
  const setRenderInfo = useCallback(
    (info: RenderInfo) =>
      setRenderInfoState((prev) =>
        prev && prev.rawPoints === info.rawPoints && prev.drawnPoints === info.drawnPoints && prev.downsampled === info.downsampled ? prev : info,
      ),
    [],
  )
  const onZoom = useCallback((from: number, to: number) => setSearch({ from: absoluteSpec(from), to: absoluteSpec(to) }), [setSearch])
  const xRange = useMemo<[number, number]>(() => (result ? [result.window.start, result.window.end] : [0, 1]), [result])

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
  const setView = useCallback(
    (v: ResultView) => {
      pushedView.current = v
      setViewState(v)
      // The new form is painted first; the address bar is brought up to date after that frame.
      requestAnimationFrame(() => setTimeout(() => setSearch({ view: v }, true), 0))
    },
    [setSearch],
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
        title: `Show the last ${spacedDuration(p)}`,
        keywords: 'time range relative',
        run: () => setSearch({ from: `now-${p}`, to: 'now' }),
      })),
    ],
    'static',
  )

  const showAll = useCallback(() => setIsolated(null), [])
  const chartLabel = `Chart of ${aligned?.series.length ?? 0} series for the query ${q}. Arrow keys move the cursor. The text form has the same data.`
  const onRange = useCallback((from: string, to: string) => setSearch({ from, to }), [setSearch])

  // The digest is computed when the text form is shown, not for every result.
  const digestText = useMemo(() => {
    if (!aligned || view !== 'text') return ''
    return renderDigest(digestSeries({ xs: aligned.xs, series: aligned.series }), { format, title: `Query: ${q}` })
  }, [aligned, format, q, view])

  // ---- render
  const error = q !== '' && query.isError ? query.error : null
  const isEmpty = !!result && result.data.result.length === 0
  const hasData = !!aligned && aligned.series.length > 0
  const shownResult = !error && (hasData || isEmpty) ? result : undefined
  const widest = search.to === 'now' && search.from === 'now-24h'

  const caption = shownResult && hasData && (
    <p className="vz-panel-desc" data-testid="status">
      <span className="app-num">{aligned!.series.length}</span> series, one point every{' '}
      {spacedDuration(formatDuration(shownResult.window.step))
        .split(' ')
        .map((part, i, parts) => (/^\d/.test(part) ? <span key={i} className="app-num">{part}</span> : ` ${part}${i < parts.length - 1 ? ' ' : ''}`))}
      , returned in{' '}
      <span className="app-num">{shownResult.elapsedMs < 10 ? shownResult.elapsedMs.toFixed(1) : Math.round(shownResult.elapsedMs).toLocaleString('en-US')}</span> ms.
      {view === 'chart' && renderInfo?.downsampled && (
        <>
          {' '}
          Each pixel column draws its minimum and maximum: <span className="app-num">{renderInfo.rawPoints.toLocaleString('en-US')}</span> points
          drawn as <span className="app-num">{renderInfo.drawnPoints.toLocaleString('en-US')}</span>.
        </>
      )}
    </p>
  )

  return (
    <div className="page">
      <h1 className="sr-only">Explore metrics</h1>

      {/* Query row: the one blue button of the view. */}
      <div className="query-row">
        <div className="vz-query query-well" onClick={() => editorRef.current?.focus()}>
          <Suspense fallback={<div className={draft ? undefined : 'cell-quiet'}>{draft || 'Loading the query editor'}</div>}>
            <PromqlEditor value={draft} onChange={setDraft} onRun={run} client={client} handleRef={editorRef} />
          </Suspense>
        </div>
        <button className="vz-button" data-tone="blue" onClick={run} aria-busy={loading} data-testid="run" aria-keyshortcuts="Control+Enter Meta+Enter">
          Run query
          <span className="vz-kbd wide-only" aria-hidden="true">
            {MOD} ↵
          </span>
        </button>
      </div>

      {/* Toolbar: every control carries its label, so the row needs no explanation. */}
      <div className="toolbar">
        <TimeRangePicker from={search.from} to={search.to} onChange={onRange} />
        <StepInput value={search.step} auto={window_ ? formatDuration(window_.step) : ''} onChange={(step) => setSearch({ step })} />
        <div className="vz-field unit-field">
          <label className="vz-label" htmlFor="unit">
            Unit
          </label>
          <select id="unit" data-testid="unit" className="vz-select" value={search.unit} onChange={(e) => setSearch({ unit: e.target.value }, true)}>
            <option value="auto">Automatic: {UNITS.find((u) => u.id === inferUnit(q))?.label ?? 'number'}</option>
            {UNITS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
        </div>
        <div className="vz-field view-field">
          <span className="vz-label" id="view-label">
            Show as
          </span>
          <div className="vz-segmented" role="group" aria-labelledby="view-label">
            {VIEWS.map(([v, label]) => (
              <button key={v} aria-pressed={view === v} onClick={() => setView(v)} data-testid={`view-${v}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Result: a panel whose waiting line and region keep their height with or without data. */}
      <section ref={panelRef} className="vz-panel result" aria-labelledby="result-title" aria-busy={loading} data-testid="result">
        <div className="vz-panel-head">
          <h2 className="vz-panel-title" id="result-title">
            Query result
          </h2>
          {shownResult && <Age at={shownResult.receivedAt} unit={unit === 'none' ? undefined : UNITS.find((u) => u.id === unit)?.label} />}
        </div>

        <div className="wait-slot">
          {wait.shown ? (
            <div className="vz-progress" data-unmeasured="" data-testid="progress">
              <div className="vz-progress-text">
                <span role="status">{wait.elapsedMs >= WAIT.alternativeAfter ? 'Still waiting. Try a shorter range.' : 'Waiting for the query'}</span>
                <span aria-hidden="true" data-testid="progress-elapsed">
                  <span className="app-num">{(wait.elapsedMs / 1000).toFixed(1)}</span> s
                </span>
                {wait.elapsedMs >= WAIT.cancelAfter && loading && (
                  <button className="vz-progress-action" onClick={() => halt('cancelled')} data-testid="cancel">
                    Cancel
                  </button>
                )}
              </div>
            </div>
          ) : halted && !loading ? (
            <div className="vz-progress" data-unmeasured="" data-testid="halted">
              <div className="vz-progress-text">
                <span role="status">
                  {halted === 'cancelled' ? 'Cancelled.' : 'Stopped after 60 s without an answer.'}
                  {shownResult ? ' The previous result is shown.' : ''}
                </span>
                <button className="vz-progress-action" onClick={run}>
                  Retry
                </button>
              </div>
            </div>
          ) : (
            <div className="vz-progress-text" aria-hidden="true">
              &nbsp;
            </div>
          )}
        </div>

        <div className="region" data-view={view}>
          {error ? (
            <ErrorState error={error} onGoTo={(at) => editorRef.current?.focus(at)} onRetry={run} />
          ) : q === '' ? (
            <StartState mock={!!backend.data?.mock} />
          ) : isEmpty ? (
            <div className="vz-empty" data-testid="empty-state" role="status">
              <h3 className="vz-empty-title">No series matched</h3>
              <p>
                Nothing matched <span className="app-num">{q}</span> between <span className="app-num">{formatDateTime(result!.window.start)}</span>{' '}
                and <span className="app-num">{formatDateTime(result!.window.end)}</span>. Check the metric name and the label matchers, or
                widen the time range.
              </p>
              {!widest && (
                <button className="vz-button" data-size="sm" onClick={() => setSearch({ from: 'now-24h', to: 'now' })}>
                  Show the last 24 h
                </button>
              )}
            </div>
          ) : hasData ? (
            <>
              <div className={view === 'chart' ? 'region-part' : 'region-part is-parked'} aria-hidden={view === 'chart' ? undefined : true}>
                <TimeSeriesChart
                  xs={aligned!.xs}
                  series={chartSeries}
                  xRange={xRange}
                  visible={visible}
                  formatValue={formatAxis}
                  onZoom={onZoom}
                  onRenderInfo={setRenderInfo}
                  syncKey="explore"
                  theme={theme}
                  ariaLabel={chartLabel}
                />
                {view === 'chart' && caption}
                {view === 'chart' && <Warnings warnings={result!.warnings} />}
                <Legend rows={rows} visible={visible} onToggle={toggleSeries} onShowAll={showAll} format={format} />
              </div>
              {view !== 'chart' && (
                <>
                  {caption}
                  <Warnings warnings={result!.warnings} />
                  {view === 'table' ? <ResultTable rows={rows} format={format} /> : view === 'text' ? <TextView text={digestText} /> : <JsonView data={result!.data} />}
                </>
              )}
            </>
          ) : null}
        </div>
      </section>
    </div>
  )
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null
  return (
    <div role="status" className="vz-banner">
      <span className="vz-mark" data-state="warn" />
      <p>{warnings.join(' ')}</p>
    </div>
  )
}

function StepInput({ value, auto, onChange }: { value: string; auto: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value === 'auto' ? '' : value)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    setText(value === 'auto' ? '' : value)
    setInvalid(false)
  }, [value])
  const commit = () => {
    const t = text.trim()
    if (t === '' || t === 'auto') {
      setInvalid(false)
      if (value !== 'auto') onChange('auto')
    } else if (parseDuration(t)) {
      setInvalid(false)
      if (t !== value) onChange(t)
    } else setInvalid(true)
  }
  return (
    <div className="vz-field step-field">
      <label className="vz-label" htmlFor="step">
        Step
      </label>
      <input
        id="step"
        className="vz-input"
        data-mono=""
        value={text}
        placeholder={auto ? `auto, ${auto}` : 'auto'}
        aria-invalid={invalid}
        aria-describedby={invalid ? 'step-help' : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        spellCheck={false}
        data-testid="step"
      />
      {invalid && (
        <span className="vz-help" data-error="" id="step-help">
          <span className="vz-mark" data-state="critical" />
          Use a duration such as 30s, 1m or 5m.
        </span>
      )}
    </div>
  )
}

function ErrorState({ error, onGoTo, onRetry }: { error: Error; onGoTo: (at: number) => void; onRetry: () => void }) {
  const api = error instanceof PromApiError ? error : null
  // Parse errors carry "line:column"; queries are one line, so the column is the character.
  const at = /\b1:(\d+): parse error/.exec(error.message)
  const character = at ? Number(at[1]) : null
  const network = api?.errorType === 'network'
  return (
    <div className="vz-empty" role="alert" data-testid="error-state">
      <h3 className="vz-empty-title">
        <span className="vz-mark" data-state="critical" />
        The query could not run
      </h3>
      <p data-testid="error-message">{error.message}</p>
      {api && (
        <p>
          The API answered{' '}
          <span data-testid="error-type">
            <span className="app-num">{api.errorType}</span>
            {api.status ? (
              <>
                {' '}
                with HTTP <span className="app-num">{api.status}</span>
              </>
            ) : null}
          </span>
          . {network ? 'Check the connection and run the query again.' : `Change the query and press ${MOD} Enter to run it again.`}
        </p>
      )}
      {character !== null ? (
        <button className="vz-button" data-size="sm" onClick={() => onGoTo(character - 1)} data-testid="error-fix">
          Go to character {character}
        </button>
      ) : (
        <button className="vz-button" data-size="sm" onClick={onRetry} data-testid="error-fix">
          Run the query again
        </button>
      )}
    </div>
  )
}

function StartState({ mock }: { mock: boolean }) {
  return (
    <div className="vz-empty" data-testid="start-state">
      <h3 className="vz-empty-title">No query yet</h3>
      <p>
        Type a PromQL query above and press <span className="vz-kbd">{MOD}</span> <span className="vz-kbd">Enter</span>. Metric and label
        names complete from the connected backend.
      </p>
      {mock && (
        <>
          <p>Or open an example on the mock data:</p>
          <ul className="example-list">
            {MOCK_EXAMPLES.map((ex) => (
              <li key={ex.q}>
                <span>{ex.title}</span>
                <Link to="/explore" search={{ q: ex.q }} className="vz-link">
                  {ex.q}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
