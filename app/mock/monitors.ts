/**
 * The ruler's monitors API (ruler/src/http.ts, ruler/openapi.json), as the mock answers it.
 * THIS IS A MOCK: seven monitors over the mock's synthetic series whose alert states are fixed
 * when the mock starts (nothing is evaluated), with acknowledge, unacknowledge, silence and
 * undo kept in memory as the ruler's notifier keeps them.
 *
 * What it follows, route by route, from the ruler's source and tests: the route table (404 "no
 * such route", 405 on a known path), then the key (401 with `WWW-Authenticate`, 403 "API key
 * lacks the <scope> scope"), then the handler; viz's error body `{error: {code, message}}` with
 * `problems` for 422; the monitor view's fields (`monitorView`), the merged history oldest
 * first (`mergeTimelines`), the list's `counts`, `total`, `lastEvaluationMs`, `watchdog` and
 * `nowMs`; acknowledge: all firing alerts or one by fingerprint (404 otherwise), the first
 * acknowledgement stands, `by` is `key:<key id>`; silence: one silence per firing alert matching
 * its labels exactly, `duration` 1 s to 30 d (422 with a path and a fix), an undo token for 60 s
 * returned once; undo: 404 for a token it does not know, 410 `undo_expired` after the window;
 * `dryRun` on every write. `mock/monitors.test.ts` validates every answer against
 * ruler/openapi.json. The real ruler was not compared (README, "Monitors").
 *
 * Test hooks under `/__mock/monitors` (never part of the API): `advance=<ms>` moves the mock's
 * clock (to close an undo window), `fail=<route>&status=<n>[&count=<n>]` fails the next answers
 * of one route, `delay=<ms>[&route=<route>][&count=<n>]` delays them, `empty=1` makes the tenant have no
 * monitors, `reset=1` starts again.
 */
import { queryInstant } from './promql'
import type { Storage } from './storage'

export const MONITORS_PATH = '/api/v1/monitors'
export const MONITORS_MOCK_PATH = '/__mock/monitors'
const UNDO_WINDOW_MS = 60_000
const MAX_SILENCE_MS = 30 * 86_400_000

export type Scope = 'monitors:read' | 'monitors:write' | 'monitors:ack'

export interface MonitorsReply {
  status: number
  body: unknown
  headers?: Record<string, string>
  /** How long the mock server waits before answering (a test hook). */
  delayMs?: number
}

type Labels = Record<string, string>
interface Ack {
  by: string
  at: number
}
interface Alert {
  fingerprint: string
  labels: Labels
  state: 'pending' | 'firing'
  activeAt: number
  firedAt: number | null
  value: number | null
  noData: boolean
  ack: Ack | null
}
interface Entry {
  at: number
  source: 'ruler' | 'notifier'
  kind: string
  [k: string]: unknown
}
interface Fixture {
  id: string
  name: string
  group: string
  intervalMs: number
  query: string
  condition: { op: string; threshold: number; unit?: string } | null
  forMs: number
  keepFiringForMs: number
  description: string
  message: string
  runbookUrl: string
  owner: string
  notify: string | null
  channel: string | null
  noData: 'ok' | 'alerting' | 'keep'
  noDataForMs: number
  labels: Labels
  health: 'ok' | 'err' | 'unknown'
  lastError: string | null
  alerts: Alert[]
  history: Entry[]
  createdAt: number
  createdBy: string
}
interface Silence {
  id: string
  matchers: { name: string; value: string; isRegex: false; isEqual: true }[]
  startsAt: number
  endsAt: number
  createdBy: string
  comment: string
  updatedAt: number
  undo: { token: string; until: number }
  monitor: string
}

/** 16 hex digits from a string: two 32-bit FNV-1a hashes. */
export function hex16(s: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < s.length; i++) {
    a = Math.imul(a ^ s.charCodeAt(i), 0x01000193)
    b = Math.imul(b ^ s.charCodeAt(i), 0x5bd1e995)
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}
const fingerprintOf = (labels: Labels) => hex16(JSON.stringify(Object.keys(labels).sort().map((k) => [k, labels[k]])))

