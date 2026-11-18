import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { ROUTES, type Route } from '../src/routes'
import { type Res, auditOf, call, env, example, get, kvGet, makeKey, newTenant, post } from './helpers'

/**
 * Tenant isolation. Tenant A is filled with one of everything, each carrying a marker
 * string. Tenant B holds a full-power credential of its own and tries every route with A's
 * ids, with guessed ids, and with every way of naming a tenant in a request.
 *
 * What must hold, always: B never gets a 2xx for an id that is A's, no response to B ever
 * contains A's marker or A's tenant id, and nothing of A's changes: not in its object and
 * not in KV.
 */
const MARKER = 'ALPHA-7f3c9d'

interface World {
  a: Awaited<ReturnType<typeof newTenant>>
  b: Awaited<ReturnType<typeof newTenant>>
  bAgent: string
  /** A's ids by path parameter name. */
  ids: Record<string, string[]>
  aKeyIds: string[]
  aKeyName: string
  aRevision: string
  aCursors: string[]
}
let w: World

async function snapshotA(): Promise<unknown> {
  const admin = w.a.admin
  const dashboards = (await get(admin, '/dashboards?limit=200')).body
  const specs: Record<string, unknown> = {}
  for (const d of dashboards.items) specs[d.id] = [(await get(admin, `/dashboards/${d.id}`)).body, (await get(admin, `/dashboards/${d.id}/revisions`)).body]
  const proposals = (await get(admin, '/proposals?status=all&limit=200')).body
  const kv: Record<string, unknown> = {}
  for (const k of [...w.aKeyIds.map((id) => `key:${id}`), `retention:${w.a.tenant}`, `limits:${w.a.tenant}`, `pool:${w.a.tenant}`, `revocation:${w.a.tenant}`]) kv[k] = await kvGet(k)
  return {
    keys: (await get(admin, '/keys')).body,
    dashboards,
    deleted: (await get(admin, '/dashboards?deleted=true')).body,
    specs,
    proposals,
    reviews: await Promise.all(proposals.items.map(async (p: any) => (await get(admin, `/proposals/${p.id}`)).body)),
    settings: (await get(admin, '/settings')).body,
    audit: await auditOf(admin),
    kv,
  }
}

