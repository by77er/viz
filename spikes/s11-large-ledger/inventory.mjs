// The account's resources by name, before and after the trial (read-only):
//
//   VIZ_TREE=/path/to/checkout node inventory.mjs <out.json>          list and write
//   VIZ_TREE=… node inventory.mjs --diff <before.json> <after.json>   what changed
//
// Workers, R2 buckets, KV namespaces, queues, Durable Object namespaces, Workers custom domains.
// Names only: no ids are needed to compare, and nothing secret is read. The README reports counts
// and the `viz-` names; other names stay in the scratch files.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const TREE = process.env.VIZ_TREE
if (!TREE) throw new Error('VIZ_TREE: a checkout with deploy/lib/cf.mjs')
const cfm = await import(pathToFileURL(join(TREE, 'deploy', 'lib', 'cf.mjs')).href)

async function inventory() {
  const [scripts, buckets, kv, queues, dos, domains] = await Promise.all([
    cfm.listScripts(),
    cfm.cf('GET', '/r2/buckets?per_page=1000').then((j) => j.result?.buckets ?? []),
    cfm.cfList('/storage/kv/namespaces'),
    cfm.cfList('/queues'),
    cfm.listDurableObjectNamespaces(),
    cfm.listCustomDomains(),
  ])
  const sort = (a) => [...a].sort()
  return {
    at: new Date().toISOString(),
    workers: sort(scripts.map((s) => s.id)),
    r2: sort(buckets.map((b) => b.name)),
    kv: sort(kv.map((n) => n.title)),
    queues: sort(queues.map((q) => q.queue_name)),
    durableObjectNamespaces: sort(dos.map((d) => `${d.script ?? '?'}:${d.class ?? d.name ?? '?'}`)),
    customDomains: sort(domains.map((d) => `${d.hostname} → ${d.service}`)),
  }
}

const summary = (inv) => Object.fromEntries(Object.entries(inv).filter(([k]) => k !== 'at').map(([k, v]) => [k, { count: v.length, viz: v.filter((n) => n.startsWith('viz-') || n.includes('viz-')) }]))

const args = process.argv.slice(2)
if (args[0] === '--diff') {
  const [a, b] = args.slice(1).map((f) => JSON.parse(readFileSync(f, 'utf8')))
  const out = {}
  for (const k of Object.keys(a)) {
    if (k === 'at') continue
    const added = b[k].filter((x) => !a[k].includes(x))
    const removed = a[k].filter((x) => !b[k].includes(x))
    out[k] = { before: a[k].length, after: b[k].length, added, removed }
  }
  console.log(JSON.stringify({ before: a.at, after: b.at, ...out }, null, 2))
} else {
  const inv = await inventory()
  if (args[0]) writeFileSync(args[0], JSON.stringify(inv, null, 2) + '\n')
  console.log(JSON.stringify({ at: inv.at, ...summary(inv) }, null, 2))
}
