/* eslint-disable */
// The speed budgets (design-system/project/README.md, "Responsiveness and feedback") on the
// dashboards views of the built app, against the mock: 4x CPU slowdown and Fast 4G, as
// e2e/measure.cjs sets them, at the desktop layout (1440 x 900, mouse) or the phone layout
// (--phone: 400 x 800, touch, coarse pointer).
//
//   node e2e/measure-dashboards.cjs [--phone] [--runs 20] [--label dashboards] [--compare <app dir of the build before>]
//
// With --compare, the build in <dir>/dist is served beside this one (port + 2, the same mock) and
// the runs alternate run by run, before then after, so the two share the machine's load; every
// run records `uptime` and the build it ran on, and the summary gives each build's figures and
// the paired differences (after minus before, run pair by run pair).
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
//                 A panel counts as painted in the frame that shows what it draws: a chart once its
//                 plot is in the page (a chart off screen may be drawn later, in its reserved
//                 place, D-B2), anything else once it is answered.
//   paintWorstOn  the same for the panels on screen when their answer arrived (in the viewport):
//                 what a person can see. paintWorstOff: those off screen (context).
//   firstVisible  the press -> the first answered panel on screen (network included; context).
//   rangeSend     the press on "1 h" -> the first request of the new range is sent. Budget row
//                 "Runs a query: send the request and show the region's waiting state": 100 ms.
//   rangeBusy     the press on "1 h" -> the frame in which every panel is marked as waiting and
//                 says "Showing the previous range" (the region's waiting state). Same row.
//   rangeInp      that press as the browser reports it. Budget: 200 ms.
//   rangePaintWorst / rangePaintMedian   as paintWorst / paintMedian, for the new range.
//   jumpGap       (--jump, review round 4, D-B3) a fresh tab: the press on the dashboard in the list, and the moment its lowest
//                 chart is answered (in that task) a jump to it (scrollIntoView, centred) -> the frame after its plot is in the
//                 page. jumpGapWorst: the same for the last of the charts the jump brought into view without a plot (jumpInView
//                 of them). Rule: a chart off screen may wait, but is painted within 100 ms of coming into view.
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
// --jump: the D-B3 runs instead (runJump): a jump to the lowest chart the moment it is answered.
const JUMP = process.argv.includes('--jump')
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
  const m = (window.__d = { shifts: [], events: [], sent: [], arrived: [], marks: {}, panels: {}, seen: {}, press: null })
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
  // Frames begun since the press: a waiting state seen before the first one is in the frame the press paints next.
  const onPress = (e) => {
    if (!(m.press && !m.press.t && e.target.closest(m.press.selector))) return
    m.press.t = e.timeStamp
    m.frames = 0
    const tick = () => { m.frames++; if (m.frames < 120) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  }
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
      if (p.dataset.state === 'answered' && m.seen[key] === undefined && m.armed && !p.querySelector('[data-testid=panel-stale]')) {
        const r = p.getBoundingClientRect()
        m.seen[key] = { on: r.top < innerHeight && r.bottom > 0 }
      }
      const drawn = p.dataset.kind !== 'timeseries' || p.querySelector('svg.vz-plot, [data-testid=panel-empty], [data-testid=panel-error]')
      if (p.dataset.state === 'answered' && drawn && !p.querySelector('[data-testid=panel-stale]') && m.panels[key] === undefined && m.armed) {
        m.panels[key] = { t: null, queries: [...p.querySelectorAll('[data-testid=open-in-explore]')].map((a) => new URL(a.href).searchParams.get('q')), top: p.getBoundingClientRect().top, on: m.seen[key]?.on ?? true }
        afterFrame((t) => (m.panels[key].t = t))
      }
    }
    // D-B3: the lowest chart, the moment it is answered, is jumped to; timed from the jump to the frame after its plot is in the page.
    if (m.phase === 'jump' && m.armed && panels.length) {
      const charts = [...panels].filter((p) => p.dataset.kind === 'timeseries')
      const target = charts[charts.length - 1]
      if (target && m.jump === undefined && target.dataset.state === 'answered') {
        const box = target.getBoundingClientRect()
        m.jump = { panel: target.dataset.panel, deferred: !!target.querySelector('[data-testid=panel-deferred]'), drawnAtJump: !!target.querySelector('svg.vz-plot'), offScreen: box.top >= innerHeight || box.bottom <= 0, answeredAt: performance.now(), t: performance.now(), painted: null, othersDeferred: document.querySelectorAll('[data-testid=panel-deferred]').length }
        target.scrollIntoView({ block: 'center' })
        m.jump.t = performance.now()
        // Every chart the jump brought into view without its plot: each is timed the same way (the worst is jumpGapWorst).
        m.jump.others = charts.filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && !p.querySelector('svg.vz-plot') }).map((p) => ({ panel: p.dataset.panel, painted: null, marked: false }))
      }
      if (m.jump && m.jump.painted === null && !m.jump.marked && target && target.querySelector('svg.vz-plot')) { m.jump.marked = true; afterFrame((t) => (m.jump.painted = t)) }
      if (m.jump) for (const o of m.jump.others) { const p = document.querySelector(`[data-testid=panel][data-panel=${o.panel}]`); if (!o.marked && p && p.querySelector('svg.vz-plot')) { o.marked = true; afterFrame((t) => (o.painted = t)) } }
    }
    if (m.phase === 'range' && panels.length && waiting === panels.length && document.querySelectorAll('[data-testid=panel-stale]').length === panels.length) { if (m.busyFrames === undefined) m.busyFrames = m.frames; once('range:busy', () => true) }
  }
  m.phase = 'view'
  m.armed = false
  document.addEventListener('DOMContentLoaded', () => new MutationObserver(watch).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'], characterData: true }))
}

