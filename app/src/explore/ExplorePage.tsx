import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { PromApiError } from '../api/client'
import { busyLine, errorAdvice, errorKind, retryDelayMs, shouldRetry } from '../api/errors'
import type { ParsedMatrix } from '../api/matrix'
import type { ApiCost } from '../api/types'
import { TimeSeriesChart, type ChartSeries, type RenderInfo } from '../charts'
import type { PromqlEditorHandle } from '../editor/PromqlEditor'
import { assignSeries, DEFAULT_POLICY, loadAssignment, saveAssignment } from '../lib/assign'
import { slotToken } from '../lib/color'
import { describeResult, identify, type ResultIdentity, type ResultRequest } from '../lib/describe'
import { digestSeries, renderDigest } from '../lib/digest'
import { nameSeries } from '../lib/naming'
import { useCoarsePointer } from '../lib/pointer'
import { countRender } from '../lib/renders'
import { alignSeries, type AlignedData, seriesStats } from '../lib/series'
import { alignWindow, autoStep, bucketWidth, type QueryWindow } from '../lib/step'
import { absoluteSpec, formatDateTime, parseDuration, resolveTimeSpec, stepWords } from '../lib/time'
import { axisUnitLabel, BINARY_INCREMENTS, formatInScale, formatValue, inferUnit, scaleFor, UNITS } from '../lib/units'
import { DEFAULT_SEARCH, parseExploreSearch, type ExploreSearch, type ResultView } from '../lib/urlState'
import { useBackendInfo } from '../shell/AppShell'
import { MOD, useCommands, useCommandsContext } from '../shell/commands'
import { useSettings } from '../shell/settings'
import { useTheme } from '../shell/theme'
import { Age, shorterRange, useWaiting, WAIT } from './waiting'
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

/** The id of the one series drawn for the Other group when the policy sums its members. */
const OTHER_ID = '__other__'

/** How long after the last change of form the address bar is brought up to date, in ms. */
const VIEW_URL_DELAY = 300

