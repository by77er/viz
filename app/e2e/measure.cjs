/* eslint-disable */
// Measures the design system's speed budgets on a built app, against the mock.
//   node e2e/measure.cjs [--root <app dir>] [--label after] [--runs 20] [--series 4,36,200] [--append] [--phone]
// --phone: the system's phone layout (400 x 800, coarse pointer, touch, device scale 2, as
// design-system/tools/speed.mjs sets it): presses are touches (CDP touchStart, held until the
// pressed frame, then touchEnd), the crosshair is a horizontal touch drag, and every control
// is scrolled into view before it is pressed. Files are then <label>-phone[-<series>].json.
// Load (design-system README, "Load"): every run records the 1-minute load average at its
// start and end, the file records the core count and a calibration task (the same loop as
// tools/speed.mjs, timed in Node before the runs, median of three), and a run whose starting
// load exceeded the core count is counted as "not judged" (summary.judgedRuns says how many were).
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
const PHONE = process.argv.includes('--phone')
const LAYOUT = PHONE ? { viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } }
const os = require('node:os')
const CORES = os.cpus().length
// The calibration task of design-system/tools/speed.mjs: the same loop, timed the same way.
const calibrate = () => { const t0 = performance.now(); let x = 0; for (let i = 0; i < 3e7; i++) x += Math.sqrt(i) % 7; return [performance.now() - t0, x] }
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
  // A worker that answers for the page (a candidate reads the matrix in one): the time its
  // message reaches the page stands in for "the body has arrived" (m.resp). The page cannot
  // see a worker's Resource Timing, so responseFull is not taken for it.
  const RealWorker = window.Worker
  if (RealWorker) window.Worker = class extends RealWorker {
    constructor(...a) { super(...a); this.addEventListener('message', () => { m.resp = performance.now(); m.viaWorker = true }) }
  }
  // The result is painted when the burst of DOM changes that follows the response has been
  // drawn: the end of the last frame in which the result panel changed, the burst being over
  // once 250 ms pass without a change. (The old app adds its chart canvas one frame after the
  // rest of the result; the new one redraws the existing canvas in the same frame as the text.
  // Counting the whole burst treats both the same.)
  // The burst is the one that starts after the last byte (Resource Timing responseEnd of the
  // query_range request; with a worker, after its message). Until 2026-11-19 it started when the
  // harness's own copy of the body (res.clone().text()) resolved; an app that reads the body
  // as it arrives can paint before that copy resolves, and the burst then started at the next
  // change of the panel, the age turning from "now" to "5 s" (measured: 5 s figures).
  m.frames = []
  new MutationObserver((records) => {
    if (!m.rec) return
    const panel = document.querySelector('section[aria-label="Query result"], [data-testid=result]')
    if (!panel || !records.some((r) => panel.contains(r.target))) return
    const t = performance.now()
    afterFrame((end) => m.frames.push({ t, end }))
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
  /** The paint of the result, once its burst is over: null while it may go on. */
  m.settle = () => {
    const entries = performance.getEntriesByType('resource').filter((e) => e.name.includes('query_range') && e.startTime >= m.rec.armedAt)
    const last = entries[entries.length - 1]
    const lastByte = last && last.responseEnd > 0 ? last.responseEnd : m.viaWorker ? m.resp : null
    if (lastByte === null || lastByte === undefined) return null
    const after = m.frames.filter((f) => f.t >= lastByte)
    if (after.length === 0) return null
    let k = 0
    while (k + 1 < after.length && after[k + 1].t - after[k].t <= 250) k++
    if (k === after.length - 1 && performance.now() - after[k].t < 250) return null
    const paintAt = after[k].end
    m.paintAt = paintAt
    return {
      full: m.viaWorker ? null : paintAt - lastByte,
      // The earlier figure, from when the harness's copy of the body resolved (or the worker's message), when that came first.
      resp: m.resp !== null && m.resp <= after[0].t ? paintAt - m.resp : null,
    }
  }
  /** Record every mousemove (crosshair) or keydown (typing) until the frame that follows it. */
  m.moves = []; m.keys = []
  m.watch = (type, into) => {
    const on = (e) => { const t0 = e.timeStamp; afterFrame((t) => { m[into].push(t - t0) }) }
    window.addEventListener(type, on, { capture: true })
    return () => window.removeEventListener(type, on, { capture: true })
  }
  /** Arm a one-shot measurement of the next pointerdown. `done` is a selector, or 'result'. */
  m.arm = (done) => {
    const rec = (m.rec = { t0: null, tUp: null, press: null, busy: null, done: null, resultAt: null, shiftFrom: performance.now(), armedAt: performance.now() })
    m.resp = null; m.respPaint = null; m.respFull = null; m.frames = []; m.viaWorker = false
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
        if (done === 'result' && rec.resultAt === null) {
          const r = m.settle()
          if (r) { m.respPaint = r.resp; m.respFull = r.full; rec.resultAt = performance.now() }
        }
        const ok = done === 'result' ? rec.resultAt !== null : visible(done)
        if (ok) afterFrame((t) => { rec.done = t - rec.tUp })
        else requestAnimationFrame(poll)
      }
      poll()
    }, { capture: true, once: true })
  }
}

