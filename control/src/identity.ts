import { TENANT_ID } from '../../contracts/ledger'
import { authenticate } from '../../edge/src/auth'
import { HttpError } from '../../edge/src/errors'
import { Problem, schemaProblem } from './errors'
import { SCOPES } from './routes'
import type { Tenant } from './tenant'

/**
 * Who is calling. Handlers see only this; they never look at a request header.
 *
 * `identify` is the single place an Identity is made. Today the only implementation is
 * the API key. Sign-in (a signed session header from a future SSO layer) is added by
 * giving `identify` a second branch that returns `kind: 'user'`; no handler changes.
 */
export interface Identity {
  /** Always from the credential. Nothing in a path, query, header or body can set it. */
  tenant: string
  /** Stable id of the caller within the tenant, e.g. `key:k_…` or later `user:…`. */
  subject: string
  /** What the UI says: "by Dana" (user), "by an agent" (agent), "by key <name>" (key). */
  kind: 'user' | 'agent' | 'key'
  scopes: string[]
  /** Display name: the key's name, or later the person's. */
  name?: string
  /** Set for API-key identities; the Tenant object re-checks that the key is still live. */
  keyId?: string
}

export interface IdentityEnv {
  CONFIG: KVNamespace
  TENANT: DurableObjectNamespace<Tenant>
}

const unauthenticated = (detail: string): Problem =>
  new Problem(401, 'unauthenticated', detail, 'Send "Authorization: Bearer viz_<keyId>_<secret>" with a key that is enabled and not expired.', {}, { 'WWW-Authenticate': 'Bearer realm="viz"' })

/**
 * Edge's verifier proves possession of the secret against KV (edge/src/auth.ts, imported,
 * not copied). It insists on one of its own two scopes, so it is asked about each scope in
 * turn until one fits: see "Needed changes" in the README. The Tenant object then gives the
 * authoritative answer on whether the key is still live, and its kind, name and scopes, so
 * a revoked key stops working on this API at once, whatever KV or a cache still says.
 */
export async function identify(req: Request, env: IdentityEnv): Promise<Identity> {
  let principal: { tenant: string; keyId: string } | undefined
  for (const scope of SCOPES) {
    try {
      principal = await authenticate(req, env.CONFIG, scope as 'read')
      break
    } catch (e) {
      if (e instanceof HttpError && e.status === 403) continue
      if (e instanceof HttpError && e.status === 401) throw unauthenticated('The API key is missing, malformed, unknown, disabled or expired.')
      throw e
    }
  }
  if (!principal) throw new Problem(403, 'no-scopes', 'The API key has no scope this API knows.', 'Create a key with at least one of: ' + SCOPES.join(', ') + '.')
  if (!TENANT_ID.test(principal.tenant)) throw unauthenticated('The API key is not usable.')
  const tenant = env.TENANT.get(env.TENANT.idFromName(principal.tenant))
  const live = await tenant.resolveKey(principal.tenant, principal.keyId)
  if (!live) throw unauthenticated('The API key is missing, malformed, unknown, disabled or expired.')
  // The tenant's object is held by a newer release (contracts/COMPATIBILITY.md §2.4): not a "no", a "later".
  if ('status' in live) throw schemaProblem(live)
  return { tenant: principal.tenant, subject: live.subject, kind: live.kind, scopes: live.scopes, name: live.name, keyId: principal.keyId }
}

/** The part of an identity that is stored with what it did. */
export interface Actor {
  subject: string
  kind: 'user' | 'agent' | 'key' | 'system'
  name: string | null
}

export const actorOf = (id: Identity): Actor => ({ subject: id.subject, kind: id.kind, name: id.name ?? null })
