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
 *   A grant follows its approver's key: suspended while it is disabled, ended once it is deleted.
 *   Until a person (`user`) can be checked the same way, the check fails closed: an approver whose
 *   subject is not `key:<id>` is refused at approval, and a grant recorded with one is ended.
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
  /**
   * Refresh tokens issued per grant in any 60 s (the code exchange's included), counted exactly in
   * the tenant's object (D70). Over it, `/oauth/token` refuses a refresh with `rate_limited` before
   * the presented token is spent: a client stuck in a refresh loop writes at most this many times a
   * minute, from any number of Cloudflare locations.
   */
  refreshesPerGrantPerMinute: 6,
} as const

/**
 * Refused by a rate limit before the tenant's object was asked (D70): retryable, nothing was
 * written, and a credential presented with the request is not spent. `retryAfterMs`: when to try
 * again. Added 2026-11-19 within version 1 of `TokenResult` and `OAuthIntrospectionResult`
 * (COMPATIBILITY.md §4, "new statuses that callers already fail closed on": control's own Worker
 * reads the first; the agent surface answers a status it does not know with a retryable 503).
 */
export interface RateLimited {
  v: 1
  status: 'rate_limited'
  retryAfterMs: number
}

// ---- credentials ----

/**
 * `<prefix>1.<tenant>.<secret>`: the secret is 43 base62 characters (`BASE62`). The tenant is
 * `contracts/ledger.ts` TENANT_ID, which has no `.`. Format version 1 is the `1` in the prefix.
 *
 * The 43 characters are a `CREDENTIAL_TAG.randomChars`-character body followed by a
 * `CREDENTIAL_TAG.tagChars`-character tag: the first 16 bytes of HMAC-SHA-256, under a key derived
 * (HKDF-SHA-256, salt `CREDENTIAL_TAG.salt`) from control's `OAUTH_CLIENT_KEY`, of
 * `<prefix>1.<tenant>.<body>`, each byte as `BASE62[byte % 62]`. The tag lets control refuse a
 * made-up credential in the Worker, before the tenant's object is asked (review of D44, M-2); it
 * does not make a credential valid: only the tenant's object, which holds the SHA-256 of the whole
 * credential, says that. Replacing `OAUTH_CLIENT_KEY` therefore ends every code and token too (a
 * client connects again). Added 2026-11-19, before any release issued a credential.
 *
 * The body has two layouts. Every reader of version 1 reads both, because the shape and the tag
 * are the same: a reader that does not know layout 2 sees 27 opaque characters, as before.
 * - **Layout 1** (issued by releases before the review of D70): 27 characters from a CSPRNG.
 * - **Layout 2** (`CREDENTIAL_LAYOUT`, issued since the review of D70, B-1, 2026-11-19): the marker
 *   `e`, the credential's expiry in 4 characters, and 22 characters from a CSPRNG (about 131 bits;
 *   with the tag, which only `OAUTH_CLIENT_KEY` can make, this is what makes the credential
 *   unguessable). The expiry is whole minutes since `CREDENTIAL_LAYOUT.expiryEpochMs`, rounded
 *   up, base62 with the most significant character first (good until 2054-12): the moment the
 *   tenant's object stops accepting the credential, or a little later, never earlier. The tag
 *   covers it, so the Worker can refuse a credential past its expiry before any limit counts it
 *   and before any object is asked (`credentialExpiresAt`; D70).
 * A layout 1 body begins with `e` one time in 62 and is then read as layout 2 with an expiry
 * uniform over 28 years; layout 1 credentials live 30 days at most, so in the month after the
 * change about 1 in 13,000 of them could be read as expired early (none had been issued in
 * production when layout 2 began).
 */
export const OAUTH_CREDENTIAL = /^(vzc|vza|vzr)1\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9]{43})$/
export const CREDENTIAL_PREFIX = { code: 'vzc1', access: 'vza1', refresh: 'vzr1' } as const
/** `randomChars`: the body's length, the characters before the tag (named before layout 2 put more than randomness in it). */
export const CREDENTIAL_TAG = { randomChars: 27, tagChars: 16, salt: 'viz.oauth.credential-tag/v1' } as const
/** The order of base62 digits in a credential's tag and in layout 2's expiry. */
export const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
/** Layout 2 of a credential's body (above): marker, expiry, random characters; 1 + 4 + 22 = `CREDENTIAL_TAG.randomChars`. */
export const CREDENTIAL_LAYOUT = {
  marker: 'e',
  expiryChars: 4,
  /** 2026-11-01T00:00:00Z. */
  expiryEpochMs: 1_793_491_200_000,
  expiryUnitMs: 60_000,
  randomChars: 22,
} as const
export type CredentialKind = keyof typeof CREDENTIAL_PREFIX

