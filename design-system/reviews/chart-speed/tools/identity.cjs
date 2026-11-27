/* eslint-disable */
// Identity of rendering between builds (AGENTS.md, Evidence: "require identical results before comparing times").
//   node identity.cjs --builds before=<dir>,after=<dir>[,control=<dir>] --out <file.json> [--images <dir>]
// <dir> holds app/ (built: app/dist) and design-system/ (built: dist/preview, dist/fixture).
// For every case it records, per build: the SHA-256 of a full-page screenshot, of every chart's
// markup (plot, legend, note), the charts' accessible names and the text forms; then compares
// every build with the first. Unthrottled; the same mock for every build. Exits 1 on a difference
// and, with --images, writes the differing screenshots.
// Cases, the app's Explore: 4, 36 and 200 series x light, dark x 1440 px (fine pointer), 400 px
// (touch, device scale 2) x rest, readout by keyboard, readout by pointer (1440 only), zoomed in,
// Other opened, a legend row chosen, table, text. The design system's own pages: the Chart
// preview (gaps, a threshold, markers, picked members, an error) and the fixture dashboard
// (36 and 200 series), same themes and widths, at rest and with a keyboard readout.
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback }
const BUILDS = arg('builds', '').split(',').filter(Boolean).map((x, k) => ({ name: x.split('=')[0], root: path.resolve(x.split('=')[1]), port: Number(process.env.VIZ_AB_PORT || 8940) + k }))
const MOCK_PORT = Number(process.env.VIZ_E2E_MOCK_PORT || 8931)
const OUT = arg('out', 'identity.json'), IMAGES = arg('images', null)
const ONLY = arg('only', '')
/** --rounds 2: every build is captured this many times, in turn. Two captures of one build can differ in a few antialiased pixels (see the control in PR.md), so a state is pixel-identical between two builds when any capture of one equals, bit for bit, any capture of the other. Markup, names and text must be equal in every capture. */
const ROUNDS = Number(arg('rounds', '1'))
const T0 = Date.UTC(2026, 10, 18, 9, 30), T1 = Date.UTC(2026, 10, 18, 12, 30)
const QUERIES = { 4: 'sum by (service) (rate(http_requests_total[5m]))', 36: 'sum by (service, route, status) (rate(http_requests_total[5m]))', 200: 'viz_synthetic_series' }
const LAYOUTS = { 1440: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, 400: { viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } }
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex')

// What changes with the clock and not with the build: the age of the result (its width moves the head's other words), a text caret.
const STILL = '[data-testid=age]{display:none !important} .cm-cursor,.cm-cursorLayer{display:none !important} *{caret-color:transparent !important}'
const facts = () => ({
  // the fixture page stamps each chart with the time its data was fetched (data-for): not part of what is drawn
  charts: [...document.querySelectorAll('.vz-chart')].map((c) => c.outerHTML.replace(/ data-for="[^"]*"/g, '')).join('\n'),
  names: [...document.querySelectorAll('svg.vz-plot')].map((s) => s.getAttribute('aria-label')),
  rows: [...document.querySelectorAll('.vz-chart .vz-series')].map((b) => b.getAttribute('aria-label')),
  text: [...document.querySelectorAll('.vz-text-form')].map((t) => t.textContent),
  table: [...document.querySelectorAll('[data-testid=result-table]')].map((t) => t.outerHTML).join('\n'),
})

async function shot(page, record, name, images) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await page.waitForTimeout(250)
  const png = await page.screenshot({ fullPage: true, animations: 'disabled' })
  const f = await page.evaluate(facts)
  record[name] = { png: sha(png), charts: sha(f.charts), chartCount: f.charts ? f.charts.split('<svg class="vz-plot"').length - 1 : 0, names: f.names, rows: sha(JSON.stringify(f.rows)), rowCount: f.rows.length, text: f.text, table: sha(f.table), bytes: png.length }
  images.set(name, png)
}

