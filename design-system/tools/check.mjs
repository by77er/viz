// Checks the token system against its own rules. Exits non-zero on any failure.
//   node tools/check.mjs [paths…] [--no-render]
//   1. Tokens: contrast of every text, control, mark and series pairing in both themes; the series palette as a palette (lightness steps
//      between neighbours, colour-vision separation of neighbours and within each dash group, distance from every status and action
//      colour, lightness band, chroma); press against hover and chosen; status-info apart from blue; the scrim translucent.
//   2. Component CSS, read as CSS (rules, not lines): the swatch keeps its ground ring wherever a rule touches its box-shadow, the crosshair
//      dot keeps its ground edge, no rule paints a fill on a chart's surface, and every media or container condition is a breakpoint token.
//   3. Rendered audit (when src/components.css is checked, unless --no-render): every component preview in both themes, at rest, with
//      legend rows chosen, under a forced hover and a forced press. Every piece of text is measured against the fill actually behind it
//      (4.5:1), and every series swatch and line against its ring or its surface (3:1). This is what a person sees, so an override anywhere
//      in the CSS cannot slip past it.
//   4. Source lint: no literal colours, lengths, durations, opacity, angles, non-geometric percentages or unitless weights, line heights and
//      scales in component CSS. In .html, <style> blocks and style="" attributes are CSS; elsewhere in .html, .js and .ts colours are linted
//      everywhere and lengths and durations inside quoted strings. A line with `token-lint-ignore: <reason>` is skipped; the reason is required.
// The mutants this is tested against, and which check catches each: tools/mutants.mjs (run it after changing this file).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { buildCss } from './css.mjs'
const root = new URL('..', import.meta.url).pathname
const args = process.argv.slice(2), render = !args.includes('--no-render'), paths = args.filter((a) => !a.startsWith('--'))
const t = JSON.parse(readFileSync(root + 'project/tokens.json', 'utf8'))
const themes = t.color.themes.map((x) => x.id)
const col = Object.fromEntries(t.color.tokens.map((k) => [k.name, k.value]))
const v = (name, th) => (typeof col[name] === 'string' ? col[name] : col[name][th])
const flatTok = Object.fromEntries(Object.keys(t).filter((k) => Array.isArray(t[k]?.tokens) && k !== 'color').flatMap((k) => t[k].tokens.map((x) => [x.name, x.value])))
const s2l = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
const lin = (h) => [1, 3, 5].map((i) => s2l(parseInt(h.slice(i, i + 2), 16) / 255))
const lum = (h) => { const c = lin(h); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const oklabL = ([r, g, b]) => { const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b); return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s] }
// Colour-vision simulation: Machado, Oliveira and Fernandes (2009), severity 1, the model the dataviz validator's thresholds are calibrated to.
const MACHADO = { protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]], deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]] }
const sim = (h, k) => { const c = lin(h), M = MACHADO[k], cl = (x) => Math.max(0, Math.min(1, x)); return M.map((row) => cl(row[0] * c[0] + row[1] * c[1] + row[2] * c[2])) }
const dE = (a, b, k) => { const x = oklabL(k ? sim(a, k) : lin(a)), y = oklabL(k ? sim(b, k) : lin(b)); return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) }
const cvd = (a, b) => Math.min(dE(a, b, 'protan'), dE(a, b, 'deutan'))
const lch = (h) => { const [L, a, b] = oklabL(lin(h)); return [L, Math.hypot(a, b)] }
let failed = 0, checked = 0
const fail = (msg) => { failed++; console.log('FAIL  ' + msg) }

