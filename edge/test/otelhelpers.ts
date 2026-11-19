/**
 * Test-side codecs for spans and logs, written apart from src/ (a protobuf and JSON writer
 * where src has readers, a VZB1 signal 2/3 decoder where src has encoders, and an oracle of
 * the contract's mapping rules), so that a bug in src cannot hide behind the same bug here.
 */
import { env } from 'cloudflare:workers'
import { type PoolMap, shardName, tenantSlots } from '../../shard/src/pool'
import { PbWriter, call, snappyCompress } from './helpers'

const te = new TextEncoder()
const td = new TextDecoder('utf-8', { fatal: true })

// ───────────────────────────── values ─────────────────────────────

/** An OTLP AnyValue as the tests build it. */
export type V = { s: string } | { i: bigint } | { d: number } | { b: boolean } | { a: V[] } | { l: [string, V][] } | { y: Uint8Array } | { n: true }
export type Attrs = [string, V][]

/** UTF-8 byte order. */
export function utf8Cmp(a: string, b: string): number {
  const x = te.encode(a)
  const y = te.encode(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return x.length - y.length
}

/** Sorted by UTF-8 key, last of a repeated key kept. */
export function lastWins<T>(kvs: [string, T][]): [string, T][] {
  const m: Record<string, T> = {}
  const keys: string[] = []
  for (const [k, v] of kvs) {
    if (!(k in m)) keys.push(k)
    m[k] = v
  }
  return keys.sort(utf8Cmp).map((k) => [k, m[k]!])
}

const b64 = (b: Uint8Array): string => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(''))
const num = (d: number): string => (Number.isNaN(d) ? '"NaN"' : d === Infinity ? '"Infinity"' : d === -Infinity ? '"-Infinity"' : JSON.stringify(d))

/** Canonical OTLP JSON (contracts/BATCH.md). */
export function canonV(v: V): string {
  if ('s' in v) return `{"stringValue":${JSON.stringify(v.s)}}`
  if ('i' in v) return `{"intValue":"${v.i}"}`
  if ('d' in v) return `{"doubleValue":${num(v.d)}}`
  if ('b' in v) return `{"boolValue":${v.b ? 'true' : 'false'}}`
  if ('a' in v) return v.a.length ? `{"arrayValue":{"values":[${v.a.map(canonV).join(',')}]}}` : '{"arrayValue":{}}'
  if ('l' in v) return v.l.length ? `{"kvlistValue":{"values":${canonL(v.l)}}}` : '{"kvlistValue":{}}'
  if ('y' in v) return `{"bytesValue":"${b64(v.y)}"}`
  return '{}'
}
export const canonL = (kvs: Attrs): string => `[${lastWins(kvs).map(([k, v]) => `{"key":${JSON.stringify(k)},"value":${canonV(v)}}`).join(',')}]`

export function plainJ(v: V): string {
  if ('s' in v) return JSON.stringify(v.s)
  if ('i' in v) return String(v.i)
  if ('d' in v) return num(v.d)
  if ('b' in v) return String(v.b)
  if ('a' in v) return `[${v.a.map(plainJ).join(',')}]`
  if ('l' in v) return `{${lastWins(v.l).map(([k, x]) => `${JSON.stringify(k)}:${plainJ(x)}`).join(',')}}`
  if ('y' in v) return `"${b64(v.y)}"`
  return 'null'
}
export const plainT = (v: V): string => ('s' in v ? v.s : plainJ(v))

/** FNV-1a 64, BigInt, signed. */
export function fnv(bytes: Uint8Array): bigint {
  let h = 0xcbf29ce484222325n
  for (const x of bytes) h = ((h ^ BigInt(x)) * 0x100000001b3n) & 0xffffffffffffffffn
  return BigInt.asIntN(64, h)
}
export const streamIdOf = (labels: [string, string][]): bigint => fnv(te.encode(labels.map(([n, v]) => `${n}\u0000${v}\u0000`).join('')))

