/**
 * The mock Prometheus HTTP API as a pure request handler, shared by the Node dev server
 * (mock/server.ts) and by tests (as an in-process `fetch`). THIS IS A MOCK: synthetic data
 * and a subset of PromQL. It identifies itself in /api/v1/status/buildinfo (`mock: true`).
 *
 * Its HTTP surface follows the real viz query API (query/src/index.ts, behind
 * deploy/gateway), checked request by request by e2e/contract.cjs: the same methods per
 * endpoint, statuses, error types and wording, `WWW-Authenticate`, the `X-Viz-*` cost
 * headers, label names sorted in every label set, series sorted, metadata empty, label
 * endpoints bounded by `start`/`end`, the query-size and nesting limits. What it does not
 * reproduce is listed in README.md ("What is mocked").
 */
import { syntheticStorage } from './data'
import { durationSeconds, matchLabels, parseSelector, PromQLError, queryInstant, queryRange, type Matcher } from './promql'
import type { Labels, SeriesSource, Storage } from './storage'

export const MOCK_VERSION = 'viz-mock-0.1.0'

export interface MockResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export interface MockOptions {
  storage?: Storage
  /** Epoch seconds; injectable for tests. */
  now?: () => number
  /**
   * When set, requests must carry `Authorization: Bearer <token>`, as the real API requires
   * an API key with the `read` scope. Unset (the development default), anything is accepted.
   */
  requireToken?: string
  /** A key that authenticates but lacks the `read` scope: answered 403, as the real API does. */
  readlessToken?: string
}

/**
 * The cost headers the real API sends on every answer after authentication (query/README.md),
 * in its order. `X-Viz-Series-Estimate` appeared in query/src on 2026-11-19 while this list was
 * being checked (e2e/contract.cjs found it), and five more by 2026-11-26 (`X-Viz-Pruning` to
 * `X-Viz-Rows-Decoded`, found the same way): the contract test is what keeps this list true.
 */
export const COST_HEADERS = [
  'X-Viz-Ledger-Version', 'X-Viz-Plan-Attempts', 'X-Viz-Files-Listed', 'X-Viz-Files-Skipped', 'X-Viz-Files-Read',
  'X-Viz-Scan-Samples', 'X-Viz-Series-Estimate', 'X-Viz-Bytes-Read', 'X-Viz-Cache-Hits', 'X-Viz-R2-Gets', 'X-Viz-Leaf-Calls', 'X-Viz-Leaves-Used',
  'X-Viz-Leaf-Rounds', 'X-Viz-Shards-Asked', 'X-Viz-Shard-Calls', 'X-Viz-Tail-Batches', 'X-Viz-Tail-Bytes',
  'X-Viz-Series-Loaded', 'X-Viz-Samples-Loaded', 'X-Viz-Engine-Ms', 'X-Viz-Wasm-Memory-Bytes', 'X-Viz-Execution',
  'X-Viz-Split-Reason', 'X-Viz-Split-Leaves', 'X-Viz-Reader-Calls', 'X-Viz-Rpc-Bytes', 'X-Viz-Leaf-Peak-Wasm-Bytes',
  'X-Viz-Leaf-Max-Samples', 'X-Viz-Leaf-Reruns', 'X-Viz-Pruning', 'X-Viz-Tail-Mode', 'X-Viz-Series-Reads', 'X-Viz-Scan-Rows', 'X-Viz-Rows-Decoded',
] as const

/** The real API's per-query limits that a request to the mock can reach (query/README.md, "Limits"). */
export const MAX_QUERY_BYTES = 16_384
export const MAX_DEPTH = 100

/** Which methods each endpoint takes, as the real query Worker routes them. */
const ROUTES: Record<string, string[]> = {
  '/api/v1/query': ['GET', 'POST'],
  '/api/v1/query_range': ['GET', 'POST'],
  '/api/v1/labels': ['GET', 'POST'],
  '/api/v1/series': ['GET', 'POST'],
  '/api/v1/metadata': ['GET'],
  '/api/v1/status/buildinfo': ['GET'],
}
/** control's identity route, which the app's sign-in asks. */
export const WHOAMI_PATH = '/api/v1/control/whoami'
export const MOCK_TENANT = 'viz-mock'
const LABEL_VALUES = /^\/api\/v1\/label\/([^/]+)\/values$/

