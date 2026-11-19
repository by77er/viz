import { badRequest } from './errors'
import { BUILT, FREE, type Meter } from './meter'
import type { PbReader } from './pb'

/**
 * What OTLP traces and logs share: AnyValue and KeyValue decoding (protobuf and JSON), the
 * canonical OTLP JSON and plain JSON text of contracts/BATCH.md ("Rules common to signals 2
 * and 3"), the typed attribute list encoding, and a growable byte writer.
 *
 * Strings are decoded leniently: invalid UTF-8 becomes U+FFFD, as the OTLP specification
 * recommends ("UTF-8 String Handling"), instead of refusing the request.
 */

/** An OTLP AnyValue. Doubles keep their 8 wire bytes (protobuf), so NaN payloads survive. */
export type AnyV =
  | { k: 's'; v: string }
  | { k: 'b'; v: boolean }
  | { k: 'i'; v: bigint }
  | { k: 'd'; v: number; bits?: Uint8Array }
  | { k: 'a'; v: AnyV[] }
  | { k: 'l'; v: KV[] }
  | { k: 'y'; v: Uint8Array }
  | { k: 'n' }

export type KV = [key: string, value: AnyV]

export const LIMITS = {
  maxAttrs: 128,
  maxKeyBytes: 1024,
  maxValueBytes: 65_536,
  maxDepth: 16,
} as const

const lossy = new TextDecoder()
const enc = new TextEncoder()

export const utf8Lossy = (buf: Uint8Array, s: number, e: number): string => lossy.decode(buf.subarray(s, e))
export const utf8 = (s: string): Uint8Array => enc.encode(s)

/** Compare two strings by their UTF-8 bytes (= code point order; not JavaScript's UTF-16 order). */
export function cmpUtf8(a: string, b: string): number {
  if (a === b) return 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i)
    const y = b.charCodeAt(i)
    if (x === y) continue
    // Surrogates (astral characters) sort after every BMP character in UTF-8.
    const xs = x >= 0xd800 && x <= 0xdfff
    const ys = y >= 0xd800 && y <= 0xdfff
    if (xs !== ys) return xs ? 1 : -1
    return x - y
  }
  return a.length - b.length
}

/** Sort key-value pairs by key in UTF-8 order, keeping the last value of a repeated key. */
export function canonKVs(kvs: readonly KV[]): KV[] {
  const m = new Map<string, AnyV>()
  for (const [k, v] of kvs) {
    m.delete(k)
    m.set(k, v)
  }
  return [...m].sort((a, b) => cmpUtf8(a[0], b[0]))
}

// ─────────────────────────────── protobuf ───────────────────────────────

/**
 *   KeyValue { string key = 1; AnyValue value = 2; int32 key_strindex = 3 (profiles only, ignored) }
 *   AnyValue { oneof: string_value = 1; bool_value = 2; int_value = 3; double_value = 4;
 *              ArrayValue array_value = 5; KeyValueList kvlist_value = 6; bytes_value = 7;
 *              int32 string_value_strindex = 8 (profiles only, ignored) }
 *
 * Every key-value entry and array element is counted against the item's meter before it is
 * built (src/meter.ts). Once the meter is over, nothing more is built: the rest is read only
 * to check the wire (lengths, wire types, nesting depth), exactly as when it is built, so a
 * body that does not decode is 400 either way.
 */

/** An AnyValue with no value set; also what is returned for a value that is not built. */
const NONE: AnyV = { k: 'n' }

/** One KeyValue: counted as one value; null when it is not built (its item is over its meter). */
export function pbKeyValue(r: PbReader, m: Meter = FREE): KV | null {
  const end = r.len()
  const keep = m.take()
  let key = ''
  let value: AnyV = NONE
  while (r.pos < end) {
    const tag = r.uint32()
    if (tag === 0x0a) {
      const e = r.len()
      if (keep) key = utf8Lossy(r.buf, r.pos, e)
      r.pos = e
    } else if (tag === 0x12) value = pbAnyValue(r, 0, m)
    else r.skip(tag & 7)
  }
  r.done(end)
  if (!keep || m.over) return null
  BUILT.n++
  return [key, value]
}

