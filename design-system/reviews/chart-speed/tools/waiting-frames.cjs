/* eslint-disable */
// waiting-frames.cjs: what each painted frame shows at the end of a wait in Explore, for two builds (C4 of
// ../second-review.md: the waiting line now goes in the render that shows the result, explore/waiting.tsx).
//   node waiting-frames.cjs --builds before=<app dir>,after=<app dir> [--phone] [--series 36,200] [--runs 3]
//                           [--min-runs 5] [--images <dir>] --out <file.json>
// Ports: VIZ_E2E_MOCK_PORT (8931) for the mock, VIZ_AB_PORT (8940) upward for the builds; the mock is the one of
// VIZ_APP_LIB's checkout (as tools/ab.cjs). Every build needs its dist/.
//
// Part 1, the frame record (the reference setup of ab.cjs: CPU 4x, Fast 4G, DevTools keeps no body copies, a fresh
// context per run, the builds in turn): Explore is loaded with the case's query, then Run query is pressed (as ab.cjs
// does); for 36 series the mock holds the answer back 300 ms so that the wait is over 400 ms (the 200-series answer
// takes over a second on Fast 4G by itself). From the press until 600 ms after the result's last change, every frame
// is recorded in the page: in a requestAnimationFrame callback (the chart draws synchronously and Explore uses no
// animation frame, so what is read there is what that frame paints, unless a ResizeObserver changes it after layout)
// and again after the frame (a task posted from the callback; a difference is flagged as `moved`):
//   t           the frame's start, ms after the press was released (pointerup / touchEnd)
//   line        the waiting line (data-testid=progress) is in the document, and its words
//   plot        how many times the chart's plot has been written since the press (childList changes under svg.vz-plot)
//   stale       "Showing the previous query" (data-testid=stale) is in the head
//   changes     DOM mutation records inside the result panel since the previous frame
//   moved       what the task after the frame read, when it differs from the callback's reading. That task runs only after
//               every task queued before it, so when the result's render comes first `moved` shows a later state, or one
//               between two tasks that no frame painted: the callback's reading is the one painted, unless a ResizeObserver
//               changed it after layout
// The record marks the last byte (Resource Timing responseEnd of query_range). Derived per run: the first frame
// that shows the new chart, the first frame without the line, the frames that show the line over the new chart
// (`lineOverNew`), and how many frames after the last byte changed the panel. With --images, Chromium's screencast
// is on for the first run of every build and case, and the frames from the last byte to the settled result are saved
// as JPEG (screencast frames are matched to the record by wall-clock time; the screencast is off in every other run).
//
// --dashboard (2026-11-28, C4 of ../third-review.md): the same record for a dashboard panel, whose waiting line is the same hook
// (useWaiting): the dashboard `service_red`, its first panel with a chart; the mock holds every query 700 ms and Refresh is pressed.
// The record follows that panel: its line (data-testid=panel-progress), its plot, "Showing the previous range" (panel-stale).
// Part 2 is not run for it.
//
// Part 2, the line's minimum (unthrottled, no network shaping): the mock holds every query back 450 ms, so the line
// is shown at 400 ms and the answer comes at about 450 ms. Per run: the first painted frame with the line and the
// first without it; `held` is the difference, and must be at least WAIT.minShown (300 ms). 4, 36 and 200 series.
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const lib = require(process.env.VIZ_APP_LIB || path.resolve(__dirname, '../../../../app/e2e/lib.cjs'))
const { chromium, Q_RATE } = lib
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback }
const PHONE = process.argv.includes('--phone'), DASH = process.argv.includes('--dashboard')
const RUNS = Number(arg('runs', '3')), MIN_RUNS = Number(arg('min-runs', '5'))
const CASES = DASH ? [0] : arg('series', '36,200').split(',').map(Number)
const MIN_CASES = arg('min-series', '4,36,200').split(',').map(Number)
const OUT = arg('out', null), IMAGES = arg('images', null)
const MOCK_PORT = Number(process.env.VIZ_E2E_MOCK_PORT || 8931)
const BUILDS = arg('builds', '').split(',').filter(Boolean).map((x, k) => ({ name: x.split('=')[0], root: path.resolve(x.split('=')[1]), port: Number(process.env.VIZ_AB_PORT || 8940) + k }))
const T0 = Date.UTC(2026, 10, 18, 9, 30), T1 = Date.UTC(2026, 10, 18, 12, 30)
const QUERIES = { 4: Q_RATE, 36: 'sum by (service, route, status) (rate(http_requests_total[5m]))', 200: 'viz_synthetic_series' }
const LAYOUT = PHONE ? { viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } }
const FAST_4G = { offline: false, latency: 165, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 }
const NO_BUFFERS = { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }
const MIN_SHOWN = 300
if (!OUT || BUILDS.length === 0) throw new Error('--builds and --out are needed')

