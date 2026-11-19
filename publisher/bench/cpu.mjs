// Run a command and sample the CPU time (user + system, from /proc/<pid>/stat) of every process in
// its tree every 50 ms. Prints `CPU <epoch ms> <ticks of the workerd processes> <ticks of all>` lines
// to $CPU_LOG (default cpu.log). Ticks are 1/100 s (`getconf CLK_TCK`). With the upgrade bench's
// `PUBLISH` lines, which carry each publish's start and end (epoch ms), `node bench/cpu.mjs --report
// <bench output> <cpu log>` prints the CPU that workerd (the publisher, its SQLite, the simulated R2
// and the test runner, all in one process) spent during each publish. Linux only.
//   CPU_LOG=cpu.log node bench/cpu.mjs -- npx vitest run -c vitest.bench.config.ts bench/upgrade.bench.test.ts --disableConsoleIntercept > out.txt
import { spawn } from 'node:child_process'
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'

if (process.argv[2] === '--report') {
  const [bench, log] = process.argv.slice(3)
  const samples = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').slice(1).map(Number))
  /** workerd's ticks at the last sample at or before `t`. */
  const at = (t) => {
    let v = samples[0][1]
    for (const [ms, busy] of samples) {
      if (ms > t) break
      v = busy
    }
    return v
  }
  for (const line of readFileSync(bench, 'utf8').split('\n')) {
    if (!line.startsWith('PUBLISH ')) continue
    const p = JSON.parse(line.slice('PUBLISH '.length))
    const cpu = (at(p.end) - at(p.start)) / 100
    console.log(`${p.case} ${p.step} ${p.i}: wall ${(p.ms / 1000).toFixed(2)} s, cpu ${cpu.toFixed(2)} s, staged ${p.staged}, rebased ${p.rebased}, added ${JSON.stringify(p.added)}`)
  }
  process.exit(0)
}

const args = process.argv.slice(process.argv.indexOf('--') + 1)
const child = spawn(args[0], args.slice(1), { stdio: 'inherit', env: process.env })
const out = process.env.CPU_LOG ?? 'cpu.log'
writeFileSync(out, '')
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
  const walk = (p) => {
    all.push(p)
    for (const k of kids.get(p) ?? []) walk(k)
  }
  walk(root)
  return all
}
/** A process's name and CPU ticks so far (utime + stime). */
const ticks = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return { comm: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')), t: Number(f[11]) + Number(f[12]) }
  } catch {
    return { comm: '', t: 0 }
  }
}
const timer = setInterval(() => {
  let workerd = 0
  let all = 0
  for (const p of tree(child.pid)) {
    const { comm, t } = ticks(p)
    if (comm === 'workerd') workerd += t
    all += t
  }
  appendFileSync(out, `CPU ${Date.now()} ${workerd} ${all}\n`)
}, 50)
child.on('exit', (code) => {
  clearInterval(timer)
  process.exit(code ?? 1)
})
