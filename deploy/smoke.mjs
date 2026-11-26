#!/usr/bin/env node
// The post-deploy smoke test, through the public URL.
//
//   node deploy/smoke.mjs [--stage S] [--url https://…] [--health-timeout 180] [--expect-release SHA]
//
// 1. GET /healthz until it says healthy (the gateway asks every backend) and, with
//    --expect-release, until the gateway answering is the release just promoted: right after a
//    promotion some locations still run the previous version for a while.
// 2. With SMOKE_KEY (an API key with the write and read scopes) in the environment: a real
//    Remote Write of 9 samples (3 series × 3 timestamps) under a fresh run label, then a
//    query that must return exactly those samples within 60 s.
// 3. Where the release serves the web app (the manifest's viz-gateway has an app build; D74): the
//    app as app/serve.json says it is served, through the public URL: every document with its
//    headers and the released document's bytes, every file the document asks for with its headers
//    and content type, a missing hashed asset and an unknown API path as the JSON 404 (never the
//    document, never stored), and nothing but GET and HEAD served. This is where what was only
//    read in Cloudflare's documentation or seen in local workerd is checked on Cloudflare, at
//    every deploy.
// Exit 0 when everything ran and passed; non-zero otherwise. The key is never printed.
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
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

/**
 * The web app as the release's manifest says it is served (`app`: the manifest's summary of the
 * build, with app/serve.json's rules), asked through `base`. Returns `{ ok, problems, checked }`.
 */
export async function checkApp(base, app, { fetchImpl = fetch } = {}) {
  const problems = []
  const serve = app.serve
  let checked = 0
  const ask = async (path, init = {}) => {
    const res = await fetchImpl(`${base}${path}`, { redirect: 'manual', ...init, headers: { 'User-Agent': 'viz-deploy-smoke/1', ...(init.headers ?? {}) } })
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) }
  }
  const expectHeaders = (what, r, want) => {
    for (const [name, value] of Object.entries(want)) if (r.headers.get(name) !== value) problems.push(`${what}: ${name} is ${JSON.stringify(r.headers.get(name))}, not ${JSON.stringify(value)}`)
  }
  const isJson404 = (r) => r.status === 404 && /^application\/json/.test(r.headers.get('content-type') ?? '') && !/<!doctype/i.test(r.body.toString()) && !/immutable|max-age=[1-9]/.test(r.headers.get('cache-control') ?? '')
  try {
    let document = null
    for (const path of serve.documents) {
      const r = await ask(path)
      checked++
      if (r.status !== 200) {
        problems.push(`GET ${path}: ${r.status}, not the document`)
        continue
      }
      expectHeaders(`GET ${path}`, r, serve.headers.document)
      if (createHash('sha256').update(r.body).digest('hex') !== app.document.sha256) problems.push(`GET ${path}: the body is not the document of build ${app.build.slice(0, 12)} (another version answered, or something between here and the Worker rewrote the page)`)
      else document = r.body.toString()
    }
    const refs = document === null ? [] : [...new Set([...document.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]))]
    if (document !== null && !refs.some((p) => p.startsWith(serve.assetsPrefix))) problems.push(`the document asks for nothing under ${serve.assetsPrefix}`)
    for (const path of refs) {
      const isAsset = path.startsWith(serve.assetsPrefix)
      const r = await ask(path)
      checked++
      if (r.status !== 200) {
        problems.push(`GET ${path}: ${r.status}; the document asks for it`)
        continue
      }
      expectHeaders(`GET ${path}`, r, { ...(isAsset ? serve.headers.asset : serve.headers.file), 'Content-Type': serve.contentTypes[extname(path)] })
      const post = await ask(path, { method: 'POST', body: 'x' })
      if (post.status === 200) problems.push(`POST ${path}: 200; only GET and HEAD are served`)
    }
    const first = refs.find((p) => p.startsWith(serve.assetsPrefix))
    const never = [
      [`${serve.assetsPrefix}viz-smoke-missing-00000000.js`, 'a hashed asset this version does not hold'],
      ...(first ? [[`${serve.assetsPrefix}%2e%2e${first}`, 'a path that leaves the asset prefix']] : []),
      ['/index.html', 'index.html itself'],
      ['/api/v1/viz-smoke-unknown', 'an unknown API path'],
      [`${serve.documents.find((d) => d !== '/') ?? '/viz-smoke'}/`, 'a document path with a trailing slash'],
    ]
    for (const [path, what] of never) {
      const r = await ask(path, { headers: { Accept: 'text/html,*/*;q=0.8', 'Sec-Fetch-Mode': 'navigate' } })
      checked++
      // A path that leaves the prefix may be normalised to the file it names and served as that file; it must never be a page.
      if (what === 'a path that leaves the asset prefix' ? /text\/html/.test(r.headers.get('content-type') ?? '') || /<!doctype/i.test(r.body.toString()) : !isJson404(r)) {
        problems.push(`GET ${path} (${what}): ${r.status} ${r.headers.get('content-type')}, cache-control ${JSON.stringify(r.headers.get('cache-control'))}; it must be the gateway's JSON 404, never a page, never kept`)
      }
    }
    const post = await ask(serve.documents[0], { method: 'POST', body: 'x' })
    checked++
    if (!isJson404(post)) problems.push(`POST ${serve.documents[0]}: ${post.status}; only GET and HEAD are the app's`)
  } catch (e) {
    problems.push(`no answer: ${e.cause?.code ?? e.message}`)
  }
  return { ok: problems.length === 0, problems, checked }
}