async function appCase(browser, B, series, theme, width, record, images) {
  const ctx = await browser.newContext({ ...LAYOUTS[width], colorScheme: theme })
  const page = await ctx.newPage()
  await page.addInitScript((t) => { try { localStorage.setItem('viz.theme', t) } catch {} }, theme)
  const id = (state) => `app ${series} series, ${theme}, ${width} px, ${state}`
  await page.goto(`http://127.0.0.1:${B.port}/explore?q=${encodeURIComponent(QUERIES[series])}&from=${T0}&to=${T1}`)
  await page.waitForSelector('[data-testid=chart] tbody tr[data-key]', { state: 'attached', timeout: 60000 })
  await page.waitForSelector('.cm-content')
  await page.addStyleTag({ content: STILL })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(1200)
  await shot(page, record, id('rest'), images)
  const plot = page.locator('[data-testid=chart] svg.vz-plot')
  // readout by keyboard: the crosshair five steps from the end
  await plot.focus()
  for (let k = 0; k < 5; k++) await page.keyboard.press('ArrowLeft')
  await shot(page, record, id('readout by keyboard'), images)
  await page.keyboard.press('Escape')
  if (width === 1440) {
    const box = await plot.boundingBox()
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5)
    await shot(page, record, id('readout by pointer'), images)
    await page.mouse.move(2, 2)
  }
  // zoomed: the foot's button, twice, with the crosshair set by keyboard so the zoom is centred on it
  await plot.focus()
  for (let k = 0; k < 40; k++) await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('+')
  await shot(page, record, id('zoomed in'), images)
  await page.keyboard.press('-')
  await page.keyboard.press('Escape')
  // Other opened, then a row chosen
  const more = page.locator('[data-testid=chart] [data-more]')
  if (await more.count()) { await more.first().click(); await shot(page, record, id('Other opened'), images) }
  await page.locator('[data-testid=chart] tbody tr[data-key] .vz-series').first().click()
  await page.mouse.move(2, 2)
  await shot(page, record, id('a legend row chosen'), images)
  await page.locator('[data-testid=chart] tbody tr[data-key] .vz-series').first().click()
  await page.mouse.move(2, 2)
  // the other forms of the same result
  await page.locator('[data-testid=view-table]').click()
  await page.waitForSelector('[data-testid=result-table] tbody tr')
  await page.mouse.move(2, 2)
  await shot(page, record, id('table'), images)
  await page.locator('[data-testid=view-text]').click()
  await page.mouse.move(2, 2)
  await shot(page, record, id('text'), images)
  await ctx.close()
}

async function systemCase(browser, B, file, theme, width, record, images) {
  const ctx = await browser.newContext({ ...LAYOUTS[width], colorScheme: theme })
  const page = await ctx.newPage()
  const id = (state) => `system ${file}, ${theme}, ${width} px, ${state}`
  await page.goto(`http://127.0.0.1:${B.port + 20}/${file}`)
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
  await page.addStyleTag({ content: STILL })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForSelector('svg.vz-plot .vz-line', { state: 'attached' })
  // charts off screen are skipped (content-visibility): bring each on once so every one is drawn at its size
  await page.evaluate(async () => { for (const c of document.querySelectorAll('.vz-chart')) { c.scrollIntoView({ block: 'center' }); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))) } scrollTo(0, 0) })
  await page.waitForTimeout(800)
  await shot(page, record, id('rest'), images)
  // a keyboard readout on every chart
  const n = await page.locator('svg.vz-plot').count()
  for (let k = 0; k < n; k++) { const s = page.locator('svg.vz-plot').nth(k); if (!(await s.isVisible())) continue; await s.focus().catch(() => {}); for (let j = 0; j < 7; j++) await page.keyboard.press('ArrowLeft') }
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); scrollTo(0, 0) })
  await shot(page, record, id('readout by keyboard on every chart'), images)
  await ctx.close()
}

