/* eslint-disable */
// Composed images of the monitors views for design review: every state below, in both themes,
// at 1440 px (mouse) and 400 px (touch, coarse pointer), from the built app on the mock (reset
// before every image, so each starts from the same monitors).
//
//   node e2e/monitors-shots.cjs [out dir]     default ../design-system/reviews/app-monitors
//   python3 e2e/encode-review-images.py ../design-system/reviews/app-monitors --flat
//
// Needs `npm run build`. Starts its own mock and preview (VIZ_E2E_APP_PORT, VIZ_E2E_MOCK_PORT),
// and a mock that requires a key (mock port + 10) with its preview (app port + 20). Images are
// the whole page (the viewport is made as tall as the page first: the chart is not painted far
// off screen).
const fs = require('node:fs')
const path = require('node:path')
const lib = require('./lib.cjs')
const { chromium, APP, MOCK } = lib
const OUT = path.resolve(process.argv[2] || path.join(lib.ROOT, '../design-system/reviews/app-monitors'))
const KEYED_MOCK_PORT = lib.MOCK_PORT + 10
const KEYED_APP_PORT = lib.APP_PORT + 20
const KEYED = `http://127.0.0.1:${KEYED_APP_PORT}`
const READ = 'viz_shotReadKey000000_readOnlySecret'
const MONREAD = 'viz_shotMonRead000000_monReadSecret'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hook = (q, base = MOCK) => fetch(`${base}/__mock/monitors?${q}`).then((r) => r.json())
const settled = (page) => page.waitForFunction(() => ['drawn', 'empty', 'failed'].includes(document.querySelector('[data-testid=monitor-chart]')?.dataset.state) && document.querySelector('[data-testid=history-line]'), null, { timeout: 30000 })
let FIRING = ''