async function click(page, selector, done, cdp) {
  const target = page.locator(selector).first()
  await target.scrollIntoViewIfNeeded()
  await page.waitForTimeout(100)
  await page.evaluate((d) => window.__m.arm(d), done)
  const box = await target.boundingBox()
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  if (PHONE) {
    // A touch: down, held until the pressed frame (and at least 60 ms), then up; the browser makes the tap a click.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await Promise.all([page.waitForFunction(() => window.__m.rec.press !== null), page.waitForTimeout(60)])
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await page.mouse.move(x, y)
    await page.waitForTimeout(150) // let the hover transition finish: the press is measured alone
    await page.mouse.down()
    await Promise.all([page.waitForFunction(() => window.__m.rec.press !== null), page.waitForTimeout(60)])
    await page.mouse.up()
  }
  await page.waitForFunction(() => window.__m.rec.done !== null, null, { timeout: 30000 })
  const rec = await page.evaluate(() => ({ ...window.__m.rec, respPaint: window.__m.respPaint, respFull: window.__m.respFull, paintAt: window.__m.paintAt, viaWorker: window.__m.viaWorker }))
  // A worker fetched the body: its own Resource Timing has the last byte, on its own clock.
  if (done === 'result' && rec.viaWorker && rec.paintAt != null) {
    const pageOrigin = await page.evaluate(() => performance.timeOrigin)
    let lastByte = null
    for (const w of page.workers()) {
      const e = await w.evaluate(() => { const r = performance.getEntriesByType('resource').filter((x) => x.name.includes('query_range')); const l = r[r.length - 1]; return l ? { end: l.responseEnd, origin: performance.timeOrigin } : null }).catch(() => null)
      if (e && e.end > 0) lastByte = e.end + e.origin - pageOrigin
    }
    if (lastByte !== null) rec.respFull = rec.paintAt - lastByte
  }
  return rec
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
      const ctx = await browser.newContext({ ...LAYOUT, colorScheme: 'light' })
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
      const run = await click(page, '[data-testid=run]', 'result', cdp)
      await page.waitForTimeout(700)
      r.press = run.press
      r.busy = run.busy
      // Release of Run query to the result painted: the whole wait, network included (not a budget figure;
      // the one figure every candidate shares, whatever thread reads the body).
      r.runToPaint = run.done
      r.response = run.respPaint
      r.responseFull = run.respFull
      const shifts = await page.evaluate((from) => window.__m.shifts.filter((s) => s.t >= from), run.shiftFrom)
      r.clsRun = shifts.filter((s) => !s.recent).reduce((a, s) => a + s.value, 0)
      r.clsRunAll = shifts.reduce((a, s) => a + s.value, 0)

      // ---- local changes
      if (hasTable) {
        r.chartToTable = (await click(page, '[data-testid=view-table]', '[data-testid=result-table] tbody tr', cdp)).done
        r.tableToText = (await click(page, '[data-testid=view-text]', '[data-testid=text-view] pre', cdp)).done
      } else {
        r.chartToText = (await click(page, '[data-testid=view-text]', '[data-testid=text-view] pre', cdp)).done
      }
      r.textToChart = (await click(page, '[data-testid=view-chart]', '[data-testid=chart] canvas', cdp)).done
      r.picker = (await click(page, '[data-testid=time-range]', '[role=dialog][aria-label="Time range"]', cdp)).done
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
      // ---- crosshair: 30 moves across the plot, each waited for (a touch drag on the phone: horizontal, so the page does not scroll)
      await page.locator('[data-testid=chart] .u-over').scrollIntoViewIfNeeded()
      await page.waitForTimeout(150)
      const over = await page.locator('[data-testid=chart] .u-over').boundingBox()
      const at = (k) => PHONE ? { x: over.x + over.width * (0.1 + 0.8 * (k / 30)), y: over.y + over.height * 0.5 } : { x: over.x + over.width * (0.1 + 0.8 * (k / 30)), y: over.y + over.height * (0.3 + 0.4 * ((k % 5) / 5)) }
      if (PHONE) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at(0)] })
      else await page.mouse.move(at(0).x, at(0).y)
      await page.waitForTimeout(200)
      await page.evaluate((type) => { window.__m.moves = []; window.__m.unwatch = window.__m.watch(type, 'moves') }, PHONE ? 'pointermove' : 'mousemove')
      for (let k = 1; k <= 30; k++) {
        if (PHONE) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at(k)] })
        else await page.mouse.move(at(k).x, at(k).y)
        await page.waitForFunction((n) => window.__m.moves.length >= n, k)
      }
      const moves = await page.evaluate(() => { window.__m.unwatch(); return window.__m.moves })
      r.crosshair = p75(moves)
      r.crosshairWorst = Math.max(...moves)
      if (PHONE) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      else await page.mouse.move(2, 2)

      // ---- typing: 60 keys into the emptied editor, each waited for
      await page.locator('.cm-content').scrollIntoViewIfNeeded()
      if (PHONE) await page.locator('.cm-content').tap()
      else await page.click('.cm-content')
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
  const base = PHONE ? `${LABEL}-phone` : LABEL
  const name = CASES.length > 1 ? `${base}-${SERIES}` : base
  const file = path.join(lib.ROOT, 'e2e', 'measurements', `${name}.json`)
  const prior = process.argv.includes('--append') && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
  if (prior) runs.unshift(...prior.raw)

  const keys = ['load1', 'loadEnd', 'press', 'busy', 'runToPaint', 'chartToTable', 'tableToText', 'chartToText', 'textToChart', 'picker', 'response', 'responseFull', 'inp', 'inputDelay', 'crosshair', 'crosshairWorst', 'typing', 'typingWorst', 'typingOver', 'inpAll', 'clsLoad', 'clsRun', 'clsRunAll']
  const summary = {}
  for (const k of keys) {
    const xs = runs.map((r) => r[k])
    if (xs.every((x) => x == null)) continue
    summary[k] = { p75: p75(xs), median: median(xs), max: Math.max(...xs.filter((x) => x != null)), min: Math.min(...xs.filter((x) => x != null)) }
  }
  const allKeys = runs.flatMap((r) => r.keys || [])
  if (allKeys.length) summary.typingKeys = { p75: p75(allKeys), median: median(allKeys), max: Math.max(...allKeys), count: allKeys.length, over50: allKeys.filter((x) => x > 50).length }
  // Load: a run is judged only when the load average at its start was at most the core count.
  const judged = runs.filter((r) => r.load1 <= CORES)
  summary.judgedRuns = { count: judged.length, of: runs.length, cores: CORES }
  if (judged.length) for (const k of ['response', 'responseFull', 'runToPaint', 'chartToTable', 'tableToText', 'press', 'typing', 'crosshair']) {
    const xs = judged.map((r) => r[k]).filter((x) => x != null)
    if (xs.length) summary[`${k}Judged`] = { p75: p75(xs), median: median(xs), max: Math.max(...xs), min: Math.min(...xs), n: xs.length }
  }
  const calibrations = [...(prior?.calibrationsMs ?? []), CALIBRATION_MS]
  const setup = `Chromium, CPU 4x, Fast 4G, ${PHONE ? '400x800, coarse pointer, touch, device scale 2' : '1440x900, fine pointer'}, fresh context per run`
  const out = { label: LABEL, series: SERIES, query: QUERIES[SERIES], layout: PHONE ? 'phone' : 'desktop', root: ROOT, when: new Date().toISOString(), runs: runs.length, setup, cores: CORES, calibrationsMs: calibrations, summary, bytes: bytes(ROOT), raw: runs }
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

let CALIBRATION_MS = null
async function main() {
  CALIBRATION_MS = [calibrate()[0], calibrate()[0], calibrate()[0]].sort((a, b) => a - b)[1]
  console.log(`calibration ${CALIBRATION_MS.toFixed(0)} ms, ${CORES} cores, load ${os.loadavg()[0].toFixed(1)}`)
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
