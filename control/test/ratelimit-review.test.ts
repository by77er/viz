/**
 * The adversarial review of D70 (design/reviews/d70-rate-limits.md), its reproductions turned
 * around: each attack is made as the review made it (R1 to R5), at a scale that spends the test
 * bindings' limits, and the test asserts that the victim is served. Run against the code the review
 * read, every test here fails (control/README.md, "Rate limits in front of OAuth (D70)", the
 * before-and-after runs); against this code, each passes.
 *
 * Same harness as test/ratelimit.test.ts: miniflare's Rate Limiting bindings with small limits
 * (vitest.config.ts: source 5, source /48 8, credential 3, tenant 12, bearer 3, bearer tenant 12,
 * per 60 s). `OAUTH_RL_CLIENT` is bound as the release the review read bound it (per client id, 3),
 * so that the same file shows R1b against that release; this release has no such binding.
 *
 * Also here: the two release skews of the credential format change (contracts/oauth.ts, layout 2):
 * this release serves what the previous one issued until it expires, and the previous release's
 * checks accept what this one issues.
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { OAUTH_LIFETIMES, parseCredential, type TenantOAuthRpc } from '../../contracts/oauth'
import worker from '../src/index'
import { introspectFor } from '../src/introspection'
import { hashCredential, mintCredential, oauthConfig, seal, sealAad, unseal } from '../src/oauth'
import * as ratelimit from '../src/ratelimit'
import type { Tenant } from '../src/tenant'
import { previousCredentialTagValid, previousMintCredential, previousParseCredential } from './fixtures/previous-release-oauth'
import { newTenant, stubOf } from './helpers'
import { ORIGIN, RESOURCE, connect, refresh as refreshPlain, revokeAtServer } from './oauth'

const KEY = oauthConfig(env).clientKey!
const byte = () => crypto.getRandomValues(new Uint8Array(1))[0]!
const ip = () => `10.${byte()}.${byte()}.${byte()}`
const WORKERS = '2a06:98c0:3600::103'

type Bindings = Record<string, unknown>
const ALL: Bindings = {
  OAUTH_RL_SOURCE: env.RL_TEST_SOURCE,
  OAUTH_RL_SOURCE_48: env.RL_TEST_SOURCE_48,
  OAUTH_RL_CREDENTIAL: env.RL_TEST_CREDENTIAL,
  OAUTH_RL_TENANT: env.RL_TEST_TENANT,
  OAUTH_RL_BEARER: env.RL_TEST_BEARER,
  OAUTH_RL_BEARER_TENANT: env.RL_TEST_BEARER_TENANT,
  // The release the review read keyed this per presented client id; this release does not read it.
  OAUTH_RL_CLIENT: env.RL_TEST_CREDENTIAL,
}
const AFTER_TAG: Bindings = { ...ALL, OAUTH_RL_SOURCE: undefined, OAUTH_RL_SOURCE_48: undefined }

function limited(bindings: Bindings) {
  ;(ratelimit as { resetLimiterState?: () => void }).resetLimiterState?.()
  const gets: string[] = []
  const TENANT = new Proxy(env.TENANT, {
    get(t, p) {
      if (p === 'get') return (id: DurableObjectId) => (gets.push(id.toString()), t.get(id))
      const v = Reflect.get(t, p) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
    },
  })
  const e = { ...env, ...bindings, TENANT }
  async function send(path: string, init: RequestInit & { from?: string | null } = {}) {
    const headers = new Headers(init.headers)
    if (init.from !== null) headers.set('CF-Connecting-IP', init.from ?? ip())
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
  const form = (path: string, params: Record<string, string>, from?: string | null) =>
    send(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), from })
  const register = (from?: string | null) => send('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'RV agent', redirect_uris: ['http://127.0.0.1:33418/callback'] }), from })
  const refresh = (clientId: string, token: string, from?: string | null) => form('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: token }, from)
  const revoke = (clientId: string, token: string, from?: string | null) => form('/oauth/revoke', { client_id: clientId, token }, from)
  const introspect = (token: string) => introspectFor(e as never, 'viz-mcp', token, RESOURCE)
  return { e, gets, send, form, register, refresh, revoke, introspect }
}

/** A client id the Worker accepts by shape: `vzk1.<16..3000 base64url>.<43 base64url>`. */
const madeUpClientId = (i: number) => `vzk1.${'Q'.repeat(20)}${String(i).padStart(6, '0')}.${'M'.repeat(43)}`

