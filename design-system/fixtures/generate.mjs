// Deterministic data for the fixture dashboard. The recipes are the ones in the Chart preview (one source): this module runs that
// script without a page and calls its generators, so the reference chart, the fixture and the compositions draw the same numbers.
//   node fixtures/generate.mjs            -> lists the panels
//   node fixtures/generate.mjs pods       -> the JSON for one panel
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const root = new URL('..', import.meta.url).pathname
export const dashboard = JSON.parse(readFileSync(root + 'fixtures/dashboard.json', 'utf8'))
export const chartScript = readFileSync(root + 'project/components/Chart/preview.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]
const win = {}
vm.runInNewContext(chartScript, { window: win, document: { readyState: 'complete', querySelectorAll: () => [] }, sessionStorage: { getItem: () => null, setItem() {} }, Date, Math, JSON, Set, Object, String, console })
export function generate(panel) {
  const d = win.vzChartDemos
  const spec = panel.recipe === 'many' ? d.many(panel.series ?? 36, panel.seed ?? 36) : d[panel.recipe]()
  if (panel.scale) for (const s of spec.series) s.values = s.values.map((v) => (v == null ? null : +(v * panel.scale).toFixed(4)))
  if (panel.unit) spec.unit = panel.unit
  return spec
}
if (process.argv[1] && process.argv[1].endsWith('generate.mjs')) {
  const id = process.argv[2]
  if (!id) for (const p of dashboard.panels) console.log(`${p.id.padEnd(10)} ${p.kind.padEnd(6)} ${String(p.series ?? p.rows ?? p.stats.length).padStart(4)}  ${p.title}`)
  else console.log(JSON.stringify(generate(dashboard.panels.find((p) => p.id === id))))
}
