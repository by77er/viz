/**
 * The second review of D70 (design/reviews/d70-rate-limits-r2.md), its reproductions turned around:
 * each attack is made as the review made it (N1, N1b, N2, N2b, N3), plus the variants this round's
 * fix had to close (the farmed stock replayed at revocation, and at introspection; a new isolate),
 * and each test asserts that the victim is served. Run against the code the review read, every test
 * here fails (control/README.md, "Rate limits in front of OAuth (D70)", round 2's before-and-after
 * runs); against this code, each passes.
 *
 * Same harness as test/ratelimit.test.ts: miniflare's Rate Limiting bindings with small limits
 * (vitest.config.ts: source 5, credential 3, tenant 12, bearer 3, bearer tenant 12, per 60 s), and
 * the real `CONFIG` KV namespace that the list of dead credentials uses. Only the public surface and
 * `resetLimiterState` (which both trees have) are used, so that the file runs unchanged against the
 * tree the review read.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { credentialExpiresAt } from '../../contracts/oauth'
import worker from '../src/index'
import { introspectFor } from '../src/introspection'
import { credentialExpired, mintCredential, oauthConfig } from '../src/oauth'
import * as ratelimit from '../src/ratelimit'
import { auditOf, call, newTenant, post } from './helpers'
import { ORIGIN, RESOURCE, connect, refresh as refreshPlain, revokeAtServer } from './oauth'

const KEY = oauthConfig(env).clientKey!
const byte = () => crypto.getRandomValues(new Uint8Array(1))[0]!
const ip = () => `10.${byte()}.${byte()}.${byte()}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Bindings = Record<string, unknown>
const AFTER_TAG: Bindings = {
  OAUTH_RL_CREDENTIAL: env.RL_TEST_CREDENTIAL,
  OAUTH_RL_TENANT: env.RL_TEST_TENANT,
  OAUTH_RL_BEARER: env.RL_TEST_BEARER,
  OAUTH_RL_BEARER_TENANT: env.RL_TEST_BEARER_TENANT,
}

/** An environment with these limiters, a TENANT namespace that counts the objects it is asked for, and a fresh isolate's memory. */
function limited(bindings: Bindings) {
  ratelimit.resetLimiterState()
  const gets: string[] = []
  const TENANT = new Proxy(env.TENANT, {
    get(t, p) {
      if (p === 'get') return (id: DurableObjectId) => (gets.push(id.toString()), t.get(id))
      const v = Reflect.get(t, p) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
    },
  })
  const e = { ...env, ...bindings, TENANT }
  async function send(path: string, init: RequestInit & { from?: string } = {}) {
    const headers = new Headers(init.headers)
    headers.set('CF-Connecting-IP', init.from ?? ip())
    const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, { ...init, headers }) as never, e as never, {} as ExecutionContext)
    const text = await res.text()
    let body: any = text
    try {
      body = JSON.parse(text)
    } catch {
      // a page
    }
    return { status: res.status, headers: res.headers, text, body }
  }
  const form = (path: string, params: Record<string, string>, from?: string) =>
    send(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), from })
  const refresh = (clientId: string, token: string, from?: string) => form('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: token }, from)
  const revoke = (clientId: string, token: string, from?: string) => form('/oauth/revoke', { client_id: clientId, token }, from)
  const introspect = (token: string) => introspectFor(e as never, 'viz-mcp', token, RESOURCE)
  return { e, gets, send, form, refresh, revoke, introspect }
}

/** Rotate a grant's refresh token `n` times (as its client, or as a thief holding its live token), keeping every token seen. */
async function farm(clientId: string, first: string, n: number): Promise<string[]> {
  const stock = [first]
  let t = first
  for (let i = 0; i < n; i++) {
    const r = await refreshPlain(clientId, t)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    t = r.body.refresh_token
    stock.push(t)
  }
  return stock
}

/** A limiter binding that counts its calls and passes them to `real`. */
const counting = (real: RateLimit) => {
  const keys: string[] = []
  return { keys, binding: { limit: (o: { key: string }) => (keys.push(o.key), real.limit(o)) } }
}

