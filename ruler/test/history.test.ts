/**
 * Reading a rule's history (contract version 4): warming new anomaly and SLO rules, and
 * backtesting threshold, anomaly and SLO rules. What is checked here:
 *
 * - warm-up: a new rule's first tick reads exactly its history class (planned first, nothing
 *   fetched before the plan is summed), feeds it through the rule's own evaluation, and scores at
 *   once with the state the library computes over the same points; over the budget, or refused by
 *   the engine's plan, nothing is fetched and the status says so (also over HTTP); an engine
 *   failure is retried, then given up; the state is written as whole rows in one transaction,
 *   survives eviction, and a crash in that transaction leaves nothing half-written and the retry
 *   gives the same state; nothing is read twice;
 * - backtests: over data a rule fired on live, a backtest from the time the rule was created gives
 *   the same alerts at the same times with the same explanations (anomaly and SLO rules), through
 *   the monitors API too; every backtest is planned first and refused whole past the budget;
 * - tenant isolation of the new endpoint: the tenant is the credential's, nothing else.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { DETECTORS } from '../../anomaly/src/index.ts'
import type { PromMatrix } from '../../contracts/engine'
import type { Alert, BacktestInterval, BacktestResponse, HistoryPlan, RuleStatus } from '../contracts-proposal/rules.v2'
import { readStateRows } from '../src/anomaly'
import { apiKey, call } from './api'
import { Crash, T0, world } from './harness'
import { expectWindows, MIN, ok, setup, vec } from './helpers'

const SLI = { bad: 'sum(increase(errors_total[$window]))', total: 'sum(increase(requests_total[$window]))' }
const sloEntry = () => ({ alert: 'CheckoutSLO', slo: { objective: 0.999, sli: SLI } })

const HOUR = 60 * MIN
const DAY = 24 * HOUR
const LAT = 'latency_ms'
const SERVICES = ['a', 'b', 'c']
/** A deterministic noisy level: 97..103 around 100, by absolute minute (so history and live agree). */
const noise = (t: number) => 100 + ((Math.round(t / MIN) * 37) % 7) - 3

const ewma = (extra: Record<string, unknown> = {}) => ({ alert: 'LatencyAnomaly', expr: LAT, keep_firing_for: '0s', ...extra, anomaly: { params: { halfLifePoints: 10, minPoints: 5 }, unit: 'ms' } })

/** Values of `latency_ms` per service at a time; history and live ticks read the same function. */
type Values = (service: string, t: number) => number

function matrixOf(values: Values, start: number, end: number, step: number): PromMatrix {
  return {
    resultType: 'matrix',
    result: SERVICES.map((s) => {
      const v: [number, string][] = []
      for (let t = start; t <= end; t += step) v.push([t / 1000, String(values(s, t))])
      return { metric: { service: s }, values: v }
    }),
  }
}

/** A tenant with one group of rules over `latency_ms` (or an SLO's parts), its history and live values scripted, and an ordered log of engine calls. */
async function rig(rules: unknown[], values: Values = (_s, t) => noise(t), opts: { group?: string; slo?: (t: number) => number } = {}) {
  const { tenant, stub, w } = await setup({ heartbeatMs: 6 * HOUR })
  const log: string[] = []
  const sloBad = opts.slo ?? (() => 0)
  w.evaluate = (q, t) => {
    log.push(`query ${t}`)
    if (q.includes('viz_slo_part')) return vec([{ viz_slo_part: 'total' }, 1000], [{ viz_slo_part: 'bad' }, sloBad(t)])
    return q === LAT ? vec(...SERVICES.map((s): [Record<string, string>, number] => [{ service: s }, values(s, t)])) : vec()
  }
  w.range = (q, start, end, step) => {
    log.push(`range ${start} ${end} ${step}`)
    if (q.includes('viz_slo_part')) {
      const width = step / MIN
      const total: [number, string][] = []
      const bad: [number, string][] = []
      for (let t = start; t <= end; t += step) {
        total.push([t / 1000, String(1000 * width)])
        // A coarse bucket sums the minutes it covers; a fine one is one minute.
        let b = 0
        for (let x = t - step + MIN; x <= t; x += MIN) b += sloBad(x)
        bad.push([t / 1000, String(b)])
      }
      return { resultType: 'matrix', result: [{ metric: { viz_slo_part: 'total' }, values: total }, { metric: { viz_slo_part: 'bad' }, values: bad }] }
    }
    return matrixOf(values, start, end, step)
  }
  const plan = (p: HistoryPlan) => (w.plan = (q, start, end, step) => {
    log.push(`plan ${start} ${end} ${step}`)
    return p
  })
  plan({ scanSamples: 1000, bytesToRead: 4096, seriesEstimate: 3, refusal: null })
  const saved = ok(await stub.saveGroups(tenant, { groups: [{ name: opts.group ?? 'g', interval: '1m', rules }] }))
  return {
    tenant,
    stub,
    w,
    saved,
    log,
    plan,
    tick: async () => {
      world.now = Math.max(world.now, ok(await stub.health(tenant)).alarmAtMs!)
      expect(await runDurableObjectAlarm(stub)).toBe(true)
      return world.now
    },
    rule: async (name = 'LatencyAnomaly'): Promise<RuleStatus> => ok(await stub.rules(tenant)).rules.find((x) => x.name === name)!,
    stateRows: () => runInDurableObject(stub, (_i, s) => s.storage.sql.exec('SELECT rule_key, chunk, body FROM anomaly_state WHERE tenant = ? ORDER BY chunk', tenant).toArray()),
    warmupRow: () => runInDurableObject(stub, (_i, s) => s.storage.sql.exec('SELECT body FROM warmup WHERE tenant = ?', tenant).toArray().map((x) => JSON.parse(x.body as string))),
  }
}

