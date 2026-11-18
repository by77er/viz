/**
 * Exactly-once EFFECT under at-least-once machinery.
 *
 * The receiver here behaves like a real idempotent consumer: it processes a request the
 * first time it sees an `Idempotency-Key` and ignores later requests with the same key.
 * Every test asserts on that de-duplicated view: exactly one processed notification per
 * decision, whatever was replayed, crashed, evicted or retried on the way.
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { WebhookPayload } from '../contracts-proposal/rules'
import { Crash, T0, tenantWorld, world, type Received, type TenantWorld, type TestNotifier, type TestRuler } from './harness'
import { alertsOf, MIN, newTenant, notifierStub, ok, rulerStub, vec } from './helpers'

const SEC = 1000

/** What an idempotent receiver ends up having processed: key -> the body it acted on. */
function processed(w: TenantWorld, handled: (r: Received, n: number) => boolean = (_r, n) => w.respond(w.received[n]!, n) !== 500) {
  const seen = new Map<string, unknown>()
  const conflicts: string[] = []
  w.received.forEach((r, n) => {
    if (!handled(r, n)) return
    expect(r.key, 'every request carries an idempotency key').toMatch(/^[0-9a-f]{32}$/)
    const key = r.key as string
    if (!seen.has(key)) seen.set(key, r.body)
    else if (JSON.stringify(seen.get(key)) !== JSON.stringify(r.body)) conflicts.push(key)
  })
  expect(conflicts, 'one key never names two different notifications').toEqual([])
  return [...seen.values()] as WebhookPayload[]
}

const summary = (ps: WebhookPayload[]) => ps.map((p) => `${p.status}:${p.alerts.map((a) => `${a.labels.instance}=${a.status}`).sort().join(',')}`)

async function env(tenant = newTenant('x'), opts: { groupWait?: string; rules?: unknown[] } = {}) {
  world.now = T0
  const ruler = rulerStub(tenant)
  const notifier = notifierStub(tenant)
  const w = tenantWorld(tenant)
  ok(await ruler.configure(tenant, { deadman: false, heartbeatMs: 30 * MIN }))
  ok(await notifier.setConfig(tenant, {
    route: { receiver: 'hook', group_by: ['alertname'], group_wait: opts.groupWait ?? '0s', group_interval: '1m', repeat_interval: '12h' },
    receivers: [{ name: 'hook', webhook_configs: [{ url: 'https://receiver.test/hook' }] }],
    delivery: { max_attempts: 50, base_backoff: '1s', max_backoff: '8s', timeout: '5s' },
  }))
  ok(await ruler.saveGroups(tenant, { groups: [{ name: 'g', interval: '1m', rules: opts.rules ?? [{ alert: 'Down', expr: 'up == 0' }] }] }))
  const first = ok(await ruler.health(tenant)).groups[0]!.nextEvaluationMs
  return { tenant, ruler, notifier, w, first }
}

type Stub = DurableObjectStub<TestRuler> | DurableObjectStub<TestNotifier>

/** Run an object's alarm handler directly. A crash is what the platform would see as a failed alarm. */
async function alarm(stub: Stub): Promise<'ok' | 'crashed'> {
  try {
    await runInDurableObject(stub as DurableObjectStub<TestRuler>, (inst) => inst.alarm())
    return 'ok'
  } catch (e) {
    if (e instanceof Crash || /injected crash/.test(String(e))) return 'crashed'
    throw e
  }
}

/**
 * Advance the clock to `until`, running each object's alarm whenever it is due (ruler first
 * on a tie). A crashed alarm loses the object's memory and is retried at once, which is the
 * platform's at-least-once behaviour compressed in time.
 */
async function pump(e: Awaited<ReturnType<typeof env>>, until: number, beforeEach?: (who: 'ruler' | 'notifier') => void | Promise<void>) {
  for (let i = 0; i < 20_000; i++) {
    const r = ok(await e.ruler.health(e.tenant)).alarmAtMs
    const n = ok(await e.notifier.health(e.tenant)).alarmAtMs
    const next = Math.min(r ?? Infinity, n ?? Infinity)
    if (next > until) break
    world.now = Math.max(world.now, next)
    const who = (r ?? Infinity) <= (n ?? Infinity) ? 'ruler' : 'notifier'
    const stub = who === 'ruler' ? e.ruler : e.notifier
    await beforeEach?.(who)
    for (let attempt = 0; (await alarm(stub)) === 'crashed'; attempt++) {
      if (attempt > 20) throw new Error('alarm keeps crashing')
      await evictDurableObject(stub)
    }
  }
  world.now = Math.max(world.now, until)
}

const down = (...instances: string[]) => vec(...instances.map((i): [Record<string, string>, number] => [{ instance: i }, 0]))

