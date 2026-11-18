import type { PromMatrix, PromScalar, PromString, PromVector } from '../../contracts/engine'

/**
 * The three services the agent surface reads and writes through. Each is reached with the
 * CALLER'S OWN credential, so each enforces tenancy itself: this Worker holds no credential
 * of its own and never names a tenant to anyone.
 *
 * - `QueryClient`: the Prometheus HTTP API served by `query/` (being finished elsewhere).
 * - `ControlClient`: the tenant control plane's HTTP API, `/api/v1/control/…` (`control/`).
 * - `MonitorsClient`: the ruler's `/api/v1/monitors` (being finished elsewhere).
 *
 * In production each is a service binding (`QUERY`, `CONTROL`, `RULER`); in tests the query
 * service and the ruler are deterministic fakes and the control plane is the real one.
 */

/** Something with a `fetch`: a service binding, or an in-process stand-in in tests. */
export interface Fetcher {
  fetch(req: Request): Promise<Response>
}

export type PromData = PromMatrix | PromVector | PromScalar | PromString

export type Result<T> =
  | { ok: true; data: T; warnings: string[]; headers: Record<string, string> }
  | { ok: false; status: number; errorType: string; error: string }

export interface QueryOptions {
  /** Seconds; forwarded as Prometheus' `timeout`. */
  timeout?: number
  signal?: AbortSignal
}

export interface RangeOptions extends QueryOptions {
  start?: number
  end?: number
}

/** The Prometheus HTTP API. Times are Unix seconds, as in that API. */
export interface QueryClient {
  instant(expr: string, time: number, opts?: QueryOptions): Promise<Result<PromData>>
  range(expr: string, start: number, end: number, step: number, opts?: QueryOptions): Promise<Result<PromMatrix>>
  labelNames(match: string[], opts?: RangeOptions): Promise<Result<string[]>>
  labelValues(name: string, match: string[], opts?: RangeOptions): Promise<Result<string[]>>
  series(match: string[], opts?: RangeOptions): Promise<Result<Record<string, string>[]>>
  metadata(metric?: string, opts?: QueryOptions): Promise<Result<Record<string, { type: string; help: string; unit: string }[]>>>
}

/** Bytes of a downstream response this Worker will read before giving up. */
export const MAX_RESPONSE_BYTES = 16 << 20

async function readJson(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get('Content-Length') ?? '0')
  if (declared > MAX_RESPONSE_BYTES) throw new TooLarge()
  const reader = res.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new TooLarge()
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(n)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.byteLength
  }
  const text = new TextDecoder().decode(bytes)
  return text ? (JSON.parse(text) as unknown) : null
}

class TooLarge extends Error {}

const unreachable = (what: string, e: unknown): { ok: false; status: number; errorType: string; error: string } => {
  if (e instanceof TooLarge) return { ok: false, status: 422, errorType: 'too_large', error: `The ${what} answer is larger than ${MAX_RESPONSE_BYTES} bytes. Aggregate, narrow the selector or shorten the range.` }
  if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError')) return { ok: false, status: 503, errorType: 'timeout', error: `The ${what} did not answer before the deadline.` }
  return { ok: false, status: 503, errorType: 'unavailable', error: `The ${what} could not be reached.` }
}

/** The Prometheus HTTP API over a fetcher, sending `authorization` exactly as the caller sent it. */
export function httpQueryClient(fetcher: Fetcher, authorization: string, base = 'https://query.internal'): QueryClient {
  async function call<T>(method: 'GET' | 'POST', path: string, params: URLSearchParams, opts: QueryOptions = {}): Promise<Result<T>> {
    // A number of seconds, which the query service parses as Prometheus does.
    if (opts.timeout !== undefined) params.set('timeout', String(Number(Math.max(0.001, opts.timeout).toFixed(3))))
    const url = method === 'GET' ? `${base}${path}?${params}` : `${base}${path}`
    const init: RequestInit = { method, headers: { Authorization: authorization, Accept: 'application/json' }, signal: opts.signal ?? null }
    if (method === 'POST') {
      init.body = params.toString()
      ;(init.headers as Record<string, string>)['Content-Type'] = 'application/x-www-form-urlencoded'
    }
    let res: Response
    let body: unknown
    try {
      res = await fetcher.fetch(new Request(url, init))
      body = await readJson(res)
    } catch (e) {
      return unreachable('query service', e)
    }
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      if (k.startsWith('x-viz-')) headers[k] = v
    })
    const env = body as { status?: string; data?: T; warnings?: unknown; errorType?: unknown; error?: unknown } | null
    if (res.ok && env?.status === 'success') {
      return { ok: true, data: env.data as T, warnings: Array.isArray(env.warnings) ? env.warnings.map(String) : [], headers }
    }
    return {
      ok: false,
      status: res.status,
      errorType: typeof env?.errorType === 'string' ? env.errorType : res.status === 401 ? 'unauthorized' : 'error',
      error: typeof env?.error === 'string' ? env.error : `The query service answered ${res.status}.`,
    }
  }
  const range = (p: URLSearchParams, o?: RangeOptions) => {
    if (o?.start !== undefined) p.set('start', String(o.start))
    if (o?.end !== undefined) p.set('end', String(o.end))
    return p
  }
  const matches = (match: string[]) => {
    const p = new URLSearchParams()
    for (const m of match) p.append('match[]', m)
    return p
  }
  return {
    instant: (expr, time, opts) => call('POST', '/api/v1/query', new URLSearchParams({ query: expr, time: String(time) }), opts),
    range: (expr, start, end, step, opts) => call('POST', '/api/v1/query_range', new URLSearchParams({ query: expr, start: String(start), end: String(end), step: String(step) }), opts),
    labelNames: (match, opts) => call('GET', '/api/v1/labels', range(matches(match), opts), opts),
    labelValues: (name, match, opts) => call('GET', `/api/v1/label/${encodeURIComponent(name)}/values`, range(matches(match), opts), opts),
    series: (match, opts) => call('GET', '/api/v1/series', range(matches(match), opts), opts),
    metadata: (metric, opts) => call('GET', '/api/v1/metadata', new URLSearchParams(metric ? { metric } : {}), opts),
  }
}

