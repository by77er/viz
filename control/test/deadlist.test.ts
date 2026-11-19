/**
 * The list of dead OAuth credentials (src/deadlist.ts; D70 after its second review, R2-M2), apart from
 * the attacks in test/ratelimit-review-r2.test.ts: what is listed and what is not (only what the
 * tenant's object says is dead for good), how long, what it costs in KV reads and writes, the
 * isolate's memory bound, and that it fails open. Real `CONFIG` (miniflare's KV) unless a test
 * replaces it.
 */
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialExpiresAt } from '../../contracts/oauth'
import worker from '../src/index'
import { DEAD_PREFIX, ISOLATE_ENTRIES, deadKey, listedDead, recordDead } from '../src/deadlist'
import { introspectFor } from '../src/introspection'
import { mintCredential, oauthConfig } from '../src/oauth'
import { resetLimiterState } from '../src/ratelimit'
import { call, makeKey, newTenant, post } from './helpers'
import { ORIGIN, RESOURCE, connect, refresh as refreshPlain } from './oauth'

const KEY = oauthConfig(env).clientKey!

/** A CONFIG that counts the Worker's reads and writes, or fails them. */
function kv(mode: 'ok' | 'throw' | 'hang' | 'write-fails' = 'ok') {
  const n = { reads: 0, writes: 0 }
  const CONFIG = {
    get: (...a: unknown[]) => {
      n.reads++
      if (mode === 'throw') return Promise.reject(new Error('kv down'))
      if (mode === 'hang') return new Promise(() => {})
      return (env.CONFIG.get as (...x: unknown[]) => Promise<unknown>)(...a)
    },
    put: (...a: Parameters<KVNamespace['put']>) => {
      n.writes++
      return mode === 'write-fails' ? Promise.reject(new Error('429 too many writes')) : env.CONFIG.put(...a)
    },
  } as unknown as KVNamespace
  return { n, CONFIG }
}

function client(over: Record<string, unknown>) {
  resetLimiterState()
  const e = { ...env, ...over }
  const send = async (path: string, params: Record<string, string>) => {
    const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() }) as never, e as never, {} as ExecutionContext)
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  return {
    e,
    refresh: (clientId: string, token: string, extra: Record<string, string> = {}) => send('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: token, ...extra }),
    revoke: (clientId: string, token: string) => send('/oauth/revoke', { client_id: clientId, token }),
    introspect: (token: string, resource = RESOURCE) => introspectFor(e as never, 'viz-mcp', token, resource),
    health: async () => (await worker.fetch!(new Request('https://control.internal/healthz') as never, e as never, {} as ExecutionContext)).text(),
  }
}

const listedInKv = async (credential: string) => (await env.CONFIG.get(deadKey(credential)!)) !== null

afterEach(() => {
  vi.restoreAllMocks()
  resetLimiterState()
})

