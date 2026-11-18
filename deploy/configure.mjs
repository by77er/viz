#!/usr/bin/env node
// Generates the wrangler configs viz is deployed with, FROM each component's own
// wrangler.jsonc, at deploy time. Bindings, migrations, crons, vars and compatibility
// settings come from the component; only what differs between "a component's config" and "a
// deployment" is overridden: Worker names, the names a binding uses to reach another Worker
// (script_name, service), resource names and ids, workers_dev and the custom domain,
// observability, deployment-wide vars, and `main` (so wrangler bundles from the component).
//
//   node deploy/configure.mjs [--stage <name>] [--release <sha>] [--ids-optional] [--quiet]
//
// Writes deploy/generated/<production|stage-NAME>/<worker>.jsonc and manifest.json there.
// Anything it does not understand (a binding kind, a resource not named viz-…, a script_name
// that is no Worker of ours, a placeholder id left behind) is an error, not a guess.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEPLOY_DIR, GENERATED_DIR, REPO_ROOT, checkStage, log, parseArgs, readJson, readJsonc, releaseId, stagedName, targetName } from './lib/common.mjs'

const KNOWN_KEYS = new Set([
  'name', 'main', 'compatibility_date', 'compatibility_flags', 'durable_objects', 'migrations', 'r2_buckets', 'kv_namespaces',
  'queues', 'triggers', 'vars', 'services', 'placement', 'observability', 'limits', 'rules', 'routes', 'route', 'workers_dev', 'preview_urls',
])
const PLACEHOLDER_ID = /^0+$/

export function loadPlan() {
  return { plan: readJson(join(DEPLOY_DIR, 'workers.json')), resources: readJson(join(DEPLOY_DIR, 'resources.json')) }
}

/** The Worker a `script_name` or `service` means, as deployed (stage applied). */
function resolveScript(name, plan, stage, where) {
  const canonical = plan.script_aliases?.[name] ?? name
  if (!plan.workers.some((w) => w.name === canonical)) throw new Error(`${where}: refers to "${name}", which is not a Worker in deploy/workers.json`)
  return stagedName(canonical, stage)
}

/** The queue names a config declares: producers, consumers and their dead-letter queues. */
export function queuesOf(cfg) {
  const q = cfg.queues ?? {}
  const names = new Set()
  for (const p of q.producers ?? []) names.add(p.queue)
  for (const c of q.consumers ?? []) {
    names.add(c.queue)
    if (c.dead_letter_queue) names.add(c.dead_letter_queue)
  }
  return [...names]
}

/** Classes a config defines (bound without script_name), and the tag of its newest migration. */
export function durableObjectsOf(cfg) {
  const classes = (cfg.durable_objects?.bindings ?? []).filter((b) => !b.script_name).map((b) => b.class_name)
  const migrations = cfg.migrations ?? []
  const tags = migrations.map((m) => m.tag)
  if (new Set(tags).size !== tags.length) throw new Error('duplicate migration tag')
  return { classes, migrationTags: tags, migrationTag: tags.length ? tags[tags.length - 1] : null }
}

/**
 * One generated config. `ids` maps a KV namespace title to its id. Pure: no I/O, so the tests
 * can call it with any component config.
 */
export function generateWorker({ worker, cfg, componentDir, plan, stage, release, ids, outDir, idsOptional = false }) {
  const where = `${worker.component}/wrangler.jsonc`
  const warnings = []
  for (const k of Object.keys(cfg)) if (!KNOWN_KEYS.has(k)) throw new Error(`${where}: "${k}" is not something configure.mjs knows how to deploy; extend it rather than drop it`)
  const out = structuredClone(cfg)
  out.name = stagedName(worker.name, stage)

  // main: bundle from the component directory. A stage's ingest goes through the shim that
  // maps its prefixed queue names back to the names stack/ compares against.
  const mainAbs = stage && worker.name === plan.resources.queues_from ? join(DEPLOY_DIR, 'stage', 'ingest.ts') : join(componentDir, cfg.main)
  if (!existsSync(mainAbs)) throw new Error(`${where}: main ${cfg.main} does not exist`)
  out.main = relative(outDir, mainAbs)

  // Only the public entry point gets a workers.dev URL, and only in a stage.
  out.workers_dev = Boolean(stage && worker.public)
  out.preview_urls = false
  delete out.route
  delete out.routes
  if (!stage && worker.public) out.routes = [{ pattern: plan.domain, custom_domain: true }]
  out.observability = structuredClone(plan.observability)
  out.upload_source_maps = true

  // KV: by binding name, to the namespace deploy/workers.json names for it.
  for (const kv of out.kv_namespaces ?? []) {
    const title = plan.resources.kv[kv.binding]
    if (!title) throw new Error(`${where}: KV binding ${kv.binding} has no namespace in deploy/workers.json resources.kv`)
    const staged = stagedName(title, stage)
    const id = ids[staged]
    if (!id && !idsOptional) throw new Error(`no id recorded for KV namespace ${staged}; run deploy/resources.mjs first`)
    kv.id = id ?? '00000000000000000000000000000000'
    delete kv.preview_id
  }
  for (const r2 of out.r2_buckets ?? []) {
    if (!plan.resources.r2.includes(r2.bucket_name)) throw new Error(`${where}: R2 bucket ${r2.bucket_name} is not in deploy/workers.json resources.r2`)
    r2.bucket_name = stagedName(r2.bucket_name, stage)
    delete r2.preview_bucket_name
  }
  const q = out.queues ?? {}
  for (const p of q.producers ?? []) p.queue = stagedName(p.queue, stage)
  for (const c of q.consumers ?? []) {
    c.queue = stagedName(c.queue, stage)
    if (c.dead_letter_queue) c.dead_letter_queue = stagedName(c.dead_letter_queue, stage)
  }
  const crossScript = []
  for (const b of out.durable_objects?.bindings ?? []) {
    if (b.script_name) {
      b.script_name = resolveScript(b.script_name, plan, stage, `${where} durable_objects ${b.name}`)
      crossScript.push(`${b.name} → ${b.script_name}:${b.class_name}`)
    }
  }
  for (const s of out.services ?? []) {
    s.service = resolveScript(s.service, plan, stage, `${where} services ${s.binding}`)
    crossScript.push(`${s.binding} → ${s.service}`)
  }

  // vars: deployment-wide values where the component declares them; the release; the stage.
  const vars = { ...(out.vars ?? {}) }
  for (const [k, v] of Object.entries(plan.shared_vars ?? {})) {
    if (k.startsWith('$') || !(k in vars)) continue
    if (vars[k] !== v) warnings.push(`${k}: ${where} has ${vars[k]}; deployed with the deployment-wide ${v}`)
    vars[k] = v
  }
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v !== 'string') continue
    let s = v
    for (const bucket of plan.resources.r2) s = s.split(`s3://${bucket}`).join(`s3://${stagedName(bucket, stage)}`)
    vars[k] = s
  }
  vars.VIZ_RELEASE = release
  vars.VIZ_WORKER = worker.name
  if (stage) vars.VIZ_STAGE_PREFIX = `viz-${stage}-`
  out.vars = vars

  const text = JSON.stringify(out, null, 2)
  if (/"id":\s*"0{32}"/.test(text) && !idsOptional) throw new Error(`${where}: a placeholder KV id survived`)
  for (const id of (out.kv_namespaces ?? []).map((k) => k.id)) if (PLACEHOLDER_ID.test(id) && !idsOptional) throw new Error(`${where}: placeholder KV id`)
  const dobj = durableObjectsOf(cfg)
  return {
    config: out,
    text,
    summary: {
      name: out.name,
      canonical: worker.name,
      component: worker.component,
      deploy: worker.deploy !== false,
      reason: worker.reason ?? null,
      public: Boolean(worker.public),
      health: worker.health ?? null,
      doClasses: dobj.classes,
      migrationTags: dobj.migrationTags,
      migrationTag: dobj.migrationTag,
      crossScript,
      queues: queuesOf(out),
      warnings,
    },
  }
}

