import type {
  ApiCost,
  ApiResult,
  BuildInfo,
  Metric,
  MetricMetadata,
  PromEnvelope,
  PromMatrixData,
  PromQueryData,
} from './types'
import { MatrixParser, NotAMatrix, type ParsedMatrix } from './matrix'

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

  constructor(opts: PromClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? '').trim().replace(/\/+$/, '')
    this.token = (opts.token ?? '').trim()
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init))
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
      const hint = res.status === 401 || res.status === 403 ? ' (check the API token in Settings)' : ''
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
