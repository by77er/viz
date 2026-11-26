// Usage and CPU read from Cloudflare's GraphQL analytics API (read-only). Every number it prints
// is "measured on Cloudflare" for the window given.
//
//   node analytics.mjs --from ISO --to ISO --ids ids.json [--by minute] [--out file.json]
//
// ids.json: { "script": "viz-s11-ledger", "bucket": "viz-s11-lake", "namespaces": {"<id>": "<class>"} },
// recorded while the Worker exists (analytics keep a namespace's rows under its id after deletion).
//
// Datasets: durableObjectsPeriodicGroups (per namespace and object: CPU, active time, GB-s, SQLite
// rows read and written, memory, exceeded-CPU and exceeded-memory errors), durableObjectsInvocations-
// AdaptiveGroups (per invocation type and status: requests, CPU and wall-time quantiles),
// workersInvocationsAdaptive, r2OperationsAdaptiveGroups, durableObjectsSqlStorageGroups.
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? args[i + 1] : d
}
const from = opt('from')
const to = opt('to')
const ids = JSON.parse(readFileSync(opt('ids'), 'utf8'))
if (!from || !to) throw new Error('usage: analytics.mjs --from ISO --to ISO --ids ids.json [--by minute] [--out f]')
const minute = opt('by') === 'minute' ? ' datetimeMinute' : ''
const acct = process.env.CLOUDFLARE_ACCOUNT_ID
const ns = Object.keys(ids.namespaces)

async function gql(query, variables) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) })
    const j = await res.json()
    if (j.errors?.length) {
      if (attempt < 3 && /rate|limit|timeout/i.test(JSON.stringify(j.errors))) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
        continue
      }
      throw new Error(`GraphQL: ${JSON.stringify(j.errors).slice(0, 800)}`)
    }
    return j.data.viewer.accounts[0]
  }
}

const Q = {
  periodic: `query($a:String!,$f:Time!,$t:Time!,$n:[String!]){ viewer { accounts(filter:{accountTag:$a}) {
    x: durableObjectsPeriodicGroups(limit:10000, filter:{datetime_geq:$f, datetime_leq:$t, namespaceId_in:$n}) {
      dimensions { namespaceId objectId${minute} }
      sum { activeTime cpuTime duration rowsRead rowsWritten exceededCpuErrors exceededMemoryErrors fatalInternalErrors subrequests }
      max { memoryUsageBytes }
    } } } }`,
  invocations: `query($a:String!,$f:Time!,$t:Time!,$n:[String!]){ viewer { accounts(filter:{accountTag:$a}) {
    x: durableObjectsInvocationsAdaptiveGroups(limit:10000, filter:{datetime_geq:$f, datetime_leq:$t, namespaceId_in:$n}) {
      dimensions { namespaceId objectId type status${minute} }
      sum { requests errors wallTime }
      quantiles { cpuTimeP50 cpuTimeP99 cpuTimeP999 wallTimeP50 wallTimeP99 wallTimeP999 }
      max { wallTime }
    } } } }`,
  workers: `query($a:String!,$f:Time!,$t:Time!,$s:String!){ viewer { accounts(filter:{accountTag:$a}) {
    x: workersInvocationsAdaptive(limit:1000, filter:{datetime_geq:$f, datetime_leq:$t, scriptName:$s}) {
      dimensions { scriptName status }
      sum { requests errors subrequests cpuTimeUs }
    } } } }`,
  r2: `query($a:String!,$f:Time!,$t:Time!,$b:String!){ viewer { accounts(filter:{accountTag:$a}) {
    x: r2OperationsAdaptiveGroups(limit:1000, filter:{datetime_geq:$f, datetime_leq:$t, bucketName:$b}) {
      dimensions { actionType actionStatus }
      sum { requests responseObjectSize }
    } } } }`,
  r2storage: `query($a:String!,$f:Time!,$t:Time!,$b:String!){ viewer { accounts(filter:{accountTag:$a}) {
    x: r2StorageAdaptiveGroups(limit:1000, filter:{datetime_geq:$f, datetime_leq:$t, bucketName:$b}) {
      dimensions { datetimeHour }
      max { payloadSize objectCount }
    } } } }`,
  sql: `query($a:String!,$f:Time!,$t:Time!,$n:[String!]){ viewer { accounts(filter:{accountTag:$a}) {
    x: durableObjectsSqlStorageGroups(limit:1000, filter:{datetime_geq:$f, datetime_leq:$t, namespaceId_in:$n}) {
      dimensions { namespaceId }
      max { storedBytes }
    } } } }`,
}
const vars = { a: acct, f: from, t: to, n: ns, s: ids.script, b: ids.bucket }
const out = { window: { from, to }, readAt: new Date().toISOString() }
for (const [k, q] of Object.entries(Q)) {
  try {
    const used = Object.fromEntries(Object.entries(vars).filter(([v]) => q.includes(`$${v}:`)))
    const rows = (await gql(q, used)).x
    for (const r of rows) if (r.dimensions?.namespaceId) r.dimensions.class = ids.namespaces[r.dimensions.namespaceId] ?? r.dimensions.namespaceId
    out[k] = rows
  } catch (e) {
    out[k] = { error: e.message }
  }
}