/** A typed attribute as stored: the kind and the value the decoder reads back. */
export type Typed = [string, 's' | 'i' | 'd' | 'b' | 'o', string]
export function typed(kvs: Attrs): Typed[] {
  return lastWins(kvs).map(([k, v]): Typed => {
    if ('s' in v) return [k, 's', v.s]
    if ('i' in v) return [k, 'i', String(v.i)]
    if ('d' in v) return [k, 'd', bitsHex(v.d)]
    if ('b' in v) return [k, 'b', String(v.b)]
    return [k, 'o', canonV(v)]
  })
}
export function bitsHex(d: number): string {
  const dv = new DataView(new ArrayBuffer(8))
  dv.setFloat64(0, d, true)
  return dv.getBigUint64(0, true).toString(16)
}

// ───────────────────────────── protobuf writers ─────────────────────────────

export function pbV(v: V): PbWriter {
  const w = new PbWriter()
  if ('s' in v) w.string(1, v.s)
  else if ('b' in v) w.int(2, v.b ? 1 : 0)
  else if ('i' in v) w.int(3, v.i)
  else if ('d' in v) w.double(4, v.d)
  else if ('a' in v) {
    const a = new PbWriter()
    for (const x of v.a) a.message(1, pbV(x))
    w.message(5, a)
  } else if ('l' in v) {
    const l = new PbWriter()
    for (const [k, x] of v.l) l.message(1, pbKV(k, x))
    w.message(6, l)
  } else if ('y' in v) w.bytes(7, v.y)
  return w
}
export const pbKV = (k: string, v: V): PbWriter => new PbWriter().string(1, k).message(2, pbV(v))

export interface SpanM {
  traceId: Uint8Array
  spanId: Uint8Array
  parent?: Uint8Array
  traceState?: string
  flags?: number
  name: string
  kind?: number
  start: bigint
  end: bigint
  attrs?: Attrs
  dropped?: [number, number, number]
  events?: { t: bigint; name: string; attrs?: Attrs }[]
  links?: { traceId: Uint8Array; spanId: Uint8Array; traceState?: string; attrs?: Attrs }[]
  statusMessage?: string
  statusCode?: number
}
export interface ScopeM {
  name?: string
  version?: string
  attrs?: Attrs
  spans: SpanM[]
}
export interface ResourceM {
  attrs: Attrs
  scopes: ScopeM[]
}

export function tracesProto(rs: ResourceM[]): Uint8Array<ArrayBuffer> {
  const root = new PbWriter()
  for (const r of rs) {
    const res = new PbWriter()
    for (const [k, v] of r.attrs) res.message(1, pbKV(k, v))
    const w = new PbWriter().message(1, res)
    for (const sc of r.scopes) {
      const scope = new PbWriter()
      if (sc.name) scope.string(1, sc.name)
      if (sc.version) scope.string(2, sc.version)
      for (const [k, v] of sc.attrs ?? []) scope.message(3, pbKV(k, v))
      const ss = new PbWriter().message(1, scope)
      for (const s of sc.spans) {
        const p = new PbWriter().bytes(1, s.traceId).bytes(2, s.spanId)
        if (s.traceState) p.string(3, s.traceState)
        if (s.parent) p.bytes(4, s.parent)
        p.string(5, s.name)
        if (s.kind) p.int(6, s.kind)
        p.fixed64Bits(7, s.start).fixed64Bits(8, s.end)
        for (const [k, v] of s.attrs ?? []) p.message(9, pbKV(k, v))
        if (s.dropped?.[0]) p.int(10, s.dropped[0])
        for (const e of s.events ?? []) {
          const ew = new PbWriter().fixed64Bits(1, e.t).string(2, e.name)
          for (const [k, v] of e.attrs ?? []) ew.message(3, pbKV(k, v))
          p.message(11, ew)
        }
        if (s.dropped?.[1]) p.int(12, s.dropped[1])
        for (const l of s.links ?? []) {
          const lw = new PbWriter().bytes(1, l.traceId).bytes(2, l.spanId)
          if (l.traceState) lw.string(3, l.traceState)
          for (const [k, v] of l.attrs ?? []) lw.message(4, pbKV(k, v))
          p.message(13, lw)
        }
        if (s.dropped?.[2]) p.int(14, s.dropped[2])
        if (s.statusMessage || s.statusCode) {
          const st = new PbWriter()
          if (s.statusMessage) st.string(2, s.statusMessage)
          if (s.statusCode) st.int(3, s.statusCode)
          p.message(15, st)
        }
        if (s.flags) {
          p.tag(16, 5)
          appendRaw(p, le32(s.flags))
        }
        ss.message(2, p)
      }
      w.message(2, ss)
    }
    root.message(1, w)
  }
  return root.finish()
}

