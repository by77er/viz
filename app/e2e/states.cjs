/* eslint-disable */
// Design-review images of states that design-system/tools/shots.mjs cannot reach (it opens a
// URL and waits for the network to be idle): waiting at 150 ms, 800 ms and 3 s, cancelled,
// pressed, busy, an invalid field, the focus ring on each kind of control, and the narrow
// view with a coarse pointer (with and without the hit areas drawn).
//   VIZ_E2E_APP_PORT=8840 VIZ_E2E_MOCK_PORT=8841 node e2e/states.cjs <outDir>
// Expects the app and the mock to be running on those ports. Same image settings as
// shots.mjs: both themes, 1440 and 400 px wide, device scale factor 2, named
// <state>-<theme>-<width>.png.
const path = require('node:path')
const fs = require('node:fs')
const lib = require('./lib.cjs')
const { chromium, url, Q_RATE, setMockDelay } = lib

const OUT = path.resolve(process.argv[2] || 'screenshots/states')
fs.mkdirSync(OUT, { recursive: true })

const ready = async (page) => {
  await page.waitForSelector('[data-testid=legend] tbody tr')
  await page.waitForSelector('[data-testid=chart] canvas')
  await page.evaluate(() => document.fonts.ready)
}
const open = async (browser, theme, width, extra = {}, height = 900) => {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: theme, ...extra })
  const page = await ctx.newPage()
  await page.goto(url(Q_RATE))
  await ready(page)
  return { ctx, page }
}
const shot = (page, name, theme, width, opts = {}) => page.screenshot({ path: path.join(OUT, `${name}-${theme}-${width}.png`), fullPage: true, ...opts })
/** A screenshot of the area around one element, so the ring and its surroundings are legible. */
async function around(page, selector, name, theme, pad = 48) {
  const el = page.locator(selector).first()
  await el.scrollIntoViewIfNeeded()
  const b = await el.boundingBox()
  const vp = page.viewportSize()
  const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad)
  await page.screenshot({ path: path.join(OUT, `${name}-${theme}-1440.png`), clip: { x, y, width: Math.min(vp.width - x, Math.min(b.width, 520) + 2 * pad), height: Math.min(vp.height - y, Math.min(b.height, 160) + 2 * pad) } })
}