/** The manifest's web app (the build its app Worker was configured with), or why there is none to check. */
export function manifestApp(manifest) {
  const w = (manifest.workers ?? []).find((x) => x.app)
  if (!w) return { app: null, why: 'no Worker of this manifest serves the web app' }
  if (w.app.withoutApp) return { app: null, why: `${w.name} was configured --without-app` }
  if (typeof w.app.build !== 'string') return { app: null, why: `the manifest holds no app build (${w.app.why ?? 'configured --ids-optional'})` }
  return { app: w.app }
}

export async function smoke({ stage, url, healthTimeoutMs = 180_000, expectRelease, appTimeoutMs = 60_000 }) {
  const base = url ?? (await publicUrl(stage))
  log(`smoke: ${base}${expectRelease ? ` (expecting release ${expectRelease})` : ''}`)
  const h = await waitHealthy(base, healthTimeoutMs, expectRelease)
  if (!h.ok) {
    log(`smoke: /healthz did not report healthy within ${healthTimeoutMs / 1000} s (last: ${h.last})`)
    return { ok: false, health: h }
  }
  log(`smoke: /healthz healthy after ${h.attempts} attempt(s) (release ${h.body.release}; ${Object.entries(h.body.backends).map(([k, v]) => `${k} ${v.status} ${v.ms} ms`).join(', ')})`)
  // The web app (D74), where this release serves one. Another location may still run the previous
  // version for some seconds after the one that answered /healthz: asked again until it passes.
  const { app, why } = manifestApp(loadManifest(stage))
  let web = 'skipped'
  if (!app) log(`smoke: the web app was not checked: ${why}`)
  else {
    const deadline = Date.now() + appTimeoutMs
    for (;;) {
      web = await checkApp(base, app)
      if (web.ok || Date.now() > deadline) break
      await sleep(3000)
    }
    if (!web.ok) {
      log(`smoke: FAILED at the web app (build ${app.build.slice(0, 12)}), ${web.problems.length} problem(s) after ${appTimeoutMs / 1000} s:`)
      for (const p of web.problems.slice(0, 20)) log(`  - ${p}`)
      log('  The API is not affected by this. If the release cannot be rolled back as a whole (forward-only), viz-gateway alone can: release.mjs rollback --record <previous.json> --only viz-gateway (deploy/README.md, "The web app").')
      return { ok: false, health: h, web }
    }
    log(`smoke: the web app (build ${app.build.slice(0, 12)}) is served as app/serve.json says: ${web.checked} requests`)
  }
  const key = process.env.SMOKE_KEY
  if (!key) {
    log('smoke: SMOKE_KEY not set; the write-and-read check was skipped')
    return { ok: true, health: h, web, data: 'skipped' }
  }
  const d = await writeAndRead(base, key)
  if (!d.ok) log(`smoke: FAILED at ${d.step}: write ${d.writeStatus}${d.queryStatus ? `, query ${d.queryStatus}` : ''}: ${d.detail ?? ''}`)
  else log(`smoke: Remote Write ${d.writeStatus} in ${d.writeMs} ms; all ${d.samples} samples returned by a query ${d.visibleAfterMs} ms after the acknowledgement`)
  return { ok: d.ok, health: h, web, data: d }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { options: ['stage', 'url', 'health-timeout', 'expect-release'] })
    checkStage(args.stage)
    const r = await smoke({ stage: args.stage, url: args.url, healthTimeoutMs: Number(args['health-timeout'] ?? 180) * 1000, expectRelease: args['expect-release'] })
    process.exit(r.ok ? 0 : 1)
  } catch (e) {
    log(`smoke: ${e.message}`)
    process.exit(1)
  }
}
