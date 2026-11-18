import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { authenticate } from '../../edge/src/auth'
import type { Tenant } from '../src/tenant'
import { auditOf, call, clearAuthCache, env, example, get, kvGet, makeKey, newTenant, post, stubOf } from './helpers'

const failingKv = { get: () => Promise.reject(new Error('kv down')), put: () => Promise.reject(new Error('kv down')), delete: () => Promise.reject(new Error('kv down')) } as unknown as KVNamespace
const breakKv = (tenant: string) => runInDurableObject(stubOf(tenant), (i: Tenant) => void (i.kv = failingKv))
const mendKv = (tenant: string) => runInDurableObject(stubOf(tenant), (i: Tenant) => void (i.kv = env.CONFIG))
const outbox = (tenant: string) => runInDurableObject(stubOf(tenant), (_i, s) => s.storage.sql.exec('SELECT COUNT(*) AS n FROM outbox').one().n as number)
const alarmAt = (tenant: string) => runInDurableObject(stubOf(tenant), (_i, s) => s.storage.getAlarm())
/** Every KV record that names this tenant's keys. */
async function kvKeysOf(tenant: string): Promise<string[]> {
  const out: string[] = []
  for (const k of (await env.CONFIG.list({ prefix: 'key:' })).keys) if ((await kvGet(k.name))?.tenant === tenant) out.push(k.name)
  return out.sort()
}
async function edgeOk(key: string): Promise<boolean> {
  clearAuthCache()
  try {
    await authenticate(new Request('https://x/', { headers: { Authorization: `Bearer ${key}` } }), env.CONFIG, 'write')
    return true
  } catch {
    return false
  }
}
async function state(admin: string): Promise<unknown> {
  const dashboards = (await get(admin, '/dashboards')).body
  return {
    keys: (await get(admin, '/keys')).body,
    dashboards,
    specs: await Promise.all(dashboards.items.map(async (d: any) => [(await get(admin, `/dashboards/${d.id}`)).body, (await get(admin, `/dashboards/${d.id}/revisions`)).body])),
    deleted: (await get(admin, '/dashboards?deleted=true')).body,
    proposals: (await get(admin, '/proposals?status=all')).body,
    settings: (await get(admin, '/settings')).body,
    audit: await auditOf(admin),
  }
}

