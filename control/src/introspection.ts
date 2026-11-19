import { WorkerEntrypoint } from 'cloudflare:workers'
import {
  OAUTH_INTROSPECTION_CALLERS,
  type OAuthIntrospectionProps,
  type OAuthIntrospectionResult,
  type OAuthIntrospectionRpc,
  type TenantOAuthRpc,
  parseCredential,
} from '../../contracts/oauth'
import { type OAuthEnv, credentialExpired, credentialTagValid, oauthConfig } from './oauth'
import { type RateLimitEnv, limitBearer } from './ratelimit'
import type { Tenant } from './tenant'

/**
 * What the agent surface (mcp/) may ask the control plane, and nothing else: is this OAuth access
 * token live, for this resource, and who is it (contracts/oauth.ts `OAuthIntrospectionRpc`;
 * review of D44, M-1).
 *
 * The agent surface used to bind control's `Tenant` Durable Object class to ask this. A class
 * binding cannot be narrowed: its holder can call every method of every tenant's object, including
 * `invoke` with an identity it makes up. This entrypoint holds that binding instead, inside
 * control, and offers one method:
 *
 * - the caller is the binding's `props.caller`, which only the caller's deployed config sets; any
 *   other is `unauthorized` and reaches no object;
 * - the tenant is the one the token names: there is no tenant argument;
 * - a token not shaped like an access token, or without this deployment's tag, is `inactive` and
 *   reaches no object (M-2);
 * - a tagged token past the expiry its body carries (layout 2, contracts/oauth.ts) is `inactive`
 *   (`expired`) and reaches no object, and counts against nothing (D70, review B-1);
 * - any other tagged token is counted against itself, then against its tenant (src/ratelimit.ts,
 *   D70), before the tenant's object is asked: over either, `rate_limited` and no object. A made-up
 *   or expired token is refused before it counts, so it cannot spend a tenant's budget, and one
 *   token spends at most its own allowance of it.
 */

export interface IntrospectionEnv extends OAuthEnv, RateLimitEnv {
  TENANT: DurableObjectNamespace<Tenant>
}

const unknown: OAuthIntrospectionResult = { v: 1, status: 'inactive', reason: 'unknown' }
const expired: OAuthIntrospectionResult = { v: 1, status: 'inactive', reason: 'expired' }

/** The entrypoint's logic, apart from the class so the tests can give it any caller. */
export async function introspectFor(env: IntrospectionEnv, caller: unknown, token: unknown, resource: unknown): Promise<OAuthIntrospectionResult> {
  if (typeof caller !== 'string' || !OAUTH_INTROSPECTION_CALLERS.includes(caller)) return { v: 1, status: 'unauthorized' }
  const cred = typeof token === 'string' ? parseCredential(token) : null
  if (!cred || cred.kind !== 'access' || typeof resource !== 'string') return unknown
  if (!(await credentialTagValid(oauthConfig(env).clientKey, token))) return unknown
  // Past the expiry the tag vouches for: the object would say the same (D70).
  if (credentialExpired(token as string)) return expired
  const limited = await limitBearer(env, cred.tenant, token as string)
  if (limited) return limited
  // The one place this picks a tenant's object: the tenant the token names.
  const stub = env.TENANT.get(env.TENANT.idFromName(cred.tenant)) as unknown as TenantOAuthRpc
  const r = await stub.introspectAccessToken(cred.tenant, token as string, resource)
  // A plain copy for the caller; the RPC result itself is released here.
  const out = { ...r }
  disposeRpc(r)
  return out
}

/** Release an RPC result (workerd attaches a disposer to results that are objects). */
export function disposeRpc(r: unknown): void {
  const sym = (Symbol as unknown as { dispose?: symbol }).dispose
  const dispose = sym !== undefined && typeof r === 'object' && r !== null ? (r as Record<symbol, unknown>)[sym] : undefined
  if (typeof dispose === 'function') (dispose as () => void).call(r)
}

/** A named export of viz-control's main module, bound by the agent surface (mcp/wrangler.jsonc `OAUTH`). */
export class OAuthIntrospection extends WorkerEntrypoint<IntrospectionEnv> implements OAuthIntrospectionRpc {
  async introspectAccessToken(token: string, resource: string): Promise<OAuthIntrospectionResult> {
    const props = (this.ctx as { props?: Partial<OAuthIntrospectionProps> }).props
    return introspectFor(this.env, props?.caller, token, resource)
  }
}
