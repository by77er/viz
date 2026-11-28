// node --test deploy/test/: the web app as viz-gateway serves it (design/DECISIONS.md D74), end to end
// in local workerd. The real gateway source is run by the pinned wrangler (`wrangler dev --local`: no
// account, no network) with exactly what deploy/lib/app.mjs generates for a release: the staged
// directory with its `_headers` as static assets, the `assets` block, and the VIZ_APP var. The
// specification is app/serve.json, read here, now. Requests are sent raw (node:http), so a path with
// dot segments or encoded separators reaches the server as written.
//
// This is Cloudflare's part of the serving (the files, by exact path, without the Worker) as far as a
// local run can show it: miniflare runs the asset router and asset worker that ship with the pinned
// wrangler. What a deployment does is checked by deploy/smoke.mjs `checkApp`, which is run here too,
// against this server and against servers that break one rule each.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { after, before, test } from 'node:test'

// Before the deploy modules load: generated/ is this test's own.
const tmp = mkdtempSync(join(tmpdir(), 'viz-app-serve-'))
process.env.VIZ_GENERATED_DIR = join(tmp, 'generated')
const { APP_VAR, appSummary, assetsConfig, readServe } = await import('../lib/app.mjs')
const { DEPLOY_DIR, REPO_ROOT } = await import('../lib/common.mjs')
const { WRANGLER } = await import('../lib/wrangler.mjs')
const { APP_FIXTURE, appBuilt } = await import('./fake-account.mjs')
const { GENERATED_DIR } = await import('../lib/common.mjs')
const { checkApp, manifestApp, smoke } = await import('../smoke.mjs')

const SERVE = readServe(join(REPO_ROOT, 'app', 'serve.json'))
const PORT = Number(process.env.VIZ_APP_SERVE_PORT || 18960)
const built = appBuilt({ stage: 'servetest', release: 'serve-1' })
const staged = join(REPO_ROOT, built.stamp.staged.dir)
const DOCUMENT = readFileSync(join(APP_FIXTURE, 'index.html'), 'utf8')
const FILES = built.stamp.build.files

let child
let log = ''

const raw = (path, { method = 'GET', headers = {}, port = PORT } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end(method === 'POST' || method === 'PUT' ? 'x' : undefined)
  })

