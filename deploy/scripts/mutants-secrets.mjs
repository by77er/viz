#!/usr/bin/env node
// Mutation check for the secrets the deploy generates (lib/secrets.mjs, its use in release.mjs, and
// how lib/wrangler.mjs hands a value over): AGENTS.md, "Tests must have teeth". Each mutant is one
// text replacement; `node --test test/secrets.test.mjs` must fail with it. The file is restored
// after every mutant, also on failure.
//
//   node scripts/mutants-secrets.mjs [text]   (from deploy/, in a COPY outside any git work tree;
//                                              with text, only the mutants whose name contains it)
//
// The copy needs only deploy/ with node_modules linked: the test brings its own fake wrangler and
// fake Cloudflare API, and writes its manifest under the copy's generated/.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEPLOY_DIR } from '../lib/common.mjs'

const MUTANTS = [
  ['always regenerate: a key that is set is replaced on every deploy', 'lib/secrets.mjs', '    if (rotate.has(spec.name)) toPut.push(', '    if (true) toPut.push('],
  ['skip when absent: a missing key is never created', 'lib/secrets.mjs', "    } else toPut.push({ spec, action: 'created' })", "    } else actions.push({ worker, name: spec.name, action: 'kept', versionId: current })"],
  ['the value on the command line', 'lib/secrets.mjs', "['versions', 'secret', 'put', spec.name, '--name', worker,", "['versions', 'secret', 'put', spec.name, value, '--name', worker,"],
  ['the value in the environment of wrangler', 'lib/secrets.mjs', '    let value = generateSecretValue(spec.bytes)\n', '    let value = generateSecretValue(spec.bytes)\n    process.env.VIZ_GENERATED_SECRET = value\n'],
  ['the value in the log', 'lib/secrets.mjs', '    let value = generateSecretValue(spec.bytes)\n', '    let value = generateSecretValue(spec.bytes)\n    log(`  generated ${value}`)\n'],
  ["wrangler's output not scrubbed when the put fails", 'lib/secrets.mjs', "      const tail = scrub(e.out ?? '', value)", "      const tail = String(e.out ?? '')"],
  ['a failed put is ignored and the upload promoted anyway', 'lib/secrets.mjs', '      throw new Error(`${worker}: ${scrub(e.message, value)} while putting', '      return { versionId: current, actions }\n      throw new Error(`${worker}: ${scrub(e.message, value)} while putting'],
  ['fail-closed dropped: a key set now but missing from the upload is replaced', 'lib/secrets.mjs', '    else if (seen?.known) {', '    else if (false) {'],
  ['the newest-version check dropped (the put may build on a version that is not this release)', 'lib/secrets.mjs', '    if (newest !== current) {', '    if (false) {'],
  ['a constant value instead of the CSPRNG', 'lib/secrets.mjs', "  return randomBytes(bytes).toString('base64url')", "  return Buffer.alloc(bytes, 7).toString('base64url')"],
  ['a short value (8 random bytes)', 'lib/secrets.mjs', "  return randomBytes(bytes).toString('base64url')", "  return randomBytes(8).toString('base64url')"],
  ['plan: a missing key reported as kept', 'lib/secrets.mjs', '    } else if (n.known) {', '    } else if (true) {'],
  ['phase 1: the upload is promoted instead of the keyed version', 'release.mjs', '          secretActions.push(...s.actions)\n          uploaded[step.name] = s.versionId\n', '          secretActions.push(...s.actions)\n'],
  ['phase 2: a new viz-control keeps serving the version without the key', 'release.mjs', '          if (s.versionId !== uploaded[step.name]) {', '          if (false) {'],
  ['plan mode puts the secret', 'release.mjs', '  const secrets = planSecrets(await secretsNow(specs, live, SECRET_API), rotate, plan.steps)\n',
    // Since D69 an ensureSecrets call without this run's VIZ_DEPLOY_RUN is refused before any put (the first form of this
    // mutant became equivalent), so the plan puts directly, as a careless change would.
    "  const secrets = planSecrets(await secretsNow(specs, live, SECRET_API), rotate, plan.steps)\n  for (const sc of secrets) if (sc.action === 'create') await wrangler(['versions', 'secret', 'put', sc.name, '--name', sc.worker], { input: 'p'.repeat(43), quiet: true }).catch(() => {})\n"],
  ['an unknown name to rotate is ignored instead of refused', 'release.mjs', '  const refusals = [...plan.problems, ...floors.problems, ...rotateProblems(rotate, specs)]', '  const refusals = [...plan.problems, ...floors.problems]'],
  ['lib/wrangler.mjs: the value is not written to stdin', 'lib/wrangler.mjs', '    if (input !== undefined) child.stdin.end(input)', '    if (input !== undefined) child.stdin.end()'],
  // review of D53 (design/reviews/d44-d52-d53-d60.md)
  ["m-10: a run with a secret on stdin keeps the deploy's own log settings (sanitising off, debug log on disk)", 'lib/wrangler.mjs', ", ...(input !== undefined ? SECRET_RUN_ENV : {}) },", ' },'],
  ['m-9: a key on a version newer than the serving one (left by a rollback) is not seen, and a new one is made', 'lib/secrets.mjs', '    for (const v of await api.listVersions(spec.worker)) {', '    for (const v of []) {'],
  // review of D53, m-11: another run of the same release between the check and the put
  ["m-11: the keyed version's VIZ_DEPLOY_RUN is not checked after the put (another run's upload is keyed and promoted)", 'lib/secrets.mjs', '    if (plainVar(made, RUN_VAR) !== run) {', '    if (false) {'],
  ["m-11: the newest version's VIZ_DEPLOY_RUN is not checked before the put", 'lib/secrets.mjs', '    if (plainVar(base, RUN_VAR) !== run) {', '    if (false) {'],
  ['m-11: uploads do not carry VIZ_DEPLOY_RUN', 'release.mjs', "'--tag', tag, '--message', message, ...runVar], { label: step.name })", "'--tag', tag, '--message', message], { label: step.name })"],
  ["m-11: phase 2's wrangler deploy does not carry VIZ_DEPLOY_RUN", 'release.mjs', '...doMode(manifest), ...runVar], { label: step.name })', '...doMode(manifest)], { label: step.name })'],
  // measured on Cloudflare, 2026-11-19, spike S9
  ['S9: a version just created is read once, not again until it shows', 'lib/secrets.mjs', '    if (ready(info) || waited >= budget) return info', '    return info'],
  ['S9: a rollback across the key\'s creation is not refused', 'lib/secrets.mjs', '      if (carrier && !accept.has(spec.name)) {', '      if (false) {'],
  ['S9: --accept-secret-loss is ignored (the refused rollback cannot be done on purpose)', 'lib/secrets.mjs', '      if (carrier && !accept.has(spec.name)) {', '      if (carrier) {'],
  ['S9: a rollback across a rotation is not refused (Cloudflare answers 10220 after the callers were moved)', 'lib/secrets.mjs', '    if (put) {', '    if (false) {'],
  ['S9: the secret check of a rollback is never run', 'release.mjs', '    problems.push(...secretRollbackProblems({', '    problems.push(...(() => [])({'],
  ['S9: a failed promotion restores viz-control across its own rotation', 'release.mjs', '      const back = promoted.filter((n) => !keyed.has(n))', '      const back = promoted'],
  ['a serving version that cannot be read is taken as not carrying the key', 'lib/secrets.mjs', '      if (!info) throw new Error(`${spec.worker}: serving version', '      if (!info) continue\n      if (!info) throw new Error(`${spec.worker}: serving version'],
  ['m-11: every run has the same VIZ_DEPLOY_RUN', 'release.mjs', "`gh${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT ?? 1}-` : ''}${randomUUID()}`", "`gh${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT ?? 1}-` : ''}00000000-0000-4000-8000-000000000000`"],
]

