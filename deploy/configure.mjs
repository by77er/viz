#!/usr/bin/env node
// Generates the wrangler configs viz is deployed with, FROM each component's own
// wrangler.jsonc, at deploy time. Bindings, migrations, crons, vars and compatibility
// settings come from the component; only what differs between "a component's config" and "a
// deployment" is overridden: Worker names, the names a binding uses to reach another Worker
// (script_name, service), resource names and ids, workers_dev and the custom domain,
// observability, deployment-wide vars, and `main` (so wrangler bundles from the component).
//
//   node deploy/configure.mjs [--stage <name>] [--release <sha>] [--expires <ISO time>] [--ids-optional] [--quiet]
//                             [--oauth-without-rate-limits] [--oauth-public]      (a stage only)
//
// --expires (a stage only): sets VIZ_STAGE_EXPIRES_AT in every Worker; the ruler's alarms and
// cron stop at that time by themselves (AGENTS.md: anything on a timer stops at a deadline).
//
// VIZ_STAGE_VARS (a stage only, from the environment): JSON `{ "<worker>": { "VAR": "value" } }`,
// set on top of the component's vars, e.g. a trial's shorter maintenance graces. Refused for
// production, whose vars come only from the components and workers.json.
//
// Schemas: every Durable Object class a Worker defines is declared in workers.json, either with
// its SchemaSpec (`schemas`) or as keeping no storage (`unversioned`). The specs are read
// (lib/schemas.mjs) into the manifest, and into each version's `VIZ_SCHEMAS` var, where later
// deploys and rollbacks read what that version knows (contracts/COMPATIBILITY.md §6).
//
// Formats (D69): the version of each format a Worker writes and the versions it reads, from the
// sources workers.json names under `formats` (lib/formats.mjs), go into the manifest and each
// version's `VIZ_FORMATS` var. Every deployed Worker declares them, completely, also one that
// reads and writes none (`"formats": {}`): one without a declaration is refused, since a rollback
// would take it to read version 1 of every format (review of D69, M-1 (c)). Rollback floors (`rollback_floors`, lib/floors.mjs): a Worker whose
// floor is declared on evidence is checked to have it and stamped with `VIZ_FLOORS`.
//
// OAuth's rate limits (D70; review of D70, M-2): a Worker with an `oauth` block in workers.json
// (viz-control) declares the Rate Limiting bindings its source names (`LIMITERS`, read from
// control/src/ratelimit.ts) in its wrangler.jsonc `ratelimits`, each with a positive integer limit and
// the period the source assumes (`RATE_PERIOD_S`, 60). Each placeholder namespace_id is replaced with
// the id deploy/resources.mjs allocated for `<deployed worker>/<binding>` (resources.json
// `ratelimit_namespaces`); a placeholder that survives, an id outside viz's range, two bindings with one
// id, a name the source does not list, or a period it does not assume is refused. A production config
// without every binding is refused, naming the missing ones; a stage only with
// --oauth-without-rate-limits, which drops them and is recorded in the manifest and the release
// record. Every production config that passes sets `OAUTH_PUBLIC=1` (a stage only with --oauth-public),
// the switch of the `oauth-public` rollback floor; no component or VIZ_STAGE_VARS may set it.
// `placement` is refused on a Worker workers.json marks `no_placement` (viz-control, viz-mcp: D70
// counts per location; review of D70, m-8).
//
// Durable Object classes of another Worker (by script_name) are bound only where workers.json
// lists them under the binding Worker's `binds_classes`: such a binding can call every method of
// every object of the class, for any tenant.
//
// Service bindings to a named entrypoint (`entrypoint`, with the `props` the binding carries,
// e.g. the ruler's SINK → viz-ingest's RecordedSamples, contracts/ingest.ts, and viz-mcp's OAUTH →
// viz-control's OAuthIntrospection, contracts/oauth.ts) are kept as the component wrote them; the callee's main module (as deployed: a stage's shim included) must
// export that name, or the release is refused before anything is uploaded (callee first,
// contracts/COMPATIBILITY.md §3.3).
//
// Writes deploy/generated/<production|stage-NAME>/<worker>.jsonc and manifest.json there.
// Anything it does not understand (a binding kind, a resource not named viz-…, a script_name
// that is no Worker of ours, a placeholder id left behind) is an error, not a guess.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEPLOY_DIR, GENERATED_DIR, REPO_ROOT, checkStage, log, parseArgs, readJson, readJsonc, releaseId, stagedName, targetName } from './lib/common.mjs'
import { FLOORS_VAR, floorRules, floorsVar, stampedFloors } from './lib/floors.mjs'
import { FORMATS_VAR, formatSources, formatsVar, readFormats } from './lib/formats.mjs'
import { SCHEMAS_VAR, evaluateExports, parseSource, readSchemas, schemaSources, schemasVar } from './lib/schemas.mjs'

