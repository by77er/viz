/**
 * Deterministic fakes of the two services being finished elsewhere: the query service
 * (the Prometheus HTTP API) and the ruler's monitor API. Each authenticates the caller's
 * credential with edge's own verifier against the same KV, exactly as the real services
 * do, and answers from that tenant's data only. A fake that took the tenant from anything
 * else would make the isolation tests meaningless.
 */
import { authenticate } from '../../../edge/src/auth'
import { HttpError } from '../../../edge/src/errors'
import type { Fetcher, MonitorView } from '../../src/clients'
import { matchLabels, parseSelector, PromQLError, queryInstant, queryRange } from './promql'
import type { FakeStorage } from './data'
import { fakeStorage } from './data'

const ok = (data: unknown, warnings?: string[]) => ({ status: 200, body: { status: 'success', data, ...(warnings?.length ? { warnings } : {}) } })
const fail = (status: number, errorType: string, error: string) => ({ status, body: { status: 'error', errorType, error } })

export interface PromOptions {
  /** Return this error (HTTP 422, execution) for a query whose text contains the key. */
  errors?: Record<string, string>
  /** `/api/v1/plan`: refuse (in `refusal`, as the query service does before fetching) a query whose text contains the key. */
  planRefusals?: Record<string, string>
  /** `/api/v1/plan` answers 404, as a query service from before the endpoint does. */
  noPlan?: boolean
  /** Return these warnings with every successful query. */
  warnings?: string[]
  /** Delay every query (ms), or a query whose text contains the key. */
  delayMs?: number | Record<string, number>
}

export interface FakeProm {
  fetcher: Fetcher
  storages: Map<string, FakeStorage>
  /** Every request: path, the tenant the credential resolved to, the expression if any. */
  calls: { path: string; tenant: string | null; expr?: string }[]
  inFlight: number
  maxInFlight: number
  options: PromOptions
}

function timeOf(v: string | null, fallback: number): number {
  if (v === null || v === '') return fallback
  const n = Number(v)
  if (Number.isFinite(n)) return n
  const ms = Date.parse(v)
  if (Number.isFinite(ms)) return ms / 1000
  throw new PromQLError(`invalid parameter: cannot parse ${JSON.stringify(v)} to a valid timestamp`)
}

function stepOf(v: string | null): number {
  if (!v) throw new PromQLError('invalid parameter "step": cannot parse "" to a valid duration')
  const n = Number(v)
  if (Number.isFinite(n)) return n
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(v)
  if (!m) throw new PromQLError(`invalid parameter "step": cannot parse ${JSON.stringify(v)} to a valid duration`)
  return Number(m[1]) * ({ ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2]!]!
}

export function fakeProm(kv: () => KVNamespace, nowSec: number, options: PromOptions = {}): FakeProm {
  const storages = new Map<string, FakeStorage>()
  const state: FakeProm = {
    storages,
    calls: [],
    inFlight: 0,
    maxInFlight: 0,
    options,
    fetcher: {
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url)
        const params = new URLSearchParams(url.search)
        if (req.method === 'POST') for (const [k, v] of new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()))) params.append(k, v)
        let tenant: string | null = null
        try {
          tenant = (await authenticate(req, kv(), 'read')).tenant
        } catch (e) {
          state.calls.push({ path: url.pathname, tenant: null })
          if (e instanceof HttpError) return Response.json(fail(e.status, e.status === 401 ? 'unauthorized' : 'forbidden', e.message).body, { status: e.status })
          throw e
        }
        const expr = params.get('query') ?? undefined
        state.calls.push({ path: url.pathname, tenant, ...(expr !== undefined ? { expr } : {}) })
        const storage = storages.get(tenant) ?? fakeStorage()
        state.inFlight++
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
        try {
          const delay = typeof state.options.delayMs === 'number' ? state.options.delayMs : Object.entries(state.options.delayMs ?? {}).find(([k]) => expr?.includes(k))?.[1] ?? 0
          if (delay > 0) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, delay)
              req.signal?.addEventListener('abort', () => {
                clearTimeout(timer)
                reject(new DOMException('aborted', 'AbortError'))
              })
            })
          }
          const res = answer(url.pathname, params, storage, nowSec, state.options)
          return Response.json(res.body, { status: res.status })
        } finally {
          state.inFlight--
        }
      },
    },
  }
  return state
}

