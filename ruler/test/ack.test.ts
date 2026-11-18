/**
 * Exactly-once notification with acknowledge and silence in play.
 *
 * Same method as exactly-once.test.ts: the receiver de-duplicates by `Idempotency-Key`,
 * and the assertions are on what it ends up having processed. The properties added here:
 *
 *   - an acknowledged alert never sends a repeat, whatever is replayed, evicted or crashed;
 *   - a crash between the acknowledgement and the next notification decision changes nothing;
 *   - un-acknowledging resumes repeats;
 *   - a silenced alert sends nothing, and undoing the silence resumes as if it never was.
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { TimelineEntry, WebhookPayload } from '../contracts-proposal/rules.v2'
import { Crash, T0, tenantWorld, world, type Received, type TenantWorld, type TestNotifier, type TestRuler } from './harness'
import { MIN, newTenant, notifierStub, ok, rulerStub, vec } from './helpers'

const SEC = 1000
const MON = 'mon_00000000000000a1'
const meta = (id: string) => ({ id, owner: '', startInvestigation: false, condition: null, createdAt: T0, createdBy: 'test', updatedAt: T0, updatedBy: 'test' })

function processed(w: TenantWorld, handled: (r: Received, n: number) => boolean = () => true) {
  const seen = new Map<string, WebhookPayload>()
  w.received.forEach((r, n) => {
    if (!handled(r, n)) return
    expect(r.key).toMatch(/^[0-9a-f]{32}$/)
    if (!seen.has(r.key as string)) seen.set(r.key as string, r.body as WebhookPayload)
    else expect(JSON.stringify(seen.get(r.key as string))).toBe(JSON.stringify(r.body))
  })
  return seen
}
const summary = (ps: Iterable<WebhookPayload>) => [...ps].map((p) => `${p.status}:${p.alerts.map((a) => `${a.labels.instance}=${a.status}`).sort().join(',')}`)

async function env(tenant = newTenant('ack'), rules: unknown[] = [{ alert: 'Down', expr: 'down', monitor: meta(MON) }], repeat = '10m') {
  world.now = T0
  const ruler = rulerStub(tenant)
  const notifier = notifierStub(tenant)
  const w = tenantWorld(tenant)
  ok(await ruler.configure(tenant, { deadman: false, heartbeatMs: 30 * MIN }))
  ok(await notifier.setConfig(tenant, {
    route: { receiver: 'hook', group_by: ['alertname'], group_wait: '0s', group_interval: '1m', repeat_interval: repeat },
    receivers: [{ name: 'hook', webhook_configs: [{ url: 'https://receiver.test/hook' }] }],
    delivery: { max_attempts: 50, base_backoff: '1s', max_backoff: '8s', timeout: '5s' },
  }))
  ok(await ruler.saveGroups(tenant, { groups: [{ name: 'g', interval: '1m', rules }] }))
  const first = ok(await ruler.health(tenant)).groups[0]!.nextEvaluationMs
  return { tenant, ruler, notifier, w, first }
}
type Env = Awaited<ReturnType<typeof env>>
type Stub = DurableObjectStub<TestRuler> | DurableObjectStub<TestNotifier>

async function alarm(stub: Stub): Promise<'ok' | 'crashed'> {
  try {
    await runInDurableObject(stub as DurableObjectStub<TestRuler>, (inst) => inst.alarm())
    return 'ok'
  } catch (e) {
    if (e instanceof Crash || /injected crash/.test(String(e))) return 'crashed'
    throw e
  }
}

/** Call the notifier from inside, so an injected crash surfaces here as a caught error, the way a failed request would. */
async function crashing(stub: DurableObjectStub<TestNotifier>, fn: (n: TestNotifier) => Promise<unknown>): Promise<'ok' | 'crashed'> {
  try {
    await runInDurableObject(stub, (inst) => fn(inst))
    return 'ok'
  } catch (e) {
    if (e instanceof Crash || /injected crash/.test(String(e))) return 'crashed'
    throw e
  }
}

