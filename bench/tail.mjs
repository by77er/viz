// Tail (write-ahead log batches) vs lake (Parquet) on the SAME rows, both in Rust/WASM.
// Rows: the first 30 minutes of the dataset = 2,000 series x 120 points = 240,000 samples.
// Lake: one sorted Parquet file. Tail: 120 batches of 2,000 samples in arrival order.
import { readFileSync } from 'node:fs'
const meta = JSON.parse(readFileSync('data/meta.json', 'utf8'))
const load = (f, T) => { const b = readFileSync('data/' + f); return new T(b.buffer, b.byteOffset, b.byteLength / T.BYTES_PER_ELEMENT) }
const idx = load('name_idx.u32', Uint32Array), sid = load('series_id.i64', BigInt64Array), ts = load('ts.i64', BigInt64Array), val = load('value.f64', Float64Array)
const P = meta.points, SER = idx.length / P, PTS = 120, N = SER * PTS
const { instance } = await WebAssembly.instantiate(readFileSync(process.argv[2]), {})
const x = instance.exports
const put = (u8) => { const p = x.alloc(u8.byteLength); new Uint8Array(x.memory.buffer, p, u8.byteLength).set(u8); return p }
const b8 = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
const out = () => new Uint8Array(x.memory.buffer, x.out_ptr(), x.out_len()).slice()
// lake file: sorted subset
const sIdx = new Uint32Array(N), sSid = new BigInt64Array(N), sTs = new BigInt64Array(N), sVal = new Float64Array(N)
for (let s = 0, r = 0; s < SER; s++) for (let p = 0; p < PTS; p++, r++) { const k = s * P + p; sIdx[r] = idx[k]; sSid[r] = sid[k]; sTs[r] = ts[k]; sVal[r] = val[k] }
const names = new TextEncoder().encode(meta.names.join('\n'))
const ps = [names, b8(sIdx), b8(sSid), b8(sTs), b8(sVal)].map(put)
x.encode_c(ps[0], names.byteLength, ps[1], ps[2], ps[3], ps[4], N)
const pq = out(); x.out_free()
// tail buffer: one batch per scrape instant, series in arrival (unsorted) order
const tail = new Uint8Array(PTS * (8 + SER * 28)); const dv = new DataView(tail.buffer); let o = 0
for (let p = 0; p < PTS; p++) {
  dv.setUint32(o, SER, true); o += 8
  const order = Array.from({ length: SER }, (_, i) => (i * 7919 + p * 31) % SER)
  for (const s of order) { dv.setUint32(o, idx[s * P + p], true); o += 4 }
  for (const s of order) { dv.setBigInt64(o, sid[s * P + p], true); o += 8 }
  for (const s of order) { dv.setBigInt64(o, ts[s * P + p], true); o += 8 }
  for (const s of order) { dv.setFloat64(o, val[s * P + p], true); o += 8 }
}
const T0 = BigInt(meta.base + 300_000), STEPS = (PTS * 15_000 - 300_000) / 60_000
const bench = (fn) => { const t = []; let r; for (let i = 0; i < 21; i++) { const s = performance.now(); r = fn(); t.push(performance.now() - s) } t.sort((a, b) => a - b); return [t[10], r] }
console.log(`rows ${N}; lake ${(pq.length / 1048576).toFixed(2)} MB parquet; tail ${(tail.length / 1048576).toFixed(2)} MB raw batches`)
for (const [label, metric, keepFn] of [['one metric (12,000 rows match)', 'app_metric_06_total', (i) => i === 6], ['all counters (120,000 rows match)', '', (i) => i % 2 === 0]]) {
  const m = new TextEncoder().encode(metric), keep = Uint8Array.from(meta.names, (_, i) => keepFn(i) ? 1 : 0)
  const [lakeMs, a] = bench(() => { const fp = put(pq), mp = put(m); x.query_c(fp, pq.length, mp, m.length, T0, STEPS); const r = new Float64Array(out().buffer); x.out_free(); x.dealloc(mp, m.length); return r.reduce((p, c) => p + c, 0) })
  const [tailMs, b] = bench(() => { const tp = put(tail), kp = put(keep); x.tail_query_c(tp, tail.length, kp, keep.length, T0, STEPS); const r = new Float64Array(out().buffer); x.out_free(); x.dealloc(tp, tail.length); x.dealloc(kp, keep.length); return r.reduce((p, c) => p + c, 0) })
  console.log(JSON.stringify({ query: label, lake_ms: +lakeMs.toFixed(2), tail_ms: +tailMs.toFixed(2), same_result: Math.abs(a - b) <= 1e-9 * Math.abs(a), sum: a.toPrecision(10) }))
}
