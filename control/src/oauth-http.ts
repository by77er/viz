import { CLIENT_ID, OAUTH_LIFETIMES, OAUTH_LIMITS, OAUTH_SCOPES, type OAuthScope, type TenantOAuthRpc, type TokenRequest, parseCredential } from '../../contracts/oauth'
import { type AuthzRequest, CODE_CHALLENGE, type OAuthEnv, callback, canonicalResource, credentialTagValid, displayName, encodeRequest, isLoopback, oauthConfig, parseScope, redirectProblem, sameResource, signRegistration, verifyClientId, type OAuthConfig } from './oauth'
import { type RateLimitEnv, type Refusal, limitRevoke, limitSource, limitToken } from './ratelimit'
import type { Tenant } from './tenant'
import { randomId } from './util'

/**
 * The OAuth 2.1 authorization server's public endpoints (contracts/oauth.ts, decision D44), for
 * MCP clients of the agent surface. Outside `/api/v1/control`; no API key. The gateway routes
 * these paths here.
 *
 *   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata
 *   POST /oauth/register                           RFC 7591; stores nothing (the client id is the signed registration)
 *   GET  /oauth/authorize                          validates the request and answers a plain-text page:
 *                                                  what is asked, and how a person approves it through the
 *                                                  control API. It never redirects by itself.
 *   POST /oauth/token                              authorization_code (PKCE S256) and refresh_token
 *   POST /oauth/revoke                             RFC 7009
 *
 * The tenant is the one the presented code or token names; that tenant's object holds only the
 * credential's hash, so a credential edited to name another tenant matches nothing. A credential
 * without this deployment's tag (contracts/oauth.ts `CREDENTIAL_TAG`) is refused here, before any
 * object is asked: a made-up one costs a tenant's object nothing (review of D44, M-2). Nothing here
 * logs a request parameter, and no error body repeats a credential.
 *
 * Rate limits (src/ratelimit.ts, D68): the four endpoints below the metadata count each request
 * against the client's network before the body is read; the token endpoint and revocation then
 * count a credential carrying the tag against its client and tenant before the tenant's object is
 * asked. A refusal is 429 `too_many_requests` with `Retry-After`, and nothing was read, changed or
 * spent. The metadata (static, cacheable) and CORS preflights are not counted.
 */

export interface OAuthHttpEnv extends OAuthEnv, RateLimitEnv {
  TENANT: DurableObjectNamespace<Tenant>
}

export const OAUTH_PATHS = new Set(['/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/authorize', '/oauth/token', '/oauth/revoke'])

/** The endpoints a client's network is counted at (D68). */
const LIMITED_PATHS = new Set(['/oauth/register', '/oauth/authorize', '/oauth/token', '/oauth/revoke'])

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
  'Access-Control-Max-Age': '600',
}
const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' }

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE, ...CORS, ...extra } })

const oauthError = (status: number, error: string, description: string, extra: Record<string, string> = {}): Response => json(status, { error, error_description: description }, extra)

/**
 * A rate-limit refusal (D68). RFC 6749 §5.2 has no code for it; `too_many_requests` is the one the
 * MCP TypeScript SDK's own authorization server sends with 429 at these four endpoints, and its
 * client maps it to `TooManyRequestsError`, keeping the client's credentials. An unknown code would
 * be read as a server error, after which that client drops the refresh and starts a new
 * authorization (a person approves again); `invalid_grant` would make it discard its tokens.
 */
const tooMany = (why: string, retryAfterS: number, outcome: string): Response =>
  oauthError(429, 'too_many_requests', `${why} ${outcome} Retry after ${retryAfterS} s.`, { 'Retry-After': String(retryAfterS) })

/** One credential's tenant object. The only place this file picks one: by the tenant the presented credential names. */
const tenantStub = (env: OAuthHttpEnv, tenant: string): TenantOAuthRpc => env.TENANT.get(env.TENANT.idFromName(tenant)) as unknown as TenantOAuthRpc