/** Run each object's alarm whenever it is due, up to `until`. A crashed alarm loses memory and is retried at once. `replays` runs every alarm that many extra times. */
async function pump(e: Env, until: number, opts: { before?: (who: 'ruler' | 'notifier') => void | Promise<void>; replays?: number } = {}) {
  for (let i = 0; i < 50_000; i++) {
    const r = ok(await e.ruler.health(e.tenant)).alarmAtMs
    const n = ok(await e.notifier.health(e.tenant)).alarmAtMs
    const next = Math.min(r ?? Infinity, n ?? Infinity)
    if (next > until) break
    world.now = Math.max(world.now, next)
    const who = (r ?? Infinity) <= (n ?? Infinity) ? 'ruler' : 'notifier'
    const stub = who === 'ruler' ? e.ruler : e.notifier
    await opts.before?.(who)
    for (let attempt = 0; (await alarm(stub)) === 'crashed'; attempt++) {
      if (attempt > 20) throw new Error('alarm keeps crashing')
      await evictDurableObject(stub)
    }
    for (let k = 0; k < (opts.replays ?? 0); k++) expect(await alarm(stub)).toBe('ok')
  }
  world.now = Math.max(world.now, until)
}

const down = (...instances: string[]) => vec(...instances.map((i): [Record<string, string>, number] => [{ instance: i }, 0]))
const firingFps = async (e: Env) => ok(await e.notifier.listAlerts(e.tenant)).alerts.filter((a) => a.status === 'firing')
const log = async (e: Env, id = MON) => ok(await e.notifier.notificationLog(e.tenant, id)).entries