// ---- control plane ----

export interface ControlResponse {
  status: number
  body: any
}

export interface ControlClient {
  call(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, opts?: { query?: Record<string, string | string[] | undefined>; body?: unknown }): Promise<ControlResponse>
}

export const CONTROL_PREFIX = '/api/v1/control'

/** The control plane's HTTP API over a fetcher, with the caller's own credential. */
export function httpControlClient(fetcher: Fetcher, authorization: string, base = 'https://control.internal'): ControlClient {
  return {
    async call(method, path, opts = {}) {
      const q = new URLSearchParams()
      for (const [k, v] of Object.entries(opts.query ?? {})) {
        if (v === undefined) continue
        for (const x of Array.isArray(v) ? v : [v]) q.append(k, x)
      }
      const qs = q.toString()
      const headers: Record<string, string> = { Authorization: authorization, Accept: 'application/json' }
      const init: RequestInit = { method, headers }
      if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json'
        init.body = JSON.stringify(opts.body)
      }
      try {
        const res = await fetcher.fetch(new Request(`${base}${CONTROL_PREFIX}${path}${qs ? `?${qs}` : ''}`, init))
        return { status: res.status, body: await readJson(res) }
      } catch (e) {
        const u = unreachable('control plane', e)
        return { status: u.status, body: { code: u.errorType, detail: u.error, fix: 'Retry in a moment.' } }
      }
    },
  }
}

// ---- monitors (the ruler's HTTP API) ----

/** What this surface reads of a monitor. A subset of the ruler's proposed `MonitorView` (ruler/contracts-proposal/rules.v2.ts). */
export interface MonitorView {
  id: string
  name: string
  group?: string
  state: 'firing' | 'pending' | 'ok' | 'no_data' | 'error' | 'unknown'
  firingSince: number | null
  activeAt?: number | null
  value: number | null
  thresholdText: string | null
  expr: string
  query?: string | null
  forMs?: number
  intervalMs?: number
  description?: string
  message?: string
  runbookUrl?: string
  owner?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  health?: 'ok' | 'err' | 'unknown'
  lastError?: string | null
  lastEvaluationMs?: number | null
  silencedUntil?: number | null
  acknowledged?: { by: string; at: number } | null
  alerts?: { fingerprint: string; labels: Record<string, string>; state: 'pending' | 'firing'; activeAt: number; firingSince: number | null; value: number }[]
}

export interface MonitorList {
  monitors: MonitorView[]
  counts?: Record<string, number>
  total?: number
}

export interface MonitorDetail {
  monitor: MonitorView
  history?: { entries: { at: number; kind?: string; [k: string]: unknown }[]; dropped: number }
}

export type MonitorResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string }

export interface MonitorsClient {
  list(filter?: 'all' | 'attention' | 'silenced'): Promise<MonitorResult<MonitorList>>
  get(id: string): Promise<MonitorResult<MonitorDetail>>
}

export function httpMonitorsClient(fetcher: Fetcher, authorization: string, base = 'https://ruler.internal'): MonitorsClient {
  async function get<T>(path: string): Promise<MonitorResult<T>> {
    try {
      const res = await fetcher.fetch(new Request(`${base}${path}`, { headers: { Authorization: authorization, Accept: 'application/json' } }))
      const body = (await readJson(res)) as { error?: { message?: unknown } | string } | null
      if (res.ok) return { ok: true, data: body as T }
      const err = body?.error
      return { ok: false, status: res.status, error: typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : `The ruler answered ${res.status}.` }
    } catch (e) {
      const u = unreachable('ruler', e)
      return { ok: false, status: u.status, error: u.error }
    }
  }
  return {
    list: (filter = 'all') => get(`/api/v1/monitors?filter=${encodeURIComponent(filter)}`),
    get: (id) => get(`/api/v1/monitors/${encodeURIComponent(id)}`),
  }
}
