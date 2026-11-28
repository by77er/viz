#!/usr/bin/env node
// Mutation check for the web app's path from its sources to a release (design/DECISIONS.md D74;
// AGENTS.md, "Tests must have teeth"): what lib/app.mjs reads, stages and refuses; what app.mjs
// builds and keeps; what configure.mjs generates; the gate in release.mjs; the smoke test's check;
// deploy.sh's order; the CI matrix; the deploy workflow's job boundary. Each mutant is one text
// replacement; `node --test` on the app, app-http, app-serve, configure, matrix and workflow tests
// must fail with it (a mutant may name the test files that hold its property, to run only those).
// The file is restored after every mutant, also on failure. (The Worker's own part,
// gateway/src/index.ts, is mutated by gateway/scripts/mutants.mjs under vitest; the few of its
// mutants here are those the local workerd run, test/app-serve.test.mjs, must catch by itself.)
//
//   node scripts/mutants-app.mjs [text]     (from deploy/, in a COPY outside any git work tree;
//                                            with text, only the mutants whose name contains it;
//                                            `re:<pattern>` for a regular expression)
//   node scripts/mutants-app.mjs --check    (anywhere, also in the work tree: changes nothing; lists
//                                            the mutants whose text is no longer in the source
//                                            exactly once, and exits 1 if there is one)
//
// The copy. The whole tracked tree, not a hand-picked part of it: `configure`, which several of
// these tests run, bundles every deployed component and what each imports (control imports
// dashboard/, for one: a copy without it fails two tests for that reason, which would count as
// kills; review of D74, m-9). So: `git archive HEAD | tar -x -C <copy>`, then the uncommitted
// files of deploy/ and .github/ copied over it, app/serve.json as it is on disk, and
// deploy/node_modules linked from the checkout. The copy is then no git work tree, which is what
// this script demands (and what makes `listSources` walk instead of asking git there).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEPLOY_DIR } from '../lib/common.mjs'

