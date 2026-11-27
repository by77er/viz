/* eslint-disable */
// Where the time between "the body has arrived" and "the result is painted" goes.
//   node profile.cjs --root <app dir with dist/> --series 36,200 [--phone] [--runs 5] [--out file.json] [--table]
// The same setup as app/e2e/measure.cjs (CPU 4x, Fast 4G, fresh context per run); per run a
// Chrome trace (devtools.timeline) and a sampling CPU profile are taken around the press on
// "Run query" (and, with --table, around Chart -> Table). The window [from, to] is cut out of
// both: timeline events give style / layout / paint / idle, the CPU profile gives JS self time
// by function (use an unminified build for names).
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback }
const LIB = arg('lib', path.resolve(__dirname, '../../../../app/e2e/lib.cjs'))
const lib = require(LIB)
const { chromium, url, Q_RATE } = lib
const ROOT = path.resolve(arg('root', lib.ROOT))
const RUNS = Number(arg('runs', '5'))
const CASES = arg('series', '36,200').split(',').map(Number)
const PHONE = process.argv.includes('--phone')
const TABLE = process.argv.includes('--table')
const OUT = arg('out', null)
const QUERIES = { 4: Q_RATE, 12: 'pod_memory_working_set_bytes', 36: lib.Q_MANY, 200: 'viz_synthetic_series' }
const LAYOUT = PHONE ? { viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } }
const FAST_4G = { offline: false, latency: 165, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 }
const median = (xs) => { const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }

function instrument() {
  const m = (window.__m = { resp: null, frames: [], rec: null })
  const afterFrame = (fn) => requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => fn(performance.now()); ch.port2.postMessage(0) })
  const realFetch = window.fetch
  window.fetch = async (...a) => {
    const res = await realFetch(...a)
    if (!window.__noclone && String(a[0] && a[0].url ? a[0].url : a[0]).includes('query_range')) res.clone().text().then(() => { m.resp = performance.now() })
    return res
  }
  new MutationObserver((records) => {
    if (!m.rec) return
    const panel = document.querySelector('section[aria-label="Query result"], [data-testid=result]')
    if (!panel || !records.some((r) => panel.contains(r.target))) return
    const t = performance.now()
    const say = (n) => (n.nodeType === 1 ? n.tagName.toLowerCase() + (n.dataset && n.dataset.testid ? '[' + n.dataset.testid + ']' : '') + '.' + String(n.className.baseVal ?? n.className).split(' ').join('.') : '#text in ' + (n.parentElement ? n.parentElement.tagName.toLowerCase() + '.' + n.parentElement.className : '?'))
    const what = [...new Set(records.filter((r) => panel.contains(r.target)).map((r) => r.type + (r.attributeName ? '(' + r.attributeName + ')' : '') + ' ' + say(r.target)))].slice(0, 12)
    afterFrame((end) => m.frames.push({ t, end, what }))
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
  m.settle = () => {
    const entries = performance.getEntriesByType('resource').filter((e) => e.name.includes('query_range') && e.startTime >= m.rec.armedAt)
    const last = entries[entries.length - 1]
    const lastByte = last && last.responseEnd > 0 ? last.responseEnd : null
    if (lastByte === null) return null
    const after = m.frames.filter((f) => f.t >= lastByte)
    if (after.length === 0) return null
    let k = 0
    while (k + 1 < after.length && after[k + 1].t - after[k].t <= 250) k++
    if (k === after.length - 1 && performance.now() - after[k].t < 250) return null
    return { lastByte, resp: m.resp, firstChange: after[0].t, paintAt: after[k].end, frames: k + 1, list: after.slice(0, k + 1) }
  }
  m.arm = (done) => {
    const rec = (m.rec = { tUp: null, done: null, doneAt: null, armedAt: performance.now(), result: null })
    m.resp = null; m.frames = []
    window.addEventListener('pointerup', (e) => {
      rec.tUp = e.timeStamp
      const visible = (sel) => { const el = document.querySelector(sel); return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' }
      const poll = () => {
        if (done === 'result') { const r = m.settle(); if (r) { rec.result = r; rec.done = 1; rec.anchor = performance.now(); performance.mark('vz-anchor'); return } }
        else if (visible(done)) { afterFrame((t) => { rec.doneAt = t; rec.done = t - rec.tUp; rec.anchor = performance.now(); performance.mark('vz-anchor') }); return }
        requestAnimationFrame(poll)
      }
      poll()
    }, { capture: true, once: true })
  }
}

async function press(page, cdp, selector, done) {
  const target = page.locator(selector).first()
  await target.scrollIntoViewIfNeeded()
  await page.waitForTimeout(100)
  await page.evaluate((d) => window.__m.arm(d), done)
  const box = await target.boundingBox()
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  if (PHONE) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await page.waitForTimeout(80)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await page.mouse.move(x, y)
    await page.waitForTimeout(150)
    await page.mouse.down()
    await page.waitForTimeout(80)
    await page.mouse.up()
  }
  await page.waitForFunction(() => window.__m.rec.done !== null, null, { timeout: 30000 })
  return page.evaluate(() => window.__m.rec)
}

const CATS = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'v8', 'devtools.timeline.frame', ...(process.argv.includes('--raw') ? ['toplevel', 'loading', 'blink', 'blink.resource', 'mojom', 'ipc', 'netlog', 'net', 'disabled-by-default-toplevel.flow', 'scheduler', 'renderer.scheduler', 'sequence_manager', 'base'] : [])]
async function traced(cdp, fn) {
  const events = []
  const onData = (d) => { for (const e of d.value) events.push(e) }
  cdp.on('Tracing.dataCollected', onData)
  // --noprofiler: the trace only (the sampling profiler slows the page and keeps code in the lower tiers longer)
  const SAMPLE = !process.argv.includes('--noprofiler')
  if (SAMPLE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 250 }) }
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: CATS, recordMode: 'recordAsMuchAsPossible' }, transferMode: 'ReportEvents' })
  if (SAMPLE) await cdp.send('Profiler.start')
  const rec = await fn()
  const { profile } = SAMPLE ? await cdp.send('Profiler.stop') : { profile: { nodes: [], samples: [], timeDeltas: [], startTime: 0 } }
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r))
  await cdp.send('Tracing.end')
  await done
  cdp.off('Tracing.dataCollected', onData)
  return { rec, events, profile }
}

