import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dataKeys, liveKeys } from '../../flush/test/helpers'
import { listDeadLetters } from '../../flush/src/index'
import { PENDING_MARKER_PREFIX, pendingMarkerKey } from '../../shard/src/shard'
import worker, { FLUSH_QUEUE_NAME, MAINT_MARKER_PREFIX, MAINT_QUEUE_NAME, type StackEnv, consumeMaintBatch, engine, enqueueDue, handleQueue, handleScheduled, maintMarkerKey, maintainTenant, noteFlushed } from '../src/index'
import { DAY_MS, type Sim, type SimTenant, checkTenant, createSim, deliver, ingest, ledger, rng, shard, take } from './sim'

let sim: Sim
const r = rng(7)
const sleep = (ms: number) => new Promise((x) => setTimeout(x, ms))
const clearKv = async (prefix: string) => {
  for (const k of (await env.CONFIG.list({ prefix })).keys) await env.CONFIG.delete(k.name)
}
beforeAll(async () => {
  sim = await createSim(3, 12)
  for (const s of sim.shards) await shard(s).configure({ sealBytes: 1 << 20, sealAgeMs: 3_600_000, retainRecordedMs: 0, fingerprintTtlMs: 0, seriesPersistMs: 0 })
})
afterAll(() => sim.restore())

/** Deliver everything on the simulated flush queue through the stack's own queue handler. */
async function drainFlushQueue(): Promise<number> {
  let n = 0
  while (sim.flushQueue.length > 0) {
    const batch = take(sim.flushQueue, 10)
    n += batch.length
    await deliver(sim, sim.flushQueue, FLUSH_QUEUE_NAME, batch, 8, (b) => handleQueue(b, sim.env))
  }
  return n
}
const markerOf = async (t: SimTenant) => (await env.CONFIG.getWithMetadata<{ due: number; orphansAt: number }>(maintMarkerKey(t.name))).metadata

