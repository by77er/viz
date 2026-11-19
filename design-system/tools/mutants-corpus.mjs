// The regression corpus for the checks. Each mutant breaks one property in a copy of the system (never the tree) and names the check that
// must fail; the harmless ones must pass. Run by tools/mutants.mjs (a table) and by npm test (tools/test/check.test.mjs).
//   R1-R18  the v4 review's mutants (reviews/system-v4/review.md, "check.mjs mutants")
//   N1-N13  v5's own (reviews/system-v5/response.md)
//   X1-X32  the v5 review's (reviews/system-v5/review.md, M5): 30 of them survived v5's check
//   V1-V17  v6's fixes, each removed
//   C1-C9   the Chart rules (tools/test/chart-rules.test.mjs must fail)
//   A1-A4   the rendered page audit (tools/audit.mjs must fail)
//   H1-H4   harmless edits (everything must pass)
// Fields: id, what, edit { file, edit(text) }, run ('check' | 'chart' | 'audit'), args (extra arguments), render (the check's rendered audit
// is needed), expect ('fail' | 'pass'), all (each pattern must appear in the output: a mutant with several literals is caught only if every
// one is reported).
const css = (from, to) => ({ file: 'src/components.css', edit: (s) => { if (!s.includes(from)) throw new Error('mutant does not apply: ' + from.slice(0, 80)); return s.replace(from, to) } })
const append = (text) => ({ file: 'src/components.css', edit: (s) => s + '\n' + text + '\n' })
const tok = (name, theme, value) => ({ file: 'project/tokens.json', edit: (s) => { const j = JSON.parse(s), k = j.color.tokens.find((x) => x.name === name); if (typeof k.value === 'string') k.value = value; else k.value[theme] = value; return JSON.stringify(j, null, 2) } })
const file = (path, from, to) => ({ file: path, edit: (s) => { if (!s.includes(from)) throw new Error('mutant does not apply: ' + from.slice(0, 80)); return s.replace(from, to) } })
const chart = (from, to) => file('project/components/Chart/preview.html', from, to)
const cut = (from, to) => ({ file: 'src/components.css', edit: (s) => { const a = s.indexOf(from), b = to ? s.indexOf(to, a) : s.length; if (a < 0 || b < 0) throw new Error('mutant does not apply: ' + from.slice(0, 60)); return s.slice(0, a) + s.slice(b) } })

