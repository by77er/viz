/* eslint-disable */
// Before/after images for the fixes to the design review (B1 and the focus cases).
//   node e2e/fix-shots.cjs --label before --root <copy of the app before the fixes> --out <dir>
//   node e2e/fix-shots.cjs --label after  --out ../design-system/reviews/app-restyle/fixes
// Starts its own servers (VIZ_E2E_APP_PORT / VIZ_E2E_MOCK_PORT). Uses only selectors that both
// builds have. Each image is 1440 px wide at scale 1, clipped to the query, the panel head,
// the chart and the legend. The element that has focus in each focus case is written to
// focus-<label>.json, because "no ring anywhere" cannot be seen in a picture.
const path = require('node:path')
const fs = require('node:fs')
const lib = require('./lib.cjs')
const { chromium, url, Q_RATE, Q_BAD, setMockDelay } = lib
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback }
const LABEL = arg('label', 'after')
const ROOT = path.resolve(arg('root', lib.ROOT))
const OUT = path.resolve(arg('out', path.join(lib.ROOT, '../design-system/reviews/app-restyle/fixes')))
const Q_MEM = 'pod_memory_working_set_bytes'

const ready = async (page) => {
  await page.waitForSelector('[data-testid=legend] tbody tr')
  await page.waitForSelector('[data-testid=chart] canvas')
  await page.evaluate(() => document.fonts.ready)
}
const setQuery = async (page, q) => { await page.click('.cm-content'); await page.keyboard.press('Control+a'); await page.keyboard.insertText(q) }
const shot = async (page, name) => {
  await page.mouse.move(2, 2)
  await page.waitForTimeout(150)
  await page.screenshot({ path: path.join(OUT, `${name}-${LABEL}.png`), clip: { x: 0, y: 0, width: 1440, height: 640 } })
}
const active = (page) => page.evaluate(() => { const el = document.activeElement; return !el || el === document.body ? 'body' : (el.getAttribute('data-testid') || el.textContent || el.tagName).trim().slice(0, 40) })

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const stop = await lib.startServers(ROOT)
  const focus = {}
  try {
    const browser = await chromium.launch()
    const open = async () => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' })
      const page = await ctx.newPage()
      await page.goto(url(Q_RATE)); await ready(page); await page.waitForSelector('.cm-content')
      return { ctx, page }
    }
    // ---- B1: waiting, then cancelled (the memory query waits over the request-rate result)
    {
      const { ctx, page } = await open()
      await setMockDelay(8000)
      await setQuery(page, Q_MEM)
      await page.keyboard.press('Control+Enter')
      await page.waitForSelector('[data-testid=progress]')
      await page.waitForTimeout(700)
      await shot(page, 'b1-waiting')
      await page.waitForSelector('[data-testid=cancel]')
      await page.click('[data-testid=cancel]')
      await page.waitForSelector('[data-testid=halted]')
      await shot(page, 'b1-cancelled')
      // ---- B1: errored after success
      await setMockDelay(0)
      await setQuery(page, Q_BAD)
      await page.keyboard.press('Control+Enter')
      await page.waitForSelector('[data-testid=error-state]')
      await shot(page, 'b1-errored')
      await ctx.close()
    }
    // ---- B1: stopped at 60 s
    {
      const { ctx, page } = await open()
      await setMockDelay(70000, { stall: true })
      await setQuery(page, Q_MEM)
      await page.keyboard.press('Control+Enter')
      await page.waitForSelector('[data-testid=halted]', { timeout: 70000 })
      await shot(page, 'b1-stopped-60s')
      await setMockDelay(0)
      await ctx.close()
    }
    // ---- focus: Cancel by keyboard, a time preset by keyboard, "Run the query again" by keyboard
    {
      const { ctx, page } = await open()
      await setMockDelay(8000)
      await page.focus('[data-testid=run]'); await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid=cancel]')
      await page.focus('[data-testid=cancel]'); await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid=halted]')
      await page.waitForTimeout(200)
      focus['after Cancel by keyboard'] = await active(page)
      await page.screenshot({ path: path.join(OUT, `focus-cancel-${LABEL}.png`), clip: { x: 0, y: 0, width: 1440, height: 330 } })
      await setMockDelay(0)
      await page.focus('[data-testid=halted] button'); await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid=halted]', { state: 'detached' })
      await page.waitForTimeout(300)
      focus['after Retry by keyboard'] = await active(page)
      await page.screenshot({ path: path.join(OUT, `focus-retry-${LABEL}.png`), clip: { x: 0, y: 0, width: 1440, height: 330 } })
      await ready(page)
      await page.focus('[data-testid=time-range]'); await page.keyboard.press('Enter')
      await page.waitForSelector('role=dialog[name="Time range"]')
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
      await page.waitForSelector('role=dialog[name="Time range"]', { state: 'detached' })
      await page.waitForTimeout(300)
      focus['after choosing a time preset by keyboard'] = await active(page)
      await page.screenshot({ path: path.join(OUT, `focus-time-preset-${LABEL}.png`), clip: { x: 0, y: 0, width: 1440, height: 330 } })
      await page.goto(url(Q_RATE, '&step=500ms')); await page.waitForSelector('[data-testid=error-fix]')
      await page.focus('[data-testid=error-fix]'); await page.keyboard.press('Enter')
      await page.waitForTimeout(400)
      focus['after "Run the query again" by keyboard'] = await active(page)
      await page.screenshot({ path: path.join(OUT, `focus-run-again-${LABEL}.png`), clip: { x: 0, y: 0, width: 1440, height: 330 } })
      await ctx.close()
    }
    // ---- focus: closing the palette and settings, switching the form with T while focus is in
    // the table, and isolating a series then showing all of them (the button removes itself).
    {
      const { ctx, page } = await open()
      const top = (name) => page.screenshot({ path: path.join(OUT, `${name}-${LABEL}.png`), clip: { x: 0, y: 0, width: 1440, height: 330 } })
      await page.focus('[data-testid=open-commands]'); await page.keyboard.press('Enter')
      await page.waitForSelector('dialog[open]'); await page.waitForTimeout(200)
      await page.keyboard.press('Escape'); await page.waitForTimeout(300)
      focus['after closing the command palette with Escape'] = await active(page)
      await top('focus-palette-closed')
      await page.focus('[data-testid=open-settings]'); await page.keyboard.press('Enter')
      await page.waitForSelector('dialog[open]'); await page.waitForTimeout(200)
      await page.keyboard.press('Escape'); await page.waitForTimeout(300)
      focus['after closing settings with Escape'] = await active(page)
      await top('focus-settings-closed')
      await page.click('[data-testid=view-table]'); await page.waitForSelector('[data-testid=result-table] tbody tr')
      await page.focus('[data-testid=result-table] .th-button'); await page.keyboard.press('t')
      await page.waitForSelector('[data-testid=text-view] pre'); await page.waitForTimeout(300)
      focus['after T (table to text) with focus on a table column head'] = await active(page)
      await top('focus-view-switch')
      await page.keyboard.press('t'); await page.waitForSelector('[data-testid=chart] canvas'); await page.waitForTimeout(300)
      await page.focus('[data-testid=legend] button.series-toggle'); await page.keyboard.press('Enter')
      await page.waitForTimeout(300)
      focus['after isolating a series by keyboard'] = await active(page)
      await page.focus('[data-testid=legend] button:has-text("Show all series")'); await page.keyboard.press('Enter')
      await page.waitForTimeout(300)
      focus['after "Show all series" by keyboard (the button goes away)'] = await active(page)
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: path.join(OUT, `focus-show-all-${LABEL}.png`), clip: { x: 0, y: 0, width: 1440, height: 900 } })
      await ctx.close()
    }
    await browser.close()
  } finally {
    await setMockDelay(0).catch(() => {})
    stop()
  }
  fs.writeFileSync(path.join(OUT, `focus-${LABEL}.json`), JSON.stringify(focus, null, 2) + '\n')
  console.log(JSON.stringify(focus, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })
