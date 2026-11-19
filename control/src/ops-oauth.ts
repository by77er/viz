import {
  type ClientRegistration,
  GRANT_KEY_PREFIX,
  type GrantStatus,
  type IntrospectionResult,
  OAUTH_LIFETIMES,
  OAUTH_LIMITS,
  type OAuthGrantView,
  type OAuthScope,
  parseCredential,
  type TokenErrorCode,
  type TokenRequest,
  type TokenResult,
} from '../../contracts/oauth'
import { sha256Hex } from '../../dashboard/src/index.ts'
import { DAY_MS } from './caps'
import { Problem, invalid, notFound } from './errors'
import type { Actor } from './identity'
import { mayApply } from './ops-dashboards'
import { dropKey, mintKey, newKey } from './ops-keys'
import {
  type AuthzRequest,
  approverScopes,
  callback,
  decodeRequest,
  hashCredential,
  isLoopback,
  mintCredential,
  parseScope,
  pkceMatches,
  sameResource,
  sameString,
  seal,
  sealAad,
  unseal,
  verifyClientId,
} from './oauth'
import { type Ctx, NoChange, type Op, type Tenant } from './tenant'
import { decodeCursor, encodeCursor, fields, isRecord, iso, pageLimit, randomId } from './util'

/**
 * OAuth grants in the tenant's object (contracts/oauth.ts, decision D44).
 *
 * Person-facing operations go through the route table like every other mutation (one
 * transaction, one audit row, dry run): approve, list, get, revoke. The token endpoint,
 * revocation and introspection are RPCs on `Tenant` (`TenantOAuthRpc`), reached by control's
 * public OAuth endpoints and by the agent surface over the Durable Object binding.
 *
 * Secrets: codes and tokens are stored as SHA-256 only. The grant key's secret is stored sealed
 * under each live code and token (`oauth.ts` `seal`); it is in clear only inside a request that
 * presented one of them. Sealing and unsealing are asynchronous (WebCrypto), so the token paths
 * run in phases: a transaction that checks and spends the presented credential, the crypto, then
 * a transaction that re-checks the grant and stores the new tokens.
 */

const SYSTEM: Actor = { subject: 'system:oauth', kind: 'system', name: null }
const HOUR_MS = 3_600_000
/** Revoked and expired grants are listed this long, then deleted (the audit log keeps them). */
const KEEP_CLOSED_MS = 90 * DAY_MS

export interface ClientRow {
  id: string
  client_id: string
  name: string
  redirect_uris: string
  registered_at: number
  bound_at: number
  bound_by: string
  last_used_at: number
}

export interface GrantRow {
  id: string
  client: string
  scopes: string
  resource: string
  key: string | null
  created_at: number
  created_by: string
  expires_at: number
  last_used_at: number | null
  revoked_at: number | null
  revoked_by: string | null
  revoke_reason: string | null
}

interface CodeRow {
  hash: string
  grant_id: string
  challenge: string
  redirect_uri: string
  expires_at: number
  used_at: number | null
  sealed: string
}

interface TokenRow {
  hash: string
  kind: 'access' | 'refresh'
  grant_id: string
  scopes: string
  issued_at: number
  expires_at: number
  rotated_at: number | null
  sealed: string
}

const CLIENT_COLS = 'id, client_id, name, redirect_uris, registered_at, bound_at, bound_by, last_used_at'
const GRANT_COLS = 'id, client, scopes, resource, key, created_at, created_by, expires_at, last_used_at, revoked_at, revoked_by, revoke_reason'
const TOKEN_COLS = 'hash, kind, grant_id, scopes, issued_at, expires_at, rotated_at, sealed'

const loadGrant = (t: Tenant, id: string): GrantRow | undefined => t.one<GrantRow>(`SELECT ${GRANT_COLS} FROM oauth_grants WHERE tenant = ? AND id = ?`, t.tenant, id)
const loadClient = (t: Tenant, id: string): ClientRow | undefined => t.one<ClientRow>(`SELECT ${CLIENT_COLS} FROM oauth_clients WHERE tenant = ? AND id = ?`, t.tenant, id)
const keyOf = (t: Tenant, g: GrantRow) =>
  g.key === null ? undefined : t.one<{ id: string; name: string; key_id: string; disabled: number; expires_at: number | null }>('SELECT id, name, key_id, disabled, expires_at FROM keys WHERE tenant = ? AND id = ?', t.tenant, g.key)

