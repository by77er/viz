import { describe, expect, it } from 'vitest'
import { BASE, call, createDashboard, env, get, newTenant, post } from './helpers'
import worker from '../src/index'

const raw = async (init: RequestInit & { path: string }) => worker.fetch!(new Request(BASE + init.path, init) as never, env as never, {} as ExecutionContext)

describe('HTTP surface', () => {
  it('errors are problem details with a code and a fix, whatever went wrong', async () => {
    const t = await newTenant()
    await createDashboard(t.admin, 'red')
    const cases: [string, string, unknown, number][] = [
      ['GET', '/nope', undefined, 404],
      ['GET', '/keys/k_nope', undefined, 404],
      ['PUT', '/keys', {}, 405],
      ['DELETE', '/dashboards', undefined, 405],
      ['POST', '/keys', '{not json', 400],
      ['POST', '/keys', '[1,2]', 422],
      ['POST', '/keys', '"x"', 422],
      ['GET', '/dashboards?limit=9999', undefined, 400],
      ['GET', '/dashboards?cursor=!!', undefined, 400],
      ['PATCH', '/dashboards/red', { ops: [{ op: 'remove', path: '/panels' }], baseRevision: 'x' }, 409],
      ['PATCH', '/dashboards/red', { ops: [{ op: 'remove', path: '/metadata/tags' }] }, 428],
      ['POST', '/dashboards', { spec: {} }, 422],
      ['PUT', '/settings/pool', { value: { pool: 'x', slots: 1, spread: 1 } }, 422],
    ]
    for (const [method, path, body, status] of cases) {
      const res = await call(t.admin, method, path, body)
      expect(res.status, `${method} ${path}`).toBe(status)
      expect(res.headers.get('Content-Type'), `${method} ${path}`).toBe('application/problem+json')
      expect(res.body).toMatchObject({ type: expect.stringMatching(/^https:\/\/vis\.bitcru\.sh\/problems\//), title: expect.any(String), status, code: expect.any(String), detail: expect.any(String), fix: expect.any(String) })
      expect(res.body.fix.length).toBeGreaterThan(10)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    }
    expect((await call(t.admin, 'PUT', '/keys', {})).headers.get('Allow')).toBe('GET, POST')
    const outside = await worker.fetch!(new Request('https://vis.bitcru.sh/api/v1/write') as never, env as never, {} as ExecutionContext)
    expect(outside.status).toBe(404)

    // bodies: must be JSON, of a sane size
    const notJson = await raw({ path: '/keys', method: 'POST', headers: { Authorization: `Bearer ${t.admin}`, 'Content-Type': 'text/plain' }, body: 'name=x' })
    expect(notJson.status).toBe(415)
    const huge = await raw({ path: '/keys', method: 'POST', headers: { Authorization: `Bearer ${t.admin}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(1_100_000), scopes: ['read'] }) })
    expect(huge.status).toBe(413)
    const patchType = await raw({ path: '/dashboards/red', method: 'PATCH', headers: { Authorization: `Bearer ${t.admin}`, 'Content-Type': 'application/json-patch+json' }, body: JSON.stringify({ ops: [] }) })
    expect(patchType.status).toBe(422) // understood as JSON; refused for its content
  })

  it('CORS: only origins on the allow-list get CORS headers', async () => {
    const t = await newTenant()
    const allowed = 'https://vis.bitcru.sh'
    const ok = await get(t.admin, '/whoami', { Origin: allowed })
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(allowed)
    expect(ok.headers.get('Access-Control-Expose-Headers')).toContain('ETag')
    expect(ok.headers.get('Vary')).toBe('Origin')
    for (const origin of ['https://evil.example', 'https://vis.bitcru.sh.evil.example', 'http://vis.bitcru.sh', 'null']) {
      const res = await get(t.admin, '/whoami', { Origin: origin })
      expect(res.status).toBe(200)
      expect(res.headers.get('Access-Control-Allow-Origin'), origin).toBeNull()
    }
    expect((await get(t.admin, '/whoami')).headers.get('Access-Control-Allow-Origin')).toBeNull()
    const pre = await raw({ path: '/dashboards/red', method: 'OPTIONS', headers: { Origin: allowed, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization, if-match' } })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('Access-Control-Allow-Methods')).toContain('PATCH')
    expect(pre.headers.get('Access-Control-Allow-Headers')).toContain('If-Match')
    const preDenied = await raw({ path: '/dashboards/red', method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PATCH' } })
    expect(preDenied.headers.get('Access-Control-Allow-Origin')).toBeNull()
    // errors carry the headers too, so a browser can read the problem
    expect((await get(null, '/whoami', { Origin: allowed })).headers.get('Access-Control-Allow-Origin')).toBe(allowed)
    // the list is configuration
    const other = await worker.fetch!(new Request(`${BASE}/whoami`, { headers: { Authorization: `Bearer ${t.admin}`, Origin: 'https://b.example' } }) as never, { ...env, CORS_ALLOW_ORIGINS: 'https://a.example, https://b.example' } as never, {} as ExecutionContext)
    expect(other.headers.get('Access-Control-Allow-Origin')).toBe('https://b.example')
  })

  it('GET /healthz answers without a credential, outside the API, as viz-ingest and viz-query do; 503 when a binding is missing', async () => {
    const at = (method: string, e: unknown = env, path = '/healthz') => worker.fetch!(new Request(`https://control.internal${path}`, { method }) as never, e as never, {} as ExecutionContext)
    const ok = await at('GET')
    expect(ok.status).toBe(200)
    // "ok", then what OAuth can do and its rate limiters (D70; test/ratelimit.test.ts): absent here.
    expect((await ok.text()).split('\n')[0]).toBe('ok')
    expect(ok.headers.get('Cache-Control')).toBe('no-store')
    expect((await at('HEAD')).status).toBe(200)
    const post = await at('POST')
    expect(post.status).toBe(405)
    expect(post.headers.get('Allow')).toBe('GET, HEAD')
    // It asks no Tenant object and no KV, so it cannot be used to probe tenants; a missing binding is a 503 that says which.
    const noTenant = await at('GET', { ...env, TENANT: undefined })
    expect(noTenant.status).toBe(503)
    expect(await noTenant.text()).toContain('TENANT')
    expect((await at('GET', { ...env, CONFIG: undefined })).status).toBe(503)
    // Only that exact path: the API's own namespace has no health route, and a credentialed route still needs one.
    expect((await at('GET', env, '/api/v1/control/healthz')).status).toBe(404)
    expect((await at('GET', env, '/healthz/x')).status).toBe(404)
    expect((await at('GET', env, '/api/v1/control/whoami')).status).toBe(401)
  })

  it('state hook: null unless the deployment supplies dashboard states, and then only for the caller\'s tenant and page', async () => {
    const t = await newTenant()
    await createDashboard(t.admin, 'red')
    await createDashboard(t.admin, 'nodes', 'k8s_node_overview')
    expect((await get(t.admin, '/dashboards')).body.items.map((d: any) => d.state)).toEqual([null, null])
    const asked: [string, string[]][] = []
    const hooks = {
      dashboardStates: async (tenant: string, ids: string[]) => {
        asked.push([tenant, ids])
        return { red: { level: 'crit' as const, label: 'Burning budget', evaluatedAt: '2026-11-18T00:00:00Z' } }
      },
    }
    const res = await call(t.admin, 'GET', '/dashboards', undefined, {}, hooks)
    expect(res.body.items.map((d: any) => [d.id, d.state?.label ?? null])).toEqual([['nodes', null], ['red', 'Burning budget']])
    expect(asked).toEqual([[t.tenant, ['nodes', 'red']]])
    void post
  })
})
