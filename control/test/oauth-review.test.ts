/**
 * The fixes from the adversarial review of D44 (design/reviews/d44-d52-d53-d60.md): each test
 * failed against the tree the review read (control/README.md, "How it was verified", lists the
 * mutants that undo each fix and the test that catches it).
 *
 *   M-1  the agent surface asks control through one entrypoint, not the Tenant class; an identity
 *        without a key is refused; an approver that is not a key fails closed
 *   M-2  a made-up credential reaches no tenant's object; a request that changes nothing writes
 *        nothing and sets no alarm
 *   m-1  an approver key's expiry is an alarm deadline
 *   m-2  a body without Content-Length is not buffered past the cap
 *   m-3  redirect URIs are ASCII
 *   m-5  the "approve only what you started" warning is shown for every redirect
 */
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { CREDENTIAL_TAG } from '../../contracts/oauth'
import worker from '../src/index'
import { OAuthIntrospection, introspectFor } from '../src/introspection'
import { credentialTagValid, mintCredential, oauthConfig } from '../src/oauth'
import { oauthDeadlines, oauthOps, prepareApprove } from '../src/ops-oauth'
import type { Tenant } from '../src/tenant'
import { get, newTenant, post, stubOf } from './helpers'
import { ORIGIN, REDIRECT, RESOURCE, approve, authorize, connect, form, introspect, newClient, oauthFetch, pkce, refresh, register } from './oauth'

const KEY = env.OAUTH_CLIENT_KEY!

/** env with a TENANT namespace that counts the objects asked for: a request that reaches no object counts 0. */
function counting(): { env: typeof env; gets: string[] } {
  const gets: string[] = []
  const ns = env.TENANT
  const TENANT = new Proxy(ns, {
    get(target, prop) {
      if (prop === 'get') return (id: DurableObjectId) => (gets.push(id.toString()), target.get(id))
      const v = Reflect.get(target, prop) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
  return { env: { ...env, TENANT } as typeof env, gets }
}

async function viaWorker(e: typeof env, path: string, params: Record<string, string>): Promise<{ status: number; text: string }> {
  const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() }) as never, e as never, {} as ExecutionContext)
  return { status: res.status, text: await res.text() }
}

/** Counts setAlarm and deleteAlarm on a tenant's live object, and reads its write counter. */
async function watchAlarms(stub: DurableObjectStub<Tenant>): Promise<{ counts: { set: number; del: number } }> {
  const counts = { set: 0, del: 0 }
  await runInDurableObject(stub, async (_o, state) => {
    const s = state.storage as unknown as { setAlarm: (...a: unknown[]) => Promise<void>; deleteAlarm: (...a: unknown[]) => Promise<void> }
    const set = s.setAlarm.bind(s)
    const del = s.deleteAlarm.bind(s)
    s.setAlarm = (...a: unknown[]) => (counts.set++, set(...a))
    s.deleteAlarm = (...a: unknown[]) => (counts.del++, del(...a))
  })
  return { counts }
}

const rowsWritten = (stub: DurableObjectStub<Tenant>) => runInDurableObject(stub, async (o: Tenant) => o.rowsWritten)
const alarmAt = (stub: DurableObjectStub<Tenant>) => runInDurableObject(stub, async (_o, s) => s.storage.getAlarm())
const tables = (stub: DurableObjectStub<Tenant>) => runInDurableObject(stub, async (_o, s) => s.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray().length)

describe('credential tags (contracts/oauth.ts CREDENTIAL_TAG)', () => {
  it('codes and tokens carry this deployment\'s tag; a credential edited, made up, or tagged under another key has none', async () => {
    const { admin, tenant } = await newTenant('tag')
    const c = await connect(admin)
    for (const cred of [c.code, c.access, c.refresh]) {
      expect(cred).toMatch(new RegExp(`^vz[car]1\\.${tenant}\\.[A-Za-z0-9]{43}$`))
      expect(await credentialTagValid(KEY, cred)).toBe(true)
    }
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1)
    // Any character of the random part, the tag, or the tenant.
    expect(await credentialTagValid(KEY, flip(c.access, c.access.length - 30))).toBe(false)
    expect(await credentialTagValid(KEY, flip(c.access, c.access.length - 1))).toBe(false)
    expect(await credentialTagValid(KEY, c.access.replace(tenant, `${tenant}x`))).toBe(false)
    expect(await credentialTagValid(KEY, `vza1.${tenant}.${'A'.repeat(43)}`)).toBe(false)
    expect(await credentialTagValid(null, c.access)).toBe(false)
    const other = await mintCredential('access', tenant, 'another-deployment-key-of-32-characters-or-more')
    expect(await credentialTagValid(KEY, other)).toBe(false)
    expect(CREDENTIAL_TAG.randomChars + CREDENTIAL_TAG.tagChars).toBe(43)
  })
})