function status(t: Tenant, g: GrantRow, now: number): GrantStatus {
  if (g.revoked_at !== null) return g.revoke_reason === 'expired' ? 'expired' : 'revoked'
  if (g.expires_at <= now) return 'expired'
  const k = keyOf(t, g)
  if (!k) return 'revoked'
  return k.disabled === 1 ? 'suspended' : 'live'
}

export function grantView(t: Tenant, g: GrantRow, now: number): OAuthGrantView {
  const client = loadClient(t, g.client)
  const key = keyOf(t, g)
  return {
    id: g.id,
    status: status(t, g, now),
    client: { name: client?.name ?? 'unknown application', redirectUris: client ? (JSON.parse(client.redirect_uris) as string[]) : [], registeredAt: iso(client?.registered_at ?? 0)! },
    scopes: JSON.parse(g.scopes) as OAuthScope[],
    resource: g.resource,
    approvedBy: JSON.parse(g.created_by) as Actor,
    createdAt: iso(g.created_at)!,
    expiresAt: iso(g.expires_at)!,
    lastUsedAt: iso(g.last_used_at),
    key: key ? { id: key.id, name: key.name } : null,
    revokedAt: iso(g.revoked_at),
    revokedBy: g.revoked_by === null ? null : (JSON.parse(g.revoked_by) as Actor),
    revokeReason: g.revoke_reason,
  }
}

/**
 * End a grant, inside the caller's transaction: its tokens and codes are deleted, its key
 * removed from SQLite and KV (revocation generation bumped), one audit entry. Idempotent.
 */
export function revokeGrant(t: Tenant, g: GrantRow, actor: Actor, now: number, reason: string): void {
  if (g.revoked_at !== null) return
  const before = grantView(t, g, now)
  t.run('UPDATE oauth_grants SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE tenant = ? AND id = ?', now, JSON.stringify(actor), reason, t.tenant, g.id)
  t.run('DELETE FROM oauth_tokens WHERE tenant = ? AND grant_id = ?', t.tenant, g.id)
  t.run('DELETE FROM oauth_codes WHERE tenant = ? AND grant_id = ?', t.tenant, g.id)
  if (keyOf(t, g)) dropKey(t, g.key!, now)
  t.audit(actor, now, reason === 'expired' ? 'oauth.grant.expire' : 'oauth.grant.revoke', 'oauth-grant', g.id, before, grantView(t, loadGrant(t, g.id)!, now))
}

// ---- approve: the consent step ----

/** Made before the approval's transaction: WebCrypto is asynchronous, a transaction is not. Nothing here depends on stored state. */
export interface ApprovePrep {
  request: AuthzRequest | null
  /** The client id's registration when its signature holds; its age is checked in the transaction. */
  registration: ClientRegistration | null
  grantId: string
  code: string
  key: { keyId: string; secret: string }
  sealed: string
}

export async function prepareApprove(t: Tenant, body: unknown): Promise<ApprovePrep> {
  const request = decodeRequest(isRecord(body) ? body.request : undefined)
  const registration = request ? await verifyClientId(t.oauth.clientKey, request.client_id) : null
  const grantId = `g_${randomId(22)}`
  const code = mintCredential('code', t.tenant)
  const key = mintKey()
  return { request, registration, grantId, code, key, sealed: await seal(code, key.secret, sealAad(t.tenant, grantId)) }
}

