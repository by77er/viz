/* eslint-disable */
// End-to-end checks for the Explore view against the mock backend and the built app.
//   node e2e/run.cjs            (expects `npm run build` to have run)
// Uses the globally pre-installed Playwright; starts and stops its own servers (8820, 8821).
const { chromium } = require('playwright')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')

const ROOT = path.resolve(__dirname, '..')
const SHOTS = path.join(ROOT, 'screenshots')
const APP = 'http://127.0.0.1:8820'
const MOCK = 'http://127.0.0.1:8821'
const AXE = fs.readFileSync(path.join(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8')

// A fixed window so screenshots are reproducible: 3 h containing the mock's "incident"
// (09:40–09:52 UTC) and one pod's data gap (10:50–11:02 UTC).
const T0 = Date.UTC(2026, 10, 18, 9, 30)
const T1 = Date.UTC(2026, 10, 18, 12, 30)
const Q_RATE = 'sum by (service) (rate(http_requests_total[5m]))'
const Q_CPU = 'pod_cpu_usage_cores{service="checkout"}'
const Q_P95 = 'histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[5m])))'
const Q_MANY = 'sum by (service, route, status) (rate(http_requests_total[5m]))'
const url = (q, extra = '') => `${APP}/explore?q=${encodeURIComponent(q)}&from=${T0}&to=${T1}${extra}`

const results = []
let failed = 0
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

function ping(u) {
  return new Promise((resolve) => {
    http.get(u, (res) => { res.resume(); resolve(res.statusCode) }).on('error', () => resolve(0))
  })
}
async function waitFor(u, ms = 20000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    if (await ping(u)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

async function canvasStats(page) {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid=chart] canvas')
    if (!c) return null
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let painted = 0
    const colors = new Map()
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 200) {
        painted++
        const key = '#' + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')
        colors.set(key, (colors.get(key) || 0) + 1)
      }
    }
    return { width: c.width, height: c.height, painted, distinct: colors.size, top: [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12) }
  })
}
const overflow = (page) => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
const legendNames = (page) => page.$$eval('[data-testid=legend] tbody button[data-series]', (els) => els.map((e) => e.getAttribute('data-series')))

