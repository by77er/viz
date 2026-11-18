// Generates dist/tokens.css and dist/viz.css from project/tokens.json and project/components/bundle.css.
// tokens.json is the single source of every value; nothing in dist/ is edited by hand.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
const root = new URL('..', import.meta.url).pathname
const t = JSON.parse(readFileSync(root + 'project/tokens.json', 'utf8'))
const themes = t.color.themes.map((x) => x.id)
const val = (tok, th) => (typeof tok.value === 'string' ? tok.value : tok.value[th] ?? tok.value[themes[0]])
const themed = [...t.color.tokens, ...(t.shadow?.tokens ?? [])]
const block = (th) => themed.map((k) => `  --${k.name}: ${val(k, th)};`).join('\n')
const flat = ['spacing', 'radius', 'size'].flatMap((f) => t[f]?.tokens ?? []).map((k) => `  --${k.name}: ${k.value};`).join('\n')
const fams = Object.entries(t.type.families).map(([k, v]) => `  --font-${k}: ${v};`).join('\n')
const styles = t.type.groups.flatMap((g) => g.styles.map((s) => `.${s.name} { font-family: var(--font-${s.family ?? g.family}); font-size: ${s.fontSize}; line-height: ${s.lineHeight}; font-weight: ${s.fontWeight};${s.letterSpacing ? ` letter-spacing: ${s.letterSpacing};` : ''}${s.opticalSize ? ` font-variation-settings: 'opsz' ${s.opticalSize};` : ''} }`)).join('\n')
const css = `/* viz — generated from tokens.json */
:root, [data-theme="${themes[0]}"] {\n${block(themes[0])}\n  color-scheme: light;\n}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {\n${block('dark')}\n  color-scheme: dark;\n} }
[data-theme="dark"] {\n${block('dark')}\n  color-scheme: dark;\n}
:root {\n${flat}\n${fams}\n}
${styles}
`
mkdirSync(root + 'dist', { recursive: true })
writeFileSync(root + 'dist/tokens.css', css)
// viz.css = tokens + components, for consumers that want one file. The font @import must stay first.
const bundle = readFileSync(root + 'project/components/bundle.css', 'utf8')
const imp = bundle.match(/^@import[^\n]*\n/)?.[0] ?? ''
writeFileSync(root + 'dist/viz.css', imp + css + bundle.replace(imp, ''))
console.log('wrote dist/tokens.css and dist/viz.css')