const le32 = (v: number): Uint8Array => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, v >>> 0, true)
  return b
}
/** Raw bytes into a writer (PbWriter has no public raw append; varints of single bytes < 128 would not do). */
function appendRaw(w: PbWriter, b: Uint8Array): void {
  ;(w as unknown as { parts: number[] }).parts.push(...b)
}

const hex = (b: Uint8Array, upper = false): string => {
  const s = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return upper ? s.toUpperCase() : s
}

export function jsonV(v: V): unknown {
  if ('s' in v) return { stringValue: v.s }
  if ('i' in v) return { intValue: v.i.toString() }
  if ('d' in v) return { doubleValue: Number.isFinite(v.d) ? v.d : String(v.d) }
  if ('b' in v) return { boolValue: v.b }
  if ('a' in v) return { arrayValue: { values: v.a.map(jsonV) } }
  if ('l' in v) return { kvlistValue: { values: v.l.map(([k, x]) => ({ key: k, value: jsonV(x) })) } }
  if ('y' in v) return { bytesValue: b64(v.y) }
  return {}
}
export const jsonKVs = (kvs: Attrs | undefined): unknown[] => (kvs ?? []).map(([k, v]) => ({ key: k, value: jsonV(v) }))

export function tracesJson(rs: ResourceM[], upperHex = false): string {
  return JSON.stringify({
    resourceSpans: rs.map((r) => ({
      resource: { attributes: jsonKVs(r.attrs) },
      scopeSpans: r.scopes.map((sc) => ({
        scope: { name: sc.name, version: sc.version, attributes: jsonKVs(sc.attrs) },
        spans: sc.spans.map((s) => ({
          traceId: hex(s.traceId, upperHex),
          spanId: hex(s.spanId, upperHex),
          parentSpanId: s.parent ? hex(s.parent) : '',
          traceState: s.traceState,
          flags: s.flags,
          name: s.name,
          kind: s.kind ?? 0,
          startTimeUnixNano: s.start.toString(),
          endTimeUnixNano: s.end.toString(),
          attributes: jsonKVs(s.attrs),
          droppedAttributesCount: s.dropped?.[0],
          events: (s.events ?? []).map((e) => ({ timeUnixNano: e.t.toString(), name: e.name, attributes: jsonKVs(e.attrs) })),
          droppedEventsCount: s.dropped?.[1],
          links: (s.links ?? []).map((l) => ({ traceId: hex(l.traceId), spanId: hex(l.spanId), traceState: l.traceState, attributes: jsonKVs(l.attrs) })),
          droppedLinksCount: s.dropped?.[2],
          status: { message: s.statusMessage, code: s.statusCode ?? 0 },
        })),
      })),
    })),
  })
}

export interface LogM {
  time?: bigint
  observed?: bigint
  severity?: number
  severityText?: string
  body?: V
  attrs?: Attrs
  flags?: number
  traceId?: Uint8Array
  spanId?: Uint8Array
}
export interface LogResourceM {
  attrs: Attrs
  scopes: { attrs?: Attrs; logs: LogM[] }[]
}

