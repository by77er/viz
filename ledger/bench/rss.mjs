// Run a command and sample the resident memory of its process tree every 100 ms (Linux /proc).
// Prints `RSS <ms> <largest process MB> <all processes MB>` lines to rss.log in the current
// directory and the peak at the end. Used for the "peak memory" column of the ledger README.
//   node bench/rss.mjs -- npm run bench
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'

const args = process.argv.slice(process.argv.indexOf('--') + 1)
const child = spawn(args[0], args.slice(1), { stdio: 'inherit', env: process.env })
const out = process.env.RSS_LOG ?? 'rss.log'
writeFileSync(out, '')
const page = 4096
function tree(root) {
  const kids = new Map()
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      if (!kids.has(ppid)) kids.set(ppid, [])
      kids.get(ppid).push(Number(d))
    } catch {}
  }
  const all = []
  const walk = (p) => { all.push(p); for (const c of kids.get(p) ?? []) walk(c) }
  walk(root)
  return all
}
let peak = 0
let peakAll = 0
const timer = setInterval(() => {
  let largest = 0
  let total = 0
  for (const p of tree(child.pid)) {
    try {
      const rss = Number(readFileSync(`/proc/${p}/statm`, 'utf8').split(' ')[1]) * page
      largest = Math.max(largest, rss)
      total += rss
    } catch {}
  }
  peak = Math.max(peak, largest)
  peakAll = Math.max(peakAll, total)
  appendFileSync(out, `RSS ${Date.now()} ${(largest / 1e6).toFixed(0)} ${(total / 1e6).toFixed(0)}\n`)
}, 100)
child.on('exit', (code) => {
  clearInterval(timer)
  console.log(`RSS peak: largest process ${(peak / 1e6).toFixed(0)} MB, all ${(peakAll / 1e6).toFixed(0)} MB`)
  process.exit(code ?? 1)
})
