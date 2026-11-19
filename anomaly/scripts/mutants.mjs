// Mutation checks (AGENTS.md, "Tests must have teeth").
//
// Each mutant breaks one property in the source on purpose. The script copies the component to
// a fresh scratch directory (never the shared tree: AGENTS.md, Evidence), applies the mutant to
// the copy, runs the named test files there, requires at least one test to fail, and deletes
// the copy. A mutant that survives, or whose pattern no longer matches exactly once, is printed
// and makes the script exit non-zero (a stale pattern is a check that silently stopped running).
// Kills are read from vitest's JSON report, not from its console output.
//
//   node scripts/mutants.mjs                 run all
//   node scripts/mutants.mjs 3 7             run mutants 3 and 7
//   node scripts/mutants.mjs --list          print the list
//   node scripts/mutants.mjs --verify-clean  read-only: every original present once, no mutant text in the tree
//   MUTANT_SCRATCH=<dir>                     where the copies go (default: the OS temp directory)

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const one = (file, find, replace) => [{ file, find, replace }]

export const MUTANTS = [
  {
    name: 'MAD without the 1.4826 constant (robust z-score window)',
    edits: one('src/detectors/robustz.ts', "if (mad > 0) return { sigma: MAD_TO_SIGMA * mad, mad, from: 'mad' }", "if (mad > 0) return { sigma: mad, mad, from: 'mad' }"),
    tests: ['test/synthetic.test.ts'],
  },
  {
    name: 'MAD without the 1.4826 constant (shared robust(): seasonal, STL, cross-series)',
    edits: one('src/stats.ts', "if (mad > 0) return { n, median: m, mad, sigma: MAD_TO_SIGMA * mad, sigmaFrom: 'mad' }", "if (mad > 0) return { n, median: m, mad, sigma: mad, sigmaFrom: 'mad' }"),
    tests: ['test/misc.test.ts', 'test/explain.test.ts', 'test/synthetic.test.ts'],
  },
  {
    name: 'seasonal baseline takes the wrong season (skips the most recent one)',
    edits: one('src/detectors/seasonal.ts', 'const v = st.vals[mod(s - j * g.P, g.R)]', 'const v = st.vals[mod(s - (j + 1) * g.P, g.R)]'),
    tests: ['test/synthetic.test.ts', 'test/explain.test.ts'],
  },
  {
    name: 'seasonal baseline one slot off phase',
    edits: one('src/detectors/seasonal.ts', 'const v = st.vals[mod(s - j * g.P, g.R)]', 'const v = st.vals[mod(s - j * g.P + 1, g.R)]'),
    tests: ['test/synthetic.test.ts', 'test/explain.test.ts'],
  },
  {
    name: 'gaps treated as zeros (a missing value reads as 0, in every detector)',
    edits: one('src/base.ts', 'export const val = (v: number): number => (Math.abs(v) <= MAX_ABS ? v + 0 : NaN)', 'export const val = (v: number): number => (Math.abs(v) <= MAX_ABS ? v + 0 : 0)'),
    tests: ['test/synthetic.test.ts', 'test/properties.test.ts'],
  },
  {
    name: 'seasonal: skipped slots between points are zeros, not missing',
    edits: one('src/detectors/seasonal.ts', 'else for (let q = st.lastSlot + 1; q < s; q++) st.vals[mod(q, g.R)] = null', 'else for (let q = st.lastSlot + 1; q < s; q++) st.vals[mod(q, g.R)] = 0'),
    tests: ['test/synthetic.test.ts', 'test/properties.test.ts'],
  },
  {
    name: 'incremental state not updated (robust z returns the window it was given)',
    edits: one('src/detectors/robustz.ts', 'const out: RobustZState = { v: 1, lastTs, stepMs, t: win.t.slice(win.head), x: win.x.slice(win.head) }', 'const out: RobustZState = { v: 1, lastTs, stepMs, t: state?.t ?? [], x: state?.x ?? [] }'),
    tests: ['test/properties.test.ts'],
  },
  {
    name: 'incremental state not updated (EWMA keeps the old mean)',
    edits: one('src/detectors/ewma.ts', 'const out: EwmaState = { v: 1, n: st.n, mean: st.mean, var: st.var, run: st.run, lastTs: st.lastTs, stepMs: st.stepMs }', 'const out: EwmaState = { v: 1, n: st.n, mean: state?.mean ?? st.mean, var: st.var, run: st.run, lastTs: st.lastTs, stepMs: st.stepMs }'),
    tests: ['test/properties.test.ts'],
  },
  {
    name: 'hysteresis removed (recovery level ignored)',
    edits: one('src/detectors/threshold.ts', "const recA = above === null ? null : typeof p.recoverAbove === 'number' && Number.isFinite(p.recoverAbove) ? Math.min(p.recoverAbove, above) : above", 'const recA = above'),
    tests: ['test/synthetic.test.ts', 'test/explain.test.ts'],
  },
  {
    name: 'changepoint penalty ignored',
    edits: one('src/detectors/pelt.ts', 'const v = F[c.tau]! + cost(c.tau, t) + beta', 'const v = F[c.tau]! + cost(c.tau, t)'),
    tests: ['test/independent.test.ts', 'test/synthetic.test.ts'],
  },
  {
    name: 'PELT prunes at once despite the minimum segment length (the bug the brute-force test found)',
    edits: one('src/detectors/pelt.ts', 'c.until = Math.min(c.until, t + minSeg)', 'c.until = Math.min(c.until, t + 1)'),
    tests: ['test/independent.test.ts'],
  },
  {
    name: 'burn-rate windows swapped between rules (14.4× paired with 6h/30m)',
    edits: one('src/detectors/burnrate.ts', "{ severity: 'page', longMs: HOUR, shortMs: 5 * MINUTE, burnRate: 14.4 },", "{ severity: 'page', longMs: 6 * HOUR, shortMs: 30 * MINUTE, burnRate: 14.4 },"),
    tests: ['test/burnrate.test.ts'],
  },
  {
    name: 'burn-rate long window read from the short window',
    edits: one('src/detectors/burnrate.ts', 'const L = windows.get(rule.longMs)', 'const L = windows.get(rule.shortMs)'),
    tests: ['test/burnrate.test.ts'],
  },
  {
    name: 'burn-rate threshold not strict (≥ instead of >)',
    edits: one('src/detectors/burnrate.ts', 'longBurn > rule.burnRate && shortBurn > rule.burnRate && enough', 'longBurn >= rule.burnRate && shortBurn >= rule.burnRate && enough'),
    tests: ['test/burnrate.test.ts'],
  },
  {
    name: 'cross-series uses mean and standard deviation instead of median and MAD',
    edits: one('src/detectors/crossseries.ts', '  const rb = robust(vals)\n', "  const rb = (() => { const m = vals.reduce((a, b) => a + b, 0) / vals.length; const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length); return { n: vals.length, median: m, mad: sd / 1.4826, sigma: sd, sigmaFrom: 'mad' as const } })()\n"),
    tests: ['test/misc.test.ts', 'test/explain.test.ts'],
  },
  {
    name: 'explanation numbers not from the computation (deviation printed in MADs while the score is in σ)',
    edits: one('src/explain.ts', '`${withUnit(args.value, args.unit)} is ${fmt(args.deviations)} ${args.spreadWord} ${direction} `', '`${withUnit(args.value, args.unit)} is ${fmt(args.deviations * 1.4826)} ${args.spreadWord} ${direction} `'),
    tests: ['test/explain.test.ts'],
  },
  {
    name: 'explanation reference is the value itself, not the baseline',
    edits: one('src/detectors/robustz.ts', '            reference: med,', '            reference: x,'),
    tests: ['test/explain.test.ts'],
  },
  {
    name: 'NaN propagating into the score (finiteScore passes non-finite values through)',
    edits: one('src/stats.ts', 'if (!Number.isFinite(x)) return x > 0 ? SCORE_CAP : 0', 'if (!Number.isFinite(x)) return x'),
    tests: ['test/properties.test.ts'],
  },
  {
    name: 'NaN propagating into state (EWMA folds in a missing value)',
    edits: one('src/detectors/ewma.ts', 'if (!Number.isFinite(ts) || !Number.isFinite(x) || (st.lastTs !== null && ts <= st.lastTs)) {', 'if (!Number.isFinite(ts) || (st.lastTs !== null && ts <= st.lastTs)) {'),
    tests: ['test/properties.test.ts', 'test/synthetic.test.ts'],
  },
  {
    name: 'CUSUM allowance k ignored (every wiggle accumulates)',
    edits: one('src/detectors/cusum.ts', 'st.hi = Math.max(0, st.hi + z - p.k)', 'st.hi = Math.max(0, st.hi + z)'),
    tests: ['test/synthetic.test.ts'],
  },
  {
    name: 'STL robustness weights computed but never used',
    edits: one('src/detectors/stl.ts', '    userw = true\n', '    userw = false\n'),
    tests: ['test/independent.test.ts'],
  },
  {
    name: 'seasonal slots anchored to the epoch instead of the first point (breaks time-shift invariance)',
    edits: [
      { file: 'src/detectors/seasonal.ts', find: 'const s = slotOf(ts, st.origin ?? ts, stepMs)', replace: 'const s = slotOf(ts, 0, stepMs)' },
    ],
    tests: ['test/properties.test.ts'],
  },
  {
    name: 'quantile spread uses the median deviation instead of the requested quantile',
    edits: one('src/detectors/robustz.ts', 'const qd = quantileInPlace(this.scratch, n, quantile)', 'const qd = quantileInPlace(this.scratch, n, 0.5)'),
    tests: ['test/synthetic.test.ts'],
  },
  {
    name: 'NAB scorer: probationary period 10% instead of 15%',
    edits: one('bench/nab.ts', 'export const PROBATION_PERCENT = 0.15', 'export const PROBATION_PERCENT = 0.1'),
    tests: ['test/nab-scorer.test.ts'],
  },
  {
    name: 'NAB scorer: every detection in a window counts, not only the best',
    edits: one('bench/nab.ts', "if (det) { tp++; if (w[i]! > best[win]!) best[win] = w[i]! } else fn++", "if (det) { tp++; best[win] = best[win]! + w[i]! } else fn++"),
    tests: ['test/nab-scorer.test.ts'],
  },
  // The SMD scorer (bench/smd.ts)
  {
    name: 'SMD windows: half-width w instead of floor(w / 2)',
    edits: one('bench/smd.ts', 'const h = Math.floor(w / 2)', 'const h = w'),
    tests: ['test/smd-scorer.test.ts'],
  },
  {
    name: 'SMD windows: width not divided among the segments',
    edits: one('bench/smd.ts', 'const w = Math.floor((fraction * nTest) / segments.length)', 'const w = Math.floor(fraction * nTest)'),
    tests: ['test/smd-scorer.test.ts'],
  },
  {
    name: 'SMD segments: dimensions read as 0-based',
    edits: one('bench/smd.ts', 'interp.filter((r) => r.dims.includes(dim))', 'interp.filter((r) => r.dims.includes(dim - 1))'),
    tests: ['test/smd-scorer.test.ts'],
  },
  {
    name: "SMD don't care: machine segments that list the dimension excluded too",
    edits: one('bench/smd.ts', 'const others = machineSegments.filter((m) => !seriesSegs.some((s) => overlaps(m, s)))', 'const others = machineSegments'),
    tests: ['test/smd-scorer.test.ts'],
  },
  {
    name: "SMD rows: don't-care spans not applied",
    edits: one('bench/smd.ts', 'for (const [a, b] of dontCare) for (let i = a; i <= b; i++) if (!rows.inWindow[i]) rows.window[i] = -2', 'void dontCare'),
    tests: ['test/smd-scorer.test.ts'],
  },
  {
    name: 'SMD rows: NAB probation applied inside the test half',
    edits: one('bench/smd.ts', 'const rows = sweepRows(file, 0)', 'const rows = sweepRows(file)'),
    tests: ['test/smd-scorer.test.ts'],
  },
  {
    name: 'SMD runs: a run begun in the history counted as an onset at the first test row',
    edits: one('bench/smd.ts', 'out.push(Math.max(s - nHistory, -1), i - 1 - nHistory)', 'out.push(Math.max(s - nHistory, 0), i - 1 - nHistory)'),
    tests: ['test/smd-scorer.test.ts'],
  },
  {
    name: 'SMD machine view: touching runs not merged into one alarm',
    edits: one('bench/smd.ts', 'return mergeSpans(spans, true).flat()', 'return mergeSpans(spans).flat()'),
    tests: ['test/smd-scorer.test.ts'],
  },
  {
    name: 'SMD event metric: tolerance not applied after the segment end',
    edits: one('bench/smd.ts', 'if (lo < onsets.length && onsets[lo]! <= e + tol) {', 'if (lo < onsets.length && onsets[lo]! <= e) {'),
    tests: ['test/smd-scorer.test.ts'],
  },
  {
    name: "SMD event metric: onsets in don't-care spans counted as false",
    edits: one('bench/smd.ts', 'else if (spanIndex(dc, i) >= 0) c.ignored++', 'else if (spanIndex(dc, i) >= 0 && false) c.ignored++'),
    tests: ['test/smd-scorer.test.ts'],
  },
  {
    name: 'SMD bootstrap: machines resampled without replacement (every weight 1)',
    edits: one('bench/smd.ts', 'for (let j = 0; j < units; j++) w[Math.floor(r() * units)]! += 1', 'for (let j = 0; j < units; j++) w[j]! += 1'),
    tests: ['test/smd-scorer.test.ts'],
  },
  {
    name: 'SMD normalisation: the null score not subtracted',
    edits: one('bench/smd.ts', 'return (100 * (r - n)) / (k * tpWeight - n)', 'return (100 * r) / (k * tpWeight)'),
    tests: ['test/smd-scorer.test.ts'],
  },
]

