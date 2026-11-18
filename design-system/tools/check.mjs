// Checks the token system against its own rules. Exits non-zero on any failure.
//   1. Contrast: every text, control and mark pairing the components use meets its floor in every theme.
//   2. Source lint: no literal colours, lengths, durations or opacity in component CSS (or in paths given as arguments).
//      In .ts, .tsx, .js and .html files colours are linted everywhere, and lengths and durations inside quoted strings.
//      A line with `token-lint-ignore` is skipped; say why on the same line.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
const root = new URL('..', import.meta.url).pathname
const t = JSON.parse(readFileSync(root + 'project/tokens.json', 'utf8'))
const themes = t.color.themes.map((x) => x.id)
const col = Object.fromEntries(t.color.tokens.map((k) => [k.name, k.value]))
const v = (name, th) => (typeof col[name] === 'string' ? col[name] : col[name][th])
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const surfaces = ['ground', 'sunken', 'raised', 'hover']
const tones = ['blue', 'red', 'green', 'yellow']
// [foreground, backgrounds, floor, why, themes?]
const pairs = [
  ...['ink', 'ink-secondary', 'ink-muted'].map((f) => [f, surfaces, 4.5, 'text']),
  ['ink', ['rule'], 4.5, 'chosen segment, pressed secondary button'],
  ['ground', ['ink'], 4.5, 'tooltip text'],
  ['rule-control', ['ground', 'sunken', 'raised'], 3, 'control border'],
  ['focus', [...surfaces, 'rule'], 3, 'focus ring'],
  ...tones.map((c) => [`on-${c}`, [c, `${c}-hover`, `${c}-pressed`], 4.5, 'button label and keyboard hint']),
  ...['blue', 'red', 'green'].map((c) => [c, ['ground', 'sunken', 'raised'], 3, 'button edge']),
  ...['status-critical', 'status-ok', 'status-info', 'status-warn-edge'].map((c) => [c, surfaces, 3, 'status mark']),
  ['status-warn', surfaces, 3, 'status mark', ['dark']],
  // v4. Series are drawn on ground and raised, across sunken (intervals, the Other band, a range being selected), and never on hover: the legend swatch carries its own ground edge.
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => [`series-${i}`, ['ground', 'raised', 'sunken'], 3, 'chart series']),
  ['series-other', ['ground', 'raised', 'sunken'], 3, 'edge of the Other band, switched-off swatch'],
  ['yellow-edge', ['ground', 'sunken', 'raised'], 3, 'edge of a yellow button'],
  ['ink-secondary', ['ground', 'sunken', 'raised', 'hover', 'rule'], 3, 'acknowledged and silenced marks, threshold line'],
  ['ink-muted', ['ground', 'sunken', 'raised', 'hover', 'rule'], 3, 'ruled-out mark, claim rule, chart markers and leader ticks'],
  ['ink-secondary', ['sunken'], 4.5, 'words on a shaded interval'],
  ['ink-secondary', ['rule'], 4.5, 'second part of a chosen or pressed legend row (muted text is not allowed on rule: 4.19:1)'],
  ['ink', ['ground', 'raised'], 3, 'crosshair, edges of a range being selected, a picked member of Other'],
  ['rule-control', ['sunken'], 3, 'edges of a shaded interval'],
]
// The series palette is also an ordered set: neighbours must stay apart (distance in OKLab, times 100, at least 15). A cheap guard
// between runs of the full colour-vision validator; the command is in reviews/system-v4/CHANGES.md.
const oklab = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b); return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s] }
const dE = (a, b) => { const [x, y] = [oklab(a), oklab(b)]; return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) }
let failed = 0, checked = 0
for (const [fg, bgs, floor, why, only] of pairs) for (const bg of bgs) for (const th of only ?? themes) {
  const r = ratio(v(fg, th), v(bg, th)); checked++
  if (r < floor) { failed++; console.log(`FAIL  ${fg} on ${bg} [${th}]  ${r.toFixed(2)} < ${floor}  (${why})`) }
}
for (const th of themes) for (let i = 1; i < 8; i++) { const d = dE(v(`series-${i}`, th), v(`series-${i + 1}`, th)); checked++; if (d < 15) { failed++; console.log(`FAIL  series-${i} beside series-${i + 1} [${th}]  distance ${d.toFixed(1)} < 15  (neighbouring series)`) } }
for (const th of themes) { checked++; if (v('status-info', th) === v('blue', th)) { failed++; console.log(`FAIL  status-info equals blue [${th}]: a status must not look like the primary action`) } }
console.log(`contrast: ${checked - failed}/${checked} pairings pass`)

const targets = process.argv.slice(2).length ? process.argv.slice(2) : [root + 'src/components.css']
const files = []
const walk = (p) => { const s = statSync(p); if (s.isDirectory()) { for (const f of readdirSync(p)) if (!['node_modules', 'dist', '.wrangler'].includes(f)) walk(join(p, f)) } else if (['.css', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.html'].includes(extname(p))) files.push(p) }
targets.forEach(walk)
const rules = [
  ['colour', /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\(/g],
  ['length', /(?<![\w-])\d*\.?\d+(?:px|rem|em)\b/g],
  ['duration', /(?<![\w-])\d*\.?\d+ms\b|(?<![\w-])\d*\.\d+s\b|(?<![\w-])[1-9]\d*s\b/g],
  ['opacity', /\bopacity\s*:/g],
]
let hits = 0
for (const f of files) {
  const css = extname(f) === '.css'
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (/token-lint-ignore/.test(line)) return
    const code = line.replace(/\/\*.*?\*\//g, '')
    // In script and markup only the text inside quotes is linted for lengths and durations (inline styles, class strings); colours are linted everywhere.
    const test = /\.test\.[a-z]+$/.test(f) // test files hold query text such as "rate(x[30s])"; only colours are linted there
    const quoted = test ? '' : (code.match(/(['"`])(?:(?!\1).)*\1/g) ?? []).join(' ')
    for (const [kind, re] of rules) { if (!css && kind === 'opacity') continue; const m = (css || kind === 'colour' ? code : quoted).match(re); if (m) { hits += m.length; console.log(`LITERAL ${kind}  ${f.replace(root, '')}:${i + 1}  ${m.join(' ')}`) } }
  })
}
console.log(`literal values: ${hits} in ${files.length} file(s)`)
process.exit(failed || hits ? 1 : 0)
