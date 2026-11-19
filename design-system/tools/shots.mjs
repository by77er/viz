// Images for design review.
//   node tools/shots.mjs capture <url|file> <outDir> [name]        -> <name>-{light,dark}-{1440,400}.png
//   node tools/shots.mjs compare <beforeDir> <afterDir> <outDir>   -> one labelled side-by-side PNG per image name
//   node tools/shots.mjs scenario <scenario.json> <outDir>         -> one PNG per state and theme, plus measurements
// Capture "before" from the base branch and "after" from the change, with the same data and state.
//
// A scenario file pictures what a plain capture cannot: interaction states, waiting states, a coarse pointer, zoom, greyscale.
//   { "url": "dist/reference.html",            a URL, or a file path relative to where the command is run
//     "name": "reference",                     prefix of the image names
//     "themes": ["light", "dark"],             default both
//     "states": [
//       { "name": "pressed-quiet", "steps": [{ "press": ".vz-button[data-quiet]" }], "clip": ".vz-button[data-quiet]", "pad": 24 },
//       { "name": "waiting-800",   "steps": [{ "click": "#run" }, { "wait": 800 }] },
//       { "name": "coarse-400",    "width": 400, "coarse": true, "measure": true, "outline": true },
//       { "name": "zoom-200",      "zoom": 2 },
//       { "name": "grey",          "greyscale": true } ] }
// Steps, in order: { "hover": sel } { "press": sel } (pointer held down while the image is taken) { "focus": sel } (keyboard focus, so the ring shows)
//   { "click": sel } { "tap": sel } { "type": [sel, text] } { "key": "ArrowRight" } { "wait": ms } { "scroll": [sel, x] } { "eval": "js" }
// State options: width (default 1440), height, scale (default 2; 1 for wide pages), coarse (touch, coarse pointer), zoom (2 = 200%: half the
//   CSS width at twice the scale), greyscale, reducedMotion, clip (selector) with pad, measure (prints sideways overflow, the smallest text,
//   any sans text set in tabular figures, and with a coarse pointer every hit area under 44px; an item partly scrolled out of a scrolling
//   strip is listed separately; a control covered at its centre, a drawn box reached by a neighbour's hit area and every link inside a sentence
//   are reported, never skipped), outline (draws the measured hit areas into the image).
import { readdirSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
const [cmd, a, b, c] = process.argv.slice(2)
const href = (u) => (u.includes('://') ? u : 'file://' + resolve(u))

// Runs in the page. The hit area of a control is what a finger can actually reach: found by asking the page which element is at each
// point, so an area clipped by a scrolling strip or covered by a neighbour's area is measured as it behaves, not as it is declared.
function measurePage(coarse) {
  const out = { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, smallestText: 99, tabularSans: [], small: [], areas: [], scrolled: [], inSentence: [], covered: [], overlaps: [] }
  for (const el of document.querySelectorAll('body *')) { if (el.closest('svg') && el.tagName !== 'text') continue; const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()); if (!own) continue; const r = el.getBoundingClientRect(); if (!r.width || !r.height || r.width <= 1) continue; const cs = getComputedStyle(el), fs = parseFloat(cs.fontSize); if (fs < out.smallestText) out.smallestText = fs
    if (/tabular-nums/.test(cs.fontVariantNumeric) && /Schibsted/.test(cs.fontFamily.split(',')[0])) out.tabularSans.push(el.textContent.trim().slice(0, 30)) } // the sans widens punctuation when tabular (system-v2 N1)
  if (!coarse) return out
  const sel = 'a[href], button, input, select, textarea, summary, [role^="menuitem"], [role="tab"], label.vz-check, [tabindex="0"]'
  const owner = (x, y) => { const e = document.elementFromPoint(x, y); return e && e.closest(sel) }
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.value || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40)
  for (const el of document.querySelectorAll(sel)) {
    if (el.disabled || el.closest('[aria-busy="true"]')) continue
    if (el.matches('input[type="checkbox"]') && el.closest('label')) continue // measured as its label
    const r = el.getBoundingClientRect(); if (r.width <= 1 || r.height <= 1 || r.bottom < 0 || r.top > innerHeight) continue // a visually hidden control (skip link at rest)
    // a link inside a sentence is text and exempt from 44px; it is measured and listed, because the main path must never be one
    if (el.matches('a') && el.closest('p')) { out.inSentence.push({ name: name(el), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }); continue }
    // an item partly scrolled out of a scrolling strip (nav, tabs, a wide table) is reachable by scrolling; it is listed, not measured
    let strip = el.parentElement; while (strip && strip !== document.body && !/(auto|scroll)/.test(getComputedStyle(strip).overflowX)) strip = strip.parentElement
    if (strip && strip !== document.body) { const s = strip.getBoundingClientRect(); if (r.left < s.left - 0.5 || r.right > s.right + 0.5) { out.scrolled.push(name(el).slice(0, 30)); continue } }
    const cx = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), cy = r.top + r.height / 2, at = owner(cx, cy)
    if (at !== el) { out.covered.push({ name: name(el), by: at ? name(at) : 'nothing it owns' }); continue } // covered at its centre: the worst overlap, reported
    // its drawn box, sampled: a neighbour's hit area reaching into it takes those taps
    for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.15, 0.5, 0.85]) { const o = owner(r.left + r.width * fx, r.top + r.height * fy); if (o && o !== el && !el.contains(o) && !o.contains(el)) { out.overlaps.push({ name: name(el), by: name(o) }); break } }
    let top = cy, bottom = cy, left = cx, right = cx
    const q = 0.25 // quarter-pixel steps, so an area of exactly 44px is not reported as 43
    while (top > cy - 60 && owner(cx, top - q) === el) top -= q
    while (bottom < cy + 60 && owner(cx, bottom + q) === el) bottom += q
    while (left > cx - 240 && owner(left - q, cy) === el) left -= q // wide enough that the outline shows the real width of a long link
    while (right < cx + 240 && owner(right + q, cy) === el) right += q
    const area = { name: name(el), tag: el.tagName.toLowerCase(), w: +(right - left + q).toFixed(1), h: +(bottom - top + q).toFixed(1), x: left, y: top }
    out.areas.push(area); if (area.h < 44 || area.w < 44) out.small.push(area)
  }
  out.overlaps = out.overlaps.filter((o, i, a) => a.findIndex((x) => x.name === o.name && x.by === o.by) === i)
  return out
}