describe('replayed ticks', () => {
  it('replaying the alarm tick that made a transition, in memory and after eviction, yields one notification', async () => {
    const e = await env()
    e.w.evaluate = () => down('a')
    await pump(e, e.first)
    for (let i = 0; i < 3; i++) expect(await alarm(e.ruler)).toBe('ok')
    await evictDurableObject(e.ruler)
    world.now = e.first + 20 * SEC
    for (let i = 0; i < 3; i++) expect(await alarm(e.ruler)).toBe('ok')
    for (let i = 0; i < 3; i++) expect(await alarm(e.notifier)).toBe('ok')
    await evictDurableObject(e.notifier)
    for (let i = 0; i < 3; i++) expect(await alarm(e.notifier)).toBe('ok')
    await pump(e, e.first + 50 * SEC)
    expect(summary(processed(e.w))).toEqual(['firing:a=firing'])
    expect(e.w.received.length).toBe(1) // not even a duplicate request was made
    expect((await alertsOf(e.ruler, e.tenant))[0]).toMatchObject({ state: 'firing', activeAt: e.first, firedAt: e.first })
  })
})

describe('crashes in the ruler', () => {
  it('crash inside the transition transaction: nothing is persisted or handed off; the retry does it once', async () => {
    const e = await env()
    e.w.evaluate = () => down('a')
    e.w.faults.add('ruler:commit')
    world.now = e.first
    expect(await alarm(e.ruler)).toBe('crashed')
    // The transaction rolled back as a whole: no alert row, no hand-off row.
    const rows = await runInDurableObject(e.ruler, (_i, state) => ({
      alerts: state.storage.sql.exec(`SELECT COUNT(*) AS n FROM alert`).one().n,
      handoff: state.storage.sql.exec(`SELECT COUNT(*) AS n FROM handoff`).one().n,
    }))
    expect(rows).toEqual({ alerts: 0, handoff: 0 })
    expect(await alertsOf(e.ruler, e.tenant)).toEqual([]) // and memory was not ahead of storage
    expect(e.w.ingestCalls).toEqual([])
    await evictDurableObject(e.ruler)
    await pump(e, e.first + 30 * SEC)
    expect(summary(processed(e.w))).toEqual(['firing:a=firing'])
    expect(e.w.received.length).toBe(1)
  })

  it('crash between "transition persisted" and "outbox drained": the hand-off survives and is delivered once', async () => {
    const e = await env()
    e.w.evaluate = () => down('a', 'b')
    e.w.faults.add('ruler:after-commit')
    world.now = e.first
    expect(await alarm(e.ruler)).toBe('crashed')
    expect(e.w.ingestCalls).toEqual([]) // committed, not yet sent
    await evictDurableObject(e.ruler)
    expect(ok(await e.ruler.health(e.tenant))).toMatchObject({ outboxDepth: 1 })
    expect((await alertsOf(e.ruler, e.tenant)).map((a) => a.state)).toEqual(['firing', 'firing'])
    await pump(e, e.first + 30 * SEC)
    expect(e.w.ingestCalls.length).toBe(1) // one hand-off, although the tick ran twice
    expect(e.w.ingestCalls[0]!.map((u) => [u.labels.instance, u.status, u.at])).toEqual([['a', 'firing', e.first], ['b', 'firing', e.first]])
    expect(summary(processed(e.w))).toEqual(['firing:a=firing,b=firing'])
    expect(ok(await e.ruler.health(e.tenant)).outboxDepth).toBe(0)
  })

  it('crash after the notifier accepted the hand-off but before the ruler recorded it: the redelivery applies nothing', async () => {
    const e = await env()
    e.w.evaluate = () => down('a')
    e.w.faults.add('ruler:handoff-sent')
    world.now = e.first
    expect(await alarm(e.ruler)).toBe('crashed')
    expect(e.w.ingestCalls.length).toBe(1)
    await evictDurableObject(e.ruler)
    await pump(e, e.first + 30 * SEC)
    expect(e.w.ingestCalls.length).toBe(2) // sent again...
    expect(ok(await e.notifier.health(e.tenant)).alerts).toEqual({ firing: 1, resolved: 0 }) // ...same alert
    expect(summary(processed(e.w))).toEqual(['firing:a=firing'])
    expect(e.w.received.length).toBe(1)
  })

  it('notifier unreachable for a while: transitions queue in order and arrive once it is back', async () => {
    const e = await env()
    let series = down('a')
    e.w.evaluate = () => series
    e.w.notifierDown = true
    await pump(e, e.first)
    series = down()
    await pump(e, e.first + MIN)
    series = down('a')
    await pump(e, e.first + 2 * MIN + 30 * SEC)
    expect(ok(await e.ruler.health(e.tenant)).outboxDepth).toBe(3)
    expect(e.w.received).toEqual([])
    e.w.notifierDown = false
    await pump(e, e.first + 6 * MIN)
    expect(ok(await e.ruler.health(e.tenant)).outboxDepth).toBe(0)
    // The notifier saw fire, resolve, fire in order and ends with the alert firing.
    expect(e.w.ingestCalls.flat().map((u) => u.status)).toEqual(['firing', 'resolved', 'firing'])
    expect(ok(await e.notifier.health(e.tenant)).alerts.firing).toBe(1)
    expect(summary(processed(e.w))).toEqual(['firing:a=firing'])
  })
})

