/**
 * The control plane's dashboard read routes, for the mock (control/README.md, "Dashboards"):
 *
 *   GET /api/v1/control/dashboards            q, tag, owner, deleted, limit, cursor
 *   GET /api/v1/control/dashboards/{id}       view=spec|outline|resolved (var.<name>=…), revision
 *
 * THIS IS A MOCK. The dashboards below are `viz.dashboard/v1` specs over the mock's synthetic
 * series (mock/data.ts); `real/seed.ts` creates the same specs in the real control plane, so
 * e2e/contract.cjs can send the same requests to both and compare the answers. The answers'
 * shapes, statuses, problem codes and wording are control's (control/src/ops-dashboards.ts,
 * src/tenant.ts, src/errors.ts). Validation, resolution and the revision hash are the model's
 * own (../dashboard/src): nothing of them is written again here.
 *
 * Not served: every write (POST, PATCH, DELETE, PUT answer 405 here; the real API takes them),
 * revisions, proposals. A dashboard here has one revision.
 */
import { resolve, revisionOf, type Dashboard } from '../../dashboard/src/index.ts'
import type { MockResponse } from './handler'

export const DASHBOARDS_PATH = '/api/v1/control/dashboards'
/** The scopes that may read dashboards (control/src/routes.ts, `D_READ`). */
export const DASHBOARD_READ_SCOPES = ['admin', 'dashboards:read', 'dashboards:write', 'dashboards:apply'] as const

const RATE = '[$__rate]'
const p95 = (by: string, matchers = '') => `histogram_quantile(0.95, sum by (le${by ? `, ${by}` : ''}) (rate(http_request_duration_seconds_bucket${matchers}${RATE})))`

