/**
 * Filtered, paged tail reads (CARDINALITY.md "What is left" 1; D48): the shard's side.
 *
 * A shard stores each acknowledged batch as the bytes `edge` sent (contracts/BATCH.md, `VZB1`).
 * An append reads only the header, and of a span or log batch the entry table's lengths and its
 * time column (`batchTimeBounds`, D72). A FILTERED tail read reads more: for each stored batch above the
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
 * One call considers at most this many stored batches, skipped ones included; the rest is the next
 * page's (review of D72, M-1: a batch skipped by its time bounds costs no payload read, but its
 * index entries are still read, so their number is bounded too). Measured here (local workerd,
 * bench/skipread.node.mjs): about 0.1 KB of pages and 0.4 µs per skipped batch, so this many cost
 * about 3 MB and 13 ms at most.
 */
export const TAIL_SCAN_MAX_BATCHES = 32_768

/**
 * What a filtered tail read keeps. Every field is optional; what is absent does not filter. A row
 * is kept when its timestamp is in `[minTs, maxTs]` and its series matches every given filter.
 *
 * Signals (added 2026-11-19, stage 2 of traces and logs; additive within `v` 1): a stored batch
 * is a metrics batch (signal 1) or, in the shards of the derived pools `{pool}/traces` and
 * `{pool}/logs`, a span (2) or log-record (3) batch (contracts/BATCH.md, "Streams per signal").
 * `signals` keeps only batches of those signals, by the header's signal byte, without reading
 * further. Everything else in the filter selects METRIC rows: the time range and the series
 * fields apply to signal 1 only. A batch of signal 2 or 3 that `signals` admits is returned
 * whole, as stored (its times are nanoseconds in columns of their own; the reader filters them),
 * unless the filter names `metrics`, `labels` or `keyRange`, which select series that such a
 * batch does not have: then it keeps nothing. A batch of any other signal is never guessed at:
 * skipped when `signals` leaves it out, else the read fails (`UnreadableBatch`). A metrics query
 * passes `signals: [1]`; a read of spans or logs passes `[2]` or `[3]`.
 *
 * Time bounds of span and log batches (added 2026-11-19, D72, review m-3; additive within `v` 1;
 * contracts/BATCH.md "Tail reads of spans and log records by time"): the shard records each span
 * or log batch's time bounds once, at append (`batchTimeBounds`: the floor in milliseconds of its
 * smallest and largest span `start` or log `ts`). A filtered read with a time range skips a span
 * or log batch whose bounds lie wholly outside `[minTs, maxTs]`, deciding from an index of the
 * bounds without reading the batch from storage (review of D72, M-1), and returns every other one
 * whole, as before. A batch without bounds (written before schema 3, or by the release before it,
 * or one the walk does not accept) is kept by every time range. So a caller that needs every span
 * starting (or log record stamped) in `[lo, hi]` nanoseconds passes `minTs = floor(lo / 10⁶)`,
 * `maxTs = floor(hi / 10⁶)` and gets every batch that holds one.
 */
export interface TailFilter {
  /** Keep only batches whose signal byte is one of these (1 metrics, 2 spans, 3 log records). */
  signals?: number[]
  /**
   * Inclusive Unix milliseconds. Metric rows by `ts`; span and log batches whole, by the bounds
   * recorded at append (a batch without bounds is always kept).
   */
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
  /** The signals kept, or null for every signal this code reads (1, 2, 3). */
  signals: Set<number> | null
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
  /** True when the filter names series (`metrics`, `labels` or `keyRange`): a span or log batch then keeps nothing. */
  series: boolean
  /** True when the filter has a time range: span and log batches are then chosen by the bounds recorded at append (`batchTimeBounds`; `Shard.tailPage`). */
  timed: boolean
}

const te = new TextEncoder()
const NAME = te.encode('__name__')