const approve: Op = (t, c) => {
  const b = fields(c.input.body, ['request', 'scopes', 'dryRun'], 'request body')
  const p = c.prepared as ApprovePrep
  const req = p.request
  if (!req) throw invalid('"request" is not an authorization request this server issued.', 'Copy "request" exactly from the page /oauth/authorize showed.', { field: 'request' })
  // Only a person decides what an agent may do (D29). Approving needs admin (the route) and a person's key.
  if (c.id.kind === 'agent') throw new Problem(403, 'approver-not-a-person', 'An agent key may not approve access for an application.', 'Approve with a person\'s key (kind "key") that has the admin scope.')
  const cfg = t.oauth
  if (!sameResource(req.resource, cfg.resource)) throw invalid('The request is for a resource this server does not issue tokens for.', `Tokens are issued for ${cfg.resource} only. Ask the application to connect to that address.`, { field: 'request' })

  // The client: bound in this tenant already, or a signed registration young enough to bind now.
  let client = t.one<ClientRow>(`SELECT ${CLIENT_COLS} FROM oauth_clients WHERE tenant = ? AND client_id = ?`, t.tenant, req.client_id)
  const reg = p.registration
  if (!client) {
    if (!reg) throw new Problem(422, 'client-unknown', 'The application\'s registration is not one this server issued, or it is damaged.', 'Ask the application to connect again: it registers itself anew.')
    if (c.now - reg.iat * 1000 > OAUTH_LIFETIMES.unboundRegistrationSeconds * 1000) {
      throw new Problem(422, 'registration-expired', 'The application registered more than 24 hours ago and nobody approved it since.', 'Ask the application to connect again: it registers itself anew.')
    }
    if (t.one<{ n: number }>('SELECT COUNT(*) AS n FROM oauth_clients WHERE tenant = ?', t.tenant)!.n >= OAUTH_LIMITS.clientsPerTenant) {
      throw new Problem(409, 'too-many-clients', `This tenant already has ${OAUTH_LIMITS.clientsPerTenant} OAuth clients.`, 'Revoke grants of applications no longer used; a client with no live grant is removed after 30 days.')
    }
  }
  const uris = client ? (JSON.parse(client.redirect_uris) as string[]) : reg!.uris
  // Exact match against what the client registered (OAuth 2.1 §4.1.1, MCP "Open Redirection").
  if (!uris.includes(req.redirect_uri)) throw invalid('The redirect URI is not one the application registered.', 'Ask the application to connect again.', { field: 'request' })

  // Scopes: what was asked, narrowed by the person if they wish, and never more than their own key holds.
  let wanted: OAuthScope[] = req.scope
  if (b.scopes !== undefined) {
    if (!Array.isArray(b.scopes) || b.scopes.length === 0 || !b.scopes.every((s) => typeof s === 'string' && (req.scope as string[]).includes(s))) {
      throw invalid('"scopes" must be a non-empty list chosen from the scopes the application asked for.', `It asked for: ${req.scope.join(', ')}.`, { field: 'scopes' })
    }
    wanted = req.scope.filter((s) => (b.scopes as string[]).includes(s))
  }
  const mine = approverScopes(c.id.scopes)
  const granted = wanted.filter((s) => mine.has(s))
  const withheld = req.scope.filter((s) => !granted.includes(s))
  if (granted.length === 0) {
    throw new Problem(403, 'nothing-to-grant', 'Your key holds none of the scopes this would grant; an application never gets more than the person who approves it.', `Approve with a key that also holds ${wanted.join(', ')}, or grant fewer scopes.`, { requested: req.scope })
  }

  // Bounds per tenant.
  const recent = t.one<{ n: number }>('SELECT COUNT(*) AS n FROM oauth_grants WHERE tenant = ? AND created_at > ?', t.tenant, c.now - HOUR_MS)!.n
  if (recent >= OAUTH_LIMITS.approvalsPerHour) {
    throw new Problem(429, 'too-many-approvals', `This tenant approved ${OAUTH_LIMITS.approvalsPerHour} OAuth clients in the last hour, the most it may.`, 'Wait, then approve again.', {}, { 'Retry-After': '600' })
  }
  if (t.one<{ n: number }>('SELECT COUNT(*) AS n FROM oauth_grants WHERE tenant = ? AND revoked_at IS NULL AND expires_at > ?', t.tenant, c.now)!.n >= OAUTH_LIMITS.liveGrantsPerTenant) {
    throw new Problem(409, 'too-many-grants', `This tenant already has ${OAUTH_LIMITS.liveGrantsPerTenant} live OAuth grants.`, 'Revoke grants that are no longer used: POST /api/v1/control/oauth/grants/{id}/revoke.')
  }
  if (t.one<{ n: number }>('SELECT COUNT(*) AS n FROM keys WHERE tenant = ?', t.tenant)!.n >= t.caps.maxKeys) {
    throw new Problem(409, 'too-many-keys', `This tenant already has ${t.caps.maxKeys} keys; each grant needs one.`, 'Delete keys or revoke grants that are no longer used.')
  }

  if (!client) {
    const id = `c_${randomId(22)}`
    t.run(
      'INSERT INTO oauth_clients (tenant, id, client_id, name, redirect_uris, registered_at, bound_at, bound_by, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      t.tenant, id, req.client_id, reg!.name, JSON.stringify(reg!.uris), reg!.iat * 1000, c.now, JSON.stringify(c.actor), c.now,
    )
    client = loadClient(t, id)!
  } else {
    t.run('UPDATE oauth_clients SET last_used_at = ? WHERE tenant = ? AND id = ?', c.now, t.tenant, client.id)
  }
  const expiresAt = c.now + OAUTH_LIFETIMES.grantDays * DAY_MS
  const key = newKey(t, c.actor, c.now, { name: `${GRANT_KEY_PREFIX}${p.grantId}`, scopes: granted, kind: 'agent', expiresAt }, p.key)
  t.run(
    'INSERT INTO oauth_grants (tenant, id, client, scopes, resource, key, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    t.tenant, p.grantId, client.id, JSON.stringify(granted), cfg.resource, key.view.id as string, c.now, JSON.stringify(c.actor), expiresAt,
  )
  const codeExpires = c.now + OAUTH_LIFETIMES.codeSeconds * 1000
  t.run(
    'INSERT INTO oauth_codes (tenant, hash, grant_id, challenge, redirect_uri, expires_at, used_at, sealed) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
    t.tenant, hashCredential(p.code), p.grantId, req.code_challenge, req.redirect_uri, codeExpires, p.sealed,
  )
  const view = grantView(t, loadGrant(t, p.grantId)!, c.now)
  t.audit(c.actor, c.now, 'oauth.grant.approve', 'oauth-grant', p.grantId, null, view)

  const host = new URL(req.redirect_uri).host
  const warnings = [`The application's name ("${client.name}") is what it says about itself; viz has not verified it.`]
  if (isLoopback(req.redirect_uri)) warnings.push(`The code goes to a program on the computer that opens the link (${host}). Any program listening there can receive it: approve only a connection you started yourself.`)
  if (withheld.length) warnings.push(`Not granted, because your key does not hold them or you left them out: ${withheld.join(', ')}.`)
  // A dry run is the consent preview: exactly what would be granted, and no code.
  const redirect = c.dryRun ? null : callback(req.redirect_uri, { code: p.code, state: req.state, iss: cfg.issuer })
  return { status: 201, body: { outcome: 'approved', grant: view, withheld, returnsTo: { host, uri: req.redirect_uri }, warnings, redirect, codeExpiresAt: iso(codeExpires), shownOnce: true } }
}