const DURATION_RE = /^(?:(\d+)y)?(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/
/** A Prometheus duration in milliseconds, as the ruler reads it (ruler/src/util.ts). */
export function parseDuration(text: string): number | null {
  if (text === '0') return 0
  if (text === '') return null
  const m = DURATION_RE.exec(text)
  if (!m) return null
  const n = (i: number) => (m[i] ? Number(m[i]) : 0)
  const ms = n(1) * 365 * 86_400_000 + n(2) * 7 * 86_400_000 + n(3) * 86_400_000 + n(4) * 3_600_000 + n(5) * 60_000 + n(6) * 1000 + n(7)
  return Number.isSafeInteger(ms) ? ms : null
}
/** Milliseconds as the ruler writes a duration in a threshold text ("5m", "1h30m"). */
function formatDuration(ms: number): string {
  if (ms === 0) return '0s'
  const parts: [number, string][] = [[86_400_000, 'd'], [3_600_000, 'h'], [60_000, 'm'], [1000, 's'], [1, 'ms']]
  let out = ''
  let left = ms
  for (const [size, unit] of parts) {
    if (left >= size) {
      out += `${Math.floor(left / size)}${unit}`
      left %= size
    }
  }
  return out
}

const json = (status: number, body: unknown, headers?: Record<string, string>): MonitorsReply => ({ status, body, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } })
const apiError = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>): MonitorsReply => json(status, { error: { code, message }, ...extra }, headers)
const invalid = (problems: { path: string; message: string; fix: string }[]) => apiError(422, 'invalid', `${problems.length} problem${problems.length === 1 ? '' : 's'} found; nothing was saved`, { problems })

/** The routes the ruler has under /api/v1/monitors, with their scopes; `mock` says whether the mock answers it. */
const ROUTES: { method: string; path: string; scope: Scope; name: string; mock: boolean }[] = [
  { method: 'GET', path: '/api/v1/monitors', scope: 'monitors:read', name: 'list', mock: true },
  { method: 'POST', path: '/api/v1/monitors', scope: 'monitors:write', name: 'create', mock: false },
  { method: 'GET', path: '/api/v1/monitors/groups', scope: 'monitors:read', name: 'groups', mock: false },
  { method: 'PUT', path: '/api/v1/monitors/groups/{name}', scope: 'monitors:write', name: 'group-put', mock: false },
  { method: 'DELETE', path: '/api/v1/monitors/groups/{name}', scope: 'monitors:write', name: 'group-delete', mock: false },
  { method: 'GET', path: '/api/v1/monitors/rulefile', scope: 'monitors:read', name: 'rulefile', mock: false },
  { method: 'POST', path: '/api/v1/monitors/rulefile', scope: 'monitors:write', name: 'rulefile-post', mock: false },
  { method: 'POST', path: '/api/v1/monitors/backtest', scope: 'monitors:read', name: 'backtest', mock: false },
  { method: 'GET', path: '/api/v1/monitors/detectors', scope: 'monitors:read', name: 'detectors', mock: false },
  { method: 'GET', path: '/api/v1/monitors/notifier', scope: 'monitors:read', name: 'notifier', mock: false },
  { method: 'PUT', path: '/api/v1/monitors/notifier', scope: 'monitors:write', name: 'notifier-put', mock: false },
  { method: 'GET', path: '/api/v1/monitors/silences', scope: 'monitors:read', name: 'silences', mock: true },
  { method: 'POST', path: '/api/v1/monitors/silences/undo', scope: 'monitors:ack', name: 'undo', mock: true },
  { method: 'DELETE', path: '/api/v1/monitors/silences/{silenceId}', scope: 'monitors:ack', name: 'expire', mock: true },
  { method: 'GET', path: '/api/v1/monitors/{id}', scope: 'monitors:read', name: 'get', mock: true },
  { method: 'PUT', path: '/api/v1/monitors/{id}', scope: 'monitors:write', name: 'update', mock: false },
  { method: 'DELETE', path: '/api/v1/monitors/{id}', scope: 'monitors:write', name: 'delete', mock: false },
  { method: 'POST', path: '/api/v1/monitors/{id}/acknowledge', scope: 'monitors:ack', name: 'acknowledge', mock: true },
  { method: 'POST', path: '/api/v1/monitors/{id}/unacknowledge', scope: 'monitors:ack', name: 'unacknowledge', mock: true },
  { method: 'POST', path: '/api/v1/monitors/{id}/silence', scope: 'monitors:ack', name: 'silence', mock: true },
  { method: 'POST', path: '/api/v1/monitors/{id}/backtest', scope: 'monitors:read', name: 'backtest-monitor', mock: false },
]

function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/')
  const s = path.split('/')
  if (p.length !== s.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    const w = p[i]!
    if (w.startsWith('{')) {
      if (s[i] === '') return null
      params[w.slice(1, -1)] = decodeURIComponent(s[i]!)
    } else if (w !== s[i]) return null
  }
  return params
}

const MIN = 60_000
/** The checkout incident windows of mock/data.ts: 12 minutes from minute 40 of every third hour (epoch minutes). */
function lastIncidentStart(nowMs: number): number {
  const minute = Math.floor(nowMs / MIN)
  const start = Math.floor((minute - 40) / 180) * 180 + 40
  return start * MIN
}

