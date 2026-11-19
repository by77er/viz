/**
 * Filtered, paged tail reads (CARDINALITY.md "What is left" 1; D48): the shard's side.
 *
 * A shard stores each acknowledged batch as the bytes `edge` sent (contracts/BATCH.md, `VZB1`).
 * Appends never look inside them. A FILTERED tail read does: for each stored batch above the
 * caller's watermark it reads the series table and the row arrays, keeps the series that match
 * (metric names, exact label values, a range of `series_id`) and the rows of those series in the
 * time range, and writes them out as a new `VZB1` batch: the series entries' bytes as stored,
 * the rows in their original order, every timestamp and value copied as raw bytes (never as a
 * number, so a staleness NaN keeps its payload). A batch whose rows all match is returned as is.
 *
 * Within a batch the later row wins (BATCH.md), and the kept rows keep their order; batches keep
 * their sequence numbers and order. So the engine reads the same samples from a filtered page
 * as from the whole tail with the same selection (test/tail.test.ts checks it through the engine).
 */

/** Version of `TailReadOptions` and of the `page` of an answer (contracts/COMPATIBILITY.md §3.1). */
export const TAIL_READ_VERSION = 1
/** A page holds at most this many payload bytes (half of what one RPC message may carry). */
export const TAIL_PAGE_MAX_BYTES = 16 * 1024 * 1024
/** One call examines at most this many stored bytes; the rest is the next page's. */
export const TAIL_SCAN_MAX_BYTES = 32 * 1024 * 1024

/**
 * What a filtered tail read keeps. Every field is optional; what is absent does not filter. A row
 * is kept when its timestamp is in `[minTs, maxTs]` and its series matches every given filter.
 */
export interface TailFilter {
  /** Inclusive Unix milliseconds. */
  minTs?: number
  maxTs?: number
  /** `__name__` is one of these. */
  metrics?: string[]
  /** Each label has exactly this value; `''` means the series has no such label (BATCH.md drops empty values). */
  labels?: { name: string; value: string }[]
  /**
   * `series_id`, read as an UNSIGNED 64-bit integer, is in `[lo, hi]` (decimal strings). This is
   * the query engine's split key when a split has no `without` labels (engine `SplitKey`): part
   * `j` of `n` is `splitKeyRange(j, n)`.
   */
  keyRange?: { lo: string; hi: string }
}

export interface TailReadOptions extends TailFilter {
  /** Absent means 1. A shard that does not know the version answers `unsupported_version`. */
  v?: number
  /** Payload bytes in one page. Default and at most `TAIL_PAGE_MAX_BYTES`. */
  maxBytes?: number
  /** `page.next` of the previous answer, with the same tenant, incarnation, `aboveSeq` and filter. */
  cursor?: string
}

/** What a page of a filtered read says about itself. Its presence is how a caller knows the filter was applied. */
export interface TailPage {
  v: number
  /** Pass as `cursor` for the next page; null when this page ends the tail (`through`). */
  next: string | null
  /** Stored batches and bytes examined for this page. */
  scannedBatches: number
  scannedBytes: number
}

/** The `[lo, hi]` of `series_id` (unsigned) that the engine's `SplitKey::part_of` gives part `part` of `parts`. */
export function splitKeyRange(part: number, parts: number): { lo: string; hi: string } {
  if (!Number.isSafeInteger(part) || !Number.isSafeInteger(parts) || parts < 1 || part < 0 || part >= parts) throw new Error('splitKeyRange: bad part')
  const span = 1n << 64n
  const P = BigInt(parts)
  // part_of(k) = floor(k * parts / 2^64): part j holds ceil(j * 2^64 / parts) .. ceil((j + 1) * 2^64 / parts) - 1.
  const ceil = (j: bigint) => (j * span + P - 1n) / P
  return { lo: String(ceil(BigInt(part))), hi: String(ceil(BigInt(part) + 1n) - 1n) }
}

const U64_MAX = (1n << 64n) - 1n
const DECIMAL = /^(0|[1-9]\d{0,19})$/

/** A filter checked and prepared for matching, or the reason it is refused. */
export interface CompiledFilter {
  minTs: number
  maxTs: number
  /** Metric names as UTF-8, by length (compared as bytes, never decoded). */
  metrics: Map<number, Uint8Array[]> | null
  labels: { name: Uint8Array; value: Uint8Array }[]
  /** How many of `labels` want a value (not absence). */
  present: number
  key: { lo: bigint; hi: bigint } | null
  /** Canonical text of the filter: a cursor is bound to it. */
  canonical: string
  /** True when nothing is filtered. */
  all: boolean
}

const te = new TextEncoder()
const NAME = te.encode('__name__')

