import { tooLarge } from './errors'
import { CONTRACT, type Limits } from './limits'

/**
 * The `VZB1` columnar batch (contracts/BATCH.md): canonical labels, series ids, and the
 * encoder. `Collector` is the one place every decoder feeds; it owns validation of labels
 * and timestamps, so Remote Write and OTLP cannot disagree about what a valid series is.
 */

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n

/**
 * FNV-1a 64 exactly as the contract states it, with BigInt. This is the reference: the
 * hot path below computes the same function on two 32-bit halves with integer arithmetic,
 * inline with the copy of the label bytes, and the tests hold the two equal on random input.
 */
export function fnv1a64(bytes: Uint8Array): bigint {
  let h = FNV_OFFSET
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]!)
    h = BigInt.asUintN(64, h * FNV_PRIME)
  }
  return BigInt.asIntN(64, h)
}

/** The bytes a series id is computed over: `name 0x00 value 0x00` per label, in order. */
export function seriesIdInput(labels: readonly (readonly [string, string])[]): Uint8Array {
  const enc = new TextEncoder()
  const parts = labels.map(([n, v]) => [enc.encode(n), enc.encode(v)] as const)
  const out = new Uint8Array(parts.reduce((a, [n, v]) => a + n.length + v.length + 2, 0))
  let p = 0
  for (const [n, v] of parts) {
    out.set(n, p)
    p += n.length + 1
    out.set(v, p)
    p += v.length + 1
  }
  return out
}

export const Reject = {
  MissingName: 1,
  DuplicateLabel: 2,
  TooManyLabels: 3,
  LabelNameTooLong: 4,
  LabelValueTooLong: 5,
  InvalidLabel: 6,
  TooOld: 7,
  TooNew: 8,
  SeriesTooLarge: 9,
} as const

const REASONS: Record<number, string> = {
  [Reject.MissingName]: 'series without a __name__ label',
  [Reject.DuplicateLabel]: 'duplicate label name',
  [Reject.TooManyLabels]: 'too many labels on one series',
  [Reject.LabelNameTooLong]: 'label name too long',
  [Reject.LabelValueTooLong]: 'label value too long',
  [Reject.InvalidLabel]: 'invalid label (empty name, NUL byte or invalid UTF-8)',
  [Reject.TooOld]: 'timestamp older than the accept window',
  [Reject.TooNew]: 'timestamp too far in the future',
  [Reject.SeriesTooLarge]: 'label set too large to fit one batch',
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true })
const utf8 = new TextDecoder()

function cmpBytes(buf: Uint8Array, aS: number, aE: number, bS: number, bE: number): number {
  const n = Math.min(aE - aS, bE - bS)
  for (let i = 0; i < n; i++) {
    const d = buf[aS + i]! - buf[bS + i]!
    if (d !== 0) return d
  }
  return aE - aS - (bE - bS)
}

/** Does `buf[s..e)` equal the ASCII string `lit`? */
function isAscii(buf: Uint8Array, s: number, e: number, lit: string): boolean {
  if (e - s !== lit.length) return false
  for (let i = 0; i < lit.length; i++) if (buf[s + i] !== lit.charCodeAt(i)) return false
  return true
}

function validUtf8(buf: Uint8Array, s: number, e: number): boolean {
  try {
    utf8Strict.decode(buf.subarray(s, e))
    return true
  } catch {
    return false
  }
}

/** Accumulates the validated series and rows of one request. */
export class Collector {
  // Series table: encoded entries back to back in one arena.
  private arena: Uint8Array
  private arenaLen = 0
  readonly entryOff: number[] = []
  readonly entryLen: number[] = []
  /** Distinct routing keys of this request (contracts/BATCH.md), and which one each series has. */
  readonly routes: string[] = []
  readonly routeOf: number[] = []
  private readonly routeBytes: Uint8Array[] = []
  private readonly routeByHash = new Map<number, number>()
  private readonly byHash = new Map<number, number>()
  private readonly nextSameHash: number[] = []
  private order = new Int32Array(64)

  // Rows, in arrival order.
  nRows = 0
  rowSeries = new Uint32Array(1024)
  rowTs = new Float64Array(1024)
  rowVal = new Uint8Array(8 * 1024)
  private valView = new DataView(this.rowVal.buffer)

  /** Samples/points seen, accepted or not. */
  received = 0
  rejectedTotal = 0
  readonly rejected = new Map<string, number>()

  private readonly minTs: number
  private readonly maxTs: number

