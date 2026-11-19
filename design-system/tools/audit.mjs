// The rendered page audit: what only shows when a page is laid out, at every width a person uses.
//   node tools/audit.mjs [--root <copy of design-system>] [--quick] [--json out.json] [page.html …]
// Pages (default): every component preview as a page of its own (dist/preview/, built by tools/reference.mjs), dist/reference.html,
// dist/fixture/index.html, the latest review's compositions (reviews/system-v6/compositions/), and, read only and reported apart, the flow
// screens (flows/dist/). Configurations: a fine pointer at 320, 400, 560, 640, 800, 1024, 1280 and 1500 px; a coarse pointer with touch at
// 320, 400 and 768 px; 200% zoom of 1280, 1440 and 1500 px windows (640, 720 and 750 CSS px at twice the scale). --quick: 320, 400 coarse,
// 720 at 200% and 1500.
// Each page in each configuration fails on:
//   overflow      the page scrolls sideways (the elements that stick out are named);
//   escape        something absolutely placed inside a scrolling or clipping box whose containing block is outside it, so the box cannot
//                 clip it and it widens the page (v5's hidden "Actions" head);
//   cell          a table head or cell outside its own table's box;
//   fold-scroll   a folding table (data-fold) that scrolls sideways: a fold table folds instead (data-fold="wide" when its columns need it);
//   cut           a word cut by the edge of a box that clips it, or out of view, or outside its own table cell (lying over the next one),
//                 outside a strip that scrolls on purpose (a wide table in its scroll form, the navigation, tabs) and outside text cut on
//                 purpose with an ellipsis (vz-cut, a legend name);
//   tiny          text below micro (11 px);
//   sentence-link with a coarse pointer, a link inside running text drawn as a 44 px control (it breaks its line), or a link standing alone
//                 whose hit area is under 44 px. A link is inside a sentence when its block holds other words; standing alone otherwise.
//   overlap       a word whose centre, hit-tested with the page scrolled to it, belongs to another element (drawn over a neighbour, or a
//                 neighbour drawn over it), a control's hit area over another control's words, or two words of different elements
//                 drawn over each other (v6 review, B1: pod names drawn over the CPU figures);
//   key-width     a key in a folded table narrower than key-min of its row (v6 review, B1: 87 px of a 368 px row);
//   stale         dist/ not what the build makes of the tree: dist/viz.css, and the fixture page's inlined CSS (v6 review, m6).
// And, on the compositions at 1500 px:
//   figure        an element marked data-figure="<chart id>|<series label value>|last|min|max" that does not show what that chart's model
//                 holds for that series, or elements marked data-same="<name>" that show different numbers;
//   caption       a table caption "N of M …" or "N …" whose N is not the number of rows under it, or whose stated order ("most recently
//                 changed first", "slowest first", "highest … first") the rows do not follow;
//   age           an age beyond a day written as "N d ago", or "0 s ago", in a table cell (Words: the absolute time beyond a day).
// Exit status 1 if any page outside flows/ fails. Flow screens are reported, never edited.
import { readdirSync, existsSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve, relative, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
const args = process.argv.slice(2), opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const root = resolve(opt('--root') ?? new URL('..', import.meta.url).pathname), quick = args.includes('--quick')
const explicit = args.filter((a, i) => a.endsWith('.html') && args[i - 1] !== '--json')
const list = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.html')).sort().map((f) => join(dir, f)) : [])
const reviews = readdirSync(join(root, 'reviews')).filter((d) => /^system-v\d+$/.test(d)).sort((a, b) => +a.slice(8) - +b.slice(8))
const latest = reviews.reverse().find((d) => existsSync(join(root, 'reviews', d, 'compositions')))
const pages = explicit.length ? explicit.map((p) => resolve(p)) : [...list(join(root, 'dist/preview')), join(root, 'dist/reference.html'), join(root, 'dist/fixture/index.html'), ...(latest ? list(join(root, 'reviews', latest, 'compositions')) : []), ...list(join(root, 'flows/dist'))].filter(existsSync)
// stale: dist/ is what the build makes of the tree, or every page below is measured on something else (v6 review, m6: the fixture page
// inlined CSS older than dist/viz.css). Checked first, by content: no file date can say it.
const stale = []
{ const { buildCss } = await import(pathToFileURL(join(root, 'tools/css.mjs')).href), viz = buildCss(root + '/').viz, read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null)
  const chart = read('project/components/Chart/preview.html')?.match(/<script>([\s\S]*?)<\/script>/)?.[1], press = read('src/press.js')
  if (read('dist/viz.css') !== viz) stale.push('dist/viz.css is not what tools/build.mjs makes of tokens.json and src/components.css: run npm run build')
  if (chart && !read('dist/viz-chart.js')?.endsWith(chart)) stale.push('dist/viz-chart.js is not the Chart preview\'s script: run npm run build')
  if (press && !read('dist/viz-press.js')?.endsWith(press)) stale.push('dist/viz-press.js is not src/press.js: run npm run build')
  const fx = read('dist/fixture/index.html'); if (fx && (!fx.includes(viz.replace(/url\("fonts\//g, 'url("../fonts/')) || (chart && !fx.includes(chart)))) stale.push('dist/fixture/index.html inlines CSS or a chart older than the tree (v6 review, m6): run npm run build')
  const ref = read('dist/reference.html'); if (ref && !ref.includes(viz)) stale.push('dist/reference.html inlines CSS older than the tree: run npm run build') }
const perturbed = await (async () => { const { tokenCss } = await import(pathToFileURL(join(root, 'tools/css.mjs')).href); return perturbedCss(tokenCss, JSON.parse(readFileSync(join(root, 'project/tokens.json'), 'utf8'))) })()
const configs = quick
  ? [{ w: 320, coarse: true }, { w: 400, coarse: true }, { w: 720, zoom: 2 }, { w: 1500 }]
  : [...[320, 400, 560, 640, 800, 1024, 1280, 1500].map((w) => ({ w })), ...[320, 400, 768].map((w) => ({ w, coarse: true })), ...[640, 720, 750].map((w) => ({ w, zoom: 2 }))]
const label = (c) => `${c.w}${c.coarse ? ' coarse' : ''}${c.zoom ? ' at 200%' : ''}`

// ---- runs in the page ----
function audit({ coarse, words }) {
  const out = [], vw = document.documentElement.clientWidth, cs = (e) => getComputedStyle(e)
  const name = (e) => { if (!e || e.nodeType !== 1) return String(e); const t = (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32); return `<${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : ''}>${t ? ' "' + t + '"' : ''}` }
  const shown = (e) => { for (let x = e; x && x.nodeType === 1; x = x.parentElement) { const s = cs(x); if (s.display === 'none' || s.visibility === 'hidden' && x === e) return false } return e.getClientRects().length > 0 && (!e.checkVisibility || e.checkVisibility()) } // checkVisibility: not inside a closed <details> (content-visibility: hidden)
  const hiddenText = (e) => e.closest('.vz-sr, .vz-skip:not(:focus), [hidden], [aria-hidden="true"]:not(svg), dialog:not([open]), template, script, style, title')
  const clips = (e) => { const s = cs(e); return s.overflowX !== 'visible' || s.overflowY !== 'visible' }
  const scrolls = (e) => /(auto|scroll)/.test(cs(e).overflowX)
  const foldTable = (e) => e.closest('table[data-fold]') && cs(e.closest('table[data-fold]')).display === 'block' // folded now
  const isCB = (e) => { const s = cs(e); return s.position !== 'static' || s.transform !== 'none' || s.filter !== 'none' || /layout|paint|strict|content/.test(s.contain) || s.willChange.includes('transform') }
  // overflow
  const over = document.documentElement.scrollWidth - vw
  // what sticks out: the outermost elements past the window's right edge that no box of theirs clips
  if (over > 0) { const culprits = []; for (const e of document.body.querySelectorAll('*')) { if (!shown(e)) continue; const r = e.getBoundingClientRect(), p = e.parentElement?.getBoundingClientRect(); if (!(r.right > vw + 0.5 && r.width > 0 && (!p || p.right <= vw + 0.5))) continue
      let c = e.parentElement, held = false; while (c && c !== document.body) { if (clips(c) && c.getBoundingClientRect().right <= vw + 0.5) { held = true; break } c = c.parentElement } if (!held) culprits.push(name(e)); if (culprits.length > 3) break }
    out.push(['overflow', `page scrolls sideways by ${over} px: ${culprits.join(', ') || 'nothing unclipped found past the edge'}`]) }
  // escapes: absolutely placed inside a clipping box, with its containing block outside that box
  for (const e of document.body.querySelectorAll('*')) { const s = cs(e); if (s.position !== 'absolute' || !e.getClientRects().length) continue
    let clip = null; for (let x = e.parentElement; x && x !== document.body; x = x.parentElement) if (clips(x)) { clip = x; break }
    if (!clip) continue
    let cb = null; for (let x = e.parentElement; x && x !== document.documentElement; x = x.parentElement) if (isCB(x)) { cb = x; break }
    if (!cb || (cb !== clip && cb.contains(clip))) out.push(['escape', `${name(e)} is placed absolutely inside ${name(clip)}, which clips or scrolls, but its containing block is ${cb ? name(cb) : 'the page'}: the clip does not hold it`]) }
  // table heads and cells inside their table; fold tables never scroll
  for (const t of document.querySelectorAll('table')) { if (!shown(t)) continue; const tr = t.getBoundingClientRect()
    for (const c of t.querySelectorAll('th, td')) { if (!shown(c)) continue; const r = c.getBoundingClientRect(); if (r.width && (r.left < tr.left - 1 || r.right > tr.right + 1)) { out.push(['cell', `${name(c)} lies outside its table (${Math.round(r.left - tr.left)} to ${Math.round(r.right - tr.left)} of ${Math.round(tr.width)} px)`]); break } }
    const wrap = t.closest('.vz-table-wrap'); if (t.matches('[data-fold]') && wrap && wrap.scrollWidth > wrap.clientWidth + 1) out.push(['fold-scroll', `${name(t)} folds (data-fold${t.dataset.fold ? '="' + t.dataset.fold + '"' : ''}) but scrolls ${wrap.scrollWidth - wrap.clientWidth} px sideways at this width`]) }
  // cut words and words out of view
  if (words) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), range = document.createRange(); let n, reported = 0
    while ((n = walker.nextNode()) && reported < 6) {
      const el = n.parentElement; if (!el || !n.textContent.trim() || hiddenText(el) || !shown(el)) continue
      // the box that clips this text, and whether the text is cut on purpose or reachable by scrolling
      let purposely = false, clipBoxes = [], cellOf = null
      for (let x = el; x && x !== document.documentElement; x = x.parentElement) { const s = cs(x)
        if (s.textOverflow === 'ellipsis' || x.matches('.vz-cut > :first-child, .vz-readout')) { purposely = true; break } // cut with an ellipsis, or a readout fitted by measuring
        if (clips(x) && x !== document.body) { if (scrolls(x) && !foldTable(el) && x.scrollWidth > x.clientWidth + 1) { purposely = true; break } clipBoxes.push(x) }
        else if (/^(TD|TH)$/.test(x.tagName) && !cellOf) cellOf = x } // a cell does not clip, but a word outside it lies over its neighbour
      if (purposely) continue
      if (cellOf) clipBoxes.push(cellOf)
      if (purposely) continue
      let L = 0, R = vw; for (const x of clipBoxes) { const r = x.getBoundingClientRect(), bl = parseFloat(cs(x).borderLeftWidth) || 0; L = Math.max(L, r.left + bl); R = Math.min(R, r.left + bl + x.clientWidth) }
      const text = n.textContent; const re = /\S+/g; let m
      while ((m = re.exec(text))) { range.setStart(n, m.index); range.setEnd(n, m.index + m[0].length)
        for (const r of range.getClientRects()) { if (!r.width) continue
          if (r.right > R + 0.75 || r.left < L - 0.75) { const inCell = cellOf && (r.right > cellOf.getBoundingClientRect().right + 0.75 || r.left < cellOf.getBoundingClientRect().left - 0.75); out.push(['cut', `"${m[0]}" in ${name(el)} is ${inCell ? 'outside its cell, over its neighbour' : r.left >= R || r.right <= L ? 'out of view' : 'cut'} (${Math.round(r.left)} to ${Math.round(r.right)}, visible ${Math.round(L)} to ${Math.round(R)})`]); reported++; break } }
        if (reported >= 6) break }
    }
  }
  // overlap (v6 review, B1): no element's box lies over another's words. Every visible word, clipped to the boxes that clip it, is
  // hit-tested at its centre (the page scrolled so the word is in view): the element found there must be the word's own (or one that
  // holds it, or one it holds). Found anything else, the word is drawn over that element (a name run out of its cell over the figures)
  // or under it (a cell drawn over the name): either way it cannot be read there, and a tap there goes elsewhere. A hit area with
  // nothing drawn (a control's ::after) that reaches over another control's words is reported too; over plain words it is not (a tap
  // there still reaches a control, and a 44 px target may lie over a label). Overlays (open menus, dialogs, floating notices, tooltips,
  // a waiting line over its region's strip) lie over the page by design; while a modal dialog is open only its own words are checked. And, independent of hit testing (words
  // that take no pointer events), two words of different elements whose boxes overlap by more than a third of the smaller.
  if (words) {
    const modal = document.querySelector('dialog:modal') ?? [...document.querySelectorAll('.vz-scrim')].find((x) => x.getClientRects().length && cs(x).visibility === 'visible')
    const overlay = (e) => e?.closest?.('.vz-menu, .vz-dialog, .vz-notice[data-floating], .vz-tooltip, dialog, .vz-panel .vz-progress') // a waiting line lies over its region's strip of words by design (Panel)
    const control = (e) => e?.closest?.('a[href], button, input, select, textarea, summary, [role^="menuitem"], [role="tab"], label')
    const clipOf = new Map(), clipBox = (el) => { if (clipOf.has(el)) return clipOf.get(el); let b
      const p = el.parentElement && el !== document.body ? clipBox(el.parentElement) : [-Infinity, -Infinity, Infinity, Infinity]
      if (el !== document.body && el !== document.documentElement && clips(el)) { const r = el.getBoundingClientRect(), s = cs(el), l = r.left + (parseFloat(s.borderLeftWidth) || 0), t = r.top + (parseFloat(s.borderTopWidth) || 0); b = [Math.max(p[0], l + scrollX), Math.max(p[1], t + scrollY), Math.min(p[2], l + scrollX + el.clientWidth), Math.min(p[3], t + scrollY + el.clientHeight)] } else b = p
      clipOf.set(el, b); return b }
    const fixedOf = (el) => { for (let x = el; x && x !== document.documentElement; x = x.parentElement) if (cs(x).position === 'fixed') return true; return false }
    const list = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), range = document.createRange(); let n
    while ((n = walker.nextNode())) { const el = n.parentElement; if (!el || !n.textContent.trim() || hiddenText(el) || !shown(el) || (modal && !modal.contains(el))) continue
      const c = clipBox(el), fixed = fixedOf(el), re = /\S+/g; let m
      while ((m = re.exec(n.textContent))) { range.setStart(n, m.index); range.setEnd(n, m.index + m[0].length)
        for (const r of range.getClientRects()) { const x0 = Math.max(r.left + scrollX, c[0]), y0 = Math.max(r.top + scrollY, c[1]), x1 = Math.min(r.right + scrollX, c[2]), y1 = Math.min(r.bottom + scrollY, c[3]); if (x1 - x0 < 2 || y1 - y0 < 2) continue
          list.push({ el, word: m[0], x0, y0, x1, y1, fixed }) } } }
    const found = new Set(), say = (k, msg) => { if (!found.has(k) && found.size < 8) { found.add(k); out.push(['overlap', msg]) } }
    const vh = innerHeight, H = document.documentElement.scrollHeight, x0 = scrollX, y0 = scrollY
    for (let top = 0; top < H; top += Math.max(100, vh - 60)) { scrollTo(x0, top)
      for (const w of list) { if (w.done || (w.fixed && top > 0)) continue; const cx = (w.x0 + w.x1) / 2 - (w.fixed ? 0 : scrollX), cy = (w.y0 + w.y1) / 2 - (w.fixed ? 0 : scrollY); if (cy < 1 || cy > vh - 1 || cx < 0 || cx >= vw) continue
        w.done = true; const hit = document.elementFromPoint(cx, cy), el = w.el
        if (!hit || hit === el || el.contains(hit) || hit.contains(el) || (hit.closest('svg') && hit.closest('svg') === el.closest('svg'))) continue
        if (overlay(hit) && overlay(hit) !== overlay(el)) continue
        const hb = hit.getBoundingClientRect(), drawn = cx >= hb.left && cx <= hb.right && cy >= hb.top && cy <= hb.bottom
        if (drawn) say(name(el) + '|' + name(hit), `"${w.word}" in ${name(el)} lies under or over ${name(hit)} at ${Math.round(cx)}, ${Math.round(cy + scrollY)}: one is drawn over the other's words`)
        else if (control(el) && control(el) !== control(hit)) say(name(el) + '|' + name(hit), `"${w.word}" in ${name(control(el))} is under the hit area of ${name(control(hit))}: a tap on it goes to the other control`) } }
    scrollTo(x0, y0)
    // the same words, by their boxes: a grid of 64 px cells, each word against the words of other elements in its cells
    const grid = new Map(), cell = (x, y) => Math.floor(x / 64) + ':' + Math.floor(y / 64)
    for (const w of list) for (let gx = Math.floor(w.x0 / 64); gx <= Math.floor(w.x1 / 64); gx++) for (let gy = Math.floor(w.y0 / 64); gy <= Math.floor(w.y1 / 64); gy++) { const k = gx + ':' + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(w) }
    for (const ws of grid.values()) for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) { const a = ws[i], b = ws[j]; if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el) || a.fixed !== b.fixed) continue
      if ((overlay(a.el) || overlay(b.el)) && overlay(a.el) !== overlay(b.el)) continue
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0); if (ox <= 2 || oy <= 0) continue
      const area = ox * oy, least = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0)); if (area > least / 3) say(name(a.el) + '|' + name(b.el), `"${a.word}" in ${name(a.el)} and "${b.word}" in ${name(b.el)} are drawn over each other (${Math.round(ox)} x ${Math.round(oy)} px)`) }
  }
  // key width (v6 review, B1): in a folded table, every key is at least key-min of its row (the whole row when it has its line to
  // itself), so a name keeps a readable, tappable width at every width, zoom and pointer
  for (const t of document.querySelectorAll('table[data-fold]')) { if (!shown(t) || cs(t).display !== 'block') continue
    const min = parseFloat(cs(t).getPropertyValue('--key-min')) / 100 || 0.5
    for (const td of t.querySelectorAll('tbody td[data-key]')) { if (!shown(td)) continue; const row = td.parentElement.getBoundingClientRect(), w = td.getBoundingClientRect().width
      if (w < min * row.width - 1) { out.push(['key-width', `${name(td)} is ${Math.round(w)} px of a ${Math.round(row.width)} px row, under key-min (${Math.round(min * 100)}%): the name is squeezed by the kept columns or the actions`]); break } } }
  // text size
  let small = 99, where = ''; for (const e of document.body.querySelectorAll('*')) { if (hiddenText(e) || ![...e.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim()) || !shown(e)) continue; const f = parseFloat(cs(e).fontSize); if (f < small) { small = f; where = name(e) } }
  if (small < 11) out.push(['tiny', `text at ${small} px: ${where}`])
  // links in sentences and links that stand alone, with a coarse pointer
  if (coarse) for (const a of document.querySelectorAll('a[href]')) { if (!shown(a) || hiddenText(a) || a.closest('[inert], .vz-nav')) continue
    // inside a sentence: other words share the link's inline flow (its nearest ancestor that is not inline is a block container, not a flex
    // or grid row of items, and holds words outside the link and outside other controls)
    let block = a.parentElement; while (block && /^(inline|contents)$/.test(cs(block).display)) block = block.parentElement
    const flow = (x) => { let b = x.parentElement; while (b && /^(inline|contents)$/.test(cs(b).display)) b = b.parentElement; return b }
    let other = false; if (block && !/flex|grid/.test(cs(block).display)) { const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT); let t
      while ((t = w.nextNode())) { if (!t.textContent.trim() || a.contains(t) || t.parentElement.closest('a, button, input, select, textarea, .vz-sr') || flow(t) !== block) continue; other = true; break } }
    const rects = [...a.getClientRects()], tallest = Math.max(...rects.map((r) => r.height)), lh = parseFloat(cs(block ?? a).lineHeight) || 20
    if (other && tallest > lh + 6) out.push(['sentence-link', `${name(a)} is inside a sentence in ${name(block)} but drawn ${Math.round(tallest)} px tall: it breaks its line`])
    if (!other && !a.closest('td[data-key]')) { a.scrollIntoView({ block: 'center', inline: 'nearest' }); const r = a.getClientRects()[0], cx = r.left + r.width / 2, cy = r.top + r.height / 2; if (cy < 0 || cy > innerHeight || cx < 0 || cx > vw) continue // measured in view: outside the viewport nothing is hit
      const own = (y) => { const e = document.elementFromPoint(cx, y); return e && (e === a || a.contains(e)) }; let top = cy, bottom = cy; while (top > cy - 40 && own(top - 0.5)) top -= 0.5; while (bottom < cy + 40 && own(bottom + 0.5)) bottom += 0.5
      if (bottom - top + 0.5 < 44 && own(cy)) out.push(['sentence-link', `${name(a)} stands alone in ${name(block)} but its hit area is ${bottom - top + 0.5} px tall`]) } }
  return out
}
// ---- compositions: figures, captions, ages (1500 px) ----
function words() {
  const out = [], num = (s) => { const m = String(s).replace(/−/g, '-').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return m ? +m[0] : NaN }
  const dec = (s) => { const m = String(s).replace(/,/g, '').match(/\d+(?:\.(\d+))?/); return m && m[1] ? m[1].length : 0 }
  const agree = (a, b) => { const d = Math.min(dec(a), dec(b)); return Math.abs(num(a) - num(b)) <= 0.5 * 10 ** -d + 1e-9 }
  for (const e of document.querySelectorAll('[data-figure]')) { const [chartId, who, stat] = e.dataset.figure.split('|'), chart = document.getElementById(chartId)
    const f = chart?.vz?.figures?.(); if (!f) { out.push(['figure', `data-figure="${e.dataset.figure}": no chart #${chartId} with figures`]); continue }
    const s = f.find((x) => x.names.includes(who)); if (!s) { out.push(['figure', `data-figure="${e.dataset.figure}": chart #${chartId} draws no series "${who}"`]); continue }
    if (!agree(e.textContent, s[stat])) out.push(['figure', `"${e.textContent.trim()}" (${who}, ${stat}) disagrees with chart #${chartId}, which shows ${s[stat]}`]) }
  const same = {}; for (const e of document.querySelectorAll('[data-same]')) (same[e.dataset.same] ??= []).push(e.textContent.trim())
  for (const [k, v] of Object.entries(same)) if (v.some((x) => !agree(x, v[0]))) out.push(['figure', `figures marked "${k}" disagree: ${v.join(' / ')}`])
  const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }
  const when = (t) => { let m; if (/just now/.test(t)) return 0; if ((m = t.match(/(\d+) s ago/))) return +m[1]; if ((m = t.match(/(\d+) min ago/))) return 60 * m[1]; if ((m = t.match(/(\d+) h ago/))) return 3600 * m[1]; if ((m = t.match(/(\d+) d ago/))) return 86400 * m[1]; if ((m = t.match(/(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec),? (\d\d):(\d\d)/))) return (Date.UTC(2026, 10, 18, 15, 16) - Date.UTC(2026, MON[m[2]], +m[1], +m[3], +m[4])) / 1000; return NaN }
  for (const cap of document.querySelectorAll('.vz-table-caption')) { const text = cap.textContent.replace(/\s+/g, ' ').trim(), table = cap.parentElement.querySelector('table'); if (!table || table.closest('.vz-chart')) continue
    const rows = [...table.tBodies].flatMap((b) => [...b.rows]).filter((r) => !r.hidden), m = text.match(/^(\d+)(?: of ([\d,]+))? /)
    if (m && +m[1] !== rows.length) out.push(['caption', `"${text}" over ${rows.length} rows`])
    const heads = [...table.querySelectorAll('thead th')].map((h) => h.textContent.trim()), col = (re) => heads.findIndex((h) => re.test(h)), cells = (i) => rows.map((r) => r.cells[i]?.textContent.trim() ?? '')
    const desc = (vals, what) => { for (let i = 1; i < vals.length; i++) if (!(vals[i] <= vals[i - 1])) { out.push(['caption', `"${text}", but row ${i + 1} (${what[i]}) comes after ${what[i - 1]}`]); return } }
    if (/most recently \w+ first|newest first/.test(text)) { const i = col(/^(Changed|Updated|Created|Last used|Time)/); if (i >= 0) { const v = cells(i); desc(v.map((x) => -when(x)), v) } }
    let k; if ((k = text.match(/highest (\w+) first/)) || /slowest first/.test(text)) { const i = k ? col(new RegExp(k[1], 'i')) : col(/p99|duration|took/i); if (i >= 0) { const v = cells(i); desc(v.map(num), v) } }
  }
  for (const td of document.querySelectorAll('td')) { const t = td.textContent.replace(/\s+/g, ' '); if (/\b\d+ d ago\b/.test(t)) out.push(['age', `"${t.trim()}": an age beyond a day is a date and time ("17 Nov, 09:30")`]); if (/\b0 s ago\b/.test(t)) out.push(['age', `"${t.trim()}"`]) }
  return out
}

