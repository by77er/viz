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
// Production is never deleted from here: `destroy` refuses without --stage. A stage is torn
// down by exact name (never by prefix match), in this order: its Workers (callers first), any
// custom domain pointing at them, its queues, its KV namespace, its R2 objects, its bucket.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CfError, cf, cfList, deleteScript, listCustomDomains, listDurableObjectNamespaces, listScripts } from './lib/cf.mjs'
import { DEPLOY_DIR, REPO_ROOT, checkStage, log, parseArgs, readJson, readJsonc, stagedName } from './lib/common.mjs'
import { queuesOf } from './configure.mjs'

const RESOURCES_FILE = join(DEPLOY_DIR, 'resources.json')

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