export function pbAnyValue(r: PbReader, depth: number, m: Meter = FREE): AnyV {
  if (depth > LIMITS.maxDepth) throw badRequest('malformed OTLP: attribute value nested too deeply')
  const end = r.len()
  let value: AnyV = NONE
  while (r.pos < end) {
    const tag = r.uint32()
    const keep = !m.over
    switch (tag) {
      case 0x0a: {
        const e = r.len()
        if (keep) value = { k: 's', v: utf8Lossy(r.buf, r.pos, e) }
        r.pos = e
        break
      }
      case 0x10:
        r.varint64()
        if (keep) value = { k: 'b', v: r.lo !== 0 || r.hi !== 0 }
        break
      case 0x18:
        r.varint64()
        if (keep) value = { k: 'i', v: r.int64Big() }
        break
      case 0x21: {
        const at = r.fixed64At()
        if (keep) {
          // A copy: `slice` of a Node Buffer is a view, and the DataView below needs its own buffer.
          const bits = new Uint8Array(8)
          bits.set(r.buf.subarray(at, at + 8))
          value = { k: 'd', v: new DataView(bits.buffer).getFloat64(0, true), bits }
        }
        break
      }
      case 0x2a: {
        const aend = r.len()
        const items: AnyV[] | null = keep ? [] : null
        while (r.pos < aend) {
          const t = r.uint32()
          if (t === 0x0a) {
            const ok = m.take()
            const item = pbAnyValue(r, depth + 1, m)
            if (ok && !m.over) items!.push(item)
          } else r.skip(t & 7)
        }
        r.done(aend)
        if (keep) value = { k: 'a', v: items! }
        break
      }
      case 0x32: {
        const kend = r.len()
        const items: KV[] | null = keep ? [] : null
        while (r.pos < kend) {
          const t = r.uint32()
          if (t === 0x0a) {
            const kvend = r.len()
            const ok = m.take()
            let k = ''
            let v: AnyV = NONE
            while (r.pos < kvend) {
              const kt = r.uint32()
              if (kt === 0x0a) {
                const e = r.len()
                if (ok) k = utf8Lossy(r.buf, r.pos, e)
                r.pos = e
              } else if (kt === 0x12) v = pbAnyValue(r, depth + 1, m)
              else r.skip(kt & 7)
            }
            r.done(kvend)
            if (ok && !m.over) {
              BUILT.n++
              items!.push([k, v])
            }
          } else r.skip(t & 7)
        }
        r.done(kend)
        if (keep) value = { k: 'l', v: items! }
        break
      }
      case 0x3a: {
        const e = r.len()
        if (keep) value = { k: 'y', v: Uint8Array.from(r.buf.subarray(r.pos, e)) }
        r.pos = e
        break
      }
      default:
        r.skip(tag & 7)
    }
  }
  r.done(end)
  if (value !== NONE) BUILT.n++
  return value
}

/** Bytes of a length-delimited field (ids). */
export function pbBytes(r: PbReader): Uint8Array {
  const e = r.len()
  const b = r.buf.subarray(r.pos, e)
  r.pos = e
  return b
}

export function pbString(r: PbReader): string {
  const e = r.len()
  const s = utf8Lossy(r.buf, r.pos, e)
  r.pos = e
  return s
}

/** Reads a fixed32 field's value. */
export function pbFixed32(r: PbReader): number {
  if (r.pos + 4 > r.end) throw badRequest('malformed protobuf: truncated')
  const b = r.buf
  const p = r.pos
  r.pos = p + 4
  return (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0
}

// ─────────────────────────────── JSON ───────────────────────────────

export const bad = (what: string): never => {
  throw badRequest(`malformed OTLP JSON: ${what}`)
}

export function list(v: unknown, what: string): unknown[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : bad(`${what} is not an array`)
}

export function object(v: unknown, what: string): Record<string, unknown> {
  if (v === undefined || v === null) return {}
  return typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad(`${what} is not an object`)
}

export function text(v: unknown, what: string): string {
  if (v === undefined || v === null) return ''
  return typeof v === 'string' ? v : bad(`${what} is not a string`)
}

export function parseJson(body: Uint8Array, what: string): Record<string, unknown> {
  let root: unknown
  try {
    // Lenient UTF-8, as for protobuf strings.
    root = JSON.parse(lossy.decode(body))
  } catch {
    throw badRequest(`malformed ${what}: body does not parse`)
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) throw badRequest(`malformed ${what}: body is not an object`)
  return root as Record<string, unknown>
}

/** A JSON integer field (int64 as a decimal string, or a number) as a BigInt; `undefined` when absent. */
export function jsonInt(v: unknown, what: string): bigint | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string' && /^-?\d{1,20}$/.test(v)) return BigInt(v)
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v)
  return bad(`${what} is not an integer`)
}