/** Twelve panels over every series of the mock: the dashboard the speed measurements load. */
const servicesOverview: Dashboard = {
  apiVersion: 'viz.dashboard/v1',
  metadata: {
    id: 'services_overview',
    title: 'Services overview',
    intent: 'On-call view of the four API services. Answers: is anything unhealthy, and is it traffic, errors, latency or a pod?',
    tags: ['on-call', 'services'],
  },
  time: { from: 'now-3h', to: 'now' },
  queries: {
    req_total: { lang: 'promql', expr: `sum(rate(http_requests_total${RATE}))` },
    err_ratio: { lang: 'promql', expr: `sum(rate(http_requests_total{status="500"}${RATE})) / sum(rate(http_requests_total${RATE}))` },
    p95_all: { lang: 'promql', expr: p95('') },
    pods_up: { lang: 'promql', expr: 'sum(up)' },
    req_by_service: { lang: 'promql', expr: `sum by (service) (rate(http_requests_total${RATE}))`, legend: '{{service}}' },
    err_by_service: { lang: 'promql', expr: `sum by (service) (rate(http_requests_total{status="500"}${RATE}))`, legend: '{{service}}' },
    p95_by_service: { lang: 'promql', expr: p95('service'), legend: '{{service}}' },
    req_by_route: { lang: 'promql', expr: `sum by (service, route, status) (rate(http_requests_total${RATE}))`, legend: '{{service}} {{route}} {{status}}' },
    cpu_by_pod: { lang: 'promql', expr: 'pod_cpu_usage_cores', legend: '{{pod}}' },
    mem_by_pod: { lang: 'promql', expr: 'pod_memory_working_set_bytes', legend: '{{pod}}' },
    route_rate: { lang: 'promql', expr: `sum by (service, route) (rate(http_requests_total${RATE}))` },
    route_errors: { lang: 'promql', expr: `sum by (service, route) (rate(http_requests_total{status="500"}${RATE}))` },
    cpu_by_service: { lang: 'promql', expr: 'sum by (service) (pod_cpu_usage_cores)' },
    mem_by_service: { lang: 'promql', expr: 'sum by (service) (pod_memory_working_set_bytes)' },
  },
  panels: {
    requests: { kind: 'stat', title: 'Requests', description: 'All requests to the four services. A drop matters more than a peak.', unit: 'req/s', queries: ['req_total'], thresholds: [{ below: 100, level: 'warn' }] },
    error_ratio: {
      kind: 'stat',
      title: 'Error ratio',
      description: 'Share of requests answered with 500. Above 2% is worth a look; above 5% is an incident.',
      unit: 'ratio',
      queries: ['err_ratio'],
      thresholds: [{ above: 0.02, level: 'warn' }, { above: 0.05, level: 'crit' }],
    },
    latency: {
      kind: 'stat',
      title: 'p95 latency',
      description: '95th percentile of request duration over all services.',
      unit: 's',
      queries: ['p95_all'],
      thresholds: [{ above: 1, level: 'warn' }],
    },
    pods: { kind: 'stat', title: 'Pods up', description: 'Pods that answered their last scrape, of 12.', unit: 'count', queries: ['pods_up'], thresholds: [{ below: 12, level: 'warn' }] },
    rate_by_service: { kind: 'timeseries', title: 'Requests by service', description: 'Throughput per service. Compare the shape with the same hour yesterday.', unit: 'req/s', queries: ['req_by_service'] },
    errors_by_service: { kind: 'timeseries', title: 'Errors by service', description: 'Responses with status 500 per service. checkout degrades for 12 minutes every third hour.', unit: 'req/s', queries: ['err_by_service'] },
    latency_by_service: { kind: 'timeseries', title: 'p95 latency by service', description: 'A service whose line leaves the others is the one to open.', unit: 's', queries: ['p95_by_service'] },
    rate_by_route: { kind: 'timeseries', title: 'Requests by route and status', description: 'Every route and status: 36 series, the eight largest drawn separately.', unit: 'req/s', queries: ['req_by_route'] },
    cpu: { kind: 'timeseries', title: 'CPU by pod', description: 'One pod restarts every two hours and is absent for 12 minutes: a real gap, not a zero.', unit: 'cores', queries: ['cpu_by_pod'] },
    memory: { kind: 'timeseries', title: 'Memory by pod', description: 'Working set per pod. A line that only rises is a leak.', unit: 'bytes', queries: ['mem_by_pod'] },
    routes: {
      kind: 'table',
      title: 'Routes',
      description: 'Request and error rate per route, busiest first.',
      unit: 'req/s',
      queries: ['route_rate', 'route_errors'],
      options: { columns: [{ query: 'route_rate', title: 'Requests' }, { query: 'route_errors', title: 'Errors' }], sortBy: 'route_rate', sortDir: 'desc', limit: 8 },
    },
    capacity: {
      kind: 'table',
      title: 'Capacity by service',
      description: 'CPU and memory in use per service, summed over its pods.',
      queries: ['cpu_by_service', 'mem_by_service'],
      options: { columns: [{ query: 'cpu_by_service', title: 'CPU', unit: 'cores' }, { query: 'mem_by_service', title: 'Memory', unit: 'bytes' }], sortBy: 'cpu_by_service', sortDir: 'desc' },
    },
  },
  layout: {
    kind: 'rows',
    rows: [
      { title: 'Health', items: [{ panel: 'requests', span: 3 }, { panel: 'error_ratio', span: 3 }, { panel: 'latency', span: 3 }, { panel: 'pods', span: 3 }] },
      { title: 'Traffic', items: ['rate_by_service', 'errors_by_service', 'latency_by_service', 'rate_by_route'] },
      { title: 'Pods', items: ['cpu', 'memory'] },
      { title: 'Detail', items: ['routes', 'capacity'] },
    ],
  },
}

