import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { authenticate } from '../../../edge/src/auth'
import { describe, expect, it } from 'vitest'
import { type Env, handle } from '../src/index'

const URL_ = 'https://vis.bitcru.sh/api/v1/bootstrap'
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))

let n = 0
/** A fresh tenant and token per test: Durable Object storage is shared within a file. */
async function setup(over: Partial<{ expiresAt: number; tenant: string }> = {}) {
  n += 1
  const tenant = over.tenant ?? `boot-${n}-${crypto.randomUUID().slice(0, 8)}`
  const token = `tok_${crypto.randomUUID()}${crypto.randomUUID()}`
  const secret = JSON.stringify({ tenant, tokenSha256: await sha256(token), expiresAt: over.expiresAt ?? Date.now() + 600_000 })
  const e = { ...env, VIZ_BOOTSTRAP: secret } as unknown as Env
  const post = (headers: Record<string, string> = { Authorization: `Bearer ${token}` }, init: RequestInit = {}, url = URL_) =>
    handle(new Request(url, { method: 'POST', headers, ...init }), e)
  return { tenant, token, e, post }
}

/** The tenant's keys, counted inside its object. */
async function runCount(tenant: string): Promise<number> {
  const stub = env.TENANT.get(env.TENANT.idFromName(tenant))
  return runInDurableObject(stub, (obj) => obj.all<{ n: number }>('SELECT COUNT(*) AS n FROM keys WHERE tenant = ?', tenant)[0]!.n)
}

describe('POST /api/v1/bootstrap', () => {
  it('does not exist while no secret is set: the ordinary 404', async () => {
    const e = { ...env, VIZ_BOOTSTRAP: undefined } as unknown as Env
    const res = await handle(new Request(URL_, { method: 'POST', headers: { Authorization: 'Bearer anything' } }), e)
    expect(res.status).toBe(404)
    expect(res.headers.get('x-viz-route')).toBe('gateway')
  })

  it('creates the first admin key once; the key works at edge; the second call is refused', async () => {
    const { tenant, post } = await setup()
    const res = await post()
    expect(res.status).toBe(201)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = (await res.json()) as { tenant: string; key: string; keyId: string; scopes: string[] }
    expect(body.tenant).toBe(tenant)
    expect(body.scopes).toEqual(['admin'])
    expect(body.key).toMatch(/^viz_[A-Za-z0-9]+_[A-Za-z0-9_-]+$/)
    expect(await runCount(tenant)).toBe(1)
    // control published edge's record: the key authenticates for its tenant (as admin; edge's
    // write scope is refused, which is why the operator then makes a write+read key).
    const req = new Request('https://x/', { headers: { Authorization: `Bearer ${body.key}` } })
    await expect(authenticate(req, env.CONFIG, 'write')).rejects.toMatchObject({ status: 403 })

    const again = await post()
    expect(again.status).toBe(409)
    expect(JSON.stringify(await again.json())).not.toContain('viz_')
    expect(await runCount(tenant)).toBe(1)
  })

  it('refuses a wrong, missing or malformed token, and creates nothing', async () => {
    const { tenant, token, post } = await setup()
    for (const headers of [
      {},
      { Authorization: `Bearer ${token}x` },
      { Authorization: `Bearer ${token.slice(0, -1)}` },
      { Authorization: token },
      { Authorization: `Basic ${btoa(`u:${token}`)}` },
      { Authorization: 'Bearer ' },
    ] as Record<string, string>[]) {
      const res = await post(headers)
      expect(res.status).toBe(401)
    }
    expect(await runCount(tenant)).toBe(0)
  })

  it('refuses after the window closes, even with the right token', async () => {
    const { tenant, post } = await setup({ expiresAt: Date.now() - 1 })
    expect((await post()).status).toBe(403)
    expect(await runCount(tenant)).toBe(0)
  })

  it('takes no tenant from the request: a body or a query string is refused', async () => {
    const { tenant, token, post } = await setup()
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    expect((await post(auth, { body: JSON.stringify({ tenant: 'someone-else' }) })).status).toBe(400)
    expect((await post(auth, {}, `${URL_}?tenant=someone-else`)).status).toBe(400)
    expect(await runCount(tenant)).toBe(0)
    expect(await runCount('someone-else')).toBe(0)
  })

  it('answers only POST, and a malformed secret is a 503 that creates nothing', async () => {
    const { e, token, tenant } = await setup()
    const get = await handle(new Request(URL_, { headers: { Authorization: `Bearer ${token}` } }), e)
    expect(get.status).toBe(405)
    const broken = { ...e, VIZ_BOOTSTRAP: '{"tenant":"x"}' } as Env
    const res = await handle(new Request(URL_, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), broken)
    expect(res.status).toBe(503)
    expect(await runCount(tenant)).toBe(0)
  })

  it('a tenant that already has keys is refused even with a fresh token', async () => {
    const first = await setup()
    expect((await first.post()).status).toBe(201)
    const second = await setup({ tenant: first.tenant })
    expect((await second.post()).status).toBe(409)
    expect(await runCount(first.tenant)).toBe(1)
  })

  it('while a newer release holds the tenant\'s storage (provision refuses with schema_too_new): a retryable 503, nothing created', async () => {
    const { tenant, post } = await setup()
    const stub = env.TENANT.get(env.TENANT.idFromName(tenant))
    // Storage as a newer, forward-only release of control left it: version and compat above what this code knows.
    const before = await runInDurableObject(stub, (_o, state) => {
      state.storage.sql.exec('UPDATE viz_schema SET version = 99, compat = 99')
      return state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().length
    })
    await evictDurableObject(stub)
    const res = await post()
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('30')
    expect(JSON.stringify(await res.json())).toMatch(/nothing was created/)
    const after = await runInDurableObject(stub, (_o, state) => ({
      keys: state.storage.sql.exec('SELECT COUNT(*) AS n FROM keys').one().n,
      row: state.storage.sql.exec('SELECT version, compat FROM viz_schema').one(),
      tables: state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().length,
    }))
    expect(after).toEqual({ keys: 0, row: { version: 99, compat: 99 }, tables: before })
  })
})