/** Text digests by result, then by unit and title: one per result as long as the result is kept. */
const digests = new WeakMap<object, Map<string, string>>()
function cachedDigest(aligned: AlignedData, title: string, unit: string, format: (v: number | null) => string): string {
  let byKey = digests.get(aligned)
  if (!byKey) digests.set(aligned, (byKey = new Map()))
  const key = `${unit}\n${title}`
  let text = byKey.get(key)
  if (text === undefined) {
    text = renderDigest(digestSeries({ xs: aligned.xs, series: aligned.series }), { format, title })
    byKey.set(key, text)
  }
  return text
}

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

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
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
  client: ReturnType<typeof useSettings>['client']
  editorRef: React.RefObject<PromqlEditorHandle | null>
  rangeRef: React.RefObject<{ start: number; end: number } | null>
  onEditorReady: () => void
}) {
  countRender('QueryRow')
  return (
    <div className="query-row">
      <div className="vz-query query-well" onClick={() => editorRef.current?.focus()}>
        <Suspense fallback={<div className={committed ? undefined : 'cell-quiet'}>{committed || 'Loading the query editor'}</div>}>
          <PromqlEditor value={committed} onRun={run} client={client} handleRef={editorRef} rangeRef={rangeRef} onReady={onEditorReady} />
        </Suspense>
      </div>
      <button className="vz-button" data-tone="blue" onClick={run} aria-busy={loading} data-testid="run" aria-keyshortcuts="Control+Enter Meta+Enter">
        Run query
        <span className="vz-kbd wide-only" aria-hidden="true">
          {MOD} ↵
        </span>
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
  const { client, connectionId } = useSettings()
  const { resolved: theme } = useTheme()
  const backend = useBackendInfo()
  const coarse = useCoarsePointer()

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
  // (kept while the next one waits, or after Cancel or the 60 s stop): nothing below this
  // line may read `search.q` or `q` to describe it.
  const result = q === '' ? undefined : query.data
  const description = useMemo(() => (result ? describeResult(result, { unit: search.unit }, current) : null), [result, search.unit, current])
  const unit = description?.unit ?? 'none'
  const aligned = useMemo(
    () => (result ? alignSeries(result.matrix.series, result.window.start, result.window.end, result.window.step) : null),
    [result],
  )
  // Prepared once per result: names, statistics, colours. None of it depends on the view or on what is typed.
  const naming = useMemo(() => nameSeries((aligned?.series ?? []).map((s) => s.labels)), [aligned])
  const stats = useMemo(() => (aligned?.series ?? []).map((s) => seriesStats(aligned!.xs, s.values)), [aligned])
  // Colours: survivors keep their slot, new series take free slots in palette order, and
  // past eight the largest by mean are coloured and the rest fold into one Other group.
  const assigned = useMemo(() => assignSeries(aligned?.series ?? [], loadAssignment(), DEFAULT_POLICY), [aligned])
  useEffect(() => {
    if (aligned && aligned.series.length > 0) saveAssignment(assigned.assignment)
  }, [aligned, assigned])

  const chartSeries = useMemo<ChartSeries[]>(() => {
    const all = aligned?.series ?? []
    const out: ChartSeries[] = all.map((s, i) => {
      const slot = assigned.assignment[s.key]
      const n = naming.names[i]!
      return {
        id: s.key,
        label: n.full,
        shortLabel: n.short,
        // When one label tells the series apart, its value is the whole name: "checkout".
        directLabel: naming.valueOnly ? n.name : undefined,
        colorVar: slotToken(slot ?? null),
        other: slot === undefined,
        values: s.values,
      }
    })
    if (assigned.other?.combined) out.push({ id: OTHER_ID, label: 'Other', colorVar: slotToken(null), other: true, values: assigned.other.combined })
    return out
  }, [aligned, assigned, naming])
  const rows = useMemo<(LegendRow & { labels: Record<string, string> })[]>(
    () =>
      (aligned?.series ?? []).map((s, i) => ({
        id: s.key,
        name: naming.names[i]!.short,
        full: naming.names[i]!.full,
        labels: s.labels,
        colorVar: chartSeries[i]!.colorVar,
        other: chartSeries[i]!.other === true,
        stats: stats[i]!,
      })),
    [aligned, chartSeries, naming, stats],
  )
  // The table's columns: the labels that differ, most distinguishing first. A single series shows every label.
  const tableColumns = useMemo(() => {
    if (naming.distinguishing.length > 0) return { columns: naming.distinguishing, common: naming.common }
    const keys = Object.keys(aligned?.series[0]?.labels ?? {}).sort()
    return { columns: keys.includes('__name__') ? ['__name__', ...keys.filter((k) => k !== '__name__')] : keys, common: {} }
  }, [naming, aligned])

  // ---- which series are drawn. By itself the view draws the coloured ones (and the Other
  // group's sum when the policy asks for one); members of Other are drawn when selected.
  const defaultDrawn = useMemo<ReadonlySet<string>>(
    () => new Set([...assigned.coloured, ...(assigned.other?.combined ? [OTHER_ID] : [])]),
    [assigned],
  )
  const [isolated, setIsolated] = useState<ReadonlySet<string> | null>(null)
  const visible = useMemo(() => {
    if (!isolated) return null
    const keep = new Set(chartSeries.filter((s) => isolated.has(s.id)).map((s) => s.id))
    return keep.size === 0 || sameSet(keep, defaultDrawn) ? null : keep
  }, [isolated, chartSeries, defaultDrawn])
  const drawn = visible ?? defaultDrawn
  const drawnRef = useRef(drawn)
  drawnRef.current = drawn
  const toggleSeries = useCallback((id: string, additive: boolean) => {
    const cur = drawnRef.current
    if (additive) {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setIsolated(next.size === 0 ? null : next)
      return
    }
    // Plain click: isolate; clicking the only visible series shows the default again.
    setIsolated(cur.size === 1 && cur.has(id) ? null : new Set([id]))
  }, [])

  // ---- units: one scale for the value axis, from what is drawn. Ticks are numbers in that
  // scale; the unit is stated once, in the panel head. A value that stands alone (readout,
  // digest) carries its own unit.
  const axisScale = useMemo(() => {
    let max = 0
    for (const r of rows) {
      if (!drawn.has(r.id)) continue
      if (r.stats.max != null) max = Math.max(max, Math.abs(r.stats.max))
      if (r.stats.min != null) max = Math.max(max, Math.abs(r.stats.min))
    }
    return scaleFor(unit, max)
  }, [rows, drawn, unit])
  const formatAxis = useCallback((v: number) => formatInScale(v, unit, axisScale, 4), [unit, axisScale])
  const formatAlone = useCallback((v: number | null) => formatValue(v, unit), [unit])
  const yIncrements = unit === 'bytes' || unit === 'bytes/s' ? BINARY_INCREMENTS : undefined

  const [renderInfo, setRenderInfoState] = useState<RenderInfo | null>(null)
  const setRenderInfo = useCallback(
    (info: RenderInfo) =>
      setRenderInfoState((prev) =>
        prev && prev.rawPoints === info.rawPoints && prev.drawnPoints === info.drawnPoints && prev.downsampled === info.downsampled ? prev : info,
      ),
    [],
  )
  // ---- zoom: a drag on the chart, or the Zoom in / Zoom out buttons. The range before the
  // first zoom is remembered so that Reset zoom can return to it.
  const rangeRef = useRef({ from: search.from, to: search.to })
  rangeRef.current = { from: search.from, to: search.to }
  const zoomBase = useRef<{ from: string; to: string } | null>(null)
  const zoomTo = useCallback(
    (from: string, to: string) => {
      zoomBase.current ??= rangeRef.current
      setSearch({ from, to })
    },
    [setSearch],
  )
  const onZoom = useCallback((from: number, to: number) => zoomTo(absoluteSpec(from), absoluteSpec(to)), [zoomTo])
  const resetZoom = useCallback(() => {
    const base = zoomBase.current ?? { from: DEFAULT_SEARCH.from, to: DEFAULT_SEARCH.to }
    zoomBase.current = null
    setSearch(base)
  }, [setSearch])
  const onRange = useCallback(
    (from: string, to: string) => {
      zoomBase.current = null
      setSearch({ from, to })
    },
    [setSearch],
  )
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
        title: `Show the last ${spacedDuration(p)}`,
        keywords: 'time range relative',
        run: () => onRange(`now-${p}`, 'now'),
      })),
    ],
    'static',
  )

  const showAll = useCallback(() => setIsolated(null), [])
  // The shell owns the settings dialog; its command opens it.
  const { commands } = useCommandsContext()
  const openSettings = useCallback(() => commands.find((c) => c.id === 'settings-open')?.run(), [commands])

  // The digest is computed when the text form is first shown for a result, and kept for that
  // result: switching away and back does not compute it again. Its title is the result's query.
  const digestText = useMemo(() => {
    if (!aligned || !description || view !== 'text') return ''
    return cachedDigest(aligned, description.digestTitle, unit, formatAlone)
  }, [aligned, description, unit, formatAlone, view])

  // ---- render
  const error = q !== '' && query.isError ? query.error : null
  const isEmpty = !!result && result.matrix.series.length === 0
  const hasData = !!aligned && aligned.series.length > 0
  const shownResult = !error && (hasData || isEmpty) ? result : undefined
  const shown = shownResult && description ? description : null
  const widest = search.to === 'now' && search.from === 'now-24h'
  const alternative = window_ ? shorterRange(window_.end - window_.start) : null

  const caption = shownResult && shown && hasData && (
    <p className="vz-panel-desc" data-testid="status">
      <span className="app-num">{aligned!.series.length}</span> series, one point every{' '}
      {stepWords(shownResult.window.step)
        .split(' ')
        .map((part, i, parts) => (/^\d/.test(part) ? <span key={i} className="app-num">{part}</span> : ` ${part}${i < parts.length - 1 ? ' ' : ''}`))}
      .
      {view === 'chart' && renderInfo?.downsampled && (
        <>
          {' '}
          Each pixel column draws its minimum and maximum: <span className="app-num">{renderInfo.rawPoints.toLocaleString('en-US')}</span> points
          drawn as <span className="app-num">{renderInfo.drawnPoints.toLocaleString('en-US')}</span>.
        </>
      )}
      {shown.stale === 'query' && (
        <span data-testid="stale-query">
          {' '}
          This is the result of the previous query, <span className="app-num">{shown.q}</span>.
        </span>
      )}
      {shown.stale === 'range' && <span data-testid="stale-range"> This is the result for the previous time range, {spacedRange(shown.range)}.</span>}
    </p>
  )

  return (
    <div className="page">
      <h1 className="sr-only">Explore metrics</h1>

      {/* Query row: the one blue button of the view. */}
      <QueryRow committed={search.q} loading={loading} run={run} client={client} editorRef={editorRef} rangeRef={lookupRange} onEditorReady={onEditorReady} />

      {/* Toolbar: every control carries its label, so the row needs no explanation. */}
      <div className="toolbar">
        <TimeRangePicker from={search.from} to={search.to} onChange={onRange} onZoom={zoomTo} onResetZoom={resetZoom} />
        <StepInput value={search.step} auto={window_ ? stepWords(window_.step) : ''} onChange={(step) => setSearch({ step })} />
        <div className="vz-field unit-field">
          <label className="vz-label" htmlFor="unit">
            Unit
          </label>
          <select id="unit" data-testid="unit" className="vz-select" value={search.unit} onChange={(e) => setSearch({ unit: e.target.value }, true)}>
            {/* "Automatic" names the unit of what is on screen while a result is shown, and of the query otherwise. */}
            <option value="auto">Automatic: {UNITS.find((u) => u.id === (shownResult ? shownResult.inferredUnit : inferUnit(q)))?.label ?? 'number'}</option>
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
          {shownResult && shown && (
            <div className="field-row" data-testid="result-meta">
              {/* While the result is not the answer to the current query, the head says so; the query's text is in the caption. */}
              {shown.staleText && (
                <span className="vz-panel-meta" data-testid="stale" title={shown.stale === 'query' ? shown.q : shown.range}>
                  {shown.staleText}
                </span>
              )}
              <span className="vz-panel-meta" data-testid="result-range">
                {spacedRange(shown.range)}
              </span>
              <Age at={shownResult.receivedAt} unit={axisUnitLabel(shown.unit, axisScale)} />
            </div>
          )}
        </div>

        <div className="wait-slot">
          {halted && !loading ? (
            <div className="vz-progress" data-unmeasured="" data-testid="halted">
              <div className="vz-progress-text">
                <span role="status">
                  {halted === 'cancelled' ? 'Cancelled.' : 'Stopped after 60 s without an answer.'}
                  {shownResult ? ' The previous result is shown.' : ''}
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
                      ? 'Still waiting.'
                      : 'Waiting for the query'}
                </span>
                <span aria-hidden="true" data-testid="progress-elapsed">
                  <span className="app-num">{(wait.elapsedMs / 1000).toFixed(1)}</span> s
                </span>
                {wait.elapsedMs >= WAIT.alternativeAfter && loading && alternative && (
                  <button className="vz-progress-action" onClick={() => onRange(`now-${alternative.preset}`, 'now')} data-testid="alternative">
                    Show the last {spacedDuration(alternative.preset)}
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
          ) : (
            <div className="vz-progress-text" aria-hidden="true">
              &nbsp;
            </div>
          )}
        </div>

        <div className="region" data-view={view}>
          {error ? (
            <ErrorState
              error={error}
              tries={query.failureCount}
              elapsedMs={lastWaitMs.current}
              syntaxErrorAt={() => (editorReady ? (editorRef.current?.syntaxErrorAt(q) ?? null) : null)}
              onGoTo={(at) => editorRef.current?.focus(at)}
              onRetry={run}
              onOpenSettings={openSettings}
            />
          ) : q === '' ? (
            <StartState mock={!!backend.data?.mock} />
          ) : isEmpty && shown ? (
            <div className="vz-empty" data-testid="empty-state" role="status">
              <h3 className="vz-empty-title">No series matched</h3>
              <p>
                Nothing matched <span className="app-num">{shown.q}</span> between <span className="app-num">{formatDateTime(result!.window.start)}</span>{' '}
                and <span className="app-num">{formatDateTime(result!.window.end)}</span>. Check the metric name and the label matchers, or
                widen the time range.
              </p>
              {!widest && (
                <button className="vz-button" data-size="sm" onClick={() => onRange('now-24h', 'now')} data-focus-after="[data-testid=time-range]">
                  Show the last 24 h
                </button>
              )}
            </div>
          ) : hasData && shown ? (
            <>
              <div className={view === 'chart' ? 'region-part' : 'region-part is-parked'} aria-hidden={view === 'chart' ? undefined : true}>
                <TimeSeriesChart
                  xs={aligned!.xs}
                  series={chartSeries}
                  xRange={xRange}
                  visible={drawn}
                  formatValue={formatAxis}
                  formatReadout={formatAlone}
                  yIncrements={yIncrements}
                  onZoom={onZoom}
                  onRenderInfo={setRenderInfo}
                  syncKey="explore"
                  theme={theme}
                  ariaLabel={shown.chartLabel(aligned!.series.length)}
                />
                {view === 'chart' && caption}
                {view === 'chart' && <Warnings warnings={result!.warnings} />}
                <Legend rows={rows} drawn={drawn} isDefault={visible === null} onToggle={toggleSeries} onShowAll={showAll} unit={shown.unit} coarse={coarse} />
              </div>
              {view !== 'chart' && (
                <>
                  {caption}
                  <Warnings warnings={result!.warnings} />
                  {view === 'table' ? (
                    <ResultTable rows={rows} unit={shown.unit} columns={tableColumns.columns} common={tableColumns.common} />
                  ) : view === 'text' ? (
                    <TextView text={digestText} />
                  ) : (
                    <JsonView data={result!.matrix} elapsedMs={result!.elapsedMs} />
                  )}
                </>
              )}
            </>
          ) : null}
        </div>
      </section>
    </div>
  )
}

