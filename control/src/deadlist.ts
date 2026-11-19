import { type InactiveReason, credentialExpiresAt, parseCredential } from '../../contracts/oauth'
import { sha256Hex } from '../../dashboard/src/index.ts'
import { EXPIRY_GRACE_MS } from './oauth'

/**
 * The list of OAuth credentials found dead (decision D70, after its second review,
 * design/reviews/d70-rate-limits-r2.md, R2-M2).
 *
 * A credential this deployment made carries its tag and its expiry, so the Worker refuses a made-up
 * or expired one by itself. A **dead** one that has not expired, a rotated refresh token, one of a
 * revoked grant, an access token revoked or of an ended grant, still has a good tag and a future
 * expiry, and only its tenant's object knows it is dead. Without this list each such credential,
 * sent again, reached its object and counted against its tenant's fuse for as long as it had not
 * expired: 30 days for a refresh token. Anyone holding one live refresh token of a grant (its
 * client, or a thief of an idle grant's token) can collect them at the per-grant refresh limit and
 * replay the stock after the grant ends (R2-M2).
 *
 * So: **when the tenant's object answers that a presented credential is dead**
 * (contracts/oauth.ts: `invalid_grant` on the `refresh_token` grant, introspection's `inactive` with
 * `DEAD_INACTIVE_REASONS`, revocation's `dead: true`), the Worker records it, and **refuses a
 * recorded credential like an expired one, before any rate limit and before any object**:
 *
 * - **In this isolate, at once**: a map of the credential's hash to its expiry (at most
 *   `ISOLATE_ENTRIES`, oldest dropped first). The next request with it in this isolate is refused
 *   without I/O.
 * - **Everywhere, eventually**: a KV record in `CONFIG` (the viz KV namespace control already binds),
 *   `oauth-dead:<tenant>:<SHA-256 of the credential, hex>` → `{"v":1,"reason":…}`, expiring with the
 *   credential (its encoded expiry plus `EXPIRY_GRACE_MS`, as KV's absolute `expiration`), so the
 *   list never holds what the expiry check refuses anyway. KV is eventually consistent: a location
 *   that has not seen the write (about 60 s, training knowledge) asks the object once more from each
 *   isolate, and learns it there. The write is put off the response's path (`waitUntil`) when the
 *   caller can.
 *
 * **Writes cannot be driven by anyone but the object's answers.** One write per dead credential per
 * isolate: an isolate that has recorded or read a credential as dead never asks the object about it
 * again, and so never writes it again. Every write is of a credential this deployment minted, which
 * the tenant's object already paid rows for, so the writes are bounded by the minting the per-grant
 * refresh limit bounds. Nothing is written for a credential past its expiry, with less than KV's
 * 60 s minimum left (the expiry check refuses it within a minute), or of layout 1 (no expiry to
 * bound the record; none was issued in production).
 *
 * **Reads are bounded the same way.** A credential read from KV and not listed is remembered so for
 * `NOT_LISTED_MS` in this isolate: a live token costs at most one KV read per isolate a minute.
 * Such an isolate still learns of a death at its next object answer, so this adds at most one
 * object request per isolate, as KV's own propagation does.
 *
 * **Fails open**, like the rate limits: without `CONFIG`, or when a read throws or takes longer than
 * `DEAD_READ_MS`, the credential is treated as not listed (the rate limits and the object still
 * apply), the failure is logged once per isolate, and this isolate skips KV reads for
 * `SKIP_READS_AFTER_FAILURE_MS`; its own memory of dead credentials still applies. A failed write is
 * logged once and not retried: the next isolate that meets the credential writes it. Nothing here
 * logs a key or a credential.
 *
 * Codes are not listed: they die in the Worker within 12 minutes of issue (layout 2), and each needs
 * a person's approval, at most 20 a tenant an hour.
 */

export interface DeadListEnv {
  /** The viz KV namespace (`CONFIG` in control/wrangler.jsonc), shared with edge and the others; this file writes only `oauth-dead:` keys. */
  CONFIG?: KVNamespace
}

/** The key prefix of the list in `CONFIG`. A KV prefix keeps its meaning for ever (COMPATIBILITY.md §4). */
export const DEAD_PREFIX = 'oauth-dead:'

/** How long one KV read may take before the request goes on without it (and this isolate skips reads for `SKIP_READS_AFTER_FAILURE_MS`). */
export const DEAD_READ_MS = 100

/** How long this isolate reads no KV after a failed read: as long as it skips a failed rate limiter (src/ratelimit.ts `SKIP_AFTER_FAILURE_MS`). */
export const SKIP_READS_AFTER_FAILURE_MS = 10_000

/** How long this isolate remembers that KV did not list a credential: at most one read per credential per isolate in this time. */
export const NOT_LISTED_MS = 60_000

/** Credentials this isolate remembers, dead and not listed, each; the oldest is dropped first. About 200 bytes each. */
export const ISOLATE_ENTRIES = 10_000

/** KV's shortest expiration, in seconds from now (contract issue 4 in control/README.md; training knowledge). */
export const KV_MIN_TTL_S = 60