// ---- 1. tokens ----
const surfaces = ['ground', 'sunken', 'raised', 'hover']
const tones = ['blue', 'red', 'green', 'yellow']
const S = [1, 2, 3, 4, 5, 6, 7, 8]
// [foreground, backgrounds, floor, why, themes?]
const pairs = [
  ...['ink', 'ink-secondary', 'ink-muted'].map((f) => [f, surfaces, 4.5, 'text']),
  ['ink', ['rule'], 4.5, 'chosen segment, pressed secondary button'],
  ['ground', ['ink'], 4.5, 'tooltip text'],
  ['rule-control', ['ground', 'sunken', 'raised'], 3, 'control border'],
  ['focus', [...surfaces, 'rule'], 3, 'focus ring'],
  ...tones.map((c) => [`on-${c}`, [c, `${c}-hover`, `${c}-pressed`], 4.5, 'button label']),
  ...['blue', 'red', 'green'].map((c) => [c, ['ground', 'sunken', 'raised'], 3, 'button edge']),
  ...['status-critical', 'status-ok', 'status-info', 'status-warn-edge'].map((c) => [c, surfaces, 3, 'status mark']),
  ['status-warn', surfaces, 3, 'status mark', ['dark']],
  // v5. A series is drawn on ground and raised and across sunken (the Other band, intervals, a range being selected); its swatch rests on
  // hover (a row under the pointer) and rule (a chosen row) for as long as the person likes, so it meets 3:1 on all five. A press lasts as long
  // as the finger: there the swatch's own ground ring carries it (rendered audit, and the ring rule in part 2).
  ...S.map((i) => [`series-${i}`, ['ground', 'raised', 'sunken', 'hover', 'rule'], 3, 'chart series and its swatch']),
  ['series-other', ['ground', 'raised', 'sunken', 'hover', 'rule', 'pressed'], 3, 'edge of the Other band, a switched-off swatch on any row, a line stepped back'],
  ['yellow-edge', ['ground', 'sunken', 'raised'], 3, 'edge of a yellow button'],
  ['ink-secondary', ['ground', 'sunken', 'raised', 'hover', 'rule'], 3, 'acknowledged and silenced marks, threshold line'],
  ['ink-muted', ['ground', 'sunken', 'raised', 'hover', 'rule'], 3, 'ruled-out mark, claim rule, chart markers and leader ticks'],
  ['ink-secondary', ['sunken'], 4.5, 'words on a shaded interval'],
  ['ink-secondary', ['rule'], 4.5, 'second part of a chosen legend row (muted text is not allowed on rule: 4.19:1)'],
  ['ink', ['ground', 'raised'], 3, 'crosshair, edges of a range being selected, a picked member of Other'],
  ['rule-control', ['sunken'], 3, 'edges of a shaded interval'],
  ['ink', ['pressed'], 4.5, 'label of a pressed button, segment, menu row, legend row'],
  ['ink-secondary', ['pressed'], 4.5, "second part of a pressed legend row, a pressed menu row's shortcut"],
  ['focus', ['pressed'], 3, 'focus ring on a pressed control'],
]
for (const [fg, bgs, floor, why, only] of pairs) for (const bg of bgs) for (const th of only ?? themes) {
  const r = ratio(v(fg, th), v(bg, th)); checked++
  if (r < floor) fail(`${fg} on ${bg} [${th}]  ${r.toFixed(2)} < ${floor}  (${why})`)
}
// The series palette as a palette. Odd slots are the darker step and even slots the lighter, so neighbours differ in lightness (greyscale, and
// every colour-vision type). Slots 1 to 4 are solid and 5 to 8 dashed: within each group every pair is told apart by colour alone (all pairs,
// because lines cross and any two can meet); between groups the dash does it. Neighbours across the boundary (4 and 5) are checked as neighbours.
const BAND = { light: [0.43, 0.77], dark: [0.48, 0.67] }
const groupOf = (i) => (i <= 4 ? 0 : 1)
for (const th of themes) {
  for (const i of S) { const h = v(`series-${i}`, th), [L, C] = lch(h); checked += 2
    if (L < BAND[th][0] || L > BAND[th][1]) fail(`series-${i} [${th}] lightness ${L.toFixed(3)} outside ${BAND[th].join('–')}`)
    if (C < 0.1) fail(`series-${i} [${th}] chroma ${C.toFixed(3)} < 0.10: it reads as grey`)
    // never a near-copy of a status or action colour (a red line beside red critical marks), nor of Other
    for (const other of ['status-critical', 'status-warn', 'status-ok', 'status-info', 'blue', 'red', 'green', 'yellow', 'series-other']) { checked++; const d = dE(h, v(other, th)); if (d < 8) fail(`series-${i} [${th}] is ${d.toFixed(1)} from ${other} (< 8): a series must not look like a ${other.startsWith('series') ? 'the Other band' : 'state or an action'}`) }
  }
  for (let i = 1; i <= 8; i++) for (let j = i + 1; j <= 8; j++) {
    const a = v(`series-${i}`, th), b = v(`series-${j}`, th), near = j === i + 1, same = groupOf(i) === groupOf(j)
    if (near) { checked++; const r = ratio(a, b); if (r < 1.3) fail(`series-${i} beside series-${j} [${th}]  lightness step ${r.toFixed(2)} < 1.3 (neighbours alternate darker and lighter)`) }
    if (near || same) { checked += 2; const c = cvd(a, b), n = dE(a, b)
      if (c < 8) fail(`series-${i} and series-${j} [${th}]  colour-vision ΔE ${c.toFixed(1)} < 8 (${near ? 'neighbours' : 'same dash group'})`)
      if (n < 15) fail(`series-${i} and series-${j} [${th}]  normal-vision ΔE ${n.toFixed(1)} < 15 (${near ? 'neighbours' : 'same dash group'})`) }
  }
}
for (const th of themes) { checked++; if (v('status-info', th) === v('blue', th) || dE(v('status-info', th), v('blue', th)) < 8) fail(`status-info too close to blue [${th}]: a status must not look like the primary action`) }
// A press must be seen: the pressed fill differs from hover (what the pointer was already showing) and from rule (what is chosen).
for (const th of themes) for (const other of ['hover', 'rule']) { const r = ratio(v('pressed', th), v(other, th)); checked++; if (r < 1.1) fail(`pressed beside ${other} [${th}]  ${r.toFixed(2)} < 1.1  (a press must differ from ${other === 'hover' ? 'hover' : 'a chosen item'})`) }
// The scrim says "not available" without hiding what the dialog is about: translucent, neither invisible nor opaque.
for (const th of themes) { checked++; const m = String(v('scrim', th)).match(/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)$/); if (!m) fail(`scrim [${th}] is not an rgba() colour: it must be the one translucent colour`); else if (+m[1] < 0.3 || +m[1] > 0.75) fail(`scrim [${th}] alpha ${m[1]} outside 0.30–0.75: the page must stay recognisable and the dialog must stand off it`) }