async function runState(browser, sc, state, theme, outDir) {
  const zoom = state.zoom ?? 1, width = Math.round((state.width ?? 1440) / zoom), scale = (state.scale ?? 2) * zoom
  const ctx = await browser.newContext({ viewport: { width, height: state.height ?? 900 }, deviceScaleFactor: scale, colorScheme: theme, reducedMotion: state.reducedMotion ? 'reduce' : 'no-preference', ...(state.coarse ? { hasTouch: true, isMobile: true } : {}) })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`  page error: ${e.message}`))
  await page.goto(href(state.url ?? sc.url), { waitUntil: 'load' })
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
  await page.evaluate(() => document.fonts.ready)
  // A full-page capture resets device emulation and with it the coarse pointer, so the viewport is made as tall as the page instead.
  if (!state.height) { const h = await page.evaluate(() => document.documentElement.scrollHeight); await page.setViewportSize({ width, height: Math.min(Math.max(h, 300), 16000) }) }
  await page.waitForTimeout(100)
  let held = false
  for (const step of state.steps ?? []) {
    const [kind, arg] = Object.entries(step)[0]
    if (kind === 'hover') await page.hover(arg)
    else if (kind === 'press') { await page.hover(arg); await page.mouse.down(); held = true }
    else if (kind === 'focus') { await page.focus(arg); await page.keyboard.press('Shift'); await page.evaluate((s) => { const e = document.querySelector(s); e.blur(); e.focus({ focusVisible: true }) }, arg) }
    else if (kind === 'click') await page.click(arg)
    else if (kind === 'tap') await page.tap(arg)
    else if (kind === 'type') await page.type(arg[0], arg[1])
    else if (kind === 'key') await page.keyboard.press(arg)
    else if (kind === 'wait') await page.waitForTimeout(arg)
    else if (kind === 'scroll') await page.evaluate(([s, x]) => { document.querySelector(s).scrollLeft = x }, arg)
    else if (kind === 'eval') await page.evaluate(arg)
    else throw new Error('unknown step ' + kind)
  }
  if (state.greyscale) await page.addStyleTag({ content: 'html{filter:grayscale(1)}' })
  const tag = `${sc.name ?? 'view'}-${state.name}-${theme}`
  if (state.measure) {
    const m = await page.evaluate(measurePage, !!state.coarse)
    console.log(`${tag}: sideways overflow ${m.overflow}px; smallest text ${m.smallestText}px; tabular sans ${m.tabularSans.length}` + (state.coarse ? `; ${m.areas.length} hit areas, ${m.small.length} under 44px, ${m.covered.length} covered, ${m.overlaps.length} drawn boxes reached by a neighbour, ${m.inSentence.length} links inside sentences` + (m.scrolled.length ? `; ${m.scrolled.length} partly scrolled out of a strip (${m.scrolled.join(', ')})` : '') : ''))
    for (const t of m.tabularSans) console.log(`  TABULAR SANS  ${t}`)
    for (const s of m.small) console.log(`  SMALL ${s.w}x${s.h}  <${s.tag}> ${s.name}`)
    for (const c of m.covered) console.log(`  COVERED  ${c.name}  (its centre belongs to ${c.by})`)
    for (const o of m.overlaps) console.log(`  OVERLAP  ${o.name}  (part of its drawn box belongs to ${o.by})`)
    for (const l of m.inSentence) console.log(`  IN SENTENCE ${l.w}x${l.h}  ${l.name}  (text, exempt; never the main path)`)
    if (state.outline) await page.evaluate((areas) => { for (const r of areas) { const d = document.createElement('div'); d.style.cssText = `position:absolute;left:${r.x + scrollX}px;top:${r.y + scrollY}px;width:${r.w}px;height:${r.h}px;outline:1px solid ${r.h < 44 || r.w < 44 ? 'red' : 'rgba(0,120,255,.7)'};pointer-events:none;z-index:99999`; document.body.appendChild(d) } }, m.areas) // token-lint-ignore: review overlay, not product
  }
  let clip
  if (state.clip) { const box = await page.locator(state.clip).first().boundingBox(); const pad = state.pad ?? 16; clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad } }
  await page.screenshot({ path: join(outDir, tag + '.png'), ...(clip ? { clip } : {}) })
  if (held) await page.mouse.up()
  await ctx.close()
}