describe('an acknowledged alert never sends a repeat', () => {
  it('two hours of repeat ticks, every alarm replayed three times and the notifier evicted before each: one notification', async () => {
    const e = await env()
    e.w.evaluate = () => down('a')
    await pump(e, e.first + 30 * SEC)
    expect(summary(processed(e.w).values())).toEqual(['firing:a=firing'])
    const [a] = await firingFps(e)
    world.now = e.first + 2 * MIN
    expect(await e.notifier.acknowledge(e.tenant, [a!.fingerprint], 'key:dana')).toEqual({ status: 'ok', applied: [a!.fingerprint], skipped: [] })
    await pump(e, e.first + 120 * MIN, { replays: 3, before: async (who) => void (who === 'notifier' && (await evictDurableObject(e.notifier))) })
    expect(e.w.received.length).toBe(1) // not even a duplicate request
    expect((await firingFps(e))[0]).toMatchObject({ status: 'firing', acknowledged: { by: 'key:dana', at: e.first + 2 * MIN } }) // acknowledged, not hidden
    // Without the acknowledgement the same two hours send a repeat every ten minutes.
    const control = await env()
    control.w.evaluate = () => down('a')
    await pump(control, control.first + 120 * MIN, { replays: 3 })
    expect(processed(control.w).size).toBe(13) // minute 0, 10, ..., 120
  })

  it('un-acknowledge resumes: the overdue repeat is sent once, then repeats continue on schedule', async () => {
    const e = await env()
    e.w.evaluate = () => down('a')
    await pump(e, e.first + 30 * SEC)
    const fp = (await firingFps(e))[0]!.fingerprint
    ok(await e.notifier.acknowledge(e.tenant, [fp], 'key:dana'))
    await pump(e, e.first + 47 * MIN, { replays: 2 })
    expect(e.w.received.length).toBe(1)
    world.now = e.first + 47 * MIN + 20 * SEC
    ok(await e.notifier.unacknowledge(e.tenant, [fp], 'key:sam'))
    await pump(e, e.first + 48 * MIN + 30 * SEC, { replays: 2 })
    expect(summary(processed(e.w).values())).toEqual(['firing:a=firing', 'firing:a=firing'])
    expect(e.w.received.length).toBe(2)
    expect(e.w.received[1]!.at).toBe(e.first + 47 * MIN + 20 * SEC) // at once: the repeat had been due since minute 10
    await pump(e, e.first + 70 * MIN)
    expect(processed(e.w).size).toBe(4) // minute 47, 57, 67: back on the ten-minute schedule
    expect((await log(e)).map((x) => (x.kind === 'notified' ? `notified${x.repeat ? ':repeat' : ''}` : `${x.kind}:${'by' in x ? x.by : ''}`))).toEqual(
      ['notified', 'acknowledged:key:dana', 'unacknowledged:key:sam', 'notified:repeat', 'notified:repeat', 'notified:repeat'])
  })

  it('the acknowledgement ends when the alert resolves: the resolve is sent, and a new firing of the same alert notifies and repeats again', async () => {
    const e = await env()
    let series = down('a')
    e.w.evaluate = () => series
    await pump(e, e.first + 30 * SEC)
    ok(await e.notifier.acknowledge(e.tenant, [(await firingFps(e))[0]!.fingerprint], 'key:dana'))
    await pump(e, e.first + 25 * MIN)
    series = down()
    await pump(e, e.first + 28 * MIN)
    series = down('a')
    await pump(e, e.first + 52 * MIN)
    expect(summary(processed(e.w).values())).toEqual(['firing:a=firing', 'resolved:a=resolved', 'firing:a=firing', 'firing:a=firing', 'firing:a=firing'])
    expect((await firingFps(e))[0]!.acknowledged).toBeNull()
  })

  it('in a group of two, the acknowledged alert is left out of repeats; a change in the group still notifies and still lists it', async () => {
    const e = await env()
    let series = down('a', 'b')
    e.w.evaluate = () => series
    await pump(e, e.first + 30 * SEC)
    const a = (await firingFps(e)).find((x) => x.labels.instance === 'a')!
    ok(await e.notifier.acknowledge(e.tenant, [a.fingerprint], 'key:dana'))
    await pump(e, e.first + 25 * MIN)
    // Repeats went out for b alone.
    expect(summary(processed(e.w).values())).toEqual(['firing:a=firing,b=firing', 'firing:b=firing', 'firing:b=firing'])
    series = down('a', 'b', 'c') // a new alert joins: that is a change, not a repeat
    await pump(e, e.first + 27 * MIN)
    expect(summary(processed(e.w).values()).at(-1)).toBe('firing:a=firing,b=firing,c=firing')
    for (const entry of await log(e)) if (entry.kind === 'notified' && entry.repeat) expect(entry.fingerprints).not.toContain(a.fingerprint)
  })
})