/** A throw-away copy of the component: sources copied, node_modules and NAB data linked (read only). */
function makeCopy() {
  const base = process.env.MUTANT_SCRATCH || tmpdir()
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'anomaly-mutant-'))
  for (const d of ['src', 'test', 'bench', 'scripts']) {
    cpSync(join(root, d), join(dir, d), { recursive: true, filter: (p) => !p.includes(`${join(root, 'bench', 'data')}`) && !p.includes(`${join(root, 'bench', 'out')}`) })
  }
  for (const f of ['package.json', 'tsconfig.json']) cpSync(join(root, f), join(dir, f))
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir')
  symlinkSync(join(root, 'bench', 'data'), join(dir, 'bench', 'data'), 'dir')
  return dir
}

function runTests(dir, tests) {
  const out = join(dir, 'report.json')
  spawnSync('npx', ['vitest', 'run', ...tests, '--reporter=json', `--outputFile=${out}`], { cwd: dir, encoding: 'utf8', timeout: 600_000 })
  let report = null
  try { report = JSON.parse(readFileSync(out, 'utf8')) } catch { /* no report: treat as error */ }
  if (!report) return { failed: -1, killers: [] }
  const killers = []
  for (const f of report.testResults ?? []) for (const a of f.assertionResults ?? []) if (a.status === 'failed') killers.push(`${f.name.replace(dir + '/', '')} > ${a.fullName}`)
  return { failed: report.numFailedTests ?? killers.length, killers }
}