  /** `bodyBytes`: size of the decoded request, a good first guess for the series table. */
  constructor(readonly limits: Limits, now: number, bodyBytes = 1 << 16) {
    this.arena = new Uint8Array(Math.min(Math.max(bodyBytes, 1 << 12), limits.maxDecodedBytes + (1 << 12), 64 << 20))
    // The accept window, clamped to the contract's range (years 1970 to 9999), so every
    // accepted timestamp is an exact i64 and its UTC day is always `YYYY-MM-DD`.
    this.minTs = Math.max(now - limits.acceptBackMs, CONTRACT.minTimestampMs)
    this.maxTs = Math.min(now + limits.acceptAheadMs, CONTRACT.maxTimestampMs)
  }

  get nSeries(): number {
    return this.entryOff.length
  }

  entry(i: number): Uint8Array {
    return this.arena.subarray(this.entryOff[i]!, this.entryOff[i]! + this.entryLen[i]!)
  }

  /** The `series_id` of series `i`: the first eight bytes of its table entry. */
  seriesId(i: number): bigint {
    return new DataView(this.arena.buffer, this.arena.byteOffset + this.entryOff[i]!, 8).getBigInt64(0, true)
  }

  reject(reason: number | string, count: number): void {
    if (count <= 0) return
    const r = typeof reason === 'string' ? reason : REASONS[reason]!
    this.rejected.set(r, (this.rejected.get(r) ?? 0) + count)
    this.rejectedTotal += count
    this.received += count
  }

  /** "3 timestamp older than the accept window; 1 duplicate label name" */
  rejectionSummary(): string {
    const s = [...this.rejected].map(([r, n]) => `${n} ${r}`).join('; ')
    return s.length > 512 ? `${s.slice(0, 509)}...` : s
  }

