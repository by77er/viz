#!/usr/bin/env node
// The post-deploy smoke test, through the public URL.
//
//   node deploy/smoke.mjs [--stage S] [--url https://…] [--health-timeout 180]
//
// 1. GET /healthz until it says healthy (the gateway asks every backend).
// 2. With SMOKE_KEY (an API key with the write and read scopes) in the environment: a real
//    Remote Write of 9 samples (3 series × 3 timestamps) under a fresh run label, then a
//    query that must return exactly those samples within 60 s.
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

export async function waitHealthy(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = 'no answer'
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`${base}/healthz`, { headers: { 'User-Agent': 'viz-deploy-smoke/1' } })
      const body = await res.text()
      if (res.status === 200 && /"status":"healthy"/.test(body)) return { ok: true, attempts: i + 1, body: JSON.parse(body) }
      last = `${res.status} ${body.slice(0, 300)}`
    } catch (e) {
      last = e.cause?.code ?? e.message
    }
    if (Date.now() > deadline) return { ok: false, attempts: i + 1, last }
    await sleep(3000)
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

export async function smoke({ stage, url, healthTimeoutMs = 180_000 }) {
  const base = url ?? (await publicUrl(stage))
  log(`smoke: ${base}`)
  const h = await waitHealthy(base, healthTimeoutMs)
  if (!h.ok) {
    log(`smoke: /healthz did not report healthy within ${healthTimeoutMs / 1000} s (last: ${h.last})`)
    return { ok: false, health: h }
  }
  log(`smoke: /healthz healthy (release ${h.body.release}; ${Object.entries(h.body.backends).map(([k, v]) => `${k} ${v.status} ${v.ms} ms`).join(', ')})`)
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
    const args = parseArgs(process.argv.slice(2), { options: ['stage', 'url', 'health-timeout'] })
    checkStage(args.stage)
    const r = await smoke({ stage: args.stage, url: args.url, healthTimeoutMs: Number(args['health-timeout'] ?? 180) * 1000 })
    process.exit(r.ok ? 0 : 1)
  } catch (e) {
    log(`smoke: ${e.message}`)
    process.exit(1)
  }
}