// ---- 2. component CSS, as CSS ----
function parseCss(text) { // -> [{ sel: [selectors], decls: [[prop, value]], cond: [conditions], line }]
  const src = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')), out = []
  const walk = (s, from, to, cond) => { let i = from
    while (i < to) { const open = s.indexOf('{', i); if (open < 0 || open >= to) break
      let depth = 1, j = open + 1; while (j < to && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++ }
      const prelude = s.slice(i, open).trim(), line = s.slice(0, open).split('\n').length
      if (prelude.startsWith('@')) walk(s, open + 1, j - 1, [...cond, prelude])
      else { const sel = []; let d = 0, cur = ''; for (const ch of prelude) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && !d) { sel.push(cur.trim()); cur = '' } else cur += ch } sel.push(cur.trim())
        const decls = s.slice(open + 1, j - 1).split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const k = x.indexOf(':'); return [x.slice(0, k).trim(), x.slice(k + 1).trim().replace(/\s+/g, ' ')] })
        out.push({ sel, decls, cond, line }) }
      i = j }
  }
  walk(src, 0, src.length, []); return out
}
const compPath = root + 'src/components.css', comp = readFileSync(compPath, 'utf8'), rules = parseCss(comp)
const lastCompound = (sel) => sel.split(/[\s>+~]+/).filter(Boolean).pop() ?? ''
// The swatch's ground ring: the base rule has it, and any rule that touches the swatch's box-shadow keeps it (a switched-off swatch has its own
// inset Other edge instead). Read as CSS, so reformatting cannot fool it and an override anywhere is found.
{ const RING = '0 0 0 var(--stroke) var(--ground)', OFF = 'inset 0 0 0 var(--hairline) var(--series-other)'; let base = false
  for (const r of rules) for (const s of r.sel) if (/\.vz-swatch\b/.test(lastCompound(s))) for (const [p, val] of r.decls) if (p === 'box-shadow') { checked++
    if (s === '.vz-swatch' && val === RING) base = true
    else if (val !== RING && !(/\[data-off\]/.test(s) && val === OFF)) fail(`${s} sets box-shadow: ${val} (line ${r.line}): the swatch must keep its ground ring (${RING}); a pressed row puts series below 3:1 without it`) }
  checked++; if (!base) fail(`.vz-swatch has lost its ground ring (${RING})`) }
{ let ok = false; for (const r of rules) for (const s of r.sel) if (s === '.vz-plot .vz-dot[data-series]') for (const [p, val] of r.decls) if (p === 'stroke') { checked++; if (val === 'var(--ground)') ok = true; else fail(`${s} stroke ${val} (line ${r.line}): the crosshair dot keeps its ground edge`) }
  checked++; if (!ok) fail('.vz-plot .vz-dot[data-series] has lost its ground edge') }
