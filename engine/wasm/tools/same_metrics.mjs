// Metrics must stay byte-identical across an ABI change (ABI 3 added the span and log
// encoders): this runs the same metric workload through an OLD build of this directory (its
// binding and its module) and through this one, in Node, and requires identical bytes.
//
//   node tools/same_metrics.mjs OLD_DIR      # OLD_DIR holds js/index.ts and js/viz_engine.wasm of the old build
//
// Workload: 8 batches of 1 MiB (2,000 series), a scrape batch with duplicates and a staleness
// marker, two overlapping segments; encodeSegment, mergeFiles of both tables, and select (all,
// one metric, a regex) over lake + tail. Compared: every file's bytes, table, day, rows, times
// and index fragment; every selected series' labels, timestamps and value bits.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createEngine } from '../js/index.ts'
import { STALE_NAN, bigBatch, encodeBatch, scrapeBatch } from '../test/vzb1.ts'

const oldDir = process.argv[2]
if (!oldDir) {
  console.error('usage: node tools/same_metrics.mjs OLD_DIR')
  process.exit(2)
}
const old = await import(pathToFileURL(resolve(oldDir, 'js/index.ts')).href)
const oldEngine = old.createEngine(new WebAssembly.Module(readFileSync(join(oldDir, 'js/viz_engine.wasm'))))
const newEngine = createEngine(new WebAssembly.Module(readFileSync(new URL('../js/viz_engine.wasm', import.meta.url))))

const T = Date.UTC(2026, 10, 18, 23)
const segA = []
let t = T
for (let i = 0; i < 8; i++) {
  const b = bigBatch(2000, 1 << 20, t, 1000)
  segA.push(b.bytes)
  t = b.lastTs + 1000
}
const up = { __name__: 'up', job: 'api', instance: 'a:1' }
const segB = [
  scrapeBatch(300, T + 3_000_000, 15_000, 40, 7),
  encodeBatch([up], [{ series: 0, ts: T, bits: 1n }, { series: 0, ts: T, bits: STALE_NAN }, { series: 0, ts: T + 3_600_000, bits: 0x7ff8000000000001n }]),
]

let checks = 0
let failures = 0
const same = (what, a, b) => {
  checks++
  const eq = a instanceof Uint8Array ? a.length === b.length && a.every((x, i) => x === b[i]) : JSON.stringify(a) === JSON.stringify(b)
  if (!eq) {
    failures++
    console.log(`DIFFERENT ${what}`)
  }
}
const files = (e, seg) => e.encodeSegment(seg)
const fa = [files(oldEngine, segA), files(newEngine, segA)]
const fb = [files(oldEngine, segB), files(newEngine, segB)]
for (const [name, [o, n]] of [['segment A', fa], ['segment B', fb]]) {
  same(`${name}: file count`, o.length, n.length)
  o.forEach((f, i) => {
    same(`${name} file ${i}: bytes`, f.bytes, n[i].bytes)
    same(`${name} file ${i}: fields`, { ...f, bytes: 0 }, { ...n[i], bytes: 0 })
  })
}
for (const table of ['metric_samples', 'metric_series']) {
  const pick = (fs) => fs.filter((f) => f.table === table && f.day === '2026-11-18').map((f) => f.bytes)
  const [o, n] = [oldEngine.mergeFiles(table, [...pick(fa[0]), ...pick(fb[0])]), newEngine.mergeFiles(table, [...pick(fa[1]), ...pick(fb[1])])]
  same(`merge ${table}: bytes`, o.bytes, n.bytes)
  same(`merge ${table}: fields`, { ...o, bytes: 0 }, { ...n, bytes: 0 })
}
const bits = (out) => out.map((s) => ({ labels: s.labels, ts: Array.from(s.ts), v: Buffer.from(s.values.buffer).toString('hex') }))
const input = (fs) => ({ seriesFiles: fs.filter((f) => f.table === 'metric_series').map((f) => f.bytes), sampleFiles: fs.filter((f) => f.table === 'metric_samples').map((f) => f.bytes), tailBatches: segB })
for (const [what, m] of [['everything', []], ['one metric', [{ name: '__name__', op: '=', value: 'http_requests_total_7' }]], ['a regex', [{ name: 'instance', op: '=~', value: '10\\.0\\.0\\..*' }]]]) {
  same(`select ${what}`, bits(oldEngine.select(input(fa[0]), m, 0, 253402300799999)), bits(newEngine.select(input(fa[1]), m, 0, 253402300799999)))
}
console.log(JSON.stringify({ checks, failures, files: fa[1].length + fb[1].length, bytes: [...fa[1], ...fb[1]].reduce((a, f) => a + f.bytes.length, 0) }))
process.exit(failures === 0 ? 0 : 1)
