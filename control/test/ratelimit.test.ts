/**
 * Rate limits in front of the OAuth endpoints and OAuth bearers (decision D68, src/ratelimit.ts).
 *
 * The Rate Limiting bindings are miniflare's own implementation, configured in vitest.config.ts
 * under test names with small limits (source 5, client 3, tenant 6, bearer 3, bearer tenant 5, all
 * per 60 s; one of 2 per 10 s to see a reset), and put in place of the OAUTH_RL_* bindings here.
 * Every other test file runs without them, as a deployment without the bindings does. A limiter that
 * fails is a stub. The exact per-grant refresh limit in the tenant's object needs no binding.
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { OAUTH_LIMITS } from '../../contracts/oauth'
import worker from '../src/index'
import { introspectFor } from '../src/introspection'
import { CHECK_TIMEOUT_MS, sourceNetwork } from '../src/ratelimit'
import type { Tenant } from '../src/tenant'
import { newTenant, stubOf } from './helpers'
import { ORIGIN, REDIRECT, RESOURCE, authorizeUrl, connect, newClient, pkce, refresh as refreshPlain, revokeAtServer } from './oauth'

const byte = () => crypto.getRandomValues(new Uint8Array(1))[0]!
/** A network no other test uses. */
const ip = () => `10.${byte()}.${byte()}.${byte()}`

type Bindings = Partial<Record<'OAUTH_RL_SOURCE' | 'OAUTH_RL_CLIENT' | 'OAUTH_RL_TENANT' | 'OAUTH_RL_BEARER' | 'OAUTH_RL_BEARER_TENANT', unknown>>
const ALL: Bindings = {
  OAUTH_RL_SOURCE: env.RL_TEST_SOURCE,
  OAUTH_RL_CLIENT: env.RL_TEST_CLIENT,
  OAUTH_RL_TENANT: env.RL_TEST_TENANT,
  OAUTH_RL_BEARER: env.RL_TEST_BEARER,
  OAUTH_RL_BEARER_TENANT: env.RL_TEST_BEARER_TENANT,
}
const AFTER_TAG: Bindings = { ...ALL, OAUTH_RL_SOURCE: undefined }

/** An environment with these limiters and a TENANT namespace that counts the objects it is asked for. */
function limited(bindings: Bindings) {
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
  const register = (from?: string) => send('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'RL agent', redirect_uris: [REDIRECT] }), from })
  const refresh = (clientId: string, token: string, from?: string) => form('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: token }, from)
  const revoke = (clientId: string, token: string, from?: string) => form('/oauth/revoke', { client_id: clientId, token }, from)
  const introspect = (token: string) => introspectFor(e as never, 'viz-mcp', token, RESOURCE)
  return { e, gets, send, form, register, refresh, revoke, introspect }
}

const forged = (prefix: string, tenant: string, i: number) => `${prefix}.${tenant}.${'A'.repeat(39)}${String(i).padStart(4, '0')}`

function expect429(r: { status: number; headers: Headers; body: any }, retryAfter = '60') {
  expect(r.status).toBe(429)
  expect(r.headers.get('Retry-After')).toBe(retryAfter)
  expect(r.headers.get('Content-Type')).toMatch(/^application\/json/)
  expect(r.headers.get('Cache-Control')).toBe('no-store')
  expect(r.headers.get('Access-Control-Allow-Origin')).toBe('*')
  expect(r.body.error).toBe('too_many_requests')
  expect(typeof r.body.error_description).toBe('string')
}

/** Rows written, alarm writes and KV writes in a tenant's object while `fn` runs. */
async function writesDuring(tenant: string, fn: () => Promise<void>): Promise<number> {
  const probe = { n: 0 }
  await runInDurableObject(stubOf(tenant), async (o: Tenant, state) => {
    const s = state.storage as unknown as { setAlarm: (...a: unknown[]) => Promise<void>; deleteAlarm: (...a: unknown[]) => Promise<void> }
    const set = s.setAlarm.bind(s)
    const del = s.deleteAlarm.bind(s)
    s.setAlarm = (...a: unknown[]) => (probe.n++, set(...a))
    s.deleteAlarm = (...a: unknown[]) => (probe.n++, del(...a))
    probe.n -= o.rowsWritten
  })
  await fn()
  return probe.n + (await runInDurableObject(stubOf(tenant), async (o: Tenant) => o.rowsWritten))
}

describe('the source limit: per client network, on register, authorize, token and revoke, before the body is read', () => {
  it('the four endpoints share one budget per network; over it, 429 too_many_requests with Retry-After; another network is served', async () => {
    const l = limited(ALL)
    const a = ip()
    const clientId = await newClient()
    const { challenge } = await pkce()
    expect((await l.register(a)).status).toBe(201)
    expect((await l.register(a)).status).toBe(201)
    expect((await l.send(authorizeUrl(clientId, challenge), { from: a })).status).toBe(200)
    expect((await l.form('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code: forged('vzc1', 'nobody', 1), code_verifier: 'x'.repeat(43), redirect_uri: REDIRECT }, a)).status).toBe(400)
    expect((await l.form('/oauth/revoke', { client_id: clientId, token: forged('vzr1', 'nobody', 1) }, a)).status).toBe(200)
    // The sixth in the minute, at each endpoint.
    const reg = await l.register(a)
    expect429(reg)
    expect(reg.body.error_description).toMatch(/your network/)
    expect429(await l.form('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: forged('vzr1', 'nobody', 2) }, a))
    expect429(await l.form('/oauth/revoke', { client_id: clientId, token: forged('vzr1', 'nobody', 2) }, a))
    // The authorization page is for a person: a page, with the same code and header.
    const page = await l.send(authorizeUrl(clientId, challenge), { from: a })
    expect(page.status).toBe(429)
    expect(page.headers.get('Retry-After')).toBe('60')
    expect(page.headers.get('Content-Type')).toMatch(/^text\/plain/)
    expect(page.text).toMatch(/too_many_requests/)
    expect(page.text).not.toMatch(/request: /)
    // Another network has its own budget.
    expect((await l.register(ip())).status).toBe(201)
    // The metadata and CORS preflights are not counted.
    expect((await l.send('/.well-known/oauth-authorization-server', { from: a })).status).toBe(200)
    expect((await l.send('/oauth/token', { method: 'OPTIONS', from: a })).status).toBe(204)
  })

  it('a refused request reads no body, asks no object and spends nothing: the genuine code it carried still works', async () => {
    const { tenant, admin } = await newTenant('rlsrc')
    const clientId = await newClient()
    const { verifier, challenge } = await pkce()
    const { authorize } = await import('./oauth')
    const { handle } = await authorize(clientId, challenge)
    const { approve, codeOf } = await import('./oauth')
    const code = codeOf((await approve(admin, handle!)).body.redirect).code
    const l = limited(ALL)
    const c = ip()
    for (let i = 0; i < 5; i++) await l.register(c)
    l.gets.length = 0
    let pulled = 0
    const params = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT, resource: RESOURCE }).toString()
    const body = new ReadableStream({ pull(ctl) { pulled++; ctl.enqueue(new TextEncoder().encode(params)); ctl.close() } })
    expect429(await l.send('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, from: c, duplex: 'half' } as RequestInit & { from: string }))
    expect(pulled).toBe(0)
    expect(l.gets).toEqual([])
    // From another network the same code is exchanged: the refusal did not spend it.
    const ok = await l.form('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT, resource: RESOURCE })
    expect(ok.status).toBe(200)
    expect(ok.body.access_token).toMatch(new RegExp(`^vza1\\.${tenant}\\.`))
  })

  it('counts an IPv6 address by its /64, an IPv4-mapped address as IPv4, and a missing or unreadable header as one shared key', async () => {
    expect(sourceNetwork('2001:db8:1:2::1')).toBe(sourceNetwork('2001:DB8:1:2:ffff:0:0:9'))
    expect(sourceNetwork('2001:db8:1:2::1')).toBe('v6:2001:db8:1:2::/64')
    expect(sourceNetwork('2001:db8:1:3::1')).not.toBe(sourceNetwork('2001:db8:1:2::1'))
    expect(sourceNetwork('::')).toBe('v6:0:0:0:0::/64')
    expect(sourceNetwork('::ffff:192.0.2.1')).toBe('v4:192.0.2.1')
    expect(sourceNetwork(' 192.0.2.1 ')).toBe('v4:192.0.2.1')
    expect(sourceNetwork('192.0.2.1')).not.toBe(sourceNetwork('192.0.2.2'))
    expect(sourceNetwork(null)).toBe('none')
    for (const bad of ['', 'garbage', '1.2.3.256', '1.2.3', '2001:db8::1%eth0', '::1::2', `${'1:'.repeat(30)}1`, '[::1]']) expect(sourceNetwork(bad), bad).toBe('unparsed')
    // Behaviour: two addresses of one /64 share a budget; the next /64 has its own.
    const l = limited(ALL)
    const net = `2001:db8:${byte().toString(16)}${byte().toString(16)}:${byte().toString(16)}`
    for (let i = 1; i <= 5; i++) expect((await l.register(`${net}::${i}`)).status).toBe(201)
    expect429(await l.register(`${net}:ffff::1`))
    expect((await l.register(`${net.replace(/:([0-9a-f]+)$/, (_m, h) => `:${(parseInt(h, 16) + 1).toString(16)}`)}::1`)).status).toBe(201)
  })
})

describe('the token endpoint and revocation, after the tag: per client in a tenant, then per tenant, before the object', () => {
  it('a client looping on the token endpoint is refused after its allowance, before the object, without spending its token; another client of the tenant is served', async () => {
    const { admin } = await newTenant('rlcli')
    const a = await connect(admin)
    const b = await connect(admin)
    const l = limited(AFTER_TAG)
    let token = a.refresh
    for (let i = 0; i < 3; i++) {
      const r = await l.refresh(a.clientId, token)
      expect(r.status).toBe(200)
      token = r.body.refresh_token
    }
    // The loop goes on: refused at its client's allowance, never reaching the object, and those
    // refusals do not count against the tenant (the narrower key is asked first).
    for (let i = 0; i < 5; i++) {
      l.gets.length = 0
      const r = await l.refresh(a.clientId, token)
      expect429(r)
      expect(r.body.error_description).toMatch(/this client/)
      expect(l.gets).toEqual([])
    }
    // Another client of the same tenant: served (the tenant has spent 3 of 6).
    expect((await l.refresh(b.clientId, b.refresh)).status).toBe(200)
    // The refused token was not spent: without the limiter it still refreshes.
    expect((await refreshPlain(a.clientId, token)).status).toBe(200)
  })

  it('one tenant\'s token and revocation budget, once spent, refuses only that tenant, and only credentials it made count', async () => {
    const x = await newTenant('rltx')
    const y = await newTenant('rlty')
    const xs = [await connect(x.admin), await connect(x.admin), await connect(x.admin)]
    const yc = await connect(y.admin)
    const l = limited(AFTER_TAG)
    // Made-up credentials naming tenant X are refused before they count (the tag comes first).
    for (let i = 0; i < 20; i++) {
      expect((await l.refresh(xs[0]!.clientId, forged('vzr1', x.tenant, i))).status).toBe(400)
      expect((await l.revoke(xs[0]!.clientId, forged('vzr1', x.tenant, i))).status).toBe(200)
    }
    expect(l.gets).toEqual([])
    // Six of X's own requests (revocations of access tokens and refreshes; the tenant allows 6).
    for (const c of xs) expect((await l.revoke(c.clientId, c.access)).status).toBe(200)
    for (const c of xs) expect((await l.refresh(c.clientId, c.refresh)).status).toBe(200)
    // The seventh, a revocation or a token request: refused before X's object.
    l.gets.length = 0
    const rv = await l.revoke(xs[0]!.clientId, xs[0]!.refresh)
    expect429(rv)
    expect(rv.body.error_description).toMatch(/this tenant/)
    expect429(await l.refresh(xs[1]!.clientId, xs[1]!.refresh))
    expect(l.gets).toEqual([])
    // Tenant Y is served.
    expect((await l.refresh(yc.clientId, yc.refresh)).status).toBe(200)
    expect((await l.revoke(yc.clientId, yc.access)).status).toBe(200)
  })
})

describe('introspection (OAuth bearers at /mcp): per token, then per tenant, before the object', () => {
  it('one token\'s flood is refused before the object; another token of the tenant is served until the tenant\'s budget is spent; another tenant is served', async () => {
    const x = await newTenant('rlbx')
    const y = await newTenant('rlby')
    const [t1, t2, t3] = [await connect(x.admin), await connect(x.admin), await connect(x.admin)]
    const yc = await connect(y.admin)
    const l = limited(AFTER_TAG)
    for (let i = 0; i < 3; i++) expect((await l.introspect(t1!.access)).status).toBe('active')
    for (let i = 0; i < 3; i++) {
      l.gets.length = 0
      expect(await l.introspect(t1!.access)).toEqual({ v: 1, status: 'rate_limited', retryAfterMs: 60_000 })
      expect(l.gets).toEqual([])
    }
    // t1's refusals did not count against X (3 of 5 spent): t2 gets two more, then X is spent for every token.
    expect((await l.introspect(t2!.access)).status).toBe('active')
    expect((await l.introspect(t2!.access)).status).toBe('active')
    l.gets.length = 0
    expect((await l.introspect(t2!.access)).status).toBe('rate_limited')
    expect((await l.introspect(t3!.access)).status).toBe('rate_limited')
    expect(l.gets).toEqual([])
    expect((await l.introspect(yc.access)).status).toBe('active')
  })

  it('made-up tokens naming a tenant are refused before they count: the tenant\'s own tokens are still served', async () => {
    const x = await newTenant('rlbf')
    const c = await connect(x.admin)
    const l = limited(AFTER_TAG)
    for (let i = 0; i < 30; i++) expect((await l.introspect(forged('vza1', x.tenant, i))).status).toBe('inactive')
    expect(l.gets).toEqual([])
    expect((await l.introspect(c.access)).status).toBe('active')
  })
})

describe('a limiter that fails lets the request through (fails open, D68)', () => {
  const throwing = { limit: () => { throw new Error('limiter down') } }
  const rejecting = { limit: () => Promise.reject(new Error('limiter down')) }
  const malformed = { limit: async () => ({ ok: true }) }
  const hanging = { limit: () => new Promise(() => {}) }
  const every = (b: unknown): Bindings => ({ OAUTH_RL_SOURCE: b, OAUTH_RL_CLIENT: b, OAUTH_RL_TENANT: b, OAUTH_RL_BEARER: b, OAUTH_RL_BEARER_TENANT: b })

  it('absent, throwing, rejecting or answering without "success": every endpoint and introspection serve', async () => {
    const { admin } = await newTenant('rlopen')
    for (const [name, bindings] of [['absent', {}], ['throwing', every(throwing)], ['rejecting', every(rejecting)], ['malformed', every(malformed)]] as const) {
      const l = limited(bindings as Bindings)
      const c = await connect(admin)
      const clientId = await newClient()
      const { challenge } = await pkce()
      expect((await l.register()).status, name).toBe(201)
      expect((await l.send(authorizeUrl(clientId, challenge))).status, name).toBe(200)
      expect((await l.introspect(c.access)).status, name).toBe('active')
      const r = await l.refresh(c.clientId, c.refresh)
      expect(r.status, name).toBe(200)
      expect((await l.revoke(c.clientId, r.body.refresh_token)).status, name).toBe(200)
    }
  })

  it(`hanging: each check gives up after ${CHECK_TIMEOUT_MS} ms and the request is served`, async () => {
    const { admin } = await newTenant('rlhang')
    const c = await connect(admin)
    const l = limited(every(hanging))
    const t0 = Date.now()
    expect((await l.register()).status).toBe(201)
    expect((await l.introspect(c.access)).status).toBe('active')
    expect(Date.now() - t0).toBeLessThan(10 * CHECK_TIMEOUT_MS)
  }, 30_000)
})

describe('a limit resets with its window', () => {
  it('a real binding with a 10 s window: refused at its limit, served again in the next window', async () => {
    const l = limited({ OAUTH_RL_SOURCE: env.RL_TEST_10S })
    // miniflare's windows start on multiples of the period: begin early in one, so the first three land in it.
    const into = Date.now() % 10_000
    if (into > 6_000) await new Promise((r) => setTimeout(r, 10_000 - into + 50))
    const a = ip()
    expect((await l.register(a)).status).toBe(201)
    expect((await l.register(a)).status).toBe(201)
    expect429(await l.register(a))
    await new Promise((r) => setTimeout(r, 10_000 - (Date.now() % 10_000) + 100))
    expect((await l.register(a)).status).toBe(201)
  }, 40_000)
})

describe('the exact limit in the tenant\'s object: refresh tokens per grant per minute', () => {
  it(`a refresh loop gets ${OAUTH_LIMITS.refreshesPerGrantPerMinute} refresh tokens a minute (the exchange's included), from any location, then 429; the refusal writes nothing and spends nothing; another grant is served; it resets`, async () => {
    const { tenant, admin } = await newTenant('rlgrant')
    const a = await connect(admin)
    const b = await connect(admin)
    let token = a.refresh
    for (let i = 1; i < OAUTH_LIMITS.refreshesPerGrantPerMinute; i++) {
      const r = await refreshPlain(a.clientId, token)
      expect(r.status).toBe(200)
      token = r.body.refresh_token
    }
    let refused: Awaited<ReturnType<typeof refreshPlain>> | undefined
    const written = await writesDuring(tenant, async () => {
      refused = await refreshPlain(a.clientId, token)
    })
    expect429(refused!, refused!.headers.get('Retry-After')!)
    const after = Number(refused!.headers.get('Retry-After'))
    expect(after).toBeGreaterThanOrEqual(1)
    expect(after).toBeLessThanOrEqual(60)
    expect(refused!.body.error_description).toMatch(/refresh token you sent was not used/)
    expect(written).toBe(0)
    // Another grant of the same tenant is served.
    expect((await refreshPlain(b.clientId, b.refresh)).status).toBe(200)
    // A minute later (the grant's tokens dated back), the same token refreshes: it was not spent.
    await runInDurableObject(stubOf(tenant), async (_o, state) => {
      state.storage.sql.exec('UPDATE oauth_tokens SET issued_at = issued_at - 61000 WHERE tenant = ? AND grant_id = ?', tenant, a.grant.id)
    })
    expect((await refreshPlain(a.clientId, token)).status).toBe(200)
  })

  it('reuse detection comes first: a rotated refresh token presented while the grant is at its limit still ends the grant', async () => {
    const { admin } = await newTenant('rlreuse')
    const a = await connect(admin)
    let token = a.refresh
    const spent: string[] = []
    for (let i = 1; i < OAUTH_LIMITS.refreshesPerGrantPerMinute; i++) {
      const r = await refreshPlain(a.clientId, token)
      spent.push(token)
      token = r.body.refresh_token
    }
    expect((await refreshPlain(a.clientId, token)).status).toBe(429)
    const reuse = await refreshPlain(a.clientId, spent[0]!)
    expect(reuse.status).toBe(400)
    expect(reuse.body.error).toBe('invalid_grant')
    // The grant has ended: its live token is refused as unknown, not as over a limit.
    const after = await refreshPlain(a.clientId, token)
    expect(after.status).toBe(400)
    expect(after.body.error).toBe('invalid_grant')
    expect((await revokeAtServer(a.clientId, token)).status).toBe(200)
  })
})
