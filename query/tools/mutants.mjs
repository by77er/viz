#!/usr/bin/env node
/**
 * Mutation check for the read path: break one safety property in the source at a time,
 * run the test suite, restore the source, and report which tests failed.
 *
 *   node tools/mutants.mjs            all mutants
 *   node tools/mutants.mjs 3 7        only mutants 3 and 7
 *   VIZ_MUTANTS_DIR=<dir> node …      where to build the scratch tree (default: a new temp dir)
 *
 * NOTHING IN THE SHARED TREE IS EVER WRITTEN (AGENTS.md, "Tests must have teeth": others
 * commit and snapshot the tree while this runs, and a mutant applied in place once reached
 * a pull request). The tool builds a scratch tree first: copies of `query/`,
 * `engine/query` and `engine/wasm-query` (the directories mutants touch and the module a
 * Rust mutant rebuilds), and symbolic links to everything else (other components,
 * `query/node_modules`), so relative imports resolve as in the real tree. Mutants are
 * applied to the copies and the suite runs there. At the end the files a mutant would
 * touch are hashed in the shared tree and compared with their hashes at the start.
 *
 * For each mutant the test files named in its `tests` run first (the tests written for
 * that property). If they pass, the WHOLE suite runs before the mutant is called a
 * survivor. A mutant that no test catches is printed as SURVIVED and the script exits 1;
 * one that does not type-check is INVALID. `--all` runs the whole suite for every mutant.
 * Mutants in Rust rebuild the copy's WASM module (its `build.sh`) before and after.
 * The copy's source is restored even if the script is interrupted.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The shared tree: read, never written. */
const repo = join(dirname(fileURLToPath(import.meta.url)), '../..')
const COPIED = ['query', 'engine/query', 'engine/wasm-query']
const SKIP = /(^|\/)(node_modules|target|\.wrangler)(\/|$)/

/** A scratch tree: COPIED are copies, everything else is a link into the shared tree. */
function scratchTree(dir) {
  mkdirSync(join(dir, 'engine'), { recursive: true })
  for (const top of readdirSync(repo)) {
    if (top === '.git' || top === 'query' || top === 'engine') continue
    symlinkSync(join(repo, top), join(dir, top))
  }
  for (const e of readdirSync(join(repo, 'engine'))) {
    if (!COPIED.includes(`engine/${e}`)) symlinkSync(join(repo, 'engine', e), join(dir, 'engine', e))
  }
  for (const c of COPIED) cpSync(join(repo, c), join(dir, c), { recursive: true, filter: (src) => !SKIP.test(src.slice(join(repo, c).length)) })
  symlinkSync(join(repo, 'query/node_modules'), join(dir, 'query/node_modules'))
  return join(dir, 'query')
}

const scratch = process.env.VIZ_MUTANTS_DIR ? (mkdirSync(process.env.VIZ_MUTANTS_DIR, { recursive: true }), mkdtempSync(join(process.env.VIZ_MUTANTS_DIR, 'tree-'))) : mkdtempSync(join(tmpdir(), 'viz-query-mutants-'))
/** `query/` in the scratch tree: every write below goes here. */
const root = scratchTree(scratch)
const rel = (p) => join(root, p)
const shared = (p) => join(repo, 'query', p)
console.log(`scratch tree: ${scratch} (copies of ${COPIED.join(', ')}; links to the rest)`)

