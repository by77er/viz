/**
 * Backtest: "if this rule had existed". It must be the live state machine run over
 * history, not a second implementation, and its chart data and its summary numbers must
 * be one computation.
 */
import { describe, expect, it } from 'vitest'
import type { PromMatrix } from '../../contracts/engine'
import type { Alert, BacktestInterval, BacktestResponse } from '../contracts-proposal/rules.v2'
import { summarize } from '../src/backtest'
import { alertsOf, expectWindows, MIN, nextTick, ok, setup } from './helpers'

type Ok = Extract<BacktestResponse, { status: 'ok' }>
const good = (r: BacktestResponse): Ok => {
  if (r.status !== 'ok') throw new Error(JSON.stringify(r))
  return r
}

/** A matrix from per-series functions of the step time. */
function matrix(series: Record<string, (ts: number) => number | null>, from: number, to: number, step: number): PromMatrix {
  return {
    resultType: 'matrix',
    result: Object.entries(series).map(([instance, f]) => {
      const values: [number, string][] = []
      for (let ts = from; ts <= to; ts += step) {
        const v = f(ts)
        if (v !== null) values.push([ts / 1000, String(v)])
      }
      return { metric: { __name__: 'm', instance }, values }
    }),
  }
}

/** The intervals a sequence of live alert states implies: the same definition the backtest uses, computed from the live object's output. */
function intervalsOf(ticks: { ts: number; alerts: Alert[] }[], to: number): Omit<BacktestInterval, 'labels' | 'noData'>[] {
  const open = new Map<string, Omit<BacktestInterval, 'labels' | 'noData'>>()
  const out: Omit<BacktestInterval, 'labels' | 'noData'>[] = []
  for (const { ts, alerts } of ticks) {
    const now = new Map(alerts.filter((a) => a.state !== 'inactive').map((a) => [a.fingerprint, a.state as 'pending' | 'firing']))
    for (const fp of new Set([...open.keys(), ...now.keys()])) {
      const cur = open.get(fp)
      const state = now.get(fp)
      if (cur && cur.state === state) continue
      if (cur) {
        cur.endMs = ts
        cur.open = false
        open.delete(fp)
      }
      if (state) {
        const next = { fingerprint: fp, state, startMs: ts, endMs: to, open: true }
        out.push(next)
        open.set(fp, next)
      }
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs || (a.fingerprint < b.fingerprint ? -1 : 1))
}

const strip = (xs: BacktestInterval[]) => xs.map(({ fingerprint, state, startMs, endMs, open }) => ({ fingerprint, state, startMs, endMs, open }))

describe('live evaluation and backtest agree', () => {
  for (const seed of [1, 2, 3, 4]) {
    it(`a recorded sequence of 90 ticks, three flapping series, for + keep_firing_for (seed ${seed}): identical intervals`, async () => {
      const { tenant, stub, w } = await setup()
      // A deterministic flapping pattern per series.
      let x = seed * 7919
      const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
      const plan = new Map<number, Record<string, number>>()
      const present: Record<string, boolean> = { a: false, b: false, c: false }
      const recorded: { ts: number; row: Record<string, number> }[] = []
      w.evaluate = (_q, ts) => {
        let row = plan.get(ts)
        if (!row) {
          row = {}
          for (const i of Object.keys(present)) {
            if (rnd() < 0.22) present[i] = !present[i]
            if (present[i]) row[i] = Math.round(rnd() * 100) / 10
          }
          plan.set(ts, row)
          recorded.push({ ts, row })
        }
        return { resultType: 'vector', result: Object.entries(row).map(([instance, v]) => ({ metric: { __name__: 'm', instance }, value: [ts / 1000, String(v)] })) }
      }
      const rule = { alert: 'Flap', expr: 'm > 0', for: '2m', keep_firing_for: '3m', labels: { severity: 'page' }, annotations: { summary: '{{ $labels.instance }} at {{ $value }}' } }
      ok(await stub.saveGroups(tenant, { groups: [{ name: 'g', interval: '1m', rules: [rule] }] }))
      const live: { ts: number; alerts: Alert[] }[] = []
      for (let i = 0; i < 90; i++) {
        const ts = await nextTick(stub, tenant)
        live.push({ ts, alerts: await alertsOf(stub, tenant) })
      }
      const from = live[0]!.ts
      const to = live[live.length - 1]!.ts
      // History, as the range evaluator would return it: exactly what the live ticks saw.
      w.range = (_q, start, end, step) => matrix(Object.fromEntries(Object.keys(present).map((i) => [i, (ts: number) => plan.get(ts)?.[i] ?? null])), start, end, step)
      const bt = good(await stub.backtest(tenant, rule, from, to, MIN, MIN))
      // One read of [from, to], fetched in windows (history.ts): contiguous, no gap, no overlap.
      expectWindows(w.rangeCalls, 'm > 0', from, to, MIN)
      expect(bt.steps).toBe(90)
      const want = intervalsOf(live, to)
      expect(want.filter((i) => i.state === 'firing').length).toBeGreaterThan(2) // the sequence exercises something
      expect(strip(bt.intervals)).toEqual(want)
      // And the state at the end is the live state.
      const liveFiring = live[live.length - 1]!.alerts.filter((a) => a.state === 'firing').map((a) => a.fingerprint).sort()
      expect(bt.intervals.filter((i) => i.open && i.state === 'firing').map((i) => i.fingerprint).sort()).toEqual(liveFiring)
      expect(bt.summary.firingAtEnd).toBe(liveFiring.length > 0)
    })
  }
})

describe('one computation: intervals to shade, and the numbers quoted beside them', () => {
  const T = Date.UTC(2026, 10, 11)
  const rule = { alert: 'CartErrors', expr: '(ratio) > 0.01', for: '5m' }

  /** Above the threshold for [20, 39] minutes and for [100, 136] minutes: with `for: 5m` that is firing for 14 and 31 minutes... */
  const history = (ts: number) => {
    const m = (ts - T) / MIN
    return (m >= 20 && m < 39) || (m >= 100 && m < 136) ? 0.013 : 0.004
  }

  async function run(step: number, expr = rule.expr) {
    const { tenant, stub, w } = await setup()
    w.range = (q, start, end, s) => {
      const all = matrix({ cart: history }, start, end, s)
      // The comparison filters: only points above the threshold are returned.
      return q.includes('>') ? { resultType: 'matrix', result: all.result.map((r) => ({ metric: r.metric, values: r.values.filter((v) => Number(v[1]) > 0.01) })) } : all
    }
    return { bt: good(await stub.backtest(tenant, { ...rule, expr }, T, T + 180 * MIN, step, MIN)), w }
  }

  it('"it would have fired twice, for 14 and 31 minutes": the sentence and the shaded spans come from the same list', async () => {
    const { bt } = await run(MIN)
    const firing = bt.intervals.filter((i) => i.state === 'firing')
    expect(firing.map((i) => [(i.startMs - T) / MIN, (i.endMs - T) / MIN, i.open])).toEqual([[25, 39, false], [105, 136, false]])
    expect(firing.map((i) => (i.endMs - i.startMs) / MIN)).toEqual([14, 31])
    expect(bt.intervals.filter((i) => i.state === 'pending').map((i) => [(i.startMs - T) / MIN, (i.endMs - T) / MIN])).toEqual([[20, 25], [100, 105]])
    expect(bt.summary).toEqual({ firingCount: 2, pendingCount: 2, firingMs: 45 * MIN, longestFiringMs: 31 * MIN, clearedCount: 0, firingAtEnd: false, series: 1 })
    // The summary is a pure function of the intervals: recomputing it from what a chart would shade gives the same numbers.
    expect(summarize(bt.intervals)).toEqual(bt.summary)
    expect(bt.intervals.every((i) => i.labels.alertname === 'CartErrors' && i.labels.instance === 'cart')).toBe(true)
  })

  it('a breach shorter than `for` shows as a pending span that cleared, and counts as no firing', async () => {
    const { tenant, stub, w } = await setup()
    w.range = (_q, s, e, st) => matrix({ cart: (ts) => ((ts - T) / MIN >= 10 && (ts - T) / MIN < 13 ? 1 : null) }, s, e, st)
    const bt = good(await stub.backtest(tenant, rule, T, T + 60 * MIN, MIN, MIN))
    expect(bt.intervals.map((i) => [i.state, (i.startMs - T) / MIN, (i.endMs - T) / MIN])).toEqual([['pending', 10, 13]])
    expect(bt.summary).toMatchObject({ firingCount: 0, pendingCount: 1, clearedCount: 1, firingMs: 0 })
  })

  it('an alert still firing at the end is an open interval ending at toMs', async () => {
    const { tenant, stub, w } = await setup()
    w.range = (_q, s, e, st) => matrix({ cart: (ts) => (ts >= T + 30 * MIN ? 1 : null) }, s, e, st)
    const bt = good(await stub.backtest(tenant, rule, T, T + 60 * MIN, MIN, MIN))
    expect(bt.intervals.at(-1)).toMatchObject({ state: 'firing', startMs: T + 35 * MIN, endMs: T + 60 * MIN, open: true })
    expect(bt.summary).toMatchObject({ firingCount: 1, firingAtEnd: true, firingMs: 25 * MIN })
  })

  it('says how the step limits accuracy: a coarse step misses the short firing, shifts the edges, and the result says so', async () => {
    const fine = (await run(MIN)).bt
    const coarse = (await run(30 * MIN)).bt
    // At 30-minute steps the 19-minute breach falls between samples; the 36-minute one is seen at one step only.
    expect(coarse.summary.firingCount).toBeLessThan(fine.summary.firingCount)
    expect(coarse.resolution).toMatchObject({ stepMs: 30 * MIN, liveIntervalMs: MIN, edgeErrorMs: 30 * MIN })
    expect(coarse.resolution.note).toMatch(/Evaluated every 30m; the live rule would be evaluated every 1m/)
    expect(coarse.resolution.note).toMatch(/A breach shorter than 30m can be missed/)
    expect(coarse.resolution.note).toMatch(/"for" \(5m\) is shorter than the step/)
    expect(fine.resolution).toMatchObject({ stepMs: MIN, edgeErrorMs: MIN })
    expect(fine.resolution.note).not.toMatch(/shorter than the step/)
    expect(fine.resolution.note).toMatch(/History is read as it is stored now/)
    // Every edge of the coarse result is within one step of the fine one it corresponds to.
    for (const c of coarse.intervals.filter((i) => i.state === 'firing')) {
      const near = fine.intervals.filter((f) => f.state === 'firing').some((f) => Math.abs(f.startMs - c.startMs) <= 30 * MIN + 5 * MIN)
      expect(near).toBe(true)
    }
  })

  it('applies the no-data policy over history too, with the bare query as the presence check', async () => {
    const { tenant, stub, w } = await setup()
    // Data stops for minutes [30, 50): the comparison is empty the whole time (healthy), the bare query has a hole.
    w.range = (q, s, e, st) => (q.includes('>') ? matrix({}, s, e, st) : matrix({ cart: (ts) => ((ts - T) / MIN >= 30 && (ts - T) / MIN < 50 ? null : 0.001) }, s, e, st))
    const bt = good(await stub.backtest(tenant, { ...rule, no_data: 'alerting', no_data_for: '10m', no_data_expr: 'ratio' }, T, T + 90 * MIN, MIN, MIN))
    // Both reads' series counted first (an alerting rule's bound, 1,000 series, would cut them into minutes), then read in one window each.
    expect(w.rangeCalls.map((c) => c[0])).toEqual(['count((ratio) > 0.01)', 'count(ratio)', '(ratio) > 0.01', 'ratio'])
    expect(expectWindows(w.rangeCalls, 'ratio', T, T + 90 * MIN, MIN)).toEqual(expectWindows(w.rangeCalls, '(ratio) > 0.01', T, T + 90 * MIN, MIN))
    expect(bt.intervals.map((i) => [i.state, i.noData, (i.startMs - T) / MIN, (i.endMs - T) / MIN])).toEqual([['pending', true, 30, 40], ['firing', true, 40, 50]])
  })
})

describe('refusals', () => {
  const T = Date.UTC(2026, 10, 11)
  it('bad ranges, steps, rules and a failing range evaluator are each reported, with a fix where the caller can act', async () => {
    const { tenant, stub, w } = await setup()
    const rule = { alert: 'A', expr: 'm > 0' }
    expect(await stub.backtest(tenant, rule, T, T - 1, MIN)).toMatchObject({ status: 'invalid', errors: [{ path: 'toMs' }] })
    expect(await stub.backtest(tenant, rule, T, T + MIN, 10)).toMatchObject({ status: 'invalid', errors: [{ path: 'stepMs' }] })
    const tooMany = await stub.backtest(tenant, rule, T, T + 30 * 24 * 60 * MIN, MIN)
    expect(tooMany).toMatchObject({ status: 'invalid', errors: [{ path: 'stepMs', message: 'the range needs more than 11000 steps' }] })
    expect(tooMany.status === 'invalid' && tooMany.errors[0]!.fix).toMatch(/at least 236000 ms/)
    expect(await stub.backtest(tenant, { record: 'a:b', expr: 'm' }, T, T + MIN, MIN)).toMatchObject({ status: 'invalid', errors: [{ path: 'rule' }] })
    expect(await stub.backtest(tenant, { alert: 'A', expr: '' }, T, T + MIN, MIN)).toMatchObject({ status: 'invalid', errors: [{ path: 'rule.expr' }] })
    expect(await stub.backtest(tenant, { alert: 'A', expr: 'm', for: 'x' }, T, T + MIN, MIN)).toMatchObject({ status: 'invalid', errors: [{ path: 'rule.for' }] })
    expect(w.rangeCalls).toEqual([]) // nothing was evaluated for an invalid request
    expect(await stub.backtest(tenant, rule, T, T + MIN, MIN)).toEqual({ status: 'failed', error: 'no range evaluator scripted' })
    w.range = () => ({ resultType: 'matrix', result: [{ metric: { a: '1' }, values: [[T / 1000, '1']] }, { metric: { a: '1' }, values: [[T / 1000, '2']] }] })
    expect(await stub.backtest(tenant, rule, T, T + MIN, MIN)).toMatchObject({ status: 'failed', error: expect.stringMatching(/same labelset/) })
    expect(await stub.backtest('someone-else', rule, T, T + MIN, MIN)).toEqual({ status: 'wrong_tenant' })
  })
})
