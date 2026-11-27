#!/usr/bin/env node
// Builds the web app for one release and stages it for viz-gateway (design/DECISIONS.md D74;
// deploy/README.md, "The web app").
//
//   node deploy/app.mjs handover [--stage S] --release <sha> --out <dir>
//   node deploy/app.mjs build    [--stage S] [--release <sha>] [--no-carry] [--from <dir> | --dist <dir>]
//
// handover: makes the build and nothing else. No Cloudflare access, and it refuses to run with a
// credential in its environment: this is the part that runs third-party code (npm install scripts,
// Vite and its plugins), so it runs where no secret is. In the deploy workflow that is a job of its
// own (.github/workflows/deploy.yml, `app-build`); deploy.sh runs it with the credentials removed
// from its environment, which is weaker (review of D74, M-1).
//   1. Lists the sources (app/ and what it needs, deploy/workers.json `app`) and hashes them.
//   2. Exports them to a new directory under the system's temporary directory, outside the
//      checkout, and builds there: `npm ci`, then the app's own `npm run build`. VIZ_SKIP_NPM_CI=1
//      links the checkout's node_modules instead of installing; the result says "linked", and
//      production refuses that for a release that is a commit.
//   3. Writes <dir>/dist/ and <dir>/build.json: what it was built from and every file's SHA-256.
//
// build --from <dir>: takes a handed-over build as data, verifies it against THIS checkout (the
// sources' hash, serve.json, every file's SHA-256; lib/app.mjs `readHandover`), and stages it:
//   4. Reads which hashed files the version serving now holds (its VIZ_APP_FILES var; Cloudflare's
//      API is only read), fetches those the new build no longer has from the deployment itself,
//      checks each against its recorded SHA-256, and keeps them: a page opened before this release
//      can still load them afterwards. --no-carry skips this; a file that cannot be had is dropped
//      and named, never a failure.
//   5. Stages deploy/generated/<target>/app/ (what wrangler uploads, with `_headers`) and writes
//      deploy/generated/<target>/app.json, which configure.mjs reads and release.mjs verifies.
// It runs no npm and no code of app/ or design-system/.
//
// build (neither --from nor --dist): steps 1, 2, 4 and 5 in this one process, for a stage by hand.
// The build's environment holds no credential, but this process and its ancestors may.
//
// --dist (a stage only): stage a build made elsewhere with no description. Nothing ties such a
// build to the sources, the stamp says "prebuilt", and production refuses it.
//
// Production, when the release is a commit SHA: git must be able to read the checkout, the checkout
// must be at that commit and the app's sources unchanged from it, or nothing is built or staged.
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { currentDeployment, versionInfo, workersSubdomain } from './lib/cf.mjs'
import { APP_FILES_VAR, VAR_MAX_BYTES, appWorker, carryPlan, credentialNames, exportAndBuild, fetchKept, hashSources, listSources, parseAppFiles, readBuild, readHandover, readServe, sourceGateProblems, stampBuild, writeHandover } from './lib/app.mjs'
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

/** The app of a plan, its sources as they are now, and whether they may be production's for `release`. */
function sourcesFor({ plan, repoRoot, release, stage, what }) {
  checkStage(stage)
  const found = appWorker(plan)
  if (!found) throw new Error('deploy/workers.json: no Worker declares "app"')
  const target = targetName(stage)
  const serveFile = join(repoRoot, found.app.serve)
  const serve = readServe(serveFile)
  const listed = listSources(repoRoot, found.app)
  const sources = { hash: hashSources(repoRoot, listed.files), files: listed.files.length, commit: listed.commit, dirty: listed.dirty, by: listed.by }
  log(`app (${what}): ${target}, release ${release}; ${sources.files} source files (${listed.by}), hash ${sources.hash.slice(0, 12)}${listed.commit ? `, commit ${listed.commit.slice(0, 12)}${listed.dirty ? ' with changes' : ''}` : ''}`)
  // Fails closed: production with a release that is a commit takes only what git shows to be that commit's.
  const gate = sourceGateProblems(listed, release, stage)
  if (gate.length) throw new Error(gate.join('; '))
  return { ...found, target, serveFile, serve, listed, sources }
}