/** Variables: a query variable (the services that have data) and an enum with "all". */
const serviceRed: Dashboard = {
  apiVersion: 'viz.dashboard/v1',
  metadata: {
    id: 'service_red',
    title: 'Service: rate, errors, duration',
    intent: 'One service at a time. Answers: is this service healthy, and which route or status is the cause when it is not?',
    tags: ['on-call', 'red'],
  },
  time: { from: 'now-1h', to: 'now' },
  variables: {
    service: { kind: 'query', label: 'Service', query: { lang: 'promql', expr: 'label_values(http_requests_total, service)' }, default: 'checkout' },
    status: { kind: 'enum', label: 'Status', values: ['200', '400', '500'], includeAll: true, default: '*' },
  },
  queries: {
    rate_by_route: { lang: 'promql', expr: `sum by (route) (rate(http_requests_total{service="$service",status=~"$status"}${RATE}))`, legend: '{{route}}' },
    err_ratio: { lang: 'promql', expr: `sum(rate(http_requests_total{service="$service",status="500"}${RATE})) / sum(rate(http_requests_total{service="$service"}${RATE}))` },
    p50: { lang: 'promql', expr: `histogram_quantile(0.5, sum by (le) (rate(http_request_duration_seconds_bucket{service="$service"}${RATE})))`, legend: 'p50' },
    p95: { lang: 'promql', expr: `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{service="$service"}${RATE})))`, legend: 'p95' },
    by_status: { lang: 'promql', expr: `sum by (status) (rate(http_requests_total{service="$service",status=~"$status"}${RATE}))`, legend: '{{status}}' },
    cpu: { lang: 'promql', expr: 'pod_cpu_usage_cores{service="$service"}', legend: '{{pod}}' },
  },
  panels: {
    error_ratio: {
      kind: 'stat',
      title: 'Error ratio',
      description: 'Share of this service\'s requests answered with 500.',
      unit: 'ratio',
      queries: ['err_ratio'],
      thresholds: [{ above: 0.02, level: 'warn' }, { above: 0.05, level: 'crit' }],
    },
    rate: { kind: 'timeseries', title: 'Requests by route', description: 'Throughput per route, for the chosen status.', unit: 'req/s', queries: ['rate_by_route'] },
    duration: { kind: 'timeseries', title: 'Request duration', description: 'Median and 95th percentile. The two moving apart means a slow tail.', unit: 's', queries: ['p50', 'p95'] },
    statuses: { kind: 'timeseries', title: 'Requests by status', description: 'What the service answered.', unit: 'req/s', queries: ['by_status'] },
    cpu: { kind: 'timeseries', title: 'CPU by pod', description: 'The service\'s pods. A gap is a restart.', unit: 'cores', queries: ['cpu'] },
  },
  layout: {
    kind: 'rows',
    rows: [
      { items: [{ panel: 'error_ratio', span: 3 }] },
      { items: ['rate', 'duration'] },
      { items: ['statuses', 'cpu'] },
    ],
  },
}

