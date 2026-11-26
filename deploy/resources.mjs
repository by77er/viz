#!/usr/bin/env node
// Idempotent creation of the resources viz runs on: the R2 bucket, the KV namespace, and the
// queues (with their dead-letter queues) that the write path's config declares. Names come
// from deploy/workers.json and the component configs, so they always match what
// configure.mjs binds.
//
//   node deploy/resources.mjs ensure  [--stage <name>]   create what is missing; record KV ids
//   node deploy/resources.mjs list    [--stage <name>]   what exists, and what is missing
//   node deploy/resources.mjs destroy --stage <name>     delete EVERYTHING that stage created
//
// Rate Limiting namespace ids (D70): the `ratelimits` of a Worker with an `oauth` gate (viz-control)
// need a namespace_id each, which "uniquely defines this rate limiting namespace within your Cloudflare
// account" (Cloudflare's binding page, read 2026-11-19). Nothing is created on Cloudflare: a namespace
// exists only as bindings name it. `ensure` gives each binding of the target an id from viz's range
// (workers.json resources.ratelimit_ids) and records it in resources.json `ratelimit_namespaces`
// under `<deployed worker>/<binding>`:
// - it first reads, READ ONLY, the Rate Limiting bindings of every script on the account (each one's
//   serving versions and its newest version);
// - it keeps the id the deployment's own viz-control already binds under that name (else the one
//   recorded here), unless another script binds it: never one a script whose name does not start with
//   viz- binds (refused, logged, and a new id taken: the counters reset), nor one another viz
//   deployment (production, another stage, a spike) binds or has recorded;
// - otherwise it takes the lowest free id at or after a start the deployment's name picks in the
//   range (FNV-1a), so two stages allocated at once from different checkouts rarely pick alike.
// `destroy --stage` frees the stage's ids (removes them from resources.json).
//
// Production is never deleted from here: `destroy` refuses without --stage. A stage is torn
// down by exact name (never by prefix match), in this order: its Workers (callers first), any
// custom domain pointing at them, its queues, its KV namespace, its R2 objects, its bucket.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CfError, cf, cfList, currentDeployment, deleteScript, listCustomDomains, listDurableObjectNamespaces, listScripts, listVersions, versionInfo } from './lib/cf.mjs'
import { DEPLOY_DIR, REPO_ROOT, checkStage, log, parseArgs, readJson, readJsonc, stagedName } from './lib/common.mjs'
import { queuesOf } from './configure.mjs'

const RESOURCES_FILE = process.env.VIZ_RESOURCES_FILE ?? join(DEPLOY_DIR, 'resources.json')
export const RATELIMIT_RECORD = 'ratelimit_namespaces'

/** The exact names this target owns. */
export function wanted(stage) {
  const plan = readJson(join(DEPLOY_DIR, 'workers.json'))
  const ingest = plan.workers.find((w) => w.name === plan.resources.queues_from)
  const ingestCfg = readJsonc(join(REPO_ROOT, ingest.component, 'wrangler.jsonc'))
  return {
    workers: plan.workers.map((w) => stagedName(w.name, stage)),
    kv: Object.values(plan.resources.kv).map((t) => stagedName(t, stage)),
    r2: plan.resources.r2.map((b) => stagedName(b, stage)),
    queues: queuesOf(ingestCfg).map((q) => stagedName(q, stage)),
  }
}

/**
 * The Rate Limiting bindings this target needs ids for: `[{ key: "<deployed worker>/<binding>", worker,
 * name }]`, from the `ratelimits` of each Worker's component config that workers.json gives an `oauth`
 * gate (configure.mjs checks the names against the component's source).
 */
export function wantedRateLimits(stage, plan = readJson(join(DEPLOY_DIR, 'workers.json'))) {
  const out = []
  for (const w of plan.workers) {
    if (w.oauth === undefined || w.deploy === false) continue
    const cfgPath = join(REPO_ROOT, w.component, 'wrangler.jsonc')
    const cfg = readJsonc(cfgPath)
    const worker = stagedName(w.name, stage)
    for (const r of cfg.ratelimits ?? []) out.push({ key: `${worker}/${r.name}`, worker, name: r.name })
  }
  return out
}

