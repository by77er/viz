import { TENANT_ID } from '../../contracts/ledger'
import { type OAuthIntrospectionRpc, OAUTH_VERSION, parseCredential } from '../../contracts/oauth'
import { authenticate } from '../../edge/src/auth'
import { HttpError } from '../../edge/src/errors'
import type { ControlClient } from './clients'

/**
 * Who is calling. `identify` is the only place an identity is made; tools see nothing else
 * of the request's credentials.
 *
 * Today the credential is an API key, `viz_<keyId>_<secret>`, sent as a Bearer token:
 * 1. edge's verifier (`edge/src/auth.ts`, imported, not copied) proves possession of the
 *    secret against KV and yields the tenant. The tenant is the key record's and nothing
 *    else: no header, path, query parameter or tool argument is ever read for it.
 * 2. the control plane's `whoami`, called with the same credential, gives the
 *    authoritative answer: still live, kind (`agent` or `key`), name and scopes. A revoked
 *    key therefore stops here at once, whatever edge's 60 s cache says.
 *
 * Kind: identities through this surface are `agent` unless the key says otherwise. Control
 * keys carry their own kind; a credential with no kind (control unreachable, or a control
 * release that does not know the key's scopes) is an `agent`, the most restricted kind.
 *
 * mayApply: the control plane's own answer to "would this caller's direct dashboard write
 * take effect?" (`whoami`), so `write_dashboard` needs no dry run to find out. Null when the
 * answer did not come (edge fallback, or a control release from before the field); callers
 * treat null as "no".
 *
 * OAuth (decision D44, contracts/oauth.ts): a Bearer token `vza1.<tenant>.<secret>` is an access
 * token the control plane issued to an MCP client a person approved. `identifyOAuth` asks control's
 * `OAuthIntrospection` entrypoint (service binding `OAUTH`, contracts/oauth.ts) whether it is live
 * and issued for THIS resource (audience), on every request, so a revoked or expired token stops at
 * once. That entrypoint is all this Worker can ask control besides its HTTP API with a caller's own
 * key: it holds no binding to control's Tenant objects (review of D44, M-1). The answer is the same `Identity` (kind `agent`, the grant's scopes) plus the grant's own
 * agent key, which is what the downstream calls carry: the client's token never leaves this
 * Worker (MCP "Token Passthrough"). The token is accepted at /mcp only; the JSON surface refuses it.
 */

/** The scopes this surface understands. `admin` is deliberately not among them. */
export const SCOPES = ['read', 'dashboards:read', 'dashboards:write', 'dashboards:apply', 'monitors:read'] as const
export type Scope = (typeof SCOPES)[number]

/** Edge's verifier insists on one scope; asking for these in turn verifies any viz key. */
const VERIFY_AS = [...SCOPES, 'admin', 'write', 'monitors:write', 'monitors:ack']

export interface Identity {
  tenant: string
  keyId: string
  subject: string
  kind: 'agent' | 'key' | 'user'
  name: string | null
  scopes: string[]
  /** Whether direct dashboard writes by this caller take effect, as the control plane says; null when it did not say. */
  mayApply: boolean | null
  /** Where `kind` and `scopes` came from. */
  source: 'control' | 'edge' | 'oauth'
  /** OAuth only: the grant, and the client's own (unverified) name for itself. */
  grant?: string
  client?: string
}

/** Who is calling, and the Authorization header value every downstream call carries for them. */
export interface Caller {
  id: Identity
  /** For an API key, the request's own header. For an OAuth token, the grant's key: never the token. */
  downstream: string
}

export class AuthError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 503,
    readonly code: string,
    message: string,
    readonly fix: string,
  ) {
    super(message)
  }
}

const unauthenticated = (msg: string): AuthError =>
  new AuthError(401, 'unauthenticated', msg, 'Send "Authorization: Bearer viz_<keyId>_<secret>" with a key that is enabled and not expired.')

export interface AuthEnv {
  CONFIG: KVNamespace
  /** control's OAuthIntrospection entrypoint (contracts/oauth.ts): introspection of OAuth access tokens, and nothing else. */
  OAUTH?: OAuthIntrospectionRpc
}

/** The access token in `Authorization: Bearer …`, if what is there is shaped like an OAuth credential (of any kind). */
export function presentedOAuth(req: Request): { token: string; kind: 'code' | 'access' | 'refresh'; tenant: string } | null {
  const m = /^Bearer[ ]+(\S+)[ ]*$/i.exec(req.headers.get('Authorization') ?? '')
  const parsed = m ? parseCredential(m[1]!) : null
  return parsed ? { token: m![1]!, ...parsed } : null
}

const invalidToken = (msg: string): AuthError => new AuthError(401, 'invalid-token', msg, 'Get a new access token: refresh it, or connect the application again so a person approves it.')

const INACTIVE: Record<string, string> = {
  unknown: 'The access token is unknown, revoked or replaced.',
  expired: 'The access token has expired.',
  revoked: 'The access token\'s grant was revoked.',
  suspended: 'The access token\'s grant is suspended (its key is disabled).',
  audience: 'The access token was issued for another resource.',
}

/**
 * An OAuth access token, checked by the control plane for `resource`. Throws `AuthError`.
 * Control takes the tenant from the token itself; its object holds only the token's hash, so a
 * token edited to name another tenant matches nothing there.
 */
