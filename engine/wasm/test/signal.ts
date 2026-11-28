/**
 * A small encoder of `VZB1` span (signal 2) and log-record (signal 3) batches for tests
 * (contracts/BATCH.md, "Rules common to signals 2 and 3", "Spans, signal 2", "Log records,
 * signal 3"), sharing no code with `edge` or with the Rust crate. It writes what the contract
 * says and nothing more: callers pass attributes already sorted and unique, as `edge` would
 * have made them, and the Rust decoder (strict) refuses anything else.
 *
 * Used by this component's tests and by `flush/` and `stack/`.
 */
const te = new TextEncoder()

/** FNV-1a 64 over `name 0x00 value 0x00` per label in UTF-8 byte order, signed: `stream_id` (= `series_id`). */
export function streamId(labels: Record<string, string>): bigint {
  const sorted = Object.entries(labels).filter(([, v]) => v !== '').map(([n, v]) => [te.encode(n), te.encode(v)] as const).sort((a, b) => cmp(a[0], b[0]))
  let h = 0xcbf29ce484222325n
  const eat = (bytes: Uint8Array) => {
    for (const b of bytes) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n)
    h = BigInt.asUintN(64, h * 0x100000001b3n)
  }
  for (const [n, v] of sorted) { eat(n); eat(v) }
  return BigInt.asIntN(64, h)
}
const pad8 = (n: number) => (n + 7) & ~7

/** A typed attribute (string, int, double bits, bool), as the batch's attribute list holds it. */
export type AttrValue = { s: string } | { i: bigint } | { d: bigint } | { b: boolean }
export type Attrs = [string, AttrValue][]

export interface SpanEntry {
  resourceFp: bigint
  resource: Attrs
  scopeName?: string
  scopeVersion?: string
  /** Canonical OTLP JSON key-value list; '' when none. */
  scopeAttrs?: string
}

export interface SpanRow {
  entry: number
  traceId: Uint8Array
  spanId: Uint8Array
  /** All zero or absent: no parent. */
  parentSpanId?: Uint8Array
  start: bigint
  end: bigint
  flags?: number
  kind?: number
  status?: number
  name: string
  traceState?: string
  statusMessage?: string
  attrs?: Attrs
}

export interface LogStream {
  labels: Record<string, string>
}

export interface LogRow {
  entry: number
  ts: bigint
  observedTs?: bigint
  traceId?: Uint8Array
  spanId?: Uint8Array
  flags?: number
  severity?: number
  line: string
  severityText?: string
  /** Sorted by name (UTF-8 bytes), unique, values non-empty. */
  metadata?: [string, string][]
}

/** A growable little-endian byte writer. */
class W {
  buf = new Uint8Array(1024)
  dv = new DataView(this.buf.buffer)
  n = 0
  private room(k: number) {
    if (this.n + k <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.n + k) size *= 2
    const b = new Uint8Array(size)
    b.set(this.buf.subarray(0, this.n))
    this.buf = b
    this.dv = new DataView(b.buffer)
  }
  u8(x: number) { this.room(1); this.buf[this.n++] = x }
  u16(x: number) { this.room(2); this.dv.setUint16(this.n, x, true); this.n += 2 }
  u32(x: number) { this.room(4); this.dv.setUint32(this.n, x, true); this.n += 4 }
  i64(x: bigint) { this.room(8); this.dv.setBigInt64(this.n, x, true); this.n += 8 }
  u64(x: bigint) { this.room(8); this.dv.setBigUint64(this.n, x, true); this.n += 8 }
  bytes(b: Uint8Array) { this.room(b.length); this.buf.set(b, this.n); this.n += b.length }
  str16(s: string) { const b = te.encode(s); this.u16(b.length); this.bytes(b) }
  str32(s: string) { const b = te.encode(s); this.u32(b.length); this.bytes(b) }
  align() { while (this.n % 8 !== 0) this.u8(0) }
  done(): Uint8Array<ArrayBuffer> { this.align(); return this.buf.slice(0, this.n) }
}

function attrs(w: W, list: Attrs) {
  w.u16(list.length)
  for (const [k, v] of list) {
    w.str16(k)
    if ('s' in v) { w.u8(1); w.str32(v.s) }
    else if ('i' in v) { w.u8(2); w.i64(v.i) }
    else if ('d' in v) { w.u8(3); w.u64(v.d) }
    else { w.u8(4); w.u8(v.b ? 1 : 0) }
  }
}

