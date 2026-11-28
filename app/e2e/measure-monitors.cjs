/* eslint-disable */
// The speed budgets (design-system/project/README.md, "Responsiveness and feedback") on the
// monitors views of the built app, against the mock: 4x CPU slowdown and Fast 4G (165 ms), as
// e2e/measure-dashboards.cjs sets them, at the desktop layout (1440 x 900, mouse) or the phone
// layout (--phone: 400 x 800, touch emulation, coarse pointer).
//
//   VIZ_E2E_APP_PORT=… VIZ_E2E_MOCK_PORT=… node e2e/measure-monitors.cjs [--phone] [--runs 20] [--label monitors] [--compare <app dir of the build before>]
//
// With --compare, the build in <dir>/dist is served beside this one (port + 2, the same mock) and
// the runs alternate run by run, before then after; every run records `uptime` and its build, and
// the summary adds the paired differences (after minus before, pair by pair).
//
// One run is one fresh tab on a reset mock: the list is loaded, the firing monitor is opened
// from it, and when its chart and history are drawn, Acknowledge is pressed. Nothing is read
// across a reload or another change of document (design-system/reviews/system-v9/confirmation.md:
// touch emulation does not survive one); a phone run is void unless the pointer is coarse.
//
//   viewChange   the press on the monitor's name in the list -> the frame that shows its page:
//                its name and state line (from the list) and its waiting region. Budget row
//                "Moves to a view whose data is not loaded": 100 ms.
//   viewInp      that press as the browser reports it (Event Timing). Budget: 200 ms.
//   firstPaint   the chart's query_range body arrived -> the frame that shows the chart. Budget
//                row "Receives a result": 100 ms after it arrives.
//   ackShown     the press on Acknowledge -> the frame that shows "Acknowledged by you at …"
//                (after the write's answer: one round trip; the press itself is painted by the
//                system's press script at pointerdown). Context: the round trip dominates.
//   ackPressed   the press on Acknowledge -> the frame in which it is busy (aria-busy): the
//                region's waiting state for a write. Budget row "Runs a query": 100 ms.
//   ackInp       that press as the browser reports it. Budget: 200 ms.
//   cls.all      every layout-shift entry from the press on the list until the monitor has
//                drawn, those the browser marks as following input included. Budget: 0.05.
//
// Every run records the 1-minute load average at its start and end (os.loadavg, as `uptime`
// prints it); the file records the core count and a calibration task. A row whose samples were
// mostly taken above a load of the core count is printed "not judged".
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const lib = require('./lib.cjs')
const { chromium, APP, MOCK } = lib

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback }
const PHONE = process.argv.includes('--phone')
const RUNS = Number(arg('runs', '20'))
const LABEL = arg('label', 'monitors')
const LAYOUT = PHONE ? { viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true } : { viewport: { width: 1440, height: 900 } }
const FAST_4G = { offline: false, latency: 165, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 }
const CORES = os.cpus().length
const calibrate = () => { const t0 = performance.now(); let x = 0; for (let i = 0; i < 3e7; i++) x += Math.sqrt(i) % 7; return [performance.now() - t0, x] }
const sorted = (xs) => xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b)
const p75 = (xs) => { const s = sorted(xs); return s.length ? s[Math.min(s.length - 1, Math.ceil(0.75 * s.length) - 1)] : null }
const median = (xs) => { const s = sorted(xs); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }
const hook = (q) => fetch(`${MOCK}/__mock/monitors?${q}`).then((r) => r.json())

