// Teeth for check.mjs: break each property it guards, on a copy, and confirm the check fails; then confirm a harmless reformatting passes.
//   node tools/mutants.mjs [workDir]      (default: a folder in the system temp directory; the source tree is never touched)
// Prints one row per mutant: what was broken, whether check.mjs caught it, and the first line it printed. Exits non-zero if any mutant
// survives or the harmless one is refused. R1 to R18 are the v4 review's (reviews/system-v4/review.md, "check.mjs mutants"); N1 to N13 are v5's.
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, loadavg, cpus } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = new URL('..', import.meta.url).pathname, work = process.argv[2] ?? join(tmpdir(), 'viz-mutants')
const tok = (name, theme, value) => ({ file: 'project/tokens.json', edit: (s) => { const j = JSON.parse(s), k = j.color.tokens.find((x) => x.name === name); if (typeof k.value === 'string') k.value = value; else k.value[theme] = value; return JSON.stringify(j, null, 2) } })
const css = (from, to) => ({ file: 'src/components.css', edit: (s) => { if (!s.includes(from)) throw new Error('mutant does not apply: ' + from); return s.replace(from, to) } })
const append = (text) => ({ file: 'src/components.css', edit: (s) => s + '\n' + text + '\n' })
const M = [
  // v4 review: caught then, must stay caught
  ['R1', 'swatch ring removed', css('background: var(--series); box-shadow: 0 0 0 var(--stroke) var(--ground); }', 'background: var(--series); }')],
  ['R2', 'pressed equal to hover (light)', tok('pressed', 'light', '#ededed')],
  ['R3', 'series-4 back to v3 #eda100 (light)', tok('series-4', 'light', '#eda100')],
  ['R4', 'crosshair dot edge to rule', css('stroke: var(--ground); stroke-width: var(--hairline); }\n.vz-plot .vz-dot-named', 'stroke: var(--rule); stroke-width: var(--hairline); }\n.vz-plot .vz-dot-named')],
  ['R5', 'status-info equal to blue (light)', tok('status-info', 'light', '#1257ff')],
  ['R6', 'two near-identical neighbours (series-3 a copy of series-2, light)', tok('series-3', 'light', '#bd6a2f')],
  ['R7', 'a literal 3px', append('.vz-panel-title { margin-top: 3px; }')],
  ['R8', 'series-other near white (light)', tok('series-other', 'light', '#e8e8e8')],
  // v4 review: survived then
  ['R9', 'swatch ring overridden on hover: tr:hover .vz-swatch { box-shadow: none }', append('.vz-table.vz-legend-table tr:hover .vz-swatch { box-shadow: none; }')],
  ['R10', 'ink-muted on pressed in the legend (the pressed override removed)', css('.vz-table.vz-legend-table tr[data-key]:active .vz-series-rest, ', '')],
  ['R11', 'ink-muted on rule in the legend (the chosen override removed)', css(', .vz-table.vz-legend-table tr[aria-selected="true"] .vz-series-rest {', ' {')],
  ['R12', 'the plot filled with hover on hover', append('.vz-plot:hover { background: var(--hover); }')],
  ['R13', 'series-8 set to status-critical (light)', tok('series-8', 'light', '#e0221b')],
  ['R14', 'a literal angle (deg)', append('.vz-mark[data-state="warn"] { transform: rotate(45deg); }')],
  ['R15', 'a literal percentage', append('.vz-skip:focus { left: 37%; }')],
  ['R16', 'a literal unitless weight', append('.vz-panel-title { font-weight: 600; }')],
  ['R17', 'an opaque scrim (light)', tok('scrim', 'light', 'rgba(17,17,17,1)')],
  ['R18', 'harmless: the swatch rule reformatted onto two lines (v4 misfired here)', css('.vz-swatch { display: inline-block; flex: none;', '.vz-swatch {\n  display: inline-block; flex: none;'), 'pass'],
  // v5
  ['N1', 'swatch ring removed on a pressed row only', append('.vz-table.vz-legend-table tbody tr[data-key]:active .vz-swatch { box-shadow: none; }')],
  ['N2', 'neighbours at one lightness (series-2 as dark as series-1, light)', tok('series-2', 'light', '#8a4f1f')],
  ['N3', 'slot 7 drawn solid (its dash removed)', css('[data-series="7"] { --series: var(--series-7); --pattern: var(--space-2) var(--space-1); }', '[data-series="7"] { --series: var(--series-7); }')],
  ['N4', 'lines that step back drawn in rule (too faint to follow)', css('.vz-plot[data-emph] .vz-series-g:not([data-emph-on]) .vz-line { stroke: var(--series-other);', '.vz-plot[data-emph] .vz-series-g:not([data-emph-on]) .vz-line { stroke: var(--rule);')],
  ['N5', 'a breakpoint that is not a token (800px)', append('@container (max-width: 799px) { .vz-split { gap: var(--space-6); } }')],
  ['N6', 'token-lint-ignore without a reason', append('.vz-panel-title { margin-top: 3px; } /* token-lint-ignore */')],
  ['N7', 'a series in the dark theme below 3:1 on rule', tok('series-1', 'dark', '#1f4f7a')],
  ['N8', 'chosen legend row text in ink-muted', append('.vz-table.vz-legend-table tr[aria-selected="true"] td { color: var(--ink-muted); }')],
  // v5, after the restart: the R10 survivor's cause, the legend ring, and the Waterfall and Log components
  ['N9', 'a waterfall bar drawn in rule (too faint to read as a span)', append('.vz-waterfall-bar { background: var(--rule); }')],
  ['N10', 'the legend row\'s ring back to an outline on the row (painted under its first cell)', css('.vz-table.vz-legend-table tr:has(.vz-series:focus-visible) td:first-child {', '.vz-table.vz-legend-table tr:has(.vz-series:focus-visible) { outline: var(--stroke) solid var(--focus); }\n.vz-legend-unused td:first-child {')],
  ['N11', 'a matched search term in ink-muted (4.19:1 on its rule fill)', append('.vz-match { color: var(--ink-muted); }')],
  ['N12', '"3 spans inside" in ink-muted (3.67:1 when its row is pressed)', append('.vz-waterfall-inside { color: var(--ink-muted); }')],
  ['N13', 'a literal line count for a cut log message', append('.vz-log-text { -webkit-line-clamp: 4; }')],
]
const load = loadavg().map((x) => x.toFixed(2)).join(' '), rows = []
let bad = 0
for (const [id, what, m, expect = 'fail'] of M) {
  rmSync(work, { recursive: true, force: true }); mkdirSync(join(work, 'project'), { recursive: true })
  for (const p of ['tools', 'src', 'project/components', 'project/tokens.json']) cpSync(join(root, p), join(work, p), { recursive: true })
  const f = join(work, m.file); writeFileSync(f, m.edit(readFileSync(f, 'utf8')))
  const r = spawnSync('node', [join(work, 'tools/check.mjs')], { encoding: 'utf8', cwd: work }), out = (r.stdout + r.stderr).split('\n')
  const first = out.find((l) => /^(FAIL|LITERAL)/.test(l)) ?? '', got = r.status === 0 ? 'pass' : 'fail', ok = got === expect
  if (!ok) bad++
  rows.push(`| ${id} | ${what} | ${expect === 'fail' ? 'caught' : 'passes'} | ${ok ? (expect === 'fail' ? 'caught' : 'passes') : '**' + (expect === 'fail' ? 'SURVIVED' : 'REFUSED') + '**'} | ${first.replace(/\|/g, '\\|').slice(0, 150)} |`)
  process.stdout.write(`\r${rows.length}/${M.length}`)
}
rmSync(work, { recursive: true, force: true })
console.log(`\n\nload average ${load} on ${cpus().length} cores\n\n| Mutant | What was broken | Expected | Result | First line check.mjs printed |\n|---|---|---|---|---|\n` + rows.join('\n'))
console.log(bad ? `\n${bad} mutant(s) not as expected.` : `\nEvery mutant caught; the harmless change passes.`)
process.exit(bad ? 1 : 0)
