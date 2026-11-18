import { describe, expect, it, vi } from 'vitest'
import { PromApiError, PromClient } from './client'
import { createMockApi } from '../../mock/handler'

function fakeFetch(status: number, body: string, statusText = '') {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(body, { status, statusText }))
}

describe('PromClient', () => {
  it('posts range queries form-encoded with a bearer token that never enters the URL', async () => {
    const f = fakeFetch(200, JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: [] }, warnings: ['w'] }))
    const c = new PromClient({ baseUrl: 'https://viz.example.com/', token: 's3cret', fetch: f })
    const r = await c.queryRange('up{a="b"}', 100, 200, 15)
    expect(r).toEqual({ data: { resultType: 'matrix', result: [] }, warnings: ['w'] })
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('https://viz.example.com/api/v1/query_range')
    expect(String(url)).not.toContain('s3cret')
    expect(init!.method).toBe('POST')
    expect(init!.body).toBe('query=up%7Ba%3D%22b%22%7D&start=100&end=200&step=15')
    expect(String(init!.body)).not.toContain('s3cret')
    expect(new Headers(init!.headers).get('Authorization')).toBe('Bearer s3cret')
  })

  it('sends no Authorization header without a token and encodes label names', async () => {
    const f = fakeFetch(200, JSON.stringify({ status: 'success', data: ['a'] }))
    const c = new PromClient({ fetch: f })
    await c.labelValues('weird/name', { match: ['up', '{job="x"}'] })
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('/api/v1/label/weird%2Fname/values?match%5B%5D=up&match%5B%5D=%7Bjob%3D%22x%22%7D')
    expect(new Headers(init!.headers).has('Authorization')).toBe(false)
  })

  it('surfaces the Prometheus error envelope (with a 4xx status)', async () => {
    const f = fakeFetch(400, JSON.stringify({ status: 'error', errorType: 'bad_data', error: 'invalid parameter "query": 1:5: parse error: unexpected end of input' }))
    const err = await new PromClient({ fetch: f }).query('sum(').catch((e) => e)
    expect(err).toBeInstanceOf(PromApiError)
    expect(err).toMatchObject({ errorType: 'bad_data', status: 400, message: 'invalid parameter "query": 1:5: parse error: unexpected end of input' })
  })

  it('surfaces an error envelope even with HTTP 200', async () => {
    const f = fakeFetch(200, JSON.stringify({ status: 'error', errorType: 'execution', error: 'boom' }))
    await expect(new PromClient({ fetch: f }).query('x')).rejects.toMatchObject({ errorType: 'execution', message: 'boom' })
  })

  it('reports non-JSON HTTP failures and hints at the token on 401', async () => {
    await expect(new PromClient({ fetch: fakeFetch(502, '<html>Bad Gateway</html>', 'Bad Gateway') }).labels()).rejects.toMatchObject({
      errorType: 'http',
      status: 502,
      message: 'HTTP 502 Bad Gateway',
    })
    const e = await new PromClient({ fetch: fakeFetch(401, '', 'Unauthorized') }).labels().catch((x) => x)
    expect(e.message).toContain('token')
  })

  it('rejects a 200 that is not an API envelope', async () => {
    await expect(new PromClient({ fetch: fakeFetch(200, '<html></html>') }).labels()).rejects.toMatchObject({ errorType: 'parse' })
    await expect(new PromClient({ fetch: fakeFetch(200, '{"hello":1}') }).labels()).rejects.toMatchObject({ errorType: 'parse' })
  })

  it('wraps network failures', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(new PromClient({ baseUrl: 'http://x', fetch: f as unknown as typeof fetch }).labels()).rejects.toMatchObject({
      errorType: 'network',
      status: 0,
      message: 'Cannot reach http://x: Failed to fetch',
    })
  })

  it('passes the AbortSignal through and lets aborts propagate unchanged', async () => {
    const ac = new AbortController()
    const f = vi.fn(
      (_i: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init!.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
        }),
    )
    const p = new PromClient({ fetch: f }).queryRange('up', 0, 1, 1, { signal: ac.signal })
    ac.abort()
    const e = await p.catch((x) => x)
    expect(e).not.toBeInstanceOf(PromApiError)
    expect(e.name).toBe('AbortError')
    expect(f.mock.calls[0]![1]!.signal).toBe(ac.signal)
  })

  it('works end to end against the mock backend', async () => {
    const api = createMockApi({ requireToken: 'tok' })
    const c = new PromClient({ baseUrl: 'http://mock', token: 'tok', fetch: api.fetch })
    expect((await c.buildInfo()).mock).toBe(true)
    expect(await c.labelValues('service')).toEqual(['auth', 'catalog', 'checkout', 'orders'])
    expect((await c.series(['up{service="auth"}'])).length).toBe(3)
    const r = await c.queryRange('sum by (service) (rate(http_requests_total[5m]))', 1795000000, 1795000600, 60)
    expect(r.data.result.length).toBe(4)
    expect(r.data.result[0]!.values.length).toBe(11)
    await expect(c.queryRange('sum by (', 1795000000, 1795000600, 60)).rejects.toMatchObject({ errorType: 'bad_data', status: 400 })
    await expect(new PromClient({ baseUrl: 'http://mock', token: 'wrong', fetch: api.fetch }).labels()).rejects.toMatchObject({ status: 401 })
  })
})
