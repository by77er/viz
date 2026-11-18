// Independent reader, in Node: take one Parquet file that the end-to-end test produced
// (senders → edge → shard → flush → R2), read it with hyparquet (pure JavaScript, shares no
// code with viz or with the Rust `parquet` crate) and compare row count and a checksum
// with what the SHARD held for that segment (its batches, read through the tail path).
//
//   node tools/hyparquet_check.mjs
//
// The test prints the file (base64) and the expected numbers; this script runs it and reads them.
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { parquetMetadata, parquetReadObjects } = await import(join(here, '../../bench/node_modules/hyparquet/src/index.js'))

let out
try {
  out = execSync("npx vitest run test/e2e.test.ts -t 'independent Parquet reader' --reporter=verbose 2>&1", { cwd: join(here, '..'), stdio: 'pipe', maxBuffer: 1 << 28, env: { ...process.env, NO_COLOR: '1' } }).toString()
} catch (e) {
  console.error(String(e.stdout) + String(e.stderr))
  process.exit(2)
}
const line = out.split('\n').find((l) => l.startsWith('HYPARQUET_EXPORT '))
if (!line) {
  console.error('the test did not print HYPARQUET_EXPORT')
  process.exit(2)
}
const exp = JSON.parse(line.slice('HYPARQUET_EXPORT '.length))
const buf = Buffer.from(exp.parquet_base64, 'base64')
const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

const md = parquetMetadata(file)
const rows = await parquetReadObjects({ file })
const M = (1n << 64n) - 1n
let ts = 0n
let sorted = true
for (let i = 0; i < rows.length; i++) {
  ts = (ts + BigInt(rows[i].ts)) & M
  if (i > 0) {
    const p = rows[i - 1]
    const r = rows[i]
    const c = Buffer.compare(Buffer.from(p.metric_name), Buffer.from(r.metric_name))
    if (c > 0 || (c === 0 && (p.series_id > r.series_id || (p.series_id === r.series_id && p.ts >= r.ts)))) sorted = false
  }
}
let failures = 0
const check = (what, got, want) => {
  const ok = String(got) === String(want)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: hyparquet=${got} expected=${want}`)
}
console.log(`file ${exp.key} (${buf.length} bytes, written by ${md.created_by})`)
check('row count (footer) vs ledger FileEntry.rows', md.num_rows, exp.rows)
check('row count (decoded) vs rows in the shard segment', rows.length, exp.segment_rows)
check('wrapping sum of ts vs the shard segment', ts, exp.ts_sum)
check('sorted by (metric_name, series_id, ts), unique', sorted, true)
process.exit(failures === 0 ? 0 : 1)
