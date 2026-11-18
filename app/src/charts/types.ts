/**
 * The internal chart interface. Views depend on these types and on the components exported
 * from `charts/index.ts` only; the renderer (uPlot today) is an implementation detail of
 * this directory and can be replaced without touching callers.
 */

export interface ChartSeries {
  /** Stable identity (canonical label set). */
  id: string
  /** Display name. */
  label: string
  /** Shorter name for tight spaces (tooltip, announcements); defaults to `label`. */
  shortLabel?: string
  /** Text drawn at the end of the line when the chart labels its series directly; defaults to `shortLabel`. */
  directLabel?: string
  /** Name of the CSS custom property that holds the line's colour (`--series-1`..`--series-8`, or a neutral ink for Other). */
  colorVar: string
  /** Folded into Other: drawn first, as a hairline, so the coloured series stay on top. */
  other?: boolean
  /** One value per x; null is a gap and is never bridged. */
  values: (number | null)[]
}

export interface RenderInfo {
  /** Points per series handed to the chart. */
  rawPoints: number
  /** Points per series actually drawn. */
  drawnPoints: number
  /** Pixel columns of the plot area (device pixels). */
  columns: number
  downsampled: boolean
}

export interface TimeSeriesChartProps {
  /** Epoch seconds, ascending, shared by all series. */
  xs: number[]
  series: ChartSeries[]
  /** Visible x range in epoch seconds (the query window), so edge gaps are visible. */
  xRange: [number, number]
  /** Ids of series to draw; null draws all. */
  visible: ReadonlySet<string> | null
  /** Axis ticks: the number alone, in the axis' one scale. The owner states the unit once (panel head). */
  formatValue: (v: number) => string
  /** A value that stands alone (the crosshair readout, the keyboard announcement): number and unit. Defaults to `formatValue`. */
  formatReadout?: (v: number) => string
  /** Allowed tick increments of the value axis (powers of two for bytes); the renderer's own when omitted. */
  yIncrements?: number[]
  /** Called with the selected range (epoch seconds) after a horizontal drag. */
  onZoom?: (from: number, to: number) => void
  onRenderInfo?: (info: RenderInfo) => void
  /** Charts with the same key share a crosshair. */
  syncKey?: string
  /** Re-reads the design tokens when it changes. The chart takes its size from its container. */
  theme: 'light' | 'dark'
  ariaLabel: string
}