/** Exports and builds; returns `{ dist, install, cleanup }`. Production with a commit refuses a linked install before building. */
function make({ repoRoot, app, listed, release, stage, skipInstall }) {
  if (skipInstall && !stage && /^[0-9a-f]{40}$/.test(release)) throw new Error(`the release is commit ${release}, and VIZ_SKIP_NPM_CI=1 would link the checkout's node_modules into the app's build instead of installing from its lockfiles: refused for production. Unset it for the app's build`)
  const made = exportAndBuild({ repoRoot, app, files: listed.files, skipInstall, log })
  return { dist: made.dist, install: made.install, cleanup: () => rmSync(made.dir, { recursive: true, force: true }) }
}

/**
 * `handover`: the build, made where no credential is, written to `out` for another job (or a later
 * step) to take as data. Returns its description.
 */
export async function handover({ stage, release = releaseId(), out, plan = readJson(join(DEPLOY_DIR, 'workers.json')), repoRoot = REPO_ROOT, skipInstall = process.env.VIZ_SKIP_NPM_CI === '1', env = process.env } = {}) {
  if (!out) throw new Error('handover needs --out <dir>')
  const held = credentialNames(env)
  if (held.length) throw new Error(`handover runs third-party code (npm scripts, the app's build) and must run where no credential is, but this environment holds ${held.join(', ')}. Run it in a job without secrets, or with them removed (env -u …; deploy.sh does); note that removing a variable is not isolation`)
  const s = sourcesFor({ plan, repoRoot, release, stage, what: 'handover' })
  const made = make({ repoRoot, app: s.app, listed: s.listed, release, stage, skipInstall })
  try {
    const d = writeHandover({ outDir: resolve(out), dist: made.dist, serve: s.serve, release, sources: s.sources, install: made.install })
    log(`  build ${d.build.hash.slice(0, 12)}: index.html (${d.build.document.bytes} bytes) and ${d.build.files.length} files; handed over in ${resolve(out)} (dist/ and build.json)`)
    return d
  } finally {
    made.cleanup()
  }
}

