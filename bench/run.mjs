// Usage: node run.mjs <rust|js|js-naive|noop> <encode|q1|q2> [iters] [wasm path] [parquet path]
import { readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
const [impl, work, itersArg, wasmPath = 'core/target/wasm32-unknown-unknown/release/vizcore.wasm', pqArg] = process.argv.slice(2)
const iters = Number(itersArg ?? 7)
const meta = JSON.parse(readFileSync('data/meta.json', 'utf8'))
const T0 = meta.base + 300_000, STEPS = (meta.points * 15_000 - 300_000) / 60_000
const METRIC = 'app_metric_06_total'
const rss = () => Number(/VmHWM:\s+(\d+)/.exec(readFileSync('/proc/self/status', 'utf8'))[1]) / 1024
const load = (f, T) => { const b = readFileSync('data/' + f); return new T(b.buffer, b.byteOffset, b.byteLength / T.BYTES_PER_ELEMENT) }

let fn, wasmMem = () => 0, startup = 0
const pqPath = pqArg ?? (impl === 'rust' ? 'data/rust.parquet' : 'data/js.parquet')

if (impl === 'rust') {
  const bytes = readFileSync(wasmPath)
  const s = performance.now()
  const { instance } = await WebAssembly.instantiate(bytes, {})
  startup = performance.now() - s
  const x = instance.exports
  wasmMem = () => x.memory.buffer.byteLength / 1048576
  const put = (u8) => { const p = x.alloc(u8.byteLength); new Uint8Array(x.memory.buffer, p, u8.byteLength).set(u8); return p }
  const bytesOf = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
  const out = () => new Uint8Array(x.memory.buffer, x.out_ptr(), x.out_len()).slice()
  if (work === 'encode') {
    const idx = load('name_idx.u32', Uint32Array), sid = load('series_id.i64', BigInt64Array), ts = load('ts.i64', BigInt64Array), val = load('value.f64', Float64Array)
    const names = new TextEncoder().encode(meta.names.join('\n'))
    fn = () => {
      const ps = [names, bytesOf(idx), bytesOf(sid), bytesOf(ts), bytesOf(val)].map(put)
      x.encode_c(ps[0], names.byteLength, ps[1], ps[2], ps[3], ps[4], val.length)
      const o = out(); x.out_free()
      ;[names, idx, sid, ts, val].forEach((a, i) => x.dealloc(ps[i], a.byteLength))
      return o
    }
  } else {
    const file = readFileSync(pqPath)
    const m = new TextEncoder().encode(work === 'q1' ? METRIC : '')
    fn = () => {
      const fp = put(file), mp = put(m)
      x.query_c(fp, file.byteLength, mp, m.byteLength, BigInt(T0), STEPS)
      const o = out(); x.out_free(); x.dealloc(mp, m.byteLength)
      return new Float64Array(o.buffer)
    }
  }
} else if (impl.startsWith('js')) {
  const s = performance.now()
  const js = await import('./ts/impl.mjs')
  startup = performance.now() - s
  if (work === 'encode') {
    const idx = load('name_idx.u32', Uint32Array), sid = load('series_id.i64', BigInt64Array), ts = load('ts.i64', BigInt64Array), val = load('value.f64', Float64Array)
    fn = () => js.encode(meta.names, idx, sid, ts, val)
  } else {
    const file = new Uint8Array(readFileSync(pqPath))
    fn = () => js.query(file, work === 'q1' ? METRIC : '', T0, STEPS, impl === 'js-naive' ? 'naive' : impl === 'js-wasm-codec' ? 'wasm-codec' : 'tuned')
  }
} else {
  // noop: load the same inputs, do nothing, to give a baseline for peak RSS
  if (work === 'encode') { load('name_idx.u32', Uint32Array); load('series_id.i64', BigInt64Array); load('ts.i64', BigInt64Array); load('value.f64', Float64Array) }
  else readFileSync(pqPath)
  fn = () => new Float64Array(1)
}

const times = []
let res
for (let i = 0; i < iters; i++) { const s = performance.now(); res = await fn(); times.push(performance.now() - s) }
if (work === 'encode' && impl !== 'noop') writeFileSync(pqPath, res)
const sorted = [...times].sort((a, b) => a - b)
const sum = work === 'encode' ? res.byteLength : Array.from(res).reduce((a, b) => a + b, 0)
console.log(JSON.stringify({
  impl, work, pq: pqPath.replace('data/', ''), cold_ms: +times[0].toFixed(1), median_ms: +sorted[sorted.length >> 1].toFixed(1), min_ms: +sorted[0].toFixed(1),
  peak_rss_mb: +rss().toFixed(0), wasm_mem_mb: +wasmMem().toFixed(0), startup_ms: +startup.toFixed(1),
  result: work === 'encode' ? `${(sum / 1048576).toFixed(2)} MB` : sum.toPrecision(12),
}))
