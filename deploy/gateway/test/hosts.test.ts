// D75: viz.bitcru.sh is canonical; vis.bitcru.sh is kept for a transition. On vis the data paths
// are served as before, with Deprecation and Link headers; everything else is a 308 to viz.
// gateway/wrangler.test.jsonc sets PUBLIC_URL and VIZ_HOST_ALIASES as configure.mjs does in production.
import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { type Env, handle, hostAliases, isDataPath, routeOf } from '../src/index'

const VIZ = 'https://viz.bitcru.sh'
const VIS = 'https://vis.bitcru.sh'
const DEPRECATED = '@1795824000' // 2026-11-28T00:00:00Z, RFC 9745 §2.1 (a Structured Field Date)
/** `redirect: 'manual'`: the test sees the 308 itself (a fetch through the Worker's own entrypoint would follow it). */
const at = (origin: string, path: string, init?: RequestInit) => exports.default.fetch(new Request(`${origin}${path}`, { redirect: 'manual', ...init }))

interface Echo {
  backend: string
  method: string
  url: string
  headers: Record<string, string>
  bodyBytes: number
}

/** Data paths: ingest, the Prometheus/Tempo/Loki reads, and the ruler's Prometheus reads. */
const DATA: [string, string][] = [
  ['/api/v1/write', 'ingest'],
  ['/api/v1/push', 'ingest'],
  ['/v1/metrics', 'ingest'],
  ['/v1/traces', 'ingest'],
  ['/v1/logs', 'ingest'],
  ['/loki/api/v1/push', 'ingest'],
  ['/api/v1/query', 'query'],
  ['/api/v1/query_range', 'query'],
  ['/api/v1/labels', 'query'],
  ['/api/v1/label/job/values', 'query'],
  ['/api/v1/series', 'query'],
  ['/api/v1/metadata', 'query'],
  ['/api/v1/status/buildinfo', 'query'],
  ['/api/v1/plan', 'query'],
  ['/api/traces/0123456789abcdef0123456789abcdef', 'query'],
  ['/api/v2/traces/abc', 'query'],
  ['/api/search', 'query'],
  ['/api/search/tags', 'query'],
  ['/api/v2/search/tag/service.name/values', 'query'],
  ['/api/metrics/query_range', 'query'],
  ['/api/echo', 'query'],
  ['/loki/api/v1/query', 'query'],
  ['/loki/api/v1/query_range', 'query'],
  ['/loki/api/v1/labels', 'query'],
  ['/loki/api/v1/label/service_name/values', 'query'],
  ['/loki/api/v1/series', 'query'],
  ['/api/v1/rules', 'ruler'],
  ['/api/v1/alerts', 'ruler'],
]

/** Everything else: redirected on vis, the paths with no route included. */
const MOVED: string[] = [
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/token',
  '/oauth/revoke',
  '/mcp',
  '/api/v1/agent',
  '/api/v1/agent/tools/validate_query',
  '/api/v1/control',
  '/api/v1/control/keys',
  '/api/v1/control/openapi.json',
  '/api/v1/monitors',
  '/api/v1/monitors/mon_0123456789abcdef/acknowledge',
  '/healthz',
  '/api/v1/bootstrap',
  '/',
  '/index.html',
  '/api/v1/query_exemplars',
  '/.well-known/openid-configuration',
]

