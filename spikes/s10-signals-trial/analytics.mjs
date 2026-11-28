// Usage read from Cloudflare's GraphQL analytics API for a window (read-only). Every number it
// prints is "measured on Cloudflare" for that window.
//
//   node analytics.mjs --from ISO --to ISO --state DIR [--by minute] [--only workers,dos,…] [--out file.json]
//
// DIR/ids.json holds the stage's names and ids, recorded before the stage was deleted (analytics
// keep a deleted script's rows under "__unknown__" and a namespace's under its id):
//   { "scripts": [...], "namespaces": {"<id>": "<script>:<class>"}, "bucket": "…", "queues": {"<id>": "<name>"}, "kv": {"<id>": "<title>"} }
//
// Datasets (account scope): workersInvocationsAdaptive (requests, CPU, wall time, isolate and WASM
// memory per invocation, by script, event type and status), durableObjectsInvocationsAdaptiveGroups
// and durableObjectsPeriodicGroups (per namespace: CPU, active time, GB-s, SQLite rows, memory,
// exceeded-memory errors), r2OperationsAdaptiveGroups and r2StorageAdaptiveGroups,
// queueMessageOperationsAdaptiveGroups, kvOperationsAdaptiveGroups, durableObjectsSqlStorageGroups.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? args[i + 1] : d
}
const from = opt('from')
const to = opt('to')
const state = opt('state')
if (!from || !to || !state) throw new Error('usage: analytics.mjs --from ISO --to ISO --state DIR [--by minute] [--only …] [--out f]')
const ids = JSON.parse(readFileSync(join(state, 'ids.json'), 'utf8'))
const by = opt('by')
const only = (opt('only') ?? 'workers,dos,doPeriodic,r2,r2storage,queues,kv,sql').split(',')
const acct = process.env.CLOUDFLARE_ACCOUNT_ID

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

const minute = by === 'minute' ? ' datetimeMinute' : ''
const Q = {
  workers: [`query($a:String!,$f:Time!,$t:Time!,$s:[String!]){ viewer { accounts(filter:{accountTag:$a}) {
    x: workersInvocationsAdaptive(limit:5000, filter:{datetime_geq:$f, datetime_leq:$t, scriptName_in:$s}) {
      dimensions { scriptName eventType status${minute} }
      sum { requests errors subrequests cpuTimeUs wallTime duration responseBodySize }
      quantiles { cpuTimeP50 cpuTimeP90 cpuTimeP99 wallTimeP50 wallTimeP90 wallTimeP99 memoryUsageBytesP50 memoryUsageBytesP99 wasmMemoryBytesP50 wasmMemoryBytesP99 }
      max { cpuTime wallTime memoryUsageBytes wasmMemoryBytes }
    } } } }`, { s: ids.scripts }],
  dos: [`query($a:String!,$f:Time!,$t:Time!,$n:[String!]){ viewer { accounts(filter:{accountTag:$a}) {
    x: durableObjectsInvocationsAdaptiveGroups(limit:5000, filter:{datetime_geq:$f, datetime_leq:$t, namespaceId_in:$n}) {
      dimensions { namespaceId type status${minute} }
      sum { requests errors wallTime responseBodySize }
      quantiles { cpuTimeP50 cpuTimeP90 cpuTimeP99 wallTimeP50 wallTimeP90 wallTimeP99 }
      max { wallTime }
    } } } }`, { n: Object.keys(ids.namespaces) }],
  doPeriodic: [`query($a:String!,$f:Time!,$t:Time!,$n:[String!]){ viewer { accounts(filter:{accountTag:$a}) {
    x: durableObjectsPeriodicGroups(limit:5000, filter:{datetime_geq:$f, datetime_leq:$t, namespaceId_in:$n}) {
      dimensions { namespaceId${minute} }
      sum { activeTime cpuTime duration rowsRead rowsWritten exceededCpuErrors exceededMemoryErrors fatalInternalErrors subrequests }
      max { memoryUsageBytes }
      quantiles { memoryUsageBytesP50 memoryUsageBytesP99 }
    } } } }`, { n: Object.keys(ids.namespaces) }],
  r2: [`query($a:String!,$f:Time!,$t:Time!,$b:String!){ viewer { accounts(filter:{accountTag:$a}) {
    x: r2OperationsAdaptiveGroups(limit:5000, filter:{datetime_geq:$f, datetime_leq:$t, bucketName:$b}) {
      dimensions { actionType actionStatus${minute} }
      sum { requests responseObjectSize responseBytes }
      quantiles { responseTimeMsP50 responseTimeMsP90 responseTimeMsP99 }
    } } } }`, { b: ids.bucket }],
  r2storage: [`query($a:String!,$f:Time!,$t:Time!,$b:String!){ viewer { accounts(filter:{accountTag:$a}) {
    x: r2StorageAdaptiveGroups(limit:5000, filter:{datetime_geq:$f, datetime_leq:$t, bucketName:$b}) {
      dimensions { datetimeHour }
      max { payloadSize metadataSize objectCount uploadCount }
    } } } }`, { b: ids.bucket }],
  queues: [`query($a:String!,$f:Time!,$t:Time!,$q:[String!]){ viewer { accounts(filter:{accountTag:$a}) {
    x: queueMessageOperationsAdaptiveGroups(limit:5000, filter:{datetime_geq:$f, datetime_leq:$t, queueId_in:$q}) {
      dimensions { queueId actionType outcome${minute} }
      count
      sum { billableOperations bytes }
      avg { lagTime retryCount }
      max { messageSize }
    } } } }`, { q: Object.keys(ids.queues) }],
  kv: [`query($a:String!,$f:Time!,$t:Time!,$n:[String!]){ viewer { accounts(filter:{accountTag:$a}) {
    x: kvOperationsAdaptiveGroups(limit:5000, filter:{datetime_geq:$f, datetime_leq:$t, namespaceId_in:$n}) {
      dimensions { namespaceId actionType result }
      sum { requests objectBytes }
    } } } }`, { n: Object.keys(ids.kv) }],
  sql: [`query($a:String!,$f:Time!,$t:Time!,$n:[String!]){ viewer { accounts(filter:{accountTag:$a}) {
    x: durableObjectsSqlStorageGroups(limit:5000, filter:{datetime_geq:$f, datetime_leq:$t, namespaceId_in:$n}) {
      dimensions { namespaceId }
      max { storedBytes }
    } } } }`, { n: Object.keys(ids.namespaces) }],
}

