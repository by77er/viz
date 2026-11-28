/**
 * /mcp as an OAuth 2.1 protected resource (MCP 2026-07-28 "Authorization", decision D44), with
 * the real control plane as authorization server (in-process, as the gateway would route) and the
 * fake query service and ruler behind it. The official SDK v2 client drives the whole flow once:
 * an implementation viz did not write reads what viz serves.
 */
import { runInDurableObject } from 'cloudflare:test'
import { Client, InsufficientScopeError, SdkHttpError, StreamableHTTPClientTransport, auth, type OAuthClientMetadata, type OAuthClientProvider } from '@modelcontextprotocol/client'
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as V1Transport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { OAUTH_SCOPES } from '../../contracts/oauth'
import { hasScopes, retryAfterSeconds } from '../src/auth'
import { httpControlClient, httpMonitorsClient, httpQueryClient, type Fetcher } from '../src/clients'
import { STEP_UP_MAX_BYTES, readCapped } from '../src/index'
import { BASE, type Harness, NOW, controlCall, controlFetcher, env, harness, makeKey, newTenant, rest, rpc, stubOf, telemetry } from './helpers'

const ORIGIN = 'https://vis.bitcru.sh'
const SERVER = `${ORIGIN}/mcp`
const PRM = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`
const REDIRECT = 'http://127.0.0.1:33418/callback'
const START = 'read dashboards:read monitors:read'

/** Every Authorization header a downstream service was sent. */
const downstream: string[] = []
const recording = (f: Fetcher): Fetcher => ({ fetch: (req) => (downstream.push(req.headers.get('Authorization') ?? ''), f.fetch(req)) })

let h: Harness
beforeAll(() => {
  h = harness({
    deps: {
      query: (_e, a) => httpQueryClient(recording(h.prom.fetcher), a),
      control: (_e, a) => httpControlClient(recording(controlFetcher), a),
      monitors: (_e, a) => httpMonitorsClient(recording(h.ruler.fetcher), a),
    },
  })
})

/** What the gateway does: /mcp and the resource metadata to this Worker; the authorization server's paths to control. */
const route = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const req = new Request(input, init)
  const p = new URL(req.url).pathname
  return p === '/mcp' || p.startsWith('/.well-known/oauth-protected-resource') ? h.fetch(req) : controlFetcher.fetch(req)
}

const b64url = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  return { verifier, challenge: b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))) }
}

const personKey = async (admin: string) => (await makeKey(admin, ['admin', ...OAUTH_SCOPES], { name: `dana ${Math.random().toString(36).slice(2, 7)}` })).key

/** The flow by hand: register, authorize, a person approves, exchange. */
async function connect(approver: string, scope = START): Promise<{ access: string; refresh: string; clientId: string; grant: string }> {
  const reg = (await (await route(`${ORIGIN}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Raw client', redirect_uris: [REDIRECT] }) })).json()) as any
  const { verifier, challenge } = await pkce()
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scope, state: 's', resource: SERVER })
  const page = await (await route(`${ORIGIN}/oauth/authorize?${q}`)).text()
  const ap = await controlCall(approver, 'POST', '/oauth/approve', { request: /^request: (\S+)$/m.exec(page)![1] })
  if (ap.status !== 201) throw new Error(`approve ${ap.status} ${JSON.stringify(ap.body)}`)
  const code = new URL(ap.body.redirect).searchParams.get('code')!
  const tok = (await (await route(`${ORIGIN}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: reg.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT, resource: SERVER }) })).json()) as any
  return { access: tok.access_token, refresh: tok.refresh_token, clientId: reg.client_id, grant: ap.body.grant.id }
}

/** Raw JSON-RPC on the stateless 2025 path (the SDK v2 client above covers 2026-07-28). */
const L = { 'MCP-Protocol-Version': '2025-06-18' }
const list = (cred: string | null, on: Harness = h) => rpc(on, cred, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, L)
const listTools = async (cred: string): Promise<string[]> => (await list(cred)).body.result.tools.map((t: any) => t.name)
const callTool = (cred: string, name: string, args: unknown = {}, headers: Record<string, string> = {}) => rpc(h, cred, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, { ...L, ...headers })

describe('protected resource metadata and the 401 challenge', () => {
  it('RFC 9728 metadata at the path-inserted and the root well-known URI, public, naming control as the authorization server', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const r = await h.fetch(new Request(`${BASE}${path}`, { headers: { Origin: 'https://inspector.example' } }))
      expect(r.status, path).toBe(200)
      expect(r.headers.get('Access-Control-Allow-Origin')).toBe('*')
      expect(await r.json()).toEqual({ resource: SERVER, authorization_servers: [ORIGIN], scopes_supported: ['read', 'dashboards:read', 'monitors:read'], bearer_methods_supported: ['header'], resource_name: 'viz' })
    }
    expect((await h.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`, { method: 'OPTIONS' }))).status).toBe(204)
    expect((await h.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`, { method: 'POST' }))).status).toBe(405)
    // the authorization server it names publishes S256
    const as = (await (await route(`${ORIGIN}/.well-known/oauth-authorization-server`)).json()) as any
    expect(as.issuer).toBe(ORIGIN)
    expect(as.code_challenge_methods_supported).toEqual(['S256'])
  })

  it('401 without a credential names the metadata and the scopes to start with, and no error; with a bad credential, invalid_token', async () => {
    const none = await list(null)
    expect(none.status).toBe(401)
    expect(none.headers.get('WWW-Authenticate')).toBe(`Bearer realm="viz", resource_metadata="${PRM}", scope="${START}"`)
    const t = await newTenant('chal')
    const ghost = `ghost-${crypto.randomUUID().slice(0, 8)}`
    for (const bad of [`vza1.${t.tenant}.${'x'.repeat(43)}`, 'viz_nope_nopenopenope', `vza1.${ghost}.${'y'.repeat(43)}`]) {
      const r = await list(bad)
      expect(r.status, bad).toBe(401)
      expect(r.headers.get('WWW-Authenticate')).toMatch(new RegExp(`^Bearer realm="viz", resource_metadata="${PRM}", scope="${START}", error="invalid_token"`))
      expect(JSON.stringify(r.body) + r.headers.get('WWW-Authenticate')).not.toContain(bad.slice(-20))
    }
    // a token naming a tenant nobody provisioned creates no storage for that name
    expect(await runInDurableObject(stubOf(ghost), (_i, st) => st.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'").toArray())).toEqual([])
  })
})

/** An OAuth client as an MCP host keeps it: in memory, one per test. */
class Provider implements OAuthClientProvider {
  info: any
  saved: any
  verifier = ''
  authUrl: URL | null = null
  readonly st = `st-${Math.random().toString(36).slice(2)}`
  get redirectUrl() {
    return REDIRECT
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'SDK v2 client', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }
  }
  state() {
    return this.st
  }
  clientInformation() {
    return this.info
  }
  saveClientInformation(i: any) {
    this.info = i
  }
  tokens() {
    return this.saved
  }
  saveTokens(t: any) {
    this.saved = t
  }
  redirectToAuthorization(u: URL) {
    this.authUrl = u
  }
  saveCodeVerifier(v: string) {
    this.verifier = v
  }
  codeVerifier() {
    return this.verifier
  }
}

describe('the official SDK v2 client does the whole flow', () => {
  it('discovers from the 401, registers, sends PKCE S256 and the resource, a person approves, it checks iss, exchanges, calls tools, refreshes on expiry, and stops at 403 insufficient_scope with the scopes to ask for', async () => {
    const t = await newTenant('sdk')
    telemetry(h, t.tenant)
    const dana = await personKey(t.admin)
    const provider = new Provider()

    // 1. no token yet: discovery, registration, the authorization URL
    expect(await auth(provider, { serverUrl: SERVER, fetchFn: route })).toBe('REDIRECT')
    const url = provider.authUrl!
    expect(`${url.origin}${url.pathname}`).toBe(`${ORIGIN}/oauth/authorize`)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('resource')).toBe(SERVER)
    expect(url.searchParams.get('scope')).toBe(START)
    expect(provider.info.client_id).toMatch(/^vzk1\./)

    // 2. the person reads the page and approves with their key
    const page = await (await route(url)).text()
    expect(page).toContain('SDK v2 client')
    const ap = await controlCall(dana, 'POST', '/oauth/approve', { request: /^request: (\S+)$/m.exec(page)![1] })
    expect(ap.status).toBe(201)
    const cb = new URL(ap.body.redirect)
    expect(cb.searchParams.get('state')).toBe(provider.st)

    // 3. the callback: issuer checked (RFC 9207), code exchanged
    expect(await auth(provider, { serverUrl: SERVER, fetchFn: route, authorizationCode: cb.searchParams.get('code')!, iss: cb.searchParams.get('iss')! })).toBe('AUTHORIZED')
    expect(provider.saved).toMatchObject({ token_type: 'Bearer', scope: START })
    const firstRefresh = provider.saved.refresh_token
    // a mixed-up issuer is refused by the client before the code is spent
    const p2 = new Provider()
    await auth(p2, { serverUrl: SERVER, fetchFn: route })
    await expect(auth(p2, { serverUrl: SERVER, fetchFn: route, authorizationCode: 'vzc1.x.' + 'a'.repeat(43), iss: 'https://evil.example' })).rejects.toThrow()

    // 4. connected: the tools the grant's scopes allow, and the tenant's own data
    const client = new Client({ name: 'sdk-oauth', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(SERVER), { authProvider: provider, fetch: route, onInsufficientScope: 'throw' }))
    const tools = (await client.listTools()).tools.map((x) => x.name)
    expect(tools).toContain('search_telemetry')
    expect(tools).toContain('list_monitors')
    expect(tools).not.toContain('write_dashboard')
    const r = (await client.callTool({ name: 'search_telemetry', arguments: { q: 'http requests' } })) as any
    expect(r.isError).toBe(false)
    expect(r.content[0].text).toContain('http_server_requests_total')

    // 5. the access token expires: the client gets 401, refreshes (rotation), and the call succeeds
    await runInDurableObject(stubOf(t.tenant), (_i, s) => void s.storage.sql.exec("UPDATE oauth_tokens SET expires_at = ? WHERE tenant = ? AND kind = 'access'", Date.now() - 1, t.tenant))
    const again = (await client.callTool({ name: 'describe_metric', arguments: { name: 'http_server_requests_total' } })) as any
    expect(again.isError).toBe(false)
    expect(provider.saved.refresh_token).not.toBe(firstRefresh)

    // 6. a tool the grant lacks: 403 insufficient_scope, which the SDK parses into the scopes to ask for
    const err = await client.callTool({ name: 'write_dashboard', arguments: { id: 'x', ops: [] } }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(InsufficientScopeError)
    expect((err as InsufficientScopeError).requiredScope).toBe('dashboards:write read')
    expect((err as InsufficientScopeError).resourceMetadataUrl?.href).toBe(PRM)
    await client.close()
  })
})

describe('scopes, audience and tenancy at the resource', () => {
  it('a grant\'s tools are exactly those of an agent key with the same scopes; a missing scope is refused by the same check (403 for OAuth, with the challenge)', async () => {
    const t = await newTenant('same')
    telemetry(h, t.tenant)
    const dana = await personKey(t.admin)
    for (const scopes of [['read'], ['dashboards:read'], ['read', 'dashboards:read', 'monitors:read'], ['read', 'dashboards:read', 'dashboards:write']]) {
      const c = await connect(dana, scopes.join(' '))
      const key = await makeKey(t.admin, scopes, { kind: 'agent' })
      expect(await listTools(c.access), scopes.join(' ')).toEqual(await listTools(key.key))
    }
    const c = await connect(dana, 'dashboards:read')
    const r = await callTool(c.access, 'query', { expr: 'up' })
    expect(r.status).toBe(403)
    expect(r.headers.get('WWW-Authenticate')).toBe(`Bearer error="insufficient_scope", scope="read", resource_metadata="${PRM}", error_description="query needs read"`)
    expect(r.body.error.data).toMatchObject({ code: 'insufficient-scope', scopes: ['read'] })
    // the same call with a key of the same scopes: over MCP the tool is not offered to it (a JSON-RPC
    // error), and the dispatcher's own check refuses it (403 missing-scope on the JSON surface)
    const key = await makeKey(t.admin, ['dashboards:read'], { kind: 'agent' })
    const k = await callTool(key.key, 'query', { expr: 'up' })
    expect(k.status).toBe(200)
    expect(k.body.error ?? k.body.result?.isError).toBeTruthy()
    const viaRest = await rest(h, key.key, 'query', { expr: 'up' })
    expect([viaRest.status, viaRest.structured.error.code]).toEqual([403, 'missing-scope'])
  })

  it('downstream calls carry the grant\'s key, never the client\'s token; what they reach is the token\'s tenant', async () => {
    const a = await newTenant('down-a')
    telemetry(h, a.tenant)
    const c = await connect(await personKey(a.admin), 'read dashboards:read monitors:read')
    downstream.length = 0
    h.prom.calls.length = 0
    h.ruler.calls.length = 0
    expect((await callTool(c.access, 'search_telemetry', { q: 'http' })).body.result.isError).toBe(false)
    expect((await callTool(c.access, 'search_dashboards', {})).body.result.isError).toBe(false)
    expect((await callTool(c.access, 'list_monitors', {})).body.result.isError).toBe(false)
    expect(downstream.length).toBeGreaterThan(3)
    for (const a of downstream) {
      expect(a).toMatch(/^Bearer viz_[A-Za-z0-9]{16}_[A-Za-z0-9]{40}$/)
      expect(a).not.toContain(c.access.split('.')[2])
    }
    expect(new Set([...h.prom.calls, ...h.ruler.calls].map((x) => x.tenant))).toEqual(new Set([a.tenant]))
    // the whoami the control plane answers for that key is the grant's identity
    const who = await controlCall(downstream.find((x) => x)!.slice(7), 'GET', '/whoami')
    expect(who.body).toMatchObject({ tenant: a.tenant, kind: 'agent', name: `oauth:${c.grant}` })
  })

  it('a token for tenant A never reaches tenant B: edited to name B it is unknown, and B\'s tools never see A\'s telemetry', async () => {
    const a = await newTenant('iso-a')
    const b = await newTenant('iso-b')
    telemetry(h, a.tenant)
    const ca = await connect(await personKey(a.admin))
    const swapped = ca.access.replace(`.${a.tenant}.`, `.${b.tenant}.`)
    const r = await callTool(swapped, 'search_telemetry', { q: 'http' })
    expect(r.status).toBe(401)
    h.prom.calls.length = 0
    expect((await callTool(ca.access, 'search_telemetry', { q: 'http' })).status).toBe(200)
    expect(h.prom.calls.every((x) => x.tenant === a.tenant)).toBe(true)
    // A tenant header or argument changes nothing, as for keys
    expect((await callTool(ca.access, 'search_telemetry', { q: 'http', tenant: b.tenant })).body.result.structuredContent.error.code).toBe('invalid-arguments')
    const hdr = await callTool(ca.access, 'search_telemetry', { q: 'http' }, { 'X-Viz-Tenant': b.tenant })
    expect(hdr.status).toBe(200)
    expect(h.prom.calls.every((x) => x.tenant === a.tenant)).toBe(true)
  })

  it('the audience is this resource: a token is refused at a resource configured elsewhere, at the JSON agent API, at the control API and at the query service', async () => {
    const t = await newTenant('aud')
    const c = await connect(await personKey(t.admin))
    const elsewhere = harness({ env: { PUBLIC_URL: 'https://other.example' } })
    const r = await list(c.access, elsewhere)
    expect(r.status).toBe(401)
    expect(r.body.error.message).toContain('issued for another resource')
    const viaRest = await rest(h, c.access, 'search_telemetry', { q: 'x' })
    expect(viaRest.status).toBe(401)
    expect(viaRest.structured.code).toBe('wrong-audience')
    expect((await controlCall(c.access, 'GET', '/whoami')).status).toBe(401)
    const q = await h.prom.fetcher.fetch(new Request('https://query.internal/api/v1/labels', { headers: { Authorization: `Bearer ${c.access}` } }))
    expect(q.status).toBe(401)
    // a refresh token or a code is not a bearer credential either
    expect((await list(c.refresh)).status).toBe(401)
  })

  it('expired and revoked tokens stop at the next request: expiry, a person\'s revocation, the client\'s RFC 7009 revocation', async () => {
    const t = await newTenant('stop')
    const dana = await personKey(t.admin)
    const e = await connect(dana)
    expect((await list(e.access)).status).toBe(200)
    await runInDurableObject(stubOf(t.tenant), (_i, s) => void s.storage.sql.exec("UPDATE oauth_tokens SET expires_at = ? WHERE tenant = ? AND kind = 'access'", Date.now() - 1, t.tenant))
    const ex = await list(e.access)
    expect(ex.status).toBe(401)
    expect(ex.headers.get('WWW-Authenticate')).toContain('error_description="The access token has expired."')

    const p = await connect(dana)
    expect((await list(p.access)).status).toBe(200)
    expect((await controlCall(dana, 'POST', `/oauth/grants/${p.grant}/revoke`, {})).status).toBe(200)
    expect((await list(p.access)).status).toBe(401)

    const r = await connect(dana)
    await route(`${ORIGIN}/oauth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: r.access, client_id: r.clientId }) })
    expect((await list(r.access)).status).toBe(401)

    // without the OAUTH binding OAuth tokens cannot be checked: 503, never accepted
    const unbound = harness({ env: { OAUTH: undefined } })
    const s = await connect(dana)
    expect((await list(s.access, unbound)).status).toBe(503)
    // nor with a binding whose props name a caller control does not accept (a misdeployment): 503
    const misbound = harness({ env: { OAUTH: env.OAUTH_AS_RULER } })
    expect((await list(s.access, misbound)).status).toBe(503)
    expect((await list(s.access, misbound)).body.error.data.code).toBe('oauth-unavailable')
  })
})