const KNOWN_KEYS = new Set([
  'name', 'main', 'compatibility_date', 'compatibility_flags', 'durable_objects', 'migrations', 'r2_buckets', 'kv_namespaces',
  'queues', 'triggers', 'vars', 'services', 'placement', 'observability', 'limits', 'rules', 'routes', 'route', 'workers_dev', 'preview_urls', 'ratelimits',
])
const PLACEHOLDER_ID = /^0+$/
const RATELIMIT_KEYS = new Set(['name', 'namespace_id', 'simple'])
const ALLOCATED_ID = /^[1-9][0-9]*$/

/**
 * The OAuth gate of each Worker that declares `oauth` in workers.json, read from its component's
 * source: `Map(canonical name → { required: [binding names], period, publicVar })`. A Worker whose
 * component is not in this checkout is left out (it is not configured either).
 */
export function readOAuthGates(plan) {
  const out = new Map()
  for (const w of plan.workers) {
    if (w.oauth === undefined) continue
    const where = `deploy/workers.json ${w.name}.oauth`
    if (!existsSync(join(REPO_ROOT, w.component, 'wrangler.jsonc'))) continue
    for (const k of ['ratelimits', 'period', 'public_var']) if (typeof w.oauth[k] !== 'string' || w.oauth[k] === '') throw new Error(`${where}: "${k}" must be a non-empty string`)
    const refs = [parseSource(w.oauth.ratelimits, `${where}.ratelimits`), parseSource(w.oauth.period, `${where}.period`)]
    const { values: [required, period] } = evaluateExports(refs)
    if (!Array.isArray(required) || required.length === 0 || !required.every((n) => typeof n === 'string' && /^[A-Z][A-Z0-9_]*$/.test(n)) || new Set(required).size !== required.length) throw new Error(`${where}: ${w.oauth.ratelimits} must be a list of distinct binding names`)
    if (period !== 10 && period !== 60) throw new Error(`${where}: ${w.oauth.period} is ${period}; a Rate Limiting binding's period is 10 or 60`)
    if (!/^[A-Z][A-Z0-9_]*$/.test(w.oauth.public_var)) throw new Error(`${where}: public_var ${w.oauth.public_var} is not a variable name`)
    out.set(w.name, { required: [...required], period, publicVar: w.oauth.public_var })
  }
  return out
}

/**
 * The `ratelimits` of one generated config (mutated in place), checked against the Worker's OAuth gate
 * and given this deployment's namespace ids. Returns the manifest's `oauth` summary of the Worker.
 */