// ---- guards: each fix the reviews asked for, checked by what it does when rendered, so a later rule that overrides it fails whatever its
// spelling (v6 review, M1: seven overrides passed the presence checks). Run at 1500 px with a fine pointer and at 400 px with a coarse one.
function guards({ fine, coarse }) {
  const out = [], cs = (e) => getComputedStyle(e), modal = document.querySelector('dialog:modal')
  const name = (e) => { const t = (e.getAttribute?.('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32); return `<${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : ''}>${t ? ' "' + t + '"' : ''}` }
  const rgb = (v) => { v = String(v).trim(); if (!v.startsWith('#')) return v.replace(/\s*,\s*/g, ', '); let h = v.slice(1); if (h.length === 3) h = [...h].map((c) => c + c).join(''); return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})` }
  const tok = (el, t) => cs(el).getPropertyValue('--' + t).trim(), px = (el, t) => parseFloat(tok(el, t))
  const visible = (e) => e.getClientRects().length > 0 && (!e.checkVisibility || e.checkVisibility()) && cs(e).visibility === 'visible'
  const say = (kind, msg) => { if (out.filter((x) => x[0] === kind).length < 6) out.push([kind, msg]) }
  // the table wrap is positioned, so what is absolutely placed inside is clipped by its scroll (v5 review, B2.1; mutant Y12)
  for (const w of document.querySelectorAll('.vz-table-wrap')) if (cs(w).position === 'static') say('guard', `${name(w)} is position: static as rendered: a visually hidden head inside it escapes its scroll and widens the page (v5 review, B2.1)`)
  if (fine) {
    // the focus ring, as drawn on focus: stroke wide in focus, offset by stroke (a hairline in a segmented control, inside a tab strip),
    // or, for a legend row and a waterfall span, drawn by the row's cells (v4 and v5 reviews; mutant Y10)
    for (const el of document.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex="0"]')) {
      if (el.disabled || el.closest('[inert], [hidden]') || (modal && !modal.contains(el)) || !visible(el) || !el.closest('.vz')) continue
      el.focus({ focusVisible: true }); if (document.activeElement !== el || !el.matches(':focus-visible')) continue
      const s = cs(el), focus = rgb(tok(el, 'focus')), stroke = px(el, 'stroke'), hair = px(el, 'hairline')
      if (el.matches('.vz-series, .vz-waterfall-span')) { const td = el.closest('tr')?.querySelector('td'); if (!td || !cs(td).boxShadow.includes(focus)) say('focus', `${name(el)} focused: its row's cells draw no ring in focus (${td ? cs(td).boxShadow : 'no cell'})`) }
      else if (s.outlineStyle === 'none' || Math.abs(parseFloat(s.outlineWidth) - stroke) > 0.01 || s.outlineColor !== focus || ![stroke, hair, -stroke].some((o) => Math.abs(parseFloat(s.outlineOffset) - o) < 0.01)) say('focus', `${name(el)} focused draws outline ${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} offset ${s.outlineOffset}, not the ring (${stroke}px solid ${focus}, offset ${stroke}px)`)
    }
    document.activeElement?.blur?.()
    // dashed slots: a swatch of slots 5 to 8 is two dashes in the series colour on no fill (v4 review M1; mutant Y13)
    for (const sw of document.querySelectorAll('.vz-swatch[data-series="5"], .vz-swatch[data-series="6"], .vz-swatch[data-series="7"], .vz-swatch[data-series="8"], .vz-swatch[data-pattern="dash"]')) {
      if (!visible(sw) || sw.matches('[data-off]') || sw.closest('[data-error]')) continue
      const s = cs(sw), series = rgb(tok(sw, 'series')), ok = ['Left', 'Right'].every((k) => s[`border${k}Style`] === 'solid' && parseFloat(s[`border${k}Width`]) > 0 && s[`border${k}Color`] === series) && /rgba\(.*,\s*0\)|transparent/.test(s.backgroundColor)
      if (!ok) say('guard', `${name(sw)} is not drawn dashed as rendered (borders ${s.borderLeftStyle} ${s.borderLeftWidth} ${s.borderLeftColor} / ${s.borderRightStyle}, fill ${s.backgroundColor}; the series is ${series}): its slot is told from 1 to 4 by hue alone`) }
    // emphasis from the legend: the lines that step back are series-other hairlines (v4 review; mutant Y15)
    for (const chart of document.querySelectorAll('.vz-chart')) { const plot = chart.querySelector('svg.vz-plot'), rows = [...chart.querySelectorAll('tbody tr[data-key]:not([data-key="other"]) .vz-series')]
      if (!plot || rows.length < 2 || chart.matches('[data-error]') || !visible(plot)) continue
      rows[1].dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      if (plot.hasAttribute('data-emph')) for (const l of plot.querySelectorAll('.vz-series-g:not([data-emph-on]) .vz-line')) { const s = cs(l), other = rgb(tok(l, 'series-other'))
        if (s.stroke !== other || Math.abs(parseFloat(s.strokeWidth) - px(l, 'hairline')) > 0.01) { say('guard', `emphasis in ${name(chart.closest('.vz-panel')?.querySelector('.vz-panel-title') ?? chart)}: a line that steps back is ${s.stroke} ${s.strokeWidth}, not a series-other hairline (${other})`); break } }
      rows[1].dispatchEvent(new FocusEvent('focusout', { bubbles: true })) }
    // nothing loops (Motion; never a spinner: the owner's direction; mutant Y5)
    for (const el of document.querySelectorAll('*')) { const s = cs(el); if (s.animationName !== 'none' && /infinite/.test(s.animationIterationCount) && (!s.animationTimeline || s.animationTimeline === 'auto')) say('motion', `${name(el)} animates ${s.animationName} ${s.animationIterationCount} times: nothing loops, and a spinner never covers a wait`) }
  }
  if (coarse) {
    // every control's hit area is 44 by 44, measured by what the page finds under a finger (Touch; mutant Y11). A link inside running text
    // is text and exempt; a control partly scrolled out of a strip is reached by scrolling.
    const sel = 'a[href], button, input:not([type="checkbox"]):not([type="radio"]), select, textarea, summary, [role^="menuitem"], [role="tab"], label.vz-check, [tabindex="0"]'
    const owner = (x, y) => document.elementFromPoint(x, y)?.closest(sel)
    const flow = (x) => { let b = x.parentElement; while (b && /^(inline|contents)$/.test(cs(b).display)) b = b.parentElement; return b }
    const inSentence = (a) => { const b = flow(a); if (!b || /flex|grid/.test(cs(b).display)) return false; const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); let t
      while ((t = w.nextNode())) if (t.textContent.trim() && !a.contains(t) && !t.parentElement.closest('a, button, input, select, textarea, .vz-sr') && flow(t) === b) return true; return false }
    for (const el of document.querySelectorAll(sel)) {
      if (el.disabled || el.closest('[inert], [aria-busy="true"], .vz-sr') || el.matches('.vz-skip:not(:focus)') || (modal && !modal.contains(el)) || !visible(el) || !el.closest('.vz')) continue
      if (el.matches('a') && inSentence(el)) continue
      el.scrollIntoView({ block: 'center', inline: 'nearest' }); const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue
      let strip = el.parentElement; while (strip && strip !== document.body && !/(auto|scroll)/.test(cs(strip).overflowX)) strip = strip.parentElement
      if (strip && strip !== document.body) { const b = strip.getBoundingClientRect(); if (r.left < b.left - 0.5 || r.right > b.right + 0.5) continue }
      const cx = Math.max(22, Math.min(innerWidth - 22, r.left + r.width / 2)), cy = r.top + r.height / 2
      if (owner(cx, cy) !== el) { const at = document.elementFromPoint(cx, cy); if (!(at && el.contains(at))) say('hit-area', `${name(el)} is covered at its centre by ${at ? name(at) : 'nothing'} with a coarse pointer`); continue }
      const tall = owner(cx, cy - 21.5) === el && owner(cx, cy + 21.5) === el, wide = owner(cx - 21.5, cy) === el && owner(cx + 21.5, cy) === el
      if (!tall || !wide) say('hit-area', `${name(el)}: hit area under 44 px ${!tall ? 'tall' : 'wide'} with a coarse pointer (drawn ${Math.round(r.width)} x ${Math.round(r.height)} px)`)
    }
    scrollTo(0, 0)
  }
  return out
}
// The page with every token moved: colours inverted, lengths and durations doubled. A computed colour, length or duration that does not move
// with them was written out somewhere (a stylesheet, a style attribute, a script, an SVG attribute, the browser's own defaults), whatever
// its spelling; an opacity other than 1 has no token at all. Every element inside .vz is read before and after, in one task, so nothing
// redraws in between.
function tokenTrace({ css }) {
  const out = [], seen = new Set(), say = (key, msg) => { if (!seen.has(key) && seen.size < 12) { seen.add(key); out.push(['token', msg]) } }
  const name = (e) => { const t = (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24); return `<${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : (e.className?.baseVal ? '.' + e.className.baseVal.split(/\s+/).join('.') : '')}>${t ? ' "' + t + '"' : ''}` }
  const COLOUR = ['color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color', 'text-decoration-color', 'column-rule-color', 'caret-color']
  const SIDES = ['top', 'right', 'bottom', 'left'], LENGTH = [...SIDES.map((k) => 'margin-' + k), ...SIDES.map((k) => 'padding-' + k), 'row-gap', 'column-gap', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius', 'font-size', 'line-height', 'letter-spacing', 'word-spacing', 'text-indent', 'text-underline-offset', 'text-decoration-thickness', 'min-width', 'min-height', 'max-width', 'max-height', 'outline-offset']
  const DURATION = ['transition-duration', 'transition-delay', 'animation-duration', 'animation-delay']
  const PAINT = /^(text|tspan|path|rect|circle|ellipse|polygon|polyline|line)$/
  const els = [...document.querySelectorAll('.vz, .vz *')].filter((e) => e.getClientRects().length && !e.closest('.vz-sr'))
  const snap = () => els.map((e) => { const s = getComputedStyle(e), v = {}, svg = e instanceof SVGElement
    for (const p of COLOUR) v[p] = s.getPropertyValue(p); for (const p of LENGTH) v[p] = s.getPropertyValue(p); for (const p of DURATION) v[p] = s.getPropertyValue(p)
    for (const k of SIDES) v[`border-${k}-width`] = s.getPropertyValue(`border-${k}-style`) === 'none' ? '0px' : s.getPropertyValue(`border-${k}-width`)
    v['outline-width'] = s.outlineStyle === 'none' ? '0px' : s.outlineWidth; v['box-shadow'] = s.boxShadow; v.opacity = s.opacity
    if (svg && PAINT.test(e.tagName)) { if (e.tagName !== 'line') v.fill = s.fill; v.stroke = s.stroke; v['stroke-width'] = s.stroke === 'none' ? '0px' : s.strokeWidth; v['fill-opacity'] = s.fillOpacity; v['stroke-opacity'] = s.strokeOpacity }
    if (svg) { delete v['background-color']; for (const p of LENGTH) if (!/^(font-size|letter-spacing|word-spacing)$/.test(p)) delete v[p] }
    return v })
  // transitions held still in both readings (a transition would report the old value as the new one); their durations are still read
  const hold = document.createElement('style'); hold.textContent = '.vz, .vz *, .vz *::before, .vz *::after { transition-property: none !important; animation-play-state: paused !important; }'; document.head.appendChild(hold)
  const a = snap(), st = document.createElement('style'); st.textContent = css; document.head.appendChild(st); const b = snap(); st.remove(); hold.remove()
  const zero = (x) => /^(0(px|s|ms)?|0px 0px|none|auto|normal|medium|from-font|rgba\(0, 0, 0, 0\)|transparent)$/.test(x.trim())
  const parts = (x) => x.match(/rgba?\([^)]*\)|-?[\d.]+px|-?[\d.]+m?s/g) ?? []
  els.forEach((e, i) => { for (const [p, v] of Object.entries(a[i])) { const w = b[i][p]
    if (p === 'opacity' || p === 'fill-opacity' || p === 'stroke-opacity') { if (v !== '1') say(e.tagName + p + v, `${p}: ${v} on ${name(e)}: there is no opacity token`); continue }
    if (/%/.test(v) || /(min|max|fit)-content|none/.test(v)) continue
    if (p === 'box-shadow' || /duration|delay/.test(p)) { const pa = parts(v), pb = parts(w); pa.forEach((x, j) => { if (!zero(x) && x === pb[j]) say(p + x, `${p} on ${name(e)} holds ${x}, which does not come from a token (${v.slice(0, 60)})`) }); continue }
    if (zero(v)) continue
    if (v === w) say(p + v, `${p}: ${v} on ${name(e)} does not come from a token`) } })
  return out
}
// moved tokens, for tokenTrace: colours inverted, px, ch and ms doubled
function perturbedCss(tokenCss, t) {
  const inv = (x) => String(x).replace(/#([0-9a-f]{6})\b/gi, (_, h) => '#' + [0, 2, 4].map((i) => (255 - parseInt(h.slice(i, i + 2), 16)).toString(16).padStart(2, '0')).join('')).replace(/#([0-9a-f]{3})\b/gi, (_, h) => '#' + [...h].map((c) => (15 - parseInt(c, 16)).toString(16).repeat(2)).join('')).replace(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g, (_, r, g, b) => `rgba(${255 - r}, ${255 - g}, ${255 - b}`)
  const dbl = (x) => String(x).replace(/(-?\d*\.?\d+)(px|ch|ms)\b/g, (_, n, u) => `${+n * 2}${u}`)
  const move = (x) => dbl(inv(x)), u = JSON.parse(JSON.stringify(t))
  for (const k of u.color.tokens) k.value = typeof k.value === 'string' ? move(k.value) : Object.fromEntries(Object.entries(k.value).map(([th, v]) => [th, move(v)]))
  for (const f of Object.keys(u)) if (Array.isArray(u[f]?.tokens) && f !== 'color') for (const k of u[f].tokens) k.value = typeof k.value === 'string' ? move(k.value) : Object.fromEntries(Object.entries(k.value).map(([th, v]) => [th, move(v)]))
  for (const g of u.type.groups) for (const st of g.styles) { st.fontSize = dbl(st.fontSize); st.lineHeight = dbl(st.lineHeight) }
  const { tokensCss, typeCss } = tokenCss(u); return tokensCss + typeCss
}
// a finger's press, as painted: CDP touch events held on each kind of control (v5 review, M3; mutant Y18)
async function fingerPress(page, cdp) {
  const out = [], rgb = (v) => { v = String(v).trim(); if (!v.startsWith('#')) return v.replace(/\s*,\s*/g, ', '); const h = v.slice(1); return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})` }
  const n = await page.evaluate(() => { const kinds = ['.vz-button:not([data-tone]):not([data-quiet])', '.vz-button[data-quiet]', '.vz-button[data-tone]', '.vz-segmented button', '.vz-menu [role^="menuitem"]', '.vz-sort', '.vz-tree-toggle', '.vz-legend-table tbody tr[data-key] .vz-series']
    const modal = document.querySelector('dialog:modal'); let i = 0
    for (const k of kinds) { let c = 0; for (const el of document.querySelectorAll(k)) { if (c >= 2) break; if (el.disabled || el.closest('[inert], [aria-busy="true"], [hidden], .vz-sr') || (modal && !modal.contains(el)) || !el.getClientRects().length || getComputedStyle(el).visibility !== 'visible' || (el.checkVisibility && !el.checkVisibility())) continue; el.dataset.vzProbe = String(i++); c++ } }
    return i })
  for (let i = 0; i < n; i++) {
    const at = await page.evaluate((i) => { const el = document.querySelector(`[data-vz-probe="${i}"]`); el.scrollIntoView({ block: 'center', inline: 'nearest' }); const r = el.getBoundingClientRect(), paint = el.matches('.vz-series') ? el.closest('tr').querySelector('td') : el, tone = el.closest('[data-tone]')?.dataset.tone
      const x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y)
      return { x, y, own: !!hit && (hit === el || el.contains(hit) || (el.matches('.vz-series') && el.closest('tr').contains(hit))), rest: getComputedStyle(paint).backgroundColor, want: getComputedStyle(el).getPropertyValue(tone ? `--${tone}-pressed` : '--pressed').trim(), what: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.textContent || '').trim().slice(0, 24)}"` } }, i)
    if (!at.own) continue
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] })
    const now = await page.evaluate((i) => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => { const el = document.querySelector(`[data-vz-probe="${i}"]`), paint = el.matches('.vz-series') ? el.closest('tr').querySelector('td') : el; done(getComputedStyle(paint).backgroundColor) }))), i)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
    if (now === at.rest || now !== rgb(at.want)) out.push(['press', `a finger held on ${at.what} paints ${now} (at rest ${at.rest}); its press is ${rgb(at.want)}`])
  }
  return out.slice(0, 6)
}
// with reduced motion requested, nothing transitions and nothing animates by the clock (Reduced motion; mutant Y14)
function stillness() {
  const out = []; for (const el of document.querySelectorAll('.vz, .vz *')) { const s = getComputedStyle(el)
    if (s.transitionDuration.split(',').some((d) => parseFloat(d) > 0) && s.transitionProperty !== 'none') out.push(['motion', `<${el.tagName.toLowerCase()}.${[...el.classList].join('.')}> transitions ${s.transitionProperty} over ${s.transitionDuration} with reduced motion requested`])
    if (s.animationName !== 'none' && (!s.animationTimeline || s.animationTimeline === 'auto')) out.push(['motion', `<${el.tagName.toLowerCase()}.${[...el.classList].join('.')}> animates ${s.animationName} with reduced motion requested`])
    if (out.length >= 6) break }
  return out
}

