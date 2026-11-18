// Local measurements of the WASM module in Node (V8, not workerd): size, instantiate time,
// and time and linear memory for encoding 8 batches of 1 MiB and selecting from the result.
//   ./build.sh && node tools/measure.mjs
// The same workload runs inside workerd in test/measure.test.ts.
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { createEngine } from '../js/index.ts'
import { bigBatch } from '../test/vzb1.ts'

const bytes = readFileSync(new URL('../js/viz_engine.wasm', import.meta.url))
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
const time = (f) => {
  const s = performance.now()
  const r = f()
  return [r, performance.now() - s]
}

const compile = []
const instantiate = []
let module
for (let i = 0; i < 15; i++) {
  const [m, c] = time(() => new WebAssembly.Module(bytes))
  module = m
  compile.push(c)
  instantiate.push(time(() => new WebAssembly.Instance(m, {}))[1])
}

const T = Date.UTC(2026, 10, 18, 12)
const batches = []
let t = T
for (let i = 0; i < 8; i++) {
  const b = bigBatch(2000, 1 << 20, t, 1000)
  batches.push(b)
  t = b.lastTs + 1000
}
const rows = batches.reduce((a, b) => a + b.rows, 0)
const enc = []
const sel = []
let encMem = 0
let selMem = 0
let files
let out
for (let i = 0; i < 7; i++) {
  const engine = createEngine(module) // a fresh instance each time, so memory is this call's peak
  let ms
  ;[files, ms] = time(() => engine.encodeSegment(batches.map((b) => b.bytes)))
  enc.push(ms)
  encMem = Math.max(encMem, engine.memoryBytes())
  const reader = createEngine(module)
  const input = { seriesFiles: [files[1].bytes], sampleFiles: [files[0].bytes], tailBatches: [] }
  ;[out, ms] = time(() => reader.select(input, [{ name: '__name__', op: '=', value: 'http_requests_total_7' }], 0, 253402300799999))
  sel.push(ms)
  selMem = Math.max(selMem, reader.memoryBytes())
}
const all = createEngine(module)
const [everything, allMs] = time(() => all.select({ seriesFiles: [files[1].bytes], sampleFiles: [files[0].bytes], tailBatches: [] }, [], 0, 253402300799999))

console.log(JSON.stringify({
  where: `node ${process.version} (local, not workerd, not Cloudflare)`,
  wasm_bytes: bytes.length,
  wasm_gzip9_bytes: gzipSync(bytes, { level: 9 }).length,
  compile_ms_median: +median(compile).toFixed(2),
  instantiate_ms_median: +median(instantiate).toFixed(3),
  encode: { batches: 8, batch_bytes: batches.map((b) => b.bytes.length), rows, parquet_bytes: files.map((f) => f.bytes.length), ms_median: +median(enc).toFixed(1), ms_min: +Math.min(...enc).toFixed(1), peak_wasm_memory_mb: +(encMem / 1048576).toFixed(1) },
  select_one_metric: { series: out.length, samples: out.reduce((a, s) => a + s.ts.length, 0), ms_median: +median(sel).toFixed(1), peak_wasm_memory_mb: +(selMem / 1048576).toFixed(1) },
  select_everything: { series: everything.length, samples: everything.reduce((a, s) => a + s.ts.length, 0), ms: +allMs.toFixed(1), peak_wasm_memory_mb: +(all.memoryBytes() / 1048576).toFixed(1) },
}, null, 1))
