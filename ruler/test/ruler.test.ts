import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import notifierSource from '../src/notifier.ts?raw'
import rulerSource from '../src/ruler.ts?raw'
import { T0, tenantWorld, world } from './harness'
import { alarmAt, alertsOf, MIN, newTenant, nextTick, notifierStub, ok, rulerStub, runNotifierUntil, setup, sqlWrites, vec } from './helpers'

const file = (rules: unknown[], extra: Record<string, unknown> = {}, name = 'g') => ({ groups: [{ name, interval: '1m', ...extra, rules }] })
const amConfig = (extra: Record<string, unknown> = {}) => ({
  route: { receiver: 'hook', group_by: ['alertname'], group_wait: '0s', group_interval: '1m', repeat_interval: '4h' },
  receivers: [{ name: 'hook', webhook_configs: [{ url: 'https://receiver.test/hook' }] }],
  ...extra,
})

describe('scheduling: one alarm for the whole object', () => {
  it('an untouched object has no alarm and no state; reading it does not create any', async () => {
    const tenant = newTenant()
    const stub = rulerStub(tenant)
    const h = ok(await stub.health(tenant))
    expect(h).toMatchObject({ groups: [], alarmAtMs: null, outboxDepth: 0 })
    expect(h.counters.sqlRowsWritten).toBe(0)
    expect(await runDurableObjectAlarm(stub)).toBe(false)
  })

  it('arms the alarm at the earliest group deadline and deletes it when the last group goes', async () => {
    const { tenant, stub } = await setup()
    const saved = ok(await stub.saveGroups(tenant, {
      groups: [
        { name: 'fast', interval: '30s', rules: [{ alert: 'A', expr: 'up' }] },
        { name: 'slow', interval: '5m', rules: [{ alert: 'B', expr: 'up' }] },
        { name: 'mid', interval: '1m', rules: [{ alert: 'C', expr: 'up' }] },
      ],
    }))
    const earliest = Math.min(...saved.groups.map((g) => g.nextEvaluationMs))
    expect(ok(await stub.health(tenant)).alarmAtMs).toBe(earliest)
    // After each tick the alarm is again the minimum over all groups' next deadlines.
    for (let i = 0; i < 8; i++) {
      await nextTick(stub, tenant)
      const h = ok(await stub.health(tenant))
      expect(h.alarmAtMs).toBe(Math.min(...h.groups.map((g) => g.nextEvaluationMs)))
      expect(h.alarmAtMs!).toBeGreaterThan(world.now)
    }
    for (const name of ['fast', 'slow']) expect(await stub.deleteGroup(tenant, name)).toEqual({ status: 'ok', existed: true })
    expect(ok(await stub.health(tenant)).alarmAtMs).not.toBeNull()
    expect(await stub.deleteGroup(tenant, 'mid')).toEqual({ status: 'ok', existed: true })
    expect(await stub.deleteGroup(tenant, 'mid')).toEqual({ status: 'ok', existed: false })
    expect(ok(await stub.health(tenant)).alarmAtMs).toBeNull()
  })

  it('a new group first runs at its next aligned time, never before it was saved', async () => {
    const { tenant, stub, w } = await setup()
    world.now = T0 + 17_000
    const saved = ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'up' }])))
    const g = saved.groups[0]!
    expect(g.nextEvaluationMs).toBeGreaterThanOrEqual(world.now)
    expect(g.nextEvaluationMs - world.now).toBeLessThanOrEqual(MIN)
    // An alarm that fires early (e.g. for another reason) does not evaluate the group.
    await runInDurableObject(stub, (i) => i.alarm())
    expect(w.evalCalls).toEqual([])
    await nextTick(stub, tenant)
    expect(w.evalCalls).toEqual([['up', g.nextEvaluationMs]])
  })

  it('runs groups that are due together concurrently, but no more than maxConcurrentGroups at once, and each group strictly in order', async () => {
    const { tenant, stub, w } = await setup({ maxConcurrentGroups: 3 })
    let inFlight = 0
    let peak = 0
    const perGroup = new Map<string, number>()
    let overlapInGroup = false
    w.evaluate = async (q) => {
      const group = q.split(':')[0]!
      if ((perGroup.get(group) ?? 0) > 0) overlapInGroup = true
      perGroup.set(group, (perGroup.get(group) ?? 0) + 1)
      peak = Math.max(peak, ++inFlight)
      await new Promise((r) => setTimeout(r, 3))
      inFlight--
      perGroup.set(group, (perGroup.get(group) as number) - 1)
      return vec()
    }
    const groups = Array.from({ length: 8 }, (_, g) => ({ name: `g${g}`, interval: '1m', rules: [0, 1, 2].map((r) => ({ alert: `A${r}`, expr: `g${g}:r${r}` })) }))
    ok(await stub.saveGroups(tenant, { groups }))
    // Wake late enough that all eight groups are due at this one alarm.
    await alarmAt(stub, T0 + 2 * MIN)
    expect(w.evalCalls.length).toBe(24)
    expect(peak).toBe(3)
    expect(overlapInGroup).toBe(false)
    for (let g = 0; g < 8; g++) expect(w.evalCalls.filter((c) => c[0].startsWith(`g${g}:`)).map((c) => c[0])).toEqual([0, 1, 2].map((r) => `g${g}:r${r}`))
  })

  it('ensureArmed re-arms an object whose alarm went missing (for the platform sweeper)', async () => {
    const { tenant, stub } = await setup()
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'up' }])))
    expect(await stub.ensureArmed(tenant)).toEqual({ status: 'ok', rearmed: false })
    await runInDurableObject(stub, (_i, state) => state.storage.deleteAlarm())
    expect(await stub.ensureArmed(tenant)).toEqual({ status: 'ok', rearmed: true })
    expect(ok(await stub.health(tenant)).alarmAtMs).not.toBeNull()
  })
})

