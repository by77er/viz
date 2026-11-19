import { type Batch, fnv1a64 } from './batch'
import { tooLarge } from './errors'
import type { Limits } from './limits'
import { Meter, SKIM, checkJsonTokens } from './meter'
import {
  type AnyV,
  Buf,
  OVER_MAX,
  checkedList,
  encodeAttrs,
  writeAttrs,
  type KV,
  bad,
  canonList,
  jsonAny,
  jsonAttrs,
  jsonId,
  jsonInt,
  jsonU32,
  list,
  nsHalves,
  nsToMs,
  object,
  parseJson,
  pbAnyValue,
  pbBytes,
  pbFixed32,
  pbKeyValue,
  pbString,
  resourceRoute,
  text,
  utf8,
  utf8Lossy,
} from './otel'
import { PbReader } from './pb'

/**
 * OTLP/HTTP traces → `VZB1` signal 2 (contracts/BATCH.md, "Spans, signal 2").
 *
 * A span that breaks a rule is refused on its own and counted, with its reason, for the
 * response's `partial_success` (OTLP specification, "Partial Success": the server "MUST set
 * the respective rejected_spans ... with the number of spans ... it rejected"). Everything
 * else in the request is stored. A body that does not decode is 400.
 *
 * Memory (edge/README.md, "Memory per request"): what is built for one span, and for one
 * resource and scope, is counted while it is decoded (src/meter.ts); a request's entries and
 * rows are bytes, at most `maxDecodedBytes` of them; nothing refers to the body after decoding.
 */

export const SPAN = {
  maxString: 8192,
  maxEvents: 128,
  maxLinks: 128,
  maxRowBytes: 262_144,
  maxEntryBytes: 262_144,
  rowFixedBytes: 94,
} as const

export const SpanReject = {
  traceId: 'span with an invalid trace_id (not 16 bytes, or all zero)',
  spanId: 'span with an invalid span_id (not 8 bytes, or all zero)',
  parent: 'span with an invalid parent_span_id (not 0 or 8 bytes)',
  kind: 'span with an unknown kind',
  status: 'span with an unknown status code',
  range: 'span timestamp outside 1970 to 2262',
  tooOld: 'span start older than the accept window',
  tooNew: 'span start too far in the future',
  field: 'span name, trace_state, status message, event name or link trace_state over 8,192 bytes',
  events: 'span with more than 128 events',
  links: 'span with more than 128 links',
  link: 'span link with an invalid trace_id or span_id',
  eventTime: 'span event time outside 1970 to 2262',
  tooLarge: 'span over 256 KiB',
  entry: 'resource and scope over 256 KiB',
  values: 'span with more than 65,536 attribute values (entries and array elements, as received)',
  entryValues: 'resource and scope with more than 65,536 attribute values (entries and array elements, as received)',
} as const

const zero = (b: Uint8Array): boolean => b.every((x) => x === 0)
const ZERO8 = new Uint8Array(8)
const EMPTY: Uint8Array = new Uint8Array(0)

/**
 * A row lies in the collector's heap from its offset: these fixed fields (70 bytes), the
 * lengths of its six variable-length columns (u32 each), then their bytes back to back. Its
 * size, `SPAN.rowFixedBytes` (94) plus its variable bytes, is what contracts/BATCH.md counts.
 */
const F = { entry: 0, traceId: 4, spanId: 20, parent: 28, start: 36, end: 44, flags: 52, dropped: 56, kind: 68, status: 69, lens: 70, data: 94 } as const

/** A span as the decoders hand it over; one object is reused for every span of a request. */
export interface SpanIn {
  traceId: Uint8Array
  spanId: Uint8Array
  parent: Uint8Array
  traceState: string
  flags: number
  name: string
  kind: number
  /** fixed64 halves. */
  startLo: number
  startHi: number
  endLo: number
  endHi: number
  attrs: KV[]
  dropped: [number, number, number]
  events: { lo: number; hi: number; name: string; attrs: KV[] }[]
  links: { traceId: Uint8Array; spanId: Uint8Array; traceState: string; attrs: KV[] }[]
  statusMessage: string
  statusCode: number
  /** Events and links as received; only the first 128 of each are built. */
  nEvents: number
  nLinks: number
  /** Over the decode limit (src/meter.ts): not all of it was built, and it is refused. */
  over: boolean
}

