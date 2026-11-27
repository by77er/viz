/* eslint-disable */
// Composed images of the dashboards views for design review: every state below, in both
// themes, at 1440 px (mouse) and 400 px (touch, coarse pointer), from the built app on the
// mock, with a fixed time range so that two runs draw the same data.
//
//   node e2e/dashboards-shots.cjs [out dir]     default ../design-system/reviews/app-dashboards
//
// Needs `npm run build`. Starts its own mock and preview (VIZ_E2E_APP_PORT, VIZ_E2E_MOCK_PORT),
// and a mock that requires a key (mock port + 10) with its preview (app port + 20) for the
// no-permission state. Images are the whole page: the viewport is made as tall as the page
// before the capture, because the system's charts are not painted while far off screen
// (content-visibility), and a capture of a tall page would show their places empty.
const fs = require('node:fs')
const path = require('node:path')
const lib = require('./lib.cjs')
const { chromium, APP, MOCK, T0, T1 } = lib
const OUT = path.resolve(process.argv[2] || path.join(lib.ROOT, '../design-system/reviews/app-dashboards'))
const KEYED_MOCK_PORT = lib.MOCK_PORT + 10
const KEYED_APP_PORT = lib.APP_PORT + 20
const KEYED = `http://127.0.0.1:${KEYED_APP_PORT}`
const READ = 'viz_shotReadKey000000_readOnlySecret'
const RANGE = `&from=${T0}&to=${T1}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const settled = (page, n) => page.waitForFunction((n) => document.querySelectorAll('[data-testid=panel]').length >= n && !document.querySelector('[data-testid=panel][data-state=waiting], [data-testid=panel][data-state=idle]'), n, { timeout: 30000 })
const delay = (ms) => fetch(`${MOCK}/__mock/delay?ms=${ms}`).then((r) => r.arrayBuffer())
const problem = { status: 500, contentType: 'application/problem+json', body: JSON.stringify({ type: 'https://vis.bitcru.sh/problems/internal', title: 'Internal error', status: 500, code: 'internal', detail: 'Something went wrong on our side. Nothing was changed.', fix: 'Retry. If it keeps failing, report the time of the request.' }) }

// [name, what is shown, how to get there]
const STATES = [
  ['01-list', 'The list of dashboards: four, by name', async (page) => { await page.goto(`${APP}/dashboards`); await page.waitForSelector('[data-testid=dashboard-row]') }],
  ['02-list-filtered', 'The list, searched for "capacity": one of four', async (page) => { await page.goto(`${APP}/dashboards?q=capacity`); await page.waitForFunction(() => document.querySelectorAll('[data-testid=dashboard-row]').length === 1) }],
  ['03-list-empty', 'Empty: a search that matches no dashboard', async (page) => { await page.goto(`${APP}/dashboards?q=billing&tag=on-call`); await page.waitForSelector('[data-testid=list-empty]') }],
  ['04-list-first-run', 'First run: a tenant with no dashboards', async (page) => { await page.route('**/api/v1/control/dashboards*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], total: 0, next: null }) })); await page.goto(`${APP}/dashboards`); await page.waitForSelector('[data-testid=list-first-run]') }],
  ['05-list-error', 'Error: the API failed to list the dashboards', async (page) => { await page.route('**/api/v1/control/dashboards*', (r) => r.fulfill(problem)); await page.goto(`${APP}/dashboards`); await page.waitForSelector('[data-testid=list-error]') }],
  ['06-list-waiting', 'Loading: the list 0.9 s into a slow answer (nothing is shown before 0.4 s)', async (page) => { await page.route('**/api/v1/control/dashboards*', async (r) => { await sleep(4000); await r.continue().catch(() => {}) }); await page.goto(`${APP}/dashboards`); await page.waitForSelector('[data-testid=list-progress]'); await sleep(450) }],
  ['07-list-no-permission', 'No permission: a key that reads metrics and not dashboards', async (page) => { await page.goto(`${KEYED}/dashboards`); await page.waitForSelector('[data-testid=no-permission]') }, { keyed: true }],
  ['08-dashboard', 'A full dashboard: twelve panels (four stats, six charts, two tables), 18 Nov 09:30 to 12:30', async (page) => { await page.goto(`${APP}/dashboards?id=services_overview${RANGE}`); await settled(page, 12) }],
  ['09-dashboard-variables', 'A dashboard with variables: Service (from a query) set to orders, Status (an enum) to 500; one panel\'s text form open', async (page) => { await page.goto(`${APP}/dashboards?id=service_red${RANGE}&var.service=orders&var.status=500`); await settled(page, 5); await page.waitForFunction(() => document.querySelectorAll('#var-service option').length >= 5); await page.click('[data-panel=rate] [data-testid=panel-text] summary'); await page.waitForSelector('[data-panel=rate] [data-testid=panel-digest]') }],
  ['10-dashboard-panel-states', 'Panel states on one dashboard: a kind not drawn (heatmap; text note), a query the API refuses (error), a query that matches nothing (empty), beside a chart and a stat', async (page) => { await page.goto(`${APP}/dashboards?id=pod_capacity${RANGE}`); await settled(page, 6) }],
  ['11-dashboard-waiting', 'Waiting: the range was changed to the last 6 h and the API is slow; 2.6 s in, every panel keeps its previous answer and says so', async (page) => { await page.goto(`${APP}/dashboards?id=checkout_path${RANGE}`); await settled(page, 4); await delay(20000); await page.click('[data-testid=preset-6h]'); await page.waitForSelector('[data-testid=panel-cancel]'); await sleep(400) }, { after: () => delay(0) }],
  ['12-dashboard-first-load', 'Waiting: a dashboard opened on a slow API, 1 s in: the panels\' places are reserved, each says what it waits for', async (page) => {
    // Opened from the list, as a person opens it: the document and its fonts are already there. (A new document asked for while six
    // slow queries hold every HTTP/1.1 connection of the preview server waits for one of them to revalidate its font: README, "Known risks (dashboards)".)
    await page.goto(`${APP}/dashboards`); await page.waitForSelector('[data-testid=dashboard-row]'); await page.evaluate(() => document.fonts.ready)
    await delay(20000); await page.click('[data-testid=open-services_overview]'); await page.waitForSelector('[data-testid=panel-progress]'); await sleep(500)
  }, { after: () => delay(0) }],
  ['13-dashboard-text', 'The whole dashboard as text (the model\'s digest)', async (page) => { await page.goto(`${APP}/dashboards?id=pod_capacity${RANGE}`); await settled(page, 6); await page.click('[data-testid=form-text]'); await page.waitForSelector('[data-testid=dashboard-digest]') }],
  ['14-dashboard-missing', 'Error: an id no dashboard has', async (page) => { await page.goto(`${APP}/dashboards?id=billing_overview`); await page.waitForSelector('[data-testid=dashboard-error]') }],
  ['15-dashboard-fragments', 'A dashboard made of one fragment used twice', async (page) => { await page.goto(`${APP}/dashboards?id=checkout_path${RANGE}`); await settled(page, 4) }],
]

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const only = (process.env.VIZ_ONLY || '').split(',').filter(Boolean)
  if (only.length === 0) for (const f of fs.readdirSync(OUT)) if (/\.png$/.test(f)) fs.rmSync(path.join(OUT, f))
  const stops = [await lib.startServers()]
  stops.push(await lib.startMock(KEYED_MOCK_PORT, ['--require-token', READ]))
  stops.push(await lib.startPreview(KEYED_APP_PORT, `http://127.0.0.1:${KEYED_MOCK_PORT}`))
  const browser = await chromium.launch()
  const written = []
  try {
    for (const [name, what, go, opts = {}] of STATES) {
      if (only.length && !only.some((o) => name.includes(o))) continue
      for (const theme of ['light', 'dark']) {
        for (const width of [1440, 400]) {
          const layout = width === 400 ? { viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true } : { viewport: { width: 1440, height: 900 } }
          const ctx = opts.keyed ? await lib.contextWithKey(browser, READ, { ...layout, colorScheme: theme }) : await browser.newContext({ ...layout, colorScheme: theme })
          const page = await ctx.newPage()
          const began = Date.now()
          try {
            await go(page)
            const reached = Date.now() - began
            await page.evaluate(() => document.fonts.ready)
            const height = Math.max(layout.viewport.height, await page.evaluate(() => document.documentElement.scrollHeight))
            await page.setViewportSize({ width, height })
            await sleep(350)
            const file = `${name}-${theme}-${width}.png`
            await page.screenshot({ path: path.join(OUT, file) })
            written.push({ file, what, bytes: fs.statSync(path.join(OUT, file)).size, height })
            if (process.env.VIZ_SHOTS_LOG) console.log(`  ${file}: state reached after ${reached} ms, captured after ${Date.now() - began} ms`)
          } finally {
            if (opts.after) await opts.after()
            await ctx.close()
          }
        }
      }
      console.log(`${name}: ${what}`)
    }
  } finally {
    await browser.close()
    for (const stop of stops.reverse()) stop()
  }
  const total = written.reduce((a, w) => a + w.bytes, 0)
  // A run of some states (VIZ_ONLY) replaces their entries and keeps the others.
  const index = path.join(OUT, 'images.json')
  const kept = only.length && fs.existsSync(index) ? JSON.parse(fs.readFileSync(index, 'utf8')).images.filter((i) => !written.some((w) => w.file === i.file)) : []
  const images = [...kept, ...written].sort((a, b) => (a.file < b.file ? -1 : 1))
  fs.writeFileSync(index, JSON.stringify({ when: new Date().toISOString(), range: [new Date(T0).toISOString(), new Date(T1).toISOString()], images }, null, 1) + '\n')
  console.log(`\n${written.length} images, ${(total / 1e6).toFixed(2)} MB, in ${OUT}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