/** A grid layout with a kind the app does not draw (heatmap), a note (text), a query the API refuses and one that matches nothing. */
const podCapacity: Dashboard = {
  apiVersion: 'viz.dashboard/v1',
  metadata: {
    id: 'pod_capacity',
    title: 'Pod capacity',
    intent: 'Capacity review. Answers: which pods are close to their limits, and how request durations are distributed.',
    tags: ['capacity', 'platform'],
  },
  time: { from: 'now-6h', to: 'now' },
  queries: {
    cpu: { lang: 'promql', expr: 'pod_cpu_usage_cores', legend: '{{pod}}' },
    mem_total: { lang: 'promql', expr: 'sum(pod_memory_working_set_bytes)' },
    buckets: { lang: 'promql', expr: `sum by (le) (rate(http_request_duration_seconds_bucket${RATE}))`, legend: '{{le}}' },
    // Valid PromQL that viz does not run: the API answers 422 `unsupported`.
    sampled: { lang: 'promql', expr: 'limitk(3, pod_cpu_usage_cores)' },
    restarts: { lang: 'promql', expr: 'sum by (pod) (rate(pod_restarts_total[$__rate]))', legend: '{{pod}}' },
  },
  panels: {
    cpu: { kind: 'timeseries', title: 'CPU by pod', description: 'Twelve pods; the eight largest are drawn separately.', unit: 'cores', queries: ['cpu'] },
    memory: { kind: 'stat', title: 'Memory in use', description: 'Working set of every pod, summed.', unit: 'bytes', queries: ['mem_total'], thresholds: [{ above: 8589934592, level: 'warn' }] },
    durations: { kind: 'heatmap', title: 'Request duration distribution', description: 'Requests per duration bucket over time, all services.', unit: 's', queries: ['buckets'] },
    sample: { kind: 'timeseries', title: 'CPU of three sampled pods', description: 'A sample of pods, for a quick look.', unit: 'cores', queries: ['sampled'] },
    restarts: { kind: 'timeseries', title: 'Restarts by pod', description: 'Container restarts per second. Nothing here means no pod reports restarts.', unit: 'ops/s', queries: ['restarts'] },
    notes: { kind: 'text', title: 'How to read this', content: 'CPU is in cores, memory in bytes. A pod above **1.2 cores** for an hour should be given a second replica. The review is on the first Monday of the month.' },
  },
  layout: {
    kind: 'grid',
    columns: 12,
    items: [
      { panel: 'cpu', x: 0, y: 0, w: 6, h: 8 },
      { panel: 'durations', x: 6, y: 0, w: 6, h: 8 },
      { panel: 'memory', x: 0, y: 8, w: 3, h: 4 },
      { panel: 'sample', x: 3, y: 8, w: 6, h: 8 },
      { panel: 'notes', x: 9, y: 8, w: 3, h: 4 },
      { panel: 'restarts', x: 0, y: 16, w: 6, h: 8 },
    ],
  },
}

/** A fragment used twice: the same two panels for two services. */
const checkoutPath: Dashboard = {
  apiVersion: 'viz.dashboard/v1',
  metadata: {
    id: 'checkout_path',
    title: 'Checkout path',
    intent: 'The two services a purchase passes through. Answers: when checkout is slow, is it checkout itself or orders behind it?',
    tags: ['checkout', 'on-call'],
  },
  time: { from: 'now-3h', to: 'now' },
  panels: {},
  layout: {
    kind: 'rows',
    rows: [
      { title: 'checkout', items: [{ fragment: 'service_pair', as: 'checkout', with: { service: 'checkout' } }] },
      { title: 'orders', items: [{ fragment: 'service_pair', as: 'orders', with: { service: 'orders' } }] },
    ],
  },
  fragments: {
    service_pair: {
      description: 'Request rate and p95 latency of one service.',
      params: { service: { description: 'The service label.' } },
      queries: {
        rate: { lang: 'promql', expr: `sum by (route) (rate(http_requests_total{service="$service"}${RATE}))`, legend: '{{route}}' },
        p95: { lang: 'promql', expr: `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{service="$service"}${RATE})))`, legend: 'p95' },
      },
      panels: {
        rate: { kind: 'timeseries', title: 'Requests by route', description: 'Throughput per route of this service.', unit: 'req/s', queries: ['rate'] },
        latency: { kind: 'timeseries', title: 'p95 latency', description: '95th percentile of request duration of this service.', unit: 's', queries: ['p95'] },
      },
      layout: { kind: 'rows', rows: [{ items: ['rate', 'latency'] }] },
    },
  },
}

export interface SeedDashboard {
  spec: Dashboard
  owner: string | null
  message: string
}

/** The dashboards of the mock, and what real/seed.ts creates in the real control plane. */
export const SEED_DASHBOARDS: SeedDashboard[] = [
  { spec: servicesOverview, owner: 'platform', message: 'Created' },
  { spec: serviceRed, owner: 'payments', message: 'Created' },
  { spec: podCapacity, owner: 'platform', message: 'Created' },
  { spec: checkoutPath, owner: null, message: 'Created' },
]