beforeAll(async () => {
  const a = await newTenant('alpha')
  const b = await newTenant('beta')
  const aKeys = [await makeKey(a.admin, ['write'], { name: `${MARKER} collectors` }), await makeKey(a.admin, ['dashboards:read', 'dashboards:write'], { name: `${MARKER} agent`, kind: 'agent' })]
  const spec = example('service_red', 'alpha_checkout')
  spec.metadata.title = `${MARKER} checkout`
  const d1 = await post(a.admin, '/dashboards', { spec, owner: `${MARKER} team` })
  const spec2 = example('k8s_node_overview', 'alpha_nodes')
  spec2.metadata.title = `${MARKER} nodes`
  await post(a.admin, '/dashboards', { spec: spec2 })
  const gone = example('service_red', 'alpha_gone')
  gone.metadata.title = `${MARKER} deleted`
  await post(a.admin, '/dashboards', { spec: gone })
  await call(a.admin, 'DELETE', '/dashboards/alpha_gone')
  const p0 = Object.keys(spec.panels)[0]
  const d2 = await call(a.admin, 'PATCH', '/dashboards/alpha_checkout', { ops: [{ op: 'replace', path: `/panels/${p0}/title`, value: `${MARKER} panel` }], baseRevision: d1.body.revision, message: `${MARKER} message` })
  const open = await post(aKeys[1]!.key, '/dashboards/alpha_checkout/proposals', { message: `${MARKER} proposal`, baseRevision: d2.body.revision, changes: [{ name: 'c1', reason: `${MARKER} reason`, ops: [{ op: 'replace', path: '/metadata/title', value: `${MARKER} proposed` }] }] })
  const declined = await post(aKeys[1]!.key, '/dashboards/alpha_checkout/proposals', { message: `${MARKER} second`, baseRevision: d2.body.revision, ops: [{ op: 'replace', path: '/metadata/title', value: `${MARKER} other` }] })
  await post(a.admin, `/proposals/${declined.body.proposal.id}/decline`, { reason: `${MARKER} declined` })
  await call(a.admin, 'PUT', '/settings/retention', { value: { metric_samples_days: 90 } })
  await call(a.admin, 'PUT', '/settings/limits', { value: { active_series: 123_456 } })
  await call(a.admin, 'PUT', '/settings/pool', { value: { pool: `tenant/${a.tenant}`, slots: 4, spread: 2 } })
  await call(a.admin, 'PUT', '/settings/notifications', { value: { email: [`${MARKER.toLowerCase()}@example.com`] } })
  const audit = await auditOf(a.admin)

  // B: an admin key, an agent key with every scope, and one dashboard of its own (so its own routes do work)
  const bAgent = await makeKey(b.admin, ['admin', 'dashboards:read', 'dashboards:write', 'dashboards:apply', 'read', 'write'], { kind: 'agent', name: 'beta agent' })
  await post(b.admin, '/dashboards', { spec: example('service_red', 'beta_dash') })
  await call(b.admin, 'PUT', '/settings/general', { value: { agentsMayApply: true } })

  w = {
    a,
    b,
    bAgent: bAgent.key,
    ids: {
      key: [a.adminId, ...aKeys.map((k) => k.id)],
      dashboard: ['alpha_checkout', 'alpha_nodes', 'alpha_gone'],
      proposal: [open.body.proposal.id, declined.body.proposal.id],
      entry: audit.slice(0, 6).map((e) => e.id),
    },
    aKeyIds: [...aKeys.map((k) => k.keyId), /^viz_([^_]+)_/.exec(a.admin)![1]!],
    aKeyName: `${MARKER} collectors`,
    aRevision: d2.body.revision,
    aCursors: [(await get(a.admin, '/audit?limit=1')).body.next, (await get(a.admin, '/dashboards?limit=1')).body.next, (await get(a.admin, '/keys?limit=1')).body.next, (await get(a.admin, '/proposals?status=all&limit=1')).body.next],
  }
  expect(w.aCursors.every((c) => typeof c === 'string')).toBe(true)
})

/** A plausible, well-formed body for each mutating route, built from ids the caller supplies. */
function bodyFor(route: Route, w: World, hostile: boolean): Record<string, unknown> | undefined {
  if (route.method === 'GET') return undefined
  const title = [{ op: 'replace', path: '/metadata/title', value: 'beta was here' }]
  switch (route.op) {
    case 'keys.create': return { name: `fuzz ${Math.random().toString(36).slice(2)}`, scopes: ['read'] }
    case 'keys.delete': return { confirmName: hostile ? w.aKeyName : 'x' }
    case 'keys.rotate': return { overlapSeconds: 0 }
    case 'dashboards.create': return { spec: example('service_red', `fz_${Math.random().toString(36).slice(2, 10)}`) }
    case 'dashboards.patch': return { ops: title, baseRevision: w.aRevision, message: 'm' }
    case 'dashboards.delete': return {}
    case 'dashboards.setOwner': return { owner: 'beta' }
    case 'revisions.revert': return { baseRevision: w.aRevision }
    case 'proposals.create': return { message: 'm', baseRevision: w.aRevision, ops: title }
    case 'proposals.edit': return { ops: title }
    case 'proposals.apply': return hostile ? { changes: ['c1'] } : {}
    case 'proposals.decline': return { reason: 'beta says no' }
    case 'settings.put': return { value: { metric_samples_days: 30 }, confirmShorter: true }
    default: return {}
  }
}

const fill = (route: Route, pick: (name: string) => string): string => route.path.replace(/\{([a-z]+)\}/g, (_m, name: string) => encodeURIComponent(pick(name)))

function assertNoLeak(res: Res, what: string): void {
  expect(res.text, `${what}: marker leaked`).not.toContain(MARKER)
  expect(res.text.toLowerCase(), `${what}: marker leaked`).not.toContain(MARKER.toLowerCase())
  expect(res.text, `${what}: tenant id leaked`).not.toContain(w.a.tenant)
  for (const id of [...w.ids.key!, ...w.ids.proposal!, ...w.ids.entry!, ...w.aKeyIds]) expect(res.text, `${what}: an id of A's came back`).not.toContain(id)
}