export function configure({ stage, release = releaseId(), idsOptional = false, quiet = false } = {}) {
  checkStage(stage)
  const { plan, resources } = loadPlan()
  const ids = resources.kv_namespaces ?? {}
  const outDir = join(GENERATED_DIR, targetName(stage))
  mkdirSync(outDir, { recursive: true })
  const workers = []
  for (const worker of plan.workers) {
    const componentDir = join(REPO_ROOT, worker.component)
    const cfgPath = join(componentDir, 'wrangler.jsonc')
    if (!existsSync(cfgPath)) {
      if (worker.deploy === false) {
        workers.push({ name: stagedName(worker.name, stage), canonical: worker.name, component: worker.component, deploy: false, reason: `${worker.reason} (component not in this checkout)` })
        continue
      }
      throw new Error(`${worker.component}/wrangler.jsonc not found, and ${worker.name} is to be deployed`)
    }
    const g = generateWorker({ worker, cfg: readJsonc(cfgPath), componentDir, plan, stage, release, ids, outDir, idsOptional })
    const file = join(outDir, `${worker.name}.jsonc`)
    const header = `// GENERATED by deploy/configure.mjs from ${worker.component}/wrangler.jsonc for ${targetName(stage)}, release ${release}. Do not edit.\n`
    writeFileSync(file, header + g.text + '\n')
    workers.push({ ...g.summary, config: relative(REPO_ROOT, file) })
  }
  const ingest = plan.workers.find((w) => w.name === plan.resources.queues_from)
  const ingestCfg = readJsonc(join(REPO_ROOT, ingest.component, 'wrangler.jsonc'))
  const manifest = {
    target: targetName(stage),
    stage: stage ?? null,
    release,
    generatedAt: new Date().toISOString(),
    domain: stage ? null : plan.domain,
    durableObjectsCodeUpdate: plan.durable_objects_code_update,
    order: workers.filter((w) => w.deploy).map((w) => w.name),
    workers,
    resources: {
      kv: Object.values(plan.resources.kv).map((t) => ({ title: stagedName(t, stage), id: ids[stagedName(t, stage)] ?? null })),
      r2: plan.resources.r2.map((b) => stagedName(b, stage)),
      queues: queuesOf(ingestCfg).map((q) => stagedName(q, stage)),
    },
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  if (!quiet) {
    log(`configure: ${manifest.target}, release ${release} → ${relative(REPO_ROOT, outDir)}/`)
    for (const w of workers) {
      log(`  ${w.deploy ? 'deploy' : 'skip  '} ${w.name.padEnd(24)} ${w.deploy ? `from ${w.component}/; migration ${w.migrationTag ?? '-'}; ${w.crossScript?.join(', ') || 'no cross-script bindings'}` : w.reason}`)
      for (const warn of w.warnings ?? []) log(`         note: ${warn}`)
    }
  }
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { flags: ['ids-optional', 'quiet'], options: ['stage', 'release'] })
    const m = configure({ stage: args.stage, release: args.release, idsOptional: args['ids-optional'], quiet: args.quiet })
    console.log(join(GENERATED_DIR, m.target, 'manifest.json'))
  } catch (e) {
    log(`configure: ${e.message}`)
    process.exit(1)
  }
}
