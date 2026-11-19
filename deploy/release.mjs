#!/usr/bin/env node
// Upload, then promote; record; roll back. Reads the manifest configure.mjs wrote.
//
//   node deploy/release.mjs deploy   [--stage S] [--ack "viz-ingest@v2 …"]   upload every Worker, then promote in order
//   node deploy/release.mjs rollback --record <release.json> [--stage S] [--reason …]
//   node deploy/release.mjs plan     [--stage S] [--ack …]                    what deploy would do; exit 3 if refused
//   node deploy/release.mjs status   [--stage S]                              what serves now
//   node deploy/release.mjs current-release [--stage S]                      the release viz-ingest serves (its version tag)
//
// The rules this implements (deploy/README.md cites the Cloudflare documentation for each):
//
// - Phase 1 uploads every Worker of the release with `wrangler versions upload`, tagged with
//   the release (git SHA); an uploaded version serves nothing. A Worker whose config adds a
//   Durable Object migration cannot be uploaded as a version (Cloudflare refuses versions that
//   change a class's lifecycle) and a Worker that does not exist yet has nothing to upload a
//   version to: both are only bundled here (`--dry-run`), and go out with `wrangler deploy`
//   at their turn in phase 2.
// - Phase 2 promotes in deploy/workers.json order, callees before callers, each at 100%.
// - A release that applies a migration needs an acknowledgement naming it
//   (`Migration: viz-ingest@v2`); without one nothing is uploaded or promoted (exit 3).
// - If phase 2 fails part-way and no migration has been applied, what was promoted is put
//   back to the previous versions; with a migration applied, nothing is rolled back.
// - Rollback restores recorded version ids in reverse order, and refuses if any Worker's
//   migration tag in force differs from the one recorded: migrations are forward-only.
// - Schemas (contracts/COMPATIBILITY.md §6). The record names each Durable Object class's
//   `{latest, compat}` (configure.mjs reads them; every version carries them as VIZ_SCHEMAS).
//   A release is FORWARD-ONLY when a class's `compat` (its highest `readableFrom`) is above
//   what the release serving before it knew, or when it changes a class's lifecycle; the
//   record says so and why. A rollback refuses, naming the release and migration, when any
//   version that ran since the target wrote storage the target cannot open (`canOpen`): that
//   is exactly crossing a forward-only release, including one that was itself rolled back.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { currentDeployment, listScripts, listVersions, versionInfo } from './lib/cf.mjs'
import { DEPLOY_DIR, GENERATED_DIR, REPO_ROOT, checkStage, log, parseArgs, targetName } from './lib/common.mjs'
import { schemasOfVersion } from './lib/schemas.mjs'
import { versionIdFrom, wrangler } from './lib/wrangler.mjs'

export const EXIT_REFUSED = 3

