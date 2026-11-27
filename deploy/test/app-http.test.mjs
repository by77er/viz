// node --test deploy/test/: the parts of the web app's release path that speak HTTP, against a small
// server on this machine (no workerd, no fake account, the real `fetch`): how a kept file is
// fetched (lib/app.mjs `defaultFetchFile`), and what the smoke test asks and compares
// (smoke.mjs `checkApp`, `smoke`). The review of D74 found these run by no test (m-9), the files'
// bytes not compared (m-7), and a failed app check hiding the data check (m-8).
// test/app-serve.test.mjs runs `checkApp` against the real gateway in local workerd; this file
// holds the rules that need a server which misbehaves in one chosen way.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { after, test } from 'node:test'

// Before the deploy modules load: generated/ is this test's own.
const tmp = mkdtempSync(join(tmpdir(), 'viz-app-http-test-'))
process.env.VIZ_GENERATED_DIR = join(tmp, 'generated')
const A = await import('../lib/app.mjs')
const { GENERATED_DIR } = await import('../lib/common.mjs')
const { APP_FIXTURE, appBuilt } = await import('./fake-account.mjs')
const { checkApp, smoke, writeSmokeRecord } = await import('../smoke.mjs')
after(() => rmSync(tmp, { recursive: true, force: true }))

/** The value a test puts where a credential would be. Never a real one. */
const DUMMY = 'DUMMY-not-a-credential-123'
const H = (c) => c.repeat(64)
const sha = (b) => execFileSync('sha256sum', { input: b, encoding: 'utf8' }).slice(0, 64)

