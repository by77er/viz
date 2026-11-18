/**
 * getSchema(kind?): a slice of the JSON Schema plus one example. Backs the
 * `get_schema` agent tool: an agent asks for the piece it is about to write
 * instead of loading the whole schema.
 */
import { isObject } from './json.ts'
import { BUILTIN_VARIABLES } from './expr.ts'
import { dashboardSchema, PANEL_CATALOG, type JsonSchema } from './schema.ts'
import { PANEL_KINDS, UNITS, type Dashboard, type PanelKind } from './types.ts'

export const SCHEMA_KINDS = ['dashboard', ...PANEL_KINDS, 'panel', 'query', 'variable', 'layout', 'fragment', 'threshold'] as const
export type SchemaKind = (typeof SCHEMA_KINDS)[number]

export interface SchemaSlice {
  kind: SchemaKind
  /** JSON Pointer of the slice inside the full schema. */
  pointer: string
  /** A self-contained JSON Schema: the slice plus the `$defs` it references. */
  schema: JsonSchema
  /** One valid example of the slice. */
  example: unknown
  /** What can be asked for. */
  kinds: readonly SchemaKind[]
  /** Panel catalog: kind → one-line description. */
  catalog: Record<PanelKind, string>
  /** Built-in variables usable in any expression. */
  builtins: Record<string, string>
  units: readonly string[]
}

/** A minimal valid dashboard; also the example returned by `getSchema()`. */
export const EXAMPLE_DASHBOARD: Dashboard = {
  apiVersion: 'viz.dashboard/v1',
  metadata: {
    id: 'checkout_overview',
    title: 'Checkout — service overview',
    intent: 'On-call view for checkout. Answers: is checkout healthy, and if not, is it traffic, errors or latency?',
    tags: ['checkout', 'tier-1'],
  },
  time: { from: 'now-6h', to: 'now', refresh: '30s' },
  variables: {
    env: { kind: 'enum', values: ['prod', 'staging'], default: 'prod' },
    route: { kind: 'query', query: { lang: 'promql', expr: 'label_values(http_server_requests_total{service="checkout",env="$env"}, route)' }, multi: true, includeAll: true, default: '*' },
  },
  queries: {
    req_rate: { lang: 'promql', expr: 'sum by (route) (rate(http_server_requests_total{service="checkout",env="$env",route=~"$route"}[$__rate]))', legend: '{{route}}' },
    err_ratio: {
      lang: 'promql',
      expr: 'sum(rate(http_server_requests_total{service="checkout",env="$env",status=~"5.."}[$__rate])) / sum(rate(http_server_requests_total{service="checkout",env="$env"}[$__rate]))',
    },
  },
  panels: {
    p_err: {
      kind: 'stat',
      title: 'Error ratio',
      description: 'Share of 5xx responses. SLO is 0.1%; above 1% is an incident.',
      unit: 'ratio',
      queries: ['err_ratio'],
      options: { sparkline: true },
      thresholds: [
        { above: 0.001, level: 'warn' },
        { above: 0.01, level: 'crit' },
      ],
    },
    p_rate: {
      kind: 'timeseries',
      title: 'Requests by route',
      description: 'Request throughput per route. Sudden drops matter more than peaks.',
      unit: 'req/s',
      queries: ['req_rate'],
      options: { stack: true },
    },
  },
  layout: { kind: 'rows', rows: [{ title: 'Health', items: [{ panel: 'p_err', span: 3 }, 'p_rate'] }] },
}

const DEF: Record<Exclude<SchemaKind, 'dashboard'>, string> = {
  timeseries: 'TimeseriesPanel',
  stat: 'StatPanel',
  table: 'TablePanel',
  heatmap: 'HeatmapPanel',
  text: 'TextPanel',
  panel: 'Panel',
  query: 'Query',
  variable: 'Variable',
  layout: 'Layout',
  fragment: 'Fragment',
  threshold: 'Threshold',
}