function answer(path: string, params: URLSearchParams, storage: FakeStorage, nowSec: number, opts: PromOptions): { status: number; body: unknown } {
  try {
    const selected = () => {
      const matches = params.getAll('match[]')
      const start = timeOf(params.get('start'), nowSec - 3600)
      const end = timeOf(params.get('end'), nowSec)
      const inRange = storage.all().filter((s) => s.latest(start - 1e-9, end) !== undefined || s.samples(start, end).length > 0)
      if (matches.length === 0) return inRange
      const sets = matches.map((m) => parseSelector(m))
      return inRange.filter((s) => sets.some((ms) => matchLabels(s.labels, ms)))
    }
    switch (path) {
      case '/api/v1/query':
      case '/api/v1/query_range': {
        const q = params.get('query') ?? ''
        for (const [k, msg] of Object.entries(opts.errors ?? {})) if (q.includes(k)) return fail(422, 'execution', msg)
        const data = path === '/api/v1/query' ? queryInstant(storage, q, timeOf(params.get('time'), nowSec)) : queryRange(storage, q, timeOf(params.get('start'), nowSec), timeOf(params.get('end'), nowSec), stepOf(params.get('step')))
        return ok(data, opts.warnings)
      }
      case '/api/v1/plan': {
        // The shape of query/src/coordinator.ts QueryPlan. The fake has no lake files, so the
        // file and byte counts are 0; the series estimate is the series of the metrics named.
        if (opts.noPlan) return fail(404, 'not_found', 'not found')
        const q = params.get('query') ?? ''
        queryRange(storage, q, timeOf(params.get('start'), nowSec), timeOf(params.get('end'), nowSec), stepOf(params.get('step') ?? '60')) // parse errors as the real one: 400 bad_data
        const named = storage.all().filter((s) => q.includes(s.labels.__name__ ?? '\u0000'))
        const refusal = Object.entries(opts.planRefusals ?? {}).find(([k]) => q.includes(k))
        return ok({
          execution: named.length === 0 ? 'none' : 'single', splitReason: named.length === 0 ? '' : 'the query fits in one place', leaves: 0, ledgerVersion: 1,
          filesListed: 0, filesSkipped: 0, filesToRead: 0, bytesToRead: 0, scanSamples: 0, seriesEstimate: named.length,
          refusal: refusal ? { errorType: 'execution', error: refusal[1] } : null,
        })
      }
      case '/api/v1/labels': {
        const names = new Set<string>()
        for (const s of selected()) for (const k of Object.keys(s.labels)) names.add(k)
        return ok([...names].sort())
      }
      case '/api/v1/series': {
        if (params.getAll('match[]').length === 0) return fail(400, 'bad_data', 'no match[] parameter provided')
        return ok(selected().map((s) => s.labels))
      }
      case '/api/v1/metadata': {
        const metric = params.get('metric')
        const all = storage.metadata()
        return ok(metric ? (all[metric] ? { [metric]: all[metric] } : {}) : all)
      }
    }
    const m = /^\/api\/v1\/label\/([^/]+)\/values$/.exec(path)
    if (m) {
      const name = decodeURIComponent(m[1]!)
      const values = new Set<string>()
      for (const s of selected()) {
        const v = s.labels[name]
        if (v !== undefined) values.add(v)
      }
      return ok([...values].sort())
    }
    return fail(404, 'not_found', `no such endpoint: ${path}`)
  } catch (e) {
    if (e instanceof PromQLError) return fail(e.errorType === 'execution' ? 422 : 400, e.errorType, e.message.startsWith('invalid parameter') ? e.message : `invalid parameter "query": ${e.message}`)
    return fail(500, 'internal', (e as Error).message)
  }
}

// ---- the ruler's monitor API ----

/** How the fake answers `POST /api/v1/monitors/backtest` for one tenant, from the request body. */
export type BacktestScript = (body: any) => { status: number; body: unknown; headers?: Record<string, string> } | Promise<{ status: number; body: unknown; headers?: Record<string, string> }>

export interface RulerCall {
  path: string
  tenant: string | null
  method?: string
  /** The JSON body, for POSTs. */
  body?: unknown
  /** Anything in the request that tries to name a tenant: tenant-looking headers, a `tenant` field. The ruler ignores them; tests require there are none. */
  tenantClaims?: string[]
}

export interface FakeRuler {
  fetcher: Fetcher
  monitors: Map<string, { view: MonitorView; history: { at: number; kind: string; [k: string]: unknown }[] }[]>
  /** Per tenant: the backtest answer. Unset: a 200 with no intervals over the range asked. */
  backtests: Map<string, BacktestScript>
  calls: RulerCall[]
}

const TENANT_HEADERS = ['x-viz-tenant', 'x-scope-orgid', 'x-tenant', 'tenant']