// ---- grants: list, one, revoke ----

const list: Op = (t, c) => {
  const which = c.input.query.status?.[0] ?? 'live'
  if (which !== 'live' && which !== 'all') throw new Problem(400, 'bad-status', '"status" must be live or all.', 'Use status=live (the default) or status=all.')
  const limit = pageLimit(c.input.query.limit?.[0])
  const after = decodeCursor(c.input.query.cursor?.[0], ['number', 'string'])
  const rows = t.all<GrantRow>(
    `SELECT ${GRANT_COLS} FROM oauth_grants WHERE tenant = ? AND (created_at > ? OR (created_at = ? AND id > ?))${which === 'live' ? ' AND revoked_at IS NULL AND expires_at > ?' : ' AND ? > 0'} ORDER BY created_at, id LIMIT ?`,
    t.tenant, (after?.[0] as number) ?? -1, (after?.[0] as number) ?? -1, (after?.[1] as string) ?? '', c.now, limit + 1,
  )
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return { status: 200, body: { items: page.map((g) => grantView(t, g, c.now)), next: rows.length > limit && last ? encodeCursor([last.created_at, last.id]) : null } }
}

const get: Op = (t, c) => {
  const g = loadGrant(t, c.input.params.grant!)
  if (!g) throw notFound('grant')
  return { status: 200, body: { grant: grantView(t, g, c.now) } }
}

