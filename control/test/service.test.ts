/**
 * The service surface (contracts/control.ts) and the notification settings it serves:
 *
 *   - `notifications` takes a webhook format and a write-only signing secret; no read, list,
 *     audit entry, dry run or KV record carries the secret;
 *   - `Tenant.notificationTarget` gives the ruler the destination, secret included, only for
 *     the tenant the object is bound to;
 *   - `Tenant.serviceKey` issues a key with the contract's scopes, which edge's verifier
 *     accepts for that tenant only; each call rotates it; a key a person disabled is not
 *     replaced; the reserved name cannot be taken by a person.
 */
import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { SERVICE_KEYS } from '../../contracts/control'
import { authenticate } from '../../edge/src/auth'
import { HttpError } from '../../edge/src/errors'
import { FORMATS } from '../src/schema'
import { expectGolden } from './golden'
import { auditOf, call, clearAuthCache, env, get, kvGet, makeKey, newTenant, post, stubOf } from './helpers'
import { dumpOf } from './storage'

const SECRET = 'whsec-0123456789abcdef-SECRET'
const put = (key: string, value: unknown, extra: Record<string, unknown> = {}) => call(key, 'PUT', '/settings/notifications', { value, ...extra })

/** Everything a person or another component could read of a tenant, as one string. */
async function everythingReadable(t: { tenant: string; admin: string }): Promise<string> {
  const parts = [
    (await get(t.admin, '/settings')).text,
    (await get(t.admin, '/settings/notifications')).text,
    JSON.stringify(await auditOf(t.admin)),
    (await get(t.admin, '/keys')).text,
  ]
  const kv = await env.CONFIG.list()
  for (const k of kv.keys) parts.push(k.name, (await env.CONFIG.get(k.name)) ?? '')
  return parts.join('\n')
}

async function verify(key: string, scope: 'read' | 'write'): Promise<string | number> {
  clearAuthCache()
  try {
    return (await authenticate(new Request('https://x/', { headers: { Authorization: `Bearer ${key}` } }), env.CONFIG, scope)).tenant
  } catch (e) {
    if (e instanceof HttpError) return e.status
    throw e
  }
}

