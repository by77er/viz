/**
 * Test-side codecs. These are deliberately written separately from src/ (a writer where
 * src has a reader, a compressor where src has a decompressor, a VZB1 decoder where src
 * has an encoder), so that a bug in src cannot hide behind the same bug here.
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { type PoolMap, shardName, tenantSlots } from '../../shard/src/pool'
import worker, { type Env } from '../src/index'

const te = new TextEncoder()
const td = new TextDecoder('utf-8', { fatal: true })

// ───────────────────────── protobuf writer ─────────────────────────

export class PbWriter {
  private parts: number[] = []
  varint(v: number | bigint): this {
    let n = BigInt.asUintN(64, BigInt(v))
    while (n >= 0x80n) {
      this.parts.push(Number(n & 0x7fn) | 0x80)
      n >>= 7n
    }
    this.parts.push(Number(n))
    return this
  }
  tag(field: number, wire: number): this {
    return this.varint((field << 3) | wire)
  }
  bytes(field: number, b: Uint8Array): this {
    this.tag(field, 2).varint(b.length)
    for (const x of b) this.parts.push(x)
    return this
  }
  string(field: number, s: string): this {
    return this.bytes(field, te.encode(s))
  }
  message(field: number, w: PbWriter): this {
    return this.bytes(field, w.finish())
  }
  int(field: number, v: number | bigint): this {
    return this.tag(field, 0).varint(v)
  }
  fixed64Bits(field: number, bits: bigint): this {
    this.tag(field, 1)
    const b = new Uint8Array(8)
    new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, bits), true)
    for (const x of b) this.parts.push(x)
    return this
  }
  double(field: number, v: number): this {
    return this.fixed64Bits(field, bitsOf(v))
  }
  finish(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.parts)
  }
}

/** IEEE 754 bits of a double. */
export function bitsOf(v: number): bigint {
  const dv = new DataView(new ArrayBuffer(8))
  dv.setFloat64(0, v, true)
  return dv.getBigUint64(0, true)
}

export const STALE_NAN = 0x7ff0000000000002n

// ───────────────────────── Remote Write bodies ─────────────────────────

export interface PrwSample {
  ts: number | bigint
  /** A number, or raw IEEE bits (for NaN payloads). */
  value: number | bigint
}
export interface PrwSeries {
  labels: [string, string][]
  samples: PrwSample[]
  /** Write samples before labels in the message (legal protobuf). */
  samplesFirst?: boolean
  histograms?: number
}

export function writeRequest(series: PrwSeries[]): Uint8Array<ArrayBuffer> {
  const req = new PbWriter()
  for (const s of series) {
    const ts = new PbWriter()
    const labels = () => {
      for (const [n, v] of s.labels) ts.message(1, new PbWriter().string(1, n).string(2, v))
    }
    const samples = () => {
      for (const smp of s.samples) {
        const w = new PbWriter()
        w.fixed64Bits(1, typeof smp.value === 'bigint' ? smp.value : bitsOf(smp.value))
        w.int(2, smp.ts)
        ts.message(2, w)
      }
    }
    if (s.samplesFirst) {
      samples()
      labels()
    } else {
      labels()
      samples()
    }
    for (let i = 0; i < (s.histograms ?? 0); i++) ts.message(4, new PbWriter().int(1, 3))
    req.message(1, ts)
  }
  return req.finish()
}

// ───────────────────────── snappy block compressor ─────────────────────────

/** A small greedy LZ77 snappy *block* compressor: literals plus 1- and 2-byte-offset copies. */
export function snappyCompress(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const out: number[] = []
  let n = src.length
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)

  const literal = (from: number, to: number) => {
    while (from < to) {
      const len = Math.min(to - from, 65536)
      if (len <= 60) out.push((len - 1) << 2)
      else if (len <= 256) out.push(60 << 2, len - 1)
      else out.push(61 << 2, (len - 1) & 255, (len - 1) >>> 8)
      for (let i = 0; i < len; i++) out.push(src[from + i]!)
      from += len
    }
  }
  const copy = (offset: number, len: number) => {
    while (len > 0) {
      // Never leave a tail shorter than 4 for a 1-byte-offset copy; 2-byte copies take 1..64.
      const l = Math.min(len, 64)
      if (l >= 4 && l <= 11 && offset < 2048) out.push(1 | ((l - 4) << 2) | ((offset >>> 8) << 5), offset & 255)
      else out.push(2 | ((l - 1) << 2), offset & 255, offset >>> 8)
      len -= l
    }
  }

  const table = new Map<number, number>()
  let i = 0
  let pending = 0
  while (i + 4 <= src.length) {
    const key = src[i]! | (src[i + 1]! << 8) | (src[i + 2]! << 16) | (src[i + 3]! << 24)
    const cand = table.get(key)
    table.set(key, i)
    if (cand !== undefined && i - cand < 65536) {
      let len = 4
      while (i + len < src.length && src[cand + len] === src[i + len]) len++
      literal(pending, i)
      copy(i - cand, len)
      i += len
      pending = i
    } else i++
  }
  literal(pending, src.length)
  return new Uint8Array(out)
}