/** A grant connected and then ended by its own client: what a former client keeps (its last refresh and access tokens). */
async function deadCredentials(admin: string) {
  const c = await connect(admin)
  expect((await revokeAtServer(c.clientId, c.refresh)).status).toBe(200) // RFC 7009: a refresh token ends its grant
  return c
}

/** What a former client holds an hour and more later: genuine, tagged credentials of the tenant whose expiry has passed. */
const expired = (kind: 'code' | 'access' | 'refresh', tenant: string) => mintCredential(kind, tenant, KEY, Date.now() - 2 * 3_600_000)

describe('B-1, R1 and R1b: a dead credential at the token endpoint spends at most its own allowance; the tenant\'s live client is served', () => {
  it('R1: one dead refresh token sent 13 times with made-up client ids (the tenant fuse is 12) reaches no object; the live client refreshes', async () => {
    const { admin } = await newTenant('rr1')
    const dead = await deadCredentials(admin)
    const victim = await connect(admin)
    const l = limited(AFTER_TAG)
    const statuses: number[] = []
    for (let i = 0; i < 13; i++) statuses.push((await l.refresh(madeUpClientId(i), dead.refresh)).status)
    const gets = l.gets.length
    const r = await l.refresh(victim.clientId, victim.refresh)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    // Before the fix: 13 × 400, each reaching the object. After round 1: 3 reached it, then its own
    // allowance refused it ([400 × 3, 429 × 10]). Since round 2 (R2-M2) its client's revocation listed
    // it dead, so every request is answered as the object would, before any limit or object.
    expect(statuses).toEqual(new Array(13).fill(400))
    expect(gets).toBe(0)
  })

  it('R1b: a dead credential sent with the victim client\'s own id spends nothing of that client\'s: it refreshes', async () => {
    const { admin } = await newTenant('rr1b')
    const dead = await deadCredentials(admin)
    const victim = await connect(admin)
    const l = limited(AFTER_TAG)
    for (let i = 0; i < 13; i++) await l.refresh(victim.clientId, dead.refresh)
    const r = await l.refresh(victim.clientId, victim.refresh)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
  })
})

describe('B-1, R2: revocation counts the token itself first', () => {
  it('one dead access token sent to /oauth/revoke 13 times: the live client can still refresh and revoke', async () => {
    const { admin } = await newTenant('rr2')
    const dead = await deadCredentials(admin)
    const victim = await connect(admin)
    const l = limited(AFTER_TAG)
    const statuses: number[] = []
    for (let i = 0; i < 13; i++) statuses.push((await l.revoke(dead.clientId, dead.access)).status)
    const gets = l.gets.length
    const rf = await l.refresh(victim.clientId, victim.refresh)
    expect(rf.status, JSON.stringify(rf.body)).toBe(200)
    const rv = await l.revoke(victim.clientId, rf.body.refresh_token)
    expect(rv.status, JSON.stringify(rv.body)).toBe(200)
    // After round 1: [200 × 3, 429 × 10]. Since round 2 the object's first answer calls it dead and the
    // Worker lists it: the other 12 are answered 200 without a limit or an object.
    expect(statuses).toEqual(new Array(13).fill(200))
    expect(gets).toBe(1)
  })
})

describe('B-1, R3: introspection', () => {
  it('the review\'s two dead access tokens (3 + 2 checks): every live token of the tenant is still served', async () => {
    const { admin } = await newTenant('rr3')
    const d1 = await deadCredentials(admin)
    const d2 = await deadCredentials(admin)
    const live = await connect(admin)
    const l = limited(AFTER_TAG)
    for (let i = 0; i < 3; i++) expect((await l.introspect(d1.access)).status).toBe('inactive')
    for (let i = 0; i < 2; i++) expect((await l.introspect(d2.access)).status).toBe('inactive')
    expect((await l.introspect(live.access)).status).toBe('active')
  })

  it('a former client\'s expired access tokens (5 tokens × 3 checks, the fuse is 12) count against nothing and reach no object: the live token is served', async () => {
    const { tenant, admin } = await newTenant('rr3x')
    const live = await connect(admin)
    const old = await Promise.all([1, 2, 3, 4, 5].map(() => expired('access', tenant)))
    const l = limited(AFTER_TAG)
    const seen: unknown[] = []
    for (const t of old) for (let i = 0; i < 3; i++) seen.push(await l.introspect(t))
    const gets = l.gets.length
    expect((await l.introspect(live.access)).status).toBe('active')
    expect(seen).toEqual(new Array(15).fill({ v: 1, status: 'inactive', reason: 'expired' }))
    expect(gets).toBe(0)
  })

  it('a former client\'s expired refresh tokens and codes, 13 each, at the token endpoint and revocation: nothing reaches the object and the live client refreshes', async () => {
    const { tenant, admin } = await newTenant('rr3t')
    const victim = await connect(admin)
    const l = limited(AFTER_TAG)
    for (let i = 0; i < 13; i++) {
      const rt = await expired('refresh', tenant)
      expect((await l.refresh(victim.clientId, rt)).status).toBe(400)
      expect((await l.revoke(victim.clientId, rt)).status).toBe(200)
      const code = await expired('code', tenant)
      expect((await l.form('/oauth/token', { grant_type: 'authorization_code', client_id: victim.clientId, code, code_verifier: 'x'.repeat(43), redirect_uri: 'http://127.0.0.1:33418/callback' })).status).toBe(400)
    }
    expect(l.gets).toEqual([])
    expect((await l.refresh(victim.clientId, victim.refresh)).status).toBe(200)
  })
})