async function main() {
  const procs = []
  const start = (cwd, args) => { const p = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, VIZ_API_TARGET: `http://127.0.0.1:${MOCK_PORT}` } }); procs.push(p) }
  const stop = () => procs.forEach((p) => { try { p.kill('SIGTERM') } catch {} })
  process.on('exit', stop)
  const up = async (u) => { for (let k = 0; k < 100; k++) { const ok = await new Promise((r) => { const rq = http.get(u, (res) => { res.resume(); r(true) }); rq.on('error', () => r(false)) }); if (ok) return; await new Promise((r) => setTimeout(r, 200)) } throw new Error('not up: ' + u) }
  const mockRoot = path.join(BUILDS[0].root, 'app')
  if (ONLY !== 'system') {
    start(mockRoot, ['--import', 'tsx', path.join(mockRoot, 'mock/server.ts'), '--port', String(MOCK_PORT)])
    for (const B of BUILDS) start(path.join(B.root, 'app'), ['node_modules/vite/bin/vite.js', 'preview', '--port', String(B.port), '--host', '127.0.0.1', '--strictPort'])
    await up(`http://127.0.0.1:${MOCK_PORT}/api/v1/status/buildinfo`)
    for (const B of BUILDS) await up(`http://127.0.0.1:${B.port}`)
  }
  // the design system's generated pages, served as files (fonts and the fixture's data are fetched)
  const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2' }
  const statics = BUILDS.map((B) => http.createServer((req, res) => { const f = path.join(B.root, 'design-system/dist', decodeURIComponent(new URL(req.url, 'http://x').pathname)); fs.readFile(f, (err, data) => { if (err) { res.writeHead(404).end(); return } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(data) }) }).listen(B.port + 20, '127.0.0.1'))
  const browser = await chromium.launch()
  const records = {}, pngs = {}
  try {
    for (let round = 0; round < ROUNDS; round++) for (const B of BUILDS) {
      const record = {}, images = new Map()
      for (const width of [1440, 400]) for (const theme of ['light', 'dark']) {
        if (ONLY !== 'system') for (const series of [4, 36, 200]) await appCase(browser, B, series, theme, width, record, images)
        if (ONLY !== 'app') for (const file of ['preview/Chart.html', 'fixture/index.html']) await systemCase(browser, B, file, theme, width, record, images)
        console.log(`${B.name}, capture ${round + 1}: ${theme}, ${width} px done (${Object.keys(record).length} states so far)`)
      }
      // merge this capture: pixels as a set of hashes; everything else must not change from capture to capture
      const all = (records[B.name] ||= {}), img = (pngs[B.name] ||= new Map())
      for (const [k, r] of Object.entries(record)) {
        if (!all[k]) { all[k] = { ...r, pngs: [r.png], unstable: [] }; img.set(k, images.get(k)); continue }
        if (!all[k].pngs.includes(r.png)) all[k].pngs.push(r.png)
        for (const f of ['charts', 'rows', 'table']) if (all[k][f] !== r[f] && !all[k].unstable.includes(f)) all[k].unstable.push(f)
        if (JSON.stringify(all[k].names) !== JSON.stringify(r.names) && !all[k].unstable.includes('accessible name')) all[k].unstable.push('accessible name')
        if (JSON.stringify(all[k].text) !== JSON.stringify(r.text) && !all[k].unstable.includes('text form')) all[k].unstable.push('text form')
      }
    }
    await browser.close()
  } finally { stop(); statics.forEach((x) => x.close()) }
  const first = BUILDS[0].name, names = Object.keys(records[first])
  const differences = []
  for (const B of BUILDS.slice(1)) for (const k of new Set([...names, ...Object.keys(records[B.name])])) {
    const a = records[first][k], b = records[B.name][k]
    if (!a || !b) { differences.push({ state: k, builds: [first, B.name], what: ['missing in ' + (a ? B.name : first)] }); continue }
    const what = ['charts', 'rows', 'table'].filter((f) => a[f] !== b[f])
    if (!a.pngs.some((h) => b.pngs.includes(h))) what.unshift('png')
    if (JSON.stringify(a.names) !== JSON.stringify(b.names)) what.push('accessible name')
    if (JSON.stringify(a.text) !== JSON.stringify(b.text)) what.push('text form')
    if (what.length) {
      differences.push({ state: k, builds: [first, B.name], what })
      if (IMAGES) { fs.mkdirSync(IMAGES, { recursive: true }); for (const n of [first, B.name]) fs.writeFileSync(path.join(IMAGES, `${k.replace(/[^a-z0-9]+/gi, '-')}.${n}.png`), pngs[n].get(k)) }
    }
  }
  const sameBuildNoise = Object.fromEntries(BUILDS.map((B) => [B.name, { statesWithMoreThanOneImage: Object.values(records[B.name]).filter((r) => r.pngs.length > 1).length, statesWithUnstableMarkup: Object.entries(records[B.name]).filter(([, r]) => r.unstable.length).map(([k, r]) => k + ': ' + r.unstable.join(', ')) }]))
  const themesDiffer = names.filter((k) => k.includes(', light, ')).every((k) => records[first][k].png !== (records[first][k.replace(', light, ', ', dark, ')] || {}).png)
  const out = { when: new Date().toISOString(), builds: BUILDS.map((b) => ({ name: b.name, root: b.root })), states: names.length, chartsInStates: names.reduce((a, k) => a + records[first][k].chartCount, 0), comparedWith: first, capturesPerBuild: ROUNDS, sameBuildNoise, differences, lightAndDarkDiffer: themesDiffer, records }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n')
  console.log(`${names.length} states per build, ${BUILDS.length} builds; every light image differs from its dark one: ${themesDiffer}`)
  for (const B of BUILDS) console.log(`${B.name}: ${ROUNDS} captures; states whose captures were not all the same image: ${sameBuildNoise[B.name].statesWithMoreThanOneImage}; states whose markup changed between captures: ${sameBuildNoise[B.name].statesWithUnstableMarkup.length}`)
  for (const B of BUILDS.slice(1)) { const d = differences.filter((x) => x.builds[1] === B.name); console.log(`${first} vs ${B.name}: ${d.length === 0 ? 'identical in every state (pixels, chart markup, accessible names, legend row names, text form, table)' : d.length + ' states differ'}`); for (const x of d.slice(0, 40)) console.log(`  ${x.state}: ${x.what.join(', ')}`) }
  process.exit(differences.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