/** Self time by event name on the main thread within [w0, w1] (trace microseconds). */
function timeline(events, tid, pid, w0, w1) {
  const xs = events.filter((e) => e.ph === 'X' && e.tid === tid && e.pid === pid && e.ts < w1 && e.ts + (e.dur || 0) > w0).sort((a, b) => a.ts - b.ts || (b.dur || 0) - (a.dur || 0))
  const self = {}
  const stack = []
  const add = (name, a, b) => { const d = Math.max(0, Math.min(b, w1) - Math.max(a, w0)); if (d > 0) self[name] = (self[name] || 0) + d }
  let cursor = null
  // sweep: at every boundary, the time since the last boundary belongs to the top of the stack
  const close = (until) => {
    while (stack.length && stack[stack.length - 1].end <= until) {
      const top = stack.pop()
      add(top.name, cursor, top.end); cursor = top.end
    }
  }
  for (const e of xs) {
    const end = e.ts + (e.dur || 0)
    close(e.ts)
    if (stack.length) add(stack[stack.length - 1].name, cursor, e.ts)
    else if (cursor !== null) add('(idle: no task)', cursor, e.ts)
    else add('(idle: no task)', w0, e.ts)
    cursor = e.ts
    stack.push({ name: e.name, end })
  }
  close(Infinity)
  if (cursor !== null && cursor < w1) add('(idle: no task)', cursor, w1)
  if (cursor === null) add('(idle: no task)', w0, w1)
  return self
}

