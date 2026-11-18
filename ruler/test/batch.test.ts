/**
 * The batch evaluator: one call per rule group per tick, a result or an error per
 * expression, and the single-call form kept as an adapter.
 */
import { evictDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { Evaluator } from '../contracts-proposal/rules.v2'
import { batchFromSingle, permissiveValidator } from '../src/evaluator'
import { T0 as T0_VALUE } from './harness'
import { alarmAt, alertsOf, MIN, nextTick, notifierStub, ok, setup, vec } from './helpers'

const T0 = () => T0_VALUE

const file = (rules: unknown[], extra: Record<string, unknown> = {}, name = 'g') => ({ groups: [{ name, interval: '1m', ...extra, rules }] })
const one = vec([{ i: '1' }, 1])

async function batchSetup(patch = {}) {
  const t = await setup(patch)
  t.w.batch = true
  return t
}

describe('one batch call per group per tick', () => {
  it('a group of N rules is one evaluator call carrying N requests, each with the rule key as id and the group evaluation time', async () => {
    const { tenant, stub, w } = await batchSetup()
    w.evaluate = () => one
    const saved = ok(await stub.saveGroups(tenant, file(Array.from({ length: 50 }, (_, i) => ({ alert: `A${i}`, expr: `m${i} > 0` })))))
    const at = await nextTick(stub, tenant)
    expect(w.batchCalls.length).toBe(1)
    expect(w.batchCalls[0]!.map((r) => r.id)).toEqual(saved.groups[0]!.rules.map((r) => r.key))
    expect(w.batchCalls[0]!.map((r) => r.promql)).toEqual(Array.from({ length: 50 }, (_, i) => `m${i} > 0`))
    expect(new Set(w.batchCalls[0]!.map((r) => r.timeMs))).toEqual(new Set([at]))
    expect((await alertsOf(stub, tenant)).length).toBe(50)
    await nextTick(stub, tenant)
    expect(w.batchCalls.length).toBe(2) // and one more per tick, never one per rule
  })

  it('groups due at the same alarm make one call each', async () => {
    const { tenant, stub, w } = await batchSetup()
    ok(await stub.saveGroups(tenant, { groups: Array.from({ length: 5 }, (_, g) => ({ name: `g${g}`, interval: '1m', rules: [0, 1, 2].map((r) => ({ alert: `A${r}`, expr: `g${g}r${r}` })) })) }))
    await alarmAt(stub, T0() + 2 * MIN)
    expect(w.batchCalls.map((c) => c.length)).toEqual([3, 3, 3, 3, 3])
    expect(w.batchCalls.map((c) => new Set(c.map((r) => r.promql.slice(0, 2))).size)).toEqual([1, 1, 1, 1, 1]) // no call mixes groups
  })

  it('query_offset shifts the time every request of the batch is evaluated at', async () => {
    const { tenant, stub, w } = await batchSetup()
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'a' }, { record: 'r', expr: 'b' }], { query_offset: '2m' })))
    const at = await nextTick(stub, tenant)
    expect(w.batchCalls[0]!.map((r) => r.timeMs)).toEqual([at - 2 * MIN, at - 2 * MIN])
  })
})