export function metadata(cfg: OAuthConfig): Record<string, unknown> {
  return {
    issuer: cfg.issuer,
    authorization_endpoint: `${cfg.issuer}/oauth/authorize`,
    token_endpoint: `${cfg.issuer}/oauth/token`,
    // Advertised only when this deployment can sign registrations.
    ...(cfg.clientKey ? { registration_endpoint: `${cfg.issuer}/oauth/register` } : {}),
    revocation_endpoint: `${cfg.issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...OAUTH_SCOPES],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  }
}

// ---- request bodies ----

const MAX_FORM_BYTES = 16 * 1024

/**
 * The body, or null when it is larger than `max` bytes. Read from the stream with a cap: a body
 * without Content-Length (chunked) is never buffered past `max` (review of D44, m-2).
 */
export async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get('Content-Length') ?? '0') > max) return null
  if (!req.body) return new Uint8Array()
  const reader = req.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    parts.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

const readBytes = readCapped

const mediaType = (req: Request): string => (req.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase()

/** An `application/x-www-form-urlencoded` body. A parameter sent twice is an error (OAuth 2.1 §3.1, §3.2). */
async function readForm(req: Request): Promise<Record<string, string> | Response> {
  if (mediaType(req) !== 'application/x-www-form-urlencoded') return oauthError(400, 'invalid_request', 'The body must be application/x-www-form-urlencoded.')
  const bytes = await readBytes(req, MAX_FORM_BYTES)
  if (!bytes) return oauthError(400, 'invalid_request', `The body may be at most ${MAX_FORM_BYTES} bytes.`)
  const params = new URLSearchParams(new TextDecoder().decode(bytes))
  const out: Record<string, string> = {}
  for (const [k, v] of params) {
    if (k in out) return oauthError(400, 'invalid_request', `The parameter ${k.slice(0, 40)} was sent more than once.`)
    out[k] = v
  }
  return out
}

// ---- registration (RFC 7591) ----

async function register(req: Request, cfg: OAuthConfig): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'invalid_request', error_description: 'Register with POST.' }, { Allow: 'POST, OPTIONS' })
  if (!cfg.clientKey) return oauthError(503, 'temporarily_unavailable', 'Client registration is not configured on this deployment.')
  if (mediaType(req) !== 'application/json') return oauthError(400, 'invalid_client_metadata', 'The body must be application/json.')
  const bytes = await readBytes(req, OAUTH_LIMITS.registrationBytes)
  if (!bytes) return oauthError(400, 'invalid_client_metadata', `The registration may be at most ${OAUTH_LIMITS.registrationBytes} bytes.`)
  let m: Record<string, unknown>
  try {
    const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error()
    m = v as Record<string, unknown>
  } catch {
    return oauthError(400, 'invalid_client_metadata', 'The body is not a JSON object.')
  }
  const uris = m.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > OAUTH_LIMITS.redirectUrisPerClient) {
    return oauthError(400, 'invalid_redirect_uri', `redirect_uris must list 1 to ${OAUTH_LIMITS.redirectUrisPerClient} URIs.`)
  }
  for (const [i, u] of uris.entries()) {
    const why = typeof u === 'string' ? redirectProblem(u) : 'must be a string'
    if (why) return oauthError(400, 'invalid_redirect_uri', `redirect_uris[${i}] ${why}.`)
  }
  if (m.token_endpoint_auth_method !== undefined && m.token_endpoint_auth_method !== 'none') {
    return oauthError(400, 'invalid_client_metadata', 'Only public clients are registered here: token_endpoint_auth_method must be "none". Protect the code with PKCE (S256).')
  }
  const grants = m.grant_types
  if (grants !== undefined && (!Array.isArray(grants) || !grants.includes('authorization_code') || !grants.every((g) => g === 'authorization_code' || g === 'refresh_token'))) {
    return oauthError(400, 'invalid_client_metadata', 'grant_types must include authorization_code and may add refresh_token; nothing else is offered.')
  }
  if (m.response_types !== undefined && (!Array.isArray(m.response_types) || !m.response_types.every((r) => r === 'code'))) {
    return oauthError(400, 'invalid_client_metadata', 'response_types may only be ["code"].')
  }
  if (m.client_name !== undefined && (typeof m.client_name !== 'string' || m.client_name.length > 400)) return oauthError(400, 'invalid_client_metadata', 'client_name must be a string of at most 400 characters.')
  if (m.scope !== undefined && (typeof m.scope !== 'string' || 'unknown' in parseScope(m.scope))) return oauthError(400, 'invalid_client_metadata', `scope may use only: ${OAUTH_SCOPES.join(' ')}.`)
  const appType = m.application_type === 'native' || m.application_type === 'web' ? m.application_type : undefined
  const name = displayName(typeof m.client_name === 'string' ? m.client_name : '')
  const iat = Math.floor(Date.now() / 1000)
  const clientId = await signRegistration(cfg.clientKey, { v: 1, n: randomId(16), iat, name, uris: uris as string[] })
  if (!CLIENT_ID.test(clientId)) return oauthError(400, 'invalid_client_metadata', 'The registration is too large: shorten the redirect URIs or the name.')
  return json(201, {
    client_id: clientId,
    client_id_issued_at: iat,
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(appType ? { application_type: appType } : {}),
    ...(typeof m.scope === 'string' ? { scope: m.scope } : {}),
  })
}

// ---- the authorization request and the consent page ----

const SCOPE_TEXT: Record<OAuthScope, string> = {
  read: 'query and search your telemetry (metrics)',
  'dashboards:read': 'read dashboards and their history',
  'dashboards:write': 'propose dashboard changes and new dashboards, for a person to apply',
  'dashboards:apply': 'change dashboards directly, only if the tenant lets agents apply',
  'monitors:read': 'read monitors and their alerts',
}

const PAGE_HEADERS = {
  'Content-Type': 'text/plain; charset=utf-8',
  ...NO_STORE,
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
}

const page = (status: number, text: string): Response => new Response(text, { status, headers: PAGE_HEADERS })

/** A request that cannot be returned to the application (unknown client, unregistered redirect): said here, never redirected (OAuth 2.1 §4.1.2.1). */
const cannotReturn = (why: string): Response =>
  page(400, `viz: this authorization request cannot be completed.\n\n${why}\n\nNothing was stored. Go back to the application and connect again.\n`)

/** The authorization page refused by the source limit (D68): a page for the person, as every answer here is. */
const pageTooMany = (r: Refusal): Response =>
  new Response(`viz: too many requests.\n\ntoo_many_requests: ${r.why}\n\nNothing was stored. Reload this page after ${r.retryAfterS} seconds.\n`, { status: 429, headers: { ...PAGE_HEADERS, 'Retry-After': String(r.retryAfterS) } })

/**
 * An error the application should hear about. OAuth would redirect it to the callback; this
 * server does not redirect by itself (every registered callback is the application's own claim),
 * so it shows the error and the link that would deliver it.
 */
function toClient(redirectUri: string, state: string | null, issuer: string, error: string, description: string): Response {
  const link = callback(redirectUri, { error, error_description: description, state, iss: issuer })
  return page(400, `viz: the application asked for something this server does not grant.\n\n${error}: ${description}\n\nNothing was stored. To tell the application, open:\n\n  ${link}\n\nor close this page.\n`)
}

async function authorize(req: Request, cfg: OAuthConfig): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return page(405, 'viz: open this address in a browser (GET).\n')
  const q = new URL(req.url).searchParams
  const one = (name: string): string | null | undefined => {
    const all = q.getAll(name)
    return all.length > 1 ? undefined : (all[0] ?? null)
  }
  const clientId = one('client_id')
  const redirectUri = one('redirect_uri')
  if (clientId === undefined || redirectUri === undefined) return cannotReturn('client_id or redirect_uri was sent more than once.')
  const reg = clientId === null ? null : await verifyClientId(cfg.clientKey, clientId)
  if (!reg) return cannotReturn('The application is not registered with this server, or its registration is damaged or from another deployment.')
  // Exact match with a registered URI (OAuth 2.1 §4.1.1; MCP "Open Redirection").
  if (redirectUri === null || !reg.uris.includes(redirectUri)) return cannotReturn('redirect_uri is missing or is not exactly one the application registered.')

  const state = one('state')
  if (state === undefined) return cannotReturn('state was sent more than once.')
  const back = (error: string, description: string) => toClient(redirectUri, state, cfg.issuer, error, description)
  if (state !== null && state.length > OAUTH_LIMITS.stateLength) return back('invalid_request', `state may be at most ${OAUTH_LIMITS.stateLength} characters.`)
  for (const p of ['response_type', 'code_challenge', 'code_challenge_method', 'scope']) if (q.getAll(p).length > 1) return back('invalid_request', `${p} was sent more than once.`)
  if (q.get('response_type') !== 'code') return back('unsupported_response_type', 'response_type must be code.')
  const challenge = q.get('code_challenge')
  if (challenge === null || !CODE_CHALLENGE.test(challenge)) return back('invalid_request', 'code_challenge is required: the base64url SHA-256 of a code_verifier (PKCE).')
  if (q.get('code_challenge_method') !== 'S256') return back('invalid_request', 'code_challenge_method must be S256; plain is not accepted.')
  const scope = parseScope(q.get('scope'))
  if ('unknown' in scope) return back('invalid_scope', `Unknown scope(s): ${scope.unknown.join(' ')}. Offered: ${OAUTH_SCOPES.join(' ')}.`)
  const resources = q.getAll('resource')
  if (resources.length > 1) return back('invalid_target', 'One resource only.')
  if (resources.length === 1 && (canonicalResource(resources[0]!) === null || !sameResource(resources[0]!, cfg.resource))) {
    return back('invalid_target', `This server issues tokens only for ${cfg.resource}.`)
  }

  const request: AuthzRequest = { v: 1, client_id: clientId!, redirect_uri: redirectUri, scope: scope.ok, code_challenge: challenge, state, resource: cfg.resource }
  const handle = encodeRequest(request)
  const host = new URL(redirectUri).host
  const pad = Math.max(...scope.ok.map((s) => s.length))
  const lines = [
    'viz: an application asks to act on your tenant',
    '',
    `Application:  ${displayName(reg.name)}`,
    '              (the application\'s own description of itself; viz has not verified it)',
    `Returns to:   ${host}`,
    `              ${redirectUri}`,
    ...(isLoopback(redirectUri) ? ['              WARNING: a program on the computer that opens the approval link. Any program listening', '              there can receive the code.'] : []),
    // Anyone can make this link and send it to a person (review of D44, m-5): said for every redirect.
    '              Approve only a connection you started yourself, in the application you mean to connect:',
    '              anyone can make a link to this page and send it to you.',
    'Asks for:',
    ...scope.ok.map((s) => `              ${s.padEnd(pad)}  ${SCOPE_TEXT[s]}`),
    `Resource:     ${cfg.resource}`,
    `If approved:  access tokens last ${OAUTH_LIFETIMES.accessSeconds / 60} minutes and are renewed for at most ${OAUTH_LIFETIMES.grantDays} days; revocable at any time.`,
    '              It never gets a scope the approving key does not hold.',
    '',
    'There is no sign-in page yet. To approve, a person with an admin key of the tenant (a key of kind "key",',
    'holding the scopes to grant) sends:',
    '',
    `  curl -sS -X POST '${cfg.issuer}/api/v1/control/oauth/approve' \\`,
    '    -H "Authorization: Bearer $VIZ_ADMIN_KEY" -H \'Content-Type: application/json\' \\',
    `    -d '{"request":"${handle}"}'`,
    '',
    '  With "dryRun": true it shows exactly what would be granted and changes nothing.',
    '  With "scopes": [...] it grants fewer than asked.',
    '',
    `The answer's "redirect" is a link for this browser: open it within ${OAUTH_LIFETIMES.codeSeconds / 60} minutes to hand the application its code.`,
    'To refuse, close this page: nothing has been stored.',
    '',
    `request: ${handle}`,
    '',
  ]
  return page(200, req.method === 'HEAD' ? '' : lines.join('\n'))
}