describe('a crash between the acknowledgement and the next notification decision', () => {
  it('the acknowledgement is one committed row: evicting the notifier right after it changes nothing', async () => {
    const e = await env()
    e.w.evaluate = () => down('a')
    await pump(e, e.first + 9 * MIN + 30 * SEC) // the repeat is 30 seconds away
    const fp = (await firingFps(e))[0]!.fingerprint
    ok(await e.notifier.acknowledge(e.tenant, [fp], 'key:dana'))
    await evictDurableObject(e.notifier) // the crash
    e.w.faults.add('notifier:flush-commit') // ...and the first decision after it crashes too
    await pump(e, e.first + 60 * MIN, { replays: 2 })
    expect(e.w.received.length).toBe(1)
    expect((await firingFps(e))[0]!.acknowledged).toEqual({ by: 'key:dana', at: e.first + 9 * MIN + 30 * SEC })
  })

  it('a crash inside the acknowledgement: the caller gets an error, nothing is recorded, the repeat is sent once; the retried acknowledgement then holds', async () => {
    const e = await env()
    e.w.evaluate = () => down('a')
    await pump(e, e.first + 9 * MIN + 30 * SEC)
    const fp = (await firingFps(e))[0]!.fingerprint
    e.w.faults.add('notifier:ack-commit')
    expect(await crashing(e.notifier, (n) => n.acknowledge(e.tenant, [fp], 'key:dana'))).toBe('crashed')
    await evictDurableObject(e.notifier)
    expect((await firingFps(e))[0]!.acknowledged).toBeNull() // not half-done: no acknowledgement, no history entry
    expect((await log(e)).map((x) => x.kind)).toEqual(['notified'])
    await pump(e, e.first + 11 * MIN, { replays: 2 })
    expect(processed(e.w).size).toBe(2) // the repeat at minute 10, exactly once
    ok(await e.notifier.acknowledge(e.tenant, [fp], 'key:dana'))
    await pump(e, e.first + 90 * MIN, { replays: 1 })
    expect(processed(e.w).size).toBe(2)
    expect(e.w.received.length).toBe(2)
  })

  it('a late alarm: the repeat tick has passed but its alarm has not run when the acknowledgement arrives; no repeat is sent', async () => {
    const e = await env()
    e.w.evaluate = () => down('a')
    await pump(e, e.first + 9 * MIN + 30 * SEC)
    const fp = (await firingFps(e))[0]!.fingerprint
    // The platform is slow: minute 10 comes and goes without the notifier's alarm running.
    world.now = e.first + 10 * MIN + 40 * SEC
    ok(await e.notifier.acknowledge(e.tenant, [fp], 'key:dana'))
    await pump(e, e.first + 40 * MIN, { replays: 2 })
    expect(e.w.received.length).toBe(1)
  })

  it('a repeat that was already decided and is stuck in the outbox when the acknowledgement arrives is delivered once; nothing follows it', async () => {
    const e = await env()
    e.w.evaluate = () => down('a')
    await pump(e, e.first + 9 * MIN)
    let failing = true
    e.w.respond = () => (failing ? 500 : 200)
    await pump(e, e.first + 10 * MIN + 20 * SEC) // the repeat is decided at minute 10 and keeps failing
    expect(ok(await e.notifier.health(e.tenant)).outboxDepth).toBe(1)
    ok(await e.notifier.acknowledge(e.tenant, [(await firingFps(e))[0]!.fingerprint], 'key:dana'))
    failing = false
    await pump(e, e.first + 60 * MIN)
    const done = processed(e.w, (_r, n) => n === 0 || e.w.received[n]!.at > e.first + 10 * MIN + 20 * SEC)
    expect(done.size).toBe(2)
    expect(new Set(e.w.received.map((r) => r.key)).size).toBe(2)
    const entries = await log(e)
    expect(entries.map((x) => x.kind)).toEqual(['notified', 'notified', 'acknowledged'])
    expect(entries[1]).toMatchObject({ repeat: true, deliveredAt: expect.any(Number), failed: null })
    expect((entries[1] as Extract<TimelineEntry, { kind: 'notified' }>).deliveredAt).toBeGreaterThan((entries[2] as { at: number }).at) // delivered after the ack, decided before it
  })
})