interface Actor {
  subject: string
  kind: 'key' | 'agent'
  name: string | null
}
/** Who changed each dashboard last, in the mock. (In the real stack it is the key that seeded them.) */
const CHANGED: Record<string, { at: string; by: Actor; created: string }> = {
  services_overview: { at: '2026-11-24T16:12:08.000Z', by: { subject: 'key:mockDana00000001', kind: 'key', name: 'Dana' }, created: '2026-09-02T09:30:00.000Z' },
  service_red: { at: '2026-11-18T13:20:41.000Z', by: { subject: 'key:mockAgent0000001', kind: 'agent', name: 'incident-agent' }, created: '2026-10-11T11:05:00.000Z' },
  pod_capacity: { at: '2026-11-02T08:01:00.000Z', by: { subject: 'key:mockLee000000001', kind: 'key', name: 'Lee' }, created: '2026-11-02T08:01:00.000Z' },
  checkout_path: { at: '2026-10-29T17:45:30.000Z', by: { subject: 'key:mockDana00000001', kind: 'key', name: 'Dana' }, created: '2026-10-29T17:45:30.000Z' },
}

function view(d: SeedDashboard): Record<string, unknown> {
  const c = CHANGED[d.spec.metadata.id]!
  return {
    id: d.spec.metadata.id,
    name: d.spec.metadata.title,
    intent: d.spec.metadata.intent,
    tags: d.spec.metadata.tags ?? [],
    owner: d.owner,
    panels: Object.keys(resolve(d.spec).panels).length,
    revision: revisionOf(d.spec),
    number: 1,
    createdAt: c.created,
    createdBy: c.by,
    lastChangedAt: c.at,
    lastChangedBy: c.by,
    state: null,
  }
}

/** control's short projection of a spec (`?view=outline`). */
function outline(spec: Dashboard): Record<string, unknown> {
  const r = resolve(spec)
  return {
    metadata: spec.metadata,
    time: spec.time ?? null,
    variables: Object.entries(spec.variables ?? {}).map(([id, v]) => ({ id, kind: v.kind, label: v.label ?? null })),
    panels: r.order.map((id) => {
      const p = r.panels[id]!
      return { id, kind: p.kind, title: p.title, unit: 'unit' in p ? (p.unit ?? null) : null, queries: 'queries' in p ? p.queries : [] }
    }),
    fragments: Object.keys(spec.fragments ?? {}),
  }
}

export const problem = (status: number, code: string, title: string, detail: string, fix: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): MockResponse => ({
  status,
  body: { type: `https://vis.bitcru.sh/problems/${code}`, title, status, code, detail, fix, ...extra },
  headers: { 'Content-Type': 'application/problem+json', ...headers },
})

const encodeCursor = (id: string) => Buffer.from(JSON.stringify([id])).toString('base64url')
function decodeCursor(raw: string | null): string | null | undefined {
  if (raw === null) return null
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    return Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined
  } catch {
    return undefined
  }
}

/**
 * Answers a request under `DASHBOARDS_PATH`. `scopes` are the scopes of the key that asked (the
 * caller has already answered 401 for a key that is missing or unknown).
 */
