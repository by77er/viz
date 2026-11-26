/**
 * Rate limits in front of the OAuth endpoints and OAuth bearers (decision D70 as rewritten after its
 * review, src/ratelimit.ts), and the layout 2 expiry the Worker checks (contracts/oauth.ts).
 *
 * The Rate Limiting bindings are miniflare's own implementation, configured in vitest.config.ts
 * under test names with small limits (source 5, source /48 8, credential 3, tenant 12, bearer 3,
 * bearer tenant 12, all per 60 s; one of 2 per 10 s to see a reset), and put in place of the
 * OAUTH_RL_* bindings here. Every other test file runs without them, as a deployment without the
 * bindings does. A limiter that fails is a stub. The exact per-grant refresh limit in the tenant's
 * object needs no binding. The review's own reproductions, turned around, are in
 * test/ratelimit-review.test.ts.
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BASE62, CREDENTIAL_LAYOUT, OAUTH_LIMITS, credentialExpiresAt } from '../../contracts/oauth'
import worker from '../src/index'
import { introspectFor } from '../src/introspection'
import { credentialExpired, credentialTagValid, expiryChars, mintCredential, oauthConfig } from '../src/oauth'
import { CHECK_BUDGET_MS, LIMITERS, RATE_PERIOD_S, SKIP_AFTER_FAILURE_MS, WORKERS_EGRESS, resetLimiterState, sourceKeys, sourceNetwork } from '../src/ratelimit'
import type { Tenant } from '../src/tenant'
import { B62 } from '../src/util'
import { newTenant, stubOf } from './helpers'
import { ORIGIN, REDIRECT, RESOURCE, authorizeUrl, connect, newClient, pkce, refresh as refreshPlain, revokeAtServer } from './oauth'
import controlWrangler from '../wrangler.jsonc?raw'
import mcpWrangler from '../../mcp/wrangler.jsonc?raw'

const KEY = oauthConfig(env).clientKey!
const byte = () => crypto.getRandomValues(new Uint8Array(1))[0]!
/** A network no other test uses. */
const ip = () => `10.${byte()}.${byte()}.${byte()}`
const hex4 = () => byte().toString(16) + byte().toString(16).padStart(2, '0')

type Bindings = Partial<Record<(typeof LIMITERS)[number], unknown>>
const ALL: Bindings = {
  OAUTH_RL_SOURCE: env.RL_TEST_SOURCE,
  OAUTH_RL_SOURCE_48: env.RL_TEST_SOURCE_48,
  OAUTH_RL_CREDENTIAL: env.RL_TEST_CREDENTIAL,
  OAUTH_RL_TENANT: env.RL_TEST_TENANT,
  OAUTH_RL_BEARER: env.RL_TEST_BEARER,
  OAUTH_RL_BEARER_TENANT: env.RL_TEST_BEARER_TENANT,
}
const AFTER_TAG: Bindings = { ...ALL, OAUTH_RL_SOURCE: undefined, OAUTH_RL_SOURCE_48: undefined }

/** An environment with these limiters and a TENANT namespace that counts the objects it is asked for. */
function limited(bindings: Bindings) {
  resetLimiterState()
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
  const health = async () => (await worker.fetch!(new Request('https://control.internal/healthz') as never, e as never, {} as ExecutionContext)).text()
  return { e, gets, send, form, register, refresh, revoke, introspect, health }
}

const forged = (prefix: string, tenant: string, i: number) => `${prefix}.${tenant}.${'A'.repeat(39)}${String(i).padStart(4, '0')}`
/** A genuine credential of the tenant, tagged, whose expiry passed two hours ago: what a former client holds. */
const expired = (kind: 'code' | 'access' | 'refresh', tenant: string) => mintCredential(kind, tenant, KEY, Date.now() - 2 * 3_600_000)

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

afterEach(() => {
  vi.restoreAllMocks()
  resetLimiterState()
})