const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' }
const server = createServer((req, res) => { const p = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); res.end(); return } res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' }); res.end(readFileSync(p)) })
const port = await new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port))), urlOf = (p) => `http://127.0.0.1:${port}/${relative(root, p)}`
const browser = await chromium.launch(), results = [], started = Date.now()
for (const c of configs) {
  const ctx = await browser.newContext({ viewport: { width: c.zoom ? c.w : c.w, height: 900 }, deviceScaleFactor: c.zoom ?? 1, ...(c.coarse ? { hasTouch: true, isMobile: true } : {}) })
  const page = await ctx.newPage(); let errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  for (const p of pages) {
    errors = []
    try { await page.goto(urlOf(p), { waitUntil: 'load', timeout: 60000 }); await page.waitForTimeout(/fixture/.test(p) ? 600 : 0); await page.evaluate(() => document.fonts.ready); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); await page.waitForTimeout(120) } catch (e) { results.push({ page: p, config: label(c), kind: 'load', msg: e.message.split('\n')[0] }); continue }
    const found = await page.evaluate(audit, { coarse: !!c.coarse, words: true })
    const fine = c.w === 1500 && !c.zoom && !c.coarse, touch = c.w === 400 && !!c.coarse
    if (fine || touch) {
      if (fine) await page.keyboard.press('Shift') // keyboard modality, so a focused control shows its ring as from the keyboard
      found.push(...await page.evaluate(guards, { fine, coarse: touch }))
      if (touch) found.push(...await fingerPress(page, await ctx.newCDPSession(page)))
      await page.evaluate((th) => { if (th) document.documentElement.dataset.theme = th }, touch ? 'dark' : null) // the token trace in both themes
      found.push(...await page.evaluate(tokenTrace, { css: perturbed }))
    }
    if (c.w === 1500 && !c.zoom && !c.coarse && /compositions|fixture/.test(p)) found.push(...(await page.evaluate(words)))
    for (const e of errors) found.push(['script', e])
    for (const [kind, msg] of found) results.push({ page: p, config: label(c), kind, msg })
  }
  await ctx.close()
  process.stdout.write(`\r${label(c).padEnd(16)} done, ${results.length} finding(s) so far, ${Math.round((Date.now() - started) / 1000)} s`)
}
{ // reduced motion: one more pass at 1500 px
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, reducedMotion: 'reduce' }), page = await ctx.newPage()
  for (const p of pages) { try { await page.goto(urlOf(p), { waitUntil: 'load', timeout: 60000 }); await page.waitForTimeout(/fixture/.test(p) ? 600 : 0) } catch { continue }
    for (const [kind, msg] of await page.evaluate(stillness)) results.push({ page: p, config: '1500 reduced motion', kind, msg }) }
  await ctx.close() }