export type DeadReason = Extract<InactiveReason, 'unknown' | 'expired' | 'revoked'>
const REASONS: readonly DeadReason[] = ['unknown', 'expired', 'revoked']

// ---- per isolate ----

const dead = new Map<string, { until: number; reason: DeadReason }>()
const notListed = new Map<string, number>()
let skipReadsUntil = 0
const logged = new Set<string>()

function logOnce(what: string, message: string, detail?: string): void {
  if (logged.has(what)) return
  logged.add(what)
  if (detail === undefined) console.error(message)
  else console.error(message, detail)
}

function remember<V>(m: Map<string, V>, key: string, value: V): void {
  m.delete(key)
  m.set(key, value)
  if (m.size > ISOLATE_ENTRIES) m.delete(m.keys().next().value!)
}

/** Tests only (through src/ratelimit.ts `resetLimiterState`): forget what this isolate knows, skipped and logged, as a new isolate would. */
export function resetDeadList(): void {
  dead.clear()
  notListed.clear()
  skipReadsUntil = 0
  logged.clear()
}

/** The KV key of a credential, or null for a string that is not one. */
export function deadKey(credential: string): string | null {
  const c = parseCredential(credential)
  return c === null ? null : `${DEAD_PREFIX}${c.tenant}:${sha256Hex(credential)}`
}

/** For `/healthz`: `bound`, `absent` (no `CONFIG`), or `skipped` (a read failed in this isolate in the last `SKIP_READS_AFTER_FAILURE_MS`). */
export function deadListStatus(env: DeadListEnv, now: number = Date.now()): 'bound' | 'absent' | 'skipped' {
  return !env.CONFIG ? 'absent' : skipReadsUntil > now ? 'skipped' : 'bound'
}

const reasonOf = (v: string): DeadReason => {
  try {
    const r = (JSON.parse(v) as { reason?: unknown }).reason
    return REASONS.includes(r as DeadReason) ? (r as DeadReason) : 'revoked'
  } catch {
    // A record this release cannot read still says the key is listed: the prefix's meaning.
    return 'revoked'
  }
}

/**
 * Whether the tenant's object has already called this credential dead: the reason recorded, or null
 * (not listed, or the list could not be read: fails open). Only for a credential whose tag was
 * verified and whose expiry has not passed. Never throws.
 */
export async function listedDead(env: DeadListEnv, credential: string, now: number = Date.now()): Promise<DeadReason | null> {
  const key = deadKey(credential)
  if (key === null) return null
  const known = dead.get(key)
  if (known !== undefined) {
    if (known.until > now) return known.reason
    dead.delete(key)
  }
  if ((notListed.get(key) ?? 0) > now) return null
  if (!env.CONFIG) {
    logOnce('absent', 'control: the OAuth dead-credential list has no CONFIG binding; dead credentials are refused only by the isolate that met them (D70)')
    return null
  }
  if (skipReadsUntil > now) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      env.CONFIG.get(key),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${DEAD_READ_MS} ms`)), DEAD_READ_MS)
      }),
    ])
    if (value === null) {
      remember(notListed, key, now + NOT_LISTED_MS)
      return null
    }
    const reason = reasonOf(value)
    const at = credentialExpiresAt(credential)
    remember(dead, key, { until: at === null ? now + NOT_LISTED_MS : at + EXPIRY_GRACE_MS, reason })
    return reason
  } catch (e) {
    skipReadsUntil = Date.now() + SKIP_READS_AFTER_FAILURE_MS
    logOnce('read', `control: the OAuth dead-credential list could not be read; requests are served without it, and this isolate skips it for ${SKIP_READS_AFTER_FAILURE_MS / 1000} s after each failure (D70)`, e instanceof Error ? e.message : 'error')
    return null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Record that the tenant's object called this credential dead (`reason`: introspection's, or
 * `revoked` for the token endpoint and revocation): in this isolate at once, and in KV until the
 * credential expires. At most once per credential per isolate. `waitUntil`, when given, takes the
 * KV write off the response's path; otherwise it is awaited. Never throws.
 */
export async function recordDead(env: DeadListEnv, credential: string, reason: DeadReason, waitUntil?: (p: Promise<unknown>) => void, now: number = Date.now()): Promise<void> {
  const key = deadKey(credential)
  const at = credentialExpiresAt(credential)
  if (key === null || at === null) return
  const until = at + EXPIRY_GRACE_MS
  if (until <= now || dead.has(key)) return
  remember(dead, key, { until, reason })
  notListed.delete(key)
  const expiration = Math.ceil(until / 1000)
  if (!env.CONFIG || expiration - now / 1000 < KV_MIN_TTL_S) return
  const put = env.CONFIG.put(key, JSON.stringify({ v: 1, reason }), { expiration }).catch((e: unknown) => {
    logOnce('write', 'control: a write to the OAuth dead-credential list failed; the next isolate that meets the credential writes it (D70)', e instanceof Error ? e.message : 'error')
  })
  if (waitUntil) waitUntil(put)
  else await put
}