function configureRateLimits({ out, worker, gate, stage, ids, range, idsOptional, withoutRateLimits, where }) {
  const list = out.ratelimits
  if (list !== undefined && !Array.isArray(list)) throw new Error(`${where}: "ratelimits" must be a list`)
  if (!gate) {
    if (list?.length) throw new Error(`${where}: "ratelimits", but deploy/workers.json declares no "oauth" gate for ${worker.name}: only the bindings a component's source names are deployed (D70)`)
    return null
  }
  if (withoutRateLimits) {
    if (!stage) throw new Error('--oauth-without-rate-limits is for a stage only: a production viz-control serves OAuth only behind its rate limits (D70; review of D70, M-2)')
    delete out.ratelimits
    return { required: gate.required, period: gate.period, ratelimits: {}, withoutRateLimits: true, public: false }
  }
  const bound = {}
  const seenIds = new Map()
  for (const [i, r] of (list ?? []).entries()) {
    const at = `${where} ratelimits[${i}]`
    if (typeof r !== 'object' || r === null || Array.isArray(r)) throw new Error(`${at}: a binding object`)
    for (const k of Object.keys(r)) if (!RATELIMIT_KEYS.has(k)) throw new Error(`${at}: "${k}" is not something configure.mjs knows how to deploy (name, namespace_id, simple)`)
    if (!gate.required.includes(r.name)) throw new Error(`${at}: ${JSON.stringify(r.name)} is not one of ${worker.name}'s rate-limit bindings (${gate.required.join(', ')}, from its source)`)
    if (Object.hasOwn(bound, r.name)) throw new Error(`${at}: ${r.name} is bound twice`)
    const simple = r.simple
    if (typeof simple !== 'object' || simple === null || Object.keys(simple).some((k) => k !== 'limit' && k !== 'period')) throw new Error(`${at} (${r.name}): "simple" must be { limit, period }`)
    if (!Number.isInteger(simple.limit) || simple.limit < 1) throw new Error(`${at} (${r.name}): limit must be a positive integer, not ${JSON.stringify(simple.limit)}`)
    if (simple.period !== gate.period) throw new Error(`${at} (${r.name}): period must be ${gate.period}, not ${JSON.stringify(simple.period)}: the Worker's Retry-After and its limits assume ${gate.period} s (RATE_PERIOD_S)`)
    const key = `${out.name}/${r.name}`
    const id = ids[key]
    if (id === undefined) {
      if (!idsOptional) throw new Error(`no namespace_id recorded for ${key}; run deploy/resources.mjs ensure${stage ? ` --stage ${stage}` : ''} first`)
      r.namespace_id = '0'
    } else {
      if (typeof id !== 'string' || !ALLOCATED_ID.test(id) || Number(id) < range.from || Number(id) > range.to) throw new Error(`${key}: recorded namespace_id ${JSON.stringify(id)} is not in viz's range ${range.from}–${range.to} (deploy/workers.json resources.ratelimit_ids)`)
      r.namespace_id = id
    }
    if (typeof r.namespace_id !== 'string' || (PLACEHOLDER_ID.test(r.namespace_id) && !idsOptional)) throw new Error(`${at} (${r.name}): a placeholder namespace_id survived`)
    if (!PLACEHOLDER_ID.test(r.namespace_id)) {
      if (seenIds.has(r.namespace_id)) throw new Error(`${at}: ${r.name} and ${seenIds.get(r.namespace_id)} have the same namespace_id ${r.namespace_id}: they would share one counter`)
      seenIds.set(r.namespace_id, r.name)
    }
    bound[r.name] = PLACEHOLDER_ID.test(r.namespace_id) ? null : r.namespace_id
  }
  const missing = gate.required.filter((n) => !Object.hasOwn(bound, n))
  if (missing.length) {
    throw new Error(
      `${where}: ${stage ? `stage ${stage}` : 'production'} ${worker.name} without the rate-limit binding${missing.length > 1 ? 's' : ''} ${missing.join(', ')}: OAuth is not served without D70's first layer (review of D70, M-2). ` +
        `Add ${missing.length > 1 ? 'them' : 'it'} to ${worker.component}/wrangler.jsonc "ratelimits"${stage ? ', or configure the stage with --oauth-without-rate-limits (recorded in its release record)' : ''}.`,
    )
  }
  return { required: gate.required, period: gate.period, ratelimits: bound, withoutRateLimits: false, public: false }
}

