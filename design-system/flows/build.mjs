// The flow screens: builds screens/*.html into dist/ (ignored by git) on the system's own CSS and reference chart, and images them.
//   node build.mjs                     pages only, into flows/dist/
//   node build.mjs --facts             prints every chart's last, min and max from fixture.js (the figures the screens state)
//   node build.mjs --shots [n ...]     pages, then the scenarios in scenarios/ (all, or the screens whose names start with n) with
//                                      tools/shots.mjs, one browser at a time; images palette-encoded into shots/; a full run writes
//                                      measurements.txt (overflow, smallest text, hit areas under 44 px with a coarse pointer, controls covered,
//                                      drawn boxes reached by a neighbour, links inside sentences)
//   node build.mjs --shift [--runs N] [--root <flows folder>] [--out file]
//                                      layout shift on every chart at 400 x 800 with a coarse pointer and touch, CPU 4x and Fast 4G: each page
//                                      opened scrolled to the chart (?at=id) with its data drawn 800 ms late (?delay=800), as a reload on a slow
//                                      link does; cumulative layout shift until drawn and 500 ms after, the chart's reserved height against its
//                                      drawn height, and the 1-minute load average at the start of every run. --root measures another copy of
//                                      the flows (the v4 screens, for the before figures); results go to shift.txt unless --out says otherwise
//   node build.mjs --compare <before>  before/after pairs into compare-v5/: every image in <before> that has a namesake in shots/ (the v4
//                                      images rendered by the same scenarios), side by side, each under 500 KB
// A screen file starts with <!-- nav: Section --> and <!-- title: ... -->. States are URL fragments: an element with
// data-when="a b" is shown only in states a and b ("default" is no fragment); data-unless="a" hides it in state a.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, renameSync, existsSync, copyFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { loadavg, cpus } from 'node:os'
import { join, resolve, dirname, extname, basename } from 'node:path'
import vm from 'node:vm'

const root = new URL('.', import.meta.url).pathname, ds = join(root, '..'), out = join(root, 'dist')
const args = process.argv.slice(2), opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
mkdirSync(out, { recursive: true })

const sections = ['Explore', 'Dashboards', 'Monitors', 'Traces', 'Logs']
// The tenant is text, not a link: no tenant switch is designed. vz-nav-end starts the group at the right (Nav).
const nav = (current) => `<nav class="vz-nav" aria-label="Sections"><span class="vz-nav-name">viz</span>${sections.map((n) => `<a href="#"${n === current ? ' aria-current="page"' : ''}>${n}</a>`).join('')}<span class="vz-nav-end vz-secondary" title="Tenant">acme-prod</span><a href="8-keys.html"${current === 'Settings' ? ' aria-current="page"' : ''}>Settings</a></nav>`

// State switching only. Every v4 work-around (the flow-* classes, the skip link's position) is gone: v5 has the components.
const css = `body { margin: 0; }
[hidden] { display: none !important; } /* state switching: system classes set display, which beats the hidden attribute */
`
const stateScript = `<script>
function flowState() { const s = decodeURIComponent(location.hash.slice(1)) || 'default'
  for (const el of document.querySelectorAll('[data-when]')) el.hidden = !el.dataset.when.split(' ').includes(s)
  for (const el of document.querySelectorAll('[data-unless]')) el.hidden = el.dataset.unless.split(' ').includes(s)
  // A dialog's scrim class is on only while the dialog is shown: tools/shots.mjs takes the first .vz-scrim in the page for the open dialog
  // and measures only inside it, so a hidden one would hide every control on the page from the touch measure.
  for (const el of document.querySelectorAll('[data-scrim]')) el.classList.toggle('vz-scrim', !el.hidden)
  document.documentElement.dataset.flowState = s; return s }
document.addEventListener('click', (e) => { const g = e.target.closest('[data-go]'); if (!g) return; e.preventDefault(); location.hash = g.dataset.go })
addEventListener('hashchange', () => { flowState(); const f = [...document.querySelectorAll('[data-autofocus]')].find((el) => el.offsetParent); if (f) f.focus() })
// Menu rows that hold a choice: a tap or Enter moves the tick; the confirming button names the choice. Nothing happens until it is pressed.
document.addEventListener('click', (e) => { const r = e.target.closest('[role="menuitemradio"]'); if (!r) return; r.parentElement.querySelectorAll('[role="menuitemradio"]').forEach((x) => x.setAttribute('aria-checked', x === r)); const b = r.closest('.vz-menu').querySelector('[data-names-choice]'); if (b) b.textContent = r.dataset.confirm })
// For measuring only (--shift): ?delay=ms draws every chart that long after the page has painted, as data arriving late does. Nothing else changes.
{ const delay = +(new URLSearchParams(location.search).get('delay') || 0), draw = window.vzChart
  if (delay && draw) window.vzChart = (el, spec) => { const o = {}; setTimeout(() => { Object.assign(o, draw(el, spec)); el.dataset.drawn = '1' }, delay); return o } }
</script>`
// ?at=id opens the page scrolled to that region, as a reload does (the hash is taken by the states).
const atScript = `<script>flowState(); { const at = new URLSearchParams(location.search).get('at'); if (at) document.getElementById(at)?.scrollIntoView({ block: 'start' }) }</script>`

