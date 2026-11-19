import { OAUTH_LIMITS, type RateLimited } from '../../contracts/oauth'
import { sha256Hex } from '../../dashboard/src/index.ts'

/**
 * Rate limits in front of the OAuth endpoints and OAuth bearers (decision D70, as rewritten after
 * its review, design/reviews/d70-rate-limits.md).
 *
 * The HMAC tag (review of D44, M-2) already keeps a made-up credential away from every tenant's
 * object, and a credential's layout 2 expiry (contracts/oauth.ts) lets the Worker refuse one past it
 * before anything counts it. What is left is cost and abuse: floods of cheap requests,
 * registration spam, a client stuck in a refresh loop, and replays of credentials this deployment
 * did make and that have not expired yet (a spent code, a rotated or revoked token: their tag is
 * good, so each replay reaches its tenant's object). Two layers:
 *
 * 1. **Approximate, before the object** (here): Cloudflare's Workers Rate Limiting binding. Its
 *    counters are per Cloudflare location and eventually consistent, its periods 10 or 60 s; a
 *    `limit()` call uses a locally cached count. Every binding here has a 60 s period
 *    (`RATE_PERIOD_S`); the limits themselves are the bindings' configuration
 *    (control/README.md, "Rate limits"). Keys, narrowest first:
 *    - `OAUTH_RL_SOURCE` and `OAUTH_RL_SOURCE_48`, the client's network (`CF-Connecting-IP`: an
 *      IPv4 address, or an IPv6 /64 and then its /48), on `/oauth/register` and `/oauth/authorize`
 *      before the body is read, and on `/oauth/token` and `/oauth/revoke` only for a request the
 *      Worker refuses by itself (no credential with the tag, or one past its expiry): a genuine
 *      credential is never counted by where it comes from (review M-1: every client hosted on
 *      Cloudflare Workers arrives from one address, `WORKERS_EGRESS`, which is not counted at all);
 *    - `OAUTH_RL_CREDENTIAL`, the presented code or token itself, at `/oauth/token` and
 *      `/oauth/revoke`, then `OAUTH_RL_TENANT`, its tenant; `OAUTH_RL_BEARER`, the access token,
 *      then `OAUTH_RL_BEARER_TENANT`, its tenant, at introspection (`OAuthIntrospection`). Only
 *      after the tag and the expiry, so only a credential this deployment made and that has not
 *      expired counts. Each credential spends only its own allowance, and of its tenant's no more
 *      than that: the tenant keys are fuses set near what one object serves, which a client
 *      cannot reach with its own credentials, and which take that fuse divided by the
 *      per-credential limit distinct unexpired credentials to spend (review B-1).
 * 2. **Exact, in the tenant's object**, where rows are written: refreshes per grant
 *    (`OAUTH_LIMITS.refreshesPerGrantPerMinute`, src/ops-oauth.ts) and the bounds D44 already had
 *    (approvals per hour, clients, live grants).
 *
 * **Every check here fails open**: a binding that is absent, throws, answers something that is not
 * `{ success: boolean }`, or has not answered within what is left of the request's
 * `CHECK_BUDGET_MS` lets the request through. A binding that failed is not asked again in this
 * isolate for `SKIP_AFTER_FAILURE_MS`, so a limiter brownout costs one request in each isolate at
 * most `CHECK_BUDGET_MS` that often (review m-1). An absent or failing binding is logged once per
 * isolate (`control: rate limiter …`), never per request, and `/healthz` says which are bound
 * (`limiterStatus`). Why fail open, per endpoint, is in D70; in short, these are approximate cost
 * throttles, the properties that matter are enforced elsewhere (the tag and the expiry before any
 * object, exact bounds on what is stored inside it), and failing closed would turn a limiter fault
 * into an OAuth outage for every tenant. The deploy, not this code, makes sure the bindings exist
 * (control/README.md, "Needed changes elsewhere"). No key is longer than about 100 characters and
 * none is made from unbounded request text (credentials are hashed), so no request can make
 * `limit()` throw.
 *
 * A refusal changes nothing in the tenant's object and spends no credential; it answers 429 with
 * `Retry-After` (the period: the binding does not say where in its window it is). The narrower
 * keys asked before the one that refused have counted the request.
 */

export interface RateLimitEnv {
  /** Per client network (IPv4 address, IPv6 /64): register and authorize, and token or revoke requests the Worker refuses by itself. */
  OAUTH_RL_SOURCE?: RateLimit
  /** Per IPv6 /48, after the /64, in the same places: one host with a routed /48 holds 65,536 /64s (review m-6). */
  OAUTH_RL_SOURCE_48?: RateLimit
  /** Per presented code or token, tagged and not expired, at `/oauth/token` and `/oauth/revoke`, before the tenant's object. */
  OAUTH_RL_CREDENTIAL?: RateLimit
  /** Per tenant of such a credential at `/oauth/token` and `/oauth/revoke`, after the credential: a fuse near one object's capacity. */
  OAUTH_RL_TENANT?: RateLimit
  /** Per tagged, unexpired access token at introspection, before the tenant's object. */
  OAUTH_RL_BEARER?: RateLimit
  /** Per tenant of such an access token at introspection, after the token: a fuse near one object's capacity. */
  OAUTH_RL_BEARER_TENANT?: RateLimit
}

