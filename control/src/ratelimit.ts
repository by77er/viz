import { OAUTH_LIMITS, type RateLimited } from '../../contracts/oauth'
import { sha256Hex } from '../../dashboard/src/index.ts'

/**
 * Rate limits in front of the OAuth endpoints and OAuth bearers (decision D70).
 *
 * The HMAC tag (review of D44, M-2) already keeps a made-up credential away from every tenant's
 * object. What is left is cost and abuse: floods of cheap requests, registration spam, a client
 * stuck in a refresh loop, and replays of credentials this deployment did make (a spent code, a
 * rotated or revoked token: the tag is still good on those, so each replay reaches its tenant's
 * object). Two layers:
 *
 * 1. **Approximate, before the object** (here): Cloudflare's Workers Rate Limiting binding. Its
 *    counters are per Cloudflare location and eventually consistent, its periods 10 or 60 s; a
 *    `limit()` call uses a locally cached count. Every binding here has a 60 s period
 *    (`RATE_PERIOD_S`); the limits themselves are the bindings' configuration
 *    (control/README.md, "Rate limits"). Keys:
 *    - `OAUTH_RL_SOURCE`, the client's network (`CF-Connecting-IP`: an IPv4 address, or an IPv6
 *      /64, which one subscriber usually holds whole), on `/oauth/register`, `/oauth/authorize`,
 *      `/oauth/token` and `/oauth/revoke`, before the body is read;
 *    - after the credential's tag is verified (so only a credential this deployment made counts,
 *      and a made-up one naming a tenant cannot spend that tenant's budget):
 *      `OAUTH_RL_CLIENT` per (tenant, `client_id`) at `/oauth/token`, then `OAUTH_RL_TENANT` per
 *      tenant at `/oauth/token` and `/oauth/revoke`; `OAUTH_RL_BEARER` per access token, then
 *      `OAUTH_RL_BEARER_TENANT` per tenant, at introspection (`OAuthIntrospection`). The narrower
 *      key is asked first and a refused call does not count, so one client's or token's flood
 *      spends at most its own allowance of its tenant's budget.
 * 2. **Exact, in the tenant's object**, where rows are written: refreshes per grant
 *    (`OAUTH_LIMITS.refreshesPerGrantPerMinute`, src/ops-oauth.ts) and the bounds D44 already had
 *    (approvals per hour, clients, live grants).
 *
 * **Every check here fails open**: a binding that is absent, throws, answers something that is not
 * `{ success: boolean }`, or has not answered within `CHECK_TIMEOUT_MS` lets the request through
 * (and logs). Why, per endpoint, is in D70; in short, these are approximate cost throttles, the
 * properties that matter are enforced elsewhere (the tag before any object, exact bounds on what is
 * stored inside it), and failing closed would turn a limiter fault into an OAuth outage for every
 * tenant: access tokens last an hour, so every agent would lose access. The deploy, not this code,
 * makes sure the bindings exist (control/README.md, "Needed changes elsewhere"). No key is longer
 * than about 100 characters and none is made from unbounded request text (client ids and tokens are
 * hashed), so no request can make `limit()` throw.
 *
 * A refusal changes nothing and spends nothing; it answers 429 with `Retry-After` (the period: the
 * binding does not say where in its window it is).
 */

export interface RateLimitEnv {
  /** Per client network, every limited OAuth endpoint, before the body is read. */
  OAUTH_RL_SOURCE?: RateLimit
  /** Per (tenant, client_id) of a tagged code or refresh token at `/oauth/token`, before the tenant's object. */
  OAUTH_RL_CLIENT?: RateLimit
  /** Per tenant of a tagged credential at `/oauth/token` and `/oauth/revoke`, before the tenant's object. */
  OAUTH_RL_TENANT?: RateLimit
  /** Per tagged access token at introspection, before the tenant's object. */
  OAUTH_RL_BEARER?: RateLimit
  /** Per tenant of a tagged access token at introspection, before the tenant's object. */
  OAUTH_RL_BEARER_TENANT?: RateLimit
}

export type LimitName = keyof RateLimitEnv

/** Every binding's period, in seconds. The deploy configures each with `"period": 60`. */
export const RATE_PERIOD_S = 60

/** How long a `limit()` call may take before the check counts as failed (and the request goes on). */
export const CHECK_TIMEOUT_MS = 1_000

/** What a check found. `unchecked`: the limiter was absent or failed, and the request goes on (fails open). */
export type Verdict = 'allowed' | 'refused' | 'unchecked'