/** A Rate Limiting binding of a version as the API lists it: `{ name, id }`; throws when its namespace id cannot be read (refuse rather than guess). */
function rateLimitsOf(version, script) {
  const out = []
  for (const b of version?.resources?.bindings ?? version?.bindings ?? []) {
    // `ratelimit` is the type wrangler uploads (training knowledge; not read from Cloudflare): any other type that names a rate limit is a shape this does not know.
    if (b?.type !== 'ratelimit') {
      if (/rate.?limit/i.test(String(b?.type ?? ''))) throw new Error(`${script}: a binding ${b.name ?? '(no name)'} of type ${b.type}, which resources.mjs does not know how to read: which Rate Limiting ids are in use is unknown, so none is allocated`)
      continue
    }
    const id = b.namespace_id ?? b.namespaceId
    if (!(typeof id === 'string' || Number.isInteger(id)) || !/^\d+$/.test(String(id))) throw new Error(`${script}: a Rate Limiting binding ${b.name ?? '(no name)'} whose namespace id cannot be read (${JSON.stringify(id)}): which ids are in use is unknown, so none is allocated`)
    out.push({ name: b.name, id: String(id) })
  }
  return out
}

/**
 * Every Rate Limiting namespace id the account's scripts bind, READ ONLY: for each script, its serving
 * versions and its newest version (a deployment list, a version list and one to three version reads
 * per script, four scripts at a time). Returns { used: Map(id → Set(script)), byScript: Map(script →
 * { binding name → id }) } (the serving version's id, else the newest's). `api`: { listScripts,
 * currentDeployment, listVersions, versionInfo } (lib/cf.mjs).
 */
export async function rateLimitIdsInUse(api) {
  const used = new Map()
  const byScript = new Map()
  const scripts = (await api.listScripts()).map((s) => s.id)
  const one = async (script) => {
    const serving = ((await api.currentDeployment(script))?.versions ?? []).map((v) => v.version_id)
    const newest = (await api.listVersions(script))[0]?.id
    const ids = [...new Set([...serving, ...(newest ? [newest] : [])])]
    const names = {}
    for (const id of ids) {
      for (const r of rateLimitsOf(await api.versionInfo(script, id), script)) {
        if (!used.has(r.id)) used.set(r.id, new Set())
        used.get(r.id).add(script)
        names[r.name] ??= r.id // serving versions are read first
      }
    }
    byScript.set(script, names)
  }
  for (let i = 0; i < scripts.length; i += 4) await Promise.all(scripts.slice(i, i + 4).map(one))
  return { used, byScript }
}

/** FNV-1a of a string, 32 bits. */
const fnv1a = (text) => {
  let h = 0x811c9dc5
  for (const c of Buffer.from(text, 'utf8')) h = Math.imul(h ^ c, 0x01000193) >>> 0
  return h
}

/**
 * Pure: the namespace id of each wanted binding of one deployment. `wanted` from wantedRateLimits;
 * `range` { from, to }; `inUse` from rateLimitIdsInUse; `recorded` resources.json's map (every
 * deployment's ids). Returns { ids: { key: id }, notes: [what was reused, moved or allocated] }.
 */