export function loadPlan() {
  // VIZ_RESOURCES_FILE (tests only, as in resources.mjs): another resources.json.
  return { plan: readJson(join(DEPLOY_DIR, 'workers.json')), resources: readJson(process.env.VIZ_RESOURCES_FILE ?? join(DEPLOY_DIR, 'resources.json')) }
}

/** The Worker of deploy/workers.json a `script_name` or `service` means (aliases applied). */
function canonicalScript(name, plan, where) {
  const canonical = plan.script_aliases?.[name] ?? name
  if (!plan.workers.some((w) => w.name === canonical)) throw new Error(`${where}: refers to "${name}", which is not a Worker in deploy/workers.json`)
  return canonical
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * The names a TypeScript or JavaScript module exports, read from its source: `export class|
 * function|const|let|var X`, `export { X, Y as Z } [from …]`, and `export * from './…'` followed
 * into the file it names. Enough to check that an entrypoint a binding names exists; not a
 * parser (a name built at run time, or exported from a package, is not seen).
 */
export function exportedNames(file, seen = new Set()) {
  const names = new Set()
  if (seen.has(file)) return names
  seen.add(file)
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const m of text.matchAll(/export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|function\*?|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) names.add(m[1])
  for (const m of text.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    if (m[1]) continue // `export type { … }`: types only
    for (const part of m[2].split(',')) {
      const spec = part.trim()
      if (!spec || spec.startsWith('type ')) continue
      const name = spec.split(/\s+as\s+/).pop().trim()
      if (IDENTIFIER.test(name)) names.add(name)
    }
  }
  for (const m of text.matchAll(/export\s+\*\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const base = resolve(dirname(file), m[1])
    const target = [base, `${base}.ts`, `${base}.js`, `${base}.mjs`, join(base, 'index.ts'), join(base, 'index.js')].find((f) => existsSync(f) && statSync(f).isFile())
    if (target) for (const n of exportedNames(target, seen)) names.add(n)
  }
  return names
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

/** Stage vars from VIZ_STAGE_VARS: `{ worker: { VAR: value } }`, string values only. */
export function stageVars(raw, stage) {
  if (!raw) return {}
  if (!stage) throw new Error('VIZ_STAGE_VARS is for a stage only: production vars come from the components and deploy/workers.json')
  let v
  try {
    v = JSON.parse(raw)
  } catch (e) {
    throw new Error(`VIZ_STAGE_VARS is not JSON: ${e.message}`)
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('VIZ_STAGE_VARS must be {"<worker>": {"VAR": "value"}}')
  for (const [w, vars] of Object.entries(v)) {
    if (typeof vars !== 'object' || vars === null || Object.values(vars).some((x) => typeof x !== 'string')) throw new Error(`VIZ_STAGE_VARS.${w}: values must be strings`)
  }
  return v
}

/**
 * One generated config. `ids` maps a KV namespace title to its id; `schemas` is what
 * lib/schemas.mjs read for this Worker's classes, `formats` what lib/formats.mjs read for its
 * formats, `floors` the rollback floors its code is stamped at (lib/floors.mjs). Pure: no I/O, so
 * the tests can call it with any component config.
 */
export function generateWorker({ worker, cfg, componentDir, plan, stage, release, ids, outDir, idsOptional = false, expires = null, schemas = [], formats = [], formatsDeclared = worker.formats !== undefined || formats.length > 0, floors = [], extraVars = {}, gate = null, ratelimitIds = {}, oauthWithoutRateLimits = false, oauthPublic = false }) {
  const where = `${worker.component}/wrangler.jsonc`
  const warnings = []
  for (const k of Object.keys(cfg)) if (!KNOWN_KEYS.has(k)) throw new Error(`${where}: "${k}" is not something configure.mjs knows how to deploy; extend it rather than drop it`)
  // Per-location limits assume each request is counted where it arrives (D70; review of D70, m-8).
  if (worker.no_placement !== undefined && cfg.placement !== undefined) throw new Error(`${where}: "placement" is refused on ${worker.name}: ${worker.no_placement}. Remove it (deploy/workers.json no_placement)`)
  // The switch of the oauth-public floor means "this config passed the gate": only configure sets it.
  if (gate && (Object.hasOwn(cfg.vars ?? {}, gate.publicVar) || Object.hasOwn(extraVars, gate.publicVar))) throw new Error(`${where}: ${gate.publicVar} is set by deploy/configure.mjs only (every production ${worker.name} that passes the rate-limit gate; a stage with --oauth-public), never by a component or VIZ_STAGE_VARS`)
  // Every class this Worker defines has its storage schema declared, or is declared to keep none.
  for (const cls of durableObjectsOf(cfg).classes) {
    const declared = Object.hasOwn(worker.schemas ?? {}, cls) || Object.hasOwn(worker.unversioned ?? {}, cls)
    if (!declared) throw new Error(`deploy/workers.json ${worker.name}: Durable Object class ${cls} has no "schemas" entry (its SchemaSpec, "<path>.ts#<EXPORT>") and no "unversioned" entry (why it keeps no storage)`)
  }
  const out = structuredClone(cfg)
  out.name = stagedName(worker.name, stage)

  // main: bundle from the component directory. A stage's ingest goes through the shim that
  // maps its prefixed queue names back to the names stack/ compares against.
  const mainAbs = mainOf(worker, cfg, componentDir, plan, stage)
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
      const at = `${where} durable_objects ${b.name}`
      // A class binding reaches every method of every object of the class (any tenant): only the
      // ones workers.json lists, with why, are deployed (review of D44, M-1).
      const owner = canonicalScript(b.script_name, plan, at)
      if (!Object.hasOwn(worker.binds_classes ?? {}, `${owner}:${b.class_name}`)) {
        throw new Error(`${at}: binds ${owner}'s Durable Object class ${b.class_name}, which deploy/workers.json does not list under ${worker.name}'s "binds_classes". Such a binding can call every method of every object of that class, for any tenant; bind a named entrypoint of ${owner} that answers only what ${worker.name} needs (as viz-mcp binds viz-control's OAuthIntrospection), or list it there with why`)
      }
      b.script_name = stagedName(owner, stage)
      crossScript.push(`${b.name} → ${b.script_name}:${b.class_name}`)
    }
  }
  // A binding to a named entrypoint keeps `entrypoint` and `props` as written; configure()
  // checks that the callee exports the entrypoint.
  const entrypoints = []
  for (const s of out.services ?? []) {
    const at = `${where} services ${s.binding}`
    const callee = canonicalScript(s.service, plan, at)
    s.service = stagedName(callee, stage)
    if (s.entrypoint !== undefined) {
      if (typeof s.entrypoint !== 'string' || !IDENTIFIER.test(s.entrypoint) || s.entrypoint === 'default') throw new Error(`${at}: entrypoint must name an export of ${callee} (or be left out for its default export)`)
      entrypoints.push({ binding: s.binding, callee, entrypoint: s.entrypoint })
    }
    if (s.props !== undefined && (typeof s.props !== 'object' || s.props === null || Array.isArray(s.props))) throw new Error(`${at}: props must be an object (what the binding carries to the callee as ctx.props)`)
    crossScript.push(`${s.binding} → ${s.service}${s.entrypoint ? `#${s.entrypoint}` : ''}`)
  }
  // Rate Limiting bindings (D70): checked, given this deployment's ids, and required where the gate says.
  const oauth = configureRateLimits({ out, worker, gate, stage, ids: ratelimitIds, range: plan.resources.ratelimit_ids ?? { from: 1, to: 0 }, idsOptional, withoutRateLimits: oauthWithoutRateLimits, where })
  if (oauthPublic && !stage) throw new Error('--oauth-public is for a stage only: every production viz-control that passes the gate sets it')
  if (oauthPublic && oauth?.withoutRateLimits) throw new Error(`--oauth-public and --oauth-without-rate-limits together: ${gate.publicVar} says the config passed the rate-limit gate`)

  // vars: deployment-wide values where the component declares them; the release; the stage.
  const vars = { ...(out.vars ?? {}) }
  for (const [k, v] of Object.entries(plan.shared_vars ?? {})) {
    if (k.startsWith('$') || !(k in vars)) continue
    if (vars[k] !== v) warnings.push(`${k}: ${where} has ${vars[k]}; deployed with the deployment-wide ${v}`)
    vars[k] = v
  }
  // PUBLIC_URL is the OAuth issuer (viz-control) and the resource's origin (viz-mcp): the two must
  // be equal, so in production it comes from the deployment's one domain, never from a component.
  // A stage has no custom domain; there the component's value stays (OAuth is not trialled there).
  if (!stage && 'PUBLIC_URL' in vars) {
    const pub = `https://${plan.domain}`
    if (vars.PUBLIC_URL !== pub) warnings.push(`PUBLIC_URL: ${where} has ${vars.PUBLIC_URL}; deployed with https://<domain>, ${pub}`)
    vars.PUBLIC_URL = pub
  }
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v !== 'string') continue
    let s = v
    for (const bucket of plan.resources.r2) s = s.split(`s3://${bucket}`).join(`s3://${stagedName(bucket, stage)}`)
    vars[k] = s
  }
  vars.VIZ_RELEASE = release
  vars.VIZ_WORKER = worker.name
  if (schemas.length > 0) vars[SCHEMAS_VAR] = schemasVar(schemas)
  // Also when it declares none: `{"v":1,"complete":true,"formats":{}}` says it reads nothing (M-1 (c)).
  if (formatsDeclared) vars[FORMATS_VAR] = formatsVar(formats)
  if (floors.length > 0) vars[FLOORS_VAR] = floorsVar(floors)
  if (stage) vars.VIZ_STAGE_PREFIX = `viz-${stage}-`
  for (const [k, v] of Object.entries(extraVars)) vars[k] = v
  if (oauth && (!stage || oauthPublic)) {
    vars[gate.publicVar] = '1'
    oauth.public = true
  }
  if (expires !== null) {
    if (!stage) throw new Error('--expires is for a stage only: production does not stop by itself')
    vars.VIZ_STAGE_EXPIRES_AT = expires
  }
  out.vars = vars

  const text = JSON.stringify(out, null, 2)
  if (/"id":\s*"0{32}"/.test(text) && !idsOptional) throw new Error(`${where}: a placeholder KV id survived`)
  for (const id of (out.kv_namespaces ?? []).map((k) => k.id)) if (PLACEHOLDER_ID.test(id) && !idsOptional) throw new Error(`${where}: placeholder KV id`)
  const dobj = durableObjectsOf(cfg)
  return {
    config: out,
    text,
    mainAbs,
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
      schemas,
      // null: the Worker declares nothing (a rollback takes it to read version 1 of every format).
      formats: formatsDeclared ? formats.map(({ format, writes, reads }) => ({ format, writes, reads })) : null,
      floors,
      oauth,
      crossScript,
      entrypoints,
      queues: queuesOf(out),
      warnings,
    },
  }
}