describe('M-1: the agent surface asks control through OAuthIntrospection only', () => {
  it('the entrypoint introspects for its one caller, takes the tenant from the token, and answers no one else', async () => {
    const { admin, tenant } = await newTenant('ep')
    const c = await connect(admin)
    const viaStub = await introspect(tenant, c.access)
    const viaEntry = await env.MCP_OAUTH.introspectAccessToken(c.access, RESOURCE)
    expect(viaEntry).toMatchObject({ v: 1, status: 'active', tenant, grant: c.grant.id })
    expect(viaEntry).toEqual(viaStub)
    // Another viz Worker, or a binding without props: refused, whatever the token.
    expect(await env.RULER_OAUTH.introspectAccessToken(c.access, RESOURCE)).toEqual({ v: 1, status: 'unauthorized' })
    expect(await env.BARE_OAUTH.introspectAccessToken(c.access, RESOURCE)).toEqual({ v: 1, status: 'unauthorized' })
    // The audience is still checked, and a refresh token or a code is not an access token.
    expect(await env.MCP_OAUTH.introspectAccessToken(c.access, 'https://elsewhere.example/mcp')).toEqual({ v: 1, status: 'inactive', reason: 'audience' })
    expect(await env.MCP_OAUTH.introspectAccessToken(c.refresh, RESOURCE)).toEqual({ v: 1, status: 'inactive', reason: 'unknown' })
  })

  it('it offers nothing else: invoke, provision, serviceKey, notificationTarget, resolveKey, recordUsage are not there', async () => {
    const { tenant } = await newTenant('ep2')
    const ep = env.MCP_OAUTH as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    const forged = { tenant, subject: 'key:nobody', kind: 'key', scopes: ['admin'] }
    for (const [m, args] of [
      ['invoke', [forged, 'keys.create', { params: {}, query: {}, body: { name: 'backdoor', scopes: ['admin'] } }]],
      ['provision', [tenant]],
      ['serviceKey', [tenant, 'viz-ruler', '0']],
      ['notificationTarget', [tenant]],
      ['resolveKey', [tenant, 'x']],
      ['recordUsage', [tenant, []]],
      ['oauthToken', [tenant, {}]],
    ] as const) {
      let error: unknown = null
      try {
        await ep[m]!(...args)
      } catch (e) {
        error = e
      }
      expect(String(error), m).toMatch(/does not implement/)
    }
    // Its whole surface: one method.
    expect(Object.getOwnPropertyNames(OAuthIntrospection.prototype).sort()).toEqual(['constructor', 'introspectAccessToken'])
    // And no key was made in the tenant.
    expect((await runInDurableObject(stubOf(tenant), async (t: Tenant) => t.all('SELECT id FROM keys WHERE tenant = ?', tenant))).length).toBe(1)
  })

  it('a token edited to name another tenant, or made up, is inactive and reaches no object', async () => {
    const { admin, tenant } = await newTenant('ep3')
    const { tenant: other } = await newTenant('ep3b')
    const c = await connect(admin)
    const { env: e, gets } = counting()
    expect(await introspectFor(e, 'viz-mcp', c.access.replace(`.${tenant}.`, `.${other}.`), RESOURCE)).toEqual({ v: 1, status: 'inactive', reason: 'unknown' })
    expect(await introspectFor(e, 'viz-mcp', `vza1.${tenant}.${'Q'.repeat(43)}`, RESOURCE)).toEqual({ v: 1, status: 'inactive', reason: 'unknown' })
    expect(await introspectFor(e, 'viz-mcp', `vza1.never-provisioned-${tenant}.${'Q'.repeat(43)}`, RESOURCE)).toEqual({ v: 1, status: 'inactive', reason: 'unknown' })
    expect(gets).toEqual([])
    // The real token does reach its object.
    expect((await introspectFor(e, 'viz-mcp', c.access, RESOURCE)).status).toBe('active')
    expect(gets.length).toBe(1)
  })

  it('an identity without a key, as a holder of the Tenant binding could make one up, is refused and changes nothing (review R1)', async () => {
    const { tenant, admin } = await newTenant('r1')
    const stub = stubOf(tenant) as unknown as { invoke(id: unknown, op: string, input: unknown): Promise<any> }
    for (const forged of [
      { tenant, subject: 'key:nobody', kind: 'key', scopes: ['admin'], name: 'forged' },
      { tenant, subject: 'system:anything', kind: 'key', scopes: ['admin', 'read', 'monitors:read'], name: 'forged' },
      { tenant, subject: 'user:dana', kind: 'user', scopes: ['admin'], name: 'Dana' },
    ]) {
      const r = await stub.invoke(forged, 'keys.create', { params: {}, query: {}, body: { name: 'backdoor', scopes: ['admin', 'read', 'write'] } })
      expect(r.status, forged.subject).toBe(401)
    }
    const clientId = await newClient()
    const { challenge } = await pkce()
    const { handle } = await authorize(clientId, challenge)
    const ap = await stub.invoke({ tenant, subject: 'system:anything', kind: 'key', scopes: ['admin'], name: 'forged' }, 'oauth.approve', { params: {}, query: {}, body: { request: handle } })
    expect(ap.status).toBe(401)
    const keys = await get(admin, '/keys?limit=200')
    expect(keys.body.items.map((k: { name: string }) => k.name)).toEqual(['first admin key'])
    expect(JSON.stringify((await get(admin, '/audit?limit=50')).body)).not.toContain('nobody')
    // A key id with a made-up subject and scopes: the object's own record of the key wins.
    const real = await post(admin, '/keys', { name: 'reader', scopes: ['read'] })
    const keyId = /^viz_([A-Za-z0-9]+)_/.exec(real.body.secret)![1]!
    const lied = await stub.invoke({ tenant, subject: 'system:anything', kind: 'key', scopes: ['admin'], keyId }, 'keys.create', { params: {}, query: {}, body: { name: 'backdoor', scopes: ['admin'] } })
    expect(lied.status).toBe(403)
  })

  it('approve refuses an approver that is not a key, and a grant recorded with one is ended (fails closed)', async () => {
    const { tenant, admin } = await newTenant('fc')
    const stub = stubOf(tenant)
    // approve itself, given an identity that is not a key (as sign-in will make): refused.
    const clientId = await newClient()
    const { challenge } = await pkce()
    const { handle } = await authorize(clientId, challenge)
    const refused = await runInDurableObject(stub, async (t: Tenant) => {
      const prepared = await prepareApprove(t, { request: handle })
      const id = { tenant, subject: 'user:dana', kind: 'user' as const, scopes: ['admin', 'read', 'dashboards:read', 'monitors:read'], name: 'Dana' }
      try {
        t.transaction(() => oauthOps['oauth.approve'](t, { id, actor: { subject: id.subject, kind: id.kind, name: id.name }, input: { params: {}, query: {}, body: { request: handle } }, now: Date.now(), dryRun: false, prepared }))
        return null
      } catch (e) {
        return (e as { status?: number; code?: string }).code ?? String(e)
      }
    })
    expect(refused).toBe('approver-not-a-key')
    expect((await get(admin, '/oauth/grants?status=all')).body.items).toEqual([])

    // A grant whose recorded approver is not a key (written by some other path): inactive at once,
    // the alarm is due now, and it ends it as approver-gone.
    const c = await connect(admin)
    expect((await introspect(tenant, c.access)).status).toBe('active')
    await runInDurableObject(stub, async (t: Tenant) => {
      t.run('UPDATE oauth_grants SET created_by = ? WHERE tenant = ? AND id = ?', JSON.stringify({ subject: 'user:dana', kind: 'user', name: 'Dana' }), tenant, c.grant.id)
    })
    expect(await introspect(tenant, c.access)).toEqual({ v: 1, status: 'inactive', reason: 'revoked' })
    expect((await refresh(c.clientId, c.refresh)).status).toBe(400)
    // (the failed refresh wrote nothing; arm the alarm the way any change would)
    await runInDurableObject(stub, async (t: Tenant, state) => {
      const deadlines = oauthDeadlines(t, Date.now())
      expect(Math.min(...deadlines)).toBeLessThanOrEqual(Date.now())
      await state.storage.setAlarm(Math.min(...deadlines))
    })
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const g = await get(admin, `/oauth/grants/${c.grant.id}`)
    expect(g.body.grant).toMatchObject({ status: 'revoked', revokeReason: 'approver-gone' })
  })
})