describe('at-least-once alarms: a replayed tick changes nothing', () => {
  it('the same (group, evaluation time) is not evaluated twice while the object stays in memory', async () => {
    const { tenant, stub, w } = await setup()
    w.evaluate = () => vec([{ i: '1' }, 1])
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'up', for: '2m' }, { record: 'r', expr: 'up' }])))
    const t1 = await nextTick(stub, tenant)
    const before = { evals: w.evalCalls.length, sink: w.sinkWrites.length, writes: await sqlWrites(stub, tenant) }
    for (let i = 0; i < 3; i++) await runInDurableObject(stub, (inst) => inst.alarm()) // the platform retries the alarm
    expect(w.evalCalls.length).toBe(before.evals)
    expect(w.sinkWrites.length).toBe(before.sink)
    expect(await sqlWrites(stub, tenant)).toBe(before.writes)
    expect(ok(await stub.health(tenant)).groups[0]).toMatchObject({ evaluations: 1, lastEvaluationMs: t1, skippedTicks: 0 })
  })

  it('a retry that arrives later in the same interval still evaluates at the aligned time: `for` does not advance', async () => {
    const { tenant, stub, w } = await setup()
    w.evaluate = () => vec([{ i: '1' }, 1])
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'up', for: '30s' }])))
    const t1 = await nextTick(stub, tenant)
    expect((await alertsOf(stub, tenant))[0]).toMatchObject({ state: 'pending', activeAt: t1 })
    // Replays 45 s later, with and without the in-memory guard (eviction drops it).
    world.now = t1 + 45_000
    await runInDurableObject(stub, (inst) => inst.alarm())
    expect((await alertsOf(stub, tenant))[0]).toMatchObject({ state: 'pending', activeAt: t1 })
    await evictDurableObject(stub)
    world.now = t1 + 50_000
    await runInDurableObject(stub, (inst) => inst.alarm())
    expect((await alertsOf(stub, tenant))[0]).toMatchObject({ state: 'pending', activeAt: t1 })
    expect(new Set(w.evalCalls.map((c) => c[1]))).toEqual(new Set([t1]))
    // The next real tick fires it: 60 s >= 30 s.
    await alarmAt(stub, t1 + MIN)
    expect((await alertsOf(stub, tenant))[0]).toMatchObject({ state: 'firing', firedAt: t1 + MIN })
  })

  it('after an eviction the replayed tick re-evaluates, finds the transition already made, and emits nothing new', async () => {
    const { tenant, stub, w, notifier } = await setup({ heartbeatMs: 30 * MIN })
    ok(await notifier.setConfig(tenant, amConfig()))
    let series = vec()
    w.evaluate = () => series
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'up' }, { record: 'r', expr: 'up' }])))
    await nextTick(stub, tenant) // first tick: writes the heartbeat cursor
    series = vec([{ i: '1' }, 1], [{ i: '2' }, 2])
    const t2 = await nextTick(stub, tenant) // transitions here; the cursor on disk still says t1
    expect(w.ingestCalls.length).toBe(1)
    const alertsBefore = await alertsOf(stub, tenant)
    expect(alertsBefore.map((a) => a.state)).toEqual(['firing', 'firing'])
    await evictDurableObject(stub) // the in-memory "t2 is done" is gone
    const writes0 = await sqlWrites(stub, tenant)
    world.now = t2 + 5000
    await runInDurableObject(stub, (inst) => inst.alarm())
    expect(w.evalCalls.filter((c) => c[1] === t2).length).toBe(4) // evaluated again...
    expect(await alertsOf(stub, tenant)).toEqual(alertsBefore) // ...same state
    expect(w.ingestCalls.length).toBe(1) // ...no second hand-off
    expect(await sqlWrites(stub, tenant)).toBe(writes0) // ...no writes
    // The recording rule was sent again under the same id, so a de-duplicating sink holds one batch.
    expect(w.sinkWrites.length).toBe(2)
    expect(w.sinkById.size).toBe(1)
    expect(ok(await stub.health(tenant)).groups[0]).toMatchObject({ skippedTicks: 0, lastEvaluationMs: t2 })
  })
})