test('a kept file is asked for as a browser would get it: 200 only, no redirect followed (m-9: the real fetch, against a local server)', async () => {
  const chunk = Buffer.from('console.log("old chunk")')
  const server = createServer((req, res) => {
    if (req.url === '/assets/ok.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end(chunk)
    else if (req.url === '/assets/moved.js') res.writeHead(307, { location: '/assets/ok.js' }).end()
    else if (req.url === '/assets/partial.js') res.writeHead(206, { 'content-type': 'text/javascript' }).end(chunk)
    else if (req.url === '/assets/error.js') res.writeHead(500, { 'content-type': 'text/javascript' }).end(chunk)
    else res.writeHead(404, { 'content-type': 'application/json' }).end('{"status":"error"}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    assert.deepEqual(await A.defaultFetchFile(`${origin}/assets/ok.js`), chunk)
    // A redirect is not followed: the file must be at its own path in the version serving now.
    await assert.rejects(A.defaultFetchFile(`${origin}/assets/moved.js`), /fetch failed|redirect/i)
    // Any status but 200 is no file, whatever its body.
    for (const p of ['partial', 'error', 'gone']) await assert.rejects(A.defaultFetchFile(`${origin}/assets/${p}.js`), /^Error: HTTP (206|500|404)$/)
    // Through fetchKept, with no fetch handed in: the same, each with its reason; only the 200 with the recorded bytes is kept.
    const r = await A.fetchKept(['ok', 'moved', 'partial', 'error', 'gone'].map((n) => ({ path: `/assets/${n}.js`, sha256: sha(chunk), age: 1 })), origin)
    assert.deepEqual(r.kept.map((k) => k.path), ['/assets/ok.js'])
    assert.deepEqual(r.dropped.map((d) => [d.path, /HTTP \d+|fetch failed|redirect/i.test(d.why)]), [['/assets/moved.js', true], ['/assets/partial.js', true], ['/assets/error.js', true], ['/assets/gone.js', true]])
  } finally {
    server.close()
  }
})


// ───────────────────────── the smoke test ─────────────────────────

const STAGE = 'httptest'
const OLD = Buffer.from('console.log("a chunk of the build before")\n')
// A release of the fixture build that also keeps one file of an earlier build.
const built = appBuilt({ stage: STAGE, release: 'http-1', kept: [{ path: '/assets/index-OLD00001.js', sha256: sha(OLD), age: 1, since: 20_000, body: OLD }] })
const APP = A.appSummary(built.stamp)
const SERVE = APP.serve
const DOCUMENT = readFileSync(join(APP_FIXTURE, 'index.html'))
const STAGED = join(GENERATED_DIR, `stage-${STAGE}`, 'app')
const NAMED = [...DOCUMENT.toString().matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1])
const LAZY = Object.keys(APP.fileHashes).find((p) => !NAMED.includes(p))

/**
 * A server that answers as app/serve.json says the gateway does (documents from memory, files of
 * the staged directory with their headers, the JSON 404 for everything else, /healthz healthy by
 * this release), except where `change(req, answer)` returns another answer.
 */
function serving(change = (_req, a) => a) {
  const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
  const json404 = () => ({ status: 404, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: Buffer.from('{"status":"error","errorType":"not_found"}') })
  const answer = (req) => {
    const path = req.url.split('?')[0]
    const get = req.method === 'GET' || req.method === 'HEAD'
    if (path === '/healthz') return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ status: 'healthy', release: 'http-1', backends: {} })) }
    if (SERVE.documents.includes(path)) return get ? { status: 200, headers: lower(SERVE.headers.document), body: DOCUMENT } : json404()
    const isFile = Object.hasOwn(APP.fileHashes, path) || APP.kept.some((k) => k.path === path)
    if (!isFile) return json404()
    if (!get) return { status: 405, headers: {}, body: Buffer.alloc(0) }
    return { status: 200, headers: { ...lower(path.startsWith(SERVE.assetsPrefix) ? SERVE.headers.asset : SERVE.headers.file), 'content-type': SERVE.contentTypes[extname(path)] }, body: readFileSync(join(STAGED, path.slice(1))) }
  }
  const asked = []
  const server = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`)
    req.resume()
    req.on('end', () => {
      const a = change(req, answer(req))
      res.writeHead(a.status, a.headers)
      res.end(req.method === 'HEAD' ? undefined : a.body)
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, asked, close: () => server.close() })))
}
const against = async (change, fn) => {
  const s = await serving(change)
  try {
    return await fn(s)
  } finally {
    s.close()
  }
}

test('smoke checkApp: every file of the version is asked for and compared byte for byte with what the release staged (m-7): the lazy chunks and the kept files too', async () => {
  assert.ok(LAZY, 'the fixture has a chunk no document names')
  assert.deepEqual(Object.keys(APP.fileHashes).sort(), built.stamp.build.files.map((f) => f.path).sort())
  assert.deepEqual(APP.kept, [{ path: '/assets/index-OLD00001.js', age: 1, sha256: sha(OLD), since: 20_000 }])
  await against(undefined, async (s) => {
    const good = await checkApp(s.url, APP)
    assert.deepEqual(good.problems, [])
    for (const p of [...Object.keys(APP.fileHashes), '/assets/index-OLD00001.js']) assert.ok(s.asked.includes(`GET ${p}`), `${p} was asked for`)
    assert.ok(good.checked >= SERVE.documents.length + NAMED.length + Object.keys(APP.fileHashes).length + 1 + 5)
  })
  const body = (path, bytes) => (req, a) => (req.url === path && req.method === 'GET' ? { ...a, body: Buffer.from(bytes) } : a)
  const cases = [
    ['a script the document names, rewritten on the way (the same headers, other bytes)', body(NAMED.find((p) => p.endsWith('.js')), 'evil()'), new RegExp(`GET ${NAMED.find((p) => p.endsWith('.js'))}: the body is not the file the release staged`)],
    ['a lazy chunk with other bytes (no document names it)', body(LAZY, 'evil()'), new RegExp(`GET ${LAZY}: the body is not the file the release staged`)],
    ['a lazy chunk the version does not hold', (req, a) => (req.url === LAZY ? { status: 404, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: Buffer.from('{}') } : a), new RegExp(`GET ${LAZY}: 404; it is a file of this version`)],
    ['a lazy chunk without its caching', (req, a) => (req.url === LAZY && a.status === 200 ? { ...a, headers: { ...a.headers, 'cache-control': 'public, max-age=0, must-revalidate' } } : a), new RegExp(`GET ${LAZY}: Cache-Control is "public, max-age=0, must-revalidate"`)],
    ['a kept file with other bytes', body('/assets/index-OLD00001.js', 'not the old chunk'), /GET \/assets\/index-OLD00001\.js: the body is not the file the release staged/],
    ['a kept file that was not uploaded', (req, a) => (req.url === '/assets/index-OLD00001.js' ? { status: 404, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: Buffer.from('{}') } : a), /GET \/assets\/index-OLD00001\.js: 404; it is a file of this version/],
  ]
  for (const [what, change, expected] of cases) {
    await against(change, async (s) => {
      const r = await checkApp(s.url, APP)
      assert.equal(r.ok, false, `${what}: not noticed`)
      assert.match(r.problems.join('\n'), expected, what)
    })
  }
  // A manifest from before the hashes were recorded cannot pass as "compared".
  await against(undefined, async (s) => {
    const { fileHashes: _f, ...older } = APP
    assert.match((await checkApp(s.url, older)).problems.join('\n'), /the manifest names no file hashes for the web app/)
  })
})

test('smoke checkApp: redirects are not followed, a document path with a trailing slash is asked for, and a POST to a document is tried (m-9)', async () => {
  const asset = NAMED.find((p) => p.startsWith(SERVE.assetsPrefix))
  const other = SERVE.documents.find((d) => d !== '/')
  const document = { status: 200, headers: Object.fromEntries(Object.entries(SERVE.headers.document).map(([k, v]) => [k.toLowerCase(), v])), body: DOCUMENT }
  const cases = [
    // The file is there, but only behind a redirect: a client that followed it would see nothing wrong.
    ['an asset answered with a redirect to itself under another path', (req, a) => (req.url === asset && req.method === 'GET' ? { status: 307, headers: { location: `${asset}?moved=1` }, body: Buffer.alloc(0) } : a), new RegExp(`GET ${asset.replace(/[.]/g, '\\.')}: 307`)],
    ['a document answered with a redirect to itself', (req, a) => (req.url === '/' && req.method === 'GET' ? { status: 302, headers: { location: `${other}` }, body: Buffer.alloc(0) } : a), /GET \/: 302, not the document/],
    ['a missing asset redirected to a page', (req, a) => (a.status === 404 && req.url.startsWith(SERVE.assetsPrefix) ? { status: 302, headers: { location: '/' }, body: Buffer.alloc(0) } : a), /a hashed asset this version does not hold\): 302/],
    ['a document path with a trailing slash served the document', (req, a) => (req.url === `${other}/` ? document : a), /\(a document path with a trailing slash\): 200 text\/html/],
    ['POST to a document served the document', (req, a) => (req.method === 'POST' && SERVE.documents.includes(req.url) ? document : a), /POST \/: 200; only GET and HEAD are the app's/],
  ]
  for (const [what, change, expected] of cases) {
    await against(change, async (s) => {
      const r = await checkApp(s.url, APP)
      assert.equal(r.ok, false, `${what}: not noticed`)
      assert.match(r.problems.join('\n'), expected, what)
      if (what.startsWith('a document path')) assert.ok(s.asked.includes(`GET ${other}/`))
      if (what.startsWith('POST')) assert.ok(s.asked.includes(`POST ${SERVE.documents[0]}`))
    })
  }
})

test('smoke: a failed app check does not hide the data check; both are run and reported, and the hint says what a gateway-only rollback costs (m-8)', async () => {
  const dir = join(GENERATED_DIR, `stage-${STAGE}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ target: `stage-${STAGE}`, stage: STAGE, release: 'http-1', order: [`viz-${STAGE}-gateway`], workers: [{ name: `viz-${STAGE}-gateway`, canonical: 'viz-gateway', public: true, deploy: true, app: APP }] }))
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
  const brokenPage = (req, a) => (SERVE.documents.includes(req.url) && a.status === 200 ? { ...a, headers: Object.fromEntries(Object.entries(a.headers).filter(([k]) => k !== 'content-security-policy')) } : a)
  const run = (s, write) => quiet(() => smoke({ stage: STAGE, url: s.url, expectRelease: 'http-1', healthTimeoutMs: 10_000, appTimeoutMs: 0, ...(write ? { write } : {}) }))
  const savedKey = process.env.SMOKE_KEY
  try {
    process.env.SMOKE_KEY = DUMMY
    const calls = []
    const passes = async (base, key) => (calls.push([base, key === DUMMY]), { ok: true, writeStatus: 204, writeMs: 12, visibleAfterMs: 900, samples: 9 })
    const fails = async (base, key) => (calls.push([base, key === DUMMY]), { ok: false, step: 'read', writeStatus: 204, queryStatus: 503, detail: 'unavailable' })
    // The page is broken, the data path works: the operator learns both.
    await against(brokenPage, async (s) => {
      const out = await run(s, passes)
      assert.deepEqual([out.r.ok, out.r.web.ok, out.r.data.ok], [false, false, true])
      assert.deepEqual(calls, [[s.url, true]], 'the data check ran although the app check failed')
      assert.match(out.log, /smoke: FAILED at the web app .*\n {2}- GET \/: Content-Security-Policy is null/)
      assert.match(out.log, /smoke: Remote Write 204 in 12 ms; all 9 samples returned/)
      assert.match(out.log, /smoke: the web app FAILED; the data path PASSED \(writes and reads work\)\./)
      // What the suggested way back costs, said where it is suggested.
      assert.match(out.log, /viz-gateway alone can go back: release\.mjs rollback --record <previous\.json> --only viz-gateway/)
      assert.match(out.log, /What that costs: the gateway of the previous release comes back WHOLE.*Every route the gateway gained since that version answers 404 again.*no web app at all, and routes such as \/api\/echo.*"Rolling viz-gateway back alone"/)
      assert.doesNotMatch(out.log, new RegExp(DUMMY), 'the key is never printed')
    })
    // Both broken: both said.
    await against(brokenPage, async (s) => {
      const out = await run(s, fails)
      assert.deepEqual([out.r.ok, out.r.web.ok, out.r.data.ok], [false, false, false])
      assert.match(out.log, /smoke: FAILED at read: write 204, query 503: unavailable/)
      assert.match(out.log, /the web app FAILED; the data path FAILED too/)
    })
    // The page is fine, the data path is not: a failure, and no advice about the gateway.
    await against(undefined, async (s) => {
      const out = await run(s, fails)
      assert.deepEqual([out.r.ok, out.r.web.ok, out.r.data.ok], [false, true, false])
      assert.doesNotMatch(out.log, /viz-gateway alone can go back/)
    })
    await against(undefined, async (s) => {
      const out = await run(s, passes)
      assert.deepEqual([out.r.ok, out.r.web.ok, out.r.data.ok], [true, true, true])
      // What it found is kept for the record of a stage (no key, no body).
      const { file, record } = writeSmokeRecord(STAGE, out.r, { release: 'http-1', base: s.url, at: '2026-11-28T09:05:00.000Z' })
      assert.deepEqual([record.ok, record.release, record.web.ok, record.web.checked, record.data, record.target], [true, 'http-1', true, out.r.web.checked, { ok: true, samples: 9 }, `stage-${STAGE}`])
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), record)
      assert.doesNotMatch(readFileSync(file, 'utf8'), new RegExp(DUMMY))
    })
    // No key: the data check is skipped and said to be; a broken page still fails.
    delete process.env.SMOKE_KEY
    await against(brokenPage, async (s) => {
      const out = await run(s)
      assert.deepEqual([out.r.ok, out.r.data], [false, 'skipped'])
      assert.match(out.log, /the web app FAILED; the data path was not checked \(no SMOKE_KEY\)/)
      assert.equal(writeSmokeRecord(STAGE, out.r, { release: 'http-1' }).record.ok, false)
    })
  } finally {
    if (savedKey === undefined) delete process.env.SMOKE_KEY
    else process.env.SMOKE_KEY = savedKey
  }
})
