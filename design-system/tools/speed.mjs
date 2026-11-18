// The shared speed harness. Measures the budgets in project/README.md ("Responsiveness and feedback") the same way for everyone.
//   node tools/speed.mjs <scenario.json> [--runs N] [--out results.json] [--no-throttle] [--no-fail]
// Reference setup: Chromium, CPU slowed 4x (CDP Emulation.setCPUThrottlingRate), network shaped to DevTools' "Fast 4G"
// (9 Mbit/s down, 1.5 Mbit/s up, 60 ms latency, with DevTools' multipliers: 0.9 on throughput, 2.75 on latency = 165 ms),
// a fresh browser context per run, 20 runs. Prints, per measurement, the 75th percentile (the budgeted figure), the median and
// the worst run, against its budget, and exits non-zero if a 75th percentile is over budget.
//
// Scenario: { "url": URL or file path (a file is served from its folder's parent on a free port in 8900-8909, so the network shaping applies),
//             "ready": selector that exists once the first results are painted, "runs": 20, "viewport": [1440, 900],
//             "measure": [ ... ] }  Each entry has "name", "type", "budget" and:
//   press     selector                    pointer down on it -> end of the next frame (the pressed state painted). Budget 50 ms.
//   type      selector, text              each key down in the editor -> end of the frame that shows the character. Budget 50 ms.
//   move      selector                    each pointer move across it -> end of the next frame (crosshair). Budget 50 ms.
//   toggle    selector, expect            click on it -> end of the first frame in which `expect` matches (a local change). Budget 100 ms.
//   response  selector, url, expect       click on it; from the moment the response whose URL contains `url` arrives -> end of the first
//             [, before]                  frame in which `expect` matches. `before` is script run first (to clear what `expect` looks for). Budget 100 ms.
//   shift     -                           cumulative layout shift over the whole run, load included (also reported: shifts within 500 ms of input).
//   inp       -                           the longest interaction of the run by Event Timing (8 ms steps). Budget 200 ms.
// "End of the frame" is taken as a task posted from requestAnimationFrame, which runs after that frame's style, layout and paint.
// Times start at the input event's own timestamp, so input delay is included.
// Say with every number whether it was measured on the system's fixture page (a floor) or on the application.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve, dirname, join, extname, basename } from 'node:path'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
const args = process.argv.slice(2), flag = (n) => args.includes(n), opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const file = args.find((x) => x.endsWith('.json') && x !== opt('--out'))
if (!file) { console.log('usage: speed.mjs <scenario.json> [--runs N] [--out results.json] [--no-throttle] [--no-fail]'); process.exit(2) }
const sc = JSON.parse(readFileSync(file, 'utf8')), runs = +(opt('--runs') ?? sc.runs ?? 20), [vw, vh] = sc.viewport ?? [1440, 900]

let url = sc.url, server
if (!url.includes('://')) {
  const page = resolve(url), base = dirname(dirname(page)) // one level up, so sibling folders (fonts) resolve
  const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png' }
  server = createServer((req, res) => { const p = join(base, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(base) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); res.end(); return } res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' }); res.end(readFileSync(p)) })
  let port = 8900
  for (; port <= 8909; port++) { const ok = await new Promise((r) => { server.once('error', () => r(false)); server.listen(port, '127.0.0.1', () => r(true)) }); if (ok) break; server.removeAllListeners('error') }
  if (port > 8909) { console.log('no free port in 8900-8909'); process.exit(2) }
  url = `http://127.0.0.1:${port}/${basename(dirname(page))}/${basename(page)}`
}

// In the page: timing helpers. Nothing here changes what the page does.
const inPage = () => {
  const afterPaint = (cb) => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => cb(performance.now()); c.port2.postMessage(0) })
  const z = (window.__speed = { afterPaint, shift: 0, shiftAfterInput: 0, worstEvent: 0, responses: [], samples: [] })
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (e.hadRecentInput) z.shiftAfterInput += e.value; else z.shift += e.value } }).observe({ type: 'layout-shift', buffered: true }) } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId && e.duration > z.worstEvent) z.worstEvent = e.duration }).observe({ type: 'event', durationThreshold: 16, buffered: true }) } catch {}
  const realFetch = window.fetch
  // a response has "arrived" when its body has: a copy is read to the end, without delaying the page's own read
  window.fetch = async (...a) => { const r = await realFetch(...a); r.clone().arrayBuffer().then(() => z.responses.push([String(a[0]?.url ?? a[0]), performance.now()]), () => {}); return r }
  const visible = (sel) => { const e = document.querySelector(sel); return !!e && e.getClientRects().length > 0 }
  // resolves with (end of the frame in which `sel` first matches) - start
  z.until = (sel, start) => new Promise((done) => { const tick = () => { if (visible(sel)) afterPaint((t) => done(t - start())); else requestAnimationFrame(tick) }; tick() })
  z.once = (type, target) => new Promise((done) => { (target ?? document).addEventListener(type, (e) => done(e.timeStamp), { capture: true, once: true }) })
  z.arm = { // each returns a promise the harness awaits after sending the real input
    press() { z.p = z.once('pointerdown').then((t0) => new Promise((d) => afterPaint((t) => d(t - t0)))) },
    move() { z.p = z.once('pointermove').then((t0) => new Promise((d) => afterPaint((t) => d(t - t0)))) },
    toggle(expect) { z.p = z.once('click').then((t0) => z.until(expect, () => t0)) },
    response(part, expect) { const from = z.responses.length; z.p = z.once('click').then(() => new Promise((d) => { const wait = () => { const hit = z.responses.slice(from).find((r) => r[0].includes(part)); if (hit) z.until(expect, () => hit[1]).then(d); else requestAnimationFrame(wait) }; wait() })) },
    type(sel, n) { z.samples = []; const el = document.querySelector(sel); let t0 = 0; el.addEventListener('keydown', (e) => { t0 = e.timeStamp }, true); el.addEventListener('input', () => { const s = t0; afterPaint((t) => z.samples.push(t - s)) }, true); z.p = new Promise((d) => { const w = () => (z.samples.length >= n ? d(z.samples) : setTimeout(w, 20)); w() }) },
  }
}

