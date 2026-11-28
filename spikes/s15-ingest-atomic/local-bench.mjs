// Local before/after measurement of D77 on workerd (`wrangler dev --local`), "measured here".
//
//   node local-bench.mjs <setup|run> --before http://127.0.0.1:PORT_A --after http://127.0.0.1:PORT_B \
//        --before-state DIR_A --after-state DIR_B --before-config A/edge/wrangler.jsonc --after-config B/edge/wrangler.jsonc \
//        --before-pid PIDS_A --after-pid PIDS_B [--only refused]   (run: the `workerd serve` processes behind each, comma-separated)
//
// Two edge Workers (the release before D77 and this one), each with its own persisted local state.
// `setup` writes, for each, the API keys and per-tenant pool maps (2 shards, spread 2) into the
// local KV with `wrangler kv key put --local`. `run` then, alternating between the builds:
//   A. fills one tenant's two span shards with realistic 8,200-span bodies (S10's generator,
//      protobuf, gzip) until they refuse, then measures refused attempts: the same body retried at
//      once, retried after its Retry-After, and new bodies; for each, client wall time and the
//      workerd process's CPU (utime + stime from /proc, 10 ms ticks) per request;
//   B. acknowledgement latency of accepted requests: 2,000-span bodies (two shards, two or more
//      batches: the reserve path) and 40-span bodies (one batch: no reserve), alternating request
//      by request between the builds, fresh tenants as buffers fill.
// Prints JSON. No network beyond 127.0.0.1; no credentials.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { lcg32, realisticTraces, tracesProto } from '../s10-signals-trial/load/bodies.mjs'

const args = Object.fromEntries(process.argv.slice(3).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []))
const cmd = process.argv[2]
const builds = ['before', 'after'].map((name) => ({ name, url: args[name], state: args[`${name}-state`], config: args[`${name}-config`] }))
const TENANTS = ['full', ...Array.from({ length: 12 }, (_, i) => `ack${i}`)].map((t) => `s15-${t}`)
const sha = (s) => createHash('sha256').update(s).digest('hex')
const keyOf = (b, t) => `viz_k${b.name}${t.replaceAll('-', '')}_secret-${sha(b.name + t).slice(0, 24)}`

if (cmd === 'setup') {
  for (const b of builds) {
    const entries = []
    for (const t of TENANTS) {
      const [, keyId, secret] = keyOf(b, t).match(/^viz_([^_]+)_(.+)$/)
      entries.push({ key: `key:${keyId}`, value: JSON.stringify({ tenant: t, secretSha256: sha(secret), scopes: ['write'] }) })
      entries.push({ key: `pool:${t}`, value: JSON.stringify({ pool: `bench/${t}`, slots: 2, spread: 2, epoch: 1 }) })
    }
    const file = `${b.state}/kv-bulk.json`
    writeFileSync(file, JSON.stringify(entries))
    execFileSync('npx', ['wrangler', 'kv', 'bulk', 'put', file, '--config', b.config, '--binding', 'CONFIG', '--local', '--persist-to', b.state], { stdio: 'inherit' })
  }
  console.log('setup done')
  process.exit(0)
}

// CPU of every workerd process behind a URL (`wrangler dev` runs the Worker and its own proxy in
// workerd processes): `--before-pid`, `--after-pid`, comma-separated; utime + stime, 100 Hz ticks.
const cpuMs = (pids) => pids.reduce((sum, pid) => {
  const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
  return sum + (Number(f[11]) + Number(f[12])) * 10
}, 0)
for (const b of builds) {
  b.pid = String(args[`${b.name}-pid`] ?? '').split(',').filter(Boolean).map(Number)
  if (b.pid.length === 0) throw new Error(`pass --${b.name}-pid`)
}
const ONLY_REFUSED = args.only === 'refused'

