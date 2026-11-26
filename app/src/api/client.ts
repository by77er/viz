import type {
  ApiCost,
  ApiResult,
  BuildInfo,
  Identity,
  Metric,
  MetricMetadata,
  PromEnvelope,
  PromMatrixData,
  PromQueryData,
} from './types'
import { MatrixParser, NotAMatrix, type ParsedMatrix } from './matrix'
import type { WorkerReply } from './matrixWorker'

/** An error reported by the API, or a transport failure, in one shape the UI can render. */
export class PromApiError extends Error {
  /** Prometheus `errorType` ("bad_data", "execution", "timeout", ...) or "network" / "http" / "parse". */
  readonly errorType: string
  /** HTTP status, or 0 when no response was received. */
  readonly status: number
  /** How long the API asked the client to wait before trying again (`Retry-After`), or null when it did not say. */
  readonly retryAfterMs: number | null

  constructor(errorType: string, message: string, status: number, retryAfterMs: number | null = null) {
    super(message)
    this.name = 'PromApiError'
    this.errorType = errorType
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/** `Retry-After` as milliseconds: a number of seconds, or an HTTP date (RFC 9110 §10.2.3). Null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null
  const v = value.trim()
  if (/^\d+$/.test(v)) return Number(v) * 1000
  // An HTTP date names its day and month ("Wed, 18 Nov 2026 12:00:07 GMT"); "-5" is not one.
  const at = /[A-Za-z]/.test(v) ? Date.parse(v) : NaN
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

/** The `X-Viz-*` headers of a response (names in lower case). */
export function costOf(headers: Headers): ApiCost {
  const cost: ApiCost = {}
  headers.forEach((value, name) => {
    if (name.startsWith('x-viz-') && name !== 'x-viz-route' && name !== 'x-viz-mock') cost[name] = value
  })
  return cost
}

export interface PromClientOptions {
  /** e.g. `https://viz.example.com` or empty for same origin. A trailing slash is ignored. */
  baseUrl?: string
  /** Sent as `Authorization: Bearer <token>`. Never placed in a URL. */
  token?: string
  /** Injectable for tests. */
  fetch?: typeof fetch
  /**
   * A worker running api/matrixWorker.ts: range queries for the Explore view are then fetched
   * and read there, off the main thread. Without one they are read on the main thread.
   */
  matrixWorker?: () => Worker
}

export interface RequestOptions {
  signal?: AbortSignal
}

/** A range query read into typed arrays (`queryRangeMatrix`). */
export interface MatrixResult {
  matrix: ParsedMatrix
  warnings: string[]
  infos: string[]
  cost: ApiCost
}

export class PromClient {
  readonly baseUrl: string
  private readonly token: string
  private readonly fetchFn: typeof fetch
  private readonly makeWorker: (() => Worker) | undefined
  private worker: Worker | null = null
  private nextId = 1
  private readonly waiting = new Map<number, (reply: WorkerReply) => void>()

  constructor(opts: PromClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? '').trim().replace(/\/+$/, '')
    this.token = (opts.token ?? '').trim()
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init))
    this.makeWorker = opts.matrixWorker
  }

  /** The range query through the worker: the same answers and errors as on the main thread. */
  private async viaWorker(form: string, opts?: RequestOptions): Promise<MatrixResult> {
    if (!this.worker) {
      this.worker = this.makeWorker!()
      this.worker.onmessage = (e: MessageEvent<WorkerReply>) => this.waiting.get(e.data.id)?.(e.data)
    }
    const worker = this.worker
    const id = this.nextId++
    const headers: [string, string][] = [['Accept', 'application/json'], ['Content-Type', 'application/x-www-form-urlencoded']]
    if (this.token) headers.push(['Authorization', `Bearer ${this.token}`])
    const url = new URL(this.baseUrl + '/api/v1/query_range', location.href).toString()
    const reply = await new Promise<WorkerReply>((resolve, reject) => {
      const onAbort = () => {
        this.waiting.delete(id)
        worker.postMessage({ id, abort: true })
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      }
      if (opts?.signal?.aborted) return onAbort()
      opts?.signal?.addEventListener('abort', onAbort, { once: true })
      this.waiting.set(id, (r) => {
        this.waiting.delete(id)
        opts?.signal?.removeEventListener('abort', onAbort)
        resolve(r)
      })
      worker.postMessage({ id, url, headers, body: form })
    })
    if (reply.kind === 'error') {
      if (reply.name === 'AbortError') throw new DOMException(reply.message, 'AbortError')
      throw new PromApiError('network', `Cannot reach ${this.baseUrl || 'the API'}: ${reply.message}`, 0)
    }
    const res = new Response(null, { status: reply.status, headers: reply.headers })
    if (reply.kind === 'response') {
      this.read<unknown>(new Response(null, { status: reply.status, statusText: reply.statusText, headers: reply.headers }), reply.text)
      throw new PromApiError('parse', 'The response is not a range-query matrix', reply.status)
    }
    const text = reply.text
    const series = reply.series.map((s) => {
      const range = s.range
      return { metric: s.metric, times: s.times, values: s.values, valuesRange: range, valuesText: range ? () => text.slice(range[0], range[1]) : () => s.json ?? '[]' }
    })
    const matrix: ParsedMatrix = { series, warnings: reply.warnings, infos: reply.infos, text, fast: reply.fast }
    return { matrix, warnings: matrix.warnings, infos: matrix.infos, cost: costOf(res.headers) }
  }

  /** Range query. Times are epoch seconds; step is seconds. */
  queryRange(
    query: string,
    start: number,
    end: number,
    step: number,
    opts?: RequestOptions,
  ): Promise<ApiResult<PromMatrixData>> {
    return this.post<PromMatrixData>(
      '/api/v1/query_range',
      { query, start: String(start), end: String(end), step: String(step) },
      opts,
    )
  }

  /** Instant query at `time` (epoch seconds; server time when omitted). */
  query(query: string, time?: number, opts?: RequestOptions): Promise<ApiResult<PromQueryData>> {
    const params: Record<string, string> = { query }
    if (time !== undefined) params.time = String(time)
    return this.post<PromQueryData>('/api/v1/query', params, opts)
  }

  async labels(params: { match?: string[]; start?: number; end?: number } = {}, opts?: RequestOptions): Promise<string[]> {
    return (await this.get<string[]>('/api/v1/labels', matchParams(params), opts)).data
  }

  async labelValues(
    name: string,
    params: { match?: string[]; start?: number; end?: number } = {},
    opts?: RequestOptions,
  ): Promise<string[]> {
    return (await this.get<string[]>(`/api/v1/label/${encodeURIComponent(name)}/values`, matchParams(params), opts)).data
  }

  async series(match: string[], params: { start?: number; end?: number } = {}, opts?: RequestOptions): Promise<Metric[]> {
    return (await this.get<Metric[]>('/api/v1/series', matchParams({ ...params, match }), opts)).data
  }

  async metadata(opts?: RequestOptions): Promise<Record<string, MetricMetadata[]>> {
    return (await this.get<Record<string, MetricMetadata[]>>('/api/v1/metadata', [], opts)).data
  }

  async buildInfo(opts?: RequestOptions): Promise<BuildInfo> {
    return (await this.get<BuildInfo>('/api/v1/status/buildinfo', [], opts)).data
  }

  /**
   * Who the API key is: control's `GET /api/v1/control/whoami`, which any valid key may ask
   * whatever its scopes. It is not a Prometheus endpoint and answers no envelope: the identity
   * itself, or a problem with an HTTP status (401 for a key that is missing, unknown, disabled
   * or expired).
   */
  async whoami(opts?: RequestOptions): Promise<Identity> {
    const res = await this.send('/api/v1/control/whoami', { method: 'GET' }, opts)
    const text = await res.text()
    if (!res.ok) throw new PromApiError('http', `HTTP ${res.status}`, res.status, parseRetryAfter(res.headers.get('Retry-After')))
    let v: Partial<Identity> | undefined
    try {
      v = JSON.parse(text) as Partial<Identity>
    } catch {
      v = undefined
    }
    if (!v || typeof v.tenant !== 'string' || !Array.isArray(v.scopes)) throw new PromApiError('parse', 'The answer is not an identity', res.status)
    return {
      tenant: v.tenant,
      subject: typeof v.subject === 'string' ? v.subject : '',
      kind: typeof v.kind === 'string' ? v.kind : 'key',
      name: typeof v.name === 'string' ? v.name : null,
      scopes: v.scopes.filter((x): x is string => typeof x === 'string'),
      ...(v.mock === true ? { mock: true } : {}),
    }
  }

  private get<T>(path: string, params: [string, string][], opts?: RequestOptions): Promise<ApiResult<T>> {
    const qs = new URLSearchParams(params).toString()
    return this.request<T>(path + (qs ? `?${qs}` : ''), { method: 'GET' }, opts)
  }

  private post<T>(path: string, params: Record<string, string>, opts?: RequestOptions): Promise<ApiResult<T>> {
    return this.request<T>(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      },
      opts,
    )
  }

  /**
   * Range query, read into typed arrays as the body arrives (api/matrix.ts) instead of
   * `JSON.parse`: what the Explore view uses. Errors, and any answer that is not a matrix,
   * are reported exactly as `queryRange` reports them.
   */
  async queryRangeMatrix(query: string, start: number, end: number, step: number, opts?: RequestOptions): Promise<MatrixResult> {
    if (this.makeWorker) return this.viaWorker(new URLSearchParams({ query, start: String(start), end: String(end), step: String(step) }).toString(), opts)
    const res = await this.send(
      '/api/v1/query_range',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ query, start: String(start), end: String(end), step: String(step) }).toString(),
      },
      opts,
    )
    if (!res.ok || !res.body) {
      // An error (or an empty body): read and reported as any other answer is; a success here is not a matrix.
      this.read<unknown>(res, await res.text())
      throw new PromApiError('parse', 'The response is not a range-query matrix', res.status)
    }
    const parser = new MatrixParser()
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parser.push(value)
    }
    try {
      const matrix = parser.finish()
      return { matrix, warnings: matrix.warnings, infos: matrix.infos, cost: costOf(res.headers) }
    } catch (e) {
      if (!(e instanceof NotAMatrix)) throw e
      // Not a matrix: an error envelope (with HTTP 200), another result type, or not JSON.
      const body = e.body as PromEnvelope<unknown> | undefined
      if (body && typeof body === 'object' && body.status === 'error') throw new PromApiError(body.errorType || 'error', body.error || `HTTP ${res.status}`, res.status)
      throw new PromApiError('parse', body && typeof body === 'object' && body.status === 'success' ? 'The response is not a range-query matrix' : 'The response is not a Prometheus API envelope', res.status)
    }
  }

  private async send(path: string, init: RequestInit, opts?: RequestOptions): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`)
    try {
      return await this.fetchFn(this.baseUrl + path, { ...init, headers, signal: opts?.signal })
    } catch (err) {
      // Aborts propagate unchanged so callers (TanStack Query) can tell them from failures.
      if (isAbort(err) || opts?.signal?.aborted) throw err
      throw new PromApiError('network', `Cannot reach ${this.baseUrl || 'the API'}: ${errorMessage(err)}`, 0)
    }
  }

  private async request<T>(path: string, init: RequestInit, opts?: RequestOptions): Promise<ApiResult<T>> {
    const res = await this.send(path, init, opts)
    return this.read<T>(res, await res.text())
  }

  /** An answer as an envelope: its data, or the error it reports, or why it is not one. */
  private read<T>(res: Response, text: string): ApiResult<T> {
    let body: PromEnvelope<T> | undefined
    try {
      body = text ? (JSON.parse(text) as PromEnvelope<T>) : undefined
    } catch {
      body = undefined
    }

    const retryAfter = parseRetryAfter(res.headers.get('Retry-After'))
    // Prometheus sends the error envelope with 4xx/5xx statuses; prefer its message.
    if (body && typeof body === 'object' && body.status === 'error') {
      throw new PromApiError(body.errorType || 'error', body.error || `HTTP ${res.status}`, res.status, retryAfter)
    }
    if (!res.ok) {
      // No envelope: a proxy, a rate limit or the platform answered (HTML, plain text or nothing).
      const hint = res.status === 401 || res.status === 403 ? ' (sign in with an API key that has the read scope)' : ''
      throw new PromApiError('http', `HTTP ${res.status} ${res.statusText}${hint}`.replace(/\s+/g, ' ').trim(), res.status, retryAfter)
    }
    if (!body || typeof body !== 'object' || body.status !== 'success') {
      throw new PromApiError('parse', 'The response is not a Prometheus API envelope', res.status)
    }
    return { data: body.data, warnings: body.warnings ?? [], infos: body.infos ?? [], cost: costOf(res.headers) }
  }
}

function matchParams(p: { match?: string[]; start?: number; end?: number }): [string, string][] {
  const out: [string, string][] = []
  for (const m of p.match ?? []) out.push(['match[]', m])
  if (p.start !== undefined) out.push(['start', String(p.start)])
  if (p.end !== undefined) out.push(['end', String(p.end)])
  return out
}

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