describe('write discipline: rows are written on transitions and at the heartbeat only', () => {
  it('100 steadily firing alerts cost zero SQL row writes per tick', async () => {
    const { tenant, stub, w } = await setup({ heartbeatMs: 10 * MIN })
    let v = 1
    w.evaluate = () => vec(...Array.from({ length: 10 }, (_, i): [Record<string, string>, number] => [{ instance: `i${i}` }, v++]))
    const rules = Array.from({ length: 10 }, (_, i) => ({ alert: `A${i}`, expr: `m${i} > 0`, for: '1m', annotations: { v: '{{ $value }}' } }))
    ok(await stub.saveGroups(tenant, file(rules)))
    await nextTick(stub, tenant) // 100 pending
    await nextTick(stub, tenant) // 100 firing
    expect((await alertsOf(stub, tenant)).filter((a) => a.state === 'firing').length).toBe(100)
    const h0 = ok(await stub.health(tenant))
    const perTick: number[] = []
    let last = h0.counters.sqlRowsWritten
    for (let i = 0; i < 8; i++) {
      await nextTick(stub, tenant)
      const now = await sqlWrites(stub, tenant)
      perTick.push(now - last)
      last = now
    }
    expect(perTick).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    const h1 = ok(await stub.health(tenant))
    // The only billed write per tick is re-arming the alarm.
    expect(h1.counters.alarmsSet - h0.counters.alarmsSet).toBe(8)
    expect(h1.groups[0]!.evaluations).toBe(10)
    // The in-memory value and annotation still follow the data.
    const a = (await alertsOf(stub, tenant, 'A0'))[0]!
    expect(a.value).toBeGreaterThan(900)
    expect(a.annotations.v).toBe(String(a.value))
  })

  it('the heartbeat writes exactly one row per heartbeat period, whatever the number of groups and rules', async () => {
    const { tenant, stub } = await setup({ heartbeatMs: 5 * MIN })
    const groups = Array.from({ length: 5 }, (_, g) => ({ name: `g${g}`, interval: '1m', rules: Array.from({ length: 20 }, (_, r) => ({ alert: `A${r}`, expr: 'up' })) }))
    ok(await stub.saveGroups(tenant, { groups }))
    await alarmAt(stub, T0 + 2 * MIN) // first tick: all groups, first heartbeat
    const w0 = await sqlWrites(stub, tenant)
    await alarmAt(stub, T0 + 6 * MIN + 59_000) // 4m59s later: no heartbeat yet
    expect(await sqlWrites(stub, tenant)).toBe(w0)
    await alarmAt(stub, T0 + 7 * MIN)
    expect(await sqlWrites(stub, tenant)).toBe(w0 + 1)
    await alarmAt(stub, T0 + 11 * MIN + 59_000)
    expect(await sqlWrites(stub, tenant)).toBe(w0 + 1)
    await alarmAt(stub, T0 + 12 * MIN)
    expect(await sqlWrites(stub, tenant)).toBe(w0 + 2)
  })

  it('each transition writes its own alert row plus one hand-off row for the batch', async () => {
    const { tenant, stub, w } = await setup({ heartbeatMs: 60 * MIN })
    w.notifierDown = true // keep hand-off rows so their deletes do not blur the count
    let series = vec()
    w.evaluate = () => series
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'up', for: '1m' }])))
    let at = await nextTick(stub, tenant)
    const step = async (next: typeof series) => {
      const before = await sqlWrites(stub, tenant)
      series = next
      await alarmAt(stub, (at += MIN))
      return (await sqlWrites(stub, tenant)) - before
    }
    const three = vec([{ i: '1' }, 1], [{ i: '2' }, 1], [{ i: '3' }, 1])
    expect(await step(three)).toBe(3) // 3 new pending alerts
    expect(await step(three)).toBe(4) // 3 pending -> firing, + 1 hand-off row
    expect(await step(three)).toBe(0)
    expect(await step(vec([{ i: '1' }, 1]))).toBe(3) // 2 resolved, + 1 hand-off row
    expect(await step(vec([{ i: '1' }, 1]))).toBe(0)
  })
})