// ---- token and revocation ----

async function token(req: Request, env: OAuthHttpEnv): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'invalid_request', error_description: 'Use POST.' }, { Allow: 'POST, OPTIONS' })
  // Public clients only: a client that authenticates is one this server never registered.
  if (req.headers.has('Authorization')) return oauthError(401, 'invalid_client', 'This server issues no client secrets: send client_id in the body and no Authorization header.', { 'WWW-Authenticate': 'Basic realm="viz-oauth"' })
  const form = await readForm(req)
  if (form instanceof Response) return form
  if (form.client_secret !== undefined || form.client_assertion !== undefined) return oauthError(401, 'invalid_client', 'This server issues no client secrets.', { 'WWW-Authenticate': 'Basic realm="viz-oauth"' })
  if (form.client_id === undefined) return oauthError(400, 'invalid_request', 'client_id is required.')
  if (!CLIENT_ID.test(form.client_id)) return oauthError(401, 'invalid_client', 'client_id is not one this server issued.', { 'WWW-Authenticate': 'Basic realm="viz-oauth"' })
  const grantType = form.grant_type
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') return oauthError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token.')
  const presented = grantType === 'authorization_code' ? form.code : form.refresh_token
  if (presented === undefined) return oauthError(400, 'invalid_request', `${grantType === 'authorization_code' ? 'code' : 'refresh_token'} is required.`)
  const cred = parseCredential(presented)
  if (!cred || cred.kind !== (grantType === 'authorization_code' ? 'code' : 'refresh')) return oauthError(400, 'invalid_grant', 'The credential is unknown, expired or revoked.')
  // Not made by this deployment: the same answer, and no tenant's object is asked.
  if (!(await credentialTagValid(oauthConfig(env).clientKey, presented))) return oauthError(400, 'invalid_grant', 'The credential is unknown, expired or revoked.')
  // A credential this deployment made: counted against its client and its tenant before the object (D68).
  const limited = await limitToken(env, cred.tenant, form.client_id)
  if (limited) return tooMany(limited.why, limited.retryAfterS, 'Nothing was issued, and the credential you sent was not used.')
  const request: TokenRequest = { grant_type: grantType, client_id: form.client_id }
  for (const k of ['code', 'redirect_uri', 'code_verifier', 'refresh_token', 'resource', 'scope'] as const) if (form[k] !== undefined) request[k] = form[k]
  const r = await tenantStub(env, cred.tenant).oauthToken(cred.tenant, request)
  if (r.status === 'ok') return json(200, r.tokens)
  if (r.status === 'error') return oauthError(r.error === 'invalid_client' ? 401 : 400, r.error, r.description)
  if (r.status === 'not_provisioned') return oauthError(400, 'invalid_grant', 'The credential is unknown, expired or revoked.')
  if (r.status === 'rate_limited') {
    // The exact limit in the tenant's object (D68): this grant's refreshes in the last minute.
    const why = `This grant was given ${OAUTH_LIMITS.refreshesPerGrantPerMinute} refresh tokens in the last minute, the most it may have.`
    return tooMany(why, Math.max(1, Math.ceil(r.retryAfterMs / 1000)), 'Nothing was issued, and the refresh token you sent was not used.')
  }
  if (r.status === 'schema_too_new') return oauthError(503, 'temporarily_unavailable', 'A deployment is in progress; nothing was changed. Retry.', { 'Retry-After': String(Math.ceil(r.retryAfterMs / 1000)) })
  return oauthError(503, 'temporarily_unavailable', 'Retry.')
}

