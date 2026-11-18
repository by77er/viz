/* eslint-disable */
// Measures the design system's speed budgets on a built app, against the mock.
//   node e2e/measure.cjs [--root <app dir>] [--label after] [--runs 20] [--append]
// Reference setup, as far as it exists: Chromium, CPU throttled 4x (CDP
// Emulation.setCPUThrottlingRate), network shaped to DevTools' "Fast 4G" (9 Mbit/s down,
// 1.5 Mbit/s up, 165 ms round trip), 1440x900, a fresh browser context per run, the 75th
// percentile of the runs. The fixture dashboard the rules name does not exist yet, so the
// page is Explore with a four-series query over a fixed three-hour window.
// The same script measures the app before the restyle (--root pointing at a copy of the old
// app with its dist/): the selectors it uses are the test ids both versions share.
//
// What each number is:
// A press is a real one: pointerdown, held until the pressed frame has been produced (at
// least 60 ms), then pointerup. Sending both at once would fold the click's work into the
// frame that is supposed to show the press.
//   press       pointerdown on "Run query" -> end of the first frame after it (the frame that
//               shows the pressed fill). Event Timing reports the same thing in 8 ms steps.
//   busy        pointerup (the click) -> aria-busy="true" on the button is in a painted frame
//               (after only: the old app had no busy state)
//   toggle x→y  pointerup on the segment -> end of the first frame in which the new form is
//               in the document and visible (for the chart: its canvas, drawn before that frame)
//   picker      pointerup on the time range button -> the popover is in a painted frame
//   response    the query_range body has arrived in the page -> end of the last frame of the
//               burst of changes to the result panel that follows (see instrument())
//   inp         the longest Event Timing duration of any interaction in the run
//   cls         layout-shift entries summed: "load" from navigation until the result has
//               settled; "run" from the press on Run query until the new result has settled.
//               The standard metric ignores shifts within 500 ms of input, which would hide a
//               shift caused by the result arriving, so the run figure is given both ways.
const path = require('node:path')
const fs = require('node:fs')
const zlib = require('node:zlib')
const lib = require('./lib.cjs')
const { chromium, url, Q_RATE } = lib

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback }
const ROOT = path.resolve(arg('root', lib.ROOT))
const LABEL = arg('label', 'after')
const RUNS = Number(arg('runs', '20'))
const FAST_4G = { offline: false, latency: 165, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 }

const p75 = (xs) => { const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(0.75 * s.length) - 1)] : null }
const median = (xs) => { const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }

// Runs in the page before any of its scripts.
function instrument() {
  const m = (window.__m = { shifts: [], events: [], resp: null, respPaint: null, rec: null })
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) m.shifts.push({ value: e.value, recent: e.hadRecentInput, t: e.startTime }) }).observe({ type: 'layout-shift', buffered: true })
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) m.events.push({ name: e.name, duration: e.duration, delay: e.processingStart - e.startTime, t: e.startTime }) }).observe({ type: 'event', durationThreshold: 16, buffered: true })
  } catch {}
  const afterFrame = (fn) => requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => fn(performance.now()); ch.port2.postMessage(0) })
  // When the query_range body has arrived.
  const realFetch = window.fetch
  window.fetch = async (...a) => {
    const res = await realFetch(...a)
    if (String(a[0] && a[0].url ? a[0].url : a[0]).includes('query_range')) res.clone().text().then(() => { m.resp = performance.now() })
    return res
  }
  // The result is painted when the burst of DOM changes that follows the response has been
  // drawn: the end of the last frame in which the result panel changed, the burst being over
  // once 250 ms pass without a change. (The old app adds its chart canvas one frame after the
  // rest of the result; the new one redraws the existing canvas in the same frame as the text.
  // Counting the whole burst treats both the same.)
  let quiet = null
  new MutationObserver((records) => {
    if (m.resp === null || m.respPaint !== null) return
    const panel = document.querySelector('section[aria-label="Query result"], [data-testid=result]')
    if (!panel || !records.some((r) => panel.contains(r.target))) return
    const resp = m.resp
    afterFrame((t) => { m.lastChange = t - resp })
    clearTimeout(quiet)
    quiet = setTimeout(() => { m.respPaint = m.lastChange; if (m.rec) m.rec.resultAt = performance.now() }, 250)
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
  /** Arm a one-shot measurement of the next pointerdown. `done` is a selector, or 'result'. */
  m.arm = (done) => {
    const rec = (m.rec = { t0: null, tUp: null, press: null, busy: null, done: null, resultAt: null, shiftFrom: performance.now() })
    m.resp = null; m.respPaint = null
    window.addEventListener('pointerdown', (e) => {
      rec.t0 = e.timeStamp
      afterFrame((t) => { rec.press = t - rec.t0 })
    }, { capture: true, once: true })
    window.addEventListener('pointerup', (e) => {
      rec.tUp = e.timeStamp
      let busySeen = false
      const visible = (sel) => { const el = document.querySelector(sel); return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' }
      const poll = () => {
        const run = document.querySelector('[data-testid=run]')
        if (!busySeen && run && run.getAttribute('aria-busy') === 'true') { busySeen = true; afterFrame((t) => { rec.busy = t - rec.tUp }) }
        const ok = done === 'result' ? rec.resultAt !== null : visible(done)
        if (ok) afterFrame((t) => { rec.done = t - rec.tUp })
        else requestAnimationFrame(poll)
      }
      poll()
    }, { capture: true, once: true })
  }
}

async function click(page, selector, done) {
  await page.evaluate((d) => window.__m.arm(d), done)
  const box = await page.locator(selector).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(150) // let the hover transition finish: the press is measured alone
  await page.mouse.down()
  await Promise.all([page.waitForFunction(() => window.__m.rec.press !== null), page.waitForTimeout(60)])
  await page.mouse.up()
  await page.waitForFunction(() => window.__m.rec.done !== null, null, { timeout: 30000 })
  return page.evaluate(() => ({ ...window.__m.rec, respPaint: window.__m.respPaint }))
}

function bytes(root) {
  const dist = path.join(root, 'dist')
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
  const size = (f) => { const b = fs.readFileSync(path.join(dist, f)); return { raw: b.length, gzip: zlib.gzipSync(b, { level: 9 }).length } }
  const sum = (list) => list.reduce((a, f) => { const s = size(f); return { raw: a.raw + s.raw, gzip: a.gzip + s.gzip } }, { raw: 0, gzip: 0 })
  const initialJs = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1])
  const css = [...html.matchAll(/href="\/(assets\/[^"]+\.css)"/g)].map((m) => m[1])
  const all = fs.readdirSync(path.join(dist, 'assets')).map((f) => `assets/${f}`)
  const lazyJs = all.filter((f) => f.endsWith('.js') && !initialJs.includes(f))
  const fonts = all.filter((f) => /\.woff2?$/.test(f))
  return { initialJs: sum(initialJs), lazyJs: sum(lazyJs), css: sum(css), html: size('index.html'), fonts: { raw: sum(fonts).raw, files: fonts.length } }
}