describe('no token, code or secret in a log line or an error body', () => {
  let logged: string[] = []
  beforeEach(() => {
    logged = []
    for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')))
  })
  afterEach(() => vi.restoreAllMocks())

  it('through failures at every step', async () => {
    const t = await newTenant('quiet')
    telemetry(h, t.tenant)
    const c = await connect(await personKey(t.admin), 'dashboards:read')
    const bodies: string[] = []
    const keep = async (r: Promise<{ status: number; body: any; headers: Headers }>) => {
      const x = await r
      bodies.push(JSON.stringify(x.body) + (x.headers.get('WWW-Authenticate') ?? ''))
    }
    await keep(callTool(c.access, 'query', { expr: 'up' })) // 403 insufficient_scope
    await keep(rpc(h, c.access.slice(0, -1) + 'Z', { jsonrpc: '2.0', id: 1, method: 'tools/list' })) // unknown
    await keep(list(c.refresh)) // not an access token
    await keep(list(c.access, harness({ env: { OAUTH: undefined } }))) // 503
    const viaRest = await rest(h, c.access, 'search_dashboards', {})
    bodies.push(JSON.stringify(viaRest.structured))
    await controlCall(c.access, 'GET', '/whoami')
    const who = await stubOf(t.tenant).introspectAccessToken(t.tenant, c.access, SERVER)
    const grantSecret = who.status === 'active' ? who.credential.split('_')[2]! : 'unreachable'
    expect(grantSecret).not.toBe('unreachable')
    // a log line from the object itself reaches the spy
    await runInDurableObject(stubOf(t.tenant), () => console.error('probe'))
    expect(logged).toContain('probe')
    for (const s of [c.access, c.access.split('.')[2]!, c.refresh.split('.')[2]!, grantSecret]) {
      expect(logged.some((l) => l.includes(s)), 'log').toBe(false)
      expect(bodies.some((b) => b.includes(s)), 'error body').toBe(false)
    }
    expect(bodies.length).toBe(5)
    void NOW
  })
})

