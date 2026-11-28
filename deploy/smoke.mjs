#!/usr/bin/env node
// The post-deploy smoke test, through the public URL.
//
//   node deploy/smoke.mjs [--stage S] [--url https://…] [--health-timeout 180] [--expect-release SHA] [--no-hosts] [--no-app]
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
//    /.well-known/oauth-authorization-server with a 308 to the same path on the domain; where the
//    release serves the web app, each alias also answers its documents and a missing hashed asset
//    with a 308 to the domain (the app is served on the domain only; D75 with D74). Retried
//    until the health timeout, as locations pick up the new gateway. Not with --url or --no-hosts
//    (after a rollback, which may restore a release from before D75, whose issuer is vis.bitcru.sh).
// 4. Where the release serves the web app (the manifest's viz-gateway has an app build; D74): the
//    app as app/serve.json says it is served, through the public URL: every document with its
//    headers and the released document's bytes; EVERY file of the version (the build's, also those
//    no document names, and the ones kept from earlier builds) with its headers, its content type
//    and the bytes the release staged (SHA-256; review of D74, m-7); a missing hashed asset and an
//    unknown API path as the JSON 404 (never the document, never stored); nothing but GET and HEAD
//    served. This is where what was only read in Cloudflare's documentation or seen in local
//    workerd is checked on Cloudflare, at every deploy.
// Steps 2, 3 and 4 all run whatever the others found, and every result is reported (m-8).
// Exit 0 when everything ran and passed; non-zero otherwise. The key is never printed.
// The result is also written to deploy/generated/<target>/smoke.json (no key, no body).
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { workersSubdomain } from './lib/cf.mjs'
import { GENERATED_DIR, checkStage, log, parseArgs, targetName } from './lib/common.mjs'
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
export async function checkHostsOnce(base, aliases, f = fetch, { app = null } = {}) {
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
    // The web app is served on the domain only (D75 with D74): on an alias each document, and a
    // hashed asset the version does not hold (which reaches the Worker), is a 308 to the domain,
    // never the page and never a 404 kept for a year. An asset the version holds is answered by
    // Cloudflare's asset layer before the Worker runs, on every hostname, and is not asked here
    // (deploy/README.md, "The app on vis.bitcru.sh").
    if (app) {
      const paths = [...app.serve.documents, `${app.serve.assetsPrefix}viz-smoke-missing-00000000.js`]
      for (const path of paths) {
        try {
          const r = await f(`https://${host}${path}`, { headers: { ...ua, Accept: 'text/html,*/*;q=0.8' }, redirect: 'manual' })
          await r.body?.cancel()
          if (r.status !== 308 || r.headers.get('Location') !== `${base}${path}`) problems.push(`${host}: GET ${path} answered ${r.status}${r.headers.get('Location') ? ` to ${r.headers.get('Location')}` : ''}, not 308 to ${base}${path}: the web app is served on ${new URL(base).host} only`)
          else if (/immutable|max-age=[1-9]/.test(r.headers.get('cache-control') ?? '')) problems.push(`${host}: GET ${path}: the 308 may be kept (Cache-Control ${r.headers.get('cache-control')}); it must outlive no rollback`)
        } catch (e) {
          problems.push(`${host}: GET ${path}: ${e.cause?.code ?? e.message}`)
        }
      }
    }
  }
  return { ok: problems.length === 0, problems }
}

