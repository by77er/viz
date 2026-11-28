/**
 * OAuth for agents (contracts/oauth.ts, decision D44): the authorization server's endpoints, the
 * consent step, and the token, revocation and introspection RPCs, against the real Worker and
 * Tenant object. The threat tests the task names are each a `describe` below; every one checks
 * stored state (SQLite, KV), not only the status code.
 */
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OAUTH_SCOPES, type ClientRegistration } from '../../contracts/oauth'
import { openSchema } from '../../contracts/schema'
import { authenticate, clearAuthCache } from '../../edge/src/auth'
import { signRegistration } from '../src/oauth'
import { TENANT_SCHEMA } from '../src/schema'
import { auditOf, call, env, get, kvGet, makeKey, newTenant, post, stubOf } from './helpers'
import {
  ORIGIN, REDIRECT, RESOURCE, type Res, approve, authorize, authorizeUrl, codeOf, connect, exchange, form, introspect, newClient, oauthFetch, pkce, refresh, register, revokeAtServer,
} from './oauth'
import { dumpOf } from './storage'

const TEST_KEY = 'test-only-oauth-registration-signing-key-not-a-secret'
const sql = (tenant: string, q: string, ...b: SqlStorageValue[]) => runInDurableObject(stubOf(tenant), (_i, s) => s.storage.sql.exec(q, ...b).toArray())
const grantKeyId = async (tenant: string, grant: string): Promise<string | null> => ((await sql(tenant, 'SELECT k.key_id AS id FROM oauth_grants g JOIN keys k ON k.tenant = g.tenant AND k.id = g.key WHERE g.tenant = ? AND g.id = ?', tenant, grant))[0]?.id as string) ?? null
const grantOf = async (admin: string, id: string) => (await get(admin, `/oauth/grants/${id}`)).body.grant
/** A person's key that holds admin and every grantable scope. */
const personKey = async (admin: string) => (await makeKey(admin, ['admin', ...OAUTH_SCOPES], { name: `dana ${Math.random().toString(36).slice(2, 8)}` })).key

/** Everything an attacker or a log must never see, collected as the tests make it. */
const secrets = new Set<string>()
const keep = (...xs: (string | null | undefined)[]) => xs.forEach((x) => x && secrets.add(x))