try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: DEPLOY_DIR, stdio: 'pipe' })
  console.error('Refusing to mutate sources inside a git work tree. Copy deploy/ first (see above).')
  process.exit(2)
} catch {
  // not a work tree: go on
}

const run = () => {
  try {
    execFileSync('node', ['--test', '--test-concurrency=1', 'test/secrets.test.mjs'], { cwd: DEPLOY_DIR, stdio: 'pipe', timeout: 600_000 })
    return { failed: false, detail: '' }
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    // A test file that does not load is reported under its own name: that is no test failing, not a kill.
    const names = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]).filter((n) => !/^test\/[^ ]+\.test\.mjs$/.test(n))
    // Killed means a test ran and failed; a suite that did not load or finish is reported as such.
    return { failed: names.length > 0, crashed: names.length === 0, detail: names.join(' | ') || out.split('\n').slice(-5).join(' ') }
  }
}

const base = run()
if (base.failed) {
  console.error(`the unmutated tests fail (${base.detail}); fix that first`)
  process.exit(1)
}
const only = process.argv[2]
const chosen = MUTANTS.filter(([name]) => !only || name.includes(only))
let killed = 0
for (const [name, file, from, to] of chosen) {
  const path = join(DEPLOY_DIR, file)
  const original = readFileSync(path, 'utf8')
  if (original.split(from).length !== 2) {
    console.log(`NOT APPLIED  ${name} (pattern not found exactly once in ${file})`)
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
  console.log(`${r.failed ? 'KILLED  ' : r.crashed ? 'NO RUN  ' : 'SURVIVED'}  ${name}${r.detail ? `  ← ${r.detail}` : ''}`)
}
console.log(`${killed} of ${chosen.length} killed`)
process.exit(killed === chosen.length ? 0 : 1)
