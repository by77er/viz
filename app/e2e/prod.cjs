/* eslint-disable */
// The build as the gateway is to serve it (serve.json; README.md, "Needed changes in deploy/"):
// a static server over dist/ that follows serve.json exactly (which paths are documents, which
// are hashed assets, which headers each carries, a JSON 404 for everything else) with the API
// on the same origin (/api/ handed to a mock that requires a key, as viz does). The app is
// then driven in a browser under that content security policy, and every violation counted.
//
//   node e2e/prod.cjs      needs `npm run build`
//
// "Teeth": the same flow is run once more under the policy without its one allowance (inline
// styles) and must then report violations; a policy check that cannot fail proves nothing.
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const zlib = require('node:zlib')
const lib = require('./lib.cjs')
const { chromium, T0, T1, Q_RATE, Q_MANY, makeChecker } = lib
const { check, failed, results } = makeChecker()

const DIST = path.join(lib.ROOT, 'dist')
const SERVE = JSON.parse(fs.readFileSync(path.join(lib.ROOT, 'serve.json'), 'utf8'))
const PORT = Number(process.env.VIZ_PROD_PORT || 18940)
const KEY = 'viz_e2eReadKey0000000_goodSecret'

/** The gateway's part, as serve.json states it. `csp` overrides the policy (the negative control). */
function serve(port, apiPort, csp) {
  const notFound = (res) => { const body = JSON.stringify({ status: 'error', errorType: 'not_found', error: 'not found' }); res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body) }
  const send = (req, res, file, headers) => {
    let body
    try { body = fs.readFileSync(file) } catch { return notFound(res) }
    const type = SERVE.contentTypes[path.extname(file)] ?? headers['Content-Type']
    const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) && !/\.woff2$/.test(file)
    const out = gzip ? zlib.gzipSync(body) : body
    res.writeHead(200, { ...headers, ...(type ? { 'Content-Type': type } : {}), ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}), 'Content-Length': out.length })
    res.end(req.method === 'HEAD' ? undefined : out)
  }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    // The API comes first, as in the gateway: its paths are never the app's.
    if (u.pathname.startsWith('/api/')) {
      const proxied = http.request({ host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${apiPort}` } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
      proxied.on('error', () => { res.writeHead(502); res.end() })
      return void req.pipe(proxied)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res)
    if (SERVE.documents.includes(u.pathname)) return send(req, res, path.join(DIST, 'index.html'), { ...SERVE.headers.document, ...(csp ? { 'Content-Security-Policy': csp } : {}) })
    if (u.pathname.startsWith(SERVE.assetsPrefix) && !u.pathname.includes('..')) return send(req, res, path.join(DIST, u.pathname), SERVE.headers.asset)
    if (SERVE.files.includes(u.pathname)) return send(req, res, path.join(DIST, u.pathname), SERVE.headers.file)
    notFound(res)
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(() => server.close())))
}

const get = (url, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })) })
  req.on('error', reject)
  req.end()
})

/** Sign in, run two queries, use the editor, every form of the result and the palette; returns the policy violations seen. */
async function drive(browser, origin) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const violations = []
  await ctx.exposeFunction('__cspReport', (v) => violations.push(v))
  await ctx.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => window.__cspReport(`${e.effectiveDirective} ${e.blockedURI || 'inline'} at ${(e.sourceFile || '').split('/').pop()}:${e.lineNumber}`)))
  const page = await ctx.newPage()
  const errors = []
  const requests = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error' && !/401|Failed to load resource|Content Security Policy/.test(m.text())) errors.push(m.text().slice(0, 200)) }) // policy violations are counted by their own event
  page.on('request', (r) => requests.push(r.url()))
  await page.goto(`${origin}/explore?q=${encodeURIComponent(Q_RATE)}&from=${T0}&to=${T1}`)
  await page.waitForSelector('[data-testid=sign-in]')
  await page.fill('[data-testid=sign-in-key]', KEY)
  await page.click('[data-testid=sign-in-submit]')
  await page.waitForSelector('[data-testid=chart] tbody tr[data-key]')
  const out = { signedIn: true }
  out.columns = await page.evaluate(() => [...document.querySelectorAll('[data-testid=chart] colgroup col')].map((c) => c.getBoundingClientRect().width || parseFloat(c.style.width) || 0))
  out.rows = await page.locator('[data-testid=chart] tbody tr[data-key]').count()
  // The editor (a chunk of its own, with its own styles): type, complete, run.
  await page.click('.query-well .cm-content')
  await page.keyboard.press('Control+A')
  await page.keyboard.type('sum by (service, route, status) (rate(http_req', { delay: 10 })
  await page.waitForSelector('.cm-tooltip-autocomplete', { timeout: 5000 }).then(() => (out.autocomplete = true), () => (out.autocomplete = false))
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(Q_MANY)
  await page.keyboard.press('Control+Enter')
  await page.waitForSelector('[data-testid=chart] tr[data-key=other]')
  out.editorFont = await page.evaluate(() => getComputedStyle(document.querySelector('.cm-content')).fontFamily)
  out.caret = await page.evaluate(() => getComputedStyle(document.querySelector('.cm-content')).caretColor)
  await page.locator('svg.vz-plot').hover({ position: { x: 600, y: 100 } })
  out.readout = await page.evaluate(() => document.querySelector('.vz-readout').textContent.length > 0)
  for (const v of ['table', 'text', 'json', 'chart']) await page.click(`[data-testid=view-${v}]`)
  await page.keyboard.press('Control+k')
  await page.waitForSelector('dialog.palette[open]')
  await page.keyboard.press('Escape')
  await page.goto(`${origin}/settings`)
  await page.waitForSelector('[data-testid=sign-out]')
  await page.click('[data-testid=theme-dark]')
  await page.goto(`${origin}/help`)
  await page.waitForSelector('h1')
  out.fonts = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')) })
  out.violations = violations
  out.errors = errors
  out.foreign = requests.filter((u) => !u.startsWith(origin))
  out.keyInUrl = requests.filter((u) => u.includes('goodSecret'))
  await ctx.close()
  return out
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('dist/ missing: run `npm run build` first')
  const stopMock = await lib.startMock(PORT + 2, ['--require-token', KEY])
  const stop = await serve(PORT, PORT + 2)
  const strict = SERVE.headers.document['Content-Security-Policy'].replace("style-src 'self' 'unsafe-inline'", "style-src 'self'")
  if (strict === SERVE.headers.document['Content-Security-Policy']) throw new Error('the negative control is the policy itself')
  const stopStrict = await serve(PORT + 1, PORT + 2, strict)
  const origin = `http://127.0.0.1:${PORT}`
  const browser = await chromium.launch()
  try {
    // ---- the build: what index.html asks for, and how much
    const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    const files = fs.readdirSync(path.join(DIST, 'assets'))
    check('the build is index.html, hashed files under assets/ and the icon; index.html asks for nothing else and nothing from another origin', refs.every((r) => (r.startsWith('/assets/') && files.includes(r.slice(8))) || r === '/favicon.svg') && fs.readdirSync(DIST).sort().join() === 'assets,favicon.svg,index.html', refs.join(' '))
    check('every file under assets/ has a content hash in its name', files.every((f) => /-[A-Za-z0-9_-]{8}\.(js|css|woff2)$/.test(f)), files.join(' '))
    check('index.html has no inline script and no inline style', !/<script(?![^>]*\bsrc=)[^>]*>/.test(html) && !/<style|style="/.test(html))
    const gz = (f) => zlib.gzipSync(fs.readFileSync(path.join(DIST, 'assets', f)), { level: 9 }).length
    const shell = files.filter((f) => /^(index|theme)-.*\.js$/.test(f))
    const shellKb = shell.reduce((n, f) => n + gz(f), 0) / 1000
    check('the shell (the scripts index.html loads) is under 200 kB compressed', shellKb < 200, `${shellKb.toFixed(1)} kB gzip: ${shell.join(', ')}`)
    console.log('      ' + files.map((f) => `${f} ${(fs.statSync(path.join(DIST, 'assets', f)).size / 1000).toFixed(1)} kB${/woff2$/.test(f) ? '' : `, ${(gz(f) / 1000).toFixed(1)} kB gzip`}`).join('\n      '))

    // ---- paths and headers
    for (const p of SERVE.documents) {
      const r = await get(origin + p)
      const h = r.headers
      check(`GET ${p} is the document: 200, HTML, revalidated on every load, with the policy and the other headers`, r.status === 200 && h['content-type'] === 'text/html; charset=utf-8' && h['cache-control'] === 'no-cache' && h['content-security-policy'] === SERVE.headers.document['Content-Security-Policy'] && h['x-content-type-options'] === 'nosniff' && h['x-frame-options'] === 'DENY' && h['referrer-policy'] === 'no-referrer' && r.body.toString().includes('<div id="root">'), JSON.stringify([r.status, h['cache-control']]))
    }
    const head = await get(origin + '/explore', {}, 'HEAD')
    check('HEAD of a document answers 200 with no body', head.status === 200 && head.body.length === 0)
    for (const f of files) {
      const r = await get(`${origin}/assets/${f}`, { 'Accept-Encoding': 'gzip' })
      const want = SERVE.contentTypes[path.extname(f)]
      if (!(r.status === 200 && r.headers['cache-control'] === 'public, max-age=31536000, immutable' && r.headers['content-type'] === want && r.headers['x-content-type-options'] === 'nosniff')) check(`GET /assets/${f}: kept for good, typed, not sniffed`, false, JSON.stringify([r.status, r.headers['cache-control'], r.headers['content-type']]))
    }
    check(`every one of the ${files.length} assets is served to be kept for good (immutable), with its type and nosniff`, true)
    for (const p of ['/assets/index-00000000.js', '/assets/', '/explore/', '/explorer', '/index.html', '/assets/../index.html', '/dashboards', '/.env', '/src/main.tsx']) {
      const r = await get(origin + p)
      if (!(r.status === 404 && /^application\/json/.test(r.headers['content-type']))) check(`GET ${p} is the gateway's JSON 404, never the document`, false, `${r.status} ${r.headers['content-type']}`)
    }
    check('a path that is not listed (a missing asset, an unknown page, a trailing slash, index.html itself) is a JSON 404, never the document', true)
    const post = await get(origin + '/explore', {}, 'POST')
    check('POST to a document path is a 404: the sign-in form posts nowhere', post.status === 404)
    const api = await get(origin + '/api/v1/status/buildinfo')
    check('the API is on the same origin and still answers for itself (401 without a key)', api.status === 401 && /json/.test(api.headers['content-type']))

    // ---- the app under the policy
    const run = await drive(browser, origin)
    check('under the policy: sign-in, two queries, autocomplete, the readout, four forms, the palette, Settings and Help all work', run.signedIn && run.rows === 4 && run.autocomplete && run.readout, JSON.stringify({ rows: run.rows, autocomplete: run.autocomplete, readout: run.readout }))
    check('under the policy: no content security policy violation, no console error, no uncaught error', run.violations.length === 0 && run.errors.length === 0, [...run.violations, ...run.errors].slice(0, 5).join(' | '))
    check('under the policy: the legend\'s figure columns have the widths the chart gave them (its style attributes are allowed)', run.columns.length === 4 && run.columns.slice(1).every((w) => w > 30 && w < 400), JSON.stringify(run.columns))
    check('under the policy: both typefaces load from this origin, and the editor is drawn in the mono', run.fonts.some((f) => /Schibsted/.test(f)) && run.fonts.some((f) => /JetBrains/.test(f)) && /JetBrains/.test(run.editorFont), JSON.stringify([run.fonts, run.editorFont]))
    check('the page asks nothing of any other origin, and the key is in no address', run.foreign.length === 0 && run.keyInUrl.length === 0, run.foreign.slice(0, 3).join(' '))

    // ---- teeth: without the allowance for style attributes the same flow must report violations
    const strictRun = await drive(browser, `http://127.0.0.1:${PORT + 1}`).catch((e) => ({ violations: [`flow failed: ${e.message.slice(0, 80)}`], columns: [] }))
    check('teeth: under the policy without its allowance for inline styles the same flow reports violations (so the check above can fail)', strictRun.violations.length > 0, `${strictRun.violations.length} violations, e.g. ${strictRun.violations[0]}`)
  } finally {
    await browser.close()
    stopStrict()
    stop()
    stopMock()
  }
  console.log(`\n${results.length - failed()} of ${results.length} checks pass`)
  process.exit(failed() ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
