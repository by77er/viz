// Teeth for the checks: break each property in a copy of the system and confirm the check that guards it fails; confirm the harmless edits pass.
//   node tools/mutants.mjs [workDir] [--only R1,X5,…] [--json out.json]
// workDir defaults to $VIZ_MUTANT_DIR, else the system temp directory; it must be outside the tree, which is never edited (AGENTS.md: mutants
// are applied to a copy in a scratch area; one reached a pull request when applied in place). Each mutant gets a fresh copy of tools/, src/,
// project/, fixtures/ and the latest review's compositions, with node_modules linked, and the copy is deleted afterwards.
// The corpus and what each mutant expects: tools/mutants-corpus.mjs. Prints one row per mutant and exits non-zero if any is not as expected.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir, loadavg, cpus } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { corpus } from './mutants-corpus.mjs'
export { corpus }
const root = resolve(new URL('..', import.meta.url).pathname)
const latest = () => readdirSync(join(root, 'reviews')).filter((d) => /^system-v\d+$/.test(d) && existsSync(join(root, 'reviews', d, 'compositions'))).sort((a, b) => +a.slice(8) - +b.slice(8)).pop()

export function runMutant(m, base = process.env.VIZ_MUTANT_DIR ?? tmpdir()) {
  base = resolve(base)
  if (base === root || base.startsWith(root + '/')) throw new Error(`refusing to mutate inside the tree (${base})`)
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, `viz-mutant-${m.id}-`))
  try {
    for (const p of ['tools', 'src', 'project', 'fixtures', 'package.json']) cpSync(join(root, p), join(dir, p), { recursive: true })
    const rev = latest(); if (rev) cpSync(join(root, 'reviews', rev, 'compositions'), join(dir, 'reviews', rev, 'compositions'), { recursive: true })
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'))
    const f = join(dir, m.edit.file); writeFileSync(f, m.edit.edit(readFileSync(f, 'utf8')))
    const run = m.run ?? 'check', node = (args) => spawnSync('node', args, { encoding: 'utf8', cwd: dir, maxBuffer: 64 << 20 })
    let r
    if (run === 'check') r = node(['tools/check.mjs', ...(m.args ?? []), ...(m.render ? [] : ['--no-render'])])
    else if (run === 'chart') r = node(['--test', '--test-concurrency=1', 'tools/test/chart-rules.test.mjs'])
    else if (run === 'audit') { for (const s of ['tools/build.mjs', 'tools/reference.mjs']) node([s]); r = node(['tools/audit.mjs', '--quick', ...(m.args ?? [])]) }
    const out = (r.stdout ?? '') + (r.stderr ?? ''), got = r.status === 0 ? 'pass' : 'fail', expect = m.expect ?? 'fail'
    const missing = got === 'fail' ? (m.all ?? []).filter((re) => !re.test(out)) : []
    const ok = got === expect && missing.length === 0
    const first = out.split('\n').find((l) => (run === 'chart' ? /^not ok|^\s+P\d|error:/.test(l) : /^(FAIL|LITERAL)|^\s{4}\w/.test(l))) ?? ''
    return { id: m.id, what: m.what, run, expect, got, ok, missing: missing.map(String), first: first.trim() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2), opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
  const base = args.find((a, i) => !a.startsWith('--') && !['--only', '--json'].includes(args[i - 1])), only = opt('--only')?.split(',')
  const list = corpus.filter((m) => !only || only.includes(m.id)), rows = [], load = loadavg().map((x) => x.toFixed(2)).join(' ')
  for (const m of list) { const r = runMutant(m, base); rows.push(r); process.stdout.write(`\r${rows.length}/${list.length} ${m.id}${r.ok ? '' : ' NOT AS EXPECTED'}        `) }
  const esc = (s) => String(s).replace(/\|/g, '\\|').slice(0, 150)
  console.log(`\n\nload average ${load} on ${cpus().length} cores\n\n| Mutant | What was broken | Run | Expected | Result | First line the check printed |\n|---|---|---|---|---|---|`)
  for (const r of rows) console.log(`| ${r.id} | ${esc(r.what)} | ${r.run} | ${r.expect === 'fail' ? 'caught' : 'passes'} | ${r.ok ? (r.expect === 'fail' ? 'caught' : 'passes') : '**' + (r.expect === 'fail' ? (r.got === 'pass' ? 'SURVIVED' : 'CAUGHT, but not every literal: ' + r.missing.join(' ')) : 'REFUSED') + '**'} | ${esc(r.first)} |`)
  const bad = rows.filter((r) => !r.ok), groups = {}; for (const r of rows) { const g = r.id.replace(/\d+$/, ''); (groups[g] ??= [0, 0])[1]++; if (r.ok) groups[g][0]++ }
  console.log('\n' + Object.entries(groups).map(([g, [ok, n]]) => `${g}: ${ok} of ${n} as expected`).join('; '))
  console.log(bad.length ? `${bad.length} mutant(s) not as expected: ${bad.map((r) => r.id).join(', ')}` : 'Every mutant caught; every harmless edit passes.')
  if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify({ at: new Date().toISOString(), load, cores: cpus().length, rows }, null, 1))
  process.exit(bad.length ? 1 : 0)
}
