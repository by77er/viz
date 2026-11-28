// Real `spans`, `trace_index` and `logs` files for the publisher's tests, made by viz's REAL write
// path from an OTLP corpus (the corpus of stack/test, the one stack/README.md "Traces and logs end to
// end" reads back through the engines):
//
//   node tools/signal_fixture.mjs WORK [seed] [scale] [maxUnits]
//
// 1. edge/scripts/otel-corpus.mjs writes an OTLP corpus to WORK/corpus (`--requests`: the requests
//    as sent, edge's own batches of them, and the expected logical rows);
// 2. the corpus mode of stack/test/signals.test.ts posts every request through edge in workerd,
//    lets the shards of `{pool}/traces` and `{pool}/logs` seal at 256 KiB, flushes them (engine/wasm,
//    ABI 3) and prints the ledger's live files; nothing in stack/ is changed, it is only run;
// 3. this writes test/fixtures/signals.json: the flush units in the ledger's precedence order (the
//    ledger version that admitted each), each with its files (table, day, hour, rows, bytes, minTs,
//    maxTs, index fragment, the Parquet bytes in base64). The keys are not kept: the publisher's
//    tests re-key the files under their own tenants and streams (the key layout is the contract's).
//
// With `maxUnits`, only the first that many units of each signal (traces, logs) are kept, so the
// fixture stays small. Deterministic for a seed only up to how segments seal (stack/README.md).
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const publisher = join(here, '..')
const repo = join(publisher, '..')
const WORK = process.argv[2] && resolve(process.argv[2])
if (!WORK) {
  console.error('usage: node tools/signal_fixture.mjs WORK [seed] [scale] [maxUnits]')
  process.exit(2)
}
const SEED = process.argv[3] ?? '1'
const SCALE = process.argv[4] ?? '1'
const MAX_UNITS = Number(process.argv[5] ?? 1e9)
const OUT = process.env.SIGNAL_FIXTURE_OUT ?? join(publisher, 'test', 'fixtures', 'signals.json')
const corpus = join(WORK, 'corpus')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

const t0 = Date.now()
const summary = execFileSync('node', [join(repo, 'edge/scripts/otel-corpus.mjs'), corpus, SEED, SCALE, '--requests'], { cwd: join(repo, 'edge'), encoding: 'utf8' })
console.log(`corpus: ${summary.trim()} (${((Date.now() - t0) / 1000).toFixed(1)} s)`)

const t1 = Date.now()
const run = spawnSync('npx', ['vitest', 'run', '--maxWorkers=1', 'test/signals.test.ts', '-t', 'corpus', '--reporter=verbose'], {
  cwd: join(repo, 'stack'), encoding: 'utf8', maxBuffer: 1 << 30, env: { ...process.env, SIGNALS_CORPUS: corpus, NO_COLOR: '1' },
})
const out = `${run.stdout}\n${run.stderr}`
writeFileSync(join(WORK, 'stack.log'), out)
if (run.status !== 0 || !out.includes('SIGNALS_EXPORT_END')) {
  console.error(out.slice(-20_000))
  console.error('the stack test failed or did not export')
  process.exit(2)
}
console.log(`stack: ${((Date.now() - t1) / 1000).toFixed(1)} s`)
const files = new Map()
const parts = new Map()
let stackSummary = null
for (const line of out.split('\n')) {
  if (line.startsWith('SIGNALS_EXPORT_SUMMARY ')) stackSummary = JSON.parse(line.slice('SIGNALS_EXPORT_SUMMARY '.length))
  else if (line.startsWith('SIGNALS_EXPORT_FILE ')) {
    const f = JSON.parse(line.slice('SIGNALS_EXPORT_FILE '.length))
    files.set(f.i, f)
  } else if (line.startsWith('SIGNALS_EXPORT_PART ')) {
    const [, i, part, data] = line.split(' ')
    if (!parts.has(Number(i))) parts.set(Number(i), [])
    parts.get(Number(i))[Number(part)] = data
  }
}
// Units by the ledger version that admitted them: the later unit wins a duplicate row.
const units = new Map()
for (const [i, f] of [...files].sort((a, b) => a[0] - b[0])) {
  const p = parts.get(i) ?? []
  if (p.length !== f.parts || p.some((x) => x === undefined)) throw new Error(`file ${i}: ${p.length} of ${f.parts} parts`)
  const b64 = p.join('')
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length !== f.bytes) throw new Error(`file ${i}: ${bytes.length} bytes, the ledger lists ${f.bytes}`)
  const id = `${f.order}:${f.unit}`
  if (!units.has(id)) units.set(id, { order: f.order, signal: f.table === 'logs' ? 'logs' : 'traces', files: [] })
  units.get(id).files.push({ table: f.table, day: f.day, hour: f.hour, rows: f.rows, bytes: f.bytes, minTs: f.minTs, maxTs: f.maxTs, index: f.index, sha256: createHash('sha256').update(bytes).digest('hex'), b64 })
}
const ordered = [...units.values()].sort((a, b) => a.order - b.order)
const kept = []
const count = { traces: 0, logs: 0 }
for (const u of ordered) {
  if (count[u.signal] >= MAX_UNITS) continue
  count[u.signal]++
  // Files of a unit in the order the flush wrote them: spans by hour, then trace_index by day; logs by day.
  u.files.sort((a, b) => (a.table === b.table ? (a.day < b.day ? -1 : a.day > b.day ? 1 : (a.hour ?? 0) - (b.hour ?? 0)) : a.table === 'spans' ? -1 : 1))
  kept.push({ signal: u.signal, files: u.files })
}
const fixture = {
  made: 'tools/signal_fixture.mjs',
  seed: Number(SEED),
  scale: Number(SCALE),
  maxUnits: MAX_UNITS === 1e9 ? null : MAX_UNITS,
  stack: stackSummary,
  units: kept,
}
writeFileSync(OUT, JSON.stringify(fixture))
const n = kept.reduce((a, u) => a + u.files.length, 0)
const bytes = kept.reduce((a, u) => a + u.files.reduce((b, f) => b + f.bytes, 0), 0)
console.log(`fixture: ${OUT}: ${kept.length} units (${count.traces} traces, ${count.logs} logs), ${n} files, ${bytes} bytes of Parquet`)
