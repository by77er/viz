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
//   cut           a word cut by the edge of a box that clips it, or out of view, outside a strip that scrolls on purpose (a wide table in
//                 its scroll form, the navigation, tabs) and outside text cut on purpose with an ellipsis (vz-cut, a legend name);
//   tiny          text below micro (11 px);
//   sentence-link with a coarse pointer, a link inside running text drawn as a 44 px control (it breaks its line), or a link standing alone
//                 whose hit area is under 44 px. A link is inside a sentence when its block holds other words; standing alone otherwise.
// And, on the compositions at 1500 px:
//   figure        an element marked data-figure="<chart id>|<series label value>|last|min|max" that does not show what that chart's model
//                 holds for that series, or elements marked data-same="<name>" that show different numbers;
//   caption       a table caption "N of M …" or "N …" whose N is not the number of rows under it, or whose stated order ("most recently
//                 changed first", "slowest first", "highest … first") the rows do not follow;
//   age           an age beyond a day written as "N d ago", or "0 s ago", in a table cell (Words: the absolute time beyond a day).
// Exit status 1 if any page outside flows/ fails. Flow screens are reported, never edited.
import { readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
const args = process.argv.slice(2), opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const root = resolve(opt('--root') ?? new URL('..', import.meta.url).pathname), quick = args.includes('--quick')
const explicit = args.filter((a, i) => a.endsWith('.html') && args[i - 1] !== '--json')
const list = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.html')).sort().map((f) => join(dir, f)) : [])
const reviews = readdirSync(join(root, 'reviews')).filter((d) => /^system-v\d+$/.test(d)).sort((a, b) => +a.slice(8) - +b.slice(8))
const latest = reviews.reverse().find((d) => existsSync(join(root, 'reviews', d, 'compositions')))
const pages = explicit.length ? explicit.map((p) => resolve(p)) : [...list(join(root, 'dist/preview')), join(root, 'dist/reference.html'), join(root, 'dist/fixture/index.html'), ...(latest ? list(join(root, 'reviews', latest, 'compositions')) : []), ...list(join(root, 'flows/dist'))].filter(existsSync)
const configs = quick
  ? [{ w: 320, coarse: true }, { w: 400, coarse: true }, { w: 720, zoom: 2 }, { w: 1500 }]
  : [...[320, 400, 560, 640, 800, 1024, 1280, 1500].map((w) => ({ w })), ...[320, 400, 768].map((w) => ({ w, coarse: true })), ...[640, 720, 750].map((w) => ({ w, zoom: 2 }))]
const label = (c) => `${c.w}${c.coarse ? ' coarse' : ''}${c.zoom ? ' at 200%' : ''}`

// ---- runs in the page ----
function audit({ coarse, words }) {
  const out = [], vw = document.documentElement.clientWidth, cs = (e) => getComputedStyle(e)
  const name = (e) => { if (!e || e.nodeType !== 1) return String(e); const t = (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32); return `<${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : ''}>${t ? ' "' + t + '"' : ''}` }
  const shown = (e) => { for (let x = e; x && x.nodeType === 1; x = x.parentElement) { const s = cs(x); if (s.display === 'none' || s.visibility === 'hidden' && x === e) return false } return e.getClientRects().length > 0 }
  const hiddenText = (e) => e.closest('.vz-sr, .vz-skip:not(:focus), [hidden], [aria-hidden="true"]:not(svg), dialog:not([open]), template, script, style, title')
  const clips = (e) => { const s = cs(e); return s.overflowX !== 'visible' || s.overflowY !== 'visible' }
  const scrolls = (e) => /(auto|scroll)/.test(cs(e).overflowX)
  const foldTable = (e) => e.closest('table[data-fold]') && cs(e.closest('table[data-fold]')).display === 'block' // folded now
  const isCB = (e) => { const s = cs(e); return s.position !== 'static' || s.transform !== 'none' || s.filter !== 'none' || /layout|paint|strict|content/.test(s.contain) || s.willChange.includes('transform') }
  // overflow
  const over = document.documentElement.scrollWidth - vw
  if (over > 0) { const culprits = []; for (const e of document.body.querySelectorAll('*')) { if (!shown(e)) continue; const r = e.getBoundingClientRect(), p = e.parentElement?.getBoundingClientRect(); if (r.right > vw + 0.5 && r.width > 0 && (!p || p.right <= vw + 0.5)) { let c = e.parentElement; while (c && c !== document.body && !clips(c)) c = c.parentElement; culprits.push(name(e)) } if (culprits.length > 3) break } out.push(['overflow', `page scrolls sideways by ${over} px: ${culprits.join(', ')}`]) }
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
      let purposely = false, clipBoxes = []
      for (let x = el; x && x !== document.documentElement; x = x.parentElement) { const s = cs(x)
        if (s.textOverflow === 'ellipsis' || x.matches('.vz-cut > :first-child, .vz-readout')) { purposely = true; break } // cut with an ellipsis, or a readout fitted by measuring
        if (clips(x) && x !== document.body) { if (scrolls(x) && !foldTable(el) && x.scrollWidth > x.clientWidth + 1) { purposely = true; break } clipBoxes.push(x) } }
      if (purposely) continue
      let L = 0, R = vw; for (const x of clipBoxes) { const r = x.getBoundingClientRect(), bl = parseFloat(cs(x).borderLeftWidth) || 0; L = Math.max(L, r.left + bl); R = Math.min(R, r.left + bl + x.clientWidth) }
      const text = n.textContent; const re = /\S+/g; let m
      while ((m = re.exec(text))) { range.setStart(n, m.index); range.setEnd(n, m.index + m[0].length)
        for (const r of range.getClientRects()) { if (!r.width) continue
          if (r.right > R + 0.75 || r.left < L - 0.75) { out.push(['cut', `"${m[0]}" in ${name(el)} is ${r.left >= R || r.right <= L ? 'out of view' : 'cut'} (${Math.round(r.left)} to ${Math.round(r.right)}, visible ${Math.round(L)} to ${Math.round(R)})`]); reported++; break } }
        if (reported >= 6) break }
    }
  }
  // text size
  let small = 99, where = ''; for (const e of document.body.querySelectorAll('*')) { if (hiddenText(e) || ![...e.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim()) || !shown(e)) continue; const f = parseFloat(cs(e).fontSize); if (f < small) { small = f; where = name(e) } }
  if (small < 11) out.push(['tiny', `text at ${small} px: ${where}`])
  // links in sentences and links that stand alone, with a coarse pointer
  if (coarse) for (const a of document.querySelectorAll('a[href]')) { if (!shown(a) || hiddenText(a) || a.closest('[inert], nav, .vz-nav') ) continue
    let block = a.parentElement; while (block && /^(inline|contents)$/.test(cs(block).display)) block = block.parentElement
    const words = (x) => (x.textContent || '').replace(/\s+/g, ' ').trim(), inSentence = block && words(block) !== words(a) && !a.closest('td[data-key], .vz-table td')
    const r = a.getBoundingClientRect(), lh = parseFloat(cs(a).lineHeight) || r.height
    if (inSentence && r.height > lh + 6) out.push(['sentence-link', `${name(a)} is inside a sentence in ${name(block)} but drawn ${Math.round(r.height)} px tall: it breaks its line`])
    if (!inSentence && !a.closest('td[data-key]')) { const cx = r.left + r.width / 2, cy = r.top + r.height / 2; if (cy < 0 || cy > innerHeight || cx < 0 || cx > vw) continue
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

const browser = await chromium.launch(), results = [], started = Date.now()
for (const c of configs) {
  const ctx = await browser.newContext({ viewport: { width: c.zoom ? c.w : c.w, height: 900 }, deviceScaleFactor: c.zoom ?? 1, ...(c.coarse ? { hasTouch: true, isMobile: true } : {}) })
  const page = await ctx.newPage(); let errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  for (const p of pages) {
    errors = []
    try { await page.goto('file://' + p, { waitUntil: 'load', timeout: 60000 }); await page.evaluate(() => document.fonts.ready); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); await page.waitForTimeout(120) } catch (e) { results.push({ page: p, config: label(c), kind: 'load', msg: e.message.split('\n')[0] }); continue }
    const found = await page.evaluate(audit, { coarse: !!c.coarse, words: true })
    if (c.w === 1500 && !c.zoom && !c.coarse && /compositions/.test(p)) found.push(...(await page.evaluate(words)))
    for (const e of errors) found.push(['script', e])
    for (const [kind, msg] of found) results.push({ page: p, config: label(c), kind, msg })
  }
  await ctx.close()
  process.stdout.write(`\r${label(c).padEnd(16)} done, ${results.length} finding(s) so far, ${Math.round((Date.now() - started) / 1000)} s`)
}
await browser.close()
const rel = (p) => relative(root, p), flows = (r) => /\/flows\//.test(r.page)
console.log(`\n\n${pages.length} pages x ${configs.length} configurations (${configs.map(label).join('; ')})`)
for (const group of [['System pages', (r) => !flows(r)], ['Flow screens (read only, reported)', flows]]) {
  const rs = results.filter(group[1]); console.log(`\n${group[0]}: ${rs.length} finding(s)`)
  const byPage = {}; for (const r of rs) (byPage[rel(r.page)] ??= []).push(r)
  for (const [p, list] of Object.entries(byPage)) { console.log(`  ${p}`); const seen = new Set(); for (const r of list) { const k = r.kind + r.msg.replace(/\d+(\.\d+)?/g, '#'); if (seen.has(k)) continue; seen.add(k); console.log(`    ${r.kind.padEnd(13)} ${r.config.padEnd(15)} ${r.msg}${list.filter((x) => x.kind + x.msg.replace(/\d+(\.\d+)?/g, '#') === k).length > 1 ? `  (and at ${list.filter((x) => x.kind + x.msg.replace(/\d+(\.\d+)?/g, '#') === k).slice(1).map((x) => x.config).join(', ')})` : ''}`) } }
}
if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify({ at: new Date().toISOString(), root, pages: pages.map(rel), configs: configs.map(label), results: results.map((r) => ({ ...r, page: rel(r.page) })) }, null, 1))
process.exit(results.some((r) => !flows(r)) ? 1 : 0)