const L = 'lib/app.mjs'
const W = '../.github/workflows/deploy.yml'
const MUTANTS = [
  // ── a missing, stale or altered build is released ──
  ['release: the app gate is not asked at deploy', 'release.mjs', "  refusals.push(...appProblems(manifest, loadWorkersPlan()))\n", ''],
  ['release: the app gate is not asked by plan', 'release.mjs', "...keyGateRefusals(keyGateProblems(manifest, configOfGenerated), secrets), ...domains, ...appProblems(manifest, loadWorkersPlan())]", '...keyGateRefusals(keyGateProblems(manifest, configOfGenerated), secrets), ...domains]'],
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
  ['stamp: a build handed in is accepted for production', L, "  if (!stage && stamp.via !== 'export' && stamp.via !== 'handover') problems.push(", '  if (false) problems.push('],
  ['sources: production at another commit than the release is accepted', L, '  if (listed.commit !== release) return [', '  if (false) return ['],
  ['sources: production with sources changed from the release\'s commit is accepted', L, '  if (listed.dirty) return [', '  if (false) return ['],
  ['stamp: the checkout is not judged again at release (another commit, changed sources)', L, '    if (now) problems.push(...sourceGateProblems(now, release, stage))\n', ''],
  ['stamp: the hash of the staged directory leaves out _headers', L, "  const files = filesUnder(dir)\n  for (const rel of files) {", "  const files = filesUnder(dir).filter((f) => f !== '_headers')\n  for (const rel of files) {"],
  ['sources: the hash covers file names only, not contents', L, "  for (const p of files) h.update(`${p}\\0${sha256(readFileSync(join(root, p)))}\\n`)", "  for (const p of files) h.update(`${p}\\n`)"],
  ['sources: untracked files are not sources (a new file changes nothing)', L, "['ls-files', '-co', '--exclude-standard', '-z', '--', ...dirs]", "['ls-files', '-c', '-z', '--', ...dirs]"],
  ['sources: ignored, generated files are sources (and are exported into the build)', L, "['ls-files', '-co', '--exclude-standard', '-z', '--', ...dirs]", "['ls-files', '-co', '-z', '--', ...dirs]"],
  ['sources: what no build reads is hashed and exported (review images)', L, '  const excluded = (p) => app.notBuiltFrom.some((x) => p === x || p.startsWith(`${x}/`))', '  const excluded = () => false'],
  ['build: the sources are not judged before a build (another commit, changed sources, no git)', 'app.mjs', "  if (gate.length) throw new Error(gate.join('; '))\n", ''],
  ['build: production takes a build made elsewhere (--dist)', 'app.mjs', "    if (!stage) throw new Error('--dist is for a stage only", "    if (false) throw new Error('--dist is for a stage only"],
  ['build: a build handed in is stamped as built here', 'app.mjs', "    via = 'prebuilt'", "    via = 'export'"],
  ['build: the app is built in the checkout, not in an export', L, "    run('npm', ['run', 'build'], join(out, app.dir))\n    const dist = join(out, app.dir, 'dist')", "    run('npm', ['run', 'build'], join(repoRoot, app.dir))\n    const dist = join(repoRoot, app.dir, 'dist')"],
  ['build: a failed build command is not a failure', L, "  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd} (exit ${r.status ?? r.signal})`)", '  void r'],
  ['deploy.sh: the app is not staged (configure meets whatever generated/ holds)', 'deploy.sh', '  APP_BUILT=$(node deploy/app.mjs build ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"} --release "$VIZ_RELEASE_SHA" --from "$HANDOVER" ${APP_ARGS[@]+"${APP_ARGS[@]}"})', '  APP_BUILT=\'{"build":"000000000000","files":0,"kept":0,"dropped":0}\''],
  ['deploy.sh: a refused app build does not stop the deploy', 'deploy.sh', '  APP_BUILT=$(node deploy/app.mjs build ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"} --release "$VIZ_RELEASE_SHA" --from "$HANDOVER" ${APP_ARGS[@]+"${APP_ARGS[@]}"})', '  APP_BUILT=$(node deploy/app.mjs build ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"} --release "$VIZ_RELEASE_SHA" --from "$HANDOVER" ${APP_ARGS[@]+"${APP_ARGS[@]}"} || true)'],
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
  ['kept: a kept file does not age', L, 'age: sameBuild ? k.age : k.age + 1, since })', 'age: k.age, since })'],
  ['kept: the serving build\'s own files are not kept (only what it had kept)', L, "  if (!sameBuild && serving.files) for (const [path, hash] of serving.files) if (!current.has(path)) out.push({ path, sha256: hash, age: 1, since: today })\n", ''],
  ['kept: the same build released again ages what was kept', L, 'age: sameBuild ? k.age : k.age + 1, since })', 'age: k.age + 1, since })'],
  ['kept: a kept file overwrites the new build\'s own file of that name', L, "    if (existsSync(to)) continue\n", ''],
  ['kept: VIZ_APP_FILES may exceed a Worker variable', L, '  while (list.length > 0 && bytes(make(list)) > VAR_MAX_BYTES) list = list.slice(0, -1)\n  if (bytes(make(list)) > VAR_MAX_BYTES) {', '  if (false) {'],
  ['kept: the stamp records a kept file that did not fit the variable (staged, but the next release does not know it)', L, '  const keptIn = stageable.filter((k) => fits.has(k.path))', '  const keptIn = stageable'],
  // ── the record, the rollback, the smoke test, CI ──
  ['record: the release record does not name the app\'s build', 'release.mjs', '    app: appOfManifest(manifest),\n    withoutApp: manifest.withoutApp === true,', '    withoutApp: manifest.withoutApp === true,'],
  ['record: what serves now is not read for its app (previous.json, the plan)', 'release.mjs', '      app = appOfVersion(v)\n', ''],
  ['rollback: going back to a version without the app is not said', 'release.mjs', "    if (a.build === null && a.was !== null) log(", '    if (false) log('],
  ['rollback: going back to another build is not said', 'release.mjs', "    else if (a.build !== a.was) log(", '    else if (false) log('],
  ['smoke: the web app is not checked after a deploy', 'smoke.mjs', "  const { app, why } = checkWebApp ? manifestApp(loadManifest(stage)) : { app: null, why: 'not asked (--no-app)' }", "  const { app, why } = { app: null, why: 'not asked (--no-app)' }"],
  ['smoke: a failed app check does not fail the smoke test', 'smoke.mjs', '  return { ok: hostsOk && webOk && dataOk, health: h, hosts, web, data }', '  return { ok: hostsOk && dataOk, health: h, hosts, web, data }'],
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
  // ── the review of D74: who can read the token (M-1) ──
  ['M-1: the build command keeps the credentials in its environment', L, "  for (const k of Object.keys(out)) if (CREDENTIAL_NAME.test(k)) delete out[k]\n", '', ['test/app.test.mjs']],
  ['M-1: the build\'s environment loses Cloudflare\'s names only (another token, a secret, a key stay)', L, "const CREDENTIAL_NAME = /^(CLOUDFLARE_|CF_API|WRANGLER_|ACTIONS_)|TOKEN|SECRET|PASSWORD|CREDENTIAL|(^|_)KEY($|_)/i", 'const CREDENTIAL_NAME = /^(CLOUDFLARE_|CF_API|WRANGLER_|ACTIONS_)/i', ['test/app.test.mjs']],
  ['M-1: handover runs beside a credential', 'app.mjs', '  if (held.length) throw new Error(', '  if (false) throw new Error(', ['test/app.test.mjs']],
  ['M-1: a handed-over file is not compared with the SHA-256 its description names', L, '      else if (n.sha256 !== f.sha256 || n.bytes !== f.bytes) problems.push(', '      else if (false) problems.push(', ['test/app.test.mjs']],
  ['M-1: a file the description does not name is taken', L, '      if (!n) problems.push(`${f.path} is in dist/ and not in the description`)\n      else if', '      if (!n) continue\n      else if', ['test/app.test.mjs']],
  ['M-1: a file the description names and dist/ lacks is not missed', L, "    for (const p of named.keys()) if (!build.files.some((f) => f.path === p)) problems.push(", '    for (const p of named.keys()) if (false) problems.push(', ['test/app.test.mjs']],
  ['M-1: the handed-over document is not compared', L, "    if (d.build.document?.sha256 !== build.documentSha256) problems.push(", '    if (false) problems.push(', ['test/app.test.mjs']],
  ['M-1: the handed-over build\'s sources are not compared with this checkout\'s', L, '  if (d.sources.hash !== sources.hash) problems.push(', '  if (false) problems.push(', ['test/app.test.mjs']],
  ['M-1: a build handed over for another release is taken', L, '  if (d.release !== release) problems.push(`it was built for release', '  if (false) problems.push(`it was built for release', ['test/app.test.mjs']],
  ['M-1: a build handed over under another serve.json is taken', L, "  if (d.serve?.sha256 !== serve.sha256) problems.push(", '  if (false) problems.push(', ['test/app.test.mjs']],
  ['M-1: for production, a handed-over build that says another commit is taken', L, '    if (d.sources.commit !== release) problems.push(', '    if (false) problems.push(', ['test/app.test.mjs']],
  ['M-1: for production, a handed-over build of changed sources is taken', L, '    if (d.sources.dirty !== false) problems.push(', '    if (false) problems.push(', ['test/app.test.mjs']],
  ['M-1: for production, a handed-over build of sources git did not list is taken', L, "    if (d.sources.by !== 'git') problems.push(`its sources were not listed by git", "    if (false) problems.push(`its sources were not listed by git", ['test/app.test.mjs']],
  ['M-1: for production, a handed-over build with linked dependencies is taken', L, "    if (d.install !== 'ci') problems.push(", '    if (false) problems.push(', ['test/app.test.mjs']],
  ['M-1: a handed-over build without its description is taken as it is', L, "  if (!existsSync(file) || !lstatSync(file).isFile()) fail(", '  if (false) fail(', ['test/app.test.mjs']],
  ['M-1: a build handed over is stamped as built here', 'app.mjs', "    via = 'handover'", "    via = 'export'", ['test/app.test.mjs']],
  ['M-1: handover replaces any directory it is pointed at', L, "  if (existsSync(outDir) && readdirSync(outDir).length > 0 && !existsSync(join(outDir, HANDOVER_FILE))) throw new Error(", '  if (false) throw new Error(', ['test/app.test.mjs']],
  ['M-1: deploy.sh builds the app with the credentials in its environment', 'deploy.sh', '    env ${SCRUB[@]+"${SCRUB[@]}"} node deploy/app.mjs handover', '    node deploy/app.mjs handover', ['test/workflow.test.mjs']],
  ['M-1: deploy.sh removes Cloudflare\'s names only from the build\'s and the installs\' environment', 'deploy.sh', '    CLOUDFLARE_*|CF_API*|WRANGLER_*|ACTIONS_*|SMOKE_KEY|*TOKEN*|*SECRET*|*PASSWORD*|*CREDENTIAL*|*_KEY|*_KEY_*|KEY_*) SCRUB+=(-u "$v") ;;', '    CLOUDFLARE_*|SMOKE_KEY) SCRUB+=(-u "$v") ;;', ['test/workflow.test.mjs']],
  ['M-1: deploy.sh installs with the credentials in the installs\' environment', 'deploy.sh', "  env ${SCRUB[@]+\"${SCRUB[@]}\"} bash -c 'set -euo pipefail; install_all'", '  install_all', ['test/workflow.test.mjs']],
  ['M-1: deploy.sh installs with install scripts', 'deploy.sh', '    (cd "$d" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)', '    (cd "$d" && npm ci --no-audit --no-fund --loglevel=error)', ['test/workflow.test.mjs']],
  ['M-1: under GitHub Actions the job that holds the token builds the app itself', 'deploy.sh', '    if [ "${GITHUB_ACTIONS:-}" = true ]; then', '    if false; then', ['test/workflow.test.mjs']],
  ['M-1: --install-only runs beside a credential', 'deploy.sh', '    if [ -n "${!v:-}" ]; then echo "deploy.sh --install-only:', '    if false; then echo "deploy.sh --install-only:', ['test/workflow.test.mjs']],
  ['M-1: deploy.sh removes a build that was handed to it', 'deploy.sh', '    HANDOVER="$VIZ_APP_BUILD"\n', '    HANDOVER="$VIZ_APP_BUILD"\n    HANDOVER_TMP="$HANDOVER"\n', ['test/workflow.test.mjs']],
  ['M-1 workflow: the deploy job has the token in its env (every step gets it)', W, "    # No `env` here: the Cloudflare credentials are given to the steps that call Cloudflare, below,\n    # and to no step that installs anything.\n    steps:", "    env:\n      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n    steps:", ['test/workflow.test.mjs']],
  ['M-1 workflow: the rollback job has the token in its env', W, "    # No `env` here either: the credentials go to the two steps that call Cloudflare.\n    steps:", "    env:\n      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n    steps:", ['test/workflow.test.mjs']],
  ['M-1 workflow: the build step is given the token', W, '        run: node deploy/app.mjs handover --release "$GITHUB_SHA" --out "$RUNNER_TEMP/app-build"', '        env:\n          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n        run: node deploy/app.mjs handover --release "$GITHUB_SHA" --out "$RUNNER_TEMP/app-build"', ['test/workflow.test.mjs']],
  ['M-1 workflow: the build job runs in the production environment (its secrets within reach)', W, "    name: Build the web app (no secrets)\n    needs: checks\n", "    name: Build the web app (no secrets)\n    needs: checks\n    environment:\n      name: production\n", ['test/workflow.test.mjs']],
  ['M-1 workflow: the install step is given the token', W, '        run: deploy/deploy.sh --install-only', "        env:\n          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n        run: deploy/deploy.sh --install-only", ['test/workflow.test.mjs']],
  ['M-1 workflow: the rollback job installs with install scripts', W, '        run: cd deploy && npm ci --ignore-scripts --no-audit --no-fund', '        run: cd deploy && npm ci --no-audit --no-fund', ['test/workflow.test.mjs']],
  ['M-1 workflow: the deploy job does not wait for the build', W, '    needs: [checks, app-build]', '    needs: checks', ['test/workflow.test.mjs']],
  ['M-1 workflow: deploy.sh is not told where the handed-over build is', W, "          VIZ_APP_BUILD: ${{ runner.temp }}/app-build\n", '', ['test/workflow.test.mjs']],
  ['M-1 workflow: the deploy step installs again (with the token)', W, "          VIZ_SKIP_NPM_CI: '1'\n", '', ['test/workflow.test.mjs']],
  ['M-1 workflow: the checks are handed every secret', W, "    uses: ./.github/workflows/ci.yml\n", "    uses: ./.github/workflows/ci.yml\n    secrets: inherit\n", ['test/workflow.test.mjs']],
  ['n-6 workflow: the build job\'s checkout leaves the workflow\'s token on disk', W, "          # Nothing here pushes or fetches again: the workflow's token is not left on disk for the build to read.\n          persist-credentials: false\n", "          fetch-depth: 1\n", ['test/workflow.test.mjs']],
  // ── a stage before production (M-2) ──
  ['M-2: the stage rule is not asked at deploy', 'release.mjs', '  refusals.push(...appStage.problems)\n', '', ['test/app.test.mjs', 'test/upgrade-production.test.mjs']],
  ['M-2: the stage rule is not asked by plan', 'release.mjs', '  problems.push(...appStage.problems)\n', '', ['test/app.test.mjs', 'test/upgrade-production.test.mjs']],
  ['M-2: evidence of other serving code counts', 'release.mjs', '  const mine = entries.filter((e) => e?.serving === fingerprint)', '  const mine = entries', ['test/app.test.mjs']],
  ['M-2: an incomplete entry counts', 'release.mjs', '  const complete = mine.find((e) => evidenceGaps(e).length === 0)', '  const complete = mine[0]', ['test/app.test.mjs']],
  ['M-2: a by-hand check that was not made, or failed, counts', 'release.mjs', "    if (item?.result !== 'pass' || typeof item.note !== 'string' || item.note.trim() === '') gaps.push(", '    if (false) gaps.push(', ['test/app.test.mjs']],
  ['M-2: a by-hand check counts without a note of what was seen', 'release.mjs', "    if (item?.result !== 'pass' || typeof item.note !== 'string' || item.note.trim() === '') gaps.push(", "    if (item?.result !== 'pass') gaps.push(", ['test/app.test.mjs']],
  ['M-2: a stage whose smoke test skipped the app counts', 'release.mjs', '  if (e?.smoke?.passed !== true || e.smoke.app !== true) gaps.push(', '  if (e?.smoke?.passed !== true) gaps.push(', ['test/app.test.mjs']],
  ['M-2: an entry nobody vouches for counts', 'release.mjs', "  if (typeof e?.by !== 'string' || e.by.trim() === '') gaps.push(", '  if (false) gaps.push(', ['test/app.test.mjs']],
  ['M-2: a blank override counts', 'release.mjs', "  const reason = String(override ?? '').trim()", "  const reason = String(override ?? '')", ['test/app.test.mjs']],
  ['M-2: the override is not recorded', 'release.mjs', 'record: { first: true, fingerprint, override: reason } }', 'record: null }', ['test/app.test.mjs', 'test/upgrade-production.test.mjs']],
  ['M-2: the override is not logged', 'release.mjs', "  for (const n of appStage.notes) log(`  ${n}`)\n  refusals.push(", '  refusals.push(', ['test/app.test.mjs']],
  ['M-2: every release is "the first" (a gateway that serves the app is asked again)', 'release.mjs', "  if (typeof live[w.name]?.app === 'string') return none\n", '', ['test/app.test.mjs', 'test/upgrade-production.test.mjs']],
  ['M-2: no release is "the first"', 'release.mjs', "  if (typeof live[w.name]?.app === 'string') return none\n", '  return none\n', ['test/app.test.mjs', 'test/upgrade-production.test.mjs']],
  ['M-2: an unreadable record is no record (the rule falls silent)', 'release.mjs', "      return { first: true, problems: [`${w.name}: ${where} cannot be read (${e.message})`], notes: [], record: null }", '      return none', ['test/app.test.mjs']],
  ['M-2: the fingerprint ignores the gateway\'s source', L, '    worker: sha256(JSON.stringify(code)),', '    worker: null,', ['test/app.test.mjs']],
  ['M-2: the fingerprint ignores the asset headers and types', L, '    headers: sha256(headersFile(serve)),', '    headers: null,', ['test/app.test.mjs']],
  ['M-2: the fingerprint ignores the document\'s headers', L, "    document: sha256(JSON.stringify(Object.entries(serve.headers.document))),\n    wrangler", '    document: null,\n    wrangler', ['test/app.test.mjs']],
  ['M-2: the fingerprint ignores wrangler\'s version', L, '    wrangler: uploader,', '    wrangler: null,', ['test/app.test.mjs']],
  ['M-2: an entry is written for a stage that went without the app', 'scripts/app-stage-evidence.mjs', '  if (!app || release.withoutApp === true) throw new Error(', '  if (false) throw new Error(', ['test/app.test.mjs']],
  ['M-2: an entry is written for a stage whose smoke test failed or skipped the app', 'scripts/app-stage-evidence.mjs', "  if (smoke.ok !== true || smoke.web === 'skipped' || smoke.web?.ok !== true) throw new Error(", '  if (false) throw new Error(', ['test/app.test.mjs']],
  ['M-2: an entry is written with the by-hand checks already passed', 'scripts/app-stage-evidence.mjs', '{ what: WHAT[n], result: null, note: \'\' }', "{ what: WHAT[n], result: 'pass', note: 'made' }", ['test/app.test.mjs']],
  ['M-2: an entry is written although the serving code changed since the stage', 'scripts/app-stage-evidence.mjs', '  if (app.serving && app.serving !== now_.fingerprint) throw new Error(', '  if (false) throw new Error(', ['test/app.test.mjs']],
  // ── the minors ──
  ['m-1: without git, production with a commit builds from whatever the directory holds', L, "  if (listed.by !== 'git') return [", '  if (false) return [', ['test/app.test.mjs']],
  ['m-1: a stamp of sources git did not list is production\'s for a commit', L, "    if (stamp.sources.by !== 'git') problems.push(", '    if (false) problems.push(', ['test/app.test.mjs']],
  ['m-2: production with a commit takes a linked install', 'app.mjs', "  if (skipInstall && !stage && /^[0-9a-f]{40}$/.test(release)) throw new Error(", '  if (false) throw new Error(', ['test/app.test.mjs']],
  ['m-2: a stamp with linked dependencies is production\'s for a commit', L, "    if (stamp.install !== 'ci') problems.push(", '    if (false) problems.push(', ['test/app.test.mjs']],
  ['m-2: a linked install is stamped as installed from the lockfiles', L, "    return { dist, dir: out, install: skipInstall ? 'linked' : 'ci' }", "    return { dist, dir: out, install: 'ci' }", ['test/app.test.mjs']],
  ['m-3: the entity tag covers the document\'s bytes only', L, "`\"${sha256(`${documentSha256}\\0${JSON.stringify(Object.entries(serve.headers.document))}`).slice(0, 32)}\"`", "`\"${sha256(`${documentSha256}\\0`).slice(0, 32)}\"`", ['test/app.test.mjs']],
  ['m-3: the build hash covers the bytes only, not the rules', L, ".update(`rules\\0${serve.rules}\\n`)", '', ['test/app.test.mjs']],
  ['m-3: the rules\' hash leaves out the headers', L, "headers: HEADER_KINDS.map((k) => Object.entries(headers[k])), contentTypes: Object.entries(contentTypes) }))", "contentTypes: Object.entries(contentTypes) }))", ['test/app.test.mjs']],
  ['m-4: an asset prefix inside the API\'s roots is accepted', L, '  if (underApiRoot(assetsPrefix)) fail(', '  if (false) fail(', ['test/app.test.mjs']],
  ['m-4: a file inside the API\'s roots is accepted', L, '  for (const p of files) if (underApiRoot(p)) fail(', '  for (const p of files) if (false) fail(', ['test/app.test.mjs']],
  ['m-4: a document inside the API\'s roots is accepted', L, '  for (const p of documents) if (underApiRoot(p)) fail(', '  for (const p of documents) if (false) fail(', ['test/app.test.mjs']],
  ['m-4: an exact root does not cover what lies under it (/mcp/x.svg)', L, "API_ROOTS.exact.some((p) => path === p || path.startsWith(`${p}/`))", 'API_ROOTS.exact.some((p) => path === p)', ['test/app.test.mjs']],
  ['m-5: a build whose file list does not fit is not said to (the log)', 'app.mjs', '    if (!stamp.filesVar.named) log(', '    if (false) log(', ['test/app.test.mjs']],
  ['m-5: a build whose file list does not fit is recorded as named', L, "    return { text, kept: [], named: false, bytes: bytes(text), ownBytes }", "    return { text, kept: [], named: true, bytes: bytes(text), ownBytes }", ['test/app.test.mjs']],
  ['m-6: kept files have no bound in time', L, "    .filter((f) => today - f.since <= keepDays)\n", '', ['test/app.test.mjs']],
  ['m-6: a day in the future is believed (a kept file outlives keep_days)', L, 'const since = Number.isInteger(k.since) && k.since >= 0 && k.since <= today ? k.since : today', 'const since = Number.isInteger(k.since) ? k.since : today', ['test/app.test.mjs']],
  ['m-6: a file kept by a release keeps no day (it is always "since today")', L, "[digest(f.sha256), f.age, ...(Number.isInteger(f.since) ? [f.since] : [])]", '[digest(f.sha256), f.age]', ['test/app.test.mjs']],
  ['m-6: the plan\'s keep_days does not reach the build', 'app.mjs', '{ now, keepDays: app.keepDays }', '{ now }', ['test/app.test.mjs']],
  ['m-6 workflow: the operator cannot drop a bad build\'s files from the dispatch form', W, "          VIZ_APP_NO_CARRY: ${{ inputs.app_drop_kept_files && '1' || '0' }}\n", '', ['test/workflow.test.mjs']],
  ['m-7: the files\' bytes are not compared with the release\'s', 'smoke.mjs', "      if (createHash('sha256').update(r.body).digest('hex') !== want) problems.push(", '      if (false) problems.push(', ['test/app-http.test.mjs']],
  ['m-7: only the files the document names are asked for (no lazy chunk, no kept file)', 'smoke.mjs', "    for (const [path, want] of hashes) {", '    for (const [path, want] of hashes.filter(([p]) => refs.includes(p))) {', ['test/app-http.test.mjs']],
  ['m-7: the kept files are not asked for', 'smoke.mjs', ", ...(app.kept ?? []).filter((k) => k.sha256).map((k) => [k.path, k.sha256])]", ']', ['test/app-http.test.mjs']],
  ['m-7: a lazy chunk\'s headers are not compared', 'smoke.mjs', '      if (!refs.includes(path)) expectHeaders(', '      if (false) expectHeaders(', ['test/app-http.test.mjs']],
  ['m-7: a manifest without file hashes passes as compared', 'smoke.mjs', "    if (app.fileHashes === undefined) problems.push(", '    if (false) problems.push(', ['test/app-http.test.mjs']],
  ['m-7: the manifest carries no file hashes', L, "  fileHashes: Object.fromEntries(stamp.build.files.map((f) => [f.path, f.sha256])),\n", '', ['test/app-http.test.mjs', 'test/app-serve.test.mjs']],
  ['m-8: a failed app check hides the data check', 'smoke.mjs', "  if (!key) log('smoke: SMOKE_KEY not set; the write-and-read check was skipped')\n  else {", "  if (!key) log('smoke: SMOKE_KEY not set; the write-and-read check was skipped')\n  else if (webOk) {", ['test/app-http.test.mjs']],
  ['m-8: a failed data check does not fail the smoke test', 'smoke.mjs', '  return { ok: hostsOk && webOk && dataOk, health: h, hosts, web, data }', '  return { ok: hostsOk && webOk, health: h, hosts, web, data }', ['test/app-http.test.mjs']],
  ['m-8: the hint does not say what a gateway-only rollback costs', 'smoke.mjs', "    log('  What that costs: ", "    void ('  What that costs: ", ['test/app-http.test.mjs']],
  ['m-8: the result does not say whether the data path works', 'smoke.mjs', "    log(`smoke: the web app FAILED; the data path ", "    void (`smoke: the web app FAILED; the data path ", ['test/app-http.test.mjs']],
  // ── m-9: the mutants the review found alive ──
  ['m-9: a stamp that names another staged directory is accepted', L, '  if (!named) problems.push(', '  if (false) problems.push(', ['test/app.test.mjs']],
  ['m-9: the directory hashed is the one the stamp names, not the one uploaded', L, '  const staged = hashStaged(stagedDir(targetDir))', '  const staged = hashStaged(join(repoRoot, stamp.staged.dir))', ['test/app.test.mjs']],
  ['m-9: files are carried although two versions serve at once', 'app.mjs', '  if (versions.length > 1) return { files: null, why:', '  if (false) return { files: null, why:', ['test/app.test.mjs']],
  ['m-9: production fetches kept files from the workers.dev name, not the domain', 'app.mjs', "const origin = stage ? `https://${name}.${await api.workersSubdomain()}.workers.dev` : `https://${plan.domain}`", "const origin = `https://${name}.${await api.workersSubdomain()}.workers.dev`", ['test/app.test.mjs']],
  ['m-9: a stage fetches kept files from the production domain', 'app.mjs', "const origin = stage ? `https://${name}.${await api.workersSubdomain()}.workers.dev` : `https://${plan.domain}`", "const origin = `https://${plan.domain}`", ['test/app.test.mjs']],
  ['m-9: a kept file is fetched following redirects', L, "redirect: 'error', signal: AbortSignal.timeout(30_000)", "redirect: 'follow', signal: AbortSignal.timeout(30_000)", ['test/app-http.test.mjs']],
  ['m-9: a kept file is taken from any HTTP status', L, "  if (res.status !== 200) {\n    await res.body?.cancel()\n    throw new Error(`HTTP ${res.status}`)\n  }\n  return Buffer.from(await res.arrayBuffer())", '  return Buffer.from(await res.arrayBuffer())', ['test/app-http.test.mjs']],
  ['m-9: a kept file over 25 MiB is kept', L, '      if (body.length > ASSET_MAX_BYTES) throw new Error(`${body.length} bytes`)\n', '', ['test/app.test.mjs']],
  ['m-9: a link among the sources is listed (git)', L, "&& existsSync(join(root, p)) && lstatSync(join(root, p)).isFile()).sort()", '&& existsSync(join(root, p))).sort()', ['test/app.test.mjs']],
  ['m-9: a link among the sources is listed (walk)', L, '    else if (e.isFile()) out.push(p)', '    else out.push(p)', ['test/app.test.mjs']],
  ['m-9: git is asked with the inherited GIT_ environment', L, "  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]\n  const r = spawnSync('git'", "  const r = spawnSync('git'", ['test/app.test.mjs']],
  ['m-9: the smoke test follows redirects', 'smoke.mjs', "{ redirect: 'manual', ...init,", '{ ...init,', ['test/app-http.test.mjs']],
  ['m-9: the smoke test does not ask a document path with a trailing slash', 'smoke.mjs', "      [`${serve.documents.find((d) => d !== '/') ?? '/viz-smoke'}/`, 'a document path with a trailing slash'],\n", '', ['test/app-http.test.mjs']],
  ['m-9: the smoke test does not POST to a document', 'smoke.mjs', "    if (!isJson404(post)) problems.push(`POST ${serve.documents[0]}", "    if (false) problems.push(`POST ${serve.documents[0]}", ['test/app-http.test.mjs']],
  // ── m-10 and the nits ──
  ['m-10: the export is built under the checkout', L, "  const out = mkdtempSync(join(base, 'viz-app-build-'))", "  const out = mkdtempSync(join(repoRoot, 'viz-app-build-'))", ['test/app.test.mjs']],
  ['m-10: a temporary directory inside the checkout is used', L, "  if (base === root || base.startsWith(`${root}${sep}`)) throw new Error(`the temporary directory", "  if (false) throw new Error(`the temporary directory", ['test/app.test.mjs']],
  ['m-10: the export is left behind after the build', 'app.mjs', 'cleanup: () => rmSync(made.dir, { recursive: true, force: true }) }', 'cleanup: () => {} }', ['test/app.test.mjs']],
  ['m-10: a failed build leaves its export behind', L, "  } catch (e) {\n    rmSync(out, { recursive: true, force: true })\n    throw e\n  }", '  } catch (e) {\n    throw e\n  }', ['test/app.test.mjs']],
  ['n-3: a reference that is not double-quoted passes unread', L, '  if (loose) throw new Error(', '  if (false) throw new Error(', ['test/app.test.mjs']],
  ['n-4: a kept path that needs a directory where the build has a file fails the build', L, '  const stageable = kept.filter((k) => !clash(k))', '  const stageable = kept', ['test/app.test.mjs']],
  // ── the Worker's part, as the local workerd run must catch it by itself ──
  ['gateway (workerd run): a missing asset is answered with the document', 'gateway/src/index.ts', '  if (route === null) return appDocument(req, env, path) ?? notFound()', "  if (route === null) return appDocument(req, env, path) ?? (appOf(env) && req.method === 'GET' ? new Response(appOf(env)!.document, { headers: appOf(env)!.headers }) : notFound())"],
  ['gateway (workerd run): the document is served without its policy', 'gateway/src/index.ts', "  headers.set('ETag', app.etag)\n", "  headers.set('ETag', app.etag)\n  headers.delete('Content-Security-Policy')\n"],
  ['gateway (workerd run): POST is served the document', 'gateway/src/index.ts', "  if (req.method !== 'GET' && req.method !== 'HEAD') return null\n", ''],
  // ── D75 with D74: the app on the alias host, the host checks, the two release gates ──
  ['D75×D74 smoke: the app is not passed to the host checks (the alias is not asked for it)', 'smoke.mjs', 'healthTimeoutMs, fetch, 3000, { app })', 'healthTimeoutMs, fetch, 3000, {})', ['test/smoke.test.mjs']],
  ['D75×D74 smoke: a host failure does not fail the smoke test', 'smoke.mjs', '  return { ok: hostsOk && webOk && dataOk, health: h, hosts, web, data }', '  return { ok: webOk && dataOk, health: h, hosts, web, data }', ['test/smoke.test.mjs']],
  ['D75×D74 smoke: a host failure stops the checks after it (m-8)', 'smoke.mjs', "  const hostsOk = hosts === 'skipped' || hosts.ok\n", "  const hostsOk = hosts === 'skipped' || hosts.ok\n  if (!hostsOk) return { ok: false, health: h, hosts, web: 'skipped', data: 'skipped' }\n", ['test/smoke.test.mjs']],
  ['D75×D74 smoke: the alias is not asked for the documents', 'smoke.mjs', '    if (app) {\n      const paths', '    if (false) {\n      const paths', ['test/smoke.test.mjs']],
  ['D75×D74 smoke: a missing asset is not asked of the alias', 'smoke.mjs', 'const paths = [...app.serve.documents, `${app.serve.assetsPrefix}viz-smoke-missing-00000000.js`]', 'const paths = [...app.serve.documents]', ['test/smoke.test.mjs']],
  ['D75×D74 smoke: the alias\'s redirect target is not compared', 'smoke.mjs', "          if (r.status !== 308 || r.headers.get('Location') !== `${base}${path}`) problems.push(`${host}: GET ${path} answered ${r.status}${r.headers.get('Location') ? ` to ${r.headers.get('Location')}` : ''}, not 308 to ${base}${path}: the web app", "          if (r.status !== 308) problems.push(`${host}: GET ${path} answered ${r.status}${r.headers.get('Location') ? ` to ${r.headers.get('Location')}` : ''}, not 308 to ${base}${path}: the web app", ['test/smoke.test.mjs']],
  ['D75×D74 smoke: a redirect on the alias that may be kept passes', 'smoke.mjs', "          else if (/immutable|max-age=[1-9]/.test(r.headers.get('cache-control') ?? '')) problems.push(", '          else if (false) problems.push(', ['test/smoke.test.mjs']],
  ['D75×D74 release: complete stage evidence clears the other refusals (deploy)', 'release.mjs', '  refusals.push(...appStage.problems)\n', '  if (appStage.record?.evidence) refusals.length = 0\n  refusals.push(...appStage.problems)\n', ['test/domains.test.mjs']],
  ['D75×D74 release: complete stage evidence clears the other refusals (plan)', 'release.mjs', '  problems.push(...appStage.problems)\n  printPlan(', '  if (appStage.record?.evidence) problems.length = 0\n  problems.push(...appStage.problems)\n  printPlan(', ['test/domains.test.mjs']],
  ['D75×D74 release: the stage gate is not asked when the hostnames are refused', 'release.mjs', '  refusals.push(...appStage.problems)\n', '  if (domains.length === 0) refusals.push(...appStage.problems)\n', ['test/domains.test.mjs']],
  ['D75×D74 stamp: the serving fingerprint depends on the target (a stage\'s evidence would never count for production)', 'lib/app.mjs', '    serving: worker ? servingFingerprint({ repoRoot, serve, worker }) : null,', '    serving: worker ? { ...servingFingerprint({ repoRoot, serve, worker }), fingerprint: sha256(`${servingFingerprint({ repoRoot, serve, worker }).fingerprint}${target}`) } : null,', ['test/domains.test.mjs']],
  ['D75×D74 workerd: the app\'s documents are served on the alias', 'gateway/src/index.ts', 'if (alias && origin !== null && url.host !== new URL(origin).host) return onAlias(req, env, url, alias, origin)', 'if (alias && origin !== null && url.host !== new URL(origin).host && appDocument(req, env, url.pathname) === null) return onAlias(req, env, url, alias, origin)', ['test/app-serve.test.mjs']],

]