/** A uint32 JSON field (counts, flags, enums as numbers). */
export function jsonU32(v: unknown, what: string): number {
  if (v === undefined || v === null) return 0
  const n = typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : v
  if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffffffff) return n
  return bad(`${what} is not an unsigned 32-bit integer`)
}

function jsonDouble(v: unknown, what: string): number {
  if (typeof v === 'number') return v
  if (v === 'NaN') return NaN
  if (v === 'Infinity') return Infinity
  if (v === '-Infinity') return -Infinity
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return bad(`${what} is not a number`)
}

function fromBase64(s: string, what: string): Uint8Array {
  let bin: string
  try {
    bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  } catch {
    return bad(`${what} is not base64`)
  }
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** A trace or span id: hex (case-insensitive) per OTLP/JSON. Empty string is zero-length. */
export function jsonId(v: unknown, what: string): Uint8Array {
  if (v === undefined || v === null || v === '') return new Uint8Array(0)
  if (typeof v !== 'string' || v.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(v)) return bad(`${what} is not hex`)
  const out = new Uint8Array(v.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(v.slice(2 * i, 2 * i + 2), 16)
  return out
}

/**
 * An OTLP/JSON AnyValue, counted as the protobuf decoder counts (one per key-value entry and
 * array element): an item refused for its meter in one encoding is refused in the other.
 * Once the meter is over nothing more is built, but every value is still checked.
 */
export function jsonAny(raw: unknown, depth: number, m: Meter = FREE): AnyV {
  if (depth > LIMITS.maxDepth) bad('attribute value nested too deeply')
  if (raw === undefined || raw === null) return NONE
  const v = object(raw, 'attribute value')
  const keep = !m.over
  if (keep) BUILT.n++
  if (v.stringValue !== undefined && v.stringValue !== null) {
    const s = text(v.stringValue, 'stringValue')
    return keep ? { k: 's', v: s } : NONE
  }
  if (v.boolValue !== undefined && v.boolValue !== null) {
    if (typeof v.boolValue !== 'boolean') bad('boolValue is not a boolean')
    return keep ? { k: 'b', v: v.boolValue as boolean } : NONE
  }
  if (v.intValue !== undefined && v.intValue !== null) {
    const n = jsonInt(v.intValue, 'intValue')!
    return keep ? { k: 'i', v: n } : NONE
  }
  if (v.doubleValue !== undefined && v.doubleValue !== null) {
    const d = jsonDouble(v.doubleValue, 'doubleValue')
    return keep ? { k: 'd', v: d } : NONE
  }
  if (v.arrayValue !== undefined && v.arrayValue !== null) {
    const raws = list(object(v.arrayValue, 'arrayValue').values, 'arrayValue.values')
    const items: AnyV[] | null = keep ? [] : null
    for (const x of raws) {
      const ok = m.take()
      const item = jsonAny(x, depth + 1, m)
      if (ok && !m.over) items!.push(item)
    }
    return keep ? { k: 'a', v: items! } : NONE
  }
  if (v.kvlistValue !== undefined && v.kvlistValue !== null) {
    const raws = list(object(v.kvlistValue, 'kvlistValue').values, 'kvlistValue.values')
    const items: KV[] | null = keep ? [] : null
    for (const x of raws) {
      const kv = jsonKV(x, depth + 1, m)
      if (kv) items!.push(kv)
    }
    return keep ? { k: 'l', v: items! } : NONE
  }
  if (v.bytesValue !== undefined && v.bytesValue !== null) {
    const b = fromBase64(text(v.bytesValue, 'bytesValue'), 'bytesValue')
    return keep ? { k: 'y', v: b } : NONE
  }
  return NONE
}

/** One key-value entry, counted as one value; null when it is not built. */
function jsonKV(raw: unknown, depth: number, m: Meter): KV | null {
  const kv = object(raw, 'attributes[]')
  const ok = m.take()
  const key = text(kv.key, 'attribute key')
  const value = jsonAny(kv.value, depth, m)
  if (!ok || m.over) return null
  BUILT.n++
  return [key, value]
}

export function jsonAttrs(v: unknown, m: Meter = FREE): KV[] {
  const out: KV[] = []
  for (const x of list(v, 'attributes')) {
    const kv = jsonKV(x, 0, m)
    if (kv) out.push(kv)
  }
  return out
}

// ─────────────────────── canonical OTLP JSON, plain JSON ───────────────────────

function base64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!)
  return btoa(s)
}

