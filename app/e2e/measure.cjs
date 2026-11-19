/* eslint-disable */
// Measures the design system's speed budgets on a built app, against the mock.
//   node e2e/measure.cjs [--root <app dir>] [--label after] [--runs 20] [--series 4,36,200] [--append]
// Reference setup, as far as it exists: Chromium, CPU throttled 4x (CDP
// Emulation.setCPUThrottlingRate), network shaped to DevTools' "Fast 4G" (9 Mbit/s down,
// 1.5 Mbit/s up, 165 ms round trip), 1440x900, a fresh browser context per run, the 75th
// percentile of the runs. The fixture dashboard the rules name does not exist yet, so the
// page is Explore over a fixed three-hour window, once per case of --series:
//   4    sum by (service) of the request rate, from the mock
//   36   sum by (service, route, status), from the mock
//   200  viz_synthetic_series: 200 slow sines. Until 2026-11-19 this script synthesised them and
//        answered through Playwright's request interception; the mock now holds them (and
//        real/seed.ts writes them to the real API), so the body comes over the shaped network,
//        gzip-compressed as the real API sends it, like the other two cases. The mock is always
//        this checkout's (lib.startServers), so every build under test gets the same bytes.
// Every run records the machine's load average (1 minute) at its start and end: the machine
// is shared, and a figure means little without it.
// With one case the file is e2e/measurements/<label>.json as before; with several, each case
// is written to <label>-<series>.json.
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
//               burst of changes to the result panel that follows (see instrument()). "Arrived"
//               is when this script's copy of the body (res.clone().text()) resolves, and that
//               is AFTER the app has read and parsed its own copy (checked: the app's text()
//               resolves first and its JSON.parse runs before the clone's callback), so this
//               figure leaves out reading and parsing the body. Kept for comparison with earlier files.
//   responseFull  the last byte of the response (Resource Timing responseEnd of the
//               query_range request) -> the same paint. This one includes decoding and parsing
//               the body: 3.6 MB of JSON for 200 series.
//   inp         the longest Event Timing duration of any interaction in the run, before the
//               typing and crosshair steps (comparable with earlier files); inpAll includes them
//   crosshair   30 pointer moves across the plot, one at a time: mousemove -> end of the next
//               frame (the frame with the crosshair and the readout). The run's figure is the
//               75th percentile of its moves; crosshairWorst is its slowest move.
//   typing      a 60-character query typed into the emptied editor one key at a time, with a
//               result on screen: keydown -> end of the next frame (the frame that shows the
//               character). The next key is sent only after that frame, so keys never queue.
//               typing is the 75th percentile of the run's 60 keys, typingWorst the slowest
//               key, typingOver the number of keys over 50 ms. The summary also pools every
//               key of every run (typingKeys).
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
const CASES = arg('series', '4').split(',').map(Number)
/** 60 characters, typed one key at a time. */
const TYPED = 'sum by (route) (rate(http_requests_total{status="500"}[5m]))'
const Q_SYNTH = 'viz_synthetic_series'
const QUERIES = { 4: Q_RATE, 36: lib.Q_MANY, 200: Q_SYNTH }
/** --skip typing,crosshair: leave those steps out (for quicker comparisons of candidates). */
const SKIP = new Set(arg('skip', '').split(',').filter(Boolean))
const os = require('node:os')
const FAST_4G = { offline: false, latency: 165, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 }

const p75 = (xs) => { const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(0.75 * s.length) - 1)] : null }
const median = (xs) => { const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }

// Runs in the page before any of its scripts.
function instrument() {
  const m = (window.__m = { shifts: [], events: [], resp: null, respPaint: null, respFull: null, rec: null })
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
    afterFrame((t) => { m.lastChange = t - resp; m.lastPaintAt = t })
    clearTimeout(quiet)
    quiet = setTimeout(() => {
      m.respPaint = m.lastChange
      const entries = performance.getEntriesByType('resource').filter((e) => e.name.includes('query_range'))
      const last = entries[entries.length - 1]
      m.respFull = last && last.responseEnd > 0 ? m.lastPaintAt - last.responseEnd : null
      if (m.rec) m.rec.resultAt = performance.now()
    }, 250)
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
  /** Record every mousemove (crosshair) or keydown (typing) until the frame that follows it. */
  m.moves = []; m.keys = []
  m.watch = (type, into) => {
    const on = (e) => { const t0 = e.timeStamp; afterFrame((t) => { m[into].push(t - t0) }) }
    window.addEventListener(type, on, { capture: true })
    return () => window.removeEventListener(type, on, { capture: true })
  }
  /** Arm a one-shot measurement of the next pointerdown. `done` is a selector, or 'result'. */
  m.arm = (done) => {
    const rec = (m.rec = { t0: null, tUp: null, press: null, busy: null, done: null, resultAt: null, shiftFrom: performance.now() })
    m.resp = null; m.respPaint = null; m.respFull = null
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
  return page.evaluate(() => ({ ...window.__m.rec, respPaint: window.__m.respPaint, respFull: window.__m.respFull }))
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

async function measureCase(browser, SERIES) {
  const runs = []
  {
    for (let i = 0; i < RUNS; i++) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
      const page = await ctx.newPage()
      await page.addInitScript(instrument)
      const cdp = await ctx.newCDPSession(page)
      await cdp.send('Network.enable')
      await cdp.send('Network.emulateNetworkConditions', FAST_4G)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
      const load1 = os.loadavg()[0]

      // ---- first load
      await page.goto(url(QUERIES[SERIES]))
      await page.waitForSelector('[data-testid=legend] tbody tr')
      await page.waitForSelector('[data-testid=chart] canvas')
      await page.waitForSelector('.cm-content')
      await page.waitForTimeout(1200)
      const r = { load1, clsLoad: await page.evaluate(() => window.__m.shifts.reduce((a, s) => a + s.value, 0)) }
      const hasTable = !!(await page.$('[data-testid=view-table]'))

      // ---- run a query
      const run = await click(page, '[data-testid=run]', 'result')
      await page.waitForTimeout(700)
      r.press = run.press
      r.busy = run.busy
      r.response = run.respPaint
      r.responseFull = run.respFull
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

      if (SKIP.has('crosshair') && SKIP.has('typing')) {
        r.loadEnd = os.loadavg()[0]
        runs.push(r)
        console.log(`[${SERIES} series] run ${i + 1}/${RUNS}  ` + Object.entries(r).filter(([k]) => k !== 'keys').map(([k, v]) => `${k}=${typeof v === 'number' ? (k.startsWith('cls') ? v.toFixed(4) : k.startsWith('load') ? v.toFixed(1) : v.toFixed(0)) : v}`).join(' '))
        await ctx.close()
        continue
      }
      // ---- crosshair: 30 moves across the plot, each waited for
      const over = await page.locator('[data-testid=chart] .u-over').boundingBox()
      await page.mouse.move(over.x + over.width * 0.1, over.y + over.height * 0.5)
      await page.waitForTimeout(200)
      await page.evaluate(() => { window.__m.moves = []; window.__m.unwatch = window.__m.watch('mousemove', 'moves') })
      for (let k = 1; k <= 30; k++) {
        await page.mouse.move(over.x + over.width * (0.1 + 0.8 * (k / 30)), over.y + over.height * (0.3 + 0.4 * ((k % 5) / 5)))
        await page.waitForFunction((n) => window.__m.moves.length >= n, k)
      }
      const moves = await page.evaluate(() => { window.__m.unwatch(); return window.__m.moves })
      r.crosshair = p75(moves)
      r.crosshairWorst = Math.max(...moves)
      await page.mouse.move(2, 2)

      // ---- typing: 60 keys into the emptied editor, each waited for
      await page.click('.cm-content')
      await page.keyboard.press('Control+a')
      await page.keyboard.press('Delete')
      await page.waitForTimeout(300)
      await page.evaluate(() => { window.__m.keys = []; window.__m.unwatch = window.__m.watch('keydown', 'keys') })
      for (let k = 0; k < TYPED.length; k++) {
        await page.keyboard.type(TYPED[k])
        await page.waitForFunction((n) => window.__m.keys.length >= n, k + 1)
        await page.waitForTimeout(40)
      }
      const keys = await page.evaluate(() => { window.__m.unwatch(); return window.__m.keys })
      r.typing = p75(keys)
      r.typingWorst = Math.max(...keys)
      r.typingOver = keys.filter((x) => x > 50).length
      r.keys = keys.map((x) => Math.round(x * 10) / 10)
      const evAll = await page.evaluate(() => window.__m.events)
      r.inpAll = evAll.length ? Math.max(...evAll.map((e) => e.duration)) : 16
      r.loadEnd = os.loadavg()[0]
      runs.push(r)
      console.log(`[${SERIES} series] run ${i + 1}/${RUNS}  ` + Object.entries(r).filter(([k]) => k !== 'keys').map(([k, v]) => `${k}=${typeof v === 'number' ? (k.startsWith('cls') ? v.toFixed(4) : k.startsWith('load') ? v.toFixed(1) : v.toFixed(0)) : v}`).join(' '))
      await ctx.close()
    }
  }

  // --append adds these runs to the label's earlier ones, so that two builds can be measured
  // in alternating batches when the machine's load drifts.
  const name = CASES.length > 1 ? `${LABEL}-${SERIES}` : LABEL
  const file = path.join(lib.ROOT, 'e2e', 'measurements', `${name}.json`)
  if (process.argv.includes('--append') && fs.existsSync(file)) runs.unshift(...JSON.parse(fs.readFileSync(file, 'utf8')).raw)

  const keys = ['load1', 'loadEnd', 'press', 'busy', 'chartToTable', 'tableToText', 'chartToText', 'textToChart', 'picker', 'response', 'responseFull', 'inp', 'inputDelay', 'crosshair', 'crosshairWorst', 'typing', 'typingWorst', 'typingOver', 'inpAll', 'clsLoad', 'clsRun', 'clsRunAll']
  const summary = {}
  for (const k of keys) {
    const xs = runs.map((r) => r[k])
    if (xs.every((x) => x == null)) continue
    summary[k] = { p75: p75(xs), median: median(xs), max: Math.max(...xs.filter((x) => x != null)), min: Math.min(...xs.filter((x) => x != null)) }
  }
  const allKeys = runs.flatMap((r) => r.keys || [])
  if (allKeys.length) summary.typingKeys = { p75: p75(allKeys), median: median(allKeys), max: Math.max(...allKeys), count: allKeys.length, over50: allKeys.filter((x) => x > 50).length }
  const out = { label: LABEL, series: SERIES, query: QUERIES[SERIES], root: ROOT, when: new Date().toISOString(), runs: runs.length, setup: 'Chromium, CPU 4x, Fast 4G, 1440x900, fresh context per run', summary, bytes: bytes(ROOT), raw: runs }
  const dir = path.join(lib.ROOT, 'e2e', 'measurements')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
  console.log(`\n${name}: ${SERIES} series, 75th percentile of ${runs.length} runs (median, max)`)
  for (const [k, v] of Object.entries(summary)) {
    const f = (x) => (k.startsWith('cls') ? x.toFixed(4) : k.startsWith('load') ? x.toFixed(1) : k === 'typingOver' ? `${x.toFixed(0)} keys` : `${x.toFixed(0)} ms`)
    console.log(`  ${k.padEnd(14)} ${f(v.p75).padStart(9)}   (${f(v.median)}, ${f(v.max)})`)
  }
  console.log('  bytes', JSON.stringify(out.bytes))
}

async function main() {
  const stop = await lib.startServers(ROOT)
  try {
    const browser = await chromium.launch()
    for (const SERIES of CASES) {
      if (!QUERIES[SERIES]) throw new Error(`--series: no case for ${SERIES} (use 4, 36 or 200)`)
      await measureCase(browser, SERIES)
    }
    await browser.close()
  } finally {
    stop()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
