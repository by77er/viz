// Checks the token system and the components against their own rules. Exits non-zero on any failure.
//   node tools/check.mjs [paths…] [--no-render]
//   1. Tokens: contrast of every text, control, mark and series pairing in both themes; the series palette as a palette (lightness steps
//      between neighbours, colour-vision separation of neighbours and within each dash group, distance from every status and action
//      colour, lightness band, chroma); Other set apart in lightness from every slot; press against hover and chosen; disabled ink set apart
//      from muted ink; status-info apart from blue; the scrim translucent; micro the smallest type size.
//   2. Component CSS, parsed (css-tree), checked as rules (tools/lib/structure.mjs): colour confined to toned buttons, status marks, chart
//      series and the focus ring; one shadow, for overlays; a press never eased, with a [data-pressed] twin for every :active; nothing
//      revealed or moved on hover; and the presence of every fix earlier reviews asked for (focus ring, coarse hit areas, the chart's
//      reservation from the coarse sizes, dashed slots, emphasis, touch-action, reduced motion, the swatch ring, a positioned table wrap,
//      the fold pattern and its two forms in step, the caption as one run of text, links in sentences, a cut link's underline).
//   3. Rendered audit (when src/components.css is checked, unless --no-render): every component preview in both themes, at rest, with
//      legend rows chosen, under a forced hover, a forced press (:active) and a finger's press ([data-pressed]). Every piece of text is
//      measured against the fill actually behind it (4.5:1), and every series swatch and line against its ring or its surface (3:1). And,
//      at 1200 px with a fine pointer and at 400 and 320 px with a coarse one, EVERY chart (v9; v8 read only those that set --legend-rows)
//      reserves exactly what it draws, both in its markup (the first frame of a load, before any script) and once its script has drawn it,
//      and computes content-visibility: auto.
//   4. Literal values (tools/lib/lint.mjs, on css-tree and parse5): any design value written out instead of taken from a token, at any
//      depth of a value, in component CSS, in <style> blocks and style attributes (either quote) in HTML, and in CSS written by script
//      (style attributes in templates, cssText, style.<prop> = …, setProperty), plus colours anywhere in script; conditions must use the
//      breakpoint tokens. A line with `token-lint-ignore: <reason>` is skipped; the reason is required.
// The mutants this is tested against, and which check catches each: tools/mutants-corpus.mjs, run by tools/mutants.mjs and npm test.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { buildCss } from './css.mjs'
import { lintCss, lintHtml, lintScript, setTokenNames } from './lib/lint.mjs'
import { structure } from './lib/structure.mjs'
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
  // v5, Waterfall and Log: a status mark in the row whose detail is shown (rule) or under a press (a failed span, an error line); a span's bar
  // in a pressed row (ink-muted, and ink where the time went).
  ...['status-critical', 'status-ok', 'status-info', 'status-warn-edge'].map((c) => [c, ['rule', 'pressed'], 3, 'status mark in a chosen or pressed row']),
  ['ink-muted', ['pressed'], 3, 'a waterfall bar in a pressed row'],
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

// Disabled reads as disabled: below text contrast, still visible, and set apart from muted ink (v5 review, X25).
for (const th of themes) { const d = v('ink-disabled', th); checked += 3
  if (ratio(d, v('ink-muted', th)) < 1.5) fail(`ink-disabled is ${ratio(d, v('ink-muted', th)).toFixed(2)}:1 from ink-muted [${th}] (< 1.5): a disabled control would read as enabled`)
  if (ratio(d, v('sunken', th)) >= 4.5) fail(`ink-disabled reaches text contrast on sunken [${th}]: it must read as unavailable`)
  if (ratio(d, v('sunken', th)) < 2) fail(`ink-disabled is ${ratio(d, v('sunken', th)).toFixed(2)}:1 on sunken [${th}] (< 2): a disabled label must still be seen`) }