/** JS self time by function within [w0, w1], from the sampling profile. */
function jsSelf(profile, w0, w1) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const parent = new Map()
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id)
  const self = {}, incl = {}
  let t = profile.startTime
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i]
    const next = i + 1 < profile.samples.length ? profile.timeDeltas[i + 1] : 0
    const a = Math.max(t, w0), b = Math.min(t + next, w1)
    if (b <= a) continue
    const n = byId.get(profile.samples[i])
    const name = (id) => { const f = byId.get(id).callFrame; return `${f.functionName || '(anonymous)'}${f.url ? ` @${path.basename(f.url).replace(/-[A-Za-z0-9_]{8}\./, '.')}:${f.lineNumber + 1}` : ''}` }
    self[name(n.id)] = (self[name(n.id)] || 0) + (b - a)
    const seen = new Set()
    for (let id = n.id; id != null; id = parent.get(id)) { const k = name(id); if (!seen.has(k)) { seen.add(k); incl[k] = (incl[k] || 0) + (b - a) } }
  }
  return { self, incl }
}

function analyse({ rec, events, profile }, kind) {
  const anchors = events.filter((e) => e.name === 'vz-anchor' && e.cat && e.cat.includes('blink.user_timing'))
  const anchor = anchors[anchors.length - 1]
  if (!anchor) throw new Error('no anchor mark in the trace')
  const off = anchor.ts - rec.anchor * 1000 // trace us = performance.now() ms * 1000 + off
  const toTs = (ms) => ms * 1000 + off
  const { tid, pid } = anchor
  const windows = kind === 'result'
    ? { fromBodyRead: [rec.result.resp ?? rec.result.lastByte, rec.result.paintAt], fromLastByte: [rec.result.lastByte, rec.result.paintAt] }
    : { local: [rec.tUp, rec.doneAt] }
  const out = { ms: {}, timeline: {}, js: {}, jsIncl: {} }
  for (const [k, [a, b]] of Object.entries(windows)) {
    out.ms[k] = b - a
    out.timeline[k] = timeline(events, tid, pid, toTs(a), toTs(b))
    const j = jsSelf(profile, toTs(a), toTs(b))
    out.js[k] = j.self; out.jsIncl[k] = j.incl
  }
  if (kind === 'result') out.marks = { lastByteToBodyRead: (rec.result.resp ?? rec.result.lastByte) - rec.result.lastByte, bodyReadToFirstChange: rec.result.firstChange - (rec.result.resp ?? rec.result.lastByte), frames: rec.result.frames }
  return out
}

const merge = (runs, pick) => {
  const keys = new Set(runs.flatMap((r) => Object.keys(pick(r))))
  const o = {}
  for (const k of keys) o[k] = median(runs.map((r) => pick(r)[k] || 0)) / 1000
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v >= 0.3).sort((a, b) => b[1] - a[1]))
}
const table = (title, o, top = 30) => { console.log(`  ${title}`); for (const [k, v] of Object.entries(o).slice(0, top)) console.log(`    ${v.toFixed(1).padStart(7)} ms  ${k}`) }