export async function build({ stage, release = releaseId(), carry = true, dist: prebuilt = null, from = null, plan = readJson(join(DEPLOY_DIR, 'workers.json')), repoRoot = REPO_ROOT, api = CLOUDFLARE, fetchFile, skipInstall = process.env.VIZ_SKIP_NPM_CI === '1', now = Date.now() } = {}) {
  const { worker, app, target, serveFile, serve, listed, sources } = sourcesFor({ plan, repoRoot, release, stage, what: from !== null ? 'staging a handed-over build' : prebuilt !== null ? 'staging a prebuilt build' : 'build' })
  const targetDir = join(GENERATED_DIR, target)
  if (from !== null && prebuilt !== null) throw new Error('--from and --dist are two different things: a described build, verified; or a bare dist/')
  let dist
  let via
  let install
  let handedOver = null
  let cleanup = () => {}
  if (from !== null) {
    // Data only: read, verified against this checkout, never executed.
    const h = readHandover({ dir: resolve(from), serve, release, stage, sources })
    dist = h.dist
    via = 'handover'
    install = h.description.install
    handedOver = { builtAt: h.description.builtAt, build: h.description.build.hash, sources: h.description.sources.hash, commit: h.description.sources.commit }
    log(`  handed over from ${resolve(from)}: built ${h.description.builtAt} from sources ${h.description.sources.hash.slice(0, 12)} (the hash of this checkout's), ${h.build.files.length} files, each with the SHA-256 its description names`)
  } else if (prebuilt !== null) {
    if (!stage) throw new Error('--dist is for a stage only: production takes a build made by this tool here, or one handed over with its description (--from)')
    dist = resolve(prebuilt)
    via = 'prebuilt'
    install = 'unknown'
    log(`  staging the build in ${dist} as it is (prebuilt: nothing ties it to these sources)`)
  } else {
    const made = make({ repoRoot, app, listed, release, stage, skipInstall })
    ;({ dist, install, cleanup } = made)
    via = 'export'
  }
  try {
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
        const wanted = carryPlan(serving.files, built, serve, app.keepBuilds, { now, keepDays: app.keepDays })
        const origin = stage ? `https://${name}.${await api.workersSubdomain()}.workers.dev` : `https://${plan.domain}`
        const got = await fetchKept(wanted, origin, fetchFile ? { fetchFile } : {})
        kept = got.kept
        dropped = got.dropped
        carried = { from: origin, servingVersion: serving.versionId, servingBuild: serving.files.build, wanted: wanted.length }
        for (const d of dropped) log(`  WARNING: ${d.path} of an earlier build is not kept (${d.why}): a page that still needs it gets 404`)
      }
      log(`  earlier builds: ${carried.skipped ? `nothing kept (${carried.skipped})` : `${kept.length} of ${carried.wanted} files kept from ${carried.from}`}`)
    } else log('  earlier builds: nothing kept, as asked (--no-carry): a page opened before this release gets 404 for a chunk it has not loaded yet')
    const stamp = stampBuild({ targetDir, repoRoot, release, target, serveFile, dist, sources, via, install, handover: handedOver, worker, kept, dropped, carry: carried })
    for (const d of stamp.dropped.filter((x) => !dropped.includes(x))) log(`  WARNING: ${d.path} of an earlier build is not kept (${d.why}): a page that still needs it gets 404`)
    // Loud, because it is silent otherwise and only shows one release later (review of D74, m-5).
    if (!stamp.filesVar.named) log(`  WARNING: this build's own file list (${built.files.length} files, ${stamp.filesVar.ownBytes} bytes) does not fit ${APP_FILES_VAR} (${VAR_MAX_BYTES} bytes), so this version names none of its files: the NEXT release can keep nothing of this build, and a page opened under it gets 404 for a chunk it has not loaded yet. "Update in place" is lost until the list fits or is kept another way (design/DECISIONS.md D74, "would change if")`)
    if (stamp.install !== 'ci') log(`  NOTE: this build's dependencies were not installed from the lockfiles (install: ${stamp.install}); the stamp and the release record say so`)
    log(`  staged ${stamp.staged.dir}/ (${stamp.staged.files} files, ${stamp.staged.bytes} bytes); stamp deploy/generated/${target}/app.json`)
    return stamp
  } finally {
    cleanup()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const usage = 'usage: app.mjs handover [--stage S] --release <sha> --out <dir>  |  app.mjs build [--stage S] [--release <sha>] [--no-carry] [--from <dir> | --dist <dir>]'
  try {
    const args = parseArgs(process.argv.slice(2), { flags: ['no-carry'], options: ['stage', 'release', 'dist', 'from', 'out'] })
    if (args._[0] === 'handover') {
      const d = await handover({ stage: args.stage, release: args.release, out: args.out })
      console.log(JSON.stringify({ build: d.build.hash, files: d.build.files.length, sources: d.sources.hash, install: d.install, out: resolve(args.out) }))
    } else if (args._[0] === 'build') {
      for (const k of ['dist', 'from']) if (args[k] !== undefined && !existsSync(args[k])) throw new Error(`--${k} ${args[k]} does not exist`)
      const stamp = await build({ stage: args.stage, release: args.release, carry: !args['no-carry'], dist: args.dist ?? null, from: args.from ?? null })
      console.log(JSON.stringify({ build: stamp.build.hash, files: stamp.build.files.length, kept: stamp.kept.length, dropped: stamp.dropped.length, staged: stamp.staged.dir, via: stamp.via, install: stamp.install, filesNamed: stamp.filesVar.named }))
    } else throw new Error(usage)
  } catch (e) {
    log(`app: ${e.message}`)
    process.exit(1)
  }
}