describe('one failing expression does not fail the batch', () => {
  it('the failed rule is err with the engine message and keeps its alerts; every other rule in the batch is evaluated and transitions', async () => {
    const { tenant, stub, w } = await batchSetup()
    const notifier = notifierStub(tenant)
    ok(await notifier.setConfig(tenant, { route: { receiver: 'hook', group_wait: '0s', group_interval: '1m', repeat_interval: '4h' }, receivers: [{ name: 'hook', webhook_configs: [{ url: 'https://receiver.test/hook' }] }] }))
    let fail = false
    w.evaluate = (q) => {
      if (fail && q === 'bad') throw new Error('parse error: unexpected right parenthesis ")"')
      return one
    }
    ok(await stub.saveGroups(tenant, file([{ alert: 'First', expr: 'ok1', for: '1m' }, { alert: 'Broken', expr: 'bad' }, { alert: 'Last', expr: 'ok2', for: '1m' }])))
    await nextTick(stub, tenant)
    const before = await alertsOf(stub, tenant, 'Broken')
    expect(before[0]!.state).toBe('firing')
    fail = true
    await nextTick(stub, tenant)
    const rules = ok(await stub.rules(tenant)).rules
    expect(rules.map((r) => [r.name, r.health, r.lastError])).toEqual([['First', 'ok', null], ['Broken', 'err', 'parse error: unexpected right parenthesis ")"'], ['Last', 'ok', null]])
    // The group was not failed: the rules around the broken one went pending -> firing in this very tick.
    expect((await alertsOf(stub, tenant, 'First'))[0]!.state).toBe('firing')
    expect((await alertsOf(stub, tenant, 'Last'))[0]!.state).toBe('firing')
    // The broken rule's alert is exactly as it was and nothing was resolved.
    expect(await alertsOf(stub, tenant, 'Broken')).toEqual(before)
    expect(w.ingestCalls.flat().filter((u) => u.status === 'resolved')).toEqual([])
    expect(ok(await stub.health(tenant)).groups[0]).toMatchObject({ evaluatorErrors: 1, rulesInError: [{ rule: 'Broken' }] })
    expect(w.batchCalls.length).toBe(2)
  })

  it('a rule that fails at evaluation time is health err with the message, survives a restart of the object, and recovers when the query works again', async () => {
    const { tenant, stub, w } = await batchSetup()
    w.evaluate = () => {
      throw new Error('engine: unknown function "rat"')
    }
    ok(await stub.saveGroups(tenant, file([{ alert: 'Typo', expr: 'rat(x[5m]) > 1' }])))
    expect(ok(await stub.rules(tenant)).rules[0]).toMatchObject({ health: 'unknown', lastError: null })
    const at = await nextTick(stub, tenant)
    expect(ok(await stub.rules(tenant)).rules[0]).toMatchObject({ health: 'err', lastError: 'engine: unknown function "rat"', lastEvaluationMs: at })
    await evictDurableObject(stub)
    await nextTick(stub, tenant)
    expect(ok(await stub.rules(tenant)).rules[0]).toMatchObject({ health: 'err', lastError: 'engine: unknown function "rat"' })
    w.evaluate = () => vec()
    await nextTick(stub, tenant)
    expect(ok(await stub.rules(tenant)).rules[0]).toMatchObject({ health: 'ok', lastError: null })
  })

  it('the whole call failing (engine unreachable) marks every rule err and changes no state; a missing result fails only its rule', async () => {
    const { tenant, stub, w } = await batchSetup()
    w.evaluate = () => one
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'a' }, { alert: 'B', expr: 'b' }])))
    await nextTick(stub, tenant)
    const before = await alertsOf(stub, tenant)
    w.batchFail = 'engine unreachable'
    await nextTick(stub, tenant)
    expect(ok(await stub.rules(tenant)).rules.map((r) => [r.health, r.lastError])).toEqual([['err', 'engine unreachable'], ['err', 'engine unreachable']])
    expect(await alertsOf(stub, tenant)).toEqual(before)
    w.batchFail = null
    await nextTick(stub, tenant)
    expect(ok(await stub.rules(tenant)).rules.map((r) => r.health)).toEqual(['ok', 'ok'])
  })

  it('a result that is not a vector or scalar is that rule\'s error only', async () => {
    const { tenant, stub, w } = await batchSetup()
    w.evaluate = (q) => (q === 'm[5m]' ? ({ resultType: 'matrix', result: [] } as never) : one)
    ok(await stub.saveGroups(tenant, file([{ alert: 'Range', expr: 'm[5m]' }, { alert: 'Fine', expr: 'x' }])))
    await nextTick(stub, tenant)
    expect(ok(await stub.rules(tenant)).rules.map((r) => [r.name, r.health])).toEqual([['Range', 'err'], ['Fine', 'ok']])
    expect(ok(await stub.rules(tenant)).rules[0]!.lastError).toMatch(/must be a vector or scalar/)
  })

  it('a batch evaluator that never answers fails the group after groupTimeoutMs; the object ticks again', async () => {
    const { tenant, stub, w } = await batchSetup({ groupTimeoutMs: 150 })
    w.evaluate = (q) => (q === 'hang' ? new Promise(() => {}) : one)
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'a' }, { alert: 'H', expr: 'hang' }])))
    await nextTick(stub, tenant)
    const rules = ok(await stub.rules(tenant)).rules
    // A true batch has no partial answer to give: both rules of the call are err.
    expect(rules.map((r) => r.health)).toEqual(['err', 'err'])
    expect(rules[0]!.lastError).toMatch(/exceeded 150 ms/)
    expect(ok(await stub.health(tenant)).alarmAtMs).not.toBeNull()
  })
})

