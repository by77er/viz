import { TENANT_ID } from '../../contracts/ledger'
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
 * keys carry their own kind; a credential with no kind (control unreachable, or a key
 * control does not know the scopes of) is an `agent`, the most restricted kind.
 *
 * OAuth seam: an OAuth branch (Client ID Metadata Documents, workers-oauth-provider) goes
 * here and returns the same `Identity`, mapping the grant to tenant, subject, kind and
 * scopes. Nothing downstream changes. It is not built.
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
  /** Where `kind` and `scopes` came from. */
  source: 'control' | 'edge'
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
    const b = who.body as { tenant?: unknown; subject?: unknown; kind?: unknown; name?: unknown; scopes?: unknown } | null
    if (who.status === 200 && b && b.tenant === principal.tenant && typeof b.subject === 'string' && Array.isArray(b.scopes)) {
      const kind = b.kind === 'key' || b.kind === 'user' ? b.kind : 'agent'
      return { ...base, subject: b.subject, kind, name: typeof b.name === 'string' ? b.name : null, scopes: b.scopes.map(String), source: 'control' }
    }
    if (who.status === 401) throw unauthenticated('The API key is disabled, expired or deleted.')
    // 403 `no-scopes`: a key whose scopes the control plane does not know (e.g. only
    // `monitors:read`); anything else: the control plane is unavailable. Either way the key is
    // valid at edge, so read with edge's scopes as the most restricted kind.
  }
  return { ...base, subject: `key:${principal.keyId}`, kind: 'agent', name: null, scopes: principal.scopes, source: 'edge' }
}

/** True when `id` holds every scope in `all`. `admin` is not honoured here: agents get explicit scopes. */
export const hasScopes = (id: Identity, all: readonly string[]): boolean => all.every((s) => id.scopes.includes(s))