describe('the source limits: registration and the authorization page, per network, before the body is read', () => {
  it('register and authorize share one budget per network; over it, 429 too_many_requests with Retry-After; another network is served; the metadata, preflights and other methods are not counted', async () => {
    const l = limited(ALL)
    const a = ip()
    const clientId = await newClient()
    const { challenge } = await pkce()
    for (let i = 0; i < 3; i++) expect((await l.register(a)).status).toBe(201)
    expect((await l.send(authorizeUrl(clientId, challenge), { from: a })).status).toBe(200)
    expect((await l.send(authorizeUrl(clientId, challenge), { from: a, method: 'HEAD' })).status).toBe(200)
    // Not counted: the metadata, a preflight on any of the four, a method an endpoint does not serve.
    expect((await l.send('/.well-known/oauth-authorization-server', { from: a })).status).toBe(200)
    for (const p of ['/oauth/register', '/oauth/authorize', '/oauth/token', '/oauth/revoke']) expect((await l.send(p, { method: 'OPTIONS', from: a })).status, p).toBeLessThan(429)
    expect((await l.send('/oauth/register', { method: 'GET', from: a })).status).toBe(405)
    expect((await l.send('/oauth/authorize', { method: 'POST', from: a })).status).toBe(405)
    // The sixth counted request in the minute.
    const reg = await l.register(a)
    expect429(reg)
    expect(reg.body.error_description).toMatch(/your network/)
    // The authorization page is for a person: a page, with the same code and header.
    const page = await l.send(authorizeUrl(clientId, challenge), { from: a })
    expect(page.status).toBe(429)
    expect(page.headers.get('Retry-After')).toBe('60')
    expect(page.headers.get('Content-Type')).toMatch(/^text\/plain/)
    expect(page.text).toMatch(/too_many_requests/)
    expect(page.text).not.toMatch(/request: /)
    // Another network has its own budget.
    expect((await l.register(ip())).status).toBe(201)
  })

  it('a refused registration reads no body', async () => {
    const l = limited(ALL)
    const c = ip()
    for (let i = 0; i < 5; i++) await l.register(c)
    let pulled = 0
    // highWaterMark 0: pulled only when someone reads it.
    const body = new ReadableStream({ pull(ctl) { pulled++; ctl.enqueue(new TextEncoder().encode(JSON.stringify({ redirect_uris: [REDIRECT] }))); ctl.close() } }, { highWaterMark: 0 })
    expect429(await l.send('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, from: c, duplex: 'half' } as RequestInit & { from: string }))
    expect(pulled).toBe(0)
  })

  it('counts an IPv6 address by its /64 and then its /48, an IPv4-mapped address as IPv4, a missing or unreadable header as one shared key, and the Workers address not at all', async () => {
    expect(sourceNetwork('2001:db8:1:2::1')).toBe(sourceNetwork('2001:DB8:1:2:ffff:0:0:9'))
    expect(sourceNetwork('2001:db8:1:2::1')).toBe('v6:2001:db8:1:2::/64')
    expect(sourceKeys('2001:db8:1:2::1')).toEqual([['OAUTH_RL_SOURCE', 's:v6:2001:db8:1:2::/64'], ['OAUTH_RL_SOURCE_48', 's48:v6:2001:db8:1::/48']])
    expect(sourceNetwork('2001:db8:1:3::1')).not.toBe(sourceNetwork('2001:db8:1:2::1'))
    expect(sourceKeys('2001:db8:1:3::1')[1]).toEqual(sourceKeys('2001:db8:1:2::1')[1])
    expect(sourceNetwork('::')).toBe('v6:0:0:0:0::/64')
    expect(sourceNetwork('::ffff:192.0.2.1')).toBe('v4:192.0.2.1')
    expect(sourceKeys('::ffff:192.0.2.1')).toEqual([['OAUTH_RL_SOURCE', 's:v4:192.0.2.1']])
    expect(sourceNetwork(' 192.0.2.1 ')).toBe('v4:192.0.2.1')
    expect(sourceNetwork('192.0.2.1')).not.toBe(sourceNetwork('192.0.2.2'))
    expect(sourceNetwork(null)).toBe('none')
    for (const bad of ['', 'garbage', '1.2.3.256', '1.2.3', '2001:db8::1%eth0', '::1::2', `${'1:'.repeat(30)}1`, '[::1]']) expect(sourceNetwork(bad), bad).toBe('unparsed')
    // Cloudflare's address for every cross-zone Worker subrequest, however it is written; its neighbours are counted.
    for (const w of [WORKERS_EGRESS, '2a06:98c0:3600:0:0:0:0:103', '2A06:98C0:3600::0103']) expect(sourceKeys(w), w).toEqual([])
    expect(sourceKeys('2a06:98c0:3600::104').length).toBe(2)
    // Behaviour: two addresses of one /64 share a budget; the next /64 of the /48 has its own, until the /48's is spent.
    const l = limited(ALL)
    const net48 = `2001:db8:${hex4()}`
    for (let i = 1; i <= 5; i++) expect((await l.register(`${net48}:1::${i}`)).status).toBe(201)
    expect429(await l.register(`${net48}:1:ffff::1`))
    // The /64's refusal did not count against the /48 (5 of 8): three more from another /64 of it, then the /48 refuses.
    for (let i = 1; i <= 3; i++) expect((await l.register(`${net48}:2::${i}`)).status).toBe(201)
    const wide = await l.register(`${net48}:3::1`)
    expect429(wide)
    expect(wide.body.error_description).toMatch(/your network/)
    // Another /48 is served.
    expect((await l.register(`2001:db8:${hex4()}:1::1`)).status).toBe(201)
  })
})

describe('the token endpoint and revocation: a request they refuse by themselves counts against its network; a genuine one never does', () => {
  it('made-up credentials and bad requests from one network are refused with 429 after its budget; a genuine refresh, code exchange and revocation from it are served and reach the object', async () => {
    const { tenant, admin } = await newTenant('rlsrc')
    const c = await connect(admin)
    const l = limited(ALL)
    const net = ip()
    expect((await l.refresh(c.clientId, forged('vzr1', tenant, 1), net)).status).toBe(400)
    expect((await l.revoke(c.clientId, forged('vza1', tenant, 1), net)).status).toBe(200)
    expect((await l.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: c.refresh }, net)).status).toBe(400) // no client_id
    // A genuine credential past its expiry is answered as the object would and counts against
    // nothing, its network included (round 2, m-2; before it, these two counted here).
    for (let i = 0; i < 3; i++) {
      expect((await l.refresh(c.clientId, await expired('refresh', tenant), net)).status).toBe(400)
      expect((await l.revoke(c.clientId, await expired('access', tenant), net)).status).toBe(200)
    }
    expect((await l.form('/oauth/token', { client_id: c.clientId, refresh_token: c.refresh }, net)).status).toBe(400) // no grant_type
    expect((await l.revoke(c.clientId, c.code, net)).status).toBe(200) // a code is not revoked: refused by the Worker
    expect(l.gets).toEqual([])
    const over = await l.refresh(c.clientId, forged('vzr1', tenant, 2), net)
    expect429(over)
    expect(over.body.error_description).toMatch(/your network/)
    expect(over.body.error_description).not.toMatch(/Nothing was read/)
    expect429(await l.revoke(c.clientId, forged('vza1', tenant, 2), net))
    // A genuine credential from the same network: counted against itself, never the network.
    const r = await l.refresh(c.clientId, c.refresh, net)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const c2 = await connect(admin)
    expect((await l.revoke(c2.clientId, c2.access, net)).status).toBe(200)
    expect(l.gets.length).toBe(2)
  })
})

