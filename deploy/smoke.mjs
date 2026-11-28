#!/usr/bin/env node
// The post-deploy smoke test, through the public URL.
//
//   node deploy/smoke.mjs [--stage S] [--url https://…] [--health-timeout 180] [--expect-release SHA] [--no-hosts]
//
// 1. GET /healthz until it says healthy (the gateway asks every backend) and, with
//    --expect-release, until the gateway answering is the release just promoted: right after a
//    promotion some locations still run the previous version for a while.
// 2. With SMOKE_KEY (an API key with the write and read scopes) in the environment: a real
//    Remote Write of 9 samples (3 series × 3 timestamps) under a fresh run label, then a
//    query that must return exactly those samples within 60 s.
// 3. Production (D75): the public URL is the manifest's domain (viz.bitcru.sh), whose OAuth metadata
//    names it as issuer; each alias of the manifest (vis.bitcru.sh) answers a data-path request
//    itself (no redirect, x-viz-route ingest, Deprecation and Link headers) and answers
//    /.well-known/oauth-authorization-server with a 308 to the same path on the domain. Retried
//    until the health timeout, as locations pick up the new gateway. Not with --url or --no-hosts
//    (after a rollback, which may restore a release from before D75, whose issuer is vis.bitcru.sh).
// Exit 0 when everything ran and passed; non-zero otherwise. The key is never printed.
import { pathToFileURL } from 'node:url'
import { workersSubdomain } from './lib/cf.mjs'
import { checkStage, log, parseArgs } from './lib/common.mjs'
import { instantQuery, remoteWrite } from './lib/prw.mjs'
import { loadManifest } from './release.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function publicUrl(stage) {
  const m = loadManifest(stage)
  if (!stage) return `https://${m.domain}`
  const gw = m.workers.find((w) => w.public)
  return `https://${gw.name}.${await workersSubdomain()}.workers.dev`
}

export async function waitHealthy(base, timeoutMs, expectRelease) {
  const deadline = Date.now() + timeoutMs
  let last = 'no answer'
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`${base}/healthz`, { headers: { 'User-Agent': 'viz-deploy-smoke/1' } })
      const body = await res.text()
      if (res.status === 200 && /"status":"healthy"/.test(body)) {
        const parsed = JSON.parse(body)
        if (!expectRelease || parsed.release === expectRelease) return { ok: true, attempts: i + 1, body: parsed, waitedMs: timeoutMs - (deadline - Date.now()) }
        last = `healthy, but release ${parsed.release} is answering, not ${expectRelease}`
      } else last = `${res.status} ${body.slice(0, 300)}`
    } catch (e) {
      last = e.cause?.code ?? e.message
    }
    if (Date.now() > deadline) return { ok: false, attempts: i + 1, last }
    await sleep(3000)
  }
}

/**
 * D75's hosts, once: `{ ok, problems }`. `base` is the canonical origin; `aliases` the hostnames
 * kept for the transition. Unauthenticated requests only (a 401 from ingest is the data path served).
 */
export async function checkHostsOnce(base, aliases, f = fetch) {
  const problems = []
  const ua = { 'User-Agent': 'viz-deploy-smoke/1' }
  const canonical = new URL(base).host
  try {
    const meta = await f(`${base}/.well-known/oauth-authorization-server`, { headers: ua, redirect: 'manual' })
    const body = await meta.text()
    let issuer = null
    try {
      issuer = JSON.parse(body).issuer ?? null
    } catch {}
    if (meta.status !== 200 || issuer !== base) problems.push(`${canonical}: OAuth metadata ${meta.status}, issuer ${JSON.stringify(issuer)}, not ${base}`)
  } catch (e) {
    problems.push(`${canonical}: OAuth metadata: ${e.cause?.code ?? e.message}`)
  }
  for (const host of aliases) {
    try {
      const w = await f(`https://${host}/api/v1/write`, { method: 'POST', headers: { ...ua, 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'snappy' }, body: new Uint8Array(0), redirect: 'manual' })
      await w.body?.cancel()
      const link = w.headers.get('Link') ?? ''
      if (w.status >= 300 && w.status < 400) problems.push(`${host}: POST /api/v1/write was redirected (${w.status} to ${w.headers.get('Location')}); data senders must be served there`)
      else if (w.headers.get('x-viz-route') !== 'ingest') problems.push(`${host}: POST /api/v1/write answered ${w.status} without x-viz-route ingest`)
      else if (!/^@\d+$/.test(w.headers.get('Deprecation') ?? '') || !link.includes(`<${base}/api/v1/write>; rel="successor-version"`)) problems.push(`${host}: POST /api/v1/write lacks Deprecation (${w.headers.get('Deprecation')}) or the successor Link (${link})`)
    } catch (e) {
      problems.push(`${host}: POST /api/v1/write: ${e.cause?.code ?? e.message}`)
    }
    try {
      const path = '/.well-known/oauth-authorization-server'
      const r = await f(`https://${host}${path}`, { headers: ua, redirect: 'manual' })
      await r.body?.cancel()
      if (r.status !== 308 || r.headers.get('Location') !== `${base}${path}`) problems.push(`${host}: GET ${path} answered ${r.status}${r.headers.get('Location') ? ` to ${r.headers.get('Location')}` : ''}, not 308 to ${base}${path}: OAuth must have one issuer`)
    } catch (e) {
      problems.push(`${host}: OAuth metadata: ${e.cause?.code ?? e.message}`)
    }
  }
  return { ok: problems.length === 0, problems }
}