describe('notifications settings: a webhook format and a write-only secret', () => {
  it('stores the format, returns and audits webhookSecretSetAt but never the secret, and a dry run stores nothing', async () => {
    const t = await newTenant('notify')
    const dry = await put(t.admin, { webhookUrl: 'https://hooks.example.com/a', webhookFormat: 'json', webhookSecret: SECRET }, { dryRun: true })
    expect(dry.status, dry.text).toBe(200)
    expect(dry.body.dryRun).toBe(true)
    expect(await stubOf(t.tenant).notificationTarget(t.tenant)).toEqual({ v: 1, status: 'ok', version: 0, target: null })

    const res = await put(t.admin, { webhookUrl: 'https://hooks.example.com/a', webhookFormat: 'json', webhookSecret: SECRET })
    expect(res.status, res.text).toBe(200)
    expect(res.body.value).toMatchObject({ webhookUrl: 'https://hooks.example.com/a', webhookFormat: 'json', sendResolved: true, email: [] })
    expect(typeof res.body.value.webhookSecretSetAt).toBe('number')
    expect(res.body.value).not.toHaveProperty('webhookSecret')
    expect(await everythingReadable(t)).not.toContain(SECRET)
    const audit = await auditOf(t.admin, '&action=settings.notifications')
    expect(audit).toHaveLength(1)
    expect(audit[0].after.value.webhookSecretSetAt).toBe(res.body.value.webhookSecretSetAt)

    expect(await stubOf(t.tenant).notificationTarget(t.tenant)).toEqual({ v: 1, status: 'ok', version: 1, target: { url: 'https://hooks.example.com/a', format: 'json', sendResolved: true, secret: SECRET } })
  })

  it('keeps the secret while the URL stays the same, drops it when the URL changes, removes it on null, and refuses what does not fit', async () => {
    const t = await newTenant('notify')
    const stub = stubOf(t.tenant)
    await put(t.admin, { webhookUrl: 'https://hooks.example.com/a', webhookSecret: SECRET })
    // Sending back what was read (webhookSecretSetAt included) keeps the secret.
    const read = (await get(t.admin, '/settings/notifications')).body.value
    expect((await put(t.admin, { ...read, sendResolved: false })).status).toBe(200)
    expect(await stub.notificationTarget(t.tenant)).toMatchObject({ version: 2, target: { secret: SECRET, sendResolved: false, format: 'alertmanager' } })
    // A new URL does not inherit it.
    expect((await put(t.admin, { webhookUrl: 'https://elsewhere.example.com/b' })).body.value.webhookSecretSetAt).toBeNull()
    expect(await stub.notificationTarget(t.tenant)).toMatchObject({ version: 3, target: { url: 'https://elsewhere.example.com/b', secret: null } })
    await put(t.admin, { webhookUrl: 'https://elsewhere.example.com/b', webhookSecret: SECRET })
    expect((await put(t.admin, { webhookUrl: 'https://elsewhere.example.com/b', webhookSecret: null })).body.value.webhookSecretSetAt).toBeNull()
    expect(await stub.notificationTarget(t.tenant)).toMatchObject({ target: { secret: null } })
    expect(await runInDurableObject(stub, (_i, s) => s.storage.sql.exec("SELECT COUNT(*) AS n FROM tenant_meta WHERE k = 'notifications.webhookSecret'").one().n)).toBe(0)
    for (const value of [
      { webhookUrl: 'https://h.example.com', webhookSecret: 'short' },
      { webhookSecret: SECRET },
      { webhookUrl: 'https://h.example.com', webhookFormat: 'xml' },
      { webhookUrl: 'https://h.example.com', sendResolved: 'yes' },
      { webhookUrl: 'https://h.example.com', webhookSecretSetAt: 12345 },
    ]) expect((await put(t.admin, value)).status, JSON.stringify(value)).toBe(422)
    expect(await everythingReadable(t)).not.toContain(SECRET)
  })

  it('a value an older release rewrote without webhookSecretSetAt leaves requests unsigned rather than signed with a stale secret', async () => {
    const t = await newTenant('notify')
    await put(t.admin, { webhookUrl: 'https://hooks.example.com/a', webhookSecret: SECRET })
    await runInDurableObject(stubOf(t.tenant), (_i, s) => {
      s.storage.sql.exec("UPDATE settings SET value = ? WHERE tenant = ? AND section = 'notifications'", JSON.stringify({ email: [], webhookUrl: 'https://hooks.example.com/a' }), t.tenant)
    })
    expect(await stubOf(t.tenant).notificationTarget(t.tenant)).toMatchObject({ target: { url: 'https://hooks.example.com/a', format: 'alertmanager', sendResolved: true, secret: null } })
  })

  it('answers only for the tenant the object is bound to', async () => {
    const a = await newTenant('notify-a')
    const b = await newTenant('notify-b')
    await put(a.admin, { webhookUrl: 'https://hooks.example.com/a', webhookSecret: SECRET })
    expect(await stubOf(a.tenant).notificationTarget(b.tenant)).toEqual({ v: 1, status: 'not_provisioned' })
    expect(await stubOf(b.tenant).notificationTarget(a.tenant)).toEqual({ v: 1, status: 'not_provisioned' })
    expect(await stubOf(`never-${a.tenant}`).notificationTarget(a.tenant)).toEqual({ v: 1, status: 'not_provisioned' })
    expect(await stubOf(b.tenant).notificationTarget(b.tenant)).toEqual({ v: 1, status: 'ok', version: 0, target: null })
  })
})