async function revoke(req: Request, env: OAuthHttpEnv): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'invalid_request', error_description: 'Use POST.' }, { Allow: 'POST, OPTIONS' })
  const form = await readForm(req)
  if (form instanceof Response) return form
  if (form.token === undefined) return oauthError(400, 'invalid_request', 'token is required.')
  if (form.client_id === undefined) return oauthError(400, 'invalid_request', 'client_id is required.')
  const cred = parseCredential(form.token)
  // RFC 7009 §2.2: an invalid token is not an error. One this deployment did not make reaches no object.
  if (!cred || cred.kind === 'code' || !(await credentialTagValid(oauthConfig(env).clientKey, form.token))) return json(200, null)
  // A token this deployment made: counted against its tenant before the object (D68). Refused, it
  // stays as it was (RFC 7009 §2.2.1 says the same of a 503); a person can also revoke the grant.
  const limited = await limitRevoke(env, cred.tenant)
  if (limited) return tooMany(limited.why, limited.retryAfterS, 'Nothing was revoked.')
  const r = await tenantStub(env, cred.tenant).oauthRevoke(cred.tenant, form.token, form.client_id)
  if (r.status === 'schema_too_new') return oauthError(503, 'temporarily_unavailable', 'A deployment is in progress; retry.', { 'Retry-After': String(Math.ceil(r.retryAfterMs / 1000)) })
  return json(200, null)
}

