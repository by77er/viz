// The flow screens: builds screens/*.html into dist/ (ignored by git) on the system's own CSS and reference chart, and images them.
//   node build.mjs                     pages only, into flows/dist/
//   node build.mjs --facts             prints every chart's last, min and max from fixture.js (the figures the screens state)
//   node build.mjs --shots [n ...]     pages, then the scenarios in scenarios/ (all, or the screens whose names start with n) with
//                                      tools/shots.mjs, one browser at a time; images palette-encoded into shots/, measurements
//                                      appended to measurements.txt
//   node build.mjs --compare <before>  before/after images into compare/: <before> holds the v1 images (<screen>-<theme>-<width>.png)
// A screen file starts with <!-- nav: Section --> and <!-- title: ... -->. States are URL fragments: an element with
// data-when="a b" is shown only in states a and b ("default" is no fragment); data-unless="a" hides it in state a.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, renameSync, existsSync, copyFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import vm from 'node:vm'

const root = new URL('.', import.meta.url).pathname, ds = join(root, '..'), out = join(root, 'dist')
const args = process.argv.slice(2)
mkdirSync(out, { recursive: true })

const sections = ['Explore', 'Dashboards', 'Monitors', 'Traces', 'Logs']
const nav = (current) => `<nav class="vz-nav" aria-label="Sections"><span class="vz-nav-name">viz</span>${sections.map((n) => `<a href="#"${n === current ? ' aria-current="page"' : ''}>${n}</a>`).join('')}<span style="flex:1"></span><span style="color:var(--ink-secondary)" title="Tenant">acme-prod</span><a href="8-keys.html"${current === 'Settings' ? ' aria-current="page"' : ''}>Settings</a></nav>`

// Everything here is either a fix-up for a system gap (named in REVISION.md, "System gaps found") or state switching for the design.
const css = `body { margin: 0; }
[hidden] { display: none !important; } /* system classes set display, which beats the hidden attribute */
a.vz-skip.vz-button { position: absolute; } /* G1: .vz-button's position: relative overrides .vz-skip's absolute, so the hidden link took a control's height above the nav */
.flow-pop { position: relative; display: inline-flex; }
.flow-pop > .vz-menu { position: absolute; right: 0; top: calc(100% + var(--space-2)); z-index: 3; width: max-content; max-width: calc(100vw - 2 * var(--space-4)); }
.flow-menu-note { margin: 0; padding: var(--space-1) var(--space-2); max-width: var(--overlay-min); font: var(--text-small); color: var(--ink-secondary); } /* G3: a menu has no place for a sentence */
.flow-menu-note + .vz-controls { padding: var(--space-1) var(--space-2) var(--space-2); }
.flow-indent { display: block; padding-left: calc(var(--space-4) * var(--depth, 0)); } /* G5 waterfall: a span's depth */
.flow-bar { display: block; height: var(--space-2); margin-left: var(--at); width: var(--len); min-width: var(--stroke); background: var(--ink-muted); } /* G5 waterfall: a span's start and length as shares of the trace */
.flow-bar[data-slow] { background: var(--ink); }
.flow-scale { display: flex; justify-content: space-between; gap: var(--space-2); font: var(--text-micro); color: var(--ink-muted); }
.vz-table td.flow-wrap { white-space: normal; min-width: var(--overlay-min); } /* G6 log line: a message wraps instead of widening the table */
.flow-said { margin: 0; max-width: var(--measure); }
`
const stateScript = `<script>
function flowState() { const s = decodeURIComponent(location.hash.slice(1)) || 'default'
  for (const el of document.querySelectorAll('[data-when]')) el.hidden = !el.dataset.when.split(' ').includes(s)
  for (const el of document.querySelectorAll('[data-unless]')) el.hidden = el.dataset.unless.split(' ').includes(s)
  document.documentElement.dataset.flowState = s; return s }
document.addEventListener('click', (e) => { const g = e.target.closest('[data-go]'); if (!g) return; e.preventDefault(); location.hash = g.dataset.go })
addEventListener('hashchange', () => { flowState(); const f = [...document.querySelectorAll('[data-autofocus]')].find((el) => el.offsetParent); if (f) f.focus() })
// Menu rows that hold a choice: a tap or Enter chooses the row; the confirming button names the choice.
document.addEventListener('click', (e) => { const r = e.target.closest('[role="menuitemradio"]'); if (!r) return; r.parentElement.querySelectorAll('[role="menuitemradio"]').forEach((x) => x.setAttribute('aria-checked', x === r)); const b = r.closest('.vz-menu').querySelector('[data-names-choice]'); if (b) b.textContent = r.dataset.confirm })
</script>`

