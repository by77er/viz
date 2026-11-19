/**
 * Calibration of the history CPU model (`src/history.ts` `CPU`): CPU time per point fed through
 * each kind of rule's evaluation in a streamed backtest, and per point of the engine's JSON parsed
 * and indexed by step (which the fake engine here does not do: it hands over built objects).
 * Run one case per process (`-t "K. anomaly ewma:"`) with `--config vitest.measure.config.ts --maxWorkers=1`.
 * CPU is workerd's thread time (`HOST`), with the fake engine's own CPU (building the windows'
 * matrices, measured alone afterwards over the same windows) taken off.
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { PromMatrix } from '../../contracts/engine'
import { byStep } from '../src/history'
import { MIN, ok, setup } from './helpers'

const HOUR = 60 * MIN
const DAY = 24 * HOUR
type Host = { ns: number; pids: number[]; loadavg: number[] }
const host = async () => (await (env as unknown as { HOST: Fetcher }).HOST.fetch('http://host/')).json() as Promise<Host>
async function cpu(fn: () => Promise<unknown>) {
  const a = await host()
  await fn()
  const b = await host()
  expect(b.pids.length, 'one workerd process').toBe(1)
  return { ms: (b.ns - a.ns) / 1e6, load: b.loadavg }
}
const SERIES = 100
const svc = (k: number) => `s${String(k).padStart(3, '0')}`
const SLI = { bad: 'sum by (svc) (increase(errors_total[$window]))', total: 'sum by (svc) (increase(requests_total[$window]))' }

function latency(start: number, end: number, step: number): PromMatrix {
  const result: PromMatrix['result'] = []
  for (let k = 0; k < SERIES; k++) {
    const values: [number, string][] = []
    for (let t = start; t <= end; t += step) {
      const m = Math.round(t / MIN)
      values.push([t / 1000, String((m + k * 13) % 10007 === 0 ? 400 : 100 + 30 * Math.sin((2 * Math.PI * m) / 1440) + ((m * 37 + k) % 7) - 3)])
    }
    result.push({ metric: { svc: svc(k) }, values })
  }
  return { resultType: 'matrix', result }
}

/** Level noise without a pattern (CUSUM learns σ from first differences; the sine and the 7-cycle above give it none). */
function noise(start: number, end: number, step: number): PromMatrix {
  const result: PromMatrix['result'] = []
  for (let k = 0; k < SERIES; k++) {
    const values: [number, string][] = []
    for (let t = start; t <= end; t += step) {
      const x = Math.sin((t / MIN) * 12.9898 + k * 78.233) * 43758.5453
      values.push([t / 1000, String(100 + 10 * (x - Math.floor(x)))])
    }
    result.push({ metric: { svc: svc(k) }, values })
  }
  return { resultType: 'matrix', result }
}

function slo(start: number, end: number, step: number): PromMatrix {
  const result: PromMatrix['result'] = []
  for (let k = 0; k < SERIES; k++) {
    const total: [number, string][] = []
    const bad: [number, string][] = []
    for (let t = start; t <= end; t += step) {
      total.push([t / 1000, String((1000 * step) / MIN)])
      bad.push([t / 1000, String(Math.round(t / MIN) % 3)])
    }
    result.push({ metric: { svc: svc(k), viz_slo_part: 'total' }, values: total }, { metric: { svc: svc(k), viz_slo_part: 'bad' }, values: bad })
  }
  return { resultType: 'matrix', result }
}

