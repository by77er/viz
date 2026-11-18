/* eslint-disable */
// "Tests must have teeth" (AGENTS.md, Evidence): break one property at a time in the source,
// rebuild, run e2e/design.cjs, and record which checks fail. The source is restored after
// every mutant. A mutant that no check catches is reported as SURVIVED.
//   VIZ_E2E_APP_PORT=... VIZ_E2E_MOCK_PORT=... node e2e/mutants.cjs
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const ROOT = path.resolve(__dirname, '..')
const mutants = [
  ['a second blue button (Save settings)', 'src/shell/SettingsPanel.tsx', '<button type="submit" className="vz-button">', '<button type="submit" className="vz-button" data-tone="blue">'],
  ['a literal colour in app CSS', 'src/app.css', '.cell-quiet { color: var(--ink-secondary); }', '.cell-quiet { color: #777777; }'],
  ['the second press is not ignored', 'src/explore/ExplorePage.tsx', 'if (loadingRef.current) return', 'if (false) return'],
  ['progress shown after 100 ms', 'src/explore/waiting.tsx', 'showAfter: 400,', 'showAfter: 100,'],
  ['progress not held for 300 ms', 'src/explore/waiting.tsx', 'minShown: 300,', 'minShown: 0,'],
  ['Cancel offered after 500 ms', 'src/explore/waiting.tsx', 'cancelAfter: 2000,', 'cancelAfter: 500,'],
  ['Cancel does not abort the request', 'src/explore/ExplorePage.tsx', 'void queryClient.cancelQueries({ queryKey: keyRef.current })', 'void 0'],
  ['rows of controls 4 px apart', 'src/app.css', '.toolbar-group { position: relative; display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-3) var(--space-2); }', '.toolbar-group { position: relative; display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-1) var(--space-2); }'],
  ['no focus ring on the query editor', 'src/app.css', '.query-well:focus-within { outline: var(--stroke) solid var(--focus); outline-offset: var(--stroke); }', ''],
  ['toolbar fields do not shrink or wrap (sideways scroll at 400 px)', 'src/app.css', '.toolbar .vz-field { max-width: 100%; }', '.toolbar .vz-field { flex: none; }'],
  ['the popover does not take focus', 'src/explore/TimeRangePicker.tsx', "(menuRef.current?.querySelector<HTMLElement>('[aria-current]') ?? items?.[0])?.focus()", 'void items'],
  ['legend rows stay 32 px with a coarse pointer', 'src/app.css', '  .legend-table td, .series-toggle { height: var(--control-touch); }', '  .legend-table td, .series-toggle { height: var(--row); }'],
]
const out = []
const only = process.env.ONLY // a substring of a mutant's name, to run just that one
for (const [name, file, from, to] of mutants) {
  if (only && !name.includes(only)) continue
  const p = path.join(ROOT, file)
  const original = fs.readFileSync(p, 'utf8')
  if (!original.includes(from)) { out.push(`NOT APPLIED  ${name}: source text not found`); continue }
  fs.writeFileSync(p, original.replace(from, to))
  try {
    const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { cwd: ROOT, encoding: 'utf8' })
    if (build.status !== 0) { out.push(`NOT BUILT    ${name}`); continue }
    const run = spawnSync(process.execPath, ['e2e/design.cjs'], { cwd: ROOT, encoding: 'utf8', env: process.env })
    const fails = run.stdout.split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.slice(6).split('  — ')[0])
    out.push(`${fails.length ? 'KILLED  ' : 'SURVIVED'}  ${name}${fails.length ? `\n            caught by: ${fails.join('; ')}` : ''}`)
  } finally {
    fs.writeFileSync(p, original)
  }
  console.log(out[out.length - 1])
}
spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { cwd: ROOT })
fs.mkdirSync(path.join(ROOT, 'e2e/measurements'), { recursive: true })
if (!only) fs.writeFileSync(path.join(ROOT, 'e2e/measurements/mutants.txt'), out.join('\n') + '\n')
