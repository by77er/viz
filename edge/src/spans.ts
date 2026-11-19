import { fnv1a64 } from './batch'
import { tooLarge } from './errors'
import type { Limits } from './limits'
import {
  type AnyV,
  Buf,
  checkedList,
  encodeAttrs,
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
} from './otel'
import { PbReader } from './pb'
import type { Batch } from './batch'

/**
 * OTLP/HTTP traces → `VZB1` signal 2 (contracts/BATCH.md, "Spans, signal 2").
 *
 * A span that breaks a rule is refused on its own and counted, with its reason, for the
 * response's `partial_success` (OTLP specification, "Partial Success": the server "MUST set
 * the respective rejected_spans ... with the number of spans ... it rejected"). Everything
 * else in the request is stored. A body that does not decode is 400.
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
} as const

const zero = (b: Uint8Array): boolean => b.every((x) => x === 0)
const ZERO8 = new Uint8Array(8)

/** One accepted span, ready to be written into a batch. */
interface Row {
  entry: number
  traceId: Uint8Array
  spanId: Uint8Array
  parent: Uint8Array
  startLo: number
  startHi: number
  endLo: number
  endHi: number
  flags: number
  dropped: [number, number, number]
  kind: number
  status: number
  name: Uint8Array
  traceState: Uint8Array
  statusMessage: Uint8Array
  attrs: Uint8Array
  events: Uint8Array
  links: Uint8Array
  /** Bytes in a batch: fixed columns, offsets, variable data. */
  size: number
}

/** A span as the decoders hand it over. */
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
}

/** Accumulates the validated spans of one request, grouped by (resource, scope) entry. */
export class SpanCollector {
  readonly entryBytes: Uint8Array[] = []
  private readonly entryByKey = new Map<string, number>()
  /** Routing key of each entry, interned. */
  readonly routes: string[] = []
  readonly routeOf: number[] = []
  private readonly routeIdx = new Map<string, number>()
  readonly rows: Row[] = []
  rowSeries = new Uint32Array(0)

  received = 0
  rejectedTotal = 0
  readonly rejected = new Map<string, number>()
  private readonly minMs: number
  private readonly maxMs: number

  constructor(readonly limits: Limits, now: number) {
    this.minMs = Math.max(now - limits.spanAcceptBackMs, 0)
    this.maxMs = now + limits.spanAcceptAheadMs
  }