export function newSpanIn(): SpanIn {
  return { traceId: EMPTY, spanId: EMPTY, parent: EMPTY, traceState: '', flags: 0, name: '', kind: 0, startLo: 0, startHi: 0, endLo: 0, endHi: 0, attrs: [], dropped: [0, 0, 0], events: [], links: [], statusMessage: '', statusCode: 0, nEvents: 0, nLinks: 0, over: false }
}

function clearSpan(s: SpanIn): void {
  s.traceId = s.spanId = s.parent = EMPTY
  s.traceState = s.name = s.statusMessage = ''
  s.flags = s.kind = s.statusCode = s.startLo = s.startHi = s.endLo = s.endHi = s.nEvents = s.nLinks = 0
  s.attrs.length = s.events.length = s.links.length = 0
  s.dropped[0] = s.dropped[1] = s.dropped[2] = 0
  s.over = false
}

/** A resource as the collector prepares it once per `ResourceSpans`: its typed attributes, fingerprint and routing key. */
export interface PreparedResource {
  typed: Uint8Array
  fp: bigint
  route: string
  /** Index among the request's distinct resources, once one of its entries exists. */
  id: number
}

const latin1 = (b: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < b.length; i += 4096) s += String.fromCharCode(...b.subarray(i, i + 4096))
  return s
}

/** Accumulates the validated spans of one request, grouped by (resource, scope) entry. */
export class SpanCollector {
  readonly entryBytes: Uint8Array[] = []
  private readonly entryByKey = new Map<string, number>()
  private readonly resourceByKey = new Map<string, number>()
  /** Routing key of each entry, interned. */
  readonly routes: string[] = []
  readonly routeOf: number[] = []
  private readonly routeIdx = new Map<string, number>()
  /** Every accepted row, as bytes (layout `F`). */
  private readonly heap = new Buf(1 << 16)
  private rowAt: Uint32Array = new Uint32Array(256)
  private rowEntry: Uint32Array = new Uint32Array(256)
  nRows = 0
  rowSeries: Uint32Array = new Uint32Array(0)
  /** Bytes of entries and rows so far, against `limits.maxDecodedBytes`. */
  decoded = 0
  /** Meters of the resource and scope being decoded, and of the span. */
  readonly entryMeter = new Meter()
  readonly spanMeter = new Meter()

  received = 0
  rejectedTotal = 0
  readonly rejected = new Map<string, number>()
  private readonly minMs: number
  private readonly maxMs: number

  constructor(readonly limits: Limits, now: number) {
    this.minMs = Math.max(now - limits.spanAcceptBackMs, 0)
    this.maxMs = now + limits.spanAcceptAheadMs
  }

  get nSeries(): number {
    return this.entryBytes.length
  }
  /** Spans are not metered (contracts/BATCH.md): no ids. */
  seriesId(): bigint {
    return 0n
  }

  reject(reason: string, count = 1): void {
    if (count <= 0) return
    this.rejected.set(reason, (this.rejected.get(reason) ?? 0) + count)
    this.rejectedTotal += count
    this.received += count
  }

  rejectionSummary(): string {
    const s = [...this.rejected].map(([r, n]) => `${n} ${r}`).join('; ')
    // Bounded, as the OTLP specification asks of partial-success messages; long enough to name every reason.
    return s.length > 2048 ? `${s.slice(0, 2045)}...` : s
  }

  private charge(bytes: number): void {
    if (this.decoded + bytes > this.limits.maxDecodedBytes) {
      throw tooLarge(`request decodes into more than ${this.limits.maxDecodedBytes} bytes of spans; send smaller requests`)
    }
    this.decoded += bytes
  }

  /** A resource, prepared once for all its scopes: or the reason every span of it is refused. */
  resource(attrs: readonly KV[]): PreparedResource | string {
    // The entry's other fields take at least 16 bytes.
    const typed = encodeAttrs(attrs, SPAN.maxEntryBytes - 16)
    if (typed === OVER_MAX) return SpanReject.entry
    if (typeof typed === 'string') return `resource ${typed}`
    return { typed, fp: fnv1a64(utf8(canonList(attrs))), route: resourceRoute(attrs), id: -1 }
  }