const MUTANTS = [
  {
    name: 'The tenant is taken from a header when one is sent',
    tests: ['test/isolation.test.ts'],
    file: 'src/index.ts',
    find: "const { tenant } = await authenticate(req, env.CONFIG, 'read')",
    replace: "const tenant = req.headers.get('X-Scope-OrgID') ?? (await authenticate(req, env.CONFIG, 'read')).tenant",
  },
  {
    name: 'The tenant is taken from a `tenant` parameter when one is sent',
    tests: ['test/isolation.test.ts'],
    file: 'src/index.ts',
    find: 'const c: Context = { env, engine, tenant, limits,',
    replace: "const c: Context = { env, engine, tenant: params.get('tenant') ?? tenant, limits,",
  },
  {
    name: 'The read-scope check is skipped (any valid key may query)',
    tests: ['test/http.test.ts'],
    file: 'src/index.ts',
    find: "await authenticate(req, env.CONFIG, 'read')",
    replace: "await authenticate(req, env.CONFIG, 'write').catch((e) => { if (e.status === 403) return authenticate(req, env.CONFIG, 'read'); throw e })",
  },
  {
    name: 'The tail is skipped (no shard is read: only the lake, for queries, split queries and the cardinality report)',
    tests: ['test/invariance.test.ts'],
    file: 'src/coordinator.ts',
    find: '  const stub = c.env.SHARD.get(c.env.SHARD.idFromName(shard))\n',
    replace: "  if (shard) return { status: 'ok', batches: [], bytes: 0 }\n  const stub = c.env.SHARD.get(c.env.SHARD.idFromName(shard))\n",
  },
  {
    name: '`stale_watermark` is ignored (the shard’s refusal is treated as an empty tail)',
    tests: ['test/fence.test.ts'],
    file: 'src/coordinator.ts',
    find: "if (r.status === 'stale_watermark') return { status: 'refused', why: `shard ${shard} has discarded rows above the watermark` }",
    replace: "if (r.status === 'stale_watermark') return { status: 'ok', batches: [], bytes: 0 }",
  },
  {
    name: 'Series files and sample files may come from different ledger versions',
    tests: ['test/fence.test.ts'],
    file: 'src/coordinator.ts',
    find: 'if (samples.version === series.version && samples.ledgerIncarnation === series.ledgerIncarnation) {',
    replace: 'if (samples.version >= 0) {',
  },
  {
    name: 'Only the first slot of the tenant’s pool map is asked for its tail',
    tests: ['test/invariance.test.ts'],
    file: 'src/coordinator.ts',
    find: 'const names = new Set(tenantSlots(map, c.tenant).map((slot) => shardName(map, slot)))',
    replace: 'const names = new Set(tenantSlots(map, c.tenant).slice(0, 1).map((slot) => shardName(map, slot)))',
  },
  {
    name: 'Name statistics unsound in the engine: a file whose largest name equals the wanted name is skipped (Rust; rebuilds the module)',
    tests: ['test/leaves.test.ts', 'test/invariance.test.ts'],
    file: '../engine/query/src/prune.rs',
    find: 'n.as_bytes() <= g.max_name.as_bytes())\n                    {',
    replace: 'n.as_bytes() < g.max_name.as_bytes())\n                    {',
    rust: true,
  },
  {
    name: 'Files are pruned against the first fetch range only',
    tests: ['test/leaves.test.ts'],
    file: 'src/coordinator.ts',
    find: 'const keep = c.engine.filesNeeded(listed.map((f) => f.index), ranges)',
    replace: 'const keep = c.engine.filesNeeded(listed.map((f) => f.index), ranges.slice(0, 1))',
  },
  {
    name: 'Sample files are read in key order (text order of sequence numbers), not in the ledger’s precedence order',
    tests: ['test/leaves.test.ts'],
    file: 'src/coordinator.ts',
    find: 'snap.samples = inPrecedenceOrder(snap.samples)',
    replace: 'snap.samples = [...snap.samples].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))',
  },
  {
    name: 'A leaf call may carry twelve R2 reads',
    tests: ['test/leaves.test.ts'],
    file: 'src/coordinator.ts',
    find: 'if (list.length < MAX_READS_PER_CALL && (list.length === 0 || used + p.bytes <= MAX_BYTES_PER_CALL)) {',
    replace: 'if (list.length < 2 * MAX_READS_PER_CALL && (list.length === 0 || used + p.bytes <= MAX_BYTES_PER_CALL)) {',
  },
  {
    name: 'The leaf does not refuse more than six reads',
    tests: ['test/leaves.test.ts', 'test/fence.test.ts'],
    file: 'src/leaf.ts',
    find: "if (items.length > MAX_READS_PER_CALL) return { status: 'refused', reason: `${items.length} reads in one call; the limit is ${MAX_READS_PER_CALL}` }",
    replace: '',
  },
  {
    name: 'A file is cached under a key without its content hash',
    tests: ['test/leaves.test.ts'],
    file: 'src/leaf.ts',
    find: "return `https://viz-file-cache.invalid/${item.key.split('/').map(encodeURIComponent).join('/')}${range}`",
    replace: "return `https://viz-file-cache.invalid/${item.key.replace(/-[0-9a-f]{8}\\.parquet$/, '.parquet').split('/').map(encodeURIComponent).join('/')}${range}`",
  },
  {
    name: 'A file is cached under its file name only (no tenant, no day)',
    tests: ['test/leaves.test.ts'],
    file: 'src/leaf.ts',
    find: "return `https://viz-file-cache.invalid/${item.key.split('/').map(encodeURIComponent).join('/')}${range}`",
    replace: "return `https://viz-file-cache.invalid/${encodeURIComponent(item.key.split('/').pop() ?? '')}${range}`",
  },
  {
    name: 'A missing data file is left out and the query answers from the rest (partial data)',
    tests: ['test/fence.test.ts'],
    file: 'src/coordinator.ts',
    find: '        refused(`file ${got.error.key}`, got.error.message)\n        again = true\n',
    replace: '',
  },
  {
    name: 'A leaf that fails twice contributes nothing and the query goes on (partial data)',
    tests: ['test/fence.test.ts'],
    file: 'src/coordinator.ts',
    find: "throw new ApiError('unavailable', `could not read data files: ${e instanceof Error ? e.message : String(e)}`)",
    replace: "results = items.map(() => ({ status: 'ok' as const, bytes: new Uint8Array(0), cached: false }))",
    alsoFind: "if (r.bytes.byteLength !== p.bytes) throw new ApiError('unavailable', `data file ${p.key}: read ${r.bytes.byteLength} bytes, expected ${p.bytes}`)",
    alsoReplace: '',
  },
  {
    name: '`step` is mis-parsed: a bare number is taken as milliseconds',
    tests: ['test/http.test.ts'],
    file: 'src/params.ts',
    find: 'const ms = decimalSecondsToMs(text) ?? Number(text) * 1000\n    if (!Number.isFinite(ms) || Math.abs(ms) > 9e15) throw err()',
    replace: 'const ms = Number(text)\n    if (!Number.isFinite(ms) || Math.abs(ms) > 9e15) throw err()',
  },
  {
    name: '`step` is mis-parsed: the `m` unit is taken as milliseconds',
    tests: ['test/http.test.ts'],
    file: 'src/params.ts',
    find: 'const UNIT_MS = [365 * 86_400_000, 7 * 86_400_000, 86_400_000, 3_600_000, 60_000, 1000, 1]',
    replace: 'const UNIT_MS = [365 * 86_400_000, 7 * 86_400_000, 86_400_000, 3_600_000, 1, 1000, 1]',
  },
  {
    name: 'Times are parsed as milliseconds, not seconds',
    tests: ['test/http.test.ts'],
    file: 'src/params.ts',
    find: 'let ms = Number(m[2]) * 1000 + Number(frac.slice(0, 3))',
    replace: 'let ms = Number(m[2])',
  },
  {
    name: 'The tenant’s limits are not passed to the engine (its defaults apply)',
    tests: ['test/limits.test.ts'],
    file: 'src/index.ts',
    find: 'const out = c.engine.queryRangeJson(input, query, start, end, step, c.limits)',
    replace: 'const out = c.engine.queryRangeJson(input, query, start, end, step)',
  },
  {
    name: 'max_fetch_bytes is not enforced',
    tests: ['test/limits.test.ts'],
    file: 'src/coordinator.ts',
    find: '  if (bytes > c.limits.maxFetchBytes) return tooMuch(c, `the ${files} data files in range`, bytes)\n',
    replace: '',
    alsoFind: "if (lakeBytes + tailBytes > c.limits.maxFetchBytes) throw tooMuch(c, 'the data files in range plus the unflushed tail', lakeBytes + tailBytes)",
    alsoReplace: '',
  },
  {
    name: 'max_scan_samples is not enforced',
    tests: ['test/limits.test.ts'],
    file: 'src/coordinator.ts',
    find: 'if (scan > c.limits.maxScanSamples) return',
    replace: 'if (scan > Infinity) return',
  },
  {
    name: 'The isolate’s byte budget is not enforced',
    tests: ['test/concurrency.test.ts'],
    file: 'src/coordinator.ts',
    find: "if (inFlightBytes > 0 && inFlightBytes + lakeBytes > (hooks.isolateBudgetBytes ?? ISOLATE_BUDGET_BYTES)) throw new ApiError('unavailable', 'the query service is busy; retry')",
    replace: '',
  },
  {
    name: 'CORS echoes any origin',
    tests: ['test/http.test.ts'],
    file: 'src/index.ts',
    find: 'if (origin && allowedOrigins(env).includes(origin)) {',
    replace: 'if (origin) {',
  },
  {
    name: 'The series files are not handed to the engine',
    tests: ['test/invariance.test.ts'],
    file: 'src/coordinator.ts',
    find: 'seriesFiles: all.slice(0, series.length), sampleFiles: all.slice(series.length), tailBatches }',
    replace: 'seriesFiles: [], sampleFiles: all.slice(series.length), tailBatches }',
  },
  {
    name: 'The refusal bound is ignored for one more attempt: after the retries are used up the query answers from what it has',
    tests: ['test/fence.test.ts'],
    file: 'src/coordinator.ts',
    // The closure of one-place `gather` (the cardinality report has its own).
    find: "    if (n > MAX_REFUSALS) throw new ApiError('unavailable', `${why}, and the ledger does not catch up; retry later`)\n  }\n  let reserved = 0\n",
    replace: '    if (n > MAX_REFUSALS) giveUp = true\n  }\n  let reserved = 0\n  let giveUp = false\n',
    alsoFind: '      if (again) continue\n\n      const tailBatches',
    alsoReplace: '      if (again && !giveUp) continue\n\n      const tailBatches',
  },
  // ── split execution and the cardinality report ──
  {
    name: 'Split by file instead of by series: each leaf reads some of the files and keeps every series in them',
    tests: ['test/split.test.ts'],
    file: 'src/leaf.ts',
    find: '        req.groups.map(async (g, gi) => {\n          const job: ExtractRequest = { series: g.series, samples: g.samples, without: req.without, part: req.part, parts: req.parts,',
    replace: '        req.groups.filter((_, gi) => gi % req.parts === req.part).map(async (g, gi) => {\n          const job: ExtractRequest = { series: g.series, samples: g.samples, without: req.without, part: 0, parts: 1,',
  },
  {
    name: 'The tail is evaluated apart from the lake: each leaf gets the tail rows of another leaf’s series',
    tests: ['test/split.test.ts'],
    file: 'src/coordinator.ts',
    find: 'ranges, groups, tails: parts[j]!,',
    replace: 'ranges, groups, tails: parts[(j + 1) % L]!,',
  },
  {
    name: 'A leaf’s partial result is merged twice when a leaf was retried',
    tests: ['test/split.test.ts'],
    file: 'src/coordinator.ts',
    find: "const answers = first.map((a) => (a.status === 'ok' ? a.answer : new Uint8Array()))",
    replace: "const answers = first.flatMap((a, j) => (a.status === 'ok' ? (c.cost.leafCalls > L && j === 1 ? [a.answer, a.answer] : [a.answer]) : [new Uint8Array()]))",
  },
  {
    name: 'The per-leaf budget is not enforced (every leaf may hold the whole query)',
    tests: ['test/split.test.ts'],
    file: 'src/coordinator.ts',
    find: 'budget: { samples: budget.samples, series: budget.series, stepPoints: c.limits.maxStepPoints },',
    replace: 'budget: { samples: Number.MAX_SAFE_INTEGER, series: Number.MAX_SAFE_INTEGER, stepPoints: Number.MAX_SAFE_INTEGER },',
  },
  {
    name: 'A query that does not decompose is sent to the leaves anyway',
    tests: ['test/split.test.ts'],
    file: 'src/index.ts',
    find: "  if (!plan.split) {\n    c.cost.execution = 'single'\n    c.cost.splitReason = plan.reason\n    return undefined\n  }",
    replace: "  if (!plan.split) {\n    c.cost.execution = 'single'\n    c.cost.splitReason = plan.reason\n    if (/no selector|parse error/.test(plan.reason)) return undefined\n    plan = { split: true, fragments: 1, without: [] }\n  }",
  },
  {
    name: 'Reader groups may carry eight reads (four file pairs) instead of six',
    tests: ['test/leaves.test.ts', 'test/split.test.ts'],
    file: 'src/coordinator.ts',
    find: 'if (!cur || cur.series.length + cur.samples.length + 2 > MAX_READS_PER_CALL || bytes + add > MAX_BYTES_PER_CALL) {',
    replace: 'if (!cur || cur.series.length + cur.samples.length + 2 > MAX_READS_PER_CALL + 2 || bytes + add > MAX_BYTES_PER_CALL) {',
  },
  {
    name: 'The cardinality report counts the tenant named by a `tenant` parameter',
    tests: ['test/cardinality.test.ts'],
    file: 'src/index.ts',
    find: '  return (await cardinality(c, w.start, w.end, w.lookbackStart, w.limit)).tsdb',
    replace: "  return (await cardinality(params.get('tenant') ? { ...c, tenant: params.get('tenant')! } : c, w.start, w.end, w.lookbackStart, w.limit)).tsdb",
  },
  {
    name: 'Churn counts series that existed before the range (the look-back window is not read)',
    tests: ['test/cardinality.test.ts'],
    file: 'src/coordinator.ts',
    find: '    const snap = await snapshot(c, lookbackStart, end)',
    replace: '    const snap = await snapshot(c, start, end)',
  },
  {
    name: 'A split query’s merged result is checked against the share of one leaf instead of the query’s budget',
    tests: ['test/split.test.ts'],
    file: 'src/coordinator.ts',
    find: 'const limits: QueryLimits = { ...c.limits, maxSamples: qSamples, maxSeries: qSeries, maxStepPoints: L * c.limits.maxStepPoints }',
    replace: 'const limits: QueryLimits = { ...c.limits, maxSamples: share(qSamples, L, 0), maxSeries: qSeries, maxStepPoints: L * c.limits.maxStepPoints }',
  },
  {
    name: 'A shard status this release does not know falls through to the stream-mismatch path (contracts/COMPATIBILITY.md)',
    tests: ['test/fence.test.ts'],
    file: 'src/coordinator.ts',
    find: "    if (status !== 'incarnation_mismatch') throw new ApiError('unavailable', `shard ${shard} answered a status this release does not know (${status.slice(0, 40)}); retry`)\n",
    replace: '',
  },
  {
    name: 'An engine that does not load is answered as a retryable 503',
    tests: ['test/http.test.ts'],
    file: 'src/index.ts',
    find: "      return failure('internal', 'the query engine could not be loaded', headers)",
    replace: "      return failure('unavailable', 'the query engine could not be loaded', { ...headers, 'Retry-After': '1' })",
  },
  {
    name: 'A query over many series is not split by its series estimate (only samples, bytes and files decide)',
    tests: ['test/split.test.ts'],
    file: 'src/coordinator.ts',
    find: ' || seriesEst > c.limits.splitAboveSeries',
    replace: '',
  },
  {
    name: 'Leaves are sized from samples alone (a split query over many series gets too few leaves)',
    tests: ['test/split.test.ts'],
    file: 'src/coordinator.ts',
    find: ', Math.ceil(series / (0.75 * limits.maxSeries)))',
    replace: ')',
  },
  {
    name: 'The series estimate counts one file per shard (size-cut segments of one span hold different series)',
    tests: ['test/split.test.ts'],
    file: 'src/coordinator.ts',
    find: '        if (g.maxTs >= f.minTs) sum += g.n\n',
    replace: '        if (g === f) sum += g.n\n',
  },
  {
    name: 'The plan-only answer leaves out the refusal the query would get',
    tests: ['test/split.test.ts'],
    file: 'src/coordinator.ts',
    find: 'refusal: refusal && { errorType: refusal.errorType, error: refusal.message } })',
    replace: 'refusal: null })',
  },
  {
    name: 'The plan-only endpoint reads the tail before answering (wakes every shard)',
    tests: ['test/split.test.ts'],
    file: 'src/coordinator.ts',
    find: '      const refusal = refusalBeforeFetch(c, splitting, scan, wanted.length, lakeBytesAll)\n',
    replace: '      const refusal = refusalBeforeFetch(c, splitting, scan, wanted.length, lakeBytesAll)\n      if (explain) await Promise.all((await shardsOf(c, snap.watermarks)).map((s) => readTail(c, s, snap.watermarks.find((w) => w.shard === s), known)))\n',
  },
  {
    name: 'The cardinality report ignores its series estimate (one place whatever the series, until the files pass maxFetchBytes)',
    tests: ['test/cardinality.test.ts'],
    file: 'src/coordinator.ts',
    find: '(bytes > c.limits.maxFetchBytes || est > per ?',
    replace: '(bytes > c.limits.maxFetchBytes ?',
  },
]

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, ...opts })
}