  get nRows(): number {
    return this.rows.length
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

  /**
   * The entry for a (resource, scope): its index, or the reason every span of it is refused.
   * `resource` is the full resource attribute list; the scope's attributes become canonical
   * OTLP JSON.
   */
  entry(resource: readonly KV[], scopeName: string, scopeVersion: string, scopeAttrs: readonly KV[]): number | string {
    const attrs = encodeAttrs(resource)
    if (typeof attrs === 'string') return `resource ${attrs}`
    const sname = utf8(scopeName)
    const sver = utf8(scopeVersion)
    if (sname.length > SPAN.maxString || sver.length > SPAN.maxString) return SpanReject.field
    let sattrs = ''
    if (scopeAttrs.length > 0) {
      sattrs = checkedList(scopeAttrs)
      if (sattrs.startsWith('!')) return `scope ${sattrs.slice(1)}`
    }
    const sa = utf8(sattrs)
    const fp = fnv1a64(utf8(canonList(resource)))
    const b = new Buf(16 + attrs.length + sname.length + sver.length + sa.length)
    b.big(fp)
    b.bytes(attrs)
    b.u16(sname.length)
    b.bytes(sname)
    b.u16(sver.length)
    b.bytes(sver)
    b.u32(sa.length)
    b.bytes(sa)
    const bytes = b.done()
    if (bytes.length > SPAN.maxEntryBytes) return SpanReject.entry
    let key = ''
    for (let i = 0; i < bytes.length; i += 4096) key += String.fromCharCode(...bytes.subarray(i, i + 4096))
    const hit = this.entryByKey.get(key)
    if (hit !== undefined) return hit
    const idx = this.entryBytes.length
    this.entryBytes.push(bytes)
    this.entryByKey.set(key, idx)
    const route = resourceRoute(resource)
    let r = this.routeIdx.get(route)
    if (r === undefined) {
      r = this.routes.length
      this.routes.push(route)
      this.routeIdx.set(route, r)
    }
    this.routeOf.push(r)
    return idx
  }

  /** Validate one span of entry `entry` (or refuse it) and add it. */
  add(entry: number, s: SpanIn): void {
    this.received++
    const no = (reason: string): void => {
      this.received--
      this.reject(reason)
    }
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
    if (s.events.length > SPAN.maxEvents) return no(SpanReject.events)
    if (s.links.length > SPAN.maxLinks) return no(SpanReject.links)
    const name = utf8(s.name)
    const traceState = utf8(s.traceState)
    const statusMessage = utf8(s.statusMessage)
    if (name.length > SPAN.maxString || traceState.length > SPAN.maxString || statusMessage.length > SPAN.maxString) return no(SpanReject.field)
    const a = encodeAttrs(attrs)
    if (typeof a === 'string') return no(a)

    const ev = new Buf(64)
    ev.u16(s.events.length)
    for (const e of s.events) {
      if (e.hi >= 0x80000000) return no(SpanReject.eventTime)
      const n = utf8(e.name)
      if (n.length > SPAN.maxString) return no(SpanReject.field)
      const j = e.attrs.length === 0 ? '[]' : checkedList(e.attrs)
      if (j.startsWith('!')) return no(`event ${j.slice(1)}`)
      const jb = utf8(j)
      ev.i64(e.lo, e.hi)
      ev.u16(n.length)
      ev.bytes(n)
      ev.u32(jb.length)
      ev.bytes(jb)
    }
    const lk = new Buf(64)
    lk.u16(s.links.length)
    for (const l of s.links) {
      if (l.traceId.length !== 16 || zero(l.traceId) || l.spanId.length !== 8 || zero(l.spanId)) return no(SpanReject.link)
      const ts = utf8(l.traceState)
      if (ts.length > SPAN.maxString) return no(SpanReject.field)
      const j = l.attrs.length === 0 ? '[]' : checkedList(l.attrs)
      if (j.startsWith('!')) return no(`link ${j.slice(1)}`)
      const jb = utf8(j)
      lk.bytes(l.traceId)
      lk.bytes(l.spanId)
      lk.u16(ts.length)
      lk.bytes(ts)
      lk.u32(jb.length)
      lk.bytes(jb)
    }
    const events = ev.done()
    const links = lk.done()
    const size = SPAN.rowFixedBytes + name.length + traceState.length + statusMessage.length + a.length + events.length + links.length
    if (size > SPAN.maxRowBytes) return no(SpanReject.tooLarge)
    if (this.rows.length >= this.limits.maxSpans) throw tooLarge(`more than ${this.limits.maxSpans} spans in one request`)
    this.rows.push({
      entry,
      traceId: s.traceId,
      spanId: s.spanId,
      parent: s.parent.length === 0 || zero(s.parent) ? ZERO8 : s.parent,
      startLo: s.startLo,
      startHi: s.startHi,
      endLo,
      endHi,
      flags: s.flags >>> 0,
      dropped: s.dropped,
      kind: s.kind,
      status: s.statusCode,
      name,
      traceState,
      statusMessage,
      attrs: a,
      events,
      links,
      size,
    })
  }

  /** Finish: the entry of each row, for routing. */
  seal(): void {
    this.rowSeries = Uint32Array.from(this.rows, (r) => r.entry)
  }

  /** Batches per slot (contracts/BATCH.md): rows in arrival order, each batch at most `maxBatchBytes`. */
  build(slotOfEntry: ArrayLike<number>, maxBatchBytes: number): Map<number, Batch[]> {
    const bySlot = new Map<number, Row[]>()
    for (const r of this.rows) {
      const slot = slotOfEntry[r.entry]!
      let l = bySlot.get(slot)
      if (!l) bySlot.set(slot, (l = []))
      l.push(r)
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
          const r = rows[to]!
          const isNew = !local.has(r.entry)
          const e = entryBytes + (isNew ? this.entryBytes[r.entry]!.length : 0)
          const n = to - from + 1
          // An upper bound on the encoded size: header, entries, fixed columns, offsets, data, padding.
          const bound = 16 + e + 8 + 70 * n + 24 * (n + 1) + varBytes + (r.size - SPAN.rowFixedBytes) + 8 * 16
          if (n > 1 && bound > maxBatchBytes) break
          if (isNew) {
            local.set(r.entry, local.size)
            entryBytes = e
          }
          varBytes += r.size - SPAN.rowFixedBytes
        }
        batches.push(this.encode(rows.slice(from, to), local))
        from = to
      }
      out.set(slot, batches)
    }
    return out
  }

  private encode(rows: Row[], local: Map<number, number>): Batch {
    const b = new Buf(1024)
    b.bytes(new Uint8Array([0x56, 0x5a, 0x42, 0x31, 2, 0, 0, 0]))
    b.u32(rows.length)
    b.u32(local.size)
    for (const e of local.keys()) b.bytes(this.entryBytes[e]!)
    const fixed = (f: (r: Row) => void): void => {
      b.pad8()
      for (const r of rows) f(r)
    }
    fixed((r) => b.u32(local.get(r.entry)!))
    fixed((r) => b.bytes(r.traceId))
    fixed((r) => b.bytes(r.spanId))
    fixed((r) => b.bytes(r.parent))
    fixed((r) => b.i64(r.startLo, r.startHi))
    fixed((r) => b.i64(r.endLo, r.endHi))
    fixed((r) => b.u32(r.flags))
    fixed((r) => {
      b.u32(r.dropped[0])
      b.u32(r.dropped[1])
      b.u32(r.dropped[2])
    })
    fixed((r) => b.u8(r.kind))
    fixed((r) => b.u8(r.status))
    for (const col of ['name', 'traceState', 'statusMessage', 'attrs', 'events', 'links'] as const) {
      b.pad8()
      let off = 0
      b.u32(0)
      for (const r of rows) {
        off += r[col].length
        b.u32(off)
      }
      b.pad8()
      for (const r of rows) b.bytes(r[col])
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

export function decodeTracesProto(body: Uint8Array, c: SpanCollector): void {
  const r = new PbReader(body)
  while (r.pos < r.end) {
    const tag = r.uint32()
    if (tag === 0x0a) resourceSpans(r, c)
    else r.skip(tag & 7)
  }
  c.seal()
}

function resourceSpans(r: PbReader, c: SpanCollector): void {
  const end = r.len()
  const scopes: number[] = []
  const attrs: KV[] = []
  while (r.pos < end) {
    const tag = r.uint32()
    if (tag === 0x0a) {
      const rend = r.len()
      while (r.pos < rend) {
        const t = r.uint32()
        if (t === 0x0a) attrs.push(pbKeyValue(r))
        else r.skip(t & 7)
      }
      r.done(rend)
    } else if (tag === 0x12) {
      scopes.push(r.pos)
      r.pos = r.len()
    } else r.skip(tag & 7)
  }
  r.done(end)
  for (const at of scopes) {
    r.pos = at
    const send = r.len()
    const spans: number[] = []
    let name = ''
    let version = ''
    const sattrs: KV[] = []
    while (r.pos < send) {
      const t = r.uint32()
      if (t === 0x0a) {
        const scend = r.len()
        while (r.pos < scend) {
          const st = r.uint32()
          if (st === 0x0a) name = pbString(r)
          else if (st === 0x12) version = pbString(r)
          else if (st === 0x1a) sattrs.push(pbKeyValue(r))
          else r.skip(st & 7)
        }
        r.done(scend)
      } else if (t === 0x12) {
        spans.push(r.pos)
        r.pos = r.len()
      } else r.skip(t & 7)
    }
    r.done(send)
    const entry = c.entry(attrs, name, version, sattrs)
    if (typeof entry === 'string') {
      c.reject(entry, spans.length)
      continue
    }
    for (const sp of spans) {
      r.pos = sp
      c.add(entry, span(r))
    }
  }
  r.pos = end
}

function span(r: PbReader): SpanIn {
  const end = r.len()
  const s: SpanIn = {
    traceId: new Uint8Array(0),
    spanId: new Uint8Array(0),
    parent: new Uint8Array(0),
    traceState: '',
    flags: 0,
    name: '',
    kind: 0,
    startLo: 0,
    startHi: 0,
    endLo: 0,
    endHi: 0,
    attrs: [],
    dropped: [0, 0, 0],
    events: [],
    links: [],
    statusMessage: '',
    statusCode: 0,
  }
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
      case 0x4a:
        s.attrs.push(pbKeyValue(r))
        break
      case 0x50:
        s.dropped[0] = r.uint32() >>> 0
        break
      case 0x5a:
        s.events.push(event(r))
        break
      case 0x60:
        s.dropped[1] = r.uint32() >>> 0
        break
      case 0x6a:
        s.links.push(link(r))
        break
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
  return s
}

function event(r: PbReader): SpanIn['events'][number] {
  const end = r.len()
  const e = { lo: 0, hi: 0, name: '', attrs: [] as KV[] }
  while (r.pos < end) {
    const t = r.uint32()
    if (t === 0x09) {
      r.fixed64()
      e.lo = r.lo
      e.hi = r.hi
    } else if (t === 0x12) e.name = pbString(r)
    else if (t === 0x1a) e.attrs.push(pbKeyValue(r))
    else r.skip(t & 7)
  }
  r.done(end)
  return e
}

function link(r: PbReader): SpanIn['links'][number] {
  const end = r.len()
  const l: SpanIn['links'][number] = { traceId: new Uint8Array(0), spanId: new Uint8Array(0), traceState: '', attrs: [] }
  while (r.pos < end) {
    const t = r.uint32()
    if (t === 0x0a) l.traceId = pbBytes(r)
    else if (t === 0x12) l.spanId = pbBytes(r)
    else if (t === 0x1a) l.traceState = pbString(r)
    else if (t === 0x22) l.attrs.push(pbKeyValue(r))
    else r.skip(t & 7)
  }
  r.done(end)
  return l
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
  const root = parseJson(body, 'OTLP JSON')
  for (const rsRaw of list(root.resourceSpans, 'resourceSpans')) {
    const rs = object(rsRaw, 'resourceSpans[]')
    const attrs = jsonAttrs(object(rs.resource, 'resource').attributes)
    for (const ssRaw of list(rs.scopeSpans, 'scopeSpans')) {
      const ss = object(ssRaw, 'scopeSpans[]')
      const scope = object(ss.scope, 'scope')
      const spans = list(ss.spans, 'spans')
      const entry = c.entry(attrs, text(scope.name, 'scope name'), text(scope.version, 'scope version'), jsonAttrs(scope.attributes))
      if (typeof entry === 'string') {
        c.reject(entry, spans.length)
        continue
      }
      for (const raw of spans) c.add(entry, jsonSpan(object(raw, 'spans[]')))
    }
  }
  c.seal()
}

function jsonSpan(s: Record<string, unknown>): SpanIn {
  const [startLo, startHi] = jsonTime(s.startTimeUnixNano, 'startTimeUnixNano')
  const [endLo, endHi] = jsonTime(s.endTimeUnixNano, 'endTimeUnixNano')
  const status = object(s.status, 'status')
  return {
    traceId: jsonId(s.traceId, 'traceId'),
    spanId: jsonId(s.spanId, 'spanId'),
    parent: jsonId(s.parentSpanId, 'parentSpanId'),
    traceState: text(s.traceState, 'traceState'),
    flags: jsonU32(s.flags, 'flags'),
    name: text(s.name, 'name'),
    kind: jsonEnum(s.kind, KINDS, 'kind'),
    startLo,
    startHi,
    endLo,
    endHi,
    attrs: jsonAttrs(s.attributes),
    dropped: [jsonU32(s.droppedAttributesCount, 'droppedAttributesCount'), jsonU32(s.droppedEventsCount, 'droppedEventsCount'), jsonU32(s.droppedLinksCount, 'droppedLinksCount')],
    events: list(s.events, 'events').map((raw) => {
      const e = object(raw, 'events[]')
      const [lo, hi] = jsonTime(e.timeUnixNano, 'timeUnixNano')
      return { lo, hi, name: text(e.name, 'event name'), attrs: jsonAttrs(e.attributes) }
    }),
    links: list(s.links, 'links').map((raw) => {
      const l = object(raw, 'links[]')
      return { traceId: jsonId(l.traceId, 'link traceId'), spanId: jsonId(l.spanId, 'link spanId'), traceState: text(l.traceState, 'link traceState'), attrs: jsonAttrs(l.attributes) }
    }),
    statusMessage: text(status.message, 'status message'),
    statusCode: jsonEnum(status.code, CODES, 'status code'),
  }
}

/** For tests and tools: an AnyValue from a JSON-decoded OTLP value. */
export const anyFromJson = (raw: unknown): AnyV => jsonAny(raw, 0)
/** For tests: an AnyValue straight from protobuf bytes of an AnyValue message (length-prefixed). */
export const anyFromProto = (buf: Uint8Array): AnyV => pbAnyValue(new PbReader(buf), 0)
