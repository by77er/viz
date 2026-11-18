// Independent validation: read the Parquet files written by `cargo test --test export`
// with hyparquet (a pure-JavaScript Parquet reader that shares no code with the Rust
// `parquet` crate) and compare row counts and checksums with what the Rust test computed
// from its own input rows.
//
//   cargo test --test export && node tools/hyparquet_check.mjs
//
// Exits 0 if everything agrees, 1 otherwise.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { parquetMetadata, parquetReadObjects } = await import(join(here, '../../../bench/node_modules/hyparquet/src/index.js'))
const dir = process.argv[2] ?? join(here, '../target/hyparquet-check')

const load = (name) => {
  const b = readFileSync(join(dir, name))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}
const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'))
const M = (1n << 64n) - 1n
const enc = new TextEncoder()
const f64 = new Float64Array(1)
const u64 = new BigUint64Array(f64.buffer)

let failures = 0
const check = (what, got, want) => {
  const ok = String(got) === String(want)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: hyparquet=${got} rust=${want}`)
}

// ---- metric_samples ----
{
  const file = load('metric_samples.parquet')
  const md = parquetMetadata(file)
  const rows = await parquetReadObjects({ file })
  let sid = 0n, ts = 0n, xor = 0n, nans = 0, stale = 0, quieted = 0, nameBytes = 0, sorted = true
  let prev = null
  for (const r of rows) {
    sid = (sid + BigInt.asUintN(64, r.series_id)) & M
    ts = (ts + BigInt.asUintN(64, r.ts)) & M
    nameBytes += enc.encode(r.metric_name).length
    f64[0] = r.value
    if (Number.isNaN(r.value)) {
      nans++
      if (u64[0] === 0x7ff0000000000002n) stale++
      if (u64[0] === 0x7ff8000000000002n) quieted++
    } else {
      xor ^= u64[0]
    }
    if (prev) {
      const a = Buffer.from(prev.metric_name), b = Buffer.from(r.metric_name)
      const c = Buffer.compare(a, b)
      if (c > 0 || (c === 0 && (prev.series_id > r.series_id || (prev.series_id === r.series_id && prev.ts >= r.ts)))) sorted = false
    }
    prev = r
  }
  const e = expected.samples
  check('samples rows', rows.length, e.rows)
  check('samples footer num_rows', md.num_rows, e.rows)
  check('samples row groups', md.row_groups.length, e.row_groups)
  check('samples series_id sum', sid, e.series_id_sum)
  check('samples ts sum', ts, e.ts_sum)
  check('samples value xor (non-NaN)', xor.toString(16).padStart(16, '0'), e.value_xor)
  check('samples NaN count', nans, e.nan_count)
  check('samples metric_name bytes', nameBytes, e.name_bytes)
  check('samples first metric_name', rows[0].metric_name, e.first_name)
  check('samples first ts', rows[0].ts, e.first_ts)
  check('samples sorted by (metric_name, series_id, ts), unique', sorted, true)
  // JavaScript numbers may canonicalise NaN payloads, so this one is reported, not enforced.
  console.log(`info staleness markers (0x7ff0000000000002) of ${e.stale_count} written: ${stale} seen bit-exact through JS numbers, ${quieted} seen quieted to 0x7ff8000000000002`)
  const encodings = md.row_groups[0].columns.map((c) => `${c.meta_data.path_in_schema.join('.')}=${c.meta_data.encodings.join('+')}/${c.meta_data.codec}`)
  console.log(`info encodings: ${encodings.join(' ')}`)
}

// ---- metric_series ----
{
  const file = load('metric_series.parquet')
  const rows = await parquetReadObjects({ file })
  let sid = 0n, labelBytes = 0, consistent = true
  for (const r of rows) {
    sid = (sid + BigInt.asUintN(64, r.series_id)) & M
    labelBytes += enc.encode(r.labels).length
    const l = JSON.parse(r.labels)
    if (l.__name__ !== r.metric_name || r.min_ts > r.max_ts) consistent = false
    if (JSON.stringify(Object.fromEntries(Object.entries(l).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))))) !== r.labels) consistent = false
  }
  const e = expected.series
  check('series rows', rows.length, e.rows)
  check('series series_id sum', sid, e.series_id_sum)
  check('series labels bytes', labelBytes, e.label_bytes)
  check('series labels parse as canonical JSON and agree with metric_name', consistent, true)
}

console.log(failures === 0 ? 'AGREE: hyparquet reads the files and matches every checksum' : `DISAGREE: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