function buildWasm() {
  execFileSync(join(root, '../engine/wasm-query/build.sh'), { stdio: 'pipe' })
}

function suite(files = []) {
  const out = join(mkdtempSync(join(tmpdir(), 'viz-query-mutants-')), 'result.json')
  // At most two workers: the machine is shared with other engineers' builds.
  const r = run('npx', ['vitest', 'run', ...files, '--maxWorkers=2', '--reporter=json', `--outputFile=${out}`])
  let json
  try {
    json = JSON.parse(readFileSync(out, 'utf8'))
  } catch {
    return { ok: false, failed: [`the suite did not run: ${(r.stderr || r.stdout).split('\n').slice(-5).join(' | ')}`], broken: true }
  }
  const failed = []
  for (const f of json.testResults) {
    const tests = f.assertionResults.filter((t) => t.status === 'failed')
    for (const t of tests) failed.push(`${f.name.split('/').pop()} › ${t.title}`)
    if (f.status === 'failed' && tests.length === 0) failed.push(`${f.name.split('/').pop()} (file failed: ${String(f.message).split('\n')[0]})`)
  }
  return { ok: json.success, failed }
}

function apply(source, m) {
  let s = source
  for (const [find, replace] of [[m.find, m.replace], [m.alsoFind, m.alsoReplace], [m.alsoFind2, m.alsoReplace2]]) {
    if (find === undefined) continue
    if (s.split(find).length !== 2) throw new Error(`mutant "${m.name}": the text to replace occurs ${s.split(find).length - 1} times in ${m.file}`)
    s = s.replace(find, () => replace)
  }
  return s
}