// Slots 5 to 8 are told from 1 to 4 by their dash where hue and lightness repeat: each must carry a pattern, and lines must draw it.
for (const i of [5, 6, 7, 8]) { checked++; if (!rules.some((r) => r.sel.includes(`[data-series="${i}"]`) && r.decls.some(([p]) => p === '--pattern'))) fail(`[data-series="${i}"] has no --pattern: slots 5 to 8 must be dashed, the second channel beside colour`) }
{ checked++; if (!rules.some((r) => r.sel.includes('.vz-plot .vz-line[data-series]') && r.decls.some(([p, val]) => p === 'stroke-dasharray' && /var\(--pattern/.test(val)))) fail('.vz-plot .vz-line[data-series] does not draw --pattern: dashed slots would be drawn solid') }
// A chart's surface is its panel's (ground, or raised in an overlay). No rule paints the plot or the chart itself: series are measured against ground and raised only.
for (const r of rules) for (const s of r.sel) { const last = lastCompound(s); if (/^(svg)?\.vz-(plot|chart)(\[[^\]]*\]|:[\w-]+(\([^)]*\))?)*$/.test(last)) for (const [p] of r.decls) if (/^(background|background-color|fill)$/.test(p)) { checked++; fail(`${s} sets ${p} (line ${r.line}): a chart has no fill of its own; series are only checked on ground and raised`) } }
// Breakpoints: media and container conditions cannot read tokens, so every width in a condition is a breakpoint token (or one less, as a maximum).
const bps = Object.entries(flatTok).filter(([k]) => k.startsWith('breakpoint-')).map(([, val]) => parseFloat(val)), bpOk = new Set(bps.flatMap((b) => [b, b - 1]))
for (const r of rules) for (const c of r.cond) for (const m of c.matchAll(/(\d+(?:\.\d+)?)px/g)) { checked++; if (!bpOk.has(+m[1])) fail(`condition "${c}" (line ${r.line}) uses ${m[1]}px, which is not a breakpoint token (${bps.join(', ')}px)`) }