export type LimitName = keyof RateLimitEnv

/** Every limiter this Worker asks, in the order `/healthz` lists them. */
export const LIMITERS: readonly LimitName[] = ['OAUTH_RL_SOURCE', 'OAUTH_RL_SOURCE_48', 'OAUTH_RL_CREDENTIAL', 'OAUTH_RL_TENANT', 'OAUTH_RL_BEARER', 'OAUTH_RL_BEARER_TENANT']

/** Every binding's period, in seconds. The deploy configures each with `"period": 60`. */
export const RATE_PERIOD_S = 60

/** How long all of one request's limiter checks may take together before the rest are skipped (the request goes on). */
export const CHECK_BUDGET_MS = 100

/** How long this isolate skips a binding after it failed (threw, rejected, answered without `success`, or ran out of time). */
export const SKIP_AFTER_FAILURE_MS = 10_000

/** What a check found. `unchecked`: the limiter was absent, failed or skipped, and the request goes on (fails open). */
export type Verdict = 'allowed' | 'refused' | 'unchecked'

// ---- per isolate: what was logged, and which bindings are skipped after a failure ----

const logged = new Set<string>()
const skipUntil = new Map<LimitName, number>()

function logOnce(what: string, message: string, detail?: string): void {
  if (logged.has(what)) return
  logged.add(what)
  // The key is never logged: it can hold an address.
  if (detail === undefined) console.error(message)
  else console.error(message, detail)
}

/** Tests only: forget what this isolate logged and skipped. */
export function resetLimiterState(): void {
  logged.clear()
  skipUntil.clear()
}

const bound = (env: RateLimitEnv, name: LimitName): RateLimit | null => {
  const b = env[name] as unknown
  return typeof b === 'object' && b !== null && typeof (b as Partial<RateLimit>).limit === 'function' ? (b as RateLimit) : null
}

/** For `/healthz`: each limiter `bound`, `absent`, or `skipped` (bound, and failed in this isolate within `SKIP_AFTER_FAILURE_MS`). */
export function limiterStatus(env: RateLimitEnv, now: number = Date.now()): Record<LimitName, 'bound' | 'absent' | 'skipped'> {
  const out = {} as Record<LimitName, 'bound' | 'absent' | 'skipped'>
  for (const name of LIMITERS) out[name] = bound(env, name) === null ? 'absent' : (skipUntil.get(name) ?? 0) > now ? 'skipped' : 'bound'
  return out
}

