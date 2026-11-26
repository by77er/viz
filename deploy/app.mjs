#!/usr/bin/env node
// Builds the web app for one release and stages it for viz-gateway (design/DECISIONS.md D74;
// deploy/README.md, "The web app").
//
//   node deploy/app.mjs build [--stage S] [--release <sha>] [--no-carry] [--dist <dir>]
//
// 1. Lists the sources (app/ and what it needs, deploy/workers.json `app`) and hashes them.
// 2. Exports them to deploy/generated/<target>/app-build/ and builds there: `npm ci`, then the
//    app's own `npm run build`. Never in app/ itself. VIZ_SKIP_NPM_CI=1 links the checkout's
//    node_modules instead of installing.
// 3. Reads which hashed files the version serving now holds (its VIZ_APP_FILES var; Cloudflare's
//    API is only read), fetches those the new build no longer has from the deployment itself,
//    checks each against its recorded SHA-256, and keeps them: a page opened before this release
//    can still load them afterwards. --no-carry skips this; a file that cannot be had is dropped
//    and named, never a failure.
// 4. Stages deploy/generated/<target>/app/ (what wrangler uploads, with `_headers`) and writes
//    deploy/generated/<target>/app.json, which configure.mjs reads and release.mjs verifies.
//
// --dist (a stage only): stage a build made elsewhere instead of building. Nothing ties such a
// build to the sources, the stamp says "prebuilt", and production refuses it.
//
// Production, when the release is a commit SHA: the checkout must be at that commit and the app's
// sources unchanged from it, or nothing is built.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { currentDeployment, versionInfo, workersSubdomain } from './lib/cf.mjs'
import { APP_FILES_VAR, appWorker, carryPlan, exportAndBuild, fetchKept, hashSources, listSources, parseAppFiles, readBuild, readServe, stampBuild } from './lib/app.mjs'
import { DEPLOY_DIR, GENERATED_DIR, REPO_ROOT, checkStage, log, parseArgs, readJson, releaseId, stagedName, targetName } from './lib/common.mjs'

const CLOUDFLARE = { currentDeployment, versionInfo, workersSubdomain }

/** What the version of `name` serving now says of its asset files (VIZ_APP_FILES), or why that is unknown. */
export async function servingAppFiles(name, api = CLOUDFLARE) {
  const dep = await api.currentDeployment(name)
  const versions = dep?.versions ?? []
  if (versions.length === 0) return { files: null, why: `${name} serves nothing yet` }
  if (versions.length > 1) return { files: null, why: `${name} serves ${versions.length} versions at once` }
  const info = await api.versionInfo(name, versions[0].version_id)
  const text = (info?.resources?.bindings ?? info?.bindings ?? []).find((b) => b?.type === 'plain_text' && b.name === APP_FILES_VAR)?.text
  const files = parseAppFiles(text)
  return files ? { files, versionId: versions[0].version_id } : { files: null, why: `the ${name} serving now (${versions[0].version_id}) has no app` }
}

