// node --test deploy/test/: smoke.mjs's D75 host checks, against a stub fetch (nothing is reached).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// Before smoke.mjs loads: generated/ is this test's own (a production manifest is written there below).
const tmp = mkdtempSync(join(tmpdir(), 'viz-smoke-'))
process.env.VIZ_GENERATED_DIR = join(tmp, 'generated')
after(() => rmSync(tmp, { recursive: true, force: true }))
const { checkHosts, checkHostsOnce, smoke } = await import('../smoke.mjs')

const VIZ = 'https://viz.bitcru.sh'
const META = '/.well-known/oauth-authorization-server'

/** A production as D75 wants it, with `over` replacing the answer for `METHOD url`. */
const site = (over = {}) => async (url, init = {}) => {
  const key = `${init.method ?? 'GET'} ${url}`
  assert.equal(init.redirect, 'manual', `${key} must not follow redirects`)
  if (over[key]) return over[key]()
  if (key === `GET ${VIZ}${META}`) return Response.json({ issuer: VIZ })
  if (key === 'POST https://vis.bitcru.sh/api/v1/write') return new Response('unauthorized', { status: 401, headers: { 'x-viz-route': 'ingest', Deprecation: '@1795824000', Link: `<${VIZ}/api/v1/write>; rel="successor-version"` } })
  if (key === `GET https://vis.bitcru.sh${META}`) return new Response(null, { status: 308, headers: { Location: `${VIZ}${META}` } })
  throw new Error(`unexpected ${key}`)
}

test('passes on production as D75 wants it', async () => {
  assert.deepEqual(await checkHostsOnce(VIZ, ['vis.bitcru.sh'], site()), { ok: true, problems: [] })
})

