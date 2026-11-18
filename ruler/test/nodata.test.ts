/**
 * No-data behaviour per rule (`no_data: ok | alerting | keep`) and absent-series handling.
 *
 * `ok` must be exactly Prometheus: an alert whose series is gone is dropped (pending) or
 * resolved (firing), subject to `keep_firing_for`. The other two modes are viz's.
 */
import { evictDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { NO_DATA_LABEL, type Alert, type AlertingRuleV2, type NoDataPolicy } from '../contracts-proposal/rules.v2'
import { DEFAULT_RULER_CONFIG } from '../src/ruler'
import { compileAlertRule, parseRuleFile, ruleKey } from '../src/rules'
import { evalAlertingRule, type Series } from '../src/statemachine'
import { alertsOf, MIN, nextTick, notifierStub, ok, runNotifierUntil, setup, vec } from './helpers'

const mkRule = (over: Partial<AlertingRuleV2> = {}): AlertingRuleV2 => {
  const base = { kind: 'alert' as const, name: 'R', expr: 'x > 1', forMs: 2 * MIN, keepFiringForMs: 0, labels: { severity: 'page' }, annotations: { summary: 'v={{ $value }}' }, ...over }
  return { ...base, key: ruleKey('alert', base.name, base.expr, base.labels), cost: { class: 'tail', windowMs: 0, reason: '' } }
}

class Sim {
  alerts: ReadonlyMap<string, Alert> = new Map()
  notified: string[] = []
  private compiled
  constructor(readonly rule: AlertingRuleV2) {
    this.compiled = compileAlertRule(rule)
  }
  /** `presence` undefined = the rule has no no-data expression. */
  eval(minute: number, series: Series[], presence?: Series[]) {
    const r = evalAlertingRule(this.rule, this.compiled, this.alerts, series, minute * MIN, { resolvedRetentionMs: 15 * MIN, limit: 0, maxAnnotationBytes: 4096, externalLabels: {} }, presence ?? null)
    if (!r.ok) throw new Error(r.error)
    this.alerts = r.alerts
    for (const n of r.notify) this.notified.push(`${minute}:${n.status}`)
    return r
  }
  states() {
    return [...this.alerts.values()].map((a) => `${a.labels.instance ?? (a.labels[NO_DATA_LABEL] ? 'NODATA' : '')}:${a.state}`).sort()
  }
}

const s = (instance: string, value = 5): Series => ({ metric: { instance }, value, text: String(value) })
const policy = (mode: NoDataPolicy['mode'], forMs = 0, expr: string | null = 'x'): NoDataPolicy => ({ mode, forMs, expr })

describe('absent series, as Prometheus handles them (no_data: ok, the default)', () => {
  it('a pending alert whose series disappears is dropped at once; when the series returns, `for` starts again', () => {
    const sim = new Sim(mkRule())
    sim.eval(0, [s('a')])
    sim.eval(1, [s('a')])
    expect(sim.states()).toEqual(['a:pending'])
    sim.eval(2, []) // gone for one evaluation, one minute before it would have fired
    expect(sim.states()).toEqual([])
    sim.eval(3, [s('a')])
    expect([...sim.alerts.values()][0]).toMatchObject({ state: 'pending', activeAt: 3 * MIN })
    sim.eval(4, [s('a')])
    expect(sim.states()).toEqual(['a:pending']) // not firing: the clock restarted at minute 3
    sim.eval(5, [s('a')])
    expect(sim.states()).toEqual(['a:firing'])
    expect(sim.notified).toEqual(['5:firing'])
  })

  it('a firing alert whose series disappears resolves at that evaluation', () => {
    const sim = new Sim(mkRule())
    for (const m of [0, 1, 2]) sim.eval(m, [s('a')])
    expect(sim.states()).toEqual(['a:firing'])
    sim.eval(3, [])
    expect(sim.states()).toEqual(['a:inactive'])
    expect(sim.notified).toEqual(['2:firing', '3:resolved'])
  })

  it('keep_firing_for holds a firing alert whose series disappeared, and only a firing one', () => {
    const sim = new Sim(mkRule({ keepFiringForMs: 3 * MIN }))
    for (const m of [0, 1, 2]) sim.eval(m, [s('a'), s('b')])
    sim.eval(3, [s('late')]) // a and b gone; "late" is new and pending
    expect(sim.states()).toEqual(['a:firing', 'b:firing', 'late:pending'])
    expect([...sim.alerts.values()].find((a) => a.labels.instance === 'a')!.keepFiringSince).toBe(3 * MIN)
    sim.eval(4, []) // "late" was only pending: dropped, not held
    expect(sim.states()).toEqual(['a:firing', 'b:firing'])
    sim.eval(5, [s('a')]) // a returns inside the hold: still firing, hold cleared, same activeAt
    expect([...sim.alerts.values()].find((a) => a.labels.instance === 'a')).toMatchObject({ state: 'firing', keepFiringSince: null, activeAt: 0 })
    sim.eval(6, [s('a')]) // 3 minutes after b went: its hold is over
    expect(sim.states()).toEqual(['a:firing', 'b:inactive'])
    expect(sim.notified).toEqual(['2:firing', '2:firing', '6:resolved'])
  })

  it('an explicit no_data: ok stores no policy and behaves identically', () => {
    const p = parseRuleFile({ groups: [{ name: 'g', rules: [{ alert: 'A', expr: 'x > 1', no_data: 'ok' }] }] }, DEFAULT_RULER_CONFIG)
    expect(p.errors).toEqual([])
    expect('noData' in p.groups[0]!.rules[0]!).toBe(false)
  })
})

describe('no_data: keep (leave the last state as it is)', () => {
  it('a firing alert stays firing through missing data and no resolve is produced; it resolves when data is back and below the threshold', () => {
    const sim = new Sim(mkRule({ noData: policy('keep') }))
    for (const m of [0, 1, 2]) sim.eval(m, [s('a')], [s('a')])
    const firing = [...sim.alerts.values()]
    for (const m of [3, 4, 5, 6, 7, 8, 9, 10]) {
      const r = sim.eval(m, [], []) // the query itself returns nothing
      expect(r).toMatchObject({ noData: true, notify: [] })
      expect(r.dirty.size).toBe(0) // nothing to write either
    }
    expect([...sim.alerts.values()]).toEqual(firing)
    sim.eval(11, [], [s('a', 0.5)]) // data is back, the comparison is false
    expect(sim.states()).toEqual(['a:inactive'])
    expect(sim.notified).toEqual(['2:firing', '11:resolved'])
  })

  it('a pending alert is neither dropped nor promoted while data is missing', () => {
    const sim = new Sim(mkRule({ noData: policy('keep') }))
    sim.eval(0, [s('a')], [s('a')])
    for (const m of [1, 2, 3, 4, 5]) sim.eval(m, [], [])
    expect([...sim.alerts.values()][0]).toMatchObject({ state: 'pending', activeAt: 0 }) // `for` (2m) has long passed: still not firing
    expect(sim.notified).toEqual([])
    sim.eval(6, [s('a')], [s('a')]) // back and still above: it fires, counted from when it was first seen
    expect(sim.states()).toEqual(['a:firing'])
  })

  it('without a no-data expression, "no data" is the rule expression returning nothing', () => {
    const sim = new Sim(mkRule({ noData: policy('keep', 0, null) }))
    for (const m of [0, 1, 2]) sim.eval(m, [s('a')])
    sim.eval(3, [])
    expect(sim.states()).toEqual(['a:firing'])
    sim.eval(4, [s('b')]) // some data: ordinary handling, a is gone
    expect(sim.states()).toEqual(['a:inactive', 'b:pending'])
  })

  it('a resolved alert that is only being retained still ages out during missing data', () => {
    const sim = new Sim(mkRule({ noData: policy('keep') }))
    for (const m of [0, 1, 2]) sim.eval(m, [s('a')], [s('a')])
    sim.eval(3, [], [s('a', 0)])
    expect(sim.states()).toEqual(['a:inactive'])
    const r = sim.eval(19, [], [])
    expect(sim.states()).toEqual([])
    expect(r.dirty.size).toBe(1)
  })
})

describe('no_data: alerting (fire after a configurable time without data)', () => {
  it('missing data becomes a pending alert at once and fires after no_data_for, not after the rule\'s `for`', () => {
    const sim = new Sim(mkRule({ forMs: 1 * MIN, noData: policy('alerting', 5 * MIN) }))
    sim.eval(0, [], [s('a', 0)]) // data present, healthy
    expect(sim.states()).toEqual([])
    for (const m of [1, 2, 3, 4, 5]) sim.eval(m, [], [])
    expect(sim.states()).toEqual(['NODATA:pending']) // 4 minutes without data; `for: 1m` did not apply
    sim.eval(6, [], [])
    expect(sim.states()).toEqual(['NODATA:firing'])
    const a = [...sim.alerts.values()][0]!
    expect(a.labels).toEqual({ [NO_DATA_LABEL]: 'true', severity: 'page', alertname: 'R' })
    expect(a).toMatchObject({ activeAt: 1 * MIN, firedAt: 6 * MIN })
    expect(Number.isNaN(a.value)).toBe(true)
    sim.eval(7, [], [s('a', 0)]) // data back: the no-data alert resolves
    expect(sim.states()).toEqual(['NODATA:inactive'])
    expect(sim.notified).toEqual(['6:firing', '7:resolved'])
  })

  it('data that returns before no_data_for clears the pending no-data alert without notifying', () => {
    const sim = new Sim(mkRule({ noData: policy('alerting', 5 * MIN) }))
    sim.eval(0, [], [])
    sim.eval(1, [], [])
    sim.eval(2, [], [s('a', 0)])
    expect(sim.states()).toEqual([])
    expect(sim.notified).toEqual([])
  })

  it('the real alerts follow Prometheus while the data is missing: the firing one resolves as the no-data alert takes over', () => {
    const sim = new Sim(mkRule({ noData: policy('alerting', 0) }))
    for (const m of [0, 1, 2]) sim.eval(m, [s('a')], [s('a')])
    sim.eval(3, [], [])
    expect(sim.states()).toEqual(['NODATA:firing', 'a:inactive'])
    expect([...sim.notified].sort()).toEqual(['2:firing', '3:firing', '3:resolved'])
  })

  it('data is "present" as long as the bare query returns something, even if the comparison is empty', () => {
    const sim = new Sim(mkRule({ noData: policy('alerting', 0) }))
    for (const m of [0, 1, 2, 3]) sim.eval(m, [], [s('a', 0.2)])
    expect(sim.states()).toEqual([])
  })
})

describe('validation of the no-data fields', () => {
  const check = (rule: Record<string, unknown>) => parseRuleFile({ groups: [{ name: 'g', rules: [{ alert: 'A', expr: 'x > 1', ...rule }] }] }, DEFAULT_RULER_CONFIG)

  it('stores the policy; `for` only for alerting', () => {
    expect((check({ no_data: 'alerting', no_data_for: '10m', no_data_expr: 'x' }).groups[0]!.rules[0] as AlertingRuleV2).noData).toEqual({ mode: 'alerting', forMs: 600_000, expr: 'x' })
    expect((check({ no_data: 'keep', no_data_expr: 'x' }).groups[0]!.rules[0] as AlertingRuleV2).noData).toEqual({ mode: 'keep', forMs: 0, expr: 'x' })
  })

  it('refuses an unknown mode, a bad duration and the reserved label, each with a path and a fix', () => {
    expect(check({ no_data: 'resolve' }).errors).toMatchObject([{ path: 'groups[0].rules[0].no_data' }])
    expect(check({ no_data: 'alerting', no_data_for: 'soon' }).errors).toMatchObject([{ path: 'groups[0].rules[0].no_data_for' }])
    expect(check({ labels: { [NO_DATA_LABEL]: 'x' } }).errors).toMatchObject([{ path: `groups[0].rules[0].labels.${NO_DATA_LABEL}` }])
    expect(parseRuleFile({ groups: [{ name: 'g', rules: [{ record: 'a:b', expr: 'x', no_data: 'keep' }] }] }, DEFAULT_RULER_CONFIG).errors).toMatchObject([{ path: 'groups[0].rules[0].no_data' }])
  })

  it('warns that a comparison without no_data_expr cannot tell "no data" from "healthy"', () => {
    const p = check({ no_data: 'keep' })
    expect(p.errors).toEqual([])
    expect(p.warnings).toMatchObject([{ path: 'groups[0].rules[0].no_data' }])
    expect(p.warnings[0]!.message).toMatch(/also what a healthy system returns/)
  })

  it('changing the no-data policy does not change the rule key, so alert state survives the edit', () => {
    expect(check({ no_data: 'keep', no_data_expr: 'x' }).groups[0]!.rules[0]!.key).toBe(check({}).groups[0]!.rules[0]!.key)
  })
})

describe('in the Ruler object', () => {
  const amConfig = { route: { receiver: 'hook', group_wait: '0s', group_interval: '1m', repeat_interval: '12h' }, receivers: [{ name: 'hook', webhook_configs: [{ url: 'https://receiver.test/hook' }] }] }

  it('keep: the no-data expression rides in the same batch; the alert keeps firing, nothing is resolved or written, and the receiver hears nothing', async () => {
    const { tenant, stub, w } = await setup()
    w.batch = true
    const notifier = notifierStub(tenant)
    ok(await notifier.setConfig(tenant, amConfig))
    let data = true
    w.evaluate = (q) => (!data ? vec() : q === 'lat' ? vec([{ svc: 'a' }, 0.9]) : vec([{ svc: 'a' }, 0.9]))
    ok(await stub.saveGroups(tenant, { groups: [{ name: 'g', interval: '1m', rules: [{ alert: 'Slow', expr: '(lat) > 0.5', no_data: 'keep', no_data_expr: 'lat' }] }] }))
    const t1 = await nextTick(stub, tenant)
    expect(w.batchCalls[0]!.map((r) => [r.id.endsWith('#presence'), r.promql])).toEqual([[false, '(lat) > 0.5'], [true, 'lat']])
    await runNotifierUntil(notifier, tenant, t1 + 30_000)
    expect(w.received.length).toBe(1)
    data = false
    const writes = ok(await stub.health(tenant)).counters.sqlRowsWritten
    for (let i = 0; i < 20; i++) await nextTick(stub, tenant)
    expect((await alertsOf(stub, tenant)).map((a) => a.state)).toEqual(['firing'])
    expect(ok(await stub.snapshot(tenant)).groups[0]!.rules[0]).toMatchObject({ health: 'ok', noData: true })
    expect(w.ingestCalls.flat().map((u) => u.status)).toEqual(['firing'])
    expect(ok(await stub.health(tenant)).counters.sqlRowsWritten - writes).toBeLessThanOrEqual(4) // heartbeats only
    await evictDurableObject(stub)
    await nextTick(stub, tenant)
    expect((await alertsOf(stub, tenant)).map((a) => a.state)).toEqual(['firing'])
    data = true
    w.evaluate = (q) => (q === 'lat' ? vec([{ svc: 'a' }, 0.1]) : vec())
    const t2 = await nextTick(stub, tenant)
    await runNotifierUntil(notifier, tenant, t2 + 2 * MIN)
    expect(w.ingestCalls.flat().map((u) => u.status)).toEqual(['firing', 'resolved'])
    expect(w.received.map((r) => (r.body as { status: string }).status)).toEqual(['firing', 'resolved'])
    expect(ok(await stub.snapshot(tenant)).groups[0]!.rules[0]!.noData).toBe(false)
  })

  it('alerting: the no-data alert fires after no_data_for, reaches the receiver, survives a restart (its value is NaN), and resolves when data returns', async () => {
    const { tenant, stub, w } = await setup()
    const notifier = notifierStub(tenant)
    ok(await notifier.setConfig(tenant, amConfig))
    let data = false
    w.evaluate = (q) => (data && q === 'lat' ? vec([{ svc: 'a' }, 0.1]) : vec())
    ok(await stub.saveGroups(tenant, { groups: [{ name: 'g', interval: '1m', rules: [{ alert: 'Slow', expr: '(lat) > 0.5', no_data: 'alerting', no_data_for: '3m', no_data_expr: 'lat', annotations: { summary: 'latency {{ $value }}' } }] }] }))
    const t1 = await nextTick(stub, tenant)
    expect((await alertsOf(stub, tenant)).map((a) => [a.state, a.labels[NO_DATA_LABEL]])).toEqual([['pending', 'true']])
    await nextTick(stub, tenant)
    await nextTick(stub, tenant)
    expect((await alertsOf(stub, tenant))[0]!.state).toBe('pending')
    const t4 = await nextTick(stub, tenant)
    expect((await alertsOf(stub, tenant))[0]).toMatchObject({ state: 'firing', activeAt: t1, firedAt: t4 })
    await evictDurableObject(stub)
    const after = (await alertsOf(stub, tenant))[0]!
    expect(after.state).toBe('firing')
    expect(Number.isNaN(after.value)).toBe(true)
    await runNotifierUntil(notifier, tenant, t4 + 30_000)
    expect((w.received[0]!.body as { alerts: { labels: Record<string, string> }[] }).alerts[0]!.labels).toMatchObject({ alertname: 'Slow', [NO_DATA_LABEL]: 'true' })
    data = true
    const t5 = await nextTick(stub, tenant)
    await runNotifierUntil(notifier, tenant, t5 + 2 * MIN)
    expect(w.received.map((r) => (r.body as { status: string }).status)).toEqual(['firing', 'resolved'])
  })

  it('a failing no-data check fails the rule (err, state untouched) rather than guessing that data is missing', async () => {
    const { tenant, stub, w } = await setup()
    w.batch = true
    let broken = false
    w.evaluate = (q) => {
      if (broken && q === 'lat') throw new Error('engine: timeout')
      return vec([{ svc: 'a' }, 0.9])
    }
    ok(await stub.saveGroups(tenant, { groups: [{ name: 'g', interval: '1m', rules: [{ alert: 'Slow', expr: '(lat) > 0.5', no_data: 'alerting', no_data_expr: 'lat' }] }] }))
    await nextTick(stub, tenant)
    const before = await alertsOf(stub, tenant)
    broken = true
    await nextTick(stub, tenant)
    expect(ok(await stub.rules(tenant)).rules[0]).toMatchObject({ health: 'err', lastError: 'no-data check: engine: timeout' })
    expect(await alertsOf(stub, tenant)).toEqual(before)
  })
})
