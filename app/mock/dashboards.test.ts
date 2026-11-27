import { describe, expect, it } from 'vitest'
import { lint, resolve, revisionOf, validate } from '../../dashboard/src/index.ts'
import { SEED_DASHBOARDS } from './dashboards'
import { createMockApi } from './handler'

const T1 = Date.UTC(2026, 10, 18, 12, 30) / 1000
const T0 = T1 - 3 * 3600

interface Json {
  [k: string]: unknown
}
const get = (path: string, opts = {}, token?: string) => {
  const res = createMockApi(opts).handle('GET', path, '', token ? { authorization: `Bearer ${token}` } : {})
  return { status: res.status, body: res.body as Json, headers: res.headers ?? {} }
}

describe('the mock\'s dashboards (mock/dashboards.ts)', () => {
  it('every spec is a valid viz.dashboard/v1 by the model\'s own validate, with no lint warning', () => {
    for (const d of SEED_DASHBOARDS) {
      expect(validate(d.spec), d.spec.metadata.id).toEqual({ ok: true, errors: [] })
      expect(lint(d.spec), d.spec.metadata.id).toEqual([])
    }
  })

  it('one has about twelve panels, one has variables of the query and enum kinds, one has a kind the app does not draw, a refused query and a query that matches nothing', () => {
    const by = Object.fromEntries(SEED_DASHBOARDS.map((d) => [d.spec.metadata.id, d.spec]))
    expect(Object.keys(resolve(by.services_overview!).panels)).toHaveLength(12)
    expect(Object.values(by.service_red!.variables!).map((v) => v.kind).sort()).toEqual(['enum', 'query'])
    expect(Object.values(by.pod_capacity!.panels).map((p) => p.kind)).toContain('heatmap')
    expect(Object.keys(resolve(by.checkout_path!).panels)).toEqual(['checkout.rate', 'checkout.latency', 'orders.rate', 'orders.latency'])
  })

  it('every query answers on the mock\'s data, except the one viz does not run (422 unsupported) and the one that matches nothing', () => {
    const api = createMockApi()
    const outcomes: Record<string, string> = {}
    for (const d of SEED_DASHBOARDS) {
      const r = resolve(d.spec)
      expect(r.issues, d.spec.metadata.id).toEqual([])
      for (const [id, q] of Object.entries(r.queries)) {
        const res = api.handle('POST', '/api/v1/query_range', new URLSearchParams({ query: q.expr, start: String(T0), end: String(T1), step: '60' }).toString(), { 'content-type': 'application/x-www-form-urlencoded' })
        const body = res.body as { errorType?: string; data?: { result: unknown[] } }
        outcomes[`${d.spec.metadata.id}/${id}`] = res.status === 200 ? (body.data!.result.length ? 'data' : 'empty') : `${res.status} ${body.errorType}`
      }
    }
    const odd = Object.fromEntries(Object.entries(outcomes).filter(([, v]) => v !== 'data'))
    expect(odd).toEqual({ 'pod_capacity/sampled': '422 unsupported', 'pod_capacity/restarts': 'empty' })
  })
})

