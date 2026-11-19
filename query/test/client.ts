/**
 * A small Prometheus HTTP API client for the tests: what a dashboard or an agent does
 * with the API (GET with query parameters, a bearer key, the `{status, data}` envelope,
 * errors as `PromApiError`). Written from the Prometheus HTTP API documentation, not from
 * the Worker, and kept here so the tests need nothing outside `query/` (the app's client
 * lived in `app/`, which is not on `main`).
 */
export class PromApiError extends Error {
  override name = 'PromApiError'
  constructor(
    readonly status: number,
    readonly errorType: string,
    message: string,
  ) {
    super(message)
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface Metric {
  [label: string]: string
}

export class PromClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchFn: Fetch

  constructor(opts: { baseUrl: string; token: string; fetch: Fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.token = opts.token
    this.fetchFn = opts.fetch
  }

  private async get<T>(path: string, params: [string, string][] = []): Promise<{ data: T; warnings: string[] }> {
    const qs = new URLSearchParams(params).toString()
    const res = await this.fetchFn(`${this.baseUrl}${path}${qs ? `?${qs}` : ''}`, { headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' } })
    let body: { status?: string; data?: T; errorType?: string; error?: string; warnings?: string[] }
    try {
      body = await res.json()
    } catch {
      throw new PromApiError(res.status, 'bad_response', `HTTP ${res.status}: not JSON`)
    }
    if (body.status !== 'success') throw new PromApiError(res.status, body.errorType ?? 'unknown', body.error ?? `HTTP ${res.status}`)
    return { data: body.data as T, warnings: body.warnings ?? [] }
  }

  queryRange(query: string, start: number, end: number, step: number) {
    return this.get<{ resultType: 'matrix'; result: { metric: Metric; values: [number, string][] }[] }>('/api/v1/query_range', [
      ['query', query],
      ['start', String(start)],
      ['end', String(end)],
      ['step', String(step)],
    ])
  }

  query(query: string, time?: number) {
    return this.get<{ resultType: string; result: unknown }>('/api/v1/query', time === undefined ? [['query', query]] : [['query', query], ['time', String(time)]])
  }

  private static window(p: { match?: string[]; start?: number; end?: number }): [string, string][] {
    const out: [string, string][] = (p.match ?? []).map((m) => ['match[]', m])
    if (p.start !== undefined) out.push(['start', String(p.start)])
    if (p.end !== undefined) out.push(['end', String(p.end)])
    return out
  }

  async labels(p: { match?: string[]; start?: number; end?: number } = {}): Promise<string[]> {
    return (await this.get<string[]>('/api/v1/labels', PromClient.window(p))).data
  }

  async labelValues(name: string, p: { match?: string[]; start?: number; end?: number } = {}): Promise<string[]> {
    return (await this.get<string[]>(`/api/v1/label/${encodeURIComponent(name)}/values`, PromClient.window(p))).data
  }

  async series(match: string[], p: { start?: number; end?: number } = {}): Promise<Metric[]> {
    return (await this.get<Metric[]>('/api/v1/series', PromClient.window({ match, ...p }))).data
  }

  async metadata(): Promise<Record<string, unknown[]>> {
    return (await this.get<Record<string, unknown[]>>('/api/v1/metadata')).data
  }

  async buildInfo(): Promise<{ version: string }> {
    return (await this.get<{ version: string }>('/api/v1/status/buildinfo')).data
  }
}