before(async () => {
  // The gateway itself, with no backend bound: an API path then answers the gateway's own 502
  // ("did not answer"), which is enough to see that the API's router got the request. Hosts as in
  // production (D75): viz canonical, vis an alias; a request to 127.0.0.1 is neither, so served as
  // canonical, and one that names `Host: vis.bitcru.sh` is the alias.
  const config = join(tmp, 'wrangler.jsonc')
  writeFileSync(config, JSON.stringify({ name: 'viz-app-serve-test', main: join(DEPLOY_DIR, 'gateway', 'src', 'index.ts'), compatibility_date: '2026-10-01', assets: assetsConfig(staged), vars: { VIZ_RELEASE: 'serve-1', [APP_VAR]: built.stamp.vars[APP_VAR], PUBLIC_URL: 'https://viz.bitcru.sh', VIZ_HOST_ALIASES: JSON.stringify([{ host: 'vis.bitcru.sh', deprecated: 1795824000 }]) } }))
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true', FORCE_COLOR: '0', HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'config') }
  // A local run needs no account, and gets none.
  for (const k of Object.keys(env)) if (/^CLOUDFLARE_|^CF_API/.test(k)) delete env[k]
  child = spawn(WRANGLER, ['dev', '--local', '--config', config, '--port', String(PORT), '--ip', '127.0.0.1', '--inspector-port', '0', '--show-interactive-dev-session=false'], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (c) => (log += c))
  child.stderr.on('data', (c) => (log += c))
  const deadline = Date.now() + 90_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited ${child.exitCode}:\n${log}`)
    try {
      await raw('/healthz/not')
      return
    } catch {
      if (Date.now() > deadline) throw new Error(`wrangler dev did not listen on ${PORT} within 90 s:\n${log}`)
      await new Promise((r) => setTimeout(r, 300))
    }
  }
})
after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise((r) => {
      child.on('exit', r)
      setTimeout(() => (child.kill('SIGKILL'), r()), 5000)
    })
  }
  rmSync(tmp, { recursive: true, force: true })
})

const isJson404 = (r) => r.status === 404 && r.headers['content-type'] === 'application/json; charset=utf-8' && r.headers['cache-control'] === 'no-store' && r.headers['x-viz-route'] === 'gateway' && JSON.parse(r.body.toString()).errorType === 'not_found'
const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))

test('the staged directory holds the build\'s files and _headers, and never index.html', () => {
  const names = (dir, rel = '') => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? names(dir, `${rel}${e.name}/`) : [`/${rel}${e.name}`]))
  assert.deepEqual(names(staged).sort(), ['/_headers', ...FILES.map((f) => f.path)].sort())
})

test('every hashed asset: 200 without the Worker, kept for good, typed by app/serve.json, not sniffed; HEAD has no body', async () => {
  const assets = FILES.filter((f) => f.path.startsWith(SERVE.assetsPrefix))
  assert.ok(assets.length >= 4)
  for (const f of assets) {
    const r = await raw(f.path, { headers: { 'Accept-Encoding': 'identity' } })
    assert.equal(r.status, 200, f.path)
    assert.equal(r.headers['x-viz-route'], undefined, `${f.path}: served by the asset layer, not by the Worker`)
    for (const [name, value] of Object.entries(lower(SERVE.headers.asset))) assert.equal(r.headers[name], value, `${f.path} ${name}`)
    assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable')
    assert.equal(r.headers['content-type'], SERVE.contentTypes[extname(f.path)], f.path)
    assert.equal(r.headers['content-security-policy'], undefined)
    assert.deepEqual(r.body, readFileSync(join(APP_FIXTURE, f.path.slice(1))), f.path)
    const head = await raw(f.path, { method: 'HEAD' })
    assert.deepEqual([head.status, head.body.length, head.headers['cache-control']], [200, 0, r.headers['cache-control']], f.path)
  }
})

test('every listed file (the icon): 200, its own cache lifetime and type', async () => {
  for (const path of SERVE.files) {
    const r = await raw(path)
    assert.equal(r.status, 200, path)
    for (const [name, value] of Object.entries(lower(SERVE.headers.file))) assert.equal(r.headers[name], value, `${path} ${name}`)
    assert.equal(r.headers['content-type'], SERVE.contentTypes[extname(path)])
    assert.doesNotMatch(r.headers['cache-control'], /immutable/)
  }
})

test('every document: 200 from the Worker with the document\'s headers; never an asset\'s caching', async () => {
  for (const path of SERVE.documents) {
    const r = await raw(path, { headers: { 'Accept-Encoding': 'identity' } })
    assert.equal(r.status, 200, path)
    assert.equal(r.headers['x-viz-route'], 'app')
    for (const [name, value] of Object.entries(lower(SERVE.headers.document))) assert.equal(r.headers[name], value, `${path} ${name}`)
    assert.equal(r.body.toString(), DOCUMENT)
    assert.doesNotMatch(r.headers['cache-control'], /immutable|max-age/)
    const head = await raw(path, { method: 'HEAD' })
    assert.deepEqual([head.status, head.body.length], [200, 0])
  }
})

test('D75 with D74, on the alias host (Host: vis.bitcru.sh): a file the version holds is answered by the asset layer before the Worker runs, as on viz; a document and a missing asset reach the Worker and are a 308 to viz', async () => {
  const vis = { Host: 'vis.bitcru.sh' }
  // Cloudflare's part runs first and knows no host: run_worker_first takes path patterns only. So the
  // build's files are served on the alias too (accepted: deploy/README.md, "The app on vis.bitcru.sh").
  for (const f of FILES) {
    const r = await raw(f.path, { headers: { ...vis, 'Accept-Encoding': 'identity' } })
    assert.equal(r.status, 200, f.path)
    assert.equal(r.headers['x-viz-route'], undefined, `${f.path}: the asset layer, not the Worker`)
    assert.deepEqual(r.body, readFileSync(join(APP_FIXTURE, f.path.slice(1))), f.path)
  }
  // The Worker's part: every document, a hashed asset this version does not hold, /index.html, a
  // document with a trailing slash. D75's redirect, never the page, never kept.
  for (const path of [...SERVE.documents, `${SERVE.assetsPrefix}index-00000000.js`, '/index.html', `${SERVE.documents.find((d) => d !== '/') ?? '/explore'}/`]) {
    for (const method of ['GET', 'HEAD', 'POST']) {
      const r = await raw(`${path}?q=up`, { method, headers: { ...vis, Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' } })
      assert.equal(r.status, 308, `${method} ${path}`)
      assert.equal(r.headers.location, `https://viz.bitcru.sh${path}?q=up`, `${method} ${path}`)
      assert.equal(r.headers['cache-control'], 'no-store', `${method} ${path}`)
      assert.equal(r.headers['x-viz-route'], 'redirect', `${method} ${path}`)
      assert.equal(r.headers['content-security-policy'], undefined)
      assert.doesNotMatch(r.body.toString(), /<!doctype/i)
    }
  }
  // The canonical host itself serves the document.
  const viz = await raw('/', { headers: { Host: 'viz.bitcru.sh' } })
  assert.deepEqual([viz.status, viz.headers['x-viz-route'], viz.body.toString()], [200, 'app', DOCUMENT])
})