const whole = process.argv.includes('--all')
const only = process.argv.slice(2).filter((a) => a !== '--all').map(Number)
const chosen = MUTANTS.map((m, i) => ({ ...m, n: i + 1 })).filter((m) => only.length === 0 || only.includes(m.n))

const fingerprint = () => {
  const h = createHash('sha256')
  for (const f of [...new Set(chosen.map((m) => m.file))].sort()) h.update(f).update(existsSync(shared(f)) ? readFileSync(shared(f)) : '')
  return h.digest('hex').slice(0, 16)
}
const before = fingerprint()

// Every mutant must apply to the source as it is, before anything runs.
for (const m of chosen) apply(readFileSync(rel(m.file), 'utf8'), m)

// Type errors that are there before any mutant (another component mid-edit) are not the
// mutant's: a mutant is invalid only if it adds one.
const tscErrors = () => new Set(run('npx', ['tsc', '--noEmit']).stdout.split('\n').filter((l) => /error TS\d+/.test(l)))
const baseline = tscErrors()
if (baseline.size > 0) console.log(`tsc reports ${baseline.size} error(s) before any mutant (not counted against mutants):\n  ${[...baseline].slice(0, 3).join('\n  ')}`)

console.log('unmutated suite …')
const clean = suite()
if (clean.broken) {
  console.error('the unmutated suite does not run:', clean.failed)
  process.exit(2)
}
// Tests that fail without any mutant (another component mid-edit) cannot kill one: a mutant
// is killed only by a failure the unmutated suite does not have.
const baselineFailed = new Set(clean.failed)
if (clean.ok) console.log('unmutated suite passes\n')
else console.log(`unmutated suite: ${baselineFailed.size} test(s) fail without any mutant and are not counted:\n  ${[...baselineFailed].join('\n  ')}\n`)
const fresh = (r) => ({ ...r, failed: r.failed.filter((f) => !baselineFailed.has(f)), ok: r.failed.every((f) => baselineFailed.has(f)) })