describe('R2-M2, N1: refresh tokens farmed while approved, replayed after the grant is revoked, are each listed dead at their first answer', () => {
  it('4 farmed tokens × 3 replays at /oauth/token: each reaches the object once; the tenant\'s live client refreshes and revokes', async () => {
    const { admin } = await newTenant('r2n1')
    const bad = await connect(admin)
    const victim = await connect(admin)
    const stock = await farm(bad.clientId, bad.refresh, 3)
    expect((await post(admin, `/oauth/grants/${bad.grant.id}/revoke`, {})).status).toBe(200)
    // Every stocked token is tagged and, as the Worker reads its expiry, alive for 30 days.
    for (const t of stock) expect(credentialExpired(t, Date.now() + 29 * 86_400_000)).toBe(false)
    const l = limited(AFTER_TAG)
    const statuses: number[] = []
    for (const t of stock) for (let i = 0; i < 3; i++) statuses.push((await l.refresh(bad.clientId, t)).status)
    const objectRequests = l.gets.length
    const r = await l.refresh(victim.clientId, victim.refresh)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect((await l.revoke(victim.clientId, r.body.refresh_token)).status).toBe(200)
    // The review's run: 12 × 400 and 12 object requests, then the victim 429 "this tenant".
    expect(statuses).toEqual(new Array(12).fill(400))
    expect(objectRequests).toBe(4)
  })

  it('the same stock replayed at /oauth/revoke (whose answer is 200 either way): the live client refreshes', async () => {
    const { admin } = await newTenant('r2n1r')
    const bad = await connect(admin)
    const victim = await connect(admin)
    const stock = await farm(bad.clientId, bad.refresh, 3)
    expect((await post(admin, `/oauth/grants/${bad.grant.id}/revoke`, {})).status).toBe(200)
    const l = limited(AFTER_TAG)
    const statuses: number[] = []
    for (const t of stock) for (let i = 0; i < 3; i++) statuses.push((await l.revoke(bad.clientId, t)).status)
    const objectRequests = l.gets.length
    const r = await l.refresh(victim.clientId, victim.refresh)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(statuses).toEqual(new Array(12).fill(200))
    expect(objectRequests).toBe(4)
  })

  it('N1b: a thief of one live refresh token of an idle grant farms the same way; once the owner\'s return ends the grant, the stock spends 1 each and the live client refreshes', async () => {
    const { admin } = await newTenant('r2n1b')
    const idle = await connect(admin)
    const victim = await connect(admin)
    const stock = await farm(idle.clientId, idle.refresh, 3)
    // The owner comes back with its copy, which the thief rotated: reuse detection ends the grant.
    expect((await refreshPlain(idle.clientId, idle.refresh)).status).toBe(400)
    const l = limited(AFTER_TAG)
    for (const t of stock) for (let i = 0; i < 3; i++) expect((await l.refresh(idle.clientId, t)).status).toBe(400)
    const r = await l.refresh(victim.clientId, victim.refresh)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
  })

  it('the list is shared: in a new isolate a listed token is refused before any limit and any object, and its KV record expires with the token', async () => {
    const { tenant, admin } = await newTenant('r2n1k')
    const bad = await connect(admin)
    const stock = await farm(bad.clientId, bad.refresh, 1)
    expect((await post(admin, `/oauth/grants/${bad.grant.id}/revoke`, {})).status).toBe(200)
    const first = limited(AFTER_TAG)
    expect((await first.refresh(bad.clientId, stock[0]!)).status).toBe(400)
    expect(first.gets.length).toBe(1)
    // KV holds it, under the list's prefix, until the token's own expiry (plus the Worker's grace).
    const { keys } = await env.CONFIG.list({ prefix: `oauth-dead:${tenant}:` })
    expect(keys.length).toBe(1)
    expect(keys[0]!.expiration).toBe(Math.ceil((credentialExpiresAt(stock[0]!)! + 60_000) / 1000))
    // A new isolate: it has never met the token, and reads the list.
    const credential = counting(env.RL_TEST_CREDENTIAL as RateLimit)
    const tenantFuse = counting(env.RL_TEST_TENANT as RateLimit)
    const fresh = limited({ ...AFTER_TAG, OAUTH_RL_CREDENTIAL: credential.binding, OAUTH_RL_TENANT: tenantFuse.binding })
    for (let i = 0; i < 5; i++) {
      const r = await fresh.refresh(bad.clientId, stock[0]!)
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('invalid_grant')
      expect((await fresh.revoke(bad.clientId, stock[0]!)).status).toBe(200)
    }
    expect(fresh.gets).toEqual([])
    expect([credential.keys, tenantFuse.keys]).toEqual([[], []])
  })
})

