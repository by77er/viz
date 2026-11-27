/* eslint-disable */
// The speed budgets (design-system/project/README.md, "Responsiveness and feedback") on the
// dashboards views of the built app, against the mock: 4x CPU slowdown and Fast 4G, as
// e2e/measure.cjs sets them, at the desktop layout (1440 x 900, mouse) or the phone layout
// (--phone: 400 x 800, touch, coarse pointer).
//
//   node e2e/measure-dashboards.cjs [--phone] [--runs 20] [--label dashboards]
//
// One run is one fresh tab: the list is loaded, a dashboard is opened from it (the 12-panel
// one), and when it has drawn, its range is changed. Nothing is read across a reload or any
// other change of document (design-system/reviews/system-v9/confirmation.md: touch emulation
// does not survive one), and the phone runs check that the pointer is coarse.
//
//   viewChange    the press on the dashboard's name in the list -> the frame that shows the
//                 dashboard's page: its name and intent (cached from the list) and its waiting
//                 region. Budget row "Moves to a view whose data is not loaded": 100 ms.
//   viewInp       that press as the browser reports it (Event Timing duration). Budget: 200 ms.
//   panelsShown   the press -> the frame in which the panels stand in their places, waiting
//                 (after the dashboard's spec has arrived: a network round trip; no budget row).
//   firstPaint    the first panel that is answered: its last response's body arrived -> the
//                 frame that shows it. Budget row "Receives a result": 100 ms after it arrives.
//   paintWorst    the same for the slowest of the twelve panels; paintMedian the median panel.
//   firstVisible  the press -> the first answered panel on screen (network included; context).
//   rangeSend     the press on "1 h" -> the first request of the new range is sent. Budget row
//                 "Runs a query: send the request and show the region's waiting state": 100 ms.
//   rangeBusy     the press on "1 h" -> the frame in which every panel is marked as waiting and
//                 says "Showing the previous range" (the region's waiting state). Same row.
//   rangeInp      that press as the browser reports it. Budget: 200 ms.
//   rangePaintWorst / rangePaintMedian   as paintWorst / paintMedian, for the new range.
//   cls*          layout-shift entries summed over the phase, twice: `unmarked` (what the
//                 browser counts: entries not following input) and `all` (every entry, those
//                 the browser marks as following input included). Budget: 0.05.
//
// Every sample records the machine's 1-minute load average at its start and end; the file
// records the core count and a calibration task. A row whose samples were mostly taken above a
// load of the core count is printed "not judged".
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const lib = require('./lib.cjs')
const { chromium, APP } = lib

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback }
const PHONE = process.argv.includes('--phone')
const RUNS = Number(arg('runs', '20'))
const LABEL = arg('label', 'dashboards')
const LAYOUT = PHONE ? { viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true } : { viewport: { width: 1440, height: 900 } }
const FAST_4G = { offline: false, latency: 165, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 }
const CORES = os.cpus().length
const DASHBOARD = 'services_overview'
const PANELS = 12
const calibrate = () => { const t0 = performance.now(); let x = 0; for (let i = 0; i < 3e7; i++) x += Math.sqrt(i) % 7; return [performance.now() - t0, x] }
const sorted = (xs) => xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b)
const p75 = (xs) => { const s = sorted(xs); return s.length ? s[Math.min(s.length - 1, Math.ceil(0.75 * s.length) - 1)] : null }
const median = (xs) => { const s = sorted(xs); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }

// Runs in the page before any of its scripts.
function instrument() {
  const m = (window.__d = { shifts: [], events: [], sent: [], arrived: [], marks: {}, panels: {}, press: null })
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) m.shifts.push({ value: e.value, marked: e.hadRecentInput, t: e.startTime }) }).observe({ type: 'layout-shift', buffered: true })
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) m.events.push({ name: e.name, duration: e.duration, t: e.startTime }) }).observe({ type: 'event', durationThreshold: 16, buffered: true })
  } catch {}
  // The frame after a change: a task queued from the animation frame runs once that frame has been produced.
  const afterFrame = (fn) => requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => fn(performance.now()); ch.port2.postMessage(0) })
  // When each query is sent, and when its body has arrived.
  const realFetch = window.fetch
  window.fetch = async (...a) => {
    const url = String(a[0] && a[0].url ? a[0].url : a[0])
    const query = /query_range$/.test(url) && a[1] && typeof a[1].body === 'string' ? new URLSearchParams(a[1].body).get('query') : null
    if (query !== null) m.sent.push({ query, t: performance.now() })
    const res = await realFetch(...a)
    if (query !== null) res.clone().text().then(() => m.arrived.push({ query, t: performance.now() }), () => {})
    return res
  }
  // The press that starts a phase, and what is watched for after it.
  const onPress = (e) => { if (m.press && !m.press.t && e.target.closest(m.press.selector)) m.press.t = e.timeStamp }
  addEventListener('pointerup', onPress, true)
  addEventListener('click', (e) => { if (m.press && !m.press.t && e.target.closest(m.press.selector)) m.press.t = e.timeStamp }, true)
  const once = (name, test) => {
    if (m.marks[name] !== undefined) return
    if (test()) { m.marks[name] = null; afterFrame((t) => (m.marks[name] = t)) }
  }
  const watch = () => {
    const title = document.querySelector('[data-testid=dashboard-title]')
    if (title && title.textContent.trim().length > 1) once(`${m.phase}:shell`, () => true)
    const panels = document.querySelectorAll('[data-testid=panel]')
    if (panels.length) once(`${m.phase}:panels`, () => true)
    let waiting = 0
    for (const p of panels) {
      const key = `${m.phase}:${p.dataset.panel}`
      if (p.dataset.state === 'waiting') waiting++
      if (p.dataset.state === 'answered' && !p.querySelector('[data-testid=panel-stale]') && m.panels[key] === undefined && m.armed) {
        m.panels[key] = { t: null, queries: [...p.querySelectorAll('[data-testid=open-in-explore]')].map((a) => new URL(a.href).searchParams.get('q')), top: p.getBoundingClientRect().top }
        afterFrame((t) => (m.panels[key].t = t))
      }
    }
    if (m.phase === 'range' && panels.length && waiting === panels.length && document.querySelectorAll('[data-testid=panel-stale]').length === panels.length) once('range:busy', () => true)
  }
  m.phase = 'view'
  m.armed = false
  document.addEventListener('DOMContentLoaded', () => new MutationObserver(watch).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'], characterData: true }))
}

const cls = (shifts, from, to) => {
  const within = shifts.filter((s) => s.t >= from && s.t < to)
  return { unmarked: within.filter((s) => !s.marked).reduce((a, s) => a + s.value, 0), all: within.reduce((a, s) => a + s.value, 0) }
}