describe('evaluator errors and limits', () => {
  it('a failed evaluation marks the rule err, keeps its alerts exactly as they were, and resolves nothing', async () => {
    const { tenant, stub, w, notifier } = await setup()
    ok(await notifier.setConfig(tenant, amConfig()))
    let fail = false
    w.evaluate = (q) => {
      if (fail && q === 'flaky') throw new Error('engine: query timed out')
      return vec([{ i: '1' }, 1])
    }
    ok(await stub.saveGroups(tenant, file([{ alert: 'Flaky', expr: 'flaky' }, { alert: 'Fine', expr: 'fine', for: '2m' }])))
    await nextTick(stub, tenant)
    const firing = await alertsOf(stub, tenant, 'Flaky')
    expect(firing[0]!.state).toBe('firing')
    expect(w.ingestCalls.flat().map((u) => u.status)).toEqual(['firing'])
    fail = true
    const writes = await sqlWrites(stub, tenant)
    for (let i = 0; i < 20; i++) await nextTick(stub, tenant) // far longer than the resolved retention
    expect(await alertsOf(stub, tenant, 'Flaky')).toEqual(firing)
    expect(w.ingestCalls.flat().filter((u) => u.labels.alertname === 'Flaky').map((u) => u.status)).toEqual(['firing']) // no resolve was sent
    const h = ok(await stub.health(tenant))
    expect(h.groups[0]).toMatchObject({ evaluatorErrors: 20, rulesInError: [{ rule: 'Flaky', error: 'engine: query timed out' }] })
    expect(ok(await stub.rules(tenant)).rules.find((r) => r.name === 'Flaky')).toMatchObject({ health: 'err', lastError: 'engine: query timed out' })
    // The other rule in the group was not held up, and its `for` kept counting.
    expect((await alertsOf(stub, tenant, 'Fine'))[0]!.state).toBe('firing')
    // Only the other rule's pending -> firing wrote anything.
    expect((await sqlWrites(stub, tenant)) - writes).toBeLessThanOrEqual(8)
    // The state also survives a restart during the outage.
    await evictDurableObject(stub)
    await nextTick(stub, tenant)
    expect(await alertsOf(stub, tenant, 'Flaky')).toEqual(firing)
    fail = false
    await nextTick(stub, tenant)
    expect(ok(await stub.rules(tenant)).rules.find((r) => r.name === 'Flaky')).toMatchObject({ health: 'ok', lastError: null })
  })

  it('an evaluator that never answers fails the rule after groupTimeoutMs instead of hanging the tick', async () => {
    const { tenant, stub, w } = await setup({ groupTimeoutMs: 150 })
    w.evaluate = (q) => (q === 'hang' ? new Promise(() => {}) : vec([{ i: '1' }, 1]))
    ok(await stub.saveGroups(tenant, file([{ alert: 'Before', expr: 'ok' }, { alert: 'Hang', expr: 'hang' }, { alert: 'After', expr: 'ok2' }])))
    await nextTick(stub, tenant)
    const rules = ok(await stub.rules(tenant)).rules
    expect(rules.map((r) => r.health)).toEqual(['ok', 'err', 'err'])
    expect(rules[1]!.lastError).toMatch(/exceeded 150 ms/)
    expect((await alertsOf(stub, tenant, 'Before'))[0]!.state).toBe('firing') // what was evaluated is kept
    expect(ok(await stub.health(tenant)).alarmAtMs).not.toBeNull() // and the object will tick again
  })

  it('the group `limit` and the tenant cap fail the rule without dropping its existing alerts', async () => {
    const { tenant, stub, w } = await setup({ limits: { maxAlertsPerRule: 5 } })
    let n = 2
    w.evaluate = () => vec(...Array.from({ length: n }, (_, i): [Record<string, string>, number] => [{ i: String(i) }, 1]))
    ok(await stub.saveGroups(tenant, { groups: [
      { name: 'limited', interval: '1m', limit: 3, rules: [{ alert: 'A', expr: 'up' }, { record: 'r', expr: 'up' }] },
      { name: 'capped', interval: '1m', rules: [{ alert: 'B', expr: 'up' }] },
    ] }))
    await alarmAt(stub, T0 + 2 * MIN)
    expect((await alertsOf(stub, tenant)).length).toBe(4)
    n = 4
    await alarmAt(stub, T0 + 3 * MIN)
    let rules = ok(await stub.rules(tenant)).rules
    expect(rules.map((r) => [r.name, r.health, r.lastError])).toEqual([
      ['A', 'err', 'exceeded limit of 3 with 4 alerts'],
      ['r', 'err', 'exceeded limit of 3 with 4 series'],
      ['B', 'ok', null],
    ])
    expect(rules[0]!.alerts.length).toBe(2) // kept, not wiped (README: deviation from Prometheus)
    n = 6
    await alarmAt(stub, T0 + 4 * MIN)
    rules = ok(await stub.rules(tenant)).rules
    expect(rules[2]).toMatchObject({ health: 'err', lastError: 'exceeded limit of 5 with 6 alerts' })
    expect(rules[2]!.alerts.length).toBe(4)
  })

  it('refuses more groups, rules or bytes than the limits allow, saving nothing', async () => {
    const { tenant, stub } = await setup({ limits: { maxGroups: 2, maxRulesPerGroup: 3, maxGroupBytes: 2000 } })
    ok(await stub.saveGroups(tenant, { groups: [{ name: 'a', rules: [] }, { name: 'b', rules: [] }] }))
    const third = await stub.saveGroups(tenant, { groups: [{ name: 'c', rules: [{ alert: 'A', expr: 'up' }] }] })
    expect(third).toMatchObject({ status: 'invalid', errors: [{ path: 'groups' }] })
    // Replacing an existing group is not a new group.
    expect((await stub.saveGroups(tenant, { groups: [{ name: 'a', rules: [{ alert: 'A', expr: 'up' }] }] })).status).toBe('ok')
    const tooMany = await stub.saveGroups(tenant, { groups: [{ name: 'a', rules: [1, 2, 3, 4].map((i) => ({ alert: `A${i}`, expr: 'up' })) }] })
    expect(tooMany).toMatchObject({ status: 'invalid', errors: [{ path: 'groups[0].rules' }] })
    const tooBig = await stub.saveGroups(tenant, { groups: [{ name: 'a', rules: [{ alert: 'A', expr: 'up', annotations: { d: 'x'.repeat(2500) } }] }] })
    expect(tooBig).toMatchObject({ status: 'invalid', errors: [{ path: 'groups[0]' }] })
    expect(ok(await stub.listGroups(tenant)).groups.map((g) => [g.name, g.rules.length])).toEqual([['a', 1], ['b', 0]])
    const interval = await stub.saveGroups(tenant, { groups: [{ name: 'a', interval: '1s', rules: [] }] })
    expect(interval).toMatchObject({ status: 'invalid', errors: [{ path: 'groups[0].interval' }] })
  })

  it('truncates an expanded annotation at the annotation limit', async () => {
    const { tenant, stub, w } = await setup({ limits: { maxAnnotationBytes: 64 } })
    w.evaluate = () => vec([{ blob: 'é'.repeat(500) }, 1])
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'up', annotations: { d: '{{ $labels.blob }}' } }])))
    await nextTick(stub, tenant)
    const d = (await alertsOf(stub, tenant))[0]!.annotations.d!
    expect(new TextEncoder().encode(d).length).toBeLessThanOrEqual(64 + 16)
    expect(d.endsWith('[truncated]')).toBe(true)
  })
})

