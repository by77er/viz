// Checks the token system against its own rules. Exits non-zero on any failure.
//   1. Contrast: every text and control pairing meets its floor in every theme.
//   2. Source lint: no literal colours in component CSS (or in any path given as arguments).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
const root = new URL('..', import.meta.url).pathname
const t = JSON.parse(readFileSync(root + 'project/tokens.json', 'utf8'))
const themes = t.color.themes.map((x) => x.id)
const col = Object.fromEntries(t.color.tokens.map((k) => [k.name, k.value]))
const v = (name, th) => (typeof col[name] === 'string' ? col[name] : col[name][th])
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const surfaces = ['ground', 'sunken', 'raised']
// [foreground, backgrounds, floor, why]
const pairs = [
  ...['ink', 'ink-secondary', 'ink-muted'].map((f) => [f, surfaces, 4.5, 'text']),
  ['rule-control', surfaces, 3, 'control border'],
  ['focus', surfaces, 3, 'focus ring'],
  ['on-blue', ['blue', 'blue-hover'], 4.5, 'button label'],
  ['on-red', ['red', 'red-hover'], 4.5, 'button label'],
  ['on-green', ['green', 'green-hover'], 4.5, 'button label'],
  ['on-yellow', ['yellow', 'yellow-hover'], 4.5, 'button label'],
  ['blue', surfaces, 3, 'button and status mark edge'],
  ['red', surfaces, 3, 'button and status mark edge'],
  ['green', surfaces, 3, 'button and status mark edge'],
]
let failed = 0, checked = 0
for (const [fg, bgs, floor, why] of pairs) for (const bg of bgs) for (const th of themes) {
  const r = ratio(v(fg, th), v(bg, th)); checked++
  if (r < floor) { failed++; console.log(`FAIL  ${fg} on ${bg} [${th}]  ${r.toFixed(2)} < ${floor}  (${why})`) }
}
// Known and documented exception: yellow has no 3:1 edge on light surfaces, so the status mark draws a rule-control edge.
console.log(`contrast: ${checked - failed}/${checked} pairings pass`)

const targets = process.argv.slice(2).length ? process.argv.slice(2) : [root + 'project/components/bundle.css']
const files = []
const walk = (p) => { const s = statSync(p); if (s.isDirectory()) { for (const f of readdirSync(p)) if (!['node_modules', 'dist', '.wrangler'].includes(f)) walk(join(p, f)) } else if (['.css', '.tsx', '.ts', '.jsx'].includes(extname(p))) files.push(p) }
targets.forEach(walk)
const literal = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\(/g
let hits = 0
for (const f of files) readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
  if (/token-lint-ignore/.test(line)) return
  const m = line.match(literal); if (m) { hits += m.length; console.log(`LITERAL  ${f.replace(root, '')}:${i + 1}  ${m.join(' ')}`) }
})
console.log(`literal colours: ${hits} in ${files.length} file(s)`)
process.exit(failed || hits ? 1 : 0)