describe('durability', () => {
  it('everything survives eviction: state is identical after the object is thrown away between every step', async () => {
    const t = await newTenant()
    const stub = stubOf(t.tenant)
    const spec = example('service_red', 'red')
    const p0 = Object.keys(spec.panels)[0]
    const title = (v: string) => [{ op: 'replace', path: `/panels/${p0}/title`, value: v }]
    let rev = ''
    let proposal = ''
    let keyId = ''
    const agent = await makeKey(t.admin, ['dashboards:read', 'dashboards:write'], { kind: 'agent', name: 'bot' })
    const steps: (() => Promise<any>)[] = [
      async () => (rev = (await post(t.admin, '/dashboards', { spec, owner: 'payments' })).body.revision),
      async () => (rev = (await call(t.admin, 'PATCH', '/dashboards/red', { ops: title('two'), baseRevision: rev })).body.revision),
      async () => (proposal = (await post(agent.key, '/dashboards/red/proposals', { message: 'm', baseRevision: rev, ops: title('three') })).body.proposal.id),
      async () => (keyId = (await post(t.admin, '/keys', { name: 'collectors', scopes: ['write'] })).body.key.id),
      async () => post(t.admin, `/keys/${keyId}/disable`),
      async () => call(t.admin, 'PUT', '/settings/retention', { value: { metric_samples_days: 60 } }),
      async () => call(t.admin, 'PUT', '/settings/pool', { value: { pool: `tenant/${t.tenant}`, slots: 4, spread: 2 } }),
      async () => (rev = (await post(t.admin, `/proposals/${proposal}/apply`)).body.revision),
      async () => (rev = (await post(t.admin, '/dashboards/red/revisions/1/revert', { baseRevision: rev })).body.revision),
      async () => post(t.admin, '/dashboards', { spec: example('k8s_node_overview', 'nodes') }),
      async () => call(t.admin, 'DELETE', '/dashboards/nodes'),
      async () => post(agent.key, '/dashboards/red/proposals', { message: 'open one', baseRevision: rev, ops: title('four') }),
    ]
    for (const [i, step] of steps.entries()) {
      const res = await step()
      expect(res, `step ${i}`).toBeTruthy()
      const before = await state(t.admin)
      const alarm = await alarmAt(t.tenant)
      await evictDurableObject(stub)
      expect(await state(t.admin), `after eviction following step ${i}`).toEqual(before)
      expect(await alarmAt(t.tenant)).toBe(alarm)
    }
    const end: any = await state(t.admin)
    expect(end.dashboards.items[0]).toMatchObject({ id: 'red', number: 4, owner: 'payments' })
    expect(end.audit).toHaveLength(steps.length + 2)
    // the credential itself survives: the bound tenant and the keys are read back from SQLite
    await evictDurableObject(stub)
    expect((await get(t.admin, '/whoami')).body.tenant).toBe(t.tenant)
    expect((await get(agent.key, '/whoami')).body.kind).toBe('agent')
  })

  it('eviction in the middle of concurrent writes: whatever was acknowledged is there, and nothing exists without its audit entry', async () => {
    const t = await newTenant()
    const stub = stubOf(t.tenant)
    const names = Array.from({ length: 12 }, (_x, i) => `burst ${i}`)
    const pending = names.map((name) => post(t.admin, '/keys', { name, scopes: ['write'] }).catch((e) => ({ status: 599, body: null, text: String(e) }) as any))
    await evictDurableObject(stub)
    const results = await Promise.all(pending)
    const acked = results.filter((r) => r.status === 201)
    await runInDurableObject(stub, (i: Tenant) => i.alarm()) // publish whatever the eviction interrupted
    const keys = (await get(t.admin, '/keys?limit=200')).body.items.filter((k: any) => k.name.startsWith('burst'))
    const created = await auditOf(t.admin, '&action=key.create')
    for (const r of acked) {
      expect(keys.map((k: any) => k.id)).toContain(r.body.key.id) // acknowledged, so present
      expect(await edgeOk(r.body.secret)).toBe(true) // and usable at edge
    }
    // atomic: one audit entry per key that exists, whether or not its creator heard back
    expect(created.map((a) => a.target.id).sort()).toEqual(keys.map((k: any) => k.id).sort())
    expect((await kvKeysOf(t.tenant)).length).toBe(keys.length + 1)
    expect(await outbox(t.tenant)).toBe(0)
  })

  it('KV down: the change commits with its audit entry and is published later by the alarm, even across an eviction', async () => {
    const t = await newTenant()
    const stub = stubOf(t.tenant)
    expect(await alarmAt(t.tenant)).toBeNull()
    await breakKv(t.tenant)
    const res = await post(t.admin, '/keys', { name: 'made while kv was down', scopes: ['write'] })
    expect(res.status, res.text).toBe(201)
    expect(res.body.kv).toBe('pending') // the caller is told the data path does not know yet
    const full: string = res.body.secret
    const keyId = /^viz_([^_]+)_/.exec(full)![1]!
    expect(await kvGet(`key:${keyId}`)).toBeNull()
    expect(await edgeOk(full)).toBe(false)
    expect((await auditOf(t.admin, '&action=key.create'))).toHaveLength(1)
    expect(await outbox(t.tenant)).toBe(1)
    const due = (await alarmAt(t.tenant))!
    expect(due - Date.now()).toBeGreaterThan(0)
    expect(due - Date.now()).toBeLessThanOrEqual(30_000)

    // still down when the alarm fires: nothing lost, alarm set again
    await runInDurableObject(stub, (i: Tenant) => i.alarm())
    expect(await outbox(t.tenant)).toBe(1)
    expect(await alarmAt(t.tenant)).not.toBeNull()

    // more changes pile up behind it, in order: disable, enable, rotate
    await post(t.admin, `/keys/${res.body.key.id}/disable`)
    await post(t.admin, `/keys/${res.body.key.id}/enable`)
    const rotated = await post(t.admin, `/keys/${res.body.key.id}/rotate`)
    expect(rotated.body.kv).toBe('pending')
    expect(await outbox(t.tenant)).toBeGreaterThanOrEqual(5)

    // the object is evicted (which also brings KV back) and the alarm publishes everything
    await evictDurableObject(stub)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(await outbox(t.tenant)).toBe(0)
    expect(await alarmAt(t.tenant)).toBeNull() // idle again: no alarm
    expect(await kvGet(`key:${keyId}`)).toBeNull() // the rotated-out secret did not come back
    expect(await edgeOk(full)).toBe(false)
    expect(await edgeOk(rotated.body.secret)).toBe(true)
    expect((await kvGet(`revocation:${t.tenant}`)).generation).toBe(2)
    expect((await auditOf(t.admin)).map((a) => a.action)).toEqual(['key.rotate', 'key.enable', 'key.disable', 'key.create', 'tenant.provision'])
    await mendKv(t.tenant)
  })

  it('a failure inside the transaction leaves nothing behind, not in SQLite and not in KV; the retry is audited exactly once', async () => {
    const t = await newTenant()
    const stub = stubOf(t.tenant)
    const kvBefore = await kvKeysOf(t.tenant)
    // make the audit insert fail, i.e. the last statement of every mutation
    await runInDurableObject(stub, (_i, s) => void s.storage.sql.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'injected failure'); END"))
    const attempts = [
      await post(t.admin, '/keys', { name: 'flaky', scopes: ['write'] }),
      await post(t.admin, '/dashboards', { spec: example('service_red', 'red') }),
      await call(t.admin, 'PUT', '/settings/retention', { value: { metric_samples_days: 60 } }),
      await call(t.admin, 'PUT', '/settings/pool', { value: { pool: `tenant/${t.tenant}`, slots: 2, spread: 1 } }),
    ]
    for (const r of attempts) {
      expect(r.status).toBe(500)
      expect(r.body.code).toBe('internal')
      expect(r.text).not.toContain('injected') // internals are not echoed
    }
    await runInDurableObject(stub, (_i, s) => void s.storage.sql.exec('DROP TRIGGER inject_failure'))
    expect((await get(t.admin, '/keys')).body.items).toHaveLength(1)
    expect((await get(t.admin, '/dashboards')).body.total).toBe(0)
    expect((await get(t.admin, '/settings/retention')).body.version).toBe(0)
    expect(await outbox(t.tenant)).toBe(0)
    // KV was not written ahead of the commit that never happened
    expect(await kvKeysOf(t.tenant)).toEqual(kvBefore)
    expect(await kvGet(`retention:${t.tenant}`)).toBeNull()
    expect(await kvGet(`pool:${t.tenant}`)).toBeNull()
    expect((await auditOf(t.admin)).map((a) => a.action)).toEqual(['tenant.provision'])

    // the same requests again: each happens once and is audited once
    expect((await post(t.admin, '/keys', { name: 'flaky', scopes: ['write'] })).status).toBe(201)
    expect((await post(t.admin, '/dashboards', { spec: example('service_red', 'red') })).status).toBe(201)
    expect((await call(t.admin, 'PUT', '/settings/retention', { value: { metric_samples_days: 60 } })).status).toBe(200)
    expect((await auditOf(t.admin)).map((a) => a.action)).toEqual(['settings.retention', 'dashboard.create', 'key.create', 'tenant.provision'])
    expect((await kvKeysOf(t.tenant)).length).toBe(kvBefore.length + 1)
    expect(await kvGet(`retention:${t.tenant}`)).toEqual({ metric_samples_days: 60 })
  })

  it('a write refused part-way (a cap) and then retried: one dashboard, one audit entry, never a change without its entry', async () => {
    const t = await newTenant()
    const stub = stubOf(t.tenant)
    await runInDurableObject(stub, (i: Tenant) => void (i.caps.maxSpecBytes = 100))
    // the dashboard row is inserted before the revision is found to be too large
    const refused = await post(t.admin, '/dashboards', { spec: example('service_red', 'red') })
    expect(refused.status).toBe(413)
    expect((await get(t.admin, '/dashboards/red')).status).toBe(404)
    expect((await auditOf(t.admin, '&targetId=red'))).toHaveLength(0)
    await runInDurableObject(stub, (i: Tenant) => void (i.caps.maxSpecBytes = 1 << 20))
    const retry = await post(t.admin, '/dashboards', { spec: example('service_red', 'red') })
    expect(retry.status, retry.text).toBe(201)
    expect(retry.body.number).toBe(1)
    expect((await auditOf(t.admin, '&targetId=red')).map((a) => a.action)).toEqual(['dashboard.create'])
    expect((await get(t.admin, '/dashboards')).body.total).toBe(1)
  })

  it('a storm of concurrent key changes: KV ends exactly where the Tenant object ends', async () => {
    const t = await newTenant()
    const k = await makeKey(t.admin, ['write'], { name: 'toggled' })
    const calls = Array.from({ length: 20 }, (_x, i) => post(t.admin, `/keys/${k.id}/${i % 2 ? 'enable' : 'disable'}`))
    const results = await Promise.all(calls)
    expect(results.every((r) => r.status === 200)).toBe(true)
    const final = (await get(t.admin, `/keys/${k.id}`)).body.key
    expect((await kvGet(`key:${k.keyId}`)).disabled).toBe(final.disabled)
    expect(await edgeOk(k.key)).toBe(!final.disabled)
    expect(await outbox(t.tenant)).toBe(0)
    expect((await kvGet(`revocation:${t.tenant}`)).generation).toBe(10)
    expect((await auditOf(t.admin)).filter((a) => a.action === 'key.disable' || a.action === 'key.enable')).toHaveLength(20)
    expect(await alarmAt(t.tenant)).toBeNull()
  })
})