const open = async (page, base = APP) => { await page.goto(`${base}/monitors?id=${FIRING}`); await settled(page) }
// [name, what is shown, how to get there, options]
const STATES = [
  ['01-list', 'The list on "Needs attention" (the default): five of seven, firing first; the one someone has after the one nobody has', async (page) => { await page.goto(`${APP}/monitors`); await page.waitForSelector('[data-testid=monitor-row]') }],
  ['02-list-all', 'The list on "All": seven monitors, attention first, the quiet last', async (page) => { await page.goto(`${APP}/monitors?filter=all`); await page.waitForFunction(() => document.querySelectorAll('[data-testid=monitor-row]').length === 7) }],
  ['03-monitor-firing', 'A firing monitor nobody has acknowledged: state line, who was told, actions, the query with its threshold and markers over the last 3 h, its alert, its history', open],
  ['04-acknowledged', 'After Acknowledge: the button replaced in place by "Acknowledged by you at …" with Unacknowledge; the state line keeps its words and takes the acknowledged mark', async (page) => { await open(page); await page.click('[data-testid=acknowledge]'); await page.waitForFunction(() => /Acknowledged by you/.test(document.querySelector('[data-testid=history-line]')?.textContent ?? '')) }],
  ['05-silence-menu', 'Silence…: the durations, what will happen, and the yellow button that carries the choice', async (page) => { await open(page); await page.click('[data-testid=silence]'); await page.waitForSelector('[data-testid=silence-menu][data-open]'); await page.evaluate(() => scrollTo(0, 0)) }, { keepScroll: true }],
  ['06-silenced-undo', 'After Silence for 1 h: "Silenced by you until …" with Undo, and how long the undo stays open', async (page) => { await open(page); await page.click('[data-testid=silence]'); await page.click('[data-testid=silence-confirm]'); await page.waitForSelector('[data-testid=undo]'); await page.waitForFunction(() => /Silenced by you/.test(document.querySelector('[data-testid=history-line]')?.textContent ?? '')) }],
  ['07-undo-expired', 'Undo pressed after the API\'s 60 s window: the API\'s 410 in its words under the actions, the silence kept, Undo gone', async (page) => { await open(page); await page.click('[data-testid=silence]'); await page.click('[data-testid=silence-confirm]'); await page.waitForSelector('[data-testid=undo]'); await hook('advance=61000'); await page.click('[data-testid=undo]'); await page.waitForSelector('[data-testid=action-failure]') }],
  ['08-write-failed', 'Acknowledge refused (the API answered 503): the notice under the button in the API\'s words; nothing else changed', async (page) => { await open(page); await hook('fail=acknowledge&status=503'); await page.click('[data-testid=acknowledge]'); await page.waitForSelector('[data-testid=action-failure]') }],
  ['09-no-ack-scope', 'A key that may read monitors and not act (no monitors:ack): the actions say why before any press', async (page) => { await open(page, KEYED) }, { key: MONREAD }],
  ['10-no-permission', 'No permission: a key without monitors:read, on the list', async (page) => { await page.goto(`${KEYED}/monitors`); await page.waitForSelector('[data-testid=monitors-no-permission]') }, { key: READ }],
  ['11-list-error', 'Error: the API could not list the monitors (503)', async (page) => { await hook('fail=list&status=503'); await page.goto(`${APP}/monitors`); await page.waitForSelector('[data-testid=monitors-error]') }],
  ['12-empty', 'Empty: a tenant with no monitors (first run)', async (page) => { await hook('empty=1'); await page.goto(`${APP}/monitors`); await page.waitForSelector('[data-testid=monitors-first-run]') }],
  ['13-monitor-error', 'A monitor that cannot be evaluated: the ruler\'s last error, the query\'s refusal in the chart\'s place, nothing to act on', async (page) => { await page.goto(`${APP}/monitors?id=${(await ids())['Payments errors'].id}`); await settled(page) }],
]
const ids = async () => Object.fromEntries((await fetch(`${MOCK}/api/v1/monitors?filter=all`).then((r) => r.json())).monitors.map((m) => [m.name, m]))

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const only = (process.env.VIZ_ONLY || '').split(',').filter(Boolean)
  if (only.length === 0) for (const f of fs.readdirSync(OUT)) if (/\.png$/.test(f)) fs.rmSync(path.join(OUT, f))
  const stops = [await lib.startServers()]
  stops.push(await lib.startMock(KEYED_MOCK_PORT, ['--require-token', READ, '--monitors-token', MONREAD]))
  stops.push(await lib.startPreview(KEYED_APP_PORT, `http://127.0.0.1:${KEYED_MOCK_PORT}`))
  FIRING = (await ids())['Checkout 5xx ratio'].id
  const browser = await chromium.launch()
  const written = []
  try {
    for (const [name, what, go, opts = {}] of STATES) {
      if (only.length && !only.some((o) => name.includes(o))) continue
      for (const theme of ['light', 'dark']) {
        for (const width of [1440, 400]) {
          await hook('reset=1')
          await hook('reset=1', `http://127.0.0.1:${KEYED_MOCK_PORT}`)
          const layout = width === 400 ? { viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true } : { viewport: { width: 1440, height: 900 } }
          const ctx = opts.key ? await lib.contextWithKey(browser, opts.key, { ...layout, colorScheme: theme }) : await browser.newContext({ ...layout, colorScheme: theme })
          const page = await ctx.newPage()
          try {
            await go(page)
            await page.evaluate(() => document.fonts.ready)
            if (!opts.keepScroll) {
              const height = Math.max(layout.viewport.height, await page.evaluate(() => document.documentElement.scrollHeight))
              await page.setViewportSize({ width, height })
            }
            await sleep(350)
            const file = `${name}-${theme}-${width}.png`
            await page.screenshot({ path: path.join(OUT, file) })
            written.push({ file, what, bytes: fs.statSync(path.join(OUT, file)).size })
          } finally {
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
  fs.writeFileSync(path.join(OUT, 'images.json'), JSON.stringify({ when: new Date().toISOString(), images: written }, null, 1) + '\n')
  console.log(`\n${written.length} images, ${(total / 1e6).toFixed(2)} MB, in ${OUT}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