describe('the token endpoint and revocation, after the tag and the expiry: per credential, then the tenant fuse, before the object', () => {
  it('one credential\'s flood is refused at its own allowance, before the object, and spends no more of its tenant\'s fuse than that; a refused refresh token is not spent', async () => {
    const { tenant, admin } = await newTenant('rlcred')
    const a = await connect(admin)
    const b = await connect(admin)
    const l = limited(AFTER_TAG)
    // A live refresh token the exact limit refuses, retried in a loop: three reach the object (each refused there, nothing spent).
    let token = a.refresh
    for (let i = 1; i < OAUTH_LIMITS.refreshesPerGrantPerMinute; i++) token = (await refreshPlain(a.clientId, token)).body.refresh_token
    for (let i = 0; i < 3; i++) expect((await l.refresh(a.clientId, token)).status).toBe(429)
    expect(l.gets.length).toBe(3)
    for (let i = 0; i < 5; i++) {
      l.gets.length = 0
      const r = await l.refresh(a.clientId, token)
      expect429(r)
      expect(r.body.error_description).toMatch(/this code or token/)
      expect(l.gets).toEqual([])
    }
    // Another client of the tenant: served (the tenant fuse has counted 3 of 12).
    expect((await l.refresh(b.clientId, b.refresh)).status).toBe(200)
    // The refused token was not spent: once the grant's minute has passed (its tokens dated back), it refreshes.
    await runInDurableObject(stubOf(tenant), async (_o, state) => {
      state.storage.sql.exec('UPDATE oauth_tokens SET issued_at = issued_at - 61000 WHERE tenant = ? AND grant_id = ?', tenant, a.grant.id)
    })
    expect((await refreshPlain(a.clientId, token)).status).toBe(200)
  })

  it('the tenant fuse takes 12 ÷ 3 = 4 distinct credentials that stay countable to spend; it refuses only that tenant; made-up and expired credentials count against nothing', async () => {
    const x = await newTenant('rltx')
    const y = await newTenant('rlty')
    const live = await connect(x.admin)
    // Four live grants, each at layer 2's limit: their refresh tokens stay live, and the object refuses
    // them (rate_limited) without calling them dead, so each retry counts. (A dead credential counts
    // once: the next test.)
    const capped: { clientId: string; token: string }[] = []
    for (let k = 0; k < 4; k++) {
      const c = await connect(x.admin)
      let token = c.refresh
      for (let i = 1; i < OAUTH_LIMITS.refreshesPerGrantPerMinute; i++) token = (await refreshPlain(c.clientId, token)).body.refresh_token
      capped.push({ clientId: c.clientId, token })
    }
    const yc = await connect(y.admin)
    const l = limited(AFTER_TAG)
    // Made-up credentials naming tenant X, and X's own expired ones: refused before anything counts them.
    for (let i = 0; i < 20; i++) {
      expect((await l.refresh(live.clientId, forged('vzr1', x.tenant, i))).status).toBe(400)
      expect((await l.revoke(live.clientId, forged('vza1', x.tenant, i))).status).toBe(200)
      expect((await l.refresh(live.clientId, await expired('refresh', x.tenant))).status).toBe(400)
      expect((await l.revoke(live.clientId, await expired('access', x.tenant))).status).toBe(200)
    }
    expect(l.gets).toEqual([])
    // Four such credentials, three requests each (the object refuses each; the fourth of each is refused at its own allowance), spend the 12.
    for (const c of capped) {
      for (let i = 0; i < 3; i++) expect((await l.refresh(c.clientId, c.token)).body.error_description).toMatch(/refresh tokens in the last minute/)
      const own = await l.refresh(c.clientId, c.token)
      expect429(own)
      expect(own.body.error_description).toMatch(/this code or token/)
    }
    // The fuse is spent: X's live client is refused before X's object, with the fuse named.
    l.gets.length = 0
    const rv = await l.refresh(live.clientId, live.refresh)
    expect429(rv)
    expect(rv.body.error_description).toMatch(/this tenant/)
    expect(l.gets).toEqual([])
    // Tenant Y is served.
    expect((await l.refresh(yc.clientId, yc.refresh)).status).toBe(200)
    expect((await l.revoke(yc.clientId, yc.access)).status).toBe(200)
  })

  it('a dead credential counts once: its object calls it dead, the Worker lists it, and its later requests count against nothing (round 2, R2-M2)', async () => {
    const x = await newTenant('rltd')
    const live = await connect(x.admin)
    const dead = [await connect(x.admin), await connect(x.admin), await connect(x.admin), await connect(x.admin)]
    // Ended by their clients: the refresh tokens are listed then, the access tokens not yet.
    for (const d of dead) expect((await revokeAtServer(d.clientId, d.refresh)).status).toBe(200)
    const l = limited(AFTER_TAG)
    for (const d of dead) {
      for (let i = 0; i < 3; i++) expect((await l.revoke(d.clientId, d.access)).status).toBe(200)
      for (let i = 0; i < 3; i++) expect((await l.refresh(d.clientId, d.refresh)).status).toBe(400)
    }
    // One object request per access token; none for the refresh tokens, listed when revoked. Before
    // round 2 this was 12 + 12 requests, and the fuse was spent after the first 12.
    expect(l.gets.length).toBe(4)
    expect((await l.refresh(live.clientId, live.refresh)).status).toBe(200)
  })
})