async function main() {
  const stop = await lib.startServers(ROOT)
  const result = { root: ROOT, layout: PHONE ? 'phone' : 'desktop', cores: os.cpus().length, when: new Date().toISOString(), cases: {} }
  try {
    const browser = await chromium.launch()
    for (const SERIES of CASES) {
      const runs = [], tables = []
      for (let i = 0; i < RUNS; i++) {
        const ctx = await browser.newContext({ ...LAYOUT, colorScheme: 'light' })
        const page = await ctx.newPage()
        if (process.argv.includes('--noclone')) await page.addInitScript(() => { window.__noclone = true })
        await page.addInitScript(instrument)
        const cdp = await ctx.newCDPSession(page)
        // --nobuffer: neither this session nor Playwright's own keeps a copy of response bodies for DevTools (Network.getResponseBody)
        if (process.argv.includes('--nobuffer')) {
          const impl = page._connection.toImpl(page)
          const client = impl.delegate ? impl.delegate._mainFrameSession._client : impl._delegate._mainFrameSession._client
          await client.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 })
        } else await cdp.send('Network.enable')
        await cdp.send('Network.emulateNetworkConditions', FAST_4G)
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
        const load1 = os.loadavg()[0]
        await page.goto(url(QUERIES[SERIES]))
        await page.waitForSelector('[data-testid=chart] tbody tr[data-key]', { state: 'attached' })
        await page.waitForSelector('.cm-content')
        if (arg('css', null)) await page.addStyleTag({ content: arg('css', '') })
        await page.waitForTimeout(1200)
        const t = await traced(cdp, () => press(page, cdp, '[data-testid=run]', 'result'))
        const a = analyse(t, 'result'); a.load1 = load1
        if (process.argv.includes('--frames')) for (const f of t.rec.result.list) console.log(`    change at +${(f.t - t.rec.result.lastByte).toFixed(1)} ms, frame ended +${(f.end - t.rec.result.lastByte).toFixed(1)} ms: ${f.what.join(' | ')}`)
        if (process.argv.includes('--raw')) fs.writeFileSync(OUT + '.raw.json', JSON.stringify({ rec: t.rec, events: t.events }))
        runs.push(a)
        console.log(`[${SERIES}${PHONE ? ' phone' : ''}] run ${i + 1}: load ${load1.toFixed(1)} bodyRead->paint ${a.ms.fromBodyRead.toFixed(0)} ms, lastByte->paint ${a.ms.fromLastByte.toFixed(0)} ms, lastByte->bodyRead ${a.marks.lastByteToBodyRead.toFixed(0)}, bodyRead->firstChange ${a.marks.bodyReadToFirstChange.toFixed(0)}, frames ${a.marks.frames}`)
        if (TABLE) {
          await page.waitForTimeout(1500)
          const tt = await traced(cdp, () => press(page, cdp, '[data-testid=view-table]', '[data-testid=result-table] tbody tr'))
          const b = analyse(tt, 'local'); b.load1 = load1
          tables.push(b)
          console.log(`[${SERIES}${PHONE ? ' phone' : ''}] run ${i + 1}: chart->table ${b.ms.local.toFixed(0)} ms`)
        }
        await ctx.close()
      }
      const c = (result.cases[SERIES] = { load: runs.map((r) => r.load1), ms: {}, timeline: {}, js: {}, jsIncl: {} })
      for (const w of ['fromBodyRead', 'fromLastByte']) {
        c.ms[w] = { median: median(runs.map((r) => r.ms[w])), all: runs.map((r) => Math.round(r.ms[w])) }
        c.timeline[w] = merge(runs, (r) => r.timeline[w]); c.js[w] = merge(runs, (r) => r.js[w]); c.jsIncl[w] = merge(runs, (r) => r.jsIncl[w])
      }
      c.marks = { lastByteToBodyRead: median(runs.map((r) => r.marks.lastByteToBodyRead)), bodyReadToFirstChange: median(runs.map((r) => r.marks.bodyReadToFirstChange)) }
      console.log(`\n== ${SERIES} series, ${result.layout}: median of ${RUNS} runs; load ${c.load.map((x) => x.toFixed(1)).join(' ')}`)
      console.log(`  body read -> painted ${c.ms.fromBodyRead.median.toFixed(0)} ms (${c.ms.fromBodyRead.all.join(', ')}); last byte -> painted ${c.ms.fromLastByte.median.toFixed(0)} ms (${c.ms.fromLastByte.all.join(', ')}); last byte -> body read ${c.marks.lastByteToBodyRead.toFixed(0)} ms`)
      table('timeline, self time, from body read', c.timeline.fromBodyRead, 16)
      table('timeline, self time, from last byte', c.timeline.fromLastByte, 16)
      table('JS self, from body read', c.js.fromBodyRead, 28)
      table('JS inclusive, from body read', c.jsIncl.fromBodyRead, 45)
      table('JS inclusive, from last byte', c.jsIncl.fromLastByte, 30)
      if (TABLE) {
        c.table = { ms: { median: median(tables.map((r) => r.ms.local)), all: tables.map((r) => Math.round(r.ms.local)) }, timeline: merge(tables, (r) => r.timeline.local), js: merge(tables, (r) => r.js.local), jsIncl: merge(tables, (r) => r.jsIncl.local) }
        console.log(`  chart -> table ${c.table.ms.median.toFixed(0)} ms (${c.table.ms.all.join(', ')})`)
        table('timeline, self time', c.table.timeline, 16); table('JS self', c.table.js, 25); table('JS inclusive', c.table.jsIncl, 40)
      }
    }
    await browser.close()
  } finally { stop() }
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 1) + '\n')
}
main().catch((e) => { console.error(e); process.exit(1) })
