// Stage 2 of traces and logs, end to end through the engines (stack/README.md, "Traces and logs
// end to end"):
//
//   node tools/signals_readback.mjs WORK [seed] [scale]
//
// 1. edge/scripts/otel-corpus.mjs writes an OTLP corpus to WORK/corpus with `--requests`: the
//    requests (protobufjs- and JSON-encoded traces and logs, Loki push), the batches edge's own
//    decoders make of them, and the expected logical rows computed from the generator's model;
// 2. the stack test `test/signals.test.ts` (corpus mode) posts every request through edge in
//    workerd, lets the shards of `{pool}/traces` and `{pool}/logs` seal, flushes them, drains the
//    ledger, and prints the ledger's live `spans`, `trace_index` and `logs` files; written here to
//    WORK/export with a manifest (table, day, hour, flush unit, the ledger's precedence order);
// 3. tools/signals-readback (Rust) reads them back with viz-storage's readers and through
//    viz-traceql's and viz-logql's read seams, and requires the rows and every query answer to
//    equal the expected rows and the engines' in-memory answers (exit status 1 otherwise);
// 4. engine/storage/tools/otel_independent_check.py reads the same export with PyArrow and DuckDB
//    when python3 has both (skipped, and said so, otherwise).
//
// Builds with `cargo -j 2` into tools/signals-readback/target, which it deletes at the end
// unless KEEP_TARGET=1.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const stack = join(here, '..')
const WORK = process.argv[2] && resolve(process.argv[2])
if (!WORK) {
  console.error('usage: node tools/signals_readback.mjs WORK [seed] [scale]')
  process.exit(2)
}
const SEED = process.argv[3] ?? '1'
const SCALE = process.argv[4] ?? '1'
const corpus = join(WORK, 'corpus')
const exp = join(WORK, 'export')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(join(exp, 'files'), { recursive: true })

const t0 = Date.now()
const summary = execFileSync('node', [join(stack, '../edge/scripts/otel-corpus.mjs'), corpus, SEED, SCALE, '--requests'], { cwd: join(stack, '../edge'), encoding: 'utf8' })
console.log(`corpus: ${summary.trim()} (${((Date.now() - t0) / 1000).toFixed(1)} s)`)

const t1 = Date.now()
const run = spawnSync('npx', ['vitest', 'run', '--maxWorkers=1', 'test/signals.test.ts', '-t', 'corpus', '--reporter=verbose'], {
  cwd: stack, encoding: 'utf8', maxBuffer: 1 << 30, env: { ...process.env, SIGNALS_CORPUS: corpus, NO_COLOR: '1' },
})
const out = `${run.stdout}\n${run.stderr}`
if (run.status !== 0 || !out.includes('SIGNALS_EXPORT_END')) {
  console.error(out.slice(-20_000))
  console.error('the stack test failed or did not export')
  process.exit(2)
}
console.log(`stack: ${((Date.now() - t1) / 1000).toFixed(1)} s`)
const files = new Map()
const parts = new Map()
for (const line of out.split('\n')) {
  if (line.startsWith('SIGNALS_EXPORT_SUMMARY ')) console.log(`stack: ${line.slice('SIGNALS_EXPORT_SUMMARY '.length)}`)
  else if (line.startsWith('SIGNALS_EXPORT_FILE ')) {
    const f = JSON.parse(line.slice('SIGNALS_EXPORT_FILE '.length))
    files.set(f.i, f)
  } else if (line.startsWith('SIGNALS_EXPORT_PART ')) {
    const [, i, part, data] = line.split(' ')
    if (!parts.has(Number(i))) parts.set(Number(i), [])
    parts.get(Number(i))[Number(part)] = data
  }
}
const manifest = []
// Units ranked by the ledger version that admitted them (precedence / PRECEDENCE_PER_VERSION):
// the later unit wins a duplicate row, in the Rust read-back and in the PyArrow check alike.
const unitKeys = [...new Set([...files.values()].map((f) => JSON.stringify([f.order, f.unit])))].sort((a, b) => JSON.parse(a)[0] - JSON.parse(b)[0])
const rank = new Map(unitKeys.map((k, i) => [k, i]))
for (const [i, f] of [...files].sort((a, b) => a[0] - b[0])) {
  const p = parts.get(i) ?? []
  if (p.length !== f.parts || p.some((x) => x === undefined)) throw new Error(`file ${i}: ${p.length} of ${f.parts} parts`)
  const bytes = Buffer.from(p.join(''), 'base64')
  if (bytes.length !== f.bytes) throw new Error(`file ${i}: ${bytes.length} bytes, the ledger lists ${f.bytes}`)
  const path = `files/${String(i).padStart(4, '0')}-${f.table}.parquet`
  writeFileSync(join(exp, path), bytes)
  manifest.push({ path, key: f.key, table: f.table, day: f.day, hour: f.hour, rows: f.rows, index: f.index, unit: rank.get(JSON.stringify([f.order, f.unit])), stream_unit: f.unit, ledger_version: f.order })
}
writeFileSync(join(exp, 'manifest.json'), JSON.stringify(manifest, null, 1))
copyFileSync(join(corpus, 'expected', 'spans.jsonl'), join(exp, 'spans.jsonl'))
copyFileSync(join(corpus, 'expected', 'logs.jsonl'), join(exp, 'logs.jsonl'))
console.log(`export: ${manifest.length} files, ${unitKeys.length} units`)

const crate = join(here, 'signals-readback')
const target = join(crate, 'target')
const t2 = Date.now()
const rust = spawnSync('cargo', ['run', '--release', '-j', '2', '--quiet', '--', corpus, exp], { cwd: crate, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, CARGO_TARGET_DIR: target } })
console.log(rust.stdout.trim())
if (rust.stderr.trim()) console.error(rust.stderr.trim().split('\n').slice(-20).join('\n'))
console.log(`read-back: ${((Date.now() - t2) / 1000).toFixed(1)} s (build included)`)
if (process.env.KEEP_TARGET !== '1') rmSync(target, { recursive: true, force: true })

// 4. PyArrow and DuckDB (engine/storage/tools/otel_independent_check.py, which reads this
//    export as it reads readback's): every file and column, the fragments, the logical rows.
const py = spawnSync('python3', [join(stack, '../engine/storage/tools/otel_independent_check.py'), exp], { encoding: 'utf8', maxBuffer: 1 << 28 })
if (py.error || /No module named/.test(py.stderr)) console.log(`pyarrow/duckdb: not run (${(py.error?.message ?? py.stderr).trim().split('\n').pop()})`)
else {
  console.log(`pyarrow/duckdb: ${py.stdout.trim().split('\n').slice(-3).join(' | ')}`)
  if (py.status !== 0) console.error(py.stderr.trim().split('\n').slice(-10).join('\n'))
}
process.exit(rust.status !== 0 ? (rust.status ?? 2) : py.error || /No module named/.test(py.stderr) ? 0 : (py.status ?? 2))
