#!/usr/bin/env node
// Upload, then promote; record; roll back. Reads the manifest configure.mjs wrote.
//
//   node deploy/release.mjs deploy   [--stage S] [--ack "viz-ingest@v2 …"] [--rotate-secret NAME]
//                                    upload every Worker, then promote in order
//   node deploy/release.mjs rollback --record <release.json> [--stage S] [--reason …] [--accept-secret-loss NAME]
//                                    [--only viz-query,…]   restore only these Workers of the record
//   node deploy/release.mjs plan     [--stage S] [--ack …] [--rotate-secret NAME]   what deploy would do; exit 3 if refused
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
// - Secrets the deploy generates (lib/secrets.mjs, D53: viz-control's OAUTH_CLIENT_KEY) are put
//   on the version phase 1 uploaded (or, for a Worker that goes out with `wrangler deploy`, on
//   the version it just deployed) only when that version does not carry them, value on stdin;
//   phase 2 promotes the keyed version. Replaced only when asked (--rotate-secret,
//   VIZ_ROTATE_SECRETS); a secret that is set now but missing from the upload is a refusal.
//   Every version a run uploads carries VIZ_DEPLOY_RUN, unique to the run; the keyed version must
//   carry this run's, or the key went on another run's upload and nothing is promoted (m-11).
// - Formats (contracts/COMPATIBILITY.md §6, D69): the record and every version (VIZ_FORMATS) name
//   the version of each format a Worker writes and, completely, the versions it reads
//   (lib/formats.mjs); a Worker that declares nothing is taken to read version 1 of every format. A
//   release that writes a version some Worker serving before it does not read is FORWARD-ONLY. A
//   rollback refuses when a Worker it restores does not read a version that any newer version of a
//   restored Worker wrote, or that any kept version of a Worker the record leaves out (it keeps
//   serving) wrote or writes (review of D69, M-1).
// - Rollback floors a writer's switch raises (lib/floors.mjs, D64, D69): a release that sets
//   INGEST_SIGNALS on viz-ingest is refused unless viz-publisher (publisher.Publisher schema 4 or
//   later), viz-query and viz-ingest (stamped VIZ_FLOORS) are each at their floor in this release and
//   as they serve now, a floor Worker this release does not deploy included; once any kept viz-ingest
//   version set it (as a var of any type, or a secret), a release or a rollback that would leave one
//   of them below its floor is refused, and a release is refused while the switch is a secret.
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { currentDeployment, listScripts, listVersions, versionInfo } from './lib/cf.mjs'
import { DEPLOY_DIR, GENERATED_DIR, REPO_ROOT, checkStage, log, parseArgs, readJsonc, stagedName, targetName } from './lib/common.mjs'
import { floorDeployProblems, floorRollbackProblems, floorRules, floorsOfVersion } from './lib/floors.mjs'
import { formatsMap, formatsOfVersion, readersOf, recordReaders } from './lib/formats.mjs'
import { schemasOfVersion } from './lib/schemas.mjs'
import { GENERATED_SECRETS, ROTATE_ENV, RUN_VAR, SecretRefused, ensureSecrets, parseRotate, planSecrets, rotateProblems, secretFacts, secretRollbackProblems, secretsNow, secretsOfManifest } from './lib/secrets.mjs'
import { versionIdFrom, wrangler } from './lib/wrangler.mjs'

export const EXIT_REFUSED = 3

/** What lib/secrets.mjs needs from wrangler and the Cloudflare API. */
const SECRET_API = { wrangler, versionInfo, listVersions }
/** What lib/floors.mjs reads from the Cloudflare API. */
const FLOOR_API = { versionInfo, listVersions }

/** deploy/workers.json, as release.mjs reads it at deploy and rollback time. */
const loadWorkersPlan = () => JSON.parse(readFileSync(join(DEPLOY_DIR, 'workers.json'), 'utf8'))