export function compileFilter(f: TailFilter): CompiledFilter | { invalid: string } {
  const minTs = f.minTs ?? -Infinity
  const maxTs = f.maxTs ?? Infinity
  if (f.minTs !== undefined && !Number.isSafeInteger(f.minTs)) return { invalid: 'minTs must be an integer' }
  if (f.maxTs !== undefined && !Number.isSafeInteger(f.maxTs)) return { invalid: 'maxTs must be an integer' }
  if (minTs > maxTs) return { invalid: 'minTs is after maxTs' }
  if (f.metrics !== undefined && (!Array.isArray(f.metrics) || f.metrics.length === 0 || f.metrics.some((m) => typeof m !== 'string' || m === ''))) return { invalid: 'metrics must be a non-empty list of names' }
  if (f.labels !== undefined && (!Array.isArray(f.labels) || f.labels.some((l) => typeof l !== 'object' || l === null || typeof l.name !== 'string' || l.name === '' || typeof l.value !== 'string'))) {
    return { invalid: 'labels must be a list of { name, value }' }
  }
  let key: CompiledFilter['key'] = null
  if (f.keyRange !== undefined) {
    const r = f.keyRange
    if (typeof r !== 'object' || r === null || typeof r.lo !== 'string' || typeof r.hi !== 'string' || !DECIMAL.test(r.lo) || !DECIMAL.test(r.hi)) return { invalid: 'keyRange must be { lo, hi } as decimal strings' }
    const lo = BigInt(r.lo)
    const hi = BigInt(r.hi)
    if (lo > U64_MAX || hi > U64_MAX || lo > hi) return { invalid: 'keyRange must lie in [0, 2^64 - 1] with lo <= hi' }
    key = { lo, hi }
  }
  const names = f.metrics ? [...new Set(f.metrics)] : null
  let metrics: CompiledFilter['metrics'] = null
  if (names) {
    metrics = new Map()
    for (const m of names) {
      const b = te.encode(m)
      metrics.set(b.length, [...(metrics.get(b.length) ?? []), b])
    }
  }
  const labels = (f.labels ?? []).map((l) => ({ name: te.encode(l.name), value: te.encode(l.value) }))
  const canonical = JSON.stringify({
    minTs: f.minTs ?? null,
    maxTs: f.maxTs ?? null,
    metrics: names ? names.sort() : null,
    labels: f.labels ? [...f.labels].map((l) => [l.name, l.value]).sort() : null,
    keyRange: key ? [String(key.lo), String(key.hi)] : null,
  })
  const all = f.minTs === undefined && f.maxTs === undefined && !metrics && labels.length === 0 && !key
  return { minTs, maxTs, metrics, labels, present: labels.filter((l) => l.value.length > 0).length, key, canonical, all }
}

const pad8 = (n: number) => (n + 7) & ~7
const equalBytes = (a: Uint8Array, b: Uint8Array, at: number, len: number) => {
  if (len !== a.length) return false
  for (let i = 0; i < len; i++) if (a[i] !== b[at + i]) return false
  return true
}

export class UnreadableBatch extends Error {}

/**
 * The rows of one stored batch that the filter keeps, as a `VZB1` batch, with their count; null
 * when none is kept. The bytes are returned unchanged when every row is kept.
 */