const CASES: Record<string, { interval: string; rule: Record<string, unknown> }> = {
  'threshold rule': { interval: '1m', rule: { alert: 'Hot', expr: 'latency_ms > 0', for: '2m' } },
  'anomaly ewma': { interval: '1m', rule: { alert: 'A', expr: 'latency_ms', anomaly: { detector: 'ewma', params: { halfLifePoints: 10, minPoints: 5 }, max_series: SERIES } } },
  'anomaly threshold': { interval: '1m', rule: { alert: 'A', expr: 'latency_ms', anomaly: { detector: 'threshold', params: { above: 300 }, max_series: SERIES } } },
  'anomaly robust_z': { interval: '1m', rule: { alert: 'A', expr: 'latency_ms', anomaly: { detector: 'robust_z', max_series: SERIES } } },
  'anomaly cusum': { interval: '1m', rule: { alert: 'A', expr: 'latency_ms', anomaly: { detector: 'cusum', params: { h: 10 }, max_series: SERIES } } },
  'anomaly seasonal': { interval: '5m', rule: { alert: 'A', expr: 'latency_ms', anomaly: { detector: 'seasonal', params: { periodMs: DAY }, max_series: SERIES } } },
  // A second size of each window-scanning detector, to check that their cost grows with their state (`CPU.anomalyPerStateByte`).
  'anomaly robust_z w72': { interval: '1m', rule: { alert: 'A', expr: 'latency_ms', anomaly: { detector: 'robust_z', params: { windowPoints: 72 }, max_series: SERIES } } },
  'anomaly seasonal 6h': { interval: '5m', rule: { alert: 'A', expr: 'latency_ms', anomaly: { detector: 'seasonal', params: { periodMs: 6 * HOUR }, max_series: SERIES } } },
  slo: { interval: '1m', rule: { alert: 'S', slo: { objective: 0.999, sli: SLI, max_series: SERIES } } },
}

describe('CPU model calibration', () => {
  for (const [name, c] of Object.entries(CASES)) {
    it(`K. ${name}: µs of CPU per point fed, a 2-day streamed backtest over ${SERIES} series`, async () => {
      const { tenant, stub, w } = await setup({ heartbeatMs: DAY })
      ok(await stub.configure(tenant, { limits: { maxAnomalyStateBytesPerRule: 16 << 20, maxAnomalyStateBytesPerObject: 256 << 20, maxBacktestCpuMs: 600_000 } } as never))
      const step = c.interval === '5m' ? 5 * MIN : MIN
      const to = Math.floor(Date.UTC(2099, 11, 31) / step) * step
      const from = to - 2 * DAY + step
      const make = (q: string, s: number, e: number, st: number) => (q.includes('viz_slo_part') ? slo(s, e, st) : name === 'anomaly cusum' ? noise(s, e, st) : latency(s, e, st))
      w.range = make
      // The series a read has at a step, for the ruler's series counts, without building the read twice.
      w.count = (q) => (q.includes('viz_slo_part') ? 2 * SERIES : SERIES)
      let res: { status: string; intervals?: unknown[] } | null = null
      const total = await cpu(async () => {
        res = (await stub.backtest(tenant, c.rule, from, to, step, step)) as never
      })
      expect(res!.status, JSON.stringify(res).slice(0, 300)).toBe('ok')
      const calls = w.rangeCalls.filter((c) => !c[0].startsWith('count('))
      const gen = await cpu(() => runInDurableObject(stub, () => calls.reduce((n, [q, a, b, st]) => n + make(q, a, b, st).result.length, 0)))
      const points = calls.reduce((n, [q, a, b, st]) => n + (Math.floor((b - a) / st) + 1) * (q.includes('viz_slo_part') ? 2 * SERIES : SERIES), 0)
      console.log(`| ${name} | ${points.toLocaleString('en-US')} | ${(total.ms - gen.ms).toFixed(0)} | ${(((total.ms - gen.ms) * 1000) / points).toFixed(2)} | ${calls.length} | ${total.load.map((x) => x.toFixed(1)).join(' ')} |`)
    })
  }

  it('K. parse: µs of CPU per point to parse a window of the engine\'s JSON and index it by step', async () => {
    const { stub } = await setup()
    const series = 100
    const steps = 2000
    await runInDurableObject(stub, (inst) => {
      const parts: string[] = []
      for (let s = 0; s < series; s++) {
        let values = ''
        for (let i = 0; i < steps; i++) values += `${i ? ',' : ''}[${4102444800 + i * 60},"${100 + ((i * 37 + s) % 7) - 3 + i / 1e3}"]`
        parts.push(`{"metric":{"svc":"s${s}","job":"checkout"},"values":[${values}]}`)
      }
      ;(inst as unknown as { text: string }).text = `{"resultType":"matrix","result":[${parts.join(',')}]}`
    })
    const c = await cpu(() => runInDurableObject(stub, async (inst) => {
      const m = (await new Response((inst as unknown as { text: string }).text).json()) as PromMatrix
      return byStep(m).size
    }))
    const points = series * steps
    console.log(`| parse + index | ${points.toLocaleString('en-US')} | ${c.ms.toFixed(0)} | ${((c.ms * 1000) / points).toFixed(2)} | 1 | ${c.load.map((x) => x.toFixed(1)).join(' ')} |`)
  })
})
