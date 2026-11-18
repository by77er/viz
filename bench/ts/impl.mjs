// JavaScript implementation of the same two workloads, on hyparquet / hyparquet-writer.
import { parquetMetadata, parquetRead } from 'hyparquet'
import { ByteWriter, parquetWrite } from 'hyparquet-writer'
import { compressors } from 'hyparquet-compressors'

export const ROW_GROUP = 240_000
const STEP_MS = 60_000, WINDOW_MS = 300_000

export function encode(names, nameIdx, sid, ts, val) {
  const n = val.length
  const nameCol = new Array(n)
  for (let i = 0; i < n; i++) nameCol[i] = names[nameIdx[i]]
  const writer = new ByteWriter()
  parquetWrite({
    writer,
    columnData: [
      { name: 'metric_name', data: nameCol, type: 'STRING', nullable: false },
      { name: 'series_id', data: sid, type: 'INT64', nullable: false, encoding: 'DELTA_BINARY_PACKED' },
      { name: 'ts', data: ts, type: 'INT64', nullable: false, encoding: 'DELTA_BINARY_PACKED' },
      { name: 'value', data: val, type: 'DOUBLE', nullable: false, encoding: 'BYTE_STREAM_SPLIT' },
    ],
    rowGroupSize: ROW_GROUP,
    pageSize: 256 * 1024,
    codec: 'SNAPPY',
  })
  return new Uint8Array(writer.getBuffer())
}

function evalSeries(ts, val, i, j, t0, acc, cum) {
  const n = j - i
  if (n < 2) return
  cum[0] = 0
  let c = 0
  for (let k = 1; k < n; k++) {
    const d = val[i + k] - val[i + k - 1]
    c += d >= 0 ? d : val[i + k]
    cum[k] = c
  }
  let lo = 0, hi = 0
  for (let k = 0; k < acc.length; k++) {
    const t = t0 + k * STEP_MS
    while (hi < n && ts[i + hi] <= t) hi++
    while (lo < hi && ts[i + lo] <= t - WINDOW_MS) lo++
    if (hi >= lo + 2) {
      const dt = ts[i + hi - 1] - ts[i + lo]
      if (dt > 0) acc[k] += (cum[hi - 1] - cum[lo]) / dt * 1000
    }
  }
}

const isCounter = (name) => (name.charCodeAt(12) - 48) % 2 === 0

/** Read one row group's four columns as whole arrays. */
async function readGroup(file, metadata, rowStart, rowEnd, wasmCodec) {
  const cols = {}
  await parquetRead({
    file, metadata, rowStart, rowEnd,
    ...(wasmCodec ? { compressors } : {}),
    columns: ['metric_name', 'series_id', 'ts', 'value'],
    onChunk: (c) => { (cols[c.columnName] ??= []).push(c) },
  })
  const one = (name) => {
    const parts = cols[name].sort((a, b) => a.rowStart - b.rowStart)
    if (parts.length === 1) return parts[0].columnData
    const total = parts.reduce((s, p) => s + p.columnData.length, 0)
    const first = parts[0].columnData
    const out = Array.isArray(first) ? new Array(total) : new first.constructor(total)
    let o = 0
    for (const p of parts) { if (Array.isArray(out)) for (const v of p.columnData) out[o++] = v; else { out.set(p.columnData, o); o += p.columnData.length } }
    return out
  }
  return { names: one('metric_name'), sid: one('series_id'), ts: one('ts'), val: one('value') }
}

export async function query(buf, metric, t0, steps, variant = 'tuned') {
  const ab = buf.buffer.byteLength === buf.byteLength ? buf.buffer : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const file = { byteLength: ab.byteLength, slice: (s, e) => ab.slice(s, e) }
  const metadata = parquetMetadata(ab)
  const acc = new Float64Array(steps)
  const cum = new Float64Array(4096)
  let rowStart = 0
  for (const rg of metadata.row_groups) {
    const n = Number(rg.num_rows), rowEnd = rowStart + n
    const st = rg.columns[0].meta_data.statistics
    if (metric && st && st.min_value !== undefined && (metric < st.min_value || metric > st.max_value)) { rowStart = rowEnd; continue }
    const g = await readGroup(file, metadata, rowStart, rowEnd, variant === 'wasm-codec')
    rowStart = rowEnd
    if (variant === 'naive') {
      // BigInt arithmetic throughout, as the library hands the data over.
      let i = 0
      const tsN = Array.from(g.ts, Number)
      while (i < n) {
        let j = i + 1
        while (j < n && g.sid[j] === g.sid[i] && g.names[j] === g.names[i]) j++
        if (metric ? g.names[i] === metric : isCounter(g.names[i])) evalSeries(tsN, g.val, i, j, t0, acc, cum)
        i = j
      }
      continue
    }
    // tuned: view int64 columns as 32-bit words; no BigInt on the hot path.
    const sw = new Int32Array(g.sid.buffer, g.sid.byteOffset, n * 2)
    const tw = new Uint32Array(g.ts.buffer, g.ts.byteOffset, n * 2)
    const tsN = new Float64Array(n)
    for (let k = 0; k < n; k++) tsN[k] = tw[2 * k] + tw[2 * k + 1] * 4294967296
    let i = 0
    while (i < n) {
      let j = i + 1
      const a = sw[2 * i], b = sw[2 * i + 1], nm = g.names[i]
      while (j < n && sw[2 * j] === a && sw[2 * j + 1] === b && g.names[j] === nm) j++
      if (metric ? nm === metric : isCounter(nm)) evalSeries(tsN, g.val, i, j, t0, acc, cum)
      i = j
    }
  }
  return acc
}