async function run(browser) {
  const ctx = await browser.newContext({ ...LAYOUT, colorScheme: 'light' })
  const page = await ctx.newPage()
  await page.addInitScript(instrument)
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', FAST_4G)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const r = { at: new Date().toISOString(), load1: os.loadavg()[0] }
  try {
    await page.goto(`${APP}/dashboards`)
    await page.waitForSelector(`[data-testid=open-${DASHBOARD}]`)
    await page.waitForTimeout(1200)
    if (PHONE && !(await page.evaluate(() => matchMedia('(pointer: coarse)').matches))) throw new Error('the phone layout does not have a coarse pointer: the run is void')
    const listLoaded = await page.evaluate(() => performance.now())
    r.clsList = await page.evaluate(() => window.__d.shifts.reduce((a, s) => a + s.value, 0))

    // ---- list -> dashboard
    const press = async (selector) => {
      await page.evaluate((selector) => { window.__d.press = { selector, t: 0 }; window.__d.armed = true }, selector)
      if (PHONE) await page.tap(selector)
      else await page.click(selector)
    }
    await press(`[data-testid=open-${DASHBOARD}]`)
    await page.waitForFunction((n) => Object.values(window.__d.panels).filter((p) => p.t !== null).length >= n, PANELS, { timeout: 60000 })
    await page.waitForTimeout(1200)
    const view = await page.evaluate(() => { const d = window.__d; return { press: d.press.t, marks: d.marks, panels: d.panels, sent: d.sent, arrived: d.arrived, shifts: d.shifts, events: d.events, now: performance.now(), coarse: matchMedia('(pointer: coarse)').matches, y: scrollY } })
    if (PHONE && !view.coarse) throw new Error('the pointer is no longer coarse: the run is void')
    r.viewChange = view.marks['view:shell'] - view.press
    r.panelsShown = view.marks['view:panels'] - view.press
    r.viewInp = Math.max(0, ...view.events.filter((e) => e.t >= view.press - 200 && e.t <= view.press + 50).map((e) => e.duration))
    const delays = (panels, arrived, phase) => Object.entries(panels).filter(([k]) => k.startsWith(`${phase}:`)).map(([k, p]) => {
      const mine = arrived.filter((a) => p.queries.includes(a.query) && a.t <= p.t)
      // The last body this panel waited for (each of its queries' latest arrival, the latest of those).
      const last = Math.max(...p.queries.map((q) => Math.max(...mine.filter((a) => a.query === q).map((a) => a.t), -Infinity)))
      return { panel: k.split(':')[1], t: p.t, top: p.top, delay: p.t - last }
    }).filter((d) => Number.isFinite(d.delay)).sort((a, b) => a.t - b.t)
    const vd = delays(view.panels, view.arrived, 'view')
    r.firstPaint = vd[0]?.delay ?? null
    r.firstPanel = vd[0]?.panel ?? null
    r.firstVisible = vd[0] ? vd[0].t - view.press : null
    r.paintWorst = Math.max(...vd.map((d) => d.delay))
    r.paintWorstPanel = vd.find((d) => d.delay === r.paintWorst)?.panel ?? null
    r.paintMedian = median(vd.map((d) => d.delay))
    r.allPainted = vd.length ? vd[vd.length - 1].t - view.press : null
    r.panelsTimed = vd.length
    r.clsView = cls(view.shifts, listLoaded, view.now)

    // ---- the range changes
    await page.evaluate(() => { const d = window.__d; d.phase = 'range'; d.sent.length = 0; d.arrived.length = 0 })
    const before = view.now
    await press('[data-testid=preset-1h]')
    await page.waitForFunction((n) => Object.keys(window.__d.panels).filter((k) => k.startsWith('range:') && window.__d.panels[k].t !== null).length >= n, PANELS, { timeout: 60000 })
    await page.waitForTimeout(1200)
    const range = await page.evaluate(() => { const d = window.__d; return { press: d.press.t, marks: d.marks, panels: d.panels, sent: d.sent, arrived: d.arrived, shifts: d.shifts, events: d.events, now: performance.now(), y: scrollY, coarse: matchMedia('(pointer: coarse)').matches } })
    r.rangeSend = range.sent.length ? range.sent[0].t - range.press : null
    r.rangeBusy = range.marks['range:busy'] != null ? range.marks['range:busy'] - range.press : null
    r.rangeInp = Math.max(0, ...range.events.filter((e) => e.t >= range.press - 200 && e.t <= range.press + 50).map((e) => e.duration))
    const rd = delays(range.panels, range.arrived, 'range')
    r.rangePaintWorst = Math.max(...rd.map((d) => d.delay))
    r.rangePaintWorstPanel = rd.find((d) => d.delay === r.rangePaintWorst)?.panel ?? null
    r.rangePaintMedian = median(rd.map((d) => d.delay))
    r.rangeFirstPaint = rd[0]?.delay ?? null
    r.rangeAllPainted = rd.length ? rd[rd.length - 1].t - range.press : null
    r.rangeScrollKept = range.y === view.y
    r.clsRange = cls(range.shifts, before, range.now)
    if (PHONE && !range.coarse) throw new Error('the pointer is no longer coarse: the run is void')
  } finally {
    r.loadEnd = os.loadavg()[0]
    await ctx.close()
  }
  return r
}