/** Ask one binding about one key, within what is left of the request's budget. Never throws. */
async function check(env: RateLimitEnv, name: LimitName, key: string, until: number): Promise<Verdict> {
  const binding = bound(env, name)
  if (binding === null) {
    logOnce(`${name}:absent`, `control: rate limiter ${name} is not bound; its checks are skipped and OAuth requests are served without it (D70)`)
    return 'unchecked'
  }
  const now = Date.now()
  // Skipped after a failure here, or the request's budget is gone (another binding took it).
  if ((skipUntil.get(name) ?? 0) > now || until <= now) return 'unchecked'
  const left = until - now
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome: unknown = await Promise.race([
      binding.limit({ key }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${left} ms`)), left)
      }),
    ])
    const success = typeof outcome === 'object' && outcome !== null ? (outcome as { success?: unknown }).success : undefined
    if (typeof success !== 'boolean') throw new Error('an answer without a boolean "success"')
    return success ? 'allowed' : 'refused'
  } catch (e) {
    // Fails open, deliberately (above), and skips this binding here for a while.
    skipUntil.set(name, Date.now() + SKIP_AFTER_FAILURE_MS)
    logOnce(`${name}:failed`, `control: rate limiter ${name} failed; requests are served without it, and this isolate skips it for ${SKIP_AFTER_FAILURE_MS / 1000} s after each failure (D70)`, e instanceof Error ? e.message : 'error')
    return 'unchecked'
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Ask the bindings in order, stopping at the first refusal (a refused call does not count, so later keys are not spent). Null when allowed. */
async function firstRefusal(env: RateLimitEnv, checks: [LimitName, string][]): Promise<LimitName | null> {
  const until = Date.now() + CHECK_BUDGET_MS
  for (const [name, key] of checks) if ((await check(env, name, key, until)) === 'refused') return name
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
 * The address every cross-zone subrequest from a Cloudflare Worker arrives from ("In cross-zone
 * subrequests … the `CF-Connecting-IP` value will be set to the Worker client IP address
 * `'2a06:98c0:3600::103'`": developers.cloudflare.com/fundamentals/reference/http-headers/, read
 * 2026-11-19, page modified 2026-11-15). Every MCP client hosted on Workers, in any account, shares
 * it, so counting it would let anyone with a Workers account refuse all of them (review M-1). It is
 * not counted: what it reaches without a genuine credential costs this Worker's CPU only, and its
 * senders pay for their own Worker requests.
 */
export const WORKERS_EGRESS = '2a06:98c0:3600::103'
const WORKERS_EGRESS_GROUPS = v6(WORKERS_EGRESS)!

const hex = (g: number[]) => g.map((x) => x.toString(16)).join(':')

/**
 * The networks a request comes from, as the source limits count them, narrowest first: an IPv4
 * address as is; an IPv6 address by its /64 (one subscriber's usual allocation), then its /48 (a
 * routed allocation one host can hold, review m-6); an IPv4-mapped IPv6 address as the IPv4
 * address. None for `WORKERS_EGRESS`. From `CF-Connecting-IP`, which Cloudflare sets on the request
 * the gateway receives and the gateway forwards unchanged (deploy/gateway/src/index.ts `forward`);
 * viz-control has no public route of its own, and neither the gateway nor this Worker reads
 * `X-Real-IP` (review m-4). A request without it, or with one that is not an address, counts against
 * one shared key (`none`, `unparsed`): never a key the request can choose.
 */
export function sourceKeys(header: string | null): [LimitName, string][] {
  if (header === null) return [['OAUTH_RL_SOURCE', 's:none']]
  const s = header.trim()
  const four = v4(s)
  if (four) return [['OAUTH_RL_SOURCE', `s:v4:${four}`]]
  const g = v6(s)
  if (!g) return [['OAUTH_RL_SOURCE', 's:unparsed']]
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return [['OAUTH_RL_SOURCE', `s:v4:${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`]]
  if (g.every((x, i) => x === WORKERS_EGRESS_GROUPS[i])) return []
  return [['OAUTH_RL_SOURCE', `s:v6:${hex(g.slice(0, 4))}::/64`], ['OAUTH_RL_SOURCE_48', `s48:v6:${hex(g.slice(0, 3))}::/48`]]
}

/** The network the narrowest source key counts (for the tests and the README): `v4:…`, `v6:…::/64`, `none`, `unparsed`, or `workers` (not counted). */
export function sourceNetwork(header: string | null): string {
  const keys = sourceKeys(header)
  return keys.length === 0 ? 'workers' : keys[0]![1].slice(2)
}

/** A fixed-length key for a credential a request presents. */
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
  OAUTH_RL_SOURCE_48: 'Too many requests to the OAuth endpoints from your network.',
  OAUTH_RL_CREDENTIAL: 'Too many requests with this code or token.',
  OAUTH_RL_TENANT: 'Too many token and revocation requests for this tenant.',
  OAUTH_RL_BEARER: 'Too many requests with this access token.',
  OAUTH_RL_BEARER_TENANT: 'Too many requests with this tenant\'s access tokens.',
}

const refusal = (name: LimitName | null): Refusal | null => (name === null ? null : { limit: name, retryAfterS: RATE_PERIOD_S, why: WHY[name] })

/**
 * The client's network: first thing at `/oauth/register` and `/oauth/authorize`; at `/oauth/token`
 * and `/oauth/revoke`, only for a request the Worker refuses by itself (review M-1).
 */
export const limitSource = async (env: RateLimitEnv, req: Request): Promise<Refusal | null> => refusal(await firstRefusal(env, sourceKeys(req.headers.get('CF-Connecting-IP'))))

/** `/oauth/token` and `/oauth/revoke`, after the credential's tag and expiry: the credential, then its tenant. */
export const limitCredential = async (env: RateLimitEnv, tenant: string, credential: string): Promise<Refusal | null> =>
  refusal(await firstRefusal(env, [['OAUTH_RL_CREDENTIAL', `k:${digest(credential)}`], ['OAUTH_RL_TENANT', `t:${tenant}`]]))

/** Introspection, after the token's tag and expiry: this token, then its tenant. */
export async function limitBearer(env: RateLimitEnv, tenant: string, token: string): Promise<RateLimited | null> {
  const r = refusal(await firstRefusal(env, [['OAUTH_RL_BEARER', `b:${digest(token)}`], ['OAUTH_RL_BEARER_TENANT', `bt:${tenant}`]]))
  return r === null ? null : { v: 1, status: 'rate_limited', retryAfterMs: r.retryAfterS * 1000 }
}

/** The exact limit's window, for src/ops-oauth.ts. */
export const REFRESH_WINDOW_MS = 60_000
export const REFRESHES_PER_WINDOW = OAUTH_LIMITS.refreshesPerGrantPerMinute