export function logsProto(rs: LogResourceM[]): Uint8Array<ArrayBuffer> {
  const root = new PbWriter()
  for (const r of rs) {
    const res = new PbWriter()
    for (const [k, v] of r.attrs) res.message(1, pbKV(k, v))
    const w = new PbWriter().message(1, res)
    for (const sc of r.scopes) {
      const scope = new PbWriter().string(1, 'lib')
      for (const [k, v] of sc.attrs ?? []) scope.message(3, pbKV(k, v))
      const sl = new PbWriter().message(1, scope)
      for (const x of sc.logs) {
        const p = new PbWriter()
        if (x.time !== undefined) p.fixed64Bits(1, x.time)
        if (x.severity) p.int(2, x.severity)
        if (x.severityText) p.string(3, x.severityText)
        if (x.body) p.message(5, pbV(x.body))
        for (const [k, v] of x.attrs ?? []) p.message(6, pbKV(k, v))
        if (x.flags) {
          p.tag(8, 5)
          appendRaw(p, le32(x.flags))
        }
        if (x.traceId) p.bytes(9, x.traceId)
        if (x.spanId) p.bytes(10, x.spanId)
        if (x.observed !== undefined) p.fixed64Bits(11, x.observed)
        sl.message(2, p)
      }
      w.message(2, sl)
    }
    root.message(1, w)
  }
  return root.finish()
}

export function logsJson(rs: LogResourceM[]): string {
  return JSON.stringify({
    resourceLogs: rs.map((r) => ({
      resource: { attributes: jsonKVs(r.attrs) },
      scopeLogs: r.scopes.map((sc) => ({
        scope: { name: 'lib', attributes: jsonKVs(sc.attrs) },
        logRecords: sc.logs.map((x) => ({
          timeUnixNano: x.time?.toString(),
          observedTimeUnixNano: x.observed?.toString(),
          severityNumber: x.severity,
          severityText: x.severityText,
          body: x.body ? jsonV(x.body) : undefined,
          attributes: jsonKVs(x.attrs),
          flags: x.flags,
          traceId: x.traceId ? hex(x.traceId) : undefined,
          spanId: x.spanId ? hex(x.spanId) : undefined,
        })),
      })),
    })),
  })
}

export interface LokiStreamM {
  labels: string
  entries: { ts: bigint; line: string; md?: [string, string][] }[]
}
export function lokiProto(streams: LokiStreamM[]): Uint8Array<ArrayBuffer> {
  const root = new PbWriter()
  for (const s of streams) {
    const w = new PbWriter()
    // Entries first, labels last: legal protobuf.
    for (const e of s.entries) {
      const ts = new PbWriter().int(1, e.ts / 1_000_000_000n).int(2, e.ts % 1_000_000_000n)
      const ew = new PbWriter().message(1, ts).string(2, e.line)
      for (const [n, v] of e.md ?? []) ew.message(3, new PbWriter().string(1, n).string(2, v))
      w.message(2, ew)
    }
    w.string(1, s.labels)
    root.message(1, w)
  }
  return snappyCompress(root.finish())
}

// ───────────────────────────── batch decoders ─────────────────────────────

class R {
  at = 0
  dv: DataView
  constructor(readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  }
  need(n: number): void {
    if (this.at + n > this.b.length) throw new Error(`truncated at ${this.at}`)
  }
  u8(): number {
    this.need(1)
    return this.b[this.at++]!
  }
  u16(): number {
    this.need(2)
    const v = this.dv.getUint16(this.at, true)
    this.at += 2
    return v
  }
  u32(): number {
    this.need(4)
    const v = this.dv.getUint32(this.at, true)
    this.at += 4
    return v
  }
  i64(): bigint {
    this.need(8)
    const v = this.dv.getBigInt64(this.at, true)
    this.at += 8
    return v
  }
  raw(n: number): Uint8Array {
    this.need(n)
    const v = this.b.slice(this.at, this.at + n)
    this.at += n
    return v
  }
  str(n: number): string {
    return td.decode(this.raw(n))
  }
  align(): void {
    while (this.at % 8 !== 0) if (this.u8() !== 0) throw new Error('non-zero padding')
  }
  col(n: number, w: number): Uint8Array[] {
    this.align()
    return Array.from({ length: n }, () => this.raw(w))
  }
  vcol(n: number): Uint8Array[] {
    this.align()
    const off = Array.from({ length: n + 1 }, () => this.u32())
    this.align()
    if (off[0] !== 0) throw new Error('first offset not 0')
    const data = this.raw(off[n]!)
    return Array.from({ length: n }, (_, i) => {
      if (off[i + 1]! < off[i]!) throw new Error('offsets decrease')
      return data.slice(off[i]!, off[i + 1]!)
    })
  }
  end(): void {
    this.align()
    if (this.at !== this.b.length) throw new Error('trailing bytes')
  }
}