// ---- 3. rendered audit ----
async function audit() {
  const { chromium } = createRequire(import.meta.url)('playwright')
  const { viz } = buildCss(root), dir = root + 'project/components/'
  const names = readdirSync(dir).filter((n) => { try { return statSync(`${dir}${n}/preview.html`).isFile() } catch { return false } }).filter((n) => n !== 'Cover')
  const part = (n) => { const h = readFileSync(`${dir}${n}/preview.html`, 'utf8'); return { style: (h.match(/<style>([\s\S]*?)<\/style>/g) ?? []).join('').replace(/<\/?style>/g, ''), scripts: h.match(/<script>[\s\S]*?<\/script>/g) ?? [], inner: h.slice(h.indexOf('<body'), h.lastIndexOf('</body>')).replace(/<body[^>]*>/, '').replace(/<script>[\s\S]*?<\/script>/g, '') } }
  const parts = names.map(part), column = (th) => `<div data-theme="${th}" class="vz" style="padding:var(--space-6)">${parts.map((p, i) => `<section data-c="${names[i]}">${p.inner}</section>`).join('')}</div>`
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${viz}body{margin:0}${parts.map((p) => p.style).join('').replace(/html,body\{margin:0\}|body\{padding:[^}]*\}/g, '')}</style></head><body>${column('light')}${column('dark')}${[...new Set(parts.flatMap((p) => p.scripts))].join('\n')}</body></html>`
  const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 900 } }), cdp = await page.context().newCDPSession(page)
  page.on('pageerror', (e) => fail(`audit page error: ${e.message}`))
  await page.setContent(html, { waitUntil: 'load' }); await page.waitForTimeout(200)
  // states the previews do not show at rest: a chosen legend row (so the others are off), and Other opened
  await page.evaluate(() => { const charts = [...document.querySelectorAll('.vz-chart')]; for (const c of charts) { const tr = c.querySelector('tbody tr[data-key]'); if (c.vz && tr) c.vz.toggle(tr.dataset.key); if (c.vz && c.querySelector('tbody tr[data-key="other"]')) c.vz.toggle('other'); c.querySelector('[data-more]')?.click() }
    // and a row brought forward, so the lines that step back are measured too
    for (const c of charts.filter((x) => x.querySelectorAll('tbody tr[data-key]').length > 3).slice(0, 2)) c.querySelectorAll('tbody tr[data-key] .vz-series')[1]?.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
  const measure = (pass) => page.evaluate((pass) => {
    const out = [], parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 } }
    const L = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b) }
    const R = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.99) return c } return { r: 255, g: 255, b: 255 } }
    const where = (el) => { const sec = el.closest('section[data-c]'); return `${el.closest('[data-theme]')?.dataset.theme} ${sec?.dataset.c ?? ''} <${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').join('.') : ''}>` }
    const hex = (c) => '#' + [c.r, c.g, c.b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el); if (cs.visibility !== 'visible' || el.closest('[hidden], [aria-hidden="true"] .vz-sr')) continue
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue
      const svgText = el.tagName === 'text' && el.closest('svg')
      if (!svgText && el.closest('svg')) {
        if (el.matches('.vz-line')) { const s = parse(cs.stroke), bg = bgOf(el.closest('svg')); if (s && R(s, bg) < 3) out.push(`${pass}: series line ${hex(s)} on ${hex(bg)} ${R(s, bg).toFixed(2)}:1 < 3  ${where(el)}`) }
        continue }
      if (el.matches('.vz-swatch')) { // the mark is its drawn edge where it has one (dashed slots, Other's band edges), else its fill
        const side = ['Top', 'Left'].find((k) => cs[`border${k}Style`] !== 'none' && parseFloat(cs[`border${k}Width`]) > 0), fill = parse(cs.backgroundColor), c = side ? parse(cs[`border${side}Color`]) : fill && fill.a > 0.99 ? fill : null
        const ring = /(rgba?\([^)]*\)) 0px 0px 0px (\d+(?:\.\d+)?)px(?! inset)/.exec(cs.boxShadow), inset = /(rgba?\([^)]*\)) 0px 0px 0px [\d.]+px inset/.exec(cs.boxShadow)
        const bg = ring && parseFloat(ring[2]) >= 2 ? parse(ring[1]) : bgOf(el.parentElement), mark = c ?? (inset ? parse(inset[1]) : null)
        if (mark && R(mark, bg) < 3) out.push(`${pass}: swatch ${hex(mark)} on ${hex(bg)} ${R(mark, bg).toFixed(2)}:1 < 3  ${where(el)}`); continue }
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()); if (!own) continue
      if (el.closest(':disabled, [aria-disabled="true"], [disabled]')) continue
      const fg = parse(svgText ? cs.fill : cs.color); if (!fg) continue
      const bg = bgOf(svgText ? el.closest('svg') : el), ratio = R(fg, bg)
      if (ratio < 4.5) out.push(`${pass}: text "${el.textContent.trim().slice(0, 24)}" ${hex(fg)} on ${hex(bg)} ${ratio.toFixed(2)}:1 < 4.5  ${where(el)}`)
    }
    return out }, pass)
  const results = [...await measure('at rest')]
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable')
  const { root: doc } = await cdp.send('DOM.getDocument', { depth: -1 }), { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: doc.nodeId, selector: 'tr, button, a, summary, label, [role^="menuitem"], .vz-plot, .vz-sort' })
  for (const [name, states] of [['hover', ['hover']], ['press', ['hover', 'active']]]) {
    for (const nodeId of nodeIds) await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: states })
    results.push(...await measure(name))
    for (const nodeId of nodeIds) await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
  }
  await browser.close()
  const uniq = [...new Set(results)]; checked += 3
  for (const r of uniq) fail('rendered ' + r)
  console.log(`rendered audit: ${names.length} previews, both themes, at rest, hover and press: ${uniq.length} failure(s)`)
}
const targets = paths.length ? paths.map((p) => resolve(p)) : [compPath]
if (render && targets.some((p) => p === compPath || p === resolve(root, 'src') || p === resolve(root, '.') || p.startsWith(root + 'project'))) await audit()
console.log(`contrast and structure: ${checked - failed}/${checked} checks pass`)

