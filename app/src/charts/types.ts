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
  /** CSS colour for the current theme. */
  color: string
  /** Canvas dash pattern; empty for a solid line. */
  dash: readonly number[]
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
  height: number
  /** Ids of series to draw; null draws all. */
  visible: ReadonlySet<string> | null
  /** Series to emphasise (e.g. hovered in the legend). */
  highlightId?: string | null
  formatValue: (v: number) => string
  /** Called with the selected range (epoch seconds) after a horizontal drag. */
  onZoom?: (from: number, to: number) => void
  onRenderInfo?: (info: RenderInfo) => void
  /** Charts with the same key share a crosshair. */
  syncKey?: string
  /** Re-reads theme tokens when it changes. */
  theme: 'light' | 'dark'
  ariaLabel: string
}