const ok = (data: unknown, headers?: Record<string, string>): MockResponse => ({ status: 200, body: { status: 'success', data }, headers })
const STATUS: Record<string, number> = {
  bad_data: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  execution: 422,
  unsupported: 422,
  internal: 500,
  unavailable: 503,
  timeout: 503,
}
export const fail = (errorType: string, error: string, headers?: Record<string, string>): MockResponse => ({
  status: STATUS[errorType] ?? 500,
  body: { status: 'error', errorType, error },
  headers,
})

/** Cost headers with what the mock knows: it reads no files and asks no shards, so most are 0. */
export function costHeaders(engineMs: number): Record<string, string> {
  const h: Record<string, string> = {}
  for (const name of COST_HEADERS) h[name] = '0'
  h['X-Viz-Plan-Attempts'] = '1'
  h['X-Viz-Execution'] = 'single'
  h['X-Viz-Split-Reason'] = 'the mock does not split queries'
  h['X-Viz-Engine-Ms'] = String(Math.round(engineMs))
  return h
}

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d*))?$/
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/

/**
 * Decimal seconds as whole milliseconds, as the real API reads them (query/src/params.ts):
 * from the digits, the fourth decimal rounding half up ("1794994200.0005" is ...200001 ms).
 */
function decimalSecondsToMs(text: string): number | null {
  const m = DECIMAL.exec(text)
  if (!m) return null
  if (m[2]!.length > 15) return m[1] === '-' ? -Infinity : Infinity
  const frac = (m[3] ?? '').padEnd(4, '0')
  let ms = Number(m[2]) * 1000 + Number(frac.slice(0, 3))
  if (frac.charCodeAt(3) >= 53) ms += 1
  return m[1] === '-' ? -ms : ms
}

/**
 * A time parameter in whole milliseconds, read as the real API reads it: decimal seconds
 * rounded to the millisecond, exponent forms, RFC 3339 with digits past the millisecond cut.
 * Returned as seconds (milliseconds / 1000), so the mock's grid is the real API's.
 */
function parseTime(text: string | null, name: string, fallback?: number): number {
  if (text === null || text === '') {
    if (fallback !== undefined) return fallback
    throw new PromQLError(`invalid parameter "${name}": cannot parse "" to a valid timestamp`)
  }
  let ms = decimalSecondsToMs(text)
  if (ms === null) {
    const f = Number(text)
    if (text.trim() !== '' && !Number.isNaN(f) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) ms = Math.round(f * 1000)
    else if (RFC3339.test(text) && !Number.isNaN(Date.parse(text))) ms = Date.parse(text.replace(/(\.\d{3})\d+/, '$1'))
    else throw new PromQLError(`invalid parameter "${name}": cannot parse ${JSON.stringify(text)} to a valid timestamp`)
  }
  return ms / 1000
}

/** The step as the real API takes it: a number of seconds or a duration, in milliseconds, then floored to a whole millisecond (0.4 ms is a step of 0). */
function parseStep(text: string | null): number {
  if (text === null || text === '') throw new PromQLError('invalid parameter "step": cannot parse "" to a valid duration')
  let ms: number
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) ms = decimalSecondsToMs(text) ?? Number(text) * 1000
  else if (/^(?:\d+(?:ms|[smhdwy]))+$/.test(text)) ms = Math.round(durationSeconds(text) * 1000)
  else throw new PromQLError(`invalid parameter "step": cannot parse ${JSON.stringify(text)} to a valid duration`)
  if (!Number.isFinite(ms)) throw new PromQLError(`invalid parameter "step": cannot parse ${JSON.stringify(text)} to a valid duration`)
  return Math.floor(ms) / 1000
}

/** A label set with its names in order, as the real API (and Prometheus) writes every label set. */
export function sortedLabels(labels: Labels): Labels {
  const out: Labels = {}
  for (const k of Object.keys(labels).sort()) out[k] = labels[k]!
  return out
}

/** The text of a query: the real API refuses an empty one before parsing it. */
function queryText(params: URLSearchParams): string {
  const q = params.get('query')
  if (q === null || q === '') throw new PromQLError('invalid parameter "query": the query is empty')
  // The real API's limits on the query text (`max_query_bytes`, `max_depth`), checked before evaluation.
  const bytes = new TextEncoder().encode(q).length
  if (bytes > MAX_QUERY_BYTES) throw new PromQLError(`query exceeded limit max_query_bytes: ${bytes} bytes of query text, the limit is ${MAX_QUERY_BYTES}`, 'execution')
  const depth = nestingDepth(q)
  if (depth > MAX_DEPTH) throw new PromQLError(`query exceeded limit max_depth: ${depth} levels of nesting (brackets and operators), the limit is ${MAX_DEPTH}`, 'execution')
  return q
}

