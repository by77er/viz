// Peak linear memory and time of `mergeFiles` (compaction) in Node, for inputs shaped like
// real flush files: values that do not compress (random doubles), jittered timestamps.
//   ./build.sh && node tools/measure_merge.mjs [inputs,rowsPerInput ...]
// A fresh engine instance per merge, so `memoryBytes()` is that merge's peak.
import { readFileSync } from 'node:fs'
import { createEngine } from '../js/index.ts'
import { encodeBatch } from '../test/vzb1.ts'

const module = new WebAssembly.Module(readFileSync(new URL('../js/viz_engine.wasm', import.meta.url)))
const T = Date.UTC(2026, 10, 18, 0)
let seed = 0x2545f491
const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) | 0) >>> 0)
const f64 = new Float64Array(1)
const u64 = new BigUint64Array(f64.buffer)
const bits = (x) => ((f64[0] = x), u64[0])

/** One flush file pair: `rows` samples of `nSeries` series, in batches of at most 1 MiB. */
function flushFile(engine, k, rows, nSeries) {
  const series = Array.from({ length: nSeries }, (_, i) => ({ __name__: `http_request_duration_seconds_${i % 20}`, job: 'api', instance: `10.0.${(i >> 8) & 255}.${i & 255}:9100`, path: `/v1/items/${i}` }))
  const batches = []
  const per = 40_000
  for (let at = 0; at < rows; at += per) {
    const n = Math.min(per, rows - at)
    const r = Array.from({ length: n }, (_, j) => {
      const row = at + j
      // Scrape `row / nSeries` of series `row % nSeries`, 15 s apart, each input continuing where the last stopped.
      return { series: row % nSeries, ts: T + (k * Math.ceil(rows / nSeries) + Math.floor(row / nSeries)) * 15_000 + (rnd() % 900), bits: bits(rnd() / 7 + rnd() * 4294967296) }
    })
    batches.push(encodeBatch(series, r))
  }
  const files = engine.encodeSegment(batches)
  if (files.length !== 2) throw new Error(`expected one day, got ${files.length} files`)
  return { samples: files[0], series: files[1] }
}

const configs = process.argv.slice(2).map((a) => a.split(',').map(Number))
if (configs.length === 0) configs.push([4, 200_000], [8, 200_000], [16, 200_000], [32, 200_000], [4, 1_000_000], [8, 1_000_000], [2, 4_000_000])
const mb = (n) => +(n / 1048576).toFixed(1)
console.log('| inputs | rows in | input MB (samples) | output MB | rows out | peak WASM MB (samples merge) | ms | peak WASM MB (series merge) |')
console.log('|---|---|---|---|---|---|---|---|')
for (const [n, rows] of configs) {
  const maker = createEngine(module)
  const inputs = Array.from({ length: n }, (_, k) => flushFile(maker, k, rows, 2000))
  maker.reset()
  const inBytes = inputs.reduce((a, f) => a + f.samples.bytes.byteLength, 0)
  const e = createEngine(module)
  const s = performance.now()
  const out = e.mergeFiles('metric_samples', inputs.map((f) => f.samples.bytes))
  const ms = performance.now() - s
  const e2 = createEngine(module)
  e2.mergeFiles('metric_series', inputs.map((f) => f.series.bytes))
  console.log(`| ${n} | ${n * rows} | ${mb(inBytes)} | ${mb(out.bytes.byteLength)} | ${out.rows} | ${mb(e.memoryBytes())} | ${ms.toFixed(0)} | ${mb(e2.memoryBytes())} |`)
}