export async function serveOAuth(req: Request, env: OAuthHttpEnv): Promise<Response> {
  const path = new URL(req.url).pathname
  const cfg = oauthConfig(env)
  try {
    if (req.method === 'OPTIONS' && path !== '/oauth/authorize') return new Response(null, { status: 204, headers: CORS })
    if (path === '/.well-known/oauth-authorization-server') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'invalid_request' }, { Allow: 'GET, HEAD, OPTIONS' })
      return new Response(req.method === 'HEAD' ? null : JSON.stringify(metadata(cfg)), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...CORS } })
    }
    // Every limited endpoint, first thing: the client's network (D68). Before the body is read.
    if (LIMITED_PATHS.has(path)) {
      const limited = await limitSource(env, req)
      if (limited) return path === '/oauth/authorize' ? pageTooMany(limited) : tooMany(limited.why, limited.retryAfterS, 'Nothing was read or changed.')
    }
    if (path === '/oauth/register') return await register(req, cfg)
    if (path === '/oauth/authorize') return await authorize(req, cfg)
    if (path === '/oauth/token') return await token(req, env)
    if (path === '/oauth/revoke') return await revoke(req, env)
    return oauthError(404, 'invalid_request', 'No such OAuth endpoint.')
  } catch (e) {
    // Never the message: it could carry a parameter of this request.
    console.error('control: oauth endpoint failed', path, e instanceof Error ? e.name : 'error')
    return oauthError(500, 'server_error', 'Something went wrong on our side. Nothing was issued.')
  }
}