function instrument() {
  const m = (window.__m = { shifts: [], events: [], arrived: [], marks: {}, press: null })
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) m.shifts.push({ value: e.value, marked: e.hadRecentInput, t: e.startTime }) }).observe({ type: 'layout-shift', buffered: true })
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) m.events.push({ name: e.name, duration: e.duration, t: e.startTime }) }).observe({ type: 'event', durationThreshold: 16, buffered: true })
  } catch {}
  const afterFrame = (fn) => requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => fn(performance.now()); ch.port2.postMessage(0) })
  const realFetch = window.fetch
  window.fetch = async (...a) => {
    const url = String(a[0] && a[0].url ? a[0].url : a[0])
    const res = await realFetch(...a)
    if (/query_range$/.test(url)) res.clone().text().then(() => m.arrived.push(performance.now()), () => {})
    return res
  }
  // Frames begun since the press: what is on screen before the first one is in the frame the press paints next.
  const onPress = (e) => {
    if (!(m.press && !m.press.t && e.target.closest(m.press.selector))) return
    m.press.t = e.timeStamp
    m.frames = 0
    const tick = () => { m.frames++; if (m.frames < 120) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  }
  addEventListener('pointerup', onPress, true)
  addEventListener('click', onPress, true)
  const once = (name) => { if (m.marks[name] === undefined) { m.marks[name] = null; afterFrame((t) => (m.marks[name] = t)) } }
  const watch = () => {
    if (!m.press) return
    if (m.phase === 'view') {
      const title = document.querySelector('[data-testid=monitor-title]')
      if (title && title.textContent.trim().length > 1 && document.querySelector('[data-testid=monitor-mark]')) { if (m.shellFrames === undefined) m.shellFrames = m.frames; once('view:shell') }
      if (document.querySelector('[data-testid=monitor-chart] svg.vz-plot .vz-line')) once('view:chart')
      if (document.querySelector('[data-testid=history-line]') && document.querySelector('[data-testid=monitor-chart] svg.vz-plot')) once('view:settled')
    }
    if (m.phase === 'ack') {
      if (document.querySelector('[data-testid=acknowledge][aria-busy=true]')) once('ack:busy')
      if (document.querySelector('[data-testid=ack-done]')) once('ack:done')
      if (/Acknowledged by you/.test(document.querySelector('[data-testid=history-line]')?.textContent ?? '')) once('ack:reread')
    }
  }
  document.addEventListener('DOMContentLoaded', () => new MutationObserver(watch).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy', 'data-state'], characterData: true }))
}

async function run(browser, id, APP) {
  await hook('reset=1')
  const ctx = await browser.newContext({ ...LAYOUT, colorScheme: 'light' })
  const page = await ctx.newPage()
  await page.addInitScript(instrument)
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', FAST_4G)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const r = { at: new Date().toISOString(), load1: os.loadavg()[0], uptime: require('node:child_process').execSync('uptime').toString().trim() }
  try {
    await page.goto(`${APP}/monitors`)
    await page.waitForSelector('[data-testid=monitor-row]', { timeout: 30000 })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(500)
    r.coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
    const sel = `[data-testid=open-${id}]`
    await page.evaluate((s) => { window.__m.phase = 'view'; window.__m.press = { selector: s, t: 0 } }, sel)
    const shiftsFrom = await page.evaluate(() => performance.now())
    if (PHONE) await page.tap(sel)
    else await page.click(sel)
    await page.waitForFunction(() => window.__m.marks['view:settled'] > 0 && window.__m.marks['view:chart'] > 0, null, { timeout: 30000 })
    await page.waitForTimeout(600)
    const v = await page.evaluate(() => window.__m)
    // The frame that shows the monitor's page. Shown in the press's own task (before any frame began after it), it is the press's
    // next paint as Event Timing reports it; otherwise, as before, a task queued from the animation callback of the frame after
    // the task that showed it (`viewChangeTask`, printed too: a task the page queues after that frame delays it).
    r.viewChangeTask = v.marks['view:shell'] - v.press.t
    const pressPaint = Math.max(...v.events.filter((e) => ['pointerdown', 'pointerup', 'click'].includes(e.name) && e.t >= v.press.t - 200 && e.t <= v.press.t + 50).map((e) => e.t + e.duration))
    r.viewInPress = v.shellFrames === 0
    r.viewChange = r.viewInPress && Number.isFinite(pressPaint) ? pressPaint - v.press.t : r.viewChangeTask
    r.firstPaint = v.marks['view:chart'] - Math.max(...v.arrived)
    r.viewInp = Math.max(0, ...v.events.filter((e) => e.t >= v.press.t - 50 && e.t <= v.press.t + 500).map((e) => e.duration))
    const within = v.shifts.filter((s) => s.t >= shiftsFrom)
    r.cls = { all: within.reduce((a, s) => a + s.value, 0), unmarked: within.filter((s) => !s.marked).reduce((a, s) => a + s.value, 0) }
    // Acknowledge, at the top of the page.
    await page.evaluate(() => scrollTo(0, 0))
    await page.evaluate(() => { window.__m.phase = 'ack'; window.__m.press = { selector: '[data-testid=acknowledge]', t: 0 }; window.__m.events = [] })
    if (PHONE) await page.tap('[data-testid=acknowledge]')
    else await page.click('[data-testid=acknowledge]')
    await page.waitForFunction(() => window.__m.marks['ack:done'] > 0 && window.__m.marks['ack:reread'] > 0, null, { timeout: 30000 })
    await page.waitForTimeout(300)
    const a = await page.evaluate(() => window.__m)
    r.ackPressed = a.marks['ack:busy'] - a.press.t
    r.ackShown = a.marks['ack:done'] - a.press.t
    r.ackReread = a.marks['ack:reread'] - a.press.t
    r.ackInp = Math.max(0, ...a.events.filter((e) => e.t >= a.press.t - 50 && e.t <= a.press.t + 500).map((e) => e.duration))
    r.void = PHONE && !r.coarse
  } catch (e) {
    r.void = true
    r.error = String(e).slice(0, 200)
  } finally {
    r.load1End = os.loadavg()[0]
    await ctx.close()
  }
  return r
}

async function main() {
  const stop = await lib.startServers()
  const BEFORE = arg('compare', null)
  const stopBefore = BEFORE ? await lib.startPreview(lib.APP_PORT + 2, MOCK, path.resolve(BEFORE)) : () => {}
  const builds = BEFORE ? [['before', `http://127.0.0.1:${lib.APP_PORT + 2}`], ['after', APP]] : [['this', APP]]
  const browser = await chromium.launch()
  const [calMs] = calibrate()
  const list = await fetch(`${MOCK}/api/v1/monitors?filter=all`).then((r) => r.json())
  const id = list.monitors.find((m) => m.name === 'Checkout 5xx ratio').id
  const runs = []
  try {
    for (let i = 0; i < RUNS * builds.length; i++) {
      const [build, base] = builds[i % builds.length]
      const r = await run(browser, id, base)
      r.build = build
      r.pair = Math.floor(i / builds.length)
      runs.push(r)
      console.log(`run ${i + 1} ${build}: view ${r.viewChange?.toFixed(0)} chart ${r.firstPaint?.toFixed(0)} ackBusy ${r.ackPressed?.toFixed(0)} ackShown ${r.ackShown?.toFixed(0)} cls ${r.cls?.all?.toFixed(4)} load ${r.load1.toFixed(2)}${r.void ? ` VOID ${r.error ?? 'pointer not coarse'}` : ''}`)
    }
  } finally {
    await browser.close()
    stopBefore()
    stop()
  }
  if (BEFORE) {
    const f0 = (v, k) => (v == null || !Number.isFinite(v) ? 'n/a' : k === 'cls' ? v.toFixed(4) : v.toFixed(0))
    const by = (b) => runs.filter((r) => r.build === b && !r.void)
    const lines = ['| What | before p75 (median, worst) | after p75 (median, worst) | paired difference, after - before: median (p25 to p75), n |', '|---|---|---|---|']
    for (const k of ['viewChange', 'viewChangeTask', 'viewInp', 'firstPaint', 'ackPressed', 'ackInp', 'ackShown', 'ackReread', 'cls']) {
      const get = (r) => (k === 'cls' ? r.cls?.all : r[k])
      const cell = (xs) => { const s = sorted(xs); return s.length ? `${f0(p75(xs), k)} (${f0(median(xs), k)}, ${f0(s.at(-1), k)})` : 'n/a' }
      const diffs = []
      for (const a of by('after')) { const b = by('before').find((x) => x.pair === a.pair); if (b && Number.isFinite(get(a)) && Number.isFinite(get(b))) diffs.push(get(a) - get(b)) }
      const ds = sorted(diffs)
      const q = (f) => ds[Math.min(ds.length - 1, Math.max(0, Math.ceil(f * ds.length) - 1))]
      lines.push(`| ${k} | ${cell(by('before').map(get))} | ${cell(by('after').map(get))} | ${ds.length ? `${f0(median(ds), k)} (${f0(q(0.25), k)} to ${f0(q(0.75), k)}), ${ds.length}` : 'n/a'} |`)
    }
    const loads = runs.flatMap((r) => [r.load1, r.load1End])
    lines.push('', `monitors, ${PHONE ? 'phone' : 'desktop'}; load ${Math.min(...loads).toFixed(2)} to ${Math.max(...loads).toFixed(2)} (median ${median(loads).toFixed(2)}), ${loads.filter((l) => l > CORES).length} of ${loads.length} samples above ${CORES}; ${runs[0].at} to ${runs.at(-1).at}; calibration ${calMs.toFixed(0)} ms; void ${runs.filter((r) => r.void).length}`)
    const dir = path.join(__dirname, 'measurements')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${LABEL}-${PHONE ? 'phone' : 'desktop'}.compare.md`), lines.join('\n') + '\n')
    fs.writeFileSync(path.join(dir, `${LABEL}-${PHONE ? 'phone' : 'desktop'}.json`), JSON.stringify({ cores: CORES, calibrationMs: calMs, runs }, null, 1))
    console.log('\n' + lines.join('\n'))
    return
  }
  const ok = runs.filter((r) => !r.void)
  const loads = runs.flatMap((r) => [r.load1, r.load1End])
  const judged = loads.filter((l) => l <= CORES).length > loads.length / 2
  const row = (name, limit, key, pick = (r) => r[key]) => {
    const xs = ok.map(pick)
    const s = sorted(xs)
    return `| ${name} | ${limit} | ${p75(xs)?.toFixed(key === 'cls' ? 4 : 0)} (${median(xs)?.toFixed(key === 'cls' ? 4 : 0)}, ${s.at(-1)?.toFixed(key === 'cls' ? 4 : 0)}) |`
  }
  const lines = [
    `monitors, ${PHONE ? 'phone 400 x 800, touch, coarse pointer' : 'desktop 1440 x 900, mouse'}, ${RUNS} runs (${ok.length} counted), measured here ${runs[0].at} to ${runs.at(-1).at}`,
    `cores ${CORES}, calibration ${calMs.toFixed(0)} ms, 1-minute load ${Math.min(...loads).toFixed(2)} to ${Math.max(...loads).toFixed(2)} (median ${median(loads).toFixed(2)}), ${loads.filter((l) => l > CORES).length} of ${loads.length} samples above ${CORES}: ${judged ? 'judged' : 'NOT JUDGED (timing rows)'}`,
    '',
    '| What | Limit | p75 (median, worst) |',
    '|---|---|---|',
    row('List -> monitor: its page (name, state line, waiting region) painted (`viewChange`)', '100 ms', 'viewChange'),
    row('That press, Interaction to Next Paint (`viewInp`)', '200 ms', 'viewInp'),
    row('The chart: query body arrived -> painted (`firstPaint`)', '100 ms', 'firstPaint'),
    row('Acknowledge pressed -> busy painted (`ackPressed`)', '100 ms', 'ackPressed'),
    row('That press, Interaction to Next Paint (`ackInp`)', '200 ms', 'ackInp'),
    row('Acknowledge pressed -> "Acknowledged by you at …" painted (`ackShown`; one round trip at 165 ms)', 'context', 'ackShown'),
    row('Acknowledge pressed -> the re-read painted (history says so) (`ackReread`; two round trips)', 'context', 'ackReread'),
    row('Layout shift, press on the list until the monitor has drawn, every entry (`cls.all`)', '0.05', 'cls', (r) => r.cls.all),
  ]
  const out = lines.join('\n')
  console.log('\n' + out)
  const dir = path.join(__dirname, 'measurements')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${LABEL}-${PHONE ? 'phone' : 'desktop'}`)
  fs.writeFileSync(`${file}.txt`, out + '\n')
  fs.writeFileSync(`${file}.json`, JSON.stringify({ cores: CORES, calibrationMs: calMs, runs }, null, 1))
}

main().catch((e) => { console.error(e); process.exit(1) })