// Other is set apart in lightness from every slot, so in greyscale its band's edges are not read as a slot's line (v5 review, m5).
const OTHER_STEP = { light: 1.3, dark: 1.15 }
for (const th of themes) for (const i of S) { checked++; const r = ratio(v('series-other', th), v(`series-${i}`, th)); if (r < OTHER_STEP[th]) fail(`series-other beside series-${i} [${th}]  lightness ${r.toFixed(2)}:1 < ${OTHER_STEP[th]}: in greyscale Other's edge reads as that slot`) }
// micro is the smallest text (v5 review, X32)
{ const styles = t.type.groups.flatMap((g) => g.styles), micro = parseFloat(styles.find((x) => x.name === 'micro').fontSize); for (const x of styles) { checked++; if (parseFloat(x.fontSize) < micro) fail(`type style ${x.name} is ${x.fontSize}, below micro (${micro}px), the smallest text`) } }

// ---- 2. component CSS, as CSS ----
const compPath = root + 'src/components.css', comp = readFileSync(compPath, 'utf8')
const bps = Object.entries(flatTok).filter(([k]) => k.startsWith('breakpoint-')).map(([, val]) => parseFloat(val)), bpOk = new Set(bps.flatMap((b) => [b, b - 1]))
const colourTokens = new Set([...t.color.tokens.map((k) => k.name), 'series'])
setTokenNames([...t.color.tokens.map((k) => k.name), ...(t.shadow?.tokens ?? []).map((k) => k.name), ...Object.keys(t).filter((k) => Array.isArray(t[k]?.tokens) && !['color', 'shadow'].includes(k)).flatMap((k) => t[k].tokens.map((x) => x.name)), ...t.type.groups.flatMap((g) => g.styles.flatMap((x) => ['', '-size', '-lh', '-weight', '-track'].map((suf) => 'text-' + x.name + suf))), ...Object.keys(t.type.families).map((k) => 'font-' + k)])
let hits = 0
const report = (kind, f, line, m) => { hits += m.length; console.log(`LITERAL ${kind}  ${f.replace(root, '')}:${line}  ${m.join(' ')}`) }
const rules = lintCss(comp, { file: compPath, report, tokens: colourTokens, breakpoints: bpOk })
checked += structure(rules, { fail, tokens: colourTokens })

