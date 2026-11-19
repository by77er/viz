/**
 * An OAuth client for the tests, speaking to control's public endpoints the way an MCP client
 * does (register, authorize, token, revoke), plus the person's approval through the control API.
 * Everything goes through the real Worker and the real Tenant object.
 */
import worker from '../src/index'
import { env, post } from './helpers'

export const ORIGIN = 'https://vis.bitcru.sh'
export const RESOURCE = `${ORIGIN}/mcp`
export const REDIRECT = 'http://127.0.0.1:33418/callback'

export interface Res {
  status: number
  headers: Headers
  text: string
  body: any
}

export async function oauthFetch(path: string, init: RequestInit = {}): Promise<Res> {
  const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, init) as never, env as never, {} as ExecutionContext)
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, headers: res.headers, text, body }
}

export const form = (path: string, params: Record<string, string>, headers: Record<string, string> = {}): Promise<Res> =>
  oauthFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(params).toString() })

export async function register(meta: Record<string, unknown> = {}): Promise<Res> {
  return oauthFetch('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Test agent', redirect_uris: [REDIRECT], ...meta }) })
}

export async function newClient(meta: Record<string, unknown> = {}): Promise<string> {
  const r = await register(meta)
  if (r.status !== 201) throw new Error(`register: ${r.status} ${r.text}`)
  return r.body.client_id as string
}

const b64url = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  return { verifier, challenge }
}

export interface AuthorizeOpts {
  redirect?: string
  scope?: string | null
  state?: string | null
  resource?: string | null
  challenge?: string
  method?: string | null
  extra?: Record<string, string>
}

export function authorizeUrl(clientId: string, challenge: string, o: AuthorizeOpts = {}): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: o.redirect ?? REDIRECT, code_challenge: o.challenge ?? challenge })
  if (o.method !== null) q.set('code_challenge_method', o.method ?? 'S256')
  if (o.scope !== null && o.scope !== undefined) q.set('scope', o.scope)
  if (o.state !== null) q.set('state', o.state ?? 'st-123')
  if (o.resource !== null) q.set('resource', o.resource ?? RESOURCE)
  for (const [k, v] of Object.entries(o.extra ?? {})) q.append(k, v)
  return `/oauth/authorize?${q}`
}

/** The page and the handle a person would copy from it. */
export async function authorize(clientId: string, challenge: string, o: AuthorizeOpts = {}): Promise<{ res: Res; handle: string | null }> {
  const res = await oauthFetch(authorizeUrl(clientId, challenge, o))
  const m = /^request: (\S+)$/m.exec(res.text)
  return { res, handle: m ? m[1]! : null }
}

export const approve = (key: string, handle: string, extra: Record<string, unknown> = {}) => post(key, '/oauth/approve', { request: handle, ...extra })

export function codeOf(redirect: string): { code: string; state: string | null; iss: string | null } {
  const u = new URL(redirect)
  return { code: u.searchParams.get('code')!, state: u.searchParams.get('state'), iss: u.searchParams.get('iss') }
}

export const exchange = (clientId: string, code: string, verifier: string, extra: Record<string, string> = {}): Promise<Res> =>
  form('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT, resource: RESOURCE, ...extra })

export const refresh = (clientId: string, token: string, extra: Record<string, string> = {}): Promise<Res> =>
  form('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: token, ...extra })

export const revokeAtServer = (clientId: string, token: string): Promise<Res> => form('/oauth/revoke', { token, client_id: clientId })

export interface Connected {
  clientId: string
  verifier: string
  grant: any
  approval: any
  code: string
  access: string
  refresh: string
  scope: string
}

/** The whole flow, as a client and a person would do it. */
export async function connect(approver: string, o: { scope?: string; grantScopes?: string[]; client?: string } = {}): Promise<Connected> {
  const clientId = o.client ?? (await newClient())
  const { verifier, challenge } = await pkce()
  const { res, handle } = await authorize(clientId, challenge, { scope: o.scope ?? 'read dashboards:read monitors:read' })
  if (res.status !== 200 || !handle) throw new Error(`authorize: ${res.status} ${res.text}`)
  const ap = await approve(approver, handle, o.grantScopes ? { scopes: o.grantScopes } : {})
  if (ap.status !== 201) throw new Error(`approve: ${ap.status} ${ap.text}`)
  const { code } = codeOf(ap.body.redirect)
  const tok = await exchange(clientId, code, verifier)
  if (tok.status !== 200) throw new Error(`token: ${tok.status} ${tok.text}`)
  return { clientId, verifier, grant: ap.body.grant, approval: ap.body, code, access: tok.body.access_token, refresh: tok.body.refresh_token, scope: tok.body.scope }
}

/** Introspection as the agent surface asks it, over the Durable Object binding. */
export const introspect = (tenant: string, token: string, resource = RESOURCE) => env.TENANT.get(env.TENANT.idFromName(tenant)).introspectAccessToken(tenant, token, resource)
