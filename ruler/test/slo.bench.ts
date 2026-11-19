/**
 * What SLO rules, warm-ups and backtests cost the ruler's Durable Object, measured in workerd under
 * the vitest pool (`npm run bench:history`, one worker):
 *
 *   T. one alarm tick of a group holding one SLO rule (the SRE Workbook's four alerts, 99.9% over
 *      30 days, 1-minute interval: a 4,320-bucket ring and a 720-bucket ring per series), warm,
 *      at 1, 10 and 100 series, against the counterfactual of the same group with one alerting
 *      rule whose result is empty; and the warm-up (the first tick) of the same rule;
 *   B. a 7-day backtest at 1 minute over 100 series: a threshold rule (the counterfactual: the
 *      alert state machine alone), an EWMA anomaly rule, and an SLO rule.
 *
 * CPU is the workerd process's thread time from `/proc` (the `HOST` binding in
 * `vitest.measure.config.ts`), which includes the RPC into the object and the fake engine's work
 * (building each tick's result; the backtests' matrices are built before the measured call and
 * handed over in memory). Peak resident memory is VmHWM of the same process.
 */
import { runDurableObjectAlarm } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { PromMatrix } from '../../contracts/engine'
import type { SloRuleV2 } from '../contracts-proposal/rules.v2'
import { anomalyWarmPoints, sloWarmReads } from '../src/history'
import { DEFAULT_RULER_CONFIG } from '../src/ruler'
import { parseRuleFile } from '../src/rules'
import { world } from './harness'
import { MIN, ok, setup, vec } from './helpers'

const HOUR = 60 * MIN
const DAY = 24 * HOUR
type Host = { ns: number; pids: number[]; loadavg: number[]; rssKb: number; peakKb: number }
const host = async () => (await (env as unknown as { HOST: Fetcher }).HOST.fetch('http://host/')).json() as Promise<Host>
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
      values.push([t / 1000, String((m + k * 13) % 1009 === 0 ? 400 : 100 + ((m * 37 + k) % 7) - 3)])
    }
    result.push({ metric: { svc: svc(k) }, values })
  }
  return { resultType: 'matrix', result }
}

const sloRule = (maxSeries: number) => ({ alert: 'CheckoutSLO', slo: { objective: 0.999, sli: SLI, max_series: maxSeries } })

describe('SLO rules, warm-ups and backtests in workerd: CPU per tick and per backtest', () => {
  it('T. one alarm tick of a group with one SLO rule (warm), at 1, 10 and 100 series, against an empty alerting rule; and its warm-up', async () => {
    note('\nT. one alarm tick, 1-minute interval; 3 unmeasured ticks after the warm-up, then 30 measured')
    note('| rule | series | ms CPU per tick (median, min–max of 30) | warm-up (first tick), ms CPU | SQL rows written per tick | load average | peak RSS, MB |')
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
      const warm = await measure(tick)
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
      note(`| ${kind === 'slo' ? 'SLO, 4 alerts' : 'counterfactual: alerting rule, empty result'} | ${series} | ${median(cpu).toFixed(2)} (${range(cpu)}) | ${kind === 'slo' ? `${warm.cpuMs.toFixed(0)} (includes generating the fake history)` : '–'} | ${range(rows, 0)} | ${load(last)} | ${peak.toFixed(0)} |`)
    }
  })

  it('B. a 7-day backtest at 1 minute over 100 series: threshold (the state machine alone), EWMA anomaly, SLO', async () => {
    note('\nB. 7-day backtest, step 1 minute, 100 series; matrices built before the measured call')
    note('| rule | points read | ms CPU | wall, ms | intervals | load average | peak RSS, MB |')
    note('|---|---|---|---|---|---|---|')
    const to = Math.floor(Date.UTC(2099, 11, 31) / MIN) * MIN
    const from = to - 7 * DAY
    for (const kind of ['threshold', 'ewma', 'slo'] as const) {
      const { tenant, stub, w } = await setup({ heartbeatMs: 24 * HOUR })
      const series = 100
      let rule: Record<string, unknown>
      const matrices = new Map<number, PromMatrix>()
      if (kind === 'threshold') {
        rule = { alert: 'Slow', expr: 'latency_ms > 300', for: '2m' }
        matrices.set(MIN, latencyMatrix(series, from, to, MIN))
      } else if (kind === 'ewma') {
        rule = { alert: 'Latency', expr: 'latency_ms', anomaly: { params: { halfLifePoints: 10, minPoints: 5 }, max_series: 100 } }
        const parsedRule = parseRuleFile({ groups: [{ name: 'g', interval: '1m', rules: [rule] }] }, DEFAULT_RULER_CONFIG).groups[0]!.anomalyRules![0]!
        matrices.set(MIN, latencyMatrix(series, from - anomalyWarmPoints(parsedRule as never, MIN) * MIN, to, MIN))
      } else {
        rule = sloRule(100)
        const parsedRule = parseRuleFile({ groups: [{ name: 'g', interval: '1m', rules: [rule] }] }, DEFAULT_RULER_CONFIG).groups[0]!.sloRules![0] as SloRuleV2
        const reads = sloWarmReads(parsedRule, MIN, from - MIN)
        matrices.set(MIN, sloMatrix(series, reads.fine.fromMs, to, MIN))
        if (reads.coarse) matrices.set(reads.coarse.stepMs, sloMatrix(series, reads.coarse.fromMs, reads.coarse.toMs, reads.coarse.stepMs))
      }
      w.range = (_q, _s, _e, step) => matrices.get(step)!
      const points = [...matrices.values()].reduce((n, m) => n + m.result.reduce((x, s) => x + s.values.length, 0), 0)
      let res: Awaited<ReturnType<typeof stub.backtest>> | null = null
      const m = await measure(async () => {
        res = await stub.backtest(tenant, rule, from, to, MIN)
      })
      const r = res as unknown as { status: string; intervals?: unknown[]; error?: string }
      expect(r.status, JSON.stringify(r).slice(0, 300)).toBe('ok')
      note(`| ${kind} | ${points.toLocaleString('en-US')} | ${m.cpuMs.toFixed(0)} | ${m.wallMs} | ${r.intervals!.length} | ${load(m.load)} | ${m.peakMb.toFixed(0)} |`)
      matrices.clear()
    }
  })
})
