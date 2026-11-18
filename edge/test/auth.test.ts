import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { clearCaches } from '../src/index'
import { DEFAULT_MAP, type PrwSeries, call, canon, makeKey, newTenant, postOtlp, postWrite, sha256Hex, snappyCompress, tail, tailOfSlot, writeRequest } from './helpers'

const sample = (name = 'm'): PrwSeries[] => [{ labels: [['__name__', name], ['job', 'j']], samples: [{ ts: Date.now(), value: 1 }] }]
const body = () => snappyCompress(writeRequest(sample()))
const raw = (authorization?: string) =>
  call('/api/v1/write', { method: 'POST', headers: { 'Content-Encoding': 'snappy', 'Content-Type': 'application/x-protobuf', ...(authorization ? { Authorization: authorization } : {}) }, body: body() })

describe('authentication', () => {
  it('401 for missing, malformed, unknown, wrong and disabled keys; never echoes the key', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const [, keyId, secret] = /^viz_([^_]+)_(.+)$/.exec(key)!
    const disabled = await makeKey(tenant, { disabled: true })
    const attempts = [
      undefined,
      'Bearer',
      'Bearer not-a-key',
      `Bearer viz_${keyId}`,
      `Bearer viz_${keyId}_${secret}x`, // wrong secret, right id
      `Bearer viz_${keyId}_${secret!.slice(0, -1)}`,
      `Bearer viz_nosuchkey_${secret}`, // right secret, unknown id
      `Bearer ${disabled}`,
      `Basic ${btoa(`${key}:`)}`, // key as username: not accepted
      'Basic !!!notbase64',
      `Digest ${key}`,
      `Bearer ${tenant}`,
    ]
    for (const a of attempts) {
      const res = await raw(a)
      expect(res.status, String(a)).toBe(401)
      expect(res.headers.get('WWW-Authenticate')).toContain('Bearer')
      const text = await res.text()
      expect(text).not.toContain(secret!)
      expect(text).not.toContain(keyId!)
    }
    // OTLP gets the same answers.
    expect((await call('/v1/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401)
    expect((await postOtlp(`${key}x`, '{}', 'application/json')).status).toBe(401)
    expect(await tail(DEFAULT_MAP, tenant)).toEqual([])
    // The same key, intact, works: the 401s above were about the credential.
    expect((await raw(`Bearer ${key}`)).status).toBe(204)
    expect((await raw(`bearer ${key}`)).status).toBe(204)
    expect((await raw(`Basic ${btoa(`anyone:${key}`)}`)).status).toBe(204)
  })

  it('403 for a key without the write scope', async () => {
    const tenant = newTenant()
    const readOnly = await makeKey(tenant, { scopes: ['read'] })
    const res = await postWrite(readOnly, sample())
    expect(res.status).toBe(403)
    expect((await postOtlp(readOnly, '{}', 'application/json')).status).toBe(403)
    expect(await tail(DEFAULT_MAP, tenant)).toEqual([])
    expect((await postWrite(await makeKey(tenant, { scopes: ['read', 'write'] }), sample())).status).toBe(204)
  })

  it('takes the tenant only from the key: headers, query and body cannot redirect a write', async () => {
    const mine = newTenant('mine')
    const victim = newTenant('victim')
    const key = await makeKey(mine)
    await makeKey(victim)
    const res = await postWrite(key, [{ labels: [['__name__', 'm'], ['tenant', victim], ['__tenant__', victim], ['job', 'j']], samples: [{ ts: Date.now(), value: 1 }] }], {
      path: `/api/v1/write?tenant=${victim}&org=${victim}`,
      headers: { 'X-Scope-OrgID': victim, 'X-Tenant': victim, 'X-Viz-Tenant': victim, Tenant: victim, 'X-Org-Id': victim },
    })
    expect(res.status).toBe(204)
    expect((await tail(DEFAULT_MAP, mine)).length).toBe(1)
    for (let slot = 0; slot < DEFAULT_MAP.slots; slot++) expect((await tailOfSlot(DEFAULT_MAP, slot, victim)).samples).toEqual([])
  })

  it('keeps two tenants apart in the same shard', async () => {
    const a = newTenant('a')
    const b = newTenant('b')
    const ka = await makeKey(a)
    const kb = await makeKey(b)
    // Both tenants are given the same one-slot pool, so they share one shard object.
    const map = { pool: `iso/${a}`, slots: 1, spread: 1, epoch: 1 }
    await env.CONFIG.put(`pool:${a}`, JSON.stringify(map))
    await env.CONFIG.put(`pool:${b}`, JSON.stringify(map))
    const now = Date.now()
    const of = (who: string, n: number): PrwSeries[] => Array.from({ length: n }, (_, i) => ({ labels: [['__name__', `${who}_secret_${i}`], ['job', 'same'], ['owner', who]], samples: [{ ts: now, value: i }] }))
    for (let round = 0; round < 3; round++) {
      expect((await postWrite(ka, of('a', 4 + round))).status).toBe(204)
      expect((await postWrite(kb, of('b', 2 + round))).status).toBe(204)
    }
    const ta = await tailOfSlot(map, 0, a)
    const tb = await tailOfSlot(map, 0, b)
    expect(ta.samples.length).toBe(4 + 5 + 6)
    expect(tb.samples.length).toBe(2 + 3 + 4)
    expect(ta.samples.every((s) => s.labels.owner === 'a')).toBe(true)
    expect(tb.samples.every((s) => s.labels.owner === 'b')).toBe(true)
    expect(canon(ta.samples).some((s) => s.includes('b_secret'))).toBe(false)
  })

  it('caches key lookups briefly, and verifies the secret on every request even from cache', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    clearCaches()
    let gets = 0
    const counting = { get: (...args: unknown[]) => (gets++, (env.CONFIG.get as (...a: unknown[]) => unknown)(...args)) } as unknown as KVNamespace
    const s = sample()
    for (let i = 0; i < 5; i++) expect((await postWrite(key, s, { env: { CONFIG: counting } })).status).toBe(204)
    expect(gets).toBe(2) // one key record + one pool map, for five requests
    // A wrong secret for a cached key id is still refused.
    expect((await postWrite(`${key}x`, s, { env: { CONFIG: counting } })).status).toBe(401)
    expect(gets).toBe(2)
    // Stored hash is of the secret only, never the secret itself.
    const [, keyId, secret] = /^viz_([^_]+)_(.+)$/.exec(key)!
    const record = (await env.CONFIG.get(`key:${keyId}`, 'json')) as { secretSha256: string }
    expect(record.secretSha256).toBe(await sha256Hex(secret!))
    expect(JSON.stringify(record)).not.toContain(secret!)
  })
})

describe('plumbing', () => {
  it('healthz, 404, 405', async () => {
    const h = await call('/healthz')
    expect(h.status).toBe(200)
    expect(await h.text()).toBe('ok\n')
    expect((await call('/healthz', { method: 'POST' })).status).toBe(405)
    expect((await call('/nope')).status).toBe(404)
    expect((await call('/api/v1/write')).status).toBe(405)
    expect((await call('/v1/metrics', { method: 'PUT' })).status).toBe(405)
  })
})
