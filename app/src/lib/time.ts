/** Durations and time specifications. All durations are in seconds; instants in epoch seconds. */

const UNIT_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 }
const DURATION_RE = /^(?:\d+(?:ms|[smhdwy]))+$/
const DURATION_PART_RE = /(\d+)(ms|[smhdwy])/g

/** Parse a Prometheus duration ("5m", "1h30m", "15s"). Returns seconds, or null if invalid. */
export function parseDuration(text: string): number | null {
  const s = text.trim()
  if (!DURATION_RE.test(s)) return null
  let total = 0
  for (const m of s.matchAll(DURATION_PART_RE)) total += Number(m[1]) * UNIT_SECONDS[m[2]!]!
  return total
}

/** Format seconds as the shortest exact Prometheus duration ("90s" -> "1m30s"). */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s'
  let ms = Math.round(seconds * 1000)
  const parts: string[] = []
  for (const [unit, size] of [['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000], ['ms', 1]] as const) {
    const n = Math.floor(ms / size)
    if (n > 0) {
      parts.push(`${n}${unit}`)
      ms -= n * size
    }
  }
  return parts.join('')
}

/**
 * A point in time as it appears in the URL: `now`, `now-<duration>`, or an absolute epoch
 * in milliseconds (as a decimal string).
 */
export type TimeSpec = string

export function isValidTimeSpec(spec: string): boolean {
  if (spec === 'now') return true
  if (spec.startsWith('now-')) return parseDuration(spec.slice(4)) !== null
  return /^\d{10,16}$/.test(spec)
}

/** Resolve a spec to epoch seconds, given the current time in epoch seconds. */
export function resolveTimeSpec(spec: TimeSpec, nowSec: number): number {
  if (spec === 'now') return nowSec
  if (spec.startsWith('now-')) return nowSec - (parseDuration(spec.slice(4)) ?? 0)
  return Number(spec) / 1000
}

export function absoluteSpec(epochSec: number): TimeSpec {
  return String(Math.round(epochSec * 1000))
}

/** "15s" is typed; "15 s" and "2 min" are read: a number, a space, and a unit that cannot be taken for metres. */
export function stepWords(seconds: number): string {
  return formatDuration(seconds)
    .replace(/(\d+)([a-z]+)/g, '$1 $2 ')
    .trim()
    .replace(/(\d+) m\b/g, '$1 min')
}
