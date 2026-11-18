// Deterministic synthetic metric samples, sorted (metric, series_id, ts).
// 20 metrics x 100 series x 960 points (4 h at 15 s) = 1,920,000 rows.
import { writeFileSync } from 'node:fs'
const METRICS = 20, SERIES = 100, POINTS = 960
const N = METRICS * SERIES * POINTS
let s = 0x9e3779b9 >>> 0
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
const nameIdx = new Uint32Array(N), sid = new BigInt64Array(N), ts = new BigInt64Array(N), val = new Float64Array(N)
const names = Array.from({ length: METRICS }, (_, i) => `app_metric_${String(i).padStart(2, '0')}_total`)
const BASE = 1763424000000n
let r = 0
for (let m = 0; m < METRICS; m++) {
  const ids = Array.from({ length: SERIES }, () => (BigInt(Math.floor(rnd() * 2 ** 31)) << 31n) | BigInt(Math.floor(rnd() * 2 ** 31)))
  ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  for (const id of ids) {
    const counter = m % 2 === 0
    let v = counter ? Math.floor(rnd() * 1000) : 50 + rnd() * 50
    const phase = rnd() * 6.28
    for (let p = 0; p < POINTS; p++) {
      if (counter) { v += Math.floor(rnd() * 20); if (rnd() < 0.0005) v = 0 }
      else v = 75 + 20 * Math.sin(phase + p / 40) + rnd() * 2
      nameIdx[r] = m; sid[r] = id; ts[r] = BASE + BigInt(p * 15000 + Math.floor(rnd() * 50)); val[r] = v; r++
    }
  }
}
writeFileSync('data/name_idx.u32', new Uint8Array(nameIdx.buffer))
writeFileSync('data/series_id.i64', new Uint8Array(sid.buffer))
writeFileSync('data/ts.i64', new Uint8Array(ts.buffer))
writeFileSync('data/value.f64', new Uint8Array(val.buffer))
writeFileSync('data/meta.json', JSON.stringify({ rows: N, names, base: Number(BASE), points: POINTS }))
console.log('rows', N, 'raw MB', (N * 28 / 1e6).toFixed(1))
