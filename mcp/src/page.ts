import { canonicalJson, sha256Hex } from '../../dashboard/src/index.ts'
import { DATA_NOTICE, FENCE_OVERHEAD, fenced } from './untrusted'

/**
 * Token budgets. Every tool takes `max_tokens` and its text never exceeds `max_tokens × 4`
 * characters (the usual ~4 characters per token). What does not fit is paged: the result
 * says `truncated` and carries a `cursor`; calling again with the cursor continues with the
 * next item, so every item is shown exactly once across pages.
 *
 * Items are atomic. An item that is larger than a whole page on its own is shown cut, with
 * a marker, and counted as shown; it is never split across two pages.
 */

export const CHARS_PER_TOKEN = 4
export const MIN_TOKENS = 200
export const MAX_TOKENS = 32_000

export const charsFor = (maxTokens: number): number => Math.floor(maxTokens * CHARS_PER_TOKEN)
export const tokensOf = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

export interface Item {
  /** Stable identity, for tests and for structured output. */
  key: string
  /** Already-cleaned text, one or more lines, ending in a newline. Goes inside the data block. */
  text: string
  /** Structured form of the same item (already cleaned). */
  data: unknown
}

export interface PageSpec {
  /** Trusted, server-written lines above the data block. */
  header: string
  items: Item[]
  /** Index of the first item to show (from the cursor). */
  offset: number
  budgetChars: number
  /** Untrusted text shown before the items inside the data block (e.g. query errors). */
  prelude?: string
  /** Trusted lines after the block; receives what was shown. */
  footer?: (p: { next: number | null; shown: number; total: number }) => string
  /** Encodes the cursor for a next offset. */
  cursorFor: (next: number) => string
}

export interface Page {
  text: string
  shown: Item[]
  next: number | null
  cursor: string | null
  truncated: boolean
  /** An item had to be cut to fit at all. */
  cut: boolean
}

const continueLine = (cursor: string, left: number, total: number): string =>
  `Truncated: ${left} of ${total} items not shown. Call again with cursor "${cursor}" to continue.\n`

/** Lay out one page of items within the character budget. */
export function page(spec: PageSpec): Page {
  const total = spec.items.length
  const offset = Math.max(0, Math.min(spec.offset, total))
  const header = spec.header.endsWith('\n') ? spec.header : spec.header + '\n'
  const notice = DATA_NOTICE + '\n'
  const prelude = spec.prelude ?? ''
  // The footer is reserved at its largest: with a cursor for the last possible offset.
  const worstCursor = spec.cursorFor(total)
  const footerFor = (next: number | null, shown: number) =>
    (next !== null ? continueLine(spec.cursorFor(next), total - next, total) : '') + (spec.footer?.({ next, shown, total }) ?? '')
  const reserve = Math.max(footerFor(null, 0).length, continueLine(worstCursor, total, total).length + (spec.footer?.({ next: total, shown: 0, total }) ?? '').length)
  let room = spec.budgetChars - header.length - notice.length - FENCE_OVERHEAD - reserve - prelude.length

  const shown: Item[] = []
  let body = prelude
  let cut = false
  let i = offset
  for (; i < total; i++) {
    const it = spec.items[i]!
    if (it.text.length <= room) {
      body += it.text
      room -= it.text.length
      shown.push(it)
      continue
    }
    if (shown.length === 0) {
      // Always make progress: show the first item cut to what is left.
      const marker = '…[item cut to fit max_tokens]\n'
      const keep = Math.max(0, room - marker.length)
      body += it.text.slice(0, keep).replace(/[\uD800-\uDBFF]$/, '') + marker
      shown.push(it)
      cut = true
      i++
    }
    break
  }
  const next = i < total ? i : null
  const cursor = next !== null ? spec.cursorFor(next) : null
  let text = header + notice + fenced(body) + footerFor(next, shown.length)
  if (text.length > spec.budgetChars) {
    // Only reachable when the header and footer alone exceed a tiny budget. Never exceed it.
    text = text.slice(0, spec.budgetChars)
    cut = true
  }
  return { text, shown, next, cursor, truncated: next !== null || cut, cut }
}

// ---- cursors ----

/**
 * A cursor is base64url JSON: the tool, a hash of the arguments it was issued for, the next
 * offset and whatever the call pinned (an absolute time range, a revision) so that later
 * pages read the same data. It carries no tenant data and needs no secret: a forged cursor
 * can only ask for a different page of the caller's own results.
 */
export interface CursorState {
  t: string
  a: string
  o: number
  p?: Record<string, unknown>
}

export class CursorError extends Error {}

/** Hash of the arguments that define a result set (everything but cursor and max_tokens). */
export function argsHash(args: Record<string, unknown>): string {
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) if (k !== 'cursor' && k !== 'max_tokens' && v !== undefined) rest[k] = v
  return sha256Hex(canonicalJson(rest)).slice(0, 12)
}

const b64url = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s: string): string => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))

export function encodeCursor(c: CursorState): string {
  return 'c1.' + b64url(JSON.stringify(c))
}

export function decodeCursor(raw: string, tool: string, args: Record<string, unknown>): CursorState {
  const bad = (why: string) => new CursorError(`${why} Call again without "cursor" to start from the beginning.`)
  if (typeof raw !== 'string' || !raw.startsWith('c1.') || raw.length > 4096) throw bad('The cursor is not one this server issued.')
  let v: unknown
  try {
    v = JSON.parse(unb64url(raw.slice(3)))
  } catch {
    throw bad('The cursor is not one this server issued.')
  }
  const c = v as Partial<CursorState>
  if (typeof c !== 'object' || c === null || typeof c.t !== 'string' || typeof c.a !== 'string' || !Number.isSafeInteger(c.o) || (c.o as number) < 0) throw bad('The cursor is not one this server issued.')
  if (c.t !== tool) throw bad(`The cursor belongs to "${c.t}", not "${tool}".`)
  if (c.a !== argsHash(args)) throw bad('The cursor was issued for different arguments; send the same arguments with it.')
  if (c.p !== undefined && (typeof c.p !== 'object' || c.p === null || Array.isArray(c.p))) throw bad('The cursor is not one this server issued.')
  return c as CursorState
}

/** Clamp `max_tokens` to what the server supports. */
export function budgetOf(maxTokens: unknown, fallback: number): number {
  const n = typeof maxTokens === 'number' && Number.isFinite(maxTokens) ? Math.floor(maxTokens) : fallback
  return Math.max(MIN_TOKENS, Math.min(MAX_TOKENS, n))
}
