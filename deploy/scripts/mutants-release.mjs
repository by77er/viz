#!/usr/bin/env node
// Mutation check for the release tool's rules (contracts/COMPATIBILITY.md §6): forward-only
// marking, the rollback refusal by schema and by format version, the rollback floors a writer's
// switch raises (D69), what configure.mjs records, and the fixes of the review of D69 (M-1, M-2,
// m-2, m-3, m-8), D70's gate in configure.mjs, the oauth-public floor and the Rate Limiting ids of
// resources.mjs (AGENTS.md, "Tests must have teeth"). Each mutant is one text replacement; `node
// --test` on the release, release-checks, configure, review-d69, workflow, oauth-gate, resources and
// upgrade-production tests must fail with it.
// The file is restored after every mutant, also on failure.
//
//   node scripts/mutants-release.mjs [text]   (from deploy/, in a COPY outside any git work tree;
//                                              with text, only the mutants whose name contains it)
//
// The copy needs deploy/ (node_modules linked), .github/workflows/ and the component sources
// configure.mjs reads: contracts/, publisher/ (src/ and test/n1, test/d64), stack/, shard/, ledger/,
// edge/, flush/, compact/, janitor/, control/, query/, ruler/, mcp/ (their wrangler.jsonc and src/).
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
    '      if (r.reads === null || r.reads.includes(f.writes)) continue // nothing serving reads it', '      if (true) continue // nothing serving reads it'],
  ['formats rollback: the format check is never run', 'release.mjs', '    problems.push(...formatRollbackProblems(target, ran.filter((v) => fw.has(v.worker)), { left }))\n', ''],
  ['formats rollback: a version written since that the target does not read is accepted', 'release.mjs',
    '      if (r.reads === null || r.reads.includes(f.writes)) continue\n      problems.push(\n        `${format}: release', '      if (true) continue\n      problems.push(\n        `${format}: release'],
  ['formats rollback: a newer version that declares no formats is ignored', 'release.mjs', '    if (v.formats === null) {\n      problems.push(`${v.worker}: version ${v.versionId}', '    if (v.formats === null) continue\n    if (false) {\n      problems.push(`${v.worker}: version ${v.versionId}'],
  ['M-1: a kept version of a Worker left out that declares no formats is ignored', 'release.mjs', '    if (v.formats === null) {\n      problems.push(`${v.worker}: this rollback leaves it serving', '    if (v.formats === null) continue\n    if (false) {\n      problems.push(`${v.worker}: this rollback leaves it serving'],
  ['formats rollback: only the versions of schema-bearing Workers are read', 'release.mjs', 'new Set([...schemaWorkers(target), ...fw, ...specs.map((sp) => sp.worker)])', 'new Set([...schemaWorkers(target), ...specs.map((sp) => sp.worker)])'],
  ["formats rollback: Workers workers.json declares formats for are not judged when the record names none (an old record)", 'release.mjs', '  for (const w of plan.workers) if (w.formats?.writes?.length) out.add(stagedName(w.name, target.stage ?? undefined))\n', ''],
  ['formats: a release that declares nothing is taken to read every version (not version 1)', 'lib/formats.mjs', '  if (formatsByWorker === null || formatsByWorker === undefined) return { reads: [1],', '  if (formatsByWorker === null || formatsByWorker === undefined) return { reads: [1, 2, 3, 4, 5, 6, 7, 8, 9],'],
  ['formats: what a release reads is the union over its Workers, not what all of them read', 'lib/formats.mjs', '    reads = reads === null ? sorted(f.reads) : reads.filter((x) => f.reads.includes(x))', '    reads = sorted([...(reads ?? []), ...f.reads])'],
  ['formats: two read lists in one Worker are united, not intersected', 'lib/formats.mjs', '    e.reads = e.reads === null ? sorted(list) : e.reads.filter((x) => list.includes(x))', '    e.reads = sorted([...(e.reads ?? []), ...list])'],
  ['formats: a Worker that writes a version it does not read is accepted', 'lib/formats.mjs', '      if (e.writes !== null && !reads.includes(e.writes)) {', '      if (false) {'],
  ['formats: `read.` entries are recorded as written', 'lib/formats.mjs', '      if (format.startsWith(READ_PREFIX)) continue\n', ''],
  ['configure: versions do not carry VIZ_FORMATS', 'configure.mjs', '  if (formatsDeclared) vars[FORMATS_VAR] = formatsVar(formats)\n', ''],
  // Rollback floors of INGEST_SIGNALS (D64, D69; review of traces and logs, M-4)
  ['floors: the switch goes on while a Worker serving now is below its floor', 'lib/floors.mjs', "      if (w.serving && !atFloor(rule, w.floor, w.serving) && !(w.now && rule.servingBelow === 'forward-only')) {", '      if (false) {'],
  ["floors: the switch goes on while one of the release's own Workers is below its floor", 'lib/floors.mjs', '      if (w.now && !atFloor(rule, w.floor, w.now)) {', '      if (false) {'],
  ['floors: with the switch off, the history is never read (older code redeployed under the data)', 'lib/floors.mjs', '    if (namesIn(value).length === 0 && workers.some((w) => w.now && !atFloor(rule, w.floor, w.now))) s.seen = await switchSeen(rule, api)\n', ''],
  ['floors rollback: the floor check is never run', 'release.mjs', '    problems.push(...(await floorRollbackProblems(rules, target, now, api)))\n', ''],
  ['floors rollback: a rollback below a floor is allowed whatever the switch did', 'lib/floors.mjs', '  if (!s.seen) return []', '  return []'],
  ['floors rollback: a Worker the record does not name is not judged', 'lib/floors.mjs', '        if (!l?.exists) continue // not in this deployment', '        continue'],
  ['floors rollback: the live state of Workers the record does not name is not read', 'release.mjs', 'await api.liveState([...new Set([...names, ...deployment, ...rules.flatMap((r) => r.floors.map((f) => f.worker))])])', 'await api.liveState(names)'],
  ['floors: only the newest version of the writer is looked at for the switch', 'lib/floors.mjs', '  for (const v of await api.listVersions(rule.writer)) {', '  for (const v of (await api.listVersions(rule.writer)).slice(0, 1)) {'],
  ['floors: only the signal names edge knows today count as the switch on', 'lib/floors.mjs', ".split(',').map((x) => x.trim()).filter(Boolean)", ".split(',').map((x) => x.trim()).filter((x) => x === 'traces' || x === 'logs')"],
  ['floors: a schema floor off by one (schema 3 passes a floor of 4)', 'lib/floors.mjs', '    return Number.isInteger(n) && n >= floor.atLeast', '    return Number.isInteger(n) && n >= floor.atLeast - 1'],
  ['configure: a floor is stamped without its evidence being checked', 'lib/floors.mjs', '      if (!existsSync(file) || !exportedNames(file).has(e.name)) {', '      if (false) {'],
  ['configure: versions do not carry VIZ_FLOORS', 'configure.mjs', '  if (floors.length > 0) vars[FLOORS_VAR] = floorsVar(floors)\n', ''],
  ['configure: a schema floor naming no class of its Worker is not refused', 'configure.mjs', '  checkFloorSchemas(rules, schemas)\n', ''],
  ['phase 2: a failed promotion restores the previous release across a forward-only Worker already promoted', 'release.mjs', '    } else if (crossed.length) {', '    } else if (false) {'],
  // Review of D69 (design/reviews/d69-deploy-safety.md): M-1, format rollbacks and the Workers a record leaves out
  ['M-1: the Workers a record leaves out are not judged (their versions never read)', 'release.mjs', '    const left = await versionsLeftServing(full, [...fw].filter((n) => !names.includes(n) && now[n]?.exists), now, api)', '    const left = []'],
  ['M-1: a Worker left out is judged by its serving version only, not by every kept version since the record', 'release.mjs', '      if (!serving.has(v.id) && boundNumber !== null && v.number !== undefined && v.number <= boundNumber) continue', '      if (!serving.has(v.id)) continue'],
  ["M-1: a Worker left out is judged against its own record entry too (the record's formats, not the restored Workers)", 'release.mjs', '  const readers = target.formats ? recordReaders(target, restored) : null', '  const readers = target.formats ? recordReaders(target, Object.keys(target.formats)) : null'],
  ['M-1 (c): a Worker that declares nothing reads nothing (not version 1 of every format)', 'lib/formats.mjs', '      f = V1\n      undeclared.push(worker)', '      continue'],
  ["M-1 (c): forward-only asks only the serving Workers that declare formats", 'release.mjs', '.filter(([, l]) => l?.exists).map(([n, l]) => [n, l.formats ?? null]))', '.filter(([, l]) => l?.exists && l.formats).map(([n, l]) => [n, l.formats]))'],
  ["M-1 (c): a version's declaration from before they were complete is taken as complete", 'lib/formats.mjs', '  if (v.complete !== true) out[ANY] = V1\n', ''],
  ["M-1 (c): a record from before declarations were complete is taken as complete", 'lib/formats.mjs', 'complete || f[ANY] ? f : { ...f, [ANY]: V1 }', 'f'],
  ['M-1 (c): configure deploys a Worker that declares no formats', 'configure.mjs', '    if (w.deploy !== false && w.formats === undefined) {', '    if (false) {'],
  ['M-1 (c): a Worker that declares none carries no VIZ_FORMATS (a rollback takes it to read version 1 of everything)', 'configure.mjs', '  if (formatsDeclared) vars[FORMATS_VAR] = formatsVar(formats)', '  if (formats.length > 0) vars[FORMATS_VAR] = formatsVar(formats)'],
  ['M-1 (c): reads_v1 is not read (those formats are taken as not read)', 'lib/formats.mjs', "    if (s.kind === 'reads_of' || s.kind === 'reads_v1') return readList(s.worker, s.format, v, where)", "    if (s.kind === 'reads_v1') return\n    if (s.kind === 'reads_of') return readList(s.worker, s.format, v, where)"],
  ['M-1 (c): workers.json no longer declares that viz-query reads kv.pool', 'workers.json', '          "kv.pool": "edge/src/route.ts: pool:<tenant>, which shards a query asks",\n', ''],
  // M-2: only main, with main's own tooling
  ["M-2: the deploy job's gate lets any ref through", '../.github/workflows/deploy.yml', '            exit 1\n          fi\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:', '            true\n          fi\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:'],
  ["M-2: the rollback job's gate lets any ref through", '../.github/workflows/deploy.yml', "            exit 1\n          fi\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - uses: actions/setup-node", "            true\n          fi\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - uses: actions/setup-node"],
  // m-2, m-3, m-8
  ['m-2: a switch set as a secret is not seen', 'lib/floors.mjs', "  return SECRET_TYPES.has(b.type) ? '(a secret)' :", '  return SECRET_TYPES.has(b.type) ? null :'],
  ['m-2: a switch set as a JSON var is not seen', 'lib/floors.mjs', "  if (b.type === 'json') return", "  if (b.type === 'json') return null\n  if (false) return"],
  ['m-2: a release goes ahead while the switch is a secret on the writer', 'lib/floors.mjs', '  if (s.secret) {', '  if (false) {'],
  ['m-3: a floor Worker this release does not deploy is not judged at switch-on', 'lib/floors.mjs', '        if (!manifest.order.includes(floor.worker)) return serving ? { floor, now: null, serving } : null', '        if (!manifest.order.includes(floor.worker)) return null'],
  ['m-8: --only is ignored (the whole record is restored)', 'release.mjs', '  const target = restrictRecord(full, only, stage)', '  const target = full'],
  // D70's gate in configure.mjs (review of D70, M-2, m-8)
  ['D70 gate: production viz-control without its bindings is not refused', 'configure.mjs', '  if (missing.length) {\n    throw new Error(', '  if (false) {\n    throw new Error('],
  ['D70 gate: a period other than the source\'s (10) is accepted', 'configure.mjs', '    if (simple.period !== gate.period) throw', '    if (false) throw'],
  ['D70 gate: a limit that is not a positive integer is accepted', 'configure.mjs', '    if (!Number.isInteger(simple.limit) || simple.limit < 1) throw', '    if (false) throw'],
  ['D70 gate: a binding name control does not list is accepted', 'configure.mjs', '    if (!gate.required.includes(r.name)) throw', '    if (false) throw'],
  ['D70 gate: two bindings of viz-control with one id are accepted', 'configure.mjs', '      if (seenIds.has(r.namespace_id)) throw', '      if (false) throw'],
  ['D70 gate: an id outside viz\'s range is accepted', 'configure.mjs', " || Number(id) < range.from || Number(id) > range.to) throw", ') throw'],
  ['D70 gate: a stage is given production\'s ids (keyed by the canonical name)', 'configure.mjs', '    const key = `${out.name}/${r.name}`', '    const key = `${worker.name}/${r.name}`'],
  ['D70 gate: a missing id becomes a placeholder without --ids-optional', 'configure.mjs', "      if (!idsOptional) throw new Error(`no namespace_id recorded for ${key}", "      if (false) throw new Error(`no namespace_id recorded for ${key}"],
  ['D70 gate: --oauth-without-rate-limits is accepted for production by generateWorker', 'configure.mjs', "    if (!stage) throw new Error('--oauth-without-rate-limits is for a stage only", "    if (false) throw new Error('--oauth-without-rate-limits is for a stage only"],
  ['D70 gate: a Worker without an oauth gate may carry ratelimits', 'configure.mjs', '    if (list?.length) throw new Error(`${where}: "ratelimits", but', '    if (false) throw new Error(`${where}: "ratelimits", but'],
  ['configure: OAUTH_PUBLIC is not set on a production viz-control', 'configure.mjs', '  if (oauth && (!stage || oauthPublic)) {', '  if (oauth && oauthPublic) {'],
  ['configure: OAUTH_PUBLIC is set on every stage, asked or not', 'configure.mjs', '  if (oauth && (!stage || oauthPublic)) {', '  if (oauth) {'],
  ['configure: a component or VIZ_STAGE_VARS may set OAUTH_PUBLIC', 'configure.mjs', '  if (gate && (Object.hasOwn(cfg.vars ?? {}, gate.publicVar)', '  if (false && (Object.hasOwn(cfg.vars ?? {}, gate.publicVar)'],
  ['m-8: placement is not refused on viz-control and viz-mcp', 'configure.mjs', '  if (worker.no_placement !== undefined && cfg.placement !== undefined) throw', '  if (false) throw'],
  ["m-8: workers.json no longer marks viz-mcp no_placement", 'workers.json', '      "no_placement": "viz-mcp\'s OAuth bearers', '      "placement_note": "viz-mcp\'s OAuth bearers'],
  // The oauth-public floor (D69 point 6)
  ['oauth-public: a release over a viz-control serving below the floor is refused (serving_below_floor ignored)', 'lib/floors.mjs', " && !(w.now && rule.servingBelow === 'forward-only')", ''],
  ['oauth-public: such a release is not marked forward-only', 'lib/floors.mjs', '    forwardOnly.push(...floorForwardOnly(rule, s))\n', ''],
  ['oauth-public: the deploy drops the floor\'s forward-only reasons', 'release.mjs', '  const forwardOnly = [...forwardOnlyReasons(manifest, before), ...floors.forwardOnly]', '  const forwardOnly = forwardOnlyReasons(manifest, before)'],
  ['oauth-public: workers.json no longer says forward-only (the 2026-11-19 production is refused)', 'workers.json', '      "serving_below_floor": "forward-only",\n', ''],
  ['oauth-public: the evidence of D70 round 3 (LISTED) dropped from the floor', 'workers.json', '            "control/src/deadlist.ts#recordDead",\n            "control/src/ratelimit.ts#LISTED"\n', '            "control/src/deadlist.ts#recordDead"\n'],
  ['deploy.sh: a release forward-only for a floor is rolled back automatically', 'deploy.sh', 'f.kind==="format"||f.kind==="floor"', 'f.kind==="format"'],
  ['release: a manifest configured --ids-optional is deployed', 'release.mjs', '(manifest.idsOptional === true ? [', '(false ? ['],
  // Rate Limiting namespace ids (resources.mjs)
  ['ids: an id a script that is not viz\'s binds is not excluded', 'resources.mjs', 'for (const s of scripts) if (!ourScripts.has(s)) takenBy.set(id, s)', 'for (const s of scripts) if (!ourScripts.has(s) && s.startsWith(\'viz-\')) takenBy.set(id, s)'],
  ['ids: another deployment\'s recorded ids are not excluded', 'resources.mjs', "  for (const [key, id] of Object.entries(recorded)) if (!mine.has(key) && !takenBy.has(String(id)))", "  for (const [key, id] of Object.entries(recorded)) if (false)"],
  ['ids: a kept id is reused although another script binds it', 'resources.mjs', '      if (free(id)) {\n        kept = id', '      if (inRange(id)) {\n        kept = id'],
  ['ids: the scan reads the serving versions only, not the newest', 'resources.mjs', '    const ids = [...new Set([...serving, ...(newest ? [newest] : [])])]', '    const ids = [...new Set(serving)]'],
  ['ids: a Rate Limiting binding whose id cannot be read is skipped', 'resources.mjs', "    if (!(typeof id === 'string' || Number.isInteger(id)) || !/^\\d+$/.test(String(id))) throw", "    if (!(typeof id === 'string' || Number.isInteger(id)) || !/^\\d+$/.test(String(id))) continue\n    if (false) throw"],
  ['ids: the deployment\'s own bound ids are not kept (re-allocated)', 'resources.mjs', '    const bound = inUse.byScript.get(w.worker)?.[w.name]', '    const bound = undefined'],
  ['ids: destroy --stage does not free the stage\'s ids', 'resources.mjs', '  if (keys.length) recordRateLimits(keys, {})\n', ''],
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
    execFileSync('node', ['--test', '--test-concurrency=2', 'test/release.test.mjs', 'test/release-checks.test.mjs', 'test/configure.test.mjs', 'test/review-d69.test.mjs', 'test/workflow.test.mjs', 'test/oauth-gate.test.mjs', 'test/resources.test.mjs', 'test/upgrade-production.test.mjs'], { cwd: DEPLOY_DIR, stdio: 'pipe', timeout: 900_000 })
    return { failed: false, detail: '' }
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    // A test file that does not load is reported under its own name: that is no test failing, not a kill.
    const names = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]).filter((n) => !/^test\/[^ ]+\.test\.mjs$/.test(n))
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
// `re:<pattern>` chooses the mutants whose name matches a regular expression.
const chosen = MUTANTS.filter(([name]) => !only || (only.startsWith('re:') ? new RegExp(only.slice(3)).test(name) : name.includes(only)))
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