function instrument(dash) {
  const m = (window.__f = { on: false, frames: [], plot: 0, changes: 0, tUp: null, done: false })
  new MutationObserver((records) => {
    if (!m.on) return
    const panel = scope()
    for (const r of records) {
      if (panel && panel.contains(r.target)) m.changes++
      if (r.type === 'childList' && r.target instanceof Element && r.target.closest('svg.vz-plot') && (!dash || (panel && panel.contains(r.target)))) { m.plot++; break }
    }
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
  const scope = () => (dash ? document.querySelector('[data-testid=panel]:has([data-testid=chart])') : document.querySelector('[data-testid=result]'))
  const state = () => {
    if (dash) { const panel = scope(), p = panel?.querySelector('[data-testid=panel-progress]'); return { line: p ? (p.querySelector('[role=status]')?.textContent ?? '') : null, plot: m.plot, stale: !!panel?.querySelector('[data-testid=panel-stale]') } }
    const p = document.querySelector('[data-testid=progress]')
    return { line: p ? (p.querySelector('[data-testid=progress-text]')?.textContent ?? '') : null, plot: m.plot, stale: !!document.querySelector('[data-testid=stale]') }
  }
  const loop = (ts) => {
    if (!m.on) return
    const at = state(), changes = m.changes
    m.changes = 0
    const f = { ts, wall: performance.timeOrigin + ts, ...at, changes }
    m.frames.push(f)
    const ch = new MessageChannel()
    ch.port1.onmessage = () => { const after = state(); f.end = performance.now(); if (after.line !== at.line || after.plot !== at.plot || after.stale !== at.stale) f.moved = after }
    ch.port2.postMessage(0)
    requestAnimationFrame(loop)
  }
  m.start = () => { m.on = true; m.frames = []; m.plot = 0; m.changes = 0; requestAnimationFrame(loop) }
  m.stop = () => { m.on = false }
}

const get = (u) => new Promise((res) => { const r = http.get(u, (x) => { x.resume(); x.on('end', () => res(x.statusCode)) }); r.on('error', () => res(0)); r.setTimeout(3000, () => { r.destroy(); res(0) }) })
const up = async (u) => { for (let i = 0; i < 200; i++) { if (await get(u)) return; await new Promise((r) => setTimeout(r, 150)) } throw new Error(`${u} did not start`) }
const mockDelay = (ms) => get(`http://127.0.0.1:${MOCK_PORT}/__mock/delay?ms=${ms}`)

async function press(page, cdp) {
  const box = await page.locator(DASH ? '[data-testid=refresh]' : '[data-testid=run]').first().boundingBox()
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  if (PHONE) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await page.waitForTimeout(60)
    await page.evaluate(() => window.__f.start())
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await page.mouse.move(x, y)
    await page.waitForTimeout(150)
    await page.mouse.down()
    await page.waitForTimeout(60)
    await page.evaluate(() => window.__f.start())
    await page.mouse.up()
  }
  return page.evaluate(() => performance.now())
}

/** Waits until the result has settled (a new plot, no line, 600 ms without a change to the panel), then stops the record. */
async function settle(page) {
  await page.waitForFunction(() => { const f = window.__f.frames; const last = f[f.length - 1]; return last && last.plot > 0 && last.line === null }, null, { timeout: 30000 })
  await page.waitForFunction(() => { const f = window.__f.frames; let k = f.length - 1; while (k > 0 && f[k].changes === 0) k--; return performance.now() - f[k].ts > 600 }, null, { timeout: 30000 })
  await page.evaluate(() => window.__f.stop())
  return page.evaluate(() => ({ frames: window.__f.frames, responseEnd: (performance.getEntriesByType('resource').filter((e) => e.name.includes('query_range')).pop() || {}).responseEnd ?? null }))
}

function derive(rec, tUp) {
  const frames = rec.frames.map((f) => ({ ...f, t: +(f.ts - tUp).toFixed(1) }))
  // a dashboard sends one query per panel, answered in any order: the record's new chart is the panel's first plot written after the press
  const lastByte = DASH || rec.responseEnd == null ? null : +(rec.responseEnd - tUp).toFixed(1)
  // The new chart: the first frame from the last byte on whose plot was written after the frame before the last byte.
  const before = lastByte == null ? -1 : frames.findIndex((f) => f.t >= lastByte) - 1
  const base = before >= 0 ? frames[before].plot : 0
  const firstNew = frames.findIndex((f, k) => k > before && f.plot > base)
  const lineFrames = frames.filter((f) => f.line !== null)
  const firstLine = frames.findIndex((f) => f.line !== null)
  const lineGone = firstLine < 0 ? -1 : frames.findIndex((f, k) => k > firstLine && f.line === null)
  const afterByte = lastByte == null ? [] : frames.filter((f) => f.t >= lastByte)
  return {
    lastByte,
    lineShownAt: firstLine >= 0 ? frames[firstLine].t : null,
    lineWords: [...new Set(lineFrames.map((f) => f.line))],
    firstNewChartAt: firstNew >= 0 ? frames[firstNew].t : null,
    lineGoneAt: lineGone >= 0 ? frames[lineGone].t : null,
    plotWrittenBeforeLastByte: base,
    lineOverNew: firstNew < 0 ? null : frames.filter((f, k) => k >= firstNew && f.line !== null).length,
    staleOverNew: firstNew < 0 ? null : frames.filter((f, k) => k >= firstNew && f.stale).length,
    framesChangedAfterLastByte: afterByte.filter((f) => f.changes > 0).length,
    changesAfterLastByte: afterByte.reduce((a, f) => a + f.changes, 0),
    moved: frames.filter((f) => f.moved).length,
    frames: frames.map(({ wall, ts, ...f }) => ({ ...f, end: f.end == null ? null : +(f.end - tUp).toFixed(1) })),
    walls: frames.map((f) => f.wall),
  }
}

async function main() {
  const procs = []
  const start = (cwd, args) => { const p = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, VIZ_API_TARGET: `http://127.0.0.1:${MOCK_PORT}` } }); procs.push(p) }
  start(lib.ROOT, ['--import', 'tsx', path.join(lib.ROOT, 'mock/server.ts'), '--port', String(MOCK_PORT)])
  for (const B of BUILDS) start(B.root, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(B.port), '--host', '127.0.0.1', '--strictPort'])
  await up(`http://127.0.0.1:${MOCK_PORT}/api/v1/status/buildinfo`)
  for (const B of BUILDS) await up(`http://127.0.0.1:${B.port}/`)
  const browser = await chromium.launch()
  const out = { when: new Date().toISOString(), layout: PHONE ? 'phone' : 'desktop', cores: os.cpus().length, builds: BUILDS.map((b) => ({ name: b.name, root: b.root })), frames: {}, minimum: {} }
  if (IMAGES) fs.mkdirSync(IMAGES, { recursive: true })
  try {
    // ---- part 1
    for (const n of CASES) {
      out.frames[n] = Object.fromEntries(BUILDS.map((b) => [b.name, []]))
      for (let i = 0; i < RUNS; i++) {
        for (const B of i % 2 ? [...BUILDS].reverse() : BUILDS) {
          await mockDelay(0)
          const ctx = await browser.newContext(LAYOUT)
          const page = await ctx.newPage()
          await page.addInitScript(instrument, DASH)
          const cdp = await ctx.newCDPSession(page)
          await cdp.send('Network.enable', NO_BUFFERS)
          const impl = page._connection.toImpl(page)
          await (impl.delegate || impl._delegate)._mainFrameSession._client.send('Network.enable', NO_BUFFERS)
          await cdp.send('Network.emulateNetworkConditions', FAST_4G)
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
          await page.goto(DASH ? `http://127.0.0.1:${B.port}/dashboards?id=service_red&from=${T0}&to=${T1}` : `http://127.0.0.1:${B.port}/explore?q=${encodeURIComponent(QUERIES[n])}&from=${T0}&to=${T1}`)
          await page.waitForSelector('[data-testid=chart] svg.vz-plot .vz-line', { state: 'attached', timeout: 60000 })
          if (!DASH) await page.waitForSelector('.cm-content')
          await page.waitForTimeout(1200)
          await mockDelay(DASH ? 700 : n === 36 ? 300 : 0)
          const load1 = os.loadavg()[0]
          const shots = []
          const filming = IMAGES && i === 0
          if (filming) {
            cdp.on('Page.screencastFrame', (e) => { shots.push({ wall: e.metadata.timestamp * 1000, data: e.data }); cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {}) })
            await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1, maxWidth: PHONE ? 400 : 960, maxHeight: PHONE ? 800 : 600 })
            await page.waitForTimeout(300)
            shots.length = 0
          }
          const tUp = await press(page, cdp)
          const rec = await settle(page)
          if (filming) await cdp.send('Page.stopScreencast')
          const d = derive(rec, tUp)
          if (filming) {
            // The screencast frames from the frame before the last byte to the settled result, each named by its time after the press.
            const from = d.walls[Math.max(0, d.frames.findIndex((f) => f.t >= d.lastByte) - 1)]
            const to = d.walls[d.frames.findIndex((f) => f.t >= (d.lineGoneAt ?? Infinity))] + 200
            d.images = []
            for (const s of shots.filter((s) => s.wall >= from - 20 && s.wall <= to)) {
              const t = s.wall - d.walls[0] + d.frames[0].t
              const file = `${PHONE ? 'phone' : 'desktop'}-${n}-${B.name}-${String(Math.round(t)).padStart(5, '0')}ms.jpg`
              fs.writeFileSync(path.join(IMAGES, file), Buffer.from(s.data, 'base64'))
              d.images.push({ file, t: +t.toFixed(1) })
            }
          }
          delete d.walls
          out.frames[n][B.name].push({ run: i + 1, load1, ...d })
          console.log(`[frames ${n}${PHONE ? ' phone' : ''}] ${B.name} run ${i + 1}: load ${load1.toFixed(1)}; last byte ${d.lastByte}; line ${d.lineShownAt} to ${d.lineGoneAt}; new chart ${d.firstNewChartAt}; line over the new chart in ${d.lineOverNew} frame(s); ${d.framesChangedAfterLastByte} frame(s) changed after the last byte${d.moved ? `; ${d.moved} moved after rAF` : ''}`)
          await ctx.close()
        }
      }
    }
    // ---- part 2
    await mockDelay(450)
    for (const n of DASH ? [] : MIN_CASES) {
      out.minimum[n] = Object.fromEntries(BUILDS.map((b) => [b.name, []]))
      for (let i = 0; i < MIN_RUNS; i++) {
        for (const B of i % 2 ? [...BUILDS].reverse() : BUILDS) {
          const ctx = await browser.newContext(LAYOUT)
          const page = await ctx.newPage()
          await page.addInitScript(instrument, DASH)
          const cdp = await ctx.newCDPSession(page)
          await page.goto(`http://127.0.0.1:${B.port}/explore?q=${encodeURIComponent(QUERIES[n])}&from=${T0}&to=${T1}`)
          await page.waitForSelector('[data-testid=chart] svg.vz-plot .vz-line', { state: 'attached', timeout: 60000 })
          await page.waitForSelector('.cm-content')
          await page.waitForTimeout(800)
          const tUp = await press(page, cdp)
          const d = derive(await settle(page), tUp)
          const held = d.lineShownAt == null || d.lineGoneAt == null ? null : +(d.lineGoneAt - d.lineShownAt).toFixed(1)
          out.minimum[n][B.name].push({ run: i + 1, lastByte: d.lastByte, lineShownAt: d.lineShownAt, firstNewChartAt: d.firstNewChartAt, lineGoneAt: d.lineGoneAt, held, lineOverNew: d.lineOverNew, ok: held != null && held >= MIN_SHOWN })
          console.log(`[minimum ${n}${PHONE ? ' phone' : ''}] ${B.name} run ${i + 1}: last byte ${d.lastByte}; line ${d.lineShownAt} to ${d.lineGoneAt} (held ${held} ms); new chart ${d.firstNewChartAt}; line over the new chart in ${d.lineOverNew} frame(s)`)
          await ctx.close()
        }
      }
    }
  } finally {
    await mockDelay(0).catch(() => {})
    await browser.close()
    for (const p of procs) p.kill()
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1))
}
main().catch((e) => { console.error(e); process.exit(1) })
