// Smoke test of the wasm32-unknown-unknown build: load the size-probe module, flush the
// batches written by `cargo test --test export`, compact, select with a regex matcher over
// lake + tail, and compare with the counts the native test computed from its input rows.
//
//   cargo test --test export
//   (cd wasm-probe && cargo build --release --target wasm32-unknown-unknown)
//   node tools/wasm_smoke.mjs [path/to/viz_storage_wasm_probe.wasm]
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const wasmPath = process.argv[2] ?? join(here, '../target/wasm32-unknown-unknown/release/viz_storage_wasm_probe.wasm')
const dir = join(here, '../target/hyparquet-check')
const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')).wasm
const batches = readFileSync(join(dir, 'batches.bin'))

const t0 = performance.now()
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {})
const x = instance.exports
const tInst = performance.now() - t0

const put = (bytes) => {
  const p = x.alloc(bytes.length)
  new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes)
  return p
}
const median = (f, n = 5) => {
  const t = []
  let r
  for (let i = 0; i < n; i++) {
    const s = performance.now()
    r = f()
    t.push(performance.now() - s)
  }
  return [r, t.sort((a, b) => a - b)[n >> 1]]
}
const bp = put(batches)
const re = new TextEncoder().encode(expected.regex)
const rp = put(re)

const [parquetBytes, tEncode] = median(() => x.probe_encode(bp, batches.length))
const [selected, tRound] = median(() => x.probe_roundtrip(bp, batches.length, rp, re.length, -(2n ** 63n), 2n ** 63n - 1n))

let ok = true
const check = (what, got, want) => {
  const good = String(got) === String(want)
  ok &&= good
  console.log(`${good ? 'ok  ' : 'FAIL'} ${what}: wasm=${got} native=${want}`)
}
check('parquet bytes produced by encode_segment', parquetBytes, expected.parquet_bytes)
check(`samples selected by {__name__=~"${expected.regex}"} after flush + merge + select(lake+tail)`, selected, expected.selected)
console.log(`info instantiate ${tInst.toFixed(1)} ms; encode_segment of ${(batches.length / 1e6).toFixed(1)} MB of batches ${tEncode.toFixed(0)} ms (median of 5); flush+merge+select ${tRound.toFixed(0)} ms; wasm memory ${(x.memory.buffer.byteLength / 1e6).toFixed(0)} MB`)
process.exit(ok ? 0 : 1)