// --check: which mutants no longer apply to the source. Changes nothing, so it may run in the work tree.
if (process.argv[2] === '--check') {
  const stale = MUTANTS.filter(([, file, from]) => readFileSync(join(DEPLOY_DIR, file), 'utf8').split(from).length !== 2)
  for (const [name, file] of stale) console.log(`NOT APPLIED  ${name} (pattern not found exactly once in ${file})`)
  console.log(`${MUTANTS.length - stale.length} of ${MUTANTS.length} mutants apply`)
  process.exit(stale.length ? 1 : 0)
}

try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: DEPLOY_DIR, stdio: 'pipe' })
  console.error('Refusing to mutate sources inside a git work tree. Copy the tree first (see above).')
  process.exit(2)
} catch {
  // not a work tree: go on
}

// VIZ_MUTANT_TESTS="test/a.test.mjs test/b.test.mjs": the test files for mutants that name none of
// their own. For a run in two passes: first without test/app-serve.test.mjs (which starts workerd
// and takes most of the time), then the survivors of that pass with it alone. A mutant any test of
// the suite kills is killed; one that survives both passes survives.
const TESTS = process.env.VIZ_MUTANT_TESTS?.split(/\s+/).filter(Boolean) ?? ['test/app.test.mjs', 'test/app-http.test.mjs', 'test/app-serve.test.mjs', 'test/configure.test.mjs', 'test/matrix.test.mjs', 'test/workflow.test.mjs']
const run = (tests = TESTS) => {
  try {
    execFileSync('node', ['--test', '--test-concurrency=2', ...tests], { cwd: DEPLOY_DIR, stdio: 'pipe', timeout: 900_000, env: { ...process.env, CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' } })
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
for (const [name, file, from, to, tests] of chosen) {
  const path = join(DEPLOY_DIR, file)
  const original = readFileSync(path, 'utf8')
  if (original.split(from).length !== 2) {
    console.log(`NOT APPLIED  ${name} (pattern not found exactly once in ${file})`)
    continue
  }
  writeFileSync(path, original.replace(from, to))
  let r
  try {
    r = run(tests)
  } finally {
    writeFileSync(path, original)
  }
  if (r.failed) killed++
  console.log(`${r.failed ? `KILLED (${r.count})` : r.crashed ? 'NO RUN  ' : 'SURVIVED'}  ${name}${r.detail ? `  ← ${r.detail}` : ''}`)
}
console.log(`${killed} of ${chosen.length} killed`)
process.exit(killed === chosen.length ? 0 : 1)
