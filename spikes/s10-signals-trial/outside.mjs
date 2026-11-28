// Bodies sent ONE AT A TIME from outside Cloudflare to the stage gateway's public URL, so that each
// edge invocation is reported by the analytics API on its own (a chain that starts at an internet
// request reports the callee's rows under its own script; one that starts in a Durable Object
// reports them under the object's namespace: README, "Where CPU is counted"). Not a load test: the
// latency includes this machine's path; only Cloudflare's per-invocation CPU and memory are used.
//
//   VIZ_TREE=… STATE=… node outside.mjs send --tenant s10-hostile [--gap 3000]   writes STATE/outside.json
//   VIZ_TREE=… STATE=… node outside.mjs read                                    per-invocation analytics
//
// The bodies: every file in STATE/hostile (edge/bench/memory.mjs --dump: D71's hostile bodies and
// bodies.mjs's realistic ones), gzip-encoded where the protocol allows (OTLP), snappy for Loki
// protobuf; and realistic bodies with distinct ids (load/bodies.mjs, lcg32), two per kind.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import * as B from './load/bodies.mjs'

const TREE = process.env.VIZ_TREE
const STATE = process.env.STATE
const cfm = await import(pathToFileURL(join(TREE, 'deploy', 'lib', 'cf.mjs')).href)
const snappy = (await import(pathToFileURL(join(TREE, 'edge', 'node_modules', 'snappyjs', 'index.js')).href)).default
const args = process.argv.slice(2)
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function bodies() {
  const out = []
  const dir = join(STATE, 'hostile')
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.bin')).sort()) {
    const raw = new Uint8Array(readFileSync(join(dir, f)))
    const json = /json/i.test(f)
    const path = /^(realistic-)?traces/i.test(f) ? '/v1/traces' : /^(realistic-)?logs/i.test(f) ? '/v1/logs' : /^(realistic-)?loki/i.test(f) ? '/loki/api/v1/push' : '/v1/metrics'
    if (path === '/loki/api/v1/push' && !json) out.push({ name: f, path, headers: { 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'snappy' }, body: /snappy/i.test(f) ? raw : snappy.compress(raw), raw: raw.length })
    else out.push({ name: f, path, headers: { 'Content-Type': json ? 'application/json' : 'application/x-protobuf', 'Content-Encoding': 'gzip' }, body: gzipSync(raw), raw: raw.length })
  }
  const enc = (s) => new TextEncoder().encode(s)
  for (let i = 0; i < 2; i++) {
    const ns = BigInt(Date.now()) * 1_000_000n
    const t = B.realisticTraces(B.lcg32(99_000_000 + i), ns)
    const l = B.realisticLogs(B.lcg32(99_100_000 + i), ns)
    const k = B.realisticLoki(B.lcg32(99_200_000 + i), ns)
    const add = (name, path, ct, raw, ce) => out.push({ name: `uniq ${name} ${i}`, path, headers: { 'Content-Type': ct, 'Content-Encoding': ce }, body: ce === 'gzip' ? gzipSync(raw) : snappy.compress(raw), raw: raw.length })
    add('traces protobuf', '/v1/traces', 'application/x-protobuf', B.tracesProto(t), 'gzip')
    add('traces JSON', '/v1/traces', 'application/json', enc(B.tracesJson(t)), 'gzip')
    add('logs protobuf', '/v1/logs', 'application/x-protobuf', B.logsProto(l), 'gzip')
    add('logs JSON', '/v1/logs', 'application/json', enc(B.logsJson(l)), 'gzip')
    add('Loki protobuf', '/loki/api/v1/push', 'application/x-protobuf', B.lokiProto(k), 'snappy')
    add('Loki JSON', '/loki/api/v1/push', 'application/json', enc(B.lokiJson(k)), 'gzip')
  }
  return out
}

if (args[0] === 'send') {
  const tenant = opt('tenant', 's10-hostile')
  const key = readFileSync(join(STATE, 'keys', `${tenant}.key`), 'utf8').trim()
  const base = `https://viz-s10-gateway.${await cfm.workersSubdomain()}.workers.dev`
  const sent = []
  for (const b of bodies()) {
    const at = new Date().toISOString()
    const t0 = Date.now()
    const res = await fetch(base + b.path, { method: 'POST', headers: { Authorization: `Bearer ${key}`, ...b.headers }, body: b.body })
    const text = new Uint8Array(await res.arrayBuffer())
    sent.push({ name: b.name, path: b.path, raw: b.raw, wire: b.body.length, at, ms: Date.now() - t0, status: res.status, answer: res.headers.get('content-type')?.includes('json') || res.headers.get('content-type')?.includes('text') ? new TextDecoder().decode(text).slice(0, 160) : `${text.length} bytes` })
    console.log(`${b.name.padEnd(64)} ${res.status} ${Date.now() - t0} ms`)
    await sleep(Number(opt('gap', '3000')))
  }
  writeFileSync(join(STATE, 'outside.json'), JSON.stringify(sent, null, 1) + '\n')
} else if (args[0] === 'read') {
  // One row per invocation of viz-s10-ingest (by its exact datetime), matched to the body sent just before it.
  const sent = JSON.parse(readFileSync(join(STATE, 'outside.json'), 'utf8'))
  const from = sent[0].at
  const to = new Date(Date.parse(sent.at(-1).at) + 30_000).toISOString()
  const q = `query($a:String!,$f:Time!,$t:Time!){ viewer { accounts(filter:{accountTag:$a}) {
    x: workersInvocationsAdaptive(limit:1000, filter:{datetime_geq:$f, datetime_leq:$t, scriptName:"viz-s10-ingest", eventType:"fetch"}, orderBy:[datetime_ASC]) {
      dimensions { datetime status httpResponseStatus } avg { sampleInterval } max { cpuTime wallTime memoryUsageBytes wasmMemoryBytes } sum { requests } } } } }`
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, variables: { a: process.env.CLOUDFLARE_ACCOUNT_ID, f: from, t: to } }) }).then((x) => x.json())
  if (r.errors) throw new Error(JSON.stringify(r.errors))
  const rows = r.data.viewer.accounts[0].x
  const out = []
  for (const s of sent) {
    const t = Date.parse(s.at)
    const row = rows.find((x) => Date.parse(x.dimensions.datetime) >= t - 1000 && Date.parse(x.dimensions.datetime) <= t + s.ms + 1000 && x.dimensions.httpResponseStatus === s.status)
    out.push({ ...s, cpuMs: row ? row.max.cpuTime / 1000 : null, wallMs: row ? row.max.wallTime / 1000 : null, isolateMiB: row ? +(row.max.memoryUsageBytes / 2 ** 20).toFixed(1) : null, sampleInterval: row?.avg.sampleInterval ?? null })
  }
  writeFileSync(join(STATE, 'outside-analytics.json'), JSON.stringify({ window: { from, to }, rows: out }, null, 1) + '\n')
  for (const o of out) console.log(`${o.name.padEnd(64)} ${o.status} cpu ${o.cpuMs ?? '?'} ms, isolate ${o.isolateMiB ?? '?'} MiB, wall ${o.wallMs ?? '?'} ms`)
  console.log(`${rows.length} analytics rows for ${sent.length} requests`)
}