/**
 * Every schema floor of a rollback rule names a class its Worker declares, read from the sources:
 * a floor on a schema that does not exist would judge every version below it.
 */
export function checkFloorSchemas(rules, schemas) {
  for (const rule of rules) {
    for (const f of rule.floors) {
      if (f.schema === undefined) continue
      if (!schemas.some((s) => s.worker === f.canonical && s.component === f.schema)) {
        throw new Error(`deploy/workers.json rollback_floors ${rule.name}: ${f.canonical}'s floor names schema ${f.schema}, which none of its classes has (${schemas.filter((s) => s.worker === f.canonical).map((s) => s.component).join(', ') || 'none'})`)
      }
    }
  }
}

/** The module a Worker is bundled from, as deployed: a stage's ingest goes through its shim. */
function mainOf(worker, cfg, componentDir, plan, stage) {
  return stage && worker.name === plan.resources.queues_from ? join(DEPLOY_DIR, 'stage', 'ingest.ts') : join(componentDir, cfg.main)
}

/**
 * Every entrypoint a Worker's bindings name is exported by its callee's main module (`mains`:
 * canonical Worker name → main module, for the Workers generated so far, callees first).
 */
export function checkEntrypoints(workerName, entrypoints, mains) {
  for (const e of entrypoints) {
    const main = mains.get(e.callee)
    if (!main) throw new Error(`${workerName}: ${e.binding} names entrypoint ${e.entrypoint} of ${e.callee}, which is not configured before it (callees first)`)
    if (!exportedNames(main).has(e.entrypoint)) {
      throw new Error(`${workerName}: ${e.binding} names entrypoint ${e.entrypoint}, which ${e.callee} (${relative(REPO_ROOT, main)}) does not export: a callee ships an entrypoint before or with its first caller (contracts/COMPATIBILITY.md §3.3)`)
    }
  }
}