/** What the library computes on its own from no state over the same points, in one batch call. */
function libraryState(ts: number[], values: number[], halfLifePoints = 10) {
  const det = DETECTORS.ewma as unknown as { detect(s: unknown, p: unknown, st: unknown): { state: unknown } }
  return det.detect({ ts: Float64Array.from(ts), values: Float64Array.from(values) }, { halfLifePoints, minPoints: 5, k: 8, unit: 'ms', stepMs: MIN }, null).state
}

function storedState(rows: Record<string, unknown>[], service: string) {
  const read = readStateRows(rows.map((r) => r.body as string))
  if ('error' in read) throw new Error(read.error)
  return [...read.series.values()].find((s) => s.labels.service === service)?.state
}

describe('warming a new rule from history', () => {
  it('an anomaly rule: the first tick plans then reads exactly the detector\'s look-back at the interval, and scores at once with the state the library computes over history and the live point', async () => {
    const r = await rig([ewma()])
    const t = await r.tick()
    // EWMA, half-life 10 points: a look-back of 20 points, ending one interval before this tick.
    const end = t - MIN
    expect(r.log).toEqual([`plan ${end - 19 * MIN} ${end} ${MIN}`, `range ${end - 19 * MIN} ${end} ${MIN}`, `query ${t}`])
    const s = await r.rule()
    expect(s.anomaly).toMatchObject({ status: 'ok', scored: 3, warming: 0, stateSeries: 3 })
    expect(s.anomaly!.warmup).toMatchObject({ status: 'done', points: 60, attempts: 1, plan: { scanSamples: 1000, bytesToRead: 4096, queries: 1 }, budget: { scanSamples: 3_000_000, bytesToRead: 16 * 1024 * 1024 }, reads: [{ fromMs: end - 19 * MIN, toMs: end, stepMs: MIN }] })
    const ts = Array.from({ length: 21 }, (_x, i) => end - 19 * MIN + i * MIN)
    expect(storedState(await r.stateRows(), 'b')).toEqual(libraryState(ts, ts.map((x) => noise(x))))
    // Whole batches: the three series' state in one row; the status in one more.
    expect(await r.stateRows()).toHaveLength(1)
    expect(await r.warmupRow()).toEqual([{ v: 1, ...s.anomaly!.warmup }])
    // Nothing is read again: not at the next tick, not after an eviction.
    await evictDurableObject(r.stub)
    expect((await r.rule()).anomaly).toMatchObject({ stateSeries: 3, warmup: { status: 'done' } })
    await r.tick()
    expect(r.log.filter((x) => !x.startsWith('query'))).toHaveLength(2)
    expect((await r.rule()).anomaly).toMatchObject({ status: 'ok', scored: 3 })
  })

  it('over the budget nothing is fetched: the warm-up is refused with the plan\'s numbers and the budget, the rule starts cold, and the monitors API shows why', async () => {
    const { tenant, stub, w } = await setup({ heartbeatMs: 6 * HOUR })
    const key = await apiKey(tenant)
    w.evaluate = (q, t) => vec(...SERVICES.map((s): [Record<string, string>, number] => [{ service: s }, noise(t)]))
    w.range = () => {
      throw new Error('fetched although over budget')
    }
    w.plan = () => ({ scanSamples: 5_000_000, bytesToRead: 40 << 20, seriesEstimate: 3, refusal: null })
    const created = await call(key.auth, 'POST', '/api/v1/monitors', { name: 'Latency', query: LAT, anomaly: { params: { halfLifePoints: 10, minPoints: 5 } } })
    expect(created.status, created.text).toBe(201)
    world.now = Math.max(world.now, ok(await stub.health(tenant)).alarmAtMs!)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(w.rangeCalls).toEqual([])
    const m = (await call(key.auth, 'GET', `/api/v1/monitors/${created.json.id}`)).json.monitor
    expect(m.anomaly.status).toMatchObject({ status: 'warming', warming: 3 })
    expect(m.anomaly.status.warmup).toMatchObject({ status: 'refused', plan: { scanSamples: 5_000_000, bytesToRead: 40 << 20, queries: 1 }, budget: { scanSamples: 3_000_000, bytesToRead: 16 << 20 }, points: 0 })
    expect(m.anomaly.status.warmup.message).toMatch(/^over budget: the read would scan 5000000 samples and 41943040 bytes in 1 range query; the budget is 3000000 samples and 16777216 bytes; nothing was fetched and the rule started cold$/)
    // The budget is a limit like the others: raised, a new rule is warmed.
    ok(await stub.configure(tenant, { limits: { maxWarmupScanSamples: 10_000_000, maxWarmupBytes: 64 << 20 } }))
    w.range = (_q, start, end, step) => matrixOf((_s, t) => noise(t), start, end, step)
    const second = await call(key.auth, 'POST', '/api/v1/monitors', { name: 'Latency 2', query: LAT, anomaly: { params: { halfLifePoints: 10, minPoints: 5 } } })
    world.now = Math.max(world.now, ok(await stub.health(tenant)).alarmAtMs!)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect((await call(key.auth, 'GET', `/api/v1/monitors/${second.json.id}`)).json.monitor.anomaly.status.warmup.status).toBe('done')
  })

  it('a read the engine\'s own limits would refuse is refused too, with the engine\'s words; nothing is fetched', async () => {
    const r = await rig([ewma()])
    r.plan({ scanSamples: 9, bytesToRead: 9, seriesEstimate: 3, refusal: { errorType: 'execution', error: 'query exceeded limit max_files: 2400 data files to read, the limit is 2000. Narrow the time range.' } })
    await r.tick()
    expect(r.log.filter((x) => x.startsWith('range'))).toEqual([])
    expect((await r.rule()).anomaly!.warmup).toMatchObject({ status: 'refused', plan: null, message: 'the engine would refuse the read: execution: query exceeded limit max_files: 2400 data files to read, the limit is 2000. Narrow the time range.; nothing was fetched and the rule started cold' })
  })

  it('an engine failure is retried at the next tick (the rule waits, and says so), then given up after three attempts: the rule starts cold', async () => {
    const r = await rig([ewma()])
    r.w.plan = () => {
      throw new Error('unavailable: a storage component did not answer; retry')
    }
    const queried = () => r.log.filter((x) => x.startsWith('query')).length
    await r.tick()
    expect(queried(), 'the rule waited').toBe(0)
    expect((await r.rule()).anomaly).toMatchObject({ status: 'warming', message: 'the engine failed the read (unavailable: a storage component did not answer; retry); tried again at the next tick', warmup: { status: 'pending', attempts: 1 } })
    await r.tick()
    expect([queried(), (await r.rule()).anomaly!.warmup!.attempts]).toEqual([0, 2])
    await r.tick()
    expect(queried(), 'given up: evaluated cold').toBe(1)
    expect((await r.rule()).anomaly!.warmup).toMatchObject({ status: 'failed', attempts: 3, message: expect.stringMatching(/the rule started cold$/) })
    await r.tick()
    expect(queried()).toBe(2)
  })

  it('a crash in the warm-up\'s transaction writes nothing; the retried alarm warms again, to the same state; then nothing is read again', async () => {
    const r = await rig([ewma()])
    r.w.faults.add('ruler:warmup-commit')
    world.now = Math.max(world.now, ok(await r.stub.health(r.tenant)).alarmAtMs!)
    const t = world.now
    const crashed = await runInDurableObject(r.stub, (inst) => inst.alarm()).then(() => 'ok', (e) => (e instanceof Crash || /injected crash/.test(String(e)) ? 'crashed' : String(e)))
    expect(crashed).toBe('crashed')
    expect(await r.stateRows()).toEqual([])
    expect((await r.warmupRow()).map((x) => x.status)).toEqual(['pending'])
    await evictDurableObject(r.stub)
    expect(await runDurableObjectAlarm(r.stub)).toBe(true)
    expect(r.log.filter((x) => x.startsWith('range'))).toHaveLength(2)
    const end = t - MIN
    const ts = Array.from({ length: 21 }, (_x, i) => end - 19 * MIN + i * MIN)
    expect(storedState(await r.stateRows(), 'c')).toEqual(libraryState(ts, ts.map((x) => noise(x))))
    expect((await r.warmupRow()).map((x) => [x.status, x.attempts])).toEqual([['done', 1]])
    await r.tick()
    expect(r.log.filter((x) => x.startsWith('range'))).toHaveLength(2)
  })

  it('an SLO rule: both reads are planned before either is fetched; the rings are written as rows in one transaction; the first evaluation sees every window and the whole compliance window', async () => {
    const r = await rig([sloEntry()], undefined, { group: 'slos/1m' })
    const t = await r.tick()
    const end = t - MIN
    const plans = r.log.filter((x) => x.startsWith('plan'))
    // Planned whole first; then fetched window by window (sized to the warm-up's memory budget).
    expect(r.log.slice(0, 2)).toEqual(plans)
    // The coarse read first: it holds the earlier time.
    const [coarse, fine] = plans.map((x) => x.split(' ').slice(1).map(Number))
    expectWindows(r.w.rangeCalls, r.w.rangeCalls[r.w.rangeCalls.length - 1]![0], fine![0]!, fine![1]!, MIN)
    expectWindows(r.w.rangeCalls, r.w.rangeCalls[0]![0], coarse![0]!, coarse![1]!, HOUR)
    // The fine read ends one interval before this tick and holds at least the 3-day window.
    expect([fine![1], fine![2]]).toEqual([end, MIN])
    expect((fine![1]! - fine![0]!) / MIN + 1).toBeGreaterThanOrEqual(4320)
    // The coarse read is hourly and ends where the fine read's first hour begins.
    expect(coarse![2]).toBe(HOUR)
    expect(fine![0]! - coarse![1]!).toBe(MIN)
    const s = await r.rule('CheckoutSLO')
    expect(s.slo).toMatchObject({ status: 'ok', warming: 0, budgetRemaining: 1, budgetCoveredMs: 30 * DAY, warmup: { status: 'done', plan: { queries: 2 } } })
    const rows = await runInDurableObject(r.stub, (_i, st) => st.storage.sql.exec('SELECT part, COUNT(*) AS n FROM slo_state WHERE tenant = ? GROUP BY part ORDER BY part', r.tenant).toArray())
    expect(rows.map((x) => x.part)).toEqual(['coarse', 'fine', 'head'])
    expect(rows.find((x) => x.part === 'fine')!.n).toBeGreaterThanOrEqual(72)
    expect(rows.find((x) => x.part === 'coarse')!.n).toBeGreaterThanOrEqual(30)
  })
})