function page(file, src) {
  const current = (src.match(/<!-- nav: (\w+) -->/) ?? [])[1], title = (src.match(/<!-- title: (.+?) -->/) ?? [])[1] ?? file
  const at = src.indexOf('<script'), markup = at < 0 ? src : src.slice(0, at), scripts = at < 0 ? '' : src.slice(at)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>viz · ${title}</title>
<link rel="preload" as="font" type="font/woff2" crossorigin href="../../dist/fonts/SchibstedGrotesk-Variable.woff2"><link rel="stylesheet" href="../../dist/viz.css"><style>${css}</style>
<script src="../../dist/viz-chart.js"></script><script src="../fixture.js"></script>${stateScript}</head>
<body class="vz"><a class="vz-button vz-skip" href="#main">Skip to content</a>${nav(current)}
${markup}${atScript}${scripts}</body></html>`
}

const names = []
for (const f of readdirSync(join(root, 'screens')).filter((x) => x.endsWith('.html')).sort((a, b) => parseInt(a) - parseInt(b))) {
  writeFileSync(join(out, f), page(f, readFileSync(join(root, 'screens', f), 'utf8')))
  names.push(f.replace('.html', ''))
}
console.log('built', names.length, 'screens into flows/dist/:', names.join(', '))

// Scenarios for tools/shots.mjs, one file per screen. Every screen: light and dark at 1440, light and dark at 400 with a coarse pointer (hit
// areas, overlaps, links inside sentences and overflow measured), a greyscale copy, and keyboard focus; then its own states (URL fragments).
// A menu at 400 with a coarse pointer is a sheet across the bottom of the screen, so those states are imaged at a phone's height (800), not
// as a page-tall viewport, which would put the sheet at the foot of the page.
const st = (name, o = {}) => ({ name, ...o })
const at400 = (name, frag, o = {}) => st(name, { url: `flows/dist/${o.screen}.html#${frag}`, width: 400, coarse: true, measure: true, themes: ['light'], ...o, screen: undefined })
const at1440 = (name, frag, o = {}) => st(name, { url: `flows/dist/${o.screen}.html#${frag}`, scale: 1, measure: true, themes: ['light'], ...o, screen: undefined })
const extra = {
  '1-dashboards': { focus: ['#q', 'main'], states: (s) => [at1440('error-1440', 'error', { screen: s }), at400('empty-400', 'empty', { screen: s }), at400('first-run-400', 'first-run', { screen: s }), at1440('first-run-1440', 'first-run', { screen: s, themes: ['dark'] })] },
  '2-dashboard': { focus: ['#range button:nth-child(2)', 'header'], states: (s) => [at1440('error-1440', 'error', { screen: s }), at1440('waiting-1440', 'waiting', { screen: s })] },
  '3-monitors': { focus: ['tbody tr:first-child a', '.vz-table-wrap'], states: (s) => [at400('error-400', 'error', { screen: s }), at400('first-run-400', 'first-run', { screen: s }), at400('400-hit-areas', '', { screen: s, outline: true }), st('zoom-200', { zoom: 2, scale: 1, measure: true, themes: ['light'] })] },
  '4-monitor': { focus: ['.vz-button[data-tone="green"]', 'header'], states: (s) => [at400('400-hit-areas', '', { screen: s, outline: true }), at400('silence-menu-400', 'silence-menu', { screen: s, height: 800, themes: ['light', 'dark'] }), at400('ack-400', 'ack', { screen: s, themes: ['light', 'dark'] }), at400('silenced-400', 'silenced', { screen: s }), at400('notice-400', 'notice', { screen: s }), at400('error-400', 'error', { screen: s }), at400('nodata-400', 'nodata', { screen: s }), at1440('silence-menu-1440', 'silence-menu', { screen: s }), st('zoom-200', { zoom: 2, scale: 1, measure: true, themes: ['light'] })] },
  '5-new-monitor': { focus: ['#name', 'form'], states: (s) => [at1440('error-1440', 'error', { screen: s }), at1440('many-1440', 'many', { screen: s }), at400('many-400', 'many', { screen: s })] },
  '6-investigation': { focus: ['#evidence-1', '#claim-1'], states: (s) => [at400('confirmed-400', 'confirmed', { screen: s }), at1440('running-1440', 'running', { screen: s }), at400('failed-400', 'failed', { screen: s })] },
  '7-proposed-change': { focus: ['#change-1', '.vz-change'], states: (s) => [at1440('applied-1440', 'applied', { screen: s }), at400('failed-400', 'failed', { screen: s })] },
  '8-keys': { focus: ['#new-key', 'header'], states: (s) => [at400('new-400', 'new', { screen: s }), at1440('secret-1440', 'secret', { screen: s, themes: ['light', 'dark'] }), at400('saved-400', 'saved', { screen: s }), at400('error-400', 'error', { screen: s }), at400('revoke-400', 'revoke', { screen: s }), at1440('menu-1440', 'menu', { screen: s }), at400('menu-400', 'menu', { screen: s, height: 800 }), at1440('arrived-1440', 'arrived', { screen: s })] },
  '9-traces': { focus: ['#first-trace', '.vz-split > :last-child'], states: (s) => [at1440('error-1440', 'error', { screen: s }), st('waterfall-focus', { steps: [{ focus: '.vz-waterfall-span[tabindex="0"]' }, { key: 'ArrowDown' }, { key: 'ArrowDown' }, { key: 'ArrowDown' }, { key: 'ArrowDown' }], clip: '.vz-waterfall', pad: 24, scale: 1, themes: ['light', 'dark'] })] },
  '10-logs': { focus: ['tbody tr:first-child a', '.vz-log'], states: (s) => [at1440('error-1440', 'error', { screen: s })] },
  '11-notification': { focus: ['main a', 'header'], states: (s) => [at400('error-400', 'error', { screen: s }), at1440('ack-1440', 'ack', { screen: s })] },
  '12-routes': { focus: ['#end', '#silences'], states: (s) => [at400('error-400', 'error', { screen: s })] },
}
mkdirSync(join(root, 'scenarios'), { recursive: true })
for (const n of names) {
  const x = extra[n] ?? { focus: ['main a, main button', 'header'], states: () => [] }
  const states = [st('1440', { scale: 1, measure: true }), st('400', { width: 400, coarse: true, measure: true }), st('grey', { scale: 1, greyscale: true, themes: ['light'] }),
    st('focus', { steps: [{ focus: x.focus[0] }], clip: x.focus[1], pad: 24, themes: ['light'] }), ...x.states(n)]
  writeFileSync(join(root, 'scenarios', n + '.json'), JSON.stringify({ name: n, url: `flows/dist/${n}.html`, states }, null, 1) + '\n')
}

if (args.includes('--facts')) {
  const ctx = { window: {}, document: { readyState: 'complete', querySelectorAll: () => [] } }; ctx.globalThis = ctx
  vm.createContext(ctx); vm.runInContext(readFileSync(join(ds, 'dist/viz-chart.js'), 'utf8'), ctx); vm.runInContext(readFileSync(join(root, 'fixture.js'), 'utf8').replace('typeof window', "'object'"), ctx)
  const f = ctx.window.flows, hm = (t) => new Date(t).toISOString().slice(5, 16).replace('T', ' ')
  for (const k of ['latency', 'errors', 'traceDurations', 'deps', 'depsAgent', 'logs', 'backtest']) { const s = f[k]()
    console.log(`${k}: ${s.unit}, ${hm(s.t0)} to ${hm(s.t0 + (s.series[0].values.length - 1) * s.step)}, step ${s.step / f.MIN} min ${s.agg}`)
    for (const x of s.series) { const v = x.values.filter((y) => y != null); console.log(`  ${Object.values(x.labels).join(' · ')}: last ${v[v.length - 1]}, min ${Math.min(...v)}, max ${Math.max(...v)}`) } }
  console.log(`error log lines, 09:16 to 15:16: ${f.logLines}`)
  const tr = f.trace, covered = tr.spans.filter((s) => s.parent === 1).reduce((a, s) => a + s.took, 0)
  console.log(`trace ${tr.id}: ${tr.took} ms, ${tr.spans.length} spans; payments-db ${tr.spans.filter((s) => /^payments-db/.test(s.name)).map((s) => s.took).join(' + ')} ms; the root's own time ${tr.took - covered} ms`)
  for (const s of tr.spans) console.log(`  ${s.name}: starts at ${s.start}, took ${s.took}, own ${s.own}${s.own >= tr.took / 10 ? ', a tenth of the trace or more' : ''}`)
}

// Palette-encode a PNG in place, keeping every token colour of both themes exact: the palette is the token colours plus 256 less that many
// colours chosen from the image (median cut); each pixel takes its nearest palette colour exactly, with no dithering.
const tokenHex = [...new Set(readFileSync(join(ds, 'dist/tokens.css'), 'utf8').match(/#[0-9a-f]{6}\b/gi))].map((h) => h.toLowerCase())
const py = `import sys
import numpy as np
from PIL import Image
toks = np.array([[int(h[i:i+2], 16) for i in (1, 3, 5)] for h in sys.argv[2].split(',')], dtype=np.int32)
size = int(sys.argv[3]) if len(sys.argv) > 3 else 256
im = Image.open(sys.argv[1]).convert('RGB'); a = np.asarray(im, dtype=np.int32).reshape(-1, 3)
cols, inv, counts = np.unique(a, axis=0, return_inverse=True, return_counts=True)
adaptive = np.array(im.quantize(colors=max(16, size - len(toks)), method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).getpalette()[: max(16, size - len(toks)) * 3], dtype=np.int32).reshape(-1, 3)
pal = np.unique(np.vstack([toks, adaptive]), axis=0)[:256]
near = np.empty(len(cols), dtype=np.uint8)
for i in range(0, len(cols), 4096): near[i:i+4096] = ((cols[i:i+4096, None, :] - pal[None, :, :]) ** 2).sum(-1).argmin(1)
out = Image.fromarray(near[inv.ravel()].reshape(im.size[1], im.size[0]), 'P'); out.putpalette(pal.astype(np.uint8).ravel().tolist())
out.save(sys.argv[1], optimize=True)
`
const encode = (file, size = 256) => { const r = spawnSync('python3', ['-c', py, file, tokenHex.join(','), String(size)], { stdio: 'inherit' }); if (r.status) throw new Error('encode failed: ' + file) }

if (args.includes('--shots')) {
  const only = args.slice(args.indexOf('--shots') + 1).filter((a) => !a.startsWith('--'))
  const tmp = join(root, 'dist', 'shots-tmp'), shots = join(root, 'shots'); mkdirSync(shots, { recursive: true })
  const log = []
  for (const f of readdirSync(join(root, 'scenarios')).filter((x) => x.endsWith('.json')).sort((a, b) => parseInt(a) - parseInt(b))) {
    if (only.length && !only.some((o) => f.startsWith(o))) continue
    rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true })
    const r = spawnSync('node', ['tools/shots.mjs', 'scenario', join('flows/scenarios', f), tmp], { cwd: ds, encoding: 'utf8', maxBuffer: 1 << 24 })
    process.stdout.write(r.stdout); process.stderr.write(r.stderr); log.push(r.stdout.trim())
    for (const png of readdirSync(tmp).filter((x) => x.endsWith('.png'))) { encode(join(tmp, png)); renameSync(join(tmp, png), join(shots, png)) }
  }
  writeFileSync(join(root, only.length ? 'dist/measurements-last.txt' : 'measurements.txt'), log.join('\n') + '\n') // a full run is kept as evidence
  rmSync(tmp, { recursive: true, force: true })
}

if (args.includes('--shift')) {
  const { chromium } = createRequire(join(ds, 'tools/shots.mjs'))('playwright')
  const runs = +(opt('--runs') ?? 10), flowsDir = resolve(opt('--root') ?? root), base = dirname(flowsDir), delay = 800, cores = cpus().length
  // [screen, chart id, state]: every chart on the flow screens, each opened scrolled to itself
  const cases = [['2-dashboard', 'lat'], ['2-dashboard', 'err'], ['4-monitor', 'chart'], ['5-new-monitor', 'backtest'], ['5-new-monitor', 'backtest', 'many'], ['6-investigation', 'agent'], ['7-proposed-change', 'newpanel'], ['9-traces', 'dur'], ['10-logs', 'rate']]
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2' }
  const server = createServer((req, res) => { const p = join(base, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(base) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); res.end(); return } res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' }); res.end(readFileSync(p)) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}/${basename(flowsDir)}/dist/`
  const browser = await chromium.launch(), res = Object.fromEntries(cases.map((c) => [c.join(' '), { shift: [], reserved: [], drawn: [], load: [] }]))
  for (let run = 0; run < runs; run++) for (const c of cases) {
    const [screen, id, frag] = c, r = res[c.join(' ')], load1 = loadavg()[0]
    const ctx = await browser.newContext({ viewport: { width: 400, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }), page = await ctx.newPage(), cdp = await ctx.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 165, downloadThroughput: (9e6 * 0.9) / 8, uploadThroughput: (1.5e6 * 0.9) / 8 }) // DevTools' Fast 4G
    await page.addInitScript(() => { window.__shift = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shift += e.value }).observe({ type: 'layout-shift', buffered: true })
      document.addEventListener('DOMContentLoaded', () => { window.__reserved = Object.fromEntries([...document.querySelectorAll('.vz-chart[id]')].map((e) => [e.id, e.getBoundingClientRect().height])) }) })
    try {
      await page.goto(`${origin}${screen}.html?delay=${delay}&at=${id}${frag ? '#' + frag : ''}`, { waitUntil: 'load', timeout: 60000 })
      await page.waitForFunction(() => [...document.querySelectorAll('.vz-chart[id]')].every((e) => e.dataset.drawn), null, { timeout: 60000 }); await page.waitForTimeout(500)
      const m = await page.evaluate((id) => { const e = document.getElementById(id), shown = e.getBoundingClientRect().height; e.style.minHeight = '0'; const drawn = e.getBoundingClientRect().height; e.style.minHeight = ''; return { shift: window.__shift, reserved: window.__reserved[id], drawn, shown } }, id)
      r.shift.push(m.shift); r.reserved.push(m.reserved); r.drawn.push(m.drawn); r.load.push(load1)
    } catch (e) { console.log(`run ${run + 1}: ${c.join(' ')}: ${e.message.split('\n')[0]}`) }
    await ctx.close()
    process.stdout.write(`\rrun ${run + 1}/${runs}, load ${load1.toFixed(1)}   `)
  }
  await browser.close(); server.close()
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] : NaN }, f4 = (x) => x.toFixed(4)
  const lines = [`Layout shift, 400 x 800, coarse pointer and touch, CPU 4x, Fast 4G, chart data drawn ${delay} ms late, page opened scrolled to the chart.`,
    `Pages: ${flowsDir}/dist. ${runs} runs per chart, alternating charts within each run. Measured here, on this machine (${cores} cores); the 1-minute load average at the start of each run is given (layout shift does not depend on speed, so it is judged at any load). Budget 0.05.`,
    '', '| Chart | Layout shift p75 (median, worst) | Reserved / drawn height, px | Runs | Load, median (min to max) |', '|---|---|---|---|---|']
  for (const c of cases) { const r = res[c.join(' ')], ok = r.shift.length && q(r.shift, 0.75) <= 0.05
    lines.push(`| ${c[0]} #${c[1]}${c[2] ? ' (' + c[2] + ')' : ''} | ${r.shift.length ? `${f4(q(r.shift, 0.75))} (${f4(q(r.shift, 0.5))}, ${f4(Math.max(...r.shift))}) ${ok ? 'within' : 'OVER'}` : 'no result'} | ${r.reserved.length ? `${Math.round(q(r.reserved, 0.5))} / ${Math.round(q(r.drawn, 0.5))}` : '-'} | ${r.shift.length} | ${r.load.length ? `${q(r.load, 0.5).toFixed(1)} (${Math.min(...r.load).toFixed(1)} to ${Math.max(...r.load).toFixed(1)})` : '-'} |`) }
  const text = lines.join('\n') + '\n'; console.log('\n' + text); writeFileSync(resolve(opt('--out') ?? join(root, 'shift.txt')), text)
}

if (args.includes('--compare')) {
  const before = resolve(args[args.indexOf('--compare') + 1]), b = join(root, 'dist', 'cmp-before'), a = join(root, 'dist', 'cmp-after'), c = join(root, 'compare-v5')
  for (const d of [a, b, c]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }) }
  for (const f of readdirSync(before).filter((x) => x.endsWith('.png'))) {
    const after = join(root, 'shots', f)
    if (!existsSync(after)) { console.log('no after image for', f); continue }
    copyFileSync(join(before, f), join(b, f)); copyFileSync(after, join(a, f))
  }
  const r = spawnSync('node', ['tools/shots.mjs', 'compare', b, a, c], { cwd: ds, stdio: 'inherit' }); if (r.status) process.exit(r.status)
  // side-by-side views, not for measuring: a smaller palette where needed keeps each under 500 KB
  for (const png of readdirSync(c).filter((x) => x.endsWith('.png'))) { for (const n of [128, 64, 32]) { encode(join(c, png), n); if (statSync(join(c, png)).size < 480000) break } }
  for (const png of readdirSync(c)) { const s = statSync(join(c, png)).size; if (s >= 500000) console.log('OVER 500 KB', png, s) }
}