const revoke: Op = (t, c) => {
  fields(c.input.body, ['dryRun'], 'request body')
  const g = loadGrant(t, c.input.params.grant!)
  if (!g) throw notFound('grant')
  if (g.revoked_at !== null || g.expires_at <= c.now) throw new NoChange({ status: 200, body: { outcome: 'unchanged', grant: grantView(t, g, c.now) } })
  revokeGrant(t, g, c.actor, c.now, 'person')
  return { status: 200, body: { outcome: 'revoked', grant: grantView(t, loadGrant(t, g.id)!, c.now) } }
}

export const oauthOps = {
  'oauth.approve': approve,
  'oauth.grants.list': list,
  'oauth.grants.get': get,
  'oauth.grants.revoke': revoke,
} satisfies Record<string, Op>

// ---- the token endpoint ----

const fail = (error: TokenErrorCode, description: string): TokenResult => ({ v: 1, status: 'error', error, description })
type Spent = { error: TokenResult } | { grant: GrantRow; sealed: string; scopes: OAuthScope[] }

/** Revoked, expired, or its key gone: nothing more may be issued for it. A disabled (suspended) key still rotates; the resource refuses it. */
function issuable(t: Tenant, g: GrantRow, now: number): boolean {
  if (g.revoked_at !== null || g.expires_at <= now) return false
  const k = keyOf(t, g)
  return k !== undefined && (k.expires_at === null || k.expires_at > now)
}

const clientMatches = (t: Tenant, g: GrantRow, clientId: string): boolean => {
  const client = loadClient(t, g.client)
  return client !== undefined && typeof clientId === 'string' && sameString(client.client_id, clientId)
}

function touch(t: Tenant, g: GrantRow, now: number): void {
  t.run('UPDATE oauth_grants SET last_used_at = ? WHERE tenant = ? AND id = ?', now, t.tenant, g.id)
  t.run('UPDATE oauth_clients SET last_used_at = ? WHERE tenant = ? AND id = ?', now, t.tenant, g.client)
}

/** The `authorization_code` grant (OAuth 2.1 §4.1.3, PKCE §4.1.3 / RFC 7636 §4.6, RFC 8707). */
export async function exchangeCode(t: Tenant, req: TokenRequest, now: number): Promise<TokenResult> {
  if (typeof req.code !== 'string' || typeof req.code_verifier !== 'string' || typeof req.redirect_uri !== 'string') {
    return fail('invalid_request', 'code, code_verifier and redirect_uri are required.')
  }
  const hash = hashCredential(req.code)
  const gone = 'The authorization code is unknown, expired or already used.'
  const spent = t.transaction((): Spent => {
    const row = t.one<CodeRow>('SELECT hash, grant_id, challenge, redirect_uri, expires_at, used_at, sealed FROM oauth_codes WHERE tenant = ? AND hash = ?', t.tenant, hash)
    if (!row) return { error: fail('invalid_grant', gone) }
    const g = loadGrant(t, row.grant_id)
    if (row.used_at !== null) {
      // A code used twice: refuse it, and revoke what was issued with it (OAuth 2.1 §4.1.3).
      if (g) revokeGrant(t, g, SYSTEM, now, 'code-reuse')
      return { error: fail('invalid_grant', gone) }
    }
    if (row.expires_at <= now) return { error: fail('invalid_grant', gone) }
    // From here on any failure spends the code: whoever holds it without the rest gets one try.
    t.run('UPDATE oauth_codes SET used_at = ? WHERE tenant = ? AND hash = ?', now, t.tenant, hash)
    if (!g || !issuable(t, g, now)) return { error: fail('invalid_grant', 'The grant this code was issued for has ended.') }
    if (!clientMatches(t, g, req.client_id)) return { error: fail('invalid_grant', 'The code was issued to another client.') }
    if (req.redirect_uri !== row.redirect_uri) return { error: fail('invalid_grant', 'redirect_uri is not the one the authorization request used.') }
    if (!pkceMatches(req.code_verifier!, row.challenge)) return { error: fail('invalid_grant', 'code_verifier does not match the code_challenge.') }
    if (req.resource !== undefined && !sameResource(req.resource, g.resource)) return { error: fail('invalid_target', 'The resource is not the one this code was issued for.') }
    touch(t, g, now)
    return { grant: g, sealed: row.sealed, scopes: JSON.parse(g.scopes) as OAuthScope[] }
  })
  if ('error' in spent) return spent.error
  return issue(t, spent.grant, req.code, spent.sealed, spent.scopes, now)
}

