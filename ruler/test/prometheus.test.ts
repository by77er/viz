/**
 * Prometheus rule-evaluation semantics, ported from prometheus/rules `alerting_test.go` and
 * `manager_test.go` (main branch, fetched from raw.githubusercontent.com on 2026-11-18).
 * Each test names the upstream test whose behaviour it encodes. Upstream drives a real
 * PromQL engine over loaded series; here the query result at each step is written out by
 * hand (the values upstream's `load` lines produce), because the ruler takes the engine as
 * an injected dependency.
 */
import { evictDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { Alert, AlertingRule } from '../contracts-proposal/rules'
import { compileAlertRule, ruleKey } from '../src/rules'
import { ERR_DUPLICATE_ALERT, evalAlertingRule, evalRecordingRule, syntheticSeries, toSeries, type Series } from '../src/statemachine'
import { tenantWorld, world } from './harness'
import { alertsOf, MIN, nextTick, ok, setup, vec } from './helpers'

const mkRule = (over: Partial<AlertingRule> & { name: string }): AlertingRule => {
  const base = { kind: 'alert' as const, expr: 'x', forMs: 0, keepFiringForMs: 0, labels: {}, annotations: {}, ...over }
  return { ...base, key: ruleKey('alert', base.name, base.expr, base.labels), cost: { class: 'tail', windowMs: 0, reason: '' } }
}

/** One alerting rule evaluated step by step, like upstream's `rule.Eval(ctx, 0, evalTime, ...)` loops. */
class Sim {
  alerts: ReadonlyMap<string, Alert> = new Map()
  private compiled
  constructor(readonly rule: AlertingRule, private opts = { resolvedRetentionMs: 15 * MIN, limit: 0, maxAnnotationBytes: 4096, externalLabels: {} as Record<string, string> }) {
    this.compiled = compileAlertRule(rule)
  }
  eval(ts: number, series: Series[], limit = this.opts.limit) {
    const r = evalAlertingRule(this.rule, this.compiled, this.alerts, series, ts, { ...this.opts, limit })
    if (r.ok) this.alerts = r.alerts
    return r
  }
  /** The `ALERTS` samples upstream asserts on: label sets, sorted. */
  ALERTS(ts: number) {
    return syntheticSeries(this.alerts.values(), ts)
      .filter((s) => s.labels.__name__ === 'ALERTS')
      .map((s) => s.labels)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  }
}

const s = (metric: Record<string, string>, value: number): Series => ({ metric, value, text: String(value) })
const http = (instance: string, value: number, extra: Record<string, string> = {}) => s({ __name__: 'http_requests', job: 'app-server', instance, ...extra }, value)

describe('alerting rule state machine (prometheus/rules/alerting_test.go, manager_test.go)', () => {
  it('TestAlertingRule: pending, then firing after `for`; an instance that stops matching goes away; rule labels override series labels', () => {
    const rule = mkRule({ name: 'HTTPRequestRateLow', forMs: MIN, labels: { severity: '{{"c"}}ritical' } })
    const sim = new Sim(rule)
    const canary = { group: 'canary', severity: 'overwrite-me' }
    const v0 = [75, 85, 95, 105, 105, 95, 85]
    const v1 = [80, 90, 100, 110, 120, 130, 140]
    const want = (state: string, instance: string) => ({ __name__: 'ALERTS', alertname: 'HTTPRequestRateLow', alertstate: state, group: 'canary', instance, job: 'app-server', severity: 'critical' })
    const expected = [
      [want('pending', '0'), want('pending', '1')],
      [want('firing', '0'), want('firing', '1')],
      [want('firing', '0')],
      [],
      [],
      [want('pending', '0')],
      [want('firing', '0')],
    ]
    expected.forEach((exp, i) => {
      const ts = i * 5 * MIN
      // `http_requests{...} < 100`
      const series = [http('0', v0[i]!, canary), http('1', v1[i]!, canary)].filter((x) => x.value < 100)
      expect(sim.eval(ts, series).ok).toBe(true)
      expect(sim.ALERTS(ts), `step ${i}`).toEqual(exp)
      // "__name__ label set on active alert" must never happen
      for (const a of sim.alerts.values()) expect(a.labels.__name__).toBeUndefined()
    })
  })

  it('TestAlertingRuleState: the rule is firing if any alert fires, pending if any is pending, else inactive', () => {
    const sim = new Sim(mkRule({ name: 'A', forMs: MIN }))
    const state = () => {
      const st = [...sim.alerts.values()].map((a) => a.state)
      return st.includes('firing') ? 'firing' : st.includes('pending') ? 'pending' : 'inactive'
    }
    expect(state()).toBe('inactive')
    sim.eval(0, [http('0', 1)])
    expect(state()).toBe('pending')
    sim.eval(MIN, [http('0', 1), http('1', 1)])
    expect(state()).toBe('firing') // one firing, one pending
    sim.eval(2 * MIN, [])
    expect(state()).toBe('inactive') // the retained resolved alert does not count
  })

  it('TestAlertingRuleLabelsUpdate: a templated label that changes value makes a new alert each time, so the alert never ages', () => {
    // Upstream templates the label with {{ if lt $value 80.0 }}; branching is outside viz's
    // template subset, so the label here is the value itself. Same mechanism: the identity
    // (label set) changes whenever the label does.
    const sim = new Sim(mkRule({ name: 'HTTPRequestRateLow', forMs: MIN, labels: { seen: '{{ $value }}' } }))
    const states: string[] = []
    ;[75, 85, 70, 70].forEach((v, i) => {
      sim.eval(i * MIN, [http('0', v)])
      states.push(sim.ALERTS(i * MIN).map((l) => `${l.alertstate}:${l.seen}`).join(','))
    })
    expect(states).toEqual(['pending:75', 'pending:85', 'pending:70', 'firing:70'])
    sim.eval(4 * MIN, []) // the series went stale
    expect(sim.ALERTS(4 * MIN)).toEqual([])
  })

  it('TestAlertingRuleExternalLabelsInTemplate: $externalLabels is available to label and annotation templates', () => {
    const rule = mkRule({ name: 'ExternalLabelExists', labels: { templated_label: 'foo is {{ $externalLabels.foo }}, dings is {{ .ExternalLabels.dings }}.' }, annotations: { a: '{{ $externalLabels.missing }}|{{ $externalLabels.foo }}' } })
    const sim = new Sim(rule, { resolvedRetentionMs: 15 * MIN, limit: 0, maxAnnotationBytes: 4096, externalLabels: { foo: 'bar', dings: 'bums' } })
    sim.eval(0, [http('0', 75)])
    const a = [...sim.alerts.values()][0]!
    expect(a.labels.templated_label).toBe('foo is bar, dings is bums.')
    expect(a.annotations.a).toBe('|bar')
    // External labels are not part of the alert's own label set.
    expect(a.labels.foo).toBeUndefined()
  })

  it('TestAlertingRuleEmptyLabelFromTemplate: a rule label that expands to "" is dropped, and removes a series label of that name', () => {
    const sim = new Sim(mkRule({ name: 'EmptyLabel', forMs: MIN, labels: { empty_label: '', instance: '{{ $labels.nothing }}' } }))
    sim.eval(0, [http('0', 75)])
    expect(sim.ALERTS(0)).toEqual([{ __name__: 'ALERTS', alertname: 'EmptyLabel', alertstate: 'pending', job: 'app-server' }])
  })

  it('TestAlertingRuleDuplicate: two series with the same labels after applying rule labels are an error, and state is untouched', () => {
    // vector(0) or label_replace(vector(0), "test", "x", "", ""), with rule label test="test"
    const sim = new Sim(mkRule({ name: 'foo', forMs: MIN, labels: { test: 'test' } }))
    const r = sim.eval(0, [s({}, 0), s({ test: 'x' }, 0)])
    expect(r).toEqual({ ok: false, error: ERR_DUPLICATE_ALERT })
    expect(sim.alerts.size).toBe(0)
  })

  it('TestAlertingRuleLimit: more alerts than the limit is an error; 0 means unlimited', () => {
    const series = [s({ __name__: 'metric', label: '1' }, 1), s({ __name__: 'metric', label: '2' }, 1)]
    for (const [limit, err] of [[0, null], [2, null], [1, 'exceeded limit of 1 with 2 alerts']] as const) {
      const r = new Sim(mkRule({ name: 'foo', forMs: MIN, labels: { test: 'test' } })).eval(0, series, limit)
      if (err === null) expect(r.ok).toBe(true)
      else expect(r).toEqual({ ok: false, error: err })
    }
  })

  it('TestKeepFiringFor: a firing alert whose series disappears keeps firing for keep_firing_for, then resolves', () => {
    const sim = new Sim(mkRule({ name: 'HTTPRequestRateHigh', forMs: MIN, keepFiringForMs: MIN }))
    const values = [75, 85, 70, 70, 10, 10, 10]
    const states = values.map((v, i) => {
      sim.eval(i * MIN, [http('0', v)].filter((x) => x.value > 50))
      return sim.ALERTS(i * MIN).map((l) => l.alertstate).join()
    })
    // "From now on the alert should keep firing" at step 4; gone at step 5.
    expect(states).toEqual(['pending', 'firing', 'firing', 'firing', 'firing', '', ''])
    const a = [...sim.alerts.values()][0]!
    expect(a).toMatchObject({ state: 'inactive', resolvedAt: 5 * MIN, keepFiringSince: 4 * MIN })
  })

  it('TestKeepFiringFor (continued): the series coming back during the hold resets keepFiringSince without a new pending phase', () => {
    const sim = new Sim(mkRule({ name: 'A', forMs: MIN, keepFiringForMs: 3 * MIN }))
    sim.eval(0, [http('0', 1)])
    sim.eval(MIN, [http('0', 1)])
    sim.eval(2 * MIN, [])
    expect([...sim.alerts.values()][0]).toMatchObject({ state: 'firing', keepFiringSince: 2 * MIN })
    sim.eval(3 * MIN, [http('0', 1)])
    expect([...sim.alerts.values()][0]).toMatchObject({ state: 'firing', keepFiringSince: null, firedAt: MIN, activeAt: 0 })
    sim.eval(4 * MIN, [])
    sim.eval(6 * MIN, [])
    expect([...sim.alerts.values()][0]!.state).toBe('firing') // 2m into a 3m hold that restarted at 4m
    sim.eval(7 * MIN, [])
    expect([...sim.alerts.values()][0]).toMatchObject({ state: 'inactive', resolvedAt: 7 * MIN })
  })

  it('TestPendingAndKeepFiringFor: keep_firing_for does not hold an alert that was only pending', () => {
    const sim = new Sim(mkRule({ name: 'HTTPRequestRateHigh', forMs: MIN, keepFiringForMs: MIN }))
    sim.eval(0, [http('0', 75)])
    expect(sim.ALERTS(0).map((l) => l.alertstate)).toEqual(['pending'])
    const r = sim.eval(MIN, [])
    expect(sim.ALERTS(MIN)).toEqual([])
    expect(sim.alerts.size).toBe(0)
    expect(r.ok && r.notify).toEqual([]) // nothing fired, so nothing to tell the notifier
  })

  it('TestFiringAlertResetToPendingOnHoldDurationIncrease: lengthening `for` puts a too-young firing alert back to pending', () => {
    const short = mkRule({ name: 'A', forMs: MIN })
    const sim = new Sim(short)
    sim.eval(0, [http('0', 1)])
    sim.eval(MIN, [http('0', 1)])
    expect([...sim.alerts.values()][0]!.state).toBe('firing')
    const long = new Sim({ ...short, forMs: 5 * MIN })
    long.alerts = sim.alerts
    const r = long.eval(2 * MIN, [http('0', 1)])
    expect([...long.alerts.values()][0]).toMatchObject({ state: 'pending', firedAt: null, activeAt: 0 })
    expect(r.ok && r.notify.map((n) => n.status)).toEqual(['resolved']) // viz tells the notifier explicitly
    long.eval(5 * MIN, [http('0', 1)])
    expect([...long.alerts.values()][0]).toMatchObject({ state: 'firing', firedAt: 5 * MIN })
  })

  it('resolved retention (alerting.go `resolvedRetention`): a resolved alert is kept 15m so the resolve can be sent, then dropped', () => {
    const sim = new Sim(mkRule({ name: 'A' }))
    sim.eval(0, [http('0', 1)])
    expect([...sim.alerts.values()][0]!.state).toBe('firing') // for: 0 fires on the first evaluation
    const r = sim.eval(MIN, [])
    expect(r.ok && r.notify).toEqual([{ fingerprint: [...sim.alerts.keys()][0], status: 'resolved' }])
    expect([...sim.alerts.values()][0]).toMatchObject({ state: 'inactive', resolvedAt: MIN })
    sim.eval(16 * MIN, []) // exactly 15m after: upstream compares with `>`, so still kept
    expect(sim.alerts.size).toBe(1)
    const gone = sim.eval(16 * MIN + 1000, [])
    expect(sim.alerts.size).toBe(0)
    expect(gone.ok && gone.notify).toEqual([]) // dropping the retained alert is not a second resolve
  })

  it('resolved retention: a series that returns while its resolved alert is retained starts a NEW alert (new activeAt)', () => {
    const sim = new Sim(mkRule({ name: 'A', forMs: 2 * MIN }))
    sim.eval(0, [http('0', 1)])
    sim.eval(2 * MIN, [http('0', 1)])
    sim.eval(3 * MIN, [])
    sim.eval(4 * MIN, [http('0', 1)])
    expect([...sim.alerts.values()][0]).toMatchObject({ state: 'pending', activeAt: 4 * MIN, resolvedAt: null })
  })

  it('the value and annotations of an existing alert follow the latest sample; activeAt does not move', () => {
    const sim = new Sim(mkRule({ name: 'A', forMs: 10 * MIN, annotations: { d: 'value is {{ $value }} on {{ $labels.instance }}' } }))
    sim.eval(0, [http('0', 75)])
    const r = sim.eval(MIN, [http('0', 99.5)])
    expect([...sim.alerts.values()][0]).toMatchObject({ value: 99.5, activeAt: 0, annotations: { d: 'value is 99.5 on 0' } })
    expect(r.ok && r.dirty.size).toBe(0) // not a transition: nothing to persist
  })

  it('a scalar result is one alert with no series labels (EngineQueryFunc converts scalars to a vector)', () => {
    const sim = new Sim(mkRule({ name: 'S' }))
    sim.eval(0, toSeries({ resultType: 'scalar', result: [0, '3'] }))
    expect([...sim.alerts.values()][0]).toMatchObject({ labels: { alertname: 'S' }, value: 3, state: 'firing' })
  })

  it('TestQueryForStateSeries: ALERTS_FOR_STATE carries activeAt in seconds, for pending and firing alerts only', () => {
    const sim = new Sim(mkRule({ name: 'A', forMs: MIN }))
    sim.eval(120_000, [http('0', 1)])
    sim.eval(180_000, [http('0', 1)])
    const series = syntheticSeries(sim.alerts.values(), 180_000)
    expect(series).toEqual([
      { labels: { __name__: 'ALERTS', alertname: 'A', alertstate: 'firing', instance: '0', job: 'app-server' }, timeMs: 180_000, value: '1' },
      { labels: { __name__: 'ALERTS_FOR_STATE', alertname: 'A', instance: '0', job: 'app-server' }, timeMs: 180_000, value: '120' },
    ])
    sim.eval(240_000, [])
    expect(syntheticSeries(sim.alerts.values(), 240_000)).toEqual([])
  })
})

describe('recording rules (prometheus/rules/recording_test.go behaviour)', () => {
  const rule = { kind: 'record' as const, name: 'job:up:sum', expr: 'x', labels: { tier: 'a', drop: '' }, key: 'k', cost: { class: 'tail' as const, windowMs: 0, reason: '' } }

  it('renames the metric, overlays rule labels, drops empty ones, and keeps the value text', () => {
    const r = evalRecordingRule(rule, toSeries(vec([{ __name__: 'up', job: 'a', drop: 'x', tier: 'z' }, '0.1'], [{ __name__: 'up', job: 'b' }, 'NaN'])), 5000, 0)
    expect(r).toEqual({
      ok: true,
      samples: [
        { labels: { __name__: 'job:up:sum', job: 'a', tier: 'a' }, timeMs: 5000, value: '0.1' },
        { labels: { __name__: 'job:up:sum', job: 'b', tier: 'a' }, timeMs: 5000, value: 'NaN' },
      ],
    })
  })

  it('TestRuleEvalDuplicate: series that collide after applying rule labels are an error', () => {
    const r = evalRecordingRule({ ...rule, labels: { test: 'test' } }, toSeries(vec([{}, 0], [{ test: 'x' }, 0])), 0, 0)
    expect(r).toEqual({ ok: false, error: 'vector contains metrics with the same labelset after applying rule labels' })
  })

  it('TestRecordingRuleLimit: more series than the limit is an error', () => {
    const series = toSeries(vec([{ a: '1' }, 1], [{ a: '2' }, 1]))
    expect(evalRecordingRule(rule, series, 0, 2).ok).toBe(true)
    expect(evalRecordingRule(rule, series, 0, 1)).toEqual({ ok: false, error: 'exceeded limit of 1 with 2 series' })
  })
})

describe('group evaluation in the Ruler object (prometheus/rules/manager_test.go, group.go)', () => {
  const file = (rules: unknown[], extra: Record<string, unknown> = {}) => ({ groups: [{ name: 'g', interval: '1m', ...extra, rules }] })

  it('Group.EvalTimestamp: every rule in a group is evaluated at the same aligned timestamp, in order', async () => {
    const { tenant, stub, w } = await setup()
    const saved = ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'a' }, { record: 'r:b', expr: 'b' }, { alert: 'C', expr: 'c' }])))
    const offset = saved.groups[0]!.offsetMs
    expect(offset).toBeGreaterThanOrEqual(0)
    expect(offset).toBeLessThan(MIN)
    for (let i = 0; i < 3; i++) {
      w.evalCalls.length = 0
      const at = await nextTick(stub, tenant)
      expect(w.evalCalls.map((c) => c[0])).toEqual(['a', 'b', 'c'])
      const times = new Set(w.evalCalls.map((c) => c[1]))
      expect(times.size).toBe(1)
      const ts = [...times][0]!
      expect((ts - offset) % MIN).toBe(0) // aligned to the interval, shifted by the group's offset
      expect(ts).toBe(at) // the alarm was set for exactly that time
    }
  })

  it('groups get different offsets, so they do not all evaluate together', async () => {
    const { tenant, stub } = await setup()
    const groups = Array.from({ length: 12 }, (_, i) => ({ name: `group-${i}`, interval: '1m', rules: [{ alert: 'A', expr: 'up' }] }))
    const saved = ok(await stub.saveGroups(tenant, { groups }))
    expect(new Set(saved.groups.map((g) => g.offsetMs)).size).toBeGreaterThan(8)
    // and the offset of a group is stable across saves
    const again = ok(await stub.saveGroups(tenant, { groups }))
    expect(again.groups.map((g) => g.offsetMs)).toEqual(saved.groups.map((g) => g.offsetMs))
  })

  it('sequential evaluation: a recording rule is written before a later rule that reads it is evaluated', async () => {
    // Upstream guarantees this because rules run in order against one storage. Here it holds
    // IF the evaluator reads what the sink wrote. This fake does; whether production does
    // depends on the ingest path making the sample queryable at once (README, "Deviations").
    const { tenant, stub, w } = await setup()
    w.evaluate = (q) => {
      if (q === 'sum(up)') return vec([{ job: 'api' }, 7])
      if (q === 'job:up:sum > 5') {
        const recorded = [...w.sinkById.values()].flatMap((b) => b.samples).filter((x) => x.labels.__name__ === 'job:up:sum')
        return vec(...recorded.filter((x) => Number(x.value) > 5).map((x): [Record<string, string>, string] => [x.labels, x.value]))
      }
      return vec()
    }
    ok(await stub.saveGroups(tenant, file([{ record: 'job:up:sum', expr: 'sum(up)' }, { alert: 'Many', expr: 'job:up:sum > 5' }, { record: 'unrelated', expr: 'sum(up)' }])))
    const at = await nextTick(stub, tenant)
    expect((await alertsOf(stub, tenant, 'Many')).map((a) => a.state)).toEqual(['firing'])
    // The dependent rule forced an early write; the unrelated rule's sample went out at the end.
    expect(w.sinkWrites.map((batches) => batches.length)).toEqual([1, 1])
    expect(w.sinkWrites[0]![0]!.samples).toEqual([{ labels: { __name__: 'job:up:sum', job: 'api' }, timeMs: at, value: '7' }])
  })

  it('TestGroup_QueryOffset: the query runs query_offset in the past; alert timing still uses the tick', async () => {
    const { tenant, stub, w } = await setup()
    w.evaluate = () => vec([{ i: '1' }, 1])
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'up' }, { record: 'r', expr: 'up' }], { query_offset: '2m' })))
    const at = await nextTick(stub, tenant)
    expect(w.evalCalls.map((c) => c[1])).toEqual([at - 2 * MIN, at - 2 * MIN])
    expect((await alertsOf(stub, tenant, 'A'))[0]).toMatchObject({ activeAt: at, firedAt: at })
    expect(w.sinkWrites[0]![0]!.samples[0]!.timeMs).toBe(at - 2 * MIN)
  })

  it('TestForStateRestore: pending and firing state survive the object being evicted; `for` timers are not reset', async () => {
    const run = async (evict: boolean) => {
      const { tenant, stub, w } = await setup()
      w.evaluate = () => vec([{ instance: '0' }, 1], [{ instance: '1' }, 1])
      ok(await stub.saveGroups(tenant, file([{ alert: 'Slow', expr: 'up', for: '5m', annotations: { v: '{{ $value }}' } }])))
      const t1 = await nextTick(stub, tenant)
      const states: string[] = []
      for (let i = 0; i < 6; i++) {
        if (evict) await evictDurableObject(stub)
        await nextTick(stub, tenant)
        const alerts = await alertsOf(stub, tenant)
        expect(alerts.every((a) => a.activeAt === t1)).toBe(true)
        states.push(alerts.map((a) => a.state).sort().join())
      }
      return { states, firedAfter: (await alertsOf(stub, tenant))[0]!.firedAt! - t1 }
    }
    const kept = await run(false)
    const evicted = await run(true)
    expect(kept.states).toEqual(['pending,pending', 'pending,pending', 'pending,pending', 'pending,pending', 'firing,firing', 'firing,firing'])
    expect(evicted).toEqual(kept)
    expect(kept.firedAfter).toBe(5 * MIN)
  })

  it('TestRuleHealthUpdates: health is unknown before the first evaluation, ok after a good one, err with the message after a failed one', async () => {
    const { tenant, stub, w } = await setup()
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'good' }, { alert: 'B', expr: 'bad' }])))
    expect(ok(await stub.rules(tenant)).rules.map((r) => r.health)).toEqual(['unknown', 'unknown'])
    w.evaluate = (q) => {
      if (q === 'bad') throw new Error('parse error: unexpected end of input')
      return vec()
    }
    const at = await nextTick(stub, tenant)
    expect(ok(await stub.rules(tenant)).rules.map((r) => [r.name, r.health, r.lastError, r.lastEvaluationMs])).toEqual([
      ['A', 'ok', null, at],
      ['B', 'err', 'parse error: unexpected end of input', at],
    ])
    w.evaluate = () => vec()
    await nextTick(stub, tenant)
    expect(ok(await stub.rules(tenant)).rules.map((r) => r.health)).toEqual(['ok', 'ok'])
  })

  it('TestCopyState / TestUpdate: saving a group keeps the alerts of unchanged rules and drops those of changed or removed rules', async () => {
    const { tenant, stub, w } = await setup()
    w.evaluate = () => vec([{ i: '1' }, 1])
    const rules = [{ alert: 'Keep', expr: 'up', for: '3m' }, { alert: 'Change', expr: 'up', for: '3m' }, { alert: 'Remove', expr: 'up', for: '3m' }]
    ok(await stub.saveGroups(tenant, file(rules)))
    const t1 = await nextTick(stub, tenant)
    expect((await alertsOf(stub, tenant)).length).toBe(3)
    // Reorder, change one expression, remove one, add one.
    ok(await stub.saveGroups(tenant, file([{ alert: 'New', expr: 'up' }, { alert: 'Change', expr: 'up > 0', for: '3m' }, { alert: 'Keep', expr: 'up', for: '3m' }])))
    expect((await alertsOf(stub, tenant)).map((a) => [a.labels.alertname, a.activeAt])).toEqual([['Keep', t1]])
    // ...and the same after the object is rebuilt from storage.
    await evictDurableObject(stub)
    expect((await alertsOf(stub, tenant)).map((a) => [a.labels.alertname, a.activeAt])).toEqual([['Keep', t1]])
    await nextTick(stub, tenant)
    const byName = Object.fromEntries((await alertsOf(stub, tenant)).map((a) => [a.labels.alertname, a]))
    expect(byName.Keep).toMatchObject({ state: 'pending', activeAt: t1 })
    expect(byName.Change).toMatchObject({ state: 'pending', activeAt: t1 + MIN })
    expect(byName.New).toMatchObject({ state: 'firing' })
  })

  it('iterations missed (prometheus_rule_group_iterations_missed_total): a late tick is evaluated once, at the latest due time; the gap is counted, not replayed', async () => {
    const { tenant, stub, w } = await setup()
    w.evaluate = () => vec([{ i: '1' }, 1])
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'up', for: '10m' }])))
    const t1 = await nextTick(stub, tenant)
    w.evalCalls.length = 0
    // The object sleeps through 4 ticks and wakes 40 s into the 6th interval.
    world.now = t1 + 5 * MIN + 40_000
    await nextTick(stub, tenant)
    expect(w.evalCalls).toEqual([['up', t1 + 5 * MIN]])
    const g = ok(await stub.health(tenant)).groups[0]!
    expect(g).toMatchObject({ lastEvaluationMs: t1 + 5 * MIN, skippedTicks: 4, evaluations: 2 })
    // `for` is measured in time, as upstream: the alert is 5m old, not "2 evaluations" old.
    expect((await alertsOf(stub, tenant))[0]).toMatchObject({ state: 'pending', activeAt: t1 })
    expect(tenantWorld(tenant).evalCalls.length).toBe(1)
  })
})
