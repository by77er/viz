/**
 * OAuth 2.1 for agents: what an MCP client (Claude, an IDE agent) holds when a person has let it
 * act on a tenant, and how the agent surface (mcp/) checks it. Decision D44; MCP specification
 * 2026-07-28, "Authorization" (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).
 *
 * The objects are the control plane's (control/), kept in each tenant's `Tenant` Durable Object:
 *
 *   client         a dynamically registered public client (RFC 7591). Registration stores
 *                  nothing: the client id is the registration, signed by control
 *                  (`ClientRegistration`). A client is stored in a tenant (bound) when a person
 *                  of that tenant first approves it, and deleted once it has had no live grant
 *                  for `clientIdleDays`. An unbound registration expires after
 *                  `unboundRegistrationSeconds`.
 *   grant          what a person approved: one client, scopes, one resource (audience), an
 *                  absolute expiry. Backed by an ordinary agent API key named `oauth:<grantId>`
 *                  with exactly the grant's scopes, which the agent surface uses for its own
 *                  downstream calls (never the client's token: the spec forbids token
 *                  passthrough). The key's secret is never stored in clear: it is sealed under
 *                  each live code, access token and refresh token, so only a holder of one of
 *                  them, through control, can recover it.
 *   code           single use, `codeSeconds`, PKCE S256 only, bound to the client, the exact
 *                  redirect URI and the resource. A second use revokes the grant.
 *   access token   `accessSeconds`, bound to the grant's resource. Checked by control on every
 *                  request (`introspectAccessToken`), so revocation is immediate at the resource.
 *   refresh token  rotated on every use; the used one is kept for a while, and presenting it again
 *                  revokes the whole grant (reuse detection).
 *
 * Rules:
 * - Tenant-scoped: each credential names its tenant in clear so the server can find the tenant's
 *   object; that object holds only the SHA-256 of the whole credential, so a credential edited to
 *   name another tenant matches nothing there. Nothing else in a request is read for the tenant.
 * - Scopes are drawn from control's scope set (`control/src/routes.ts` SCOPES), limited to
 *   `OAUTH_SCOPES`, and a grant never holds a scope its approver's own key does not hold
 *   (`admin` counts as the dashboards scopes control lets it stand for, and is never granted).
 * - Only a person approves: an identity of kind `key` or `user` with `admin`, never an agent.
 * - Every RPC result carries `v` (COMPATIBILITY.md §3.1); a caller refuses a `v` it does not know.
 *   Nothing here throws for bad input.
 *
 * Versions: 1 (all formats and results below).
 */

import type { SchemaTooNew } from './schema'

export const OAUTH_VERSION = 1

/**
 * Scopes a grant may hold: the ones the agent surface checks (`mcp/src/auth.ts` SCOPES).
 * Never `admin` (total in control), `write` (ingest), `monitors:write` or `monitors:ack`.
 */
export const OAUTH_SCOPES = ['read', 'dashboards:read', 'dashboards:write', 'dashboards:apply', 'monitors:read'] as const
export type OAuthScope = (typeof OAUTH_SCOPES)[number]

/** What a client gets when it names no scope, and what the resource advertises as enough to start: read only. */
export const OAUTH_DEFAULT_SCOPES = ['read', 'dashboards:read', 'monitors:read'] as const satisfies readonly OAuthScope[]

/** The scope an approver must hold, as a person (kind `key` or `user`). */
export const OAUTH_APPROVER_SCOPE = 'admin'

/**
 * A grant's key is named `oauth:<grantId>`. The prefix is reserved, as `service:` is: a person
 * cannot create a key with it, and such a key is rotated or deleted only through its grant.
 */
export const GRANT_KEY_PREFIX = 'oauth:'

/** Scopes `admin` stands for in control (its dashboards routes accept it); a grant approved by an admin key may carry these. */
export const ADMIN_IMPLIES = ['dashboards:read', 'dashboards:write', 'dashboards:apply'] as const

export const OAUTH_LIFETIMES = {
  /** Authorization code. A person copies the redirect by hand while there is no consent page, hence the upper end of OAuth 2.1's advice. */
  codeSeconds: 600,
  accessSeconds: 3_600,
  /** A refresh token unused this long expires, and the grant with it. */
  refreshSeconds: 30 * 86_400,
  /** A grant ends this long after approval whatever happens. */
  grantDays: 90,
  /** A registration no person approved within this time is refused at approval. */
  unboundRegistrationSeconds: 86_400,
  /** A bound client with no live grant for this long is deleted. */
  clientIdleDays: 30,
  /** How long a rotated refresh token is kept, so that presenting it again is recognised as reuse. */
  rotatedRefreshKeepSeconds: 86_400,
} as const

export const OAUTH_LIMITS = {
  /** Bound clients per tenant. */
  clientsPerTenant: 50,
  /** Live grants per tenant. */
  liveGrantsPerTenant: 50,
  /** Approvals per tenant in any hour. */
  approvalsPerHour: 20,
  redirectUrisPerClient: 5,
  redirectUriLength: 512,
  clientNameLength: 100,
  stateLength: 512,
  /** A registration request body, in bytes. */
  registrationBytes: 8_192,
} as const

// ---- credentials ----

