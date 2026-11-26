import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { fixHead, fixName, fixRowName, fixText } from './fixups'
import { drawChart, type ChartHandle, type ChartSpec } from './systemChart'

/** The range a zoomed chart shows, as instants (epoch ms). */
export interface ShownRange {
  fromMs: number
  toMs: number
}

export interface ChartProps {
  /** The result on screen, as the system's chart takes it (charts/spec.ts). A new object is a new result. */
  spec: ChartSpec
  /** What `spec`'s times were moved by so that the chart's clock reads local time; taken off again for `onShownRange`. */
  shiftMs: number
  /** The step as it is read ("15 s"), for the text form. */
  stepWords: string
  /** The view's colour map: series keep their colours for the tab's session under this name (Chart, "Series colour", 2). */
  view: string
  /** The id of the element the chart writes its text form into (`.vz-text-form`). */
  textFormId: string
  /**
   * An error after this result was drawn: the message lies over the plot and the legend keeps
   * the result's figures (Chart, "States"). `title` is what the text form says failed; the
   * node is what is shown.
   */
  error: { title: string; node: ReactNode } | null
  /** The range the chart shows changed by a zoom; null when it shows the whole result again. */
  onShownRange?: (range: ShownRange | null) => void
  /** Parked: laid out and drawn (the text form and the next switch need it) but not shown. */
  parked: boolean
}

const RESERVE = 'viz.chart.reserve:'

/** The legend rows and note lines the view's last result drew, so the next load reserves them before its data arrives (Chart, "Reserved height"). */
function reserved(view: string): CSSProperties {
  try {
    const v = JSON.parse(sessionStorage.getItem(RESERVE + view) ?? 'null') as { rows?: unknown; notes?: unknown } | null
    if (v && Number.isInteger(v.rows) && Number.isInteger(v.notes)) return { '--legend-rows': v.rows, '--legend-notes': v.notes } as CSSProperties
  } catch {
    // Nothing remembered.
  }
  return {}
}
function remember(view: string, root: HTMLElement): void {
  const rows = Number(root.style.getPropertyValue('--legend-rows'))
  const notes = Number(root.style.getPropertyValue('--legend-notes'))
  if (!Number.isInteger(rows) || !Number.isInteger(notes)) return
  try {
    sessionStorage.setItem(RESERVE + view, JSON.stringify({ rows, notes }))
  } catch {
    // Not remembered: the next load reserves the chart's fixed parts only.
  }
}

/** The reserved height of a view's chart before any chart is drawn (the waiting and empty states use it). */
export const reservedStyle = reserved

/**
 * The design system's chart for one result. This component owns no drawing: it hands the
 * system's chart the result, tells it of an error, and listens for the range it shows.
 */