export function loadManifest(stage) {
  const file = join(GENERATED_DIR, targetName(stage), 'manifest.json')
  if (!existsSync(file)) throw new Error(`${file} not found: run deploy/configure.mjs first`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** `viz-ingest@v2` entries in any text (a dispatch input, commit trailers). Names are production names. */
export function parseAcks(text) {
  const out = new Set()
  for (const m of String(text ?? '').matchAll(/(?:^|[\s,;:])(viz-[a-z0-9-]+)@([A-Za-z0-9._-]+)/g)) out.add(`${m[1]}@${m[2]}`)
  return out
}

const annotation = (v, key) => v?.annotations?.[key] ?? v?.metadata?.annotations?.[key] ?? null

/**
 * What a deploy of this manifest would do, Worker by Worker, against what the account runs now.
 * Pure given its inputs (the tests call it with fixtures).
 */
export function planRelease(manifest, live, acks) {
  const steps = []
  const problems = []
  for (const name of manifest.order) {
    const w = manifest.workers.find((x) => x.name === name)
    const now = live[name] ?? { exists: false, migrationTag: null }
    let migration = null
    if (w.migrationTag !== now.migrationTag) {
      if (now.migrationTag !== null && !w.migrationTags.includes(now.migrationTag)) {
        problems.push(`${name}: the deployed migration tag ${now.migrationTag} is not in ${w.component}/wrangler.jsonc (tags: ${w.migrationTags.join(', ') || 'none'}). Migrations are forward-only; a config may not drop one that was applied.`)
      }
      migration = { from: now.migrationTag, to: w.migrationTag }
    }
    const ack = migration ? `${w.canonical}@${migration.to}` : null
    if (migration && !acks.has(ack)) problems.push(`${name}: this release applies Durable Object migration ${migration.from ?? '(none)'} → ${migration.to}. Acknowledge it with a commit trailer or dispatch input "Migration: ${ack}".`)
    steps.push({ name, canonical: w.canonical, config: w.config, exists: now.exists, via: !now.exists || migration ? 'deploy' : 'versions', migration, ack })
  }
  return { steps, problems, migrations: steps.filter((s) => s.migration) }
}

/**
 * Live state of each Worker: exists, migration tag in force, the versions serving now, their
 * release tag, and what the serving version declares it knows of each class (`schemas`, from
 * its VIZ_SCHEMAS var; null when it declares nothing or more than one version serves).
 */
export async function liveState(names) {
  const scripts = await listScripts()
  const out = {}
  for (const name of names) {
    const s = scripts.find((x) => x.id === name)
    if (!s) {
      out[name] = { exists: false, migrationTag: null, versions: [], release: null, schemas: null }
      continue
    }
    const dep = await currentDeployment(name)
    const versions = dep?.versions ?? []
    let release = null
    let schemas = null
    if (versions.length === 1) {
      const v = await versionInfo(name, versions[0].version_id)
      release = annotation(v, 'workers/tag')
      schemas = schemasOfVersion(v)
    }
    out[name] = { exists: true, migrationTag: s.migration_tag ?? null, versions, release, schemas }
  }
  return out
}

/**
 * Why this release is forward-only against the release serving now (contracts/COMPATIBILITY.md
 * §6), one entry per reason; empty when it is not. Pure.
 *
 * - `schema`: a class's `compat` is above what the serving version knows of it (its `latest`).
 *   A serving version that declares nothing predates schema records; it is taken to know
 *   version 1, the schema of code from before versioning (COMPATIBILITY.md §6, Bootstrapping),
 *   which is also the safe direction. A Worker that does not exist yet has no older code.
 * - `lifecycle`: a Durable Object migration tag changes on a Worker that exists (Cloudflare
 *   refuses a rollback across it too).
 */
export function forwardOnlyReasons(manifest, live) {
  const out = []
  for (const name of manifest.order) {
    const w = manifest.workers.find((x) => x.name === name)
    const now = live[name] ?? { exists: false, migrationTag: null, schemas: null }
    if (!now.exists) continue
    if ((w.migrationTag ?? null) !== (now.migrationTag ?? null)) {
      out.push({ worker: name, kind: 'lifecycle', from: now.migrationTag ?? null, to: w.migrationTag ?? null, why: `${name}: Durable Object migration ${now.migrationTag ?? '(none)'} → ${w.migrationTag}: a class lifecycle change (Cloudflare does not roll back across it)` })
    }
    for (const sc of w.schemas ?? []) {
      const declared = now.schemas?.[sc.component]
      const knows = declared ? declared.latest : 1
      if (sc.compat <= knows) continue
      const crossing = sc.migrations.filter((m) => m.readableFrom > knows)
      out.push({
        worker: name,
        kind: 'schema',
        component: sc.component,
        previousKnows: knows,
        previousDeclared: Boolean(declared),
        latest: sc.latest,
        compat: sc.compat,
        migrations: crossing,
        why: `${sc.component}: ${crossing.map((m) => `migration ${m.version} ("${m.name}") has readableFrom ${m.readableFrom}`).join('; ')}, above version ${knows}, which ${declared ? 'the release serving before it knew' : 'is all the release serving before it is taken to know (it declares no schema versions)'}`,
      })
    }
  }
  return out
}

/** `{ component: { worker, latest, compat, by } }` of a manifest's Workers. */
export function schemasOfManifest(manifest) {
  const out = {}
  for (const name of manifest.order) {
    for (const sc of manifest.workers.find((x) => x.name === name)?.schemas ?? []) {
      const by = sc.migrations.find((m) => m.readableFrom === sc.compat)
      out[sc.component] = { worker: name, latest: sc.latest, compat: sc.compat, by: by ? `${by.version}: ${by.name}` : null }
    }
  }
  return out
}

/**
 * contracts/COMPATIBILITY.md §6, for a rollback to the release recorded in `target`: for every
 * class, `canOpen(target.latest, newest storage written since)`. `ran` is every version of the
 * target's Workers newer than the target's own, as Cloudflare keeps them (`{ worker, versionId,
 * release, schemas }`, `schemas` from its VIZ_SCHEMAS var, null if it declares none): a superset
 * of what ran since the target, which only makes the check stricter. Pure; returns the problems.
 */
export function schemaRollbackProblems(target, ran) {
  if (!target.schemas) {
    return [`the record of ${target.release} has no schema versions (it predates them), so a rollback to it cannot be checked against contracts/COMPATIBILITY.md §6. Fix forward, or deploy that commit again (a new release, through the migration gate).`]
  }
  const problems = []
  const workersWithSchemas = new Set(Object.values(target.schemas).map((x) => x.worker))
  for (const v of ran) {
    if (!workersWithSchemas.has(v.worker)) continue
    if (v.schemas === null) {
      problems.push(`${v.worker}: version ${v.versionId} (release ${v.release ?? 'unknown'}), newer than the one being restored, does not declare its schema versions, so what it may have written is unknown. Fix forward.`)
      continue
    }
    for (const [component, ranAt] of Object.entries(v.schemas)) {
      const knows = target.schemas[component]?.latest
      if (knows === undefined) continue // the target release has no code for this class
      // canOpen (contracts/schema.ts): storage at `version` is readable by code knowing `known` iff version ≤ known or compat ≤ known.
      if (ranAt.latest <= knows || ranAt.compat <= knows) continue
      problems.push(
        `${component}: release ${v.release ?? 'unknown'} (${v.worker} version ${v.versionId}) ran schema version ${ranAt.latest}, readable from ${ranAt.compat}, ` +
          `and ${target.release} knows only up to ${knows}: that release is forward-only (migration ${ranAt.by ?? '?'}). Its objects' storage cannot be opened by ${target.release}. Fix forward instead.`,
      )
    }
  }
  return [...new Set(problems)]
}

/** Every version Cloudflare keeps of the target's schema-bearing Workers that is newer than the target's. */
async function versionsSince(target, api) {
  const out = []
  const workers = new Set(Object.values(target.schemas ?? {}).map((x) => x.worker))
  for (const w of target.workers) {
    if (!workers.has(w.name) || !w.versionId) continue
    const own = await api.versionInfo(w.name, w.versionId)
    const ownNumber = own?.number ?? null
    for (const v of await api.listVersions(w.name)) {
      if (v.id === w.versionId) continue
      if (ownNumber !== null && v.number !== undefined && v.number <= ownNumber) continue
      const info = await api.versionInfo(w.name, v.id)
      out.push({ worker: w.name, versionId: v.id, number: v.number, release: annotation(info, 'workers/tag'), schemas: schemasOfVersion(info) })
    }
  }
  return out
}

function recordOf(manifest, live, extra = {}) {
  return {
    target: manifest.target,
    stage: manifest.stage,
    release: extra.release ?? manifest.release,
    recordedAt: new Date().toISOString(),
    ...extra,
    workers: manifest.order.map((name) => ({
      name,
      versionId: live[name]?.versions.length === 1 ? live[name].versions[0].version_id : null,
      versions: live[name]?.versions ?? [],
      migrationTag: live[name]?.migrationTag ?? null,
      release: live[name]?.release ?? null,
    })),
  }
}

/** The release serving now: the version tag of the write path's Worker (else the first that has one). */
const servingRelease = (manifest, live) => live[manifest.releaseFrom]?.release ?? manifest.order.map((n) => live[n]?.release).find(Boolean) ?? null

/** What the serving versions declare, as a record's `schemas` (for `previous.json`); null if none declares. */
function schemasOfLive(manifest, live) {
  const out = {}
  for (const name of manifest.order) for (const [component, v] of Object.entries(live[name]?.schemas ?? {})) out[component] = { worker: name, ...v }
  return Object.keys(out).length > 0 ? out : null
}

const doMode = (manifest) => ['--durable-objects-code-update-mode', manifest.durableObjectsCodeUpdate]

function writeRecord(stage, name, record) {
  const dir = join(GENERATED_DIR, targetName(stage))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
  return file
}

/** Promote one version at 100%, then apply the Worker's triggers (routes, custom domain, crons, queue consumers). */
async function promoteVersion(manifest, step, versionId, message) {
  await wrangler(['versions', 'deploy', `${versionId}@100%`, '--config', join(REPO_ROOT, step.config), '--yes', '--message', message, ...doMode(manifest)], { label: step.name })
  await wrangler(['triggers', 'deploy', '--config', join(REPO_ROOT, step.config)], { label: step.name })
}

async function restore(manifest, workers, reason) {
  // Callers first: an older callee never serves a newer caller.
  for (const w of [...workers].reverse()) {
    if (!w.versionId) {
      log(`  ${w.name}: no single previous version recorded; left as it is`)
      continue
    }
    log(`  ${w.name}: back to ${w.versionId}`)
    await wrangler(['versions', 'deploy', `${w.versionId}@100%`, '--name', w.name, '--yes', '--message', `rollback: ${reason}`.slice(0, 100), ...doMode(manifest)], { label: w.name })
  }
}

export async function deploy({ stage, ackText = '' }) {
  const manifest = loadManifest(stage)
  const release = manifest.release
  const tag = release.slice(0, 40)
  const message = `viz ${release}`.slice(0, 100)
  const before = await liveState(manifest.order)
  const previous = recordOf(manifest, before, { release: servingRelease(manifest, before), kind: 'previous', schemas: schemasOfLive(manifest, before) })
  const previousFile = writeRecord(stage, 'previous.json', previous)
  const plan = planRelease(manifest, before, parseAcks(ackText))
  const forwardOnly = forwardOnlyReasons(manifest, before)
  printPlan(manifest, plan)
  for (const f of forwardOnly) log(`  FORWARD-ONLY: ${f.why}`)
  if (plan.problems.length) {
    log('\nrelease: REFUSED before uploading or promoting anything:')
    for (const p of plan.problems) log(`  - ${p}`)
    log('  See deploy/README.md, "Durable Object migrations".')
    return { exit: EXIT_REFUSED, plan }
  }

  // Phase 1: upload (or, where a version cannot be uploaded, bundle). Nothing serves yet.
  log('\nphase 1: upload')
  const uploaded = {}
  for (const step of plan.steps) {
    if (step.via === 'versions') {
      const r = await wrangler(['versions', 'upload', '--config', join(REPO_ROOT, step.config), '--tag', tag, '--message', message], { label: step.name })
      uploaded[step.name] = versionIdFrom(r, 'version-upload')
      log(`  ${step.name}: uploaded ${uploaded[step.name]} (serving nothing yet)`)
    } else {
      await wrangler(['deploy', '--dry-run', '--config', join(REPO_ROOT, step.config), '--outdir', join(GENERATED_DIR, targetName(stage), 'dry-run', step.name)], { label: step.name, quiet: true })
      log(`  ${step.name}: bundled; goes out with wrangler deploy in phase 2 (${step.migration ? `migration ${step.migration.from ?? '(none)'} → ${step.migration.to}` : 'new Worker'})`)
    }
  }

  // Phase 2: promote, callees first.
  log('\nphase 2: promote')
  const promoted = []
  let migrationApplied = false
  try {
    for (const step of plan.steps) {
      if (step.via === 'versions') {
        await promoteVersion(manifest, step, uploaded[step.name], message)
        log(`  ${step.name}: ${uploaded[step.name]} at 100%`)
      } else {
        const r = await wrangler(['deploy', '--config', join(REPO_ROOT, step.config), '--tag', tag, '--message', message, ...doMode(manifest)], { label: step.name })
        uploaded[step.name] = versionIdFrom(r, 'deploy')
        if (step.migration) migrationApplied = true
        log(`  ${step.name}: deployed ${uploaded[step.name]}${step.migration ? ` with migration ${step.migration.to}` : ''}`)
      }
      promoted.push(step.name)
    }
  } catch (e) {
    log(`\nrelease: promotion failed at ${plan.steps[promoted.length]?.name}: ${e.message}`)
    if (migrationApplied) {
      log('  A Durable Object migration has been applied, so nothing is rolled back (migrations are forward-only).')
      log('  Fix forward: push a commit that repairs the release; see deploy/README.md, "When a deploy fails".')
    } else if (promoted.length) {
      log(`  rolling back what was promoted (${promoted.join(', ')}) to the previous release`)
      await restore(manifest, previous.workers.filter((w) => promoted.includes(w.name)), `promotion of ${release} failed`)
    }
    throw e
  }
  const after = await liveState(manifest.order)
  const record = recordOf(manifest, after, {
    kind: 'release',
    previousRelease: previous.release,
    migrations: plan.migrations.map((s) => ({ worker: s.name, from: s.migration.from, to: s.migration.to })),
    // contracts/COMPATIBILITY.md §6: what each class's code knows, and whether no rollback may cross this release.
    schemas: schemasOfManifest(manifest),
    forwardOnly: forwardOnly.length > 0,
    forwardOnlyBecause: forwardOnly,
    via: Object.fromEntries(plan.steps.map((s) => [s.name, s.via])),
  })
  for (const w of record.workers) if (w.versionId !== uploaded[w.name]) log(`  warning: ${w.name} serves ${w.versionId}, expected ${uploaded[w.name]}`)
  const file = writeRecord(stage, 'release.json', record)
  writeRecord(stage, `release-${release}.json`, record)
  summary(record, previous)
  log(`\nrelease: ${release} promoted. Record: ${file}; previous: ${previousFile}`)
  return { exit: 0, record, previous, plan }
}

const CLOUDFLARE = { liveState, versionInfo, listVersions, restore: (...a) => restore(...a) }

export async function rollback({ stage, recordFile, record, reason = 'requested', api = CLOUDFLARE }) {
  const manifest = { durableObjectsCodeUpdate: loadPlanCodeUpdate() }
  const target = record ?? JSON.parse(readFileSync(recordFile, 'utf8'))
  if ((target.stage ?? null) !== (stage ?? null)) throw new Error(`the record is for ${target.target}, not ${targetName(stage)}`)
  const names = target.workers.map((w) => w.name)
  const now = await api.liveState(names)
  const problems = []
  for (const w of target.workers) {
    if (!w.versionId) problems.push(`${w.name}: the record has no single version to restore`)
    else if ((now[w.name]?.migrationTag ?? null) !== (w.migrationTag ?? null)) {
      problems.push(`${w.name}: the release being restored ran under Durable Object migration ${w.migrationTag ?? '(none)'}, and ${now[w.name]?.migrationTag ?? '(none)'} is in force now. Cloudflare does not roll back across a class lifecycle change and migrations are forward-only: fix forward instead.`)
    } else if (!(await api.versionInfo(w.name, w.versionId))) problems.push(`${w.name}: version ${w.versionId} no longer exists (Cloudflare keeps the 100 most recent)`)
  }
  // Schema versions (contracts/COMPATIBILITY.md §6): no class's storage may be newer than the target can open.
  if (problems.length === 0) problems.push(...schemaRollbackProblems(target, await versionsSince(target, api)))
  if (problems.length) {
    log(`rollback to ${target.release}: REFUSED, nothing changed:`)
    for (const p of problems) log(`  - ${p}`)
    return { exit: EXIT_REFUSED, problems }
  }
  log(`rollback to ${target.release} (${reason}), callers first:`)
  await api.restore(manifest, target.workers, `${reason}; to ${target.release}`)
  const after = await api.liveState(names)
  const done = { ...recordOf({ ...target, order: names }, after, { kind: 'rollback', release: target.release, reason, schemas: target.schemas }), target: target.target, stage: target.stage }
  writeRecord(stage, 'rollback.json', done)
  summary(done, null)
  return { exit: 0, record: done }
}

function loadPlanCodeUpdate() {
  return JSON.parse(readFileSync(join(DEPLOY_DIR, 'workers.json'), 'utf8')).durable_objects_code_update
}

function printPlan(manifest, plan) {
  log(`release ${manifest.release} → ${manifest.target}`)
  for (const s of plan.steps) {
    log(`  ${s.name.padEnd(22)} ${s.via === 'versions' ? 'upload, then promote' : 'wrangler deploy     '} ${s.migration ? `MIGRATION ${s.migration.from ?? '(none)'} → ${s.migration.to}` : s.exists ? '' : '(new Worker)'}`)
  }
}

/** The release record as a table, to stderr and to the GitHub job summary. */
function summary(record, previous) {
  const rows = record.workers.map((w) => {
    const prev = previous?.workers.find((p) => p.name === w.name)
    return `| ${w.name} | \`${w.versionId ?? '-'}\` | ${w.migrationTag ?? '-'} | ${prev ? `\`${prev.versionId ?? '-'}\`` : '-'} |`
  })
  const md = [
    `### viz ${record.kind}: \`${record.release}\` (${record.target})`,
    '',
    record.migrations?.length ? `Durable Object migrations applied: ${record.migrations.map((m) => `${m.worker} ${m.from ?? '(none)'} → ${m.to}`).join(', ')}` : 'No Durable Object migration in this release.',
    '',
    record.forwardOnly ? `**Forward-only**: no rollback may cross this release. ${record.forwardOnlyBecause.map((f) => f.why).join('; ')}` : record.kind === 'release' ? 'Not forward-only: the previous release can open everything this one writes.' : '',
    '',
    '| Worker | Version | Migration tag in force | Previous version |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
  log(md)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { options: ['stage', 'ack', 'record', 'reason'] })
    checkStage(args.stage)
    const cmd = args._[0]
    const ackText = [args.ack ?? '', process.env.VIZ_ACK_MIGRATIONS ?? ''].join(' ')
    if (cmd === 'deploy') process.exit((await deploy({ stage: args.stage, ackText })).exit)
    else if (cmd === 'plan') {
      const manifest = loadManifest(args.stage)
      const plan = planRelease(manifest, await liveState(manifest.order), parseAcks(ackText))
      printPlan(manifest, plan)
      for (const p of plan.problems) log(`  - ${p}`)
      console.log(JSON.stringify({ migrations: plan.migrations.map((s) => ({ worker: s.name, ...s.migration, ack: s.ack })), refused: plan.problems.length > 0 }))
      process.exit(plan.problems.length ? EXIT_REFUSED : 0)
    } else if (cmd === 'rollback') {
      if (!args.record) throw new Error('rollback needs --record <release.json>')
      process.exit((await rollback({ stage: args.stage, recordFile: args.record, reason: args.reason })).exit)
    } else if (cmd === 'status') {
      const manifest = loadManifest(args.stage)
      console.log(JSON.stringify(await liveState(manifest.order), null, 2))
    } else if (cmd === 'current-release') {
      const manifest = loadManifest(args.stage)
      const from = manifest.releaseFrom ?? manifest.order[0]
      const live = await liveState([from])
      console.log(live[from]?.release ?? '')
    } else throw new Error('usage: release.mjs deploy|plan|rollback|status|current-release')
  } catch (e) {
    log(`release: ${e.message}`)
    process.exit(1)
  }
}
