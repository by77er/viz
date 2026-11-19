#!/usr/bin/env node
// Mutation check for the release tool's rules (contracts/COMPATIBILITY.md §6): forward-only
// marking, the rollback refusal by schema and by format version, the rollback floors a writer's
// switch raises (D69), and what configure.mjs records (AGENTS.md, "Tests must have teeth"). Each
// mutant is one text replacement; `node --test` on the release, release-checks and configure tests
// must fail with it. The file is restored after every mutant, also on failure.
//
//   node scripts/mutants-release.mjs [text]   (from deploy/, in a COPY outside any git work tree;
//                                              with text, only the mutants whose name contains it)
//
// The copy needs deploy/ (node_modules linked) and the component sources configure.mjs reads:
// contracts/, publisher/ (src/ and test/n1, test/d64), stack/, shard/, ledger/, edge/, flush/,
// compact/, janitor/, control/, query/, ruler/, mcp/ (their wrangler.jsonc and src/).
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
  ['rollback: the schema check is never run', 'release.mjs', '    problems.push(...schemaRollbackProblems(target, ran.filter((v) => schemaWorkers(target).has(v.worker))))\n', ''],
  ['rollback: a newer version that declares nothing is ignored', 'release.mjs', '    if (v.schemas === null) {', '    if (v.schemas === null) continue\n    if (false) {'],
  ['rollback: a record without schema versions is accepted', 'release.mjs', '  if (!target.schemas) {', '  if (false) {'],
  ['rollback: only the version serving now is judged, not every version since the target', 'release.mjs',
    '    for (const v of await api.listVersions(w.name)) {', '    const serving = ((await api.liveState([w.name]))[w.name]?.versions ?? []).map((x) => x.version_id)\n    for (const v of (await api.listVersions(w.name)).filter((x) => serving.includes(x.id))) {'],
  ['configure: a class with no declared schema is deployed', 'configure.mjs', '    if (!declared) throw new Error(', '    if (false) throw new Error('],
  ['configure: versions do not carry VIZ_SCHEMAS', 'configure.mjs', '  if (schemas.length > 0) vars[SCHEMAS_VAR] = schemasVar(schemas)\n', ''],
  ['schemas: compat recorded as the latest version', 'lib/schemas.mjs', '      compat: rel.compat,', '      compat: rel.latest,'],
  // review of D44 (design/reviews/d44-d52-d53-d60.md, M-1)
  ['configure: a Durable Object class of another Worker is bound without being listed in binds_classes', 'configure.mjs', "      if (!Object.hasOwn(worker.binds_classes ?? {}, `${owner}:${b.class_name}`)) {", '      if (false) {'],
  ["mcp/wrangler.jsonc: viz-mcp binds control's Tenant class again (its binding before the review)", '../mcp/wrangler.jsonc', '  "services": [\n', '  "durable_objects": { "bindings": [{ "name": "TENANT", "class_name": "Tenant", "script_name": "viz-control" }] },\n  "services": [\n'],
  ["mcp/wrangler.jsonc: viz-mcp's OAUTH binding without the entrypoint (control's default fetch instead)", '../mcp/wrangler.jsonc', '"entrypoint": "OAuthIntrospection", ', ''],
  // Format versions (D69; review of D60, m-13)
  ['formats: a release writing a version the serving release does not read is not marked forward-only', 'release.mjs',
    '      const reads = readsOf(Object.fromEntries(declaring.map((x) => [x.name, live[x.name].formats ?? {}])), f.format)\n      if (reads.includes(f.writes)) continue',
    '      const reads = readsOf(Object.fromEntries(declaring.map((x) => [x.name, live[x.name].formats ?? {}])), f.format)\n      if (true) continue'],
  ['formats rollback: the format check is never run', 'release.mjs', '    problems.push(...formatRollbackProblems(target, ran.filter((v) => fw.has(v.worker))))\n', ''],
  ['formats rollback: a version written since that the target does not read is accepted', 'release.mjs',
    '      const reads = readsOf(target.formats, format)\n      if (reads.includes(f.writes)) continue', '      const reads = readsOf(target.formats, format)\n      if (true) continue'],
  ['formats rollback: a newer version that declares no formats is ignored', 'release.mjs', '    if (v.formats === null) {', '    if (v.formats === null) continue\n    if (false) {'],
  ['formats rollback: only the versions of schema-bearing Workers are read', 'release.mjs', 'new Set([...schemaWorkers(target), ...fw, ...specs.map((sp) => sp.worker)])', 'new Set([...schemaWorkers(target), ...specs.map((sp) => sp.worker)])'],
  ["formats rollback: Workers workers.json declares formats for are not judged when the record names none (an old record)", 'release.mjs', '  for (const w of plan.workers) if (w.formats) out.add(stagedName(w.name, target.stage ?? undefined))\n', ''],
  ['formats: a release that declares nothing is taken to read every version (not version 1)', 'lib/formats.mjs', '  return reads ?? [1]', '  return reads ?? [1, 2, 3, 4, 5, 6, 7, 8, 9]'],
  ['formats: what a release reads is the union over its Workers, not what all of them read', 'lib/formats.mjs', '    reads = reads === null ? sorted(f.reads) : reads.filter((x) => f.reads.includes(x))', '    reads = sorted([...(reads ?? []), ...f.reads])'],
  ['formats: two read lists in one Worker are united, not intersected', 'lib/formats.mjs', '    e.reads = e.reads === null ? sorted(list) : e.reads.filter((x) => list.includes(x))', '    e.reads = sorted([...(e.reads ?? []), ...list])'],
  ['formats: a Worker that writes a version it does not read is accepted', 'lib/formats.mjs', '      if (e.writes !== null && !reads.includes(e.writes)) {', '      if (false) {'],
  ['formats: `read.` entries are recorded as written', 'lib/formats.mjs', '      if (format.startsWith(READ_PREFIX)) continue\n', ''],
  ['configure: versions do not carry VIZ_FORMATS', 'configure.mjs', '  if (formats.length > 0) vars[FORMATS_VAR] = formatsVar(formats)\n', ''],
  // Rollback floors of INGEST_SIGNALS (D64, D69; review of traces and logs, M-4)
  ['floors: the switch goes on while a Worker serving now is below its floor', 'lib/floors.mjs', '      if (w.serving && !atFloor(rule, w.floor, w.serving)) {', '      if (false) {'],
  ["floors: the switch goes on while one of the release's own Workers is below its floor", 'lib/floors.mjs', '      if (!atFloor(rule, w.floor, w.now)) {', '      if (false) {'],
  ['floors: with the switch off, the history is never read (older code redeployed under the data)', 'lib/floors.mjs', '    if (namesIn(value).length === 0 && workers.some((w) => !atFloor(rule, w.floor, w.now))) s.seen = await switchSeen(rule, api)\n', ''],
  ['floors rollback: the floor check is never run', 'release.mjs', '    problems.push(...(await floorRollbackProblems(rules, target, now, api)))\n', ''],
  ['floors rollback: a rollback below a floor is allowed whatever the switch did', 'lib/floors.mjs', '  if (!s.seen) return []', '  return []'],
  ['floors rollback: a Worker the record does not name is not judged', 'lib/floors.mjs', '        if (!l?.exists) continue // not in this deployment', '        continue'],
  ['floors rollback: the live state of Workers the record does not name is not read', 'release.mjs', 'await api.liveState([...new Set([...names, ...rules.flatMap((r) => r.floors.map((f) => f.worker))])])', 'await api.liveState(names)'],
  ['floors: only the newest version of the writer is looked at for the switch', 'lib/floors.mjs', '  for (const v of await api.listVersions(rule.writer)) {', '  for (const v of (await api.listVersions(rule.writer)).slice(0, 1)) {'],
  ['floors: only the signal names edge knows today count as the switch on', 'lib/floors.mjs', ".split(',').map((x) => x.trim()).filter(Boolean)", ".split(',').map((x) => x.trim()).filter((x) => x === 'traces' || x === 'logs')"],
  ['floors: a schema floor off by one (schema 3 passes a floor of 4)', 'lib/floors.mjs', '    return Number.isInteger(n) && n >= floor.atLeast', '    return Number.isInteger(n) && n >= floor.atLeast - 1'],
  ['configure: a floor is stamped without its evidence being checked', 'lib/floors.mjs', '      if (!existsSync(file) || !exportedNames(file).has(e.name)) {', '      if (false) {'],
  ['configure: versions do not carry VIZ_FLOORS', 'configure.mjs', '  if (floors.length > 0) vars[FLOORS_VAR] = floorsVar(floors)\n', ''],
  ['configure: a schema floor naming no class of its Worker is not refused', 'configure.mjs', '  checkFloorSchemas(rules, schemas)\n', ''],
  ['phase 2: a failed promotion restores the previous release across a forward-only Worker already promoted', 'release.mjs', '    } else if (crossed.length) {', '    } else if (false) {'],
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
    execFileSync('node', ['--test', '--test-concurrency=2', 'test/release.test.mjs', 'test/release-checks.test.mjs', 'test/configure.test.mjs'], { cwd: DEPLOY_DIR, stdio: 'pipe', timeout: 600_000 })
    return { failed: false, detail: '' }
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    const names = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1])
    // Killed means a test ran and failed; a suite that did not load or finish is reported as such.
    return { failed: names.length > 0, crashed: names.length === 0, count: names.length, detail: names.slice(0, 2).join(' | ') || out.split('\n').slice(-5).join(' ') }
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
  console.log(`${r.failed ? `KILLED (${r.count})` : r.crashed ? 'NO RUN  ' : 'SURVIVED'}  ${name}${r.detail ? `  ← ${r.detail}` : ''}`)
}
console.log(`${killed} of ${chosen.length} killed`)
process.exit(killed === chosen.length ? 0 : 1)
