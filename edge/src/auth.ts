import { HttpError } from './errors'

/**
 * API keys: `viz_<keyId>_<secret>`.
 *
 * KV holds `key:<keyId>` → { tenant, secretSha256, scopes, disabled? }. Only the SHA-256 of
 * the secret is stored. The tenant is whatever the key record says and nothing else:
 * no header, path or body field is ever consulted. Secrets are never logged or echoed;
 * error messages name the problem, not the credential.
 */

export interface KeyRecord {
  tenant: string
  /** Lowercase hex SHA-256 of the secret part of the key. */
  secretSha256: string
  scopes: string[]
  disabled?: boolean
}

export interface Principal {
  tenant: string
  keyId: string
  scopes: string[]
}

const KEY_RE = /^viz_([A-Za-z0-9]{1,64})_([A-Za-z0-9_\-]{8,256})$/
const HIT_TTL_MS = 60_000
/** Unknown key ids are remembered briefly too, so a bad key cannot hammer KV. */
const MISS_TTL_MS = 10_000
const MAX_CACHE = 10_000

const cache = new Map<string, { record: KeyRecord | null; expires: number }>()

export function clearAuthCache(): void {
  cache.clear()
}

const unauthorized = (why: string): HttpError => new HttpError(401, why, { 'WWW-Authenticate': 'Bearer realm="viz"' })

/** The API key presented by the request, from Bearer or from the password of Basic auth. */
function presentedKey(req: Request): string | null {
  const h = req.headers.get('Authorization')
  if (!h) return null
  const sp = h.indexOf(' ')
  if (sp < 0) return null
  const scheme = h.slice(0, sp).toLowerCase()
  const rest = h.slice(sp + 1).trim()
  if (scheme === 'bearer') return rest
  if (scheme === 'basic') {
    let decoded: string
    try {
      decoded = atob(rest)
    } catch {
      return null
    }
    const colon = decoded.indexOf(':')
    return colon < 0 ? null : decoded.slice(colon + 1)
  }
  return null
}

function parseRecord(v: unknown): KeyRecord | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (typeof r.tenant !== 'string' || r.tenant === '') return null
  if (typeof r.secretSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.secretSha256)) return null
  if (!Array.isArray(r.scopes) || !r.scopes.every((s) => typeof s === 'string')) return null
  return { tenant: r.tenant, secretSha256: r.secretSha256, scopes: r.scopes as string[], disabled: r.disabled === true }
}

async function lookup(kv: KVNamespace, keyId: string, now: number): Promise<KeyRecord | null> {
  const hit = cache.get(keyId)
  if (hit && hit.expires > now) return hit.record
  const record = parseRecord(await kv.get(`key:${keyId}`, 'json'))
  if (cache.size >= MAX_CACHE) cache.clear()
  cache.set(keyId, { record, expires: now + (record ? HIT_TTL_MS : MISS_TTL_MS) })
  return record
}

/** Compares two equal-length byte strings without an early exit. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16)
  return out
}

const NO_SUCH_KEY = new Uint8Array(32)

/**
 * Authenticate a request and require a scope. Throws 401 for a missing, malformed,
 * unknown, disabled or wrong key, and 403 for a valid key without the scope.
 */
export async function authenticate(req: Request, kv: KVNamespace, scope: 'write' | 'read', now = Date.now()): Promise<Principal> {
  const key = presentedKey(req)
  if (key === null) throw unauthorized('missing API key')
  const m = KEY_RE.exec(key)
  if (!m) throw unauthorized('invalid API key')
  const keyId = m[1]!
  const record = await lookup(kv, keyId, now)
  // Hash and compare even when the key id is unknown, so both paths cost the same.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m[2]!)))
  const match = constantTimeEqual(digest, record ? hexBytes(record.secretSha256) : NO_SUCH_KEY)
  if (!record || !match || record.disabled) throw unauthorized('invalid API key')
  if (!record.scopes.includes(scope)) throw new HttpError(403, `API key lacks the ${scope} scope`)
  return { tenant: record.tenant, keyId, scopes: record.scopes }
}
