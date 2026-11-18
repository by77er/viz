/**
 * A small `VZB1` encoder for tests (contracts/BATCH.md), sharing no code with `edge` or
 * with the Rust crate. Series ids are FNV-1a 64 computed with BigInt, as the contract
 * states it. Values are given as raw bits so tests control NaN payloads exactly.
 */
export const STALE_NAN = 0x7ff0000000000002n

const te = new TextEncoder()

export function cmpUtf8(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return a.length - b.length
}

/** Labels as `[name bytes, value bytes]`, empty values dropped, sorted in UTF-8 byte order. */
export function canonical(labels: Record<string, string>): [Uint8Array, Uint8Array][] {
  return Object.entries(labels)
    .filter(([, v]) => v !== '')
    .map(([n, v]) => [te.encode(n), te.encode(v)] as [Uint8Array, Uint8Array])
    .sort((a, b) => cmpUtf8(a[0], b[0]))
}

export function seriesId(labels: Record<string, string>): bigint {
  let h = 0xcbf29ce484222325n
  const eat = (bytes: Uint8Array) => {
    for (const b of bytes) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n)
    h = BigInt.asUintN(64, h * 0x100000001b3n) // the 0x00 separator: xor with 0, then multiply
  }
  for (const [n, v] of canonical(labels)) {
    eat(n)
    eat(v)
  }
  return BigInt.asIntN(64, h)
}

export const bitsOf = (v: number): bigint => {
  const dv = new DataView(new ArrayBuffer(8))
  dv.setFloat64(0, v, true)
  return dv.getBigUint64(0, true)
}

export interface Row {
  /** Index into the batch's series list. */
  series: number
  ts: number
  /** IEEE 754 bits. */
  bits: bigint
}

const pad8 = (n: number) => (n + 7) & ~7

/** Encode one batch. Rows are written in the order given. */
export function encodeBatch(series: Record<string, string>[], rows: Row[]): Uint8Array<ArrayBuffer> {
  const entries = series.map((labels) => ({ id: seriesId(labels), labels: canonical(labels) }))
  let table = 0
  for (const e of entries) table += 12 + e.labels.reduce((a, [n, v]) => a + 4 + n.length + v.length, 0)
  const idxAt = pad8(16 + table)
  const tsAt = idxAt + pad8(4 * rows.length)
  const valAt = tsAt + 8 * rows.length
  const out = new Uint8Array(valAt + 8 * rows.length)
  const dv = new DataView(out.buffer)
  out.set(te.encode('VZB1'), 0)
  out[4] = 1
  dv.setUint32(8, rows.length, true)
  dv.setUint32(12, entries.length, true)
  let p = 16
  for (const e of entries) {
    dv.setBigInt64(p, e.id, true)
    dv.setUint32(p + 8, e.labels.length, true)
    p += 12
    for (const [n, v] of e.labels) {
      for (const part of [n, v]) {
        dv.setUint16(p, part.length, true)
        out.set(part, p + 2)
        p += 2 + part.length
      }
    }
  }
  rows.forEach((r, i) => {
    dv.setUint32(idxAt + 4 * i, r.series, true)
    dv.setBigInt64(tsAt + 8 * i, BigInt(r.ts), true)
    dv.setBigUint64(valAt + 8 * i, r.bits, true)
  })
  return out
}

/** The bits of every element of a Float64Array, read from its bytes (never as numbers). */
export function bitsFromBytes(a: Float64Array): bigint[] {
  const dv = new DataView(a.buffer, a.byteOffset, a.byteLength)
  return Array.from({ length: a.length }, (_, i) => dv.getBigUint64(8 * i, true))
}

/**
 * A batch of `nSeries` series with rows filling it to just under `targetBytes`: row `k`
 * is series `k % nSeries` at `t0 + floor(k / nSeries) * stepMs`, value `k`.
 */
export function bigBatch(nSeries: number, targetBytes: number, t0: number, stepMs: number, tag = ''): { bytes: Uint8Array<ArrayBuffer>; rows: number; lastTs: number } {
  const series = Array.from({ length: nSeries }, (_, i) => ({
    __name__: `http_requests_total_${i % 20}`,
    job: 'api',
    instance: `10.0.${(i >> 8) & 255}.${i & 255}:9100`,
    path: `/v1/items/${i}${tag}`,
  }))
  let table = 0
  for (const s of series) table += 12 + canonical(s).reduce((a, [n, v]) => a + 4 + n.length + v.length, 0)
  const nRows = Math.floor((targetBytes - pad8(16 + table) - 8) / 20)
  const rows: Row[] = Array.from({ length: nRows }, (_, k) => ({ series: k % nSeries, ts: t0 + Math.floor(k / nSeries) * stepMs, bits: bitsOf(k) }))
  const bytes = encodeBatch(series, rows)
  return { bytes, rows: nRows, lastTs: rows[nRows - 1]!.ts }
}