function claimsOf(req: Request, body: unknown): string[] {
  const out = TENANT_HEADERS.filter((h) => req.headers.has(h)).map((h) => `header ${h}`)
  const walk = (v: unknown, path: string) => {
    if (typeof v !== 'object' || v === null) return
    for (const [k, x] of Object.entries(v)) {
      if (/^(tenant|tenantId|orgId|org_id)$/i.test(k) && !path.endsWith('.labels') && !path.endsWith('.annotations')) out.push(`body ${path}.${k}`)
      walk(x, `${path}.${k}`)
    }
  }
  walk(body, 'body')
  return out
}

/**
 * The ruler as its HTTP API answers (ruler/src/http.ts, ruler/openapi.json): edge's own key
 * verifier with the route's scope (`monitors:read` for every route here), the tenant from the
 * key record only, errors as `{ error: { code, message } }`.
 */
export function fakeRuler(kv: () => KVNamespace): FakeRuler {
  const monitors: FakeRuler['monitors'] = new Map()
  const backtests: FakeRuler['backtests'] = new Map()
  const calls: FakeRuler['calls'] = []
  return {
    monitors,
    backtests,
    calls,
    fetcher: {
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url)
        let body: unknown
        if (req.method === 'POST') {
          try {
            body = JSON.parse(await req.text())
          } catch {
            body = null
          }
        }
        const call: RulerCall = { path: url.pathname, tenant: null, method: req.method, ...(body !== undefined ? { body } : {}), tenantClaims: claimsOf(req, body) }
        calls.push(call)
        let tenant: string
        try {
          tenant = (await authenticate(req, kv(), 'monitors:read' as 'read')).tenant
        } catch (e) {
          if (e instanceof HttpError) return Response.json({ error: { code: e.status === 401 ? 'unauthorized' : 'forbidden', message: e.message } }, { status: e.status })
          throw e
        }
        call.tenant = tenant
        if (url.pathname === '/api/v1/monitors/backtest') {
          if (req.method !== 'POST') return Response.json({ error: { code: 'method_not_allowed', message: `${req.method} is not supported on this path` } }, { status: 405 })
          const b = body as { monitor?: unknown; step?: unknown } | null
          if (!b || typeof b.monitor !== 'object' || b.monitor === null) return Response.json({ error: { code: 'invalid', message: '1 problem found; nothing was saved' }, problems: [{ path: 'monitor', message: 'give "monitor" (a monitor document) or "rule" (an alerting rule)', fix: 'Send the monitor you are about to save.' }] }, { status: 422 })
          if (typeof b.step !== 'string') return Response.json({ error: { code: 'invalid', message: '1 problem found; nothing was saved' }, problems: [{ path: 'step', message: 'step is required', fix: 'Give the resolution as a duration, e.g. "1m".' }] }, { status: 422 })
          const script = backtests.get(tenant)
          // A slow answer is abandoned when the caller aborts, as a service binding's fetch is.
          const aborted = new Promise<never>((_, reject) => {
            if (req.signal.aborted) reject(req.signal.reason)
            req.signal.addEventListener('abort', () => reject(req.signal.reason))
          })
          const r = await Promise.race([Promise.resolve(script ? script(b) : { status: 200, body: fakeBacktest(b, []) }), aborted])
          return Response.json(r.body, { status: r.status, headers: r.headers ?? {} })
        }
        if (req.method !== 'GET') return Response.json({ error: { code: 'method_not_allowed', message: `${req.method} is not supported on this path` } }, { status: 405 })
        const mine = monitors.get(tenant) ?? []
        if (url.pathname === '/api/v1/monitors') {
          const views = mine.map((m) => m.view)
          return Response.json({ monitors: views, counts: {}, total: views.length })
        }
        const m = /^\/api\/v1\/monitors\/([^/]+)$/.exec(url.pathname)
        if (m) {
          const id = decodeURIComponent(m[1]!)
          const found = mine.find((x) => x.view.id === id)
          if (!found) return Response.json({ error: { code: 'not_found', message: 'monitor not found' } }, { status: 404 })
          return Response.json({ monitor: found.view, history: { entries: found.history, dropped: 0 } })
        }
        return Response.json({ error: { code: 'not_found', message: 'no route' } }, { status: 404 })
      },
    },
  }
}

// ---- backtest answers, in the ruler's shape (ruler/openapi.json Backtest) ----

export interface FakeInterval {
  fingerprint: string
  labels: Record<string, string>
  state: 'pending' | 'firing'
  startMs: number
  endMs: number
  open: boolean
  noData?: boolean
  annotations?: Record<string, string>
}

