/**
 * What SLO rules, warm-ups and backtests cost the ruler's Durable Object, measured in workerd under
 * the vitest pool (`npm run bench:history`, one worker):
 *
 *   T. one alarm tick of a group holding one SLO rule (the SRE Workbook's four alerts, 99.9% over
 *      30 days, 1-minute interval: a 4,320-bucket ring and a 720-bucket ring per series), warm,
 *      at 1, 10 and 100 series, against the counterfactual of the same group with one alerting
 *      rule whose result is empty; and the warm-up (the first tick) of the same rule;
 *   B. a 7-day backtest at 1 minute over 100 and 1,000 series, streamed in windows (part 13): a
 *      threshold rule, an EWMA anomaly rule and an SLO rule; one case per process (`-t "B. ewma 1000:"`),
 *      the peak resident memory reset before it; run under `MINIFLARE_WORKERD_V8_FLAGS=--max-old-space-size=128`
 *      to hold workerd to a Durable Object's heap;
 *   B1. the counterfactual: the same with each read in one window (a 4 GiB budget).
 *
 * CPU is the workerd process's thread time from `/proc` (the `HOST` binding in
 * `vitest.measure.config.ts`), which includes the RPC into the object and the fake engine's work
 * (building each tick's result, and each backtest or warm-up window's matrix: that part is measured
 * alone afterwards over the same windows and reported beside it). Peak memory is VmHWM.
 */
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { PromMatrix } from '../../contracts/engine'
import type { SloRuleV2 } from '../contracts-proposal/rules.v2'
import { CPU } from '../src/history'
import { DEFAULT_RULER_CONFIG } from '../src/ruler'
import { parseRuleFile } from '../src/rules'
import { world } from './harness'
import { MIN, ok, setup, vec } from './helpers'

const HOUR = 60 * MIN
const DAY = 24 * HOUR
type Host = { ns: number; pids: number[]; loadavg: number[]; rssKb: number; peakKb: number }
const host = async (reset = false) => (await (env as unknown as { HOST: Fetcher }).HOST.fetch(`http://host/${reset ? '?reset' : ''}`)).json() as Promise<Host>
const range = (xs: number[], digits = 2) => (Math.min(...xs) === Math.max(...xs) ? Math.min(...xs).toFixed(digits) : `${Math.min(...xs).toFixed(digits)}–${Math.max(...xs).toFixed(digits)}`)
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!
const load = (l: number[]) => l.map((x) => x.toFixed(1)).join(' ')

async function measure(fn: () => Promise<unknown>) {
  const a = await host()
  const t = Date.now()
  await fn()
  const wallMs = Date.now() - t
  const b = await host()
  expect(b.pids.length, 'exactly one workerd process (run with --maxWorkers=1)').toBe(1)
  return { cpuMs: (b.ns - a.ns) / 1e6, wallMs, load: b.loadavg, peakMb: b.peakKb / 1024 }
}

const note = (line: string) => console.log(line)
const SLI = { bad: 'sum by (svc) (increase(errors_total[$window]))', total: 'sum by (svc) (increase(requests_total[$window]))' }
const svc = (k: number) => `s${String(k).padStart(3, '0')}`
/** Errors per bucket: a trickle, and a burst on a few services now and then. */
const badAt = (k: number, t: number) => {
  const m = Math.round(t / MIN)
  return (m + k * 37) % 977 < 4 && k % 7 === 0 ? 400 : m % 3
}

function sloMatrix(series: number, start: number, end: number, step: number): PromMatrix {
  const result: PromMatrix['result'] = []
  const width = step / MIN
  for (let k = 0; k < series; k++) {
    const total: [number, string][] = []
    const bad: [number, string][] = []
    for (let t = start; t <= end; t += step) {
      total.push([t / 1000, String(1000 * width)])
      let b = 0
      for (let x = t - step + MIN; x <= t; x += MIN) b += badAt(k, x)
      bad.push([t / 1000, String(b)])
    }
    result.push({ metric: { svc: svc(k), viz_slo_part: 'total' }, values: total }, { metric: { svc: svc(k), viz_slo_part: 'bad' }, values: bad })
  }
  return { resultType: 'matrix', result }
}

function latencyMatrix(series: number, start: number, end: number, step: number): PromMatrix {
  const result: PromMatrix['result'] = []
  for (let k = 0; k < series; k++) {
    const values: [number, string][] = []
    for (let t = start; t <= end; t += step) {
      const m = Math.round(t / MIN)
      // A spike every 10,007 minutes per series (about once a week): 1,000 series' alerts, with their
      // explanations, stay within the 4 MiB a backtest's intervals may hold.
      values.push([t / 1000, String((m + k * 13) % 10007 === 0 ? 400 : 100 + ((m * 37 + k) % 7) - 3)])
    }
    result.push({ metric: { svc: svc(k) }, values })
  }
  return { resultType: 'matrix', result }
}

