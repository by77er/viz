import { Problem, invalid } from './errors'

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** `n` characters of base62 from the system CSPRNG, without modulo bias. 22 characters are about 131 bits. */
export function randomId(n: number): string {
  let out = ''
  const buf = new Uint8Array(n * 2)
  while (out.length < n) {
    crypto.getRandomValues(buf)
    for (let i = 0; i < buf.length && out.length < n; i++) {
      const b = buf[i]!
      if (b < 248) out += B62[b % 62]
    }
  }
  return out
}

export const iso = (ms: number | null | undefined): string | null => (ms === null || ms === undefined ? null : new Date(ms).toISOString())

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Refuse unknown fields: a misspelt field must not be silently ignored. */
export function fields(body: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (body === undefined || body === null) return {}
  if (!isRecord(body)) throw invalid(`The ${what} must be a JSON object.`, 'Send a JSON object.')
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) throw invalid(`Unknown field "${k}" in the ${what}.`, `Allowed fields: ${allowed.join(', ')}.`, { field: k })
  }
  return body
}

export function str(v: unknown, field: string, { min = 1, max = 200, optional = false } = {}): string | undefined {
  if (v === undefined || v === null) {
    if (optional) return undefined
    throw invalid(`"${field}" is required.`, `Send "${field}" as a string.`, { field })
  }
  if (typeof v !== 'string') throw invalid(`"${field}" must be a string.`, `Send "${field}" as a string.`, { field })
  const s = v.trim()
  if (s.length < min || s.length > max) throw invalid(`"${field}" must be ${min} to ${max} characters.`, `Shorten or fill in "${field}".`, { field })
  return s
}

export function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw invalid(`"${field}" must be an integer from ${min} to ${max}.`, `Send "${field}" as a whole number in that range.`, { field })
  }
  return v
}

// ---- opaque cursors ----
// A cursor is only a position in an order the caller could already see; it never names a
// tenant, and every query it feeds is scoped by the credential's tenant.

export function encodeCursor(position: (string | number)[]): string {
  return btoa(JSON.stringify(position)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeCursor(cursor: string | undefined, shape: ('string' | 'number')[]): (string | number)[] | null {
  if (cursor === undefined || cursor === '') return null
  const bad = new Problem(400, 'bad-cursor', 'The cursor is not one this API issued.', 'Start again without a cursor; use only the "next" value of the previous page.')
  let v: unknown
  try {
    v = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    throw bad
  }
  if (!Array.isArray(v) || v.length !== shape.length) throw bad
  for (let i = 0; i < shape.length; i++) {
    if (typeof v[i] !== shape[i] || (typeof v[i] === 'number' && !Number.isSafeInteger(v[i]))) throw bad
  }
  return v as (string | number)[]
}

export function pageLimit(raw: string | undefined): number {
  if (raw === undefined) return 50
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new Problem(400, 'bad-limit', '"limit" must be an integer from 1 to 200.', 'Use a limit from 1 to 200, and follow "next" for more.')
  return n
}

/** Escape `%`, `_` and `\` for a LIKE ... ESCAPE '\' pattern. */
export const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`)

export const utf8Length = (s: string): number => new TextEncoder().encode(s).length