  /**
   * The entry for a (resource, scope): its index, or the reason every span of it is refused.
   * The scope's attributes become canonical OTLP JSON. An entry is found again by its
   * resource and the scope's own bytes, so a scope costs its own size, not its resource's.
   */
  entry(res: PreparedResource, scopeName: string, scopeVersion: string, scopeAttrs: readonly KV[]): number | string {
    const sname = utf8(scopeName)
    const sver = utf8(scopeVersion)
    if (sname.length > SPAN.maxString || sver.length > SPAN.maxString) return SpanReject.field
    let sattrs = ''
    if (scopeAttrs.length > 0) {
      sattrs = checkedList(scopeAttrs)
      if (sattrs.startsWith('!')) return `scope ${sattrs.slice(1)}`
    }
    const sa = utf8(sattrs)
    const size = 8 + res.typed.length + 2 + sname.length + 2 + sver.length + 4 + sa.length
    if (size > SPAN.maxEntryBytes) return SpanReject.entry
    const scope = new Buf(8 + sname.length + sver.length + sa.length)
    scope.u16(sname.length)
    scope.bytes(sname)
    scope.u16(sver.length)
    scope.bytes(sver)
    scope.u32(sa.length)
    scope.bytes(sa)
    const scopeBytes = scope.done()
    if (res.id < 0) {
      const rkey = latin1(res.typed)
      const known = this.resourceByKey.get(rkey)
      if (known !== undefined) res.id = known
      else {
        this.charge(rkey.length)
        res.id = this.resourceByKey.size
        this.resourceByKey.set(rkey, res.id)
      }
    }
    const key = `${res.id}:${latin1(scopeBytes)}`
    const hit = this.entryByKey.get(key)
    if (hit !== undefined) return hit
    const b = new Buf(size)
    b.big(res.fp)
    b.bytes(res.typed)
    b.bytes(scopeBytes)
    const bytes = b.done()
    this.charge(bytes.length + key.length + res.route.length)
    const idx = this.entryBytes.length
    this.entryBytes.push(bytes)
    this.entryByKey.set(key, idx)
    let r = this.routeIdx.get(res.route)
    if (r === undefined) {
      r = this.routes.length
      this.routes.push(res.route)
      this.routeIdx.set(res.route, r)
    }
    this.routeOf.push(r)
    return idx
  }

