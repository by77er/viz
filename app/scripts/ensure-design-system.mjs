// Makes sure design-system/dist is there and current before the app is served or built.
// dist/ is generated and not committed, so a fresh checkout has none. It is generated only
// when a file the app takes from it is missing or older than what it is made from: a build of
// the app does not rewrite the design system's files under other work that is reading them.
import { existsSync, statSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../design-system/', import.meta.url))
const made = ['dist/viz.css', 'dist/viz-chart.js', 'dist/viz-press.js', 'dist/fonts/SchibstedGrotesk-Variable.woff2', 'dist/fonts/JetBrainsMono-Variable.woff2']
const from = ['project/tokens.json', 'src/components.css', 'src/press.js', 'project/components/Chart/preview.html', 'tools/build.mjs', 'tools/css.mjs', ...readdirSync(root + 'project/fonts').map((f) => 'project/fonts/' + f)]
const time = (f) => statSync(root + f).mtimeMs
const missing = made.filter((f) => !existsSync(root + f))
const newest = Math.max(...from.map(time))
const stale = missing.length === 0 ? made.filter((f) => time(f) < newest) : []
if (missing.length === 0 && stale.length === 0) {
  console.log('design-system/dist is current')
} else {
  console.log(`design-system/dist: ${missing.length ? `missing ${missing.join(', ')}` : `older than its source: ${stale.join(', ')}`}; generating`)
  const r = spawnSync(process.execPath, [root + 'tools/build.mjs'], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
