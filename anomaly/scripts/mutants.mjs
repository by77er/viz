// Mutation checks (AGENTS.md, "Tests must have teeth").
//
// Each mutant breaks one property in the source on purpose. The script applies it, runs the
// named test files, requires at least one test to fail, and restores the source. A mutant that
// survives, or whose pattern no longer matches exactly once, is printed and makes the script
// exit non-zero (a stale pattern is a check that silently stopped running).
// Kills are read from vitest's JSON report, not from its console output.
//
//   node scripts/mutants.mjs           run all
//   node scripts/mutants.mjs 3 7       run mutants 3 and 7
//   node scripts/mutants.mjs --list    print the list

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
]

function runTests(tests) {
  const dir = mkdtempSync(join(tmpdir(), 'anomaly-mutant-'))
  const out = join(dir, 'report.json')
  spawnSync('npx', ['vitest', 'run', ...tests, '--reporter=json', `--outputFile=${out}`], { cwd: root, encoding: 'utf8', timeout: 600_000 })
  let report = null
  try { report = JSON.parse(readFileSync(out, 'utf8')) } catch { /* no report: treat as error */ }
  rmSync(dir, { recursive: true, force: true })
  if (!report) return { failed: -1, killers: [] }
  const killers = []
  for (const f of report.testResults ?? []) for (const a of f.assertionResults ?? []) if (a.status === 'failed') killers.push(`${f.name.replace(root + '/', '')} > ${a.fullName}`)
  return { failed: report.numFailedTests ?? killers.length, killers }
}

const args = process.argv.slice(2)
if (args.includes('--list')) {
  MUTANTS.forEach((m, i) => console.log(`${i + 1}. ${m.name}`))
  process.exit(0)
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
  try {
    const current = new Map(originals)
    for (const e of m.edits) { const p = join(root, e.file); current.set(p, current.get(p).replace(e.find, e.replace)) }
    for (const [p, s] of current) writeFileSync(p, s)
    const r = runTests(m.tests)
    if (r.failed > 0) {
      console.log(`#${k} killed: ${m.name}\n    by ${r.killers.slice(0, 3).join('\n       ')}${r.killers.length > 3 ? `\n       (+${r.killers.length - 3} more)` : ''}`)
      lines.push(`| ${k} | ${m.name} | killed by ${r.killers.length}: ${r.killers[0]} |`)
    } else {
      bad++
      console.log(`#${k} SURVIVED${r.failed < 0 ? ' (no test report)' : ''}: ${m.name}`)
      lines.push(`| ${k} | ${m.name} | SURVIVED |`)
    }
  } finally {
    for (const [p, s] of originals) writeFileSync(p, s)
  }
}
console.log(`\n${pick.length - bad}/${pick.length} mutants killed`)
writeFileSync(join(root, 'bench/out/mutants.md'), `| # | mutant | result |\n|---|---|---|\n${lines.join('\n')}\n`)
process.exit(bad ? 1 : 0)
