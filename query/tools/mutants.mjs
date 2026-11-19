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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  {
    name: 'A split reader never reads again what its id-range read did not cover (a series whose key is not its id is lost)',
    tests: ['test/pruning.test.ts'],
    file: 'src/leaf.ts',
    find: "  if (have === 'whole') return true\n",
    replace: "  if (have === 'whole' || need.length >= 0) return true\n",
  },
  {
    name: 'A range read is put back one byte off (the sparse file names the wrong offset)',
    tests: ['test/pruning.test.ts'],
    file: 'src/coordinator.ts',
    find: '    if (chunks.length === 1) segments.push({ offset, bytes: chunks[0]! })',
    replace: '    if (chunks.length === 1) segments.push({ offset: offset + 1, bytes: chunks[0]! })',
  },
  {
    name: 'The label endpoints count series against the query limit, not maxMetadataSeries (refused at 20,000 series again)',
    tests: ['test/pruning.test.ts'],
    file: 'src/index.ts',
    find: 'const metaLimits = (c: Context) => ({ ...c.limits, maxSeries: c.limits.maxMetadataSeries })',
    replace: 'const metaLimits = (c: Context) => ({ ...c.limits })',
  },
  // ── 2026-11-19, the tail filtered and paged (D48) ──
  {
    name: 'The tail filter sends a label one range pins as if every range did (rows other ranges read are dropped)',
    tests: ['test/tail.test.ts'],
    file: 'src/tail.ts',
    find: '    if (ranges.every((r) => eq(r).some((x) => x.name === m.name && x.value === m.value))) shared.set(',
    replace: '    if (ranges.some((r) => eq(r).some((x) => x.name === m.name && x.value === m.value))) shared.set(',
  },
  {
    name: 'The tail filter sends metric names when only some ranges pin one',
    tests: ['test/tail.test.ts'],
    file: 'src/tail.ts',
    find: "  if (names.every((n) => n !== undefined && n !== '')) f.metrics = [...new Set(names as string[])].sort()",
    replace: "  if (names.some((n) => n !== undefined && n !== '')) f.metrics = [...new Set(names.filter((n): n is string => !!n))].sort()",
  },
  {
    name: 'The tail filter takes its time range from the first range only',
    tests: ['test/tail.test.ts'],
    file: 'src/tail.ts',
    find: '    const lo = Math.max(MIN_TS, Math.min(...ranges.map((r) => r.minTs)))',
    replace: '    const lo = Math.max(MIN_TS, ranges[0]!.minTs)',
  },
  {
    name: 'A stale watermark on a later page ends the read with the pages so far (a partial tail)',
    tests: ['test/tail.test.ts'],
    file: 'src/tail.ts',
    find: "    if (r.status === 'stale_watermark') return { status: 'stale', shard, calls: out.calls }",
    replace: "    if (r.status === 'stale_watermark') {\n      if (page > 0) return out\n      return { status: 'stale', shard, calls: out.calls }\n    }",
  },
  {
    name: 'A shard that stops paging in the middle of a read is taken as the rest of the tail',
    tests: ['test/tail.test.ts'],
    file: 'src/tail.ts',
    find: '        if (page > 0) return unavailable(',
    replace: '        if (page < 0) return unavailable(',
  },
  {
    name: 'A kept batch that does not fit the budget (page_limit) is taken as the end of the tail',
    tests: ['test/tail.test.ts', 'test/limits.test.ts'],
    file: 'src/tail.ts',
    find: '      out.complete = false\n',
    replace: '      out.complete = true\n',
  },
  {
    name: 'Tails that fit one by one but not together are not refused (the budget is not summed over shards)',
    tests: ['test/limits.test.ts', 'test/tail.test.ts', 'test/review-d54.test.ts', 'test/signals.test.ts'],
    file: 'src/coordinator.ts',
    find: '  const over = reads.some((r) => !r.complete) || bytes > limit',
    replace: '  const over = reads.some((r) => !r.complete)',
  },
  {
    name: 'A part reads the rest of a tail without its key range',
    tests: ['test/tail.test.ts'],
    file: 'src/tail.ts',
    find: 'keyRange ? { ...rest.filter, keyRange } : rest.filter',
    replace: 'rest.filter',
  },
  {
    name: 'A part does not check for rows of other parts (a series whose split key is not its id is lost)',
    tests: ['test/tail.test.ts'],
    file: 'src/leaf.ts',
    find: '              if (filtered && pieces.some((x, k) => k !== req.part && x !== null)) return null',
    replace: '              if (filtered && pieces.length < 0) return null',
  },
  {
    name: 'A split leaf of the previous release (it ignores the rest of the tail) is believed',
    tests: ['test/tail.test.ts'],
    file: 'src/coordinator.ts',
    find: "      if (!a.tail) throw new ApiError('unavailable', 'a split leaf of an earlier release answered without reading its part of the tail; retry')",
    replace: "      if (!a.tail) a.tail = { calls: 0, batches: 0, bytes: 0 }",
  },
  {
    name: 'A part reads the rest from the end the coordinator saw, not from the last batch it read (rows in between are lost)',
    tests: ['test/tail.test.ts'],
    file: 'src/coordinator.ts',
    find: '  return { incarnation: r.incarnation, above: r.batches.reduce((a, b) => Math.max(a, b.seq), r.above), through: r.through, filter }',
    replace: '  return { incarnation: r.incarnation, above: r.through, through: r.through, filter }',
  },
  {
    name: 'A part\'s tail is not capped by maxFetchBytes',
    tests: ['test/tail.test.ts'],
    file: 'src/leaf.ts',
    find: '          req.tailMaxBytes ?? 0,\n          (batches, filtered) => {',
    replace: '          Number.MAX_SAFE_INTEGER,\n          (batches, filtered) => {',
  },
  {
    name: 'A shard that discarded above a part\'s watermark is taken as an empty rest',
    tests: ['test/tail.test.ts'],
    file: 'src/leaf.ts',
    find: "  if (rest.status === 'stale') return { status: 'tail', kind: 'stale', shard: rest.shard, incarnation: rest.incarnation, asked: rest.asked }",
    replace: "  if (rest.status === 'stale') return { status: 'ok', batches: parts.flatMap((p) => p.batches), stats: { calls: 0, batches: 0, bytes: 0 } }",
  },
  {
    name: 'cutById ignores the low word of the id (ids at a part\'s edge go to the wrong part)',
    tests: ['test/tail.test.ts'],
    file: 'src/tail.ts',
    find: 'const partOfKey = (hi: number, lo: number, parts: number): number => Math.floor((hi * parts + Math.floor((lo * parts) / TWO32)) / TWO32)',
    replace: 'const partOfKey = (hi: number, lo: number, parts: number): number => Math.floor((hi * parts) / TWO32)',
  },
  // ── 2026-11-19, the label endpoints over leaves and `limit` ──
  {
    name: 'The cap on series listed over leaves takes the largest part, not the sum',
    tests: ['test/meta.test.ts'],
    file: 'src/coordinator.ts',
    find: '    const n = answers.reduce((x, a) => x + (a.listed[i] ?? 0), 0)',
    replace: '    const n = Math.max(0, ...answers.map((a) => a.listed[i] ?? 0))',
  },
  {
    name: 'A part counts a series once per wave of files it is listed in (no exact union)',
    tests: ['test/meta.test.ts'],
    file: 'src/meta.ts',
    find: '      for (let k = 0; k < list.length; k++) into.add(list[k]!)',
    replace: '      for (let k = 0; k < list.length; k++) into.add(BigInt(into.size))',
  },
  {
    name: 'Each part lists every series (the part is not passed to the engine)',
    tests: ['test/meta.test.ts'],
    file: 'src/leaf.ts',
    find: '        listing.add(own(() => leafEngine.metaPart(req.kind, { ...input, sampleFiles: [] }, req.name, req.match, req.start, req.end, req.part, req.parts, req.limits)))',
    replace: '        listing.add(own(() => leafEngine.metaPart(req.kind, { ...input, sampleFiles: [] }, req.name, req.match, req.start, req.end, 0, 1, req.limits)))',
  },
  {
    name: 'Names and values merged in UTF-16 order, not code-point (UTF-8) order',
    tests: ['test/meta.test.ts'],
    file: 'src/meta.ts',
    find: '    const x = a.codePointAt(i)!\n    const y = b.codePointAt(i)!',
    replace: '    const x = a.charCodeAt(i)\n    const y = b.charCodeAt(i)',
  },
  {
    name: 'The parts\' series are concatenated, not sorted',
    tests: ['test/meta.test.ts'],
    file: 'src/coordinator.ts',
    find: '    all.sort(byLabels)',
    replace: '    all.sort(() => 0)',
  },
  {
    name: 'Series files over maxFetchBytes are read in one place anyway (never over leaves by themselves)',
    tests: ['test/meta.test.ts'],
    file: 'src/coordinator.ts',
    find: '      const leaves = hooks.forceLeaves !== undefined || bytes > c.limits.maxFetchBytes',
    replace: '      const leaves = hooks.forceLeaves !== undefined',
  },
  {
    name: 'A series file a part cannot read is left out of its listing',
    tests: ['test/meta.test.ts'],
    file: 'src/leaf.ts',
    find: "          if (r.status !== 'ok' || r.bytes.byteLength !== length) return { status: 'missing', key: item.key }",
    replace: "          if (r.status !== 'ok' || r.bytes.byteLength !== length) return { status: 'ok', json: '[]', listed: [], files: 0, bytesRead: 0, cacheHits: 0, r2Gets: 0, engineMs: 0 }",
  },
  {
    name: 'A negative `limit` is accepted (as no limit)',
    tests: ['test/meta.test.ts'],
    file: 'src/params.ts',
    find: "  if (n < 0) throw bad('limit', 'limit must be non-negative')",
    replace: "  if (n < -1e18) throw bad('limit', 'limit must be non-negative')",
  },
  {
    name: 'A query result is cut one series late',
    tests: ['test/meta.test.ts'],
    file: 'src/index.ts',
    find: '      if (depth === 0 && ++elements === limit) {',
    replace: '      if (depth === 0 && ++elements === limit + 1) {',
  },
  {
    name: 'A label list cut by `limit` carries no warning',
    tests: ['test/meta.test.ts'],
    file: 'src/index.ts',
    find: '  c.warnings = [...(c.warnings ?? []), TRUNCATED]\n  return list.slice(0, limit)',
    replace: '  return list.slice(0, limit)',
  },
  // ── 2026-11-19, split parts read their id range of the series files (ABI 5) ──
  {
    name: 'A part that saw a foreign series is ignored (the split is not run again with the series files read whole)',
    tests: ['test/tail.test.ts'],
    file: 'src/coordinator.ts',
    find: "  if (seriesByPart && (foreign > 0 || unknown > 0) && !hooks.ignoreForeign) return { status: 'foreign', count: foreign, unknown }",
    replace: "  if (seriesByPart && (foreign < 0 || unknown > 0) && !hooks.ignoreForeign) return { status: 'foreign', count: foreign, unknown }",
  },
  {
    name: 'A reader does not report the foreign series it saw',
    tests: ['test/tail.test.ts'],
    file: 'src/leaf.ts',
    find: '          if (ex.strays === 0) return { status: \'ok\', batch: ex.batch, rows: ex.rows, series: ex.series, bytesRead: stats.bytesRead, cacheHits: stats.cacheHits, r2Gets: stats.r2Gets, engineMs, foreign: ex.foreign }',
    replace: '          if (ex.strays === 0) return { status: \'ok\', batch: ex.batch, rows: ex.rows, series: ex.series, bytesRead: stats.bytesRead, cacheHits: stats.cacheHits, r2Gets: stats.r2Gets, engineMs, foreign: 0 }',
  },
  {
    name: 'A split leaf does not add up its readers\' foreign series',
    tests: ['test/tail.test.ts'],
    file: 'src/leaf.ts',
    find: "            if (typeof answer.foreign === 'number') stats.foreign += answer.foreign",
    replace: "            if (typeof answer.foreign === 'number') stats.foreign += 0",
  },
  // ── Traces and logs (2026-11-19, ABI 6): mutants 74 to 80 ──
  {
    name: 'Wrong signal from the tail: metrics reads ask every shard the ledger names, span and log shards included',
    tests: ['test/signals.test.ts'],
    file: 'src/coordinator.ts',
    find: "for (const w of watermarks) if (names.has(w.shard) || signalOfShard(w.shard) === 'metrics') names.add(w.shard)",
    replace: 'for (const w of watermarks) names.add(w.shard)',
  },
  {
    name: 'Wrong signal from the tail: every tail read asks the shards for signal 1 (metrics), span and log reads included',
    tests: ['test/signals.test.ts'],
    file: 'src/coordinator.ts',
    find: '  const asked = withSignal(filter, signal)',
    replace: '  const asked = withSignal(filter, 1)',
  },
  {
    name: 'Wrong signal from the tail: a batch of another signal is read as the one asked for (no header check)',
    tests: ['test/signals.test.ts'],
    file: 'src/shards.ts',
    find: '  if (got !== want) throw new WrongSignal(shard, got, want)',
    replace: '  void got',
  },
  {
    name: 'Pruning drops a matching hour: trace by ID keeps a span file only if its fragments name the hour after the file\'s',
    tests: ['test/signals.test.ts'],
    file: 'src/signals.ts',
    find: 'const x = hourOf(f); return x === null || hours.has(x)',
    replace: 'const x = hourOf(f); return x === null || hours.has(x + 1)',
  },
  {
    name: 'A cap not enforced: the rows the fragments say a span or log query decodes are not checked before fetching',
    tests: ['test/signals.test.ts'],
    file: 'src/signals.ts',
    find: '  if (rows > rowsLimit) {',
    replace: '  if (rows > rowsLimit * 1_000_000) {',
  },
  {
    name: 'The tenant is taken from the query string (Tempo search: `orgId`)',
    tests: ['test/signals.test.ts'],
    file: 'src/sigroutes.ts',
    find: "  const { start, end } = tempoWindow(params)\n  return traceSearch(c,",
    replace: "  const { start, end } = tempoWindow(params)\n  c.tenant = params.get('orgId') ?? c.tenant\n  return traceSearch(c,",
  },
  {
    name: 'A result shape field renamed: trace by ID answers `resourceSpans` for `batches` (Rust; rebuilds the module)',
    tests: ['test/signals.test.ts'],
    file: '../engine/wasm-query/src/traces.rs',
    rust: true,
    find: '    let mut out = String::from("{\\"batches\\":[");',
    replace: '    let mut out = String::from("{\\"resourceSpans\\":[");',
  },
  // ── 2026-11-19, the review of D54, D56 and D59 (design/reviews/d54-d56-d59.md): mutants 81 to 96, ported from pull request #7 ──
  {
    name: 'B-1: a reader that answers without `foreign` leaves its split leaf\'s count known (taken as 0)',
    tests: ['test/review-d54.test.ts'],
    file: 'src/leaf.ts',
    find: '            else if (req.seriesByPart) stats.foreignUnknown = true',
    replace: '            else if (req.seriesByPart) stats.foreignUnknown = false',
  },
  {
    name: 'B-1: the coordinator takes a part\'s missing `foreign` as 0 (the reviewed code)',
    tests: ['test/review-d54.test.ts'],
    file: 'src/coordinator.ts',
    find: "      if (typeof st.foreign === 'number' && st.foreignUnknown === false) foreign += st.foreign\n      else unknown++",
    replace: '      foreign += st.foreign ?? 0',
  },
  {
    name: 'M-1: a part\'s rest is not bounded by the end the coordinator fixed (it reads to the shard\'s end)',
    tests: ['test/review-d54.test.ts'],
    file: 'src/tail.ts',
    find: '  const through = o.through ?? null',
    replace: '  const through = null as number | null',
  },
  {
    name: 'M-1: the end of a read that stopped on its first page is not learned from the shard',
    tests: ['test/review-d54.test.ts'],
    file: 'src/coordinator.ts',
    find: '  const ends = await Promise.all(reads.map((r) => (r.complete || r.through !== null || signal !== 1 ? null : learnEnd(c, r, known))))',
    replace: '  const ends = reads.map(() => null as string | null)',
  },
  {
    name: 'm-1: a batch past the end that does not fit a part\'s budget stops the read as over it',
    tests: ['test/review-d54.test.ts'],
    file: 'src/tail.ts',
    find: "      if (through !== null && typeof r.seq === 'number' && r.seq > through) return out",
    replace: "      if (through !== null && typeof r.seq === 'number' && r.seq < 0) return out",
  },
  {
    name: 'M-2: each shard\'s read gets the whole budget in the first round (one budget per shard)',
    tests: ['test/review-d54.test.ts', 'test/signals.test.ts'],
    file: 'src/tail.ts',
    find: '  const share = Math.floor(Math.max(0, cap - used) / Math.max(1, n))',
    replace: '  const share = Math.max(0, cap - used)',
  },
  {
    name: 'M-2: the coordinator cuts the tail by `series_id` whatever the split key leaves out',
    tests: ['test/review-d54.test.ts', 'test/tail.test.ts'],
    file: 'src/coordinator.ts',
    find: '      cut = cutReads(reads, L, spec.without)\n      tailFor = (j) => ({ tails: cut.flatMap((perShard) => perShard[j]!) })',
    replace: '      cut = cutReads(reads, L, [])\n      tailFor = (j) => ({ tails: cut.flatMap((perShard) => perShard[j]!) })',
  },
  {
    name: 'M-2: the FNV hash of a series that carries a `without` label is taken over every label',
    tests: ['test/review-d54.test.ts'],
    file: 'src/tail.ts',
    find: '        if (isLeft(nAt, nLen)) continue',
    replace: '        if (isLeft(nAt, nLen) && nLen < 0) continue',
  },
  {
    name: 'M-2: the reads keep their batches after they are cut (the tail held twice; memory only)',
    tests: ['test/review-d54.test.ts'],
    file: 'src/coordinator.ts',
    find: '    r.batches = []\n',
    replace: '    r.batches = [...r.batches]\n',
  },
  {
    name: 'm-2: a leaf counts a rolled-back shard\'s whole answer against the part\'s budget (no filter applied)',
    tests: ['test/review-d54.test.ts', 'test/tail.test.ts'],
    file: 'src/tail.ts',
    find: "        const f = where === 'leaf' ? compileFilter(filter) : null",
    replace: '        const f = null as ReturnType<typeof compileFilter> | null',
  },
  {
    name: 'm-3: the estimate ignores the batches after the one that did not fit (the reviewed rule)',
    tests: ['test/review-d54.test.ts'],
    file: 'src/tail.ts',
    find: '    if (r.overSeq !== null && r.overSeq > r.above) {',
    replace: '    if (r.overSeq !== null && r.overSeq < r.above) {',
  },
  {
    name: 'm-3: a split sized too small is not split again',
    tests: ['test/review-d54.test.ts'],
    file: 'src/coordinator.ts',
    find: '      if (k >= 2) {',
    replace: '      if (k >= 2 && k < 0) {',
  },
  {
    name: 'M-3: the parts that read the rest of a tail are not bounded',
    tests: ['test/review-d54.test.ts'],
    file: 'src/coordinator.ts',
    find: '  if (parts <= c.limits.maxTailReadParts) return',
    replace: '  if (parts >= 0) return',
  },
  {
    name: 'm-5: a label call over more series files than maxFiles stays in one place',
    tests: ['test/review-d54.test.ts'],
    file: 'src/coordinator.ts',
    find: '      const leaves = hooks.forceLeaves !== undefined || bytes > c.limits.maxFetchBytes || plans.length > c.limits.maxFiles',
    replace: '      const leaves = hooks.forceLeaves !== undefined || bytes > c.limits.maxFetchBytes',
  },
  {
    name: 'm-5: a label call over leaves counts one copy of the series files against maxQueryFetchBytes',
    tests: ['test/review-d54.test.ts'],
    file: 'src/coordinator.ts',
    find: '      let partBytes = L * bytes',
    replace: '      let partBytes = bytes',
  },
  {
    name: 'm-7: a page that does not advance the read is asked for again',
    tests: ['test/review-d54.test.ts', 'test/signals.test.ts'],
    file: 'src/tail.ts',
    find: '      if (r.page.next === cursor) return unavailable',
    replace: "      if (r.page.next === cursor && cursor === '') return unavailable",
  },
  // ── The review's fixes on the span and log reads (D62), which share `readTails`: mutant 97 ──
  {
    name: 'A span or log read that goes on in the second round of the shared budget sends the filter without its signal (its cursor is bound to the signal\'s filter)',
    tests: ['test/signals.test.ts'],
    file: 'src/coordinator.ts',
    find: "read.incarnation, read.above, asked, budget, 'coordinator'",
    replace: "read.incarnation, read.above, filter, budget, 'coordinator'",
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
// Only errors in the copied directories count: other components are links into the shared tree,
// which other engineers edit while this runs (a type error in flush/ appearing mid-run made every
// mutant INVALID on 2026-11-19); a mutant can add errors only where it changes something.
const tscErrors = () => new Set(run('npx', ['tsc', '--noEmit']).stdout.split('\n').filter((l) => /error TS\d+/.test(l) && !/^\.\.\/(?!engine\/(query|wasm-query)\/)/.test(l)))
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
// The scratch tree (with the copy's WASM target directory) is large on a shared disk: delete it.
rmSync(scratch, { recursive: true, force: true })
console.log(`scratch tree ${scratch} deleted`)
process.exit(survived ? 1 : 0)
