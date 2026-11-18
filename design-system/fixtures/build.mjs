// Builds the fixture dashboard as a page: dist/fixture/index.html and dist/fixture/data/<panel>.json.
// The page is the design system's components and the reference chart, nothing else. It is the baseline the budgets are checked on,
// and the specification an application implements under its own route (same panels, same data) to be measured the same way.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dashboard, generate, chartScript } from './generate.mjs'
const root = new URL('..', import.meta.url).pathname, out = root + 'dist/fixture/'
mkdirSync(out + 'data', { recursive: true })
for (const p of dashboard.panels) if (p.recipe) writeFileSync(`${out}data/${p.id}.json`, JSON.stringify(generate(p)))
const css = readFileSync(root + 'dist/viz.css', 'utf8').replace(/url\("fonts\//g, 'url("../fonts/')
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const panel = (p) => p.kind === 'stats'
  ? `<section class="vz-panel" data-span="12" id="panel-${p.id}"><div class="vz-panel-head"><h3 class="vz-panel-title">${esc(p.title)}</h3><span class="vz-panel-meta"><span>updated <span class="vz-qty">12 s</span> ago</span></span></div><div class="vz-grid">${p.stats.map((s) => `<div class="vz-stat" data-span="3"><span class="vz-label">${esc(s.label)}</span><span class="vz-stat-value">${esc(s.value)}<span class="vz-stat-unit">${esc(s.unit)}</span></span><span class="vz-stat-context">${esc(s.context)}</span></div>`).join('')}</div></section>`
  : `<section class="vz-panel" data-span="${p.span}" id="panel-${p.id}" data-kind="${p.kind}" data-rows="${p.rows ?? ''}"><div class="vz-panel-head"><h3 class="vz-panel-title">${esc(p.title)}</h3><span class="vz-panel-meta"><span data-range>09:16 to 15:16</span><span>· 6 min max</span><span>· updated <span class="vz-qty">12 s</span> ago</span></span></div><div class="vz-panel-body"><div class="vz-chart" data-view="fixture-${p.id}"${p.recipe === 'backtest' ? ' data-size="sm"' : ''} style="--legend-rows:${Math.min(p.series ?? 1, 8) + ((p.series ?? 1) > 8 ? 1 : 0)}"></div><div class="vz-table-wrap" data-table hidden${p.kind === 'table' ? ' style="min-height:calc((' + p.rows + ' + 1) * (var(--row) + var(--hairline)))"' : ''}></div></div></section>`
writeFileSync(out + 'index.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>viz fixture dashboard</title><link rel="preload" as="font" type="font/woff2" crossorigin href="../fonts/SchibstedGrotesk-Variable.woff2"><link rel="preload" as="font" type="font/woff2" crossorigin href="../fonts/JetBrainsMono-Variable.woff2">
<style>${css}
body{margin:0}</style></head><body class="vz">
<nav class="vz-nav" aria-label="Sections"><span class="vz-nav-name">viz</span><a href="#">Explore</a><a href="#" aria-current="page">Dashboards</a><a href="#">Monitors</a></nav>
<main class="vz-page">
  <header class="vz-page-head"><div><h1 class="vz-page-title">${esc(dashboard.name)}</h1><p class="vz-page-sub">${dashboard.panels.length} panels, including a 36-series and a 200-series chart. Deterministic data; the clock is fixed at 15:16.</p></div>
    <div class="vz-controls"><div class="vz-segmented" role="group" aria-label="Form"><button id="view-chart" aria-pressed="true">Charts</button><button id="view-table" aria-pressed="false">Tables</button></div></div></header>
  <div class="vz-controls"><textarea id="query" class="vz-query" rows="1" aria-label="Query" spellcheck="false" style="flex:1 1 var(--overlay-min);resize:none">sum by (pod) (rate(pod_cpu_usage_seconds_total[5m]))</textarea><button id="run" class="vz-button" data-tone="blue">Run query</button></div>
  <div class="vz-dashboard"><div class="vz-grid">${dashboard.panels.map(panel).join('')}</div></div>
</main>
<script>${chartScript}</script>
<script>
const panels = [...document.querySelectorAll('.vz-panel[data-kind]')], specs = {}
const tableOf = (spec, rows) => { const s = rows ? spec.series.slice(0, rows) : spec.series.slice(0, 30); return '<table class="vz-table"><thead><tr><th class="vz-label">Series</th><th class="vz-label vz-right">Last, ' + spec.unit + '</th><th class="vz-label vz-right">Min</th><th class="vz-label vz-right">Max</th></tr></thead><tbody>' + s.map((x) => { const v = x.values.filter((p) => p != null); return '<tr><td data-key>' + Object.values(x.labels).slice(-2).join(' · ') + '</td><td class="vz-num vz-right">' + v[v.length - 1].toFixed(2) + '</td><td class="vz-num vz-right">' + Math.min(...v).toFixed(2) + '</td><td class="vz-num vz-right">' + Math.max(...v).toFixed(2) + '</td></tr>' }).join('') + '</tbody></table>' }
let form = 'chart'
function show(p) { const spec = specs[p.id], chart = p.querySelector('.vz-chart'), table = p.querySelector('[data-table]'), asTable = form === 'table' || p.dataset.kind === 'table'
  chart.hidden = asTable; table.hidden = !asTable
  if (asTable) { if (table.dataset.for !== spec.stamp) { table.innerHTML = tableOf(spec, +p.dataset.rows); table.dataset.for = spec.stamp } } else if (chart.dataset.for !== spec.stamp) { chart.vz ? chart.vz.setData(spec) : (chart.vz = vzChart(chart, spec)); chart.dataset.for = spec.stamp }
  p.setAttribute('data-drawn', form) }
async function load(p, bust) { const r = await fetch('data/' + p.id.replace('panel-', '') + '.json' + (bust ? '?t=' + bust : '')); specs[p.id] = await r.json(); specs[p.id].stamp = String(bust || 0); show(p) }
async function run() { const b = document.getElementById('run'); b.setAttribute('aria-busy', 'true'); const t = Date.now(); await Promise.all(panels.map((p) => load(p, t))); b.removeAttribute('aria-busy'); document.body.setAttribute('data-loaded', String(+(document.body.dataset.loaded || 0) + 1))
  // the other form of each panel is prepared when the page is idle, so switching form only shows it
  ;(window.requestIdleCallback || setTimeout)(() => panels.forEach((p) => { const table = p.querySelector('[data-table]'), spec = specs[p.id]; if (table.dataset.for !== spec.stamp) { table.innerHTML = tableOf(spec, +p.dataset.rows); table.dataset.for = spec.stamp } })) }
document.getElementById('run').addEventListener('click', run)
for (const id of ['chart', 'table']) document.getElementById('view-' + id).addEventListener('click', () => { form = id; document.getElementById('view-chart').setAttribute('aria-pressed', id === 'chart'); document.getElementById('view-table').setAttribute('aria-pressed', id === 'table'); panels.forEach(show) })
run()
</script></body></html>`)
console.log('wrote dist/fixture/index.html and', dashboard.panels.filter((p) => p.recipe).length, 'data files')
