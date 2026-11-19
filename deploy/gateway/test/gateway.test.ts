import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import control from '../../../control/src/index'
import { type Env, ENTRYPOINTS, HEALTH_PATHS, handle, routeOf } from '../src/index'

const BASE = 'https://vis.bitcru.sh'
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${BASE}${path}`, init))

interface Echo {
  backend: string
  method: string
  url: string
  headers: Record<string, string>
  bodyBytes: number
  bodySha256: string
}

const sha256 = async (b: Uint8Array<ArrayBuffer>): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('')

describe('routing', () => {
  const table: [string, string][] = [
    ['/api/v1/write', 'ingest'],
    ['/api/v1/push', 'ingest'],
    ['/v1/metrics', 'ingest'],
    ['/api/v1/query', 'query'],
    ['/api/v1/query_range', 'query'],
    ['/api/v1/labels', 'query'],
    ['/api/v1/label/job/values', 'query'],
    ['/api/v1/label/a%2Fb/values', 'query'],
    ['/api/v1/series', 'query'],
    ['/api/v1/metadata', 'query'],
    ['/api/v1/status/buildinfo', 'query'],
    ['/api/v1/control', 'control'],
    ['/api/v1/control/keys', 'control'],
    ['/api/v1/control/dashboards/d1/revisions/3', 'control'],
  ]

  it.each(table)('%s goes to %s, with x-viz-route', async (path, backend) => {
    const res = await call(`${path}?a=1&b=two`, { method: 'POST', body: 'x' })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-viz-route')).toBe(backend)
    expect(res.headers.get('x-fake-backend')).toBe(backend)
    const seen = (await res.json()) as Echo
    expect(seen.backend).toBe(backend)
    // The backend sees the public URL, path and query string untouched.
    expect(seen.url).toBe(`${BASE}${path}?a=1&b=two`)
  })

  const notFound = ['/', '/index.html', '/api', '/api/v1', '/api/v1/query_exemplars', '/api/v1/write/', '/api/v1/controls', '/api/v1/label', '/v1/logs', '/healthz/x', '/app']
  it.each(notFound)('%s is a JSON 404 listing the entry points, not a page', async (path) => {
    const res = await call(path)
    expect(res.status).toBe(404)
    expect(res.headers.get('x-viz-route')).toBe('gateway')
    expect(res.headers.get('Content-Type')).toMatch(/^application\/json/)
    expect(res.headers.get('x-fake-backend')).toBeNull()
    const body = (await res.json()) as { entrypoints: typeof ENTRYPOINTS }
    expect(body.entrypoints).toEqual(ENTRYPOINTS)
  })

  it('routeOf agrees with the table and never routes an unknown path', () => {
    for (const [path, backend] of table) expect(routeOf(path.split('?')[0]!)).toBe(backend)
    for (const path of notFound) expect(routeOf(path)).toBeNull()
    expect(routeOf('/healthz')).toBe('health')
    expect(routeOf('/api/v1/bootstrap')).toBe('bootstrap')
  })
})

describe('transparency', () => {
  it('passes method, headers and body through byte for byte', async () => {
    const body = new Uint8Array(3 * 1024 * 1024 + 17)
    for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) & 0xff
    const res = await call('/api/v1/write', {
      method: 'POST',
      body,
      headers: {
        Authorization: 'Bearer viz_abc_secretsecret',
        'Content-Encoding': 'snappy',
        'Content-Type': 'application/x-protobuf',
        'X-Prometheus-Remote-Write-Version': '0.1.0',
        'X-Custom': 'kept',
      },
    })
    const seen = (await res.json()) as Echo
    expect(seen.method).toBe('POST')
    expect(seen.bodyBytes).toBe(body.length)
    expect(seen.bodySha256).toBe(await sha256(body))
    expect(seen.headers['authorization']).toBe('Bearer viz_abc_secretsecret')
    expect(seen.headers['content-encoding']).toBe('snappy')
    expect(seen.headers['content-type']).toBe('application/x-protobuf')
    expect(seen.headers['x-prometheus-remote-write-version']).toBe('0.1.0')
    expect(seen.headers['x-custom']).toBe('kept')
  })

  it('streams a request body that is still being written', async () => {
    const ts = new TransformStream<Uint8Array, Uint8Array>()
    const w = ts.writable.getWriter()
    const parts = [new TextEncoder().encode('part-one;'), new TextEncoder().encode('part-two')]
    void (async () => {
      for (const p of parts) {
        await w.write(p)
        await new Promise((r) => setTimeout(r, 50))
      }
      await w.close()
    })()
    const res = await call('/v1/metrics', { method: 'POST', body: ts.readable, duplex: 'half' } as RequestInit)
    const seen = (await res.json()) as Echo
    expect(seen.bodyBytes).toBe(17)
    expect(seen.bodySha256).toBe(await sha256(new TextEncoder().encode('part-one;part-two')))
  })

  it.each([200, 201, 204, 400, 401, 404, 413, 415, 422, 429, 500, 503])('keeps status %i, its status text and every header', async (code) => {
    const res = await call(`/api/v1/status/__fake/status?code=${code}`)
    expect(res.status).toBe(code)
    expect(res.statusText).toBe(`Fake ${code}`)
    expect(res.headers.get('Retry-After')).toBe('7')
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="viz"')
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/'])
    expect(res.headers.get('x-viz-route')).toBe('query')
    if (code !== 204) expect(await res.text()).toBe(`status ${code}`)
  })

  it('streams the response: the first chunk arrives before the backend has finished', async () => {
    const start = Date.now()
    const res = await call('/api/v1/control/__fake/stream')
    expect(res.headers.get('x-viz-route')).toBe('control')
    const reader = res.body!.getReader()
    const first = await reader.read()
    const firstAt = Date.now() - start
    expect(new TextDecoder().decode(first.value)).toBe('first;')
    // The backend waits 600 ms before its second chunk; a buffering gateway would hold the first.
    expect(firstAt).toBeLessThan(450)
    let rest = ''
    for (;;) {
      const r = await reader.read()
      if (r.done) break
      rest += new TextDecoder().decode(r.value)
    }
    expect(rest).toBe('second')
    expect(Date.now() - start).toBeGreaterThanOrEqual(550)
  })

  it('a backend that throws gives a retryable 502, not a gateway crash', async () => {
    const res = await call('/api/v1/label/__fake/throw')
    expect(res.status).toBe(502)
    expect(res.headers.get('Retry-After')).toBe('1')
    expect(res.headers.get('x-viz-route')).toBe('query')
  })
})

describe('health', () => {
  it('is healthy when every backend answers its health route', async () => {
    const res = await call('/healthz')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-viz-route')).toBe('health')
    const body = (await res.json()) as { status: string; release: string; backends: Record<string, { ok: boolean; status: number }> }
    expect(body.status).toBe('healthy')
    expect(body.release).toBe('test')
    expect(Object.keys(body.backends).sort()).toEqual(['control', 'ingest', 'query'])
    for (const b of Object.values(body.backends)) expect(b).toMatchObject({ ok: true, status: 200 })
  })

  it('is unhealthy (503) and names the backend when one fails or throws', async () => {
    const down = { fetch: async () => new Response('down', { status: 500 }) } as unknown as Fetcher
    const throws = { fetch: async () => { throw new Error('gone') } } as unknown as Fetcher
    for (const [name, bad] of [['ingest', down], ['control', throws]] as const) {
      const e = { ...env, [name.toUpperCase()]: bad } as unknown as Env
      const res = await handle(new Request(`${BASE}/healthz`), e)
      expect(res.status).toBe(503)
      const body = (await res.json()) as { status: string; backends: Record<string, { ok: boolean }> }
      expect(body.status).toBe('unhealthy')
      expect(body.backends[name]!.ok).toBe(false)
      for (const other of ['ingest', 'query', 'control'].filter((n) => n !== name)) expect(body.backends[other]!.ok).toBe(true)
    }
  })

  it('asks each backend its own /healthz; control\'s is control\'s real route, which fails when a binding of its is missing', async () => {
    expect(HEALTH_PATHS).toEqual({ ingest: '/healthz', query: '/healthz', control: '/healthz' })
    const asked: string[] = []
    const recording = { fetch: (req: Request) => (asked.push(new URL(req.url).pathname), env.CONTROL.fetch(req)) } as unknown as Fetcher
    const res = await handle(new Request(`${BASE}/healthz`), { ...env, CONTROL: recording } as unknown as Env)
    expect(res.status).toBe(200)
    expect(asked).toEqual(['/healthz'])
    // control's own route answers (control/src/index.ts, run here on this Worker's bindings), without a credential
    const direct = await env.CONTROL.fetch(new Request('https://gateway.internal/healthz'))
    expect([direct.status, await direct.text()]).toEqual([200, 'ok\n'])
    // and it is not the OpenAPI document any more: the old probe would have needed none of control's bindings
    const misconfigured = await control.fetch!(new Request('https://gateway.internal/healthz') as never, { ...env, TENANT: undefined } as never, {} as ExecutionContext)
    expect(misconfigured.status).toBe(503)
    const broken = { fetch: (req: Request) => control.fetch!(req as never, { ...env, TENANT: undefined } as never, {} as ExecutionContext) } as unknown as Fetcher
    const unhealthy = await handle(new Request(`${BASE}/healthz`), { ...env, CONTROL: broken } as unknown as Env)
    expect(unhealthy.status).toBe(503)
    const body = (await unhealthy.json()) as { backends: Record<string, { ok: boolean; status: number }> }
    expect(body.backends.control).toMatchObject({ ok: false, status: 503 })
  })

  it('refuses methods other than GET and HEAD', async () => {
    expect((await call('/healthz', { method: 'POST' })).status).toBe(405)
    expect((await call('/healthz', { method: 'HEAD' })).status).toBe(200)
  })
})