describe('tenant isolation', () => {
  it('ids are random, not sequential: nothing about one tenant\'s ids predicts another\'s', async () => {
    for (const id of w.ids.key!) expect(id).toMatch(/^k_[A-Za-z0-9]{22}$/)
    for (const id of w.ids.proposal!) expect(id).toMatch(/^p_[A-Za-z0-9]{22}$/)
    for (const id of w.ids.entry!) expect(id).toMatch(/^a_[A-Za-z0-9]{22}$/)
    for (const id of w.aKeyIds) expect(id).toMatch(/^[A-Za-z0-9]{16}$/)
    const bAudit = await auditOf(w.b.admin)
    const all = [...(await auditOf(w.a.admin)).map((e) => e.id), ...bAudit.map((e) => e.id)]
    expect(new Set(all).size).toBe(all.length)
    // no sequence number or other position is exposed in an entry
    expect(Object.keys(bAudit[0]).sort()).toEqual(['action', 'after', 'at', 'before', 'by', 'id', 'target'])
  })

  it('every route, with each of A\'s ids, called with B\'s credentials: 404 and nothing of A\'s in the answer', async () => {
    const before = await snapshotA()
    let tried = 0
    for (const key of [w.b.admin, w.bAgent]) {
      for (const route of ROUTES) {
        const names = [...route.path.matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]!).filter((n) => w.ids[n])
        if (names.length === 0) continue
        for (const target of w.ids[names[0]!]!) {
          const path = fill(route, (n) => (n === names[0] ? target : n === 'number' ? '1' : n === 'section' ? 'limits' : 'x'))
          const res = await call(key, route.method, path, bodyFor(route, w, true))
          expect(res.status, `${route.method} ${path}: ${res.text}`).toBe(404)
          expect(res.body.code).toBe('not-found')
          assertNoLeak(res, `${route.method} ${path}`)
          tried++
        }
      }
    }
    expect(tried).toBeGreaterThan(100)
    expect(await snapshotA()).toEqual(before)
  })

  it('B\'s lists, searches, filters and A\'s own cursors show only B\'s things', async () => {
    const before = await snapshotA()
    const queries = [
      '/keys', '/dashboards', '/dashboards?deleted=true', `/dashboards?q=${MARKER}`, '/dashboards?q=alpha', '/dashboards?q=%25', '/dashboards?q=_', `/dashboards?owner=${encodeURIComponent(`${MARKER} team`)}`,
      '/proposals?status=all', '/proposals?dashboard=alpha_checkout&status=all', '/settings', '/settings/retention', '/settings/limits', '/settings/pool', '/settings/notifications',
      '/audit', '/audit?targetId=alpha_checkout', `/audit?subject=${encodeURIComponent(`key:${w.a.adminId}`)}`, `/audit?targetId=${w.ids.proposal![0]}`, '/audit?targetType=setting', '/whoami',
      ...w.aCursors.flatMap((c) => [`/audit?cursor=${c}`, `/dashboards?cursor=${c}`, `/keys?cursor=${c}`, `/proposals?status=all&cursor=${c}`, `/dashboards/beta_dash/revisions?cursor=${c}`]),
    ]
    for (const q of queries) {
      for (const key of [w.b.admin, w.bAgent]) {
        const res = await get(key, q)
        expect([200, 400], q).toContain(res.status) // 400: a cursor of the wrong shape for that list
        assertNoLeak(res, q)
      }
    }
    expect((await get(w.b.admin, '/dashboards')).body.items.map((d: any) => d.id)).toEqual(['beta_dash'])
    expect((await get(w.b.admin, '/settings/retention')).body.value).toBeNull()
    expect((await get(w.b.admin, '/whoami')).body.tenant).toBe(w.b.tenant)
    expect(await snapshotA()).toEqual(before)
  })

  it('a request that names a tenant is refused; headers that look like a tenant change nothing', async () => {
    const before = await snapshotA()
    const mine = (await get(w.b.admin, '/dashboards')).body
    // in the query string or the body: refused outright, on every route
    for (const route of ROUTES) {
      const path = fill(route, (n) => (n === 'number' ? '1' : n === 'section' ? 'limits' : n === 'dashboard' ? 'beta_dash' : 'x'))
      const q = await call(w.b.admin, route.method, `${path}?tenant=${w.a.tenant}`, bodyFor(route, w, false))
      expect(q.status, `${route.method} ${path}?tenant=`).toBe(400)
      expect(q.body.code).toBe('tenant-not-accepted')
      if (route.method !== 'GET') {
        const b = await call(w.b.admin, route.method, path, { ...bodyFor(route, w, false), tenant: w.a.tenant })
        expect(b.status, `${route.method} ${path} body.tenant`).toBe(400)
        expect(b.body.code).toBe('tenant-not-accepted')
      }
    }
    // in a header, or under another name: ignored; the answer is B's own, byte for byte
    const headers = { 'X-Scope-OrgID': w.a.tenant, 'X-Tenant': w.a.tenant, 'X-Viz-Tenant': w.a.tenant, 'X-Tenant-Id': w.a.tenant, 'CF-Tenant': w.a.tenant, Tenant: w.a.tenant }
    expect((await get(w.b.admin, '/dashboards', headers)).body).toEqual(mine)
    expect((await get(w.b.admin, `/dashboards?tenantId=${w.a.tenant}&org=${w.a.tenant}&t=${w.a.tenant}`, headers)).body).toEqual(mine)
    expect((await get(w.b.admin, '/whoami', headers)).body.tenant).toBe(w.b.tenant)
    // Basic auth with A's tenant as the username: the username is not a tenant
    const basic = await call(null, 'GET', '/whoami', undefined, { Authorization: `Basic ${btoa(`${w.a.tenant}:${w.b.admin}`)}` })
    expect(basic.body.tenant).toBe(w.b.tenant)
    expect(await snapshotA()).toEqual(before)
  })

  it('no credential, or a broken one: 401 on every route, and nothing about what exists', async () => {
    const aKey = w.a.admin
    const [, keyId, secret] = /^viz_([^_]+)_(.+)$/.exec(aKey)!
    const [, bKeyId, bSecret] = /^viz_([^_]+)_(.+)$/.exec(w.b.admin)!
    const creds: Record<string, string>[] = [{}, { Authorization: 'Bearer nope' }, { Authorization: `Bearer viz_${keyId}_${bSecret}` }, { Authorization: `Bearer viz_${bKeyId}_${secret}` }, { Authorization: `Bearer viz_${keyId}_${secret!.slice(0, -1)}` }, { Authorization: `Bearer ${w.a.tenant}` }, { Cookie: `session=${aKey}` }, { 'X-Api-Key': aKey }]
    for (const route of ROUTES) {
      const path = fill(route, (n) => w.ids[n]?.[0] ?? (n === 'number' ? '1' : 'limits'))
      for (const headers of creds) {
        const res = await call(null, route.method, path, bodyFor(route, w, true), headers)
        expect(res.status, `${route.method} ${path} ${JSON.stringify(headers).slice(0, 40)}`).toBe(401)
        expect(res.headers.get('WWW-Authenticate')).toContain('Bearer')
        assertNoLeak(res, path)
        expect(res.text).not.toContain(secret!)
      }
    }
  })

  it('fuzz: random routes, ids, queries, headers and bodies from B never read or change anything of A\'s', async () => {
    const before = await snapshotA()
    const hostileId = (name: string) =>
      fc.oneof(
        { weight: 5, arbitrary: fc.constantFrom(...(w.ids[name] ?? ['1', 'limits', 'retention', 'pool'])) },
        { weight: 2, arbitrary: fc.constantFrom('beta_dash', '1', '2', '0', '-1', 'limits', 'general', '..', '.', '%', '*', '_', "' OR 1=1 --", '"; DROP TABLE audit; --', w.a.tenant, `${w.a.tenant}/${w.ids[name]?.[0] ?? 'x'}`, `${w.a.tenant}:${w.ids[name]?.[0] ?? 'x'}`, `../${w.a.tenant}/${w.ids[name]?.[0] ?? 'x'}`, `${w.ids[name]?.[0] ?? 'x'}\u0000`, ` ${w.ids[name]?.[0] ?? 'x'}`, (w.ids[name]?.[0] ?? 'x').toUpperCase(), (w.ids[name]?.[0] ?? 'x').slice(0, -1)) },
        { weight: 2, arbitrary: fc.string({ maxLength: 40 }).filter((s) => s.length > 0 && !s.includes('/')) },
        { weight: 1, arbitrary: fc.stringMatching(/^[kpa]_[A-Za-z0-9]{22}$/) },
      )
    const queryArb = fc.array(
      fc.constantFrom(
        `tenantId=${w.a.tenant}`, `org=${w.a.tenant}`, `dashboard=alpha_checkout`, `targetId=alpha_checkout`, `targetId=${w.ids.proposal![0]}`, `subject=key:${w.a.adminId}`, `q=${MARKER}`, 'q=alpha', 'q=%25', 'deleted=true', 'status=all', 'view=resolved', 'view=outline', 'revision=1', 'revision=2', 'dryRun=true', 'limit=200', `confirmName=${encodeURIComponent(w.aKeyName)}`,
        ...w.aCursors.map((c) => `cursor=${c}`), `owner=${encodeURIComponent(`${MARKER} team`)}`, `var.env=${w.a.tenant}`,
      ),
      { maxLength: 3 },
    )
    const headerArb = fc.dictionary(fc.constantFrom('X-Scope-OrgID', 'X-Tenant', 'X-Viz-Tenant', 'X-Forwarded-Tenant', 'If-Match'), fc.constantFrom(w.a.tenant, `"${w.aRevision}"`, 'alpha_checkout'), { maxKeys: 2 })
    let aIdCalls = 0
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...(ROUTES as readonly Route[])),
        hostileId('key'), hostileId('dashboard'), hostileId('proposal'), hostileId('entry'), fc.constantFrom('1', '2', '3', '99', 'x'), fc.constantFrom('general', 'retention', 'limits', 'pool', 'notifications', 'nope'),
        queryArb, headerArb, fc.boolean(), fc.boolean(), fc.boolean(),
        async (route, key, dashboard, proposal, entry, number, section, query, headers, hostileBody, asAgent, nameTenant) => {
          const picked: Record<string, string> = { key, dashboard, proposal, entry, number, section }
          const used = [...route.path.matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]!)
          const path = fill(route, (n) => picked[n]!)
          const qs = [...query, ...(nameTenant ? [`tenant=${w.a.tenant}`] : [])]
          const res = await call(asAgent ? w.bAgent : w.b.admin, route.method, `${path}${qs.length ? `?${qs.join('&')}` : ''}`, bodyFor(route, w, hostileBody), headers)
          const what = `${route.method} ${path}?${qs.join('&')} → ${res.status}`
          expect(res.status, what).toBeLessThan(500)
          assertNoLeak(res, what)
          // ("." and ".." are resolved by URL parsing before routing, so such a path may be no route at all)
          const dots = used.some((n) => picked[n] === '.' || picked[n] === '..')
          if (nameTenant && !dots) expect(res.status, what).toBe(400)
          const usesAId = used.some((n) => (w.ids[n] ?? []).includes(picked[n]!))
          if (usesAId) {
            aIdCalls++
            expect(res.status, what).toBeGreaterThanOrEqual(400)
          }
        },
      ),
      { numRuns: 400 },
    )
    expect(aIdCalls).toBeGreaterThan(100)
    expect(await snapshotA()).toEqual(before)
    // A's credentials still see everything, so the snapshot was not empty by accident
    const snap: any = before
    expect(snap.dashboards.items.map((d: any) => d.name)).toEqual([`${MARKER} proposed`.replace('proposed', 'checkout'), `${MARKER} nodes`])
    expect(snap.keys.items).toHaveLength(3)
    expect(snap.proposals.items).toHaveLength(2)
    expect(snap.audit.length).toBeGreaterThan(10)
    expect(Object.values(snap.kv).filter((v) => v !== null)).toHaveLength(6)
    void env
  })
})
