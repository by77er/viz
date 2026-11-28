/**
 * The third look at D70 (design/reviews/d70-rate-limits-r3.md), its reproductions turned around: the
 * attack is made as the review made it, and the test asserts that the owner's presentation of its
 * rotated refresh token still reaches the object, which ends the thief's grant (R3-B1), and that a
 * revocation under another client id gives the same answers for a live and a rotated refresh token
 * (R3-M1). Run against the code the review read, R3-B1 and R3-M1 fail (control/README.md, round 3);
 * against this code each passes. Also here: the listed credential spends its own allowance before the
 * list is read (m-1). Only the public surface and `resetLimiterState` are used, so the file runs
 * unchanged against the tree the review read.
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'
import { introspectFor } from '../src/introspection'
import * as ratelimit from '../src/ratelimit'
import { get, newTenant, post, stubOf, windowRoom } from './helpers'
import { ORIGIN, RESOURCE, connect, refresh as refreshPlain } from './oauth'

// No test here may straddle the minute: the local binding's windows are the wall clock's (helpers.ts).
beforeEach(() => windowRoom(), 20_000)

const byte = () => crypto.getRandomValues(new Uint8Array(1))[0]!
const ip = () => `10.${byte()}.${byte()}.${byte()}`
const AFTER_TAG = { OAUTH_RL_CREDENTIAL: env.RL_TEST_CREDENTIAL, OAUTH_RL_TENANT: env.RL_TEST_TENANT, OAUTH_RL_BEARER: env.RL_TEST_BEARER, OAUTH_RL_BEARER_TENANT: env.RL_TEST_BEARER_TENANT }

function limited(bindings: Record<string, unknown>, config: KVNamespace = env.CONFIG) {
  ratelimit.resetLimiterState()
  const gets: string[] = []
  const TENANT = new Proxy(env.TENANT, {
    get(t, p) {
      if (p === 'get') return (id: DurableObjectId) => (gets.push(id.toString()), t.get(id))
      const v = Reflect.get(t, p) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
    },
  })
  const e = { ...env, ...bindings, TENANT, CONFIG: config }
  async function form(path: string, params: Record<string, string>) {
    const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip() })
    const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: new URLSearchParams(params).toString() }) as never, e as never, {} as ExecutionContext)
    const text = await res.text()
    let body: any = text
    try {
      body = JSON.parse(text)
    } catch {
      // empty
    }
    return { status: res.status, body }
  }
  const refresh = (clientId: string, token: string) => form('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: token })
  const revoke = (clientId: string, token: string) => form('/oauth/revoke', { client_id: clientId, token })
  const introspect = (token: string) => introspectFor(e as never, 'viz-mcp', token, RESOURCE)
  return { gets, refresh, revoke, introspect }
}

const status = async (admin: string, id: string) => (await get(admin, `/oauth/grants/${id}`)).body.grant.status

describe('R3-B1: nothing a revocation under another client id does can stop reuse detection', () => {
  it('control: the owner presenting its rotated token ends the thief\'s grant', async () => {
    const { admin } = await newTenant('r3c')
    const g = await connect(admin)
    const l = limited(AFTER_TAG)
    const thief = await l.refresh(g.clientId, g.refresh)
    expect(thief.status).toBe(200)
    expect((await l.refresh(g.clientId, g.refresh)).status).toBe(400)
    expect((await l.refresh(g.clientId, thief.body.refresh_token)).status).toBe(400)
    expect(await status(admin, g.grant.id)).toBe('revoked')
  })

  it('the thief revokes the rotated token under another client id first: the owner\'s copy still reaches the object, the grant ends, and the thief\'s token is refused', async () => {
    const { admin } = await newTenant('r3b')
    const g = await connect(admin)
    const l = limited(AFTER_TAG)
    const thief = await l.refresh(g.clientId, g.refresh)
    expect(thief.status).toBe(200)
    expect((await l.revoke('not-the-client', g.refresh)).status).toBe(200) // RFC 7009: changes nothing
    // A new isolate too, in case anything had reached KV.
    const m = limited(AFTER_TAG)
    const before = m.gets.length
    const owner = await m.refresh(g.clientId, g.refresh)
    // The review's run: 400 without reaching the object, the grant live, the thief's next refresh 200.
    expect(owner.status).toBe(400)
    expect(m.gets.length).toBeGreaterThan(before)
    expect(await status(admin, g.grant.id)).toBe('revoked')
    expect((await m.refresh(g.clientId, thief.body.refresh_token)).status).toBe(400)
  })

  it('a revocation of the rotated token as the client itself ends the grant at once, so nothing is left to detect; only then is the token dead', async () => {
    const { admin } = await newTenant('r3own')
    const g = await connect(admin)
    const l = limited(AFTER_TAG)
    const thief = await l.refresh(g.clientId, g.refresh)
    expect((await l.revoke(g.clientId, g.refresh)).status).toBe(200)
    // Revoking a refresh token as its client ends the grant, rotated or not: nothing is left to detect.
    expect(await status(admin, g.grant.id)).toBe('revoked')
    expect((await l.refresh(g.clientId, thief.body.refresh_token)).status).toBe(400)
  })
})

describe('R3-B1, the wider rule: nothing is listed whose later presentation must reach reuse detection', () => {
  it('a rotated refresh token whose own row has just expired, revoked by another client: not dead, so its owner\'s copy still ends the grant', async () => {
    const { tenant, admin } = await newTenant('r3exp')
    const g = await connect(admin)
    const l = limited(AFTER_TAG)
    const thief = await l.refresh(g.clientId, g.refresh)
    expect(thief.status).toBe(200)
    // The rotated row past its own expiry (the Worker reads the 30-day expiry the token carries, so it
    // still sends it to the object; the object checks reuse before expiry).
    await runInDurableObject(stubOf(tenant), async (_o, state) => {
      state.storage.sql.exec("UPDATE oauth_tokens SET expires_at = ? WHERE tenant = ? AND grant_id = ? AND kind = 'refresh' AND rotated_at IS NOT NULL", Date.now() - 1_000, tenant, g.grant.id)
    })
    expect((await l.revoke('not-the-client', g.refresh)).status).toBe(200)
    const m = limited(AFTER_TAG)
    expect((await m.refresh(g.clientId, g.refresh)).status).toBe(400)
    expect(await status(admin, g.grant.id)).toBe('revoked')
    expect((await m.refresh(g.clientId, thief.body.refresh_token)).status).toBe(400)
  })
})

describe('R3-M1: a revocation under another client id says nothing about whether a refresh token is live', () => {
  it('a live and a rotated refresh token give the same answers, [200 × 3, 429 × 2], and neither probe changes anything', async () => {
    const { admin } = await newTenant('r3o')
    const g = await connect(admin)
    const rotated = g.refresh
    const live = (await refreshPlain(g.clientId, rotated)).body.refresh_token as string
    const l = limited(AFTER_TAG)
    const a: number[] = []
    const b: number[] = []
    for (let i = 0; i < 5; i++) a.push((await l.revoke('not-the-client', live)).status)
    for (let i = 0; i < 5; i++) b.push((await l.revoke('not-the-client', rotated)).status)
    expect(a).toEqual([200, 200, 200, 429, 429])
    expect(b).toEqual(a)
    expect(await status(admin, g.grant.id)).toBe('live')
    expect((await refreshPlain(g.clientId, live)).status).toBe(200)
  })

  it('a token of an ended grant, listed, is counted like a live one too (round 3, m-1): the same answers', async () => {
    const { admin } = await newTenant('r3o2')
    const g = await connect(admin)
    const h = await connect(admin)
    expect((await post(admin, `/oauth/grants/${g.grant.id}/revoke`, {})).status).toBe(200)
    const l = limited(AFTER_TAG)
    const dead: number[] = []
    const live: number[] = []
    for (let i = 0; i < 5; i++) dead.push((await l.revoke('not-the-client', g.refresh)).status)
    for (let i = 0; i < 5; i++) live.push((await l.revoke('not-the-client', h.refresh)).status)
    expect(dead).toEqual([200, 200, 200, 429, 429])
    expect(live).toEqual(dead)
  })
})

describe('m-1: the per-credential limit comes before the list is read', () => {
  it('a listed credential replayed: its own allowance first, then 429; KV is read at most once per allowed request, and the tenant fuse is never counted', async () => {
    const { admin } = await newTenant('r3m1')
    const g = await connect(admin)
    expect((await post(admin, `/oauth/grants/${g.grant.id}/revoke`, {})).status).toBe(200)
    const reads = { n: 0 }
    const CONFIG = { get: (...a: unknown[]) => (reads.n++, (env.CONFIG.get as (...x: unknown[]) => Promise<unknown>)(...a)), put: env.CONFIG.put.bind(env.CONFIG) } as unknown as KVNamespace
    const fuse = { keys: [] as string[] }
    const realFuse = env.RL_TEST_TENANT as RateLimit
    const l = limited({ ...AFTER_TAG, OAUTH_RL_TENANT: { limit: (o: { key: string }) => (fuse.keys.push(o.key), realFuse.limit(o)) } }, CONFIG)
    const statuses: number[] = []
    for (let i = 0; i < 10; i++) {
      // A new isolate before each, so its memory does not hide the order: every request would read KV.
      ratelimit.resetLimiterState()
      statuses.push((await l.refresh(g.clientId, g.refresh)).status)
    }
    // The first reaches the object (not yet listed) and lists it; the next two are refused from the list; then its own allowance.
    expect(statuses).toEqual([400, 400, 400, ...new Array(7).fill(429)])
    expect(reads.n).toBe(3)
    expect(fuse.keys.length).toBe(1)
  })

  it('at introspection: a listed access token answers its recorded reason within its allowance, then rate_limited', async () => {
    const { admin } = await newTenant('r3m1b')
    const g = await connect(admin)
    expect((await post(admin, `/oauth/grants/${g.grant.id}/revoke`, {})).status).toBe(200)
    const l = limited(AFTER_TAG)
    const seen: string[] = []
    for (let i = 0; i < 5; i++) seen.push((await l.introspect(g.access)).status)
    expect(seen).toEqual(['inactive', 'inactive', 'inactive', 'rate_limited', 'rate_limited'])
    expect(l.gets.length).toBe(1)
  })
})
