import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Measurements (`npm run bench:anomaly`): `test/*.bench.ts` in workerd, as the test suite runs,
// plus `HOST`, a service binding answered here in Node, because code inside workerd cannot see
// CPU time (its clocks move only across I/O) or the machine's load.
//
// `HOST` answers the CPU time, in nanoseconds, of every thread of the workerd processes that this
// vitest process started (`/proc/<pid>/task/<tid>/schedstat`, first field), and the load average.
// Run with one worker, so that one workerd serves the measuring file and nothing else.

/** Resident memory of the workerd processes this vitest started, in kB (`/proc/<pid>/status` VmRSS and VmHWM, its peak). */
function workerdRss(pids: number[]): { rssKb: number; peakKb: number } {
  let rssKb = 0
  let peakKb = 0
  for (const pid of pids) {
    try {
      const st = readFileSync(`/proc/${pid}/status`, 'utf8')
      rssKb += Number(/VmRSS:\s+(\d+)/.exec(st)?.[1] ?? 0)
      peakKb += Number(/VmHWM:\s+(\d+)/.exec(st)?.[1] ?? 0)
    } catch {
      // the process went away
    }
  }
  return { rssKb, peakKb }
}

function workerdCpu(): { ns: number; pids: number[] } {
  const pids: number[] = []
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      const m = /^\d+ \((.*)\) \S (\d+)/.exec(readFileSync(`/proc/${d}/stat`, 'utf8'))
      if (m && m[1] === 'workerd' && Number(m[2]) === process.pid) pids.push(Number(d))
    } catch {
      // the process went away
    }
  }
  let ns = 0
  for (const pid of pids) {
    for (const t of readdirSync(`/proc/${pid}/task`)) {
      try {
        ns += Number(readFileSync(`/proc/${pid}/task/${t}/schedstat`, 'utf8').split(' ')[0])
      } catch {
        // the thread ended
      }
    }
  }
  return { ns, pids }
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: {
        serviceBindings: {
          HOST: async (request: Request) => {
            const cpu = workerdCpu()
            // `?reset`: start a new peak (VmHWM) for the workerd processes ("5" to clear_refs, proc(5)).
            if (new URL(request.url).searchParams.has('reset')) for (const pid of cpu.pids) writeFileSync(`/proc/${pid}/clear_refs`, '5')
            return Response.json({ ...cpu, ...workerdRss(cpu.pids), loadavg: loadavg() })
          },
          CAPTURE: async () => new Response('not captured in measurements', { status: 400 }),
        },
      },
    }),
  ],
  test: { include: ['test/**/*.bench.ts'], testTimeout: 1_200_000 },
})