describe('silence from an alert, with undo', () => {
  it('a silenced alert sends no repeat and no resolve; replays and evictions do not change that', async () => {
    const e = await env()
    let series = down('a')
    e.w.evaluate = () => series
    await pump(e, e.first + 30 * SEC)
    const fp = (await firingFps(e))[0]!.fingerprint
    const s = await e.notifier.silenceAlerts(e.tenant, [fp], 60 * MIN, 'key:dana', 'known issue')
    expect(s).toMatchObject({ status: 'ok', applied: [fp], skipped: [] })
    await pump(e, e.first + 35 * MIN, { replays: 2, before: async (who) => void (who === 'notifier' && (await evictDurableObject(e.notifier))) })
    series = down()
    await pump(e, e.first + 40 * MIN, { replays: 2 })
    expect(e.w.received.length).toBe(1)
  })

  it('undo inside the window removes the silence entirely: the alert that fired under it notifies once, and repeats run', async () => {
    const e = await env(undefined, [{ alert: 'Down', expr: 'down', for: '2m', monitor: meta(MON) }])
    e.w.evaluate = () => down('a')
    await pump(e, e.first + 2 * MIN + 30 * SEC) // firing since minute 2, notified
    expect(e.w.received.length).toBe(1)
    const fp = (await firingFps(e))[0]!.fingerprint
    world.now = e.first + 9 * MIN + 50 * SEC
    const s = await e.notifier.silenceAlerts(e.tenant, [fp], 60 * MIN, 'key:dana', 'oops')
    if (s.status !== 'ok') throw new Error('silence failed')
    await pump(e, e.first + 12 * MIN + 10 * SEC, { replays: 2 }) // the repeat due at minute 12 is muted
    expect(e.w.received.length).toBe(1)
    // Past the window: the token no longer works, and nothing was changed by trying.
    expect(await e.notifier.undoSilence(e.tenant, s.undoToken, 'key:dana')).toEqual({ status: 'expired', undoUntil: s.undoUntil })
    expect(ok(await e.notifier.listSilences(e.tenant)).silences.map((x) => x.state)).toEqual(['active'])
    ok(await e.notifier.expireSilence(e.tenant, s.silences[0]!.id, 'key:dana'))
    // A second silence, undone in time.
    world.now = e.first + 12 * MIN + 20 * SEC
    const s2 = await e.notifier.silenceAlerts(e.tenant, [fp], 60 * MIN, 'key:dana', 'wrong alert')
    if (s2.status !== 'ok') throw new Error('silence failed')
    world.now += 30 * SEC
    expect(await e.notifier.undoSilence(e.tenant, s2.undoToken, 'key:dana', true)).toEqual({ status: 'ok', removed: [s2.silences[0]!.id] }) // dry run
    expect(ok(await e.notifier.listSilences(e.tenant)).silences.filter((x) => x.state === 'active').length).toBe(1)
    expect(await e.notifier.undoSilence(e.tenant, s2.undoToken, 'key:dana')).toEqual({ status: 'ok', removed: [s2.silences[0]!.id] })
    expect(ok(await e.notifier.listSilences(e.tenant)).silences.map((x) => x.id)).toEqual([s.silences[0]!.id]) // gone, not merely ended
    expect(await e.notifier.undoSilence(e.tenant, s2.undoToken, 'key:dana')).toEqual({ status: 'not_found' })
    await pump(e, e.first + 26 * MIN, { replays: 2 })
    // The muted repeat goes out once the first silence is ended, then the ten-minute rhythm resumes.
    expect(processed(e.w).size).toBeGreaterThanOrEqual(3)
    expect(new Set(e.w.received.map((r) => r.key)).size).toBe(e.w.received.length) // one request per notification
    expect((await log(e)).map((x) => x.kind).filter((k) => k !== 'notified')).toEqual(['silenced', 'silence_expired', 'silenced', 'silence_undone'])
  })

  it('the silence matches exactly the alert it was made from, not its neighbours', async () => {
    const e = await env()
    e.w.evaluate = () => down('a', 'b')
    await pump(e, e.first + 30 * SEC)
    const a = (await firingFps(e)).find((x) => x.labels.instance === 'a')!
    const s = await e.notifier.silenceAlerts(e.tenant, [a.fingerprint, 'ffffffffffffffff'], 60 * MIN, 'key:dana', 'only a')
    expect(s).toMatchObject({ status: 'ok', applied: [a.fingerprint], skipped: ['ffffffffffffffff'] })
    const alerts = await firingFps(e)
    expect(alerts.map((x) => [x.labels.instance, x.silencedBy.length, x.silencedUntil !== null]).sort()).toEqual([['a', 1, true], ['b', 0, false]])
    await pump(e, e.first + 11 * MIN)
    expect(summary(processed(e.w).values())).toEqual(['firing:a=firing,b=firing', 'firing:b=firing'])
  })
})