  /** Validate one span of entry `entry` (or refuse it) and add it. */
  add(entry: number, s: SpanIn): void {
    const no = (reason: string): void => this.reject(reason)
    if (s.traceId.length !== 16 || zero(s.traceId)) return no(SpanReject.traceId)
    if (s.spanId.length !== 8 || zero(s.spanId)) return no(SpanReject.spanId)
    if (s.parent.length !== 0 && s.parent.length !== 8) return no(SpanReject.parent)
    if (!(s.kind >= 0 && s.kind <= 5)) return no(SpanReject.kind)
    if (!(s.statusCode >= 0 && s.statusCode <= 2)) return no(SpanReject.status)
    if (s.startHi >= 0x80000000 || s.endHi >= 0x80000000) return no(SpanReject.range)
    const startMs = nsToMs(s.startLo, s.startHi)
    if (startMs < this.minMs) return no(SpanReject.tooOld)
    if (startMs > this.maxMs) return no(SpanReject.tooNew)
    let { endLo, endHi } = s
    let attrs = s.attrs
    if (endHi < s.startHi || (endHi === s.startHi && endLo < s.startLo)) {
      // contracts/TRACES.md: stored with end = start and `viz.clamped_end = true`.
      endLo = s.startLo
      endHi = s.startHi
      attrs = [...attrs, ['viz.clamped_end', { k: 'b', v: true }]]
    }
    if (s.nEvents > SPAN.maxEvents) return no(SpanReject.events)
    if (s.nLinks > SPAN.maxLinks) return no(SpanReject.links)
    if (s.over) return no(SpanReject.values)
    // Anything longer than this in UTF-16 units is longer in bytes too: refused before it is written.
    const maxVar = SPAN.maxRowBytes - SPAN.rowFixedBytes
    if (s.name.length > SPAN.maxString || s.traceState.length > SPAN.maxString || s.statusMessage.length > SPAN.maxString) return no(SpanReject.field)
    const h = this.heap
    const at = h.n
    const undo = (reason: string): void => {
      h.n = at
      no(reason)
    }
    h.u32(entry)
    h.bytes(s.traceId)
    h.bytes(s.spanId)
    h.bytes(s.parent.length === 0 || zero(s.parent) ? ZERO8 : s.parent)
    h.i64(s.startLo, s.startHi)
    h.i64(endLo, endHi)
    h.u32(s.flags >>> 0)
    h.u32(s.dropped[0])
    h.u32(s.dropped[1])
    h.u32(s.dropped[2])
    h.u8(s.kind)
    h.u8(s.statusCode)
    for (let i = 0; i < 6; i++) h.u32(0)
    const d0 = h.n
    const nameLen = h.str(s.name)
    const tsLen = h.str(s.traceState)
    const smLen = h.str(s.statusMessage)
    if (nameLen > SPAN.maxString || tsLen > SPAN.maxString || smLen > SPAN.maxString) return undo(SpanReject.field)
    const a0 = h.n
    const why = writeAttrs(attrs, h, maxVar - (a0 - d0))
    if (why !== null) return undo(why === OVER_MAX ? SpanReject.tooLarge : why)
    const e0 = h.n
    h.u16(s.events.length)
    for (const e of s.events) {
      if (e.hi >= 0x80000000) return undo(SpanReject.eventTime)
      h.i64(e.lo, e.hi)
      if (e.name.length > SPAN.maxString || h.strU16(e.name) > SPAN.maxString) return undo(SpanReject.field)
      const j = e.attrs.length === 0 ? '[]' : checkedList(e.attrs)
      if (j.startsWith('!')) return undo(`event ${j.slice(1)}`)
      if (j.length > maxVar - (h.n - d0)) return undo(SpanReject.tooLarge)
      h.strU32(j)
    }
    const l0 = h.n
    h.u16(s.links.length)
    for (const l of s.links) {
      if (l.traceId.length !== 16 || zero(l.traceId) || l.spanId.length !== 8 || zero(l.spanId)) return undo(SpanReject.link)
      h.bytes(l.traceId)
      h.bytes(l.spanId)
      if (l.traceState.length > SPAN.maxString || h.strU16(l.traceState) > SPAN.maxString) return undo(SpanReject.field)
      const j = l.attrs.length === 0 ? '[]' : checkedList(l.attrs)
      if (j.startsWith('!')) return undo(`link ${j.slice(1)}`)
      if (j.length > maxVar - (h.n - d0)) return undo(SpanReject.tooLarge)
      h.strU32(j)
    }
    const size = h.n - at
    if (size > SPAN.maxRowBytes) return undo(SpanReject.tooLarge)
    if (this.nRows >= this.limits.maxSpans) throw tooLarge(`more than ${this.limits.maxSpans} spans in one request`)
    this.charge(size)
    const lens = [nameLen, tsLen, smLen, e0 - a0, l0 - e0, h.n - l0]
    for (let i = 0; i < 6; i++) h.setU32(at + F.lens + 4 * i, lens[i]!)
    if (this.nRows === this.rowAt.length) {
      const grow = (a: Uint32Array): Uint32Array => {
        const g = new Uint32Array(a.length * 2)
        g.set(a)
        return g
      }
      this.rowAt = grow(this.rowAt)
      this.rowEntry = grow(this.rowEntry)
    }
    this.rowAt[this.nRows] = at
    this.rowEntry[this.nRows] = entry
    this.nRows++
    this.received++
  }

  /** Finish: the entry of each row, for routing. */
  seal(): void {
    this.rowSeries = this.rowEntry.slice(0, this.nRows)
  }

  private sizeOf(i: number): number {
    return (i + 1 < this.nRows ? this.rowAt[i + 1]! : this.heap.n) - this.rowAt[i]!
  }

