/**
 * Request parameters of the Prometheus HTTP API, parsed the way Prometheus parses them
 * (`web/api/v1/api.go`: `parseTime`, `parseDuration`), with its error messages.
 */
import { ApiError, MAX_TS, MIN_TS } from './coordinator'

const bad = (name: string, why: string): ApiError => new ApiError('bad_data', `invalid parameter "${name}": ${why}`)

/** Parameters of the URL query and of a form-encoded body, merged; a name may repeat. */
export async function readParams(req: Request, maxBodyBytes = 1 << 20): Promise<URLSearchParams> {
  const params = new URLSearchParams(new URL(req.url).search)
  if (req.method !== 'POST') return params
  const type = (req.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== '' && type !== 'application/x-www-form-urlencoded') throw new ApiError('bad_data', `unsupported content type ${JSON.stringify(type)}: send application/x-www-form-urlencoded`)
  // Decoded here (not `req.text()`, which warns about form bodies in workerd).
  const body = new TextDecoder().decode(await req.arrayBuffer())
  if (body.length > maxBodyBytes) throw new ApiError('bad_data', `request body exceeds ${maxBodyBytes} bytes`)
  for (const [k, v] of new URLSearchParams(body)) params.append(k, v)
  return params
}

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d*))?$/
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/

/**
 * A decimal number of seconds as integer milliseconds, rounded to the nearest
 * millisecond, computed on the digits (no float multiplication, so `1700000000.123` is
 * exactly 1700000000123). Null if the text is not a plain decimal.
 */
function decimalSecondsToMs(text: string): number | null {
  const m = DECIMAL.exec(text)
  if (!m) return null
  if (m[2]!.length > 15) return m[1] === '-' ? -Infinity : Infinity
  const frac = (m[3] ?? '').padEnd(4, '0')
  let ms = Number(m[2]) * 1000 + Number(frac.slice(0, 3))
  if (frac.charCodeAt(3) >= 53) ms += 1 // the fourth digit is 5 or more: round half up
  return m[1] === '-' ? -ms : ms
}

/**
 * A timestamp parameter: Unix seconds (`1700000000`, `1700000000.123`, `1.7e9`) or
 * RFC 3339 (`2026-11-18T12:00:00Z`, with fraction and offset). Returns integer Unix
 * milliseconds, clamped to what storage can hold.
 */
export function parseTime(name: string, text: string): number {
  let ms = decimalSecondsToMs(text)
  if (ms === null) {
    const f = Number(text)
    if (text.trim() !== '' && !Number.isNaN(f) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) ms = Math.round(f * 1000)
    else if (RFC3339.test(text) && !Number.isNaN(Date.parse(text))) {
      // Date.parse keeps milliseconds; further digits are truncated, as Prometheus' millisecond engine does.
      ms = Date.parse(text.replace(/(\.\d{3})\d+/, '$1'))
    } else throw bad(name, `cannot parse ${JSON.stringify(text)} to a valid timestamp`)
  }
  return Math.min(Math.max(ms, MIN_TS), MAX_TS)
}

const DURATION = /^(?:(\d+)y)?(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/
const UNIT_MS = [365 * 86_400_000, 7 * 86_400_000, 86_400_000, 3_600_000, 60_000, 1000, 1]

/**
 * A duration parameter (`step`, `timeout`): a number of SECONDS (`15`, `0.5`) or a
 * Prometheus duration (`15s`, `1m30s`, `1h`, `500ms`). Returns milliseconds, which may be
 * fractional or zero: the caller decides what it accepts.
 */
export function parseDuration(name: string, text: string): number {
  const err = (): ApiError => bad(name, `cannot parse ${JSON.stringify(text)} to a valid duration`)
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
    const ms = decimalSecondsToMs(text) ?? Number(text) * 1000
    if (!Number.isFinite(ms) || Math.abs(ms) > 9e15) throw err()
    return ms
  }
  const m = text === '' ? null : DURATION.exec(text)
  if (!m) throw err()
  let ms = 0
  for (let i = 0; i < UNIT_MS.length; i++) if (m[i + 1] !== undefined) ms += Number(m[i + 1]) * UNIT_MS[i]!
  if (!Number.isSafeInteger(ms)) throw err()
  return ms
}

export function required(params: URLSearchParams, name: string): string {
  const v = params.get(name)
  if (v === null || v === '') throw bad(name, name === 'query' ? 'the query is empty' : `cannot parse "" to a valid ${name === 'step' ? 'duration' : 'timestamp'}`)
  return v
}

/** `start`, `end` and `step` of a range query, as integer milliseconds. */
export function rangeParams(params: URLSearchParams): { start: number; end: number; step: number } {
  const start = parseTime('start', required(params, 'start'))
  const end = parseTime('end', required(params, 'end'))
  if (end < start) throw bad('end', 'end timestamp must not be before start time')
  const stepMs = parseDuration('step', required(params, 'step'))
  // The engine steps in whole milliseconds, like Prometheus.
  const step = Math.floor(stepMs)
  if (step <= 0) throw bad('step', 'zero or negative query resolution step widths are not accepted. Try a positive integer')
  return { start, end, step }
}

/** Optional `start` and `end` of a metadata call. Missing: everything storage can hold. */
export function windowParams(params: URLSearchParams): { start: number; end: number } {
  const s = params.get('start')
  const e = params.get('end')
  const start = s === null || s === '' ? MIN_TS : parseTime('start', s)
  const end = e === null || e === '' ? MAX_TS : parseTime('end', e)
  if (end < start) throw bad('end', 'end timestamp must not be before start time')
  return { start, end }
}

/** The query's time limit: the tenant's, lowered by a `timeout` parameter. */
export function timeoutParam(params: URLSearchParams, maxMs: number): number {
  const t = params.get('timeout')
  if (t === null || t === '') return maxMs
  const ms = parseDuration('timeout', t)
  if (ms <= 0) throw bad('timeout', 'the timeout must be positive')
  return Math.min(ms, maxMs)
}

const DAY_MS = 86_400_000

/**
 * The window of a cardinality report: `end` (default now), and either `start` or `range`
 * (a duration before `end`; default one day); `lookback` (default the range's length)
 * is how far before `start` the report looks to tell new series from old ones.
 */
export function cardinalityParams(params: URLSearchParams, now: number): { start: number; end: number; lookbackStart: number; limit: number } {
  const e = params.get('end')
  const end = e === null || e === '' ? Math.min(Math.max(now, MIN_TS), MAX_TS) : parseTime('end', e)
  const s = params.get('start')
  const r = params.get('range')
  let start: number
  if (s !== null && s !== '') start = parseTime('start', s)
  else {
    const ms = r === null || r === '' ? DAY_MS : parseDuration('range', r)
    if (!(ms > 0)) throw bad('range', 'the range must be positive')
    start = Math.max(MIN_TS, end - Math.floor(ms))
  }
  if (end < start) throw bad('end', 'end timestamp must not be before start time')
  const lb = params.get('lookback')
  const lookback = lb === null || lb === '' ? end - start : Math.floor(parseDuration('lookback', lb))
  if (lookback < 0) throw bad('lookback', 'the lookback must not be negative')
  const l = params.get('limit')
  let limit = 10
  if (l !== null && l !== '') {
    if (!/^\d+$/.test(l)) throw bad('limit', `cannot parse ${JSON.stringify(l)} to a valid limit`)
    limit = Number(l)
    // Prometheus: at most 10,000 items per list.
    if (limit < 1 || limit > 10_000) throw bad('limit', 'limit must be between 1 and 10000')
  }
  return { start, end, lookbackStart: Math.max(MIN_TS, start - lookback), limit }
}