/** The `refresh_token` grant, rotating (OAuth 2.1 §4.3.1): the presented token is spent; presenting it again revokes the grant. */
export async function refreshTokens(t: Tenant, req: TokenRequest, now: number): Promise<TokenResult> {
  if (typeof req.refresh_token !== 'string') return fail('invalid_request', 'refresh_token is required.')
  const hash = hashCredential(req.refresh_token)
  const gone = 'The refresh token is unknown, expired, used or revoked.'
  const spent = t.transaction((): Spent => {
    const row = t.one<TokenRow>(`SELECT ${TOKEN_COLS} FROM oauth_tokens WHERE tenant = ? AND hash = ? AND kind = 'refresh'`, t.tenant, hash)
    if (!row) return { error: fail('invalid_grant', gone) }
    const g = loadGrant(t, row.grant_id)
    if (row.rotated_at !== null) {
      // Reuse of a rotated refresh token: one of the two holders is not the client. End the grant.
      if (g) revokeGrant(t, g, SYSTEM, now, 'refresh-reuse')
      return { error: fail('invalid_grant', gone) }
    }
    if (row.expires_at <= now || !g || !issuable(t, g, now)) return { error: fail('invalid_grant', gone) }
    if (!clientMatches(t, g, req.client_id)) {
      // A refresh token presented by another client was stolen from the one it was issued to.
      revokeGrant(t, g, SYSTEM, now, 'wrong-client')
      return { error: fail('invalid_grant', gone) }
    }
    if (req.resource !== undefined && !sameResource(req.resource, g.resource)) return { error: fail('invalid_target', 'The resource is not the one this grant is for.') }
    const held = JSON.parse(g.scopes) as OAuthScope[]
    let scopes = held
    if (req.scope !== undefined && req.scope !== '') {
      const asked = parseScope(req.scope)
      if ('unknown' in asked || !asked.ok.every((s) => held.includes(s))) return { error: fail('invalid_scope', `A refresh may ask only for scopes the grant holds: ${held.join(' ')}.`) }
      scopes = asked.ok
    }
    t.run('UPDATE oauth_tokens SET rotated_at = ? WHERE tenant = ? AND hash = ?', now, t.tenant, hash)
    // Keep rotated tokens a day (reuse detection), expired ones not at all.
    t.run(
      "DELETE FROM oauth_tokens WHERE tenant = ? AND grant_id = ? AND (expires_at <= ? OR (kind = 'refresh' AND rotated_at IS NOT NULL AND rotated_at <= ?))",
      t.tenant, g.id, now, now - OAUTH_LIFETIMES.rotatedRefreshKeepSeconds * 1000,
    )
    touch(t, g, now)
    return { grant: g, sealed: row.sealed, scopes }
  })
  if ('error' in spent) return spent.error
  return issue(t, spent.grant, req.refresh_token, spent.sealed, spent.scopes, now)
}

/** Unseal the grant key's secret with the spent credential, mint and seal the new pair, store them if the grant is still live. */
async function issue(t: Tenant, g: GrantRow, presented: string, sealed: string, scopes: OAuthScope[], now: number): Promise<TokenResult> {
  const aad = sealAad(t.tenant, g.id)
  const secret = await unseal(presented, sealed, aad)
  if (secret === null) return fail('invalid_grant', 'This grant cannot issue tokens; approve the application again.')
  const access = mintCredential('access', t.tenant)
  const refresh = mintCredential('refresh', t.tenant)
  const [sa, sr] = await Promise.all([seal(access, secret, aad), seal(refresh, secret, aad)])
  const stored = t.transaction(() => {
    // Revoked while the crypto ran (a reuse, a person, the alarm): issue nothing.
    const cur = loadGrant(t, g.id)
    if (!cur || !issuable(t, cur, now)) return false
    const ins = 'INSERT INTO oauth_tokens (tenant, hash, kind, grant_id, scopes, issued_at, expires_at, rotated_at, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)'
    t.run(ins, t.tenant, hashCredential(access), 'access', g.id, JSON.stringify(scopes), now, now + OAUTH_LIFETIMES.accessSeconds * 1000, sa)
    t.run(ins, t.tenant, hashCredential(refresh), 'refresh', g.id, JSON.stringify(scopes), now, now + OAUTH_LIFETIMES.refreshSeconds * 1000, sr)
    return true
  })
  if (!stored) return fail('invalid_grant', 'The grant has ended.')
  return { v: 1, status: 'ok', tokens: { access_token: access, token_type: 'Bearer', expires_in: OAUTH_LIFETIMES.accessSeconds, refresh_token: refresh, scope: scopes.join(' ') } }
}