export function dashboardsApi(method: string, url: URL, scopes: readonly string[], dashboards: readonly SeedDashboard[] = SEED_DASHBOARDS): MockResponse {
  const rest = url.pathname.slice(DASHBOARDS_PATH.length)
  const one = /^\/([^/]+)$/.exec(rest)
  if (rest !== '' && !one) return problem(404, 'not-found', 'Not found', 'No such resource.', 'See /api/v1/control/openapi.json for the routes.')
  if (method !== 'GET') return problem(405, 'method-not-allowed', 'Method not allowed', `${method} is not supported here.`, 'Use one of: GET.', { Allow: 'GET' })
  if (url.searchParams.has('tenant'))
    return problem(400, 'tenant-not-accepted', 'Bad request', 'A tenant was named in the query string. This API never takes a tenant from a request.', 'Remove it. The tenant is always the one your credential belongs to (see GET /api/v1/control/whoami).')
  if (!DASHBOARD_READ_SCOPES.some((s) => scopes.includes(s))) {
    const need = DASHBOARD_READ_SCOPES.join(', ')
    return problem(403, 'missing-scope', 'Not allowed', `This needs one of the scopes: ${need}.`, `Use a key that has one of: ${need}. This key has: ${scopes.join(', ') || 'none'}.`, {}, { required: [...DASHBOARD_READ_SCOPES] })
  }
  const q = url.searchParams
  const sorted = [...dashboards].sort((a, b) => (a.spec.metadata.id < b.spec.metadata.id ? -1 : 1))

  if (!one) {
    let limit = 50
    if (q.get('limit') !== null) {
      limit = Number(q.get('limit'))
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) return problem(400, 'bad-limit', 'Bad request', '"limit" must be an integer from 1 to 200.', 'Use a limit from 1 to 200, and follow "next" for more.')
    }
    const after = decodeCursor(q.get('cursor'))
    if (after === undefined) return problem(400, 'bad-cursor', 'Bad request', 'The cursor is not one this API issued.', 'Use the "next" value of the previous page unchanged, or leave it out to start again.')
    let items = q.get('deleted') === 'true' ? [] : sorted.map(view)
    const search = q.get('q')?.trim().toLowerCase().slice(0, 200)
    // As control searches: a substring of the name, the id, the intent, the owner or the tags (as stored: a JSON list).
    if (search) items = items.filter((d) => [d.name, d.id, d.intent, d.owner ?? '', JSON.stringify(d.tags)].some((f) => String(f).toLowerCase().includes(search)))
    const tag = q.get('tag')
    if (tag) items = items.filter((d) => JSON.stringify(d.tags).toLowerCase().includes(JSON.stringify(tag).toLowerCase()))
    const owner = q.get('owner')
    if (owner) items = items.filter((d) => d.owner === owner)
    const total = items.length
    const rest = items.filter((d) => String(d.id) > (after ?? ''))
    const page = rest.slice(0, limit)
    return { status: 200, body: { items: page, total, next: rest.length > limit ? encodeCursor(String(page[page.length - 1]!.id)) : null } }
  }

  let id: string
  try {
    id = decodeURIComponent(one[1]!)
  } catch {
    return problem(404, 'not-found', 'Not found', 'No such resource.', 'See /api/v1/control/openapi.json for the routes.')
  }
  const notFound = (what: string) => problem(404, 'not-found', 'Not found', `No such ${what}.`, `List the ${what}s you can see and use an id from that list. Ids from another tenant never resolve.`)
  const found = sorted.find((d) => d.spec.metadata.id === id)
  if (!found) return notFound('dashboard')
  const kind = q.get('view') ?? 'spec'
  if (kind !== 'spec' && kind !== 'outline' && kind !== 'resolved')
    return problem(400, 'bad-view', 'Bad request', '"view" must be spec, outline or resolved.', 'Use ?view=spec (the default), ?view=outline, or ?view=resolved with var.<name>=<value> for each variable.')
  if (q.get('revision') !== null && q.get('revision') !== '1') return notFound('revision')
  const revision = revisionOf(found.spec)
  const body: Record<string, unknown> = { dashboard: view(found), number: 1, revision, current: true, view: kind }
  if (kind === 'spec') body.spec = found.spec
  else if (kind === 'outline') body.outline = outline(found.spec)
  else {
    const variables: Record<string, string | string[]> = {}
    for (const k of new Set(q.keys())) if (k.startsWith('var.') && k.length > 4) variables[k.slice(4)] = q.getAll(k).length === 1 ? q.get(k)! : q.getAll(k)
    body.resolved = resolve(found.spec, { variables })
  }
  return { status: 200, body, headers: { ETag: `"${revision}"` } }
}