describe('R2-M2: collecting refresh tokens shows in the grant view, and the revocation\'s audit entry keeps it', () => {
  it('a grant rotated at the per-grant limit shows 6 refreshes in its last day, an ordinary one 1; a person revoking it sees and keeps the count', async () => {
    const { admin } = await newTenant('r2farm')
    const bad = await connect(admin)
    const ordinary = await connect(admin)
    await farm(bad.clientId, bad.refresh, 5)
    const views = (await call(admin, 'GET', '/oauth/grants')).body.items as { id: string; refreshesLastDay: number }[]
    expect(views.find((g) => g.id === bad.grant.id)?.refreshesLastDay).toBe(6)
    expect(views.find((g) => g.id === ordinary.grant.id)?.refreshesLastDay).toBe(1)
    expect((await post(admin, `/oauth/grants/${bad.grant.id}/revoke`, {})).status).toBe(200)
    const entry = (await auditOf(admin, '&action=oauth.grant.revoke')).find((a) => a.target?.id === bad.grant.id)
    expect(entry?.before?.refreshesLastDay).toBe(6)
    expect(entry?.after?.refreshesLastDay).toBe(0)
  })
})

describe('R2-M2 at introspection: dead access tokens are listed at their first answer', () => {
  it('5 dead access tokens × 3 introspections (the bearer fuse is 12): every live token of the tenant is served', async () => {
    const { admin } = await newTenant('r2bi')
    const dead = []
    for (let i = 0; i < 5; i++) {
      const c = await connect(admin)
      expect((await revokeAtServer(c.clientId, c.refresh)).status).toBe(200)
      dead.push(c)
    }
    const live = await connect(admin)
    const l = limited(AFTER_TAG)
    const seen: string[] = []
    for (const d of dead) for (let i = 0; i < 3; i++) seen.push((await l.introspect(d.access)).status)
    const objectRequests = l.gets.length
    expect((await l.introspect(live.access)).status).toBe('active')
    expect(seen).toEqual(new Array(15).fill('inactive'))
    expect(objectRequests).toBe(5)
  })
})

describe('R2-M1, N2: when a narrow key is skipped, the wider ones are not asked either', () => {
  const realCredential = env.RL_TEST_CREDENTIAL as RateLimit
  for (const [name, fail] of [
    ['hangs once (beyond its share of the budget)', () => new Promise(() => {})],
    ['throws once', () => Promise.reject(new Error('blip'))],
  ] as const) {
    it(`credential binding ${name}: one dead, unexpired refresh token sent 13 times does not spend the tenant fuse; the live client refreshes`, async () => {
      const { admin } = await newTenant('r2n2')
      const dead = await connect(admin)
      // Ended by a person through the control API, so the Worker has not listed it (the review
      // revoked it at /oauth/revoke, which now lists it at once: then no limiter is asked at all).
      expect((await post(admin, `/oauth/grants/${dead.grant.id}/revoke`, {})).status).toBe(200)
      const victim = await connect(admin)
      let first = true
      const tenantFuse = counting(env.RL_TEST_TENANT as RateLimit)
      const l = limited({ ...AFTER_TAG, OAUTH_RL_CREDENTIAL: { limit: (o: { key: string }) => (first ? ((first = false), fail()) : realCredential.limit(o)) }, OAUTH_RL_TENANT: tenantFuse.binding })
      vi.spyOn(console, 'error').mockImplementation(() => {})
      for (let i = 0; i < 13; i++) expect((await l.refresh(dead.clientId, dead.refresh)).status).toBe(400)
      expect(ratelimit.limiterStatus(l.e as never).OAUTH_RL_CREDENTIAL).toBe('skipped')
      // While the credential's limiter is skipped, its tenant's fuse counted none of the 13.
      expect(tenantFuse.keys).toEqual([])
      const r = await l.refresh(victim.clientId, victim.refresh)
      vi.restoreAllMocks()
      expect(r.status, JSON.stringify(r.body)).toBe(200)
    })
  }

  it('N2b: bearer binding throws once: one dead, unexpired access token sent 13 times; every live token of the tenant is active', async () => {
    const { admin } = await newTenant('r2n2b')
    const dead = await connect(admin)
    expect((await post(admin, `/oauth/grants/${dead.grant.id}/revoke`, {})).status).toBe(200)
    const live = await connect(admin)
    const bearerFuse = counting(env.RL_TEST_BEARER_TENANT as RateLimit)
    const realBearer = env.RL_TEST_BEARER as RateLimit
    let first = true
    const l = limited({ ...AFTER_TAG, OAUTH_RL_BEARER: { limit: (o: { key: string }) => (first ? ((first = false), Promise.reject(new Error('blip'))) : realBearer.limit(o)) }, OAUTH_RL_BEARER_TENANT: bearerFuse.binding })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let i = 0; i < 13; i++) expect((await l.introspect(dead.access)).status).toBe('inactive')
    expect(bearerFuse.keys).toEqual([])
    const r = await l.introspect(live.access)
    vi.restoreAllMocks()
    expect(r.status).toBe('active')
  })
})