describe('control\'s dashboard read routes, as the mock answers them', () => {
  it('lists every dashboard in order of id, with what the list shows and no spec', () => {
    const { status, body } = get('/api/v1/control/dashboards')
    expect(status).toBe(200)
    const items = body.items as Json[]
    expect(items.map((d) => d.id)).toEqual(['checkout_path', 'pod_capacity', 'service_red', 'services_overview'])
    expect(body.total).toBe(4)
    expect(body.next).toBeNull()
    expect(Object.keys(items[0]!).sort()).toEqual(['createdAt', 'createdBy', 'id', 'intent', 'lastChangedAt', 'lastChangedBy', 'name', 'number', 'owner', 'panels', 'revision', 'state', 'tags'])
    expect(items[3]).toMatchObject({ name: 'Services overview', panels: 12, owner: 'platform', number: 1, state: null, tags: ['on-call', 'services'] })
  })

  it('searches name, id, intent, owner and tags; filters by a whole tag; pages with a cursor', () => {
    const ids = (path: string) => (get(path).body.items as Json[]).map((d) => d.id)
    expect(ids('/api/v1/control/dashboards?q=CAPACITY')).toEqual(['pod_capacity'])
    expect(ids('/api/v1/control/dashboards?q=payments')).toEqual(['service_red'])
    expect(ids('/api/v1/control/dashboards?tag=on-call')).toEqual(['checkout_path', 'service_red', 'services_overview'])
    expect(ids('/api/v1/control/dashboards?tag=call')).toEqual([])
    expect(ids('/api/v1/control/dashboards?q=nothing-like-this')).toEqual([])
    const first = get('/api/v1/control/dashboards?limit=3').body
    expect((first.items as Json[]).length).toBe(3)
    expect(first.total).toBe(4)
    expect(ids(`/api/v1/control/dashboards?limit=3&cursor=${first.next as string}`)).toEqual(['services_overview'])
    expect(get('/api/v1/control/dashboards?limit=0').body.code).toBe('bad-limit')
  })

  it('answers one dashboard with its spec, its revision as the model computes it, and an ETag', () => {
    const { status, body, headers } = get('/api/v1/control/dashboards/service_red')
    const spec = SEED_DASHBOARDS.find((d) => d.spec.metadata.id === 'service_red')!.spec
    expect(status).toBe(200)
    expect(body.spec).toEqual(spec)
    expect(body.revision).toBe(revisionOf(spec))
    expect(headers.ETag).toBe(`"${revisionOf(spec)}"`)
    expect(body).toMatchObject({ number: 1, current: true, view: 'spec' })
    const resolved = get('/api/v1/control/dashboards/service_red?view=resolved&var.service=orders').body.resolved as { queries: Record<string, { expr: string }> }
    expect(resolved.queries.cpu!.expr).toBe('pod_cpu_usage_cores{service="orders"}')
    expect(get('/api/v1/control/dashboards/service_red?view=outline').body.outline).toMatchObject({ fragments: [] })
  })

  it('refuses as control does: 404 for an unknown id, 400 for a view it does not have and for a tenant in the query, 405 for a write', () => {
    expect(get('/api/v1/control/dashboards/nope')).toMatchObject({ status: 404, body: { code: 'not-found', detail: 'No such dashboard.' } })
    expect(get('/api/v1/control/dashboards/service_red?view=png')).toMatchObject({ status: 400, body: { code: 'bad-view' } })
    expect(get('/api/v1/control/dashboards?tenant=other')).toMatchObject({ status: 400, body: { code: 'tenant-not-accepted' } })
    expect(get('/api/v1/control/dashboards/service_red?revision=2')).toMatchObject({ status: 404, body: { detail: 'No such revision.' } })
    const post = createMockApi().handle('POST', '/api/v1/control/dashboards', '{}', {})
    expect(post.status).toBe(405)
  })

  it('needs a key with a dashboards scope: 401 without a key, 403 missing-scope for a key that only reads metrics', () => {
    const opts = { requireToken: 'r', readlessToken: 'w', dashboardsToken: 'd' }
    expect(get('/api/v1/control/dashboards', opts)).toMatchObject({ status: 401, body: { code: 'unauthenticated' }, headers: { 'WWW-Authenticate': 'Bearer realm="viz"' } })
    expect(get('/api/v1/control/dashboards', opts, 'nope').status).toBe(401)
    const refused = get('/api/v1/control/dashboards', opts, 'r')
    expect(refused).toMatchObject({ status: 403, body: { code: 'missing-scope', detail: 'This needs one of the scopes: admin, dashboards:read, dashboards:write, dashboards:apply.' } })
    expect(refused.body.fix).toBe('Use a key that has one of: admin, dashboards:read, dashboards:write, dashboards:apply. This key has: read.')
    expect(get('/api/v1/control/dashboards/service_red', opts, 'r').status).toBe(403)
    expect(get('/api/v1/control/dashboards', opts, 'd').status).toBe(200)
    // The dashboards key reads metrics too, as a person's key does.
    expect(createMockApi(opts).handle('GET', '/api/v1/status/buildinfo', '', { authorization: 'Bearer d' }).status).toBe(200)
  })
})