let seed = 1
const NS = () => BigInt(Date.now()) * 1_000_000n
const traceBody = (n) => gzipSync(tracesProto(realisticTraces(lcg32(seed++), NS(), n)))
const smallBody = () => {
  const t = realisticTraces(lcg32(seed++), NS(), 400)
  t.resource_spans = t.resource_spans.slice(0, 1).map((r) => ({ ...r, scope_spans: r.scope_spans.map((s) => ({ ...s, spans: s.spans.slice(0, 40) })) }))
  return gzipSync(tracesProto(t))
}
async function post(b, tenant, body) {
  const t0 = performance.now()
  const r = await fetch(`${b.url}/v1/traces`, { method: 'POST', headers: { Authorization: `Bearer ${keyOf(b, tenant)}`, 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'gzip' }, body })
  await r.arrayBuffer()
  return { status: r.status, ms: performance.now() - t0, retryAfter: Number(r.headers.get('Retry-After') ?? 0) }
}
const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0)
const summary = (xs) => ({ n: xs.length, p50: q(xs, 0.5), p90: q(xs, 0.9), mean: xs.length ? sum(xs) / xs.length : null })

const result = { builds: builds.map((b) => ({ name: b.name, url: b.url, pid: b.pid })), refused: {}, ack: {} }

// ── A. a full buffer ──
for (const b of builds) {
  let refusedInARow = 0
  let sent = 0
  while (refusedInARow < 3 && sent < 200) {
    const r = await post(b, 's15-full', traceBody(8200))
    sent++
    refusedInARow = r.status === 429 ? refusedInARow + 1 : 0
    if (r.status !== 200 && r.status !== 429) throw new Error(`fill ${b.name}: ${r.status}`)
  }
  b.filledAfter = sent
}
result.filledAfter = Object.fromEntries(builds.map((b) => [b.name, b.filledAfter]))
// One refused body per build, refused once already (so the tenant is marked), then refused once more (so the body is remembered).
for (const b of builds) {
  b.body = traceBody(8200)
  for (let i = 0; i < 2; i++) if ((await post(b, 's15-full', b.body)).status !== 429) throw new Error(`${b.name}: expected 429 while full`)
}
async function measure(label, rounds, per, make, gapMs = 0) {
  const out = Object.fromEntries(builds.map((b) => [b.name, { ms: [], cpu: 0, n: 0, statuses: {} }]))
  for (let r = 0; r < rounds; r++) {
    for (const b of builds) {
      const bodies = Array.from({ length: per }, () => make(b))
      const c0 = cpuMs(b.pid)
      for (const body of bodies) {
        if (gapMs) await new Promise((res) => setTimeout(res, gapMs))
        const x = await post(b, 's15-full', body)
        out[b.name].ms.push(x.ms)
        out[b.name].statuses[x.status] = (out[b.name].statuses[x.status] ?? 0) + 1
      }
      out[b.name].cpu += cpuMs(b.pid) - c0
      out[b.name].n += per
    }
  }
  result.refused[label] = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { ...summary(v.ms), cpuMsPerRequest: v.cpu / v.n, statuses: v.statuses }]))
}
await measure('same body, retried at once', 10, 20, (b) => b.body)
await measure('same body, retried after its Retry-After (1.05 s)', 5, 4, (b) => b.body, 1050)
await measure('a new body each time', 5, 6, () => traceBody(8200))

// ── B. acknowledgement latency ──
if (ONLY_REFUSED) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}
const ackTenant = Object.fromEntries(builds.map((b) => [b.name, { i: 0, bytes: 0 }]))
const acks = Object.fromEntries(['large', 'small'].flatMap((k) => builds.map((b) => [`${k}:${b.name}`, []])))
for (let i = 0; i < 220; i++) {
  for (const kind of ['large', 'small']) {
    const body = kind === 'large' ? traceBody(2000) : smallBody()
    for (const b of i % 2 === 0 ? builds : [...builds].reverse()) {
      const at = ackTenant[b.name]
      const tenant = `s15-ack${at.i}`
      const x = await post(b, tenant, body)
      if (x.status === 429) {
        at.i++
        if (at.i >= 12) throw new Error('out of ack tenants')
        continue
      }
      if (x.status !== 200) throw new Error(`ack ${b.name}: ${x.status}`)
      if (i >= 20) acks[`${kind}:${b.name}`].push(x.ms) // the first 20 warm up
    }
  }
}
for (const [k, v] of Object.entries(acks)) result.ack[k] = summary(v)
console.log(JSON.stringify(result, null, 2))