/** ECMAScript Number::toString for finite doubles; NaN and ±Infinity as JSON strings. */
function jsonNumber(d: number): string {
  if (Number.isNaN(d)) return '"NaN"'
  if (d === Infinity) return '"Infinity"'
  if (d === -Infinity) return '"-Infinity"'
  return String(d)
}

/** Canonical OTLP JSON of an AnyValue (contracts/BATCH.md). */
export function canonAny(v: AnyV): string {
  switch (v.k) {
    case 's':
      return `{"stringValue":${JSON.stringify(v.v)}}`
    case 'b':
      return `{"boolValue":${v.v}}`
    case 'i':
      return `{"intValue":"${v.v.toString()}"}`
    case 'd':
      return `{"doubleValue":${jsonNumber(v.v)}}`
    case 'a':
      return v.v.length === 0 ? '{"arrayValue":{}}' : `{"arrayValue":{"values":[${v.v.map(canonAny).join(',')}]}}`
    case 'l':
      return v.v.length === 0 ? '{"kvlistValue":{}}' : `{"kvlistValue":{"values":${canonList(v.v)}}}`
    case 'y':
      return `{"bytesValue":${JSON.stringify(base64(v.v))}}`
    case 'n':
      return '{}'
  }
}

/** Canonical OTLP JSON of a key-value list: `[{"key":K,"value":V},…]`, sorted, last duplicate kept. */
export function canonList(kvs: readonly KV[]): string {
  return `[${canonKVs(kvs)
    .map(([k, v]) => `{"key":${JSON.stringify(k)},"value":${canonAny(v)}}`)
    .join(',')}]`
}

/** Plain JSON of an AnyValue. */
export function plainJson(v: AnyV): string {
  switch (v.k) {
    case 's':
      return JSON.stringify(v.v)
    case 'b':
      return String(v.v)
    case 'i':
      return v.v.toString()
    case 'd':
      return jsonNumber(v.v)
    case 'a':
      return `[${v.v.map(plainJson).join(',')}]`
    case 'l':
      return `{${canonKVs(v.v)
        .map(([k, x]) => `${JSON.stringify(k)}:${plainJson(x)}`)
        .join(',')}}`
    case 'y':
      return JSON.stringify(base64(v.v))
    case 'n':
      return 'null'
  }
}

/** Plain JSON text: a string is itself, anything else its plain JSON. */
export const plainText = (v: AnyV): string => (v.k === 's' ? v.v : plainJson(v))

// ─────────────────────────────── bytes ───────────────────────────────

/** A growable little-endian byte writer. */
export class Buf {
  b: Uint8Array
  n = 0
  private dv: DataView

  /** `limit`: it doubles as it grows, but not past this (only as far as a write needs). */
  constructor(cap = 256, readonly limit = Number.POSITIVE_INFINITY) {
    this.b = new Uint8Array(cap)
    this.dv = new DataView(this.b.buffer)
  }