export function allocateRateLimitIds({ wanted, range, inUse, recorded = {} }) {
  if (!Number.isInteger(range?.from) || !Number.isInteger(range?.to) || range.from < 1 || range.to < range.from) throw new Error('deploy/workers.json resources.ratelimit_ids: { "from": <positive integer>, "to": <at least from> }')
  const mine = new Set(wanted.map((w) => w.key))
  const ourScripts = new Set(wanted.map((w) => w.worker))
  // Taken by other deployments: what any other script binds, and what resources.json records for them.
  const takenBy = new Map()
  for (const [id, scripts] of inUse.used) for (const s of scripts) if (!ourScripts.has(s)) takenBy.set(id, s)
  for (const [key, id] of Object.entries(recorded)) if (!mine.has(key) && !takenBy.has(String(id))) takenBy.set(String(id), `${key} (recorded in resources.json)`)
  const inRange = (id) => /^[1-9]\d*$/.test(id) && Number(id) >= range.from && Number(id) <= range.to
  const ids = {}
  const given = new Set()
  const notes = []
  const free = (id) => inRange(id) && !takenBy.has(id) && !given.has(id)
  const pending = []
  for (const w of wanted) {
    const bound = inUse.byScript.get(w.worker)?.[w.name]
    let kept = null
    for (const [cand, from] of [[bound, `bound by ${w.worker}`], [recorded[w.key], 'recorded in resources.json']]) {
      if (cand === undefined || cand === null) continue
      const id = String(cand)
      if (free(id)) {
        kept = id
        notes.push(`${w.key}: ${id} kept (${from})`)
        break
      }
      const other = takenBy.get(id)
      if (other && !other.startsWith('viz-')) notes.push(`${w.key}: REFUSING to reuse ${id} (${from}): script ${other}, which is not viz's, binds it; a new id is taken and the counters reset`)
      else notes.push(`${w.key}: not reusing ${id} (${from}): ${other ? `${other} has it` : given.has(id) ? 'another binding of this deployment has it' : `outside viz's range ${range.from}–${range.to}`}`)
    }
    if (kept) {
      ids[w.key] = kept
      given.add(kept)
    } else pending.push(w)
  }
  const size = range.to - range.from + 1
  for (const w of pending) {
    const start = fnv1a(w.worker) % size
    let id = null
    for (let i = 0; i < size; i++) {
      const c = String(range.from + ((start + i) % size))
      if (free(c)) {
        id = c
        break
      }
    }
    if (id === null) throw new Error(`no free Rate Limiting namespace id left in viz's range ${range.from}–${range.to} for ${w.key}`)
    ids[w.key] = id
    given.add(id)
    notes.push(`${w.key}: ${id} allocated`)
  }
  return { ids, notes }
}

function recordRateLimits(keys, ids) {
  const r = JSON.parse(readFileSync(RESOURCES_FILE, 'utf8'))
  const map = { ...(r[RATELIMIT_RECORD] ?? {}) }
  for (const k of keys) delete map[k]
  Object.assign(map, ids)
  r[RATELIMIT_RECORD] = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(RESOURCES_FILE, JSON.stringify(r, null, 2) + '\n')
}

/** A stage's Rate Limiting ids, removed from resources.json (nothing to delete on Cloudflare). Returns the keys freed. */
export function freeRateLimitIds(stage, plan) {
  if (!stage) throw new Error('only a stage frees its rate-limit ids: production keeps its own')
  const keys = wantedRateLimits(stage, plan).map((x) => x.key)
  if (keys.length) recordRateLimits(keys, {})
  return keys
}

const CF_READ = { listScripts, currentDeployment, listVersions, versionInfo }

/** Allocates (or keeps) this target's Rate Limiting namespace ids and records them; reads the account only. */
export async function ensureRateLimitIds(stage, api = CF_READ, plan = readJson(join(DEPLOY_DIR, 'workers.json'))) {
  const wanted = wantedRateLimits(stage, plan)
  if (wanted.length === 0) return { ids: {}, notes: [] }
  const recorded = JSON.parse(readFileSync(RESOURCES_FILE, 'utf8'))[RATELIMIT_RECORD] ?? {}
  const r = allocateRateLimitIds({ wanted, range: plan.resources.ratelimit_ids, inUse: await rateLimitIdsInUse(api), recorded })
  recordRateLimits(wanted.map((w) => w.key), r.ids)
  for (const n of r.notes) log(`resources: rate limit ${n}`)
  return r
}

const listBuckets = async () => (await cf('GET', '/r2/buckets?per_page=1000')).result?.buckets ?? []
const listKv = () => cfList('/storage/kv/namespaces')
const listQueues = () => cfList('/queues')

function recordKv(title, id) {
  const r = JSON.parse(readFileSync(RESOURCES_FILE, 'utf8'))
  r.kv_namespaces ??= {}
  if (id === null) delete r.kv_namespaces[title]
  else r.kv_namespaces[title] = id
  writeFileSync(RESOURCES_FILE, JSON.stringify(r, null, 2) + '\n')
}

export async function ensure(stage) {
  const w = wanted(stage)
  const created = []
  const buckets = new Set((await listBuckets()).map((b) => b.name))
  for (const name of w.r2) {
    if (buckets.has(name)) continue
    await cf('POST', '/r2/buckets', { name })
    created.push(`R2 bucket ${name}`)
  }
  const kv = await listKv()
  for (const title of w.kv) {
    let ns = kv.find((n) => n.title === title)
    if (!ns) {
      ns = (await cf('POST', '/storage/kv/namespaces', { title })).result
      created.push(`KV namespace ${title}`)
    }
    recordKv(title, ns.id)
  }
  const queues = new Set((await listQueues()).map((q) => q.queue_name))
  for (const name of w.queues) {
    if (queues.has(name)) continue
    await cf('POST', '/queues', { queue_name: name })
    created.push(`queue ${name}`)
  }
  log(`resources: ${created.length ? `created ${created.join(', ')}` : 'all present'} (${[...w.r2, ...w.kv, ...w.queues].join(', ')})`)
  // Rate Limiting namespace ids: no resource on Cloudflare, only ids (the account's bindings read, not changed).
  await ensureRateLimitIds(stage)
  return created
}

/** What of this target exists on the account now. */
export async function present(stage) {
  const w = wanted(stage)
  const [scripts, buckets, kv, queues, domains] = await Promise.all([listScripts(), listBuckets(), listKv(), listQueues(), listCustomDomains()])
  return {
    workers: scripts.map((s) => s.id).filter((id) => w.workers.includes(id)),
    r2: buckets.map((b) => b.name).filter((n) => w.r2.includes(n)),
    kv: kv.filter((n) => w.kv.includes(n.title)).map((n) => n.title),
    queues: queues.map((q) => q.queue_name).filter((n) => w.queues.includes(n)),
    domains: domains.filter((d) => w.workers.includes(d.service)).map((d) => `${d.hostname} → ${d.service}`),
  }
}

/** Every object key in a bucket, through the R2 REST listing (cursor-paged). */
async function listObjects(bucket) {
  const keys = []
  let cursor
  for (;;) {
    const q = new URLSearchParams({ per_page: '1000' })
    if (cursor) q.set('cursor', cursor)
    const j = await cf('GET', `/r2/buckets/${bucket}/objects?${q}`)
    for (const o of j.result ?? []) keys.push(o.key)
    cursor = j.result_info?.cursor
    if (!cursor || !j.result_info?.is_truncated) break
  }
  return keys
}

export async function destroy(stage) {
  if (!stage) throw new Error('destroy needs --stage: production resources are never deleted by this script')
  checkStage(stage)
  const w = wanted(stage)
  const done = []
  // A Worker that consumes a queue cannot be deleted (Cloudflare error 10064): remove the
  // consumers of the stage's own queues first.
  for (const q of await listQueues()) {
    if (!w.queues.includes(q.queue_name)) continue
    for (const c of (await cf('GET', `/queues/${q.queue_id}/consumers`)).result ?? []) {
      await cf('DELETE', `/queues/${q.queue_id}/consumers/${c.consumer_id}`)
      done.push(`consumer of ${q.queue_name} (${c.script ?? c.script_name ?? c.service ?? 'worker'})`)
    }
  }
  // Workers: callers before callees (reverse of deploy/workers.json), so nothing is left
  // bound to a script that is already gone.
  for (const name of [...w.workers].reverse()) if (await deleteScript(name)) done.push(`Worker ${name}`)
  for (const d of await listCustomDomains()) {
    if (!w.workers.includes(d.service)) continue
    await cf('DELETE', `/workers/domains/${d.id}`)
    done.push(`custom domain ${d.hostname}`)
  }
  for (const q of await listQueues()) {
    if (!w.queues.includes(q.queue_name)) continue
    try {
      await cf('DELETE', `/queues/${q.queue_id}`)
    } catch (e) {
      // A queue that still has a consumer cannot be deleted: remove the consumer, then retry.
      if (!(e instanceof CfError)) throw e
      for (const c of (await cf('GET', `/queues/${q.queue_id}/consumers`)).result ?? []) await cf('DELETE', `/queues/${q.queue_id}/consumers/${c.consumer_id}`)
      await cf('DELETE', `/queues/${q.queue_id}`)
    }
    done.push(`queue ${q.queue_name}`)
  }
  for (const ns of await listKv()) {
    if (!w.kv.includes(ns.title)) continue
    await cf('DELETE', `/storage/kv/namespaces/${ns.id}`)
    recordKv(ns.title, null)
    done.push(`KV namespace ${ns.title}`)
  }
  for (const b of await listBuckets()) {
    if (!w.r2.includes(b.name)) continue
    const keys = await listObjects(b.name)
    for (const key of keys) await cf('DELETE', `/r2/buckets/${b.name}/objects/${encodeURIComponent(key)}`)
    await cf('DELETE', `/r2/buckets/${b.name}`)
    done.push(`R2 bucket ${b.name} (${keys.length} objects)`)
  }
  // Its Rate Limiting namespace ids: nothing on Cloudflare (a namespace exists only as bindings name it); freed here.
  const freed = freeRateLimitIds(stage)
  if (freed.length) done.push(`rate-limit ids of ${freed.length} bindings freed`)
  log(`destroy ${stage}: ${done.length ? done.join(', ') : 'nothing to delete'}`)
  return done
}

/** Anything left whose name starts with the stage prefix: Workers, buckets, KV, queues, DO namespaces. */
export async function leftovers(stage) {
  const prefix = `viz-${stage}-`
  const [scripts, buckets, kv, queues, domains, dos] = await Promise.all([listScripts(), listBuckets(), listKv(), listQueues(), listCustomDomains(), listDurableObjectNamespaces()])
  return {
    workers: scripts.map((s) => s.id).filter((n) => n.startsWith(prefix)),
    r2: buckets.map((b) => b.name).filter((n) => n.startsWith(prefix)),
    kv: kv.map((n) => n.title).filter((n) => n.startsWith(prefix)),
    queues: queues.map((q) => q.queue_name).filter((n) => n.startsWith(prefix)),
    domains: domains.filter((d) => d.service.startsWith(prefix)).map((d) => d.hostname),
    durableObjectNamespaces: dos.map((d) => d.script ?? d.name ?? '').filter((n) => n.startsWith(prefix)),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { options: ['stage'] })
    checkStage(args.stage)
    const cmd = args._[0]
    if (cmd === 'ensure') await ensure(args.stage)
    else if (cmd === 'list') console.log(JSON.stringify({ wanted: wanted(args.stage), present: await present(args.stage) }, null, 2))
    else if (cmd === 'destroy') {
      await destroy(args.stage)
      const left = await leftovers(args.stage)
      console.log(JSON.stringify({ leftovers: left }, null, 2))
      if (Object.values(left).some((l) => l.length)) {
        log(`destroy ${args.stage}: something named viz-${args.stage}-… is still there (above)`)
        process.exit(1)
      }
    } else if (cmd === 'leftovers') console.log(JSON.stringify(await leftovers(args.stage), null, 2))
    else throw new Error('usage: resources.mjs ensure|list|destroy|leftovers [--stage <name>]')
  } catch (e) {
    log(`resources: ${e.message}`)
    process.exit(1)
  }
}
