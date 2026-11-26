// Mutation check for the janitor's registration-before-writes changes (D61; spec/README.md F16
// and F15): break one at a time, run the tests that should notice, expect them to FAIL, restore.
// The older janitor mutants are in stack/scripts/mutants.mjs (`npm run mutants`).
//   node scripts/mutants.mjs [substring of a mutant name]       (from janitor/, in a COPY)
//   node scripts/mutants.mjs --check                             only check that every pattern applies
//
// AGENTS.md (Evidence): never in place in the shared checkout; the script refuses to run inside
// a git checkout. Copy `contracts/`, `janitor/`, `shard/`, `ledger/`, `flush/`, `compact/`,
// `publisher/` and `engine/wasm/` (each with a link to its node_modules) elsewhere.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const check = process.argv[2] === '--check'
if (!check && existsSync(`${ROOT}.git`)) {
  console.error(`mutants: ${ROOT} is a git checkout. Run this on a copy in a scratch directory (AGENTS.md, Evidence).`)
  process.exit(2)
}

const F = 'src/janitor.ts'
const T = { registration: 'npx vitest run --maxWorkers=2 test/registration.test.ts', signals: 'npx vitest run --maxWorkers=2 test/signals.test.ts' }
// [name, file, from, to, tests]
const mutants = [
  ['D61: the sweep counts a committed incarnation (F15 back)', F, '  const newer = w.loggedIncarnation !== undefined ? w.loggedIncarnation > inc : w.incarnation > inc && w.seq > 0', '  const newer = w.incarnation > inc', T.registration],
  ["D61: the sweep keeps D30's rule (a logged unit of the newer incarnation; F16 back)", F, '  const newer = w.loggedIncarnation !== undefined ? w.loggedIncarnation > inc : w.incarnation > inc && w.seq > 0', '  const newer = w.incarnation > inc && w.seq > 0', T.registration],
  ['D61: the sweep skips ensureStream (F16 back)', F, '  if (env.SHARD) {', '  if (false) {', T.registration],
  ['D61: a shard without ensureStream stops the sweep (m-6)', F, '        out.ensured.push({ shard, error: why })', '        throw e', T.registration],
  // review m-1 (design/reviews/signals-end-to-end.md): an unreadable trace_days or log_days stops that signal only
  ['m-1: an unreadable signal field refuses the whole record, metrics included (the fix undone)', F, "  return { status: 'ok', policy, source: 'record', ...(reasons.length ? { unreadable: reasons } : {}) }", "  if (reasons.length) return unreadable(reasons[0]!)\n  return { status: 'ok', policy, source: 'record' }", T.signals],
  ['m-1: an unreadable signal field falls back to the default (fails open)', F, '    reasons.push(`${k} is ${JSON.stringify(x)}, not a positive integer`)\n    return null', '    return DEFAULT_SIGNAL_DAYS', T.signals],
  ['m-1: an unreadable signal is expired as if it kept no days', F, '    if (keepDays === null) continue\n', '', T.signals],
  ['m-1: only trace_days is checked; a bad log_days is taken as a number or the default', F, "log_days: signal('log_days') }", "log_days: typeof (rec as Record<string, unknown>).log_days === 'number' ? ((rec as Record<string, unknown>).log_days as number) : DEFAULT_SIGNAL_DAYS }", T.signals],
  ['m-1: a partly unreadable record is not reported (no hourly look, no marker)', F, '  if (read.unreadable) {', '  if (false) {', T.signals],
]

const only = check ? undefined : process.argv[2]
let survived = 0
let missing = 0
for (const [name, file, from, to, tests] of mutants) {
  if (only && !name.includes(only)) continue
  const path = `${ROOT}janitor/${file}`
  const original = readFileSync(path, 'utf8')
  if (!original.includes(from)) {
    console.log(`NOT APPLIED  ${name} (pattern not found in ${file})`)
    missing++
    continue
  }
  if (check) continue
  writeFileSync(path, original.replace(from, to))
  let failed = false
  let detail = ''
  try {
    execSync(tests, { cwd: `${ROOT}janitor`, stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
  } catch (e) {
    failed = true
    const out = String(e.stdout) + String(e.stderr)
    detail = [...out.matchAll(/^\s+× (.+?)(?: \d+ms)?$/gm)].map((m) => m[1]).slice(0, 2).join(' | ') || (out.match(/Error: .*/)?.[0] ?? '')
  } finally {
    writeFileSync(path, original)
  }
  if (!failed) survived++
  console.log(`${failed ? 'KILLED  ' : 'SURVIVED'}  ${name}${detail ? `  ← ${detail}` : ''}`)
}
if (check) {
  console.log(missing === 0 ? `all ${mutants.length} patterns apply` : `${missing} pattern(s) do not apply`)
  process.exit(missing === 0 ? 0 : 1)
}
console.log(survived + missing === 0 ? 'all mutants killed' : `${survived} survived, ${missing} not applied`)
process.exit(survived + missing === 0 ? 0 : 1)