describe('crashes and failures in the notifier', () => {
  it('crash inside the flush transaction: the receiver has seen nothing; the retry notifies once', async () => {
    const e = await env()
    e.w.evaluate = () => down('a')
    world.now = e.first
    expect(await alarm(e.ruler)).toBe('ok')
    e.w.faults.add('notifier:flush-commit')
    expect(await alarm(e.notifier)).toBe('crashed')
    // The decision did not commit, so nothing may have left the building.
    expect(e.w.received).toEqual([])
    expect(ok(await e.notifier.health(e.tenant))).toMatchObject({ outboxDepth: 0 })
    await evictDurableObject(e.notifier)
    await pump(e, e.first + 30 * SEC)
    expect(summary(processed(e.w))).toEqual(['firing:a=firing'])
    expect(e.w.received.length).toBe(1)
  })

  it('crash after the decision committed, before the outbox was drained: sent once after restart', async () => {
    const e = await env()
    e.w.evaluate = () => down('a')
    world.now = e.first
    expect(await alarm(e.ruler)).toBe('ok')
    e.w.faults.add('notifier:flush-committed')
    expect(await alarm(e.notifier)).toBe('crashed')
    expect(e.w.received).toEqual([])
    await evictDurableObject(e.notifier)
    expect(ok(await e.notifier.health(e.tenant))).toMatchObject({ outboxDepth: 1 })
    await pump(e, e.first + 30 * SEC)
    expect(summary(processed(e.w))).toEqual(['firing:a=firing'])
    expect(e.w.received.length).toBe(1)
  })

  it('evicted mid-drain, after the receiver processed the request but before that was recorded: the resend has the same key', async () => {
    const e = await env()
    e.w.evaluate = () => down('a')
    world.now = e.first
    expect(await alarm(e.ruler)).toBe('ok')
    e.w.faults.add('notifier:sent')
    expect(await alarm(e.notifier)).toBe('crashed')
    expect(e.w.received.length).toBe(1)
    await evictDurableObject(e.notifier)
    await pump(e, e.first + 30 * SEC)
    expect(e.w.received.length).toBe(2) // a real duplicate request...
    expect(e.w.received[1]!.key).toBe(e.w.received[0]!.key) // ...under the same key...
    expect(e.w.received[1]!.body).toEqual(e.w.received[0]!.body)
    expect(summary(processed(e.w))).toEqual(['firing:a=firing']) // ...so the receiver acts once
    expect(ok(await e.notifier.health(e.tenant))).toMatchObject({ outboxDepth: 0, deadLetters: 0 })
  })

  it('receiver answers 500 then 200: one notification processed', async () => {
    const e = await env()
    e.w.evaluate = () => down('a')
    e.w.respond = (_r, n) => (n === 0 ? 500 : 200)
    await pump(e, e.first + 30 * SEC)
    expect(e.w.received.length).toBe(2)
    expect(e.w.received[1]!.key).toBe(e.w.received[0]!.key)
    expect(summary(processed(e.w))).toEqual(['firing:a=firing'])
  })

  it('receiver times out AFTER processing: the duplicate send carries the same key, so it is processed once', async () => {
    const e = await env()
    e.w.evaluate = () => down('a')
    e.w.respond = (_r, n) => (n < 2 ? 'timeout' : 200)
    await pump(e, e.first + 30 * SEC)
    expect(e.w.received.length).toBe(3)
    expect(new Set(e.w.received.map((r) => r.key)).size).toBe(1)
    // The receiver handled all three requests; de-duplicated, that is one notification.
    expect(summary(processed(e.w, () => true))).toEqual(['firing:a=firing'])
    expect(ok(await e.notifier.outbox(e.tenant)).entries).toEqual([])
  })

  it('distinct notifications get distinct keys: fire, resolve, fire again, and a repeat', async () => {
    const tenant = newTenant('x')
    const e = await env(tenant)
    ok(await e.notifier.setConfig(tenant, {
      route: { receiver: 'hook', group_by: ['alertname'], group_wait: '0s', group_interval: '1m', repeat_interval: '10m' },
      receivers: [{ name: 'hook', webhook_configs: [{ url: 'https://receiver.test/hook' }] }],
    }))
    let series = down('a')
    e.w.evaluate = () => series
    await pump(e, e.first + 30 * SEC)
    series = down()
    await pump(e, e.first + 3 * MIN)
    series = down('a')
    await pump(e, e.first + 25 * MIN)
    const got = summary(processed(e.w))
    expect(got).toEqual(['firing:a=firing', 'resolved:a=resolved', 'firing:a=firing', 'firing:a=firing', 'firing:a=firing'])
    expect(new Set(e.w.received.map((r) => r.key)).size).toBe(5)
  })
})