// ---- 3. rendered audit ----
async function audit() {
  const { chromium } = createRequire(import.meta.url)('playwright')
  const { viz } = buildCss(root), dir = root + 'project/components/'
  const names = readdirSync(dir).filter((n) => { try { return statSync(`${dir}${n}/preview.html`).isFile() } catch { return false } }).filter((n) => n !== 'Cover')
  const part = (n) => { const h = readFileSync(`${dir}${n}/preview.html`, 'utf8'); return { style: (h.match(/<style>([\s\S]*?)<\/style>/g) ?? []).join('').replace(/<\/?style>/g, ''), scripts: h.match(/<script>[\s\S]*?<\/script>/g) ?? [], inner: h.slice(h.indexOf('<body'), h.lastIndexOf('</body>')).replace(/<body[^>]*>/, '').replace(/<script>[\s\S]*?<\/script>/g, '') } }
  const parts = names.map(part), column = (th) => `<div data-theme="${th}" class="vz" style="padding:var(--space-6)">${parts.map((p, i) => `<section data-c="${names[i]}">${p.inner}</section>`).join('')}</div>`
  var html = `<!doctype html><html><head><meta charset="utf-8"><style>${viz}body{margin:0}${parts.map((p) => p.style).join('').replace(/html,body\{margin:0\}|body\{padding:[^}]*\}/g, '')}</style></head><body>${column('light')}${column('dark')}${[...new Set(parts.flatMap((p) => p.scripts))].join('\n')}</body></html>`
  const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 900 } }), cdp = await page.context().newCDPSession(page)
  page.on('pageerror', (e) => fail(`audit page error: ${e.message}`))
  await page.setContent(html, { waitUntil: 'load' }); await page.waitForTimeout(200)
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
      if (el.matches('.vz-waterfall-bar')) { const c = parse(cs.backgroundColor), bg = bgOf(el.parentElement); if (c && R(c, bg) < 3) out.push(`${pass}: waterfall bar ${hex(c)} on ${hex(bg)} ${R(c, bg).toFixed(2)}:1 < 3  ${where(el)}`); continue }
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
  // The previews as they open, under a forced press: nothing chosen yet, so a press on a row whose text is muted (Other's count) is measured.
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable')
  const forced = async (selector, states, pass) => { const { root: doc } = await cdp.send('DOM.getDocument', { depth: -1 }), { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: doc.nodeId, selector })
    for (const nodeId of nodeIds) await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: states })
    const out = await measure(pass); for (const nodeId of nodeIds) await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }); return out }
  const results = [...await forced('tr, button, a, summary, label, [role^="menuitem"], .vz-plot, .vz-sort', ['hover', 'active'], 'press, as opened')]
  // states the previews do not show at rest: a chosen legend row (so the others are off), and Other opened
  await page.evaluate(() => { const charts = [...document.querySelectorAll('.vz-chart')]; for (const c of charts) { const tr = c.querySelector('tbody tr[data-key]'); if (c.vz && tr) c.vz.toggle(tr.dataset.key); if (c.vz && c.querySelector('tbody tr[data-key="other"]')) c.vz.toggle('other'); c.querySelector('[data-more]')?.click() }
    // and a row brought forward, so the lines that step back are measured too
    for (const c of charts.filter((x) => x.querySelectorAll('tbody tr[data-key]').length > 3).slice(0, 2)) c.querySelectorAll('tbody tr[data-key] .vz-series')[1]?.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
  results.push(...await measure('at rest'))
  for (const [name, states] of [['hover', ['hover']], ['press', ['hover', 'active']]]) results.push(...await forced('tr, button, a, summary, label, [role^="menuitem"], .vz-plot, .vz-sort', states, name))
  // a finger's press: data-pressed (viz-press.js) on every pressable and its ancestors, as a held finger leaves it
  await page.evaluate(() => { for (const e of document.querySelectorAll('button, a[href], summary, [role^="menuitem"], tr[data-key], .vz-sort')) for (let x = e; x && x !== document.body; x = x.parentElement) x.setAttribute('data-pressed', '') })
  results.push(...await measure('finger press'))
  await browser.close()
  // The chart's reserved height is what it draws (v4 review, B2), for EVERY chart on the previews (v9; the v8 review's B1: v8 read only the
  // charts that set --legend-rows, and most did not), at 1200 px with a fine pointer and at 400 and 320 px with a coarse one, twice:
  //   in its markup, as the first frame of a load draws it, before any script has run (the page rendered with its scripts left out): a
  //     chart that draws legend rows and has no --legend-rows there has no reservation, and fails;
  //   once its script has drawn it (the reservation it then holds while skipped off screen or while the next result waits);
  // each against what it draws, laid out (a chart off screen is skipped: content-visibility: auto, v8). And every chart computes
  // content-visibility: auto (the v8 review's V4: a later rule undid the skipping).
  for (const [width, coarse] of [[1200, false], [400, true], [320, true]]) {
    const b2 = await chromium.launch(), p2 = await b2.newPage({ viewport: { width, height: 900 }, ...(coarse ? { hasTouch: true, isMobile: true } : {}) }), light = html.replace(column('dark'), '')
    const read = () => p2.evaluate(() => [...document.querySelectorAll('.vz-chart')].map((c) => { const cs = getComputedStyle(c); return { where: `${c.closest('section[data-c]')?.dataset.c} "${(c.closest('.vz-panel')?.querySelector('.vz-panel-title')?.textContent ?? c.dataset.view ?? '').trim().slice(0, 40)}"`, shown: c.getClientRects().length > 0, reserved: Math.round(parseFloat(cs.minHeight) * 10) / 10, rows: cs.getPropertyValue('--legend-rows').trim(), cv: cs.contentVisibility } }))
    await p2.setContent(light.replace(/<script>[\s\S]*?<\/script>/g, ''), { waitUntil: 'load' }); const markup = await read()
    await p2.setContent(light, { waitUntil: 'load' }); await p2.waitForTimeout(300); const drawnNow = await read()
    const drawn = await p2.evaluate(() => [...document.querySelectorAll('.vz-chart')].map((c) => { c.style.setProperty('content-visibility', 'visible', 'important'); c.style.setProperty('min-height', '0px', 'important'); const h = c.getBoundingClientRect().height; c.style.removeProperty('min-height'); c.style.removeProperty('content-visibility'); return { h: Math.round(h * 10) / 10, rows: c.querySelectorAll('.vz-legend-table tbody tr').length } }))
    await b2.close()
    const at = `${coarse ? 'coarse' : 'fine'} pointer, ${width} px`
    if (markup.length !== drawnNow.length) results.push(`${at}: the previews' scripts add or remove charts (${markup.length} in the markup, ${drawnNow.length} drawn): reservations cannot be compared`)
    else drawnNow.forEach((c, i) => { if (!c.shown) return; const d = drawn[i], m = markup[i]; checked += 3
      if (c.cv !== 'auto') results.push(`${at}: ${c.where} chart computes content-visibility: ${c.cv}: off screen it is restyled on every change of theme (the v8 review's V4)`)
      if (Math.abs(c.reserved - d.h) > 1) results.push(`${at}: ${c.where} chart reserves ${c.reserved} px once drawn and draws ${d.h} px: skipped off screen it is the wrong height, and a page that loads scrolled past it moves (the v8 review's B1)`)
      if (d.rows && !m.rows) results.push(`${at}: ${c.where} chart draws ${d.rows} legend row(s) and its markup sets no --legend-rows: it has no reservation before its script runs (the v8 review's B1)`)
      else if (Math.abs(m.reserved - d.h) > 1) results.push(`${at}: ${c.where} chart reserves ${m.reserved} px in its markup and draws ${d.h} px: the first frame of a load is the wrong height`) })
    console.log(`reserved height, ${at}: ${drawnNow.filter((c) => c.shown).length} chart(s), reserved in the markup / once drawn / drawn: ${drawnNow.map((c, i) => c.shown ? `${markup[i]?.reserved}/${c.reserved}/${drawn[i].h}` : null).filter(Boolean).join(', ')}`)
  }
  const uniq = [...new Set(results)]; checked += 3
  for (const r of uniq) fail('rendered ' + r)
  console.log(`rendered audit: ${names.length} previews, both themes, at rest, hover, press and a finger's press, and reserved heights: ${uniq.length} failure(s)`)
}
const targets = paths.length ? paths.map((p) => resolve(p)) : [compPath]
if (render && targets.some((p) => p === compPath || p === resolve(root, 'src') || p === resolve(root, '.') || p.startsWith(root + 'project'))) await audit()
console.log(`contrast and structure: ${checked - failed}/${checked} checks pass`)

// ---- 4. literal values in other files ----
const files = []
const walk = (p) => { const st = statSync(p); if (st.isDirectory()) { for (const f of readdirSync(p)) if (!['node_modules', 'dist', '.wrangler', 'bundle.css'].includes(f)) walk(join(p, f)) } else if (['.css', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.html'].includes(extname(p))) files.push(p) }
targets.filter((p) => p !== compPath).forEach(walk); files.splice(0, files.length, ...files.filter((f) => f !== compPath))
for (const f of files) {
  const text = readFileSync(f, 'utf8'), ext = extname(f)
  if (ext === '.css') lintCss(text, { file: f, report, tokens: colourTokens, breakpoints: bpOk })
  else if (ext === '.html') lintHtml(text, { file: f, report, tokens: colourTokens, breakpoints: bpOk })
  else lintScript(text, { file: f, report, tokens: colourTokens, test: /\.test\.[a-z]+$/.test(f) }) // test files hold query text such as "rate(x[30s])"; only colours are linted there
}
console.log(`literal values: ${hits} in ${files.length + 1} file(s)`)
process.exit(failed || hits ? 1 : 0)
