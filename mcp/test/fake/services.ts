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

export interface FakeRuler {
  fetcher: Fetcher
  monitors: Map<string, { view: MonitorView; history: { at: number; kind: string; [k: string]: unknown }[] }[]>
  calls: { path: string; tenant: string | null }[]
}

export function fakeRuler(kv: () => KVNamespace): FakeRuler {
  const monitors: FakeRuler['monitors'] = new Map()
  const calls: FakeRuler['calls'] = []
  return {
    monitors,
    calls,
    fetcher: {
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url)
        let tenant: string
        try {
          tenant = (await authenticate(req, kv(), 'monitors:read' as 'read')).tenant
        } catch (e) {
          calls.push({ path: url.pathname, tenant: null })
          if (e instanceof HttpError) return Response.json({ error: { code: e.status === 401 ? 'unauthorized' : 'forbidden', message: e.message } }, { status: e.status })
          throw e
        }
        calls.push({ path: url.pathname, tenant })
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
