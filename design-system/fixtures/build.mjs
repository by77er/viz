// Builds the fixture dashboard as a page: dist/fixture/index.html and dist/fixture/data/<panel>.json.
// The page is the design system's components and the reference chart, nothing else. It is the baseline the budgets are checked on,
// and the specification an application implements under its own route (same panels, same data) to be measured the same way.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dashboard, generate, chartScript } from './generate.mjs'
const root = new URL('..', import.meta.url).pathname, out = root + 'dist/fixture/'
mkdirSync(out + 'data', { recursive: true })
for (const p of dashboard.panels) if (p.recipe) writeFileSync(`${out}data/${p.id}.json`, JSON.stringify(generate(p)))
const css = readFileSync(root + 'dist/viz.css', 'utf8').replace(/url\("fonts\//g, 'url("../fonts/'), press = readFileSync(root + 'dist/viz-press.js', 'utf8')
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
// Reserved heights come from the last result: legend rows (coloured series, plus Other's row and the action row when there is an Other)
// and note lines (shared labels; Other's sentence). An application keeps these with the panel; the fixture knows them from its specification.
const legendRows = (p) => Math.min(p.series ?? 1, 8) + ((p.series ?? 1) > 8 ? 2 : 0), legendNotes = (p) => ((p.series ?? 1) > 1 ? 1 : 0) + ((p.series ?? 1) > 8 ? 1 : 0)
const age = '<span data-age style="visibility:hidden">· updated <span class="vz-qty">just now</span></span>' // the age of what is drawn: shown once something is drawn
const panel = (p) => p.kind === 'stats'
  ? `<section class="vz-panel" data-span="12" id="panel-${p.id}"><div class="vz-panel-head"><h3 class="vz-panel-title">${esc(p.title)}</h3><span class="vz-panel-meta"><span>updated <span class="vz-qty">12 s</span> ago</span></span></div><div class="vz-grid">${p.stats.map((s) => `<div class="vz-stat" data-span="3"><span class="vz-label">${esc(s.label)}</span><span class="vz-stat-value"${s.figure ? ` data-figure="panel-${esc(s.figure).replace('|', '-chart|')}"` : ''}>${esc(s.value)}<span class="vz-stat-unit">${esc(s.unit)}</span></span><span class="vz-stat-context">${esc(s.context)}</span></div>`).join('')}</div></section>`
  : `<section class="vz-panel" data-span="${p.span}" id="panel-${p.id}" data-kind="${p.kind}" data-rows="${p.rows ?? ''}"><div class="vz-panel-head"><h3 class="vz-panel-title">${esc(p.title)}</h3><span class="vz-panel-meta"><span data-range>${p.recipe === 'backtest' ? '11 Nov 15:16 to 18 Nov 15:16' : '09:16 to 15:16'}</span><span>· ${p.recipe === 'backtest' ? '5' : '6'} min max</span>${age}</span>${p.kind === 'chart' ? `<div class="vz-segmented" role="group" aria-label="Form of ${esc(p.title)}" data-form-for="${p.id}"><button aria-pressed="true" data-form="chart">Chart</button><button aria-pressed="false" data-form="table">Table</button></div>` : ''}</div><div class="vz-panel-body"><div class="vz-chart" id="panel-${p.id}-chart" data-view="fixture-${p.id}"${p.recipe === 'backtest' ? ' data-size="sm"' : ''}${p.kind === 'table' ? ' hidden' : ` style="--legend-rows:${legendRows(p)};--legend-notes:${legendNotes(p)}"`}></div><div data-table${p.kind === 'table' ? ` style="min-height:calc(var(--strip) + var(--space-2) + (${p.rows} + 1) * (var(--row) + var(--hairline)))"` : ' hidden'}></div></div></section>`
writeFileSync(out + 'index.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>viz fixture dashboard</title><link rel="preload" as="font" type="font/woff2" crossorigin href="../fonts/SchibstedGrotesk-Variable.woff2"><link rel="preload" as="font" type="font/woff2" crossorigin href="../fonts/JetBrainsMono-Variable.woff2">
<style>${css}
body{margin:0}.fixture-query{flex:1 1 var(--overlay-min)}</style></head><body class="vz">
<nav class="vz-nav" aria-label="Sections"><span class="vz-nav-name">viz</span><a href="#">Explore</a><a href="#" aria-current="page" data-view="dashboard" id="nav-dashboard">Dashboards</a><a href="#pods" data-view="pods" id="nav-pods">Pods</a></nav>
<main class="vz-page" id="view-dashboard">
  <header class="vz-page-head"><div><h1 class="vz-page-title">${esc(dashboard.name)}</h1><p class="vz-page-sub">${dashboard.panels.length} panels, including a 36-series and a 200-series chart. Deterministic data; the clock is fixed at 15:16. Each chart can be shown as a table.</p></div>
    <div class="vz-controls"><div class="vz-segmented" role="group" aria-label="Theme" id="theme"><button aria-pressed="true" data-theme-choice="">System</button><button aria-pressed="false" data-theme-choice="light">Light</button><button aria-pressed="false" data-theme-choice="dark">Dark</button></div>
      <span class="vz-menu-anchor"><button class="vz-button" id="share" aria-haspopup="menu" aria-expanded="false" aria-controls="share-menu">Share…</button><div class="vz-menu" role="menu" id="share-menu" data-align="end"><button role="menuitem">Copy link to this range</button><button role="menuitem">Copy link to now</button><button role="menuitem">Export as CSV</button></div></span></div>
    </header>
  <div class="vz-controls"><textarea id="query" class="vz-query fixture-query" rows="1" aria-label="Query" spellcheck="false">sum by (pod) (rate(pod_cpu_usage_seconds_total[5m]))</textarea><button id="run" class="vz-button" data-tone="blue">Run query</button></div>
  <div class="vz-dashboard"><div class="vz-grid">${dashboard.panels.map(panel).join('')}</div></div>
</main>
<main class="vz-page" id="view-pods" hidden>
  <header class="vz-page-head"><div><h1 class="vz-page-title">${esc(dashboard.views.pods.title)}</h1><p class="vz-page-sub">Every pod of acme-prod, highest CPU first. Its data loads when the view opens.</p></div></header>
  <section class="vz-panel" id="pods-region"><div class="vz-panel-head"><h3 class="vz-panel-title">Pods by CPU</h3><span class="vz-panel-meta"><span>15:16</span><span data-age style="visibility:hidden">· updated <span class="vz-qty">just now</span></span></span></div>
    <div class="vz-panel-body" style="min-height:calc(var(--strip) + var(--space-2) + (${dashboard.views.pods.rows} + 1) * (var(--row) + var(--hairline)))"><p class="vz-table-caption">Pods</p><div data-table></div></div></section>
</main>
<script>${press}</script>
<script>${chartScript}</script>
<script>
const panels = [...document.querySelectorAll('.vz-panel[data-kind]')], specs = {}, forms = {}
// ?delay=ms holds every response that long, to picture or measure the wait (the speed harness shapes the network instead)
const delay = +(new URLSearchParams(location.search).get('delay') || 0)
const fmt = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const tableOf = (spec, rows) => { const all = spec.series.map((x) => { const v = x.values.filter((p) => p != null); return { x, last: v[v.length - 1], min: Math.min(...v), max: Math.max(...v) } }).sort((a, b) => b.last - a.last), s = all.slice(0, rows || 30), name = Object.keys(spec.series[0].labels).includes('pod') ? 'pods' : 'series'
  return '<p class="vz-table-caption">' + s.length + ' of ' + all.length + ' ' + name + ', highest last value first</p><div class="vz-table-wrap"><table class="vz-table"><thead><tr><th class="vz-label">Series</th><th class="vz-label vz-right">Last, ' + spec.unit + '</th><th class="vz-label vz-right">Min</th><th class="vz-label vz-right">Max</th></tr></thead><tbody>' + s.map((r) => '<tr><td data-key>' + Object.values(r.x.labels).slice(-2).join(' · ') + '</td><td class="vz-num vz-right">' + fmt(r.last) + '</td><td class="vz-num vz-right">' + fmt(r.min) + '</td><td class="vz-num vz-right">' + fmt(r.max) + '</td></tr>').join('') + '</tbody></table></div>' }
function show(p) { const spec = specs[p.id], chart = p.querySelector('.vz-chart'), table = p.querySelector('[data-table]'), asTable = forms[p.id] === 'table' || p.dataset.kind === 'table'
  chart.hidden = asTable; table.hidden = !asTable
  if (asTable) { if (table.dataset.for !== spec.stamp) { table.innerHTML = tableOf(spec, +p.dataset.rows); table.dataset.for = spec.stamp } } else if (chart.dataset.for !== spec.stamp) { chart.vz ? chart.vz.setData(spec) : (chart.vz = vzChart(chart, spec)); chart.dataset.for = spec.stamp }
  p.querySelector('[data-age]')?.style.removeProperty('visibility'); p.setAttribute('data-drawn', asTable ? 'table' : 'chart') }
async function load(p, bust) { const r = await fetch('data/' + p.id.replace('panel-', '') + '.json' + (bust ? '?t=' + bust : '')); const spec = await r.json(); if (delay) await new Promise((d) => setTimeout(d, delay)); specs[p.id] = spec; specs[p.id].stamp = String(bust || 0); show(p) }
async function run() { const b = document.getElementById('run'); b.setAttribute('aria-busy', 'true'); const t = Date.now(); await Promise.all(panels.map((p) => load(p, t))); b.removeAttribute('aria-busy'); document.body.setAttribute('data-loaded', String(+(document.body.dataset.loaded || 0) + 1))
  // the other form of each panel is prepared when the page is idle, so switching form only shows it
  ;(window.requestIdleCallback || setTimeout)(() => panels.forEach((p) => { const table = p.querySelector('[data-table]'), spec = specs[p.id]; if (table.dataset.for !== spec.stamp) { table.innerHTML = tableOf(spec, +p.dataset.rows); table.dataset.for = spec.stamp } })) }
document.getElementById('run').addEventListener('click', run)
// one panel's form: chart or table, as Explore and every panel offer it
for (const seg of document.querySelectorAll('[data-form-for]')) seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; const id = 'panel-' + seg.dataset.formFor; forms[id] = b.dataset.form; seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b)); show(document.getElementById(id)) })
// The theme: a local change, finished in the next frame (budget row 2).
const themeSeg = document.getElementById('theme')
themeSeg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; themeSeg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b)); if (b.dataset.themeChoice) document.documentElement.dataset.theme = b.dataset.themeChoice; else delete document.documentElement.dataset.theme })
// A menu: a local change (budget row 2). Opens anchored under its button; a press outside or Escape closes it.
const share = document.getElementById('share'), menu = document.getElementById('share-menu'), setMenu = (on) => { on ? menu.setAttribute('data-open', '') : menu.removeAttribute('data-open'); share.setAttribute('aria-expanded', String(on)) }
share.addEventListener('click', () => setMenu(!menu.hasAttribute('data-open')))
document.addEventListener('pointerdown', (e) => { if (menu.hasAttribute('data-open') && !e.target.closest('.vz-menu-anchor')) setMenu(false) })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false) })
// A second view whose data is not loaded (budget row 3): its shell (head, panel, caption strip, the table's reserved height) at once;
// the link that opened it is busy until 400 ms; then the waiting line over the strip with the stage and elapsed time; the rows when they arrive.
let podsLoaded = false
async function openView(name) {
  for (const [k, el] of Object.entries({ dashboard: document.getElementById('view-dashboard'), pods: document.getElementById('view-pods') })) el.hidden = k !== name
  for (const a of document.querySelectorAll('.vz-nav a[data-view]')) a.dataset.view === name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')
  if (name !== 'pods' || podsLoaded) return
  const region = document.getElementById('pods-region'), body = region.querySelector('.vz-panel-body'), link = document.getElementById('nav-pods'), t0 = performance.now()
  region.setAttribute('data-waiting', ''); link.setAttribute('aria-busy', 'true')
  const later = setTimeout(() => { link.removeAttribute('aria-busy'); body.insertAdjacentHTML('afterbegin', '<div class="vz-progress" data-unmeasured><div class="vz-progress-text"><span role="status">Loading pods</span><span class="vz-qty" aria-hidden="true" data-elapsed></span></div></div>'); const tick = () => { const e = body.querySelector('[data-elapsed]'); if (e) { e.textContent = ((performance.now() - t0) / 1000).toFixed(1) + ' s'; setTimeout(tick, 100) } }; tick() }, 400)
  const r = await fetch('data/table.json'), spec = await r.json(); if (delay) await new Promise((d) => setTimeout(d, delay))
  clearTimeout(later); link.removeAttribute('aria-busy'); body.querySelector('.vz-progress')?.remove()
  body.querySelector('[data-table]').innerHTML = tableOf(spec, ${dashboard.views.pods.rows}); body.querySelector('.vz-table-caption').remove()
  region.querySelector('[data-age]').style.removeProperty('visibility'); region.removeAttribute('data-waiting'); region.setAttribute('data-drawn', ''); podsLoaded = true
}
document.querySelector('.vz-nav').addEventListener('click', (e) => { const a = e.target.closest('a[data-view]'); if (!a) return; e.preventDefault(); openView(a.dataset.view) })
run()
</script></body></html>`)
console.log('wrote dist/fixture/index.html and', dashboard.panels.filter((p) => p.recipe).length, 'data files')