// ───────────────────────── OTLP protobuf from OTLP/JSON shape ─────────────────────────

type J = Record<string, any>

function anyValue(v: J): PbWriter {
  const w = new PbWriter()
  if (v.stringValue !== undefined) w.string(1, v.stringValue)
  else if (v.boolValue !== undefined) w.int(2, v.boolValue ? 1 : 0)
  else if (v.intValue !== undefined) w.int(3, BigInt(v.intValue))
  else if (v.doubleValue !== undefined) w.double(4, v.doubleValue)
  else if (v.arrayValue !== undefined) {
    const a = new PbWriter()
    for (const x of v.arrayValue.values ?? []) a.message(1, anyValue(x))
    w.message(5, a)
  } else if (v.kvlistValue !== undefined) {
    const l = new PbWriter()
    for (const kv of v.kvlistValue.values ?? []) l.message(1, keyValue(kv))
    w.message(6, l)
  } else if (v.bytesValue !== undefined) w.bytes(7, Uint8Array.from(atob(v.bytesValue), (c) => c.charCodeAt(0)))
  return w
}

function keyValue(kv: J): PbWriter {
  return new PbWriter().string(1, kv.key).message(2, anyValue(kv.value))
}

function numberPoint(p: J): PbWriter {
  const w = new PbWriter()
  if (p.startTimeUnixNano !== undefined) w.fixed64Bits(2, BigInt(p.startTimeUnixNano))
  if (p.timeUnixNano !== undefined) w.fixed64Bits(3, BigInt(p.timeUnixNano))
  if (p.asDouble !== undefined) w.double(4, Number(p.asDouble))
  if (p.asInt !== undefined) w.fixed64Bits(6, BigInt(p.asInt))
  for (const kv of p.attributes ?? []) w.message(7, keyValue(kv))
  if (p.flags !== undefined) w.int(8, p.flags)
  return w
}

/** Encode an OTLP/JSON-shaped ExportMetricsServiceRequest as protobuf. */
export function otlpProto(req: J): Uint8Array<ArrayBuffer> {
  const out = new PbWriter()
  for (const rm of req.resourceMetrics ?? []) {
    const rmw = new PbWriter()
    const res = new PbWriter()
    for (const kv of rm.resource?.attributes ?? []) res.message(1, keyValue(kv))
    rmw.message(1, res)
    for (const sm of rm.scopeMetrics ?? []) {
      const smw = new PbWriter()
      if (sm.scope) smw.message(1, new PbWriter().string(1, sm.scope.name ?? ''))
      for (const m of sm.metrics ?? []) {
        const mw = new PbWriter()
        mw.string(1, m.name)
        if (m.description) mw.string(2, m.description)
        if (m.unit) mw.string(3, m.unit)
        const numeric = (field: number, d: J, sum: boolean) => {
          const dw = new PbWriter()
          for (const p of d.dataPoints ?? []) dw.message(1, numberPoint(p))
          if (sum && d.aggregationTemporality !== undefined) dw.int(2, d.aggregationTemporality)
          if (sum && d.isMonotonic !== undefined) dw.int(3, d.isMonotonic ? 1 : 0)
          mw.message(field, dw)
        }
        if (m.gauge) numeric(5, m.gauge, false)
        if (m.sum) numeric(7, m.sum, true)
        // Histogram-like points: only enough structure for the receiver to count them.
        for (const [field, key] of [[9, 'histogram'], [10, 'exponentialHistogram'], [11, 'summary']] as const) {
          if (!m[key]) continue
          const dw = new PbWriter()
          for (const p of m[key].dataPoints ?? []) dw.message(1, new PbWriter().fixed64Bits(3, BigInt(p.timeUnixNano ?? 0)).int(4, 7))
          if (m[key].aggregationTemporality !== undefined) dw.int(2, m[key].aggregationTemporality)
          mw.message(field, dw)
        }
        smw.message(2, mw)
      }
      rmw.message(2, smw)
    }
    out.message(1, rmw)
  }
  return out.finish()
}