// ---- revocation (RFC 7009) ----

/** An access token ends alone; a refresh token ends its grant. A token of another client, or none at all, changes nothing. */
export function revokeToken(t: Tenant, token: string, clientId: string, now: number): void {
  const parsed = typeof token === 'string' ? parseCredential(token) : null
  if (!parsed || parsed.kind === 'code') return
  const row = t.one<TokenRow>(`SELECT ${TOKEN_COLS} FROM oauth_tokens WHERE tenant = ? AND hash = ? AND kind = ?`, t.tenant, hashCredential(token), parsed.kind)
  if (!row) return
  const g = loadGrant(t, row.grant_id)
  if (!g || !clientMatches(t, g, clientId)) return
  if (row.kind === 'access') {
    t.run('DELETE FROM oauth_tokens WHERE tenant = ? AND hash = ?', t.tenant, row.hash)
    return
  }
  const client = loadClient(t, g.client)!
  revokeGrant(t, g, { subject: `oauth-client:${client.id}`, kind: 'agent', name: client.name }, now, 'client')
}

// ---- introspection, for the resource ----

/**
 * Is this access token live, for `resource`, and who is it? Read only. The grant key's secret is
 * unsealed with the token itself and returned for the resource's downstream calls.
 */
export async function introspect(t: Tenant, token: string, resource: string, now: number): Promise<IntrospectionResult> {
  const inactive = (reason: 'unknown' | 'expired' | 'revoked' | 'suspended' | 'audience'): IntrospectionResult => ({ v: 1, status: 'inactive', reason })
  const row = t.one<TokenRow>(`SELECT ${TOKEN_COLS} FROM oauth_tokens WHERE tenant = ? AND hash = ? AND kind = 'access'`, t.tenant, hashCredential(token))
  if (!row) return inactive('unknown')
  if (row.expires_at <= now) return inactive('expired')
  const g = loadGrant(t, row.grant_id)
  if (!g || g.revoked_at !== null) return inactive('revoked')
  if (g.expires_at <= now) return inactive('expired')
  // Audience (RFC 8707; MCP "Token Handling"): a token is good only at the resource it was issued for.
  if (!sameResource(resource, g.resource)) return inactive('audience')
  const secret = await unseal(token, row.sealed, sealAad(t.tenant, g.id))
  if (secret === null) return inactive('unknown')
  // After the await: read the state again, so a revocation that landed meanwhile is seen.
  const cur = loadGrant(t, g.id)
  const k = cur ? keyOf(t, cur) : undefined
  if (!cur || cur.revoked_at !== null || !k || !t.one('SELECT hash FROM oauth_tokens WHERE tenant = ? AND hash = ?', t.tenant, row.hash)) return inactive('revoked')
  if (k.disabled === 1) return inactive('suspended')
  if (k.expires_at !== null && k.expires_at <= now) return inactive('expired')
  const live = t.one<{ s: string }>('SELECT secret_sha256 AS s FROM key_secrets WHERE tenant = ? AND key = ? AND key_id = ?', t.tenant, k.id, k.key_id)
  if (!live || !sameString(sha256Hex(secret), live.s)) return inactive('revoked')
  const scopes = JSON.parse(row.scopes) as OAuthScope[]
  const client = loadClient(t, g.client)
  return {
    v: 1,
    status: 'active',
    tenant: t.tenant,
    grant: g.id,
    clientName: client?.name ?? 'unknown application',
    subject: `key:${k.id}`,
    kind: 'agent',
    name: k.name,
    scopes,
    mayApply: mayApply(t, { id: { tenant: t.tenant, subject: `key:${k.id}`, kind: 'agent', scopes } } as Ctx),
    expiresAt: row.expires_at,
    credential: `viz_${k.key_id}_${secret}`,
  }
}