export const Chart = memo(function Chart({ spec, shiftMs, stepWords, view, textFormId, error, onShownRange, parked }: ChartProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const handle = useRef<ChartHandle | null>(null)
  const [reserve] = useState(() => reserved(view))
  const [errorHost, setErrorHost] = useState<HTMLElement | null>(null)
  const live = useRef({ spec, shiftMs, stepWords, onShownRange, shown: false })
  live.current.shiftMs = shiftMs
  live.current.stepWords = stepWords
  live.current.onShownRange = onShownRange

  const wasFailed = useRef<string | null>(null)

  // ---- once per element: the observers around the chart.
  useLayoutEffect(() => {
    const root = rootRef.current!
    const unitless = () => live.current.spec.unit === ''
    const fix = (records: MutationRecord[] | null) => {
      const tbody = root.querySelector('tbody')
      const svg = root.querySelector(':scope > svg')
      if (unitless()) {
        const head = root.querySelector('thead [data-col="last"] .vz-sort')
        if (head && head.textContent !== fixHead(head.textContent)) head.textContent = fixHead(head.textContent)
        const name = svg?.getAttribute('aria-label')
        if (svg && name && name !== fixName(name)) svg.setAttribute('aria-label', fixName(name))
      }
      // Only when the legend's rows were written again, not on every move of the crosshair.
      if (tbody && (records === null || records.some((r) => r.target === tbody))) {
        for (const row of tbody.querySelectorAll<HTMLElement>('.vz-series')) {
          const name = row.getAttribute('aria-label') ?? ''
          const fixed = fixRowName(`${row.querySelector('.vz-series-name')?.textContent ?? ''} ${row.querySelector('.vz-series-rest')?.textContent ?? ''}`, name)
          if (fixed !== name) row.setAttribute('aria-label', fixed)
          // "Other" and "28 series" are two elements with nothing between them: their text reads "Other28 series". A space between them is not drawn (they are flex items) and makes the words two.
          const rest = row.querySelector('.vz-series-rest')
          if (rest && rest.previousSibling?.nodeType === Node.ELEMENT_NODE) rest.before(' ')
        }
      }
      // The error's place: the chart makes a new one whenever it draws, so the message follows it.
      const host = root.querySelector<HTMLElement>(':scope > .vz-empty')
      setErrorHostNow(host)
    }
    let current: HTMLElement | null = null
    const setErrorHostNow = (host: HTMLElement | null) => {
      if (host === current) return
      current = host
      if (host) host.replaceChildren() // the chart's own words; ours take their place in the same task
      flushSync(() => setErrorHost(host))
    }
    const text = document.getElementById(textFormId)
    const fixForm = () => {
      const first = text?.querySelector('li')
      if (first && first.textContent !== fixText(first.textContent, live.current.stepWords)) first.textContent = fixText(first.textContent, live.current.stepWords)
    }
    const chartObserver = new MutationObserver((records) => fix(records))
    chartObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] })
    const textObserver = new MutationObserver(fixForm)
    if (text) textObserver.observe(text, { childList: true })

    return () => {
      chartObserver.disconnect()
      textObserver.disconnect()
    }
  }, [textFormId])

  // ---- a result: drawn before the frame that shows it.
  useLayoutEffect(() => {
    const root = rootRef.current!
    live.current.spec = spec
    handle.current = drawChart(root, spec)
    remember(view, root)
    // A new result is drawn whole; the chart cleared any error with it.
    wasFailed.current = null
    if (live.current.shown) {
      live.current.shown = false
      live.current.onShownRange?.(null)
    }
  }, [spec, view])

  // ---- the range the chart shows. A zoom (the foot's buttons, a drag, plus and minus) changes
  // it within the result. These listeners are added after the chart's own (the effect above
  // made the chart), so they run after it has acted.
  useLayoutEffect(() => {
    const root = rootRef.current!
    const report = () => {
      const h = handle.current
      if (!h) return
      const { spec: s, shiftMs: shift } = live.current
      const n = s.series[0]?.values.length ?? 1
      const zoomed = h.state.t0 !== s.t0 || h.state.t1 !== s.t0 + (n - 1) * s.step
      if (!zoomed && !live.current.shown) return
      live.current.shown = zoomed
      live.current.onShownRange?.(zoomed ? { fromMs: h.state.t0 - shift, toMs: h.state.t1 - shift } : null)
    }
    for (const type of ['click', 'pointerup', 'keydown'] as const) root.addEventListener(type, report)
    return () => {
      for (const type of ['click', 'pointerup', 'keydown'] as const) root.removeEventListener(type, report)
    }
  }, [])

  // ---- an error after the result was drawn, and its end.
  const failed = error?.title ?? null
  useLayoutEffect(() => {
    if (failed === wasFailed.current) return
    wasFailed.current = failed
    handle.current?.setError(failed === null ? null : { title: failed, text: '' })
  }, [failed, spec])

  return (
    <>
      <div ref={rootRef} className={parked ? 'vz-chart is-parked' : 'vz-chart'} inert={parked} data-view={view} data-text-form={textFormId} style={reserve} data-testid="chart" />
      {error && errorHost && createPortal(error.node, errorHost)}
    </>
  )
})