// Totals per class, and usage at list price (Workers Paid; developers.cloudflare.com, read
// 2026-11-19), IGNORING the plan's included allowances: an upper bound of what the window adds.
const sum = (rows, f) => (Array.isArray(rows) ? rows.reduce((a, r) => a + (f(r) ?? 0), 0) : 0)
const byClass = {}
for (const r of Array.isArray(out.periodic) ? out.periodic : []) {
  const c = (byClass[r.dimensions.class] ??= { cpuMs: 0, activeS: 0, gbS: 0, rowsRead: 0, rowsWritten: 0, exceededCpu: 0, exceededMemory: 0, maxMemoryMB: 0 })
  c.cpuMs += r.sum.cpuTime / 1000
  c.activeS += r.sum.activeTime / 1e6
  c.gbS += r.sum.duration
  c.rowsRead += r.sum.rowsRead
  c.rowsWritten += r.sum.rowsWritten
  c.exceededCpu += r.sum.exceededCpuErrors
  c.exceededMemory += r.sum.exceededMemoryErrors
  c.maxMemoryMB = Math.max(c.maxMemoryMB, r.max.memoryUsageBytes / 1048576)
}
for (const c of Object.values(byClass)) for (const k of Object.keys(c)) c[k] = +c[k].toFixed(k === 'gbS' ? 1 : 0)
out.byClass = byClass
const r2Class = (t) => (/^(PutObject|CopyObject|CompleteMultipartUpload|CreateMultipartUpload|UploadPart|UploadPartCopy|ListObjects|ListObjectsV2|ListMultipartUploads|ListParts|ListBuckets|PutBucket|DeleteBucket)/.test(t) ? 'A' : /^(DeleteObject|DeleteObjects|AbortMultipartUpload)/.test(t) ? 'free' : 'B')
const u = {
  workerRequests: sum(out.workers, (r) => r.sum.requests),
  workerCpuMs: sum(out.workers, (r) => r.sum.cpuTimeUs) / 1000,
  doRequests: sum(out.invocations, (r) => r.sum.requests),
  doGbS: sum(out.periodic, (r) => r.sum.duration),
  rowsRead: sum(out.periodic, (r) => r.sum.rowsRead),
  rowsWritten: sum(out.periodic, (r) => r.sum.rowsWritten),
  r2ClassA: sum(out.r2, (r) => (r2Class(r.dimensions.actionType) === 'A' ? r.sum.requests : 0)),
  r2ClassB: sum(out.r2, (r) => (r2Class(r.dimensions.actionType) === 'B' ? r.sum.requests : 0)),
}
const usd = {
  workerRequests: (u.workerRequests / 1e6) * 0.3,
  workerCpu: (u.workerCpuMs / 1e6) * 0.02,
  doRequests: (u.doRequests / 1e6) * 0.15,
  doDuration: (u.doGbS / 1e6) * 12.5,
  rowsRead: (u.rowsRead / 1e6) * 0.001,
  rowsWritten: (u.rowsWritten / 1e6) * 1.0,
  r2ClassA: (u.r2ClassA / 1e6) * 4.5,
  r2ClassB: (u.r2ClassB / 1e6) * 0.36,
}
out.usage = u
out.listPriceUsd = { ...Object.fromEntries(Object.entries(usd).map(([k, v]) => [k, +v.toFixed(4)])), total: +Object.values(usd).reduce((a, b) => a + b, 0).toFixed(3) }
const text = JSON.stringify(out, null, 1)
if (opt('out')) writeFileSync(opt('out'), text + '\n')
console.log(JSON.stringify({ window: out.window, byClass, usage: u, listPriceUsd: out.listPriceUsd }, null, 1))