const sloRule = (maxSeries: number) => ({ alert: 'CheckoutSLO', slo: { objective: 0.999, sli: SLI, max_series: maxSeries } })

describe('SLO rules, warm-ups and backtests in workerd: CPU per tick and per backtest', () => {
  it('T. one alarm tick of a group with one SLO rule (warm), at 1, 10 and 100 series, against an empty alerting rule; and its warm-up', async () => {
    note('\nT. one alarm tick, 1-minute interval; 3 unmeasured ticks after the warm-up, then 30 measured')
    note('| rule | series | ms CPU per tick (median, min–max of 30) | warm-up (first tick), ms CPU, fake engine taken off | SQL rows written per tick | load average | peak RSS, MB |')
    note('|---|---|---|---|---|---|---|')
    for (const [kind, series] of [['empty', 1], ['slo', 1], ['slo', 10], ['slo', 100]] as const) {
      const { tenant, stub, w } = await setup({ heartbeatMs: 24 * HOUR, limits: { maxAnomalyStateBytesPerObject: 64_000_000 } })
      const parsed = parseRuleFile({ groups: [{ name: 'g', interval: '1m', rules: [sloRule(100)] }] }, DEFAULT_RULER_CONFIG).groups[0]!.sloRules![0] as SloRuleV2
      // The warm-up's reads, as the first tick will ask for them, built before anything is measured.
      const firstTick = Math.ceil((world.now + 1) / MIN) * MIN
      void parsed
      const cache = new Map<string, PromMatrix>()
      w.range = (q, start, end, step) => {
        const key = `${start} ${end} ${step}`
        let m = cache.get(key)
        if (!m) cache.set(key, (m = sloMatrix(series, start, end, step)))
        return m
      }
      w.evaluate = (q, t) => {
        if (!q.includes('viz_slo_part')) return vec()
        const out: [Record<string, string>, number][] = []
        for (let k = 0; k < series; k++) out.push([{ svc: svc(k), viz_slo_part: 'total' }, 1000], [{ svc: svc(k), viz_slo_part: 'bad' }, badAt(k, t)])
        return vec(...out)
      }
      ok(await stub.saveGroups(tenant, { groups: [{ name: 'g', interval: '1m', rules: [kind === 'slo' ? sloRule(100) : { alert: 'Nothing', expr: 'nothing_here' }] }] }))
      void firstTick
      const tick = async () => {
        world.now = Math.max(world.now, ok(await stub.health(tenant)).alarmAtMs!)
        expect(await runDurableObjectAlarm(stub)).toBe(true)
      }
      // The first tick holds the warm-up: its reads are generated on demand by the fake engine, so
      // generate them once untimed (a twin tenant would get other offsets), then time a fresh rule.
      // The warm-up (first tick) reads in windows; the fake engine builds them in the same isolate,
      // so its CPU is measured alone afterwards (the same windows built again) and taken off.
      const warmTotal = await measure(tick)
      const calls = w.rangeCalls.slice()
      cache.clear()
      const gen = await measure(() => runInDurableObject(stub, () => calls.reduce((n, [q, a, b, st]) => n + sloMatrix(series, a, b, st).result.length + (q ? 0 : 0), 0)))
      const warm = { cpuMs: warmTotal.cpuMs - gen.cpuMs, windows: calls.length }
      for (let i = 0; i < 3; i++) await tick()
      const cpu: number[] = []
      const rows: number[] = []
      let peak = 0
      let last: number[] = []
      for (let i = 0; i < 30; i++) {
        const before = ok(await stub.health(tenant)).counters.sqlRowsWritten
        const m = await measure(tick)
        rows.push(ok(await stub.health(tenant)).counters.sqlRowsWritten - before)
        cpu.push(m.cpuMs)
        peak = Math.max(peak, m.peakMb)
        last = m.load
      }
      const status = ok(await stub.rules(tenant)).rules[0]!
      if (kind === 'slo') expect(status.slo).toMatchObject({ series, warmup: { status: 'done' } })
      note(`| ${kind === 'slo' ? 'SLO, 4 alerts' : 'counterfactual: alerting rule, empty result'} | ${series} | ${median(cpu).toFixed(2)} (${range(cpu)}) | ${kind === 'slo' ? `${warm.cpuMs.toFixed(0)} (${warm.windows} windows)` : '–'} | ${range(rows, 0)} | ${load(last)} | ${peak.toFixed(0)} |`)
    }
  })

  // B. One case per process (`-t "B. ewma 1000"`): the peak (VmHWM) is reset before the case, and a
  // case run after another would reuse heap the earlier one freed.
  // `B1.`: the counterfactual, the previous behaviour: each read in one window (a budget of 4 GiB).
  for (const [prefix, oneWindow] of [['B.', false], ['B1.', true]] as const) for (const kind of ['threshold', 'ewma', 'slo'] as const) {
    for (const series of [100, 1000]) {
      it(`${prefix} ${kind} ${series}: a 7-day backtest at 1 minute, ${oneWindow ? 'one window per read' : 'streamed in windows'}`, async () => {
        const { tenant, stub, w } = await setup({ heartbeatMs: 24 * HOUR })
        // Measured whole, whatever the CPU model says: its figure is printed beside the measurement.
        ok(await stub.configure(tenant, { limits: { maxBacktestCpuMs: 600_000 } } as never))
        if (oneWindow) ok(await stub.configure(tenant, { limits: { maxBacktestMemoryBytes: 4 * 1024 ** 3 } } as never))
        // A 1,000-series EWMA rule needs more state per rule than the default 1 MiB to be saved at all.
        if (kind === 'ewma' && series > 100) ok(await stub.configure(tenant, { limits: { maxAnomalyStateBytesPerRule: 8 << 20 } } as never))
        const to = Math.floor(Date.UTC(2099, 11, 31) / MIN) * MIN
        const from = to - 7 * DAY + MIN
        let rule: Record<string, unknown>
        if (kind === 'threshold') rule = { alert: 'Up', expr: 'latency_ms > 0', for: '2m' }
        else if (kind === 'ewma') rule = { alert: 'Latency', expr: 'latency_ms', anomaly: { params: { halfLifePoints: 10, minPoints: 5 }, max_series: series } }
        else {
          rule = { alert: 'CheckoutSLO', slo: { objective: 0.999, sli: SLI, max_series: series } }
          if (series > 100) ok(await stub.configure(tenant, { limits: { maxSloSeriesPerRule: series } } as never))
        }
        // The fake engine builds each window's matrix when it is asked for it, as viz-query's JSON is parsed in the isolate.
        const make = (q: string, start: number, end: number, step: number): PromMatrix => (q.includes('viz_slo_part') ? sloMatrix(series, start, end, step) : latencyMatrix(series, start, end, step))
        w.range = make
        const before = await host(true)
        let res: Awaited<ReturnType<typeof stub.backtest>> | null = null
        const m = await measure(async () => {
          res = await stub.backtest(tenant, rule, from, to, MIN)
        })
        const after = await host()
        const r = res as unknown as { status: string; intervals?: unknown[]; error?: string; message?: string; memory?: { peakBytes: number; budgetBytes: number }; cost?: { memory: { peakBytes: number; budgetBytes: number; windowSteps: number[]; queries: number }; cpu: { modelledMs: number } } }
        const peakMb = (after.peakKb - before.rssKb) / 1024
        if (r.status !== 'ok') {
          expect(r.status, JSON.stringify(r).slice(0, 300)).toBe('over_budget')
          note(`| ${prefix} ${kind} | ${series} | refused: ${r.message!.slice(0, 120)} | – | – | – | ${(r.memory!.peakBytes / 1048576).toFixed(1)} / ${(r.memory!.budgetBytes / 1048576).toFixed(0)} | ${peakMb.toFixed(1)} | – | ${load(m.load)} |`)
          return
        }
        // The fake engine's own CPU: the same windows built again, measured alone.
        const calls = w.rangeCalls.slice()
        const gen = await measure(() => runInDurableObject(stub, () => {
          let n = 0
          for (const [q, a, b, st] of calls) n += make(q, a, b, st).result.length
          return n
        }))
        const points = calls.reduce((n, [, a, b, st]) => n + (Math.floor((b - a) / st) + 1) * (kind === 'slo' ? 2 * series : series), 0)
        const mem = r.cost!.memory
        note(`| ${prefix} ${kind} | ${series} | ${(m.cpuMs - gen.cpuMs).toFixed(0)} (+${gen.cpuMs.toFixed(0)} fake engine) | ${(m.wallMs / 1000).toFixed(1)} | ${mem.windowSteps.join(' + ')} steps × ${mem.queries} queries | ${points.toLocaleString('en-US')} | ${(mem.peakBytes / 1048576).toFixed(1)} / ${(mem.budgetBytes / 1048576).toFixed(0)} | ${peakMb.toFixed(1)} | ${r.intervals!.length} | ${load(m.load)} | modelled ${r.cost!.cpu.modelledMs} ms, ${(r.cost!.cpu.modelledMs - (points * CPU.parse) / 1000).toFixed(0)} without parsing |`)
      })
    }
  }
})
