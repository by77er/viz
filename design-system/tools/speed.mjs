// The shared speed harness. Measures the budgets in project/README.md ("Responsiveness and feedback") the same way for everyone.
//   node tools/speed.mjs <scenario.json> [--runs N] [--out results.json] [--no-throttle] [--no-fail] [--url page.html] [--compare before.html]
// --compare: before and after in the same session, alternating run by run (before, after, before, …), so they share the machine's load;
// each is reported on its own and both go to --out.
// Reference setup: Chromium, CPU slowed 4x (CDP Emulation.setCPUThrottlingRate), network shaped to DevTools' "Fast 4G"
// (9 Mbit/s down, 1.5 Mbit/s up, 60 ms latency, with DevTools' multipliers: 0.9 on throughput, 2.75 on latency = 165 ms),
// a fresh browser context per run, 20 runs, at the scenario's viewport, with a coarse pointer and touch when the scenario says "coarse".
// Prints, per measurement, the 75th percentile (the budgeted figure), the median and the worst run, against its budget.
//
// Load. Every sample records the 1-minute load average when it was taken; the core count and a calibration task timed before the runs are
// recorded once. A timing row is judged only when most of its samples were taken with the load at or below the core count (the stated
// limit, printed with every result); above it the row is printed with its load and marked "not judged", whatever the calibration says: on a
// shared machine its 75th percentile does not reproduce. Layout shift is judged at any load (it does not depend on speed). Exit status:
// non-zero if a judged row is over budget.
//
// Scenario: { "url": URL or file path (a file is served from its folder's parent on a free port in 8900-8909, so the network shaping applies),
//             "ready": selector that exists once the first results are painted, "runs": 20, "viewport": [1440, 900], "coarse": false,
//             "measure": [ ... ] }  Each entry has "name", "type", "budget" and:
//   press       selector                 pointer down on it (a finger, by CDP touch events, on a coarse layout; the mouse otherwise), held ->
//                                        end of the first frame in which the control's fill differs from its fill at rest: the pressed state
//                                        as painted, not as assumed. A press never painted within 1 s counts as 1000 ms. Then waits for the
//                                        work the press started (body[data-loaded] changes) before the next measurement. Budget 50 ms.
//   type        selector, text           each key down in the editor -> end of the frame that shows the character. Budget 50 ms.
//   move        selector                 each pointer move across it -> end of the frame that drew the crosshair. Budget 50 ms.
//   drag        selector                 a touch drag across it (CDP touch events); each touch move -> end of the frame. Budget 50 ms.
//   toggle      selector, expect         click (a tap on a coarse layout) -> end of the first frame in which `expect` matches. "undo": true
//                                        clicks it again afterwards (or "undo": selector, that instead), so every run starts the same. Budget 100 ms.
//   send        selector, expect, url    click (tap) -> end of the first frame in which `expect` matches (the region's waiting state), counted
//                                        only if a request whose URL contains `url` was sent by then. Waits for the work to finish. Budget 100 ms.
//   response    selector, url, expect    click on it; from the moment the response whose URL contains `url` arrives -> end of the first
//               [, before]               frame in which `expect` matches. `before` is script run first (to clear what `expect` looks for). Budget 100 ms.
//   shift       -                        cumulative layout shift over the whole run, load included (shifts within 500 ms of input excluded).
//   transitions selector, expect[, undo]  click (tap) -> in the frame in which `expect` first matches, the CSS transitions running: a change
//                                        that eases its colours shows the old state after the frame that counts as done. Budget 0; judged at
//                                        any load, as layout shift is (v8: the theme change's regression check).
//   load-shift  hash [, delay]           a separate load of the page at url#hash, so it opens scrolled to that region before its data arrives
//                                        (as a reload does), every data response held `delay` ms more: cumulative layout shift until ready
//                                        and 500 ms after. Budget 0.05.
//   inp         -                        the longest interaction of the run by Event Timing (8 ms steps). Budget 200 ms.
// "End of the frame" is a task posted from inside the requestAnimationFrame callback of that frame, which runs after its style, layout and
// paint. When the condition is first seen inside a frame callback, the task is posted from that same callback, never from the next frame.
// Times start at the input event's own timestamp, so input delay is included. A control scrolled into view is touched two frames later,
// once it is painted, as a person would (v8: content-visibility: auto renders what comes into view at the next frame).
// Say with every number whether it was measured on the system's fixture page (a floor) or on the application, and give the load.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve, dirname, join, extname, basename } from 'node:path'
import { loadavg, cpus } from 'node:os'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
const args = process.argv.slice(2), flag = (n) => args.includes(n), opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const file = args.find((x) => x.endsWith('.json') && x !== opt('--out'))
if (!file) { console.log('usage: speed.mjs <scenario.json> [--runs N] [--out results.json] [--no-throttle] [--no-fail] [--url page.html]'); process.exit(2) }
const sc = JSON.parse(readFileSync(file, 'utf8')), runs = +(opt('--runs') ?? sc.runs ?? 20), [vw, vh] = sc.viewport ?? [1440, 900], coarse = !!sc.coarse, limit = cpus().length
const cores = cpus().length