describe('save results and classification', () => {
  it('returns each rule\'s cost class with the save result, and warns without failing', async () => {
    const { tenant, stub } = await setup({ hotWindowMs: 10 * MIN, recentWindowMs: 6 * 60 * MIN })
    const doc = { groups: [{ name: 'g', interval: '5m', rules: [
      { alert: 'Tail', expr: 'rate(errors_total[5m]) > 1', for: '1m' },
      { alert: 'Recent', expr: 'avg_over_time(latency[2h]) > 1' },
      { record: 'weekly:avg', expr: 'avg_over_time(latency[7d])' },
    ] }] }
    const checked = ok(await stub.checkGroups(tenant, doc))
    expect(ok(await stub.listGroups(tenant)).groups).toEqual([]) // checking saves nothing
    const saved = ok(await stub.saveGroups(tenant, doc))
    expect(saved.groups).toEqual(checked.groups)
    expect(saved.groups[0]!.rules.map((r) => [r.name, r.kind, r.cost.class, r.cost.windowMs])).toEqual([
      ['Tail', 'alert', 'tail', 5 * MIN],
      ['Recent', 'alert', 'recent', 120 * MIN],
      ['weekly:avg', 'record', 'rollup', 7 * 24 * 60 * MIN],
    ])
    expect(saved.warnings.map((x) => x.path)).toEqual(['groups[0].rules[0].for'])
    // Changing the hot window re-classifies what is stored.
    ok(await stub.configure(tenant, { hotWindowMs: 3 * 60 * MIN }))
    expect(ok(await stub.rules(tenant)).rules.map((r) => r.cost.class)).toEqual(['tail', 'tail', 'rollup'])
    await evictDurableObject(stub)
    expect(ok(await stub.rules(tenant)).rules.map((r) => r.cost.class)).toEqual(['tail', 'tail', 'rollup'])
    expect(await stub.configure(tenant, { heartbeatMs: -1, nope: 1 } as never)).toMatchObject({ status: 'invalid' })
  })

  it('an invalid file saves nothing and says where and how to fix it', async () => {
    const { tenant, stub } = await setup()
    const r = await stub.saveGroups(tenant, { groups: [{ name: 'g', rules: [{ alert: 'A', expr: 'up', annotations: { s: '{{ range . }}{{ end }}' } }] }] })
    expect(r.status).toBe('invalid')
    if (r.status !== 'invalid') return
    expect(r.errors).toEqual([{ path: 'groups[0].rules[0].annotations.s', message: expect.stringContaining('"range" is not supported'), fix: expect.stringContaining('Supported:') }])
    expect(ok(await stub.health(tenant)).groups).toEqual([])
  })
})