function typedList(b: Uint8Array): Typed[] {
  const r = new R(b)
  const n = r.u16()
  const out: Typed[] = []
  for (let i = 0; i < n; i++) {
    const k = r.str(r.u16())
    const t = r.u8()
    if (t === 1) out.push([k, 's', r.str(r.u32())])
    else if (t === 2) out.push([k, 'i', String(r.i64())])
    else if (t === 3) out.push([k, 'd', BigInt.asUintN(64, r.i64()).toString(16)])
    else if (t === 4) out.push([k, 'b', String(r.u8() === 1)])
    else if (t === 5) out.push([k, 'o', r.str(r.u32())])
    else throw new Error(`type ${t}`)
  }
  if (r.at !== b.length) throw new Error('trailing attribute bytes')
  for (let i = 1; i < out.length; i++) if (utf8Cmp(out[i - 1]![0], out[i]![0]) >= 0) throw new Error('attributes unsorted')
  return out
}

export interface StoredSpan {
  resourceFp: bigint
  resource: Typed[]
  scopeName: string
  scopeVersion: string
  scopeAttrs: string
  traceId: string
  spanId: string
  parent: string
  start: bigint
  end: bigint
  flags: number
  dropped: number[]
  kind: number
  status: number
  name: string
  traceState: string
  statusMessage: string
  attrs: Typed[]
  events: { t: bigint; name: string; attrs: string }[]
  links: { traceId: string; spanId: string; traceState: string; attrs: string }[]
}

export function decodeSpanBatch(b: Uint8Array): StoredSpan[] {
  const r = new R(b)
  if (td.decode(r.raw(4)) !== 'VZB1' || r.u8() !== 2 || r.u8() !== 0 || r.u16() !== 0) throw new Error('header')
  const n = r.u32()
  const ne = r.u32()
  const entries = Array.from({ length: ne }, () => {
    const fp = r.i64()
    const start = r.at
    const k = r.u16()
    r.at = start
    // Walk the attribute list to find its end.
    const t0 = r.at
    r.u16()
    for (let i = 0; i < k; i++) {
      r.raw(r.u16())
      const t = r.u8()
      if (t === 1 || t === 5) r.raw(r.u32())
      else if (t === 2 || t === 3) r.raw(8)
      else r.raw(1)
    }
    const resource = typedList(b.slice(t0, r.at))
    return { fp, resource, scopeName: r.str(r.u16()), scopeVersion: r.str(r.u16()), scopeAttrs: r.str(r.u32()) }
  })
  const entry = r.col(n, 4).map((x) => new DataView(x.buffer).getUint32(0, true))
  const tid = r.col(n, 16)
  const sid = r.col(n, 8)
  const par = r.col(n, 8)
  const i64 = (x: Uint8Array) => new DataView(x.buffer).getBigInt64(0, true)
  const start = r.col(n, 8).map(i64)
  const end = r.col(n, 8).map(i64)
  const flags = r.col(n, 4).map((x) => new DataView(x.buffer).getUint32(0, true))
  const dropped = r.col(n, 12).map((x) => [0, 4, 8].map((o) => new DataView(x.buffer).getUint32(o, true)))
  const kind = r.col(n, 1).map((x) => x[0]!)
  const status = r.col(n, 1).map((x) => x[0]!)
  const [name, ts, sm, attrs, events, links] = [r.vcol(n), r.vcol(n), r.vcol(n), r.vcol(n), r.vcol(n), r.vcol(n)]
  r.end()
  return Array.from({ length: n }, (_, i) => {
    const e = entries[entry[i]!]!
    const er = new R(events[i]!)
    const evs = Array.from({ length: er.u16() }, () => ({ t: er.i64(), name: er.str(er.u16()), attrs: er.str(er.u32()) }))
    const lr = new R(links[i]!)
    const lks = Array.from({ length: lr.u16() }, () => ({ traceId: hex(lr.raw(16)), spanId: hex(lr.raw(8)), traceState: lr.str(lr.u16()), attrs: lr.str(lr.u32()) }))
    return {
      resourceFp: e.fp,
      resource: e.resource,
      scopeName: e.scopeName,
      scopeVersion: e.scopeVersion,
      scopeAttrs: e.scopeAttrs,
      traceId: hex(tid[i]!),
      spanId: hex(sid[i]!),
      parent: hex(par[i]!),
      start: start[i]!,
      end: end[i]!,
      flags: flags[i]!,
      dropped: dropped[i]!,
      kind: kind[i]!,
      status: status[i]!,
      name: td.decode(name[i]!),
      traceState: td.decode(ts[i]!),
      statusMessage: td.decode(sm[i]!),
      attrs: typedList(attrs[i]!),
      events: evs,
      links: lks,
    }
  })
}

