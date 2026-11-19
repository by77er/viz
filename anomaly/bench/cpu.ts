/**
 * CPU cost per detector, measured in Node (this machine), plus state size and declared history.
 *
 *   node --experimental-strip-types bench/cpu.ts
 *
 * batch:  one call over 100,000 points (median of 5 runs) → µs of CPU per 1,000 points.
 * tick:   the ruler's pattern — for each new point: JSON.parse(state), detect([point]),
 *         JSON.stringify(state) — over 2,000 ticks after warm-up → µs per tick (per series).
 * Synthetic input: daily sine + noise at 5-minute steps (hourly for the weekly seasonal case,
 * 1-minute buckets for burn rate), seeded.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import {
  threshold, ewma, robustZ, seasonal, burnRate, stl, fitStl, cusum, peltDetector, detectGroup, detectSeasonality, classify,
  type Series, type DetectResult, type HistoryNeed, SRE_WORKBOOK_RULES, DAY_MS, WEEK_MS,
} from '../src/index.ts'

const MIN = 60_000, H = 60 * MIN
let seed = 12345
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd())
const make = (n: number, step: number): Series => {
  const ts = new Float64Array(n), values = new Float64Array(n)
  for (let i = 0; i < n; i++) { ts[i] = 1.7e12 + i * step; values[i] = 100 + 30 * Math.sin((2 * Math.PI * i * step) / DAY_MS) + 3 * gauss() }
  return { ts, values }
}
const cpu = (f: () => void) => { const a = process.cpuUsage(); f(); const b = process.cpuUsage(a); return (b.user + b.system) / 1000 } // ms
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!

type Det = (s: Series, st: unknown) => DetectResult<unknown>
interface Case { name: string; step: number; n: number; run: Det; incremental: boolean; history: HistoryNeed; extra?: (s: Series) => Series }

const burnSeries = (s: Series): Series => ({ ts: s.ts, values: s.values.map((v) => Math.max(0, v - 99) / 10), total: new Float64Array(s.values.length).fill(1000) } as Series)

const cases: Case[] = [
  { name: 'threshold', step: 5 * MIN, n: 100_000, incremental: true, run: (s, st) => threshold.detect(s, { above: 130, recoverAbove: 125, stepMs: 5 * MIN }, st as never), history: threshold.history({}, 5 * MIN) },
  { name: 'ewma', step: 5 * MIN, n: 100_000, incremental: true, run: (s, st) => ewma.detect(s, { stepMs: 5 * MIN }, st as never), history: ewma.history({}, 5 * MIN) },
  { name: 'robust_z (288 points)', step: 5 * MIN, n: 100_000, incremental: true, run: (s, st) => robustZ.detect(s, { stepMs: 5 * MIN }, st as never), history: robustZ.history({}, 5 * MIN) },
  { name: 'seasonal (daily, 5 min, k=4)', step: 5 * MIN, n: 100_000, incremental: true, run: (s, st) => seasonal.detect(s, { periodMs: DAY_MS, stepMs: 5 * MIN }, st as never), history: seasonal.history({ periodMs: DAY_MS }, 5 * MIN) },
  { name: 'seasonal (weekly, 1 h, k=4)', step: H, n: 100_000, incremental: true, run: (s, st) => seasonal.detect(s, { periodMs: WEEK_MS, stepMs: H }, st as never), history: seasonal.history({ periodMs: WEEK_MS }, H) },
  { name: 'burn_rate (workbook rules, 1-min buckets)', step: MIN, n: 20_000, incremental: true, extra: burnSeries, run: (s, st) => burnRate.detect(s as never, { stepMs: MIN }, st as never), history: burnRate.history({}, MIN) },
  { name: 'burn_rate (workbook rules, 5-min buckets)', step: 5 * MIN, n: 20_000, incremental: true, extra: burnSeries, run: (s, st) => burnRate.detect(s as never, { stepMs: 5 * MIN }, st as never), history: burnRate.history({}, 5 * MIN) },
  { name: 'cusum', step: 5 * MIN, n: 100_000, incremental: true, run: (s, st) => cusum.detect(s, { stepMs: 5 * MIN }, st as never), history: cusum.history({}, 5 * MIN) },
  { name: 'stl, scoring against a stored model', step: 5 * MIN, n: 100_000, incremental: true, run: (s, st) => stl.detect(s, { periodMs: DAY_MS, stepMs: 5 * MIN }, (st ?? stlModel) as never), history: stl.history({ periodMs: DAY_MS }, 5 * MIN) },
]
const stlModel = fitStl(make(8 * 288, 5 * MIN), { periodMs: DAY_MS, stepMs: 5 * MIN })!.model

const out: Record<string, unknown>[] = []
for (const c of cases) {
  const s0 = make(c.n, c.step)
  const s = c.extra ? c.extra(s0) : s0
  const batch = median(Array.from({ length: 5 }, () => cpu(() => c.run(s, null))))
  const full = c.run(s, null)
  // tick: warm up on the first part, then one point at a time through JSON
  const warmN = Math.min(c.n - 2000, Math.max(3000, Math.ceil(c.history.lookbackMs / c.step) + 10))
  const sub = (a: number, b: number): Series => ({ ts: s.ts.subarray(a, b), values: s.values.subarray(a, b), ...((s as { total?: Float64Array }).total ? { total: (s as unknown as { total: Float64Array }).total.subarray(a, b) } : {}) } as Series)
  let stateJson = JSON.stringify(c.run(sub(0, warmN), null).state)
  const tickMs = cpu(() => {
    for (let i = warmN; i < warmN + 2000; i++) {
      const r = c.run(sub(i, i + 1), JSON.parse(stateJson))
      stateJson = JSON.stringify(r.state)
    }
  })
  const row = {
    detector: c.name,
    batchUsPer1k: (1000 * batch) / (c.n / 1000),
    tickUs: (1000 * tickMs) / 2000,
    stateBytes: full.summary.stateBytes,
    lookback: c.history.lookbackMs,
    class: classify(c.history, MIN),
  }
  out.push(row)
  console.error(`${c.name}: batch ${row.batchUsPer1k.toFixed(0)} µs/1k points, tick ${row.tickUs.toFixed(1)} µs, state ${row.stateBytes} B`)
}

// batch-only detectors: cost per run
const day5 = make(8 * 288, 5 * MIN)
const stlFit = median(Array.from({ length: 5 }, () => cpu(() => fitStl(day5, { periodMs: DAY_MS, stepMs: 5 * MIN }))))
const wk1h = make(8 * 168, H)
const stlFitW = median(Array.from({ length: 5 }, () => cpu(() => fitStl(wk1h, { periodMs: WEEK_MS, stepMs: H }))))
const pelt1d = make(288, 5 * MIN)
for (let i = 150; i < 288; i++) pelt1d.values[i]! += 20
const peltRun = median(Array.from({ length: 20 }, () => cpu(() => peltDetector.detect(pelt1d))))
const pelt7d = make(7 * 288, 5 * MIN)
const peltRun7 = median(Array.from({ length: 5 }, () => cpu(() => peltDetector.detect(pelt7d))))
const season7 = median(Array.from({ length: 5 }, () => cpu(() => detectSeasonality(make(7 * 288, 5 * MIN)))))
const season5w = median(Array.from({ length: 5 }, () => cpu(() => detectSeasonality(make(5 * 168, H)))))
const group = Array.from({ length: 50 }, (_, i) => ({ id: `pod-${i}`, value: 100 + gauss() }))
const groupRun = median(Array.from({ length: 200 }, () => cpu(() => { for (let k = 0; k < 100; k++) detectGroup(group) }))) / 100
const batchRows = [
  { job: 'STL fit, 8 days at 5 min (2,304 points), daily period', ms: stlFit },
  { job: 'STL fit, 8 weeks at 1 h (1,344 points), weekly period', ms: stlFitW },
  { job: 'PELT, 1 day at 5 min (288 points)', ms: peltRun },
  { job: 'PELT, 7 days at 5 min (2,016 points)', ms: peltRun7 },
  { job: 'seasonality detection, 7 days at 5 min', ms: season7 },
  { job: 'seasonality detection, 5 weeks at 1 h', ms: season5w },
  { job: 'cross-series, 50 members, one timestamp', ms: groupRun },
]
for (const b of batchRows) console.error(`${b.job}: ${b.ms.toFixed(3)} ms`)

const lines = ['| detector | batch, µs CPU per 1,000 points | one tick through JSON state, µs | state, bytes | cold-start history | class per tick / cold start |', '|---|---|---|---|---|---|']
const dur = (ms: number) => (ms >= DAY_MS ? `${+(ms / DAY_MS).toFixed(2)} d` : ms >= H ? `${+(ms / H).toFixed(2)} h` : `${+(ms / MIN).toFixed(1)} min`)
for (const r of out as { detector: string; batchUsPer1k: number; tickUs: number; stateBytes: number; lookback: number; class: { tick: string; coldStart: string } }[]) {
  lines.push(`| ${r.detector} | ${r.batchUsPer1k.toFixed(0)} | ${r.tickUs.toFixed(1)} | ${r.stateBytes.toLocaleString('en-US')} | ${dur(r.lookback)} | ${r.class.tick} / ${r.class.coldStart} |`)
}
lines.push('', '| batch job | ms CPU per run |', '|---|---|')
for (const b of batchRows) lines.push(`| ${b.job} | ${b.ms.toFixed(2)} |`)
console.log(lines.join('\n'))
mkdirSync(new URL('./out/', import.meta.url).pathname, { recursive: true })
writeFileSync(new URL('./out/cpu.md', import.meta.url).pathname, `Node ${process.version}, ${new Date().toISOString().slice(0, 10)}\n\n${lines.join('\n')}\n`)
void SRE_WORKBOOK_RULES