describe('recording rules read in the same tick', () => {
  it('a rule that reads a series recorded earlier in the group starts a second batch, after the sample was written', async () => {
    const { tenant, stub, w } = await batchSetup()
    w.evaluate = (q) => {
      if (q === 'sum(up)') return vec([{ job: 'api' }, 7])
      if (q === 'job:up:sum > 5') {
        const recorded = [...w.sinkById.values()].flatMap((b) => b.samples).filter((x) => x.labels.__name__ === 'job:up:sum')
        return vec(...recorded.map((x): [Record<string, string>, string] => [x.labels, x.value]))
      }
      return vec()
    }
    ok(await stub.saveGroups(tenant, file([{ alert: 'Before', expr: 'x' }, { record: 'job:up:sum', expr: 'sum(up)' }, { alert: 'Many', expr: 'job:up:sum > 5' }, { alert: 'After', expr: 'y' }])))
    await nextTick(stub, tenant)
    expect(w.batchCalls.map((c) => c.map((r) => r.promql))).toEqual([['x', 'sum(up)'], ['job:up:sum > 5', 'y']])
    expect((await alertsOf(stub, tenant, 'Many')).map((a) => a.state)).toEqual(['firing'])
    expect(w.sinkWrites.length).toBe(1) // written between the two batches
  })

  it('THE LIMITATION: a dependency the text does not show (a regex on __name__) stays in one batch and reads the previous tick', async () => {
    const { tenant, stub, w } = await batchSetup()
    let n = 0
    w.evaluate = (q) => {
      if (q === 'sum(up)') return vec([{ job: 'api' }, ++n])
      const recorded = [...w.sinkById.values()].flatMap((b) => b.samples).filter((x) => x.labels.__name__ === 'job:up:sum')
      const latest = recorded.sort((a, b) => b.timeMs - a.timeMs)[0]
      return latest ? vec([{ seen: latest.value }, 1]) : vec()
    }
    ok(await stub.saveGroups(tenant, file([{ record: 'job:up:sum', expr: 'sum(up)' }, { alert: 'Reads', expr: '{__name__=~"job:up:.+"}' }])))
    await nextTick(stub, tenant)
    expect(w.batchCalls.map((c) => c.length)).toEqual([2])
    expect(await alertsOf(stub, tenant, 'Reads')).toEqual([]) // Prometheus would have seen the value 1 here
    await nextTick(stub, tenant)
    // One interval late: it sees what was recorded at the previous tick (1), not this tick's 2.
    expect((await alertsOf(stub, tenant, 'Reads')).map((a) => a.labels.seen)).toEqual(['1'])
  })
})

