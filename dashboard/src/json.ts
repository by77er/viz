/** JSON helpers: clone, equality, canonical form, JSON Pointer, edit distance. */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k)
}

/** Assign an own property without ever touching the prototype (`__proto__` keys are data). */
export function setOwn(o: Record<string, unknown>, k: string, v: unknown): void {
  if (k === '__proto__') {
    Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true })
  } else {
    o[k] = v
  }
}

export function getOwn(o: Record<string, unknown>, k: string): unknown {
  return hasOwn(o, k) ? o[k] : undefined
}

/** Deep copy of a JSON value. Does not use `structuredClone` so it behaves identically everywhere. */
export function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => clone(x)) as unknown as T
  if (isObject(v)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v)) setOwn(out, k, clone(v[k]))
    return out as T
  }
  return v
}

/** JSON equality: object key order is irrelevant, array order matters, `-0` equals `0`. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (typeof a === 'number') return Number.isNaN(a) && Number.isNaN(b as number)
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  if (isObject(a)) {
    if (!isObject(b)) return false
    const ka = Object.keys(a)
    if (ka.length !== Object.keys(b).length) return false
    for (const k of ka) if (!hasOwn(b, k) || !deepEqual(a[k], b[k])) return false
    return true
  }
  return false
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace,
 * numbers and strings as `JSON.stringify` writes them (the RFC 8785 rules
 * for the value space a dashboard uses). `undefined` members are dropped,
 * as `JSON.stringify` does.
 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',') + ']'
  if (isObject(v)) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'
  }
  return JSON.stringify(v) ?? 'null'
}

// ---- JSON Pointer (RFC 6901) ----

export function escapeToken(t: string): string {
  return t.replace(/~/g, '~0').replace(/\//g, '~1')
}

/** `~1` → `/` first, then `~0` → `~`, so that `~01` decodes to `~1` and not `/`. */
export function unescapeToken(t: string): string {
  return t.replace(/~0/g, '~').replace(/~1/g, '/')
}

export function pointer(tokens: readonly (string | number)[]): string {
  let out = ''
  for (const t of tokens) out += '/' + escapeToken(String(t))
  return out
}

/** Parse a pointer into tokens. Returns `null` if it is not a valid RFC 6901 pointer. */
export function parsePointer(p: unknown): string[] | null {
  if (typeof p !== 'string') return null
  if (p === '') return []
  if (p[0] !== '/') return null
  const parts = p.slice(1).split('/')
  for (const t of parts) if (/~(?![01])/.test(t)) return null
  return parts.map(unescapeToken)
}

// ---- suggestions ----

/** Edit distance where an adjacent transposition ("evn" → "env") costs 1 (optimal string alignment). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const n = b.length
  let prev2: number[] = []
  let prev = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(n + 1)
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const sub = prev[j - 1]! + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1)
      let best = Math.min(prev[j]! + 1, cur[j - 1]! + 1, sub)
      if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        best = Math.min(best, prev2[j - 2]! + 1)
      }
      cur[j] = best
    }
    prev2 = prev
    prev = cur
  }
  return prev[n]!
}

/**
 * Closest candidate to `input`, or `undefined` if nothing is near enough to
 * be a plausible typo (distance above half the longer length, case-insensitive;
 * a prefix/substring match always counts).
 */
export function closest(input: string, candidates: Iterable<string>): string | undefined {
  const needle = input.toLowerCase()
  let best: string | undefined
  let bestD = Infinity
  for (const c of candidates) {
    const hay = c.toLowerCase()
    let d = levenshtein(needle, hay)
    if (needle.length >= 3 && (hay.includes(needle) || needle.includes(hay))) d = Math.min(d, 1)
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  if (best === undefined) return undefined
  const limit = Math.max(1, Math.floor(Math.max(needle.length, best.length) / 2))
  return bestD <= limit ? best : undefined
}

export function listOf(values: readonly string[], max = 12): string {
  const shown = values.slice(0, max).map((v) => JSON.stringify(v))
  return shown.join(', ') + (values.length > max ? `, … (${values.length - max} more)` : '')
}

/** Turn arbitrary text into a valid Id (lowercase, `_` separators, starts with a letter). */
export function slugId(text: string, fallback = 'x'): string {
  let s = text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!/^[a-z]/.test(s)) s = s ? `${fallback}_${s}` : fallback
  return s.slice(0, 48).replace(/_+$/, '')
}