await browser.close(); server.close()
for (const msg of stale) results.unshift({ page: join(root, 'dist'), config: 'build', kind: 'stale', msg })
const rel = (p) => relative(root, p), flows = (r) => /\/flows\//.test(r.page)
console.log(`\n\n${pages.length} pages x ${configs.length} configurations (${configs.map(label).join('; ')})`)
for (const group of [['System pages', (r) => !flows(r)], ['Flow screens (read only, reported)', flows]]) {
  const rs = results.filter(group[1]); console.log(`\n${group[0]}: ${rs.length} finding(s)`)
  const byPage = {}; for (const r of rs) (byPage[rel(r.page)] ??= []).push(r)
  for (const [p, list] of Object.entries(byPage)) { console.log(`  ${p}`); const seen = new Set(); for (const r of list) { const k = r.kind + r.msg.replace(/\d+(\.\d+)?/g, '#'); if (seen.has(k)) continue; seen.add(k); console.log(`    ${r.kind.padEnd(13)} ${r.config.padEnd(15)} ${r.msg}${list.filter((x) => x.kind + x.msg.replace(/\d+(\.\d+)?/g, '#') === k).length > 1 ? `  (and at ${list.filter((x) => x.kind + x.msg.replace(/\d+(\.\d+)?/g, '#') === k).slice(1).map((x) => x.config).join(', ')})` : ''}`) } }
}
if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify({ at: new Date().toISOString(), root, pages: pages.map(rel), configs: configs.map(label), results: results.map((r) => ({ ...r, page: rel(r.page) })) }, null, 1))
process.exit(results.some((r) => !flows(r)) ? 1 : 0)