describe('recording rules and the sink', () => {
  it('hands samples to the sink with an id that is the same for the same (rule, evaluation time)', async () => {
    const { tenant, stub, w } = await setup()
    w.evaluate = () => vec([{ __name__: 'up', job: 'a' }, '0.5'])
    const saved = ok(await stub.saveGroups(tenant, file([{ record: 'job:up', expr: 'up', labels: { src: 'ruler' } }])))
    const key = saved.groups[0]!.rules[0]!.key
    const t1 = await nextTick(stub, tenant)
    const t2 = await nextTick(stub, tenant)
    expect(w.sinkWrites.flat()).toEqual([
      { id: `${tenant}/0/g/${key}@${t1}`, samples: [{ labels: { __name__: 'job:up', job: 'a', src: 'ruler' }, timeMs: t1, value: '0.5' }] },
      { id: `${tenant}/0/g/${key}@${t2}`, samples: [{ labels: { __name__: 'job:up', job: 'a', src: 'ruler' }, timeMs: t2, value: '0.5' }] },
    ])
  })

  it('retries a failing sink within the tick; if it keeps failing the batch is counted as dropped and the rule is err', async () => {
    const { tenant, stub, w } = await setup()
    w.evaluate = () => vec([{ job: 'a' }, 1])
    ok(await stub.saveGroups(tenant, file([{ record: 'job:up', expr: 'up' }])))
    w.sinkFail = 2
    await nextTick(stub, tenant)
    expect(w.sinkWrites.length).toBe(1) // third attempt got through
    expect(ok(await stub.health(tenant)).samplesDropped).toBe(0)
    w.sinkFail = 3
    await nextTick(stub, tenant)
    expect(w.sinkWrites.length).toBe(1)
    expect(ok(await stub.health(tenant))).toMatchObject({ samplesDropped: 1, groups: [{ rulesInError: [{ rule: 'job:up', error: 'sink: sink unavailable' }] }] })
    await nextTick(stub, tenant)
    expect(ok(await stub.health(tenant)).groups[0]!.rulesInError).toEqual([])
  })
})

describe('health and the hand-off outbox', () => {
  it('reports last evaluation, duration, skipped ticks, errors, outbox depth and oldest undelivered age', async () => {
    const { tenant, stub, w, notifier } = await setup()
    ok(await notifier.setConfig(tenant, amConfig()))
    w.notifierDown = true
    w.evaluate = () => vec([{ i: '1' }, 1])
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'up' }])))
    const t1 = await nextTick(stub, tenant)
    let h = ok(await stub.health(tenant))
    expect(h).toMatchObject({ tenant, shard: '0', nowMs: t1, outboxDepth: 1, oldestUndeliveredAgeMs: 0, lastHandoffError: 'notifier unreachable' })
    expect(h.groups[0]).toMatchObject({ name: 'g', intervalMs: MIN, lastEvaluationMs: t1, nextEvaluationMs: t1 + MIN, evaluations: 1, skippedTicks: 0, unobservedTicks: 0, evaluatorErrors: 0 })
    expect(h.groups[0]!.lastDurationMs).toBeGreaterThanOrEqual(0)
    // The retry is scheduled before the next tick (seeded backoff), and the age grows meanwhile.
    expect(h.alarmAtMs!).toBeGreaterThan(t1)
    expect(h.alarmAtMs!).toBeLessThan(t1 + 3000)
    world.now = t1 + 40_000
    expect(ok(await stub.health(tenant)).oldestUndeliveredAgeMs).toBe(40_000)
    // The outbox survives a restart, and drains once the notifier is back.
    await evictDurableObject(stub)
    expect(ok(await stub.health(tenant))).toMatchObject({ outboxDepth: 1, oldestUndeliveredAgeMs: 40_000 })
    w.notifierDown = false
    await nextTick(stub, tenant)
    h = ok(await stub.health(tenant))
    expect(h).toMatchObject({ outboxDepth: 0, oldestUndeliveredAgeMs: null, lastHandoffError: null })
    expect(ok(await notifier.health(tenant)).alerts.firing).toBe(1)
  })

  it('after a restart, ticks since the last heartbeat are reported as unobserved, not as skipped', async () => {
    const { tenant, stub } = await setup({ heartbeatMs: 10 * MIN })
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'up' }])))
    for (let i = 0; i < 4; i++) await nextTick(stub, tenant) // heartbeat on the first; three more unrecorded
    await evictDurableObject(stub)
    await nextTick(stub, tenant)
    expect(ok(await stub.health(tenant)).groups[0]).toMatchObject({ skippedTicks: 0, unobservedTicks: 3 })
    // With heartbeatMs 0 the cursor is written every tick and the count is exact.
    const exact = await setup({ heartbeatMs: 0 })
    ok(await exact.stub.saveGroups(exact.tenant, file([{ alert: 'A', expr: 'up' }])))
    const t1 = await nextTick(exact.stub, exact.tenant)
    await nextTick(exact.stub, exact.tenant)
    await evictDurableObject(exact.stub)
    await alarmAt(exact.stub, t1 + 4 * MIN + 5000)
    expect(ok(await exact.stub.health(exact.tenant)).groups[0]).toMatchObject({ skippedTicks: 2, unobservedTicks: 0, lastEvaluationMs: t1 + 4 * MIN })
  })

  it('deleting a group or a rule tells the notifier its firing alerts are over', async () => {
    const { tenant, stub, w, notifier } = await setup()
    ok(await notifier.setConfig(tenant, amConfig()))
    w.evaluate = () => vec([{ i: '1' }, 1])
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'up' }, { alert: 'B', expr: 'up' }])))
    await nextTick(stub, tenant)
    expect(ok(await notifier.health(tenant)).alerts).toEqual({ firing: 2, resolved: 0 })
    ok(await stub.saveGroups(tenant, file([{ alert: 'B', expr: 'up' }]))) // A removed
    await runInDurableObject(stub, (inst) => inst.alarm())
    expect(ok(await notifier.health(tenant)).alerts).toEqual({ firing: 1, resolved: 1 })
    ok(await stub.deleteGroup(tenant, 'g'))
    await runInDurableObject(stub, (inst) => inst.alarm())
    expect(ok(await notifier.health(tenant)).alerts).toEqual({ firing: 0, resolved: 2 })
    expect(ok(await stub.health(tenant))).toMatchObject({ outboxDepth: 0, alarmAtMs: null })
    expect(await alertsOf(stub, tenant)).toEqual([])
  })

  it('a group replaced while its tick is in flight abandons that tick instead of writing stale results', async () => {
    const { tenant, stub, w } = await setup()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    w.evaluate = async (q) => {
      if (q === 'slow') await gate
      return vec([{ i: '1' }, 1])
    }
    ok(await stub.saveGroups(tenant, file([{ alert: 'Old', expr: 'slow' }])))
    const h = ok(await stub.health(tenant))
    world.now = h.alarmAtMs!
    const ticking = runInDurableObject(stub, (inst) => inst.alarm())
    await new Promise((r) => setTimeout(r, 20))
    ok(await stub.saveGroups(tenant, file([{ alert: 'New', expr: 'fast' }])))
    release()
    await ticking
    expect(ok(await stub.rules(tenant)).rules.map((r) => [r.name, r.alerts.length])).toEqual([['New', 0]])
    expect(ok(await stub.health(tenant)).alarmAtMs).not.toBeNull()
  })
})