const results = Object.fromEntries(sc.measure.map((m) => [m.name, []]))
const browser = await chromium.launch()
for (let run = 0; run < runs; run++) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh } }), page = await ctx.newPage(), cdp = await ctx.newCDPSession(page)
  await page.addInitScript(inPage)
  if (!flag('--no-throttle')) {
    await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 165, downloadThroughput: 9e6 / 8 * 0.9, uploadThroughput: 1.5e6 / 8 * 0.9 })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  }
  await page.goto(url, { waitUntil: 'load' }); await page.waitForSelector(sc.ready ?? 'body', { timeout: 60000 }); await page.waitForTimeout(500)
  const centre = async (sel) => { const loc = page.locator(sel).first(); await loc.scrollIntoViewIfNeeded(); const b = await loc.boundingBox(); if (!b) throw new Error('not found: ' + sel); return b }
  const wait = (ms = 30000) => Promise.race([page.evaluate(() => window.__speed.p), new Promise((_, r) => setTimeout(() => r(new Error('timed out')), ms))])
  for (const m of sc.measure) {
    const push = (v) => results[m.name].push(...[].concat(v))
    try {
      if (m.type === 'press') { const b = await centre(m.selector); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(150); await page.evaluate(() => window.__speed.arm.press()); await page.mouse.down(); push(await wait()); await page.waitForTimeout(60); await page.mouse.up(); await page.waitForSelector(sc.ready ?? 'body'); await page.waitForTimeout(400) }
      else if (m.type === 'move') { const b = await centre(m.selector); const xs = [0.3, 0.4, 0.5, 0.6, 0.7]; await page.mouse.move(b.x + b.width * 0.2, b.y + b.height / 2); await page.waitForTimeout(100); const one = []; for (const f of xs) { await page.evaluate(() => window.__speed.arm.move()); await page.mouse.move(b.x + b.width * f, b.y + b.height / 2); one.push(await wait()); await page.waitForTimeout(40) } push(one.sort((p, q) => p - q)[Math.ceil(one.length * 0.75) - 1]) }
      else if (m.type === 'toggle') { await centre(m.selector); await page.evaluate((e) => window.__speed.arm.toggle(e), m.expect); await page.click(m.selector); push(await wait()); await page.waitForTimeout(200) }
      else if (m.type === 'response') { await centre(m.selector); if (m.before) await page.evaluate(m.before); await page.evaluate(([u, e]) => window.__speed.arm.response(u, e), [m.url, m.expect]); await page.click(m.selector); push(await wait()); await page.waitForTimeout(600) }
      else if (m.type === 'type') { await page.click(m.selector); await page.keyboard.press('End'); await page.evaluate(([s, n]) => window.__speed.arm.type(s, n), [m.selector, m.text.length]); await page.keyboard.type(m.text, { delay: 120 }); const s = (await wait()).sort((p, q) => p - q); push(s[Math.ceil(s.length * 0.75) - 1]) }
      else if (m.type === 'shift') push(await page.evaluate(() => window.__speed.shift))
      else if (m.type === 'inp') { await page.waitForTimeout(300); push(await page.evaluate(() => window.__speed.worstEvent)) }
      else throw new Error('unknown type ' + m.type)
    } catch (e) { console.log(`run ${run + 1}: ${m.name}: ${e.message}`) }
  }
  await ctx.close()
  process.stdout.write(`\rrun ${run + 1}/${runs}`)
}
await browser.close(); server?.close()
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] : NaN }
const fmt = (m, v) => (Number.isNaN(v) ? 'no data' : m.type === 'shift' ? v.toFixed(4) : Math.round(v) + ' ms')
console.log(`\n\n${url}\n${runs} runs, ${flag('--no-throttle') ? 'no throttling' : 'CPU 4x, Fast 4G'}, ${vw}x${vh}. p75 is the budgeted figure.\n`)
console.log('| What | Budget | p75 | Median | Worst | Runs | |\n|---|---|---|---|---|---|---|')
let over = 0
const summary = sc.measure.map((m) => { const a = results[m.name], p75 = q(a, 0.75), ok = a.length > 0 && p75 <= m.budget; if (!ok) over++
  console.log(`| ${m.name} | ${m.type === 'shift' ? m.budget : m.budget + ' ms'} | ${fmt(m, p75)} | ${fmt(m, q(a, 0.5))} | ${fmt(m, a.length ? Math.max(...a) : NaN)} | ${a.length} | ${ok ? 'within' : '**OVER**'} |`)
  return { name: m.name, type: m.type, budget: m.budget, p75, median: q(a, 0.5), worst: a.length ? Math.max(...a) : null, runs: a } })
if (opt('--out')) writeFileSync(opt('--out'), JSON.stringify({ url, runs, throttled: !flag('--no-throttle'), at: new Date().toISOString(), measurements: summary }, null, 2))
console.log(over ? `\n${over} measurement(s) over budget or without data.` : '\nEvery 75th percentile is within its budget.')
process.exit(over && !flag('--no-fail') ? 1 : 0)