const cls = (shifts, from, to) => {
  const within = shifts.filter((s) => s.t >= from && s.t < to)
  return { unmarked: within.filter((s) => !s.marked).reduce((a, s) => a + s.value, 0), all: within.reduce((a, s) => a + s.value, 0) }
}

async function run(browser, APP) {
  const ctx = await browser.newContext({ ...LAYOUT, colorScheme: 'light' })
  const page = await ctx.newPage()
  await page.addInitScript(instrument)
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', FAST_4G)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const r = { at: new Date().toISOString(), load1: os.loadavg()[0], uptime: require('node:child_process').execSync('uptime').toString().trim() }
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
      return { panel: k.split(':')[1], t: p.t, top: p.top, on: p.on, delay: p.t - last }
    }).filter((d) => Number.isFinite(d.delay)).sort((a, b) => a.t - b.t)
    const vd = delays(view.panels, view.arrived, 'view')
    r.firstPaint = vd[0]?.delay ?? null
    r.firstPanel = vd[0]?.panel ?? null
    r.firstVisible = vd[0] ? vd[0].t - view.press : null
    r.paintWorst = Math.max(...vd.map((d) => d.delay))
    r.paintWorstPanel = vd.find((d) => d.delay === r.paintWorst)?.panel ?? null
    r.paintMedian = median(vd.map((d) => d.delay))
    r.paintWorstOn = Math.max(...vd.filter((d) => d.on).map((d) => d.delay))
    r.paintWorstOff = vd.some((d) => !d.on) ? Math.max(...vd.filter((d) => !d.on).map((d) => d.delay)) : null
    r.onScreen = vd.filter((d) => d.on).map((d) => d.panel).join(',')
    r.allPainted = vd.length ? vd[vd.length - 1].t - view.press : null
    r.panelsTimed = vd.length
    r.clsView = cls(view.shifts, listLoaded, view.now)

    // ---- the range changes
    await page.evaluate(() => { const d = window.__d; d.phase = 'range'; d.sent.length = 0; d.arrived.length = 0 })
    const before = view.now
    await press('[data-testid=preset-1h]')
    await page.waitForFunction((n) => Object.keys(window.__d.panels).filter((k) => k.startsWith('range:') && window.__d.panels[k].t !== null).length >= n, PANELS, { timeout: 60000 })
    await page.waitForTimeout(1200)
    const range = await page.evaluate(() => { const d = window.__d; return { press: d.press.t, busyFrames: d.busyFrames ?? null, marks: d.marks, panels: d.panels, sent: d.sent, arrived: d.arrived, shifts: d.shifts, events: d.events, now: performance.now(), y: scrollY, coarse: matchMedia('(pointer: coarse)').matches } })
    r.rangeSend = range.sent.length ? range.sent[0].t - range.press : null
    // The frame that shows every panel waiting. When they were marked in the press's own task (before any frame began after it), it is
    // the press's next paint, as Event Timing reports it; otherwise the frame after the task that marked them (a task queued from
    // that frame's animation callback), as before. Only the first is affected by a task queued after the frame (the page's own).
    r.rangeBusyTask = range.marks['range:busy'] != null ? range.marks['range:busy'] - range.press : null
    const pressPaint = Math.max(...range.events.filter((e) => ['pointerdown', 'pointerup', 'click'].includes(e.name) && e.t >= range.press - 200 && e.t <= range.press + 50).map((e) => e.t + e.duration))
    r.rangeBusyInPress = range.busyFrames === 0
    r.rangeBusy = r.rangeBusyInPress && Number.isFinite(pressPaint) ? pressPaint - range.press : r.rangeBusyTask
    r.rangeInp = Math.max(0, ...range.events.filter((e) => e.t >= range.press - 200 && e.t <= range.press + 50).map((e) => e.duration))
    const rd = delays(range.panels, range.arrived, 'range')
    r.rangePaintWorst = Math.max(...rd.map((d) => d.delay))
    r.rangePaintWorstPanel = rd.find((d) => d.delay === r.rangePaintWorst)?.panel ?? null
    r.rangePaintMedian = median(rd.map((d) => d.delay))
    r.rangePaintWorstOn = Math.max(...rd.filter((d) => d.on).map((d) => d.delay))
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