  /**
   * Canonicalise one label set and add it to the series table (or find it there).
   * `offs` holds four offsets into `buf` per label: name start, name end, value start,
   * value end. Returns the series index, or `-Reject` if the series is invalid.
   */
  addSeries(buf: Uint8Array, offs: Int32Array, n: number): number {
    const L = this.limits
    if (this.order.length < n) this.order = new Int32Array(Math.max(n, this.order.length * 2))
    const order = this.order

    // Empty-valued labels are dropped; the rest are sorted by name, byte order.
    let m = 0
    let bytes = 12
    for (let i = 0; i < n; i++) {
      const o = 4 * i
      const nameLen = offs[o + 1]! - offs[o]!
      const valueLen = offs[o + 3]! - offs[o + 2]!
      if (valueLen === 0) continue
      if (nameLen === 0) return -Reject.InvalidLabel
      if (nameLen > L.maxLabelNameBytes) return -Reject.LabelNameTooLong
      if (valueLen > L.maxLabelValueBytes) return -Reject.LabelValueTooLong
      if (m >= L.maxLabelsPerSeries) return -Reject.TooManyLabels
      bytes += 4 + nameLen + valueLen
      // Insertion sort: senders almost always send labels already sorted.
      let j = m
      while (j > 0) {
        const p = 4 * order[j - 1]!
        const c = cmpBytes(buf, offs[p]!, offs[p + 1]!, offs[o]!, offs[o + 1]!)
        if (c === 0) return -Reject.DuplicateLabel
        if (c < 0) break
        order[j] = order[j - 1]!
        j--
      }
      order[j] = i
      m++
    }

    // A batch must hold at least one row of this series: header, this entry, one row.
    if (pad8(16 + bytes) + 8 + 16 > L.maxBatchBytes) return -Reject.SeriesTooLarge

    if (this.arenaLen + bytes > this.arena.length) {
      // Doubling, but not past the decoded-size limit (checked below, once the series is known new).
      const need = this.arenaLen + bytes
      const grown = new Uint8Array(Math.max(Math.min(this.arena.length * 2, L.maxDecodedBytes), need))
      grown.set(this.arena.subarray(0, this.arenaLen))
      this.arena = grown
    }
    const out = this.arena
    const start = this.arenaLen
    let p = start + 12

    // FNV-1a 64 over `name 0 value 0`, while copying the entry. The hash is kept as two
    // 32-bit halves and multiplied by the prime 2^40 + 435 with integer operations only:
    //   lo' = lo * 435 (low 32 bits);  hi' = hi * 435 + (lo << 8) + carry(lo * 435)
    // where the carry out of the low half is computed from 16-bit limbs.
    let lo = 0x84222325 | 0
    let hi = 0xcbf29ce4 | 0
    let any = 0
    let hasName = false
    let jobS = 0
    let jobE = 0
    let instS = 0
    let instE = 0
    for (let k = 0; k < m; k++) {
      const o = 4 * order[k]!
      const ns = offs[o]!
      const ne = offs[o + 1]!
      const vs = offs[o + 2]!
      const ve = offs[o + 3]!
      out[p] = (ne - ns) & 255
      out[p + 1] = (ne - ns) >>> 8
      p += 2
      for (let i = ns; i < ne; i++) {
        const c = buf[i]!
        if (c === 0) return -Reject.InvalidLabel
        any |= c
        out[p++] = c
        lo ^= c
        hi = (Math.imul(hi, 435) + (lo << 8) + (((lo >>> 16) * 435 + (((lo & 0xffff) * 435) >>> 16)) >>> 16)) | 0
        lo = Math.imul(lo, 435)
      }
      {
        // The 0x00 after the name: xor with zero changes nothing, only multiply.
        hi = (Math.imul(hi, 435) + (lo << 8) + (((lo >>> 16) * 435 + (((lo & 0xffff) * 435) >>> 16)) >>> 16)) | 0
        lo = Math.imul(lo, 435)
      }
      out[p] = (ve - vs) & 255
      out[p + 1] = (ve - vs) >>> 8
      p += 2
      for (let i = vs; i < ve; i++) {
        const c = buf[i]!
        if (c === 0) return -Reject.InvalidLabel
        any |= c
        out[p++] = c
        lo ^= c
        hi = (Math.imul(hi, 435) + (lo << 8) + (((lo >>> 16) * 435 + (((lo & 0xffff) * 435) >>> 16)) >>> 16)) | 0
        lo = Math.imul(lo, 435)
      }
      {
        hi = (Math.imul(hi, 435) + (lo << 8) + (((lo >>> 16) * 435 + (((lo & 0xffff) * 435) >>> 16)) >>> 16)) | 0
        lo = Math.imul(lo, 435)
      }
      const nameLen = ne - ns
      if (nameLen === 8) {
        if (isAscii(buf, ns, ne, '__name__')) hasName = true
        else if (isAscii(buf, ns, ne, 'instance')) {
          instS = vs
          instE = ve
        }
      } else if (nameLen === 3 && isAscii(buf, ns, ne, 'job')) {
        jobS = vs
        jobE = ve
      }
    }
    if (!hasName) return -Reject.MissingName
    if (any & 0x80) {
      for (let k = 0; k < m; k++) {
        const o = 4 * order[k]!
        if (!validUtf8(buf, offs[o]!, offs[o + 1]!) || !validUtf8(buf, offs[o + 2]!, offs[o + 3]!)) return -Reject.InvalidLabel
      }
    }
    // series_id i64 little-endian, then n_labels u32.
    out[start] = lo & 255
    out[start + 1] = (lo >>> 8) & 255
    out[start + 2] = (lo >>> 16) & 255
    out[start + 3] = lo >>> 24
    out[start + 4] = hi & 255
    out[start + 5] = (hi >>> 8) & 255
    out[start + 6] = (hi >>> 16) & 255
    out[start + 7] = hi >>> 24
    out[start + 8] = m & 255
    out[start + 9] = (m >>> 8) & 255
    out[start + 10] = (m >>> 16) & 255
    out[start + 11] = m >>> 24

    // Same series seen earlier in this request? Compare the whole entry, not just the id.
    // 30 bits, so the Map key stays a small integer.
    const key = (lo ^ hi) & 0x3fffffff
    const first = this.byHash.get(key)
    for (let s = first; s !== undefined && s >= 0; s = this.nextSameHash[s]) {
      if (this.entryLen[s] !== bytes) continue
      const so = this.entryOff[s]!
      let same = true
      for (let i = 0; i < bytes; i++) {
        if (out[so + i] !== out[start + i]) {
          same = false
          break
        }
      }
      if (same) return s
    }
    if (this.entryOff.length >= L.maxSeries) throw tooLarge(`more than ${L.maxSeries} series in one request`)
    // A resource's labels are copied into every series of it: a small body can name far more
    // label bytes than it holds (edge/README.md, "Memory per request").
    if (start + bytes > L.maxDecodedBytes) throw tooLarge(`request decodes into more than ${L.maxDecodedBytes} bytes of series labels; send smaller requests`)
    const idx = this.entryOff.length
    this.entryOff.push(start)
    this.entryLen.push(bytes)
    this.routeOf.push(this.route(buf, jobS, jobE, instS, instE))
    this.nextSameHash.push(first ?? -1)
    this.byHash.set(key, idx)
    this.arenaLen = start + bytes
    return idx
  }