describe('what is listed: only what the tenant\'s object says is dead for good (contracts/oauth.ts)', () => {
  it('a refresh refused for its scope, its resource or the per-grant limit leaves the token live and unlisted; it refreshes afterwards', async () => {
    const { admin } = await newTenant('dlkeep')
    const c = await connect(admin)
    const w = client({})
    expect((await w.refresh(c.clientId, c.refresh, { scope: 'admin' })).body.error).toBe('invalid_scope')
    expect((await w.refresh(c.clientId, c.refresh, { resource: 'https://elsewhere.example/mcp' })).body.error).toBe('invalid_target')
    expect(await listedInKv(c.refresh)).toBe(false)
    expect(await listedDead(w.e, c.refresh)).toBeNull()
    expect((await w.refresh(c.clientId, c.refresh)).status).toBe(200)
  })

  it('introspection: suspended and audience are not listed (the token comes back); unknown is, with its reason', async () => {
    const { admin } = await newTenant('dlsusp')
    const dana = await makeKey(admin, ['admin', 'read', 'dashboards:read', 'monitors:read'], { name: 'dana' })
    const c = await connect(dana.key)
    const w = client({})
    expect(await w.introspect(c.access, 'https://elsewhere.example/mcp')).toEqual({ v: 1, status: 'inactive', reason: 'audience' })
    expect((await w.introspect(c.access)).status).toBe('active')
    expect((await call(admin, 'POST', `/keys/${dana.id}/disable`)).status).toBe(200)
    expect(await w.introspect(c.access)).toEqual({ v: 1, status: 'inactive', reason: 'suspended' })
    expect(await listedInKv(c.access)).toBe(false)
    expect((await call(admin, 'POST', `/keys/${dana.id}/enable`)).status).toBe(200)
    expect((await w.introspect(c.access)).status).toBe('active')
    // A person ends the grant, which deletes its tokens: the object no longer knows the token
    // (`unknown`), and it is listed with that reason, which a new isolate answers from the list.
    const grant = (await call(admin, 'GET', '/oauth/grants')).body.items[0].id
    expect((await post(admin, `/oauth/grants/${grant}/revoke`, {})).status).toBe(200)
    expect(await w.introspect(c.access)).toEqual({ v: 1, status: 'inactive', reason: 'unknown' })
    expect(JSON.parse((await env.CONFIG.get(deadKey(c.access)!))!)).toEqual({ v: 1, reason: 'unknown' })
    resetLimiterState()
    expect(await w.introspect(c.access)).toEqual({ v: 1, status: 'inactive', reason: 'unknown' })
  })

  it('a live token revoked by another client is not dead (nothing changes) and is not listed; its own client\'s revocation lists it', async () => {
    const { admin } = await newTenant('dlwrong')
    const a = await connect(admin)
    const b = await connect(admin)
    const w = client({})
    expect((await w.revoke(b.clientId, a.access)).status).toBe(200)
    expect(await listedInKv(a.access)).toBe(false)
    expect((await w.introspect(a.access)).status).toBe('active')
    expect((await w.revoke(a.clientId, a.access)).status).toBe(200)
    expect(await listedInKv(a.access)).toBe(true)
  })

  it('nothing is written for a credential with less than KV\'s 60 s left, nor for layout 1 (no expiry to bound it); the isolate still remembers the first', async () => {
    const { tenant } = await newTenant('dlshort')
    const counted = kv()
    const e = { CONFIG: counted.CONFIG }
    // Expired at the last whole minute: the Worker's 60 s of grace leave it under 60 s to live, which KV cannot hold.
    const soon = await mintCredential('access', tenant, KEY, Math.floor(Date.now() / 60_000) * 60_000)
    const left = credentialExpiresAt(soon)! + 60_000 - Date.now()
    expect(left).toBeGreaterThan(0)
    expect(left).toBeLessThan(60_000)
    await recordDead(e, soon, 'revoked')
    expect(counted.n.writes).toBe(0)
    expect(await listedDead({}, soon)).toBe('revoked')
    const layout1 = `vza1.${tenant}.${'Q'.repeat(43)}`
    await recordDead(e, layout1, 'revoked')
    expect(counted.n.writes).toBe(0)
    expect(await listedDead({}, layout1)).toBeNull()
  })
})

describe('what it costs', () => {
  it('one write per dead credential per isolate, however often it is replayed; a listed one is never asked of the object again', async () => {
    const { admin } = await newTenant('dlonce')
    const c = await connect(admin)
    expect((await post(admin, `/oauth/grants/${c.grant.id}/revoke`, {})).status).toBe(200)
    const counted = kv()
    const w = client({ CONFIG: counted.CONFIG })
    for (let i = 0; i < 20; i++) {
      expect((await w.refresh(c.clientId, c.refresh)).status).toBe(400)
      expect((await w.revoke(c.clientId, c.refresh)).status).toBe(200)
      expect((await w.introspect(c.access)).status).toBe('inactive')
    }
    // Two credentials (the refresh token, the access token), one write each; one read each before.
    expect(counted.n).toEqual({ reads: 2, writes: 2 })
  })

  it('concurrent replays of one dead credential, all past the list before any answer: one write', async () => {
    const { admin } = await newTenant('dlconc')
    const c = await connect(admin)
    expect((await post(admin, `/oauth/grants/${c.grant.id}/revoke`, {})).status).toBe(200)
    const counted = kv()
    const w = client({ CONFIG: counted.CONFIG })
    const all = await Promise.all(Array.from({ length: 5 }, () => w.introspect(c.access)))
    expect(all.map((r) => r.status)).toEqual(new Array(5).fill('inactive'))
    expect(counted.n.writes).toBe(1)
  })

  it('a live token is read from KV once per isolate a minute, however often it is used', async () => {
    const { admin } = await newTenant('dlread')
    const c = await connect(admin)
    const counted = kv()
    const w = client({ CONFIG: counted.CONFIG })
    for (let i = 0; i < 50; i++) expect((await w.introspect(c.access)).status).toBe('active')
    expect(counted.n).toEqual({ reads: 1, writes: 0 })
  })

  it(`the isolate remembers at most ${ISOLATE_ENTRIES} dead credentials, dropping the oldest first`, async () => {
    const { tenant } = await newTenant('dlmem')
    const first = await mintCredential('access', tenant, KEY)
    await recordDead({}, first, 'revoked')
    let last = first
    for (let i = 0; i < ISOLATE_ENTRIES; i++) {
      last = await mintCredential('access', tenant, KEY)
      await recordDead({}, last, 'revoked')
    }
    expect(await listedDead({}, last)).toBe('revoked')
    expect(await listedDead({}, first)).toBeNull()
  }, 60_000)
})