export function filterBatch(payload: Uint8Array, f: CompiledFilter): { bytes: Uint8Array; rows: number } | null {
  const bad = (why: string) => new UnreadableBatch(`not a VZB1 batch: ${why}`)
  if (payload.length < 16 || payload[0] !== 0x56 || payload[1] !== 0x5a || payload[2] !== 0x42 || payload[3] !== 0x31 || payload[4] !== 1) throw bad('header')
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const nRows = dv.getUint32(8, true)
  const nSeries = dv.getUint32(12, true)
  // The series table: which entries the filter keeps, and where each one's bytes are.
  const starts = new Uint32Array(nSeries + 1)
  const keep = new Uint8Array(nSeries)
  let p = 16
  for (let s = 0; s < nSeries; s++) {
    starts[s] = p
    if (p + 12 > payload.length) throw bad('series table')
    let ok = true
    if (f.key) {
      const id = (BigInt(dv.getUint32(p + 4, true)) << 32n) | BigInt(dv.getUint32(p, true))
      ok = id >= f.key.lo && id <= f.key.hi
    }
    const nLabels = dv.getUint32(p + 8, true)
    p += 12
    // Label names and values are compared as bytes: the batch's are UTF-8, as the filter's are.
    let metricOk = f.metrics === null
    let matched = 0
    for (let l = 0; l < nLabels; l++) {
      if (p + 2 > payload.length) throw bad('label')
      const nameLen = dv.getUint16(p, true)
      const nameAt = p + 2
      p = nameAt + nameLen
      if (p + 2 > payload.length) throw bad('label')
      const valueLen = dv.getUint16(p, true)
      const valueAt = p + 2
      p = valueAt + valueLen
      if (p > payload.length) throw bad('label')
      if (!ok) continue
      if (f.metrics && equalBytes(NAME, payload, nameAt, nameLen)) metricOk = (f.metrics.get(valueLen) ?? []).some((m) => equalBytes(m, payload, valueAt, valueLen))
      for (const want of f.labels) {
        if (!equalBytes(want.name, payload, nameAt, nameLen)) continue
        // Present: it must have the wanted value (an empty wanted value means absent).
        if (want.value.length > 0 && equalBytes(want.value, payload, valueAt, valueLen)) matched++
        else ok = false
      }
    }
    if (ok && !metricOk) ok = false
    // Every wanted non-empty value was found (names are unique within a series).
    if (ok && matched !== f.present) ok = false
    keep[s] = ok ? 1 : 0
  }
  starts[nSeries] = p
  const idxAt = pad8(p)
  const tsAt = idxAt + pad8(4 * nRows)
  const valAt = tsAt + 8 * nRows
  if (valAt + 8 * nRows !== payload.length) throw bad('row arrays')
  const timed = f.minTs !== -Infinity || f.maxTs !== Infinity
  // Rows kept, in order.
  const rows: number[] = []
  const used = new Uint8Array(nSeries)
  for (let i = 0; i < nRows; i++) {
    const s = dv.getUint32(idxAt + 4 * i, true)
    if (s >= nSeries) throw bad('series index')
    if (!keep[s]) continue
    if (timed) {
      // Timestamps are 0 … 253,402,300,799,999 (BATCH.md): exact as a number.
      const ts = dv.getUint32(tsAt + 8 * i + 4, true) * 4294967296 + dv.getUint32(tsAt + 8 * i, true)
      if (ts < f.minTs || ts > f.maxTs) continue
    }
    rows.push(i)
    used[s] = 1
  }
  if (rows.length === 0) return null
  if (rows.length === nRows) {
    let every = true
    for (let s = 0; s < nSeries && every; s++) if (!used[s]) every = false
    if (every) return { bytes: payload, rows: nRows }
  }
  // A new batch: the series that have kept rows (entries copied as stored), then the rows.
  const remap = new Int32Array(nSeries).fill(-1)
  let table = 0
  let kept = 0
  for (let s = 0; s < nSeries; s++) {
    if (!used[s]) continue
    remap[s] = kept++
    table += starts[s + 1]! - starts[s]!
  }
  const n = rows.length
  const oIdx = pad8(16 + table)
  const oTs = oIdx + pad8(4 * n)
  const oVal = oTs + 8 * n
  const out = new Uint8Array(oVal + 8 * n)
  const ov = new DataView(out.buffer)
  out.set(payload.subarray(0, 8), 0) // magic, signal, flags, reserved
  ov.setUint32(8, n, true)
  ov.setUint32(12, kept, true)
  let q = 16
  for (let s = 0; s < nSeries; s++) {
    if (!used[s]) continue
    out.set(payload.subarray(starts[s]!, starts[s + 1]!), q)
    q += starts[s + 1]! - starts[s]!
  }
  for (let k = 0; k < n; k++) {
    const i = rows[k]!
    ov.setUint32(oIdx + 4 * k, remap[dv.getUint32(idxAt + 4 * i, true)]!, true)
    // Raw bytes, never a number: a staleness NaN keeps its payload.
    out.set(payload.subarray(tsAt + 8 * i, tsAt + 8 * i + 8), oTs + 8 * k)
    out.set(payload.subarray(valAt + 8 * i, valAt + 8 * i + 8), oVal + 8 * k)
  }
  return { bytes: out, rows: n }
}

/** What a cursor binds a continuation to. */
export interface TailCursor {
  /** The stream incarnation, the caller's watermark and the end of the tail fixed by the first page. */
  inc: number
  above: number
  through: number
  /** The next sequence number to examine. */
  seq: number
  /** FNV-1a 64 of the tenant and of the filter's canonical text. */
  t: string
  f: string
}

export function fnv64(text: string): string {
  let h = 0xcbf29ce484222325n
  for (const b of te.encode(text)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn
  return h.toString(16).padStart(16, '0')
}

/** `v1.` and the cursor as base64url JSON: opaque to callers, versioned (COMPATIBILITY.md §3.4). */
export function encodeCursor(c: TailCursor): string {
  const json = JSON.stringify({ inc: c.inc, above: c.above, through: c.through, seq: c.seq, t: c.t, f: c.f })
  return `v${TAIL_READ_VERSION}.${btoa(json).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`
}

export function decodeCursor(token: unknown): TailCursor | { invalid: string } | { unsupported: number } {
  if (typeof token !== 'string') return { invalid: 'cursor must be a string' }
  const m = /^v(\d+)\.([A-Za-z0-9_-]+)$/.exec(token)
  if (!m) return { invalid: 'not a tail cursor' }
  if (Number(m[1]) !== TAIL_READ_VERSION) return { unsupported: Number(m[1]) }
  try {
    const b = m[2]!.replaceAll('-', '+').replaceAll('_', '/')
    const c = JSON.parse(atob(b + '='.repeat((4 - (b.length % 4)) % 4))) as TailCursor
    const ints = [c.inc, c.above, c.through, c.seq]
    if (ints.some((x) => !Number.isSafeInteger(x) || x < 0) || typeof c.t !== 'string' || typeof c.f !== 'string') return { invalid: 'not a tail cursor' }
    return c
  } catch {
    return { invalid: 'not a tail cursor' }
  }
}