const out = { window: { from, to }, readAt: new Date().toISOString() }
for (const k of only) {
  const [query, vars] = Q[k]
  try {
    const rows = (await gql(query, { a: acct, f: from, t: to, ...vars })).x
    // Name namespaces, queues and KV namespaces.
    for (const r of rows) {
      const d = r.dimensions ?? {}
      if (d.namespaceId) d.name = ids.namespaces[d.namespaceId] ?? d.namespaceId
      if (d.queueId) d.name = ids.queues[d.queueId] ?? d.queueId
      if (k === 'kv' && d.namespaceId) d.name = ids.kv[d.namespaceId] ?? d.namespaceId
    }
    out[k] = rows
  } catch (e) {
    out[k] = { error: e.message }
  }
}

// Usage at list price, Workers Paid (developers.cloudflare.com/workers/platform/pricing/, read
// 2026-11-19), IGNORING the plan's included allowances: an upper bound of what the window adds.
const sum = (rows, f) => (Array.isArray(rows) ? rows.reduce((a, r) => a + (f(r) ?? 0), 0) : 0)
const r2Class = (t) => (/^(PutObject|CopyObject|CompleteMultipartUpload|CreateMultipartUpload|UploadPart|UploadPartCopy|ListObjects|ListMultipartUploads|ListParts|ListBuckets|PutBucket|DeleteBucket|PutBucketEncryption|PutBucketCors|PutBucketLifecycleConfiguration)/.test(t) ? 'A' : /^(DeleteObject|DeleteObjects|AbortMultipartUpload)/.test(t) ? 'free' : 'B')
if (Array.isArray(out.workers)) {
  const w = out.workers
  const u = {
    workerRequests: sum(w, (r) => r.sum.requests),
    workerCpuMs: sum(w, (r) => r.sum.cpuTimeUs) / 1000,
    doRequests: sum(out.dos, (r) => r.sum.requests),
    doGbS: sum(out.doPeriodic, (r) => r.sum.duration),
    rowsRead: sum(out.doPeriodic, (r) => r.sum.rowsRead),
    rowsWritten: sum(out.doPeriodic, (r) => r.sum.rowsWritten),
    r2ClassA: sum(out.r2, (r) => (r2Class(r.dimensions.actionType) === 'A' ? r.sum.requests : 0)),
    r2ClassB: sum(out.r2, (r) => (r2Class(r.dimensions.actionType) === 'B' ? r.sum.requests : 0)),
    queueOps: sum(out.queues, (r) => r.sum.billableOperations),
    kvReads: sum(out.kv, (r) => (r.dimensions.actionType === 'read' ? r.sum.requests : 0)),
    kvWritesDeletesLists: sum(out.kv, (r) => (r.dimensions.actionType !== 'read' ? r.sum.requests : 0)),
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
    queues: (u.queueOps / 1e6) * 0.4,
    kvReads: (u.kvReads / 1e6) * 0.5,
    kvWrites: (u.kvWritesDeletesLists / 1e6) * 5,
  }
  out.usage = u
  out.listPriceUsd = { ...Object.fromEntries(Object.entries(usd).map(([k, v]) => [k, +v.toFixed(5)])), total: +Object.values(usd).reduce((a, b) => a + b, 0).toFixed(4) }
}
const text = JSON.stringify(out, null, 2)
if (opt('out')) writeFileSync(opt('out'), text + '\n')
console.log(text)