  /**
   * The routing key `job=<job>\u0000instance=<instance>` of a series, interned: a sender
   * repeats a handful of job/instance pairs across thousands of series, so the string is
   * built once per distinct pair and found again by comparing bytes.
   */
  private route(buf: Uint8Array, js: number, je: number, is: number, ie: number): number {
    let h = 0x811c9dc5
    for (let i = js; i < je; i++) h = Math.imul(h ^ buf[i]!, 0x01000193)
    h = Math.imul(h ^ 0x100, 0x01000193)
    for (let i = is; i < ie; i++) h = Math.imul(h ^ buf[i]!, 0x01000193)
    h &= 0x3fffffff
    const jl = je - js
    const il = ie - is
    const hit = this.routeByHash.get(h)
    if (hit !== undefined) {
      const b = this.routeBytes[hit]!
      if (b.length === jl + il + 1 && b[jl] === 0) {
        let same = true
        for (let i = 0; same && i < jl; i++) same = b[i] === buf[js + i]
        for (let i = 0; same && i < il; i++) same = b[jl + 1 + i] === buf[is + i]
        if (same) return hit
      }
    }
    // New pair (or a hash collision, which just costs a second entry for the same string).
    const bytes = new Uint8Array(jl + il + 1)
    bytes.set(buf.subarray(js, je), 0)
    bytes.set(buf.subarray(is, ie), jl + 1)
    const idx = this.routes.length
    this.routes.push(`job=${utf8.decode(buf.subarray(js, je))}\u0000instance=${utf8.decode(buf.subarray(is, ie))}`)
    this.routeBytes.push(bytes)
    this.routeByHash.set(h, idx)
    return idx
  }

  /** Validates the timestamp and reserves a row; returns the byte offset of its value, or -1. */
  private row(series: number, ts: number): number {
    this.received++
    // Integers beyond 2^53 are far outside any window; which side depends on the sign.
    if (!(ts >= this.minTs)) {
      this.rejectedTotal++
      this.rejected.set(REASONS[Reject.TooOld]!, (this.rejected.get(REASONS[Reject.TooOld]!) ?? 0) + 1)
      return -1
    }
    if (!(ts <= this.maxTs)) {
      this.rejectedTotal++
      this.rejected.set(REASONS[Reject.TooNew]!, (this.rejected.get(REASONS[Reject.TooNew]!) ?? 0) + 1)
      return -1
    }
    const i = this.nRows
    if (i >= this.limits.maxSamples) throw tooLarge(`more than ${this.limits.maxSamples} samples in one request`)
    if (i === this.rowTs.length) {
      const cap = i * 2
      const s = new Uint32Array(cap)
      s.set(this.rowSeries)
      this.rowSeries = s
      const t = new Float64Array(cap)
      t.set(this.rowTs)
      this.rowTs = t
      const v = new Uint8Array(cap * 8)
      v.set(this.rowVal)
      this.rowVal = v
      this.valView = new DataView(v.buffer)
    }
    this.rowSeries[i] = series
    this.rowTs[i] = ts
    this.nRows = i + 1
    return i * 8
  }

  /**
   * Add a sample whose value is 8 little-endian IEEE 754 bytes at `src[off..]`. The bytes
   * are copied, never passed through a JS number, so NaN payloads survive.
   * `src === null` means the value 0 (a protobuf default).
   */
  addSampleBytes(series: number, ts: number, src: Uint8Array | null, off: number): void {
    const p = this.row(series, ts)
    if (p < 0 || src === null) return
    const v = this.rowVal
    for (let i = 0; i < 8; i++) v[p + i] = src[off + i]!
  }

  addSampleNumber(series: number, ts: number, value: number): void {
    const p = this.row(series, ts)
    if (p >= 0) this.valView.setFloat64(p, value, true)
  }

  /** The Prometheus staleness marker, NaN with bits 0x7ff0000000000002. */
  addStale(series: number, ts: number): void {
    const p = this.row(series, ts)
    if (p < 0) return
    this.valView.setUint32(p, 2, true)
    this.valView.setUint32(p + 4, 0x7ff00000, true)
  }
}

export interface Batch {
  bytes: Uint8Array<ArrayBuffer>
  rows: number
  /**
   * The `series_id` of each series table entry, in table order: what the shard meters
   * (contracts/BATCH.md). Absent for span and log batches, which are not metered.
   */
  seriesIds?: BigInt64Array
}

