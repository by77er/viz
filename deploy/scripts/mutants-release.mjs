#!/usr/bin/env node
// Mutation check for the release tool's schema rules (contracts/COMPATIBILITY.md §6): forward-only
// marking, the rollback refusal, and what configure.mjs records (AGENTS.md, "Tests must have
// teeth"). Each mutant is one text replacement; `node --test` on the release and configure tests
// must fail with it. The file is restored after every mutant, also on failure.
//
//   node scripts/mutants-release.mjs        (from deploy/, in a COPY outside any git work tree)
//
// The copy needs deploy/ (node_modules linked) and the component sources configure.mjs reads:
// contracts/, publisher/, stack/, shard/, ledger/, control/, query/, ruler/, mcp/ (their
// wrangler.jsonc and src/).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEPLOY_DIR } from '../lib/common.mjs'

const MUTANTS = [
  ['forward-only: a migration above what the serving release knows is not marked', 'release.mjs', '      if (sc.compat <= knows) continue', '      if (true) continue'],
  ['forward-only: a serving version that declares nothing is taken to know the new version', 'release.mjs', '      const knows = declared ? declared.latest : 1', '      const knows = declared ? declared.latest : sc.latest'],
  ['forward-only: a class lifecycle change is not marked', 'release.mjs', '    if ((w.migrationTag ?? null) !== (now.migrationTag ?? null)) {', '    if (false) {'],
  ['rollback: storage newer than the target can open is accepted (canOpen dropped)', 'release.mjs', '      if (ranAt.latest <= knows || ranAt.compat <= knows) continue', '      if (true) continue'],
  ['rollback: canOpen off by one (compat one above what the target knows passes)', 'release.mjs', '      if (ranAt.latest <= knows || ranAt.compat <= knows) continue', '      if (ranAt.latest <= knows || ranAt.compat <= knows + 1) continue'],
  ['rollback: the schema check is never run', 'release.mjs', '  if (problems.length === 0) problems.push(...schemaRollbackProblems(target, await versionsSince(target, api)))\n', ''],
  ['rollback: a newer version that declares nothing is ignored', 'release.mjs', '    if (v.schemas === null) {', '    if (v.schemas === null) continue\n    if (false) {'],
  ['rollback: a record without schema versions is accepted', 'release.mjs', '  if (!target.schemas) {', '  if (false) {'],
  ['rollback: only the version serving now is judged, not every version since the target', 'release.mjs',
    '    for (const v of await api.listVersions(w.name)) {', '    const serving = ((await api.liveState([w.name]))[w.name]?.versions ?? []).map((x) => x.version_id)\n    for (const v of (await api.listVersions(w.name)).filter((x) => serving.includes(x.id))) {'],
  ['configure: a class with no declared schema is deployed', 'configure.mjs', '    if (!declared) throw new Error(', '    if (false) throw new Error('],
  ['configure: versions do not carry VIZ_SCHEMAS', 'configure.mjs', '  if (schemas.length > 0) vars[SCHEMAS_VAR] = schemasVar(schemas)\n', ''],
  ['schemas: compat recorded as the latest version', 'lib/schemas.mjs', '      compat: rel.compat,', '      compat: rel.latest,'],
]

try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: DEPLOY_DIR, stdio: 'pipe' })
  console.error('Refusing to mutate sources inside a git work tree. Copy the tree first (see above).')
  process.exit(2)
} catch {
  // not a work tree: go on
}

const run = () => {
  try {
    execFileSync('node', ['--test', 'test/release.test.mjs', 'test/configure.test.mjs'], { cwd: DEPLOY_DIR, stdio: 'pipe', timeout: 300_000 })
    return { failed: false, detail: '' }
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    const names = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1])
    return { failed: names.length > 0, detail: names.slice(0, 2).join(' | ') || out.split('\n').slice(-5).join(' ') }
  }
}

const base = run()
if (base.failed) {
  console.error(`the unmutated tests fail (${base.detail}); fix that first`)
  process.exit(1)
}
let killed = 0
for (const [name, file, from, to] of MUTANTS) {
  const path = join(DEPLOY_DIR, file)
  const original = readFileSync(path, 'utf8')
  if (!original.includes(from)) {
    console.log(`NOT APPLIED  ${name} (pattern not found in ${file})`)
    continue
  }
  writeFileSync(path, original.replace(from, to))
  let r
  try {
    r = run()
  } finally {
    writeFileSync(path, original)
  }
  if (r.failed) killed++
  console.log(`${r.failed ? 'KILLED  ' : 'SURVIVED'}  ${name}${r.detail ? `  ← ${r.detail}` : ''}`)
}
console.log(`${killed} of ${MUTANTS.length} killed`)
process.exit(killed === MUTANTS.length ? 0 : 1)