export const corpus = [
  // ---- v4 review ----
  { id: 'R1', what: 'swatch ring removed', edit: css('background: var(--series); box-shadow: 0 0 0 var(--stroke) var(--ground); }', 'background: var(--series); }') },
  { id: 'R2', what: 'pressed equal to hover (light)', edit: tok('pressed', 'light', '#ededed') },
  { id: 'R3', what: 'series-4 back to v3 #eda100 (light)', edit: tok('series-4', 'light', '#eda100') },
  { id: 'R4', what: 'crosshair dot edge to rule', edit: css('stroke: var(--ground); stroke-width: var(--hairline); }\n.vz-plot .vz-dot-named', 'stroke: var(--rule); stroke-width: var(--hairline); }\n.vz-plot .vz-dot-named') },
  { id: 'R5', what: 'status-info equal to blue (light)', edit: tok('status-info', 'light', '#1257ff') },
  { id: 'R6', what: 'two near-identical neighbours (series-3 a copy of series-2, light)', edit: tok('series-3', 'light', '#bd6a2f') },
  { id: 'R7', what: 'a literal 3px', edit: append('.vz-panel-title { margin-top: 3px; }') },
  { id: 'R8', what: 'series-other near white (light)', edit: tok('series-other', 'light', '#e8e8e8') },
  { id: 'R9', what: 'swatch ring overridden on hover', edit: append('.vz-table.vz-legend-table tr:hover .vz-swatch { box-shadow: none; }') },
  { id: 'R10', what: 'ink-muted on pressed in the legend (the pressed override removed)', edit: css('.vz-table.vz-legend-table tr[data-key]:active .vz-series-rest, ', ''), render: true },
  { id: 'R11', what: 'ink-muted on rule in the legend (the chosen override removed)', edit: css(', .vz-table.vz-legend-table tr[aria-selected="true"] .vz-series-rest', ''), render: true },
  { id: 'R12', what: 'the plot filled with hover on hover', edit: append('.vz-plot:hover { background: var(--hover); }') },
  { id: 'R13', what: 'series-8 set to status-critical (light)', edit: tok('series-8', 'light', '#e0221b') },
  { id: 'R14', what: 'a literal angle (deg)', edit: append('.vz-mark[data-state="warn"] { transform: rotate(45deg); }') },
  { id: 'R15', what: 'a literal percentage', edit: append('.vz-skip:focus { left: 37%; }') },
  { id: 'R16', what: 'a literal unitless weight', edit: append('.vz-panel-title { font-weight: 600; }') },
  { id: 'R17', what: 'an opaque scrim (light)', edit: tok('scrim', 'light', 'rgba(17,17,17,1)') },
  { id: 'R18', what: 'harmless: the swatch rule reformatted onto two lines', edit: css('.vz-swatch { display: inline-block; flex: none;', '.vz-swatch {\n  display: inline-block; flex: none;'), expect: 'pass' },
  // ---- v5 ----
  { id: 'N1', what: 'swatch ring removed on a pressed row only', edit: append('.vz-table.vz-legend-table tbody tr[data-key]:active .vz-swatch { box-shadow: none; }') },
  { id: 'N2', what: 'neighbours at one lightness (series-2 as dark as series-1, light)', edit: tok('series-2', 'light', '#8a4f1f') },
  { id: 'N3', what: 'slot 7 drawn solid (its dash removed)', edit: css('[data-series="7"] { --series: var(--series-7); --pattern: var(--space-2) var(--space-1); }', '[data-series="7"] { --series: var(--series-7); }') },
  { id: 'N4', what: 'lines that step back drawn in rule', edit: css('.vz-plot[data-emph] .vz-series-g:not([data-emph-on]) .vz-line { stroke: var(--series-other);', '.vz-plot[data-emph] .vz-series-g:not([data-emph-on]) .vz-line { stroke: var(--rule);') },
  { id: 'N5', what: 'a breakpoint that is not a token (800px)', edit: append('@container (max-width: 799px) { .vz-split { gap: var(--space-6); } }') },
  { id: 'N6', what: 'token-lint-ignore without a reason', edit: append('.vz-panel-title { margin-top: 3px; } /* token-lint-ignore */') },
  { id: 'N7', what: 'a series in the dark theme below 3:1 on rule', edit: tok('series-1', 'dark', '#1f4f7a') },
  { id: 'N8', what: 'chosen legend row text in ink-muted', edit: append('.vz-table.vz-legend-table tr[aria-selected="true"] td { color: var(--ink-muted); }'), render: true },
  { id: 'N9', what: 'a waterfall bar drawn in rule', edit: append('.vz-waterfall-bar { background: var(--rule); }'), render: true },
  { id: 'N10', what: "the legend row's ring back to an outline on the row", edit: css('.vz-table.vz-legend-table tr:has(.vz-series:focus-visible) td:first-child {', '.vz-table.vz-legend-table tr:has(.vz-series:focus-visible) { outline: var(--stroke) solid var(--focus); }\n.vz-legend-unused td:first-child {') },
  { id: 'N11', what: 'a matched search term in ink-muted', edit: append('.vz-match { color: var(--ink-muted); }'), render: true },
  { id: 'N12', what: '"3 spans inside" in ink-muted', edit: append('.vz-waterfall-inside { color: var(--ink-muted); }'), render: true },
  { id: 'N13', what: 'a literal line count for a cut log message', edit: append('.vz-log-text { -webkit-line-clamp: 4; }') },
  // ---- the v5 review's mutants (M5) ----
  { id: 'X1', what: 'a named colour', edit: append('.vz-button { border-color: red; }'), all: [/colour.*red/] },
  { id: 'X2', what: 'RGB(255,0,0), upper case', edit: append('.vz-button[data-tone="red"] { background: RGB(255,0,0); }'), all: [/colour.*RGB/i] },
  { id: 'X3', what: 'a tinted table head from color-mix of tokens at 50%', edit: append('.vz-table th { background: color-mix(in srgb, var(--blue) 50%, var(--ground)); }'), all: [/colour.*color-mix/, /blue/] },
  { id: 'X4', what: '3PX, upper case', edit: append('.vz-panel-title { margin-top: 3PX; }'), all: [/length.*3PX/] },
  { id: 'X5', what: '1ex, 2vmin, 0.5lh, 3cqi', edit: append('.vz-panel-title { margin-top: 1ex; }\n.vz-panel-meta { gap: 2vmin; }\n.vz-label { padding-top: 0.5lh; }\n.vz-panel { padding-top: 3cqi; }'), all: [/1ex/, /2vmin/, /0\.5lh/, /3cqi/] },
  { id: 'X6', what: 'font-weight: bold', edit: append('.vz-panel-title { font-weight: bold; }'), all: [/weight.*bold/] },
  { id: 'X7', what: 'a breakpoint in em', edit: append('@media (max-width: 50em) { .vz-split { gap: var(--space-6); } }'), all: [/breakpoint.*50em/] },
  { id: 'X8', what: 'border-radius: 50% (fully rounded)', edit: append('.vz-button { border-radius: 50%; }'), all: [/radius/] },
  { id: 'X9', what: 'a gradient built from tokens', edit: append('.vz-banner { background: linear-gradient(var(--sunken), var(--ground)); }'), all: [/gradient/] },
  { id: 'X10', what: 'a second shadow built from tokens', edit: append('.vz-panel { box-shadow: 0 var(--space-1) var(--space-4) var(--rule); }'), all: [/shadow/] },
  { id: 'X11', what: 'capitals and tracking on labels', edit: append('.vz-label { text-transform: uppercase; letter-spacing: var(--space-half); }'), all: [/capitals/, /tracking/] },
  { id: 'X12', what: 'an off-scale calc(var(--space-1) * 1.5)', edit: append('.vz-stack { gap: calc(var(--space-1) * 1.5); }'), all: [/number.*1\.5/] },
  { id: 'X13', what: 'filter: opacity(0.5) and filter: brightness(0.9)', edit: append('.vz-button:disabled { filter: opacity(0.5); }\n.vz-menu { filter: brightness(0.9); }'), all: [/filter: opacity/, /filter: brightness/] },
  { id: 'X14', what: 'linear and ease-in-out', edit: append('.vz-button { transition: background-color var(--duration-fast) linear; }\n.vz-input { transition: border-color var(--duration-fast) ease-in-out; }'), all: [/easing.*linear/, /easing.*ease-in-out/] },
  { id: 'X15', what: 'a press that eases', edit: css('.vz-button:active, .vz-button[data-pressed] { transition-duration: 0s; background: var(--pressed); }', '.vz-button:active, .vz-button[data-pressed] { background: var(--pressed); }'), all: [/press would ease/] },
  { id: 'X16', what: 'selection in blue', edit: append('.vz-segmented button[aria-pressed="true"] { background: var(--blue); color: var(--on-blue); }'), all: [/action colour/] },
  { id: 'X17', what: 'a series colour on a panel rule', edit: append('.vz-panel { border-top-color: var(--series-1); }'), all: [/series colour belongs/] },
  { id: 'X18', what: 'the reduced-motion block removed', edit: cut('@media (prefers-reduced-motion: reduce)', '\n'), all: [/reduced-motion/] },
  { id: 'X19', what: 'the focus ring removed everywhere', edit: css('.vz :focus-visible { outline: var(--stroke) solid var(--focus); outline-offset: var(--stroke); }', '.vz :focus-visible { outline: none; }'), all: [/focus ring is gone/] },
  { id: 'X20', what: 'every coarse-pointer hit area removed', edit: cut('/* Touch: a 44px hit area'), all: [/coarse pointer/] },
  { id: 'X21', what: 'dashed swatches drawn solid', edit: css('.vz-swatch[data-series="5"], .vz-swatch[data-series="6"], .vz-swatch[data-series="7"], .vz-swatch[data-series="8"], .vz-swatch[data-pattern="dash"] {', '.vz-swatch[data-pattern="dash"] {'), all: [/not drawn dashed/] },
  { id: 'X22', what: 'emphasis removed', edit: cut('.vz-plot[data-emph] .vz-series-g:not([data-emph-on]) .vz-line', '.vz-plot[data-emph="other"]'), all: [/emphasis/] },
  { id: 'X23', what: 'touch-action removed', edit: css(' touch-action: pan-y;', ''), all: [/touch-action/] },
  { id: 'X24', what: 'series-5 a copy of series-1 (light)', edit: tok('series-5', 'light', '#06578a') },
  { id: 'X25', what: 'ink-disabled equal to ink-muted (light)', edit: tok('ink-disabled', 'light', '#6b6b6b'), all: [/ink-disabled/] },
  { id: 'X26', what: 'series-4 near grey (light)', edit: tok('series-4', 'light', '#7a7385') },
  { id: 'X27', what: "the chart reservation ignoring the coarse legend row (v4's B2 back)", edit: css('var(--legend-rows, 0) * var(--legend-row)', 'var(--legend-rows, 0) * calc(var(--control-sm) + var(--hairline))'), all: [/reserves its height without reading/] },
  { id: 'X28', what: 'a main path moved into a sentence', edit: file('project/components/Timeline/preview.html', 'payments-db suspected. Not verified.</p><a class="vz-link" href="#">Read the report</a>', 'payments-db suspected. Not verified. <a class="vz-link" href="#">Read the report</a></p>'), args: ['project/components'], all: [/main-path/] },
  { id: 'X29', what: "a single-quoted style='font-weight:600;width:37%' in a preview", edit: file('project/components/Button/preview.html', '<div class="vz-stack">', "<div class=\"vz-stack\"><span style='font-weight:600;width:37%'>x</span>"), args: ['project/components'], all: [/weight.*600/, /37%/] },
  { id: 'X30', what: 'opacity and weight set from script', edit: chart("const svg = root.querySelector('svg'),", "root.style.opacity = '0.5'; root.style.fontWeight = 600\n    const svg = root.querySelector('svg'),"), args: ['project/components'], all: [/opacity/, /weight/] },
  { id: 'X31', what: 'row actions revealed only on hover', edit: append('.vz-table td.vz-row-actions > * { visibility: hidden; }\n.vz-table tbody tr:hover td.vz-row-actions > * { visibility: visible; }'), all: [/hover/] },
  { id: 'X32', what: 'text below micro', edit: append('.vz-kbd { font-size: calc(var(--text-micro-size) - var(--hairline)); }'), all: [/size/] },
  // ---- v6's fixes, each removed ----
  { id: 'V1', what: 'the table wrap unpositioned (B2.1)', edit: css('.vz-table-wrap { position: relative; overflow-x: auto;', '.vz-table-wrap { overflow-x: auto;'), all: [/not positioned/] },
  { id: 'V2', what: 'a state in a kept column no longer wraps (B2.2)', edit: css('  .vz-table[data-fold] [data-priority="1"] .vz-status { white-space: normal; }\n', ''), all: [/does not wrap/] },
  { id: 'V3', what: '"Actions…" without its place in the folded row (B2.2)', edit: css('  .vz-table[data-fold] td.vz-row-actions:not([data-key]) { order: 1;', '  .vz-table[data-fold] td.vz-row-actions:not([data-key]) { order: 2;'), all: [/Actions/] },
  { id: 'V4', what: 'the two fold forms drift apart', edit: css('  .vz-table[data-fold="wide"] td { padding-block: var(--space-1); }', '  .vz-table[data-fold="wide"] td { padding-block: var(--space-2); }'), all: [/drifted/] },
  { id: 'V5', what: "a finger's press: the blue button's [data-pressed] twin removed (M3)", edit: css('.vz-button[data-tone="blue"]:active, .vz-button[data-tone="blue"][data-pressed] {', '.vz-button[data-tone="blue"]:active {'), all: [/no \[data-pressed\] twin/] },
  { id: 'V6', what: 'the caption a flex row again (flows G17)', edit: css('.vz-table-caption { margin: 0;', '.vz-table-caption { display: flex; margin: 0;'), all: [/caption is a flex/] },
  { id: 'V7', what: "links in list items and help lines drawn as controls again (m1)", edit: css(':is(p, li, dd, .vz-help, .vz-secondary, .vz-text, .vz-page-sub) .vz-link', 'p .vz-link'), all: [/running text/] },
  { id: 'V8', what: "a cut key link's underline removed (m2)", edit: css('.vz-link .vz-cut, .vz-link .vz-cut > * { text-decoration: inherit;', '.vz-link .vz-cut, .vz-link .vz-cut > * {'), all: [/underline/] },
  { id: 'V9', what: 'the reservation keyed on an inline style attribute again (m7)', edit: append('.vz-chart[style*="--legend-rows"] { min-height: var(--chart-plot); }'), all: [/inline style attribute/] },
  { id: 'V10', what: 'legend rows reserved a hairline taller than drawn (v5)', edit: css('.vz-table.vz-legend-table td { height: var(--legend-row);', '.vz-table.vz-legend-table td { height: calc(var(--legend-row) - var(--hairline));'), render: true, all: [/reserves .* and draws/] },
  { id: 'V11', what: 'after an error, swatches keep their colour (m3)', edit: css('.vz-chart[data-error] .vz-legend-table .vz-swatch { background: transparent;', '.vz-chart[data-error] .vz-legend-table .vz-swatch { background: var(--series);'), all: [/m3/] },
  { id: 'V12', what: 'series-other back to v5 (light #767676, 1.02:1 from series-4)', edit: tok('series-other', 'light', '#767676'), all: [/series-other beside series-4/] },
  { id: 'V13', what: 'the scroll edge back to an inset shadow under the cells (m14)', edit: css('.vz-table-wrap, .vz-nav, .vz-tabs { border-right: var(--stroke) solid transparent;', '.vz-table-wrap, .vz-nav, .vz-tabs { box-shadow: inset calc(-1 * var(--stroke)) 0 0 var(--rule-control);'), all: [/m14/] },
  { id: 'V14', what: 'status marks centred across lines, not on the first', edit: css('.vz-status { display: inline-flex; align-items: flex-start;', '.vz-status { display: inline-flex; align-items: center;'), all: [/first line/] },
  { id: 'V15', what: 'a kept column narrower than its phrase', edit: css('  .vz-table[data-fold] [data-priority="1"] { flex: 0 0 var(--keep); min-width: min-content;', '  .vz-table[data-fold] [data-priority="1"] { flex: 0 0 var(--keep); min-width: 0;'), all: [/longest phrase/] },
  { id: 'V17', what: "a status's words and its time side by side, not one run (the time leaves the line)", edit: file('project/components/Table/preview.html', '<span class="vz-status" data-state="critical"><span>Firing since <span class="vz-qty">13:07</span>, <span class="vz-qty">2 h 9 min</span></span></span>', '<span class="vz-status" data-state="critical">Firing since <span class="vz-qty">13:07</span>, <span class="vz-qty">2 h 9 min</span></span>'), args: ['project/components'], all: [/status-run/] },
  { id: 'V16', what: 'a shadow-overlay on a panel (the one shadow off an overlay)', edit: append('.vz-panel { box-shadow: var(--shadow-overlay); }'), all: [/overlays only/] },
  // ---- the Chart rules: tools/test/chart-rules.test.mjs must fail ----
  { id: 'C1', what: "v5's order: the view's filter applied before colours are assigned (image 01)", run: 'chart', edit: chart('assignSeries(map, result, { filteredOut: view.filteredOut })\n    for (const s of result) s.slot = slotOf(map, s.key) || 0\n    const listed = view.filter ? result.filter(view.filter) : result', 'const listed = view.filter ? result.filter(view.filter) : result\n    assignSeries(map, listed, { filteredOut: view.filteredOut })\n    for (const s of result) s.slot = slotOf(map, s.key) || 0') },
  { id: 'C2', what: 'a returning series that was in Other takes a free slot (the round trip is not the identity)', run: 'chart', edit: chart("const pool = series.filter((s) => !S[s.key])", "const pool = series.filter((s) => !S[s.key] || (!S[s.key].on && !S[s.key].slot))") },
  { id: 'C3', what: 'a returning series never gets its slot back (image 02)', run: 'chart', edit: chart("const e = S[s.key]; if (!holds.has(e.slot)) holds.set(e.slot, s.key); else pool.push(s) }", "pool.push(s) }") },
  { id: 'C4', what: 'new series never take a reserved slot (the largest grey while a slot is free)', run: 'chart', edit: chart("if (!slot) { let best = Infinity;", "if (false) { let best = Infinity;") },
  { id: 'C5', what: '"highest" over the coloured lines only (v4 B1)', run: 'chart', edit: chart("highestAt: (i) => drawn.filter(", "highestAt: (i) => vis.lines.filter(") },
  { id: 'C6', what: "the threshold's series over coloured lines only (M1, image 06)", run: 'chart', edit: chart("aboveAtEnd: drawn.filter(endAbove)", "aboveAtEnd: vis.lines.filter(endAbove)") },
  { id: 'C7', what: 'the note counted over the whole result, not the legend', run: 'chart', edit: chart("return { kind: 'by-size', coloured: m.coloured.length,", "return { kind: 'by-size', coloured: m.result.filter((s) => s.slot).length,") },
  { id: 'C8', what: 'a negative value loses its sign', run: 'chart', edit: chart("f = (v, d) => (v < 0 && abs(v, d) !== abs(0, d) ? MINUS : '')", "f = (v, d) => ('')") },
  { id: 'C9', what: 'the axis starts at zero whatever the data (image 07)', run: 'chart', edit: chart("let a = Math.min(from, lo, th ?? Infinity)", "let a = Math.max(0, Math.min(from, lo, th ?? Infinity))") },
  // ---- the rendered page audit: tools/audit.mjs must fail ----
  { id: 'A1', what: 'the hidden "Actions" head escapes the table (B2.1, image 03)', run: 'audit', edit: css('.vz-table-wrap { position: relative; overflow-x: auto;', '.vz-table-wrap { overflow-x: auto;'), args: ['dist/preview/Table.html'], all: [/escape|overflow/] },
  // Removing the status wrap alone does not cut the state any more: the kept column's min-content width then holds the unbroken words (a first
  // run of this corpus found A2 surviving that way, and a second, that both fold forms apply at 400 px). So A2 is v5's fold, in both forms.
  { id: 'A2', what: '"Burning budget" over "Actions…" in a kept column (B2.2, image 04): the wrap and the minimum width removed from both fold forms, as in v5', run: 'audit', edit: { file: 'src/components.css', edit: (s) => { let t = s; for (const f of ['[data-fold]', '[data-fold="wide"]']) { const a = `  .vz-table${f} [data-priority="1"] .vz-status { white-space: normal; }\n`, b = `  .vz-table${f} [data-priority="1"] { flex: 0 0 var(--keep); min-width: min-content;`; if (!t.includes(a) || !t.includes(b)) throw new Error('mutant does not apply'); t = t.replace(a, '').replace(b, `  .vz-table${f} [data-priority="1"] { flex: 0 0 var(--keep); min-width: 0;`) } return t } }, args: ['reviews/system-v6/compositions/dialog.html'], all: [/cut|fold-scroll/] },
  { id: 'A3', what: '"Actions…" off screen in a folded row (B2.2, image 04)', run: 'audit', edit: css('  .vz-table[data-fold="wide"] td.vz-row-actions:not([data-key]) { order: 1; flex: none; width: auto;', '  .vz-table[data-fold="wide"] td.vz-row-actions:not([data-key]) { order: 1; flex: none; width: 0;'), args: ['reviews/system-v6/compositions/dialog.html'], all: [/cut|fold-scroll|cell/] },
  { id: 'A4', what: 'a link in a help line drawn as a control (m1, image 08)', run: 'audit', edit: css(':is(p, li, dd, .vz-help, .vz-secondary, .vz-text, .vz-page-sub) .vz-link', 'p .vz-link'), args: ['reviews/system-v6/compositions/monitor.html'], all: [/sentence-link/] },
  // ---- harmless ----
  { id: 'H1', what: 'harmless: a rule reformatted across lines', edit: css('.vz-stack { display: flex; flex-direction: column;', '.vz-stack {\n  display: flex;\n  flex-direction: column;'), expect: 'pass' },
  { id: 'H2', what: 'harmless: a comment added', edit: append('/* a note */'), expect: 'pass' },
  { id: 'H3', what: 'harmless: a new rule written in tokens only', edit: append('.vz-example { gap: var(--space-2); padding: calc(2 * var(--space-1)) var(--space-3); border-top: var(--hairline) solid var(--rule); }'), expect: 'pass' },
  { id: 'H4', what: 'harmless: a data custom property in a style attribute', edit: file('project/components/Button/preview.html', '<div class="vz-stack">', '<div class="vz-stack" style="--legend-rows: 3">'), args: ['project/components'], expect: 'pass' },
]