  /** Batches per slot (contracts/BATCH.md): rows in arrival order, each batch at most `maxBatchBytes`. */
  build(slotOfEntry: ArrayLike<number>, maxBatchBytes: number): Map<number, Batch[]> {
    const bySlot = new Map<number, number[]>()
    for (let i = 0; i < this.nRows; i++) {
      const slot = slotOfEntry[this.rowEntry[i]!]!
      let l = bySlot.get(slot)
      if (!l) bySlot.set(slot, (l = []))
      l.push(i)
    }
    const out = new Map<number, Batch[]>()
    for (const [slot, rows] of bySlot) {
      const batches: Batch[] = []
      let from = 0
      while (from < rows.length) {
        const local = new Map<number, number>()
        let entryBytes = 0
        let varBytes = 0
        let to = from
        for (; to < rows.length; to++) {
          const row = rows[to]!
          const entry = this.rowEntry[row]!
          const isNew = !local.has(entry)
          const e = entryBytes + (isNew ? this.entryBytes[entry]!.length : 0)
          const n = to - from + 1
          const v = this.sizeOf(row) - SPAN.rowFixedBytes
          // An upper bound on the encoded size: header, entries, fixed columns, offsets, data, padding.
          const bound = 16 + e + 8 + 70 * n + 24 * (n + 1) + varBytes + v + 8 * 16
          if (n > 1 && bound > maxBatchBytes) break
          if (isNew) {
            local.set(entry, local.size)
            entryBytes = e
          }
          varBytes += v
        }
        batches.push(this.encode(rows.slice(from, to), local))
        from = to
      }
      out.set(slot, batches)
    }
    return out
  }

  private encode(rows: number[], local: Map<number, number>): Batch {
    const b = new Buf(1 << 16)
    b.bytes(new Uint8Array([0x56, 0x5a, 0x42, 0x31, 2, 0, 0, 0]))
    b.u32(rows.length)
    b.u32(local.size)
    for (const e of local.keys()) b.bytes(this.entryBytes[e]!)
    const heap = this.heap.b
    const view = new DataView(heap.buffer, heap.byteOffset, heap.byteLength)
    const fixed = (off: number, len: number): void => {
      b.pad8()
      for (const r of rows) {
        const at = this.rowAt[r]! + off
        b.bytes(heap.subarray(at, at + len))
      }
    }
    b.pad8()
    for (const r of rows) b.u32(local.get(this.rowEntry[r]!)!)
    fixed(F.traceId, 16)
    fixed(F.spanId, 8)
    fixed(F.parent, 8)
    fixed(F.start, 8)
    fixed(F.end, 8)
    fixed(F.flags, 4)
    fixed(F.dropped, 12)
    fixed(F.kind, 1)
    fixed(F.status, 1)
    for (let col = 0; col < 6; col++) {
      b.pad8()
      let off = 0
      b.u32(0)
      for (const r of rows) {
        off += view.getUint32(this.rowAt[r]! + F.lens + 4 * col, true)
        b.u32(off)
      }
      b.pad8()
      for (const r of rows) {
        const at = this.rowAt[r]!
        let from = at + F.data
        for (let k = 0; k < col; k++) from += view.getUint32(at + F.lens + 4 * k, true)
        b.bytes(heap.subarray(from, from + view.getUint32(at + F.lens + 4 * col, true)))
      }
    }
    b.pad8()
    return { bytes: b.done(), rows: rows.length }
  }
}

// ───────────────────────────── protobuf ─────────────────────────────
//
//   ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
//   ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
//   Resource      { repeated KeyValue attributes = 1; }
//   ScopeSpans    { InstrumentationScope scope = 1; repeated Span spans = 2; }
//   InstrumentationScope { string name = 1; string version = 2; repeated KeyValue attributes = 3; }
//   Span { bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; bytes parent_span_id = 4;
//          string name = 5; SpanKind kind = 6; fixed64 start_time_unix_nano = 7;
//          fixed64 end_time_unix_nano = 8; repeated KeyValue attributes = 9;
//          uint32 dropped_attributes_count = 10; repeated Event events = 11;
//          uint32 dropped_events_count = 12; repeated Link links = 13;
//          uint32 dropped_links_count = 14; Status status = 15; fixed32 flags = 16; }
//   Event  { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; }
//   Link   { bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; repeated KeyValue attributes = 4; }
//   Status { string message = 2; StatusCode code = 3; }
//
// A message's fields may arrive in any order, so a level is read twice: first for what its
// children need (the resource, the scope) and to count them, then for the children, in
// order. Nothing is kept per child between the two passes.