/**
 * `<prefix>1.<tenant>.<secret>`: the secret is 43 base62 characters (about 256 bits). The tenant
 * is `contracts/ledger.ts` TENANT_ID, which has no `.`. Format version 1 is the `1` in the prefix.
 */
export const OAUTH_CREDENTIAL = /^(vzc|vza|vzr)1\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9]{43})$/
export const CREDENTIAL_PREFIX = { code: 'vzc1', access: 'vza1', refresh: 'vzr1' } as const
export type CredentialKind = keyof typeof CREDENTIAL_PREFIX

export function parseCredential(s: string): { kind: CredentialKind; tenant: string } | null {
  const m = OAUTH_CREDENTIAL.exec(s)
  if (!m) return null
  const kind = m[1] === 'vzc' ? 'code' : m[1] === 'vza' ? 'access' : 'refresh'
  return { kind, tenant: m[2]! }
}

/**
 * A client id: `vzk1.<payload>.<mac>`, payload = base64url of the JSON `ClientRegistration`,
 * mac = base64url HMAC-SHA256 of the payload under control's `OAUTH_CLIENT_KEY`. Public clients
 * only (`token_endpoint_auth_method: none`): there is no client secret.
 */
export const CLIENT_ID = /^vzk1\.([A-Za-z0-9_-]{16,3000})\.([A-Za-z0-9_-]{43})$/

export interface ClientRegistration {
  v: 1
  /** 16 base62 characters: two registrations with the same metadata are different clients. */
  n: string
  /** Issued at, Unix seconds. */
  iat: number
  /** As the client gave it: untrusted text, shown cleaned and marked unverified. */
  name: string
  /** Exact redirect URIs: https, or http on localhost, 127.0.0.1 or [::1]; no fragment, no user info. */
  uris: string[]
}

// ---- what a person sees ----

export interface OAuthActor {
  subject: string
  kind: 'user' | 'agent' | 'key' | 'system'
  name: string | null
}

export type GrantStatus = 'live' | 'suspended' | 'revoked' | 'expired'

/** A grant as the control API shows it (`GET /api/v1/control/oauth/grants`). No credential and no hash. */
export interface OAuthGrantView {
  id: string
  status: GrantStatus
  client: { name: string; redirectUris: string[]; registeredAt: string }
  scopes: OAuthScope[]
  /** The audience: the resource the tokens are for. */
  resource: string
  approvedBy: OAuthActor
  createdAt: string
  expiresAt: string
  lastUsedAt: string | null
  /** The agent key the resource acts with downstream: id and name (`oauth:<grantId>`). */
  key: { id: string; name: string } | null
  revokedAt: string | null
  revokedBy: OAuthActor | null
  /** person, client, code-reuse, refresh-reuse, not-exchanged, idle, expired. */
  revokeReason: string | null
}

// ---- the RPCs (over the Tenant Durable Object binding, by script_name, like control.ts) ----

/** The token endpoint's form, as received (RFC 6749 §4.1.3, §6; RFC 8707). */
export interface TokenRequest {
  grant_type: string
  client_id: string
  code?: string
  redirect_uri?: string
  code_verifier?: string
  refresh_token?: string
  resource?: string
  scope?: string
}

export type TokenErrorCode = 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'invalid_scope' | 'invalid_target' | 'unsupported_grant_type'

export type TokenResult =
  | {
      v: 1
      status: 'ok'
      tokens: { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string }
    }
  /** The description never contains a credential. */
  | { v: 1; status: 'error'; error: TokenErrorCode; description: string }
  | { v: 1; status: 'not_provisioned' }
  | SchemaTooNew

export type InactiveReason = 'unknown' | 'expired' | 'revoked' | 'suspended' | 'audience'

export type IntrospectionResult =
  | {
      v: 1
      status: 'active'
      tenant: string
      grant: string
      clientName: string
      /** As control's `whoami` names the grant's key: `key:<id>`. */
      subject: string
      kind: 'agent'
      /** The key's name, `oauth:<grantId>`. */
      name: string
      scopes: OAuthScope[]
      /** As `whoami`'s: whether direct dashboard writes take effect for this identity. */
      mayApply: boolean
      /** The access token's expiry, Unix ms. */
      expiresAt: number
      /**
       * `viz_<keyId>_<secret>`: the grant's key, for the resource's own calls to the query
       * service, the control plane and the ruler. Never returned to a client, never logged.
       */
      credential: string
    }
  | { v: 1; status: 'inactive'; reason: InactiveReason }
  | { v: 1; status: 'not_provisioned' }
  | SchemaTooNew

export type RevokeResult = { v: 1; status: 'ok' } | { v: 1; status: 'not_provisioned' } | SchemaTooNew

export interface TenantOAuthRpc {
  /** The token endpoint, for the tenant the presented code or refresh token names. */
  oauthToken(tenant: string, req: TokenRequest): Promise<TokenResult>
  /** RFC 7009. An access token ends; a refresh token ends its grant. Unknown tokens are not an error. */
  oauthRevoke(tenant: string, token: string, clientId: string): Promise<RevokeResult>
  /** For the resource: is this access token live, for this resource, and who is it. */
  introspectAccessToken(tenant: string, token: string, resource: string): Promise<IntrospectionResult>
}
