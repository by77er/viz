/* eslint-disable */
// frame-shots.cjs: images of the exact frames at the end of a wait, for C4 of ../third-review.md (the waiting line's last frame).
//   node frame-shots.cjs --builds before=<app dir>,after=<app dir> [--phone] [--theme light|dark] [--series 200,36] [--dashboard]
//                        --out <file.json> --images <dir>
// Ports: VIZ_E2E_MOCK_PORT for the mock, VIZ_AB_PORT upward for the builds; the mock is VIZ_APP_LIB's checkout's (as ab.cjs).
//
// How a frame and its image are tied together. Chromium is started with begin-frame control (headless shell's
// HeadlessExperimental.beginFrame, with --run-all-compositor-stages-before-draw): the page produces a frame only when this
// script sends a BeginFrame, and the call returns when that frame has been drawn, with a screenshot of that frame. The script
// sends one every 16.7 ms of wall time (a 60 Hz display), or as soon as the previous one returned if that took longer (a long
// frame, as on a real display), and gives each its frame time (frameTimeTicks, on the same monotonic clock the renderer uses).
// The page keeps the same frame record as waiting-frames.cjs, in a requestAnimationFrame callback, whose timestamp is that
// frame time; so every image is matched to the record's frame by its frame time, and the match is checked for every image
// (the offset between the two clocks must be the same for all frames, to 0.1 ms). From the press until the result has
// settled, every frame is captured (PNG); the images kept are the frame before the new result, the frame that first shows
// it, and every later frame up to and including the first without the waiting line.
//
// Explore (the default): as waiting-frames.cjs part 1 (CPU 4x, Fast 4G, DevTools keeps no body copies, the mock holds a
// 36-series answer 300 ms so that the wait passes 400 ms). --dashboard: the dashboard `service_red`, whose panels use the same
// hook (useWaiting); the mock holds every query 700 ms, then Refresh is pressed; the record follows the first panel
// ([data-testid=panel] with a chart): its waiting line (data-testid=panel-progress), its plot, "Showing the previous range".
//
// What differs from a display: frames come from this script, not from vsync, and while a screenshot is taken the next frame
// waits for it; so the record's times here are not the reference setup's, and the frame record in waiting-line/ is the one
// that times things. What these images show is what each frame drew.
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const lib = require(process.env.VIZ_APP_LIB || path.resolve(__dirname, '../../../../app/e2e/lib.cjs'))
const { chromium, Q_RATE } = lib
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback }
const PHONE = process.argv.includes('--phone'), DASH = process.argv.includes('--dashboard')
const THEME = arg('theme', 'light')
const CASES = DASH ? [0] : arg('series', '200,36').split(',').map(Number)
const RUNS = Number(arg('runs', '1'))
const OUT = arg('out', null), IMAGES = arg('images', null)
const MOCK_PORT = Number(process.env.VIZ_E2E_MOCK_PORT || 8931)
const BUILDS = arg('builds', '').split(',').filter(Boolean).map((x, k) => ({ name: x.split('=')[0], root: path.resolve(x.split('=')[1]), port: Number(process.env.VIZ_AB_PORT || 8940) + k }))
const T0 = Date.UTC(2026, 10, 18, 9, 30), T1 = Date.UTC(2026, 10, 18, 12, 30)
const QUERIES = { 4: Q_RATE, 36: 'sum by (service, route, status) (rate(http_requests_total[5m]))', 200: 'viz_synthetic_series' }
const LAYOUT = PHONE ? { viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } }
const FAST_4G = { offline: false, latency: 165, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 }
const NO_BUFFERS = { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }
const FRAME = 1000 / 60
if (!OUT || !IMAGES || BUILDS.length === 0) throw new Error('--builds, --out and --images are needed')

