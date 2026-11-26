/**
 * The design system's reference chart (design-system/dist/viz-chart.js, built from
 * project/components/Chart/preview.html) and its press script, as this app uses them.
 *
 * The chart is the system's own implementation of its Chart rules: slots and the colour map
 * ("what a person sees wins"), one Other band and one legend row, "Colour the eight largest"
 * offered only when it would change a colour (D73), direct labels, the readout in the foot,
 * zoom by button, the legend as a table of toggles, the text form, and the reserved height it
 * sets on itself (`--legend-rows`, `--legend-notes`) whenever it draws its legend. The app
 * hands it a result and sets geometry-free data only; it draws nothing of a chart itself.
 *
 * Both files are plain scripts that register themselves on `window` (`vzChart`,
 * `vzChartRules`, `vzPress`). They are imported for that effect and bundled with the app, so
 * the page loads no script from anywhere but its own origin.
 */
import '../../../design-system/dist/viz-chart.js'
import '../../../design-system/dist/viz-press.js'

/** One series of a result on the chart's regular grid: `values[i]` is the value at `t0 + i * step`, null where there is none. */
export interface SpecSeries {
  labels: Record<string, string>
  values: (number | null)[]
}

/** What the chart draws (Chart preview, `demos`): times in milliseconds. */
export interface ChartSpec {
  /** The unit the values arrive in: `B` (scaled in binary steps), `s` or `ms` (scaled to s, ms, µs), or any other name, kept. */
  unit: string
  /** The aggregate over a step, as the text form says it. */
  agg: string
  t0: number
  step: number
  series: SpecSeries[]
}

/** The chart's view state that the app reads: the range shown (after a zoom) and the crosshair. */
export interface ChartState {
  t0: number
  t1: number
  cursor: number | null
}

export interface ChartError {
  title: string
  text: string
  action?: string
}

export interface ChartHandle {
  draw(): void
  state: ChartState
  /** A new result for the same view: colours (the view's map), chosen rows and sort order survive. */
  setData(next: ChartSpec): void
  /** An error after a result was drawn: the message lies over the plot; the legend keeps the previous figures. Null clears it. */
  setError(error: ChartError | null): void
  /** The slot (1 to 8) a series has in the view's colour map, 0 for Other. */
  slot(key: string): number
}

interface ValueTicks {
  bottom: number
  top: number
  step: number
  ticks: number[]
}

/** The Chart rules as pure functions (Chart README; `tools/test/chart-rules.test.mjs` checks them as properties). */
export interface ChartRules {
  scaleUnit(unit: string, max: number): { div: number; unit: string; suffix: string; binary?: boolean }
  valueTicks(o: { lo?: number; hi?: number; plotH: number; lineH: number; binary?: boolean }): ValueTicks
  numberFormat(step: number, suffix?: string, div?: number): { dec: number; tick(v: number): string; value(raw: number | null): string }
  distinguish(series: { labels: Record<string, string> }[]): { common: Record<string, string>; order: string[] }
}

declare global {
  interface Window {
    vzChart(root: HTMLElement, spec: ChartSpec): ChartHandle
    vzChartRules: ChartRules
  }
}

/** One chart per element, for the element's life: the script adds its listeners to the element it is given and has no way to remove them. */
const handles = new WeakMap<HTMLElement, ChartHandle>()

/** Draws `spec` in `root` (a `.vz-chart` with `data-view`), or hands the chart already there the new result. */
export function drawChart(root: HTMLElement, spec: ChartSpec): ChartHandle {
  let handle = handles.get(root)
  if (handle) handle.setData(spec)
  else handles.set(root, (handle = window.vzChart(root, spec)))
  return handle
}

export const chartRules = (): ChartRules => window.vzChartRules
