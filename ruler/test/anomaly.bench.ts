/**
 * What an anomaly rule costs the ruler's Durable Object, measured in workerd under the vitest pool
 * (`npm run bench:anomaly`, one worker). Three levels, each per detector:
 *
 *   A. the library alone, one batch call over 100,000 points, the same synthetic series and
 *      parameters as `anomaly/bench/cpu.ts` (whose Node figures the README compares with);
 *   B. the ruler's evaluation function (`evalAnomaly`): one point per series per evaluation from
 *      warm in-memory state, each changed series re-serialised as it is stored; 100 series;
 *   C. the whole alarm tick of a group holding one such rule (fake evaluator, alert state
 *      machine, the state rows written to SQLite in the commit), against the counterfactual of the
 *      same group with an alerting rule that returns nothing.
 *
 * CPU is the workerd process's thread time from `/proc` (the `HOST` binding in
 * `vitest.measure.config.ts`); wall time is `Date.now()` around each call, which moves in workerd
 * across the call's I/O. Warm state is computed by the library from history and, for C, written
 * into `anomaly_state` the way the ruler stores it, so every measured evaluation scores.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { DAY_MS, DETECTORS, WEEK_MS } from '../../anomaly/src/index.ts'
import type { AnomalyRuleV2, RulerConfig } from '../contracts-proposal/rules.v2'
import { anomalyLimits, evalAnomaly, newAnomalyRt, readStateRows, stateRows } from '../src/anomaly'
import { DEFAULT_RULER_CONFIG } from '../src/ruler'
import { parseRuleFile } from '../src/rules'
import { fingerprint } from '../src/util'
import { world } from './harness'
import { MIN, ok, setup, vec } from './helpers'

const H = 60 * MIN
const host = async () => (await (env as unknown as { HOST: Fetcher }).HOST.fetch('http://host/')).json() as Promise<{ ns: number; pids: number[]; loadavg: number[] }>
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!
const range = (xs: number[], digits = 2) => (Math.min(...xs) === Math.max(...xs) ? Math.min(...xs).toFixed(digits) : `${Math.min(...xs).toFixed(digits)}–${Math.max(...xs).toFixed(digits)}`)
const load = (l: number[]) => l.map((x) => x.toFixed(1)).join(' ')
const LIMITS = { maxAnomalyStateBytesPerRule: 16_000_000, maxAnomalyStateBytesPerObject: 64_000_000 }

/** `anomaly/bench/cpu.ts`'s generator: daily sine + noise, seeded. */
function make(n: number, step: number, seed0 = 12345, shift = 0): { ts: Float64Array; values: Float64Array } {
  let seed = seed0
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd())
  const ts = new Float64Array(n)
  const values = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    ts[i] = 1.7e12 + i * step
    values[i] = 100 + shift + 30 * Math.sin((2 * Math.PI * i * step) / DAY_MS) + 3 * gauss()
  }
  return { ts, values }
}

type Detect = { detect(s: unknown, p: unknown, st: unknown): { state: unknown; points: { status: string }[] } }
const det = (name: string) => (DETECTORS as unknown as Record<string, Detect>)[name]!

/** CPU (ms, workerd threads) and wall (ms) of `fn`, with the cost of an empty call to the object taken off the CPU. */
async function measure(fn: () => Promise<unknown>, overheadMs = 0) {
  const a = await host()
  const t = Date.now()
  await fn()
  const wallMs = Date.now() - t
  const b = await host()
  expect(b.pids.length, 'exactly one workerd process (run with --maxWorkers=1)').toBe(1)
  return { cpuMs: (b.ns - a.ns) / 1e6 - overheadMs, wallMs, load: b.loadavg }
}

const report: string[] = []
const note = (line: string) => {
  report.push(line)
  console.log(line)
}