describe('everything at once, with people acting on the alerts', () => {
  const prng = (seed: number) => () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const rules = [
    { alert: 'Down', expr: 'down', for: '1m', monitor: meta('mon_00000000000000d1') },
    { alert: 'Slow', expr: 'slow', keep_firing_for: '2m', monitor: meta('mon_00000000000000d2') },
  ]
  const STEPS = 45

  async function scenario(tenant: string, seed: number, chaos: boolean) {
    const e = await env(tenant, rules, '5m')
    const data = prng(seed)
    const present = { down: new Set<string>(), slow: new Set<string>() }
    const plan = Array.from({ length: STEPS }, () => {
      for (const i of ['a', 'b', 'c']) if (data() < 0.2) present.down.has(i) ? present.down.delete(i) : present.down.add(i)
      for (const i of ['a', 'b']) if (data() < 0.15) present.slow.has(i) ? present.slow.delete(i) : present.slow.add(i)
      return { down: [...present.down], slow: [...present.slow] }
    })
    e.w.evaluate = (q, timeMs) => {
      const step = plan[Math.round((timeMs - e.first) / MIN)]
      return down(...(step ? (q === 'down' ? step.down : step.slow) : []))
    }
    const act = prng(seed * 31 + 7)
    const fault = prng(seed * 7919 + 1)
    const points = { ruler: ['ruler:commit', 'ruler:after-commit', 'ruler:handoff-sent'], notifier: ['notifier:flush-commit', 'notifier:flush-committed', 'notifier:sent'] }
    const counts = { injected: 0, acks: 0, unacks: 0, silences: 0, undos: 0, ackCrashes: 0 }
    const handledByReceiver: boolean[] = []
    if (chaos) {
      e.w.respond = () => {
        const x = fault()
        const r = x < 0.2 ? 500 : x < 0.35 ? 'timeout' : 200
        handledByReceiver.push(r !== 500)
        return r
      }
    }
    /** The test's own record: at each step, which alerts were acknowledged after that step's actions. */
    const ackedAfter: Set<string>[] = []
    let lastUndo: string | null = null
    for (let k = 0; k < STEPS; k++) {
      await pump(e, e.first + k * MIN + 20 * SEC, {
        before: async (who) => {
          if (!chaos) return
          const x = fault()
          if (x < 0.3) {
            e.w.faults.add(points[who][Math.floor(fault() * 3)]!)
            counts.injected++
          } else if (x < 0.45) await evictDurableObject(who === 'ruler' ? e.ruler : e.notifier)
        },
      })
      // People act, 20 seconds after each tick. The choices depend on the seed and on the
      // alert state, which is the same with and without faults.
      const firing = (await firingFps(e)).sort((x, y) => (x.fingerprint < y.fingerprint ? -1 : 1))
      const x = act()
      const pick = firing[Math.floor(act() * firing.length)]
      if (pick && x < 0.3) {
        const on = !pick.acknowledged
        if (chaos && fault() < 0.4) {
          // The acknowledgement itself crashes; the caller retries, as a client would.
          e.w.faults.add('notifier:ack-commit')
          counts.ackCrashes++
          expect(await crashing(e.notifier, (n) => (on ? n.acknowledge(e.tenant, [pick.fingerprint], 'key:p') : n.unacknowledge(e.tenant, [pick.fingerprint], 'key:p')))).toBe('crashed')
          await evictDurableObject(e.notifier)
        }
        ok(on ? await e.notifier.acknowledge(e.tenant, [pick.fingerprint], 'key:p') : await e.notifier.unacknowledge(e.tenant, [pick.fingerprint], 'key:p'))
        on ? counts.acks++ : counts.unacks++
      } else if (pick && x < 0.42) {
        const s = await e.notifier.silenceAlerts(e.tenant, [pick.fingerprint], 4 * MIN, 'key:p', 'fuzz')
        if (s.status === 'ok' && s.undoToken !== '') {
          lastUndo = s.undoToken
          counts.silences++
          if (act() < 0.5) {
            world.now += 10 * SEC
            expect(await e.notifier.undoSilence(e.tenant, lastUndo, 'key:p')).toMatchObject({ status: 'ok' })
            counts.undos++
          }
        }
      }
      if (chaos && fault() < 0.3) await evictDurableObject(e.notifier)
      ackedAfter.push(new Set((await firingFps(e)).filter((a) => a.acknowledged).map((a) => a.fingerprint)))
    }
    await pump(e, e.first + (STEPS + 10) * MIN)
    e.w.faults.clear()
    const done = processed(e.w, chaos ? (_r, n) => handledByReceiver[n] === true : () => true)

    // The invariant, checked against the test's own record of who was acknowledged when:
    // no repeat lists an alert that was acknowledged at the time it was decided.
    const entries = [...(await log(e, 'mon_00000000000000d1')), ...(await log(e, 'mon_00000000000000d2'))]
    let repeats = 0
    for (const entry of entries) {
      if (entry.kind !== 'notified' || !entry.repeat) continue
      repeats++
      expect(done.has(entry.idempotencyKey), 'a logged repeat is one the receiver processed').toBe(true)
      const step = Math.floor((entry.at - e.first - 20 * SEC) / MIN)
      const acked = ackedAfter[Math.min(Math.max(step, 0), STEPS - 1)]!
      for (const fp of entry.fingerprints) expect(acked.has(fp), `repeat at step ${step} for acknowledged ${fp}`).toBe(false)
    }
    // Every notification the receiver processed is in the history, delivered.
    const logged = new Map(entries.flatMap((x) => (x.kind === 'notified' ? [[x.idempotencyKey, x] as const] : [])))
    for (const key of done.keys()) expect(logged.get(key)?.deliveredAt, key).toEqual(expect.any(Number))

    const result = {
      notifications: [...done.values()].map((p) => JSON.stringify(p)).sort(),
      history: entries.map((x) => (x.kind === 'notified' ? `${x.at - e.first}:notified:${x.status}:${x.repeat}:${x.fingerprints.join(',')}` : `${x.kind}:${'fingerprints' in x ? x.fingerprints.join(',') : ''}`)),
      requests: e.w.received.length,
      repeats,
      counts,
      outbox: ok(await e.notifier.health(e.tenant)).outboxDepth + ok(await e.ruler.health(e.tenant)).outboxDepth,
    }
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

  it('acknowledge, un-acknowledge, silence and undo at random, under crashes, evictions and receiver failures: the receiver processes exactly what it would have without faults, and no repeat ever names an acknowledged alert', async () => {
    const totals = { notifications: 0, repeats: 0, injected: 0, acks: 0, unacks: 0, silences: 0, undos: 0, ackCrashes: 0, extra: 0 }
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const tenant = newTenant('ackchaos')
      const calm = await scenario(tenant, seed, false)
      const wild = await scenario(tenant, seed, true)
      expect(calm.notifications.length, `seed ${seed}`).toBeGreaterThan(8)
      expect(wild.notifications, `seed ${seed}`).toEqual(calm.notifications)
      expect(wild.history, `seed ${seed}`).toEqual(calm.history)
      expect(wild.counts.acks).toBe(calm.counts.acks)
      expect(wild.outbox).toBe(0)
      totals.notifications += calm.notifications.length
      totals.repeats += calm.repeats
      totals.injected += wild.counts.injected
      totals.ackCrashes += wild.counts.ackCrashes
      totals.extra += wild.requests - calm.requests
      for (const k of ['acks', 'unacks', 'silences', 'undos'] as const) totals[k] += calm.counts[k]
    }
    console.log(`ack chaos: ${JSON.stringify(totals)}`)
    expect(totals.acks).toBeGreaterThan(15)
    expect(totals.silences).toBeGreaterThan(5)
    expect(totals.repeats).toBeGreaterThan(10)
    expect(totals.injected).toBeGreaterThan(60)
  })
})
