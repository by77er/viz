/**
 * The mock Prometheus HTTP API as a pure request handler, shared by the Node dev server
 * (mock/server.ts) and by tests (as an in-process `fetch`). THIS IS A MOCK: synthetic data
 * and a subset of PromQL. It identifies itself in /api/v1/status/buildinfo (`mock: true`).
 */
import { syntheticStorage } from './data'
import { durationSeconds, matchLabels, parseSelector, PromQLError, queryInstant, queryRange, type Matcher } from './promql'
import type { Storage } from './storage'

export const MOCK_VERSION = 'viz-mock-0.1.0'

export interface MockResponse {
  status: number
  body: unknown
}

export interface MockOptions {
  storage?: Storage
  /** Epoch seconds; injectable for tests. */
  now?: () => number
  /** When set, requests must carry `Authorization: Bearer <token>`. */
  requireToken?: string
}

const ok = (data: unknown): MockResponse => ({ status: 200, body: { status: 'success', data } })
const fail = (status: number, errorType: string, error: string): MockResponse => ({ status, body: { status: 'error', errorType, error } })

function parseTime(text: string | null, name: string, fallback?: number): number {
  if (text === null || text === '') {
    if (fallback !== undefined) return fallback
    throw new PromQLError(`invalid parameter "${name}": cannot parse "" to a valid timestamp`)
  }
  const n = Number(text)
  if (Number.isFinite(n)) return n
  const ms = Date.parse(text)
  if (Number.isFinite(ms)) return ms / 1000
  throw new PromQLError(`invalid parameter "${name}": cannot parse ${JSON.stringify(text)} to a valid timestamp`)
}

function parseStep(text: string | null): number {
  if (text === null || text === '') throw new PromQLError('invalid parameter "step": cannot parse "" to a valid duration')
  const n = Number(text)
  if (Number.isFinite(n)) return n
  if (/^(?:\d+(?:ms|[smhdwy]))+$/.test(text)) return durationSeconds(text)
  throw new PromQLError(`invalid parameter "step": cannot parse ${JSON.stringify(text)} to a valid duration`)
}

export function createMockApi(opts: MockOptions = {}) {
  const storage = opts.storage ?? syntheticStorage()
  const now = opts.now ?? (() => Date.now() / 1000)

  function selected(params: URLSearchParams) {
    const matches = params.getAll('match[]')
    const all = storage.all()
    if (matches.length === 0) return all
    const sets: Matcher[][] = matches.map((m) => {
      try {
        return parseSelector(m)
      } catch (e) {
        throw new PromQLError(`invalid parameter "match[]": ${(e as Error).message}`)
      }
    })
    return all.filter((s) => sets.some((ms) => matchLabels(s.labels, ms)))
  }

  /**
   * @param method  HTTP method
   * @param url     path and query string (origin optional)
   * @param body    form-encoded body for POST
   * @param headers request headers (lower-case names)
   */
  function handle(method: string, url: string, body = '', headers: Record<string, string | undefined> = {}): MockResponse {
    const u = new URL(url, 'http://mock.invalid')
    const params = new URLSearchParams(u.search)
    if (method === 'POST' && body) for (const [k, v] of new URLSearchParams(body)) params.append(k, v)
    const path = u.pathname.replace(/\/+$/, '')

    if (!path.startsWith('/api/v1/')) return fail(404, 'not_found', `no such endpoint: ${path}`)
    if (opts.requireToken && headers.authorization !== `Bearer ${opts.requireToken}`)
      return fail(401, 'unauthorized', 'missing or invalid bearer token')
    if (method !== 'GET' && method !== 'POST') return fail(405, 'bad_data', `method ${method} not allowed`)

    try {
      switch (path) {
        case '/api/v1/status/buildinfo':
          return ok({ version: MOCK_VERSION, revision: 'synthetic', mock: true })
        case '/api/v1/query_range': {
          const query = params.get('query') ?? ''
          let data
          try {
            data = queryRange(storage, query, parseTime(params.get('start'), 'start'), parseTime(params.get('end'), 'end'), parseStep(params.get('step')))
          } catch (e) {
            throw wrapQueryError(e)
          }
          return ok(data)
        }
        case '/api/v1/query': {
          const query = params.get('query') ?? ''
          try {
            return ok(queryInstant(storage, query, parseTime(params.get('time'), 'time', now())))
          } catch (e) {
            throw wrapQueryError(e)
          }
        }
        case '/api/v1/labels': {
          const names = new Set<string>()
          for (const s of selected(params)) for (const k of Object.keys(s.labels)) names.add(k)
          return ok([...names].sort())
        }
        case '/api/v1/series':
          if (params.getAll('match[]').length === 0) return fail(400, 'bad_data', 'no match[] parameter provided')
          return ok(selected(params).map((s) => s.labels))
        case '/api/v1/metadata': {
          const metric = params.get('metric')
          const all = storage.metadata()
          return ok(metric ? (all[metric] ? { [metric]: all[metric] } : {}) : all)
        }
        case '/api/v1/status/flags':
          return ok({})
      }
      const m = /^\/api\/v1\/label\/([^/]+)\/values$/.exec(path)
      if (m) {
        const name = decodeURIComponent(m[1]!)
        const values = new Set<string>()
        for (const s of selected(params)) {
          const v = s.labels[name]
          if (v !== undefined) values.add(v)
        }
        return ok([...values].sort())
      }
      return fail(404, 'not_found', `no such endpoint: ${path}`)
    } catch (e) {
      if (e instanceof PromQLError) return fail(e.errorType === 'execution' ? 422 : 400, e.errorType, e.message)
      return fail(500, 'internal', (e as Error).message)
    }
  }

  /** A `fetch` that answers from the mock in-process (for tests). */
  const mockFetch: typeof fetch = async (input, init) => {
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v))
    const res = handle(init?.method ?? 'GET', url, typeof init?.body === 'string' ? init.body : '', headers)
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } })
  }

  return { handle, fetch: mockFetch }
}

/** Parse errors from the `query` parameter are reported the way Prometheus does. */
function wrapQueryError(e: unknown): unknown {
  if (e instanceof PromQLError && e.errorType === 'bad_data' && /parse error/.test(e.message) && !e.message.startsWith('invalid parameter'))
    return new PromQLError(`invalid parameter "query": ${e.message}`)
  return e
}