/** A metrics batch: always carries its series ids. */
export interface MetricBatch extends Batch {
  seriesIds: BigInt64Array
}

const pad8 = (n: number): number => (n + 7) & ~7

/**
 * Split the collected rows into `VZB1` batches: rows are grouped by `slotOf(series)`,
 * and each slot's rows are cut into batches of at most `maxBatchBytes` (a batch always
 * holds at least one row). Row order within a slot is arrival order. Rows of a series
 * marked in `skip` are left out (series a shard refused for the active-series limit).
 */
export function buildBatches(c: Collector, slotOfSeries: ArrayLike<number>, maxBatchBytes: number, skip?: Uint8Array): Map<number, MetricBatch[]> {
  const nSeries = c.nSeries
  const counts = new Map<number, number>()
  for (let r = 0; r < c.nRows; r++) {
    if (skip && skip[c.rowSeries[r]!]) continue
    const slot = slotOfSeries[c.rowSeries[r]!]!
    counts.set(slot, (counts.get(slot) ?? 0) + 1)
  }
  const rowsOf = new Map<number, { rows: Uint32Array; n: number }>()
  for (const [slot, n] of counts) rowsOf.set(slot, { rows: new Uint32Array(n), n: 0 })
  for (let r = 0; r < c.nRows; r++) {
    if (skip && skip[c.rowSeries[r]!]) continue
    const s = rowsOf.get(slotOfSeries[c.rowSeries[r]!]!)!
    s.rows[s.n++] = r
  }

  // `stamp[series] === gen` means the series is already in the batch being built, at `local[series]`.
  const stamp = new Int32Array(nSeries)
  const local = new Int32Array(nSeries)
  let gen = 0
  const out = new Map<number, MetricBatch[]>()
  for (const [slot, { rows }] of rowsOf) {
    const batches: MetricBatch[] = []
    let from = 0
    while (from < rows.length) {
      gen++
      const series: number[] = []
      let tableBytes = 0
      let to = from
      for (; to < rows.length; to++) {
        const s = c.rowSeries[rows[to]!]!
        const isNew = stamp[s] !== gen
        const table = tableBytes + (isNew ? c.entryLen[s]! : 0)
        const n = to - from + 1
        if (n > 1 && pad8(16 + table) + pad8(4 * n) + 16 * n > maxBatchBytes) break
        if (isNew) {
          stamp[s] = gen
          local[s] = series.length
          series.push(s)
          tableBytes = table
        }
      }
      batches.push(encodeBatch(c, series, rows, from, to, local, tableBytes))
      from = to
    }
    out.set(slot, batches)
  }
  return out
}

function encodeBatch(c: Collector, series: number[], rows: Uint32Array, from: number, to: number, local: Int32Array, tableBytes: number): MetricBatch {
  const n = to - from
  const idxAt = pad8(16 + tableBytes)
  const tsAt = idxAt + pad8(4 * n)
  const valAt = tsAt + 8 * n
  const bytes = new Uint8Array(valAt + 8 * n)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x56 // V
  bytes[1] = 0x5a // Z
  bytes[2] = 0x42 // B
  bytes[3] = 0x31 // 1
  bytes[4] = 1 // signal: metrics
  view.setUint32(8, n, true)
  view.setUint32(12, series.length, true)
  let p = 16
  for (const s of series) {
    bytes.set(c.entry(s), p)
    p += c.entryLen[s]!
  }
  for (let i = 0; i < n; i++) {
    const r = rows[from + i]!
    view.setUint32(idxAt + 4 * i, local[c.rowSeries[r]!]!, true)
    // i64 from a safe integer, without BigInt: two's complement by halves.
    const ts = c.rowTs[r]!
    let lo: number
    let hi: number
    if (ts >= 0) {
      lo = ts % 4294967296
      hi = (ts - lo) / 4294967296
    } else {
      const m = -ts - 1
      const mlo = m % 4294967296
      lo = ~mlo
      hi = ~((m - mlo) / 4294967296)
    }
    view.setUint32(tsAt + 8 * i, lo >>> 0, true)
    view.setUint32(tsAt + 8 * i + 4, hi >>> 0, true)
  }
  for (let i = 0; i < n; i++) {
    const src = rows[from + i]! * 8
    bytes.set(c.rowVal.subarray(src, src + 8), valAt + 8 * i)
  }
  return { bytes, rows: n, seriesIds: BigInt64Array.from(series, (s) => c.seriesId(s)) }
}