describe('introspection (OAuth bearers at /mcp): per token, then the tenant fuse, before the object', () => {
  it('one token\'s flood is refused at its own allowance before the object; another token is served; the fuse takes 4 distinct tokens; another tenant is served', async () => {
    const x = await newTenant('rlbx')
    const y = await newTenant('rlby')
    const [t1, t2, t3, t4, t5] = [await connect(x.admin), await connect(x.admin), await connect(x.admin), await connect(x.admin), await connect(x.admin)]
    const yc = await connect(y.admin)
    const l = limited(AFTER_TAG)
    for (let i = 0; i < 3; i++) expect((await l.introspect(t1!.access)).status).toBe('active')
    for (let i = 0; i < 3; i++) {
      l.gets.length = 0
      expect(await l.introspect(t1!.access)).toEqual({ v: 1, status: 'rate_limited', retryAfterMs: 60_000 })
      expect(l.gets).toEqual([])
    }
    // t1's refusals did not count against X (3 of 12): three more tokens of X spend 9 more.
    for (const t of [t2, t3, t4]) for (let i = 0; i < 3; i++) expect((await l.introspect(t!.access)).status).toBe('active')
    l.gets.length = 0
    expect((await l.introspect(t5!.access)).status).toBe('rate_limited')
    expect(l.gets).toEqual([])
    expect((await l.introspect(yc.access)).status).toBe('active')
  })

  it('made-up tokens and expired ones naming a tenant are refused before they count, expired ones as expired: the tenant\'s own tokens are still served', async () => {
    const x = await newTenant('rlbf')
    const c = await connect(x.admin)
    const l = limited(AFTER_TAG)
    for (let i = 0; i < 30; i++) {
      expect((await l.introspect(forged('vza1', x.tenant, i))).status).toBe('inactive')
      expect(await l.introspect(await expired('access', x.tenant))).toEqual({ v: 1, status: 'inactive', reason: 'expired' })
    }
    expect(l.gets).toEqual([])
    expect((await l.introspect(c.access)).status).toBe('active')
  })
})