/** The frame record of waiting-frames.cjs, for Explore or for one dashboard panel. */
function instrument(dash) {
  const m = (window.__f = { on: false, frames: [], plot: 0, changes: 0 })
  const scope = () => (dash ? document.querySelector('[data-testid=panel]:has([data-testid=chart])') : document.querySelector('[data-testid=result]'))
  new MutationObserver((records) => {
    if (!m.on) return
    const panel = scope()
    for (const r of records) {
      if (panel && panel.contains(r.target)) m.changes++
      if (r.type === 'childList' && r.target instanceof Element && r.target.closest('svg.vz-plot') && (!panel || panel.contains(r.target))) { m.plot++; break }
    }
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
  const state = () => {
    const panel = scope()
    const p = dash ? panel?.querySelector('[data-testid=panel-progress]') : document.querySelector('[data-testid=progress]')
    const words = p ? (dash ? p.querySelector('[role=status]')?.textContent : p.querySelector('[data-testid=progress-text]')?.textContent) ?? '' : null
    return { line: words, plot: m.plot, stale: !!(dash ? panel?.querySelector('[data-testid=panel-stale]') : document.querySelector('[data-testid=stale]')) }
  }
  const loop = (ts) => {
    if (!m.on) return
    const at = state(), changes = m.changes
    m.changes = 0
    m.frames.push({ ts, ...at, changes })
    requestAnimationFrame(loop)
  }
  m.start = () => { m.on = true; m.frames = []; m.plot = 0; m.changes = 0; requestAnimationFrame(loop) }
  m.stop = () => { m.on = false }
}

const get = (u) => new Promise((res) => { const r = http.get(u, (x) => { x.resume(); x.on('end', () => res(x.statusCode)) }); r.on('error', () => res(0)); r.setTimeout(3000, () => { r.destroy(); res(0) }) })
const up = async (u) => { for (let i = 0; i < 200; i++) { if (await get(u)) return; await new Promise((r) => setTimeout(r, 150)) } throw new Error(`${u} did not start`) }
const mockDelay = (ms) => get(`http://127.0.0.1:${MOCK_PORT}/__mock/delay?ms=${ms}`)
const ticks = () => Number(process.hrtime.bigint()) / 1e6 // CLOCK_MONOTONIC, the clock of the renderer's TimeTicks on Linux
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

/** Sends BeginFrames at 60 Hz until stopped; captures a screenshot of each frame while `capture` is on. */
function pump(cdp) {
  const p = { running: true, capture: false, sent: [], shots: [], errors: 0 }
  p.done = (async () => {
    let next = ticks()
    while (p.running) {
      const ft = ticks(), capture = p.capture
      try {
        const r = await cdp.send('HeadlessExperimental.beginFrame', { frameTimeTicks: ft, interval: FRAME, ...(capture ? { screenshot: { format: 'png', optimizeForSpeed: true } } : {}) })
        p.sent.push({ ft, damage: r.hasDamage, shot: !!r.screenshotData })
        if (capture && r.screenshotData) p.shots.push({ ft, data: r.screenshotData })
      } catch (e) { p.sent.push({ ft, error: String(e.message || e).slice(0, 120) }); if (++p.errors > 50) throw e }
      next += FRAME
      const now = ticks()
      if (next < now) next = now
      await sleep(next - now)
    }
  })()
  p.stop = async () => { p.running = false; await p.done }
  return p
}

async function press(page, cdp, selector) {
  const box = await page.locator(selector).first().boundingBox()
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

async function main() {
  const procs = []
  const start = (cwd, args) => { const p = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, VIZ_API_TARGET: `http://127.0.0.1:${MOCK_PORT}` } }); procs.push(p) }
  start(lib.ROOT, ['--import', 'tsx', path.join(lib.ROOT, 'mock/server.ts'), '--port', String(MOCK_PORT)])
  for (const B of BUILDS) start(B.root, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(B.port), '--host', '127.0.0.1', '--strictPort'])
  await up(`http://127.0.0.1:${MOCK_PORT}/api/v1/status/buildinfo`)
  for (const B of BUILDS) await up(`http://127.0.0.1:${B.port}/`)
  const browser = await chromium.launch({ args: ['--enable-begin-frame-control', '--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout', '--disable-threaded-animation', '--disable-threaded-scrolling', '--disable-checker-imaging'] })
  const bs = await browser.newBrowserCDPSession()
  const out = { when: new Date().toISOString(), layout: PHONE ? 'phone' : 'desktop', theme: THEME, view: DASH ? 'dashboard service_red, first chart panel' : 'Explore', cores: os.cpus().length, builds: BUILDS.map((b) => ({ name: b.name, root: b.root })), runs: [] }
  fs.mkdirSync(IMAGES, { recursive: true })
  try {
    for (const n of CASES) for (let i = 0; i < RUNS; i++) for (const B of i % 2 ? [...BUILDS].reverse() : BUILDS) {
      await mockDelay(0)
      const ctx = await browser.newContext({ ...LAYOUT, colorScheme: THEME })
      await ctx.addInitScript((t) => { try { localStorage.setItem('viz.theme', t) } catch {} }, THEME)
      await ctx.addInitScript(instrument, DASH)
      const ctxId = ctx._connection.toImpl(ctx)._browserContextId
      const pageP = ctx.waitForEvent('page')
      await bs.send('Target.createTarget', { url: 'about:blank', browserContextId: ctxId, enableBeginFrameControl: true })
      const page = await pageP
      const cdp = await ctx.newCDPSession(page)
      const pm = pump(cdp)
      try {
        await cdp.send('Network.enable', NO_BUFFERS)
        const impl = page._connection.toImpl(page)
        await (impl.delegate || impl._delegate)._mainFrameSession._client.send('Network.enable', NO_BUFFERS)
        await cdp.send('Network.emulateNetworkConditions', FAST_4G)
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
        const address = DASH ? `http://127.0.0.1:${B.port}/dashboards?id=service_red&from=${T0}&to=${T1}` : `http://127.0.0.1:${B.port}/explore?q=${encodeURIComponent(QUERIES[n])}&from=${T0}&to=${T1}`
        await page.goto(address)
        await page.waitForSelector('[data-testid=chart] svg.vz-plot .vz-line', { state: 'attached', timeout: 60000 })
        if (!DASH) await page.waitForSelector('.cm-content')
        await page.evaluate(() => document.fonts.ready)
        await page.waitForTimeout(1500)
        await mockDelay(DASH ? 700 : n === 36 ? 300 : 0)
        const load1 = os.loadavg()[0]
        pm.capture = true
        const tUp = await press(page, cdp, DASH ? '[data-testid=refresh]' : '[data-testid=run]')
        await page.waitForFunction(() => { const f = window.__f.frames; const last = f[f.length - 1]; return last && last.plot > 0 && last.line === null }, null, { timeout: 30000, polling: 50 })
        await page.waitForFunction(() => { const f = window.__f.frames; let k = f.length - 1; while (k > 0 && f[k].changes === 0) k--; return performance.now() - f[k].ts > 400 }, null, { timeout: 30000, polling: 50 })
        pm.capture = false
        await page.evaluate(() => window.__f.stop())
        const rec = await page.evaluate(() => ({ frames: window.__f.frames, responseEnd: (performance.getEntriesByType('resource').filter((e) => e.name.includes('query')).pop() || {}).responseEnd ?? null }))
        await pm.stop()
        // tie every captured image to the record's frame by frame time
        // the offset between the two clocks: of the offsets that pair the record's first frame with some BeginFrame, the one that pairs most frames
        const hits = (o) => rec.frames.filter((f) => pm.sent.some((s) => Math.abs(s.ft - f.ts - o) <= 0.1)).length
        const cands = rec.frames.slice(0, 12).flatMap((f) => pm.sent.map((s) => s.ft - f.ts))
        let off = cands[0], best = -1; for (const o of cands) { const h = hits(o); if (h > best) { best = h; off = o } }
        const frames = rec.frames.map((f) => { const s = pm.shots.find((s) => Math.abs(s.ft - f.ts - off) <= 0.1), b = pm.sent.find((s) => Math.abs(s.ft - f.ts - off) <= 0.1); return { t: +(f.ts - tUp).toFixed(1), line: f.line, plot: f.plot, stale: f.stale, changes: f.changes, image: s ? s : null, beginFrame: b ? (b.error ? 'error: ' + b.error : b.shot ? 'image' : 'no image' + (b.damage ? '' : ' (no damage)')) : 'none at this frame time' } })
        const matched = frames.filter((f) => f.image).length
        const lastByte = rec.responseEnd == null ? null : +(rec.responseEnd - tUp).toFixed(1)
        const firstNew = frames.findIndex((f) => f.plot > 0)
        const lineGone = frames.findIndex((f, k) => k >= firstNew && f.line === null)
        const keep = frames.filter((f, k) => k >= firstNew - 1 && k <= lineGone && f.image)
        const tag = `${DASH ? 'dashboard' : n}-${PHONE ? 'phone' : 'desktop'}-${THEME}-${B.name}`
        const images = []
        for (const f of keep) {
          const k = frames.indexOf(f)
          const what = k === firstNew - 1 ? 'before' : k === firstNew && k === lineGone ? 'new-result-line-gone' : k === firstNew ? 'new-result' : k === lineGone ? 'line-gone' : 'line-over-new'
          const file = `${tag}-${String(Math.round(f.t)).padStart(5, '0')}ms-${what}.png`
          fs.writeFileSync(path.join(IMAGES, file), Buffer.from(f.image.data, 'base64'))
          images.push({ file, t: f.t, what, line: f.line, plot: f.plot, stale: f.stale, frameTime: +f.image.ft.toFixed(3), rafTs: +(f.t).toFixed(1) })
        }
        const run = { view: out.view, series: n || null, build: B.name, run: i + 1, load1, lastByte, framesRecorded: frames.length, framesCaptured: pm.shots.length, framesMatched: matched, beginFrames: pm.sent.length, beginFrameErrors: pm.sent.filter((s) => s.error).length, unmatched: frames.filter((f) => !f.image).map((f) => ({ t: f.t, plot: f.plot, line: f.line, beginFrame: f.beginFrame })), clockOffsetMs: +off.toFixed(3), maxOffsetDeviationMs: +Math.max(...frames.filter((f) => f.image).map((f) => Math.abs(f.image.ft - (f.t + tUp) - off))).toFixed(3), firstNewAt: firstNew >= 0 ? frames[firstNew].t : null, lineGoneAt: lineGone >= 0 ? frames[lineGone].t : null, lineOverNew: firstNew < 0 ? null : frames.filter((f, k) => k >= firstNew && f.line !== null).length, images, frames: frames.map(({ image, ...f }) => ({ ...f, captured: !!image })) }
        out.runs.push(run)
        console.log(`[${tag}] run ${i + 1}: load ${load1.toFixed(1)}; ${frames.length} frames recorded, ${pm.shots.length} captured, ${matched} matched (deviation ${run.maxOffsetDeviationMs} ms); last byte ${lastByte}; new result ${run.firstNewAt}; line gone ${run.lineGoneAt}; line over the new result in ${run.lineOverNew} frame(s); images ${images.map((x) => x.what + '@' + Math.round(x.t)).join(', ')}`)
      } finally {
        if (pm.running) await pm.stop().catch(() => {})
        await ctx.close()
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