// ---- the alarm ----

/** Inside the alarm's transaction: end grants that are due, delete what is spent, forget idle clients. */
export function sweepOAuth(t: Tenant, now: number): void {
  const open = (where: string, ...b: SqlStorageValue[]) => t.all<GrantRow>(`SELECT ${GRANT_COLS} FROM oauth_grants WHERE tenant = ? AND revoked_at IS NULL AND ${where}`, t.tenant, ...b)
  for (const g of open('expires_at <= ?', now)) revokeGrant(t, g, SYSTEM, now, 'expired')
  for (const g of open('id IN (SELECT grant_id FROM oauth_codes WHERE tenant = ? AND used_at IS NULL AND expires_at <= ?)', t.tenant, now)) revokeGrant(t, g, SYSTEM, now, 'not-exchanged')
  for (const g of open('last_used_at IS NOT NULL AND last_used_at <= ?', now - OAUTH_LIFETIMES.refreshSeconds * 1000)) revokeGrant(t, g, SYSTEM, now, 'idle')
  t.run("DELETE FROM oauth_tokens WHERE tenant = ? AND (expires_at <= ? OR (kind = 'refresh' AND rotated_at IS NOT NULL AND rotated_at <= ?))", t.tenant, now, now - OAUTH_LIFETIMES.rotatedRefreshKeepSeconds * 1000)
  t.run('DELETE FROM oauth_codes WHERE tenant = ? AND expires_at <= ?', t.tenant, now)
  t.run('DELETE FROM oauth_grants WHERE tenant = ? AND revoked_at IS NOT NULL AND revoked_at <= ?', t.tenant, now - KEEP_CLOSED_MS)
  const idle = t.all<ClientRow>(
    `SELECT ${CLIENT_COLS} FROM oauth_clients c WHERE c.tenant = ? AND c.last_used_at <= ? AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.tenant = c.tenant AND g.client = c.id AND g.revoked_at IS NULL AND g.expires_at > ?)`,
    t.tenant, now - OAUTH_LIFETIMES.clientIdleDays * DAY_MS, now,
  )
  for (const c of idle) {
    t.run('DELETE FROM oauth_clients WHERE tenant = ? AND id = ?', t.tenant, c.id)
    t.audit(SYSTEM, now, 'oauth.client.expire', 'oauth-client', c.id, { name: c.name, redirectUris: JSON.parse(c.redirect_uris) as string[], lastUsedAt: iso(c.last_used_at) }, null)
  }
}

/** When the alarm must next run for OAuth: a grant's end, a code nobody exchanged, a grant gone idle, a client to forget, a closed grant to delete. */
export function oauthDeadlines(t: Tenant, now: number): number[] {
  const min = (q: string, ...b: SqlStorageValue[]) => t.one<{ m: number | null }>(q, ...b)!.m
  const out: (number | null)[] = [
    min('SELECT MIN(expires_at) AS m FROM oauth_grants WHERE tenant = ? AND revoked_at IS NULL', t.tenant),
    min('SELECT MIN(expires_at) AS m FROM oauth_codes WHERE tenant = ? AND used_at IS NULL', t.tenant),
  ]
  const used = min('SELECT MIN(last_used_at) AS m FROM oauth_grants WHERE tenant = ? AND revoked_at IS NULL AND last_used_at IS NOT NULL', t.tenant)
  if (used !== null) out.push(used + OAUTH_LIFETIMES.refreshSeconds * 1000)
  const idle = min(
    'SELECT MIN(c.last_used_at) AS m FROM oauth_clients c WHERE c.tenant = ? AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.tenant = c.tenant AND g.client = c.id AND g.revoked_at IS NULL AND g.expires_at > ?)',
    t.tenant, now,
  )
  if (idle !== null) out.push(idle + OAUTH_LIFETIMES.clientIdleDays * DAY_MS)
  const closed = min('SELECT MIN(revoked_at) AS m FROM oauth_grants WHERE tenant = ? AND revoked_at IS NOT NULL', t.tenant)
  if (closed !== null) out.push(closed + KEEP_CLOSED_MS)
  return out.filter((x): x is number => x !== null)
}