async function main() {
  const stop = await lib.startServers(ROOT)
  const runs = []
  try {
    const browser = await chromium.launch()
    for (let i = 0; i < RUNS; i++) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
      const page = await ctx.newPage()
      await page.addInitScript(instrument)
      const cdp = await ctx.newCDPSession(page)
      await cdp.send('Network.enable')
      await cdp.send('Network.emulateNetworkConditions', FAST_4G)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })

      // ---- first load
      await page.goto(url(Q_RATE))
      await page.waitForSelector('[data-testid=legend] tbody tr')
      await page.waitForSelector('[data-testid=chart] canvas')
      await page.waitForSelector('.cm-content')
      await page.waitForTimeout(1200)
      const r = { clsLoad: await page.evaluate(() => window.__m.shifts.reduce((a, s) => a + s.value, 0)) }
      const hasTable = !!(await page.$('[data-testid=view-table]'))

      // ---- run a query
      const run = await click(page, '[data-testid=run]', 'result')
      await page.waitForTimeout(700)
      r.press = run.press
      r.busy = run.busy
      r.response = run.respPaint
      const shifts = await page.evaluate((from) => window.__m.shifts.filter((s) => s.t >= from), run.shiftFrom)
      r.clsRun = shifts.filter((s) => !s.recent).reduce((a, s) => a + s.value, 0)
      r.clsRunAll = shifts.reduce((a, s) => a + s.value, 0)

      // ---- local changes
      if (hasTable) {
        r.chartToTable = (await click(page, '[data-testid=view-table]', '[data-testid=result-table] tbody tr')).done
        r.tableToText = (await click(page, '[data-testid=view-text]', '[data-testid=text-view] pre')).done
      } else {
        r.chartToText = (await click(page, '[data-testid=view-text]', '[data-testid=text-view] pre')).done
      }
      r.textToChart = (await click(page, '[data-testid=view-chart]', '[data-testid=chart] canvas')).done
      r.picker = (await click(page, '[data-testid=time-range]', '[role=dialog][aria-label="Time range"]')).done
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)

      const ev = await page.evaluate(() => window.__m.events)
      r.inp = ev.length ? Math.max(...ev.map((e) => e.duration)) : 16 // nothing reached the 16 ms reporting floor
      r.inpEvent = ev.length ? ev.reduce((a, e) => (e.duration > a.duration ? e : a)).name : '(all under 16 ms)'
      r.inputDelay = ev.length ? Math.max(...ev.map((e) => e.delay)) : 0
      runs.push(r)
      console.log(`run ${i + 1}/${RUNS}  ` + Object.entries(r).map(([k, v]) => `${k}=${typeof v === 'number' ? (k.startsWith('cls') ? v.toFixed(4) : v.toFixed(0)) : v}`).join(' '))
      await ctx.close()
    }
    await browser.close()
  } finally {
    stop()
  }

  // --append adds these runs to the label's earlier ones, so that two builds can be measured
  // in alternating batches when the machine's load drifts.
  const file = path.join(lib.ROOT, 'e2e', 'measurements', `${LABEL}.json`)
  if (process.argv.includes('--append') && fs.existsSync(file)) runs.unshift(...JSON.parse(fs.readFileSync(file, 'utf8')).raw)

  const keys = ['press', 'busy', 'chartToTable', 'tableToText', 'chartToText', 'textToChart', 'picker', 'response', 'inp', 'inputDelay', 'clsLoad', 'clsRun', 'clsRunAll']
  const summary = {}
  for (const k of keys) {
    const xs = runs.map((r) => r[k])
    if (xs.every((x) => x == null)) continue
    summary[k] = { p75: p75(xs), median: median(xs), max: Math.max(...xs.filter((x) => x != null)) }
  }
  const out = { label: LABEL, root: ROOT, when: new Date().toISOString(), runs: runs.length, setup: 'Chromium, CPU 4x, Fast 4G, 1440x900, fresh context per run', summary, bytes: bytes(ROOT), raw: runs }
  const dir = path.join(lib.ROOT, 'e2e', 'measurements')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${LABEL}.json`), JSON.stringify(out, null, 2) + '\n')
  console.log(`\n${LABEL}: 75th percentile of ${runs.length} runs (median, max)`)
  for (const [k, v] of Object.entries(summary)) {
    const f = (x) => (k.startsWith('cls') ? x.toFixed(4) : `${x.toFixed(0)} ms`)
    console.log(`  ${k.padEnd(14)} ${f(v.p75).padStart(9)}   (${f(v.median)}, ${f(v.max)})`)
  }
  console.log('  bytes', JSON.stringify(out.bytes))
}

main().catch((e) => { console.error(e); process.exit(1) })