/** `env` whose Durable Object namespaces and queues count every use. */
function counting(base: StackEnv) {
  const calls = { shard: 0, ledger: 0, flushMessages: 0, maintMessages: 0 }
  const ns = <T extends object>(target: T, key: 'shard' | 'ledger'): T =>
    new Proxy(target, {
      get(t, prop) {
        const v = Reflect.get(t, prop)
        if (prop === 'get') return (...args: unknown[]) => (calls[key]++, (v as (...a: unknown[]) => unknown).apply(t, args))
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
  const queue = (key: 'flushMessages' | 'maintMessages') => ({ send: async () => void calls[key]++, sendBatch: async (list: unknown[]) => void (calls[key] += [...list].length) }) as unknown as Queue<never>
  return { calls, env: { ...base, SHARD: ns(base.SHARD, 'shard'), LEDGER: ns(base.LEDGER, 'ledger'), FLUSH_QUEUE: queue('flushMessages'), MAINT_QUEUE: queue('maintMessages') } as StackEnv }
}

describe('what happens without anyone calling it', () => {
  it('a seal leads to a flush, a flush to a maintenance run, and the run leaves a marker that says when to look again', async () => {
    const [a] = sim.tenants
    for (let i = 0; i < 5; i++) {
      expect(await ingest(sim, a!, r, 6, 3, 0)).toBe(204)
      for (const s of sim.shards) await shard(s).seal(a!.name)
    }
    // The seals put messages on the flush queue; the stack's queue handler consumes them.
    expect(sim.flushQueue.length).toBeGreaterThanOrEqual(5)
    expect(sim.flushQueue.every((m) => m.body.tenant === a!.name && sim.shards.includes(m.body.shard))).toBe(true)
    await drainFlushQueue()
    for (const s of sim.shards) expect(await shard(s).pendingSegments(a!.name)).toEqual([])
    const before = await checkTenant(sim, a!, 0, 'after flush')
    expect(before.live.length).toBeGreaterThanOrEqual(10)
    // Each successful flush run asked for maintenance and made sure the marker exists.
    expect(sim.maintQueue.length).toBeGreaterThanOrEqual(2)
    expect(sim.maintQueue.every((m) => m.body.tenant === a!.name)).toBe(true)
    expect((await markerOf(a!))!.due).toBeLessThanOrEqual(Date.now())

    // The maintenance queue delivers (several messages for one tenant are one run).
    const batch = take(sim.maintQueue, 10)
    const d = await deliver(sim, sim.maintQueue, MAINT_QUEUE_NAME, batch, 5, (b) => consumeMaintBatch(b, sim.env, engine, { compaction: { maxL0AgeMs: 0, minL0Files: 2 }, deleteGraceMs: 3_600_000 }))
    expect(d.outcomes).toHaveLength(1)
    expect(d.acked).toBe(batch.length)
    const report = d.outcomes[0]!.report!
    expect(report.compaction.merged).toBeGreaterThanOrEqual(1)
    expect(report.purged).toMatchObject({ deleted: [] })
    expect(report.purged.waiting).toBeGreaterThan(0) // the merged inputs wait for their grace
    const after = await checkTenant(sim, a!, 3_600_000, 'after maintenance')
    expect(after.canon).toEqual(before.canon)
    expect(after.live.length).toBeLessThan(before.live.length)
    // The marker now says when time alone makes work: not now, and no later than the grace or midnight.
    const m = (await markerOf(a!))!
    expect(m.due).toBe(report.nextDueAt)
    expect(m.due).toBeGreaterThan(Date.now())
    expect(m.due).toBeLessThanOrEqual(Date.now() + 3_600_000)
    expect((await enqueueDue(sim.env)).enqueued).not.toContain(a!.name)
    expect((await enqueueDue(sim.env, m.due)).enqueued).toContain(a!.name)
    sim.maintQueue.length = 0
  })

  it('a maintenance run that fails is retried by one message; one that stops at its step limit sends a follow-up; junk is dead-lettered', async () => {
    const [, b] = sim.tenants
    const messages = [{ tenant: b!.name }, { tenant: b!.name }, { nope: 1 }]
    const batch = createMessageBatch(MAINT_QUEUE_NAME, messages.map((body, i) => ({ id: `x${i}`, timestamp: Date.now(), attempts: i + 1, body })))
    const ctx = createExecutionContext()
    const dead: string[] = []
    const out = await consumeMaintBatch(batch, sim.env, engine, { run: async () => { throw new Error('ledger unreachable') }, deadLetter: async (_m, reason) => void dead.push(reason) })
    const result = await getQueueResult(batch, ctx)
    expect(out).toEqual([{ tenant: b!.name, action: 'again', why: 'ledger unreachable' }])
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(['x0'])
    expect(result.explicitAcks.sort()).toEqual(['x1', 'x2'])
    expect(dead).toEqual(['not a {tenant} message'])

    sim.maintQueue.length = 0
    const more = await consumeMaintBatch(createMessageBatch(MAINT_QUEUE_NAME, [{ id: 'y', timestamp: Date.now(), attempts: 1, body: { tenant: b!.name } }]), sim.env, engine, {
      run: async (e, eng, tenant, o) => ({ ...(await maintainTenant(e, eng, tenant, o)), more: true }),
    })
    expect(more[0]!.action).toBe('done')
    expect(sim.maintQueue.map((m) => m.body)).toEqual([{ tenant: b!.name }])
    sim.maintQueue.length = 0
  })

  it('the stack handler records dead letters of both queues where they can be listed', async () => {
    const queue = `viz-flush-dlq`
    const id = `dead-${Date.now()}`
    const batch = createMessageBatch(queue, [{ id, timestamp: Date.now(), attempts: 9, body: { tenant: 'gone', shard: 'p/0' } }])
    const ctx = createExecutionContext()
    await handleQueue(batch, sim.env)
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual([id])
    expect((await listDeadLetters(env, queue)).map((l) => [l.id, l.attempts, l.reason])).toContainEqual([id, 9, 'retries exhausted'])
  })

  it('a tenant whose data has all expired and been deleted loses its marker: nothing is ever due for it again', async () => {
    const [, , c] = sim.tenants
    await env.CONFIG.put(`retention:${c!.name}`, JSON.stringify({ metric_samples_days: 1 }))
    expect(await ingest(sim, c!, r, 6, 3, 3)).toBe(204) // three days old
    for (const s of sim.shards) await shard(s).seal(c!.name)
    await drainFlushQueue()
    expect((await liveKeys(ledger(c!))).length).toBeGreaterThan(0)
    sim.maintQueue.length = 0
    // Retention removes the files; they wait for their grace; the marker stays.
    const first = await maintainTenant(sim.env, engine, c!.name, { deleteGraceMs: 2000, orphanEveryMs: 0, orphanGraceMs: 0, maxCompactStepMs: 0 })
    expect(first.expired.removed.length).toBeGreaterThan(0)
    expect(await liveKeys(ledger(c!))).toEqual([])
    expect(first.nextDueAt).not.toBeNull()
    await sleep(2100)
    const second = await maintainTenant(sim.env, engine, c!.name, { deleteGraceMs: 2000, orphanEveryMs: 0, orphanGraceMs: 0, maxCompactStepMs: 0 })
    expect(second.purged.deleted.sort()).toEqual(first.expired.removed.sort())
    expect(await dataKeys(c!.name)).toEqual([])
    expect(second.nextDueAt).toBeNull()
    expect(await env.CONFIG.get(maintMarkerKey(c!.name))).toBeNull()
    expect((await enqueueDue(sim.env, Date.now() + 365 * DAY_MS)).enqueued).not.toContain(c!.name)
    c!.model.expire('9999-01-01')
    await checkTenant(sim, c!, 0, 'after everything expired')
  })
})

describe('an idle deployment', () => {
  it('makes zero Durable Object wakes and sends zero queue messages, cron after cron', async () => {
    // Work: every tenant ingests, the shards seal, the queues are consumed to the end.
    for (const t of sim.tenants) {
      expect(await ingest(sim, t, r, 5, 2, 0)).toBe(204)
      for (const s of sim.shards) await shard(s).seal(t.name)
    }
    await drainFlushQueue()
    while (sim.maintQueue.length > 0) {
      await deliver(sim, sim.maintQueue, MAINT_QUEUE_NAME, take(sim.maintQueue, 10), 5, (b) => handleQueue(b, sim.env))
    }
    // Housekeeping alarms run until none is left: discard, fingerprints, series windows; the ledgers' drain.
    for (const s of sim.shards) {
      for (let i = 0; i < 5 && (await runInDurableObject(shard(s), (_i, st) => st.storage.getAlarm())) !== null; i++) await runDurableObjectAlarm(shard(s))
    }
    for (const t of sim.tenants) await ledger(t).drain()
    // Markers left by other tests' shards in this file's KV are not this deployment's.
    for (const k of (await env.CONFIG.list({ prefix: PENDING_MARKER_PREFIX })).keys) {
      if (!sim.shards.some((s) => pendingMarkerKey(s) === k.name)) await env.CONFIG.delete(k.name)
    }
    for (const k of (await env.CONFIG.list({ prefix: MAINT_MARKER_PREFIX })).keys) {
      if (!sim.tenants.some((t) => maintMarkerKey(t.name) === k.name)) await env.CONFIG.delete(k.name)
    }

    // The first cron after the work finds the shards' pending markers, asks each shard once
    // (nothing is pending), and the shards remove their markers.
    const first = counting(sim.env)
    const swept = await handleScheduled(first.env)
    expect(swept.flush).toEqual({ markers: 2, shardsAsked: 2, enqueued: [] })
    expect(first.calls).toEqual({ shard: 2, ledger: 0, flushMessages: 0, maintMessages: 0 })

    // From here the deployment is idle: tenants have data (so they have maintenance markers,
    // none of them due), no shard has anything pending, no object has an alarm.
    const announced = sim.flushQueue.length
    const idle = counting(sim.env)
    for (let i = 0; i < 5; i++) {
      const x = await handleScheduled(idle.env)
      expect(x.flush).toEqual({ markers: 0, shardsAsked: 0, enqueued: [] })
      expect(x.maintenance.enqueued).toEqual([])
      expect(x.maintenance.markers).toBeGreaterThanOrEqual(2)
    }
    expect(idle.calls).toEqual({ shard: 0, ledger: 0, flushMessages: 0, maintMessages: 0 })
    expect(sim.flushQueue.length).toBe(announced)
    expect(sim.maintQueue).toEqual([])
    // No timer is pending in any object: nothing will wake by itself either.
    for (const s of sim.shards) expect(await runInDurableObject(shard(s), (_i, st) => st.storage.getAlarm())).toBeNull()
    for (const t of sim.tenants) expect(await runInDurableObject(ledger(t), (_i, st) => st.storage.getAlarm())).toBeNull()
    expect((await env.CONFIG.list({ prefix: PENDING_MARKER_PREFIX })).keys).toEqual([])
    // And the data is all still there.
    for (const t of sim.tenants) await checkTenant(sim, t, 0, 'idle')
  })

  it('the script exports the handlers the bindings need: fetch, queue and scheduled', async () => {
    expect(typeof worker.fetch).toBe('function')
    expect(typeof worker.queue).toBe('function')
    const ctx = createExecutionContext()
    await worker.scheduled(createScheduledController({ cron: '7 * * * *' }), counting(sim.env).env, ctx)
    await waitOnExecutionContext(ctx)
  })

  it('noteFlushed still asks for a run when the marker cannot be written', async () => {
    const [a] = sim.tenants
    await clearKv(maintMarkerKey(a!.name))
    sim.maintQueue.length = 0
    const broken = { ...sim.env, CONFIG: new Proxy(env.CONFIG, { get: (t, p) => (p === 'put' ? async () => { throw new Error('KV 429') } : Reflect.get(t, p).bind(t)) }) } as StackEnv
    await noteFlushed(broken, { tenant: a!.name })
    expect(sim.maintQueue.map((m) => m.body)).toEqual([{ tenant: a!.name }])
    // The run that message causes writes the marker itself.
    await maintainTenant(sim.env, engine, a!.name)
    expect(await markerOf(a!)).not.toBeNull()
  })
})
