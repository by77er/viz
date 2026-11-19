/**
 * Parameters of Tempo's and Loki's HTTP APIs, as their documentation states them (read
 * 2026-11-19: grafana.com/docs/tempo/latest/api_docs/ and
 * grafana.com/docs/loki/latest/reference/loki-http-api/; `CLEANROOM.md`). Times become
 * nanoseconds as `bigint`, from the digits, never through a float.
 *
 *   Loki:  "All epoch values will be interpreted as a Unix timestamp in nanoseconds. A floating
 *          point number is a Unix timestamp with fractions of a second." RFC 3339 too. `step`:
 *          a duration `[0-9]+[smhdwy]` or a float number of seconds.
 *   Tempo: `start`/`end` are Unix epoch seconds; the metrics API also takes nanoseconds and
 *          RFC 3339; `step` and `since` are duration strings.
 */
import { ApiError } from './coordinator'

export const NS_PER_S = 1_000_000_000n
export const NS_PER_MS = 1_000_000n
/** The largest time storage holds (contracts/BATCH.md, signals 2 and 3: an i64 of nanoseconds). */
export const MAX_NS = (1n << 63n) - 1n

const bad = (name: string, v: string, why = ''): ApiError => new ApiError('bad_data', `invalid parameter "${name}": cannot parse ${JSON.stringify(v.slice(0, 64))} ${why}`.trim())

/** `12.5` seconds as nanoseconds, exactly (at most nine fractional digits). */
function decimalSeconds(name: string, v: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,9}))?$/.exec(v)
  if (!m) throw bad(name, v, 'as a number of seconds')
  const ns = BigInt(m[2]!) * NS_PER_S + BigInt((m[3] ?? '').padEnd(9, '0'))
  return m[1] === '-' ? -ns : ns
}

/** RFC 3339 with an optional fraction of up to nine digits and `Z` or an offset. */
function rfc3339(name: string, v: string): bigint {
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/.exec(v)
  if (!m) throw bad(name, v, 'as a time')
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
  if (!Number.isFinite(ms)) throw bad(name, v, 'as a time')
  let ns = BigInt(ms) * NS_PER_MS + BigInt((m[7] ?? '').padEnd(9, '0'))
  if (m[8] !== 'Z' && m[8] !== 'z') {
    const sign = m[8]!.startsWith('-') ? -1n : 1n
    const [h, mi] = m[8]!.slice(1).split(':').map(Number)
    ns -= sign * BigInt(h! * 3600 + mi! * 60) * NS_PER_S
  }
  return ns
}

/** A Loki time: an integer of nanoseconds, a float of seconds, or RFC 3339. */
export function lokiTime(name: string, v: string): bigint {
  const t = /^-?\d+$/.test(v) ? BigInt(v) : /^-?\d+\.\d+$/.test(v) ? decimalSeconds(name, v) : rfc3339(name, v)
  if (t < 0n || t > MAX_NS) throw bad(name, v, 'within the times storage holds')
  return t
}

/** A Tempo time: Unix epoch seconds (search, tags, trace by ID). */
export function tempoSeconds(name: string, v: string): bigint {
  if (!/^\d+$/.test(v)) throw bad(name, v, 'as Unix epoch seconds')
  const t = BigInt(v) * NS_PER_S
  if (t > MAX_NS) throw bad(name, v, 'within the times storage holds')
  return t
}

/**
 * A Tempo metrics time: Unix epoch seconds or nanoseconds, or RFC 3339. The documentation
 * does not say how seconds and nanoseconds are told apart: an integer of 13 or more digits is
 * nanoseconds (seconds of that length are past the year 33,000; nanoseconds below it before 1970-01-01T00:16:40Z).
 */
export function tempoMetricsTime(name: string, v: string): bigint {
  if (/^\d+$/.test(v)) {
    const t = v.length >= 13 ? BigInt(v) : BigInt(v) * NS_PER_S
    if (t > MAX_NS) throw bad(name, v, 'within the times storage holds')
    return t
  }
  if (/^\d+\.\d+$/.test(v)) return decimalSeconds(name, v)
  return rfc3339(name, v)
}

const UNITS: Record<string, bigint> = { ns: 1n, us: 1_000n, µs: 1_000n, ms: 1_000_000n, s: NS_PER_S, m: 60n * NS_PER_S, h: 3600n * NS_PER_S, d: 86_400n * NS_PER_S, w: 7n * 86_400n * NS_PER_S, y: 365n * 86_400n * NS_PER_S }

/** A duration: Go's (`1m30s`, `500ms`) or Prometheus' units (`d`, `w`, `y`), or a float number of seconds. */
export function duration(name: string, v: string): bigint {
  if (/^\d+(\.\d{1,9})?$/.test(v)) return decimalSeconds(name, v)
  const parts = [...v.matchAll(/(\d+)(?:\.(\d{1,9}))?(ns|us|µs|ms|s|m|h|d|w|y)/g)]
  if (parts.length === 0 || parts.map((p) => p[0]).join('') !== v) throw bad(name, v, 'as a duration')
  let ns = 0n
  for (const p of parts) {
    const unit = UNITS[p[3]!]!
    ns += BigInt(p[1]!) * unit + (BigInt((p[2] ?? '').padEnd(9, '0')) * unit) / NS_PER_S
  }
  return ns
}

/** A non-negative integer parameter (absent: `dflt`). */
export function count(params: URLSearchParams, name: string, dflt: number, max = 1_000_000_000): number {
  const v = params.get(name)
  if (v === null || v === '') return dflt
  if (!/^\d+$/.test(v) || Number(v) > max) throw bad(name, v, `as an integer from 0 to ${max}`)
  return Number(v)
}

/** viz's default step when a request has none (both APIs leave it "dynamic"): the range over 250 points, rounded up to a whole second, at least one. */
export function defaultStep(startNs: bigint, endNs: bigint): bigint {
  const range = endNs > startNs ? endNs - startNs : 0n
  const per = (range + 250n * NS_PER_S - 1n) / (250n * NS_PER_S)
  return (per < 1n ? 1n : per) * NS_PER_S
}

/** `now` in nanoseconds (the Worker's clock; milliseconds). */
export const nowNs = (): bigint => BigInt(Date.now()) * NS_PER_MS

/** A trace id from a URL: up to 32 hex digits, left-padded with zeros to 16 bytes (Tempo's 64-bit ids). */
export function traceIdParam(v: string): Uint8Array {
  if (!/^[0-9a-fA-F]{1,32}$/.test(v)) throw new ApiError('bad_data', `invalid trace id ${JSON.stringify(v.slice(0, 40))}: up to 32 hexadecimal digits`)
  const h = v.toLowerCase().padStart(32, '0')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(h.slice(2 * i, 2 * i + 2), 16)
  return out
}

/** Nanoseconds to inclusive milliseconds for a ledger plan: `[floor(lo), floor(hi)]`, clamped to storage's millisecond range. */
export function msRange(lo: bigint, hi: bigint): { minTs: number; maxTs: number } {
  const MAX_MS = Number(MAX_NS / NS_PER_MS)
  const f = (x: bigint) => Math.max(0, Math.min(MAX_MS, Number((x < 0n ? 0n : x) / NS_PER_MS)))
  return { minTs: f(lo), maxTs: f(hi) }
}