describe('layout 2: the expiry a credential carries, under its tag (contracts/oauth.ts)', () => {
  it('codes, access and refresh tokens carry their row\'s expiry, rounded up to the minute, never earlier', async () => {
    const { tenant, admin } = await newTenant('lay')
    const t0 = Date.now()
    const c = await connect(admin)
    const rows = await runInDurableObject(stubOf(tenant), async (_o: Tenant, s) => ({
      code: s.storage.sql.exec<{ e: number }>('SELECT expires_at AS e FROM oauth_codes WHERE tenant = ?', tenant).one().e,
      access: s.storage.sql.exec<{ e: number }>("SELECT expires_at AS e FROM oauth_tokens WHERE tenant = ? AND kind = 'access'", tenant).one().e,
      refresh: s.storage.sql.exec<{ e: number }>("SELECT expires_at AS e FROM oauth_tokens WHERE tenant = ? AND kind = 'refresh'", tenant).one().e,
    }))
    for (const [kind, cred] of [['code', c.code], ['access', c.access], ['refresh', c.refresh]] as const) {
      expect(cred.split('.')[2]![0], kind).toBe(CREDENTIAL_LAYOUT.marker)
      const at = credentialExpiresAt(cred)!
      // The code's is minted a moment before its row's clock: up to a few seconds earlier, then rounded up.
      expect(at, kind).toBeGreaterThanOrEqual(rows[kind] - (kind === 'code' ? 5_000 : 0))
      expect(at, kind).toBeLessThan(rows[kind] + 60_000)
      expect(credentialExpired(cred), kind).toBe(false)
    }
    expect(credentialExpiresAt(c.access)! - t0).toBeGreaterThanOrEqual(3_600_000 - 5_000)
  })

  it('the encoding is fixed: whole minutes since 2026-11-01T00:00Z, base62 most significant first; a layout 1 credential carries none', async () => {
    expect(B62).toBe(BASE62)
    expect(CREDENTIAL_LAYOUT.expiryEpochMs).toBe(Date.UTC(2026, 10, 1))
    expect(1 + CREDENTIAL_LAYOUT.expiryChars + CREDENTIAL_LAYOUT.randomChars).toBe(27)
    expect(expiryChars(Date.UTC(2026, 10, 1))).toBe('AAAA')
    expect(expiryChars(Date.UTC(2026, 10, 1) + 1)).toBe('AAAB')
    expect(expiryChars(Date.UTC(2026, 10, 1) + 62 * 60_000)).toBe('AABA')
    expect(expiryChars(Date.UTC(2026, 11, 1, 12, 34, 5))).toBe('ALa7') // 43,955 minutes, rounded up
    expect(expiryChars(Date.UTC(2099, 0, 1))).toBe('9999')
    expect(expiryChars(0)).toBe('AAAA')
    const cred = await mintCredential('access', 'golden', KEY, Date.UTC(2026, 11, 1, 12, 34, 5))
    expect(cred).toMatch(/^vza1\.golden\.eALa7[A-Za-z0-9]{22}[A-Za-z0-9]{16}$/)
    expect(credentialExpiresAt(cred)).toBe(Date.UTC(2026, 11, 1, 12, 35))
    expect(await credentialTagValid(KEY, cred)).toBe(true)
    // The tag covers the expiry: moving it breaks the tag.
    expect(await credentialTagValid(KEY, cred.replace('.eALa7', '.eALa8'))).toBe(false)
    expect(credentialExpiresAt(`vza1.golden.${'Q'.repeat(43)}`)).toBeNull()
    expect(credentialExpiresAt('not a credential')).toBeNull()
  })

  it('the Worker refuses a credential only once its expiry and 60 s more have passed', async () => {
    const { tenant } = await newTenant('grace')
    const l = limited({})
    // Whole minutes, so the encoding adds nothing: one expired less than a minute ago, one more than a minute ago.
    const minute = Math.floor(Date.now() / 60_000) * 60_000
    const almost = await mintCredential('access', tenant, KEY, minute)
    const past = await mintCredential('access', tenant, KEY, minute - 60_000)
    expect(credentialExpiresAt(almost)).toBe(minute)
    expect(credentialExpired(almost)).toBe(false)
    expect(credentialExpired(past)).toBe(true)
    // Not past it: the object is asked (and knows no such token).
    expect(await l.introspect(almost)).toEqual({ v: 1, status: 'inactive', reason: 'unknown' })
    expect(l.gets.length).toBe(1)
    expect(await l.introspect(past)).toEqual({ v: 1, status: 'inactive', reason: 'expired' })
    expect(l.gets.length).toBe(1)
  })
})