const args = process.argv.slice(2)
if (args.includes('--list')) {
  MUTANTS.forEach((m, i) => console.log(`${i + 1}. ${m.name}`))
  process.exit(0)
}
if (args.includes('--verify-clean')) {
  // read-only check of the shared tree: no mutant applied, no pattern gone stale
  let problems = 0
  MUTANTS.forEach((m, i) => {
    for (const e of m.edits) {
      const s = readFileSync(join(root, e.file), 'utf8')
      const originals = s.split(e.find).length - 1
      // count the mutant text outside the original (several mutants are a prefix of their original)
      const masked = s.split(e.find).join('\u0000')
      const mutated = e.replace.includes(e.find) ? 0 : masked.split(e.replace).length - 1
      if (originals !== 1 || mutated !== 0) { problems++; console.log(`#${i + 1} ${e.file}: original ×${originals}, mutant ×${mutated}`) }
    }
  })
  console.log(problems ? `${problems} problem(s)` : `clean: all ${MUTANTS.length} mutants absent, every original present once`)
  process.exit(problems ? 1 : 0)
}
const pick = args.length ? args.map(Number) : MUTANTS.map((_, i) => i + 1)
let bad = 0
const lines = []
for (const k of pick) {
  const m = MUTANTS[k - 1]
  const originals = new Map()
  let stale = false
  for (const e of m.edits) {
    const p = join(root, e.file)
    const src = originals.get(p) ?? readFileSync(p, 'utf8')
    originals.set(p, originals.get(p) ?? src)
    const count = src.split(e.find).length - 1
    if (count !== 1) { stale = true; console.log(`#${k} STALE: pattern found ${count} times in ${e.file}`); break }
  }
  if (stale) { bad++; lines.push(`| ${k} | ${m.name} | STALE |`); continue }
  const dir = makeCopy()
  try {
    // edits go to the copy only; the shared tree is read, never written
    const current = new Map()
    for (const e of m.edits) { const p = join(dir, e.file); current.set(p, (current.get(p) ?? originals.get(join(root, e.file))).replace(e.find, e.replace)) }
    for (const [p, s] of current) writeFileSync(p, s)
    const r = runTests(dir, m.tests)
    if (r.failed > 0) {
      console.log(`#${k} killed: ${m.name}\n    by ${r.killers.slice(0, 3).join('\n       ')}${r.killers.length > 3 ? `\n       (+${r.killers.length - 3} more)` : ''}`)
      lines.push(`| ${k} | ${m.name} | killed by ${r.killers.length}: ${r.killers[0]} |`)
    } else {
      bad++
      console.log(`#${k} SURVIVED${r.failed < 0 ? ' (no test report)' : ''}: ${m.name}`)
      lines.push(`| ${k} | ${m.name} | SURVIVED |`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
console.log(`\n${pick.length - bad}/${pick.length} mutants killed`)
mkdirSync(join(root, 'bench/out'), { recursive: true })
writeFileSync(join(root, 'bench/out/mutants.md'), `| # | mutant | result |\n|---|---|---|\n${lines.join('\n')}\n`)
process.exit(bad ? 1 : 0)