describe('metadata and registration', () => {
  it('RFC 8414 metadata: endpoints under the issuer, S256 only, public clients, iss in responses, no admin among the scopes', async () => {
    const r = await oauthFetch('/.well-known/oauth-authorization-server')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['read', 'dashboards:read', 'dashboards:write', 'dashboards:apply', 'monitors:read'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: false,
    })
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('registration stores nothing and returns a signed public client; without the signing key it is off and not advertised', async () => {
    const r = await register({ client_name: 'Claude', grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none', application_type: 'native' })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] })
    expect(r.body.client_id).toMatch(/^vzk1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
    expect(r.body.client_secret).toBeUndefined()
    // Two registrations of the same metadata are two clients.
    expect((await register({ client_name: 'Claude' })).body.client_id).not.toBe(r.body.client_id)

    const off = { ...env, OAUTH_CLIENT_KEY: undefined }
    const { default: worker } = await import('../src/index')
    const reg = await worker.fetch!(new Request(`${ORIGIN}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) }) as never, off as never, {} as ExecutionContext)
    expect(reg.status).toBe(503)
    const meta = (await (await worker.fetch!(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`) as never, off as never, {} as ExecutionContext)).json()) as Record<string, unknown>
    expect(meta.registration_endpoint).toBeUndefined()
  })

  it('redirect URIs: https, or http on a loopback host; no fragment, user info, other schemes, spaces; at most 5', async () => {
    const bad = ['http://example.com/cb', 'https://example.com/cb#x', 'https://user:pw@example.com/cb', 'com.example.app:/cb', 'javascript:alert(1)', 'https://exa mple.com/cb', 'https://example.com\\@evil.com/', '/relative', '', 'x'.repeat(600)]
    for (const u of bad) {
      const r = await register({ redirect_uris: [u] })
      expect(r.status, u).toBe(400)
      expect(r.body.error).toBe('invalid_redirect_uri')
    }
    expect((await register({ redirect_uris: [] })).status).toBe(400)
    expect((await register({ redirect_uris: Array.from({ length: 6 }, (_, i) => `https://a.example/${i}`) })).status).toBe(400)
    for (const u of ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:6274/oauth/callback', 'http://[::1]:9/cb', 'http://127.0.0.1:1/cb?x=1']) expect((await register({ redirect_uris: [u] })).status, u).toBe(201)
    // confidential clients, odd grant types and response types: refused
    for (const m of [{ token_endpoint_auth_method: 'client_secret_basic' }, { grant_types: ['client_credentials'] }, { grant_types: ['refresh_token'] }, { response_types: ['token'] }, { scope: 'admin' }]) {
      expect((await register(m)).status, JSON.stringify(m)).toBe(400)
    }
  })
})

describe('the authorization request: exact redirect URIs, PKCE S256 only, and never a redirect by itself', () => {
  it('a valid request answers a plain-text page that says what is asked and how a person approves it', async () => {
    const client = await newClient({ client_name: 'Claude‮ (evil)\u0000' })
    const { challenge } = await pkce()
    const { res, handle } = await authorize(client, challenge, { scope: 'read dashboards:write' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.get('Location')).toBeNull()
    expect(res.text).toContain('Returns to:   127.0.0.1:33418')
    expect(res.text).toContain('WARNING: a program on the computer')
    expect(res.text).toMatch(/read\s+query and search your telemetry/)
    expect(res.text).toMatch(/dashboards:write\s+propose dashboard changes/)
    expect(res.text).toContain(`Resource:     ${RESOURCE}`)
    expect(res.text).toContain(`${ORIGIN}/api/v1/control/oauth/approve`)
    expect(res.text).toContain('has not verified it')
    // the client's own name is shown on one line, without its bidi override or control character
    expect(res.text).not.toMatch(/[‮\u0000]/)
    expect(handle).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('an unknown or tampered client, or a redirect URI that is not exactly a registered one: 400, no redirect, nothing stored', async () => {
    const client = await newClient()
    const { challenge } = await pkce()
    const [, payload, mac] = /^vzk1\.([^.]+)\.(.+)$/.exec(client)!
    const reg = JSON.parse(atob(payload!.replace(/-/g, '+').replace(/_/g, '/'))) as ClientRegistration
    const evilPayload = btoa(JSON.stringify({ ...reg, uris: ['https://evil.example/cb'] })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const forged = await signRegistration('another-deployment-key-0123456789abcdef', reg)
    const cases: [string, string][] = [
      [client, 'https://evil.example/cb'],
      [client, `${REDIRECT}/`],
      [client, REDIRECT.replace('33418', '33419')],
      [client, `${REDIRECT}?next=https://evil.example`],
      [client, REDIRECT.replace('127.0.0.1', 'localhost')],
      [client, REDIRECT.toUpperCase()],
      [`vzk1.${evilPayload}.${mac}`, 'https://evil.example/cb'],
      [forged, REDIRECT],
      ['vzk1.x.y', REDIRECT],
      ['', REDIRECT],
    ]
    for (const [id, redirect] of cases) {
      const r = await oauthFetch(authorizeUrl(id, challenge, { redirect }))
      expect(r.status, `${id.slice(0, 20)} ${redirect}`).toBe(400)
      expect(r.headers.get('Location')).toBeNull()
      expect(r.text).toContain('cannot be completed')
      expect(r.text).not.toContain('evil.example')
    }
    // a parameter sent twice cannot be returned either
    expect((await oauthFetch(`${authorizeUrl(client, challenge)}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`)).status).toBe(400)
  })

  it('PKCE: a missing, malformed or plain challenge is refused; so are unknown scopes and another resource; the error is shown with the client\'s own callback, not followed', async () => {
    const client = await newClient()
    const { challenge } = await pkce()
    const cases: [Parameters<typeof authorizeUrl>[2], string][] = [
      [{ method: null }, 'invalid_request'],
      [{ method: 'plain' }, 'invalid_request'],
      [{ challenge: 'short' }, 'invalid_request'],
      [{ scope: 'read admin' }, 'invalid_scope'],
      [{ scope: 'write' }, 'invalid_scope'],
      [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
      [{ resource: `${ORIGIN}/api/v1/query` }, 'invalid_target'],
      [{ extra: { response_type: 'token' } }, 'invalid_request'],
    ]
    for (const [o, error] of cases) {
      const r = await oauthFetch(authorizeUrl(client, challenge, o))
      expect(r.status, JSON.stringify(o)).toBe(400)
      expect(r.headers.get('Location')).toBeNull()
      expect(r.text).toContain(`${error}:`)
      const link = /^ {2}(http\S+)$/m.exec(r.text)![1]!
      expect(link.startsWith(`${REDIRECT}?`)).toBe(true)
      expect(new URL(link).searchParams.get('iss')).toBe(ORIGIN)
      expect(new URL(link).searchParams.get('state')).toBe('st-123')
    }
    // response_type missing entirely
    const q = new URL(`${ORIGIN}${authorizeUrl(client, challenge)}`)
    q.searchParams.delete('response_type')
    expect((await oauthFetch(q.pathname + q.search)).text).toContain('unsupported_response_type')
    // no resource: the one resource is assumed; upper-case scheme and host are the same resource
    expect((await authorize(client, challenge, { resource: null })).res.status).toBe(200)
    expect((await authorize(client, challenge, { resource: 'HTTPS://VIZ.BITCRU.SH/mcp' })).res.status).toBe(200)
  })

  it('no endpoint ever answers with a redirect', async () => {
    const t = await newTenant('noredirect')
    const c = await connect(await personKey(t.admin))
    const answers: Res[] = [
      await oauthFetch('/.well-known/oauth-authorization-server'),
      await oauthFetch(authorizeUrl(c.clientId, 'x'.repeat(43))),
      await oauthFetch(authorizeUrl(c.clientId, 'x'.repeat(43), { redirect: 'https://evil.example/' })),
      await exchange(c.clientId, c.code, c.verifier),
      await refresh(c.clientId, c.refresh),
      await revokeAtServer(c.clientId, c.access),
      await register(),
    ]
    for (const a of answers) {
      expect(a.status < 300 || a.status >= 400).toBe(true)
      expect(a.headers.get('Location')).toBeNull()
    }
  })
})

describe('consent: a person approves, with a key that holds admin, and never grants more than that key holds', () => {
  it('a dry run is the preview: what would be granted, no code, nothing stored', async () => {
    const t = await newTenant('preview')
    const dana = await personKey(t.admin)
    const client = await newClient()
    const { challenge } = await pkce()
    const { handle } = await authorize(client, challenge, { scope: 'read dashboards:read dashboards:write' })
    const before = await runInDurableObject(stubOf(t.tenant), (_i, s) => dumpOf(s))
    const dry = await approve(dana, handle!, { dryRun: true })
    expect(dry.status, dry.text).toBe(201)
    expect(dry.body).toMatchObject({ dryRun: true, redirect: null, withheld: [], grant: { status: 'live', scopes: ['read', 'dashboards:read', 'dashboards:write'], resource: RESOURCE, client: { name: 'Test agent', redirectUris: [REDIRECT] } } })
    expect(dry.body.warnings.join(' ')).toContain('has not verified it')
    expect(await runInDurableObject(stubOf(t.tenant), (_i, s) => dumpOf(s))).toEqual(before)
  })

  it('an agent key, even with admin, may not approve; a key without admin may not either; nothing is stored', async () => {
    const t = await newTenant('approver')
    const agent = await makeKey(t.admin, ['admin', ...OAUTH_SCOPES], { kind: 'agent', name: 'bot' })
    const reader = await makeKey(t.admin, [...OAUTH_SCOPES], { name: 'reader' })
    const client = await newClient()
    const { challenge } = await pkce()
    const { handle } = await authorize(client, challenge)
    const before = await runInDurableObject(stubOf(t.tenant), (_i, s) => dumpOf(s))
    const a = await approve(agent.key, handle!)
    expect(a.status).toBe(403)
    expect(a.body.code).toBe('approver-not-a-person')
    const r = await approve(reader.key, handle!)
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('missing-scope')
    expect(await runInDurableObject(stubOf(t.tenant), (_i, s) => dumpOf(s))).toEqual(before)
  })

  it('a token cannot exceed the approver\'s scopes: the grant, its key in KV, the token response and introspection all hold the intersection', async () => {
    const t = await newTenant('scopes')
    // The first admin key holds only admin: it may hand on the dashboards scopes admin stands for, and nothing else.
    const c = await connect(t.admin, { scope: 'read dashboards:read dashboards:write monitors:read' })
    expect(c.approval.withheld).toEqual(['read', 'monitors:read'])
    expect(c.grant.scopes).toEqual(['dashboards:read', 'dashboards:write'])
    expect(c.scope).toBe('dashboards:read dashboards:write')
    const kv = await kvGet(`key:${await grantKeyId(t.tenant, c.grant.id)}`)
    expect(kv.scopes).toEqual(['dashboards:read', 'dashboards:write'])
    const who = await introspect(t.tenant, c.access)
    expect(who).toMatchObject({ status: 'active', scopes: ['dashboards:read', 'dashboards:write'], kind: 'agent', mayApply: false })
    // A key with read but not monitors:read: monitors:read is withheld.
    const partial = await makeKey(t.admin, ['admin', 'read'], { name: 'partial' })
    const c2 = await connect(partial.key, { scope: 'read monitors:read' })
    expect(c2.grant.scopes).toEqual(['read'])
    // Nothing in common: refused, nothing granted.
    const client = await newClient()
    const { challenge } = await pkce()
    const { handle } = await authorize(client, challenge, { scope: 'monitors:read' })
    const none = await approve(t.admin, handle!)
    expect(none.status).toBe(403)
    expect(none.body.code).toBe('nothing-to-grant')
    // A person may narrow, never widen.
    const dana = await personKey(t.admin)
    const narrowed = await approve(dana, (await authorize(await newClient(), challenge, { scope: 'read dashboards:read' })).handle!, { scopes: ['read'] })
    expect(narrowed.body.grant.scopes).toEqual(['read'])
    const widened = await approve(dana, (await authorize(await newClient(), challenge, { scope: 'read' })).handle!, { scopes: ['read', 'dashboards:apply'] })
    expect(widened.status).toBe(422)
    // An admin key never makes an admin grant, even if asked by a forged handle.
    const forged = btoa(JSON.stringify({ v: 1, client_id: client, redirect_uri: REDIRECT, scope: ['admin'], code_challenge: challenge, state: null, resource: RESOURCE })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect((await approve(dana, forged)).status).toBe(422)
  })

  it('a registration nobody approved within 24 h is refused; a forged handle is checked again in full', async () => {
    const t = await newTenant('aged')
    const dana = await personKey(t.admin)
    const { challenge } = await pkce()
    const old = await signRegistration(TEST_KEY, { v: 1, n: 'aaaaaaaaaaaaaaaa', iat: Math.floor(Date.now() / 1000) - 86_401, name: 'old', uris: [REDIRECT] })
    const { handle } = await authorize(old, challenge)
    const r = await approve(dana, handle!)
    expect(r.status).toBe(422)
    expect(r.body.code).toBe('registration-expired')
    // A handle whose redirect URI was edited after /oauth/authorize checked it: refused at approval too.
    const client = await newClient()
    const h = (await authorize(client, challenge)).handle!
    const edited = JSON.parse(atob(h.replace(/-/g, '+').replace(/_/g, '/')))
    edited.redirect_uri = 'https://evil.example/cb'
    const e = await approve(dana, btoa(JSON.stringify(edited)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
    expect(e.status).toBe(422)
    expect(e.text).not.toContain('evil.example')
    expect((await get(dana, '/oauth/grants')).body.items).toEqual([])
  })

  it('bounds per tenant: approvals an hour, clients, live grants', async () => {
    const t = await newTenant('bounds')
    const dana = await personKey(t.admin)
    const { challenge } = await pkce()
    const client = await newClient()
    for (let i = 0; i < 20; i++) expect((await approve(dana, (await authorize(client, challenge)).handle!)).status, `approval ${i}`).toBe(201)
    const over = await approve(dana, (await authorize(client, challenge)).handle!)
    expect(over.status).toBe(429)
    expect(over.body.code).toBe('too-many-approvals')
    expect(over.headers.get('Retry-After')).toBe('600')

    const u = await newTenant('bounds2')
    const dana2 = await personKey(u.admin)
    await runInDurableObject(stubOf(u.tenant), (_i, s) => {
      for (let i = 0; i < 50; i++) s.storage.sql.exec("INSERT INTO oauth_clients (tenant, id, client_id, name, redirect_uris, registered_at, bound_at, bound_by, last_used_at) VALUES (?, ?, ?, 'x', '[]', 0, 0, '{}', 0)", u.tenant, `c_fill${i}`, `fill${i}`)
    })
    const tooManyClients = await approve(dana2, (await authorize(await newClient(), challenge)).handle!)
    expect(tooManyClients.body.code).toBe('too-many-clients')
    await runInDurableObject(stubOf(u.tenant), (_i, s) => {
      s.storage.sql.exec("DELETE FROM oauth_clients WHERE tenant = ? AND id LIKE 'c_fill%'", u.tenant)
      for (let i = 0; i < 50; i++) s.storage.sql.exec("INSERT INTO oauth_grants (tenant, id, client, scopes, resource, key, created_at, created_by, expires_at) VALUES (?, ?, 'c_x', '[]', ?, NULL, 0, '{}', ?)", u.tenant, `g_fill${i}`, RESOURCE, Date.now() + 86_400_000)
    })
    const tooManyGrants = await approve(dana2, (await authorize(await newClient(), challenge)).handle!)
    expect(tooManyGrants.body.code).toBe('too-many-grants')
  })
})

describe('the token endpoint', () => {
  it('the whole flow: approve, exchange; tokens are opaque, typed, short-lived, not cached; the approval is audited once and the exchange not at all', async () => {
    const t = await newTenant('flow')
    const dana = await personKey(t.admin)
    const audit0 = (await auditOf(t.admin)).length
    const c = await connect(dana)
    keep(c.code, c.access, c.refresh, c.verifier)
    expect(c.access).toMatch(new RegExp(`^vza1\\.${t.tenant}\\.[A-Za-z0-9]{43}$`))
    expect(c.refresh).toMatch(new RegExp(`^vzr1\\.${t.tenant}\\.[A-Za-z0-9]{43}$`))
    expect(codeOf(c.approval.redirect)).toMatchObject({ state: 'st-123', iss: ORIGIN })
    expect(c.approval.redirect.startsWith(`${REDIRECT}?code=vzc1.`)).toBe(true)
    const audit = await auditOf(t.admin)
    // the approval only; the exchange is not a change anyone audits
    expect(audit.length).toBe(audit0 + 1)
    expect(audit[0]).toMatchObject({ action: 'oauth.grant.approve', target: { type: 'oauth-grant', id: c.grant.id } })
    expect(JSON.stringify(audit)).not.toContain(c.code)
    const grant = await grantOf(dana, c.grant.id)
    expect(grant).toMatchObject({ status: 'live', approvedBy: { kind: 'key' }, key: { name: `oauth:${c.grant.id}` } })
    expect(grant.lastUsedAt).not.toBeNull()
    // the same client again: already bound in this tenant, a second grant
    const x = await connectCode(dana, c.clientId)
    const res = await exchange(x.client, x.code, x.verifier)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read dashboards:read monitors:read' })
    expect((await sql(t.tenant, 'SELECT COUNT(*) AS n FROM oauth_clients WHERE tenant = ?', t.tenant))[0]!.n).toBe(1)
  })

  it('a PKCE verifier mismatch is refused, spends the code and ends its grant (key gone); the right verifier afterwards is refused', async () => {
    const t = await newTenant('pkce')
    const dana = await personKey(t.admin)
    const { client, code, verifier, grant } = await connectCode(dana)
    const keyId = (await grantKeyId(t.tenant, grant))!
    const other = await pkce()
    const bad = await exchange(client, code, other.verifier)
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('invalid_grant')
    expect(bad.text).not.toContain(code)
    // nothing was issued and the code is spent: the grant can never issue, so it ends now
    expect(await grantOf(dana, grant)).toMatchObject({ status: 'revoked', revokeReason: 'exchange-failed', revokedBy: { subject: 'system:oauth' }, key: null })
    expect(await kvGet(`key:${keyId}`)).toBeNull()
    const good = await exchange(client, code, verifier)
    expect(good.status).toBe(400)
    expect(good.body.error).toBe('invalid_grant')
    // malformed verifiers are refused the same way
    const again = await connectCode(dana)
    for (const v of ['', 'short', 'x'.repeat(129), `${again.verifier}!`]) expect((await exchange(again.client, again.code, v)).body.error).toBe('invalid_grant')
  })

  it('code reuse is refused and revokes what the code issued: the access token, the refresh token and the grant\'s key (KV too)', async () => {
    const t = await newTenant('reuse')
    const dana = await personKey(t.admin)
    const c = await connect(dana)
    const keyId = (await grantKeyId(t.tenant, c.grant.id))!
    expect(await kvGet(`key:${keyId}`)).not.toBeNull()
    expect(await introspect(t.tenant, c.access)).toMatchObject({ status: 'active' })
    const second = await exchange(c.clientId, c.code, c.verifier)
    expect(second.status).toBe(400)
    expect(second.body.error).toBe('invalid_grant')
    // the grant's tokens are deleted with it: inactive (as unknown)
    expect(await introspect(t.tenant, c.access)).toMatchObject({ v: 1, status: 'inactive' })
    expect((await refresh(c.clientId, c.refresh)).body.error).toBe('invalid_grant')
    expect(await kvGet(`key:${keyId}`)).toBeNull()
    expect(await sql(t.tenant, 'SELECT * FROM oauth_tokens WHERE tenant = ?', t.tenant)).toEqual([])
    expect((await grantOf(dana, c.grant.id))).toMatchObject({ status: 'revoked', revokeReason: 'code-reuse', revokedBy: { subject: 'system:oauth' }, key: null })
    expect((await auditOf(t.admin))[0]).toMatchObject({ action: 'oauth.grant.revoke', by: { subject: 'system:oauth' } })
  })

  it('the code is bound to its client, its exact redirect URI and its resource; an expired code is refused', async () => {
    const t = await newTenant('bound')
    const dana = await personKey(t.admin)
    const otherClient = await newClient({ redirect_uris: [REDIRECT] })
    for (const [what, run] of [
      ['another client', (x: Awaited<ReturnType<typeof connectCode>>) => exchange(otherClient, x.code, x.verifier)],
      ['another redirect URI', (x: Awaited<ReturnType<typeof connectCode>>) => exchange(x.client, x.code, x.verifier, { redirect_uri: `${REDIRECT}/` })],
      ['another resource', (x: Awaited<ReturnType<typeof connectCode>>) => exchange(x.client, x.code, x.verifier, { resource: 'https://other.example/mcp' })],
    ] as const) {
      const x = await connectCode(dana)
      const r = await run(x)
      expect(r.status, what).toBe(400)
      expect(['invalid_grant', 'invalid_target'], what).toContain(r.body.error)
      // spent: the legitimate exchange now fails too, and the grant ended with the failure
      expect((await exchange(x.client, x.code, x.verifier)).status, what).toBe(400)
      expect((await grantOf(dana, x.grant)).revokeReason, what).toBe('exchange-failed')
    }
    // failed exchanges leave nothing live to count against the grant and key limits
    expect((await sql(t.tenant, 'SELECT COUNT(*) AS n FROM oauth_grants WHERE tenant = ? AND revoked_at IS NULL', t.tenant))[0]!.n).toBe(0)
    const x = await connectCode(dana)
    await sql(t.tenant, 'UPDATE oauth_codes SET expires_at = ? WHERE tenant = ?', Date.now() - 1, t.tenant)
    expect((await exchange(x.client, x.code, x.verifier)).body.error).toBe('invalid_grant')
  })

  it('malformed requests: no client authentication accepted, form encoding only, parameters once', async () => {
    const t = await newTenant('malformed')
    const x = await connectCode(await personKey(t.admin))
    const base = { grant_type: 'authorization_code', client_id: x.client, code: x.code, code_verifier: x.verifier, redirect_uri: REDIRECT }
    expect((await form('/oauth/token', base, { Authorization: `Basic ${btoa(`${x.client}:secret`)}` })).status).toBe(401)
    expect((await form('/oauth/token', { ...base, client_secret: 'x' })).status).toBe(401)
    expect((await oauthFetch('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(base) })).status).toBe(400)
    expect((await oauthFetch('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `${new URLSearchParams(base)}&code=${x.code}` })).body.error).toBe('invalid_request')
    expect((await form('/oauth/token', { ...base, grant_type: 'password' })).body.error).toBe('unsupported_grant_type')
    expect((await form('/oauth/token', { ...base, client_id: 'nope' })).status).toBe(401)
    expect((await oauthFetch('/oauth/token')).status).toBe(405)
    // none of that spent the code
    expect((await exchange(x.client, x.code, x.verifier)).status).toBe(200)
  })
})

describe('refresh tokens rotate; reuse revokes the grant', () => {
  it('each refresh spends the token and issues a new pair; presenting a used one revokes everything', async () => {
    const t = await newTenant('rotate')
    const dana = await personKey(t.admin)
    const c = await connect(dana)
    const r1 = await refresh(c.clientId, c.refresh)
    expect(r1.status).toBe(200)
    expect(r1.body.refresh_token).not.toBe(c.refresh)
    expect(r1.body.access_token).not.toBe(c.access)
    keep(r1.body.refresh_token, r1.body.access_token)
    const r2 = await refresh(c.clientId, r1.body.refresh_token)
    expect(r2.status).toBe(200)
    expect(await introspect(t.tenant, r2.body.access_token)).toMatchObject({ status: 'active' })
    // the first refresh token again: someone else holds a copy
    const reuse = await refresh(c.clientId, c.refresh)
    expect(reuse.body.error).toBe('invalid_grant')
    expect(await introspect(t.tenant, r2.body.access_token)).toMatchObject({ status: 'inactive' })
    expect((await refresh(c.clientId, r2.body.refresh_token)).body.error).toBe('invalid_grant')
    expect(await grantOf(dana, c.grant.id)).toMatchObject({ status: 'revoked', revokeReason: 'refresh-reuse' })
  })

  it('a refresh may narrow the scope, never widen it; a refresh token presented by another client revokes its grant', async () => {
    const t = await newTenant('narrow')
    const dana = await personKey(t.admin)
    const c = await connect(dana, { scope: 'read dashboards:read' })
    expect((await refresh(c.clientId, c.refresh, { scope: 'read dashboards:write' })).body.error).toBe('invalid_scope')
    const n = await refresh(c.clientId, c.refresh, { scope: 'read' })
    expect(n.body.scope).toBe('read')
    expect(await introspect(t.tenant, n.body.access_token)).toMatchObject({ scopes: ['read'] })
    const thief = await newClient()
    expect((await refresh(thief, n.body.refresh_token)).body.error).toBe('invalid_grant')
    expect(await grantOf(dana, c.grant.id)).toMatchObject({ status: 'revoked', revokeReason: 'wrong-client' })
  })
})

describe('tenant isolation of tokens', () => {
  it('a token of tenant A is unknown to tenant B, also when edited to name B, and A\'s grant is unaffected', async () => {
    const a = await newTenant('iso-a')
    const b = await newTenant('iso-b')
    const ca = await connect(await personKey(a.admin))
    const swap = (s: string) => s.replace(`.${a.tenant}.`, `.${b.tenant}.`)
    expect(await introspect(b.tenant, ca.access)).toEqual({ v: 1, status: 'inactive', reason: 'unknown' })
    expect(await introspect(b.tenant, swap(ca.access))).toEqual({ v: 1, status: 'inactive', reason: 'unknown' })
    expect((await refresh(ca.clientId, swap(ca.refresh))).body.error).toBe('invalid_grant')
    expect((await exchange(ca.clientId, swap(ca.code), ca.verifier)).body.error).toBe('invalid_grant')
    await revokeAtServer(ca.clientId, swap(ca.refresh))
    // A's object never heard of any of it
    expect(await introspect(a.tenant, ca.access)).toMatchObject({ status: 'active', tenant: a.tenant })
    expect((await refresh(ca.clientId, ca.refresh)).status).toBe(200)
    // B's object asked about A's tenant: not provisioned for it
    expect(await stubOf(b.tenant).introspectAccessToken(a.tenant, ca.access, RESOURCE)).toEqual({ v: 1, status: 'not_provisioned' })
    expect(await stubOf(b.tenant).oauthToken(a.tenant, { grant_type: 'refresh_token', client_id: ca.clientId, refresh_token: ca.refresh })).toEqual({ v: 1, status: 'not_provisioned' })
    // B's admin sees none of A's grants and cannot touch them
    expect((await get(b.admin, '/oauth/grants?status=all')).body.items).toEqual([])
    expect((await post(b.admin, `/oauth/grants/${ca.grant.id}/revoke`)).status).toBe(404)
    // an access token is not an API key anywhere else
    expect((await call(ca.access, 'GET', '/whoami')).status).toBe(401)
    await expect(authenticate(new Request('https://x/', { headers: { Authorization: `Bearer ${ca.access}` } }), env.CONFIG, 'read')).rejects.toMatchObject({ status: 401 })
  })
})

describe('a credential naming a tenant nobody provisioned', () => {
  it('is refused at every entry point, and creates no storage for that name', async () => {
    const names = Array.from({ length: 3 }, () => `ghost-${crypto.randomUUID().slice(0, 8)}`)
    const client = await newClient()
    for (const ghost of names) {
      const fake = (p: string) => `${p}.${ghost}.${'a'.repeat(43)}`
      expect(await introspect(ghost, fake('vza1'))).toEqual({ v: 1, status: 'not_provisioned' })
      expect((await exchange(client, fake('vzc1'), 'v'.repeat(43))).body.error).toBe('invalid_grant')
      expect((await refresh(client, fake('vzr1'))).body.error).toBe('invalid_grant')
      expect((await revokeAtServer(client, fake('vzr1'))).status).toBe(200)
      const tables = await runInDurableObject(stubOf(ghost), (_i, s) => s.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'").toArray())
      expect(tables, ghost).toEqual([])
      expect(await runDurableObjectAlarm(stubOf(ghost))).toBe(false)
    }
    // and provisioning such an object afterwards works as for any new tenant
    const { key } = await stubOf(names[0]!).provision(names[0]!)
    expect((await get(key, '/whoami')).body.tenant).toBe(names[0])
  })
})

describe('introspection, for the resource', () => {
  it('active: the grant\'s identity and its key for downstream calls, which edge accepts with the grant\'s scopes and which is not the token', async () => {
    const t = await newTenant('intro')
    const dana = await personKey(t.admin)
    const c = await connect(dana, { scope: 'read dashboards:read' })
    const who = await introspect(t.tenant, c.access)
    if (who.status !== 'active') throw new Error(JSON.stringify(who))
    keep(who.credential)
    expect(who).toMatchObject({ v: 1, tenant: t.tenant, grant: c.grant.id, clientName: 'Test agent', kind: 'agent', name: `oauth:${c.grant.id}`, scopes: ['read', 'dashboards:read'], mayApply: false })
    expect(who.credential).toMatch(/^viz_[A-Za-z0-9]{16}_[A-Za-z0-9]{40}$/)
    expect(who.credential).not.toContain(c.access.split('.')[2])
    clearAuthCache()
    const p = await authenticate(new Request('https://x/', { headers: { Authorization: `Bearer ${who.credential}` } }), env.CONFIG, 'read')
    expect(p).toMatchObject({ tenant: t.tenant, scopes: ['read', 'dashboards:read'] })
    const whoami = await get(who.credential, '/whoami')
    expect(whoami.body).toMatchObject({ subject: who.subject, kind: 'agent', name: who.name, scopes: ['read', 'dashboards:read'], mayApply: false })
    // the audience is this resource only; scheme and host case do not matter
    expect(await introspect(t.tenant, c.access, `${ORIGIN}/api/v1/agent`)).toEqual({ v: 1, status: 'inactive', reason: 'audience' })
    expect(await introspect(t.tenant, c.access, 'https://other.example/mcp')).toEqual({ v: 1, status: 'inactive', reason: 'audience' })
    expect(await introspect(t.tenant, c.access, 'HTTPS://VIZ.BITCRU.SH/mcp')).toMatchObject({ status: 'active' })
    // a refresh token or a code is not an access token
    expect(await introspect(t.tenant, c.refresh)).toMatchObject({ status: 'inactive', reason: 'unknown' })
  })

  it('expired and revoked tokens are refused at once: expiry, a person\'s revocation, RFC 7009 by the client, the grant key disabled (suspended) and enabled again', async () => {
    const t = await newTenant('ends')
    const dana = await personKey(t.admin)
    // expiry
    const e = await connect(dana)
    await sql(t.tenant, "UPDATE oauth_tokens SET expires_at = ? WHERE tenant = ? AND kind = 'access'", Date.now() - 1, t.tenant)
    expect(await introspect(t.tenant, e.access)).toEqual({ v: 1, status: 'inactive', reason: 'expired' })
    // a person revokes: the tokens stop, the key goes from KV, the audit names the person
    const p = await connect(dana)
    const keyId = (await grantKeyId(t.tenant, p.grant.id))!
    const dry = await post(dana, `/oauth/grants/${p.grant.id}/revoke`, { dryRun: true })
    expect(dry.body).toMatchObject({ dryRun: true, outcome: 'revoked' })
    expect(await introspect(t.tenant, p.access)).toMatchObject({ status: 'active' })
    const rv = await post(dana, `/oauth/grants/${p.grant.id}/revoke`)
    expect(rv.body).toMatchObject({ outcome: 'revoked', grant: { status: 'revoked', revokeReason: 'person' }, kv: 'published' })
    expect(await introspect(t.tenant, p.access)).toMatchObject({ v: 1, status: 'inactive' })
    expect(await kvGet(`key:${keyId}`)).toBeNull()
    expect((await refresh(p.clientId, p.refresh)).body.error).toBe('invalid_grant')
    expect((await post(dana, `/oauth/grants/${p.grant.id}/revoke`)).body.outcome).toBe('unchanged')
    // the client revokes its access token: that token only; its refresh token: the grant
    const r = await connect(dana)
    expect((await revokeAtServer(r.clientId, r.access)).status).toBe(200)
    expect(await introspect(t.tenant, r.access)).toMatchObject({ status: 'inactive' })
    const after = await refresh(r.clientId, r.refresh)
    expect(after.status).toBe(200)
    expect((await revokeAtServer(await newClient(), after.body.refresh_token)).status).toBe(200) // another client: no effect
    expect(await introspect(t.tenant, after.body.access_token)).toMatchObject({ status: 'active' })
    expect((await revokeAtServer(r.clientId, after.body.refresh_token)).status).toBe(200)
    expect(await introspect(t.tenant, after.body.access_token)).toMatchObject({ status: 'inactive' })
    expect(await grantOf(dana, r.grant.id)).toMatchObject({ status: 'revoked', revokeReason: 'client' })
    expect((await revokeAtServer(r.clientId, 'garbage')).status).toBe(200)
    // suspend through the key, then resume
    const s = await connect(dana)
    const key = (await grantOf(dana, s.grant.id)).key.id
    await post(dana, `/keys/${key}/disable`)
    expect(await introspect(t.tenant, s.access)).toEqual({ v: 1, status: 'inactive', reason: 'suspended' })
    expect((await grantOf(dana, s.grant.id)).status).toBe('suspended')
    await post(dana, `/keys/${key}/enable`)
    expect(await introspect(t.tenant, s.access)).toMatchObject({ status: 'active' })
  })

  it('a grant is never broader than its approver\'s key, also later: disabled, the grant is suspended; deleted, it ends', async () => {
    const t = await newTenant('approver-key')
    const dana = await makeKey(t.admin, ['admin', ...OAUTH_SCOPES], { name: 'dana' })
    const c = await connect(dana.key)
    await post(t.admin, `/keys/${dana.id}/disable`)
    expect(await introspect(t.tenant, c.access)).toEqual({ v: 1, status: 'inactive', reason: 'suspended' })
    expect((await grantOf(t.admin, c.grant.id)).status).toBe('suspended')
    await post(t.admin, `/keys/${dana.id}/enable`)
    expect(await introspect(t.tenant, c.access)).toMatchObject({ status: 'active' })
    const keyId = (await grantKeyId(t.tenant, c.grant.id))!
    expect((await call(t.admin, 'DELETE', `/keys/${dana.id}`, { confirmName: 'dana' })).status).toBe(200)
    expect(await introspect(t.tenant, c.access)).toEqual({ v: 1, status: 'inactive', reason: 'revoked' })
    expect((await refresh(c.clientId, c.refresh)).body.error).toBe('invalid_grant')
    // the alarm is due at once, and ends the grant with its key
    expect(await runInDurableObject(stubOf(t.tenant), (_i, s) => s.storage.getAlarm())).toBeLessThanOrEqual(Date.now())
    expect(await runDurableObjectAlarm(stubOf(t.tenant))).toBe(true)
    expect(await grantOf(t.admin, c.grant.id)).toMatchObject({ status: 'revoked', revokeReason: 'approver-gone', key: null })
    expect(await kvGet(`key:${keyId}`)).toBeNull()
  })

  it('a grant\'s key cannot be rotated, deleted or impersonated through the keys API', async () => {
    const t = await newTenant('grantkey')
    const dana = await personKey(t.admin)
    const c = await connect(dana)
    const key = (await grantOf(dana, c.grant.id)).key
    expect((await post(dana, `/keys/${key.id}/rotate`)).body.code).toBe('grant-key')
    expect((await call(dana, 'DELETE', `/keys/${key.id}`, { confirmName: key.name })).body.code).toBe('grant-key')
    expect((await post(dana, '/keys', { name: 'oauth:g_mine', scopes: ['read'] })).status).toBe(422)
    expect(await introspect(t.tenant, c.access)).toMatchObject({ status: 'active' })
  })
})

describe('the alarm: grants that are due end by themselves', () => {
  it('a code nobody exchanged, a grant past its end, an idle grant, and a client with nothing left', async () => {
    const t = await newTenant('alarm')
    const dana = await personKey(t.admin)
    const stub = stubOf(t.tenant)
    const x = await connectCode(dana)
    const alarm = await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())
    expect(alarm).toBeGreaterThan(Date.now() + 500_000) // the code's expiry, about 10 minutes
    expect(alarm).toBeLessThanOrEqual(Date.now() + 600_000)
    await sql(t.tenant, 'UPDATE oauth_codes SET expires_at = ? WHERE tenant = ?', Date.now() - 1, t.tenant)
    const c = await connect(dana)
    const old = await connect(dana)
    await sql(t.tenant, 'UPDATE oauth_grants SET expires_at = ? WHERE tenant = ? AND id = ?', Date.now() - 1, t.tenant, c.grant.id)
    await sql(t.tenant, 'UPDATE oauth_grants SET last_used_at = ? WHERE tenant = ? AND id = ?', Date.now() - 31 * 86_400_000, t.tenant, old.grant.id)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(await grantOf(dana, x.grant)).toMatchObject({ status: 'revoked', revokeReason: 'not-exchanged', key: null })
    expect(await grantOf(dana, c.grant.id)).toMatchObject({ status: 'expired', revokeReason: 'expired', key: null })
    expect(await grantOf(dana, old.grant.id)).toMatchObject({ status: 'revoked', revokeReason: 'idle' })
    expect((await auditOf(t.admin)).filter((a) => a.by.subject === 'system:oauth').map((a) => a.action).sort()).toEqual(['oauth.grant.expire', 'oauth.grant.revoke', 'oauth.grant.revoke'])
    // every client now has no live grant; once idle 30 days it is forgotten
    await sql(t.tenant, 'UPDATE oauth_clients SET last_used_at = ? WHERE tenant = ?', Date.now() - 31 * 86_400_000, t.tenant)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(await sql(t.tenant, 'SELECT id FROM oauth_clients WHERE tenant = ?', t.tenant)).toEqual([])
    expect((await auditOf(t.admin)).filter((a) => a.action === 'oauth.client.expire').length).toBe(3)
    // closed grants are still listed; the alarm stays for their deletion in 90 days
    expect((await get(dana, '/oauth/grants?status=all')).body.items.length).toBe(3)
    expect((await get(dana, '/oauth/grants')).body.items).toEqual([])
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBeGreaterThan(Date.now() + 80 * 86_400_000)
  })
})

describe('no credential at rest, in a log line or in an error body', () => {
  let logged: string[] = []
  beforeEach(() => {
    logged = []
    for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')))
  })
  afterEach(() => vi.restoreAllMocks())

  it('after a flow with every error path, no stored row, KV value, log line or error body holds a code, token, verifier or the grant key\'s secret', async () => {
    const t = await newTenant('rest')
    const dana = await personKey(t.admin)
    const errors: string[] = []
    const note = (r: Res) => r.status >= 400 && errors.push(r.text)
    const c = await connect(dana)
    keep(c.code, c.access, c.refresh, c.verifier)
    const who = await introspect(t.tenant, c.access)
    if (who.status === 'active') keep(who.credential, who.credential.split('_')[2])
    note(await exchange(c.clientId, c.code, 'w'.repeat(43)))
    note(await refresh(await newClient(), c.refresh))
    const d = await connect(dana)
    keep(d.code, d.access, d.refresh, d.verifier)
    const r1 = await refresh(d.clientId, d.refresh)
    keep(r1.body.access_token, r1.body.refresh_token)
    note(await refresh(d.clientId, d.refresh))
    note(await exchange(d.clientId, d.code, d.verifier))
    note(await form('/oauth/token', { grant_type: 'refresh_token', client_id: d.clientId, refresh_token: d.refresh, client_secret: d.access }))
    note(await form('/oauth/revoke', { token: d.access }))
    note(await oauthFetch(authorizeUrl(c.clientId, c.verifier, { redirect: `https://x.example/${c.access}` })))
    // and grants whose code rows are still stored: one exchanged once (kept, spent, until it expires), one never exchanged
    const once = await connect(dana)
    keep(once.code, once.access, once.refresh, once.verifier)
    await connectCode(dana)
    expect((await sql(t.tenant, 'SELECT hash FROM oauth_codes WHERE tenant = ?', t.tenant)).length).toBe(2)
    // probe: a line logged inside the Tenant object reaches the spy, so the check below sees the object's logs too
    await runInDurableObject(stubOf(t.tenant), () => console.error('probe from the object'))
    expect(logged.some((l) => l.includes('probe from the object'))).toBe(true)

    const dump = JSON.stringify(await runInDurableObject(stubOf(t.tenant), (_i, s) => dumpOf(s)))
    const kv: string[] = []
    for (const k of (await env.CONFIG.list()).keys) kv.push(`${k.name}=${await env.CONFIG.get(k.name)}`)
    const secretParts = [...secrets].flatMap((s) => [s, ...(s.split('.').length === 3 ? [s.split('.')[2]!] : [])])
    expect(secretParts.length).toBeGreaterThan(10)
    expect(errors.length).toBeGreaterThanOrEqual(6)
    for (const s of secretParts) {
      expect(dump.includes(s), 'in SQLite').toBe(false)
      expect(kv.some((v) => v.includes(s)), 'in KV').toBe(false)
      expect(logged.some((l) => l.includes(s)), 'in a log line').toBe(false)
      expect(errors.some((e) => e.includes(s)), 'in an error body').toBe(false)
    }
    // the audit log and the grant views carry none either
    const views = JSON.stringify([await auditOf(t.admin), (await get(dana, '/oauth/grants?status=all')).body, (await get(dana, '/keys')).body])
    for (const s of secretParts) expect(views.includes(s)).toBe(false)
  })
})

describe('versioned storage', () => {
  it('the previous release (schema 2) may open storage holding OAuth grants and tokens, and changes nothing', async () => {
    const t = await newTenant('rollback-oauth')
    await connect(await personKey(t.admin))
    const res = await runInDurableObject(stubOf(t.tenant), (_i, s) => {
      const before = dumpOf(s)
      const opened = openSchema(s.storage, { ...TENANT_SCHEMA, migrations: TENANT_SCHEMA.migrations.slice(0, 2) })
      return { opened, before, after: dumpOf(s) }
    })
    expect(res.opened).toMatchObject({ status: 'ok', version: 3, compat: 1, known: 2, migrated: [] })
    expect(res.after).toEqual(res.before)
  })
})

/** Register, authorize and approve, and stop before the exchange. */
async function connectCode(approver: string, clientId?: string): Promise<{ client: string; code: string; verifier: string; grant: string }> {
  const client = clientId ?? (await newClient())
  const { verifier, challenge } = await pkce()
  const { handle } = await authorize(client, challenge)
  const ap = await approve(approver, handle!)
  if (ap.status !== 201) throw new Error(`approve: ${ap.status} ${ap.text}`)
  const { code } = codeOf(ap.body.redirect)
  keep(code, verifier)
  return { client, code, verifier, grant: ap.body.grant.id }
}