describe('M-1, R4: the source limit and genuine credentials', () => {
  it('every Worker-hosted client arrives as 2a06:98c0:3600::103: registrations from it are not counted, and a genuine refresh from it is served', async () => {
    const { admin } = await newTenant('rr4')
    const victim = await connect(admin)
    const l = limited(ALL)
    for (let i = 0; i < 10; i++) expect((await l.register(WORKERS)).status).toBe(201)
    const r = await l.refresh(victim.clientId, victim.refresh, WORKERS)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
  })

  it('a network whose source budget made-up credentials spent: a genuine refresh and revocation from it are served', async () => {
    const { tenant, admin } = await newTenant('rr4b')
    const victim = await connect(admin)
    const l = limited(ALL)
    const net = ip()
    const forged = `vzr1.${tenant}.${'A'.repeat(43)}`
    for (let i = 0; i < 5; i++) expect((await l.refresh(victim.clientId, forged, net)).status).toBe(400)
    const over = await l.refresh(victim.clientId, forged, net)
    expect(over.status).toBe(429)
    expect(over.body.error_description).toMatch(/your network/)
    const r = await l.refresh(victim.clientId, victim.refresh, net)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect((await l.revoke(victim.clientId, r.body.access_token, net)).status).toBe(200)
  })

  it('recorded, not changed: requests without CF-Connecting-IP (only an internal caller sends one) share one key', async () => {
    const l = limited(ALL)
    for (let i = 0; i < 5; i++) await l.register(null)
    expect((await l.register(null)).status).toBe(429)
  })
})

describe('m-1, R5: a limiter brownout', () => {
  const hanging = { limit: () => new Promise(() => {}) }
  it('with limiters that never answer, each refresh and introspection waits at most about 100 ms for all its checks, and once each binding has failed once the isolate skips it', async () => {
    const { admin } = await newTenant('rr5')
    const c = await connect(admin)
    const l = limited({ OAUTH_RL_SOURCE: hanging, OAUTH_RL_SOURCE_48: hanging, OAUTH_RL_CREDENTIAL: hanging, OAUTH_RL_CLIENT: hanging, OAUTH_RL_TENANT: hanging, OAUTH_RL_BEARER: hanging, OAUTH_RL_BEARER_TENANT: hanging })
    const timed = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
      const t0 = Date.now()
      const v = await f()
      return [v, Date.now() - t0]
    }
    let token = c.refresh
    const refreshMs: number[] = []
    const introMs: number[] = []
    for (let i = 0; i < 3; i++) {
      const [r, ms] = await timed(() => l.refresh(c.clientId, token))
      expect(r.status).toBe(200)
      refreshMs.push(ms)
      token = r.body.refresh_token
      const [a, ms2] = await timed(() => l.introspect(r.body.access_token))
      expect(a.status).toBe('active')
      introMs.push(ms2)
    }
    console.log('R5', JSON.stringify({ refreshMs, introMs }))
    // The review measured 3,035 and 2,005 ms. A request asks two bindings; the first hangs and takes
    // the request's 100 ms, the second is tried by the next request: by the third, both are skipped.
    for (const ms of [...refreshMs, ...introMs]) expect(ms).toBeLessThan(600)
    expect(refreshMs[2]!).toBeLessThan(100)
    expect(introMs[2]!).toBeLessThan(100)
  }, 30_000)
})

