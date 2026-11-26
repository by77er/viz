import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { NO_AGGREGATE } from './spec'
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
 * Words the chart writes that an application's result needs otherwise. Each is a gap in the
 * reference chart, listed in README.md under "Needed changes in the design system"; this is
 * the whole of what the app changes in what the chart writes.
 *
 * - A result with no unit: the chart writes "Last, " and "title, , range". The comma that
 *   introduces the missing unit is removed.
 * - The text form says "every 0.25 min, <aggregate>" (it assumes steps of whole minutes and an
 *   aggregate per step). A range query has neither: it says "one value every 15 s".
 */
const fixHead = (text: string) => (text.endsWith(', ') ? text.slice(0, -2) : text)
const fixName = (text: string) => text.replace(', , ', ', ')
export function fixText(line: string, step: string): string {
  return line.replace(', , ', ', ').replace(new RegExp(`, every [^,]+ min, ${NO_AGGREGATE}\\.`), `, one value every ${step}.`)
}

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

  // ---- once per element: the observers and listeners around the chart.
  useLayoutEffect(() => {
    const root = rootRef.current!
    const unitless = () => live.current.spec.unit === ''
    const fix = () => {
      const svg = root.querySelector(':scope > svg')
      if (unitless()) {
        const head = root.querySelector('thead [data-col="last"] .vz-sort')
        if (head && head.textContent !== fixHead(head.textContent)) head.textContent = fixHead(head.textContent)
        const name = svg?.getAttribute('aria-label')
        if (svg && name && name !== fixName(name)) svg.setAttribute('aria-label', fixName(name))
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
    const chartObserver = new MutationObserver(fix)
    chartObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] })
    const textObserver = new MutationObserver(fixForm)
    if (text) textObserver.observe(text, { childList: true })

    // A zoom (the foot's buttons, a drag, plus and minus) changes the range the chart shows,
    // within the result. These run after the chart's own handlers.
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
      chartObserver.disconnect()
      textObserver.disconnect()
      for (const type of ['click', 'pointerup', 'keydown'] as const) root.removeEventListener(type, report)
    }
  }, [textFormId])

  // ---- a result: drawn before the frame that shows it.
  useLayoutEffect(() => {
    const root = rootRef.current!
    live.current.spec = spec
    handle.current = drawChart(root, spec)
    remember(view, root)
    if (live.current.shown) {
      live.current.shown = false
      live.current.onShownRange?.(null)
    }
  }, [spec, view])

  // ---- an error after the result was drawn, and its end.
  const failed = error?.title ?? null
  const wasFailed = useRef<string | null>(null)
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
