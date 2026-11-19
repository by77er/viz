// Component CSS read as CSS: the properties earlier reviews found broken, and their fixes, stated as requirements on the parsed rules, so
// removing a fix fails the check (presence), and the rules that confine colour, shape and motion hold everywhere (structure).
// rules: [{ sel: [selector], decls: [[prop, value, node, important]], cond: [at-rule prelude], line }], from lib/lint.mjs.
const N = (s) => String(s).replace(/\s+/g, '').toLowerCase()
export function structure(rules, { fail, tokens }) {
  let checked = 0
  const R = rules.map((r) => ({ ...r, nsel: r.sel.map(N), nd: r.decls.map(([p, v, , imp]) => [p, N(v), imp]), ncond: r.cond.map(N) }))
  const decl = (r, p) => r.nd.filter(([q]) => q === p).map(([, v]) => v)
  const has = (selFn, p, valFn, condFn = () => true) => R.some((r) => condFn(r.ncond) && r.nsel.some(selFn) && decl(r, p).some(valFn))
  const need = (ok, msg) => { checked++; if (!ok) fail(msg) }
  const coarse = (c) => c.some((x) => x.includes('(pointer:coarse)')), fine = (c) => !coarse(c)
  const eq = (s) => (x) => x === N(s), inc = (s) => (x) => x.includes(N(s)), val = (s) => (v) => v === N(s), vinc = (s) => (v) => v.includes(N(s))

  // ---- confinement: colour belongs to action buttons, status marks, chart series and the focus ring ----
  const fam = (t) => (/^(blue|red|green|yellow)(-hover|-pressed|-edge)?$|^on-(blue|red|green|yellow)$/.test(t) ? 'action' : /^status-/.test(t) ? 'status' : /^series(-\d|-other)?$/.test(t) ? 'series' : t === 'focus' ? 'focus' : null)
  for (const r of R) for (const [p, v] of r.nd) for (const m of v.matchAll(/var\(--([a-z0-9-]+)/g)) { const t = m[1], f = fam(t); if (!f) continue
    for (const s of r.nsel) { checked++
      const ok = f === 'action' ? s.includes(`[data-tone="${t.replace(/^on-/, '').replace(/-(hover|pressed|edge)$/, '')}"]`)
        : f === 'status' ? /\.vz-(status|mark)\[data-state=|\[aria-invalid="true"\]/.test(s)
        : f === 'series' ? /\[data-series|\.vz-swatch|\.vz-plot/.test(s)
        : /:focus(-visible|-within)?/.test(s)
      if (!ok) fail(`${s} uses --${t} (${p}, line ${r.line}): ${f === 'action' ? 'an action colour belongs to its own toned button only ([data-tone="…"]), never to selection, state or decoration' : f === 'status' ? 'a status colour belongs to a status mark (or an invalid field) only' : f === 'series' ? 'a series colour belongs to a chart and its legend only' : 'the focus colour belongs to the focus ring only'}`) } }
  // nothing is fully rounded, nothing glows, one shadow (lint.mjs reads each value; here, where they may appear)
  for (const r of R) for (const [p, v] of r.nd) if (p === 'box-shadow' && v.includes('var(--shadow-overlay)')) for (const s of r.nsel) { checked++; if (!/\.vz-(menu|dialog|notice|tooltip)/.test(s)) fail(`${s} has shadow-overlay (line ${r.line}): the one shadow means "this floats", for overlays only`) }

  // ---- motion: a press is never eased; nothing appears on hover ----
  const transitioned = R.filter((r) => r.nd.some(([p, v]) => /^transition(-property)?$/.test(p) && v !== 'none')).flatMap((r) => r.nsel.map((s) => s.replace(/\[[^\]]*\]|:[a-z-]+(\([^)]*\))?/g, '')))
  for (const r of R) for (const s of r.nsel) if (/:active|\[data-pressed\]|\[aria-busy="true"\]/.test(s)) {
    for (const [p, v] of r.nd) if (/^transition(-duration)?$/.test(p) && !/^(0s|none|0ms)$/.test(v)) { checked++; fail(`${s} sets ${p}: ${v} (line ${r.line}): a press is painted in the next frame, never eased`) }
    const base = s.replace(/\[[^\]]*\]|:[a-z-]+(\([^)]*\))?/g, ''), coveredBy = s.replace(/\[data-tone="[^"]*"\]|\[data-quiet\]/g, '')
    if (transitioned.includes(base)) { checked++; if (!R.some((q) => q.nsel.some((x) => x === coveredBy || x === s) && q.nd.some(([p, v]) => /^transition(-duration)?$/.test(p) && /^(0s|none|0ms)$/.test(v)))) fail(`${s} (line ${r.line}) changes a control that has a transition, and no press rule for it sets transition-duration: 0s: the press would ease in`) } }
  // every :active has a [data-pressed] twin (a finger's press, painted from pointerdown by viz-press.js), with the same declarations
  for (const r of R) for (const s of r.nsel) if (s.includes(':active')) { checked++; const twin = s.replace(/:active/g, '[data-pressed]'); if (!R.some((q) => q.nsel.includes(twin) && N(JSON.stringify(q.nd)) === N(JSON.stringify(r.nd)))) fail(`${s} (line ${r.line}) has no [data-pressed] twin with the same declarations: a finger's press would not paint until the release`) }

  // ---- presence: the fixes of v4, v5 and v6 ----
  need(has(eq('.vz :focus-visible'), 'outline', val('var(--stroke) solid var(--focus)')) && has(eq('.vz :focus-visible'), 'outline-offset', val('var(--stroke)')), 'the focus ring is gone: .vz :focus-visible must draw outline: var(--stroke) solid var(--focus), offset by var(--stroke), on every focusable element')
  for (const r of R) for (const s of r.nsel) if (s.includes(':focus-visible') && decl(r, 'outline').some((v) => /^(0|none)/.test(v))) { const subject = s.replace(/:focus-visible/, ''); checked++
    if (R.filter((q) => q.nsel.some((x) => x.includes(`:has(${subject.split(/[\s>]/).pop()}:focus-visible)`)) && q.nd.some(([p, v]) => p === 'box-shadow' && v.includes('var(--focus)'))).length < 3) fail(`${s} removes the outline (line ${r.line}) and nothing draws its ring instead (three cell rules with box-shadow in --focus, :has(…:focus-visible))`) }
  for (const btn of ['.vz-series', '.vz-waterfall-span']) need(R.filter((r) => r.nsel.some((x) => x.includes(N(`:has(${btn}:focus-visible)`)) && /td(:first-child|:last-child)?$/.test(x)) && r.nd.some(([p, v]) => p === 'box-shadow' && v.includes('var(--focus)'))).length >= 3, `the row of ${btn} has no focus ring drawn by its cells (td, first and last cell, box-shadow in focus): a keyboard user cannot see which row is focused`)
  // coarse pointer: every control a 44 px hit area
  const touch = [['.vz-button::after', 'height'], ['.vz-segmented button::after', 'height'], ['.vz-tabs button::after', 'height'], ['.vz-nav a::after', 'height'], ['.vz-progress-action::after', 'height'], ['.vz-check', 'min-height'], ['.vz-done', 'min-height'], ['.vz-sort', 'min-height'], ['.vz-menu [role^="menuitem"]', 'height'], ['.vz-details > summary', 'min-height'], ['.vz-input', 'height'], ['.vz-select', 'height'], ['.vz-query', 'min-height'], ['.vz-tree-toggle', 'height'], ['.vz-table[data-fold] td[data-key]', 'min-height']]
  for (const [s, p] of touch) need(has(eq(s), p, vinc('var(--control-touch)'), coarse), `with a coarse pointer, ${s} has no ${p} of control-touch: its hit area is under 44 px`)
  need(has(inc('.vz-button::after'), 'width', val('max(100%, var(--control-touch))'), coarse), 'with a coarse pointer, a button\'s hit area is not at least control-touch wide')
  need(has(inc('.vz-table tr:has(a, button, input, select) td'), 'height', vinc('var(--control-touch)'), coarse), 'with a coarse pointer, table rows that hold a control are not control-touch tall: targets in neighbouring rows overlap')
  need(has(inc(':is(.vz-links, .vz-timeline) > li > .vz-link'), 'min-height', val('var(--control-touch)'), coarse) && R.some((r) => coarse(r.ncond) && r.nsel.some((x) => x.includes(N('.vz-link:not(:is(p, li, dd, .vz-help, .vz-secondary, .vz-text, .vz-page-sub) .vz-link')))), 'with a coarse pointer, a link inside running text (p, li, dd, a help line, prose) must keep its line and a standalone link (a list of links, a timeline line) must be control-touch tall (v5 review, m1)')
  // the chart's reserved height, from the same custom properties the coarse block sets (v4 review, B2)
  const reserve = R.find((r) => r.nsel.includes('.vz-chart') && decl(r, 'min-height').length)
  need(!!reserve && ['var(--chart-plot)', 'var(--strip)', 'var(--chart-foot)', 'var(--legend-head)', 'var(--legend-row)', 'var(--legend-rows', 'var(--legend-notes'].every((x) => decl(reserve, 'min-height')[0].includes(N(x))), 'the chart reserves its height without reading --chart-plot, --strip, --chart-foot, --legend-head, --legend-row, --legend-rows and --legend-notes: on a phone it would reserve the wrong height (v4 B2)')
  need(!R.some((r) => r.nsel.some((x) => x.includes('[style*='))), 'a rule is keyed on an inline style attribute ([style*=…]): the reservation must hold when the custom properties come from a stylesheet (v5 review, m7)')
  for (const p of ['--chart-foot', '--legend-head', '--legend-row']) need(has(eq('.vz-chart'), p, vinc('var(--control-touch)'), coarse), `the coarse-pointer block does not set ${p} on .vz-chart from control-touch: the reserved height would ignore the touch-size legend (v4 B2, v5 X27)`)
  need(has(eq('.vz'), '--strip', val('var(--control-touch)'), coarse), 'the coarse-pointer block does not make the strip control-touch tall')
  need(has(eq('.vz-plot'), 'height', (v) => v.includes('var(--chart-plot)') && v.includes('var(--strip)')), 'the plot\'s height does not come from --chart-plot and --strip')
  need(has(eq('.vz-plot'), 'touch-action', val('pan-y')), 'the plot lost touch-action: pan-y: a finger dragging for the crosshair would scroll the page')
  // the second channel: dashed slots, in lines and swatches; emphasis from the legend
  for (const i of [5, 6, 7, 8]) { need(R.some((r) => r.nsel.includes(`[data-series="${i}"]`) && r.nd.some(([p]) => p === '--pattern')), `[data-series="${i}"] has no --pattern: slots 5 to 8 must be dashed, the second channel beside colour`)
    need(R.some((r) => r.nsel.includes(`.vz-swatch[data-series="${i}"]`) && decl(r, 'border-inline').some((v) => v.includes('solid') && v.includes('var(--series)')) && decl(r, 'background').includes('transparent')), `.vz-swatch[data-series="${i}"] is not drawn dashed (two dashes and a gap: transparent fill, border-inline in the series colour)`) }
  need(has(eq('.vz-plot .vz-line[data-series]'), 'stroke-dasharray', vinc('var(--pattern')), '.vz-plot .vz-line[data-series] does not draw --pattern: dashed slots would be drawn solid')
  need(has(eq('.vz-plot[data-emph] .vz-series-g:not([data-emph-on]) .vz-line'), 'stroke', val('var(--series-other)')) && has(eq('.vz-plot[data-emph] .vz-series-g:not([data-emph-on]) .vz-line'), 'stroke-width', val('var(--hairline)')), 'emphasis from the legend is gone: the lines that step back must be series-other hairlines')
  need(R.some((r) => r.ncond.some((c) => c.includes('prefers-reduced-motion:reduce')) && r.nsel.includes(N('.vz *')) && r.nd.some(([p, v, imp]) => p === 'transition' && v === 'none' && imp)), 'the reduced-motion block is gone: .vz * { transition: none !important } under prefers-reduced-motion: reduce')
  // the swatch's ground ring; the crosshair dot's ground edge
  { const RING = N('0 0 0 var(--stroke) var(--ground)'), OFF = N('inset 0 0 0 var(--hairline) var(--series-other)'); let base = false
    for (const r of R) for (const s of r.nsel) if (/\.vz-swatch(\[[^\]]*\])*$/.test(s)) for (const v of decl(r, 'box-shadow')) { checked++; if (s === '.vz-swatch' && v === RING) base = true; else if (v !== RING && !((s.includes('[data-off]') || s.includes('[data-error]')) && v === OFF)) fail(`${s} sets box-shadow: ${v} (line ${r.line}): the swatch must keep its ground ring; a pressed row puts series below 3:1 without it`) }
    need(base, '.vz-swatch has lost its ground ring') }
  need(has(eq('.vz-plot .vz-dot[data-series]'), 'stroke', val('var(--ground)')), '.vz-plot .vz-dot[data-series] has lost its ground edge')
  for (const r of R) for (const s of r.nsel) { const last = s.split(/[\s>+~]+/).pop(); if (/^(svg)?\.vz-(plot|chart)(\[[^\]]*\]|:[\w-]+(\([^)]*\))?)*$/.test(last)) for (const [p] of r.nd) if (/^(background|background-color|fill)$/.test(p)) { checked++; fail(`${s} sets ${p} (line ${r.line}): a chart has no fill of its own`) } }
  need(has(eq('.vz-chart[data-error] .vz-legend-table .vz-swatch'), 'background', val('transparent')), 'after an error the legend\'s swatches claim colours for lines that are not drawn (v5 review, m3)')
  // narrow and zoom: tables (v5 review, B2)
  need(has(eq('.vz-table-wrap'), 'position', val('relative')), '.vz-table-wrap is not positioned: something absolutely placed inside a table (a visually hidden head) escapes its scroll and widens the page (v5 review, B2.1)')
  need(has(inc('.vz-table-wrap'), 'border-right', vinc('var(--stroke)')) && R.some((r) => r.nsel.some((x) => x.includes('.vz-table-wrap')) && decl(r, 'animation-timeline').some((v) => v.includes('scroll('))), 'the table wrap\'s scroll edge is not its own border on a scroll timeline: the cells\' fill would cover it (v5 review, m14)')
  for (const f of ['[data-fold]', '[data-fold="wide"]']) {
    const inFold = (c) => c.some((x) => x.includes('max-width:' + (f === '[data-fold]' ? '639px' : '1199px')))
    need(has(eq(`.vz-table${f} [data-priority="1"] .vz-status`), 'white-space', val('normal'), inFold), `in a folded table (${f}) a state in a kept column does not wrap: "Burning budget" is cut (v5 review, B2.2)`)
    need(has(eq(`.vz-table${f} [data-priority="1"]`), 'min-width', val('min-content'), inFold), `in a folded table (${f}) a kept column can be narrower than its longest phrase`)
    need(has(eq(`.vz-table${f} td.vz-row-actions:not([data-key])`), 'order', val('1'), inFold) && has(eq(`.vz-table${f} td.vz-row-actions:not([data-key])`), 'width', val('auto'), inFold), `in a folded table (${f}) "Actions…" has no fixed place on the key's line: it lands off screen (v5 review, B2.2)`)
  }
  // the two fold forms are one pattern: every folding rule below breakpoint-narrow has its twin below breakpoint-wide
  { const narrow = R.filter((r) => r.ncond.some((c) => c.includes('max-width:639px')) && r.nsel.some((x) => x.includes('[data-fold]'))), wide = R.filter((r) => r.ncond.some((c) => c.includes('max-width:1199px')) && r.nsel.some((x) => x.includes('[data-fold="wide"]')))
    const key = (r, swap) => JSON.stringify([r.nsel.map((x) => (swap ? x.replace(/\[data-fold\]/g, '[data-fold="wide"]') : x)), r.nd])
    const W = new Set(wide.map((r) => key(r))); for (const r of narrow) { checked++; if (!W.has(key(r, true))) fail(`the folding rule "${r.sel.join(', ').slice(0, 90)}" (line ${r.line}) has no twin for data-fold="wide": the two fold forms have drifted`) } }
  need(!has(eq('.vz-table-caption'), 'display', (v) => /flex|grid/.test(v)), 'the table caption is a flex or grid row: the spaces round a vz-qty in it collapse (flows G17)')
  need(has(eq('.vz-status'), 'align-items', val('flex-start')) && has(eq('.vz-status::before'), 'margin-top', vinc('1lh')), 'a status mark is not centred on its first line: a status that wraps leaves its mark between lines')
  need(has(eq('.vz-link .vz-cut > *'), 'text-decoration', val('inherit')), 'a link holding a vz-cut loses its underline (v5 review, m2)')
  return checked
}