/** checkHostsOnce until it passes or `timeoutMs` is spent. */
export async function checkHosts(base, aliases, timeoutMs, f = fetch, pauseMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (let i = 1; ; i++) {
    const r = await checkHostsOnce(base, aliases, f)
    if (r.ok || Date.now() > deadline) return { ...r, attempts: i }
    await sleep(pauseMs)
  }
}

/** Write 9 known samples and read them back. Returns { ok, writeStatus, visibleAfterMs, … }. */
export async function writeAndRead(base, key, { visibleWithinMs = 60_000, authRetryMs = 90_000 } = {}) {
  const run = crypto.randomUUID()
  const now = Date.now()
  const series = [0, 1, 2].map((i) => ({
    labels: { __name__: 'viz_smoke_samples', run, series: String(i), job: 'viz-smoke', instance: `smoke-${i}` },
    samples: [now - 2000, now - 1000, now].map((t, k) => [t, i * 10 + k + 0.5]),
  }))
  // A key made moments ago may not have reached this location's KV yet: retry 401 for a while.
  let w
  const writeDeadline = Date.now() + authRetryMs
  for (;;) {
    w = await remoteWrite(base, key, series)
    if (w.status === 204 || w.status === 200) break
    if (![0, 401, 429, 500, 502, 503].includes(w.status) || Date.now() > writeDeadline) return { ok: false, step: 'write', writeStatus: w.status, detail: w.text }
    await sleep(w.status === 401 ? 5000 : 1000)
  }
  const writtenAt = Date.now()
  const want = new Set(series.flatMap((s) => s.samples.map(([t, v]) => `${s.labels.series}@${t}=${v}`)))
  let last
  for (;;) {
    const q = await instantQuery(base, key, `viz_smoke_samples{run="${run}"}[5m]`, (Date.now() + 1000) / 1000)
    last = q
    if (q.status === 200 && q.body?.status === 'success') {
      const got = new Set()
      for (const r of q.body.data.result ?? []) for (const [t, v] of r.values ?? []) got.add(`${r.metric.series}@${Math.round(t * 1000)}=${Number(v)}`)
      if ([...want].every((x) => got.has(x)) && got.size === want.size) return { ok: true, writeStatus: w.status, writeMs: Math.round(w.ms), visibleAfterMs: Date.now() - writtenAt, samples: want.size }
    }
    if (Date.now() - writtenAt > visibleWithinMs) return { ok: false, step: 'read', writeStatus: w.status, queryStatus: last.status, detail: JSON.stringify(last.body).slice(0, 400) }
    await sleep(1000)
  }
}

export async function smoke({ stage, url, healthTimeoutMs = 180_000, expectRelease, hosts: checkTheHosts = true }) {
  const base = url ?? (await publicUrl(stage))
  log(`smoke: ${base}${expectRelease ? ` (expecting release ${expectRelease})` : ''}`)
  const h = await waitHealthy(base, healthTimeoutMs, expectRelease)
  if (!h.ok) {
    log(`smoke: /healthz did not report healthy within ${healthTimeoutMs / 1000} s (last: ${h.last})`)
    return { ok: false, health: h }
  }
  log(`smoke: /healthz healthy after ${h.attempts} attempt(s) (release ${h.body.release}; ${Object.entries(h.body.backends).map(([k, v]) => `${k} ${v.status} ${v.ms} ms`).join(', ')})`)
  if (!stage && !url && checkTheHosts) {
    const m = loadManifest(stage)
    const hosts = await checkHosts(base, m.domainAliases ?? [], healthTimeoutMs)
    if (!hosts.ok) {
      log(`smoke: FAILED on the hosts (D75) after ${hosts.attempts} attempt(s):\n  - ${hosts.problems.join('\n  - ')}`)
      return { ok: false, health: h, hosts }
    }
    log(`smoke: hosts: ${new URL(base).host} is the issuer; ${(m.domainAliases ?? []).map((a) => `${a} serves the data path (deprecated) and 308s OAuth to ${new URL(base).host}`).join('; ') || 'no aliases'}`)
  }
  const key = process.env.SMOKE_KEY
  if (!key) {
    log('smoke: SMOKE_KEY not set; the write-and-read check was skipped')
    return { ok: true, health: h, data: 'skipped' }
  }
  const d = await writeAndRead(base, key)
  if (!d.ok) log(`smoke: FAILED at ${d.step}: write ${d.writeStatus}${d.queryStatus ? `, query ${d.queryStatus}` : ''}: ${d.detail ?? ''}`)
  else log(`smoke: Remote Write ${d.writeStatus} in ${d.writeMs} ms; all ${d.samples} samples returned by a query ${d.visibleAfterMs} ms after the acknowledgement`)
  return { ok: d.ok, health: h, data: d }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { flags: ['no-hosts'], options: ['stage', 'url', 'health-timeout', 'expect-release'] })
    checkStage(args.stage)
    const r = await smoke({ stage: args.stage, url: args.url, healthTimeoutMs: Number(args['health-timeout'] ?? 180) * 1000, expectRelease: args['expect-release'], hosts: !args['no-hosts'] })
    process.exit(r.ok ? 0 : 1)
  } catch (e) {
    log(`smoke: ${e.message}`)
    process.exit(1)
  }
}