async function main() {
  const calibrationMs = [calibrate()[0], calibrate()[0], calibrate()[0]].sort((a, b) => a - b)[1]
  console.log(`${PHONE ? 'phone (400 x 800, touch)' : 'desktop (1440 x 900)'}; calibration ${calibrationMs.toFixed(0)} ms, ${CORES} cores, load ${os.loadavg().map((x) => x.toFixed(2)).join(' ')}`)
  const stop = await lib.startServers()
  const browser = await chromium.launch()
  const runs = []
  const voided = []
  try {
    for (let i = 0; i < RUNS; i++) {
      try {
        const r = await run(browser)
        runs.push(r)
        console.log(`run ${String(i + 1).padStart(2)}: load ${r.load1.toFixed(2)}  viewChange ${r.viewChange.toFixed(0)}  viewInp ${r.viewInp.toFixed(0)}  firstPaint ${r.firstPaint?.toFixed(0)} (${r.firstPanel})  paintWorst ${r.paintWorst.toFixed(0)} (${r.paintWorstPanel})  rangeSend ${r.rangeSend?.toFixed(0)}  rangeBusy ${r.rangeBusy?.toFixed(0)}  rangeInp ${r.rangeInp.toFixed(0)}  rangePaintWorst ${r.rangePaintWorst.toFixed(0)} (${r.rangePaintWorstPanel})  cls ${r.clsView.all.toFixed(4)}/${r.clsRange.all.toFixed(4)}`)
      } catch (e) {
        voided.push(String(e.message).slice(0, 200))
        console.log(`run ${i + 1}: void (${String(e.message).slice(0, 120)})`)
      }
    }
  } finally {
    await browser.close()
    stop()
  }
  const keys = ['viewChange', 'viewInp', 'panelsShown', 'firstPaint', 'paintMedian', 'paintWorst', 'firstVisible', 'allPainted', 'rangeSend', 'rangeBusy', 'rangeInp', 'rangeFirstPaint', 'rangePaintMedian', 'rangePaintWorst', 'rangeAllPainted']
  const summary = {}
  for (const k of keys) { const xs = runs.map((r) => r[k]); summary[k] = { p75: p75(xs), median: median(xs), max: Math.max(...sorted(xs)), min: Math.min(...sorted(xs)), n: sorted(xs).length } }
  for (const k of ['clsList']) { const xs = runs.map((r) => r[k]); summary[k] = { p75: p75(xs), median: median(xs), max: Math.max(...xs) } }
  for (const k of ['clsView', 'clsRange']) for (const kind of ['unmarked', 'all']) { const xs = runs.map((r) => r[k][kind]); summary[`${k}.${kind}`] = { p75: p75(xs), median: median(xs), max: Math.max(...xs) } }
  const loaded = runs.filter((r) => Math.max(r.load1, r.loadEnd) > CORES).length
  const judged = loaded <= runs.length / 2
  const out = { label: LABEL, layout: PHONE ? 'phone' : 'desktop', dashboard: DASHBOARD, when: new Date().toISOString(), runs: runs.length, voided, cores: CORES, calibrationMs, setup: 'CPU 4x slowdown, Fast 4G (165 ms latency, 9 Mbit/s down, 1.5 up), the built app on the mock', load: { min: Math.min(...runs.map((r) => r.load1)), max: Math.max(...runs.map((r) => Math.max(r.load1, r.loadEnd))), median: median(runs.map((r) => r.load1)), samplesAboveCores: loaded }, judged, scrollKept: runs.filter((r) => r.rangeScrollKept).length, firstPanels: runs.map((r) => r.firstPanel), summary, samples: runs }
  const file = path.join(lib.ROOT, 'e2e', 'measurements', `${LABEL}-${PHONE ? 'phone' : 'desktop'}.json`)
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n')
  const f = (v) => (v == null ? 'n/a' : v < 1 ? v.toFixed(4) : v.toFixed(0))
  console.log(`\n${PHONE ? 'phone' : 'desktop'}: 75th percentile of ${runs.length} runs (median, worst)${judged ? '' : '  NOT JUDGED: most samples were taken above a load of ' + CORES}`)
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(20)} ${f(v.p75).padStart(8)}   (${f(v.median)}, ${f(v.max)})`)
  console.log(`  load at the samples: ${out.load.min.toFixed(2)} to ${out.load.max.toFixed(2)} (median ${out.load.median.toFixed(2)}); ${loaded} of ${runs.length} above ${CORES}`)
  console.log(`  written to ${path.relative(lib.ROOT, file)}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