export async function identifyOAuth(presented: { token: string; kind: string; tenant: string }, env: AuthEnv, resource: string): Promise<Caller> {
  if (presented.kind !== 'access') throw invalidToken('That is not an access token: send the access_token from the token endpoint.')
  if (!env.OAUTH) throw new AuthError(503, 'oauth-unavailable', 'OAuth tokens cannot be checked on this deployment (no OAUTH binding).', 'Use an API key, or ask the operator to bind control\'s OAuthIntrospection entrypoint.')
  const result = await env.OAUTH.introspectAccessToken(presented.token, resource)
  // A plain copy; the RPC result itself is released (workerd attaches a disposer to object results).
  const r = typeof result === 'object' && result !== null ? { ...result } : result
  const dispose = typeof result === 'object' && result !== null ? (result as { [Symbol.dispose]?: () => void })[Symbol.dispose] : undefined
  if (typeof dispose === 'function') dispose.call(result)
  // This Worker is not a caller control's entrypoint allows: a deployment fault, not the token's.
  if (r?.status === 'unauthorized') throw new AuthError(503, 'oauth-unavailable', 'OAuth tokens cannot be checked on this deployment (the control plane does not accept this Worker as a caller).', 'Use an API key, or ask the operator to fix the OAUTH binding\'s props.')
  if (r?.status === 'schema_too_new') throw new AuthError(503, 'unavailable', 'A deployment is in progress; the token could not be checked.', `Retry in ${Math.ceil(r.retryAfterMs / 1000)} s.`)
  // contracts/COMPATIBILITY.md §3.2: a result version this code does not know is refused, not guessed.
  if (!r || r.v !== OAUTH_VERSION) throw new AuthError(503, 'unavailable', 'The control plane answered in a form this release does not read.', 'Retry in a moment.')
  if (r.status === 'not_provisioned') throw invalidToken(INACTIVE.unknown!)
  if (r.status === 'inactive') throw invalidToken(INACTIVE[r.reason] ?? INACTIVE.unknown!)
  if (r.status !== 'active') throw new AuthError(503, 'unavailable', 'The control plane gave an answer this release does not know.', 'Retry in a moment.')
  const key = /^viz_([A-Za-z0-9]{1,64})_[A-Za-z0-9]{8,256}$/.exec(r.credential)
  if (r.tenant !== presented.tenant || !TENANT_ID.test(r.tenant) || !key) throw invalidToken(INACTIVE.unknown!)
  return {
    id: { tenant: r.tenant, keyId: key[1]!, subject: r.subject, kind: 'agent', name: r.name, scopes: [...r.scopes], mayApply: r.mayApply, source: 'oauth', grant: r.grant, client: r.clientName },
    downstream: `Bearer ${r.credential}`,
  }
}

export async function identify(req: Request, env: AuthEnv, control: ((authorization: string) => ControlClient) | null): Promise<Identity> {
  const authorization = req.headers.get('Authorization')
  if (!authorization) throw unauthenticated('No credential was sent.')
  let principal: { tenant: string; keyId: string; scopes: string[] } | undefined
  for (const scope of VERIFY_AS) {
    try {
      principal = await authenticate(req, env.CONFIG, scope as 'read')
      break
    } catch (e) {
      if (e instanceof HttpError && e.status === 403) continue
      if (e instanceof HttpError && e.status === 401) throw unauthenticated('The API key is missing, malformed, unknown, disabled or expired.')
      throw e
    }
  }
  if (!principal) throw new AuthError(403, 'no-scopes', 'The API key has no scope this surface knows.', `Use a key with at least one of: ${SCOPES.join(', ')}.`)
  if (!TENANT_ID.test(principal.tenant)) throw unauthenticated('The API key is not usable.')

  const base = { tenant: principal.tenant, keyId: principal.keyId }
  if (control) {
    const who = await control(authorization).call('GET', '/whoami')
    const b = who.body as { tenant?: unknown; subject?: unknown; kind?: unknown; name?: unknown; scopes?: unknown; mayApply?: unknown } | null
    if (who.status === 200 && b && b.tenant === principal.tenant && typeof b.subject === 'string' && Array.isArray(b.scopes)) {
      const kind = b.kind === 'key' || b.kind === 'user' ? b.kind : 'agent'
      const mayApply = typeof b.mayApply === 'boolean' ? b.mayApply : null
      return { ...base, subject: b.subject, kind, name: typeof b.name === 'string' ? b.name : null, scopes: b.scopes.map(String), mayApply, source: 'control' }
    }
    if (who.status === 401) throw unauthenticated('The API key is disabled, expired or deleted.')
    // 403 `no-scopes`: a control release that knows none of the key's scopes (the control
    // plane issues every scope this surface checks, so only an older release during a deploy);
    // anything else: the control plane is unavailable. Either way the key is valid at edge, so
    // read with edge's scopes as the most restricted kind, which may not apply.
  }
  return { ...base, subject: `key:${principal.keyId}`, kind: 'agent', name: null, scopes: principal.scopes, mayApply: null, source: 'edge' }
}

/**
 * The dashboards scopes include each other as control's do (`control/src/routes.ts` D_READ,
 * D_WRITE): `dashboards:apply` ⊇ `dashboards:write` ⊇ `dashboards:read` (MCP 2026-07-28, Step-Up
 * Authorization Flow: servers account for scope hierarchies; review of D44, m-6).
 */
const IMPLIED: Record<string, readonly string[]> = {
  'dashboards:read': ['dashboards:read', 'dashboards:write', 'dashboards:apply'],
  'dashboards:write': ['dashboards:write', 'dashboards:apply'],
}

/** True when `id` holds every scope in `all`, or one that includes it. `admin` is not honoured here: agents get explicit scopes. */
export const hasScopes = (id: Identity, all: readonly string[]): boolean => all.every((s) => (IMPLIED[s] ?? [s]).some((x) => id.scopes.includes(x)))