describe('service keys (contracts/control.ts serviceKey)', () => {
  it('issues a key with the contract scopes that edge accepts for this tenant, lists and audits it without its secret, and rotates it on every call', async () => {
    const t = await newTenant('svc')
    const stub = stubOf(t.tenant)
    const first = await stub.serviceKey(t.tenant, 'viz-ruler', '0')
    expect(first).toMatchObject({ v: 1, status: 'ok', name: 'service:viz-ruler/0', scopes: [...SERVICE_KEYS['viz-ruler'].scopes] })
    if (first.status !== 'ok') throw new Error('not issued')
    expect(first.key).toMatch(/^viz_[A-Za-z0-9]{16}_[A-Za-z0-9]{40}$/)
    expect(await verify(first.key, 'read')).toBe(t.tenant)
    expect(await verify(first.key, 'write')).toBe(t.tenant)
    const listed = (await get(t.admin, '/keys')).body.items.find((k: any) => k.name === 'service:viz-ruler/0')
    expect(listed).toMatchObject({ kind: 'key', scopes: ['read', 'write'], disabled: false, createdBy: { subject: 'system:viz-ruler', kind: 'system' } })

    const second = await stub.serviceKey(t.tenant, 'viz-ruler', '0')
    if (second.status !== 'ok') throw new Error('not rotated')
    expect(second.keyId).not.toBe(first.keyId)
    expect(await verify(first.key, 'read')).toBe(401)
    expect(await verify(second.key, 'read')).toBe(t.tenant)
    expect(await kvGet(`key:${first.keyId}`)).toBeNull()
    // One key row, two audit entries by the service; neither secret anywhere a person or KV reader sees.
    expect((await get(t.admin, '/keys')).body.items.filter((k: any) => k.name.startsWith('service:'))).toHaveLength(1)
    const audit = await auditOf(t.admin, '&action=key.service')
    expect(audit.map((a) => [a.by.subject, a.by.kind])).toEqual([['system:viz-ruler', 'system'], ['system:viz-ruler', 'system']])
    const readable = await everythingReadable(t)
    for (const k of [first.key, second.key]) expect(readable).not.toContain(k.split('_')[2])
    // A second shard gets its own key.
    expect(await stub.serviceKey(t.tenant, 'viz-ruler', '1')).toMatchObject({ status: 'ok', name: 'service:viz-ruler/1' })
  })

  it('a key a person disabled is not replaced; a deleted one is issued again; the reserved name cannot be taken', async () => {
    const t = await newTenant('svc')
    const stub = stubOf(t.tenant)
    const first = await stub.serviceKey(t.tenant, 'viz-ruler', '0')
    if (first.status !== 'ok') throw new Error('not issued')
    const id = (await get(t.admin, '/keys')).body.items.find((k: any) => k.name === 'service:viz-ruler/0').id
    expect((await post(t.admin, `/keys/${id}/disable`)).status).toBe(200)
    const before = await runInDurableObject(stub, (_i, s) => dumpOf(s))
    expect(await stub.serviceKey(t.tenant, 'viz-ruler', '0')).toEqual({ v: 1, status: 'disabled', name: 'service:viz-ruler/0' })
    expect(await runInDurableObject(stub, (_i, s) => dumpOf(s))).toEqual(before)
    expect(await verify(first.key, 'read')).toBe(401)
    expect((await call(t.admin, 'DELETE', `/keys/${id}`, { confirmName: 'service:viz-ruler/0' })).status).toBe(200)
    expect(await stub.serviceKey(t.tenant, 'viz-ruler', '0')).toMatchObject({ status: 'ok' })
    const taken = await post(t.admin, '/keys', { name: 'service:viz-ruler/7', scopes: ['read'] })
    expect(taken.status).toBe(422)
    expect(taken.body.field).toBe('name')
  })

  it('refuses another tenant, an unknown service and a malformed instance, and changes nothing', async () => {
    const a = await newTenant('svc-a')
    const b = await newTenant('svc-b')
    const stub = stubOf(a.tenant)
    const before = await runInDurableObject(stub, (_i, s) => dumpOf(s))
    expect(await stub.serviceKey(b.tenant, 'viz-ruler', '0')).toEqual({ v: 1, status: 'not_provisioned' })
    expect(await stub.serviceKey(a.tenant, 'viz-admin' as never, '0')).toMatchObject({ v: 1, status: 'invalid' })
    expect(await stub.serviceKey(a.tenant, 'toString' as never, '0')).toMatchObject({ v: 1, status: 'invalid' })
    for (const instance of ['', 'x', '12345', '0/../1']) expect(await stub.serviceKey(a.tenant, 'viz-ruler', instance)).toMatchObject({ v: 1, status: 'invalid' })
    expect(await runInDurableObject(stub, (_i, s) => dumpOf(s))).toEqual(before)
    expect(await stubOf(`never-${a.tenant}`).serviceKey(a.tenant, 'viz-ruler', '0')).toEqual({ v: 1, status: 'not_provisioned' })
    // B's key, issued by B's object, is B's.
    const kb = await stubOf(b.tenant).serviceKey(b.tenant, 'viz-ruler', '0')
    if (kb.status !== 'ok') throw new Error('not issued')
    expect(await verify(kb.key, 'read')).toBe(b.tenant)
  })
})

describe('golden formats of the service surface', () => {
  it('rpc.notification-target and rpc.service-key, as the ruler reads them', async () => {
    const t = await newTenant('golden')
    await put(t.admin, { webhookUrl: 'https://hooks.example.com/alerts?token=abc', webhookFormat: 'json', webhookSecret: SECRET, sendResolved: false })
    const target = await stubOf(t.tenant).notificationTarget(t.tenant)
    const key = await stubOf(t.tenant).serviceKey(t.tenant, 'viz-ruler', '0')
    const scrubbed = JSON.parse(
      JSON.stringify(key)
        .replace(/"key":"viz_[A-Za-z0-9]{16}_[A-Za-z0-9]{40}"/, '"key":"viz_<keyId>_<secret>"')
        .replace(/"keyId":"[A-Za-z0-9]{16}"/, '"keyId":"<keyId>"')
        .replace(/"issuedAt":\d{13}/, '"issuedAt":"<ms>"'),
    )
    expectGolden(`formats/rpc.notification-target.v${FORMATS['rpc.notification-target']}.json`, { format: 'rpc.notification-target', version: FORMATS['rpc.notification-target'], result: target })
    expectGolden(`formats/rpc.service-key.v${FORMATS['rpc.service-key']}.json`, { format: 'rpc.service-key', version: FORMATS['rpc.service-key'], result: scrubbed })
  })
})
