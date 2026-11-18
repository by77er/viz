// Checks the token system against its own rules. Exits non-zero on any failure.
//   1. Contrast: every text, control and mark pairing the components use meets its floor in every theme.
//   2. Source lint: no literal colours, lengths, durations or opacity in component CSS (or in paths given as arguments).
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
]
let failed = 0, checked = 0
for (const [fg, bgs, floor, why, only] of pairs) for (const bg of bgs) for (const th of only ?? themes) {
  const r = ratio(v(fg, th), v(bg, th)); checked++
  if (r < floor) { failed++; console.log(`FAIL  ${fg} on ${bg} [${th}]  ${r.toFixed(2)} < ${floor}  (${why})`) }
}
console.log(`contrast: ${checked - failed}/${checked} pairings pass`)

const targets = process.argv.slice(2).length ? process.argv.slice(2) : [root + 'src/components.css']
const files = []
const walk = (p) => { const s = statSync(p); if (s.isDirectory()) { for (const f of readdirSync(p)) if (!['node_modules', 'dist', '.wrangler'].includes(f)) walk(join(p, f)) } else if (['.css', '.tsx', '.ts', '.jsx'].includes(extname(p))) files.push(p) }
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
    for (const [kind, re] of css ? rules : rules.slice(0, 1)) { const m = code.match(re); if (m) { hits += m.length; console.log(`LITERAL ${kind}  ${f.replace(root, '')}:${i + 1}  ${m.join(' ')}`) } }
  })
}
console.log(`literal values: ${hits} in ${files.length} file(s)`)
process.exit(failed || hits ? 1 : 0)