const EXAMPLES: Record<Exclude<SchemaKind, 'dashboard'>, unknown> = {
  timeseries: EXAMPLE_DASHBOARD.panels.p_rate,
  stat: EXAMPLE_DASHBOARD.panels.p_err,
  panel: EXAMPLE_DASHBOARD.panels.p_err,
  table: {
    kind: 'table',
    title: 'Slowest routes',
    description: 'p99 latency and request rate per route, slowest first. Routes above 1s need a look.',
    queries: ['route_p99', 'route_rate'],
    options: { columns: [{ query: 'route_p99', title: 'p99', unit: 's' }, { query: 'route_rate', title: 'Rate', unit: 'req/s' }], sortBy: 'route_p99', sortDir: 'desc', limit: 20 },
    thresholds: [{ above: 1, level: 'warn' }],
  },
  heatmap: {
    kind: 'heatmap',
    title: 'Latency distribution',
    description: 'Request duration histogram. A second band above 1s usually means a slow dependency.',
    unit: 's',
    queries: ['latency_buckets'],
    options: { yScale: 'log' },
  },
  text: { kind: 'text', title: 'How to read this', content: 'Start top-left. If **Error ratio** is red, check the deploy annotations first.' },
  query: EXAMPLE_DASHBOARD.queries!.req_rate,
  variable: EXAMPLE_DASHBOARD.variables!.route,
  layout: EXAMPLE_DASHBOARD.layout,
  threshold: { above: 0.01, level: 'crit', label: 'incident' },
  fragment: {
    description: 'RED summary for one downstream dependency. Reuse once per dependency.',
    params: { service: { description: 'Dependency service name' }, env: { default: 'prod' } },
    queries: {
      rate: { lang: 'promql', expr: 'sum(rate(client_requests_total{peer="$service",env="$env"}[$__rate]))' },
    },
    panels: {
      rate: { kind: 'timeseries', title: 'Calls', description: 'Outbound call rate to the dependency. A drop to zero means we stopped calling it.', unit: 'req/s', queries: ['rate'] },
    },
    layout: { kind: 'rows', rows: [{ items: ['rate'] }] },
  },
}

function collectRefs(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, into))
  else if (isObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') {
        const name = v.replace('#/$defs/', '')
        if (!into.has(name)) {
          into.add(name)
          collectRefs((dashboardSchema.$defs as Record<string, unknown>)[name], into)
        }
      } else collectRefs(v, into)
    }
  }
}

/**
 * Schema slice for `kind` with one example. Without a kind (or with
 * `dashboard`) returns the whole schema and a small complete dashboard.
 * Throws a `RangeError` naming the valid kinds if `kind` is unknown.
 */
export function getSchema(kind: SchemaKind = 'dashboard'): SchemaSlice {
  const common = { kinds: SCHEMA_KINDS, catalog: PANEL_CATALOG, builtins: { ...BUILTIN_VARIABLES }, units: UNITS }
  if (kind === 'dashboard') return { kind, pointer: '', schema: dashboardSchema, example: EXAMPLE_DASHBOARD, ...common }
  if (!Object.prototype.hasOwnProperty.call(DEF, kind)) throw new RangeError(`Unknown schema kind "${String(kind)}". Valid: ${SCHEMA_KINDS.join(', ')}.`)
  const name = DEF[kind]
  const defs = dashboardSchema.$defs as Record<string, JsonSchema>
  const needed = new Set<string>()
  collectRefs(defs[name], needed)
  needed.delete(name)
  const schema: Record<string, unknown> = {
    $schema: dashboardSchema.$schema,
    $id: dashboardSchema.$id.replace(/\.json$/, `/${name}.json`),
    title: `viz.dashboard/v1 ${name}`,
    ...defs[name],
  }
  if (needed.size) schema.$defs = Object.fromEntries([...needed].sort().map((n) => [n, defs[n]]))
  return { kind, pointer: `/$defs/${name}`, schema, example: EXAMPLES[kind], ...common }
}
