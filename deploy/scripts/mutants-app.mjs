#!/usr/bin/env node
// Mutation check for the web app's path from its sources to a release (design/DECISIONS.md D74;
// AGENTS.md, "Tests must have teeth"): what lib/app.mjs reads, stages and refuses; what app.mjs
// builds and keeps; what configure.mjs generates; the gate in release.mjs; the smoke test's check;
// deploy.sh's order; the CI matrix. Each mutant is one text replacement; `node --test` on the app,
// app-serve, configure, matrix and workflow tests must fail with it. The file is restored after
// every mutant, also on failure. (The Worker's own part, gateway/src/index.ts, is mutated by
// gateway/scripts/mutants.mjs under vitest; the few of its mutants here are those the local
// workerd run, test/app-serve.test.mjs, must catch by itself.)
//
//   node scripts/mutants-app.mjs [text]     (from deploy/, in a COPY outside any git work tree;
//                                            with text, only the mutants whose name contains it;
//                                            `re:<pattern>` for a regular expression)
//
// The copy needs deploy/ (node_modules linked), .github/workflows/, app/ (serve.json, package.json,
// scripts/), design-system/ (package.json, tools/check.mjs) and the component sources
// configure.mjs reads (see scripts/mutants-release.mjs).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEPLOY_DIR } from '../lib/common.mjs'