  private room(k: number): void {
    if (this.n + k <= this.b.length) return
    const g = new Uint8Array(Math.max(Math.min(this.b.length * 2, this.limit), this.n + k))
    g.set(this.b.subarray(0, this.n))
    this.b = g
    this.dv = new DataView(g.buffer)
  }
  u8(x: number): void {
    this.room(1)
    this.b[this.n++] = x
  }
  u16(x: number): void {
    this.room(2)
    this.dv.setUint16(this.n, x, true)
    this.n += 2
  }
  u32(x: number): void {
    this.room(4)
    this.dv.setUint32(this.n, x >>> 0, true)
    this.n += 4
  }
  /** An i64 from its two unsigned 32-bit halves. */
  i64(lo: number, hi: number): void {
    this.room(8)
    this.dv.setUint32(this.n, lo >>> 0, true)
    this.dv.setUint32(this.n + 4, hi >>> 0, true)
    this.n += 8
  }
  big(x: bigint): void {
    this.room(8)
    this.dv.setBigInt64(this.n, BigInt.asIntN(64, x), true)
    this.n += 8
  }
  bytes(x: Uint8Array): void {
    this.room(x.length)
    this.b.set(x, this.n)
    this.n += x.length
  }
  /** A string's UTF-8 bytes (ASCII written directly); returns how many. */
  str(s: string): number {
    this.room(3 * s.length)
    const b = this.b
    const start = this.n
    let p = start
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c >= 128) {
        p = start + enc.encodeInto(s, b.subarray(start)).written
        break
      }
      b[p++] = c
    }
    this.n = p
    return p - start
  }
  /** A string with a u16 (or u32) length in front; returns its byte length. */
  strU16(s: string): number {
    const at = this.n
    this.u16(0)
    const len = this.str(s)
    this.dv.setUint16(at, len & 0xffff, true)
    return len
  }
  strU32(s: string): number {
    const at = this.n
    this.u32(0)
    const len = this.str(s)
    this.dv.setUint32(at, len, true)
    return len
  }
  /** Overwrite the u32 at `at` (already written). */
  setU32(at: number, x: number): void {
    this.dv.setUint32(at, x >>> 0, true)
  }
  pad8(): void {
    const k = (8 - (this.n % 8)) % 8
    this.room(k)
    this.b.fill(0, this.n, this.n + k)
    this.n += k
  }
  done(): Uint8Array<ArrayBuffer> {
    return this.b.slice(0, this.n)
  }
}

// ─────────────────────────────── typed attributes ───────────────────────────────

/** Attribute problems that refuse the item, with the reason the sender is told. */
export const ATTR_REASONS = {
  emptyKey: 'attribute with an empty key',
  tooMany: 'more than 128 attributes in one list',
  keyTooLong: 'attribute key over 1,024 bytes',
  valueTooLong: 'attribute value over 65,536 bytes',
} as const

/** What `writeAttrs` returns when the list's encoding passes the `max` it was given. */
export const OVER_MAX = 'over the item size limit'

/**
 * The typed attribute list encoding (contracts/BATCH.md): sorted by key in UTF-8 order, the
 * last of a repeated key kept, appended to `out`. Returns null, or the reason the list is
 * refused (then `out` is left as it was): `OVER_MAX` when its bytes pass `max` (the item's
 * own size limit), which is checked as it is written, so `out` never grows far past it. A
 * key or value is measured before it is written: a string's UTF-16 length is at most its
 * UTF-8 length, so one longer than its limit in UTF-16 units is over it in bytes too.
 */
export function writeAttrs(kvs: readonly KV[], out: Buf, max = Number.POSITIVE_INFINITY): string | null {
  const sorted = kvs.length < 2 ? kvs : canonKVs(kvs)
  if (sorted.length > LIMITS.maxAttrs) return ATTR_REASONS.tooMany
  const start = out.n
  const fail = (why: string): string => {
    out.n = start
    return why
  }
  out.u16(sorted.length)
  for (const [k, v] of sorted) {
    if (out.n - start > max) return fail(OVER_MAX)
    if (k === '') return fail(ATTR_REASONS.emptyKey)
    if (k.length > LIMITS.maxKeyBytes || out.strU16(k) > LIMITS.maxKeyBytes) return fail(ATTR_REASONS.keyTooLong)
    switch (v.k) {
      case 's':
        out.u8(1)
        if (v.v.length > LIMITS.maxValueBytes || out.strU32(v.v) > LIMITS.maxValueBytes) return fail(ATTR_REASONS.valueTooLong)
        break
      case 'i':
        out.u8(2)
        out.big(v.v)
        break
      case 'd':
        out.u8(3)
        if (v.bits) out.bytes(v.bits)
        else {
          const t = new DataView(new ArrayBuffer(8))
          t.setFloat64(0, v.v, true)
          out.bytes(new Uint8Array(t.buffer))
        }
        break
      case 'b':
        out.u8(4)
        out.u8(v.v ? 1 : 0)
        break
      default: {
        out.u8(5)
        const c = canonAny(v)
        if (c.length > LIMITS.maxValueBytes || out.strU32(c) > LIMITS.maxValueBytes) return fail(ATTR_REASONS.valueTooLong)
      }
    }
  }
  if (out.n - start > max) return fail(OVER_MAX)
  return null
}