/** checkHostsOnce until it passes or `timeoutMs` is spent. */
export async function checkHosts(base, aliases, timeoutMs, f = fetch, pauseMs = 3000, opts = {}) {
  const deadline = Date.now() + timeoutMs
  for (let i = 1; ; i++) {
    const r = await checkHostsOnce(base, aliases, f, opts)
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
    // Every file of the version, byte for byte: what the release hashed before the upload is what
    // Cloudflare serves after it (nothing changed the directory in between, and nothing between here
    // and the asset layer rewrites a script). The kept files of earlier builds too.
    const hashes = [...Object.entries(app.fileHashes ?? {}), ...(app.kept ?? []).filter((k) => k.sha256).map((k) => [k.path, k.sha256])]
    if (app.fileHashes === undefined) problems.push('the manifest names no file hashes for the web app (configured by an older deploy/configure.mjs): the files\' bytes cannot be compared')
    for (const [path, want] of hashes) {
      const r = await ask(path)
      checked++
      if (r.status !== 200) {
        problems.push(`GET ${path}: ${r.status}; it is a file of this version`)
        continue
      }
      if (!refs.includes(path)) expectHeaders(`GET ${path}`, r, { ...(path.startsWith(serve.assetsPrefix) ? serve.headers.asset : serve.headers.file), 'Content-Type': serve.contentTypes[extname(path)] })
      if (createHash('sha256').update(r.body).digest('hex') !== want) problems.push(`GET ${path}: the body is not the file the release staged (its SHA-256 differs: the directory changed before the upload, another version answered, or something between here and Cloudflare rewrote it)`)
    }
    // (Paths with dot segments are not asked here: this client's URL parser removes them before
    // sending. test/app-serve.test.mjs sends them raw to a local workerd.)
    const never = [
      [`${serve.assetsPrefix}viz-smoke-missing-00000000.js`, 'a hashed asset this version does not hold'],
      ['/index.html', 'index.html itself'],
      ['/api/v1/viz-smoke-unknown', 'an unknown API path'],
      [`${serve.documents.find((d) => d !== '/') ?? '/viz-smoke'}/`, 'a document path with a trailing slash'],
    ]
    for (const [path, what] of never) {
      const r = await ask(path, { headers: { Accept: 'text/html,*/*;q=0.8', 'Sec-Fetch-Mode': 'navigate' } })
      checked++
      if (!isJson404(r)) {
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

export async function smoke({ stage, url, healthTimeoutMs = 180_000, expectRelease, hosts: checkTheHosts = true, appTimeoutMs = 60_000, checkWebApp = true, write = writeAndRead }) {
  const base = url ?? (await publicUrl(stage))
  log(`smoke: ${base}${expectRelease ? ` (expecting release ${expectRelease})` : ''}`)
  const h = await waitHealthy(base, healthTimeoutMs, expectRelease)
  if (!h.ok) {
    log(`smoke: /healthz did not report healthy within ${healthTimeoutMs / 1000} s (last: ${h.last})`)
    return { ok: false, health: h }
  }
  log(`smoke: /healthz healthy after ${h.attempts} attempt(s) (release ${h.body.release}; ${Object.entries(h.body.backends).map(([k, v]) => `${k} ${v.status} ${v.ms} ms`).join(', ')})`)
  // The web app (D74), where this release serves one. `checkWebApp: false` (--no-app): after a
  // rollback, when what serves is not the manifest's release.
  const { app, why } = checkWebApp ? manifestApp(loadManifest(stage)) : { app: null, why: 'not asked (--no-app)' }
  // The hostnames (D75), production only. A failure here does not stop the checks after it: each is reported (m-8).
  let hosts = 'skipped'
  if (!stage && !url && checkTheHosts) {
    const m = loadManifest(stage)
    hosts = await checkHosts(base, m.domainAliases ?? [], healthTimeoutMs, fetch, 3000, { app })
    if (!hosts.ok) log(`smoke: FAILED on the hosts (D75) after ${hosts.attempts} attempt(s):\n  - ${hosts.problems.join('\n  - ')}`)
    else log(`smoke: hosts: ${new URL(base).host} is the issuer; ${(m.domainAliases ?? []).map((a) => `${a} serves the data path (deprecated) and 308s OAuth${app ? ' and the web app' : ''} to ${new URL(base).host}`).join('; ') || 'no aliases'}`)
  }
  const hostsOk = hosts === 'skipped' || hosts.ok
  // Another location may still run the previous version for some seconds after the one that
  // answered /healthz: the app is asked again until it passes.
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
    } else log(`smoke: the web app (build ${app.build.slice(0, 12)}) is served as app/serve.json says: ${web.checked} requests, every file with the bytes the release staged`)
  }
  // The data check runs whatever the app check found: a broken page must not hide whether writes
  // and reads work, least of all after a release that cannot be rolled back (review of D74, m-8).
  const webOk = web === 'skipped' || web.ok
  const key = process.env.SMOKE_KEY
  let data = 'skipped'
  if (!key) log('smoke: SMOKE_KEY not set; the write-and-read check was skipped')
  else {
    data = await write(base, key)
    if (!data.ok) log(`smoke: FAILED at ${data.step}: write ${data.writeStatus}${data.queryStatus ? `, query ${data.queryStatus}` : ''}: ${data.detail ?? ''}`)
    else log(`smoke: Remote Write ${data.writeStatus} in ${data.writeMs} ms; all ${data.samples} samples returned by a query ${data.visibleAfterMs} ms after the acknowledgement`)
  }
  const dataOk = data === 'skipped' || data.ok
  if (!webOk) {
    log(`smoke: the web app FAILED; the data path ${data === 'skipped' ? 'was not checked (no SMOKE_KEY)' : data.ok ? 'PASSED (writes and reads work)' : 'FAILED too'}.`)
    log('  If the release cannot be rolled back as a whole (forward-only), viz-gateway alone can go back: release.mjs rollback --record <previous.json> --only viz-gateway, or the workflow\'s rollback_only.')
    log('  What that costs: the gateway of the previous release comes back WHOLE, not only without this page. Every route the gateway gained since that version answers 404 again (after the first release over the 2026-11-19 production: no web app at all, and routes such as /api/echo), while the backends stay on the new release. Read deploy/README.md, "Rolling viz-gateway back alone", before choosing between that and a fix forward.')
  }
  return { ok: hostsOk && webOk && dataOk, health: h, hosts, web, data }
}

/** What a smoke test found, for the record of a stage that went before production (no key, no response body). */
export function writeSmokeRecord(stage, result, { release = null, base = null, at = new Date().toISOString() } = {}) {
  const dir = join(GENERATED_DIR, targetName(stage))
  mkdirSync(dir, { recursive: true })
  const web = result.web && result.web !== 'skipped' ? { ok: result.web.ok, checked: result.web.checked, problems: result.web.problems.slice(0, 20) } : 'skipped'
  const data = result.data && result.data !== 'skipped' ? { ok: result.data.ok, samples: result.data.samples ?? null } : (result.data ?? null)
  const hosts = result.hosts && result.hosts !== 'skipped' ? { ok: result.hosts.ok, problems: result.hosts.problems.slice(0, 20) } : 'skipped'
  const record = { v: 1, at, target: targetName(stage), release: result.health?.body?.release ?? release, expected: release, base, ok: result.ok === true, healthy: result.health?.ok === true, hosts, web, data }
  const file = join(dir, 'smoke.json')
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
  return { file, record }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { flags: ['no-hosts', 'no-app'], options: ['stage', 'url', 'health-timeout', 'expect-release'] })
    checkStage(args.stage)
    const r = await smoke({ stage: args.stage, url: args.url, healthTimeoutMs: Number(args['health-timeout'] ?? 180) * 1000, expectRelease: args['expect-release'], hosts: !args['no-hosts'], checkWebApp: !args['no-app'] })
    // Not after a rollback (--no-app): that run describes another release than the manifest's.
    if (!args['no-app']) writeSmokeRecord(args.stage, r, { release: args['expect-release'] ?? null, base: args.url ?? null })
    process.exit(r.ok ? 0 : 1)
  } catch (e) {
    log(`smoke: ${e.message}`)
    process.exit(1)
  }
}