describe('anomaly rules in workerd: CPU and wall time per detector', () => {
  it('A. the library alone: one batch call over 100,000 points (as anomaly/bench/cpu.ts in Node)', async () => {
    const { stub } = await setup()
    const empty: number[] = []
    for (let i = 0; i < 20; i++) empty.push((await measure(() => runInDurableObject(stub, () => undefined))).cpuMs)
    const overhead = median(empty)
    note(`\nA. library batch, 100,000 points; overhead of an empty call to the object ${overhead.toFixed(2)} ms CPU (median of 20), taken off`)
    note('| detector | ms CPU per 1,000 points (median of 5) | wall, ms per 1,000 points | Node (anomaly/README.md) | load average |')
    note('|---|---|---|---|---|')
    const cases: [string, string, number, Record<string, unknown>, string][] = [
      ['threshold', 'threshold', 5 * MIN, { above: 130, recoverAbove: 125 }, '0.59'],
      ['ewma', 'ewma', 5 * MIN, {}, '0.14'],
      ['robust_z (288 points)', 'robust_z', 5 * MIN, {}, '3.6'],
      ['seasonal (daily, 5 min, k=4)', 'seasonal', 5 * MIN, { periodMs: DAY_MS }, '9.8'],
      ['seasonal (weekly, 1 h, k=4)', 'seasonal', H, { periodMs: WEEK_MS }, '5.8'],
      ['cusum', 'cusum', 5 * MIN, {}, '0.61'],
    ]
    for (const [label, name, step, params, node] of cases) {
      const s = make(100_000, step)
      const runs: { cpuMs: number; wallMs: number; load: number[] }[] = []
      for (let r = 0; r < 5; r++) runs.push(await measure(() => runInDurableObject(stub, () => void det(name).detect(s, { ...params, stepMs: step }, null)), overhead))
      const cpu = median(runs.map((x) => x.cpuMs)) / 100
      const wall = median(runs.map((x) => x.wallMs)) / 100
      note(`| ${label} | ${cpu.toFixed(3)} | ${wall.toFixed(3)} | ${node} | ${load(runs.at(-1)!.load)} |`)
    }
  })

  // Cases for B and C: the ruler's defaults (ewma: half-life 100, k 8), 100 series.
  const S = 100
  const CASES: { label: string; detector: string; interval: string; step: number; params: Record<string, unknown> }[] = [
    { label: 'threshold', detector: 'threshold', interval: '5m', step: 5 * MIN, params: { above: 1e9 } },
    { label: 'ewma', detector: 'ewma', interval: '5m', step: 5 * MIN, params: {} },
    { label: 'robust_z (288 points)', detector: 'robust_z', interval: '5m', step: 5 * MIN, params: {} },
    { label: 'seasonal (daily, 5 min, k=4)', detector: 'seasonal', interval: '5m', step: 5 * MIN, params: { periodMs: DAY_MS } },
    { label: 'seasonal (weekly, 1 h, k=4)', detector: 'seasonal', interval: '1h', step: H, params: { periodMs: WEEK_MS } },
    { label: 'cusum', detector: 'cusum', interval: '5m', step: 5 * MIN, params: {} },
  ]
  const cfg: RulerConfig = { ...DEFAULT_RULER_CONFIG, limits: { ...DEFAULT_RULER_CONFIG.limits, ...LIMITS } }
  const ruleOf = (c: (typeof CASES)[number]) => ({ alert: 'Bench', expr: 'bench_metric', anomaly: { detector: c.detector, params: c.params, max_series: S } })
  const parsed = (c: (typeof CASES)[number]): AnomalyRuleV2 => {
    const p = parseRuleFile({ groups: [{ name: 'bench', interval: c.interval, rules: [ruleOf(c)] }] }, cfg)
    if (p.errors.length > 0) throw new Error(JSON.stringify(p.errors))
    return p.groups[0]!.anomalyRules![0] as AnomalyRuleV2
  }
  /** History and future values of S series, and the warm state rows the ruler would hold after the history. */
  function warm(c: (typeof CASES)[number], rule: AnomalyRuleV2, firstTick: number, ticks: number) {
    const n = Math.ceil(rule.anomaly.history.lookbackMs / c.step) + 20
    const labels = Array.from({ length: S }, (_, j) => ({ service: `svc-${String(j).padStart(3, '0')}`, region: 'eu-west-1' }))
    const all = labels.map((_l, j) => make(n + ticks, c.step, 1000 + j, j % 7))
    const json = new Map<string, string>()
    for (let j = 0; j < S; j++) {
      const ts = Float64Array.from({ length: n }, (_x, i) => firstTick - (n - i) * c.step)
      const r = det(c.detector).detect({ ts, values: all[j]!.values.subarray(0, n) }, { ...rule.anomaly.params, stepMs: c.step }, null)
      const k = fingerprint(labels[j]!)
      json.set(k, JSON.stringify({ k, l: labels[j], s: r.state, last: null, seen: ts[n - 1] }))
    }
    const future = (i: number) => labels.map((l, j): [Record<string, string>, number] => [l, all[j]!.values[n + i]!])
    return { rows: stateRows(json), future, n }
  }

  it('B. the ruler\'s evaluation function: one evaluation of 100 series from warm state (detector, explanation, state as stored, limits)', async () => {
    const { stub } = await setup()
    const T = 40
    note(`\nB. evalAnomaly, ${S} series, ${T} evaluations from warm state, 3 runs (ranges are min–max)`)
    note('| detector | ms CPU per evaluation (100 series) | ms CPU per 1,000 points | wall, ms per evaluation | state, bytes per series | scored / warming at the end | Node, one tick through JSON, per 1,000 points | load average |')
    note('|---|---|---|---|---|---|---|---|')
    const nodeTick: Record<string, string> = { threshold: '6.3', ewma: '8.9', 'robust_z (288 points)': '193', 'seasonal (daily, 5 min, k=4)': '523', 'seasonal (weekly, 1 h, k=4)': '285', cusum: '21' }
    for (const c of CASES) {
      const rule = parsed(c)
      const firstTick = 1.8e12
      const { rows, future } = warm(c, rule, firstTick, T)
      const inputs = Array.from({ length: T }, (_, i) => future(i).map(([metric, value]) => ({ metric, value, text: String(value) })))
      const limits = anomalyLimits(cfg)
      const cpu: number[] = []
      const wall: number[] = []
      let bytes = 0
      let last: { status: string; scored: number; warming: number } = { status: '', scored: 0, warming: 0 }
      for (let run = 0; run < 3; run++) {
        const read = readStateRows(rows)
        if ('error' in read) throw new Error(read.error)
        const rt = newAnomalyRt(rule)
        rt.series = read.series
        rt.json = read.json
        const m = await measure(() =>
          runInDurableObject(stub, () => {
            for (let i = 0; i < T; i++) {
              const ev = evalAnomaly(rule, rt, inputs[i]!, firstTick + i * c.step, c.step, limits, {})
              if (!ev.ok) throw new Error(ev.error)
              rt.series = ev.next
              rt.json = ev.json
              rt.status = ev.status
            }
          }),
        )
        cpu.push(m.cpuMs / T)
        wall.push(m.wallMs / T)
        bytes = rt.status.stateBytes / S
        last = rt.status
        if (run === 2) note(`| ${c.label} | ${range(cpu)} | ${range(cpu.map((x) => (x / S) * 1000), 1)} | ${range(wall)} | ${bytes.toFixed(0)} | ${last.scored} / ${last.warming} | ${nodeTick[c.label]} | ${load(m.load)} |`)
      }
      // Every series was evaluated warm; CUSUM re-learns its reference for 30 points after each
      // alarm, and on this daily sine some series are always re-learning: that is its real cost.
      expect(last.scored + last.warming, c.label).toBe(S)
      if (c.detector !== 'cusum') expect(last, `${c.label}: every series scored`).toMatchObject({ status: 'ok', scored: S })
    }
  })

  it('C. the whole tick in the object: one group with one 100-series anomaly rule, against the same group with an alerting rule that returns nothing', async () => {
    const T = 30
    note(`\nC. alarm ticks in the Ruler object, ${S} series, ${T} measured ticks after 3 unmeasured, 3 runs (ranges are min–max)`)
    note('| rule | ms CPU per tick | wall per tick, median / p95 (ms) | SQL rows written per tick | state rows | scored / warming at the end | load average |')
    note('|---|---|---|---|---|---|---|')
    const one = async (c: (typeof CASES)[number] | null) => {
      const interval = c?.interval ?? '5m'
      const step = c?.step ?? 5 * MIN
      const { tenant, stub, w } = await setup({ heartbeatMs: 24 * H, limits: LIMITS })
      const saved = ok(await stub.saveGroups(tenant, { groups: [{ name: 'bench', interval, rules: [c ? ruleOf(c) : { alert: 'Bench', expr: 'bench_metric' }] }] }))
      const first = saved.groups[0]!.nextEvaluationMs
      let vectors: ReturnType<typeof vec>[] = []
      if (c) {
        const rule = parsed(c)
        expect(saved.groups[0]!.rules[0]!.key).toBe(rule.key)
        const { rows, future } = warm(c, rule, first, T + 3)
        vectors = Array.from({ length: T + 3 }, (_, i) => vec(...future(i)))
        await runInDurableObject(stub, (_i, s) => {
          rows.forEach((body, chunk) => s.storage.sql.exec('INSERT INTO anomaly_state (tenant, grp, rule_key, chunk, body) VALUES (?, ?, ?, ?, ?)', tenant, 'bench', rule.key, chunk, body))
        })
        await evictDurableObject(stub)
      }
      w.evaluate = (q, t) => (c && q === 'bench_metric' ? vectors[Math.round((t - first) / step)]! : vec())
      const at = (i: number) => first + i * step
      for (let i = 0; i < 3; i++) {
        world.now = at(i)
        expect(await runDurableObjectAlarm(stub)).toBe(true)
      }
      const rows0 = ok(await stub.health(tenant)).counters.sqlRowsWritten
      const walls: number[] = []
      const m = await measure(async () => {
        for (let i = 3; i < T + 3; i++) {
          world.now = at(i)
          const t0 = Date.now()
          await runDurableObjectAlarm(stub)
          walls.push(Date.now() - t0)
        }
      })
      const h = ok(await stub.health(tenant))
      const st = ok(await stub.rules(tenant)).rules[0]!
      expect(st.health).toBe('ok')
      if (c) expect(st.anomaly!.scored + st.anomaly!.warming, c.label).toBe(S)
      if (c && c.detector !== 'cusum') expect(st.anomaly, `${c.label}: every series scored at every tick`).toMatchObject({ status: 'ok', scored: S })
      const stateRowCount = await runInDurableObject(stub, (_i, s) => s.storage.sql.exec('SELECT COUNT(*) AS n FROM anomaly_state').one().n as number)
      const sorted = [...walls].sort((a, b) => a - b)
      return { cpu: m.cpuMs / T, wallMedian: sorted[T >> 1]!, wallP95: sorted[Math.floor(0.95 * T)]!, rows: (h.counters.sqlRowsWritten - rows0) / T, stateRows: stateRowCount, scored: st.anomaly ? `${st.anomaly.scored} / ${st.anomaly.warming}` : '–', load: m.load }
    }
    for (const c of [null, ...CASES]) {
      const runs = [await one(c), await one(c), await one(c)]
      note(`| ${c ? c.label : 'counterfactual: alerting rule, empty result'} | ${range(runs.map((r) => r.cpu))} | ${range(runs.map((r) => r.wallMedian), 0)} / ${range(runs.map((r) => r.wallP95), 0)} | ${range(runs.map((r) => r.rows), 1)} | ${runs[0]!.stateRows} | ${runs.at(-1)!.scored} | ${load(runs.at(-1)!.load)} |`)
    }
    console.log(`\n${report.join('\n')}`)
  })
})