export async function build({ stage, release = releaseId(), carry = true, dist: prebuilt = null, plan = readJson(join(DEPLOY_DIR, 'workers.json')), repoRoot = REPO_ROOT, api = CLOUDFLARE, fetchFile, skipInstall = process.env.VIZ_SKIP_NPM_CI === '1' } = {}) {
  checkStage(stage)
  const found = appWorker(plan)
  if (!found) throw new Error('deploy/workers.json: no Worker declares "app"')
  const { worker, app } = found
  const target = targetName(stage)
  const targetDir = join(GENERATED_DIR, target)
  const serveFile = join(repoRoot, app.serve)
  const serve = readServe(serveFile)
  const listed = listSources(repoRoot, app)
  const sources = { hash: hashSources(repoRoot, listed.files), files: listed.files.length, commit: listed.commit, dirty: listed.dirty, by: listed.by }
  log(`app: ${target}, release ${release}; ${sources.files} source files (${listed.by}), hash ${sources.hash.slice(0, 12)}${listed.commit ? `, commit ${listed.commit.slice(0, 12)}${listed.dirty ? ' with changes' : ''}` : ''}`)
  if (!stage && /^[0-9a-f]{40}$/.test(release) && listed.by === 'git') {
    if (listed.commit !== release) throw new Error(`the release is commit ${release}, and this checkout is at ${listed.commit ?? 'no commit'}: the app would be built from other sources than the release names`)
    if (listed.dirty) throw new Error(`the release is commit ${release}, and the app's sources differ from it in this checkout (${listed.dirtyFiles.join(', ')})`)
  }
  let dist
  let via
  if (prebuilt !== null) {
    if (!stage) throw new Error('--dist is for a stage only: production is built here, from an export of the sources')
    dist = resolve(prebuilt)
    via = 'prebuilt'
    log(`  staging the build in ${dist} as it is (prebuilt: nothing ties it to these sources)`)
  } else {
    dist = exportAndBuild({ repoRoot, targetDir, app, files: listed.files, skipInstall, log })
    via = 'export'
  }
  const built = readBuild(dist, serve)
  log(`  build ${built.hash.slice(0, 12)}: index.html (${Buffer.byteLength(built.document)} bytes) and ${built.files.length} files, ${built.files.reduce((n, f) => n + f.bytes, 0)} bytes`)

  // Files of earlier builds, for pages opened before this release.
  let kept = []
  let dropped = []
  let carried = { skipped: 'asked (--no-carry)' }
  if (carry && app.keepBuilds === 0) carried = { skipped: 'keep_builds is 0' }
  else if (carry && !(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID)) {
    carried = { skipped: 'no Cloudflare credentials to read what serves now' }
    log(`  WARNING: ${carried.skipped}: no file of an earlier build is kept; a page opened before this release gets 404 for a chunk it has not loaded yet`)
  } else if (carry) {
    const name = stagedName(worker.name, stage)
    const serving = await servingAppFiles(name, api)
    if (!serving.files) carried = { skipped: serving.why }
    else {
      const wanted = carryPlan(serving.files, built, serve, app.keepBuilds)
      const origin = stage ? `https://${name}.${await api.workersSubdomain()}.workers.dev` : `https://${plan.domain}`
      const got = await fetchKept(wanted, origin, fetchFile ? { fetchFile } : {})
      kept = got.kept
      dropped = got.dropped
      carried = { from: origin, servingVersion: serving.versionId, servingBuild: serving.files.build, wanted: wanted.length }
      for (const d of dropped) log(`  WARNING: ${d.path} of an earlier build is not kept (${d.why}): a page that still needs it gets 404`)
    }
    log(`  earlier builds: ${carried.skipped ? `nothing kept (${carried.skipped})` : `${kept.length} of ${carried.wanted} files kept from ${carried.from}`}`)
  }
  const stamp = stampBuild({ targetDir, repoRoot, release, target, serveFile, dist, sources, via, kept, dropped, carry: carried })
  log(`  staged ${stamp.staged.dir}/ (${stamp.staged.files} files, ${stamp.staged.bytes} bytes); stamp deploy/generated/${target}/app.json`)
  return stamp
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { flags: ['no-carry'], options: ['stage', 'release', 'dist'] })
    if (args._[0] !== 'build') throw new Error('usage: app.mjs build [--stage S] [--release <sha>] [--no-carry] [--dist <dir>]')
    if (args.dist !== undefined && !existsSync(args.dist)) throw new Error(`--dist ${args.dist} does not exist`)
    const stamp = await build({ stage: args.stage, release: args.release, carry: !args['no-carry'], dist: args.dist ?? null })
    console.log(JSON.stringify({ build: stamp.build.hash, files: stamp.build.files.length, kept: stamp.kept.length, dropped: stamp.dropped.length, staged: stamp.staged.dir }))
  } catch (e) {
    log(`app: ${e.message}`)
    process.exit(1)
  }
}