test('a hashed asset this version does not hold reaches the Worker: the JSON 404, never stored, never the asset headers, never the document', async () => {
  for (const path of [`${SERVE.assetsPrefix}index-00000000.js`, `${SERVE.assetsPrefix}Editor-OLDBUILD.js`, `${SERVE.assetsPrefix}`, SERVE.assetsPrefix.slice(0, -1), `${SERVE.assetsPrefix}x/y.css`]) {
    for (const method of ['GET', 'POST']) {
      const r = await raw(path, { method, headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' } })
      assert.ok(isJson404(r), `${method} ${path}: ${r.status} ${JSON.stringify(r.headers)}`)
    }
  }
})

test('only GET and HEAD are served: any other method on a file is refused without a body, on a document it is the JSON 404', async () => {
  const asset = FILES.find((f) => f.path.endsWith('.js')).path
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
    for (const path of [asset, ...SERVE.files]) {
      const r = await raw(path, { method })
      // Cloudflare's asset layer answers 405 for a path that is a file; the bytes are never sent.
      assert.equal(r.status, 405, `${method} ${path}`)
      assert.equal(r.body.length, 0, `${method} ${path}`)
    }
    for (const path of SERVE.documents) assert.ok(isJson404(await raw(path, { method })), `${method} ${path}`)
  }
})

test('no path reaches anything but the build\'s files: traversal, encoded separators, index.html, _headers, sources', async () => {
  const P = SERVE.assetsPrefix
  const asset = FILES.find((f) => f.path.endsWith('.js')).path
  const name = asset.slice(P.length)
  const mustBe404 = [
    '/index.html', '/index', '/_headers', `${P}_headers`, `${P}../_headers`, `${P}../index.html`, `${P}%2e%2e/index.html`, `${P}%2E%2E/index.html`, `${P}..%2findex.html`, `${P}..%2Findex.html`, `${P}%2e%2e%2findex.html`,
    `${P}..%5cindex.html`, `${P}..\\index.html`, `${P}x/../../index.html`, `${P}./../index.html`, `${P}..;/index.html`, `${P}%252e%252e/index.html`, `${P}..%00/index.html`, `${P}${name}/`, `${P}${name}%00`, `${P}${name}%20`, `${P}${name}.map`,
    `${P.toUpperCase()}${name}`, `${P}${name.toUpperCase()}`, '/explore/', '/explore.html', '/.env', '/src/main.tsx', '/package.json', '/serve.json', '/app.json', '/node_modules/x.js', '/wrangler.jsonc', '/%2e%2e/%2e%2e/etc/passwd', '/../../etc/passwd', '/..%2f..%2fetc%2fpasswd',
  ]
  for (const path of mustBe404) {
    const r = await raw(path)
    assert.ok(isJson404(r), `GET ${path}: ${r.status} ${r.headers['content-type']} ${r.headers['cache-control']} ${r.body.toString().slice(0, 80)}`)
  }
  // Paths that name a file of the build another way: the file itself, or a redirect to its one
  // address; never a page, never anything else.
  const known = new Map(FILES.map((f) => [f.path, readFileSync(join(APP_FIXTURE, f.path.slice(1)))]))
  for (const path of [`${P}../${P.slice(1)}${name}`, `${P}%2e%2e${asset}`, `${P}/${name}`, `/${P}${name}`, `${P}${name.replace('.', '%2e')}`, `${P}./${name}`, `${P}${name}?x=../../index.html`, `${P.slice(0, -1)}\\${name}`, `${P}%2e%2e${SERVE.files[0] ?? asset}`]) {
    const r = await raw(path, { headers: { 'Accept-Encoding': 'identity' } })
    if (r.status === 200) assert.ok([...known.values()].some((b) => b.equals(r.body)), `GET ${path}: 200 with bytes that are no file of the build`)
    else if (r.status === 307) assert.ok(known.has(new URL(r.headers.location, 'http://x').pathname), `GET ${path}: redirected to ${r.headers.location}`)
    else assert.ok(isJson404(r), `GET ${path}: ${r.status}`)
    assert.doesNotMatch(r.headers['content-type'] ?? '', /text\/html/, path)
    assert.doesNotMatch(r.body.toString(), /<!doctype/i, path)
  }
})

test('the API comes first: its paths reach the Worker\'s router, an unknown one is the JSON 404, a browser\'s navigation gets no page', async () => {
  const nav = { Accept: 'text/html,application/xhtml+xml', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }
  for (const path of ['/api/v1/nope', '/api', '/api/', '/api/v1/', '/oauth/x', '/mcp/x', '/v1/x']) assert.ok(isJson404(await raw(path, { headers: nav })), path)
  // No backend is bound in this run: the gateway's own "did not answer" says the API route was taken.
  for (const [path, route] of [['/api/v1/query?query=up', 'query'], ['/api/v1/labels', 'query'], ['/api/v1/control/keys', 'control'], ['/mcp', 'mcp']]) {
    const r = await raw(path, { headers: nav })
    assert.deepEqual([r.status, r.headers['x-viz-route'], r.headers['content-type']], [502, route, 'application/json; charset=utf-8'], path)
    assert.doesNotMatch(r.body.toString(), /<!doctype/i)
  }
  const health = await raw('/healthz')
  assert.equal(health.headers['x-viz-route'], 'health')
})

/** A proxy in front of the server that changes answers: `change(req, answer)` returns the answer to give. */
const proxy = (change) =>
    new Promise((resolve) => {
      const server = http.createServer(async (req, res) => {
        const r = await raw(req.url, { method: req.method, headers: { ...req.headers, host: `127.0.0.1:${PORT}`, 'accept-encoding': 'identity' } })
        const out = change(req, { status: r.status, headers: { ...r.headers }, body: r.body }) ?? r
        delete out.headers['content-length']
        delete out.headers['transfer-encoding']
        delete out.headers['content-encoding']
        res.writeHead(out.status, out.headers)
        res.end(req.method === 'HEAD' ? undefined : out.body)
      })
      server.listen(0, '127.0.0.1', () => resolve(server))
    })

test('smoke.mjs checkApp passes against this server, and fails against one that breaks a rule', async () => {
  const app = appSummary(built.stamp)
  const good = await checkApp(`http://127.0.0.1:${PORT}`, app)
  assert.deepEqual(good.problems, [])
  assert.ok(good.checked >= SERVE.documents.length + FILES.length)

  // Behind a proxy that breaks one rule: each must be reported.
  const broken = proxy
  const doc = Buffer.from(DOCUMENT)
  const cases = [
    ['the document without its policy', (req, r) => (SERVE.documents.includes(req.url) && delete r.headers['content-security-policy'], r), /Content-Security-Policy is null/],
    ['the document kept for good', (req, r) => (SERVE.documents.includes(req.url) && (r.headers['cache-control'] = SERVE.headers.asset['Cache-Control']), r), /Cache-Control is "public, max-age=31536000, immutable"/],
    ['an asset revalidated on every load', (req, r) => (req.url.startsWith(SERVE.assetsPrefix) && r.status === 200 && (r.headers['cache-control'] = 'public, max-age=0, must-revalidate'), r), /Cache-Control is "public, max-age=0, must-revalidate"/],
    ['an asset with the uploader\'s content type', (req, r) => (req.url.endsWith('.js') && r.status === 200 && (r.headers['content-type'] = 'application/javascript'), r), /Content-Type is "application\/javascript"/],
    ['a missing asset answered with the document (a single-page fallback)', (req, r) => (r.status === 404 && req.method === 'GET' ? { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: doc } : r), /a hashed asset this version does not hold.*200 text\/html/],
    ['a missing asset\'s 404 kept for good', (req, r) => (r.status === 404 && req.url.startsWith(SERVE.assetsPrefix) && (r.headers['cache-control'] = SERVE.headers.asset['Cache-Control']), r), /a hashed asset this version does not hold.*immutable/],
    ['an unknown API path answered with the document', (req, r) => (req.url.startsWith('/api/') ? { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: doc } : r), /an unknown API path/],
    ['another build\'s document', (req, r) => (SERVE.documents.includes(req.url) && r.status === 200 && (r.body = Buffer.from(DOCUMENT.replace('<title>viz</title>', '<title>viz </title>'))), r), /not the document of build/],
    ['POST served', (req, r) => (req.method === 'POST' ? { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('ok') } : r), /only GET and HEAD/],
    ['POST served for the files only', (req, r) => (req.method === 'POST' && req.url.startsWith(SERVE.assetsPrefix) ? { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: Buffer.from('ok') } : r), /POST \/assets\/\S+: 200; only GET and HEAD are served/],
    ['a 404 that is a page (a not-found page instead of the JSON)', (req, r) => (r.status === 404 && req.method === 'GET' ? { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: Buffer.from('<!doctype html><title>not found</title>') } : r), /a hashed asset this version does not hold.*404 text\/html/],
    ['an unknown API path answered 200 with JSON', (req, r) => (req.url.startsWith('/api/') ? { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: Buffer.from('{"status":"success"}') } : r), /an unknown API path\): 200 application\/json/],
    ['index.html served', (req, r) => (req.url === '/index.html' ? { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }, body: doc } : r), /index.html itself/],
  ]
  for (const [what, change, expected] of cases) {
    const server = await broken(change)
    try {
      const r = await checkApp(`http://127.0.0.1:${server.address().port}`, app)
      assert.equal(r.ok, false, `${what}: not noticed`)
      assert.match(r.problems.join('\n'), expected, what)
    } finally {
      server.close()
    }
  }
})