export function decodeTracesProto(body: Uint8Array, c: SpanCollector): void {
  const r = new PbReader(body)
  const s = newSpanIn()
  while (r.pos < r.end) {
    const tag = r.uint32()
    if (tag === 0x0a) resourceSpans(r, c, s)
    else r.skip(tag & 7)
  }
  c.seal()
}

function resourceSpans(r: PbReader, c: SpanCollector, s: SpanIn): void {
  const end = r.len()
  const start = r.pos
  const m = c.entryMeter.reset()
  const attrs: KV[] = []
  let scopes = 0
  while (r.pos < end) {
    const tag = r.uint32()
    if (tag === 0x0a) {
      const rend = r.len()
      while (r.pos < rend) {
        const t = r.uint32()
        if (t === 0x0a) {
          const kv = pbKeyValue(r, m)
          if (kv) attrs.push(kv)
        } else r.skip(t & 7)
      }
      r.done(rend)
    } else if (tag === 0x12) {
      scopes++
      r.pos = r.len()
    } else r.skip(tag & 7)
  }
  r.done(end)
  if (scopes === 0) return
  const used = m.used
  let res: PreparedResource | string | null = m.over ? SpanReject.entryValues : null
  r.pos = start
  while (r.pos < end) {
    const tag = r.uint32()
    if (tag !== 0x12) {
      r.skip(tag & 7)
      continue
    }
    const send = r.len()
    const sstart = r.pos
    const sm = c.entryMeter.reset(used)
    let name = ''
    let version = ''
    const sattrs: KV[] = []
    let spans = 0
    while (r.pos < send) {
      const t = r.uint32()
      if (t === 0x0a) {
        const scend = r.len()
        while (r.pos < scend) {
          const st = r.uint32()
          if (st === 0x0a) name = pbString(r)
          else if (st === 0x12) version = pbString(r)
          else if (st === 0x1a) {
            const kv = pbKeyValue(r, sm)
            if (kv) sattrs.push(kv)
          } else r.skip(st & 7)
        }
        r.done(scend)
      } else if (t === 0x12) {
        spans++
        r.pos = r.len()
      } else r.skip(t & 7)
    }
    r.done(send)
    if (spans === 0) continue
    res ??= c.resource(attrs)
    const entry = typeof res === 'string' ? res : sm.over ? SpanReject.entryValues : c.entry(res, name, version, sattrs)
    if (typeof entry === 'string') {
      c.reject(entry, spans)
      continue
    }
    r.pos = sstart
    while (r.pos < send) {
      const t = r.uint32()
      if (t === 0x12) {
        span(r, c.spanMeter, s)
        c.add(entry, s)
      } else r.skip(t & 7)
    }
  }
  r.pos = end
}

function span(r: PbReader, m: Meter, s: SpanIn): void {
  const end = r.len()
  m.reset()
  clearSpan(s)
  while (r.pos < end) {
    const tag = r.uint32()
    switch (tag) {
      case 0x0a:
        s.traceId = pbBytes(r)
        break
      case 0x12:
        s.spanId = pbBytes(r)
        break
      case 0x1a:
        s.traceState = pbString(r)
        break
      case 0x22:
        s.parent = pbBytes(r)
        break
      case 0x2a:
        s.name = pbString(r)
        break
      case 0x30:
        r.varint64()
        s.kind = r.hi === 0 && r.lo <= 0x7fffffff ? r.lo : -1
        break
      case 0x39:
        r.fixed64()
        s.startLo = r.lo
        s.startHi = r.hi
        break
      case 0x41:
        r.fixed64()
        s.endLo = r.lo
        s.endHi = r.hi
        break
      case 0x4a: {
        const kv = pbKeyValue(r, m)
        if (kv) s.attrs.push(kv)
        break
      }
      case 0x50:
        s.dropped[0] = r.uint32() >>> 0
        break
      case 0x5a: {
        const keep = ++s.nEvents <= SPAN.maxEvents && !m.over
        const e = event(r, keep ? m : SKIM, keep)
        if (e) s.events.push(e)
        break
      }
      case 0x60:
        s.dropped[1] = r.uint32() >>> 0
        break
      case 0x6a: {
        const keep = ++s.nLinks <= SPAN.maxLinks && !m.over
        const l = link(r, keep ? m : SKIM, keep)
        if (l) s.links.push(l)
        break
      }
      case 0x70:
        s.dropped[2] = r.uint32() >>> 0
        break
      case 0x7a: {
        const send = r.len()
        while (r.pos < send) {
          const t = r.uint32()
          if (t === 0x12) s.statusMessage = pbString(r)
          else if (t === 0x18) {
            r.varint64()
            s.statusCode = r.hi === 0 && r.lo <= 0x7fffffff ? r.lo : -1
          } else r.skip(t & 7)
        }
        r.done(send)
        break
      }
      case 0x85: // field 16 (flags), wire type 5: the tag is the varint 0x85 0x01
        s.flags = pbFixed32(r)
        break
      default:
        r.skip(tag & 7)
    }
  }
  r.done(end)
  s.over = m.over
}