describe('m-1, N3: each check has its own share of the budget, and only a binding that overran its share is blamed', () => {
  /** A binding that answers `success: true` after `ms`, counting its calls. */
  const slow = (ms: number) => {
    const calls = { n: 0 }
    return { calls, binding: { limit: async () => (calls.n++, await sleep(ms), { success: true }) } }
  }
  for (const [credMs, tenMs, credStatus, tenStatus, tenCalled] of [
    [80, 30, 'skipped', 'bound', 0],
    [60, 60, 'skipped', 'bound', 0],
    [30, 30, 'bound', 'bound', 1],
    // The first version gave the tenant what was left of 100 ms (80 here): it would have answered.
    [20, 75, 'bound', 'skipped', 1],
  ] as const) {
    it(`credential ${credMs} ms, tenant ${tenMs} ms: credential ${credStatus}, tenant ${tenStatus}`, async () => {
      ratelimit.resetLimiterState()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const cred = slow(credMs)
      const ten = slow(tenMs)
      const bindings = { OAUTH_RL_CREDENTIAL: cred.binding, OAUTH_RL_TENANT: ten.binding }
      expect(await ratelimit.limitCredential(bindings as never, 'x', 'y')).toBeNull()
      const status = ratelimit.limiterStatus(bindings as never)
      vi.restoreAllMocks()
      expect([status.OAUTH_RL_CREDENTIAL, status.OAUTH_RL_TENANT]).toEqual([credStatus, tenStatus])
      expect(ten.calls.n).toBe(tenCalled)
    })
  }
})

describe('m-2: a genuine credential past its expiry is answered as the object would, and not counted against its network', () => {
  it('10 expired refresh tokens and 10 expired revocations from one network: 400 and 200, never 429; the network\'s budget is then whole', async () => {
    const { tenant, admin } = await newTenant('r2m2')
    const c = await connect(admin)
    const l = limited({ OAUTH_RL_SOURCE: env.RL_TEST_SOURCE, ...AFTER_TAG })
    const net = ip()
    for (let i = 0; i < 10; i++) {
      const old = await mintCredential('refresh', tenant, KEY, Date.now() - 2 * 3_600_000)
      const r = await l.refresh(c.clientId, old, net)
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('invalid_grant')
      expect((await l.revoke(c.clientId, await mintCredential('access', tenant, KEY, Date.now() - 2 * 3_600_000), net)).status).toBe(200)
    }
    expect(l.gets).toEqual([])
    // The network's 5 are untouched: 5 made-up refreshes are answered 400, the sixth 429.
    const forged = (i: number) => `vzr1.${tenant}.${'A'.repeat(39)}${String(i).padStart(4, '0')}`
    for (let i = 0; i < 5; i++) expect((await l.refresh(c.clientId, forged(i), net)).status).toBe(400)
    expect((await l.refresh(c.clientId, forged(5), net)).status).toBe(429)
  })
})