/**
 * `plan` replaces deploy/workers.json and `resources` deploy/resources.json (the tests' way to
 * configure a plan that must be refused, or a deployment with ids of its own).
 */
export function configure({ stage, release = releaseId(), idsOptional = false, quiet = false, expires = null, plan: planOverride, resources: resourcesOverride, oauthWithoutRateLimits = false, oauthPublic = false } = {}) {
  checkStage(stage)
  if (expires !== null && !(Number.isFinite(Date.parse(expires)) && /^\d{4}-\d{2}-\d{2}T/.test(expires))) throw new Error(`--expires must be an ISO 8601 time: ${expires}`)
  if ((oauthWithoutRateLimits || oauthPublic) && !stage) throw new Error(`${oauthWithoutRateLimits ? '--oauth-without-rate-limits' : '--oauth-public'} is for a stage only: a production viz-control always has its rate limits and OAUTH_PUBLIC (D70)`)
  const loaded = resourcesOverride ? { plan: planOverride ?? loadPlan().plan, resources: resourcesOverride } : loadPlan()
  const plan = planOverride ?? loaded.plan
  const resources = loaded.resources
  const ids = resources.kv_namespaces ?? {}
  const ratelimitIds = resources.ratelimit_namespaces ?? {}
  const gates = readOAuthGates(plan)
  if ((oauthWithoutRateLimits || oauthPublic) && gates.size === 0) throw new Error('--oauth-without-rate-limits and --oauth-public need a Worker with an "oauth" gate in deploy/workers.json')
  const extra = stageVars(process.env.VIZ_STAGE_VARS, stage)
  for (const w of Object.keys(extra)) if (!plan.workers.some((x) => x.name === w)) throw new Error(`VIZ_STAGE_VARS names ${w}, which is not a Worker in deploy/workers.json`)
  const outDir = join(GENERATED_DIR, targetName(stage))
  mkdirSync(outDir, { recursive: true })
  // The schemas of every class, read once for all Workers whose component is in this checkout.
  const present = plan.workers.filter((w) => existsSync(join(REPO_ROOT, w.component, 'wrangler.jsonc')))
  const schemas = readSchemas(schemaSources(present))
  const formats = readFormats(formatSources(present))
  const rules = floorRules(plan, stage)
  checkFloorSchemas(rules, schemas)
  for (const w of plan.workers) {
    if (w.deploy !== false && w.formats === undefined) {
      throw new Error(`deploy/workers.json ${w.name}: no "formats". Every deployed Worker says completely what it reads (and writes): sources under "reads", "reads_of" and "writes", formats read with no version in the code under "reads_v1", or "formats": {} with a "$comment" when it reads none. Without it a rollback takes it to read version 1 of every format (review of D69, M-1)`)
    }
  }
  const workers = []
  /** Main module of each Worker configured so far, for the entrypoint check of the ones after it. */
  const mains = new Map()
  const deploymentIds = new Map()
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
    const g = generateWorker({
      worker, cfg: readJsonc(cfgPath), componentDir, plan, stage, release, ids, outDir, idsOptional, expires,
      schemas: schemas.filter((s) => s.worker === worker.name),
      formats: formats.filter((f) => f.worker === worker.name),
      floors: stampedFloors(rules, worker.name, exportedNames),
      extraVars: extra[worker.name] ?? {},
      gate: gates.get(worker.name) ?? null,
      ratelimitIds,
      oauthWithoutRateLimits,
      oauthPublic,
    })
    // Two bindings of one deployment with one namespace id would share a counter.
    for (const [name, id] of Object.entries(g.summary.oauth?.ratelimits ?? {})) {
      if (id === null) continue
      const other = deploymentIds.get(id)
      if (other) throw new Error(`${worker.name} ${name} and ${other} have the same namespace_id ${id}: they would share one counter`)
      deploymentIds.set(id, `${worker.name} ${name}`)
    }
    checkEntrypoints(worker.name, g.summary.entrypoints, mains)
    mains.set(worker.name, g.mainAbs)
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
    expires,
    // Placeholder ids (--ids-optional): release.mjs refuses to deploy this manifest.
    idsOptional,
    // --oauth-without-rate-limits (a stage only), carried into the release record.
    oauthWithoutRateLimits,
    domain: stage ? null : plan.domain,
    durableObjectsCodeUpdate: plan.durable_objects_code_update,
    order: workers.filter((w) => w.deploy).map((w) => w.name),
    // The Worker whose version tag says which release is serving (the write path).
    releaseFrom: stagedName(plan.resources.queues_from, stage),
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
      for (const sc of w.schemas ?? []) log(`         schema ${sc.component}: version ${sc.latest}, readable from ${sc.compat}`)
      const split = (w.formats ?? []).filter((f) => f.reads.length > 1 || f.writes === null)
      if (w.formats?.length) log(`         formats: ${w.formats.length}${split.length ? `; ${split.map((f) => `${f.format} writes ${f.writes ?? '-'}, reads ${f.reads.join(',')}`).join('; ')}` : ''}`)
      for (const f of w.floors ?? []) log(`         at the rollback floor of ${f} (${FLOORS_VAR})`)
      if (w.oauth) log(`         OAuth: ${w.oauth.withoutRateLimits ? 'WITHOUT rate limits, as asked (--oauth-without-rate-limits)' : `rate limits ${Object.entries(w.oauth.ratelimits).map(([n, id]) => `${n}=${id ?? 'placeholder'}`).join(', ')}`}${w.oauth.public ? '; OAUTH_PUBLIC=1' : ''}`)
      for (const warn of w.warnings ?? []) log(`         note: ${warn}`)
    }
  }
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { flags: ['ids-optional', 'quiet', 'oauth-without-rate-limits', 'oauth-public'], options: ['stage', 'release', 'expires'] })
    const m = configure({ stage: args.stage, release: args.release, idsOptional: args['ids-optional'], quiet: args.quiet, expires: args.expires ?? null, oauthWithoutRateLimits: Boolean(args['oauth-without-rate-limits']), oauthPublic: Boolean(args['oauth-public']) })
    console.log(join(GENERATED_DIR, m.target, 'manifest.json'))
  } catch (e) {
    log(`configure: ${e.message}`)
    process.exit(1)
  }
}
