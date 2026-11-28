// Peak linear memory and time of `mergeSignalFiles` (compaction of spans, trace_index and logs)
// in Node, over flush files written by engine/storage's merge benchmark:
//
//   (cd ../storage && cargo run --release --example otel_bench -- merge 8 25000 1 DIR)
//   ./build.sh && node tools/measure_signal_merge.mjs DIR [counts...]
//
// For each table and each input count (default 2, 4, 8: the largest step compaction allows is
// 8 inputs and 16 MB), a fresh engine instance per merge, so `memoryBytes()` is that merge's
// peak (linear memory only grows). Times are wall time of the call in Node, one run each.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createEngine } from '../js/index.ts'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node tools/measure_signal_merge.mjs DIR [counts...]')
  process.exit(2)
}
const counts = process.argv.slice(3).map(Number)
if (counts.length === 0) counts.push(2, 4, 8)
const module = new WebAssembly.Module(readFileSync(new URL('../js/viz_engine.wasm', import.meta.url)))
const mb = (n) => +(n / 1048576).toFixed(1)
console.log('| table | inputs | input MB | rows out | output MB | peak WASM MB | ms |')
console.log('|---|---|---|---|---|---|---|')
for (const table of ['spans', 'trace_index', 'logs']) {
  const files = readdirSync(dir).filter((f) => f.startsWith(`${table}-`)).sort().map((f) => new Uint8Array(readFileSync(join(dir, f))))
  for (const n of counts) {
    if (n > files.length) continue
    const inputs = files.slice(0, n)
    const e = createEngine(module)
    const s = performance.now()
    const out = e.mergeSignalFiles(table, inputs)
    const ms = performance.now() - s
    console.log(`| ${table} | ${n} | ${mb(inputs.reduce((a, f) => a + f.byteLength, 0))} | ${out.rows} | ${mb(out.bytes.byteLength)} | ${mb(e.memoryBytes())} | ${ms.toFixed(0)} |`)
  }
}