/** Ask one binding about one key. Never throws. */
export async function check(env: RateLimitEnv, name: LimitName, key: string): Promise<Verdict> {
  const binding = env[name]
  if (binding === undefined || binding === null || typeof (binding as Partial<RateLimit>).limit !== 'function') return 'unchecked'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome: unknown = await Promise.race([
      binding.limit({ key }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${CHECK_TIMEOUT_MS} ms`)), CHECK_TIMEOUT_MS)
      }),
    ])
    const success = typeof outcome === 'object' && outcome !== null ? (outcome as { success?: unknown }).success : undefined
    if (typeof success !== 'boolean') throw new Error('an answer without a boolean "success"')
    return success ? 'allowed' : 'refused'
  } catch (e) {
    // Fails open, deliberately (above). The key is not logged: it can hold an address.
    console.error(`control: rate limiter ${name} failed; the request was served without it`, e instanceof Error ? e.message : 'error')
    return 'unchecked'
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Ask the bindings in order, stopping at the first refusal (a refused call does not count, so later keys are not spent). Null when allowed. */
async function firstRefusal(env: RateLimitEnv, checks: [LimitName, string][]): Promise<LimitName | null> {
  for (const [name, key] of checks) if ((await check(env, name, key)) === 'refused') return name
  return null
}

// ---- keys ----

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function v4(s: string): string | null {
  const m = V4.exec(s)
  if (!m) return null
  const octets = m.slice(1).map(Number)
  return octets.every((o) => o <= 255) ? octets.join('.') : null
}

/** The eight 16-bit groups of an IPv6 address, or null. Parsed by the URL parser, then expanded. */
function v6(s: string): number[] | null {
  if (s.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(s) || !s.includes(':')) return null
  let host: string
  try {
    host = new URL(`http://[${s}]/`).hostname
  } catch {
    return null
  }
  // Serialised compressed, lower case, without a dotted quad (WHATWG URL): "[2001:db8::1]".
  const inner = host.slice(1, -1)
  const [head, tail] = inner.includes('::') ? inner.split('::') as [string, string] : [inner, null]
  const part = (x: string) => (x === '' ? [] : x.split(':').map((h) => parseInt(h, 16)))
  const left = part(head)
  const right = tail === null ? [] : part(tail)
  const groups = tail === null ? left : [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right]
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null
}

/**
 * The network a request comes from, as the source limit counts it: an IPv4 address as is; an IPv6
 * address by its /64 (one subscriber's usual allocation, so stepping through it does not reset the
 * count); an IPv4-mapped IPv6 address as the IPv4 address. From `CF-Connecting-IP`, which
 * Cloudflare sets on the request the gateway receives and the gateway forwards unchanged
 * (deploy/gateway/src/index.ts `forward`); viz-control has no public route of its own. A request
 * without it, or with one that is not an address, counts against one shared key (`none`,
 * `unparsed`): never a key the request can choose.
 */
export function sourceNetwork(header: string | null): string {
  if (header === null) return 'none'
  const s = header.trim()
  const four = v4(s)
  if (four) return `v4:${four}`
  const g = v6(s)
  if (!g) return 'unparsed'
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `v4:${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`
  return `v6:${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`
}

/** A fixed-length key for text a request supplies (a client id is up to about 3,000 characters). */
const digest = (s: string): string => sha256Hex(s).slice(0, 32)

// ---- what the endpoints call ----

export interface Refusal {
  limit: LimitName
  retryAfterS: number
  /** Said to the caller: which budget is spent, never a key. */
  why: string
}

const WHY: Record<LimitName, string> = {
  OAUTH_RL_SOURCE: 'Too many requests to the OAuth endpoints from your network.',
  OAUTH_RL_CLIENT: 'Too many token requests from this client for this tenant.',
  OAUTH_RL_TENANT: 'Too many token and revocation requests for this tenant.',
  OAUTH_RL_BEARER: 'Too many requests with this access token.',
  OAUTH_RL_BEARER_TENANT: 'Too many requests with this tenant\'s access tokens.',
}

const refusal = (name: LimitName | null): Refusal | null => (name === null ? null : { limit: name, retryAfterS: RATE_PERIOD_S, why: WHY[name] })

/** Every limited OAuth endpoint, first thing: the client's network. */
export const limitSource = async (env: RateLimitEnv, req: Request): Promise<Refusal | null> =>
  refusal(await firstRefusal(env, [['OAUTH_RL_SOURCE', `s:${sourceNetwork(req.headers.get('CF-Connecting-IP'))}`]]))

/** `/oauth/token`, after the credential's tag: this client in this tenant, then the tenant. */
export const limitToken = async (env: RateLimitEnv, tenant: string, clientId: string): Promise<Refusal | null> =>
  refusal(await firstRefusal(env, [['OAUTH_RL_CLIENT', `c:${tenant}:${digest(clientId)}`], ['OAUTH_RL_TENANT', `t:${tenant}`]]))

/** `/oauth/revoke`, after the token's tag: the tenant (with the token endpoint's requests). */
export const limitRevoke = async (env: RateLimitEnv, tenant: string): Promise<Refusal | null> => refusal(await firstRefusal(env, [['OAUTH_RL_TENANT', `t:${tenant}`]]))

/** Introspection, after the token's tag: this token, then its tenant. */
export async function limitBearer(env: RateLimitEnv, tenant: string, token: string): Promise<RateLimited | null> {
  const r = refusal(await firstRefusal(env, [['OAUTH_RL_BEARER', `b:${digest(token)}`], ['OAUTH_RL_BEARER_TENANT', `bt:${tenant}`]]))
  return r === null ? null : { v: 1, status: 'rate_limited', retryAfterMs: r.retryAfterS * 1000 }
}

/** The exact limit's window, for src/ops-oauth.ts. */
export const REFRESH_WINDOW_MS = 60_000
export const REFRESHES_PER_WINDOW = OAUTH_LIMITS.refreshesPerGrantPerMinute