function header(w: W, signal: 2 | 3, rows: number, entries: number) {
  w.bytes(te.encode('VZB1'))
  w.u8(signal)
  w.u8(0)
  w.u16(0)
  w.u32(rows)
  w.u32(entries)
}

/** A variable-length column: `off u32[n+1]`, then at the next multiple of 8 the data. */
function variable(w: W, values: Uint8Array[]) {
  w.align()
  let off = 0
  w.u32(0)
  for (const v of values) { off += v.length; w.u32(off) }
  w.align()
  for (const v of values) w.bytes(v)
}

function encoded(f: (w: W) => void): Uint8Array {
  const w = new W()
  f(w)
  return w.buf.slice(0, w.n)
}

export function encodeSpanBatch(entries: SpanEntry[], rows: SpanRow[]): Uint8Array<ArrayBuffer> {
  const w = new W()
  header(w, 2, rows.length, entries.length)
  for (const e of entries) {
    w.i64(e.resourceFp)
    attrs(w, e.resource)
    w.str16(e.scopeName ?? '')
    w.str16(e.scopeVersion ?? '')
    w.str32(e.scopeAttrs ?? '')
  }
  const zero8 = new Uint8Array(8)
  w.align(); for (const r of rows) w.u32(r.entry)
  w.align(); for (const r of rows) w.bytes(r.traceId)
  w.align(); for (const r of rows) w.bytes(r.spanId)
  w.align(); for (const r of rows) w.bytes(r.parentSpanId ?? zero8)
  w.align(); for (const r of rows) w.i64(r.start)
  w.align(); for (const r of rows) w.i64(r.end)
  w.align(); for (const r of rows) w.u32(r.flags ?? 0)
  w.align(); for (const _ of rows) { w.u32(0); w.u32(0); w.u32(0) }
  w.align(); for (const r of rows) w.u8(r.kind ?? 0)
  w.align(); for (const r of rows) w.u8(r.status ?? 0)
  variable(w, rows.map((r) => te.encode(r.name)))
  variable(w, rows.map((r) => te.encode(r.traceState ?? '')))
  variable(w, rows.map((r) => te.encode(r.statusMessage ?? '')))
  variable(w, rows.map((r) => encoded((x) => attrs(x, r.attrs ?? []))))
  variable(w, rows.map(() => encoded((x) => x.u16(0)))) // no events
  variable(w, rows.map(() => encoded((x) => x.u16(0)))) // no links
  return w.done()
}

export function encodeLogBatch(streams: LogStream[], rows: LogRow[]): Uint8Array<ArrayBuffer> {
  const w = new W()
  header(w, 3, rows.length, streams.length)
  for (const s of streams) {
    const labels = Object.entries(s.labels).filter(([, v]) => v !== '').map(([n, v]) => [te.encode(n), te.encode(v)] as const)
    labels.sort((a, b) => cmp(a[0], b[0]))
    w.i64(streamId(s.labels))
    w.u32(labels.length)
    for (const [n, v] of labels) { w.u16(n.length); w.bytes(n); w.u16(v.length); w.bytes(v) }
  }
  const zero16 = new Uint8Array(16)
  const zero8 = new Uint8Array(8)
  w.align(); for (const r of rows) w.u32(r.entry)
  w.align(); for (const r of rows) w.i64(r.ts)
  w.align(); for (const r of rows) w.i64(r.observedTs ?? 0n)
  w.align(); for (const r of rows) w.bytes(r.traceId ?? zero16)
  w.align(); for (const r of rows) w.bytes(r.spanId ?? zero8)
  w.align(); for (const r of rows) w.u32(r.flags ?? 0)
  w.align(); for (const r of rows) w.u8(r.severity ?? 0)
  variable(w, rows.map((r) => te.encode(r.line)))
  variable(w, rows.map((r) => te.encode(r.severityText ?? '')))
  variable(w, rows.map((r) => encoded((x) => {
    const md = r.metadata ?? []
    x.u16(md.length)
    for (const [n, v] of md) { x.str16(n); x.str16(v) }
  })))
  return w.done()
}

function cmp(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return a.length - b.length
}

/** `n` bytes all equal to `x` (ids for tests; never all zero for a trace or span id). */
export const id = (n: 16 | 8, x: number): Uint8Array => new Uint8Array(n).fill(x)