/** An event, or null when it is not kept (only read, to check the wire). */
function event(r: PbReader, m: Meter, keep: boolean): SpanIn['events'][number] | null {
  const end = r.len()
  let lo = 0
  let hi = 0
  let name = ''
  const attrs: KV[] | null = keep ? [] : null
  while (r.pos < end) {
    const t = r.uint32()
    if (t === 0x09) {
      r.fixed64()
      lo = r.lo
      hi = r.hi
    } else if (t === 0x12) {
      const e = r.len()
      if (keep) name = utf8Lossy(r.buf, r.pos, e)
      r.pos = e
    } else if (t === 0x1a) {
      const kv = pbKeyValue(r, m)
      if (kv) attrs!.push(kv)
    } else r.skip(t & 7)
  }
  r.done(end)
  return keep ? { lo, hi, name, attrs: attrs! } : null
}

/** A link, or null when it is not kept (only read, to check the wire). */
function link(r: PbReader, m: Meter, keep: boolean): SpanIn['links'][number] | null {
  const end = r.len()
  let traceId = EMPTY
  let spanId = EMPTY
  let traceState = ''
  const attrs: KV[] | null = keep ? [] : null
  while (r.pos < end) {
    const t = r.uint32()
    if (t === 0x0a) traceId = pbBytes(r)
    else if (t === 0x12) spanId = pbBytes(r)
    else if (t === 0x1a) {
      const e = r.len()
      if (keep) traceState = utf8Lossy(r.buf, r.pos, e)
      r.pos = e
    } else if (t === 0x22) {
      const kv = pbKeyValue(r, m)
      if (kv) attrs!.push(kv)
    } else r.skip(t & 7)
  }
  r.done(end)
  return keep ? { traceId, spanId, traceState, attrs: attrs! } : null
}

// ─────────────────────────────── JSON ───────────────────────────────

const KINDS = ['SPAN_KIND_UNSPECIFIED', 'SPAN_KIND_INTERNAL', 'SPAN_KIND_SERVER', 'SPAN_KIND_CLIENT', 'SPAN_KIND_PRODUCER', 'SPAN_KIND_CONSUMER']
const CODES = ['STATUS_CODE_UNSET', 'STATUS_CODE_OK', 'STATUS_CODE_ERROR']

/** An enum as an integer (OTLP/JSON), or its name (accepted too). Unknown values are -1. */
function jsonEnum(v: unknown, names: string[], what: string): number {
  if (v === undefined || v === null) return 0
  if (typeof v === 'number' && Number.isInteger(v)) return v >= 0 && v <= 0x7fffffff ? v : -1
  if (typeof v === 'string') return names.indexOf(v)
  return bad(`${what} is not an enum`)
}

/** A fixed64 time field (decimal string or number) as halves; out of range gives hi = 2^31 (refused later). */
function jsonTime(v: unknown, what: string): [number, number] {
  const n = jsonInt(v, what) ?? 0n
  if (n < 0n) bad(`${what} is negative`)
  return nsHalves(n) ?? [0, 0x80000000]
}