test('smoke.mjs: a release that serves the web app is checked for it after /healthz; a broken app fails the smoke test; --no-app and a manifest without a build skip it', async () => {
  // The manifest of the release, as configure.mjs writes it for a gateway with the app.
  const dir = join(GENERATED_DIR, 'stage-servetest')
  mkdirSync(dir, { recursive: true })
  const manifest = (app) => writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ target: 'stage-servetest', stage: 'servetest', release: 'serve-1', order: ['viz-servetest-gateway'], workers: [{ name: 'viz-servetest-gateway', canonical: 'viz-gateway', public: true, deploy: true, app }] }))
  const summary = appSummary(built.stamp)
  manifest(summary)
  assert.equal(manifestApp(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))).app.build, built.stamp.build.hash)
  // No backend is bound here, so /healthz is answered for them: healthy, by this release.
  const healthy = (req, r) => (req.url === '/healthz' ? { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ status: 'healthy', release: 'serve-1', backends: {} })) } : r)
  const quiet = async (fn) => {
    const saved = console.error
    const lines = []
    console.error = (...a) => lines.push(a.join(' '))
    try {
      return { r: await fn(), log: lines.join('\n') }
    } finally {
      console.error = saved
    }
  }
  const savedKey = process.env.SMOKE_KEY
  delete process.env.SMOKE_KEY
  const good = await proxy(healthy)
  const bad = await proxy((req, r) => {
    const out = healthy(req, r)
    if (SERVE.documents.includes(req.url)) delete out.headers['content-security-policy']
    return out
  })
  try {
    const url = (s) => `http://127.0.0.1:${s.address().port}`
    const ok = await quiet(() => smoke({ stage: 'servetest', url: url(good), expectRelease: 'serve-1', healthTimeoutMs: 10_000, appTimeoutMs: 0 }))
    assert.equal(ok.r.ok, true, ok.log)
    assert.equal(ok.r.web.ok, true)
    assert.match(ok.log, /the web app \(build [0-9a-f]{12}\) is served as app\/serve\.json says/)
    const failed = await quiet(() => smoke({ stage: 'servetest', url: url(bad), expectRelease: 'serve-1', healthTimeoutMs: 10_000, appTimeoutMs: 0 }))
    assert.equal(failed.r.ok, false, failed.log)
    assert.match(failed.log, /FAILED at the web app .*\n {2}- GET \/: Content-Security-Policy is null/)
    assert.match(failed.log, /viz-gateway alone can go back: release\.mjs rollback --record <previous\.json> --only viz-gateway/)
    assert.match(failed.log, /the web app FAILED; the data path was not checked \(no SMOKE_KEY\)/)
    // After a rollback (--no-app), and for a manifest without a build, the app is not asked.
    const skipped = await quiet(() => smoke({ stage: 'servetest', url: url(bad), expectRelease: 'serve-1', healthTimeoutMs: 10_000, appTimeoutMs: 0, checkWebApp: false }))
    assert.deepEqual([skipped.r.ok, skipped.r.web], [true, 'skipped'])
    for (const [app, why] of [[{ withoutApp: true }, /was configured --without-app/], [{ notBuilt: true, why: 'x' }, /holds no app build \(x\)/], [undefined, /no Worker of this manifest serves the web app/]]) {
      manifest(app)
      const none = await quiet(() => smoke({ stage: 'servetest', url: url(bad), expectRelease: 'serve-1', healthTimeoutMs: 10_000, appTimeoutMs: 0 }))
      assert.equal(none.r.ok, true)
      assert.match(none.log, why)
    }
  } finally {
    good.close()
    bad.close()
    if (savedKey !== undefined) process.env.SMOKE_KEY = savedKey
  }
})