describe('a limiter that fails lets the request through (fails open, D70), says so once per isolate, and is skipped for a while', () => {
  const throwing = { limit: () => { throw new Error('limiter down') } }
  const rejecting = { limit: () => Promise.reject(new Error('limiter down')) }
  const malformed = { limit: async () => ({ ok: true }) }
  const hanging = { limit: () => new Promise(() => {}) }
  const every = (b: unknown): Bindings => Object.fromEntries(LIMITERS.map((n) => [n, b]))

  it('absent, throwing, rejecting or answering without "success": every endpoint and introspection serve; each absent binding is logged once, each failing one once, and a wider one is never asked while a narrower one fails (round 2, R2-M1)', async () => {
    const { admin } = await newTenant('rlopen')
    for (const [name, bindings] of [['absent', {}], ['throwing', every(throwing)], ['rejecting', every(rejecting)], ['malformed', every(malformed)]] as const) {
      const l = limited(bindings as Bindings)
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      for (let round = 0; round < 2; round++) {
        const c = await connect(admin)
        const clientId = await newClient()
        const { challenge } = await pkce()
        expect((await l.register()).status, name).toBe(201)
        expect((await l.register(`2001:db8:${hex4()}::1`)).status, name).toBe(201)
        expect((await l.send(authorizeUrl(clientId, challenge))).status, name).toBe(200)
        expect((await l.introspect(c.access)).status, name).toBe('active')
        const r = await l.refresh(c.clientId, c.refresh)
        expect(r.status, name).toBe(200)
        expect((await l.revoke(c.clientId, r.body.refresh_token)).status, name).toBe(200)
        expect((await l.refresh(c.clientId, forged('vzr1', 'nobody', round))).status, name).toBe(400)
      }
      // (The helpers that connect use the plain environment, whose limiters are absent: those lines are the absent case's.)
      const kind = name === 'absent' ? / is not bound;/ : / failed;/
      const lines = log.mock.calls.map((a) => String(a[0])).filter((m) => m.startsWith('control: rate limiter') && kind.test(m))
      // Absent: all six, whether or not a request came to ask them. Failing: the narrowest of each
      // chain, once; the wider ones were never asked (before round 2 each was asked alone and logged).
      const narrow = ['OAUTH_RL_SOURCE', 'OAUTH_RL_CREDENTIAL', 'OAUTH_RL_BEARER']
      for (const n of LIMITERS) expect(lines.filter((m) => m.includes(` ${n} `)).length, `${name} ${n}`).toBe(name === 'absent' || narrow.includes(n) ? 1 : 0)
      log.mockRestore()
    }
  })

  it(`hanging: a request's checks give up together after ${CHECK_BUDGET_MS} ms, the binding is then skipped in this isolate for ${SKIP_AFTER_FAILURE_MS / 1000} s, and /healthz says so`, async () => {
    const { admin } = await newTenant('rlhang')
    const c = await connect(admin)
    const l = limited(every(hanging))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const t0 = Date.now()
    expect((await l.register()).status).toBe(201)
    expect((await l.introspect(c.access)).status).toBe('active')
    expect(Date.now() - t0).toBeLessThan(4 * CHECK_BUDGET_MS + 500)
    // Every binding these asked has failed once; asked again, they are skipped at once.
    expect((await l.register()).status).toBe(201)
    expect((await l.introspect(c.access)).status).toBe('active')
    const t1 = Date.now()
    expect((await l.register()).status).toBe(201)
    expect((await l.introspect(c.access)).status).toBe('active')
    expect(Date.now() - t1).toBeLessThan(CHECK_BUDGET_MS)
    expect(await l.health()).toMatch(/^OAUTH_RL_SOURCE: skipped$/m)
    expect(await l.health()).toMatch(/^OAUTH_RL_BEARER: skipped$/m)
  }, 30_000)
})