describe('the single-call form is an adapter', () => {
  const single = (fn: (q: string) => unknown): Evaluator => ({ instant: async (q) => fn(q) as never })

  it('runs requests in order, one at a time, and reports each failure on its own request', async () => {
    const order: string[] = []
    let inFlight = 0
    let peak = 0
    const batch = batchFromSingle({
      instant: async (q) => {
        order.push(q)
        peak = Math.max(peak, ++inFlight)
        await new Promise((r) => setTimeout(r, 2))
        inFlight--
        if (q === 'b') throw new Error('boom')
        return { resultType: 'scalar', result: [0, '1'] }
      },
    })
    const out = await batch.evaluate([{ id: '1', promql: 'a', timeMs: 5 }, { id: '2', promql: 'b', timeMs: 5 }, { id: '3', promql: 'c', timeMs: 5 }])
    expect(order).toEqual(['a', 'b', 'c'])
    expect(peak).toBe(1)
    expect(out.map((r) => [r.id, r.ok, r.ok ? null : r.error])).toEqual([['1', true, null], ['2', false, 'boom'], ['3', true, null]])
    expect(out.every((r) => typeof r.durationMs === 'number')).toBe(true)
  })

  it('on abort it returns what it has: finished requests keep their results, the rest fail with the reason', async () => {
    const abort = new AbortController()
    const batch = batchFromSingle(single((q) => (q === 'hang' ? new Promise(() => {}) : { resultType: 'scalar', result: [0, '1'] })))
    setTimeout(() => abort.abort(new Error('out of time')), 20)
    const out = await batch.evaluate([{ id: '1', promql: 'a', timeMs: 0 }, { id: '2', promql: 'hang', timeMs: 0 }, { id: '3', promql: 'c', timeMs: 0 }], { signal: abort.signal })
    expect(out.map((r) => [r.ok, r.ok ? null : r.error])).toEqual([[true, null], [false, 'out of time'], [false, 'out of time']])
  })

  it('a ruler given only the single-call form behaves as before: N calls in order, and the per-rule duration is measured', async () => {
    const { tenant, stub, w } = await setup() // w.batch is false: the adapter is in use
    w.evaluate = async () => {
      await new Promise((r) => setTimeout(r, 3))
      return one
    }
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'a' }, { alert: 'B', expr: 'b' }, { alert: 'C', expr: 'c' }])))
    await nextTick(stub, tenant)
    expect(w.batchCalls).toEqual([])
    expect(w.evalCalls.map((c) => c[0])).toEqual(['a', 'b', 'c'])
    const snap = ok(await stub.snapshot(tenant))
    expect(snap.groups[0]!.rules.every((r) => (r.lastDurationMs ?? 0) >= 1)).toBe(true)
  })
})

describe('save-time PromQL validation (interface only; the engine binding does not exist yet)', () => {
  it('the permissive stand-in accepts any non-empty expression and reports no selectors', async () => {
    expect(await permissiveValidator.check('this is ((( not promql')).toEqual({ ok: true, errors: [], selectors: [] })
    expect((await permissiveValidator.check('  ')).ok).toBe(false)
  })

  it('so a syntactically wrong expression is saved, and found at its first evaluation', async () => {
    const { tenant, stub, w } = await batchSetup()
    w.evaluate = () => {
      throw new Error('1:5: parse error: unexpected identifier "promql"')
    }
    expect((await stub.saveGroups(tenant, file([{ alert: 'Wrong', expr: 'not promql at all' }]))).status).toBe('ok')
    await nextTick(stub, tenant)
    expect(ok(await stub.rules(tenant)).rules[0]).toMatchObject({ health: 'err', lastError: '1:5: parse error: unexpected identifier "promql"' })
  })

  it('a validator that rejects an expression stops the save, with the path of the expression, the offset and a fix; nothing is stored', async () => {
    const { tenant, stub, w } = await setup()
    w.validate = async (q) => (q.includes('rat(') ? { ok: false, errors: [{ message: 'unknown function "rat"', offset: 4 }], selectors: [] } : { ok: true, errors: [], selectors: [] })
    const r = await stub.saveGroups(tenant, file([{ alert: 'Fine', expr: 'up == 0' }, { alert: 'Bad', expr: 'sum(rat(up[5m]))' }]))
    expect(r).toMatchObject({ status: 'invalid', errors: [{ path: 'groups[0].rules[1].expr', message: 'unknown function "rat" (at character 4)' }] })
    expect(r.status === 'invalid' && r.errors[0]!.fix.length).toBeGreaterThan(10)
    expect(ok(await stub.listGroups(tenant)).groups).toEqual([])
    expect((await stub.checkGroups(tenant, file([{ alert: 'Bad', expr: 'rat(up[5m])' }]))).status).toBe('invalid')
  })

  it('a validator that cannot be reached does not block saving', async () => {
    const { tenant, stub, w } = await setup()
    w.validate = async () => {
      throw new Error('engine unreachable')
    }
    expect((await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'up == 0' }]))).status).toBe('ok')
  })
})