let survived = 0
let restore = () => {}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restore()
    process.exit(130)
  })
}
for (const m of chosen) {
  const original = readFileSync(rel(m.file), 'utf8')
  restore = () => writeFileSync(rel(m.file), original)
  let result
  try {
    writeFileSync(rel(m.file), apply(original, m))
    if (m.rust) buildWasm()
    // A mutant that does not type-check is a build error, not a kill.
    const added = m.rust ? [] : [...tscErrors()].filter((l) => !baseline.has(l))
    if (added.length > 0) result = { ok: false, failed: [`BUILD ERROR: ${added[0]}`], broken: true }
    else {
      result = fresh(suite(whole ? [] : m.tests))
      if (result.ok && !whole) result = fresh(suite()) // not caught where expected: is it caught anywhere?
    }
  } finally {
    restore()
    restore = () => {}
    if (m.rust) buildWasm()
  }
  if (result.broken) {
    console.log(`${String(m.n).padStart(2)}. INVALID   ${m.name}\n      ${result.failed[0]}`)
    survived++
  } else if (result.ok) {
    console.log(`${String(m.n).padStart(2)}. SURVIVED  ${m.name}`)
    survived++
  } else {
    console.log(`${String(m.n).padStart(2)}. killed    ${m.name}\n      by ${result.failed.length} test(s): ${result.failed.slice(0, 4).join(' | ')}${result.failed.length > 4 ? ' | …' : ''}`)
  }
}
console.log(`\n${chosen.length - survived} of ${chosen.length} mutants killed`)
const after = fingerprint()
console.log(`shared tree, files the mutants touch: ${before} before, ${after} after${before === after ? ' (unchanged)' : ' (CHANGED: by someone else; this tool writes only to the scratch tree)'}`)
process.exit(survived ? 1 : 0)