/** `writeAttrs` into fresh bytes: the encoding, or the reason the list is refused. */
export function encodeAttrs(kvs: readonly KV[], max = Number.POSITIVE_INFINITY): Uint8Array | string {
  const out = new Buf(64)
  const why = writeAttrs(kvs, out, max)
  return why ?? out.done()
}

/** A canonical OTLP JSON list with the same limits as a typed list, or the reason it is refused. */
export function checkedList(kvs: readonly KV[]): string {
  const sorted = canonKVs(kvs)
  if (sorted.length > LIMITS.maxAttrs) return `!${ATTR_REASONS.tooMany}`
  for (const [k, v] of sorted) {
    if (k === '') return `!${ATTR_REASONS.emptyKey}`
    if (utf8(k).length > LIMITS.maxKeyBytes) return `!${ATTR_REASONS.keyTooLong}`
    if (utf8(v.k === 's' ? v.v : canonAny(v)).length > LIMITS.maxValueBytes) return `!${ATTR_REASONS.valueTooLong}`
  }
  return canonList(sorted)
}

/** The routing value of a resource attribute: a string as it is, anything else its plain JSON. */
export const routeValue = (v: AnyV | undefined): string => (v === undefined ? '' : plainText(v))

/** The resource's routing key, `job=<job>\u0000instance=<instance>` (contracts/BATCH.md "Routing"). */
export function resourceRoute(attrs: readonly KV[]): string {
  let service = ''
  let namespace = ''
  let instance = ''
  for (const [k, v] of attrs) {
    if (k === 'service.name') service = routeValue(v)
    else if (k === 'service.namespace') namespace = routeValue(v)
    else if (k === 'service.instance.id') instance = routeValue(v)
  }
  const job = service === '' ? '' : namespace !== '' ? `${namespace}/${service}` : service
  return `job=${job}\u0000instance=${instance}`
}

/** Unix nanoseconds from the halves of a fixed64, as milliseconds (floored, exact). */
export const nsToMs = (lo: number, hi: number): number => hi * 4294 + Math.floor((hi * 967296 + lo) / 1e6)

/** A timestamp in i64 nanoseconds as halves, from a BigInt; null when outside 0..2^63-1. */
export function nsHalves(ns: bigint): [number, number] | null {
  if (ns < 0n || ns > 0x7fffffffffffffffn) return null
  return [Number(ns & 0xffffffffn), Number(ns >> 32n)]
}

/** The protobuf response bodies of `Export<signal>ServiceResponse` with a partial success. */
export function exportResponse(json: boolean, rejected: number, message: string, jsonField: string): Uint8Array<ArrayBuffer> {
  if (json) {
    const body = rejected > 0 || message !== '' ? { partialSuccess: { [jsonField]: String(rejected), errorMessage: message } } : {}
    return enc.encode(JSON.stringify(body))
  }
  if (rejected === 0 && message === '') return new Uint8Array(0)
  const msg = enc.encode(message)
  const inner = new Buf(16 + msg.length)
  // rejected_<signal> = 1 (int64 varint), error_message = 2 (string)
  inner.u8(0x08)
  varint(inner, rejected)
  inner.u8(0x12)
  varint(inner, msg.length)
  inner.bytes(msg)
  const body = inner.done()
  const out = new Buf(body.length + 8)
  out.u8(0x0a)
  varint(out, body.length)
  out.bytes(body)
  return out.done()
}

function varint(b: Buf, n: number): void {
  while (n >= 128) {
    b.u8((n % 128) | 128)
    n = Math.floor(n / 128)
  }
  b.u8(n)
}