// ---- 4. source lint ----
const files = []
const walk = (p) => { const s = statSync(p); if (s.isDirectory()) { for (const f of readdirSync(p)) if (!['node_modules', 'dist', '.wrangler', 'bundle.css'].includes(f)) walk(join(p, f)) } else if (['.css', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.html'].includes(extname(p))) files.push(p) }
targets.forEach(walk)
const colour = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb|color)\(/g
const cssRules = [
  ['colour', colour],
  ['length', /(?<![\w-])\d*\.?\d+(?:px|rem|em|ch|vw|vh|pt|cm|mm|in)\b/g],
  ['duration', /(?<![\w-])\d*\.?\d+ms\b|(?<![\w-])\d*\.\d+s\b|(?<![\w-])[1-9]\d*s\b/g],
  ['opacity', /\bopacity\s*:/g],
  ['angle', /(?<![\w-])-?\d*\.?\d+(?:deg|turn|rad|grad)\b/g],
  ['percentage', /(?<![\w-])\d*\.?\d+%/g],
  ['unitless', /\bfont-weight\s*:\s*\d+|\bline-height\s*:\s*(?!1\s*[;}]|1$|normal|var)[\d.]+|\bscale\s*\(\s*-?[\d.]+|\bz-index\s*:\s*(?!-?[0-9]{1,2}\s*[;}]|-?[0-9]{1,2}$)\d+/g],
]
const GEOMETRY = new Set(['0%', '50%', '100%']) // geometry, not a design value
let hits = 0
const report = (kind, f, line, m) => { hits += m.length; console.log(`LITERAL ${kind}  ${f.replace(root, '')}:${line}  ${m.join(' ')}`) }
function lintCss(text, f, lineOf = (i) => i + 1, inCondition) {
  const conds = new Set(); for (const r of parseCss(text)) for (const c of r.cond) conds.add(c)
  text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).split('\n').forEach((line, i) => {
    if (/token-lint-ignore/.test(text.split('\n')[i])) { if (!/token-lint-ignore:\s*\S/.test(text.split('\n')[i])) report('ignore-without-reason', f, lineOf(i), ['token-lint-ignore']); return }
    const code = line.replace(/@(media|container)[^{]*/g, '') // conditions are checked against the breakpoint tokens above
    for (const [kind, re] of cssRules) { let m = code.match(re); if (!m) continue; if (kind === 'percentage') m = m.filter((x) => !GEOMETRY.has(x)); if (m.length) report(kind, f, lineOf(i), m) }
  })
}
for (const f of files) {
  const text = readFileSync(f, 'utf8'), ext = extname(f)
  if (ext === '.css') { lintCss(text, f); continue }
  const lines = text.split('\n'), test = /\.test\.[a-z]+$/.test(f) // test files hold query text such as "rate(x[30s])"; only colours are linted there
  let inStyle = false, styleStart = 0, styleText = []
  lines.forEach((raw, i) => {
    if (ext === '.html') {
      if (inStyle || /<style>/.test(raw)) { const open = raw.indexOf('<style>'), close = raw.indexOf('</style>'); if (!inStyle) { inStyle = true; styleStart = i; styleText = [] } styleText.push(raw.slice(open >= 0 ? open + 7 : 0, close >= 0 ? close : undefined)); if (close >= 0) { inStyle = false; lintCss(styleText.join('\n'), f, (k) => styleStart + k + 1) } if (open >= 0 && close < 0 || inStyle) return; raw = raw.slice(close + 8) }
      for (const m of raw.matchAll(/\sstyle="([^"]*)"/g)) if (!/token-lint-ignore/.test(raw)) lintCss(`x{${m[1]}}`, f, () => i + 1)
    }
    if (/token-lint-ignore/.test(raw)) { if (!/token-lint-ignore:\s*\S/.test(raw)) report('ignore-without-reason', f, i + 1, ['token-lint-ignore']); return }
    const code = raw.replace(/\/\*.*?\*\//g, '').replace(/\sstyle="[^"]*"/g, '')
    const quoted = test ? '' : (code.match(/(['"`])(?:(?!\1).)*\1/g) ?? []).join(' ')
    const m1 = code.match(colour); if (m1) report('colour', f, i + 1, m1)
    for (const [kind, re] of cssRules.slice(1, 3)) { const m = quoted.match(re); if (m) report(kind, f, i + 1, m) }
  })
}
console.log(`literal values: ${hits} in ${files.length} file(s)`)
process.exit(failed || hits ? 1 : 0)