describe('it fails open, like the rate limits', () => {
  for (const mode of ['throw', 'hang'] as const) {
    it(`a KV read that ${mode === 'throw' ? 'throws' : 'does not answer'}: the request is served, logged once, reads are skipped for a while, /healthz says so`, async () => {
      const { admin } = await newTenant('dlopen')
      const c = await connect(admin)
      const broken = kv(mode)
      const w = client({ CONFIG: broken.CONFIG })
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const t0 = Date.now()
      const r = await w.refresh(c.clientId, c.refresh)
      expect(r.status).toBe(200)
      expect(Date.now() - t0).toBeLessThan(1_000)
      expect((await w.introspect(r.body.access_token)).status).toBe('active')
      expect((await w.refresh(c.clientId, r.body.refresh_token)).status).toBe(200)
      // One read failed; the others were skipped. One log line.
      expect(broken.n.reads).toBe(1)
      expect(log.mock.calls.filter((a) => String(a[0]).includes('dead-credential list could not be read')).length).toBe(1)
      expect(await w.health()).toMatch(/^OAUTH_DEAD_LIST: skipped$/m)
    })
  }

  it('a KV write that fails: the answer is the object\'s, the isolate still remembers, logged once', async () => {
    const { admin } = await newTenant('dlwfail')
    const c = await connect(admin)
    expect((await post(admin, `/oauth/grants/${c.grant.id}/revoke`, {})).status).toBe(200)
    const broken = kv('write-fails')
    const w = client({ CONFIG: broken.CONFIG })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let i = 0; i < 3; i++) expect((await w.refresh(c.clientId, c.refresh)).status).toBe(400)
    expect(broken.n.writes).toBe(1)
    expect(await listedDead({}, c.refresh)).toBe('revoked')
    expect(log.mock.calls.filter((a) => String(a[0]).includes('write to the OAuth dead-credential list failed')).length).toBe(1)
  })

  it('without CONFIG: dead credentials are refused only by the isolate that met them, logged once', async () => {
    const { admin } = await newTenant('dlnone')
    const c = await connect(admin)
    expect((await post(admin, `/oauth/grants/${c.grant.id}/revoke`, {})).status).toBe(200)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = client({ CONFIG: undefined })
    for (let i = 0; i < 3; i++) expect((await w.refresh(c.clientId, c.refresh)).status).toBe(400)
    expect(await listedDead({}, c.refresh)).toBe('revoked')
    expect(log.mock.calls.filter((a) => String(a[0]).includes('has no CONFIG binding')).length).toBe(1)
  })

  it('keys are under the list\'s own prefix, name the credential\'s tenant, and never the credential', async () => {
    const { tenant, admin } = await newTenant('dlkey')
    const c = await connect(admin)
    expect(deadKey(c.access)!.startsWith(`${DEAD_PREFIX}${tenant}:`)).toBe(true)
    expect(deadKey(c.access)).not.toContain(c.access.split('.')[2])
    expect(deadKey('not a credential')).toBeNull()
    // Rotation does not list the token it spent: only a later answer that it is dead does.
    const r = await refreshPlain(c.clientId, c.refresh)
    expect(r.status).toBe(200)
    expect(await listedInKv(c.refresh)).toBe(false)
  })
})