export async function gzip(b: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
}

// ───────────────────────── VZB1 decoder ─────────────────────────

export interface DecodedSeries {
  id: bigint
  labels: [string, string][]
}
export interface DecodedBatch {
  series: DecodedSeries[]
  rows: { series: number; ts: bigint; bits: bigint }[]
}

/** Strict decoder for contracts/BATCH.md: every byte must be accounted for. */
export function decodeVZB1(b: Uint8Array): DecodedBatch {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const fail = (m: string): never => {
    throw new Error(`VZB1: ${m}`)
  }
  if (td.decode(b.subarray(0, 4)) !== 'VZB1') fail('bad magic')
  if (b[4] !== 1) fail('signal is not metrics')
  if (b[5] !== 0 || dv.getUint16(6, true) !== 0) fail('flags/reserved not zero')
  const nRows = dv.getUint32(8, true)
  const nSeries = dv.getUint32(12, true)
  if (nRows === 0) fail('empty batch')
  let p = 16
  const series: DecodedSeries[] = []
  for (let i = 0; i < nSeries; i++) {
    const id = dv.getBigInt64(p, true)
    const nLabels = dv.getUint32(p + 8, true)
    p += 12
    const labels: [string, string][] = []
    for (let j = 0; j < nLabels; j++) {
      const nl = dv.getUint16(p, true)
      const name = td.decode(b.subarray(p + 2, p + 2 + nl))
      p += 2 + nl
      const vl = dv.getUint16(p, true)
      const value = td.decode(b.subarray(p + 2, p + 2 + vl))
      p += 2 + vl
      labels.push([name, value])
    }
    series.push({ id, labels })
  }
  const pad = () => {
    while (p % 8 !== 0) {
      if (b[p] !== 0) fail('padding not zero')
      p++
    }
  }
  pad()
  const idx: number[] = []
  for (let i = 0; i < nRows; i++, p += 4) idx.push(dv.getUint32(p, true))
  pad()
  const ts: bigint[] = []
  for (let i = 0; i < nRows; i++, p += 8) ts.push(dv.getBigInt64(p, true))
  const rows: DecodedBatch['rows'] = []
  for (let i = 0; i < nRows; i++, p += 8) {
    if (idx[i]! >= nSeries) fail('series_idx out of range')
    rows.push({ series: idx[i]!, ts: ts[i]!, bits: dv.getBigUint64(p, true) })
  }
  if (p !== b.length) fail(`length ${b.length}, expected ${p}`)
  return { series, rows }
}

/** Contract rules for a series table entry, checked by an independent implementation. */
export function checkCanonical(s: DecodedSeries): void {
  const names = s.labels.map(([n]) => te.encode(n))
  for (let i = 1; i < names.length; i++) {
    if (cmp(names[i - 1]!, names[i]!) >= 0) throw new Error(`labels not sorted/unique: ${JSON.stringify(s.labels)}`)
  }
  if (!s.labels.some(([n]) => n === '__name__')) throw new Error('no __name__')
  if (s.labels.some(([, v]) => v === '')) throw new Error('empty label value')
  if (refSeriesId(s.labels) !== s.id) throw new Error(`series_id mismatch for ${JSON.stringify(s.labels)}`)
}

function cmp(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return a.length - b.length
}

/** FNV-1a 64 over `name 0 value 0`, written independently of src/batch.ts. */
export function refSeriesId(labels: [string, string][]): bigint {
  let h = 14695981039346656037n
  const mask = (1n << 64n) - 1n
  for (const [n, v] of labels) {
    for (const part of [n, v]) {
      for (const byte of [...te.encode(part), 0]) h = ((h ^ BigInt(byte)) * 1099511628211n) & mask
    }
  }
  return h >= 1n << 63n ? h - (1n << 64n) : h
}