describe('M-2: a made-up credential reaches no object; a request that changes nothing writes nothing', () => {
  it('forged codes, refresh tokens and revocations for an existing tenant (with a live grant): no object asked, no alarm, no row', async () => {
    const { tenant, admin } = await newTenant('m2')
    await connect(admin) // a live grant: there is an OAuth deadline the old code re-armed on every request
    const stub = stubOf(tenant)
    const { counts } = await watchAlarms(stub)
    const rows = await rowsWritten(stub)
    const alarm = await alarmAt(stub)
    const clientId = await newClient()
    const { env: e, gets } = counting()
    for (let i = 0; i < 20; i++) {
      const forged = (p: string) => `${p}.${tenant}.${'C'.repeat(42)}${i % 10}`
      expect((await viaWorker(e, '/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code: forged('vzc1'), code_verifier: 'x'.repeat(43), redirect_uri: REDIRECT })).status).toBe(400)
      expect((await viaWorker(e, '/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: forged('vzr1') })).status).toBe(400)
      expect((await viaWorker(e, '/oauth/revoke', { client_id: clientId, token: forged('vzr1') })).status).toBe(200)
      expect((await viaWorker(e, '/oauth/revoke', { client_id: clientId, token: forged('vza1') })).status).toBe(200)
    }
    expect(gets).toEqual([])
    expect(counts).toEqual({ set: 0, del: 0 })
    expect(await rowsWritten(stub)).toBe(rows)
    expect(await alarmAt(stub)).toBe(alarm)
  })

  it('forged credentials naming a tenant nobody provisioned: no object asked; that object has no storage and no alarm', async () => {
    const ghost = `ghost-${crypto.randomUUID().slice(0, 8)}`
    const clientId = await newClient()
    const { env: e, gets } = counting()
    expect((await viaWorker(e, '/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: `vzr1.${ghost}.${'D'.repeat(43)}` })).status).toBe(400)
    expect((await viaWorker(e, '/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code: `vzc1.${ghost}.${'D'.repeat(43)}`, code_verifier: 'x'.repeat(43), redirect_uri: REDIRECT })).status).toBe(400)
    expect((await viaWorker(e, '/oauth/revoke', { client_id: clientId, token: `vzr1.${ghost}.${'D'.repeat(43)}` })).status).toBe(200)
    expect(await introspectFor(e, 'viz-mcp', `vza1.${ghost}.${'D'.repeat(43)}`, RESOURCE)).toEqual({ v: 1, status: 'inactive', reason: 'unknown' })
    expect(gets).toEqual([])
    expect(await tables(stubOf(ghost))).toBe(0)
    expect(await alarmAt(stubOf(ghost))).toBeNull()
  })

  it('at the object itself (a credential carrying the tag, as if the key were known): unknown codes, refresh and access tokens write nothing and set no alarm', async () => {
    const { tenant, admin } = await newTenant('m2obj')
    const c = await connect(admin)
    const stub = stubOf(tenant)
    const { counts } = await watchAlarms(stub)
    const rows = await rowsWritten(stub)
    const alarm = await alarmAt(stub)
    for (let i = 0; i < 10; i++) {
      const code = await mintCredential('code', tenant, KEY)
      const rt = await mintCredential('refresh', tenant, KEY)
      const at = await mintCredential('access', tenant, KEY)
      expect(await stub.oauthToken(tenant, { grant_type: 'authorization_code', client_id: c.clientId, code, code_verifier: 'x'.repeat(43), redirect_uri: REDIRECT })).toMatchObject({ status: 'error', error: 'invalid_grant' })
      expect(await stub.oauthToken(tenant, { grant_type: 'refresh_token', client_id: c.clientId, refresh_token: rt })).toMatchObject({ status: 'error', error: 'invalid_grant' })
      expect(await stub.oauthRevoke(tenant, rt, c.clientId)).toEqual({ v: 1, status: 'ok' })
      expect(await stub.oauthRevoke(tenant, at, c.clientId)).toEqual({ v: 1, status: 'ok' })
      expect(await stub.introspectAccessToken(tenant, at, RESOURCE)).toEqual({ v: 1, status: 'inactive', reason: 'unknown' })
      // A real refresh token presented by the wrong client is a change (the grant ends): not counted here.
    }
    expect(counts).toEqual({ set: 0, del: 0 })
    expect(await rowsWritten(stub)).toBe(rows)
    expect(await alarmAt(stub)).toBe(alarm)
    // And for a tenant nobody provisioned: not_provisioned, no storage, no alarm.
    const ghost = `ghost-${crypto.randomUUID().slice(0, 8)}`
    expect(await stubOf(ghost).oauthToken(ghost, { grant_type: 'refresh_token', client_id: c.clientId, refresh_token: await mintCredential('refresh', ghost, KEY) })).toEqual({ v: 1, status: 'not_provisioned' })
    expect(await tables(stubOf(ghost))).toBe(0)
    expect(await alarmAt(stubOf(ghost))).toBeNull()
  })

  it('a request that does change something still arms the alarm and publishes (a revoked refresh token ends its grant and its key\'s KV record)', async () => {
    const { tenant, admin } = await newTenant('m2real')
    const c = await connect(admin)
    const stub = stubOf(tenant)
    const { counts } = await watchAlarms(stub)
    const rows = await rowsWritten(stub)
    const keyId = await runInDurableObject(stub, async (t: Tenant) => t.one<{ key_id: string }>('SELECT k.key_id FROM keys k JOIN oauth_grants g ON g.tenant = k.tenant AND g.key = k.id WHERE g.tenant = ? AND g.id = ?', tenant, c.grant.id)!.key_id)
    expect(await env.CONFIG.get(`key:${keyId}`)).not.toBeNull()
    expect((await form('/oauth/revoke', { client_id: c.clientId, token: c.refresh })).status).toBe(200)
    expect(await rowsWritten(stub)).toBeGreaterThan(rows)
    expect(counts.set + counts.del).toBeGreaterThan(0)
    expect(await env.CONFIG.get(`key:${keyId}`)).toBeNull()
    // A refresh that rotates is a change too.
    const d = await connect(admin)
    const before = counts.set + counts.del
    expect((await refresh(d.clientId, d.refresh)).status).toBe(200)
    expect(counts.set + counts.del).toBeGreaterThan(before)
  })
})

describe('minors', () => {
  it('m-1: an approver key that expires sets the alarm for its expiry, and the grant ends then (review R6)', async () => {
    const { tenant, admin } = await newTenant('m1')
    const exp = Date.now() + 6 * 60_000
    const k = await post(admin, '/keys', { name: 'short admin', scopes: ['admin', 'read', 'monitors:read'], expiresAt: new Date(exp).toISOString() })
    expect(k.status).toBe(201)
    await connect(k.body.secret)
    const alarm = await alarmAt(stubOf(tenant))
    expect(alarm).not.toBeNull()
    expect(alarm!).toBeLessThanOrEqual(exp)
  })

  it('m-2: a 4 MiB body without Content-Length is refused after at most the cap, not read whole (review R5)', async () => {
    for (const path of ['/oauth/token', '/oauth/revoke', '/oauth/register']) {
      const chunk = new Uint8Array(64 * 1024).fill(0x61)
      let sent = 0
      const body = new ReadableStream({
        pull(c) {
          if (sent >= 64) return c.close()
          sent++
          c.enqueue(chunk)
        },
      })
      const type = path === '/oauth/register' ? 'application/json' : 'application/x-www-form-urlencoded'
      const r = await oauthFetch(path, { method: 'POST', headers: { 'Content-Type': type }, body, duplex: 'half' } as RequestInit)
      expect(r.status, path).toBe(400)
      expect(sent, path).toBeLessThanOrEqual(3)
    }
    // The control API's own bodies too (after the key is checked).
    const { admin } = await newTenant('m2b')
    let sent = 0
    const chunk = new Uint8Array(256 * 1024).fill(0x20)
    const body = new ReadableStream({
      pull(c) {
        if (sent >= 16) return c.close()
        sent++
        c.enqueue(chunk)
      },
    })
    const res = await worker.fetch!(new Request(`${ORIGIN}/api/v1/control/dashboards`, { method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' }, body, duplex: 'half' } as RequestInit) as never, env as never, {} as ExecutionContext)
    expect(res.status).toBe(413)
    expect(sent).toBeLessThanOrEqual(6)
  })

  it('m-3: a redirect URI with a bidirectional, invisible or other non-ASCII character is refused; punycode is accepted (review R4)', async () => {
    for (const u of ['https://evil.example/cb/‮moc.elgoog', 'https://evil.example/cb​', 'https://bücher.example/cb', 'http://127.0.0.1:3000/cé']) {
      const r = await register({ redirect_uris: [u] })
      expect(r.status, u).toBe(400)
      expect(r.body.error_description, u).toMatch(/ASCII/)
    }
    expect((await register({ redirect_uris: ['https://xn--bcher-kva.example/cb'] })).status).toBe(201)
    expect((await register({ redirect_uris: ['https://app.example/cb/%E2%80%AE'] })).status).toBe(201)
  })

  it('m-5: the page and the approval warn to approve only a connection you started, for an https redirect too', async () => {
    const { admin } = await newTenant('m5')
    const uri = 'https://app.example/callback'
    const clientId = await newClient({ redirect_uris: [uri] })
    const { challenge } = await pkce()
    const { res, handle } = await authorize(clientId, challenge, { redirect: uri })
    expect(res.status).toBe(200)
    expect(res.text).toContain('Approve only a connection you started yourself')
    expect(res.text).not.toContain('WARNING: a program on the computer')
    const dry = await approve(admin, handle!, { dryRun: true })
    expect(dry.status).toBe(201)
    expect(dry.body.warnings.join(' ')).toContain('Approve only a connection you started yourself')
    expect(dry.body.warnings.join(' ')).toContain('app.example')
  })
})

describe('the issuer configuration the tag key comes from', () => {
  it('without OAUTH_CLIENT_KEY nothing is issued: approve answers 503 and the token endpoint refuses before any object', async () => {
    const { admin, tenant } = await newTenant('nokey')
    const clientId = await newClient()
    const { challenge } = await pkce()
    const { handle } = await authorize(clientId, challenge)
    // The approval through an object whose Worker has no key: the same env without it.
    const off = { ...env, OAUTH_CLIENT_KEY: undefined }
    expect(oauthConfig(off).clientKey).toBeNull()
    const stub = stubOf(tenant)
    const out = await runInDurableObject(stub, async (t: Tenant) => {
      const saved = (t as unknown as { env: Record<string, unknown> }).env.OAUTH_CLIENT_KEY
      ;(t as unknown as { env: Record<string, unknown> }).env.OAUTH_CLIENT_KEY = undefined
      try {
        const prepared = await prepareApprove(t, { request: handle })
        const id = { tenant, subject: 'key:x', kind: 'key' as const, scopes: ['admin', 'read', 'dashboards:read', 'monitors:read'], name: 'k' }
        try {
          t.transaction(() => oauthOps['oauth.approve'](t, { id, actor: { subject: id.subject, kind: id.kind, name: id.name }, input: { params: {}, query: {}, body: { request: handle } }, now: Date.now(), dryRun: false, prepared }))
          return null
        } catch (e) {
          return (e as { code?: string }).code ?? String(e)
        }
      } finally {
        ;(t as unknown as { env: Record<string, unknown> }).env.OAUTH_CLIENT_KEY = saved
      }
    })
    expect(out).toBe('oauth-unavailable')
    const c = await connect(admin)
    const { env: e, gets } = counting()
    const r = await worker.fetch!(new Request(`${ORIGIN}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: c.clientId, refresh_token: c.refresh }).toString() }) as never, { ...e, OAUTH_CLIENT_KEY: undefined } as never, {} as ExecutionContext)
    expect(r.status).toBe(400)
    expect(gets).toEqual([])
  })
})
