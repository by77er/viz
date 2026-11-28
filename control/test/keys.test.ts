import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { authenticate } from '../../edge/src/auth'
import { auditOf, call, clearAuthCache, env, get, kvGet, makeKey, newTenant, post, stubOf } from './helpers'

const edgeReq = (key: string) => new Request('https://viz.bitcru.sh/api/v1/write', { headers: { Authorization: `Bearer ${key}` } })
/** Edge's own verifier, against the same KV, with its cache emptied first unless told otherwise. */
async function edgeAccepts(key: string, scope: 'write' | 'read' = 'write', now?: number, keepCache = false): Promise<string | number> {
  if (!keepCache) clearAuthCache()
  try {
    return (await authenticate(edgeReq(key), env.CONFIG, scope, now)).tenant
  } catch (e) {
    return (e as { status: number }).status
  }
}
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Every value of every row of every table in the tenant's SQLite, as one string. */
async function dumpStorage(tenant: string): Promise<string> {
  return runInDurableObject(stubOf(tenant), (_i, state) => {
    const tables = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'").toArray()
    return JSON.stringify(tables.map((t) => state.storage.sql.exec(`SELECT * FROM "${t.name as string}"`).toArray()))
  })
}

describe('keys', () => {
  it('create returns the full key once; only the SHA-256 of the secret is stored, here and in KV, in edge\'s exact record format', async () => {
    const t = await newTenant()
    const res = await post(t.admin, '/keys', { name: 'prod collectors', scopes: ['write'] })
    expect(res.status, res.text).toBe(201)
    expect(res.body.kv).toBe('published')
    const full: string = res.body.secret
    const m = /^viz_([A-Za-z0-9]{16})_([A-Za-z0-9]{40})$/.exec(full)!
    expect(m).not.toBeNull()
    const [, keyId, secret] = m
    expect(res.body.key.prefix).toBe(`viz_${keyId}`)

    // KV: exactly edge's KeyRecord, nothing more.
    const record = await kvGet(`key:${keyId}`)
    expect(record).toEqual({ tenant: t.tenant, secretSha256: await sha256(secret!), scopes: ['write'], disabled: false })
    expect(JSON.stringify(record)).not.toContain(secret!)

    // Edge's verifier, imported from edge/src, accepts it for the tenant and the scope it has, and not for another.
    expect(await edgeAccepts(full, 'write')).toBe(t.tenant)
    expect(await edgeAccepts(full, 'read')).toBe(403)
    expect(await edgeAccepts(`${full}x`)).toBe(401)

    // Nothing stored anywhere contains the secret; the hash is there.
    const dump = await dumpStorage(t.tenant)
    expect(dump).not.toContain(secret!)
    expect(dump).toContain(await sha256(secret!))

    // No later response contains the secret or its hash: list, get, audit.
    const list = await get(t.admin, '/keys')
    const one = await get(t.admin, `/keys/${res.body.key.id}`)
    const audit = await get(t.admin, '/audit')
    for (const r of [list, one, audit]) {
      expect(r.status).toBe(200)
      expect(r.text).not.toContain(secret!)
      expect(r.text).not.toContain(await sha256(secret!))
    }
    expect(one.body.key.secret).toBeUndefined()
  })

  it('list shows the columns of the keys screen and nulls for usage nobody has reported', async () => {
    const t = await newTenant()
    const k = await makeKey(t.admin, ['read'], { name: 'grafana' })
    const list = await get(t.admin, '/keys')
    expect(list.body.items).toHaveLength(2)
    const row = list.body.items.find((x: any) => x.id === k.id)
    expect(row).toMatchObject({ name: 'grafana', kind: 'key', scopes: ['read'], prefix: `viz_${k.keyId}`, disabled: false, expiresAt: null, lastUsedAt: null, samples24h: null })
    expect(row.createdBy).toEqual({ subject: `key:${t.adminId}`, kind: 'key', name: 'first admin key' })
    expect(Date.parse(row.createdAt)).toBeGreaterThan(Date.now() - 60_000)
    expect(Object.keys(row).sort()).toEqual(['createdAt', 'createdBy', 'disabled', 'expired', 'expiresAt', 'id', 'kind', 'lastUsedAt', 'name', 'prefix', 'previousSecretValidUntil', 'rotatedAt', 'samples24h', 'scopes'])
    // paging with an opaque cursor
    const p1 = await get(t.admin, '/keys?limit=1')
    expect(p1.body.items).toHaveLength(1)
    expect(typeof p1.body.next).toBe('string')
    const p2 = await get(t.admin, `/keys?limit=1&cursor=${p1.body.next}`)
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id)
    expect(p2.body.next).toBeNull()
  })

  it('recordUsage is the interface for last used and samples in 24 h; until it is called both are null', async () => {
    const t = await newTenant()
    const other = await newTenant()
    const k = await makeKey(t.admin, ['write'])
    const now = Date.now()
    const row = async () => (await get(t.admin, `/keys/${k.id}`)).body.key
    expect(await row()).toMatchObject({ lastUsedAt: null, samples24h: null })
    // a batch from the data path: two recent reports, one older than 24 h, one for a key id nobody has
    const r = await stubOf(t.tenant).recordUsage(t.tenant, [
      { keyId: k.keyId, at: now - 5_000, samples: 1200 },
      { keyId: k.keyId, at: now - 3 * 3_600_000, samples: 300 },
      { keyId: k.keyId, at: now - 30 * 3_600_000, samples: 99_999 },
      { keyId: 'nosuchkeyid', at: now, samples: 5 },
    ])
    expect(r).toEqual({ accepted: 3, unknown: 1 })
    expect(await row()).toMatchObject({ lastUsedAt: new Date(now - 5_000).toISOString(), samples24h: 1500 })
    // reported with the wrong tenant, or to another tenant's object: nothing is recorded
    expect(await stubOf(other.tenant).recordUsage(other.tenant, [{ keyId: k.keyId, at: now, samples: 7 }])).toEqual({ accepted: 0, unknown: 1 })
    expect(await stubOf(t.tenant).recordUsage(other.tenant, [{ keyId: k.keyId, at: now, samples: 7 }])).toEqual({ accepted: 0, unknown: 1 })
    expect((await row()).samples24h).toBe(1500)
    // usage is not a configuration change: it is not in the audit log
    expect((await auditOf(t.admin)).map((a) => a.action)).toEqual(['key.create', 'tenant.provision'])
  })

  it('disable stops the key on this API at once and at edge when its cache entry ends; enable brings it back', async () => {
    const t = await newTenant()
    const k = await makeKey(t.admin, ['write', 'dashboards:read'])
    const t0 = Date.now()
    expect(await edgeAccepts(k.key, 'write', t0)).toBe(t.tenant) // edge now holds a 60 s cache entry
    expect((await get(k.key, '/whoami')).status).toBe(200)
    expect(await kvGet(`revocation:${t.tenant}`)).toBeNull()

    const res = await post(t.admin, `/keys/${k.id}/disable`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.key.disabled).toBe(true)
    expect(await kvGet(`key:${k.keyId}`)).toMatchObject({ disabled: true, tenant: t.tenant })
    const revocation = await kvGet(`revocation:${t.tenant}`)
    expect(revocation.generation).toBe(1)
    expect(revocation.revokedBefore).toBeGreaterThanOrEqual(t0)

    // The control API asks the Tenant object, so it refuses immediately, cache or no cache.
    expect((await get(k.key, '/whoami')).status).toBe(401)
    // Edge, with its cache entry from before: still accepted until the entry is 60 s old, refused after.
    expect(await edgeAccepts(k.key, 'write', t0 + 59_000, true)).toBe(t.tenant)
    expect(await edgeAccepts(k.key, 'write', t0 + 60_001, true)).toBe(401)
    expect(await edgeAccepts(k.key)).toBe(401)

    const en = await post(t.admin, `/keys/${k.id}/enable`)
    expect(en.body.key.disabled).toBe(false)
    expect((await kvGet(`key:${k.keyId}`)).disabled).toBe(false)
    expect(await edgeAccepts(k.key)).toBe(t.tenant)
    expect((await get(k.key, '/whoami')).status).toBe(200)
    expect((await kvGet(`revocation:${t.tenant}`)).generation).toBe(1) // enabling revokes nothing
  })

  it('rotate switches the secret: at once by default, or with an overlap during which both work', async () => {
    const t = await newTenant()
    const k = await makeKey(t.admin, ['write', 'dashboards:read'])

    const r1 = await post(t.admin, `/keys/${k.id}/rotate`)
    expect(r1.status, r1.text).toBe(200)
    const k2: string = r1.body.secret
    expect(k2).not.toBe(k.key)
    expect(r1.body.key.id).toBe(k.id)
    expect(r1.body.key.prefix).toBe(k2.slice(0, k2.lastIndexOf('_')))
    expect(await kvGet(`key:${k.keyId}`)).toBeNull()
    expect(await edgeAccepts(k.key)).toBe(401)
    expect(await edgeAccepts(k2)).toBe(t.tenant)
    expect((await get(k.key, '/whoami')).status).toBe(401)
    expect((await get(k2, '/whoami')).body.subject).toBe(`key:${k.id}`)
    expect((await kvGet(`revocation:${t.tenant}`)).generation).toBe(1)

    // with an overlap: old and new both authenticate; the old KV record carries an expiration
    const before = Date.now()
    const r2 = await post(t.admin, `/keys/${k.id}/rotate`, { overlapSeconds: 3600 })
    const k3: string = r2.body.secret
    expect(await edgeAccepts(k2)).toBe(t.tenant)
    expect(await edgeAccepts(k3)).toBe(t.tenant)
    expect((await get(k2, '/whoami')).status).toBe(200)
    expect((await get(k3, '/whoami')).status).toBe(200)
    const oldId = /^viz_([^_]+)_/.exec(k2)![1]!
    const listed = await env.CONFIG.list({ prefix: `key:${oldId}` })
    const exp = listed.keys[0]!.expiration!
    expect(exp).toBeGreaterThanOrEqual(Math.floor(before / 1000) + 3600)
    expect(exp).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000) + 3601)
    const newId = /^viz_([^_]+)_/.exec(k3)![1]!
    expect((await env.CONFIG.list({ prefix: `key:${newId}` })).keys[0]!.expiration).toBeUndefined()
    expect(Date.parse(r2.body.key.previousSecretValidUntil)).toBeGreaterThan(before + 3_599_000)
    expect((await kvGet(`revocation:${t.tenant}`)).generation).toBe(1) // nothing was revoked by an overlapping rotation

    // when the overlap is over, the Tenant object no longer knows the old secret
    await runInDurableObject(stubOf(t.tenant), (_i, state) => void state.storage.sql.exec('UPDATE key_secrets SET valid_until = ? WHERE tenant = ? AND key_id = ?', Date.now() - 1, t.tenant, oldId))
    expect((await get(k2, '/whoami')).status).toBe(401)
    expect((await get(k3, '/whoami')).status).toBe(200)

    // an overlap KV cannot express is refused, not rounded
    const bad = await post(t.admin, `/keys/${k.id}/rotate`, { overlapSeconds: 30 })
    expect(bad.status).toBe(422)
    expect(bad.body.fix).toContain('60')
    expect((await get(k3, '/whoami')).status).toBe(200)
  })

  it('delete needs the key\'s name repeated; then the key is gone everywhere', async () => {
    const t = await newTenant()
    const k = await makeKey(t.admin, ['write'], { name: 'staging collectors' })
    for (const body of [{}, { confirmName: 'staging' }, { confirmName: 'Staging collectors' }, { confirmName: k.id }]) {
      const res = await call(t.admin, 'DELETE', `/keys/${k.id}`, body)
      expect(res.status).toBe(422)
      expect(res.body.fix).toContain('confirmName')
    }
    expect((await call(t.admin, 'DELETE', `/keys/${k.id}`)).status).toBe(422)
    expect(await edgeAccepts(k.key)).toBe(t.tenant)
    const res = await call(t.admin, 'DELETE', `/keys/${k.id}`, { confirmName: 'staging collectors' })
    expect(res.status, res.text).toBe(200)
    expect(await kvGet(`key:${k.keyId}`)).toBeNull()
    expect(await edgeAccepts(k.key)).toBe(401)
    expect((await get(t.admin, `/keys/${k.id}`)).status).toBe(404)
    expect((await get(t.admin, '/keys')).body.items.map((x: any) => x.id)).toEqual([t.adminId])
    expect((await kvGet(`revocation:${t.tenant}`)).generation).toBe(1)
    // the query-string form of the confirmation works too
    const k2 = await makeKey(t.admin, ['write'], { name: 'tmp' })
    expect((await call(t.admin, 'DELETE', `/keys/${k2.id}?confirmName=tmp`)).status).toBe(200)
  })

  it('expiry: carried to KV as the record\'s expiration, enforced by the Tenant object', async () => {
    const t = await newTenant()
    const soon = await post(t.admin, '/keys', { name: 'too soon', scopes: ['read'], expiresAt: new Date(Date.now() + 30_000).toISOString() })
    expect(soon.status).toBe(422)
    expect((await post(t.admin, '/keys', { name: 'bad', scopes: ['read'], expiresAt: 'tomorrow' })).status).toBe(422)
    const at = Date.now() + 7 * 86_400_000
    const k = await makeKey(t.admin, ['read', 'dashboards:read'], { name: 'temp', expiresAt: new Date(at).toISOString() })
    expect((await env.CONFIG.list({ prefix: `key:${k.keyId}` })).keys[0]!.expiration).toBe(Math.ceil(at / 1000))
    expect((await get(k.key, '/whoami')).status).toBe(200)
    await runInDurableObject(stubOf(t.tenant), (_i, state) => void state.storage.sql.exec('UPDATE keys SET expires_at = ? WHERE tenant = ? AND id = ?', Date.now() - 1, t.tenant, k.id))
    expect((await get(k.key, '/whoami')).status).toBe(401)
    expect((await get(t.admin, `/keys/${k.id}`)).body.key.expired).toBe(true)
  })

  it('validation, scopes and the last-admin guard', async () => {
    const t = await newTenant()
    const bad = [
      { scopes: ['write'] },
      { name: '', scopes: ['write'] },
      { name: 'x', scopes: [] },
      { name: 'x', scopes: ['root'] },
      { name: 'x', scopes: ['write'], kind: 'robot' },
      { name: 'x', scopes: ['write'], secret: 'viz_mine_please' },
    ]
    for (const b of bad) {
      const res = await post(t.admin, '/keys', b)
      expect(res.status, JSON.stringify(b)).toBe(422)
      expect(res.body.fix.length).toBeGreaterThan(5)
    }
    await makeKey(t.admin, ['write'], { name: 'dup' })
    expect((await post(t.admin, '/keys', { name: 'dup', scopes: ['read'] })).status).toBe(409)

    // keys are for admins
    for (const scopes of [['write'], ['read'], ['dashboards:read', 'dashboards:write', 'dashboards:apply']]) {
      const k = await makeKey(t.admin, scopes)
      for (const [method, path] of [['GET', '/keys'], ['POST', '/keys'], ['GET', `/keys/${t.adminId}`], ['POST', `/keys/${t.adminId}/disable`], ['POST', `/keys/${t.adminId}/rotate`], ['DELETE', `/keys/${t.adminId}`]] as const) {
        const res = await call(k.key, method, path, method === 'GET' ? undefined : { name: 'n', scopes: ['admin'], confirmName: 'first admin key' })
        expect(res.status, `${scopes} ${method} ${path}`).toBe(403)
        expect(res.body.code).toBe('missing-scope')
      }
    }

    // the only admin key cannot be disabled or deleted; with a second one, it can
    expect((await post(t.admin, `/keys/${t.adminId}/disable`)).body.code).toBe('last-admin-key')
    expect((await call(t.admin, 'DELETE', `/keys/${t.adminId}`, { confirmName: 'first admin key' })).body.code).toBe('last-admin-key')
    const second = await makeKey(t.admin, ['admin'], { name: 'second admin' })
    expect((await post(second.key, `/keys/${t.adminId}/disable`)).status).toBe(200)
    expect((await get(t.admin, '/whoami')).status).toBe(401)
    expect((await post(second.key, `/keys/${second.id}/disable`)).body.code).toBe('last-admin-key')

    // an agent's key says so
    const agent = await makeKey(second.key, ['dashboards:read'], { name: 'investigator', kind: 'agent' })
    expect((await get(agent.key, '/whoami')).body).toMatchObject({ kind: 'agent', name: 'investigator', subject: `key:${agent.id}`, tenant: t.tenant })
  })

  it('dry runs of create, rotate, disable and delete report the outcome and change nothing', async () => {
    const t = await newTenant()
    const k = await makeKey(t.admin, ['write'], { name: 'steady' })
    const snapshot = async () => ({ keys: (await get(t.admin, '/keys')).body, audit: (await auditOf(t.admin)).length, kv: (await env.CONFIG.list({ prefix: 'key:' })).keys.length, rev: await kvGet(`revocation:${t.tenant}`), record: await kvGet(`key:${k.keyId}`) })
    const before = await snapshot()

    const c = await post(t.admin, '/keys', { name: 'would be', scopes: ['read'], dryRun: true })
    expect(c.status).toBe(201)
    expect(c.body).toMatchObject({ dryRun: true, secret: null, key: { name: 'would be', scopes: ['read'] } })
    const r = await post(t.admin, `/keys/${k.id}/rotate`, { dryRun: true })
    expect(r.body).toMatchObject({ dryRun: true, secret: null })
    const d = await post(t.admin, `/keys/${k.id}/disable`, { dryRun: true })
    expect(d.body).toMatchObject({ dryRun: true, key: { disabled: true } })
    const x = await call(t.admin, 'DELETE', `/keys/${k.id}?dryRun=true`, { confirmName: 'steady' })
    expect(x.body).toMatchObject({ dryRun: true, deleted: k.id })

    expect(await snapshot()).toEqual(before)
    expect(await edgeAccepts(k.key)).toBe(t.tenant)
  })
})