// ───────────────────────── environment helpers ─────────────────────────

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s)))
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('')
}

let keyN = 0
/** Create an API key in KV and return the full key string. */
export async function makeKey(tenant: string, opts: { scopes?: string[]; disabled?: boolean } = {}): Promise<string> {
  const keyId = `k${Date.now().toString(36)}${keyN++}`
  const secret = `s3cr3t-${crypto.randomUUID()}`
  await env.CONFIG.put(`key:${keyId}`, JSON.stringify({ tenant, secretSha256: await sha256Hex(secret), scopes: opts.scopes ?? ['write'], disabled: opts.disabled }))
  return `viz_${keyId}_${secret}`
}

let tenantN = 0
export const newTenant = (prefix = 't'): string => `${prefix}-${Date.now().toString(36)}-${tenantN++}`

export async function setPool(tenant: string, map: PoolMap): Promise<void> {
  await env.CONFIG.put(`pool:${tenant}`, JSON.stringify(map))
}

export async function call(path: string, init: RequestInit & { env?: Partial<Env> } = {}): Promise<Response> {
  const { env: override, ...rest } = init
  const ctx = createExecutionContext()
  const res = await worker.fetch(new Request(`https://edge.test${path}`, rest as RequestInit) as never, { ...env, ...override } as Env)
  await waitOnExecutionContext(ctx)
  return res
}

export function postWrite(key: string, series: PrwSeries[] | Uint8Array<ArrayBuffer>, extra: { headers?: Record<string, string>; env?: Partial<Env>; path?: string } = {}): Promise<Response> {
  const body = series instanceof Uint8Array ? series : snappyCompress(writeRequest(series))
  return call(extra.path ?? '/api/v1/write', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'snappy', 'X-Prometheus-Remote-Write-Version': '0.1.0', ...extra.headers },
    body,
    env: extra.env,
  })
}

export function postOtlp(key: string, body: Uint8Array<ArrayBuffer> | string, contentType: string, extra: { headers?: Record<string, string>; env?: Partial<Env> } = {}): Promise<Response> {
  return call('/v1/metrics', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': contentType, ...extra.headers }, body, env: extra.env })
}

export interface StoredSample {
  labels: Record<string, string>
  id: bigint
  ts: bigint
  bits: bigint
}

export const shardStub = (map: PoolMap, slot: number) => env.SHARD.get(env.SHARD.idFromName(shardName(map, slot)))

/** Every batch one tenant has in one shard, decoded (and checked against the contract). */
export async function tailOfSlot(map: PoolMap, slot: number, tenant: string): Promise<{ batches: DecodedBatch[]; samples: StoredSample[] }> {
  const stub = shardStub(map, slot)
  const d = await stub.describe(tenant)
  if (!d) return { batches: [], samples: [] }
  const tail = await stub.tailRead(tenant, d.incarnation, 0)
  if (tail.status !== 'ok') throw new Error(`tailRead: ${tail.status}`)
  const batches = tail.batches.map((b) => {
    const decoded = decodeVZB1(b.payload)
    if (decoded.rows.length !== b.rows) throw new Error('rows mismatch between append and batch')
    decoded.series.forEach(checkCanonical)
    return decoded
  })
  const samples = batches.flatMap((b) =>
    b.rows.map((r) => ({ labels: Object.fromEntries(b.series[r.series]!.labels), id: b.series[r.series]!.id, ts: r.ts, bits: r.bits })),
  )
  return { batches, samples }
}

/** Everything a tenant has stored anywhere in its pool, in slot order. */
export async function tail(map: PoolMap, tenant: string): Promise<StoredSample[]> {
  const out: StoredSample[] = []
  for (const slot of tenantSlots(map, tenant)) out.push(...(await tailOfSlot(map, slot, tenant)).samples)
  return out
}

export const DEFAULT_MAP: PoolMap = JSON.parse(env.DEFAULT_POOL!)

/** Order-independent form for comparing sets of samples. */
export function canon(samples: { labels: Record<string, string>; ts: bigint | number; bits: bigint }[]): string[] {
  return samples
    .map((s) => `${JSON.stringify(Object.entries(s.labels).sort(([a], [b]) => (a < b ? -1 : 1)))} @${BigInt(s.ts)} =${s.bits.toString(16)}`)
    .sort()
}
