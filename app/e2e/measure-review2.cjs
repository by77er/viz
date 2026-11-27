/* eslint-disable */
// The two interaction paths the fixes for the second design review touch, measured once each
// at both layouts (design-system/reviews/app-v9/response.md): pressing "Show 50 more" under
// the table of 200 series (ResultTable: the row of controls now stands in a stack), and
// pressing "Copy link" in Explore's head (a new control). Not a before/after series.
//
//   node e2e/measure-review2.cjs            20 runs at the desktop layout, then 20 at the phone's
//
// The reference setup of e2e/measure.cjs: Chromium, CPU slowed 4x, Fast 4G, the built app on
// the mock, a fresh context per run; 1440 x 900 with a mouse, 400 x 800 with touch (device
// scale 2). Each time runs from the input's own timestamp (the click the release makes) to
// the end of the frame in which the result is on screen. Every run records the machine's
// 1-minute load when it started; a run above the core count is not judged.
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const lib = require('./lib.cjs')
const RUNS = Number(process.env.VIZ_RUNS || 20)
const CORES = os.cpus().length
const FAST_4G = { offline: false, latency: 165, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 }
const calibrate = () => { const t0 = performance.now(); let x = 0; for (let i = 0; i < 3e7; i++) x += Math.sqrt(i) % 7; return performance.now() - t0 }
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] }

/** In the page: time from the next click on `sel` to the end of the frame in which `done()` first holds. */
const arm = ([sel, what]) => {
  window.__t = null
  const done = what === 'rows' ? () => document.querySelectorAll('[data-testid=result-table] tbody tr').length >= 100 : () => document.querySelector(sel).textContent === 'Copied'
  document.querySelector(sel).addEventListener('click', (e) => {
    const t0 = e.timeStamp
    const poll = () => { if (done()) requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => { window.__t = performance.now() - t0 }; c.port2.postMessage(0) }); else requestAnimationFrame(poll) }
    poll()
  }, { capture: true, once: true })
}

async function main() {
  const calibration = [calibrate(), calibrate(), calibrate()].sort((a, b) => a - b)[1]
  const stop = await lib.startServers()
  const browser = await lib.chromium.launch()
  const out = { when: new Date().toISOString(), cores: CORES, calibrationMs: Math.round(calibration), runs: RUNS, layouts: {} }
  try {
    for (const [layout, options] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['phone', { viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }]]) {
      const rows = []
      for (let i = 0; i < RUNS; i++) {
        const ctx = await browser.newContext({ ...options, colorScheme: 'light' })
        await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: lib.APP })
        const page = await ctx.newPage()
        const cdp = await ctx.newCDPSession(page)
        await cdp.send('Network.enable')
        await cdp.send('Network.emulateNetworkConditions', FAST_4G)
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
        const load = os.loadavg()[0]
        await page.goto(lib.url('viz_synthetic_series', '&view=table'))
        await page.waitForSelector('[data-testid=table-more]')
        await page.waitForTimeout(1200)
        if (layout === 'phone' && !(await page.evaluate(() => matchMedia('(pointer: coarse)').matches))) throw new Error('the phone layout does not have a coarse pointer: the run is void')
        const press = async (sel, what) => {
          const target = page.locator(sel)
          await target.evaluate((b) => b.scrollIntoView({ block: 'center' }))
          await page.waitForTimeout(250)
          await page.evaluate(arm, [sel, what])
          const box = await target.boundingBox()
          const x = box.x + box.width / 2, y = box.y + box.height / 2
          if (layout === 'phone') {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
            await page.waitForTimeout(60)
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
          } else {
            await page.mouse.move(x, y)
            await page.waitForTimeout(150)
            await page.mouse.down()
            await page.waitForTimeout(60)
            await page.mouse.up()
          }
          await page.waitForFunction(() => window.__t !== null, null, { timeout: 30000 })
          return page.evaluate(() => window.__t)
        }
        rows.push({ load, more: await press('[data-testid=table-more]', 'rows'), copy: await press('[data-testid=copy-link]', 'copied') })
        await ctx.close()
        process.stdout.write(`\r${layout} ${i + 1}/${RUNS}`)
      }
      const judged = rows.filter((r) => r.load <= CORES)
      const row = (k) => ({ p75: Math.round(q(judged.map((r) => r[k]), 0.75)), median: Math.round(q(judged.map((r) => r[k]), 0.5)), worst: Math.round(Math.max(...judged.map((r) => r[k]))) })
      const loads = rows.map((r) => r.load)
      out.layouts[layout] = { judged: `${judged.length} of ${rows.length}`, load: { median: q(loads, 0.5), min: Math.min(...loads), max: Math.max(...loads) }, showMore: judged.length ? row('more') : null, copyLink: judged.length ? row('copy') : null, raw: rows }
      console.log(`\n${layout}: load ${out.layouts[layout].load.median.toFixed(1)} (${out.layouts[layout].load.min.toFixed(1)} to ${out.layouts[layout].load.max.toFixed(1)}), ${out.layouts[layout].judged} runs judged; "Show 50 more" to 100 rows painted ${JSON.stringify(out.layouts[layout].showMore)}; "Copy link" to "Copied" painted ${JSON.stringify(out.layouts[layout].copyLink)}`)
    }
  } finally {
    await browser.close()
    stop()
  }
  fs.writeFileSync(path.join(__dirname, 'measurements', 'review2-touched-paths.json'), JSON.stringify(out, null, 1))
}
main().catch((e) => { console.error(e); process.exit(1) })