const L = 'lib/app.mjs'
const MUTANTS = [
  // ── a missing, stale or altered build is released ──
  ['release: the app gate is not asked at deploy', 'release.mjs', "  refusals.push(...appProblems(manifest, loadWorkersPlan()))\n", ''],
  ['release: the app gate is not asked by plan', 'release.mjs', "...keyGateRefusals(keyGateProblems(manifest, configOfGenerated), secrets), ...appProblems(manifest, loadWorkersPlan())]", '...keyGateRefusals(keyGateProblems(manifest, configOfGenerated), secrets)]'],
  ['release: a manifest that says nothing of the app is released (the gateway goes out with no app)', 'release.mjs', "  if (!w.app || w.app.notBuilt === true || typeof w.app.build !== 'string') {", '  if (!w.app) return []\n  if (w.app.notBuilt === true) {'],
  ['release: a manifest whose build was left out is released', 'release.mjs', "  if (!w.app || w.app.notBuilt === true || typeof w.app.build !== 'string') {", "  if (w.app?.notBuilt === true) return []\n  if (!w.app || typeof w.app.build !== 'string') {"],
  ['release: production may go without the app', 'release.mjs', "    if (!stage || manifest.withoutApp !== true) return [`${w.name}: its manifest entry says", "    if (false) return [`${w.name}: its manifest entry says"],
  ['release: a stage goes without the app although it was not configured so', 'release.mjs', '    if (!stage || manifest.withoutApp !== true) return [', '    if (!stage) return ['],
  ['release: a stage "without the app" may still upload assets', 'release.mjs', "    return carries.length ? [`${w.name}: configured --without-app, but its generated config carries ${carries.join(', ')}`] : []", '    return []'],
  ['release: the config\'s `assets` is not compared with the staged build', 'release.mjs', "  if (JSON.stringify(cfg.assets ?? null) !== JSON.stringify(want)) out.push(", '  if (false) out.push('],
  ['release: the config\'s VIZ_APP is not compared with the staged build', 'release.mjs', '  for (const k of [APP_VAR, APP_FILES_VAR]) if ((cfg.vars ?? {})[k] !== stamp.vars[k]) out.push(', '  for (const k of [APP_FILES_VAR]) if ((cfg.vars ?? {})[k] !== stamp.vars[k]) out.push('],
  ['release: the manifest\'s build is not compared with the staged one', 'release.mjs', '  if (stamp.build.hash !== w.app.build) out.push(', '  if (false) out.push('],
  ['stamp: a missing stamp is no problem', L, '  if (!stamp) return { stamp: null, problems: [`the app has not been built for this release', '  if (!stamp) return { stamp: null, problems: [] }\n  if (false) return { stamp: null, problems: [`the app has not been built for this release'],
  ['stamp: another release\'s build is accepted (stale)', L, '  if (stamp.release !== release) problems.push(', '  if (false) problems.push('],
  ['stamp: another target\'s build is accepted', L, '  if (stamp.target !== target) problems.push(', '  if (false) problems.push('],
  ['stamp: the sources are not compared with what was built (stale)', L, '    if (hashSources(repoRoot, now.files) !== stamp.sources.hash) problems.push(', '    if (false) problems.push('],
  ['stamp: serve.json is not compared with what the build was staged by', L, '    if (serve.sha256 !== stamp.serve.sha256) problems.push(', '    if (false) problems.push('],
  ['stamp: the staged directory is not compared with what was stamped (altered)', L, '  else if (staged.hash !== stamp.staged.hash) problems.push(', '  else if (false) problems.push('],
  ['stamp: a missing staged directory is accepted', L, '  if (!staged) problems.push(`the staged app build', '  if (false) problems.push(`the staged app build'],
  ['stamp: a build handed in is accepted for production', L, "  if (!stage && stamp.via !== 'export') problems.push(", '  if (false) problems.push('],
  ['stamp: production at another commit than the release is accepted', L, '    if (now.commit !== release) problems.push(', '    if (false) problems.push('],
  ['stamp: production with sources changed from the release\'s commit is accepted', L, '    else if (now.dirty) problems.push(', '    else if (false) problems.push('],
  ['stamp: the hash of the staged directory leaves out _headers', L, "  const files = filesUnder(dir)\n  for (const rel of files) {", "  const files = filesUnder(dir).filter((f) => f !== '_headers')\n  for (const rel of files) {"],
  ['sources: the hash covers file names only, not contents', L, "  for (const p of files) h.update(`${p}\\0${sha256(readFileSync(join(root, p)))}\\n`)", "  for (const p of files) h.update(`${p}\\n`)"],
  ['sources: untracked files are not sources (a new file changes nothing)', L, "['ls-files', '-co', '--exclude-standard', '-z', '--', ...dirs]", "['ls-files', '-c', '-z', '--', ...dirs]"],
  ['sources: ignored, generated files are sources (and are exported into the build)', L, "['ls-files', '-co', '--exclude-standard', '-z', '--', ...dirs]", "['ls-files', '-co', '-z', '--', ...dirs]"],
  ['sources: what no build reads is hashed and exported (review images)', L, '  const excluded = (p) => app.notBuiltFrom.some((x) => p === x || p.startsWith(`${x}/`))', '  const excluded = () => false'],
  ['build: production is built whatever commit the checkout is at', 'app.mjs', "    if (listed.commit !== release) throw new Error(", '    if (false) throw new Error('],
  ['build: production is built from changed sources', 'app.mjs', "    if (listed.dirty) throw new Error(", '    if (false) throw new Error('],
  ['build: production takes a build made elsewhere (--dist)', 'app.mjs', "    if (!stage) throw new Error('--dist is for a stage only", "    if (false) throw new Error('--dist is for a stage only"],
  ['build: a build handed in is stamped as built here', 'app.mjs', "    via = 'prebuilt'", "    via = 'export'"],
  ['build: the app is built in the checkout, not in an export', L, "  run('npm', ['run', 'build'], join(out, app.dir))\n  const dist = join(out, app.dir, 'dist')", "  run('npm', ['run', 'build'], join(repoRoot, app.dir))\n  const dist = join(repoRoot, app.dir, 'dist')"],
  ['build: a failed build command is not a failure', L, "  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd} (exit ${r.status ?? r.signal})`)", '  void r'],
  ['deploy.sh: the app is not built (configure meets whatever generated/ holds)', 'deploy.sh', '  APP_BUILT=$(node deploy/app.mjs build ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"} --release "$VIZ_RELEASE_SHA" ${APP_ARGS[@]+"${APP_ARGS[@]}"})', '  APP_BUILT=\'{"build":"000000000000","files":0,"kept":0,"dropped":0}\''],
  ['deploy.sh: a failed app build does not stop the deploy', 'deploy.sh', '  APP_BUILT=$(node deploy/app.mjs build ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"} --release "$VIZ_RELEASE_SHA" ${APP_ARGS[@]+"${APP_ARGS[@]}"})', '  APP_BUILT=$(node deploy/app.mjs build ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"} --release "$VIZ_RELEASE_SHA" ${APP_ARGS[@]+"${APP_ARGS[@]}"} || true)'],
  ['deploy.sh: production may be deployed without the app (VIZ_WITHOUT_APP)', 'deploy.sh', '  [ -n "$STAGE" ] || { echo "VIZ_WITHOUT_APP=1 is for a stage only: production serves the web app (D74)" >&2; exit 1; }\n', ''],
  // ── what configure.mjs generates ──
  ['configure: production may be configured --without-app', 'configure.mjs', "  if (withoutApp && !stage) throw new Error('--without-app is for a stage only: production serves the web app (D74)')\n", ''],
  ['configure: a build that cannot be released is left out silently (the gateway is configured without the app)', 'configure.mjs', "    if (idsOptional) return { notBuilt: true, why: problems[0] }", "    if (idsOptional || true) return { notBuilt: true, why: problems[0] }"],
  ['configure: the staged build is not verified (a stale or altered one is configured)', 'configure.mjs', '    if (problems.length === 0) return { stamp, dir: stagedDir(outDir) }', '    if (stamp) return { stamp, dir: stagedDir(outDir) }'],
  ['configure: a component may set VIZ_APP itself', 'configure.mjs', "  for (const k of [APP_VAR, APP_FILES_VAR]) if (Object.hasOwn(cfg.vars ?? {}, k) || Object.hasOwn(extraVars, k)) throw", "  for (const k of [APP_FILES_VAR]) if (Object.hasOwn(cfg.vars ?? {}, k) || Object.hasOwn(extraVars, k)) throw"],
  ['configure: a component\'s own `assets` is deployed as written', 'configure.mjs', "'workers_dev', 'preview_urls', 'ratelimits',\n])", "'workers_dev', 'preview_urls', 'ratelimits', 'assets',\n])"],
  ['configure: the gateway is given the build but not the document (no VIZ_APP)', 'configure.mjs', '    vars[APP_VAR] = app.stamp.vars[APP_VAR]\n', ''],
  ['configure: the gateway is given the document but no assets', 'configure.mjs', '    out.assets = assetsConfig(relative(outDir, app.dir))\n', ''],
  // ── how the build is served ──
  ['assets: a single-page fallback (an unknown path gets index.html from the asset layer)', L, "html_handling: 'none', not_found_handling: 'none', run_worker_first: false }", "html_handling: 'none', not_found_handling: 'single-page-application', run_worker_first: false }"],
  ['assets: the Worker first except under /assets/ (a missing asset is then Cloudflare\'s 404 with the asset headers: kept for good)', L, "html_handling: 'none', not_found_handling: 'none', run_worker_first: false }", "html_handling: 'none', not_found_handling: 'none', run_worker_first: ['/*', '!/assets/*'] }"],
  ['assets: HTML handling on (redirects, index.html at /)', L, "  return { directory, html_handling: 'none',", "  return { directory, html_handling: 'auto-trailing-slash',"],
  ['staging: index.html is staged among the assets (served at /index.html without the policy)', L, "  writeFileSync(join(outDir, '_headers'), headersFile(serve))\n  return hashStaged(outDir)", "  writeFileSync(join(outDir, '_headers'), headersFile(serve))\n  cpSync(join(dist, 'index.html'), join(outDir, 'index.html'))\n  return hashStaged(outDir)"],
  ['staging: no _headers (assets get Cloudflare\'s default: revalidated on every load, the uploader\'s content type)', L, "  writeFileSync(join(outDir, '_headers'), headersFile(serve))\n  return hashStaged(outDir)", "  return hashStaged(outDir)"],
  ['_headers: the assets are not kept for good', L, '  block(`${serve.assetsPrefix}*`, serve.headers.asset)', "  block(`${serve.assetsPrefix}*`, { ...serve.headers.asset, 'Cache-Control': 'public, max-age=0, must-revalidate' })"],
  ['_headers: the assets\' other headers are left out (nosniff)', L, '  block(`${serve.assetsPrefix}*`, serve.headers.asset)', "  block(`${serve.assetsPrefix}*`, { 'Cache-Control': serve.headers.asset['Cache-Control'] })"],
  ['_headers: no content types (the uploader\'s guess is served)', L, "  for (const [ext, type] of Object.entries(serve.contentTypes)) block(`${serve.assetsPrefix}*${ext}`, { 'Content-Type': type })\n", ''],
  ['_headers: the listed files get the assets\' caching (the icon kept for good)', L, "  for (const f of serve.files) block(f, { ...serve.headers.file, 'Content-Type': serve.contentTypes[extname(f)] })", "  for (const f of serve.files) block(f, { ...serve.headers.asset, 'Content-Type': serve.contentTypes[extname(f)] })"],
  ['_headers: one rule for every path (the asset headers on anything the asset layer answers)', L, '  block(`${serve.assetsPrefix}*`, serve.headers.asset)', "  block('/*', serve.headers.asset)"],
  ['VIZ_APP: the document headers are not serve.json\'s (no policy)', L, 'documents: serve.documents, headers: serve.headers.document, document: build.document })', "documents: serve.documents, headers: Object.fromEntries(Object.entries(serve.headers.document).filter(([k]) => k !== 'Content-Security-Policy')), document: build.document })"],
  ['VIZ_APP: the asset headers are given to the document', L, 'documents: serve.documents, headers: serve.headers.document, document: build.document })', "documents: serve.documents, headers: { ...serve.headers.document, ...serve.headers.asset }, document: build.document })"],
  ['VIZ_APP: a document that does not fit a variable is cut', L, "  if (bytes(text) > VAR_MAX_BYTES) throw new Error(`${APP_VAR} would be", "  if (false) throw new Error(`${APP_VAR} would be"],
  // ── serve.json and the build, read ──
  ['serve.json: a rule this code does not know is ignored', L, '  for (const k of Object.keys(spec)) if (!SERVE_KEYS.has(k)) fail(', '  for (const k of Object.keys(spec)) if (false) fail('],
  ['serve.json: a document without a policy is accepted', L, "  if (!doc['content-security-policy']) fail(", '  if (false) fail('],
  ['serve.json: a document a cache may keep is accepted', L, "  if (!/\\bno-cache\\b|\\bno-store\\b/.test(doc['cache-control'] ?? '') || /immutable|max-age=[1-9]/.test(doc['cache-control'])) fail(", '  if (false) fail('],
  ['serve.json: a header over two lines is accepted (into _headers and the document)', L, "      if (typeof value !== 'string' || value === '' || !/^[\\x20-\\x7e]+$/.test(value) || value !== value.trim()) fail(", "      if (typeof value !== 'string') fail("],
  ['serve.json: a document path with dot segments or a trailing slash is accepted', L, "    for (const p of list) if (typeof p !== 'string' || !(p === '/' || (p.startsWith('/') && p.slice(1).split('/').every((s) => SEGMENT.test(s))))) fail(", "    for (const p of list) if (typeof p !== 'string' || !p.startsWith('/')) fail("],
  ['build: a file serve.json does not cover is staged anyway', L, "    if (!isAsset && !serve.files.includes(path)) throw new Error(", '    if (false) throw new Error('],
  ['build: a file with no content type is staged anyway', L, "    if (!serve.contentTypes[extname(rel)]) throw new Error(", '    if (false) throw new Error('],
  ['build: a link is followed and its target staged', L, "    if (!st.isFile()) throw new Error(`${dist}/${rel}: not a regular file", "    if (false) throw new Error(`${dist}/${rel}: not a regular file"],
  ['build: a document that asks for a file the build does not hold is accepted (two builds mixed)', L, "  for (const r of refs) if (!files.some((f) => f.path === r)) throw new Error(", '  for (const r of refs) if (false) throw new Error('],
  ['build: a document with an inline script is accepted', L, "  if (/<script(?![^>]*\\bsrc=)[^>]*>/.test(document)) throw new Error(", '  if (false) throw new Error('],
  // ── files of earlier builds ──
  ['kept: a fetched file is kept without comparing its bytes with the recorded hash', L, "      if (sha256(body) !== f.sha256) throw new Error('its bytes are not the ones recorded')\n", ''],
  ['kept: a file that cannot be fetched fails the build', L, "      dropped.push({ path: f.path, why: String(e.message ?? e).slice(0, 200) })", '      throw e'],
  ['kept: any path the serving version names is fetched and staged (index.html, a path outside the prefix)', L, "    .filter((f) => f.path.startsWith(serve.assetsPrefix) && f.path.slice(1).split('/').every((s) => SEGMENT.test(s)) && Boolean(serve.contentTypes[extname(f.path)]) && /^[0-9a-f]{64}$/.test(f.sha256))\n", ''],
  ['kept: files are kept for good (never aged out)', L, '    .filter((f) => Number.isInteger(f.age) && f.age >= 1 && f.age <= keepBuilds)', '    .filter((f) => Number.isInteger(f.age) && f.age >= 1)'],
  ['kept: a kept file does not age', L, 'age: sameBuild ? k.age : k.age + 1 })', 'age: k.age })'],
  ['kept: the serving build\'s own files are not kept (only what it had kept)', L, "  if (!sameBuild && serving.files) for (const [path, hash] of serving.files) if (!current.has(path)) out.push({ path, sha256: hash, age: 1 })\n", ''],
  ['kept: the same build released again ages what was kept', L, 'age: sameBuild ? k.age : k.age + 1 })', 'age: k.age + 1 })'],
  ['kept: a kept file overwrites the new build\'s own file of that name', L, "    if (existsSync(to)) continue\n", ''],
  ['kept: VIZ_APP_FILES may exceed a Worker variable', L, '  while (list.length > 0 && bytes(make(list)) > VAR_MAX_BYTES) list = list.slice(0, -1)\n  if (bytes(make(list)) > VAR_MAX_BYTES) return', '  if (false) return'],
  ['kept: the stamp records a kept file that did not fit the variable (staged, but the next release does not know it)', L, '  const keptIn = kept.filter((k) => fits.has(k.path))', '  const keptIn = kept'],
  // ── the record, the rollback, the smoke test, CI ──
  ['record: the release record does not name the app\'s build', 'release.mjs', '    app: appOfManifest(manifest),\n    withoutApp: manifest.withoutApp === true,', '    withoutApp: manifest.withoutApp === true,'],
  ['record: what serves now is not read for its app (previous.json, the plan)', 'release.mjs', '      app = appOfVersion(v)\n', ''],
  ['rollback: going back to a version without the app is not said', 'release.mjs', "    if (a.build === null && a.was !== null) log(", '    if (false) log('],
  ['rollback: going back to another build is not said', 'release.mjs', "    else if (a.build !== a.was) log(", '    else if (false) log('],
  ['smoke: the web app is not checked after a deploy', 'smoke.mjs', "  const { app, why } = checkWebApp ? manifestApp(loadManifest(stage)) : { app: null, why: 'not asked (--no-app)' }", "  const { app, why } = { app: null, why: 'not asked (--no-app)' }"],
  ['smoke: a failed app check does not fail the smoke test', 'smoke.mjs', '      return { ok: false, health: h, web }', '      void 0'],
  ['smoke: document headers are not compared', 'smoke.mjs', "      expectHeaders(`GET ${path}`, r, serve.headers.document)\n", ''],
  ['smoke: asset headers and content types are not compared', 'smoke.mjs', "      expectHeaders(`GET ${path}`, r, { ...(isAsset ? serve.headers.asset : serve.headers.file), 'Content-Type': serve.contentTypes[extname(path)] })\n", ''],
  ['smoke: the document\'s bytes are not compared with the release\'s', 'smoke.mjs', "      if (createHash('sha256').update(r.body).digest('hex') !== app.document.sha256) problems.push(", '      if (false) problems.push('],
  ['smoke: a 404 that a cache may keep passes', 'smoke.mjs', " && !/immutable|max-age=[1-9]/.test(r.headers.get('cache-control') ?? '')", ''],
  ['smoke: a 404 that is a page passes', 'smoke.mjs', "r.status === 404 && /^application\\/json/.test(r.headers.get('content-type') ?? '') && !/<!doctype/i.test(r.body.toString())", 'r.status === 404'],
  ['smoke: any status passes for what must be a 404', 'smoke.mjs', "  const isJson404 = (r) => r.status === 404 && ", "  const isJson404 = (r) => "],
  ['smoke: POST is not tried', 'smoke.mjs', "      if (post.status === 200) problems.push(`POST ${path}: 200; only GET and HEAD are served`)\n", ''],
  ['CI: the design system is typechecked (npx tsc with no TypeScript there)', 'ci/matrix.mjs', "  { dir: 'design-system', tsc: false, commands:", "  { dir: 'design-system', commands:"],
  ['CI: the design system\'s check runs its rendered audit (no browser in CI)', 'ci/matrix.mjs', "commands: ['node tools/check.mjs --no-render'] }", "commands: ['node tools/check.mjs'] }"],
  ['CI: the app is typechecked before design-system/dist is generated', 'ci/matrix.mjs', "    prepare: ['node scripts/ensure-design-system.mjs'],\n", ''],
  ['CI: the app is not built, nor its build read by serve.json\'s rules', 'ci/matrix.mjs', "    commands: ['npm run check:tokens', 'npm run build', 'node ../deploy/ci/app-build.mjs dist'],", "    commands: ['npm run check:tokens'],"],
  // ── the Worker's part, as the local workerd run must catch it by itself ──
  ['gateway (workerd run): a missing asset is answered with the document', 'gateway/src/index.ts', '  if (route === null) return appDocument(req, env, path) ?? notFound()', "  if (route === null) return appDocument(req, env, path) ?? (appOf(env) && req.method === 'GET' ? new Response(appOf(env)!.document, { headers: appOf(env)!.headers }) : notFound())"],
  ['gateway (workerd run): the document is served without its policy', 'gateway/src/index.ts', "  headers.set('ETag', app.etag)\n", "  headers.set('ETag', app.etag)\n  headers.delete('Content-Security-Policy')\n"],
  ['gateway (workerd run): POST is served the document', 'gateway/src/index.ts', "  if (req.method !== 'GET' && req.method !== 'HEAD') return null\n", ''],
]

try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: DEPLOY_DIR, stdio: 'pipe' })
  console.error('Refusing to mutate sources inside a git work tree. Copy the tree first (see above).')
  process.exit(2)
} catch {
  // not a work tree: go on
}

const TESTS = ['test/app.test.mjs', 'test/app-serve.test.mjs', 'test/configure.test.mjs', 'test/matrix.test.mjs', 'test/workflow.test.mjs']
const run = () => {
  try {
    execFileSync('node', ['--test', '--test-concurrency=2', ...TESTS], { cwd: DEPLOY_DIR, stdio: 'pipe', timeout: 900_000, env: { ...process.env, CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' } })
    return { failed: false, detail: '' }
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    // A test file that does not load is reported under its own name: that is no test failing, not a kill.
    const names = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]).filter((n) => !/^test\/[^ ]+\.test\.mjs$/.test(n))
    return { failed: names.length > 0, crashed: names.length === 0, count: names.length, detail: names.slice(0, 2).map((n) => n.slice(0, 110)).join(' | ') || out.split('\n').slice(-5).join(' ') }
  }
}

const base = run()
if (base.failed || base.crashed) {
  console.error(`the unmutated tests fail (${base.detail}); fix that first`)
  process.exit(1)
}
const only = process.argv[2]
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
