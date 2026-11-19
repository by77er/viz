/** Small pure helpers shared by the ruler and the notifier. No I/O, no randomness. */

/**
 * 64-bit non-cryptographic hash of a string as 16 hex digits (two independent 32-bit
 * multiply-xorshift streams). Used for alert fingerprints, group offsets, idempotency keys
 * and seeded jitter. It is NOT Prometheus' xxhash: fingerprints are stable inside viz but do
 * not equal the ones Prometheus or Alertmanager would print (README, "Deviations").
 */
export function hash64(s: string): string {
  let h1 = 0xdeadbeef ^ s.length
  let h2 = 0x41c6ce57 ^ s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

/** A number in [0, 1) derived only from `seed`. */
export function unitFromSeed(seed: string): number {
  return parseInt(hash64(seed).slice(0, 13), 16) / 2 ** 52
}

export type Labels = Record<string, string>

/** A label's value, or '' when the set does not have it. Never reads the prototype chain. */
export function labelValue(labels: Labels, name: string): string {
  return Object.hasOwn(labels, name) ? (labels[name] as string) : ''
}

/** Canonical text of a label set: names sorted, separators that cannot occur in a name. */
export function labelsKey(labels: Labels): string {
  const names = Object.keys(labels).sort()
  let out = ''
  for (const n of names) out += n + '\u0001' + labels[n] + '\u0002'
  return out
}

/** Fingerprint of a label set. Empty-valued labels must already have been dropped. */
export function fingerprint(labels: Labels): string {
  return hash64(labelsKey(labels))
}

const DURATION_RE = /^(?:(\d+)y)?(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/

/** Prometheus `model.Duration` text ("1h30m", "90s", "0") to milliseconds, or null if malformed. */
export function parseDuration(text: string): number | null {
  if (text === '0') return 0
  if (text === '') return null
  const m = DURATION_RE.exec(text)
  if (!m) return null
  const n = (i: number) => (m[i] ? Number(m[i]) : 0)
  const ms =
    n(1) * 365 * 86_400_000 + n(2) * 7 * 86_400_000 + n(3) * 86_400_000 + n(4) * 3_600_000 + n(5) * 60_000 + n(6) * 1000 + n(7)
  return Number.isSafeInteger(ms) ? ms : null
}

/** Milliseconds to the shortest Prometheus duration text. */
export function formatDuration(ms: number): string {
  if (ms === 0) return '0s'
  const units: [string, number][] = [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000], ['ms', 1]]
  let rest = ms
  let out = ''
  for (const [u, size] of units) {
    const q = Math.floor(rest / size)
    if (q > 0) {
      out += `${q}${u}`
      rest -= q * size
    }
  }
  return out
}

/** RFC 3339 in UTC, as Alertmanager prints times. */
export function rfc3339(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * The latest grid time `<= now` for a grid `offset + k * interval`.
 * This is Prometheus' `Group.EvalTimestamp`: evaluation times are aligned to the interval
 * and shifted by a per-group offset so groups do not all evaluate together.
 */
export function alignedTick(nowMs: number, intervalMs: number, offsetMs: number): number {
  return nowMs - (((nowMs - offsetMs) % intervalMs) + intervalMs) % intervalMs
}

/**
 * Retry delay for attempt `attempt` (1 = after the first failure): exponential, capped, with
 * "equal jitter" in [0.5, 1) of the step. The jitter comes from `seed`, so the same row
 * always backs off the same way and tests can assert the schedule.
 */
export function backoffMs(attempt: number, baseMs: number, capMs: number, seed: string): number {
  const step = Math.min(capMs, baseMs * 2 ** Math.min(attempt - 1, 30))
  return Math.floor(step * (0.5 + 0.5 * unitFromSeed(`${seed}#${attempt}`)))
}

/** UTF-8 byte length without allocating the encoding for ASCII-only strings. */
export function byteLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c < 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

export const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
export const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/

/** Parse a Prometheus sample value string ("1.5", "NaN", "+Inf", "-Inf"). */
export function parseSampleValue(s: string): number {
  if (s === '+Inf' || s === 'Inf') return Infinity
  if (s === '-Inf') return -Infinity
  if (s === 'NaN') return NaN
  return Number(s)
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

/**
 * The name a Durable Object answers to. Normally `ctx.id.name`. The name is also stored on
 * first write, so an object woken without a name (an alarm on a runtime that does not carry
 * it) still knows whose data it holds instead of finding nothing and going idle. A stored
 * name that disagrees with the one presented means the object must serve nobody.
 */
export function resolveObjectName(presented: string | undefined, stored: string | undefined): string {
  if (presented === undefined || presented === '') return stored ?? ''
  if (stored !== undefined && stored !== presented) return ''
  return presented
}

/**
 * Whether a staged trial's deadline (`VIZ_STAGE_EXPIRES_AT`, ISO 8601, set by
 * deploy/configure.mjs --expires) has passed. Unset (production): never. Unparseable: expired,
 * so a typo stops the trial rather than letting it run on.
 */
export function stageExpired(expiresAt: string | undefined, nowMs: number): boolean {
  if (expiresAt === undefined || expiresAt === '') return false
  const at = Date.parse(expiresAt)
  return !Number.isFinite(at) || nowMs >= at
}