/** Live alert states per tick, as backtest intervals (with the annotations each alert had when it entered its state). */
function intervalsOf(ticks: { ts: number; alerts: Alert[] }[], to: number) {
  const open = new Map<string, BacktestInterval>()
  const out: BacktestInterval[] = []
  for (const { ts, alerts } of ticks) {
    const now = new Map(alerts.filter((a) => a.state !== 'inactive').map((a) => [a.fingerprint, a]))
    for (const fp of new Set([...open.keys(), ...now.keys()])) {
      const cur = open.get(fp)
      const a = now.get(fp)
      if (cur && cur.state === a?.state) continue
      if (cur) {
        cur.endMs = ts
        cur.open = false
        open.delete(fp)
      }
      if (a) {
        const next: BacktestInterval = { fingerprint: fp, labels: a.labels, state: a.state as 'pending' | 'firing', startMs: ts, endMs: to, open: true, noData: false, annotations: a.annotations }
        out.push(next)
        open.set(fp, next)
      }
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs || (a.fingerprint < b.fingerprint ? -1 : 1))
}

const good = (r: BacktestResponse) => {
  if (r.status !== 'ok') throw new Error(JSON.stringify(r).slice(0, 500))
  return r
}

describe('backtests: the rule\'s own evaluation over history, in time order', () => {
  it('an anomaly rule: over data it fired on live, a backtest from its creation gives the same alerts at the same times with the same explanations', async () => {
    // Two bursts on b and one on c, inside 60 minutes of live ticks.
    const values: Values = (s, t) => {
      const m = Math.round(t / MIN) % 1000
      return (s === 'b' && (m % 41 === 7 || m % 41 === 8)) || (s === 'c' && m % 53 === 30) ? 400 : noise(t)
    }
    const r = await rig([ewma({ for: '1m', annotations: { summary: '{{ $labels.service }} latency {{ $value }}' } })], values)
    const ticks: { ts: number; alerts: Alert[] }[] = []
    for (let i = 0; i < 60; i++) {
      const ts = await r.tick()
      ticks.push({ ts, alerts: (await r.rule()).alerts })
    }
    const from = ticks[0]!.ts
    const to = ticks.at(-1)!.ts
    const live = intervalsOf(ticks, to)
    expect(live.filter((x) => x.state === 'firing').length, 'it fired live').toBeGreaterThanOrEqual(2)
    const bt = good(await r.stub.backtest(r.tenant, ewma({ for: '1m', annotations: { summary: '{{ $labels.service }} latency {{ $value }}' } }), from, to, MIN))
    expect(bt.kind).toBe('anomaly')
    const strip = (xs: BacktestInterval[]) => xs.map(({ fingerprint, state, startMs, endMs, open, annotations }) => ({ fingerprint, state, startMs, endMs, open, annotations }))
    expect(strip(bt.intervals)).toEqual(strip(live))
    expect(bt.intervals.find((x) => x.state === 'firing')!.annotations!.anomaly).toMatch(/^400 ms is [\d.]+ standard deviations above the exponentially weighted mean/)
    // Warmed exactly as the live rule was: the same read before `from`.
    expect(bt.warmup).toEqual({ reads: [{ fromMs: from - 20 * MIN, toMs: from - MIN, stepMs: MIN }], points: 60 })
    expect(bt.cost).toMatchObject({ scanSamples: 1000, bytesToRead: 4096, queries: 1, budget: { scanSamples: 20_000_000, bytesToRead: 128 << 20 }, memory: { budgetBytes: 32 << 20 } })
    expect(bt.cost!.memory!.peakBytes).toBeLessThanOrEqual(32 << 20)
  })

  it('an SLO rule: over data it paged and ticketed on live, the backtest gives the same alerts at the same times with the same sentences', async () => {
    // History: a trickle of errors (half the budget rate); live: two six-minute outages.
    const outage = (t: number) => {
      const m = Math.round(t / MIN)
      return t >= T0 && m % 97 >= 10 && m % 97 < 16 ? 1000 : m % 2
    }
    const r = await rig([sloEntry()], undefined, { group: 'slos/1m', slo: outage })
    const ticks: { ts: number; alerts: Alert[] }[] = []
    for (let i = 0; i < 100; i++) {
      const ts = await r.tick()
      ticks.push({ ts, alerts: (await r.rule('CheckoutSLO')).alerts })
    }
    const from = ticks[0]!.ts
    const to = ticks.at(-1)!.ts
    const live = intervalsOf(ticks, to)
    const severities = new Set(live.map((x) => x.labels.severity))
    expect(severities, 'it paged and ticketed live').toEqual(new Set(['page', 'ticket']))
    const bt = good(await r.stub.backtest(r.tenant, sloEntry(), from, to, MIN))
    expect(bt.kind).toBe('slo')
    const strip = (xs: BacktestInterval[]) => xs.map(({ fingerprint, state, startMs, endMs, open, annotations, labels }) => ({ fingerprint, state, startMs, endMs, open, annotations, labels }))
    expect(strip(bt.intervals)).toEqual(strip(live))
    expect(bt.intervals.find((x) => x.labels.severity === 'page')!.annotations!.slo).toMatch(/^error budget burning at .*\(page threshold (14\.4|6)×\).*% of the budget is left over the last 30 days/)
    expect(bt.cost!.queries).toBe(2)
  })

  it('every backtest is planned first and refused whole past the budget, for every kind; a step other than the interval is refused for detectors', async () => {
    const r = await rig([ewma()])
    r.plan({ scanSamples: 25_000_000, bytesToRead: 1 << 20, seriesEstimate: 3, refusal: null })
    const T = T0 - DAY
    for (const rule of [{ alert: 'Hot', expr: 'latency_ms > 300' }, ewma(), sloEntry()]) {
      const res = await r.stub.backtest(r.tenant, rule, T, T + DAY, MIN)
      expect(res).toMatchObject({ status: 'over_budget', budget: { scanSamples: 20_000_000, bytesToRead: 128 << 20 } })
      expect(res.status === 'over_budget' && res.message).toMatch(/^over budget: the read would scan \d+ samples .* the budget is 20000000 samples and 134217728 bytes\. Nothing was fetched/)
    }
    expect(r.log.filter((x) => x.startsWith('range'))).toEqual([])
    expect(await r.stub.backtest(r.tenant, ewma(), T, T + HOUR, 5 * MIN, MIN)).toMatchObject({ status: 'invalid', errors: [{ path: 'stepMs', message: expect.stringMatching(/an anomaly rule is backtested at its interval \(1m\)/) }] })
    expect(await r.stub.backtest(r.tenant, { record: 'x:y', expr: 'up' }, T, T + HOUR, MIN)).toMatchObject({ status: 'invalid', errors: [{ path: 'rule', message: 'a recording rule cannot be backtested' }] })
  })
})

describe('backtests through the monitors API', () => {
  it('POST /monitors/backtest takes an SLO or anomaly monitor about to be saved; POST /monitors/{id}/backtest a saved one, at its interval; over budget is 422 over_budget; only the caller\'s own monitors and data', async () => {
    const outage = (t: number) => (Math.round(t / MIN) % 97 >= 10 && Math.round(t / MIN) % 97 < 16 ? 1000 : 0)
    const a = await rig([], undefined, { slo: outage })
    const b = await rig([], undefined, { slo: () => 0 })
    const ka = await apiKey(a.tenant)
    const kb = await apiKey(b.tenant)
    const doc = { name: 'Checkout availability', slo: { objective: 0.999, sli: { bad: SLI.bad, total: SLI.total } } }
    const T = world.now - (world.now % MIN)
    const draft = await call(ka.auth, 'POST', '/api/v1/monitors/backtest', { monitor: doc, fromMs: T - 2 * HOUR, toMs: T, step: '1m' })
    expect(draft.status, draft.text).toBe(200)
    expect(draft.json.kind).toBe('slo')
    expect(draft.json.intervals.some((x: BacktestInterval) => x.state === 'firing' && x.labels.severity === 'page' && /^error budget burning/.test(x.annotations!.slo!))).toBe(true)
    const anomalyDraft = await call(ka.auth, 'POST', '/api/v1/monitors/backtest', { monitor: { name: 'Latency', query: LAT, anomaly: {} }, fromMs: T - HOUR, toMs: T, step: '1m' })
    expect([anomalyDraft.status, anomalyDraft.json.kind]).toEqual([200, 'anomaly'])
    const saved = await call(ka.auth, 'POST', '/api/v1/monitors', doc)
    expect(saved.status, saved.text).toBe(201)
    expect(saved.json).toMatchObject({ group: 'slos/1m', expr: null, sloHistory: { lookbackMs: 4320 * MIN } })
    const byId = await call(ka.auth, 'POST', `/api/v1/monitors/${saved.json.id}/backtest`, { fromMs: T - 2 * HOUR, toMs: T })
    expect(byId.status, byId.text).toBe(200)
    expect(byId.json.intervals.map((x: BacktestInterval) => [x.state, x.startMs, x.endMs, x.labels.severity])).toEqual(draft.json.intervals.map((x: BacktestInterval) => [x.state, x.startMs, x.endMs, x.labels.severity]))
    // Past the budget: refused, nothing fetched.
    const ranges = a.w.rangeCalls.length
    a.plan({ scanSamples: 30_000_000, bytesToRead: 0, seriesEstimate: 1, refusal: null })
    const over = await call(ka.auth, 'POST', `/api/v1/monitors/${saved.json.id}/backtest`, { fromMs: T - 2 * HOUR, toMs: T })
    expect([over.status, over.json.error.code, over.json.budget]).toEqual([422, 'over_budget', { scanSamples: 20_000_000, bytesToRead: 128 << 20 }])
    expect(a.w.rangeCalls.length).toBe(ranges)
    const wrongStep = await call(ka.auth, 'POST', `/api/v1/monitors/${saved.json.id}/backtest`, { fromMs: T - HOUR, toMs: T, step: '5m' })
    expect([wrongStep.status, wrongStep.json.problems?.[0]?.path]).toEqual([422, 'stepMs'])
    // Tenant B: A's monitor is not found, whatever B names; B's own backtest reads B's data only.
    const bRanges = b.w.rangeCalls.length
    for (const [q, h, body] of [['', {}, {}], [`?tenant=${a.tenant}`, { 'X-Scope-OrgID': a.tenant }, { tenant: a.tenant }]] as const) {
      const res = await call(kb.auth, 'POST', `/api/v1/monitors/${saved.json.id}/backtest${q}`, { fromMs: T - HOUR, toMs: T, ...body }, h)
      expect(res.status, res.text).toBe(404)
    }
    a.plan({ scanSamples: 0, bytesToRead: 0, seriesEstimate: 1, refusal: null })
    const aRanges = a.w.rangeCalls.length
    const mine = await call(kb.auth, 'POST', `/api/v1/monitors/backtest?tenant=${a.tenant}`, { monitor: doc, fromMs: T - 2 * HOUR, toMs: T, step: '1m' }, { 'X-Scope-OrgID': a.tenant })
    expect(mine.status, mine.text).toBe(200)
    expect(mine.json.intervals, 'B has no outage').toEqual([])
    expect(a.w.rangeCalls.length, 'nothing read for A').toBe(aRanges)
    expect(b.w.rangeCalls.length).toBeGreaterThan(bRanges)
  })
})

describe('streaming: history is read and evaluated in windows sized to a memory budget', () => {
  const small = (tenantStub: { configure: (t: string, p: never) => Promise<unknown> }, tenant: string, bytes: number) => tenantStub.configure(tenant, { limits: { maxBacktestMemoryBytes: bytes } } as never)

  it('across many window boundaries an anomaly and an SLO backtest give exactly the alerts, times and explanations of one window and of live evaluation', async () => {
    const values: Values = (s, t) => {
      const m = Math.round(t / MIN) % 1000
      return (s === 'b' && (m % 41 === 7 || m % 41 === 8)) || (s === 'c' && m % 53 === 30) ? 400 : noise(t)
    }
    const rule = ewma({ for: '1m', annotations: { summary: '{{ $labels.service }} latency {{ $value }}' } })
    const r = await rig([rule], values)
    const ticks: { ts: number; alerts: Alert[] }[] = []
    for (let i = 0; i < 60; i++) ticks.push({ ts: await r.tick(), alerts: (await r.rule()).alerts })
    const from = ticks[0]!.ts
    const to = ticks.at(-1)!.ts
    const strip = (xs: BacktestInterval[]) => xs.map(({ fingerprint, state, startMs, endMs, open, annotations }) => ({ fingerprint, state, startMs, endMs, open, annotations }))
    const whole = good(await r.stub.backtest(r.tenant, rule, from, to, MIN))
    expect(whole.cost!.memory!.windowSteps).toEqual([80])
    // A budget a little over the fixed bytes: windows of a few steps.
    ok((await small(r.stub as never, r.tenant, 7_200_000)) as never)
    const before = r.w.rangeCalls.length
    const windowed = good(await r.stub.backtest(r.tenant, rule, from, to, MIN))
    const ws = expectWindows(r.w.rangeCalls.slice(before), LAT, from - 20 * MIN, to, MIN)
    expect(ws.length, 'many windows').toBeGreaterThan(5)
    expect(windowed.cost!.memory!.windowSteps[0]).toBe(ws[0]![1] / MIN - ws[0]![0] / MIN + 1)
    expect(windowed.cost!.memory!.peakBytes).toBeLessThanOrEqual(7_200_000)
    expect(strip(windowed.intervals)).toEqual(strip(whole.intervals))
    expect(strip(windowed.intervals)).toEqual(strip(intervalsOf(ticks, to)))
    expect(windowed.warmup).toEqual(whole.warmup)

    // The SLO rule: the coarse read and the fine read both cut into windows.
    const outage = (t: number) => {
      const m = Math.round(t / MIN)
      return t >= T0 && m % 97 >= 10 && m % 97 < 16 ? 1000 : m % 2
    }
    const s = await rig([sloEntry()], undefined, { group: 'slos/1m', slo: outage })
    const sticks: { ts: number; alerts: Alert[] }[] = []
    for (let i = 0; i < 100; i++) sticks.push({ ts: await s.tick(), alerts: (await s.rule('CheckoutSLO')).alerts })
    const sFrom = sticks[0]!.ts
    const sTo = sticks.at(-1)!.ts
    const sWhole = good(await s.stub.backtest(s.tenant, sloEntry(), sFrom, sTo, MIN))
    ok((await small(s.stub as never, s.tenant, 7_400_000)) as never)
    const sBefore = s.w.rangeCalls.length
    const sWindowed = good(await s.stub.backtest(s.tenant, sloEntry(), sFrom, sTo, MIN))
    const fineCalls = s.w.rangeCalls.slice(sBefore).filter((c) => c[3] === MIN)
    expect(fineCalls.length, 'many fine windows').toBeGreaterThan(20)
    expect(s.w.rangeCalls.slice(sBefore).filter((c) => c[3] === HOUR).length, 'the coarse read in windows too').toBeGreaterThan(1)
    expect(strip(sWindowed.intervals)).toEqual(strip(sWhole.intervals))
    expect(strip(sWindowed.intervals)).toEqual(strip(intervalsOf(sticks, sTo)))
    expect(sWindowed.intervals.some((x) => x.labels.severity === 'page')).toBe(true)
  })

  it('refused before any plan or fetch when the modelled peak cannot fit: an SLO rule\'s rings over the budget, and 1,000 series of SLO state at the default budget; the answer says the model\'s numbers', async () => {
    const { tenant, stub, w } = await setup({ heartbeatMs: 6 * HOUR })
    const key = await apiKey(tenant)
    w.range = () => {
      throw new Error('fetched although refused')
    }
    ok(await stub.configure(tenant, { limits: { maxBacktestMemoryBytes: 4 << 20 } } as never))
    const T = T0 - DAY
    const tooSmall = await stub.backtest(tenant, { alert: 'S', slo: { objective: 0.999, sli: SLI, max_series: 100 } }, T, T + HOUR, MIN)
    expect(tooSmall).toMatchObject({ status: 'over_budget', plan: null, memory: { budgetBytes: 4 << 20 } })
    expect(tooSmall.status === 'over_budget' && tooSmall.message).toMatch(/^over the memory budget: holding this rule's state \([\d.]+ MiB\) and one step of 200 series would take [\d.]+ MiB; the budget is 4\.0 MiB\. Nothing was fetched/)
    // 1,000 series of SLO state (the limit raised to allow the rule) is about 80 MB of rings: refused at the default 32 MiB.
    ok(await stub.configure(tenant, { limits: { maxBacktestMemoryBytes: 32 << 20, maxSloSeriesPerRule: 1000 } } as never))
    const thousand = await call(key.auth, 'POST', '/api/v1/monitors/backtest', { rule: { alert: 'S', slo: { objective: 0.999, sli: SLI, max_series: 1000 } }, fromMs: T, toMs: T + 7 * DAY - MIN, step: '1m' })
    expect([thousand.status, thousand.json.error.code, thousand.json.plan]).toEqual([422, 'over_budget', null])
    expect(thousand.json.memory.peakBytes).toBeGreaterThan(80_000_000)
    expect(w.planCalls).toEqual([])
    expect(w.rangeCalls).toEqual([])
  })

  it('a warm-up whose window cannot fit its memory budget is refused before any plan; the rule starts cold and says why', async () => {
    const r = await rig([ewma()])
    ok(await r.stub.configure(r.tenant, { limits: { maxWarmupMemoryBytes: 1 << 20 } } as never))
    await r.tick()
    expect(r.log.filter((x) => !x.startsWith('query'))).toEqual([])
    expect((await r.rule()).anomaly!.warmup).toMatchObject({ status: 'refused', plan: null, message: expect.stringMatching(/^over the memory budget: holding this rule's state \(2\.0 MiB\) and one step of 100 series would take [\d.]+ MiB; the budget is 1\.0 MiB; nothing was fetched and the rule started cold$/) })
  })

  it('a window holding more points than the model sized it for (more series than the rule allows) stops the run with that reason', async () => {
    const r = await rig([ewma()])
    await r.tick()
    const base = r.w.range!
    r.w.range = (q, s0, e, st) => {
      const m = base(q, s0, e, st) as PromMatrix
      // Two hundred series, where the rule allows max_series 100.
      return { resultType: 'matrix', result: Array.from({ length: 200 }, (_x, k) => ({ metric: { service: `x${k}` }, values: m.result[0]!.values })) }
    }
    const T = T0 - DAY
    const res = await r.stub.backtest(r.tenant, ewma(), T, T + HOUR, MIN)
    expect(res).toMatchObject({ status: 'failed', error: expect.stringMatching(/^the engine returned \d+ points for a window the memory model sized for \d+ \(100 series a step\): more series than the rule allows$/) })
  })
})

describe('CPU: a run the model prices over its budget is refused whole, never cut off by the platform', () => {
  const limits = (r: { stub: { configure: (t: string, p: never) => Promise<unknown> }; tenant: string }, l: Record<string, number>) => r.stub.configure(r.tenant, { limits: l } as never)

  it('a backtest is refused after reading only its first window, with the projection of the whole run (which, allowed, is what the run then costs), through RPC and HTTP', async () => {
    const r = await rig([ewma()])
    const T = T0 - DAY
    ok((await limits(r as never, { maxBacktestMemoryBytes: 7_200_000, maxBacktestCpuMs: 20 })) as never)
    const res = await r.stub.backtest(r.tenant, ewma(), T, T + 6 * HOUR, MIN)
    if (res.status !== 'over_budget') throw new Error(JSON.stringify(res))
    expect(res.message).toMatch(/^over the CPU budget: the first window shows 3 series; the whole run would take about \d+ ms of CPU \(modelled\), the budget is 20 ms\. Nothing was evaluated\. Shorten the range, lengthen the step \(alerting rules only\), or narrow the expression; an operator can raise maxBacktestCpuMs/)
    expect(res.cpu!.budgetMs).toBe(20)
    expect(res.cpu!.modelledMs).toBeGreaterThan(20)
    expect(res.plan).toMatchObject({ queries: 1 })
    // Planned whole, then one window read: the one that counts the series.
    expect(r.w.planCalls).toHaveLength(1)
    expect(r.w.rangeCalls).toHaveLength(1)
    expect(r.w.rangeCalls[0]![2]).toBeLessThan(T + 6 * HOUR)

    // Allowed, with the same series at every step, the run's account is the projection exactly.
    ok((await limits(r as never, { maxBacktestCpuMs: 600_000 })) as never)
    const allowed = good(await r.stub.backtest(r.tenant, ewma(), T, T + 6 * HOUR, MIN))
    expect(allowed.cost!.cpu).toEqual({ modelledMs: res.cpu!.modelledMs, budgetMs: 600_000 })
    expect(r.w.rangeCalls.length, 'many windows').toBeGreaterThan(5)

    ok((await limits(r as never, { maxBacktestCpuMs: 20 })) as never)
    const key = await apiKey(r.tenant)
    const http = await call(key.auth, 'POST', '/api/v1/monitors/backtest', { rule: ewma(), fromMs: T, toMs: T + 6 * HOUR, step: '1m' })
    expect([http.status, http.json.error.code, http.json.cpu]).toEqual([422, 'over_budget', { modelledMs: res.cpu!.modelledMs, budgetMs: 20 }])
  })

  it('a run whose series grow is stopped before the first window that shows them, nothing kept; the series it had seen fitted the budget', async () => {
    const r = await rig([ewma()])
    const T = T0 - DAY
    const grow = T + 3 * HOUR
    const base = r.w.range!
    r.w.range = (q, s0, e, st) => {
      const m = base(q, s0, e, st) as PromMatrix
      // From `grow` on, 97 more series (100 in all, the rule's max_series).
      const later = m.result[0]!.values.filter(([sec]) => sec * 1000 >= grow)
      if (later.length === 0) return m
      return { resultType: 'matrix', result: [...m.result, ...Array.from({ length: 97 }, (_x, k) => ({ metric: { service: `x${k}` }, values: later }))] }
    }
    ok((await limits(r as never, { maxBacktestMemoryBytes: 7_200_000, maxBacktestCpuMs: 60 })) as never)
    const res = await r.stub.backtest(r.tenant, ewma(), T, T + 6 * HOUR, MIN)
    if (res.status !== 'over_budget') throw new Error(JSON.stringify(res))
    const [, fed, total] = /^over the CPU budget: after (\d+) of (\d+) windows the run shows 100 series; the whole run would take about \d+ ms of CPU \(modelled\), the budget is 60 ms\. Stopped before evaluating more; nothing is kept\./.exec(res.message) ?? []
    expect(Number(fed)).toBe(r.w.rangeCalls.length - 1)
    expect(Number(total)).toBeGreaterThan(Number(fed) + 1)
    // The window that showed them is the first holding a step at or after `grow`.
    expect(r.w.rangeCalls.at(-2)![2]).toBeLessThan(grow)
    expect(r.w.rangeCalls.at(-1)![2]).toBeGreaterThanOrEqual(grow)
    // The same range with the original three series fits.
    r.w.range = base
    expect(good(await r.stub.backtest(r.tenant, ewma(), T, T + 6 * HOUR, MIN)).cost!.cpu!.modelledMs).toBeLessThanOrEqual(60)
  })

  it('a warm-up priced over maxWarmupCpuMs is refused after its first window; the rule starts cold at once and says why', async () => {
    const s = await rig([sloEntry()], undefined, { group: 'slos/1m' })
    ok((await limits(s as never, { maxWarmupCpuMs: 10 })) as never)
    await s.tick()
    expect(s.w.rangeCalls).toHaveLength(1)
    const st = await s.rule('CheckoutSLO')
    expect(st.slo!.warmup).toMatchObject({ status: 'refused', attempts: 1, message: expect.stringMatching(/^over the CPU budget: the first window shows 2 series; the whole run would take about \d+ ms of CPU \(modelled\), the budget is 10 ms\. Nothing was evaluated; the rule started cold$/) })
    expect(st.slo!.warmup!.finishedAt).not.toBeNull()
    // Cold, not waiting: evaluated at this tick.
    expect(s.log.filter((x) => x.startsWith('query'))).toHaveLength(1)
  })

  const long = (name: string) => ({ alert: name, expr: LAT, keep_firing_for: '0s', anomaly: { params: { halfLifePoints: 300, minPoints: 5 }, unit: 'ms' } })
  const keyOf = async (r: Awaited<ReturnType<typeof rig>>, name: string) => ok(await r.stub.listGroups(r.tenant)).groups.flatMap((g) => g.anomalyRules ?? []).find((x) => x.name === name)!.key
  const stateOf = async (r: Awaited<ReturnType<typeof rig>>, name: string, service: string) => {
    const key = await keyOf(r, name)
    return storedState((await r.stateRows()).filter((x) => x.rule_key === key), service)
  }
  // The library's state over a contiguous run of points ending at `end`: 600 of look-back and what was evaluated live.
  const library = (from: number, end: number) => {
    const ts: number[] = []
    for (let t = from; t <= end; t += MIN) ts.push(t)
    return libraryState(ts, ts.map((x) => noise(x)), 300)
  }

  it('the warm-ups of one alarm share maxWarmupCpuMs: one that fits a warm-up but not what is left waits for the next alarm (no attempt counted, through an eviction) and is then warmed whole, to the state the library computes', async () => {
    const r = await rig([long('A1'), long('A2')])
    ok((await limits(r as never, { maxWarmupCpuMs: 40 })) as never)
    const t1 = await r.tick()
    expect((await r.rule('A1')).anomaly!.warmup).toMatchObject({ status: 'done', attempts: 1 })
    const w2 = (await r.rule('A2')).anomaly!.warmup!
    expect(w2).toMatchObject({ status: 'pending', attempts: 0, finishedAt: null })
    expect(w2.message).toMatch(/^waiting for the next alarm: over the CPU budget: the first window shows 3 series; the whole run would take about (\d+) ms of CPU \(modelled\), the budget is \d+ ms\. Nothing was evaluated; it fits a warm-up's 40 ms but not the \d+ ms this alarm had left$/)
    expect(await r.warmupRow()).toContainEqual(expect.objectContaining({ status: 'pending', attempts: 0 }))
    await evictDurableObject(r.stub)
    const t2 = await r.tick()
    expect(t2).toBe(t1 + MIN)
    expect((await r.rule('A2')).anomaly!.warmup).toMatchObject({ status: 'done', attempts: 1 })
    // A2 is the rule it would be had it been created a tick later: 600 points ending one interval before t2, then t2 live.
    expect(await stateOf(r, 'A2', 'b')).toEqual(library(t2 - 600 * MIN, t2))
    // A1: warmed at t1 and evaluated live at t1 and t2.
    expect(await stateOf(r, 'A1', 'b')).toEqual(library(t1 - 600 * MIN, t2))
  })

  it('groups evaluated in the same alarm reserve the budget before reading: two warm-ups that fit one at a time do not both run', async () => {
    const r = await rig([long('A1')])
    ok(await r.stub.saveGroups(r.tenant, { groups: [{ name: 'g', interval: '1m', rules: [long('A1')] }, { name: 'h', interval: '1m', rules: [long('A2')] }] }))
    ok((await limits(r as never, { maxWarmupCpuMs: 40 })) as never)
    // A late alarm: both groups are due in it, evaluated concurrently.
    world.now = ok(await r.stub.health(r.tenant)).alarmAtMs! + 2 * MIN
    expect(await runDurableObjectAlarm(r.stub)).toBe(true)
    const states = [(await r.rule('A1')).anomaly!.warmup!.status, (await r.rule('A2')).anomaly!.warmup!.status].sort()
    expect(states).toEqual(['done', 'pending'])
  })
})
