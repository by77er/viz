/* eslint-disable */
// States images and a few timings of the interactions density changes, for one build.
//   node states.cjs <label> <dist dir> <out dir>
// States (both themes; 1440 fine, 400 coarse in Blink): the range control open; the panel's commands open (C: its Actions menu;
// B: the text form opened from the head; baseline: the text form disclosure opened); focus on the first control of the bar (fine).
// Timings (5 runs each, 4x CPU slowdown, indication only): input to the next frame painted for opening the range control and a
// panel's commands; first data mark painted after navigation to the 12-panel dashboard; layout shift of a load scrolled to the
// "CPU by pod" chart (as a reload lands). The machine's 1-minute load average is recorded with every run.
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')
const http = require('node:http')
const { chromium } = require('playwright')
const WT = '/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/wt-density'
const [label, distDir, outDir] = process.argv.slice(2)
const APP_PORT = 8862, MOCK_PORT = 8863
const APP = `http://127.0.0.1:${APP_PORT}`, MOCK = `http://127.0.0.1:${MOCK_PORT}`
const T0 = Date.UTC(2026, 10, 18, 9, 30), T1 = Date.UTC(2026, 10, 18, 12, 30)
const DASH = `/dashboards?id=services_overview&from=${T0}&to=${T1}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ping = (u) => new Promise((res) => { const q = http.get(u, (r) => { r.resume(); res(r.statusCode) }); q.on('error', () => res(0)); q.setTimeout(3000, () => { q.destroy(); res(-1) }) })
async function waitFor(u, ms = 30000) { const t = Date.now(); while (Date.now() - t < ms) { if (await ping(u)) return true; await sleep(200) } return false }
const settled = (page) => page.waitForFunction(() => document.querySelectorAll('[data-testid=panel]').length >= 12 && !document.querySelector('[data-testid=panel][data-state=waiting], [data-testid=panel][data-state=idle]'), null, { timeout: 30000 })
const COARSE = '--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1'

// Opening the range control: B/C have one button; the baseline's range controls are always open (nothing to press).
async function openRange(page) { const b = await page.$('[data-testid=range-button]'); if (!b) return false; await b.click(); await page.waitForSelector('.vz-popover[data-open]'); return true }
async function openPanel(page) {
  const sel = '[data-panel=rate_by_service]'
  if (await page.$(`${sel} [data-testid=panel-actions]`)) { await page.click(`${sel} [data-testid=panel-actions]`); await page.waitForSelector(`${sel} .vz-menu[data-open]`); return 'actions menu' }
  if (await page.$(`${sel} [data-testid=panel-text-toggle]`)) { await page.click(`${sel} [data-testid=panel-text-toggle]`); await page.waitForSelector(`${sel} [data-testid=panel-digest]`); return 'text form' }
  await page.click(`${sel} [data-testid=panel-text] summary`); await page.waitForSelector(`${sel} [data-testid=panel-digest]`); return 'text form'
}

// Input to next paint, measured in the page: from the pointerdown's timestamp to the second rAF after it (the frame that shows the change).
async function inputToPaint(page, selector) {
  await page.evaluate((sel) => {
    window.__t = null
    const el = document.querySelector(sel)
    el.addEventListener('click', (e) => { const t0 = e.timeStamp; requestAnimationFrame(() => requestAnimationFrame((t) => { window.__t = performance.now() - t0 })) }, { once: true, capture: true })
  }, selector)
  await page.click(selector)
  await page.waitForFunction(() => window.__t !== null)
  return page.evaluate(() => window.__t)
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true })
  const procs = []
  const start = (args, cwd, env = {}) => { const p = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } }); p.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`)); procs.push(p); return p }
  const stop = () => procs.forEach((p) => { try { p.kill('SIGTERM') } catch {} })
  process.on('exit', stop)
  start(['--import', 'tsx', 'mock/server.ts', '--port', String(MOCK_PORT)], path.join(WT, 'app'))
  start(['node_modules/vite/bin/vite.js', 'preview', '--port', String(APP_PORT), '--host', '127.0.0.1', '--outDir', path.resolve(distDir), '--strictPort'], path.join(WT, 'app'), { VIZ_API_TARGET: MOCK })
  if (!(await waitFor(`${MOCK}/__mock/delay`)) || !(await waitFor(APP))) { stop(); throw new Error('servers did not start') }
  const fine = await chromium.launch(), coarse = await chromium.launch({ args: [COARSE] })
  const timings = { label, cores: os.cpus().length, runs: [] }
  try {
    for (const L of [{ n: '1440-fine', w: 1440, h: 900, c: false }, { n: '400-coarse', w: 400, h: 800, c: true }]) {
      for (const theme of ['light', 'dark']) {
        const ctx = await (L.c ? coarse : fine).newContext({ viewport: { width: L.w, height: L.h }, colorScheme: theme, ...(L.c ? { isMobile: true } : {}) })
        const page = await ctx.newPage()
        await page.goto(APP + DASH); await settled(page); await page.evaluate(() => document.fonts.ready); await sleep(300)
        if (await openRange(page)) { await sleep(250); await page.screenshot({ path: path.join(outDir, `${label}-range-open-${L.n}-${theme}.png`) }); await page.keyboard.press('Escape'); await sleep(200) }
        const what = await openPanel(page)
        await page.evaluate(() => { const p = document.querySelector('[data-panel=rate_by_service]'); window.scrollTo(0, p.getBoundingClientRect().top + scrollY - 60) })
        await sleep(300)
        await page.screenshot({ path: path.join(outDir, `${label}-panel-commands-${L.n}-${theme}.png`) })
        console.log(`${L.n} ${theme}: range ${(await page.$('[data-testid=range-button]')) ? 'opened' : 'always shown'}; panel: ${what}`)
        if (!L.c) {
          await page.keyboard.press('Escape'); await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement && document.activeElement.blur() })
          const first = (await page.$('[data-testid=range-button]')) ? '[data-testid=range-button]' : '[data-testid=preset-15m]'
          await page.focus(first); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); await sleep(150)
          await page.screenshot({ path: path.join(outDir, `${label}-focus-range-${L.n}-${theme}.png`) })
        }
        await ctx.close()
      }
      // Timings, light theme, 4x CPU slowdown.
      for (let run = 0; run < 5; run++) {
        const ctx = await (L.c ? coarse : fine).newContext({ viewport: { width: L.w, height: L.h }, ...(L.c ? { isMobile: true, hasTouch: false } : {}) })
        const page = await ctx.newPage()
        const cdp = await ctx.newCDPSession(page)
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
        const load = os.loadavg()[0]
        const t0 = Date.now()
        await page.goto(APP + DASH)
        await page.waitForSelector('.vz-stat-value:not(.is-reserved *)', { timeout: 60000 })
        const firstMark = await page.evaluate(() => performance.now())
        await settled(page)
        const all = await page.evaluate(() => performance.now())
        const r = { layout: L.n, run, load: +load.toFixed(2), firstStatMs: Math.round(firstMark), allPanelsMs: Math.round(all) }
        if (await page.$('[data-testid=range-button]')) { r.openRangeMs = Math.round(await inputToPaint(page, '[data-testid=range-button]')); await page.keyboard.press('Escape'); await sleep(100) }
        const ps = (await page.$('[data-panel=rate_by_service] [data-testid=panel-actions]')) ? '[data-panel=rate_by_service] [data-testid=panel-actions]' : (await page.$('[data-panel=rate_by_service] [data-testid=panel-text-toggle]')) ? '[data-panel=rate_by_service] [data-testid=panel-text-toggle]' : '[data-panel=rate_by_service] [data-testid=panel-text] summary'
        await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), ps); await sleep(200)
        r.openPanelCommandsMs = Math.round(await inputToPaint(page, ps))
        // A reload while scrolled to "CPU by pod": the layout shift it causes, every entry counted.
        await page.evaluate(() => { const p = document.querySelector('[data-panel=cpu]'); window.scrollTo(0, p.getBoundingClientRect().top + scrollY - 40) })
        await sleep(300)
        const before = await page.evaluate(() => document.querySelector('[data-panel=cpu]').getBoundingClientRect().top)
        await page.addInitScript(() => { window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__cls += e.value }).observe({ type: 'layout-shift', buffered: true }) })
        await page.reload(); await settled(page); await sleep(1200)
        r.reloadShift = +(await page.evaluate(() => window.__cls)).toFixed(4)
        r.reloadLandedOffPx = Math.round((await page.evaluate(() => document.querySelector('[data-panel=cpu]').getBoundingClientRect().top)) - before)
        timings.runs.push(r)
        console.log(JSON.stringify(r))
        await ctx.close()
      }
    }
  } finally { await fine.close(); await coarse.close(); stop() }
  fs.writeFileSync(path.join(outDir, `${label}-timings.json`), JSON.stringify(timings, null, 1))
}
main().catch((e) => { console.error(e); process.exit(1) })
