import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { PromApiError } from '../api/client'
import type { PromMatrixData } from '../api/types'
import { TimeSeriesChart, type ChartSeries, type RenderInfo } from '../charts'
import type { PromqlEditorHandle } from '../editor/PromqlEditor'
import { assignStyles, DASHES, slotColor } from '../lib/color'
import { digestSeries, renderDigest } from '../lib/digest'
import { alignMatrix, seriesStats } from '../lib/series'
import { alignWindow, autoStep, bucketWidth, type QueryWindow } from '../lib/step'
import { absoluteSpec, describeRange, formatDateTime, formatDuration, parseDuration, resolveTimeSpec } from '../lib/time'
import { formatValue, inferUnit, isUnitId, UNITS, type UnitId } from '../lib/units'
import { parseExploreSearch, type ExploreSearch } from '../lib/urlState'
import { useBackendInfo } from '../shell/AppShell'
import { MOD, useCommands } from '../shell/commands'
import { useSettings } from '../shell/settings'
import { useTheme } from '../shell/theme'
import { Legend, type LegendRow } from './Legend'
import { JsonView } from './JsonView'
import { ResultTable } from './ResultTable'
import { TextView } from './TextView'
import { PRESETS, TimeRangePicker } from './TimeRangePicker'

const exploreRoute = getRouteApi('/explore')
const PromqlEditor = lazy(() => import('../editor/PromqlEditor'))

const CHART_HEIGHT = 300

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
}

export function ExplorePage() {
  const rawSearch = exploreRoute.useSearch()
  const search = useMemo(() => parseExploreSearch(rawSearch), [rawSearch])
  const navigate = useNavigate()
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
    // runId re-resolves "now" for relative ranges on every run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.from, search.to, search.step, widthBucket, runId])

  const q = search.q.trim()
  const query = useQuery<RangeResult, Error>({
    // The token is deliberately not part of the key; connectionId changes when settings do.
    queryKey: ['query_range', connectionId, q, window_?.start, window_?.end, window_?.step, runId],
    enabled: q !== '' && window_ !== null,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    gcTime: 60_000,
    queryFn: async ({ signal }) => {
      const w = window_!
      const t0 = performance.now()
      const res = await client.queryRange(q, w.start, w.end, w.step, { signal })
      return { data: res.data, warnings: res.warnings, window: w, elapsedMs: performance.now() - t0 }
    },
  })

  const run = useCallback(() => {
    const next = draft.trim()
    if (next !== search.q) setSearch({ q: next })
    setRunId((n) => n + 1)
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
  const chartSeries = useMemo<ChartSeries[]>(
    () =>
      (aligned?.series ?? []).map((s) => {
        const st = styles.get(s.key)!
        return { id: s.key, label: s.name, color: slotColor(st.slot, theme === 'dark'), dash: DASHES[st.dash]!, values: s.values }
      }),
    [aligned, styles, theme],
  )
  const rows = useMemo<(LegendRow & { labels: Record<string, string> })[]>(
    () =>
      (aligned?.series ?? []).map((s, i) => ({
        id: s.key,
        name: s.name,
        labels: s.labels,
        color: chartSeries[i]!.color,
        dash: chartSeries[i]!.dash,
        stats: seriesStats(aligned!.xs, s.values),
      })),
    [aligned, chartSeries],
  )
  const digestText = useMemo(() => {
    if (!aligned) return ''
    return renderDigest(digestSeries({ xs: aligned.xs, series: aligned.series }), { format, title: `Query: ${q}` })
  }, [aligned, format, q])

  // ---- series isolation (local view state; pruned when the series set changes)
  const [isolated, setIsolated] = useState<ReadonlySet<string> | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
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

  const [renderInfo, setRenderInfo] = useState<RenderInfo | null>(null)
  const onZoom = useCallback((from: number, to: number) => setSearch({ from: absoluteSpec(from), to: absoluteSpec(to) }), [setSearch])
  const xRange = useMemo<[number, number]>(() => (result ? [result.window.start, result.window.end] : [0, 1]), [result])

  // ---- keyboard & commands
  const toggleView = useCallback(() => setSearch({ view: search.view === 'text' ? 'chart' : 'text' }, true), [search.view, setSearch])
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
      { id: 'q-focus', group: 'Query', title: 'Focus query editor', shortcut: '/', run: () => editorRef.current?.focus() },
      {
        id: 'q-link',
        group: 'Query',
        title: 'Copy link to this view',
        keywords: 'share url permalink',
        run: () => void navigator.clipboard?.writeText(window.location.href).catch(() => {}),
      },
      { id: 'v-text', group: 'View', title: search.view === 'text' ? 'Show chart' : 'Show text view (digest)', shortcut: 'T', keywords: 'toggle accessible agent', run: toggleView },
      { id: 'v-table', group: 'View', title: 'Show result table', run: () => setSearch({ tab: 'table' }, true) },
      { id: 'v-json', group: 'View', title: 'Show raw JSON', run: () => setSearch({ tab: 'json' }, true) },
      ...PRESETS.map((p) => ({
        id: `t-${p}`,
        group: 'Time range' as const,
        title: `Last ${p}`,
        keywords: 'time range relative',
        run: () => setSearch({ from: `now-${p}`, to: 'now' }),
      })),
    ],
    search.view,
  )

  // ---- render
  const error = q !== '' && query.isError ? query.error : null
  const loading = q !== '' && query.isFetching
  const isEmpty = !!result && result.data.result.length === 0
  const hasData = !!aligned && aligned.series.length > 0
  const stale = query.isPlaceholderData

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 p-2 sm:p-3">
      <h1 className="sr-only">Explore metrics</h1>

      {/* Query row */}
      <div className="flex items-start gap-2">
        <div className="panel flex min-h-[34px] min-w-0 flex-1 items-stretch focus-within:border-[var(--focus)]">
          <Suspense fallback={<div className="mono flex-1 px-2.5 py-[7px] text-fg-3">{draft || 'Loading editor…'}</div>}>
            <PromqlEditor value={draft} onChange={setDraft} onRun={run} client={client} handleRef={editorRef} />
          </Suspense>
        </div>
        <button className="btn btn-primary h-[34px] px-3.5" onClick={run} data-testid="run" aria-keyshortcuts="Control+Enter Meta+Enter" title={`Run query (${MOD}+Enter)`}>
          Run
          <span className="hidden text-[11px] font-normal md:inline">{MOD}↵</span>
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <TimeRangePicker from={search.from} to={search.to} onChange={(from, to) => setSearch({ from, to })} />
        <label className="flex items-center gap-1.5 text-[12px] text-fg-3">
          Step
          <StepInput value={search.step} auto={window_ ? formatDuration(window_.step) : ''} onChange={(step) => setSearch({ step })} />
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-fg-3">
          Unit
          <select className="input" value={search.unit} onChange={(e) => setSearch({ unit: e.target.value }, true)}>
            <option value="auto">auto ({UNITS.find((u) => u.id === inferUnit(q))?.label ?? 'number'})</option>
            {UNITS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
        </label>
        <datalist id="step-options">
          {['15s', '30s', '1m', '5m', '15m', '1h'].map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <div className="flex-1" />
        <div className="seg" role="group" aria-label="Result form">
          <button aria-pressed={search.view === 'chart'} onClick={() => setSearch({ view: 'chart' }, true)} data-testid="view-chart">
            Chart
          </button>
          <button aria-pressed={search.view === 'text'} onClick={() => setSearch({ view: 'text' }, true)} data-testid="view-text">
            Text
          </button>
        </div>
      </div>

      {/* Result */}
      <section ref={panelRef} className="panel relative min-w-0" aria-label="Query result" aria-busy={loading}>
        {loading && <div className="progress" role="progressbar" aria-label="Loading query result" />}

        <StatusLine result={hasData || isEmpty ? result : undefined} loading={loading} stale={stale && !error} info={search.view === 'chart' ? renderInfo : null} points={aligned?.xs.length ?? 0} />

        {error ? (
          <ErrorState error={error} />
        ) : q === '' ? (
          <StartState
            mock={!!backend.data?.mock}
            onPick={(example) => {
              setDraft(example)
              setSearch({ q: example })
              setRunId((n) => n + 1)
            }}
          />
        ) : isEmpty ? (
          <div className="flex flex-col items-center justify-center gap-1 px-4 text-center" style={{ minHeight: CHART_HEIGHT }} data-testid="empty-state" role="status">
            <div className="text-[14px] font-semibold">The query returned no series</div>
            <div className="max-w-[520px] text-fg-3">
              Nothing matched between {formatDateTime(result!.window.start)} and {formatDateTime(result!.window.end)}. Check the metric name and
              label matchers, or widen the time range.
            </div>
          </div>
        ) : hasData ? (
          <>
            {search.view === 'text' ? (
              <TextView text={digestText} height={CHART_HEIGHT} />
            ) : (
              <div className={`px-1 pt-1 transition-opacity ${stale ? 'opacity-60' : ''}`}>
                <TimeSeriesChart
                  xs={aligned!.xs}
                  series={chartSeries}
                  xRange={xRange}
                  height={CHART_HEIGHT}
                  visible={visible}
                  highlightId={hoverId}
                  formatValue={formatAxis}
                  onZoom={onZoom}
                  onRenderInfo={setRenderInfo}
                  syncKey="explore"
                  theme={theme}
                  ariaLabel={`Chart of ${aligned!.series.length} series for the query ${q}. Arrow keys move the cursor. The Text view has the same data.`}
                />
              </div>
            )}
            <Legend rows={rows} visible={visible} onToggle={toggleSeries} onShowAll={() => setIsolated(null)} onHover={setHoverId} format={format} />
          </>
        ) : (
          <div className="flex items-center justify-center text-fg-3" style={{ minHeight: CHART_HEIGHT }} role="status">
            Running query…
          </div>
        )}
      </section>

      {result && result.warnings.length > 0 && (
        <div role="status" className="rounded-md border border-warn-line bg-warn-soft px-3 py-1.5 text-[12px] text-warn-fg">
          {result.warnings.map((w) => (
            <div key={w}>Warning: {w}</div>
          ))}
        </div>
      )}

      {/* Table / JSON */}
      {hasData && !error && (
        <section className="panel min-w-0 overflow-hidden" aria-label="Result data">
          <div className="flex items-center gap-2 border-b border-line px-2 py-1.5">
            <div className="seg" role="tablist" aria-label="Result data form">
              <button role="tab" id="tab-table" aria-selected={search.tab === 'table'} aria-controls="tabpanel" onClick={() => setSearch({ tab: 'table' }, true)}>
                Table
              </button>
              <button role="tab" id="tab-json" aria-selected={search.tab === 'json'} aria-controls="tabpanel" onClick={() => setSearch({ tab: 'json' }, true)} data-testid="tab-json">
                JSON
              </button>
            </div>
            <span className="text-[12px] text-fg-3">
              {search.tab === 'table' ? 'Latest value per series in the range' : 'Raw API response'}
            </span>
          </div>
          <div role="tabpanel" id="tabpanel" aria-labelledby={search.tab === 'table' ? 'tab-table' : 'tab-json'}>
            {search.tab === 'table' ? <ResultTable rows={rows} format={format} /> : <JsonView data={result!.data} />}
          </div>
        </section>
      )}
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
    <input
      className="input tnum w-[112px]"
      value={text}
      placeholder={auto ? `auto (${auto})` : 'auto'}
      aria-label="Query step (a duration such as 30s; empty for automatic)"
      aria-invalid={invalid}
      title="Query step, e.g. 15s, 1m. Empty = automatic from the range and chart width."
      style={invalid ? { borderColor: 'var(--danger)' } : undefined}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
      list="step-options"
      spellCheck={false}
      data-testid="step"
    />
  )
}

function StatusLine({
  result,
  loading,
  stale,
  info,
  points,
}: {
  result: RangeResult | undefined
  loading: boolean
  stale: boolean
  info: RenderInfo | null
  points: number
}) {
  if (!result) return null
  const n = result.data.result.length
  const items: string[] = [
    `${n} series`,
    `${points.toLocaleString('en-US')} steps`,
    `step ${formatDuration(result.window.step)}`,
    describeRange(absoluteSpec(result.window.start), absoluteSpec(result.window.end), 0),
    `${result.elapsedMs < 10 ? result.elapsedMs.toFixed(1) : Math.round(result.elapsedMs)} ms`,
  ]
  return (
    <div className="tnum flex flex-wrap items-center gap-x-2 px-2.5 pt-1.5 text-[11.5px] text-fg-3" data-testid="status" role="status">
      {items.map((it, i) => (
        <span key={i} className="whitespace-nowrap">
          {i > 0 && <span aria-hidden="true" className="mr-2 text-line-strong">·</span>}
          {it}
        </span>
      ))}
      {info?.downsampled && n > 0 && (
        <span className="whitespace-nowrap" title="More samples than pixel columns: each column draws its minimum and maximum, so spikes are preserved.">
          <span aria-hidden="true" className="mr-2 text-line-strong">·</span>
          drawn as min/max per pixel column ({info.rawPoints.toLocaleString('en-US')} → {info.drawnPoints.toLocaleString('en-US')} points)
        </span>
      )}
      {loading && <span className="whitespace-nowrap text-fg-2">{stale ? 'Loading… showing the previous result' : 'Loading…'}</span>}
    </div>
  )
}

function ErrorState({ error }: { error: Error }) {
  const api = error instanceof PromApiError ? error : null
  return (
    <div className="flex flex-col items-start gap-2 p-4" style={{ minHeight: 160 }} role="alert" data-testid="error-state">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-danger">
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 1.8 15 14H1z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M8 6.5v3.4M8 11.6v.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        Query failed
        {api && (
          <span className="rounded-sm border border-danger-line px-1.5 text-[11px] font-medium" data-testid="error-type">
            {api.errorType}
            {api.status ? ` · HTTP ${api.status}` : ''}
          </span>
        )}
      </div>
      <pre className="mono m-0 w-full whitespace-pre-wrap break-words rounded border border-danger-line bg-danger-soft px-3 py-2 text-[12.5px] text-fg" data-testid="error-message">
        {error.message}
      </pre>
      <div className="text-[12px] text-fg-3">Fix the query and press {MOD}+Enter to run it again.</div>
    </div>
  )
}

function StartState({ mock, onPick }: { mock: boolean; onPick: (q: string) => void }) {
  return (
    <div className="flex flex-col gap-3 p-4" style={{ minHeight: CHART_HEIGHT }} data-testid="start-state">
      <div>
        <div className="text-[14px] font-semibold">Explore metrics</div>
        <div className="text-fg-3">
          Type a PromQL query above and press <span className="kbd">{MOD}</span> <span className="kbd">Enter</span>. Metric and label names
          autocomplete from the connected backend.
        </div>
      </div>
      {mock && (
        <div className="flex flex-col gap-1">
          <div className="label">Examples (mock data)</div>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {MOCK_EXAMPLES.map((ex) => (
              <li key={ex.q}>
                <button className="group flex w-full flex-col rounded border border-line px-2.5 py-1.5 text-left hover:border-line-strong hover:bg-surface-2 sm:flex-row sm:items-baseline sm:gap-3" onClick={() => onPick(ex.q)}>
                  <span className="shrink-0 font-medium sm:w-[190px]">{ex.title}</span>
                  <span className="mono min-w-0 break-all text-fg-3 group-hover:text-fg-2">{ex.q}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