async function axe(page, label) {
  await page.evaluate(AXE)
  const res = await page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } })
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary || '').replace(/\s+/g, ' ').slice(0, 220)) }))
  })
  const bad = res.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  check(`axe (${label}): no serious/critical violations`, bad.length === 0, `${res.length} violation(s) total: ${res.map((v) => `${v.id}[${v.impact}]`).join(', ') || 'none'}`)
  for (const v of res) console.log(`      axe ${v.impact} ${v.id}: ${v.help}\n        ${v.nodes.join('\n        ')}`)
  return res
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  if (!fs.existsSync(path.join(ROOT, 'dist/index.html'))) throw new Error('dist/ missing: run `npm run build` first')

  const procs = []
  const start = (cmd, args) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
    p.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
    procs.push(p)
    return p
  }
  if (await ping(`${MOCK}/api/v1/status/buildinfo`)) throw new Error('port 8821 is already in use')
  if (await ping(APP)) throw new Error('port 8820 is already in use')
  start(process.execPath, ['--import', 'tsx', 'mock/server.ts', '--port', '8821'])
  start(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '8820', '--host', '127.0.0.1'])
  const stop = () => procs.forEach((p) => { try { p.kill('SIGTERM') } catch {} })
  process.on('exit', stop)

  try {
    if (!(await waitFor(`${MOCK}/api/v1/status/buildinfo`)) || !(await waitFor(APP))) throw new Error('servers did not start')

    const browser = await chromium.launch()
    const consoleErrors = []
    let expectHttpError = false
    const watch = (page) => {
      page.on('console', (m) => {
        if (m.type() !== 'error') return
        if (expectHttpError && /Failed to load resource.*\b4\d\d\b/.test(m.text())) return
        consoleErrors.push(m.text())
      })
      page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
    }

    // ------------------------------------------------------------ desktop, light
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' })
    const page = await ctx.newPage()
    watch(page)
    const requests = []
    page.on('request', (r) => { if (r.url().includes('/api/v1/')) requests.push(r) })

    await page.goto(`${APP}/`)
    await page.waitForSelector('[data-testid=start-state]')
    check('/ redirects to /explore', new URL(page.url()).pathname === '/explore')
    await page.waitForSelector('[data-testid=mock-banner]')
    check('mock banner is shown when connected to the mock', /mock backend/i.test(await page.textContent('[data-testid=mock-banner]')))
    await page.waitForSelector('.cm-content')

    // Autocomplete: metric names, then label names and values, from the API.
    await page.click('.cm-content')
    await page.keyboard.type('http_requests_t')
    await page.waitForSelector('.cm-tooltip-autocomplete')
    let options = await page.$$eval('.cm-tooltip-autocomplete li', (els) => els.map((e) => e.textContent))
    check('autocomplete offers metric names from the API', options.some((o) => o.includes('http_requests_total')), options.slice(0, 4).join(' | '))
    await page.screenshot({ path: path.join(SHOTS, 'autocomplete-light.png') })
    await page.keyboard.press('Enter')
    await page.keyboard.type('{')
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-tooltip-autocomplete li')].some((e) => e.textContent.includes('service')))
    options = await page.$$eval('.cm-tooltip-autocomplete li', (els) => els.map((e) => e.textContent))
    check('autocomplete offers label names of the metric', ['service', 'route', 'status'].every((l) => options.some((o) => o.startsWith(l))), options.join(' | '))
    await page.keyboard.type('service="')
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-tooltip-autocomplete li')].some((e) => e.textContent.includes('checkout')))
    options = await page.$$eval('.cm-tooltip-autocomplete li', (els) => els.map((e) => e.textContent))
    check('autocomplete offers label values', ['auth', 'catalog', 'checkout', 'orders'].every((l) => options.some((o) => o.startsWith(l))), options.join(' | '))
    await page.keyboard.press('Escape')
    const highlighted = await page.$$eval('.cm-content span[class]', (els) => new Set(els.map((e) => getComputedStyle(e).color)).size)

    // Run a query with Ctrl+Enter.
    await page.keyboard.press('Control+a')
    await page.keyboard.insertText(Q_RATE)
    await page.keyboard.press('Control+Enter')
    await page.waitForSelector('[data-testid=legend] tbody tr')
    check('Ctrl+Enter runs the query and puts it in the URL', new URL(page.url()).searchParams.get('q') === Q_RATE, page.url())
    const tokens = await page.$$eval('.cm-content span[class]', (els) => new Set(els.map((e) => getComputedStyle(e).color)).size)
    check('PromQL syntax highlighting is applied', tokens >= 3 || highlighted >= 2, `${tokens} token colours`)
    let names = await legendNames(page)
    check('legend lists the expected series', JSON.stringify(names) === JSON.stringify(['{service="auth"}', '{service="catalog"}', '{service="checkout"}', '{service="orders"}']), names.join(' '))
    await page.waitForSelector('[data-testid=chart] canvas')
    let stats = await canvasStats(page)
    check('chart canvas has non-blank pixels', !!stats && stats.painted > 3000 && stats.distinct > 8, stats ? `${stats.painted} painted px, ${stats.distinct} colours, ${stats.width}×${stats.height}` : 'no canvas')
    const palette = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
    const seriesColours = palette.filter((c) => stats.top.some(([k, n]) => k === c && n > 100))
    check('four series colours from the palette are drawn', seriesColours.length === 4, seriesColours.join(' '))

    // Colour stability across reloads.
    const swatches = () => page.$$eval('[data-testid=legend] tbody tr', (rows) => rows.map((r) => r.querySelector('button').getAttribute('data-series') + '=' + r.querySelector('svg line').getAttribute('stroke')))
    const before = await swatches()
    await page.reload()
    await page.waitForSelector('[data-testid=legend] tbody tr')
    const after = await swatches()
    check('series colours are identical after a reload', JSON.stringify(before) === JSON.stringify(after), after.join(' '))

    // Fixed window for the rest (and for the screenshots).
    await page.goto(url(Q_RATE))
    await page.waitForSelector('[data-testid=legend] tbody tr')
    await page.waitForSelector('[data-testid=chart] canvas')
    const status = await page.textContent('[data-testid=status]')
    check('status line reports series, step and timing', /4 series/.test(status) && /step 15s/.test(status) && /ms/.test(status), status.replace(/\s+/g, ' '))

    // Crosshair + tooltip.
    const over = await page.locator('[data-testid=chart] .u-over').boundingBox()
    await page.mouse.move(over.x + over.width * 0.55, over.y + over.height * 0.5)
    await page.waitForSelector('.chart-tip', { state: 'visible' })
    const tip = await page.textContent('.chart-tip')
    check('hover shows a crosshair tooltip with all series', ['auth', 'catalog', 'checkout', 'orders'].every((s) => tip.includes(s)) && /\/s/.test(tip), tip.slice(0, 60))
    await page.screenshot({ path: path.join(SHOTS, 'explore-desktop-light.png') })
    let o = await overflow(page)
    check('no horizontal overflow (desktop, light)', o.sw <= o.iw, `${o.sw} <= ${o.iw}`)

    // Table + JSON.
    const tableText = await page.textContent('[data-testid=result-table]')
    check('table lists an instant value per series', ['auth', 'catalog', 'checkout', 'orders'].every((s) => tableText.includes(s)) && /\d\/s/.test(tableText))
    await page.click('[data-testid=tab-json]')
    const json = await page.textContent('[data-testid=result-json] pre')
    check('raw JSON view shows the API response', json.includes('"resultType": "matrix"') && json.includes('"service":"auth"') && new URL(page.url()).searchParams.get('tab') === 'json')
    await page.click('#tab-table')

    // Click-to-isolate.
    await page.click('[data-testid=legend] button[data-series=\'{service="checkout"}\']')
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=legend] button[aria-pressed=true]').length === 1)
    const iso = await canvasStats(page)
    const isoColours = palette.filter((c) => iso.top.some(([k, n]) => k === c && n > 100))
    check('clicking a legend row isolates that series', isoColours.length === 1, `colours drawn: ${isoColours.join(' ')}`)
    await page.screenshot({ path: path.join(SHOTS, 'explore-isolated-light.png') })
    await page.click('[data-testid=legend] button[data-series=\'{service="checkout"}\']')
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=legend] button[aria-pressed=true]').length === 4)

    // Drag to zoom updates the URL time range; Back undoes it.
    const urlBefore = new URL(page.url())
    await page.mouse.move(over.x + over.width * 0.25, over.y + over.height * 0.5)
    await page.mouse.down()
    await page.mouse.move(over.x + over.width * 0.45, over.y + over.height * 0.55, { steps: 8 })
    await page.mouse.move(over.x + over.width * 0.75, over.y + over.height * 0.6, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction((f) => new URL(location.href).searchParams.get('from') !== f, String(T0))
    const z = new URL(page.url())
    const zf = Number(z.searchParams.get('from'))
    const zt = Number(z.searchParams.get('to'))
    const span = T1 - T0
    const okZoom = Math.abs(zf - (T0 + 0.25 * span)) < span * 0.02 && Math.abs(zt - (T0 + 0.75 * span)) < span * 0.02
    check('drag-to-zoom changes the URL time range to the selection', okZoom, `from ${urlBefore.searchParams.get('from')}→${zf}, to ${urlBefore.searchParams.get('to')}→${zt}`)
    await page.waitForFunction(() => /step 15s/.test(document.querySelector('[data-testid=status]')?.textContent || ''))
    check('the query, not just the picture, is zoomed', z.searchParams.get('q') === Q_RATE)
    await page.goBack()
    await page.waitForFunction((f) => new URL(location.href).searchParams.get('from') === f, String(T0))
    check('browser Back undoes the zoom', true)

    // Relative preset through the picker.
    await page.click('[data-testid=time-range]')
    await page.screenshot({ path: path.join(SHOTS, 'time-picker-light.png') })
    await page.click('role=dialog[name="Time range"] >> text=24h')
    await page.waitForFunction(() => new URL(location.href).searchParams.get('from') === 'now-24h')
    check('time picker preset writes a relative range to the URL', !new URL(page.url()).searchParams.has('to'), page.url().split('?')[1])
    await page.waitForFunction(() => /step 1m/.test(document.querySelector('[data-testid=status]')?.textContent || ''))
    check('auto step follows the range (24 h → 1 m at this width; 3 h → 15 s)', true)

    // Explicit step + min/max downsampling.
    await page.goto(url(Q_CPU, '&step=1s'))
    await page.waitForSelector('[data-testid=legend] tbody tr')
    await page.waitForFunction(() => /min\/max per pixel column/.test(document.querySelector('[data-testid=status]')?.textContent || ''))
    const ds = await page.textContent('[data-testid=status]')
    check('more points than pixels: min/max downsampling is applied and labelled', /10,801 →/.test(ds), ds.replace(/\s+/g, ' ').slice(-90))
    await page.screenshot({ path: path.join(SHOTS, 'explore-downsampled-gap-light.png') })

    // Text view.
    await page.goto(url(Q_RATE))
    await page.waitForSelector('[data-testid=legend] tbody tr')
    await page.click('[data-testid=view-text]')
    await page.waitForSelector('[data-testid=text-view]')
    const digest = await page.textContent('[data-testid=text-view] pre')
    check('text view shows a digest (last/min/max/mean/trend per series)', /4 series/.test(digest) && /\{service="catalog"\}: last [\d.]+\/s, min [\d.]+\/s, max [\d.]+\/s, mean [\d.]+\/s, (rising|falling|flat)/.test(digest) && new URL(page.url()).searchParams.get('view') === 'text', digest.split('\n')[2])
    await page.screenshot({ path: path.join(SHOTS, 'explore-text-light.png') })
    await axe(page, 'text view, light')
    await page.keyboard.press('Escape')
    await page.locator('body').click({ position: { x: 700, y: 880 } })
    await page.keyboard.press('t')
    await page.waitForSelector('[data-testid=chart] canvas')
    check('T toggles back to the chart', !new URL(page.url()).searchParams.has('view'))

    // Loading state keeps the previous data visible.
    await page.route('**/api/v1/query_range', async (route) => { await new Promise((r) => setTimeout(r, 900)); await route.continue() })
    await page.click('.cm-content')
    await page.keyboard.press('Control+a')
    await page.keyboard.insertText(Q_P95)
    await page.keyboard.press('Control+Enter')
    await page.waitForSelector('[role=progressbar]')
    const during = { names: await legendNames(page), canvas: !!(await page.$('[data-testid=chart] canvas')), status: await page.textContent('[data-testid=status]') }
    check('while loading, the previous result stays visible', during.canvas && during.names.length === 4 && /Loading/.test(during.status), during.status.replace(/\s+/g, ' ').slice(-50))
    await page.waitForSelector('[role=progressbar]', { state: 'detached' })
    await page.unroute('**/api/v1/query_range')
    await page.waitForFunction(() => /ms$|ms\s/.test(document.querySelector('[data-testid=status]')?.textContent || ''))
    const p95 = await page.textContent('[data-testid=legend]')
    check('latency query is formatted in time units', /\d ms/.test(p95), p95.replace(/\s+/g, ' ').slice(60, 130))

    // Error state.
    expectHttpError = true
    await page.click('.cm-content')
    await page.keyboard.press('Control+a')
    await page.keyboard.insertText('sum by (service) (rate(http_requests_total[5m])')
    await page.click('[data-testid=run]')
    await page.waitForSelector('[data-testid=error-message]')
    const err = await page.textContent('[data-testid=error-message]')
    const errType = await page.textContent('[data-testid=error-type]')
    check('error state shows the Prometheus error text', /parse error: unexpected end of input/.test(err) && /bad_data/.test(errType), `${errType.trim()}: ${err.trim()}`)
    await page.screenshot({ path: path.join(SHOTS, 'explore-error-light.png') })
    await page.waitForTimeout(150)
    expectHttpError = false

    // Empty state.
    await page.click('.cm-content')
    await page.keyboard.press('Control+a')
    await page.keyboard.insertText('no_such_metric_total')
    await page.keyboard.press('Control+Enter')
    await page.waitForSelector('[data-testid=empty-state]')
    check('empty state says the query returned no series', /returned no series/.test(await page.textContent('[data-testid=empty-state]')))
    await page.screenshot({ path: path.join(SHOTS, 'explore-empty-light.png') })

    // Command palette: run query + navigation.
    await page.goto(url(Q_RATE))
    await page.waitForSelector('[data-testid=legend] tbody tr')
    const n0 = requests.filter((r) => r.url().includes('query_range')).length
    await page.keyboard.press('Control+k')
    await page.waitForSelector('dialog[aria-label="Command palette"][open]')
    await page.screenshot({ path: path.join(SHOTS, 'command-palette-light.png') })
    await page.keyboard.type('run q')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => !document.querySelector('dialog[open]'))
    await page.waitForTimeout(400)
    check('command palette "Run query" re-runs the query', requests.filter((r) => r.url().includes('query_range')).length === n0 + 1)
    await page.keyboard.press('Control+k')
    await page.keyboard.type('shortcuts')
    await page.keyboard.press('Enter')
    await page.waitForURL('**/help')
    check('command palette navigates', true)
    await page.keyboard.press('Control+k')
    await page.keyboard.type('explore')
    await page.keyboard.press('Enter')
    await page.waitForURL('**/explore')

    // Settings: token goes to localStorage and the Authorization header, never the URL.
    await page.goto(url(Q_RATE))
    await page.waitForSelector('[data-testid=legend] tbody tr')
    await page.click('button[aria-label=Settings]')
    await page.fill('#set-token', 'tok-e2e-123')
    await page.screenshot({ path: path.join(SHOTS, 'settings-light.png') })
    const reqP = page.waitForRequest((r) => r.url().includes('/api/v1/query_range'))
    await page.click('dialog[open] button[type=submit]')
    const req = await reqP
    const stored = await page.evaluate(() => localStorage.getItem('viz.settings'))
    check('token is stored in localStorage and sent as a bearer header', /tok-e2e-123/.test(stored) && req.headers()['authorization'] === 'Bearer tok-e2e-123')
    const leaked = requests.filter((r) => r.url().includes('tok-e2e-123')).length
    check('token never appears in a URL', !page.url().includes('tok-e2e-123') && leaked === 0)
    await page.evaluate(() => localStorage.removeItem('viz.settings'))

    // Accessibility (main view, light).
    await page.goto(url(Q_RATE))
    await page.waitForSelector('[data-testid=legend] tbody tr')
    await page.waitForSelector('[data-testid=chart] canvas')
    await axe(page, 'main view, light')
    // Keyboard on the chart.
    await page.focus('[data-testid=chart]')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    const live = await page.textContent('[data-testid=chart] [aria-live]')
    check('arrow keys move the chart cursor and announce values', /2026-11-18 \d\d:\d\d:\d\d\. \{service="auth"\}: [\d.]+\/s/.test(live), live.slice(0, 70))
    await ctx.close()

    // ------------------------------------------------------------ desktop, dark
    const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' })
    const dpage = await dctx.newPage()
    watch(dpage)
    await dpage.goto(url(Q_CPU))
    await dpage.waitForSelector('[data-testid=legend] tbody tr')
    await dpage.waitForSelector('[data-testid=chart] canvas')
    const dover = await dpage.locator('[data-testid=chart] .u-over').boundingBox()
    await dpage.mouse.move(dover.x + dover.width * 0.3, dover.y + dover.height * 0.4)
    await dpage.waitForSelector('.chart-tip', { state: 'visible' })
    await dpage.screenshot({ path: path.join(SHOTS, 'explore-desktop-dark.png') })
    const bg = await dpage.evaluate(() => getComputedStyle(document.body).backgroundColor)
    check('dark theme follows the system preference', bg === 'rgb(13, 13, 13)', bg)
    o = await overflow(dpage)
    check('no horizontal overflow (desktop, dark)', o.sw <= o.iw, `${o.sw} <= ${o.iw}`)
    const dstats = await canvasStats(dpage)
    const darkPalette = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767']
    check('dark theme uses the dark palette steps on the canvas', darkPalette.filter((c) => dstats.top.some(([k, n]) => k === c && n > 100)).length === 3)
    await axe(dpage, 'main view, dark')
    // Manual toggle overrides the system preference (system → light).
    await dpage.click('button[aria-label^="Theme"]')
    const bg2 = await dpage.evaluate(() => getComputedStyle(document.body).backgroundColor)
    check('manual theme toggle overrides the system preference', bg2 === 'rgb(246, 246, 244)' && (await dpage.evaluate(() => localStorage.getItem('viz.theme'))) === 'light', bg2)
    await dpage.evaluate(() => localStorage.removeItem('viz.theme'))
    // Many series, dark.
    await dpage.goto(url(Q_MANY))
    await dpage.waitForSelector('[data-testid=legend] tbody tr')
    await dpage.waitForSelector('[data-testid=chart] canvas')
    check('36 series render with a scrolling legend', (await legendNames(dpage)).length === 36)
    await dpage.screenshot({ path: path.join(SHOTS, 'explore-many-series-dark.png') })
    await dpage.goto(`${APP}/explore`)
    await dpage.waitForSelector('[data-testid=start-state] button')
    await dpage.screenshot({ path: path.join(SHOTS, 'explore-start-dark.png') })
    await dpage.goto(`${APP}/help`)
    await dpage.waitForSelector('h1')
    await dpage.screenshot({ path: path.join(SHOTS, 'help-dark.png') })
    await axe(dpage, 'help, dark')
    await dctx.close()

    // ------------------------------------------------------------ narrow (400 px), both themes
    for (const scheme of ['light', 'dark']) {
      const nctx = await browser.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, colorScheme: scheme })
      const np = await nctx.newPage()
      watch(np)
      await np.goto(url(Q_RATE))
      await np.waitForSelector('[data-testid=legend] tbody tr')
      await np.waitForSelector('[data-testid=chart] canvas')
      await np.waitForTimeout(300)
      o = await overflow(np)
      check(`no horizontal overflow (400 px, ${scheme})`, o.sw <= o.iw, `${o.sw} <= ${o.iw}`)
      await np.screenshot({ path: path.join(SHOTS, `explore-narrow-${scheme}.png`), fullPage: true })
      const st = await np.textContent('[data-testid=status]')
      check(`narrow chart picks a coarser auto step (400 px, ${scheme})`, /step 30s/.test(st), st.replace(/\s+/g, ' ').slice(0, 60))
      await np.click('[data-testid=time-range]')
      await np.waitForSelector('role=dialog[name="Time range"]')
      o = await overflow(np)
      check(`time picker fits (400 px, ${scheme})`, o.sw <= o.iw, `${o.sw} <= ${o.iw}`)
      if (scheme === 'light') await np.screenshot({ path: path.join(SHOTS, 'time-picker-narrow-light.png') })
      await np.keyboard.press('Escape')
      await np.goto(`${APP}/explore`)
      await np.waitForSelector('[data-testid=start-state] button')
      o = await overflow(np)
      check(`start state fits (400 px, ${scheme})`, o.sw <= o.iw, `${o.sw} <= ${o.iw}`)
      if (scheme === 'light') await axe(np, 'main view, 400 px light')
      await nctx.close()
    }

    check('no console errors or page errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' || '))
    await browser.close()
  } finally {
    stop()
  }

  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