/** A value unique to one run of `release.mjs deploy` (m-11): every version it uploads carries it as VIZ_DEPLOY_RUN. */
export const newRunId = () => `${process.env.GITHUB_RUN_ID ? `gh${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT ?? 1}-` : ''}${randomUUID()}`

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
 * its VIZ_SCHEMAS var), of each format (`formats`, from VIZ_FORMATS) and which rollback floors its
 * code is stamped at (`floors`, from VIZ_FLOORS); each null when it declares nothing or more than
 * one version serves.
 */
export async function liveState(names) {
  const scripts = await listScripts()
  const out = {}
  for (const name of names) {
    const s = scripts.find((x) => x.id === name)
    if (!s) {
      out[name] = { exists: false, migrationTag: null, versions: [], release: null, schemas: null, formats: null, floors: null }
      continue
    }
    const dep = await currentDeployment(name)
    const versions = dep?.versions ?? []
    let release = null
    let schemas = null
    let formats = null
    let floors = null
    if (versions.length === 1) {
      const v = await versionInfo(name, versions[0].version_id)
      release = annotation(v, 'workers/tag')
      schemas = schemasOfVersion(v)
      formats = formatsOfVersion(v)
      floors = floorsOfVersion(v)
    }
    out[name] = { exists: true, migrationTag: s.migration_tag ?? null, versions, release, schemas, formats, floors }
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
 * - `format`: this release writes a version of a format that the serving release does not read
 *   (COMPATIBILITY.md §6). What the serving release reads of a format is what every Worker serving
 *   now reads (`live`: this release's Workers and any other Worker of the deployment it was asked
 *   about), as its version declares (VIZ_FORMATS): one that declares nothing at all is taken to read
 *   version 1 of every format, an incomplete declaration (D69's) version 1 of any format it does not
 *   list (lib/formats.mjs `readsOf`; review of D69, M-1 (c)).
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
  // Every Worker serving now, as it declares what it reads (null: nothing declared, or more than one version serving).
  const serving = Object.fromEntries(Object.entries(live).filter(([, l]) => l?.exists).map(([n, l]) => [n, l.formats ?? null]))
  for (const name of manifest.order) {
    const w = manifest.workers.find((x) => x.name === name)
    for (const f of w.formats ?? []) {
      if (f.writes === null) continue
      const r = readersOf(serving, f.format)
      if (r.reads === null || r.reads.includes(f.writes)) continue // nothing serving reads it, or every reader reads this version
      const assumed = [...r.undeclared, ...r.implicit]
      out.push({
        worker: name,
        kind: 'format',
        format: f.format,
        writes: f.writes,
        previousReads: r.reads,
        previousDeclared: assumed.length === 0,
        why: `${f.format}: ${name} writes version ${f.writes}, and the release serving before it reads only ${r.reads.join(', ')}${assumed.length === 0 ? '' : ` (${assumed.join(', ')} declares no version of this format, so it is taken to read version 1)`}; contracts/COMPATIBILITY.md §3.3 deploys the reader first`,
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
 * `{ worker: { format: { writes, reads } } }` of a manifest's Workers: every Worker that declares
 * its formats, also one that declares none (`{}`: it reads nothing). A Worker without a declaration
 * is left out, and a rollback to the record takes it to read version 1 of every format.
 */
export function formatsOfManifest(manifest) {
  const out = {}
  for (const name of manifest.order) {
    const list = manifest.workers.find((x) => x.name === name)?.formats
    if (Array.isArray(list)) out[name] = formatsMap(list)
  }
  return out
}

/** What the serving versions declare, as a record's `formats` (for `previous.json`); null if none declares. */
function formatsOfLive(manifest, live) {
  const out = {}
  for (const name of manifest.order) if (live[name]?.formats) out[name] = live[name].formats
  return Object.keys(out).length > 0 ? out : null
}

/**
 * contracts/COMPATIBILITY.md §6 for formats, for a rollback to the release recorded in `target`:
 * the Workers it restores must read every version of a format that was written since, and that the
 * Workers it leaves serving write. Pure.
 *
 * - What the restored Workers read: their entries in the record's `formats` (lib/formats.mjs
 *   `recordReaders`, `readsOf`): a record from before format versions, or a restored Worker it has
 *   no entry for, is taken to read version 1 of every format; a record from before declarations were
 *   complete (no `formatsComplete`), version 1 of any format an entry does not list. Only the Workers
 *   the record restores read under it: an entry of a Worker left out of `workers` is not a reader.
 * - `ran`: every version of the restored Workers that write formats, newer than the target's own
 *   (`{ worker, versionId, release, formats }`, `formats` from VIZ_FORMATS, null if it declares
 *   none). One that declares none wrote something unknown and is refused, as for schemas.
 * - `left`: the kept versions of the Workers that write formats and that the record leaves out
 *   (`{ ..., serving }`): they keep serving, so what they wrote and write stays under the restored
 *   Workers (review of D69, M-1). Unknown is refused too.
 */
export function formatRollbackProblems(target, ran, { left = [] } = {}) {
  const problems = []
  const restored = target.workers?.map((w) => w.name) ?? Object.keys(target.formats ?? {})
  const readers = target.formats ? recordReaders(target, restored) : null
  const why = (r) =>
    r.whole
      ? ' (its record predates format versions: taken to read version 1 of every format)'
      : r.undeclared.length
        ? ` (${r.undeclared.join(', ')} has no format versions in that record: taken to read version 1 of every format)`
        : r.implicit.length
          ? ` (${r.implicit.join(', ')} does not list it, in a record from before format declarations were complete: taken to read version 1 of it)`
          : ''
  for (const v of ran) {
    if (v.formats === null) {
      problems.push(`${v.worker}: version ${v.versionId} (release ${v.release ?? 'unknown'}), newer than the one being restored, does not declare its format versions, so what it may have written is unknown. Fix forward.`)
      continue
    }
    for (const [format, f] of Object.entries(v.formats)) {
      if (f.writes === null) continue
      const r = readersOf(readers, format)
      if (r.reads === null || r.reads.includes(f.writes)) continue
      problems.push(
        `${format}: release ${v.release ?? 'unknown'} (${v.worker} version ${v.versionId}) wrote version ${f.writes}, and ${target.release} reads only ${r.reads.join(', ')}` +
          `${why(r)}. A rollback to it would leave what was written unreadable (contracts/COMPATIBILITY.md §6). Fix forward instead.`,
      )
    }
  }
  for (const v of left) {
    if (v.formats === null) {
      problems.push(`${v.worker}: this rollback leaves it serving (the record does not restore it), and its version ${v.versionId} (release ${v.release ?? 'unknown'}) does not declare its format versions, so what it wrote is unknown. Restore it with the others (the whole record), or fix forward.`)
      continue
    }
    for (const [format, f] of Object.entries(v.formats)) {
      if (f.writes === null) continue
      const r = readersOf(readers, format)
      if (r.reads === null || r.reads.includes(f.writes)) continue
      problems.push(
        `${format}: ${v.worker} is left serving by this rollback (the record does not restore it), and its version ${v.versionId} (release ${v.release ?? 'unknown'}${v.serving ? ', serving now' : ''}) writes version ${f.writes}, and ${target.release} reads only ${r.reads.join(', ')}${why(r)}. ` +
          `What it wrote${v.serving ? ', and keeps writing,' : ''} would be unreadable by the Workers restored (contracts/COMPATIBILITY.md §6; review of D69, M-1). Restore ${v.worker} with them, or fix forward.`,
      )
    }
  }
  return [...new Set(problems)]
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

/** The Workers of a target record whose versions carry schema versions: those its `schemas` name. */
const schemaWorkers = (target) => new Set(Object.values(target.schemas ?? {}).map((x) => x.worker))

/**
 * The Workers that write formats, whose versions a rollback judges as writers: those whose entry in
 * the target's record writes one, and those deploy/workers.json declares a `writes` source for now
 * (a record from before format versions names none, and a version uploaded since by such a Worker
 * may have written any of them). A Worker that writes no recorded format (viz-query, viz-mcp,
 * viz-gateway) is judged only as a reader.
 */
function formatWriters(target, plan) {
  const out = new Set(Object.entries(target.formats ?? {}).filter(([, f]) => Object.values(f ?? {}).some((x) => x?.writes !== null && x?.writes !== undefined)).map(([n]) => n))
  for (const w of plan.workers) if (w.formats?.writes?.length) out.add(stagedName(w.name, target.stage ?? undefined))
  return out
}

/**
 * Every kept version of each Worker in `names`, which the rollback leaves serving: those newer than
 * its version in `full` (the record before `--only`), when the record names one, else every version
 * Cloudflare keeps (a superset of what ran since the target, which only makes the check stricter);
 * its serving versions always. `{ worker, versionId, number, release, formats, serving }`.
 */
async function versionsLeftServing(full, names, now, api) {
  const out = []
  for (const name of names) {
    const bound = full.workers.find((w) => w.name === name)?.versionId
    const boundNumber = bound ? ((await api.versionInfo(name, bound))?.number ?? null) : null
    const serving = new Set((now[name]?.versions ?? []).map((v) => v.version_id))
    for (const v of await api.listVersions(name)) {
      if (!serving.has(v.id) && boundNumber !== null && v.number !== undefined && v.number <= boundNumber) continue
      const info = await api.versionInfo(name, v.id)
      out.push({ worker: name, versionId: v.id, number: v.number, release: annotation(info, 'workers/tag'), formats: formatsOfVersion(info), serving: serving.has(v.id) })
    }
  }
  return out
}

/** Every version Cloudflare keeps of the target's Workers in `names` that is newer than the target's. */
async function versionsSince(target, api, names) {
  const out = []
  for (const w of target.workers) {
    if (!names.has(w.name) || !w.versionId) continue
    const own = await api.versionInfo(w.name, w.versionId)
    const ownNumber = own?.number ?? null
    for (const v of await api.listVersions(w.name)) {
      if (v.id === w.versionId) continue
      if (ownNumber !== null && v.number !== undefined && v.number <= ownNumber) continue
      const info = await api.versionInfo(w.name, v.id)
      out.push({ worker: w.name, versionId: v.id, number: v.number, release: annotation(info, 'workers/tag'), schemas: schemasOfVersion(info), formats: formatsOfVersion(info), ...secretFacts(info) })
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

/** The vars of a manifest Worker's generated config (what its versions are uploaded with). */
const varsOfGenerated = (w) => readJsonc(join(REPO_ROOT, w.config)).vars ?? {}

/**
 * The Workers a deploy reads the live state of: this release's, every other Worker of the manifest
 * (one not deployed here keeps serving, and reading: review of D69, M-1 and m-3), and every Worker a
 * rollback floor names.
 */
const liveNames = (manifest, rules) => [...new Set([...manifest.order, ...manifest.workers.map((w) => w.name), ...rules.flatMap((r) => [r.writer, ...r.floors.map((f) => f.worker)])])]

export async function deploy({ stage, ackText = '', rotateText = '' }) {
  const manifest = loadManifest(stage)
  const release = manifest.release
  const tag = release.slice(0, 40)
  const message = `viz ${release}`.slice(0, 100)
  // Unique to this run: on every version it uploads (VIZ_DEPLOY_RUN), so a version another run of
  // the same release uploaded is told apart from this run's (review of D53, m-11).
  const run = newRunId()
  const runVar = ['--var', `${RUN_VAR}:${run}`]
  const rules = floorRules(loadWorkersPlan(), stage)
  const before = await liveState(liveNames(manifest, rules))
  // formatsComplete: each entry is what that version declared (with lib/formats.mjs ANY where its declaration was incomplete).
  const previous = recordOf(manifest, before, { release: servingRelease(manifest, before), kind: 'previous', schemas: schemasOfLive(manifest, before), formats: formatsOfLive(manifest, before), formatsComplete: true })
  const previousFile = writeRecord(stage, 'previous.json', previous)
  const plan = planRelease(manifest, before, parseAcks(ackText))
  const forwardOnly = forwardOnlyReasons(manifest, before)
  const floors = await floorDeployProblems(rules, manifest, before, FLOOR_API, varsOfGenerated)
  const specs = secretsOfManifest(manifest)
  const rotate = parseRotate(rotateText)
  const secretsBefore = await secretsNow(specs, before, SECRET_API)
  log(`run ${run}`)
  printPlan(manifest, plan, planSecrets(secretsBefore, rotate, plan.steps))
  for (const f of forwardOnly) log(`  FORWARD-ONLY: ${f.why}`)
  const refusals = [...plan.problems, ...floors.problems, ...rotateProblems(rotate, specs)]
  if (refusals.length) {
    log('\nrelease: REFUSED before uploading or promoting anything:')
    for (const p of refusals) log(`  - ${p}`)
    log('  See deploy/README.md, "Durable Object migrations", "Rollback floors" and "Worker secrets the deploy generates".')
    return { exit: EXIT_REFUSED, plan }
  }
  const secretActions = []
  const withSecrets = (step, versionId) => {
    const mine = specs.filter((s) => s.worker === step.name)
    if (mine.length === 0) return null
    // `deployed`: the version wrangler deploy made in phase 2 serves already, so a refusal there comes after promotion (m-5).
    return ensureSecrets({ worker: step.name, versionId, specs: mine, now: secretsBefore, rotate, release, run, tag, message, api: SECRET_API, deployed: step.via === 'deploy', log })
  }

  // Phase 1: upload (or, where a version cannot be uploaded, bundle). Nothing serves yet.
  log('\nphase 1: upload')
  const uploaded = {}
  try {
    for (const step of plan.steps) {
      if (step.via === 'versions') {
        const r = await wrangler(['versions', 'upload', '--config', join(REPO_ROOT, step.config), '--tag', tag, '--message', message, ...runVar], { label: step.name })
        uploaded[step.name] = versionIdFrom(r, 'version-upload')
        log(`  ${step.name}: uploaded ${uploaded[step.name]} (serving nothing yet)`)
        // Generated secrets go on the upload, still serving nothing; phase 2 promotes the keyed version.
        const s = await withSecrets(step, uploaded[step.name])
        if (s) {
          secretActions.push(...s.actions)
          uploaded[step.name] = s.versionId
        }
      } else {
        await wrangler(['deploy', '--dry-run', '--config', join(REPO_ROOT, step.config), '--outdir', join(GENERATED_DIR, targetName(stage), 'dry-run', step.name)], { label: step.name, quiet: true })
        log(`  ${step.name}: bundled; goes out with wrangler deploy in phase 2 (${step.migration ? `migration ${step.migration.from ?? '(none)'} → ${step.migration.to}` : 'new Worker'})`)
      }
    }
  } catch (e) {
    if (!(e instanceof SecretRefused)) throw e
    log(`\nrelease: REFUSED in phase 1, before promoting anything (uploaded versions serve nothing):\n  - ${e.message}`)
    return { exit: EXIT_REFUSED, plan }
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
        const r = await wrangler(['deploy', '--config', join(REPO_ROOT, step.config), '--tag', tag, '--message', message, ...doMode(manifest), ...runVar], { label: step.name })
        uploaded[step.name] = versionIdFrom(r, 'deploy')
        if (step.migration) migrationApplied = true
        log(`  ${step.name}: deployed ${uploaded[step.name]}${step.migration ? ` with migration ${step.migration.to}` : ''}`)
        // A new (or migrating) Worker had no version to put a secret on in phase 1: put it on the
        // version just deployed and deploy the keyed one, before any later Worker (the gateway) is promoted.
        const s = await withSecrets(step, uploaded[step.name])
        if (s) {
          secretActions.push(...s.actions)
          if (s.versionId !== uploaded[step.name]) {
            await wrangler(['versions', 'deploy', `${s.versionId}@100%`, '--config', join(REPO_ROOT, step.config), '--yes', '--message', message, ...doMode(manifest)], { label: step.name })
            uploaded[step.name] = s.versionId
            log(`  ${step.name}: ${s.versionId} (with its generated secrets) at 100%`)
          }
        }
      }
      promoted.push(step.name)
    }
  } catch (e) {
    // A refusal here (SecretRefused, on a Worker that went out with wrangler deploy) is a failure in phase 2: exit 1 (review of D69, m-5).
    log(`\nrelease: ${e instanceof SecretRefused ? 'REFUSED in phase 2, after promotion began (exit 1)' : 'promotion failed'} at ${plan.steps[promoted.length]?.name}: ${e.message}`)
    // A Worker promoted for which this release is forward-only (a schema its objects may have
    // migrated, a format version it may have written) cannot be put back under the previous release.
    const crossed = forwardOnly.filter((f) => promoted.includes(f.worker))
    if (migrationApplied) {
      log('  A Durable Object migration has been applied, so nothing is rolled back (migrations are forward-only).')
      log('  Fix forward: push a commit that repairs the release; see deploy/README.md, "When a deploy fails".')
    } else if (crossed.length) {
      log(`  This release is forward-only for what was promoted (${crossed.map((f) => f.why).join('; ')}), so nothing is rolled back: the previous release could not read it.`)
      log('  Fix forward: push a commit that repairs the release; see deploy/README.md, "When a deploy fails".')
    } else if (promoted.length) {
      // A Worker whose generated secret this release created or rotated stays: restoring it would
      // serve without the key, or be refused by Cloudflare (10220) midway (measured, S9). It is a
      // callee of what is put back, newer than its callers: the skew COMPATIBILITY.md allows.
      const keyed = new Set(secretActions.filter((a) => a.action !== 'kept').map((a) => a.worker))
      for (const name of promoted.filter((n) => keyed.has(n))) log(`  ${name}: left on this release's version: its generated secret was ${secretActions.find((a) => a.worker === name).action} by it`)
      const back = promoted.filter((n) => !keyed.has(n))
      if (back.length) {
        log(`  rolling back what was promoted (${back.join(', ')}) to the previous release`)
        await restore(manifest, previous.workers.filter((w) => back.includes(w.name)), `promotion of ${release} failed`)
      }
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
    // The same for formats: the version each Worker writes and, completely, the versions it reads (D69; review of D69, M-1).
    formats: formatsOfManifest(manifest),
    formatsComplete: true,
    forwardOnly: forwardOnly.length > 0,
    forwardOnlyBecause: forwardOnly,
    // Rollback floors a writer's switch raises (D64, D69): what each rule saw.
    floors: floors.seen,
    via: Object.fromEntries(plan.steps.map((s) => [s.name, s.via])),
    // Generated secrets, by name: kept, created or rotated, and on which version. Never a value.
    secrets: secretActions.map(({ worker, name, action, versionId }) => ({ worker, name, action, versionId })),
    // The VIZ_DEPLOY_RUN every version this run uploaded carries.
    run,
  })
  for (const w of record.workers) if (w.versionId !== uploaded[w.name]) log(`  warning: ${w.name} serves ${w.versionId}, expected ${uploaded[w.name]}`)
  const file = writeRecord(stage, 'release.json', record)
  writeRecord(stage, `release-${release}.json`, record)
  summary(record, previous)
  log(`\nrelease: ${release} promoted. Record: ${file}; previous: ${previousFile}`)
  return { exit: 0, record, previous, plan }
}

const CLOUDFLARE = { liveState, versionInfo, listVersions, restore: (...a) => restore(...a) }

/**
 * The record restricted to the Workers `only` names (`--only`, comma or space separated; production
 * or deployed names): the others keep what serves now, and are judged as they serve. Unknown names
 * are refused, not ignored.
 */
export function restrictRecord(full, only, stage) {
  const asked = String(only ?? '').split(/[\s,;]+/).filter(Boolean)
  if (asked.length === 0) return full
  const names = asked.map((n) => (full.workers.some((w) => w.name === n) ? n : stagedName(n, stage ?? undefined)))
  const unknown = names.filter((n) => !full.workers.some((w) => w.name === n))
  if (unknown.length) throw new Error(`--only names ${unknown.join(', ')}, which the record of ${full.release} does not have (it has ${full.workers.map((w) => w.name).join(', ')})`)
  return { ...full, workers: full.workers.filter((w) => names.includes(w.name)) }
}

export async function rollback({ stage, recordFile, record, reason = 'requested', acceptSecretLoss = '', only = '', api = CLOUDFLARE }) {
  const plan = loadWorkersPlan()
  const manifest = { durableObjectsCodeUpdate: plan.durable_objects_code_update }
  const full = record ?? JSON.parse(readFileSync(recordFile, 'utf8'))
  if ((full.stage ?? null) !== (stage ?? null)) throw new Error(`the record is for ${full.target}, not ${targetName(stage)}`)
  const target = restrictRecord(full, only, stage)
  const names = target.workers.map((w) => w.name)
  const rules = floorRules(plan, stage)
  // Every Worker of the deployment and every Worker a floor rule names too: one the record does not
  // restore keeps what serves now, and is judged as it serves (formats: review of D69, M-1; floors).
  const deployment = plan.workers.map((w) => stagedName(w.name, stage))
  const now = await api.liveState([...new Set([...names, ...deployment, ...rules.flatMap((r) => r.floors.map((f) => f.worker))])])
  const problems = []
  const targetInfo = {}
  for (const w of target.workers) {
    if (!w.versionId) problems.push(`${w.name}: the record has no single version to restore`)
    else if ((now[w.name]?.migrationTag ?? null) !== (w.migrationTag ?? null)) {
      problems.push(`${w.name}: the release being restored ran under Durable Object migration ${w.migrationTag ?? '(none)'}, and ${now[w.name]?.migrationTag ?? '(none)'} is in force now. Cloudflare does not roll back across a class lifecycle change and migrations are forward-only: fix forward instead.`)
    } else if (!(targetInfo[w.name] = await api.versionInfo(w.name, w.versionId))) problems.push(`${w.name}: version ${w.versionId} no longer exists (Cloudflare keeps the 100 most recent)`)
  }
  if (problems.length === 0) {
    const fw = formatWriters(target, plan)
    // Generated secrets (D53; measured on Cloudflare, S9): the Workers that carry one.
    const specs = GENERATED_SECRETS.map((sp) => ({ ...sp, worker: stagedName(sp.worker, stage), canonical: sp.worker })).filter((sp) => names.includes(sp.worker))
    const ran = await versionsSince(target, api, new Set([...schemaWorkers(target), ...fw, ...specs.map((sp) => sp.worker)]))
    // A key the restored version lacks, or a rotation since it: refused before anything is moved.
    problems.push(...secretRollbackProblems({ target, targetInfo, ran: ran.filter((v) => specs.some((sp) => sp.worker === v.worker)), specs, accept: parseRotate(acceptSecretLoss) }))
    // Schema versions (contracts/COMPATIBILITY.md §6): no class's storage may be newer than the target can open.
    problems.push(...schemaRollbackProblems(target, ran.filter((v) => schemaWorkers(target).has(v.worker))))
    // Format versions (§6, D69): the restored Workers read every format version written since the
    // target, and every one that the Workers this rollback leaves serving wrote and write (M-1).
    const left = await versionsLeftServing(full, [...fw].filter((n) => !names.includes(n) && now[n]?.exists), now, api)
    problems.push(...formatRollbackProblems(target, ran.filter((v) => fw.has(v.worker)), { left }))
    // Rollback floors (D64, D69): no reader below its floor under a writer whose switch was on.
    problems.push(...(await floorRollbackProblems(rules, target, now, api)))
  }
  if (problems.length) {
    log(`rollback to ${target.release}: REFUSED, nothing changed:`)
    for (const p of problems) log(`  - ${p}`)
    return { exit: EXIT_REFUSED, problems }
  }
  log(`rollback to ${target.release} (${reason}), callers first:`)
  await api.restore(manifest, target.workers, `${reason}; to ${target.release}`)
  const after = await api.liveState(names)
  const done = { ...recordOf({ ...target, order: names }, after, { kind: 'rollback', release: target.release, reason, schemas: target.schemas, formats: target.formats ?? null, formatsComplete: target.formatsComplete === true }), target: target.target, stage: target.stage }
  writeRecord(stage, 'rollback.json', done)
  summary(done, null)
  return { exit: 0, record: done }
}

function printPlan(manifest, plan, secrets = []) {
  log(`release ${manifest.release} → ${manifest.target}`)
  for (const s of plan.steps) {
    log(`  ${s.name.padEnd(22)} ${s.via === 'versions' ? 'upload, then promote' : 'wrangler deploy     '} ${s.migration ? `MIGRATION ${s.migration.from ?? '(none)'} → ${s.migration.to}` : s.exists ? '' : '(new Worker)'}`)
  }
  for (const s of secrets) log(`  ${s.line}`)
}

/**
 * `release.mjs plan`: what deploy would do, changing nothing (no wrangler call; Cloudflare's API
 * is only read). A generated secret that is not set yet is reported as "would be created".
 */
export async function planOnly({ stage, ackText = '', rotateText = '' }) {
  const manifest = loadManifest(stage)
  const rules = floorRules(loadWorkersPlan(), stage)
  const live = await liveState(liveNames(manifest, rules))
  const plan = planRelease(manifest, live, parseAcks(ackText))
  const specs = secretsOfManifest(manifest)
  const rotate = parseRotate(rotateText)
  const secrets = planSecrets(await secretsNow(specs, live, SECRET_API), rotate, plan.steps)
  const floors = await floorDeployProblems(rules, manifest, live, FLOOR_API, varsOfGenerated)
  const forwardOnly = forwardOnlyReasons(manifest, live)
  const problems = [...plan.problems, ...floors.problems, ...rotateProblems(rotate, specs)]
  printPlan(manifest, plan, secrets)
  for (const f of forwardOnly) log(`  FORWARD-ONLY: ${f.why}`)
  for (const p of problems) log(`  - ${p}`)
  return { exit: problems.length ? EXIT_REFUSED : 0, plan, secrets: secrets.map(({ worker, name, action }) => ({ worker, name, action })), forwardOnly, problems }
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
    record.secrets?.length ? `Generated secrets: ${record.secrets.map((s) => `${s.name} on ${s.worker} ${s.action}${s.action === 'kept' ? '' : ` (version \`${s.versionId}\`)`}`).join(', ')}` : '',
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
    const args = parseArgs(process.argv.slice(2), { options: ['stage', 'ack', 'record', 'reason', 'rotate-secret', 'accept-secret-loss', 'only'] })
    checkStage(args.stage)
    const cmd = args._[0]
    const ackText = [args.ack ?? '', process.env.VIZ_ACK_MIGRATIONS ?? ''].join(' ')
    const rotateText = [args['rotate-secret'] ?? '', process.env[ROTATE_ENV] ?? ''].join(' ')
    if (cmd === 'deploy') process.exit((await deploy({ stage: args.stage, ackText, rotateText })).exit)
    else if (cmd === 'plan') {
      const r = await planOnly({ stage: args.stage, ackText, rotateText })
      console.log(JSON.stringify({ migrations: r.plan.migrations.map((s) => ({ worker: s.name, ...s.migration, ack: s.ack })), secrets: r.secrets, refused: r.exit !== 0 }))
      process.exit(r.exit)
    } else if (cmd === 'rollback') {
      if (!args.record) throw new Error('rollback needs --record <release.json>')
      process.exit((await rollback({ stage: args.stage, recordFile: args.record, reason: args.reason, acceptSecretLoss: args['accept-secret-loss'] ?? '', only: args.only ?? '' })).exit)
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