export function parseCredential(s: string): { kind: CredentialKind; tenant: string } | null {
  const m = OAUTH_CREDENTIAL.exec(s)
  if (!m) return null
  const kind = m[1] === 'vzc' ? 'code' : m[1] === 'vza' ? 'access' : 'refresh'
  return { kind, tenant: m[2]! }
}

/**
 * When a layout 2 credential expires (Unix ms; the object's own expiry or up to a minute later), or
 * null for a layout 1 credential or a string that is not a credential. Read only after the tag has
 * been verified: the tag is what makes the expiry the issuer's.
 */
export function credentialExpiresAt(s: string): number | null {
  const m = OAUTH_CREDENTIAL.exec(s)
  if (!m || m[3]![0] !== CREDENTIAL_LAYOUT.marker) return null
  let v = 0
  for (const ch of m[3]!.slice(1, 1 + CREDENTIAL_LAYOUT.expiryChars)) v = v * 62 + BASE62.indexOf(ch)
  return CREDENTIAL_LAYOUT.expiryEpochMs + v * CREDENTIAL_LAYOUT.expiryUnitMs
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
  /** person, client, code-reuse, refresh-reuse, wrong-client, not-exchanged, idle, approver-gone, expired. */
  revokeReason: string | null
}

// ---- the RPCs on the Tenant object (control/ only: its Worker and its own entrypoints) ----

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
  /** A refresh over `OAUTH_LIMITS.refreshesPerGrantPerMinute` for its grant; the presented token is not spent. */
  | RateLimited
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

// ---- the resource's entrypoint: what the agent surface (mcp/) may ask control, and nothing else ----

/**
 * A named `WorkerEntrypoint` export of viz-control (added 2026-11-19, review of D44, M-1). The agent
 * surface binds it as a service binding naming the entrypoint, with its own name in `props`:
 *
 *   { "binding": "OAUTH", "service": "viz-control", "entrypoint": "OAuthIntrospection",
 *     "props": { "caller": "viz-mcp" } }
 *
 * It replaces the agent surface's binding to the `Tenant` Durable Object class, which could call
 * every method of every tenant's object (`invoke` with any identity, `provision`, `serviceKey`,
 * `notificationTarget`). This entrypoint does one thing: introspect an access token.
 *
 * - The tenant is the one the token names. There is no tenant argument: a caller cannot point the
 *   question at a tenant other than the token's, and the tenant's object still holds only the
 *   token's hash, so a token edited to name another tenant matches nothing there.
 * - A call whose `ctx.props.caller` is not in `OAUTH_INTROSPECTION_CALLERS` is answered
 *   `unauthorized` and reaches no object.
 * - A token that is not shaped like an access token, or does not carry this deployment's tag
 *   (`CREDENTIAL_TAG`), is `inactive` (`unknown`) and reaches no object.
 * - A token with the tag whose layout 2 expiry has passed (`credentialExpiresAt`) is `inactive`
 *   (`expired`) and reaches no object (D70).
 * - Results are `IntrospectionResult` (version 1, above) plus `unauthorized` and `rate_limited`
 *   (D70: too many introspections of this token, or of this token's tenant, in this Cloudflare
 *   location; checked after the tag and the expiry and before the tenant's object, so only a
 *   credential this deployment made, not yet expired, counts). Nothing throws for bad input.
 */
export const OAUTH_INTROSPECTION_ENTRYPOINT = 'OAuthIntrospection'

/** Callers allowed to introspect: the value of `props.caller` on their binding. */
export const OAUTH_INTROSPECTION_CALLERS: readonly string[] = ['viz-mcp']

/** What a caller's service binding carries in `props`. */
export interface OAuthIntrospectionProps {
  caller: string
}

export type OAuthIntrospectionResult = IntrospectionResult | { v: 1; status: 'unauthorized' } | RateLimited

export interface OAuthIntrospectionRpc {
  /** Is this access token live, for `resource` (the caller's own canonical URI), and who is it. Read only. */
  introspectAccessToken(token: string, resource: string): Promise<OAuthIntrospectionResult>
}