describe('tenant isolation', () => {
  it('every RPC refuses a tenant other than the one the object is named for', async () => {
    const { tenant, stub, notifier } = await setup()
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'up' }])))
    const wrong = { status: 'wrong_tenant' }
    const other = 'intruder'
    expect(await stub.configure(other, { deadman: true })).toEqual(wrong)
    expect(await stub.saveGroups(other, file([]))).toEqual(wrong)
    expect(await stub.checkGroups(other, file([]))).toEqual(wrong)
    expect(await stub.deleteGroup(other, 'g')).toEqual(wrong)
    expect(await stub.listGroups(other)).toEqual(wrong)
    expect(await stub.rules(other)).toEqual(wrong)
    expect(await stub.health(other)).toEqual(wrong)
    expect(await stub.ensureArmed(other)).toEqual(wrong)
    expect(await stub.saveGroups('', file([]))).toEqual(wrong)
    expect(ok(await stub.listGroups(tenant)).groups.length).toBe(1)
    expect(await notifier.setConfig(other, amConfig())).toEqual(wrong)
    expect(await notifier.ingest(other, `${other}/0`, [])).toEqual(wrong)
    expect(await notifier.ingest(tenant, `${other}/0`, [])).toEqual(wrong) // a shard of another tenant cannot speak here
    expect(await notifier.createSilence(other, {} as never)).toEqual(wrong)
    expect(await notifier.expireSilence(other, 'x')).toEqual(wrong)
    expect(await notifier.listSilences(other)).toEqual(wrong)
    expect(await notifier.listAlerts(other)).toEqual(wrong)
    expect(await notifier.outbox(other)).toEqual(wrong)
    expect(await notifier.retryDeadLetter(other, 1)).toEqual(wrong)
    expect(await notifier.discardDeadLetter(other, 1)).toEqual(wrong)
    expect(await notifier.health(other)).toEqual(wrong)
  })

  it('two tenants with the same group and rule names never see each other\'s rules, alerts, queries or notifications', async () => {
    const a = await setup()
    const b = await setup()
    for (const t of [a, b]) ok(await t.notifier.setConfig(t.tenant, amConfig()))
    a.w.evaluate = () => vec([{ secret: 'tenant-a' }, 1])
    b.w.evaluate = () => vec([{ secret: 'tenant-b' }, 2])
    ok(await a.stub.saveGroups(a.tenant, file([{ alert: 'Same', expr: 'a_metric', annotations: { s: '{{ $labels.secret }}' } }])))
    ok(await b.stub.saveGroups(b.tenant, file([{ alert: 'Same', expr: 'b_metric', annotations: { s: '{{ $labels.secret }}' } }])))
    for (const t of [a, b]) {
      await nextTick(t.stub, t.tenant)
      await runNotifierUntil(t.notifier, t.tenant, world.now)
    }
    for (const [t, own, foreign] of [[a, 'tenant-a', 'tenant-b'], [b, 'tenant-b', 'tenant-a']] as const) {
      const everything = JSON.stringify([await t.stub.rules(t.tenant), await t.stub.listGroups(t.tenant), await t.notifier.listAlerts(t.tenant), t.w.received, t.w.evalCalls])
      expect(everything).toContain(own)
      expect(everything).not.toContain(foreign)
      expect(t.w.received.length).toBe(1)
    }
    // Rows are stored under the object's own tenant only.
    const tenants = await runInDurableObject(a.stub, (_i, state) =>
      ['meta', 'rule_group', 'alert', 'handoff'].flatMap((table) => state.storage.sql.exec<{ tenant: string }>(`SELECT DISTINCT tenant FROM ${table}`).toArray().map((r) => r.tenant)))
    expect(new Set(tenants)).toEqual(new Set([a.tenant]))
  })

  it('an object reached under a name that is not `<tenant>/<n>` serves nobody', async () => {
    const stub = rulerStub('', 'x')
    expect(await stub.health('')).toEqual({ status: 'wrong_tenant' })
  })

  it('every SQL statement that touches tenant data names the tenant (AGENTS.md, Durable Objects)', () => {
    for (const [name, source] of [['ruler.ts', rulerSource], ['notifier.ts', notifierSource]] as const) {
      const statements = [...source.matchAll(/`((?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*)`/g)].map((m) => m[1]!)
      expect(statements.length, name).toBeGreaterThan(8)
      for (const sql of statements) {
        if (sql.startsWith('INSERT')) expect(sql, name).toMatch(/\(tenant,/)
        else expect(sql, name).toMatch(/WHERE tenant = \?/)
      }
    }
  })
})

