/**
 * TypeScript types for `viz.dashboard/v1`. These mirror the JSON Schema in
 * `schema.ts` one to one; `test/schema.test.ts` checks the two against each
 * other on the examples and on a table of invalid specs.
 */

export const API_VERSION = 'viz.dashboard/v1' as const

/** Stable identifier: lowercase letter, then lowercase letters, digits or `_`; at most 48 chars. */
export type Id = string

export const UNITS = [
  'none', 'count', 'percent', 'ratio',
  's', 'ms', 'us', 'ns',
  'bytes', 'bits', 'bytes/s', 'bits/s',
  'req/s', 'ops/s', 'events/s', 'rows/s', 'errors/s',
  'cores', 'celsius', 'usd',
] as const
export type Unit = (typeof UNITS)[number]

export const QUERY_LANGS = ['promql', 'traceql', 'logql'] as const
export type QueryLang = (typeof QUERY_LANGS)[number]

export const PANEL_KINDS = ['timeseries', 'stat', 'table', 'heatmap', 'text'] as const
export type PanelKind = (typeof PANEL_KINDS)[number]

export const LEVELS = ['info', 'warn', 'crit'] as const
export type Level = (typeof LEVELS)[number]
export type ThresholdState = 'ok' | Level

export const REDUCERS = ['last', 'mean', 'min', 'max', 'sum'] as const
export type Reducer = (typeof REDUCERS)[number]

export interface Metadata {
  id: Id
  title: string
  /** What question the dashboard answers, and for whom. Required. */
  intent: string
  tags?: string[]
}

export interface TimeRange {
  /** `now`, `now-6h`, or an RFC 3339 timestamp. */
  from: string
  to: string
  /** Auto-refresh interval as a duration, e.g. `30s`. */
  refresh?: string
}

interface VariableBase {
  label?: string
  description?: string
}
export interface EnumVariable extends VariableBase {
  kind: 'enum'
  values: string[]
  multi?: boolean
  includeAll?: boolean
  default?: string | string[]
}
export interface QueryVariable extends VariableBase {
  kind: 'query'
  query: { lang: QueryLang; expr: string }
  multi?: boolean
  includeAll?: boolean
  default?: string | string[]
}
export interface TextVariable extends VariableBase {
  kind: 'text'
  default?: string
}
export interface IntervalVariable extends VariableBase {
  kind: 'interval'
  /** Durations such as `1m`, `5m`, `1h`. */
  values: string[]
  default?: string
}
export type Variable = EnumVariable | QueryVariable | TextVariable | IntervalVariable

export interface Query {
  lang: QueryLang
  expr: string
  /** Series name template, e.g. `{{route}} {{status}}`. */
  legend?: string
  /** Evaluate at the end of the range only (tables, stats). */
  instant?: boolean
}

export type Threshold =
  | { above: number; level: Level; label?: string }
  | { below: number; level: Level; label?: string }

export interface TimeseriesPanel {
  kind: 'timeseries'
  title: string
  description: string
  unit: Unit
  queries: Id[]
  options?: {
    style?: 'line' | 'area' | 'bars'
    stack?: boolean
    yScale?: 'linear' | 'log'
    yMin?: number
    yMax?: number
    maxSeries?: number
    legend?: 'list' | 'table' | 'hidden'
  }
  thresholds?: Threshold[]
}
export interface StatPanel {
  kind: 'stat'
  title: string
  description: string
  unit: Unit
  queries: Id[]
  options?: {
    reduce?: Reducer
    sparkline?: boolean
    decimals?: number
  }
  thresholds?: Threshold[]
}
export interface TableColumn {
  /** Named query whose value fills the column. */
  query: Id
  title?: string
  unit?: Unit
}
export interface TablePanel {
  kind: 'table'
  title: string
  description: string
  /** Default unit for value columns; a column may override it. */
  unit?: Unit
  queries: Id[]
  options?: {
    reduce?: Reducer
    columns?: TableColumn[]
    sortBy?: Id
    sortDir?: 'asc' | 'desc'
    limit?: number
  }
  thresholds?: Threshold[]
}
export interface HeatmapPanel {
  kind: 'heatmap'
  title: string
  description: string
  unit: Unit
  queries: Id[]
  options?: {
    yScale?: 'linear' | 'log'
    colorScale?: 'linear' | 'sqrt' | 'log'
    exemplars?: boolean
  }
}
export interface TextPanel {
  kind: 'text'
  title: string
  description?: string
  /** Markdown. No HTML, no scripts. */
  content: string
}
export type Panel = TimeseriesPanel | StatPanel | TablePanel | HeatmapPanel | TextPanel
export type DataPanel = TimeseriesPanel | StatPanel | TablePanel | HeatmapPanel

/** Row item: a panel id, a panel with a span, a fragment instance, or a nested layout. */
export type RowItem =
  | Id
  | { panel: Id; span?: number }
  | FragmentUse
  | Layout

export interface FragmentUse {
  /** Fragment to instantiate (key of `fragments`). */
  fragment: Id
  /** Instance name; unique in the dashboard. Expanded ids are `<as>.<id>`. */
  as: Id
  /** Arguments: a literal string, or exactly one variable reference such as `$env`. */
  with?: Record<Id, string>
  span?: number
}
export interface Row {
  title?: string
  /** Row height in pixels. */
  height?: number
  items: RowItem[]
}
export interface RowsLayout {
  kind: 'rows'
  rows: Row[]
}
export interface GridItem {
  panel: Id
  x: number
  y: number
  w: number
  h: number
}
export interface GridLayout {
  kind: 'grid'
  /** Number of columns; default 24. */
  columns?: number
  items: GridItem[]
}
export type Layout = RowsLayout | GridLayout

export interface FragmentParam {
  description?: string
  /** If absent the parameter is required. */
  default?: string
}
export interface Fragment {
  description: string
  params?: Record<Id, FragmentParam>
  queries?: Record<Id, Query>
  panels: Record<Id, Panel>
  layout: Layout
}

export interface Dashboard {
  apiVersion: typeof API_VERSION
  metadata: Metadata
  time?: TimeRange
  variables?: Record<Id, Variable>
  queries?: Record<Id, Query>
  panels: Record<Id, Panel>
  layout: Layout
  fragments?: Record<Id, Fragment>
}

/** An error an agent can act on. */
export interface Issue {
  /** RFC 6901 JSON Pointer into the spec. `""` is the root. */
  path: string
  /** Stable machine-readable code, e.g. `unknown-key`, `dangling-query-ref`. */
  code: string
  /** Plain-language statement of what is wrong. */
  message: string
  /** What to do about it; present whenever one can be computed. */
  suggestion?: string
}
export type ValidationError = Issue
export type LintWarning = Issue

export interface ValidationResult {
  ok: boolean
  errors: ValidationError[]
}

// Prometheus HTTP API result shapes. Structurally identical to
// contracts/engine.ts; redeclared here so this package has no cross-directory
// import (see README, "Contract issues").
export interface PromMatrix {
  resultType: 'matrix'
  result: { metric: Record<string, string>; values: [number, string][] }[]
}
export interface PromVector {
  resultType: 'vector'
  result: { metric: Record<string, string>; value: [number, string] }[]
}