describe('everything at once', () => {
  /** Deterministic PRNG (mulberry32): the chaos is reproducible from its seed. */
  const prng = (seed: number) => () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const rules = [
    { alert: 'Down', expr: 'down', for: '1m' },
    { alert: 'Slow', expr: 'slow', keep_firing_for: '2m' },
    { record: 'job:down', expr: 'down' },
  ]

  async function scenario(tenant: string, seed: number, chaos: boolean) {
    const e = await env(tenant, { groupWait: '30s', rules })
    const data = prng(seed)
    // 30 ticks of flapping series, fixed by the seed and independent of faults.
    const plan = Array.from({ length: 30 }, () => ({ down: ['a', 'b', 'c'].filter(() => data() < 0.45), slow: ['a', 'b'].filter(() => data() < 0.5) }))
    e.w.evaluate = (q, timeMs) => {
      const step = plan[Math.round((timeMs - e.first) / MIN)]
      return down(...(step ? (q === 'down' ? step.down : step.slow) : []))
    }
    const fault = prng(seed * 7919 + 1)
    const points = { ruler: ['ruler:commit', 'ruler:after-commit', 'ruler:handoff-sent'], notifier: ['notifier:flush-commit', 'notifier:flush-committed', 'notifier:sent'] }
    let injected = 0
    const handledByReceiver: boolean[] = []
    if (chaos) {
      e.w.respond = () => {
        const x = fault()
        const r = x < 0.2 ? 500 : x < 0.35 ? 'timeout' : 200
        handledByReceiver.push(r !== 500)
        return r
      }
    }
    await pump(e, e.first + 40 * MIN, async (who) => {
      if (!chaos) return
      const x = fault()
      if (x < 0.3) {
        e.w.faults.add(points[who][Math.floor(fault() * 3)]!)
        injected++
      } else if (x < 0.45) {
        await evictDurableObject(who === 'ruler' ? e.ruler : e.notifier)
      }
    })
    e.w.faults.clear()
    const done = processed(e.w, chaos ? (_r, n) => handledByReceiver[n] === true : () => true)
    const result = {
      // What the receiver acted on, as a set: (idempotency key is per tenant, so compare bodies).
      notifications: done.map((p) => JSON.stringify(p)).sort(),
      alerts: (await alertsOf(e.ruler, e.tenant)).map((a) => [a.labels.alertname, a.labels.instance, a.state, a.activeAt - e.first, a.firedAt === null ? null : a.firedAt - e.first]).sort(),
      sink: [...e.w.sinkById.keys()].length,
      requests: e.w.received.length,
      injected,
      outbox: ok(await e.notifier.health(e.tenant)).outboxDepth + ok(await e.ruler.health(e.tenant)).outboxDepth,
    }
    // Start the next scenario on this tenant from nothing.
    for (const stub of [e.ruler, e.notifier] as Stub[]) {
      await runInDurableObject(stub as DurableObjectStub<TestRuler>, async (_i, state) => {
        await state.storage.deleteAlarm()
        await state.storage.deleteAll()
      })
      await evictDurableObject(stub)
    }
    world.tenants.delete(tenant)
    return result
  }

  it('random crashes, evictions, receiver failures and timeouts change nothing about what the receiver ends up processing', async () => {
    const totals = { injected: 0, extraRequests: 0, notifications: 0 }
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const tenant = newTenant('chaos')
      const calm = await scenario(tenant, seed, false)
      const wild = await scenario(tenant, seed, true)
      expect(calm.notifications.length, `seed ${seed}`).toBeGreaterThan(5)
      expect(wild.notifications, `seed ${seed}`).toEqual(calm.notifications)
      expect(wild.alerts, `seed ${seed}`).toEqual(calm.alerts)
      expect(wild.sink).toBe(calm.sink) // recording-rule batches, de-duplicated by id
      expect(wild.outbox).toBe(0)
      totals.injected += wild.injected
      totals.extraRequests += wild.requests - calm.requests
      totals.notifications += calm.notifications.length
    }
    console.log(`chaos: ${totals.notifications} notifications over 6 seeds; ${totals.injected} injected crashes; ${totals.extraRequests} extra (duplicate or failed) requests absorbed`)
    expect(totals.injected).toBeGreaterThan(40)
    expect(totals.extraRequests).toBeGreaterThan(20)
  })
})