function page(file, src) {
  const current = (src.match(/<!-- nav: (\w+) -->/) ?? [])[1], title = (src.match(/<!-- title: (.+?) -->/) ?? [])[1] ?? file
  const at = src.indexOf('<script'), markup = at < 0 ? src : src.slice(0, at), scripts = at < 0 ? '' : src.slice(at)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>viz · ${title}</title>
<link rel="preload" as="font" type="font/woff2" crossorigin href="../../dist/fonts/SchibstedGrotesk-Variable.woff2"><link rel="stylesheet" href="../../dist/viz.css"><style>${css}</style>
<script src="../../dist/viz-chart.js"></script><script src="../fixture.js"></script>${stateScript}</head>
<body class="vz"><a class="vz-button vz-skip" href="#main">Skip to content</a>${nav(current)}
${markup}<script>flowState()</script>${scripts}</body></html>`
}

const names = []
for (const f of readdirSync(join(root, 'screens')).filter((x) => x.endsWith('.html')).sort((a, b) => parseInt(a) - parseInt(b))) {
  writeFileSync(join(out, f), page(f, readFileSync(join(root, 'screens', f), 'utf8')))
  names.push(f.replace('.html', ''))
}
console.log('built', names.length, 'screens into flows/dist/:', names.join(', '))

// Scenarios for tools/shots.mjs, one file per screen. Every screen: light and dark at 1440, light at 400 with a coarse pointer (hit areas
// and overflow measured), a greyscale copy, and keyboard focus; then its own states (URL fragments) and errors.
const st = (name, o = {}) => ({ name, ...o })
const at400 = (name, frag, o = {}) => st(name, { url: `flows/dist/${o.screen}.html#${frag}`, width: 400, coarse: true, measure: true, themes: ['light'], ...o, screen: undefined })
const at1440 = (name, frag, o = {}) => st(name, { url: `flows/dist/${o.screen}.html#${frag}`, scale: 1, measure: true, themes: ['light'], ...o, screen: undefined })
const extra = {
  '1-dashboards': { focus: ['#q', 'header'], states: (s) => [at1440('error-1440', 'error', { screen: s }), at400('empty-400', 'empty', { screen: s }), at400('first-run-400', 'first-run', { screen: s }), at1440('first-run-1440', 'first-run', { screen: s, themes: ['dark'] })] },
  '2-dashboard': { focus: ['#range button:nth-child(2)', 'header'], states: (s) => [at1440('error-1440', 'error', { screen: s }), at1440('waiting-1440', 'waiting', { screen: s })] },
  '3-monitors': { focus: ['tbody tr:first-child a', '.vz-table-wrap'], states: (s) => [at400('error-400', 'error', { screen: s }), at400('first-run-400', 'first-run', { screen: s }), at400('400-hit-areas', '', { screen: s, outline: true }), st('zoom-200', { zoom: 2, scale: 1, measure: true, themes: ['light'] })] },
  '4-monitor': { focus: ['.vz-button[data-tone="green"]', 'header'], states: (s) => [at400('400', '', { screen: s, themes: ['dark'] }), at400('400-hit-areas', '', { screen: s, outline: true }), at400('silence-menu-400', 'silence-menu', { screen: s }), at400('ack-400', 'ack', { screen: s, themes: ['light', 'dark'] }), at400('silenced-400', 'silenced', { screen: s }), at400('notice-400', 'notice', { screen: s }), at400('error-400', 'error', { screen: s }), at400('nodata-400', 'nodata', { screen: s }), st('zoom-200', { zoom: 2, scale: 1, measure: true, themes: ['light'] })] },
  '5-new-monitor': { focus: ['#name', 'form'], states: (s) => [at1440('error-1440', 'error', { screen: s }), at1440('many-1440', 'many', { screen: s })] },
  '6-investigation': { focus: ['#evidence-1', '#claim-1'], states: (s) => [at400('confirmed-400', 'confirmed', { screen: s }), at1440('running-1440', 'running', { screen: s }), at400('failed-400', 'failed', { screen: s })] },
  '7-proposed-change': { focus: ['#change-1', '.vz-change'], states: (s) => [at1440('applied-1440', 'applied', { screen: s }), at400('failed-400', 'failed', { screen: s })] },
  '8-keys': { focus: ['#new-key', 'header'], states: (s) => [at400('new-400', 'new', { screen: s }), at1440('secret-1440', 'secret', { screen: s, themes: ['light', 'dark'] }), at400('saved-400', 'saved', { screen: s }), at400('error-400', 'error', { screen: s }), at400('revoke-400', 'revoke', { screen: s }), at1440('menu-1440', 'menu', { screen: s }), at1440('arrived-1440', 'arrived', { screen: s })] },
  '9-traces': { focus: ['#first-trace', '.vz-split > :last-child'], states: (s) => [at1440('error-1440', 'error', { screen: s })] },
  '10-logs': { focus: ['tbody tr:first-child a', '.vz-panel:last-of-type'], states: (s) => [at1440('error-1440', 'error', { screen: s })] },
  '11-notification': { focus: ['header a', 'header'], states: (s) => [at400('error-400', 'error', { screen: s }), at1440('ack-1440', 'ack', { screen: s })] },
  '12-routes': { focus: ['#end', '.vz-panel:last-of-type'], states: (s) => [at400('error-400', 'error', { screen: s })] },
}
mkdirSync(join(root, 'scenarios'), { recursive: true })
for (const n of names) {
  const x = extra[n] ?? { focus: ['main a, main button', 'header'], states: () => [] }
  const states = [st('1440', { scale: 1, measure: true }), st('400', { width: 400, coarse: true, measure: true, themes: ['light'] }), st('grey', { scale: 1, greyscale: true, themes: ['light'] }),
    st('focus', { steps: [{ focus: x.focus[0] }], clip: x.focus[1], pad: 24, themes: ['light'] }), ...x.states(n)]
  // a state that names a theme list keeps it; "400" may appear twice (light from the common set, dark from the screen's own)
  writeFileSync(join(root, 'scenarios', n + '.json'), JSON.stringify({ name: n, url: `flows/dist/${n}.html`, states }, null, 1) + '\n')
}

if (args.includes('--facts')) {
  const ctx = { window: {}, document: { readyState: 'complete', querySelectorAll: () => [] } }; ctx.globalThis = ctx
  vm.createContext(ctx); vm.runInContext(readFileSync(join(ds, 'dist/viz-chart.js'), 'utf8'), ctx); vm.runInContext(readFileSync(join(root, 'fixture.js'), 'utf8').replace('typeof window', "'object'"), ctx)
  const f = ctx.window.flows, hm = (t) => new Date(t).toISOString().slice(11, 16)
  for (const k of ['latency', 'errors', 'traceDurations', 'deps', 'depsAgent', 'logs', 'backtest']) { const s = f[k]()
    console.log(`${k}: ${s.unit}, ${hm(s.t0)} to ${hm(s.t0 + (s.series[0].values.length - 1) * s.step)}, step ${s.step / f.MIN} min ${s.agg}`)
    for (const x of s.series) { const v = x.values.filter((y) => y != null); console.log(`  ${Object.values(x.labels).join(' · ')}: last ${v[v.length - 1]}, min ${Math.min(...v)}, max ${Math.max(...v)}`) } }
  console.log(`error log lines, 09:16 to 15:16: ${f.logLines}`)
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
  writeFileSync(join(root, 'dist', 'measurements-last.txt'), log.join('\n') + '\n')
  rmSync(tmp, { recursive: true, force: true })
}

if (args.includes('--compare')) {
  const before = args[args.indexOf('--compare') + 1], b = join(root, 'dist', 'cmp-before'), a = join(root, 'dist', 'cmp-after'), c = join(root, 'compare')
  for (const d of [a, b]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }) }
  mkdirSync(c, { recursive: true })
  // v1 named images <screen>-<theme>-<width>; v2 names them <screen>-<state>-<theme>. The pairs: 1440 light, 1440 dark, 400 light.
  for (const f of readdirSync(before).filter((x) => /-(light|dark)-(1440|400)\.png$/.test(x))) {
    const [, screen, theme, w] = f.match(/^(.+)-(light|dark)-(1440|400)\.png$/), after = join(root, 'shots', `${screen}-${w}-${theme}.png`)
    if (!existsSync(after)) { console.log('no after image for', f); continue }
    copyFileSync(join(before, f), join(b, `${screen}-${w}-${theme}.png`)); copyFileSync(after, join(a, `${screen}-${w}-${theme}.png`))
  }
  const r = spawnSync('node', ['tools/shots.mjs', 'compare', b, a, c], { cwd: ds, stdio: 'inherit' }); if (r.status) process.exit(r.status)
  for (const png of readdirSync(c).filter((x) => x.endsWith('.png'))) { encode(join(c, png), 128); if (statSync(join(c, png)).size > 480000) encode(join(c, png), 64) } // side-by-side views, not for measuring: a smaller palette keeps each under about 500 KB
}