export function decodeTracesJson(body: Uint8Array, c: SpanCollector): void {
  checkJsonTokens(body, c.limits.maxJsonTokens)
  const root = parseJson(body, 'OTLP JSON')
  const s = newSpanIn()
  for (const rsRaw of list(root.resourceSpans, 'resourceSpans')) {
    const rs = object(rsRaw, 'resourceSpans[]')
    const m = c.entryMeter.reset()
    const attrs = jsonAttrs(object(rs.resource, 'resource').attributes, m)
    const used = m.used
    let res: PreparedResource | string | null = m.over ? SpanReject.entryValues : null
    for (const ssRaw of list(rs.scopeSpans, 'scopeSpans')) {
      const ss = object(ssRaw, 'scopeSpans[]')
      const scope = object(ss.scope, 'scope')
      const spans = list(ss.spans, 'spans')
      const sm = c.entryMeter.reset(used)
      const name = text(scope.name, 'scope name')
      const version = text(scope.version, 'scope version')
      const sattrs = jsonAttrs(scope.attributes, sm)
      if (spans.length === 0) continue
      res ??= c.resource(attrs)
      const entry = typeof res === 'string' ? res : sm.over ? SpanReject.entryValues : c.entry(res, name, version, sattrs)
      if (typeof entry === 'string') {
        c.reject(entry, spans.length)
        continue
      }
      for (const raw of spans) {
        jsonSpan(object(raw, 'spans[]'), c.spanMeter, s)
        c.add(entry, s)
      }
    }
  }
  c.seal()
}

function jsonSpan(x: Record<string, unknown>, m: Meter, s: SpanIn): void {
  m.reset()
  clearSpan(s)
  ;[s.startLo, s.startHi] = jsonTime(x.startTimeUnixNano, 'startTimeUnixNano')
  ;[s.endLo, s.endHi] = jsonTime(x.endTimeUnixNano, 'endTimeUnixNano')
  const status = object(x.status, 'status')
  s.traceId = jsonId(x.traceId, 'traceId')
  s.spanId = jsonId(x.spanId, 'spanId')
  s.parent = jsonId(x.parentSpanId, 'parentSpanId')
  s.traceState = text(x.traceState, 'traceState')
  s.flags = jsonU32(x.flags, 'flags')
  s.name = text(x.name, 'name')
  s.kind = jsonEnum(x.kind, KINDS, 'kind')
  s.attrs = jsonAttrs(x.attributes, m)
  s.dropped[0] = jsonU32(x.droppedAttributesCount, 'droppedAttributesCount')
  s.dropped[1] = jsonU32(x.droppedEventsCount, 'droppedEventsCount')
  s.dropped[2] = jsonU32(x.droppedLinksCount, 'droppedLinksCount')
  for (const raw of list(x.events, 'events')) {
    const keep = ++s.nEvents <= SPAN.maxEvents && !m.over
    const e = object(raw, 'events[]')
    const [lo, hi] = jsonTime(e.timeUnixNano, 'timeUnixNano')
    const name = text(e.name, 'event name')
    const attrs = jsonAttrs(e.attributes, keep ? m : SKIM)
    if (keep) s.events.push({ lo, hi, name, attrs })
  }
  for (const raw of list(x.links, 'links')) {
    const keep = ++s.nLinks <= SPAN.maxLinks && !m.over
    const l = object(raw, 'links[]')
    const traceId = jsonId(l.traceId, 'link traceId')
    const spanId = jsonId(l.spanId, 'link spanId')
    const traceState = text(l.traceState, 'link traceState')
    const attrs = jsonAttrs(l.attributes, keep ? m : SKIM)
    if (keep) s.links.push({ traceId, spanId, traceState, attrs })
  }
  s.statusMessage = text(status.message, 'status message')
  s.statusCode = jsonEnum(status.code, CODES, 'status code')
  s.over = m.over
}

/** For tests and tools: an AnyValue from a JSON-decoded OTLP value. */
export const anyFromJson = (raw: unknown): AnyV => jsonAny(raw, 0)
/** For tests: an AnyValue straight from protobuf bytes of an AnyValue message (length-prefixed). */
export const anyFromProto = (buf: Uint8Array): AnyV => pbAnyValue(new PbReader(buf), 0)
