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
  const at = Date.parse(v)
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

  private async request<T>(path: string, init: RequestInit, opts?: RequestOptions): Promise<ApiResult<T>> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`)

    let res: Response
    try {
      res = await this.fetchFn(this.baseUrl + path, { ...init, headers, signal: opts?.signal })
    } catch (err) {
      // Aborts propagate unchanged so callers (TanStack Query) can tell them from failures.
      if (isAbort(err) || opts?.signal?.aborted) throw err
      throw new PromApiError('network', `Cannot reach ${this.baseUrl || 'the API'}: ${errorMessage(err)}`, 0)
    }

    const text = await res.text()
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