test('fails when vis redirects the data path, serves OAuth itself, or the issuer is not viz', async () => {
  const cases = {
    'POST https://vis.bitcru.sh/api/v1/write': [() => new Response(null, { status: 308, headers: { Location: `${VIZ}/api/v1/write` } }), /was redirected \(308/],
    [`GET https://vis.bitcru.sh${META}`]: [() => Response.json({ issuer: 'https://vis.bitcru.sh' }), /answered 200, not 308/],
    [`GET ${VIZ}${META}`]: [() => Response.json({ issuer: 'https://vis.bitcru.sh' }), /issuer "https:\/\/vis\.bitcru\.sh", not https:\/\/viz\.bitcru\.sh/],
  }
  for (const [key, [answer, pattern]] of Object.entries(cases)) {
    const r = await checkHostsOnce(VIZ, ['vis.bitcru.sh'], site({ [key]: answer }))
    assert.equal(r.ok, false, key)
    assert.match(r.problems.join('\n'), pattern, key)
  }
  const noHeaders = await checkHostsOnce(VIZ, ['vis.bitcru.sh'], site({ 'POST https://vis.bitcru.sh/api/v1/write': () => new Response('x', { status: 401, headers: { 'x-viz-route': 'ingest' } }) }))
  assert.match(noHeaders.problems.join('\n'), /lacks Deprecation/)
  const wrongTarget = await checkHostsOnce(VIZ, ['vis.bitcru.sh'], site({ [`GET https://vis.bitcru.sh${META}`]: () => new Response(null, { status: 301, headers: { Location: `${VIZ}/` } }) }))
  assert.match(wrongTarget.problems.join('\n'), /answered 301 to https:\/\/viz\.bitcru\.sh\/, not 308/)
  // The right place, but 301 or 302 (a client may turn POST into GET) or 307 (temporary): not D75's 308.
  for (const status of [301, 302, 307]) {
    const r = await checkHostsOnce(VIZ, ['vis.bitcru.sh'], site({ [`GET https://vis.bitcru.sh${META}`]: () => new Response(null, { status, headers: { Location: `${VIZ}${META}` } }) }))
    assert.match(r.problems.join('\n'), new RegExp(`answered ${status} to .*, not 308`), String(status))
  }
  const down = await checkHostsOnce(VIZ, ['vis.bitcru.sh'], async () => { throw new Error('ENOTFOUND') })
  assert.equal(down.problems.length, 3)
})

test('checkHosts retries until it passes, and gives up at its deadline', async () => {
  let n = 0
  const flaky = async (url, init) => (++n <= 3 ? new Response('old version', { status: 200 }) : site()(url, init))
  const r = await checkHosts(VIZ, ['vis.bitcru.sh'], 10_000, flaky, 1)
  assert.equal(r.ok, true)
  assert.ok(r.attempts >= 2)
  const never = await checkHosts(VIZ, ['vis.bitcru.sh'], 20, async () => new Response('no', { status: 404 }), 5)
  assert.equal(never.ok, false)
})

// D75 with D74: where the release serves the web app, its documents and a missing hashed asset on
// the alias are a 308 to viz (the app is served on viz only).
const APP = { serve: { documents: ['/', '/explore'], assetsPrefix: '/assets/' } }
const appSite = (over = {}) => {
  const base = site()
  return async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${url}`
    if (over[key]) return over[key]()
    const m = /^GET https:\/\/vis\.bitcru\.sh(\/|\/explore|\/assets\/viz-smoke-missing-00000000\.js)$/.exec(key)
    if (m) return new Response('{"status":"moved"}', { status: 308, headers: { Location: `${VIZ}${m[1]}`, 'Cache-Control': 'no-store' } })
    return base(url, init)
  }
}

test('with the web app: passes when vis 308s its documents and a missing asset to viz; fails when vis serves the page, 404s, or lets the redirect be kept', async () => {
  assert.deepEqual(await checkHostsOnce(VIZ, ['vis.bitcru.sh'], appSite(), { app: APP }), { ok: true, problems: [] })
  // Without the app, nothing of it is asked (a stub that knows none of its paths still passes).
  assert.deepEqual(await checkHostsOnce(VIZ, ['vis.bitcru.sh'], site(), { app: null }), { ok: true, problems: [] })
  const page = () => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
  const cases = {
    'GET https://vis.bitcru.sh/': [page, /GET \/ answered 200, not 308 to https:\/\/viz\.bitcru\.sh\/: the web app is served on viz\.bitcru\.sh only/],
    'GET https://vis.bitcru.sh/explore': [() => new Response(null, { status: 308, headers: { Location: `${VIZ}/` } }), /GET \/explore answered 308 to https:\/\/viz\.bitcru\.sh\/, not 308 to https:\/\/viz\.bitcru\.sh\/explore/],
    'GET https://vis.bitcru.sh/assets/viz-smoke-missing-00000000.js': [() => Response.json({ errorType: 'not_found' }, { status: 404 }), /viz-smoke-missing-00000000\.js answered 404/],
  }
  for (const [key, [answer, pattern]] of Object.entries(cases)) {
    const r = await checkHostsOnce(VIZ, ['vis.bitcru.sh'], appSite({ [key]: answer }), { app: APP })
    assert.equal(r.ok, false, key)
    assert.match(r.problems.join('\n'), pattern, key)
  }
  for (const status of [301, 302, 307]) {
    const r = await checkHostsOnce(VIZ, ['vis.bitcru.sh'], appSite({ 'GET https://vis.bitcru.sh/': () => new Response(null, { status, headers: { Location: `${VIZ}/` } }) }), { app: APP })
    assert.match(r.problems.join('\n'), new RegExp(`GET / answered ${status} to .*, not 308`), String(status))
  }
  const kept = await checkHostsOnce(VIZ, ['vis.bitcru.sh'], appSite({ 'GET https://vis.bitcru.sh/': () => new Response(null, { status: 308, headers: { Location: `${VIZ}/`, 'Cache-Control': 'public, max-age=31536000' } }) }), { app: APP })
  assert.match(kept.problems.join('\n'), /the 308 may be kept/)
  // checkHosts passes the app on to every attempt.
  assert.equal((await checkHosts(VIZ, ['vis.bitcru.sh'], 10, appSite({ 'GET https://vis.bitcru.sh/': page }), 1, { app: APP })).ok, false)
  assert.equal((await checkHosts(VIZ, ['vis.bitcru.sh'], 10, appSite(), 1, { app: APP })).ok, true)
})

test('smoke() on production: the host checks ask the alias for the web app\'s documents, and a failure there fails the smoke test while the other checks still run (m-8)', async () => {
  const app = { build: 'b'.repeat(64), document: { sha256: '0'.repeat(64) }, fileHashes: {}, kept: [], serve: { documents: ['/', '/explore'], assetsPrefix: '/assets/', files: [], headers: { document: {}, asset: {}, file: {} }, contentTypes: {} } }
  mkdirSync(join(tmp, 'generated', 'production'), { recursive: true })
  writeFileSync(join(tmp, 'generated', 'production', 'manifest.json'), JSON.stringify({ target: 'production', stage: null, release: 'rel-s', domain: 'viz.bitcru.sh', domainAliases: ['vis.bitcru.sh'], workers: [{ name: 'viz-gateway', canonical: 'viz-gateway', public: true, deploy: true, app }] }))
  const run = async (over, opts = {}) => {
    const real = globalThis.fetch
    const asked = []
    const stub = appSite(over)
    globalThis.fetch = async (url, init = {}) => {
      asked.push(`${init.method ?? 'GET'} ${url}`)
      if (url === `${VIZ}/healthz`) return Response.json({ status: 'healthy', release: 'rel-s', backends: {} })
      if (/^https:\/\/vis\./.test(url) || url === `${VIZ}${META}`) return stub(url, { redirect: 'manual', ...init })
      return new Response('not here', { status: 404 }) // the app's own check on viz: fails, and is not what this test is about
    }
    const saved = process.env.SMOKE_KEY
    delete process.env.SMOKE_KEY
    try {
      const write = console.error
      console.error = () => {}
      try {
        return { r: await smoke({ healthTimeoutMs: 0, appTimeoutMs: 0, expectRelease: 'rel-s', ...opts }), asked }
      } finally {
        console.error = write
      }
    } finally {
      globalThis.fetch = real
      if (saved !== undefined) process.env.SMOKE_KEY = saved
    }
  }
  const good = await run({})
  assert.equal(good.r.hosts.ok, true, JSON.stringify(good.r.hosts))
  for (const path of ['/', '/explore', '/assets/viz-smoke-missing-00000000.js']) assert.ok(good.asked.includes(`GET https://vis.bitcru.sh${path}`), path)
  const bad = await run({ 'GET https://vis.bitcru.sh/explore': () => new Response('<!doctype html>', { status: 200 }) })
  assert.equal(bad.r.hosts.ok, false)
  assert.match(bad.r.hosts.problems.join('\n'), /GET \/explore answered 200, not 308/)
  assert.equal(bad.r.ok, false)
  // The app's own check still ran after the host checks failed (and failed here: the stub serves no app on viz).
  assert.ok(bad.asked.includes(`GET ${VIZ}/explore`))
  assert.notEqual(bad.r.web, 'skipped')
  // A host failure alone fails the smoke test: here the app is not checked (--no-app) and no key is set,
  // so the hosts are the only check that can fail (vis answers OAuth itself).
  const alone = await run({ [`GET https://vis.bitcru.sh${META}`]: () => Response.json({ issuer: 'https://vis.bitcru.sh' }) }, { checkWebApp: false })
  assert.deepEqual([alone.r.hosts.ok, alone.r.web, alone.r.data, alone.r.ok], [false, 'skipped', 'skipped', false])
  // --no-hosts (after a rollback): nothing is asked of the alias.
  const real = globalThis.fetch
  globalThis.fetch = async (url) => (url === `${VIZ}/healthz` ? Response.json({ status: 'healthy', release: 'rel-s', backends: {} }) : new Response('x', { status: 404 }))
  const write = console.error
  console.error = () => {}
  try {
    const r = await smoke({ healthTimeoutMs: 0, appTimeoutMs: 0, hosts: false, checkWebApp: false })
    assert.deepEqual([r.hosts, r.web, r.ok], ['skipped', 'skipped', true])
  } finally {
    console.error = write
    globalThis.fetch = real
  }
})