// Pages are served over HTTP from their folder's parent on a free port in 8900-8909, so the network shaping applies to every file.
const servers = []
async function serve(u) {
  if (u.includes('://')) return u
  const page = resolve(u), base = dirname(dirname(page)) // one level up, so sibling folders (fonts) resolve
  const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png' }
  const server = createServer((req, res) => { const p = join(base, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(base) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); res.end(); return } res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' }); res.end(readFileSync(p)) })
  let port = 8900
  for (; port <= 8909; port++) { const ok = await new Promise((r) => { server.once('error', () => r(false)); server.listen(port, '127.0.0.1', () => r(true)) }); if (ok) break; server.removeAllListeners('error') }
  if (port > 8909) { console.log('no free port in 8900-8909'); process.exit(2) }
  servers.push(server); return `http://127.0.0.1:${port}/${basename(dirname(page))}/${basename(page)}`
}
const sides = [{ name: 'after', url: await serve(opt('--url') ?? sc.url) }]
if (opt('--compare')) sides.unshift({ name: 'before', url: await serve(opt('--compare')) })

// Calibration: a fixed amount of work in this process, timed. On an idle core of the reference machine it takes about 100 ms; the ratio
// to that says how contended the machine was when these numbers were taken.
const calibrate = () => { const t0 = performance.now(); let x = 0; for (let i = 0; i < 3e7; i++) x += Math.sqrt(i) % 7; return [performance.now() - t0, x] }
const cal = [calibrate()[0], calibrate()[0], calibrate()[0]].sort((a, b) => a - b)[1]

// In the page: timing helpers. Nothing here changes what the page does.
const inPage = () => {
  const post = (cb) => { const c = new MessageChannel(); c.port1.onmessage = () => cb(performance.now()); c.port2.postMessage(0) } // from inside a frame callback: runs after that frame
  const afterPaint = (cb) => requestAnimationFrame(() => post(cb))
  const z = (window.__speed = { afterPaint, shift: 0, shiftAfterInput: 0, worstEvent: 0, responses: [], requests: [], samples: [] })
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (e.hadRecentInput) z.shiftAfterInput += e.value; else z.shift += e.value } }).observe({ type: 'layout-shift', buffered: true }) } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId && e.duration > z.worstEvent) z.worstEvent = e.duration }).observe({ type: 'event', durationThreshold: 16, buffered: true }) } catch {}
  const realFetch = window.fetch
  // a response has "arrived" when its body has: a copy is read to the end, without delaying the page's own read
  window.fetch = async (...a) => { z.requests.push(String(a[0]?.url ?? a[0])); const r = await realFetch(...a); r.clone().arrayBuffer().then(() => z.responses.push([String(a[0]?.url ?? a[0]), performance.now()]), () => {}); return r }
  const visible = (sel) => { const e = document.querySelector(sel); return !!e && e.getClientRects().length > 0 }
  // resolves with (end of the frame in which `sel` first matches) - start. Checked in each frame callback; when it matches, the end of THAT frame.
  z.until = (sel, start) => new Promise((done) => { const tick = () => { if (visible(sel)) post((t) => done(t - start())); else requestAnimationFrame(tick) }; requestAnimationFrame(tick) })
  z.once = (type, target) => new Promise((done) => { (target ?? document).addEventListener(type, (e) => done(e.timeStamp), { capture: true, once: true }) })
  z.arm = { // each returns a promise the harness awaits after sending the real input
    press(sel) { const el = document.querySelector(sel), rest = getComputedStyle(el).backgroundColor
      z.p = z.once('pointerdown').then((t0) => new Promise((d) => { const tick = () => { if (getComputedStyle(el).backgroundColor !== rest) post((t) => d(t - t0)); else if (performance.now() - t0 > 1000) d(1000); else requestAnimationFrame(tick) }; requestAnimationFrame(tick) })) },
    move() { z.p = z.once('pointermove').then((t0) => new Promise((d) => afterPaint((t) => d(t - t0)))) },
    toggle(expect) { z.p = z.once('click').then((t0) => z.until(expect, () => t0)) },
    send(expect, part) { const from = z.requests.length; z.p = z.once('click').then((t0) => new Promise((d) => { const tick = () => { const sent = z.requests.slice(from).some((u) => u.includes(part)); if (sent && visible(expect)) post((t) => d(t - t0)); else requestAnimationFrame(tick) }; requestAnimationFrame(tick) })) },
    response(part, expect) { const from = z.responses.length; z.p = z.once('click').then(() => new Promise((d) => { const wait = () => { const hit = z.responses.slice(from).find((r) => r[0].includes(part)); if (hit) z.until(expect, () => hit[1]).then(d); else requestAnimationFrame(wait) }; wait() })) },
    type(sel, n) { z.samples = []; const el = document.querySelector(sel); let t0 = 0; el.addEventListener('keydown', (e) => { t0 = e.timeStamp }, true); el.addEventListener('input', () => { const s = t0; afterPaint((t) => z.samples.push(t - s)) }, true); z.p = new Promise((d) => { const w = () => (z.samples.length >= n ? d(z.samples) : setTimeout(w, 20)); w() }) },
  }
}