/** Brackets open at once, outside quoted strings, up to one past the limit: the part of the real engine's depth count a parser reaches first. */
function nestingDepth(q: string): number {
  let depth = 0
  let max = 0
  let quote = ''
  for (let i = 0; i < q.length; i++) {
    const c = q[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'" || c === '`') quote = c
    // The real engine stops counting at the first level past the limit.
    else if (c === '(' || c === '[' || c === '{') {
      max = Math.max(max, ++depth)
      if (max > MAX_DEPTH) return max
    }
    else if (c === ')' || c === ']' || c === '}') depth--
  }
  return max
}

/**
 * The mock's parser reports positions ("1:48: parse error: …"); the real API does not
 * (README, "Needed changes in query/"), so neither does this envelope.
 */
const apiMessage = (e: PromQLError): string => e.message.replace(/^\d+:\d+: /, '')

export function createMockApi(opts: MockOptions = {}) {
  const storage = opts.storage ?? syntheticStorage()
  const now = opts.now ?? (() => Date.now() / 1000)

  /** Series selected by `match[]` and holding a sample in [start, end] (the real API's window; all time when absent). */
  function selected(params: URLSearchParams): SeriesSource[] {
    const matches = params.getAll('match[]')
    const start = parseTime(params.get('start'), 'start', -Infinity)
    const end = parseTime(params.get('end'), 'end', Infinity)
    if (end < start) throw new PromQLError('invalid parameter "end": end timestamp must not be before start time')
    let all = storage.all()
    if (matches.length > 0) {
      const sets: Matcher[][] = matches.map((m) => {
        try {
          return parseSelector(m)
        } catch (e) {
          throw new PromQLError((e as Error).message)
        }
      })
      all = all.filter((s) => sets.some((ms) => matchLabels(s.labels, ms)))
    }
    if (start === -Infinity && end === Infinity) return all
    return all.filter((s) => s.latest(Math.max(start, -8.64e12) - 1e-9, Math.min(end, 8.64e12)) !== undefined)
  }

  function authorize(headers: Record<string, string | undefined>): MockResponse | null {
    if (!opts.requireToken) return null
    const challenge = { 'WWW-Authenticate': 'Bearer realm="viz"' }
    const h = headers.authorization
    if (!h) return fail('unauthorized', 'missing API key', challenge)
    const token = /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim()
    if (opts.readlessToken && token === opts.readlessToken) return fail('forbidden', 'API key lacks the read scope')
    if (token !== opts.requireToken) return fail('unauthorized', 'invalid API key', challenge)
    return null
  }

  /**
   * @param method  HTTP method
   * @param url     path and query string (origin optional)
   * @param body    form-encoded body for POST
   * @param headers request headers (lower-case names)
   */
  /**
   * control's `GET /api/v1/control/whoami`: who the key is, for any valid key whatever its
   * scopes (control/README.md). It is not a Prometheus endpoint: the identity itself, or
   * control's problem body with 401. Without `requireToken` the mock needs no key and says so
   * by answering for a key of its own.
   */
  function whoami(method: string, headers: Record<string, string | undefined>): MockResponse {
    const problem = (status: number, code: string, title: string, detail: string, fix: string, extra?: Record<string, string>): MockResponse => ({
      status,
      body: { type: `https://vis.bitcru.sh/problems/${code}`, title, status, code, detail, fix },
      headers: { 'Content-Type': 'application/problem+json', ...extra },
    })
    if (method !== 'GET') return problem(405, 'method-not-allowed', 'Method not allowed', `${method} is not supported here.`, 'Use one of: GET.', { Allow: 'GET' })
    const identity = (name: string, scopes: string[]): MockResponse => ({ status: 200, body: { tenant: MOCK_TENANT, subject: `key:${name}`, kind: 'key', name, scopes, mayApply: false } })
    if (!opts.requireToken) return identity('mock key', ['read'])
    const token = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1]?.trim()
    if (opts.readlessToken && token === opts.readlessToken) return identity('write-only key', ['write'])
    if (token === opts.requireToken) return identity('read key', ['read'])
    return problem(401, 'unauthenticated', 'Not authenticated', 'The API key is missing, malformed, unknown, disabled or expired.', 'Send "Authorization: Bearer viz_<keyId>_<secret>" with a key that is enabled and not expired.', {
      'WWW-Authenticate': 'Bearer realm="viz"',
    })
  }

  function handle(method: string, url: string, body = '', headers: Record<string, string | undefined> = {}): MockResponse {
    const u = new URL(url, 'http://mock.invalid')
    const path = u.pathname
    if (path === WHOAMI_PATH) return whoami(method, headers)
    const values = LABEL_VALUES.exec(path)
    const methods = values ? ['GET'] : ROUTES[path]
    if (!methods) return fail('not_found', 'not found')
    if (!methods.includes(method)) return fail('method_not_allowed', 'method not allowed', { Allow: methods.join(', ') })
    const denied = authorize(headers)
    if (denied) return denied

    const t0 = performance.now()
    const answered = (data: unknown) => ok(data, costHeaders(performance.now() - t0))
    const failed = (errorType: string, error: string) => fail(errorType, error, costHeaders(performance.now() - t0))
    try {
      const params = new URLSearchParams(u.search)
      if (method === 'POST') {
        const type = (headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
        if (type !== '' && type !== 'application/x-www-form-urlencoded')
          return fail('bad_data', `unsupported content type ${JSON.stringify(type)}: send application/x-www-form-urlencoded`)
        if (body) for (const [k, v] of new URLSearchParams(body)) params.append(k, v)
      }
      switch (path) {
        case '/api/v1/status/buildinfo':
          // The real API's six fields; `mock` is the mock's own, so the UI can say what it is talking to.
          return answered({ version: MOCK_VERSION, revision: 'synthetic', branch: '', buildUser: '', buildDate: '', goVersion: '', mock: true })
        case '/api/v1/query_range': {
          const query = queryText(params)
          const start = parseTime(params.get('start'), 'start')
          const end = parseTime(params.get('end'), 'end')
          const data = queryRange(storage, query, start, end, parseStep(params.get('step')))
          return answered({ resultType: data.resultType, result: data.result.map((s) => ({ metric: sortedLabels(s.metric), values: s.values })) })
        }
        case '/api/v1/query': {
          const query = queryText(params)
          // The real API resolves "now" to the millisecond.
          const data = queryInstant(storage, query, parseTime(params.get('time'), 'time', Math.round(now() * 1000) / 1000))
          if (data.resultType === 'vector' || data.resultType === 'matrix') {
            const result = (data.result as { metric: Labels }[]).map((s) => ({ ...s, metric: sortedLabels(s.metric) }))
            result.sort((a, b) => (labelOrder(a.metric) < labelOrder(b.metric) ? -1 : 1))
            return answered({ resultType: data.resultType, result })
          }
          return answered(data)
        }
        case '/api/v1/labels': {
          const names = new Set<string>()
          for (const s of selected(params)) for (const k of Object.keys(s.labels)) names.add(k)
          return answered([...names].sort())
        }
        case '/api/v1/series':
          if (params.getAll('match[]').length === 0) return failed('bad_data', 'no match[] parameter provided')
          return answered(
            selected(params)
              .map((s) => sortedLabels(s.labels))
              .sort((a, b) => (labelOrder(a) < labelOrder(b) ? -1 : 1)),
          )
        case '/api/v1/metadata':
          // The real API stores no metric metadata and always answers {} (query/README.md).
          return answered({})
      }
      const name = decodeURIComponent(values![1]!)
      const found = new Set<string>()
      for (const s of selected(params)) {
        const v = s.labels[name]
        if (v !== undefined) found.add(v)
      }
      return answered([...found].sort())
    } catch (e) {
      if (e instanceof PromQLError) return failed(e.errorType, apiMessage(e))
      return failed('internal', 'internal error')
    }
  }

  /** A `fetch` that answers from the mock in-process (for tests). */
  const mockFetch: typeof fetch = async (input, init) => {
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v))
    const res = handle(init?.method ?? 'GET', url, typeof init?.body === 'string' ? init.body : '', headers)
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json', ...res.headers } })
  }

  return { handle, fetch: mockFetch }
}

/** The order the real API lists series in: by their label sets, names sorted. */
function labelOrder(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}\u0000${labels[k]}`)
    .join('\u0001')
}