const Q_ERRORS = 'sum(rate(http_requests_total{service="checkout",status="500"}[5m])) / sum(rate(http_requests_total{service="checkout"}[5m]))'
const Q_P95 = 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{service="checkout"}[5m])))'
const Q_SEARCH = 'histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{service="catalog"}[5m])))'
const Q_INGEST = 'sum(rate(viz_ingest_batches_total[5m]))'
const Q_MEMORY = 'max(pod_memory_working_set_bytes{service="checkout"})'
const Q_ORDERS = 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{service="orders"}[5m])))'
const Q_PAYMENTS = 'sum(rate_over_time(payments_errors_total[5m]))'

export interface MonitorsOptions {
  storage: Storage
  /** Epoch milliseconds. */
  now: () => number
}

export function createMonitors(opts: MonitorsOptions) {
  let offset = 0
  const now = () => Math.round(opts.now()) + offset
  let fixtures: Fixture[] = []
  let silences = new Map<string, Silence>()
  let empty = false
  let counter = 0
  const failures = new Map<string, { status: number; left: number }>()
  const delays = new Map<string, { ms: number; left: number }>()

  const valueAt = (query: string, ms: number): number | null => {
    try {
      const r = queryInstant(opts.storage, query, ms / 1000)
      if (r.resultType === 'vector') {
        const v = (r.result as { value: [number, string] }[])[0]?.value[1]
        return v === undefined ? null : Number(v)
      }
    } catch {
      // A query the mock's PromQL cannot run has no value.
    }
    return null
  }

  function build(): void {
    const T = now()
    const created = (at: number, by: string): Entry => ({ at, source: 'ruler', kind: 'created', by })
    const edited = (at: number, by: string): Entry => ({ at, source: 'ruler', kind: 'edited', by })
    const alert = (labels: Labels, state: 'pending' | 'firing', activeAt: number, firedAt: number | null, value: number | null, noData = false): Alert => ({ fingerprint: fingerprintOf(labels), labels, state, activeAt, firedAt, value, noData, ack: null })
    const cycle = (a: Alert, receiver: string, channel: string, resolvedAt: number | null): Entry[] => {
      const out: Entry[] = [{ at: a.activeAt, source: 'ruler', kind: 'pending', fingerprint: a.fingerprint, labels: a.labels, value: a.value, noData: a.noData }]
      if (a.firedAt !== null) {
        out.push({ at: a.firedAt, source: 'ruler', kind: 'firing', fingerprint: a.fingerprint, labels: a.labels, value: a.value, noData: a.noData })
        out.push({ at: a.firedAt + 1_400, source: 'notifier', kind: 'notified', receiver, integration: 'slack', channel, status: 'firing', repeat: false, idempotencyKey: hex16(`${a.fingerprint}${a.firedAt}`), deliveredAt: a.firedAt + 1_900, failed: null, fingerprints: [a.fingerprint] })
      }
      if (resolvedAt !== null) {
        out.push({ at: resolvedAt, source: 'ruler', kind: 'resolved', fingerprint: a.fingerprint, labels: a.labels, value: null })
        out.push({ at: resolvedAt + 1_200, source: 'notifier', kind: 'notified', receiver, integration: 'slack', channel, status: 'resolved', repeat: false, idempotencyKey: hex16(`${a.fingerprint}${resolvedAt}`), deliveredAt: resolvedAt + 1_700, failed: null, fingerprints: [a.fingerprint] })
      }
      return out
    }
    const base = {
      group: 'monitors/1m',
      intervalMs: 60_000,
      keepFiringForMs: 0,
      noData: 'ok' as const,
      noDataForMs: 0,
      health: 'ok' as const,
      lastError: null,
      createdAt: T - 30 * 86_400_000,
      createdBy: 'key:dana',
    }

    // 1. Firing: the checkout 5xx ratio, which the mock's data drives above 2 % in every checkout incident.
    // The latest window whose alert has fired by now (one that began less than 8 min ago has not yet).
    const inc = lastIncidentStart(T) + 8 * MIN > T ? lastIncidentStart(T) - 180 * MIN : lastIncidentStart(T)
    const errActive = inc + 2 * MIN
    const errFired = errActive + 5 * MIN
    const errLabels = { alertname: 'Checkout 5xx ratio', service: 'checkout', severity: 'page', viz_receiver: 'checkout-oncall' }
    const errAlert = alert(errLabels, 'firing', errActive, errFired, valueAt(Q_ERRORS, errFired))
    const prevAlert = { ...errAlert, activeAt: errActive - 180 * MIN, firedAt: errFired - 180 * MIN, value: valueAt(Q_ERRORS, errFired - 180 * MIN) }
    // 2. Pending: checkout p95 latency above 250 ms, for 10 min.
    const p95Labels = { alertname: 'Checkout p95 latency', service: 'checkout', severity: 'page', viz_receiver: 'checkout-oncall' }
    const p95Alert = alert(p95Labels, 'pending', T - 4 * MIN, null, valueAt(Q_P95, T - 4 * MIN))
    // 3. No data: ingest batches have stopped arriving (the mock has no such series), no data counts as alerting after 10 min.
    const ingLabels = { alertname: 'Ingest batches stalled', severity: 'page', viz_receiver: 'platform-oncall' }
    const ingAlert = alert(ingLabels, 'firing', T - 41 * MIN, T - 31 * MIN, null, true)
    // 5. Silenced: catalog p99 latency, firing, silenced by Lee for 2 h.
    const seaLabels = { alertname: 'Catalog p99 latency', service: 'catalog', severity: 'ticket', viz_receiver: 'catalog-team' }
    const seaAlert = alert(seaLabels, 'firing', T - 58 * MIN, T - 53 * MIN, valueAt(Q_SEARCH, T - 53 * MIN))
    seaAlert.ack = { by: 'key:lee', at: T - 49 * MIN }

    fixtures = [
      {
        ...base,
        id: 'mon_' + hex16('checkout-errors'),
        name: 'Checkout 5xx ratio',
        query: Q_ERRORS,
        condition: { op: '>', threshold: 0.02 },
        forMs: 5 * MIN,
        description: 'The share of checkout requests answered with a 500, over 5 minutes. Above 2 % customers are failing to pay.',
        message: 'Checkout is failing {{ $value | humanizePercentage }} of requests',
        runbookUrl: 'https://runbooks.example.com/checkout/5xx',
        owner: 'checkout',
        notify: 'checkout-oncall',
        channel: '#checkout-oncall',
        labels: { severity: 'page', viz_receiver: 'checkout-oncall', service: 'checkout' },
        alerts: [errAlert],
        history: [created(base.createdAt, 'key:dana'), edited(T - 3 * 86_400_000, 'key:lee'), ...cycle(prevAlert, 'checkout-oncall', '#checkout-oncall', inc - 180 * MIN + 13 * MIN), ...cycle(errAlert, 'checkout-oncall', '#checkout-oncall', null)],
      },
      {
        ...base,
        id: 'mon_' + hex16('checkout-p95'),
        name: 'Checkout p95 latency',
        query: Q_P95,
        condition: { op: '>', threshold: 0.25, unit: 's' },
        forMs: 10 * MIN,
        description: 'The 95th percentile of checkout request latency over 5 minutes.',
        message: 'Checkout p95 latency is {{ $value | humanizeDuration }}',
        runbookUrl: 'https://runbooks.example.com/checkout/latency',
        owner: 'checkout',
        notify: 'checkout-oncall',
        channel: '#checkout-oncall',
        labels: { severity: 'page', viz_receiver: 'checkout-oncall', service: 'checkout' },
        alerts: [p95Alert],
        history: [created(base.createdAt + 86_400_000, 'key:dana'), ...cycle(p95Alert, 'checkout-oncall', '#checkout-oncall', null)],
      },
      {
        ...base,
        id: 'mon_' + hex16('ingest-stalled'),
        name: 'Ingest batches stalled',
        query: Q_INGEST,
        condition: { op: '<', threshold: 1, unit: '/s' },
        forMs: 5 * MIN,
        noData: 'alerting',
        noDataForMs: 10 * MIN,
        description: 'Batches written per second by the ingest path. None for 10 minutes means samples are not being stored.',
        message: 'No ingest batches for 10 minutes',
        runbookUrl: '',
        owner: 'platform',
        notify: 'platform-oncall',
        channel: '#platform-oncall',
        labels: { severity: 'page', viz_receiver: 'platform-oncall' },
        alerts: [ingAlert],
        history: [created(base.createdAt + 2 * 86_400_000, 'key:sam'), ...cycle(ingAlert, 'platform-oncall', '#platform-oncall', null)],
      },
      {
        ...base,
        id: 'mon_' + hex16('payments-budget'),
        name: 'Payments errors',
        query: Q_PAYMENTS,
        condition: { op: '>', threshold: 0 },
        forMs: 0,
        health: 'err',
        lastError: 'invalid parameter "query": parse error: unknown function with name "rate_over_time"',
        description: 'Errors counted by the payments service.',
        message: 'Payments is counting errors',
        runbookUrl: 'https://runbooks.example.com/payments',
        owner: 'payments',
        notify: 'payments-oncall',
        channel: '#payments',
        labels: { severity: 'page', viz_receiver: 'payments-oncall' },
        alerts: [],
        history: [created(T - 2 * 86_400_000, 'key:incident-agent'), edited(T - 26 * MIN, 'key:dana')],
      },
      {
        ...base,
        id: 'mon_' + hex16('catalog-p99'),
        name: 'Catalog p99 latency',
        query: Q_SEARCH,
        condition: { op: '>', threshold: 0.08, unit: 's' },
        forMs: 5 * MIN,
        description: 'The 99th percentile of catalog latency over 5 minutes.',
        message: 'Catalog p99 latency is {{ $value | humanizeDuration }}',
        runbookUrl: '',
        owner: 'catalog',
        notify: 'catalog-team',
        channel: '#catalog',
        labels: { severity: 'ticket', viz_receiver: 'catalog-team', service: 'catalog' },
        alerts: [seaAlert],
        history: [
          created(base.createdAt, 'key:lee'),
          ...cycle(seaAlert, 'catalog-team', '#catalog', null),
          { at: T - 49 * MIN, source: 'notifier', kind: 'acknowledged', by: 'key:lee', fingerprints: [seaAlert.fingerprint] },
          { at: T - 48 * MIN, source: 'notifier', kind: 'silenced', by: 'key:lee', until: T + 72 * MIN, silenceIds: [hex16('catalog-silence')], fingerprints: [seaAlert.fingerprint] },
        ],
      },
      {
        ...base,
        id: 'mon_' + hex16('checkout-memory'),
        name: 'Checkout pod memory',
        query: Q_MEMORY,
        condition: { op: '>', threshold: 2_000_000_000, unit: 'bytes' },
        forMs: 15 * MIN,
        description: 'The largest working set of a checkout pod. The pods are limited to 2.5 GB.',
        message: 'A checkout pod uses {{ $value | humanize1024 }}B',
        runbookUrl: '',
        owner: 'checkout',
        notify: 'checkout-oncall',
        channel: '#checkout-oncall',
        labels: { severity: 'ticket', viz_receiver: 'checkout-oncall', service: 'checkout' },
        alerts: [],
        history: [created(base.createdAt + 5 * 86_400_000, 'key:dana')],
      },
      {
        ...base,
        id: 'mon_' + hex16('orders-p95'),
        name: 'Orders p95 latency',
        query: Q_ORDERS,
        condition: { op: '>', threshold: 0.6, unit: 's' },
        forMs: 10 * MIN,
        description: 'The 95th percentile of orders latency over 5 minutes.',
        message: 'Orders p95 latency is {{ $value | humanizeDuration }}',
        runbookUrl: 'https://runbooks.example.com/orders/latency',
        owner: 'orders',
        notify: null,
        channel: null,
        labels: { severity: 'ticket' },
        alerts: [],
        history: [created(base.createdAt + 9 * 86_400_000, 'key:sam')],
      },
    ]
    silences = new Map()
    const s: Silence = {
      id: hex16('catalog-silence'),
      matchers: Object.keys(seaLabels).sort().map((name) => ({ name, value: (seaLabels as Labels)[name]!, isRegex: false, isEqual: true })),
      startsAt: T - 48 * MIN,
      endsAt: T + 72 * MIN,
      createdBy: 'key:lee',
      comment: 'Reindex running until 14:00',
      updatedAt: T - 48 * MIN,
      undo: { token: hex16('catalog-undo') + hex16('catalog-undo-2'), until: T - 47 * MIN },
      monitor: fixtures[4]!.id,
    }
    silences.set(s.id, s)
  }
  build()

  const matches = (s: Silence, labels: Labels) => s.matchers.every((m) => labels[m.name] === m.value) && Object.keys(labels).filter((k) => labels[k] !== '').length === s.matchers.length
  const silencedUntil = (a: Alert, t: number): number | null => {
    let until: number | null = null
    for (const s of silences.values()) if (s.startsAt <= t && t < s.endsAt && matches(s, a.labels)) until = Math.max(until ?? 0, s.endsAt)
    return until
  }
  const stateOf = (f: Fixture, alerts: Alert[]): string => {
    if (alerts.some((a) => a.state === 'firing' && !a.noData)) return 'firing'
    if (alerts.some((a) => a.noData)) return 'no_data'
    if (f.health === 'err') return 'error'
    if (alerts.length > 0) return 'pending'
    if (f.health === 'unknown') return 'unknown'
    return 'ok'
  }
  const thresholdText = (f: Fixture) => (f.condition ? `${f.condition.op} ${f.condition.threshold}${f.condition.unit ? ` ${f.condition.unit}` : ''}${f.forMs > 0 ? ` for ${formatDuration(f.forMs)}` : ''}` : null)
  const exprOf = (f: Fixture) => (f.condition ? `${f.query} ${f.condition.op} ${f.condition.threshold}` : f.query)
  /** The last evaluation: the latest whole minute (the group's interval). */
  const evaluatedAt = (t: number) => Math.floor(t / 60_000) * 60_000

  function view(f: Fixture, t: number) {
    const alerts = f.alerts
      .map((a) => {
        const until = silencedUntil(a, t)
        return {
          fingerprint: a.fingerprint,
          labels: a.labels,
          state: a.state,
          activeAt: a.activeAt,
          firingSince: a.state === 'firing' ? a.firedAt : null,
          firesAt: a.state === 'pending' ? a.activeAt + (a.noData ? f.noDataForMs : f.forMs) : null,
          value: a.value,
          noData: a.noData,
          acknowledged: a.ack,
          silencedUntil: until,
          inhibited: false,
          lastNotifiedAt: a.state === 'firing' ? (a.firedAt as number) + 1_400 : null,
          nextRepeatAt: a.state === 'firing' && !a.ack && until === null ? (a.firedAt as number) + 1_400 + 4 * 3_600_000 : null,
          handedOff: a.state === 'firing',
        }
      })
      .sort((a, b) => a.activeAt - b.activeAt || (a.fingerprint < b.fingerprint ? -1 : 1))
    const firing = alerts.filter((a) => a.state === 'firing')
    const acks = firing.map((a) => a.acknowledged)
    const allAcked = firing.length > 0 && acks.every((a) => a !== null)
    const sil = alerts.map((a) => a.silencedUntil)
    const allSilenced = alerts.length > 0 && sil.every((s) => s !== null)
    const min = (xs: number[]) => (xs.length > 0 ? Math.min(...xs) : null)
    const receivers = f.notify ? [{ name: f.notify, integrations: [{ kind: 'slack' as const, channel: f.channel, signed: false }] }] : []
    return {
      id: f.id,
      name: f.name,
      group: f.group,
      shard: '0',
      state: stateOf(f, f.alerts),
      firingSince: min(firing.map((a) => a.firingSince as number)),
      activeAt: min(alerts.map((a) => a.activeAt)),
      value: alerts[0]?.value ?? null,
      thresholdText: thresholdText(f),
      expr: exprOf(f),
      query: f.condition ? f.query : null,
      condition: f.condition ? { op: f.condition.op, threshold: f.condition.threshold, ...(f.condition.unit ? { unit: f.condition.unit } : {}) } : null,
      forMs: f.forMs,
      keepFiringForMs: f.keepFiringForMs,
      intervalMs: f.intervalMs,
      description: f.description,
      message: f.message,
      runbookUrl: f.runbookUrl,
      owner: f.owner,
      notify: f.notify,
      notifies: receivers,
      noData: f.noData,
      noDataForMs: f.noDataForMs,
      startInvestigation: false,
      labels: f.labels,
      annotations: { summary: f.message, description: f.description, ...(f.runbookUrl ? { runbook_url: f.runbookUrl } : {}) },
      cost: { class: 'tail', windowMs: 300_000, reason: 'a 5m window read from the tail of the write path' },
      health: f.health,
      lastError: f.lastError,
      lastEvaluationMs: evaluatedAt(t),
      acknowledged: allAcked ? (acks as Ack[]).reduce((a, b) => (a.at <= b.at ? a : b)) : null,
      silencedUntil: allSilenced ? Math.min(...(sil as number[])) : null,
      alerts,
      historyRecorded: true,
      anomaly: null,
      slo: null,
    }
  }

  const silenceView = (s: Silence, t: number) => ({ id: s.id, matchers: s.matchers, startsAt: s.startsAt, endsAt: s.endsAt, createdBy: s.createdBy, comment: s.comment, updatedAt: s.updatedAt, state: t < s.startsAt ? 'pending' : t < s.endsAt ? 'active' : 'expired' })

  const all = () => (empty ? [] : fixtures)
  const find = (id: string) => all().find((f) => f.id === id) ?? null
  const NEEDS_ATTENTION = new Set(['firing', 'pending', 'no_data', 'error'])
  const dryRunOf = (u: URL, body: unknown) => {
    const q = u.searchParams.get('dryRun')
    if (q !== null) return q === 'true' || q === '1'
    return typeof body === 'object' && body !== null && (body as { dryRun?: unknown }).dryRun === true
  }
  const log = (f: Fixture, e: Entry) => {
    f.history.push(e)
    if (f.history.length > 400) f.history.shift()
  }
  /** The alerts an action is for: every firing alert of the monitor, or the one named (ruler/src/http.ts `targetAlerts`). */
  const targets = (f: Fixture, body: unknown): Alert[] | MonitorsReply => {
    const firing = f.alerts.filter((a) => a.state === 'firing')
    const one = (body as { fingerprint?: unknown } | null)?.fingerprint
    if (one !== undefined) {
      const hit = firing.find((a) => a.fingerprint === one)
      if (typeof one !== 'string' || !hit) return apiError(404, 'not_found', 'the monitor has no firing alert with that fingerprint')
      return [hit]
    }
    return firing
  }

  function routeHandler(name: string, u: URL, params: Record<string, string>, body: unknown, by: string): MonitorsReply {
    const t = now()
    switch (name) {
      case 'list': {
        const filter = u.searchParams.get('filter') ?? 'all'
        if (!['all', 'attention', 'silenced'].includes(filter)) return apiError(400, 'bad_request', 'filter must be all, attention or silenced')
        const views = all().map((f) => view(f, t))
        const monitors = views.filter((m) => (filter === 'attention' ? NEEDS_ATTENTION.has(m.state) : filter === 'silenced' ? m.silencedUntil !== null : true))
        const counts: Record<string, number> = { firing: 0, pending: 0, no_data: 0, error: 0, ok: 0, unknown: 0, warming: 0 }
        for (const m of views) counts[m.state] = (counts[m.state] ?? 0) + 1
        return json(200, { monitors, counts, total: views.length, lastEvaluationMs: views.length ? evaluatedAt(t) : null, watchdog: { lastEvaluationMs: evaluatedAt(t), firing: true }, nowMs: t })
      }
      case 'get': {
        const f = find(params.id!)
        if (!f) return apiError(404, 'not_found', `monitor ${params.id} not found`)
        const entries = [...f.history].sort((a, b) => a.at - b.at || (a.source === b.source ? 0 : a.source === 'ruler' ? -1 : 1))
        return json(200, { monitor: view(f, t), history: { entries, dropped: 0 }, nowMs: t })
      }
      case 'silences':
        return json(200, { silences: [...silences.values()].map((s) => silenceView(s, t)), nowMs: t })
      case 'acknowledge':
      case 'unacknowledge': {
        const on = name === 'acknowledge'
        const f = find(params.id!)
        if (!f) return apiError(404, 'not_found', `monitor ${params.id} not found`)
        const dryRun = dryRunOf(u, body)
        const hit = targets(f, body)
        if (!Array.isArray(hit)) return hit
        // The first acknowledgement stands: a second person acknowledging does not rewrite who took it.
        const changes = hit.filter((a) => Boolean(a.ack) !== on)
        if (!dryRun && changes.length > 0) {
          for (const a of changes) a.ack = on ? { by, at: t } : null
          log(f, { at: t, source: 'notifier', kind: on ? 'acknowledged' : 'unacknowledged', by, fingerprints: changes.map((a) => a.fingerprint) })
        }
        return json(200, { dryRun, id: f.id, [on ? 'acknowledged' : 'unacknowledged']: hit.map((a) => a.fingerprint), notYetHandedOff: [], by, at: t })
      }
      case 'silence': {
        const b = (body ?? {}) as { duration?: unknown; comment?: unknown }
        const dryRun = dryRunOf(u, body)
        const ms = typeof b.duration === 'string' ? parseDuration(b.duration) : null
        if (ms === null) return invalid([{ path: 'duration', message: 'duration is required', fix: 'Give how long to silence the alert, e.g. "15m", "1h" or "4h".' }])
        if (b.comment !== undefined && (typeof b.comment !== 'string' || b.comment.length > 4096)) return invalid([{ path: 'comment', message: 'comment must be a string of at most 4096 characters', fix: 'Shorten it.' }])
        const f = find(params.id!)
        if (!f) return apiError(404, 'not_found', `monitor ${params.id} not found`)
        const hit = targets(f, body)
        if (!Array.isArray(hit)) return hit
        if (ms < 1000 || ms > MAX_SILENCE_MS) return invalid([{ path: 'duration', message: 'duration must be between 1s and 30d', fix: 'Choose e.g. "15m", "1h" or "4h".' }])
        const comment = typeof b.comment === 'string' && b.comment !== '' ? b.comment : `Silenced from monitor ${f.id}`
        const undo = { token: hex16(`undo${t}${counter}`) + hex16(`token${counter++}${t}`), until: t + UNDO_WINDOW_MS }
        const made: Silence[] = hit.map((a) => ({
          id: hex16(`silence${t}${counter++}${a.fingerprint}`),
          matchers: Object.keys(a.labels).sort().map((n) => ({ name: n, value: a.labels[n]!, isRegex: false as const, isEqual: true as const })),
          startsAt: t,
          endsAt: t + ms,
          createdBy: by,
          comment,
          updatedAt: t,
          undo,
          monitor: f.id,
        }))
        if (!dryRun) {
          made.forEach((s, i) => {
            silences.set(s.id, s)
            log(f, { at: t, source: 'notifier', kind: 'silenced', by, until: s.endsAt, silenceIds: [s.id], fingerprints: [hit[i]!.fingerprint] })
          })
        }
        const token = made.length === 0 || dryRun ? null : undo.token
        return json(200, {
          dryRun, id: f.id, silences: made.map((s) => silenceView(s, t)), silenced: hit.map((a) => a.fingerprint), notYetHandedOff: [],
          undoToken: token, undoUntil: made.length === 0 && !dryRun ? null : undo.until,
        })
      }
      case 'undo': {
        const b = (body ?? {}) as { undoToken?: unknown }
        const dryRun = dryRunOf(u, body)
        if (typeof b.undoToken !== 'string' || b.undoToken === '') return invalid([{ path: 'undoToken', message: 'undoToken is required', fix: 'Send the token the silence call returned.' }])
        const ids = [...silences.values()].filter((s) => s.undo.token === b.undoToken).map((s) => s.id)
        if (ids.length === 0) return apiError(404, 'not_found', 'undo token not found')
        const until = silences.get(ids[0]!)!.undo.until
        if (t > until) return apiError(410, 'undo_expired', `the undo window closed at ${new Date(until).toISOString()}; expire the silence instead`)
        if (!dryRun) {
          for (const id of ids) {
            const s = silences.get(id)!
            const f = find(s.monitor)
            if (f) log(f, { at: t, source: 'notifier', kind: 'silence_undone', by, silenceIds: [id] })
            silences.delete(id)
          }
        }
        return json(200, { dryRun, removed: ids })
      }
      case 'expire': {
        const s = silences.get(params.silenceId!)
        if (!s) return apiError(404, 'not_found', 'silence not found')
        const dryRun = dryRunOf(u, null)
        if (!dryRun) {
          s.endsAt = Math.min(s.endsAt, t)
          s.updatedAt = t
          const f = find(s.monitor)
          if (f) log(f, { at: t, source: 'notifier', kind: 'silence_expired', by, silenceIds: [s.id] })
        }
        return json(200, { dryRun, expired: s.id })
      }
    }
    return apiError(501, 'not_implemented', `the mock does not implement ${u.pathname}; the real ruler does`)
  }

  /**
   * One request to /api/v1/monitors…: the route, then the key (`scopes` null: no key, or one
   * the API does not know), then the handler.
   */
  function handle(method: string, u: URL, rawBody: string, key: { id: string; scopes: string[] } | null, hasKey: boolean): MonitorsReply {
    let def: (typeof ROUTES)[number] | undefined
    let params: Record<string, string> = {}
    let known = false
    for (const r of ROUTES) {
      const p = match(r.path, u.pathname)
      if (!p) continue
      known = true
      if (r.method === method) {
        def = r
        params = p
        break
      }
    }
    if (!def) return known ? apiError(405, 'method_not_allowed', `${method} is not supported on this path`) : apiError(404, 'not_found', 'no such route')
    const challenge = { 'WWW-Authenticate': 'Bearer realm="viz"' }
    if (!key) return apiError(401, 'unauthorized', hasKey ? 'invalid API key' : 'missing API key', {}, challenge)
    if (!key.scopes.includes(def.scope)) return apiError(403, 'forbidden', `API key lacks the ${def.scope} scope`)
    const fail = failures.get(def.name)
    const d = delays.get(def.name) ?? delays.get('*')
    const delayMs = d && d.left > 0 ? d.ms : 0
    if (d && d.left > 0 && Number.isFinite(d.left)) d.left--
    if (fail && fail.left > 0) {
      fail.left--
      const r = fail.status === 503 ? apiError(503, 'unavailable', 'the ruler did not answer in time; nothing was changed', {}, { 'Retry-After': '1' }) : apiError(fail.status, 'internal', 'internal error')
      return { ...r, delayMs }
    }
    let body: unknown = {}
    if (method !== 'GET' && rawBody.trim() !== '') {
      try {
        body = JSON.parse(rawBody)
      } catch {
        return apiError(400, 'bad_request', 'the request body is not valid JSON')
      }
    }
    return { ...routeHandler(def.name, u, params, body, `key:${key.id}`), delayMs }
  }

  /** The test hooks (`/__mock/monitors`). */
  function control(u: URL): MonitorsReply {
    const q = u.searchParams
    if (q.get('reset') === '1') {
      offset = 0
      empty = false
      failures.clear()
      delays.clear()
      build()
    }
    if (q.has('advance')) offset += Number(q.get('advance')) || 0
    if (q.has('empty')) empty = q.get('empty') === '1'
    if (q.has('fail')) failures.set(q.get('fail')!, { status: Number(q.get('status') ?? '503'), left: Number(q.get('count') ?? '1') })
    if (q.has('delay')) delays.set(q.get('route') ?? '*', { ms: Number(q.get('delay')) || 0, left: q.has('count') ? Number(q.get('count')) : Infinity })
    return json(200, { nowMs: now(), offsetMs: offset, empty, failures: Object.fromEntries(failures), delays: Object.fromEntries(delays) })
  }

  return { handle, control, ids: () => fixtures.map((f) => f.id) }
}