describe('one budget per request, a share per check (review m-1; round 2, m-1 and R2-M1)', () => {
  it(`a binding that hangs takes only its own share (${CHECK_BUDGET_MS / 2} ms of ${CHECK_BUDGET_MS}); while it is skipped the wider binding is not asked at all`, async () => {
    const { admin } = await newTenant('rlbudget')
    const c = await connect(admin)
    const calls = { credential: 0, tenant: 0 }
    const l = limited({
      OAUTH_RL_CREDENTIAL: { limit: () => (calls.credential++, new Promise(() => {})) },
      OAUTH_RL_TENANT: { limit: () => (calls.tenant++, new Promise(() => {})) },
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await l.refresh(c.clientId, c.refresh)
    expect(r.status).toBe(200)
    expect(calls).toEqual({ credential: 1, tenant: 0 })
    // Before round 2 the next request asked the tenant's fuse alone (R2-M1).
    expect((await l.refresh(c.clientId, r.body.refresh_token)).status).toBe(200)
    expect(calls).toEqual({ credential: 1, tenant: 0 })
  })

  it('a check that answers within its share is not blamed for another\'s time, and two checks together stay within the budget', async () => {
    const { admin } = await newTenant('rlshare')
    const c = await connect(admin)
    const answer = (ms: number) => ({ limit: async () => (await new Promise((r) => setTimeout(r, ms)), { success: true }) })
    // The credential takes 40 ms of its 50; the first version left the tenant 60, this one gives it 50, and it answers in 45.
    const l = limited({ OAUTH_RL_CREDENTIAL: answer(40), OAUTH_RL_TENANT: answer(45) })
    const t0 = Date.now()
    expect((await l.refresh(c.clientId, c.refresh)).status).toBe(200)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80)
    expect(await l.health()).toMatch(/^OAUTH_RL_CREDENTIAL: bound$/m)
    expect(await l.health()).toMatch(/^OAUTH_RL_TENANT: bound$/m)
    // A tenant check of 60 ms overran its 50 ms share (the first version would have let it run to 100 ms in all).
    const m = limited({ OAUTH_RL_CREDENTIAL: answer(5), OAUTH_RL_TENANT: answer(60) })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const c2 = await connect(admin)
    expect((await m.refresh(c2.clientId, c2.refresh)).status).toBe(200)
    expect(await m.health()).toMatch(/^OAUTH_RL_TENANT: skipped$/m)
    expect(await m.health()).toMatch(/^OAUTH_RL_CREDENTIAL: bound$/m)
  })
})

describe('/healthz reports each limiter (review M-2, m-2)', () => {
  it('bound or absent, one line each after "ok", and whether OAuth can issue anything; an absent limiter is not a 503', async () => {
    const some = limited({ OAUTH_RL_SOURCE: env.RL_TEST_SOURCE, OAUTH_RL_BEARER: env.RL_TEST_BEARER })
    const text = await some.health()
    expect(text.split('\n')[0]).toBe('ok')
    expect(text).toMatch(/^OAUTH_CLIENT_KEY: set$/m)
    expect(text).toMatch(/^OAUTH_RL_SOURCE: bound$/m)
    expect(text).toMatch(/^OAUTH_RL_BEARER: bound$/m)
    for (const n of ['OAUTH_RL_SOURCE_48', 'OAUTH_RL_CREDENTIAL', 'OAUTH_RL_TENANT', 'OAUTH_RL_BEARER_TENANT']) expect(text).toMatch(new RegExp(`^${n}: absent$`, 'm'))
    expect(text).not.toMatch(/test-only-oauth/)
    const res = await worker.fetch!(new Request('https://control.internal/healthz') as never, { ...env, OAUTH_CLIENT_KEY: undefined } as never, {} as ExecutionContext)
    expect(res.status).toBe(200)
    expect(await res.text()).toMatch(/^OAUTH_CLIENT_KEY: absent$/m)
  })
})

describe('the limits are per Cloudflare location only while control and mcp have no Smart Placement (review m-8)', () => {
  it('neither Worker\'s configuration places it', () => {
    for (const [name, text] of [['control', controlWrangler], ['mcp', mcpWrangler]]) expect(text, name).not.toMatch(/"placement"/)
  })
})

describe('the shipped rate limits match the source (review round 4, m-1)', () => {
  it('wrangler.jsonc binds exactly LIMITERS, each over RATE_PERIOD_S, and each fuse is at least 1,200 times the per-credential limit', () => {
    // The block is plain JSON inside the JSONC file: read it without a JSONC parser.
    const block = /"ratelimits":\s*(\[[\s\S]*?\n\s*\])/.exec(controlWrangler)
    expect(block, 'control/wrangler.jsonc has no ratelimits block').not.toBeNull()
    const bound = JSON.parse(block![1]!) as { name: string; simple: { limit: number; period: number } }[]
    expect(bound.map((b) => b.name).sort()).toEqual([...LIMITERS].sort())
    for (const b of bound) {
      expect(b.simple.period, b.name).toBe(RATE_PERIOD_S)
      expect(Number.isInteger(b.simple.limit) && b.simple.limit > 0, b.name).toBe(true)
    }
    const limit = (n: string) => bound.find((b) => b.name === n)!.simple.limit
    // D70: tripping a tenant fuse must take at least 1,200 distinct unexpired credentials at the token
    // endpoint, and at least 25 at introspection.
    expect(limit('OAUTH_RL_TENANT') / limit('OAUTH_RL_CREDENTIAL')).toBeGreaterThanOrEqual(1200)
    expect(limit('OAUTH_RL_BEARER_TENANT') / limit('OAUTH_RL_BEARER')).toBeGreaterThanOrEqual(25)
  })
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
