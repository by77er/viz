/* eslint-disable */
// Density measurements of the viz app's views, as built in <dist dir>, on the worktree's mock.
//   node measure.cjs <label> <dist dir> <out dir> [--shots] [--only a,b]
// Serves <dist dir> with `vite preview --outDir`, the mock from the worktree, both on their own ports, and stops them.
// Configurations: 1440x900 fine pointer (mouse), and 400x800 coarse pointer made coarse in Blink (--blink-settings + isMobile),
// as design-system/tools/audit.mjs does for its reload pass, so the coarse rules hold across navigation.
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const http = require('node:http')
const WT = '/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/wt-density'
const { chromium } = require('playwright')
const [label, distDir, outDir, ...rest] = process.argv.slice(2)
const SHOTS = rest.includes('--shots')
const onlyIdx = rest.indexOf('--only')
const ONLY = onlyIdx >= 0 ? rest[onlyIdx + 1].split(',') : null
const APP_PORT = Number(process.env.D_APP_PORT || 8860)
const MOCK_PORT = Number(process.env.D_MOCK_PORT || 8861)
const APP = `http://127.0.0.1:${APP_PORT}`
const MOCK = `http://127.0.0.1:${MOCK_PORT}`
const T0 = Date.UTC(2026, 10, 18, 9, 30)
const T1 = Date.UTC(2026, 10, 18, 12, 30)
const Q_RATE = 'sum by (service) (rate(http_requests_total[5m]))'
const Q_MANY = 'sum by (service, route, status) (rate(http_requests_total[5m]))'
const RANGE = `from=${T0}&to=${T1}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ping = (u) => new Promise((res) => { const q = http.get(u, (r) => { r.resume(); res(r.statusCode) }); q.on('error', () => res(0)); q.setTimeout(3000, () => { q.destroy(); res(-1) }) })
async function waitFor(u, ms = 30000) { const t = Date.now(); while (Date.now() - t < ms) { if (await ping(u)) return true; await sleep(200) } return false }

const settled = (n) => (page) => page.waitForFunction((n) => document.querySelectorAll('[data-testid=panel]').length >= n && !document.querySelector('[data-testid=panel][data-state=waiting], [data-testid=panel][data-state=idle]'), n, { timeout: 30000 })
const chartReady = (page) => page.waitForSelector('[data-testid=result] svg.vz-plot .vz-line', { state: 'attached', timeout: 30000 })
const VIEWS = [
  ['explore-4', `/explore?q=${encodeURIComponent(Q_RATE)}&${RANGE}`, chartReady],
  ['explore-36', `/explore?q=${encodeURIComponent(Q_MANY)}&${RANGE}`, chartReady],
  ['list', `/dashboards`, (page) => page.waitForSelector('[data-testid=dashboard-row]')],
  ['services', `/dashboards?id=services_overview&${RANGE}`, settled(12)],
  ['red', `/dashboards?id=service_red&${RANGE}&var.service=orders&var.status=500`, settled(5)],
]
const COARSE = '--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1'
const LAYOUTS = [
  { name: '1440-fine', width: 1440, height: 900, coarse: false },
  { name: '400-coarse', width: 400, height: 800, coarse: true },
]

// Runs in the page: everything section 1 asks for, as rendered at scroll 0.
function inPage() {
  const vh = innerHeight, vw = innerWidth, sy = scrollY
  const shown = (el) => { const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && !el.closest('[hidden],.is-reserved,.is-parked,[aria-hidden=true]') }
  const doc = (r) => ({ top: r.top + sy, bottom: r.bottom + sy, left: r.left, right: r.right, height: r.height, width: r.width })
  const clipArea = (r) => Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))
  const panels = [...document.querySelectorAll('[data-testid=panel], [data-testid=result]')].filter(shown)
  const plots = [...document.querySelectorAll('svg.vz-plot')].filter(shown)
  const stats = [...document.querySelectorAll('.vz-stat-value')].filter(shown)
  const dataTables = [...document.querySelectorAll('table.vz-table:not(.vz-legend-table)')].filter(shown)
  const dataCells = dataTables.flatMap((t) => [...t.querySelectorAll('tbody td, tbody th')]).filter(shown)
  const firstRows = dataTables.map((t) => t.querySelector('tbody tr')).filter(Boolean).filter(shown)
  const legendCells = [...document.querySelectorAll('table.vz-legend-table tbody tr:not(.vz-legend-actions) td')].filter(shown)
  const marks = [...plots, ...stats, ...firstRows]
  const firstMark = marks.length ? Math.min(...marks.map((e) => doc(e.getBoundingClientRect()).top)) : null
  // A plot's own data area starts under its strip; the svg's top is the strip.
  const stripPx = parseFloat(getComputedStyle(document.querySelector('.vz') || document.documentElement).getPropertyValue('--strip')) || 0
  const firstPlot = plots.length ? Math.min(...plots.map((e) => doc(e.getBoundingClientRect()).top)) : null
  const area = (els) => els.reduce((a, e) => a + clipArea(e.getBoundingClientRect()), 0)
  const screen = vw * vh
  const dataArea = area(plots) + area(stats) + area(dataCells)
  const legendArea = area(legendCells)
  const fullyVisible = panels.filter((p) => { const r = p.getBoundingClientRect(); return r.top >= 0 && r.bottom <= vh }).length
  const startedVisible = panels.filter((p) => { const r = p.getBoundingClientRect(); return r.top < vh }).length
  const marksVisible = marks.filter((m) => m.getBoundingClientRect().top < vh).length
  // Controls: everything a person can press or type into.
  const ctlSel = 'a[href], button, input, select, textarea, summary, [tabindex="0"], [role=button]'
  const controls = [...document.querySelectorAll(ctlSel)].filter(shown).filter((e) => !e.disabled)
  const inView = controls.filter((e) => { const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw })
  const navCtl = inView.filter((e) => e.closest('.vz-nav'))
  const firstPanelTop = panels.length ? doc(panels[0].getBoundingClientRect()).top : null
  const above = controls.filter((e) => !e.closest('.vz-nav') && firstPanelTop !== null && doc(e.getBoundingClientRect()).bottom <= firstPanelTop + 1)
  const rowsY = []
  for (const e of above) { const r = doc(e.getBoundingClientRect()); const c = (r.top + r.bottom) / 2; if (!rowsY.some((y) => Math.abs(y - c) < 12)) rowsY.push(c) }
  // Per panel: what is chrome and what is data.
  const h = (el) => (el && shown(el) ? el.getBoundingClientRect().height : 0)
  const per = panels.map((p) => {
    const kind = p.dataset.kind || 'result'
    const total = p.getBoundingClientRect().height
    const head = h(p.querySelector(':scope > .vz-panel-head'))
    const desc = [...p.querySelectorAll(':scope > .vz-panel-desc')].reduce((a, e) => a + h(e), 0)
    const foot = h(p.querySelector(':scope > details.vz-details')) + h(p.querySelector(':scope > .vz-links'))
    const plot = [...p.querySelectorAll('svg.vz-plot')].filter(shown).reduce((a, e) => a + e.getBoundingClientRect().height, 0)
    const legend = [...p.querySelectorAll('.vz-legend-table')].filter(shown).reduce((a, e) => a + e.closest('.vz-table-wrap').getBoundingClientRect().height, 0) + [...p.querySelectorAll('.vz-legend-note')].filter(shown).reduce((a, e) => a + e.getBoundingClientRect().height, 0)
    const chartFoot = [...p.querySelectorAll('.vz-chart-foot')].filter(shown).reduce((a, e) => a + e.getBoundingClientRect().height, 0)
    const statV = [...p.querySelectorAll('.vz-stat-value')].filter(shown)
    const stat = statV.length ? Math.max(...statV.map((e) => e.getBoundingClientRect().height)) : 0
    const tbl = [...p.querySelectorAll('table.vz-table:not(.vz-legend-table) tbody')].filter(shown).reduce((a, e) => a + e.getBoundingClientRect().height, 0)
    const data = kind === 'timeseries' || kind === 'result' ? plot : kind === 'stat' ? stat : kind === 'table' ? tbl : 0
    const title = (p.querySelector('.vz-panel-title')?.textContent || '').trim()
    return { title, kind, total: Math.round(total), head: Math.round(head), desc: Math.round(desc), foot: Math.round(foot), plot: Math.round(plot), legend: Math.round(legend), chartFoot: Math.round(chartFoot), data: Math.round(data), chrome: Math.round(total - data) }
  })
  return {
    vw, vh, coarse: matchMedia('(pointer: coarse)').matches, strip: stripPx,
    pageHeight: document.documentElement.scrollHeight,
    firstMark: firstMark === null ? null : Math.round(firstMark), firstPlot: firstPlot === null ? null : Math.round(firstPlot),
    panels: panels.length, fullyVisible, startedVisible, marksVisible, marks: marks.length,
    dataShare: +(dataArea / screen).toFixed(3), legendShare: +(legendArea / screen).toFixed(3),
    controlRowsAbove: rowsY.length, controlsAbove: above.length, controlsInView: inView.length, navControlsInView: navCtl.length,
    per,
  }
}

async function tabStops(page) {
  // From the top of the document: how many Tab presses until focus is inside the first panel.
  await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement && document.activeElement.blur(); })
  await page.mouse.click(1, 1).catch(() => {})
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); })
  for (let i = 1; i <= 120; i++) {
    await page.keyboard.press('Tab')
    const inside = await page.evaluate(() => { const a = document.activeElement; return !!(a && a.closest('[data-testid=panel], [data-testid=result], [data-testid=dashboard-row]')) })
    if (inside) return i
  }
  return null
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true })
  const procs = []
  const start = (args, cwd, env = {}) => { const p = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } }); p.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`)); procs.push(p); return p }
  const stop = () => procs.forEach((p) => { try { p.kill('SIGTERM') } catch {} })
  process.on('exit', stop)
  if (await ping(APP) || await ping(`${MOCK}/__mock/delay`)) throw new Error('ports in use')
  start(['--import', 'tsx', 'mock/server.ts', '--port', String(MOCK_PORT)], path.join(WT, 'app'))
  start(['node_modules/vite/bin/vite.js', 'preview', '--port', String(APP_PORT), '--host', '127.0.0.1', '--outDir', path.resolve(distDir), '--strictPort'], path.join(WT, 'app'), { VIZ_API_TARGET: MOCK })
  if (!(await waitFor(`${MOCK}/__mock/delay`)) || !(await waitFor(APP))) { stop(); throw new Error('servers did not start') }
  const fine = await chromium.launch()
  const coarse = await chromium.launch({ args: [COARSE] })
  const results = {}
  try {
    for (const [name, url, ready] of VIEWS) {
      if (ONLY && !ONLY.includes(name)) continue
      for (const L of LAYOUTS) {
        for (const theme of SHOTS ? ['light', 'dark'] : ['light']) {
          const browser = L.coarse ? coarse : fine
          const ctx = await browser.newContext({ viewport: { width: L.width, height: L.height }, colorScheme: theme, ...(L.coarse ? { isMobile: true } : {}) })
          const page = await ctx.newPage()
          try {
            await page.goto(APP + url)
            await ready(page)
            await page.evaluate(() => document.fonts.ready)
            await sleep(400)
            await page.evaluate(() => window.scrollTo(0, 0))
            await sleep(150)
            const key = `${name}/${L.name}`
            if (theme === 'light') {
              const m = await page.evaluate(inPage)
              if (!L.coarse) m.tabStops = await tabStops(page)
              await page.evaluate(() => { document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0) })
              results[key] = m
              console.log(key, JSON.stringify({ first: m.firstMark, page: m.pageHeight, full: m.fullyVisible, of: m.panels, data: m.dataShare, legend: m.legendShare, rows: m.controlRowsAbove, tabs: m.tabStops, ctl: m.controlsInView }))
            }
            if (SHOTS) {
              await sleep(100)
              await page.screenshot({ path: path.join(outDir, `${label}-${name}-${L.name}-${theme}-screen.png`) })
              // Whole page: the viewport made as tall as the page, because charts off screen are not painted (content-visibility).
              const height = await page.evaluate(() => document.documentElement.scrollHeight)
              await page.setViewportSize({ width: L.width, height: Math.max(L.height, height) })
              await sleep(400)
              await page.screenshot({ path: path.join(outDir, `${label}-${name}-${L.name}-${theme}-page.png`) })
            }
          } catch (e) {
            console.error(`${name}/${L.name}/${theme}: ${e.message}`)
          } finally {
            await ctx.close()
          }
        }
      }
    }
  } finally {
    await fine.close(); await coarse.close(); stop()
  }
  const file = path.join(outDir, `${label}-measurements.json`)
  const prev = fs.existsSync(file) && ONLY ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  fs.writeFileSync(file, JSON.stringify({ ...prev, ...results }, null, 1))
}
main().catch((e) => { console.error(e); process.exit(1) })