export interface StoredLog {
  streamId: bigint
  labels: [string, string][]
  ts: bigint
  observed: bigint
  traceId: string
  spanId: string
  flags: number
  severity: number
  line: string
  severityText: string
  metadata: [string, string][]
}

function pairsOf(r: R, n: number): [string, string][] {
  return Array.from({ length: n }, () => [r.str(r.u16()), r.str(r.u16())] as [string, string])
}

export function decodeLogBatch(b: Uint8Array): StoredLog[] {
  const r = new R(b)
  if (td.decode(r.raw(4)) !== 'VZB1' || r.u8() !== 3 || r.u8() !== 0 || r.u16() !== 0) throw new Error('header')
  const n = r.u32()
  const ne = r.u32()
  const streams = Array.from({ length: ne }, () => {
    const id = r.i64()
    return { id, labels: pairsOf(r, r.u32()) }
  })
  const entry = r.col(n, 4).map((x) => new DataView(x.buffer).getUint32(0, true))
  const i64 = (x: Uint8Array) => new DataView(x.buffer).getBigInt64(0, true)
  const ts = r.col(n, 8).map(i64)
  const obs = r.col(n, 8).map(i64)
  const tid = r.col(n, 16)
  const sid = r.col(n, 8)
  const flags = r.col(n, 4).map((x) => new DataView(x.buffer).getUint32(0, true))
  const sev = r.col(n, 1).map((x) => x[0]!)
  const [line, st, md] = [r.vcol(n), r.vcol(n), r.vcol(n)]
  r.end()
  return Array.from({ length: n }, (_, i) => {
    const s = streams[entry[i]!]!
    const mr = new R(md[i]!)
    return {
      streamId: s.id,
      labels: s.labels,
      ts: ts[i]!,
      observed: obs[i]!,
      traceId: hex(tid[i]!),
      spanId: hex(sid[i]!),
      flags: flags[i]!,
      severity: sev[i]!,
      line: td.decode(line[i]!),
      severityText: td.decode(st[i]!),
      metadata: pairsOf(mr, mr.u16()),
    }
  })
}

// ───────────────────────────── environment ─────────────────────────────

export const SIGNALS_ON = { INGEST_SIGNALS: 'traces,logs' }