async function main() {
  const browser = await chromium.launch()
  try {
    for (const theme of ['light', 'dark']) {
      for (const width of [1440, 400]) {
        // ---- waiting
        // The third wait is pictured 2.5 s in; the mock is given 6 s so that Cancel is still there to
        // press after a slow screenshot.
        for (const [name, delay, at] of [['waiting-150ms', 150, 90], ['waiting-800ms', 800, 620], ['waiting-3s', 6000, 2500]]) {
          const { ctx, page } = await open(browser, theme, width)
          await setMockDelay(delay)
          await page.click('[data-testid=run]')
          await page.mouse.move(0, 0)
          await page.waitForTimeout(at)
          await shot(page, name, theme, width)
          if (delay === 6000) {
            await page.click('[data-testid=cancel]')
            await page.waitForSelector('[data-testid=halted]')
            await page.mouse.move(0, 0)
            await shot(page, 'cancelled', theme, width)
          }
          await setMockDelay(0)
          await ctx.close()
        }
        // ---- an invalid field, and the legend with one series isolated
        const { ctx, page } = await open(browser, theme, width)
        await page.fill('[data-testid=step]', '15x')
        await page.keyboard.press('Enter')
        await page.click('[data-testid=legend] button[data-series=\'{service="checkout"}\']')
        await page.mouse.move(0, 0)
        await shot(page, 'invalid-step-isolated', theme, width)
        await ctx.close()
      }

      // ---- focus ring on each kind of control, pressed, hover (1440 only, clipped)
      const { ctx, page } = await open(browser, theme, 1440)
      const stops = [
        ['focus-nav-link', 'header a[href="/help"]'],
        ['focus-quiet-button', '[data-testid=open-settings]'],
        ['focus-primary-button', '[data-testid=run]'],
        ['focus-button', '[data-testid=time-range]'],
        ['focus-input', '[data-testid=step]'],
        ['focus-select', '[data-testid=unit]'],
        ['focus-segment', '[data-testid=view-table]'],
        ['focus-chart', '[data-testid=chart]'],
        ['focus-column-head', '[data-testid=legend] th button'],
        ['focus-legend-row', '[data-testid=legend] tbody button'],
      ]
      await page.keyboard.press('Tab') // keyboard modality, so :focus-visible applies
      for (const [name, sel] of stops) {
        await page.focus(sel)
        await around(page, sel, name, theme)
      }
      await page.click('.cm-content'); await page.keyboard.press('End')
      await around(page, '.query-well', 'focus-query-editor', theme)
      await page.focus('[data-testid=time-range]'); await page.keyboard.press('Enter')
      await page.waitForSelector('role=dialog[name="Time range"]')
      await around(page, 'role=dialog[name="Time range"]', 'focus-menu-item', theme, 24)
      await page.keyboard.press('Escape')
      await page.focus('[data-testid=open-settings]'); await page.keyboard.press('Enter')
      await page.waitForSelector('dialog.vz-dialog[open]')
      await page.focus('dialog[open] .vz-check input')
      await around(page, 'dialog[open] .vz-check', 'focus-checkbox', theme)
      await page.keyboard.press('Escape')
      await page.goto(url(lib.Q_BAD)); await page.waitForSelector('[data-testid=error-fix]')
      await page.keyboard.press('Tab'); await page.focus('[data-testid=error-fix]')
      await around(page, '[data-testid=error-state]', 'focus-error-action', theme, 24)
      await page.goto(url(Q_RATE)); await ready(page)
      for (const [name, sel] of [['pressed-primary-button', '[data-testid=run]'], ['pressed-segment', '[data-testid=view-text]'], ['pressed-button', '[data-testid=time-range]']]) {
        const b = await page.locator(sel).boundingBox()
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
        await page.waitForTimeout(200)
        await around(page, sel, name.replace('pressed', 'hover'), theme)
        await page.mouse.down()
        await around(page, sel, name, theme)
        await page.mouse.move(0, 0); await page.mouse.up()
      }
      await ctx.close()

      // ---- coarse pointer, narrow: as drawn, and with every control's hit area outlined
      for (const [state, go] of [['coarse', async (p) => {}], ['coarse-time-picker', async (p) => { await p.tap('[data-testid=time-range]'); await p.waitForSelector('role=dialog[name="Time range"]') }]]) {
        // A tall viewport and no full-page capture: Chromium's full-page capture resets the device
        // emulation, and with it the coarse pointer.
        const c = await open(browser, theme, 400, { hasTouch: true, isMobile: true }, 2400)
        const whole = async (name) => {
          const h = await c.page.evaluate(() => Math.ceil(Math.max(document.querySelector('.page').getBoundingClientRect().bottom, document.querySelector('.popover')?.getBoundingClientRect().bottom ?? 0)))
          await c.page.screenshot({ path: path.join(OUT, `${name}-${theme}-400.png`), clip: { x: 0, y: 0, width: 400, height: Math.min(2400, h) } })
        }
        await go(c.page)
        await whole(state)
        await c.page.evaluate(() => {
          const pop = document.querySelector('.popover')
          for (const el of (pop || document).querySelectorAll('button, a[href], input, select, [role=menuitem], label.vz-check')) {
            if (el.getClientRects().length === 0 || el.classList.contains('app-skip')) continue
            const r = el.getBoundingClientRect()
            let w = r.width, h = r.height
            const a = getComputedStyle(el, '::after')
            if (a.content !== 'none' && a.content !== 'normal' && a.position === 'absolute') { w = Math.max(w, parseFloat(a.width)); h = Math.max(h, parseFloat(a.height)) }
            const o = document.createElement('div')
            // Review overlay only, drawn by this script: not part of the app.
            o.style.cssText = `position:absolute;z-index:99;pointer-events:none;box-sizing:border-box;border:1px dashed var(--ink);left:${r.left + scrollX + r.width / 2 - w / 2}px;top:${r.top + scrollY + r.height / 2 - h / 2}px;width:${w}px;height:${h}px`
            document.body.append(o)
          }
        })
        await whole(`${state}-hit-areas`)
        await c.ctx.close()
      }
    }
  } finally {
    await setMockDelay(0).catch(() => {})
    await browser.close()
  }
  console.log(`wrote ${fs.readdirSync(OUT).length} images to ${OUT}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