export function compileFilter(f: TailFilter): CompiledFilter | { invalid: string } {
  const minTs = f.minTs ?? -Infinity
  const maxTs = f.maxTs ?? Infinity
  if (f.minTs !== undefined && !Number.isSafeInteger(f.minTs)) return { invalid: 'minTs must be an integer' }
  if (f.maxTs !== undefined && !Number.isSafeInteger(f.maxTs)) return { invalid: 'maxTs must be an integer' }
  if (minTs > maxTs) return { invalid: 'minTs is after maxTs' }
  if (f.signals !== undefined && (!Array.isArray(f.signals) || f.signals.length === 0 || f.signals.some((x) => !Number.isInteger(x) || x < 1 || x > 255))) {
    return { invalid: 'signals must be a non-empty list of signal numbers (1 to 255)' }
  }
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
  const signals = f.signals ? new Set(f.signals) : null
  const canonical = JSON.stringify({
    minTs: f.minTs ?? null,
    maxTs: f.maxTs ?? null,
    metrics: names ? names.sort() : null,
    labels: f.labels ? [...f.labels].map((l) => [l.name, l.value]).sort() : null,
    keyRange: key ? [String(key.lo), String(key.hi)] : null,
    // Only when given: a filter without signals keeps the text (and so the cursors) it had before.
    ...(signals ? { signals: [...signals].sort((a, b) => a - b) } : {}),
  })
  const series = !!metrics || labels.length > 0 || !!key
  const timed = f.minTs !== undefined || f.maxTs !== undefined
  const all = !signals && !timed && !metrics && labels.length === 0 && !key
  return { signals, minTs, maxTs, metrics, labels, present: labels.filter((l) => l.value.length > 0).length, key, canonical, all, series, timed }
}

const NS_PER_MS = 1_000_000n

/**
 * The time bounds of a span (signal 2) or log-record (signal 3) batch, computed once at append
 * (D72): the floor, in Unix milliseconds, of its smallest and largest span `start`
 * (`start_time_unix_nano`) or log `ts`, the same floor the ledger's `FileEntry.minTs`/`maxTs`
 * take of a file's nanosecond bounds (D63). A millisecond range `[a, b]` covers nanoseconds
 * `[a·10⁶, b·10⁶ + 999,999]`, so these bounds overlap a millisecond range exactly when the rows'
 * nanosecond times can.
 *
 * Read without decoding the batch: the entry table is walked by its length fields
 * (contracts/BATCH.md, "Spans, signal 2", "Log records, signal 3") to find the one fixed-width
 * column, which is then scanned as pairs of u32 (exact, no float). Only the layout BATCH.md
 * defines is walked: `flags` and `reserved` zero (a later layout says so there, or by a new magic
 * or signal: BATCH.md "The one layout a shard reads"), at least one entry, zero padding before and
 * after the `entry` column (review of D72, m-1). Null for a metric batch, a batch of another
 * signal or layout, an empty one, and any batch whose lengths do not lead to a whole column
 * inside it, or that holds a time outside `0 … 2^63 − 1`: such a batch is stored without bounds
 * and every time range keeps it. It never throws: an append is never refused for it.
 *
 * Cost: linear in the entry table and the column, paid once per append (review of D72, m-4; see
 * bench/walk.node.mjs and shard/README.md for the measurements).
 */
export function batchTimeBounds(payload: Uint8Array): { minTs: number; maxTs: number } | null {
  const signal = batchSignal(payload)
  if (signal !== 2 && signal !== 3) return null
  const len = payload.length
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  // Flags and reserved: a layout this code does not know (BATCH.md: a later one signals itself here).
  if (payload[5] !== 0 || payload[6] !== 0 || payload[7] !== 0) return null
  const n = dv.getUint32(8, true)
  const entries = dv.getUint32(12, true)
  // Every row takes more than 8 bytes, every entry more than 8: anything larger cannot be walked.
  if (n === 0 || entries === 0 || n > len / 8 || entries > len / 8) return null
  let p = 16
  const skip16 = (): boolean => {
    if (p + 2 > len) return false
    p += 2 + dv.getUint16(p, true)
    return true
  }
  const skip32 = (): boolean => {
    if (p + 4 > len) return false
    p += 4 + dv.getUint32(p, true)
    return true
  }
  for (let e = 0; e < entries; e++) {
    p += 8 // resource_fp or stream_id
    if (signal === 2) {
      // resource attrs: n u16, then per attribute key_len u16, key, type u8, value.
      if (p + 2 > len) return null
      const nAttrs = dv.getUint16(p, true)
      p += 2
      for (let a = 0; a < nAttrs; a++) {
        if (!skip16() || p + 1 > len) return null
        const type = payload[p++]!
        if (type === 1 || type === 5) {
          if (!skip32()) return null
        } else if (type === 2 || type === 3) p += 8
        else if (type === 4) p += 1
        else return null
        if (p > len) return null
      }
      // scope_name u16, scope_version u16, scope_attrs u32.
      if (!skip16() || !skip16() || !skip32()) return null
    } else {
      // n_labels u32, then per label name_len u16, name, value_len u16, value.
      if (p + 4 > len) return null
      const nLabels = dv.getUint32(p, true)
      p += 4
      if (nLabels > len) return null
      for (let l = 0; l < nLabels; l++) if (!skip16() || !skip16()) return null
    }
    if (p > len) return null
  }
  // Every column starts at a multiple of 8 after zero padding: `entry` u32[n], then (spans)
  // trace_id 16n, span_id 8n, parent_span_id 8n, then `start` i64[n]; (logs) `ts` i64[n] straight
  // after `entry`. Padding that is not zero is a layout this code does not know.
  const at8 = (x: number) => Math.ceil(x / 8) * 8
  const entryAt = at8(p)
  const entryEnd = entryAt + 4 * n
  let col = at8(entryEnd)
  if (col > len) return null
  for (let i = p; i < entryAt; i++) if (payload[i] !== 0) return null
  for (let i = entryEnd; i < col; i++) if (payload[i] !== 0) return null
  if (signal === 2) col += 32 * n
  if (col + 8 * n > len) return null
  // The smallest and largest value, compared as (high, low) u32 pairs: exact for every i64.
  let minHi = 0xffffffff
  let minLo = 0xffffffff
  let maxHi = 0
  let maxLo = 0
  for (let i = 0, q = col; i < n; i++, q += 8) {
    const lo = dv.getUint32(q, true)
    const hi = dv.getUint32(q + 4, true)
    if (hi >= 0x80000000) return null // negative: outside what the contract allows
    if (hi < minHi || (hi === minHi && lo < minLo)) {
      minHi = hi
      minLo = lo
    }
    if (hi > maxHi || (hi === maxHi && lo > maxLo)) {
      maxHi = hi
      maxLo = lo
    }
  }
  const ms = (hi: number, lo: number) => Number(((BigInt(hi) << 32n) | BigInt(lo)) / NS_PER_MS)
  return { minTs: ms(minHi, minLo), maxTs: ms(maxHi, maxLo) }
}

const pad8 = (n: number) => (n + 7) & ~7
const equalBytes = (a: Uint8Array, b: Uint8Array, at: number, len: number) => {
  if (len !== a.length) return false
  for (let i = 0; i < len; i++) if (a[i] !== b[at + i]) return false
  return true
}

export class UnreadableBatch extends Error {}

/** The signal byte of a stored batch (contracts/BATCH.md, offset 4), or null when it has no `VZB1` header. */
export function batchSignal(payload: Uint8Array): number | null {
  if (payload.length < 16 || payload[0] !== 0x56 || payload[1] !== 0x5a || payload[2] !== 0x42 || payload[3] !== 0x31) return null
  return payload[4]!
}

/**
 * The rows of one stored batch that the filter keeps, as a `VZB1` batch, with their count; null
 * when none is kept. The bytes are returned unchanged when every row is kept. A span or log batch
 * is kept whole or not at all (`TailFilter`).
 */
export function filterBatch(payload: Uint8Array, f: CompiledFilter): { bytes: Uint8Array; rows: number } | null {
  const bad = (why: string) => new UnreadableBatch(`not a VZB1 batch: ${why}`)
  const signal = batchSignal(payload)
  if (signal === null) throw bad('header')
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  if (f.signals && !f.signals.has(signal)) return null
  if (signal === 2 || signal === 3) return f.series ? null : { bytes: payload, rows: dv.getUint32(8, true) }
  if (signal !== 1) throw bad(`signal ${signal}`)
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