/** A Prometheus duration in the ruler's form to milliseconds (ruler/src/util.ts). */
export function durationMs(text: string): number {
  const m = /^(?:(\d+)y)?(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/.exec(text)
  if (!m || text === '') throw new Error(`not a duration: ${text}`)
  const n = (i: number) => (m[i] ? Number(m[i]) : 0)
  return n(1) * 365 * 86_400_000 + n(2) * 7 * 86_400_000 + n(3) * 86_400_000 + n(4) * 3_600_000 + n(5) * 60_000 + n(6) * 1000 + n(7)
}

/** The ruler's summary, written again here from ruler/src/backtest.ts `summarize` (not imported from the code under test). */
function rulerSummary(intervals: FakeInterval[]) {
  const firing = intervals.filter((i) => i.state === 'firing')
  const pending = intervals.filter((i) => i.state === 'pending')
  const fired = new Set(firing.map((i) => `${i.fingerprint}@${i.startMs}`))
  return {
    firingCount: firing.length,
    pendingCount: pending.length,
    firingMs: firing.reduce((n, i) => n + (i.endMs - i.startMs), 0),
    longestFiringMs: firing.reduce((n, i) => Math.max(n, i.endMs - i.startMs), 0),
    clearedCount: pending.filter((i) => !i.open && !fired.has(`${i.fingerprint}@${i.endMs}`)).length,
    firingAtEnd: firing.some((i) => i.open),
    series: new Set(intervals.map((i) => i.fingerprint)).size,
  }
}

/** A 200 answer for the request `body` with these intervals, as the ruler builds it (`Ruler.backtest`). */
export function fakeBacktest(body: any, intervals: FakeInterval[], over: Record<string, unknown> = {}): Record<string, unknown> {
  const stepMs = durationMs(body.step)
  const monitor = body.monitor ?? {}
  const kind = monitor.slo !== undefined ? 'slo' : monitor.anomaly !== undefined ? 'anomaly' : 'alert'
  const liveIntervalMs = monitor.interval ? durationMs(monitor.interval) : 60_000
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs || (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0))
  const steps = Math.floor((body.toMs - body.fromMs) / stepMs) + 1
  return {
    fromMs: body.fromMs,
    toMs: body.toMs,
    stepMs,
    steps,
    intervals: sorted,
    summary: rulerSummary(sorted),
    resolution: {
      stepMs,
      liveIntervalMs,
      edgeErrorMs: Math.max(stepMs, liveIntervalMs),
      note: `Evaluated every ${body.step}; the live rule would be evaluated every ${monitor.interval ?? '1m'}. Each start and end is within ${body.step} of the true time. A breach shorter than ${body.step} can be missed, and firings less than ${body.step} apart are joined. History is read as it is stored now (late samples and rollups included), not as it was at the time.`,
    },
    kind,
    warmup: kind === 'alert' ? null : { reads: [{ fromMs: body.fromMs - 100 * stepMs, toMs: body.fromMs - stepMs, stepMs }], points: 100 * 3 },
    cost: {
      scanSamples: steps * 240,
      bytesToRead: steps * 2001,
      queries: 1,
      budget: { scanSamples: 20_000_000, bytesToRead: 128 * 1024 * 1024 },
      memory: { peakBytes: 6_815_744, budgetBytes: 32 * 1024 * 1024, windowSteps: [steps], queries: 1 },
      cpu: { modelledMs: 12, budgetMs: 20_000 },
    },
    ...over,
  }
}

/**
 * The ruler's 422 over_budget (`backtestAnswer` in ruler/src/http.ts). `exceeded` (which budget,
 * contract version 5) only when given: without it, the answer of a ruler older than the field.
 */
export function fakeOverBudget(message: string, parts: { plan?: unknown; memory?: unknown; cpu?: unknown; exceeded?: string | null }): { status: number; body: unknown } {
  return { status: 422, body: { error: { code: 'over_budget', message }, ...('exceeded' in parts ? { exceeded: parts.exceeded } : {}), plan: parts.plan ?? null, budget: { scanSamples: 20_000_000, bytesToRead: 128 * 1024 * 1024 }, memory: parts.memory ?? null, cpu: parts.cpu ?? null } }
}

export function monitorView(over: Partial<MonitorView> & { id: string; name: string }): MonitorView {
  return {
    state: 'ok',
    firingSince: null,
    value: null,
    thresholdText: null,
    expr: 'vector(1)',
    health: 'ok',
    lastError: null,
    labels: {},
    annotations: {},
    alerts: [],
    ...over,
  }
}