const browser = await chromium.launch()
if (cmd === 'capture') {
  mkdirSync(b, { recursive: true })
  for (const theme of ['light', 'dark']) for (const width of [1440, 400]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: theme })
    await page.goto(href(a), { waitUntil: 'networkidle' })
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await page.evaluate(() => document.fonts.ready)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if (overflow > 0) console.log(`WARN ${theme} ${width}: page scrolls sideways by ${overflow}px`)
    await page.screenshot({ path: join(b, `${c ?? 'view'}-${theme}-${width}.png`), fullPage: true })
    await page.close()
  }
} else if (cmd === 'scenario') {
  const sc = JSON.parse(readFileSync(a, 'utf8')); mkdirSync(b, { recursive: true })
  for (const state of sc.states) for (const theme of state.themes ?? sc.themes ?? ['light', 'dark']) await runState(browser, sc, state, theme, b)
} else if (cmd === 'compare') {
  mkdirSync(c, { recursive: true })
  const uri = (p) => 'data:image/png;base64,' + readFileSync(p).toString('base64')
  for (const f of readdirSync(b).filter((x) => x.endsWith('.png'))) {
    let before
    try { before = uri(join(a, f)) } catch { before = null }
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
    await page.setContent(`<body style="margin:0;padding:24px;background:#fff;font:14px Georgia,serif;color:#111"><div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start">
      <div><div style="margin-bottom:8px">Before · ${f}</div>${before ? `<img src="${before}" style="width:100%;border:1px solid #e4e4e4">` : '<div style="padding:48px;border:1px solid #e4e4e4">New view: nothing to compare.</div>'}</div>
      <div><div style="margin-bottom:8px">After · ${f}</div><img src="${uri(join(b, f))}" style="width:100%;border:1px solid #e4e4e4"></div></div></body>`)
    await page.screenshot({ path: join(c, f), fullPage: true })
    await page.close()
  }
} else console.log('usage: shots.mjs capture <url> <outDir> [name] | compare <beforeDir> <afterDir> <outDir> | scenario <scenario.json> <outDir>')
await browser.close()
