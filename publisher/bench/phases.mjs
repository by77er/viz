// Join the benchmark's `PHASE <ms> <name> <json>` lines (its output) with the resident memory
// samples `RSS <ms> <largest process MB> <all MB>` that ../ledger/bench/rss.mjs wrote, and print
// for each phase: the largest process's RSS when it began, its peak during the phase, and the
// growth. Usage: node bench/phases.mjs <bench output> <rss log>
import { readFileSync } from 'node:fs'

const [out, rssLog] = process.argv.slice(2)
const phases = [...readFileSync(out, 'utf8').matchAll(/^PHASE (\d+) (\S+) (.*)$/gm)].map((m) => ({ at: Number(m[1]), name: m[2], extra: m[3] }))
const rss = [...readFileSync(rssLog, 'utf8').matchAll(/^RSS (\d+) (\d+) (\d+)$/gm)].map((m) => ({ at: Number(m[1]), mb: Number(m[2]) }))
const at = (t) => rss.filter((r) => r.at <= t).at(-1)?.mb ?? 0
const rows = []
for (const [i, p] of phases.entries()) {
  if (p.name.endsWith(':end')) continue
  const end = phases.slice(i + 1).find((q) => q.name === `${p.name}:end` || !q.name.startsWith(p.name))?.at ?? Infinity
  const during = rss.filter((r) => r.at >= p.at && r.at <= end).map((r) => r.mb)
  const start = at(p.at)
  const peak = Math.max(start, ...during)
  rows.push({ phase: p.name, startMB: start, peakMB: peak, growthMB: peak - start, extra: p.extra })
}
console.log('| Phase | RSS at start (MB) | Peak (MB) | Growth (MB) |\n|---|---|---|---|')
for (const r of rows) console.log(`| ${r.phase} | ${r.startMB} | ${r.peakMB} | +${r.growthMB} |`)
console.log(`process peak ${Math.max(...rss.map((r) => r.mb))} MB`)