describe('the credential format change (contracts/oauth.ts, layout 2): both release skews are served', () => {
  /** Issue tokens of `c`'s grant as the previous release did (layout 1), with rows as it wrote them. */
  async function legacyTokens(tenant: string, c: Awaited<ReturnType<typeof connect>>, accessExpiresAt = Date.now() + OAUTH_LIFETIMES.accessSeconds * 1000) {
    // One in 62 layout 1 bodies begins with layout 2's marker and is read as carrying an expiry,
    // uniform over 28 years (the false reading contracts/oauth.ts states): not drawn here, so the
    // test says the same every run.
    const mint = async (kind: 'access' | 'refresh') => {
      for (;;) {
        const cred = await previousMintCredential(kind, tenant, KEY)
        if (cred.split('.')[2]![0] !== 'e') return cred
      }
    }
    const access = await mint('access')
    const refresh = await mint('refresh')
    await runInDurableObject(stubOf(tenant), async (_o: Tenant, state) => {
      const sql = state.storage.sql
      const row = sql.exec<{ grant_id: string; sealed: string; scopes: string }>("SELECT grant_id, sealed, scopes FROM oauth_tokens WHERE tenant = ? AND hash = ? AND kind = 'refresh'", tenant, hashCredential(c.refresh)).one()
      const aad = sealAad(tenant, row.grant_id)
      const secret = (await unseal(c.refresh, row.sealed, aad))!
      const now = Date.now()
      const ins = 'INSERT INTO oauth_tokens (tenant, hash, kind, grant_id, scopes, issued_at, expires_at, rotated_at, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)'
      sql.exec(ins, tenant, hashCredential(access), 'access', row.grant_id, row.scopes, now - 120_000, accessExpiresAt, await seal(access, secret, aad))
      sql.exec(ins, tenant, hashCredential(refresh), 'refresh', row.grant_id, row.scopes, now - 120_000, now + OAUTH_LIFETIMES.refreshSeconds * 1000, await seal(refresh, secret, aad))
    })
    return { access, refresh }
  }

  it('this release serves the previous release\'s credentials (layout 1, no expiry in them) until they expire, with every limiter bound', async () => {
    const { tenant, admin } = await newTenant('skew1')
    const c = await connect(admin)
    const old = await legacyTokens(tenant, c)
    const l = limited(ALL)
    expect((await l.introspect(old.access)).status).toBe('active')
    const r = await l.refresh(c.clientId, old.refresh)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    // What it is given in exchange is layout 2, and served too.
    expect((await l.introspect(r.body.access_token)).status).toBe('active')
    expect((await l.revoke(c.clientId, old.access)).status).toBe(200)
    expect((await l.introspect(old.access)).status).toBe('inactive')
    // A previous-release access token past its expiry: the object, not the Worker, says so.
    const c2 = await connect(admin)
    const stale = await legacyTokens(tenant, c2, Date.now() - 1_000)
    l.gets.length = 0
    expect(await l.introspect(stale.access)).toEqual({ v: 1, status: 'inactive', reason: 'expired' })
    expect(l.gets.length).toBe(1)
  })

  it('the previous release\'s checks accept what this release issues, and its path to the object (the RPC by hash) serves it', async () => {
    const { tenant, admin } = await newTenant('skew2')
    const c = await connect(admin)
    for (const cred of [c.code, c.access, c.refresh]) {
      expect(previousParseCredential(cred), cred.slice(0, 5)).toEqual(parseCredential(cred))
      expect(await previousCredentialTagValid(KEY, cred)).toBe(true)
    }
    // After its checks, the previous release's Worker asks the object exactly this.
    const stub = stubOf(tenant) as unknown as TenantOAuthRpc
    expect((await stub.introspectAccessToken(tenant, c.access, RESOURCE)).status).toBe('active')
    const r = await stub.oauthToken(tenant, { grant_type: 'refresh_token', client_id: c.clientId, refresh_token: c.refresh })
    expect(r.status).toBe('ok')
    const next = (r as { tokens: { refresh_token: string; access_token: string } }).tokens
    expect(await previousCredentialTagValid(KEY, next.refresh_token)).toBe(true)
    expect((await stub.oauthRevoke(tenant, next.access_token, c.clientId)).status).toBe('ok')
    // And a refresh through this release's endpoint with what the object issued there.
    expect((await refreshPlain(c.clientId, next.refresh_token)).status).toBe(200)
  })
})