describe('review of D44 (design/reviews/d44-d52-d53-d60.md): what the agent surface holds and checks', () => {
  it('M-1: it checks tokens through OAUTH only; it is given no Tenant namespace, and a binding naming another caller gets no answer', async () => {
    const t = await newTenant('m1')
    telemetry(h, t.tenant)
    const c = await connect(await personKey(t.admin))
    // h's env has no TENANT (helpers.ts strips it), as production binds none.
    expect((await list(c.access)).status).toBe(200)
    expect(await env.OAUTH_AS_RULER.introspectAccessToken(c.access, SERVER)).toEqual({ v: 1, status: 'unauthorized' })
    // The entrypoint takes the tenant from the token: one edited to name another tenant matches nothing.
    const other = await newTenant('m1b')
    expect((await list(c.access.replace(`.${t.tenant}.`, `.${other.tenant}.`))).status).toBe(401)
  })

  it('m-6: scopes include each other as control\'s do: dashboards:apply covers write and read, write covers read', async () => {
    const id = (scopes: string[]) => ({ tenant: 't', keyId: 'k', subject: 'key:k', kind: 'agent' as const, name: null, scopes, mayApply: null, source: 'oauth' as const })
    expect(hasScopes(id(['dashboards:apply']), ['dashboards:write'])).toBe(true)
    expect(hasScopes(id(['dashboards:apply']), ['dashboards:read'])).toBe(true)
    expect(hasScopes(id(['dashboards:write']), ['dashboards:read'])).toBe(true)
    expect(hasScopes(id(['dashboards:write']), ['dashboards:apply'])).toBe(false)
    expect(hasScopes(id(['dashboards:read']), ['dashboards:write'])).toBe(false)
    expect(hasScopes(id(['dashboards:apply']), ['dashboards:write', 'read'])).toBe(false)
    expect(hasScopes(id(['admin']), ['dashboards:read'])).toBe(false)
    // A token holding dashboards:apply (and read) is not stepped up for dashboards:write or dashboards:read.
    const t = await newTenant('m6')
    telemetry(h, t.tenant)
    const c = await connect(await personKey(t.admin), 'read dashboards:apply')
    const tools = await listTools(c.access)
    expect(tools).toEqual(expect.arrayContaining(['write_dashboard', 'search_dashboards', 'get_dashboard']))
    for (const [name, args] of [['search_dashboards', {}], ['annotate', { text: 'x', at: NOW }]] as const) {
      const r = await callTool(c.access, name, args)
      expect(r.status, name).toBe(200)
      expect(r.headers.get('WWW-Authenticate'), name).toBeNull()
    }
  })

  it('m-2: the step-up check reads a copy of the body with a cap; a body without Content-Length is not buffered past it', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (sent >= 64) return ctl.close()
        sent++
        ctl.enqueue(chunk)
      },
    })
    expect(await readCapped({ body }, STEP_UP_MAX_BYTES)).toBeNull()
    expect(sent).toBeLessThanOrEqual(STEP_UP_MAX_BYTES / chunk.length + 2)
    const small = new Request('https://x.example/', { method: 'POST', body: '{"a":1}' })
    expect(new TextDecoder().decode((await readCapped(small, STEP_UP_MAX_BYTES))!)).toBe('{"a":1}')

    // Through the Worker: a tool call past the cap is not looked into by the step-up check, sent
    // chunked or with its length, alike (no 403 insufficient_scope from it); under the cap it is.
    const t = await newTenant('m2s')
    telemetry(h, t.tenant)
    const c = await connect(await personKey(t.admin), 'dashboards:read')
    const call = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'query', arguments: { expr: 'up' } } })
    const padded = call + ' '.repeat(STEP_UP_MAX_BYTES + 10)
    const headers = { Authorization: `Bearer ${c.access}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...L }
    const status = async (body: BodyInit, extra: Record<string, string> = {}) => (await h.fetch(new Request(`${BASE}/mcp`, { method: 'POST', headers: { ...headers, ...extra }, body, duplex: 'half' } as RequestInit))).status
    expect(await status(call)).toBe(403)
    const withLength = await status(padded, { 'Content-Length': String(new TextEncoder().encode(padded).length) })
    const bytes = new TextEncoder().encode(padded)
    const chunked = new ReadableStream<Uint8Array>({
      start(ctl) {
        for (let i = 0; i < bytes.length; i += 64 * 1024) ctl.enqueue(bytes.subarray(i, i + 64 * 1024))
        ctl.close()
      },
    })
    expect(withLength).not.toBe(403)
    expect(await status(chunked)).toBe(withLength)
  })
})

describe('D70: control refuses an introspection over its rate limit', () => {
  /** Miniflare's limiter counts in windows aligned to the wall clock: start the counted calls well inside one, so no reset falls between them. */
  const freshWindow = async (periodMs = 60_000, needMs = 10_000): Promise<void> => {
    const left = periodMs - (Date.now() % periodMs)
    if (left < needMs) await new Promise((r) => setTimeout(r, left + 100))
  }
  /** The agent surface with OAUTH bound to control's real entrypoint whose OAUTH_RL_BEARER allows 2 a minute per token (wrangler.test.jsonc, test/worker.ts). */
  const limited = (): Harness => harness({ env: { OAUTH: env.OAUTH_LIMITED } })
  const RL_MESSAGE = 'Too many requests with this access token, or with its tenant\'s access tokens; nothing was done. Retry in 60 s.'

  it('the third request with one token in a minute is 429 with Retry-After, not 401; nothing is spent, another token keeps its budget, and both official SDK clients report the 429 and keep their tokens', async () => {
    const t = await newTenant('rl')
    const dana = await personKey(t.admin)
    const c = await connect(dana)
    const other = await connect(dana)
    const on = limited()
    await freshWindow()
    expect((await list(c.access, on)).status).toBe(200)
    expect((await list(c.access, on)).status).toBe(200)
    const r = await list(c.access, on)
    expect(r.status).toBe(429)
    expect(r.headers.get('Retry-After')).toBe('60')
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    // Not a 401: no challenge, so a client neither discards its token nor starts a new authorization.
    expect(r.headers.get('WWW-Authenticate')).toBeNull()
    expect(r.body).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32001, message: RL_MESSAGE, data: { code: 'rate-limited', status: 429 } } })
    // Another token of the same person and tenant is counted on its own.
    expect((await list(other.access, on)).status).toBe(200)
    // Nothing was spent or revoked: the same token works where no limiter is bound.
    expect((await list(c.access)).status).toBe(200)

    // Implementations viz did not write. SDK v2 (2.4.0): an HTTP error carrying 429 and the body's text; no refresh, no authorization.
    const provider = new Provider()
    provider.saved = { access_token: c.access, token_type: 'Bearer', refresh_token: c.refresh }
    const v2 = new Client({ name: 'sdk-rl', version: '1' })
    const e2 = await v2.connect(new StreamableHTTPClientTransport(new URL(SERVER), { authProvider: provider, fetch: (u, i) => on.fetch(new Request(u, i)) })).then(() => null, (e: unknown) => e)
    expect(e2).toBeInstanceOf(SdkHttpError)
    expect((e2 as SdkHttpError).status).toBe(429)
    expect((e2 as Error).message).toContain('Retry in 60 s.')
    expect(provider.authUrl).toBeNull()
    expect(provider.saved).toEqual({ access_token: c.access, token_type: 'Bearer', refresh_token: c.refresh })
    await v2.close().catch(() => {})
    // SDK v1 (1.32.2): StreamableHTTPError with code 429 and the body's text.
    const v1 = new V1Client({ name: 'v1-rl', version: '1' })
    const withToken = (u: any, i: any) => {
      const q = new Request(u, i)
      const hd = new Headers(q.headers)
      hd.set('Authorization', `Bearer ${c.access}`)
      return on.fetch(new Request(q, { headers: hd }))
    }
    const e1 = await v1.connect(new V1Transport(new URL(SERVER), { fetch: withToken })).then(() => null, (e: unknown) => e)
    expect((e1 as { code?: unknown } | null)?.code).toBe(429)
    expect((e1 as Error).message).toContain('Retry in 60 s.')
    await v1.close().catch(() => {})
  })

  it('the JSON agent API refuses an OAuth token before introspection (401 wrong-audience): it never answers 429 for one, and does not spend the token\'s budget', async () => {
    const t = await newTenant('rl-json')
    const c = await connect(await personKey(t.admin))
    const on = limited()
    await freshWindow()
    for (let i = 0; i < 3; i++) {
      const j = await rest(on, c.access, 'search_telemetry', { q: 'x' })
      expect([j.status, j.structured.code], `JSON call ${i + 1}`).toEqual([401, 'wrong-audience'])
    }
    expect((await list(c.access, on)).status).toBe(200)
    expect((await list(c.access, on)).status).toBe(200)
    expect((await list(c.access, on)).status).toBe(429)
    const after = await rest(on, c.access, 'search_telemetry', { q: 'x' })
    expect([after.status, after.structured.code]).toEqual([401, 'wrong-audience'])
  })

  it('Retry-After is control\'s retryAfterMs in whole seconds, rounded up; an answer without a usable number gets 60', async () => {
    const token = `vza1.rl-fake.${'x'.repeat(43)}`
    for (const [ms, sec] of [[1500, 2], [60_000, 60], [1, 1]] as const) {
      const fake = { introspectAccessToken: async () => ({ v: 1, status: 'rate_limited', retryAfterMs: ms }) }
      const r = await list(token, harness({ env: { OAUTH: fake } }))
      expect([r.status, r.headers.get('Retry-After'), r.body.error.data.code], String(ms)).toEqual([429, String(sec), 'rate-limited'])
      expect(r.body.error.message).toContain(`Retry in ${sec} s.`)
    }
    expect([0, 999, 1000, 1001, 3_600_000, 1e12, -1, Number.NaN, Infinity, '5', undefined].map(retryAfterSeconds)).toEqual([0, 1, 1, 2, 3600, 3600, 60, 60, 60, 60, 60])
  })
})