describe('vis.bitcru.sh (an alias): the data paths are served as before, with deprecation headers', () => {
  it.each(DATA)('%s is served by %s on vis, no redirect, with Deprecation and Link', async (path, backend) => {
    const res = await at(VIS, `${path}?a=1&b=two`, { method: 'POST', body: 'payload' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Location')).toBeNull()
    expect(res.headers.get('x-viz-route')).toBe(backend)
    expect(res.headers.get('x-fake-backend')).toBe(backend)
    expect(res.headers.get('Deprecation')).toBe(DEPRECATED)
    expect(res.headers.get('Link')).toBe(`<${VIZ}${path}>; rel="successor-version"`)
    const seen = (await res.json()) as Echo
    // The backend sees the request as it arrived: its host, path, query, method and body.
    expect([seen.backend, seen.method, seen.url, seen.bodyBytes]).toEqual([backend, 'POST', `${VIS}${path}?a=1&b=two`, 7])
  })

  it('a Remote Write on vis reaches ingest with its credential and headers, as on viz', async () => {
    const headers = { Authorization: 'Bearer viz_abc_secretsecret', 'Content-Encoding': 'snappy', 'Content-Type': 'application/x-protobuf', 'X-Prometheus-Remote-Write-Version': '0.1.0' }
    const res = await at(VIS, '/api/v1/write', { method: 'POST', body: new Uint8Array(4096), headers })
    const seen = (await res.json()) as Echo
    expect(res.status).toBe(200)
    expect([seen.headers.authorization, seen.headers['content-encoding'], seen.headers['x-prometheus-remote-write-version'], seen.bodyBytes]).toEqual(['Bearer viz_abc_secretsecret', 'snappy', '0.1.0', 4096])
  })

  it('the backend\'s own status and headers are kept; Link is added to, not replaced', async () => {
    const viaQuery = await handle(new Request(`${VIS}/api/v1/query`), { ...env, QUERY: { fetch: () => Promise.resolve(new Response('slow down', { status: 429, headers: { 'Retry-After': '7', Link: '</docs>; rel="help"' } })) } } as unknown as Env)
    expect(viaQuery.status).toBe(429)
    expect(viaQuery.headers.get('Retry-After')).toBe('7')
    expect(viaQuery.headers.get('Deprecation')).toBe(DEPRECATED)
    expect(viaQuery.headers.get('Link')).toBe(`</docs>; rel="help", <${VIZ}/api/v1/query>; rel="successor-version"`)
  })

  it('a backend that throws on vis still gives the retryable 502, with the deprecation headers', async () => {
    const res = await handle(new Request(`${VIS}/api/v1/write`, { method: 'POST', body: 'x' }), { ...env, INGEST: { fetch: () => Promise.reject(new Error('down')) } } as unknown as Env)
    expect([res.status, res.headers.get('Retry-After'), res.headers.get('Deprecation')]).toEqual([502, '1', DEPRECATED])
  })
})

describe('vis.bitcru.sh (an alias): everything else is a 308 to the same path and query on viz', () => {
  const methods = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  it.each(MOVED)('%s on vis: 308 to viz for every method, query kept, no backend asked', async (path) => {
    for (const method of methods) {
      const query = '?client_id=vzk1.a.b&redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcb&scope=read+dashboards%3Aread&state=x%2Fy&a=1&a=2'
      const res = await at(VIS, `${path}${query}`, { method, ...(method === 'POST' || method === 'PUT' ? { body: '{"x":1}' } : {}) })
      // 308, never 301/302 (a client may turn POST into GET) nor 307 (temporary).
      expect(res.status, `${method} ${path}`).toBe(308)
      expect(res.headers.get('Location'), `${method} ${path}`).toBe(`${VIZ}${path}${query}`)
      expect(res.headers.get('x-fake-backend')).toBeNull()
      expect(res.headers.get('x-viz-route')).toBe('redirect')
      // Not cached: a rollback to a release before D75 serves vis again.
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      await res.body?.cancel()
    }
  })

  it('OAuth is never answered on vis: no metadata names vis, and nothing is registered there', async () => {
    const meta = await at(VIS, '/.well-known/oauth-authorization-server')
    expect(meta.status).toBe(308)
    const text = await meta.text()
    expect(text).not.toMatch(/"issuer"/)
    const reg = await at(VIS, '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: ['http://127.0.0.1:9/cb'] }) })
    expect([reg.status, reg.headers.get('Location')]).toEqual([308, `${VIZ}/oauth/register`])
  })

  it('a client that follows the 308 reaches the same backend on viz with the same method, body and query', async () => {
    for (const [method, path, backend] of [['POST', '/mcp', 'mcp'], ['PUT', '/api/v1/control/dashboards/d1', 'control'], ['DELETE', '/api/v1/monitors/mon_0123456789abcdef', 'ruler'], ['POST', '/oauth/token', 'control']] as const) {
      const res = await exports.default.fetch(new Request(`${VIS}${path}?q=1&r=%2F`, { method, body: method === 'DELETE' ? undefined : 'seven b', redirect: 'follow' }))
      expect(res.status, path).toBe(200)
      const seen = (await res.json()) as Echo
      expect([seen.backend, seen.method, seen.url, seen.bodyBytes], path).toEqual([backend, method, `${VIZ}${path}?q=1&r=%2F`, method === 'DELETE' ? 0 : 7])
    }
  })

  it('a path with no query redirects without one, and an empty query (?) is kept as sent', async () => {
    expect((await at(VIS, '/mcp', { method: 'POST' })).headers.get('Location')).toBe(`${VIZ}/mcp`)
    // URL.search is '' for a bare '?': nothing to keep.
    expect((await at(VIS, '/mcp?', { method: 'POST' })).headers.get('Location')).toBe(`${VIZ}/mcp`)
    expect((await at(VIS, '/api/v1/control/keys?x=%20y')).headers.get('Location')).toBe(`${VIZ}/api/v1/control/keys?x=%20y`)
  })
})

describe('viz.bitcru.sh (canonical) serves everything, without deprecation headers', () => {
  it.each([...DATA, ...MOVED.filter((p) => routeOf(p) !== null && routeOf(p) !== 'health' && routeOf(p) !== 'bootstrap').map((p) => [p, routeOf(p)!] as [string, string])])('%s on viz is served by %s', async (path, backend) => {
    const res = await at(VIZ, `${path}?a=1`, { method: 'POST', body: 'x' })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-viz-route')).toBe(backend)
    expect(res.headers.get('Deprecation')).toBeNull()
    expect(res.headers.get('Link')).toBeNull()
    expect(((await res.json()) as Echo).url).toBe(`${VIZ}${path}?a=1`)
  })

  it('/healthz, an unknown path and bootstrap (without its secret) answer on viz as before', async () => {
    expect((await at(VIZ, '/healthz')).status).toBe(200)
    expect((await at(VIZ, '/index.html')).status).toBe(404)
    expect((await at(VIZ, '/api/v1/bootstrap', { method: 'POST' })).status).toBe(404)
  })
})

describe('other hosts and configuration', () => {
  it('a host that is neither (a test, a stage\'s workers.dev URL) is served as the canonical host', async () => {
    for (const origin of ['https://viz-trial-gateway.example.workers.dev', 'https://vis.bitcru.sh.evil.example', 'https://x.vis.bitcru.sh']) {
      const res = await at(origin, '/.well-known/oauth-authorization-server')
      expect([res.status, res.headers.get('x-viz-route'), res.headers.get('Deprecation')], origin).toEqual([200, 'control', null])
    }
  })

  it('no aliases configured (a stage, or a release from before D75): every host is served, nothing redirected', async () => {
    const plain = { ...env, VIZ_HOST_ALIASES: '[]' } as unknown as Env
    for (const path of ['/mcp', '/api/v1/write', '/.well-known/oauth-authorization-server']) {
      const res = await handle(new Request(`${VIS}${path}`, { method: 'POST', body: 'x' }), plain)
      expect([res.status, res.headers.get('Deprecation')], path).toEqual([200, null])
    }
    const none = { ...env, VIZ_HOST_ALIASES: undefined, PUBLIC_URL: undefined } as unknown as Env
    expect((await handle(new Request(`${VIS}/oauth/token`, { method: 'POST' }), none)).status).toBe(200)
  })

  it('unreadable aliases or a PUBLIC_URL that is no origin: a host that may be an alias gets 500, not a guess; the canonical host is served', async () => {
    for (const bad of ['not json', '{"host":"vis.bitcru.sh"}', '[{"host":"vis.bitcru.sh"}]', '[{"host":"VIS.bitcru.sh/x","deprecated":1}]', '[{"host":"vis.bitcru.sh","deprecated":-1}]']) {
      const e = { ...env, VIZ_HOST_ALIASES: bad } as unknown as Env
      expect((await handle(new Request(`${VIS}/api/v1/write`, { method: 'POST' }), e)).status, bad).toBe(500)
      expect((await handle(new Request(`${VIS}/mcp`, { method: 'POST' }), e)).status, bad).toBe(500)
      expect((await handle(new Request(`${VIZ}/mcp`, { method: 'POST' }), e)).status, bad).toBe(200)
    }
    const noOrigin = { ...env, PUBLIC_URL: 'viz.bitcru.sh' } as unknown as Env
    expect((await handle(new Request(`${VIS}/mcp`, { method: 'POST' }), noOrigin)).status).toBe(500)
  })

  it('hostAliases and isDataPath', () => {
    expect(hostAliases(undefined)).toEqual([])
    expect(hostAliases('')).toEqual([])
    expect(hostAliases('[{"host":"vis.bitcru.sh","deprecated":1795824000}]')).toEqual([{ host: 'vis.bitcru.sh', deprecated: 1795824000 }])
    expect(hostAliases('[{"host":"vis.bitcru.sh","deprecated":1.5}]')).toBeNull()
    for (const [p] of DATA) expect(isDataPath(p), p).toBe(true)
    for (const p of MOVED) expect(isDataPath(p), p).toBe(false)
  })
})