// D-B3: a fresh tab; the list, the press on the dashboard, and the moment its lowest chart is answered a jump to it (scrollIntoView,
// in the task that marked it answered); the jump -> the frame after its plot is in the page. `jumpDeferred` says whether the chart was
// still waiting to be drawn at the jump (a chart already drawn is timed the same way: the frame that shows it).
async function runJump(browser, APP) {
  const ctx = await browser.newContext({ ...LAYOUT, colorScheme: 'light' })
  const page = await ctx.newPage()
  await page.addInitScript(instrument)
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', FAST_4G)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const r = { at: new Date().toISOString(), load1: os.loadavg()[0], uptime: require('node:child_process').execSync('uptime').toString().trim() }
  try {
    await page.goto(`${APP}/dashboards`)
    await page.waitForSelector(`[data-testid=open-${DASHBOARD}]`)
    await page.waitForTimeout(1200)
    if (PHONE && !(await page.evaluate(() => matchMedia('(pointer: coarse)').matches))) throw new Error('the phone layout does not have a coarse pointer: the run is void')
    const selector = `[data-testid=open-${DASHBOARD}]`
    await page.evaluate((selector) => { const d = window.__d; d.phase = 'jump'; d.press = { selector, t: 0 }; d.armed = true }, selector)
    if (PHONE) await page.tap(selector)
    else await page.click(selector)
    await page.waitForFunction(() => window.__d.jump && window.__d.jump.painted != null && window.__d.jump.others.every((o) => o.painted != null), null, { timeout: 60000 })
    const j = await page.evaluate(() => ({ ...window.__d.jump, press: window.__d.press.t, coarse: matchMedia('(pointer: coarse)').matches }))
    if (PHONE && !j.coarse) throw new Error('the pointer is no longer coarse: the run is void')
    r.jumpGap = j.painted - j.t
    r.jumpGapWorst = Math.max(r.jumpGap, ...j.others.map((o) => o.painted - j.t))
    r.jumpInView = j.others.length
    r.jumpDeferred = j.deferred
    r.jumpOffScreen = j.offScreen
    r.jumpPanel = j.panel
    r.jumpAnsweredAfterPress = j.answeredAt - j.press
    r.jumpOthersDeferred = j.othersDeferred
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
  const BEFORE = arg('compare', null)
  const stopBefore = BEFORE ? await lib.startPreview(lib.APP_PORT + 2, lib.MOCK, path.resolve(BEFORE)) : () => {}
  const builds = BEFORE ? [['before', `http://127.0.0.1:${lib.APP_PORT + 2}`], ['after', APP]] : [['this', APP]]
  const browser = await chromium.launch()
  const runs = []
  const voided = []
  try {
    for (let i = 0; i < RUNS * builds.length; i++) {
      const [build, base] = builds[i % builds.length]
      try {
        const r = JUMP ? await runJump(browser, base) : await run(browser, base)
        r.build = build
        r.pair = Math.floor(i / builds.length)
        runs.push(r)
        if (JUMP) { console.log(`run ${String(i + 1).padStart(2)} ${build}: load ${r.load1.toFixed(2)}  jumpGap ${r.jumpGap.toFixed(0)} worst in view ${r.jumpGapWorst.toFixed(0)} of ${r.jumpInView} (${r.jumpPanel}, ${r.jumpDeferred ? 'deferred' : 'drawn'} at the jump, ${r.jumpOffScreen ? 'off screen' : 'on screen'}, answered ${r.jumpAnsweredAfterPress.toFixed(0)} ms after the press, ${r.jumpOthersDeferred} waiting)  ${r.uptime}`); continue }
        console.log(`run ${String(i + 1).padStart(2)} ${build}: load ${r.load1.toFixed(2)}  viewChange ${r.viewChange.toFixed(0)}  viewInp ${r.viewInp.toFixed(0)}  firstPaint ${r.firstPaint?.toFixed(0)} (${r.firstPanel})  paintWorst ${r.paintWorst.toFixed(0)} (${r.paintWorstPanel}) on screen ${r.paintWorstOn.toFixed(0)}  rangeSend ${r.rangeSend?.toFixed(0)}  rangeBusy ${r.rangeBusy?.toFixed(0)}  rangeInp ${r.rangeInp.toFixed(0)}  rangePaintWorst ${r.rangePaintWorst.toFixed(0)} (${r.rangePaintWorstPanel})  cls ${r.clsView.all.toFixed(4)}/${r.clsRange.all.toFixed(4)}`)
      } catch (e) {
        voided.push(String(e.message).slice(0, 200))
        console.log(`run ${i + 1}: void (${String(e.message).slice(0, 120)})`)
      }
    }
  } finally {
    await browser.close()
    stopBefore()
    stop()
  }
  const keys = JUMP ? ['jumpGap', 'jumpGapWorst', 'jumpInView', 'jumpAnsweredAfterPress'] : ['viewChange', 'viewInp', 'panelsShown', 'firstPaint', 'paintMedian', 'paintWorstOn', 'paintWorst', 'paintWorstOff', 'firstVisible', 'allPainted', 'rangeSend', 'rangeBusy', 'rangeBusyTask', 'rangeInp', 'rangeFirstPaint', 'rangePaintMedian', 'rangePaintWorstOn', 'rangePaintWorst', 'rangeAllPainted']
  if (BEFORE) {
    // Each build's figures, and the paired differences (after minus before, pair by pair).
    const f0 = (v) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(0))
    const by = (b) => runs.filter((r) => r.build === b)
    const lines = [`| What | before p75 (median, worst) | after p75 (median, worst) | paired difference, after - before: median (p25 to p75), n |`, '|---|---|---|---|']
    for (const k of JUMP ? keys : [...keys, 'clsView.all', 'clsRange.all']) {
      const get = (r) => k.includes('.') ? r[k.split('.')[0]][k.split('.')[1]] : r[k]
      const cell = (xs) => { const s = sorted(xs); return s.length ? `${k.startsWith('cls') ? p75(xs).toFixed(4) : f0(p75(xs))} (${k.startsWith('cls') ? median(xs).toFixed(4) : f0(median(xs))}, ${k.startsWith('cls') ? s.at(-1).toFixed(4) : f0(s.at(-1))})` : 'n/a' }
      const diffs = []
      for (const a of by('after')) { const b = by('before').find((x) => x.pair === a.pair); if (b && Number.isFinite(get(a)) && Number.isFinite(get(b))) diffs.push(get(a) - get(b)) }
      const ds = sorted(diffs)
      const q = (f) => ds[Math.min(ds.length - 1, Math.max(0, Math.ceil(f * ds.length) - 1))]
      lines.push(`| ${k} | ${cell(by('before').map(get))} | ${cell(by('after').map(get))} | ${ds.length ? `${k.startsWith('cls') ? median(ds).toFixed(4) : f0(median(ds))} (${k.startsWith('cls') ? q(0.25).toFixed(4) : f0(q(0.25))} to ${k.startsWith('cls') ? q(0.75).toFixed(4) : f0(q(0.75))}), ${ds.length}` : 'n/a'} |`)
    }
    const loads = runs.flatMap((r) => [r.load1, r.loadEnd])
    lines.push('', `load ${Math.min(...loads).toFixed(2)} to ${Math.max(...loads).toFixed(2)} (median ${median(loads).toFixed(2)}), ${loads.filter((l) => l > CORES).length} of ${loads.length} samples above ${CORES}; ${runs[0].at} to ${runs.at(-1).at}; calibration ${calibrationMs.toFixed(0)} ms`)
    const file = path.join(lib.ROOT, 'e2e', 'measurements', `${LABEL}-${PHONE ? 'phone' : 'desktop'}.compare.md`)
    fs.writeFileSync(file, lines.join('\n') + '\n')
    console.log('\n' + lines.join('\n'))
  }
  const summary = {}
  for (const k of keys) { const xs = runs.map((r) => r[k]); summary[k] = { p75: p75(xs), median: median(xs), max: Math.max(...sorted(xs)), min: Math.min(...sorted(xs)), n: sorted(xs).length } }
  if (JUMP) for (const b of builds.map((x) => x[0])) { const xs = runs.filter((r) => r.build === b); summary[`jumpDeferred.${b}`] = { p75: xs.filter((r) => r.jumpDeferred).length, median: xs.length, max: xs.filter((r) => r.jumpOffScreen).length } }
  if (!JUMP) for (const k of ['clsList']) { const xs = runs.map((r) => r[k]); summary[k] = { p75: p75(xs), median: median(xs), max: Math.max(...xs) } }
  if (!JUMP) for (const k of ['clsView', 'clsRange']) for (const kind of ['unmarked', 'all']) { const xs = runs.map((r) => r[k][kind]); summary[`${k}.${kind}`] = { p75: p75(xs), median: median(xs), max: Math.max(...xs) } }
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