export function postSignal(path: string, key: string, body: BodyInit, contentType: string, extra: { headers?: Record<string, string>; env?: Record<string, string> } = {}): Promise<Response> {
  return call(path, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': contentType, ...extra.headers }, body, env: { ...SIGNALS_ON, ...extra.env } })
}

export const signalPool = (map: PoolMap, signal: 'traces' | 'logs'): PoolMap => ({ ...map, pool: `${map.pool}/${signal}` })

/** Every stored batch of a tenant in a pool, by slot. */
export async function storedBatches(map: PoolMap, tenant: string): Promise<Map<number, Uint8Array[]>> {
  const out = new Map<number, Uint8Array[]>()
  for (const slot of tenantSlots(map, tenant)) {
    const stub = env.SHARD.get(env.SHARD.idFromName(shardName(map, slot)))
    const d = await stub.describe(tenant)
    if (!d) continue
    const t = await stub.tailRead(tenant, d.incarnation, 0)
    if (t.status !== 'ok') throw new Error(`tailRead: ${t.status}`)
    out.set(slot, t.batches.map((b) => b.payload))
  }
  return out
}

export async function storedSpans(map: PoolMap, tenant: string): Promise<StoredSpan[]> {
  const out: StoredSpan[] = []
  for (const batches of (await storedBatches(signalPool(map, 'traces'), tenant)).values()) for (const b of batches) out.push(...decodeSpanBatch(b))
  return out
}

export async function storedLogs(map: PoolMap, tenant: string): Promise<StoredLog[]> {
  const out: StoredLog[] = []
  for (const batches of (await storedBatches(signalPool(map, 'logs'), tenant)).values()) for (const b of batches) out.push(...decodeLogBatch(b))
  return out
}

/** Decode an OTLP partial-success response body (protobuf): [rejected, message]. */
export function partialProto(b: Uint8Array): [number, string] {
  if (b.length === 0) return [0, '']
  const r = new R(b)
  const varint = (): number => {
    let x = 0
    let m = 1
    for (;;) {
      const c = r.u8()
      x += (c & 127) * m
      if (c < 128) return x
      m *= 128
    }
  }
  if (r.u8() !== 0x0a) throw new Error('not partial_success')
  varint()
  let rejected = 0
  let msg = ''
  while (r.at < b.length) {
    const t = r.u8()
    if (t === 0x08) rejected = varint()
    else if (t === 0x12) msg = r.str(varint())
    else throw new Error(`tag ${t}`)
  }
  return [rejected, msg]
}

// ───────────────────────────── random generators ─────────────────────────────

/** A small seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class Gen {
  constructor(readonly r: () => number) {}
  int(n: number): number {
    return Math.floor(this.r() * n)
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!
  }
  chance(p: number): boolean {
    return this.r() < p
  }
  text(max = 10): string {
    const kind = this.int(6)
    if (kind === 0) return ''
    const alphabets = ['abcdefghij', 'é€ü中文', '😀🌡𝄞', '\u0000\u0001\n\t"\\', '￿ ', 'ABC xyz.-_/']
    const al = Array.from(alphabets[kind === 1 ? 0 : this.int(alphabets.length)]!)
    return Array.from({ length: 1 + this.int(max) }, () => this.pick(al)).join('')
  }
  value(depth = 0): V {
    const k = this.int(depth > 1 ? 5 : 8)
    if (k === 0) return { s: this.text() }
    if (k === 1) return { i: BigInt.asIntN(64, BigInt(Math.floor(this.r() * 2 ** 53)) * (this.chance(0.5) ? -1n : 1n) * (this.chance(0.2) ? 1024n : 1n)) }
    if (k === 2) return { d: this.pick([0, -0, 1.5, -2.25e-300, 1e21, 123456789.125, Infinity, -Infinity, NaN, 0.1]) }
    if (k === 3) return { b: this.chance(0.5) }
    if (k === 4) return this.chance(0.5) ? { y: Uint8Array.from({ length: this.int(6) }, () => this.int(256)) } : { n: true }
    if (k === 5) return { a: Array.from({ length: this.int(3) }, () => this.value(depth + 1)) }
    return { l: Array.from({ length: this.int(3) }, () => [this.pick(['k', 'b', 'a', 'é']), this.value(depth + 1)] as [string, V]) }
  }
  attrs(max = 6, keys: readonly string[] = ['a', 'b.c', 'http.route', 'service.name', 'é', '😀', 'k8s.pod.name', 'x']): Attrs {
    return Array.from({ length: this.int(max + 1) }, () => [this.chance(0.8) ? this.pick(keys) : this.text(6) || 'z', this.value()] as [string, V])
  }
  id(n: number): Uint8Array {
    const b = Uint8Array.from({ length: n }, () => this.int(256))
    b[0] = 1 + this.int(255)
    return b
  }
}