/** "Last 1h" as it is read: "Last 1 h". Absolute spans are already spaced. */
const spacedRange = (range: string) => (range.startsWith('Last ') ? `Last ${spacedDuration(range.slice(5))}` : range)

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

function ErrorState({
  error,
  tries,
  elapsedMs,
  syntaxErrorAt,
  onGoTo,
  onRetry,
  onOpenSettings,
}: {
  error: Error
  /** How many times the query was sent before this error (busy answers are retried). */
  tries: number
  /** How long those tries took, in ms. */
  elapsedMs: number
  /** Where the editor's own parser finds the first syntax error in the query, when the API gives no position. */
  syntaxErrorAt: () => number | null
  onGoTo: (at: number) => void
  onRetry: () => void
  onOpenSettings: () => void
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
      <h3 className="vz-empty-title">
        <span className="vz-mark" data-state="critical" />
        The query could not run
      </h3>
      <p data-testid="error-message">{error.message}</p>
      {api && (
        <p data-testid="error-advice">
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
          . {errorAdvice(error, Math.max(1, tries), elapsedMs, MOD)}
        </p>
      )}
      {character !== null ? (
        <button className="vz-button" data-size="sm" onClick={() => onGoTo(character - 1)} data-testid="error-fix">
          Go to character {character}
        </button>
      ) : kind === 'auth' || kind === 'scope' ? (
        <button className="vz-button" data-size="sm" onClick={onOpenSettings} data-testid="error-fix">
          Open settings
        </button>
      ) : (
        <button className="vz-button" data-size="sm" onClick={onRetry} data-testid="error-fix" data-focus-after="[data-testid=run]">
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
                <Link to="/explore" search={{ q: ex.q }} className="vz-link" data-focus-after="[data-testid=run]">
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