describe("dead-man's switch", () => {
  it('shard 0 of an activated tenant carries an always-firing rule that reaches the receiver end to end', async () => {
    const tenant = newTenant()
    const { stub, w, notifier } = await setup({ deadman: true, heartbeatMs: 5 * MIN }, tenant)
    ok(await notifier.setConfig(tenant, amConfig({ route: { receiver: 'hook', group_by: ['alertname'], group_wait: '0s', group_interval: '1m', repeat_interval: '10m' } })))
    const h = ok(await stub.health(tenant))
    expect(h.groups.map((g) => g.name)).toEqual(['viz:deadman'])
    const t1 = await nextTick(stub, tenant)
    expect(w.evalCalls).toEqual([['vector(1)', t1]]) // it goes through the evaluator like any rule
    expect((await alertsOf(stub, tenant))[0]).toMatchObject({ state: 'firing', labels: { alertname: 'DeadMansSwitch', severity: 'none' } })
    await runNotifierUntil(notifier, tenant, world.now)
    expect(w.received.length).toBe(1)
    expect(w.received[0]!.body).toMatchObject({ status: 'firing', alerts: [{ labels: { alertname: 'DeadMansSwitch' } }] })
    // It cannot be deleted or shadowed by a user group.
    expect(await stub.deleteGroup(tenant, 'viz:deadman')).toEqual({ status: 'ok', existed: false })
    expect((await stub.saveGroups(tenant, { groups: [{ name: 'viz:deadman', rules: [] }] })).status).toBe('invalid')
  })

  it('while the ruler ticks the switch keeps repeating; when the ruler stops, the notifier resolves it by itself', async () => {
    const tenant = newTenant()
    const { stub, w, notifier } = await setup({ deadman: true, heartbeatMs: 5 * MIN }, tenant)
    ok(await notifier.setConfig(tenant, amConfig({ route: { receiver: 'hook', group_by: ['alertname'], group_wait: '0s', group_interval: '1m', repeat_interval: '10m' } })))
    const t1 = await nextTick(stub, tenant)
    await runNotifierUntil(notifier, tenant, world.now)
    // 30 minutes of healthy ticking: the ruler refreshes the alert at each heartbeat.
    for (let m = 1; m <= 30; m++) {
      await alarmAt(stub, t1 + m * MIN)
      await runNotifierUntil(notifier, tenant, world.now)
    }
    const firing = w.received.filter((r) => (r.body as { status: string }).status === 'firing').length
    expect(firing).toBe(4) // the first, then one per 10m repeat_interval
    expect(w.received.length).toBe(firing)
    expect(new Set(w.received.map((r) => r.key)).size).toBe(firing) // each repeat is its own notification
    // The ruler dies (no more alarms run). Nothing refreshes the alert.
    const diedAt = world.now
    await runNotifierUntil(notifier, tenant, diedAt + 30 * MIN)
    const resolved = w.received.filter((r) => (r.body as { status: string }).status === 'resolved')
    expect(resolved.length).toBe(1)
    expect(resolved[0]!.at - diedAt).toBeLessThanOrEqual(2 * 5 * MIN + 2 * MIN)
    expect(ok(await notifier.health(tenant)).alerts.firing).toBe(0)
  })

  it('is off on other shards, on untouched tenants, and when disabled', async () => {
    const tenant = newTenant()
    world.now = T0
    const shard1 = rulerStub(tenant, '1')
    ok(await shard1.configure(tenant, {}))
    expect(ok(await shard1.health(tenant)).groups).toEqual([])
    const shard0 = rulerStub(tenant, '0')
    expect(ok(await shard0.health(tenant)).groups).toEqual([]) // not activated yet
    ok(await shard0.configure(tenant, {}))
    expect(ok(await shard0.health(tenant)).groups.map((g) => g.name)).toEqual(['viz:deadman'])
    ok(await shard0.configure(tenant, { deadman: false }))
    expect(ok(await shard0.health(tenant)).groups).toEqual([])
    expect(tenantWorld(tenant).evalCalls).toEqual([])
    expect(ok(await notifierStub(tenant).health(tenant)).alerts).toEqual({ firing: 0, resolved: 0 })
  })
})