for (const side of sides) { side.results = Object.fromEntries(sc.measure.map((m) => [m.name, []])); side.loads = Object.fromEntries(sc.measure.map((m) => [m.name, []])); side.runLoads = [] }
const browser = await chromium.launch()
const newPage = async () => {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, ...(coarse ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) }), page = await ctx.newPage(), cdp = await ctx.newCDPSession(page)
  await page.addInitScript(inPage)
  if (!flag('--no-throttle')) {
    await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 165, downloadThroughput: 9e6 / 8 * 0.9, uploadThroughput: 1.5e6 / 8 * 0.9 })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  }
  return { ctx, page, cdp }
}
for (let run = 0; run < runs; run++) for (const side of sides) {
  const { url, results, loads, runLoads } = side, load1 = loadavg()[0]; runLoads.push(load1)
  // layout shift on a load that opens scrolled to a region: a page of its own, before the run's page
  for (const m of sc.measure.filter((x) => x.type === 'load-shift')) {
    const { ctx, page } = await newPage()
    if (m.delay) await page.route(/\/data\/[^/]+\.json/, async (r) => { await new Promise((d) => setTimeout(d, m.delay)); await r.continue() }) // results arrive after the page has painted, as on a slow link
    try { await page.goto(url + '#' + m.hash, { waitUntil: 'load' }); await page.waitForSelector(sc.ready ?? 'body', { timeout: 60000 }); await page.waitForTimeout(500); results[m.name].push(await page.evaluate(() => window.__speed.shift)); loads[m.name].push(load1) } catch (e) { console.log(`run ${run + 1}: ${m.name}: ${e.message}`) }
    await ctx.close()
  }
  const { ctx, page, cdp } = await newPage()
  await page.goto(url, { waitUntil: 'load' }); await page.waitForSelector(sc.ready ?? 'body', { timeout: 60000 }); await page.waitForTimeout(500)
  const centre = async (sel) => { const loc = page.locator(sel).first(); if (!(await loc.count())) throw new Error('not on this page: ' + sel); await loc.scrollIntoViewIfNeeded(); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); const b = await loc.boundingBox(); if (!b) throw new Error('not found: ' + sel); return b }
  const wait = (ms = 30000) => Promise.race([page.evaluate(() => window.__speed.p), new Promise((_, r) => setTimeout(() => r(new Error('timed out')), ms))])
  const loaded = () => page.evaluate(() => document.body.dataset.loaded ?? '')
  const tap = (m) => m.input ? m.input === 'tap' : coarse, act = async (m, sel = m.selector) => (tap(m) ? page.tap(sel) : page.click(sel))
  for (const m of sc.measure) {
    const push = (v) => { for (const x of [].concat(v)) { results[m.name].push(x); loads[m.name].push(loadavg()[0]) } }
    try {
      if (m.type === 'press') { const b = await centre(m.selector), x = b.x + b.width / 2, y = b.y + b.height / 2, before = await loaded()
        if (coarse) { await page.waitForTimeout(150); await page.evaluate((sel) => window.__speed.arm.press(sel), m.selector); await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); push(await wait()); await page.waitForTimeout(60); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }) }
        else { await page.mouse.move(x, y); await page.waitForTimeout(150); await page.evaluate((sel) => window.__speed.arm.press(sel), m.selector); await page.mouse.down(); push(await wait()); await page.waitForTimeout(60); await page.mouse.up() }
        await page.waitForFunction((b) => (document.body.dataset.loaded ?? '') !== b, before, { timeout: 60000 }).catch(() => {}); await page.waitForTimeout(400) } // the work the press started is finished before anything else is timed
      else if (m.type === 'move') { const b = await centre(m.selector); const xs = [0.3, 0.4, 0.5, 0.6, 0.7]; await page.mouse.move(b.x + b.width * 0.2, b.y + b.height / 2); await page.waitForTimeout(100); const one = []; for (const f of xs) { await page.evaluate(() => window.__speed.arm.move()); await page.mouse.move(b.x + b.width * f, b.y + b.height / 2); one.push(await wait()); await page.waitForTimeout(40) } push(one.sort((p, q) => p - q)[Math.ceil(one.length * 0.75) - 1]) }
      else if (m.type === 'drag') { const b = await centre(m.selector), y = b.y + b.height / 2, tp = (x) => [{ x, y }]; await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(b.x + b.width * 0.2) }); await page.waitForTimeout(100); const one = []
        for (const f of [0.3, 0.4, 0.5, 0.6, 0.7]) { await page.evaluate(() => window.__speed.arm.move()); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(b.x + b.width * f) }); one.push(await wait()); await page.waitForTimeout(40) }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); push(one.sort((p, q) => p - q)[Math.ceil(one.length * 0.75) - 1]) }
      else if (m.type === 'toggle') { await centre(m.selector); await page.evaluate((e) => window.__speed.arm.toggle(e), m.expect); await act(m); push(await wait()); await page.waitForTimeout(200); if (m.undo) { await act(m, typeof m.undo === 'string' ? m.undo : m.selector); await page.waitForTimeout(300) } }
      else if (m.type === 'send') { await centre(m.selector); const before = await loaded(); await page.evaluate(([e, u]) => window.__speed.arm.send(e, u), [m.expect, m.url]); await act(m); push(await wait()); await page.waitForFunction((b) => (document.body.dataset.loaded ?? '') !== b, before, { timeout: 60000 }).catch(() => {}); await page.waitForTimeout(400) }
      else if (m.type === 'response') { await centre(m.selector); if (m.before) await page.evaluate(m.before); const before = await loaded(); await page.evaluate(([u, e]) => window.__speed.arm.response(u, e), [m.url, m.expect]); await act(m); push(await wait()); await page.waitForFunction((b) => (document.body.dataset.loaded ?? '') !== b, before, { timeout: 60000 }).catch(() => {}); await page.waitForTimeout(400) }
      else if (m.type === 'type') { await page.click(m.selector); await page.keyboard.press('End'); await page.evaluate(([s, n]) => window.__speed.arm.type(s, n), [m.selector, m.text.length]); await page.keyboard.type(m.text, { delay: 120 }); const s = (await wait()).sort((p, q) => p - q); push(s[Math.ceil(s.length * 0.75) - 1]) }
      else if (m.type === 'shift') push(await page.evaluate(() => window.__speed.shift))
      else if (m.type === 'transitions') { await centre(m.selector); const n = page.evaluate((e) => new Promise((done) => { const tick = () => document.querySelector(e) ? done(document.getAnimations().filter((a) => a instanceof CSSTransition && a.playState === 'running').length) : requestAnimationFrame(tick); requestAnimationFrame(tick) }), m.expect); await act(m); push(await n); await page.waitForTimeout(200); if (m.undo) { await act(m, m.undo); await page.waitForTimeout(300) } }
      else if (m.type === 'load-shift') { /* measured above, on its own load */ }
      else if (m.type === 'inp') { await page.waitForTimeout(300); push(await page.evaluate(() => window.__speed.worstEvent)) }
      else throw new Error('unknown type ' + m.type)
    } catch (e) { console.log(`run ${run + 1}: ${m.name}: ${e.message}`) }
  }
  await ctx.close()
  process.stdout.write(`\rrun ${run + 1}/${runs}${sides.length > 1 ? ' ' + side.name : ''}, load ${load1.toFixed(1)}   `)
}
await browser.close(); for (const x of servers) x.close()
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] : NaN }
const fmt = (m, v) => (Number.isNaN(v) ? 'no data' : /shift/.test(m.type) ? v.toFixed(4) : m.type === 'transitions' ? String(v) : Math.round(v) + ' ms')
const end = loadavg(), out = { runs, throttled: !flag('--no-throttle'), viewport: [vw, vh], coarse, cores, judgedAtLoadAtMost: limit, calibrationMs: cal, loadAtEnd: end, at: new Date().toISOString(), sides: {} }
let over = 0
for (const side of sides) {
  const { url, results, loads, runLoads: la } = side
  console.log(`\n\n${sides.length > 1 ? side.name.toUpperCase() + ': ' : ''}${url}\n${runs} runs, ${flag('--no-throttle') ? 'no throttling' : 'CPU 4x, Fast 4G'}, ${vw}x${vh}${coarse ? ', coarse pointer and touch (presses and taps by CDP touch events)' : ''}. p75 is the budgeted figure.`)
  console.log(`Load: 1-minute load average at the start of each run ${Math.min(...la).toFixed(1)} to ${Math.max(...la).toFixed(1)} (median ${q(la, 0.5).toFixed(1)}) on ${cores} cores; at the end ${end.map((x) => x.toFixed(1)).join(' ')}. Calibration task ${Math.round(cal)} ms (about 100 ms on an idle core). A timing row is judged only when most of its samples were taken at a load of ${limit} or less.\n`)
  console.log('| What | Budget | p75 | Median | Worst | Samples | Load when taken (median, range) | |\n|---|---|---|---|---|---|---|---|')
  side.summary = sc.measure.map((m) => { const a = results[m.name], ld = loads[m.name], p75 = q(a, 0.75), busy = ld.filter((x) => x <= limit).length <= ld.length / 2, /* judged only when MOST samples were at or below the limit: a tie is not judged (v8; it was judged before) */ timing = !/shift|transitions/.test(m.type), judged = !(timing && busy), ok = a.length > 0 && p75 <= m.budget
    if (judged && !ok && side.name === 'after') over++
    console.log(`| ${m.name} | ${/shift|transitions/.test(m.type) ? m.budget : m.budget + ' ms'} | ${fmt(m, p75)} | ${fmt(m, q(a, 0.5))} | ${fmt(m, a.length ? Math.max(...a) : NaN)} | ${a.length} | ${ld.length ? `${q(ld, 0.5).toFixed(1)} (${Math.min(...ld).toFixed(1)} to ${Math.max(...ld).toFixed(1)})` : '-'} | ${!a.length ? 'no data' : !judged ? (ok ? 'within, not judged (load above ' + limit + ')' : 'over, not judged (load above ' + limit + ')') : ok ? 'within' : '**OVER**'} |`)
    return { name: m.name, type: m.type, budget: m.budget, p75, median: q(a, 0.5), worst: a.length ? Math.max(...a) : null, judged, runs: a, loads: ld } })
  out.sides[side.name] = { url, loadAtRunStart: la, measurements: side.summary }
}
if (opt('--out')) writeFileSync(opt('--out'), JSON.stringify(out, null, 2))
console.log(over ? `\n${over} judged measurement(s) over budget or without data.` : '\nEvery judged 75th percentile is within its budget (rows not judged are neither passed nor failed).')
process.exit(over && !flag('--no-fail') ? 1 : 0)
