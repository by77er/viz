import { createExecutionContext, createMessageBatch, getQueueResult, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FLUSH_MESSAGE_VERSION, type FlushMessage, PENDING_MARKER_PREFIX, Shard, pendingMarkerKey } from '../../shard/src/shard'
import { consumeDeadLetters, consumeFlushBatch, engine, listDeadLetters, retryDelaySeconds, shardsFromPoolMaps, sweepPending, type FlushResult } from '../src/index'
import { T0, append, breakLedgerLog, dataKeys, flushSettled, healLedgerLog, liveKeys, read, Sent, someSamples, stream } from './helpers'

/**
 * A flush that runs until the shard has been told what the ledger logged, the ledger's drain
 * (its alarm) run at once in between: what the consumer sees once the log has caught up. The
 * ledger drains only when asked in this suite (vitest.config.ts); a plain run whose units are
 * not logged yet ends `awaitingLog` and is retried (tested below on its own).
 */
const settled = (tenant: string, shard: string): Promise<FlushResult> => flushSettled(env, engine, tenant, shard)

/** Seal notifications of this file's shards, captured instead of sent (the queue is bound in stack/). */
const proto = Shard.prototype as unknown as { announce(msg: FlushMessage): Promise<void> }
const original = proto.announce
let announced: FlushMessage[] = []
beforeEach(() => {
  announced = []
  proto.announce = async (msg) => void announced.push(msg)
})
afterEach(() => {
  proto.announce = original
})

let id = 0
const batchOf = (bodies: unknown[], attempts: number[] = [], queue = 'viz-flush') =>
  createMessageBatch(queue, bodies.map((body, i) => ({ id: `m${id++}`, timestamp: Date.now(), attempts: attempts[i] ?? 1, body })))

/** Run the consumer on a batch and return what happened to each message. */
async function deliver(batch: MessageBatch<unknown>, opts: Parameters<typeof consumeFlushBatch>[3] = {}) {
  const ctx = createExecutionContext()
  // The test harness reports which messages were retried but not with what delay: record it here.
  const delays = new Map<string, number | undefined>()
  for (const m of batch.messages) {
    const retry = m.retry.bind(m)
    m.retry = (o?: QueueRetryOptions) => (delays.set(m.id, o?.delaySeconds), retry(o))
  }
  const outcomes = await consumeFlushBatch(batch, env, engine, opts)
  const result = await getQueueResult(batch, ctx)
  return { outcomes, acked: result.explicitAcks, retried: result.retryMessages.map((r) => ({ msgId: r.msgId, delaySeconds: delays.get(r.msgId) })) }
}

async function sealed(prefix: string, sent = new Sent()) {
  const s = stream(prefix)
  await append(s.shard, s.tenant, someSamples(s.tenant, T0, 24), sent)
  await s.shard.seal(s.tenant)
  return { ...s, sent, msg: { v: FLUSH_MESSAGE_VERSION, tenant: s.tenant, shard: s.shardName } }
}

describe('flush queue consumer', () => {
  it('flushes each (tenant, shard) of a batch once, however many messages name it, and acknowledges them all', async () => {
    const a = await sealed('qa')
    const b = await sealed('qb')
    expect(announced).toEqual([a.msg, b.msg])
    let runs = 0
    const batch = batchOf([a.msg, b.msg, a.msg, a.msg])
    const r = await deliver(batch, { flush: (t, s) => (runs++, settled(t, s)) })
    expect(runs).toBe(2)
    expect(r.outcomes.map((o) => [o.tenant, o.messages, o.action])).toEqual([[a.tenant, 3, 'done'], [b.tenant, 1, 'done']])
    expect(r.acked).toHaveLength(4)
    expect(r.retried).toEqual([])
    for (const x of [a, b]) {
      expect(await x.shard.pendingSegments(x.tenant)).toEqual([])
      expect((await liveKeys(x.ledger)).length).toBeGreaterThanOrEqual(2)
      expect((await read(x.tenant, [x.shardName])).canon).toEqual(x.sent.canon())
    }
  })

  it('a redelivered message after success changes nothing', async () => {
    const a = await sealed('qr')
    expect((await deliver(batchOf([a.msg]), { flush: settled })).outcomes[0]).toMatchObject({ action: 'done' })
    const keys = await dataKeys(a.tenant)
    const version = (await a.ledger.plan({ table: 'metric_samples', minTs: 0, maxTs: 1 })).version
    for (let i = 0; i < 3; i++) {
      const r = await deliver(batchOf([a.msg, a.msg], [2, 3]))
      expect(r.outcomes[0]).toMatchObject({ action: 'done' })
      expect(r.outcomes[0]!.result!.segments).toEqual([])
      expect(r.retried).toEqual([])
    }
    expect(await dataKeys(a.tenant)).toEqual(keys)
    expect((await a.ledger.plan({ table: 'metric_samples', minTs: 0, maxTs: 1 })).version).toBe(version)
  })

  it('retries ONE message of a group when the run throws, and the redelivery finishes the job', async () => {
    const a = await sealed('qx')
    const { flushTenant } = await import('../src/flush')
    const crash = { afterPut: () => { throw new Error('injected crash after PUT') } }
    const batch = batchOf([a.msg, a.msg, a.msg], [1, 3, 2])
    const first = await deliver(batch, { flush: (t, s) => flushTenant(env, engine, t, s, { hooks: crash }) })
    expect(first.outcomes[0]).toMatchObject({ action: 'again', why: 'exception: injected crash after PUT' })
    expect(first.acked).toHaveLength(2)
    // The carrier is the message with the fewest attempts, delayed by the backoff for that attempt.
    expect(first.retried).toEqual([{ msgId: batch.messages[0]!.id, delaySeconds: 5 }])
    // Nothing visible, nothing acknowledged to the shard, the segment still pending.
    expect(await liveKeys(a.ledger)).toEqual([])
    expect(await a.shard.pendingSegments(a.tenant)).toHaveLength(1)

    const second = await deliver(batchOf([a.msg], [2]), { flush: settled })
    expect(second.outcomes[0]).toMatchObject({ action: 'done' })
    expect(second.outcomes[0]!.result!.segments[0]!.files.every((f) => f.put === 'exists')).toBe(true)
    expect(await a.shard.pendingSegments(a.tenant)).toEqual([])
    expect((await read(a.tenant, [a.shardName])).canon).toEqual(a.sent.canon())
  })

  it('retries when flush stops with an error status, with a delay that grows with the attempts', async () => {
    const a = await sealed('qe')
    const failed: FlushResult = { status: 'error', reason: 'object_conflict', detail: 'injected', tenant: a.tenant, shard: a.shardName, segments: [], loggedThrough: 0, recordedThrough: 0, awaitingLog: false, remaining: 0, changed: false }
    const r = await deliver(batchOf([a.msg], [4]), { flush: async () => failed })
    expect(r.outcomes[0]).toMatchObject({ action: 'again', why: 'object_conflict' })
    expect(r.retried).toEqual([expect.objectContaining({ delaySeconds: 40 })])
    expect([1, 2, 3, 4, 7, 20].map(retryDelaySeconds)).toEqual([5, 10, 20, 40, 300, 300])
  })

  it('retries while the ledger has admitted the unit but not logged it, and is done once it has', async () => {
    // The ledger writes its log in the background: a run whose unit is not logged yet is retried.
    const q = await sealed('ql0')
    const before = await deliver(batchOf([q.msg]))
    expect(before.outcomes[0]).toMatchObject({ action: 'again', why: 'awaiting_log' })
    expect(before.acked).toEqual([])
    await q.ledger.drain()
    expect((await deliver(batchOf([q.msg], [2]))).outcomes[0]).toMatchObject({ action: 'done' })
    expect((await q.shard.describe(q.tenant))!.recordedThrough).toBe(1)
    // And while its log cannot be written at all, for as long as that lasts.
    const a = await sealed('ql')
    await breakLedgerLog(a.ledger)
    const first = await deliver(batchOf([a.msg]))
    expect(first.outcomes[0]).toMatchObject({ action: 'again', why: 'awaiting_log' })
    expect(first.retried).toHaveLength(1)
    // Visible to queries already; the shard has been told nothing, so it still holds the rows.
    expect((await liveKeys(a.ledger)).length).toBeGreaterThanOrEqual(2)
    expect((await a.shard.describe(a.tenant))!.recordedThrough).toBe(0)
    await healLedgerLog(a.ledger)
    await a.ledger.drain()
    const second = await deliver(batchOf([a.msg], [2]))
    expect(second.outcomes[0]).toMatchObject({ action: 'done' })
    expect((await a.shard.describe(a.tenant))!.recordedThrough).toBe(1)
    expect((await read(a.tenant, [a.shardName])).canon).toEqual(a.sent.canon())
  })

  it('calls onFlushed after a run that changed something, and retries the group if it throws', async () => {
    const a = await sealed('qh')
    const seen: string[] = []
    const ok = await deliver(batchOf([a.msg]), { flush: settled, onFlushed: (r) => void seen.push(`${r.tenant}:${r.segments.length}:${r.changed}`) })
    expect(ok.outcomes[0]!.action).toBe('done')
    expect(seen).toEqual([`${a.tenant}:1:true`])
    const b = await sealed('qh2')
    const bad = await deliver(batchOf([b.msg]), { onFlushed: () => { throw new Error('KV down') } })
    expect(bad.outcomes[0]).toMatchObject({ action: 'again', why: 'exception: KV down' })
    expect(bad.retried).toHaveLength(1)
  })

  it('writes a message that can never be flushed to the dead letters at once, where it can be listed', async () => {
    const a = await sealed('qd')
    const queue = `viz-flush-${a.tenant}`
    const r = await deliver(batchOf([{ tenant: '../etc', shard: 'x' }, 'garbage', a.msg, { tenant: a.tenant }], [], queue), { flush: settled })
    expect(r.acked).toHaveLength(4)
    expect(r.retried).toEqual([])
    expect(r.outcomes.map((o) => o.tenant)).toEqual([a.tenant]) // the good one was still flushed
    const letters = await listDeadLetters(env, queue)
    expect(letters.map((l) => l.body)).toEqual(expect.arrayContaining([{ tenant: '../etc', shard: 'x' }, 'garbage', { tenant: a.tenant }]))
    expect(letters).toHaveLength(3)
    expect(letters.every((l) => l.reason === 'not a {tenant, shard} message' && l.queue === queue)).toBe(true)
    // If the dead letter cannot be written the message is retried, not dropped.
    const stuck = await deliver(batchOf(['garbage'], [], queue), { deadLetter: async () => { throw new Error('R2 down') } })
    expect(stuck.acked).toEqual([])
    expect(stuck.retried).toHaveLength(1)
  })

  it('the dead-letter consumer records what the queue gave up on', async () => {
    const queue = `viz-flush-dlq-${Date.now().toString(36)}`
    const batch = batchOf([{ tenant: 't1', shard: 'p/0' }, { tenant: 't2', shard: 'p/1' }], [6, 6], queue)
    const ctx = createExecutionContext()
    expect(await consumeDeadLetters(batch, env)).toBe(2)
    const result = await getQueueResult(batch, ctx)
    expect(result.explicitAcks).toHaveLength(2)
    const letters = await listDeadLetters(env, queue)
    expect(letters.map((l) => [l.body, l.attempts, l.reason])).toEqual([
      [{ tenant: 't1', shard: 'p/0' }, 6, 'retries exhausted'],
      [{ tenant: 't2', shard: 'p/1' }, 6, 'retries exhausted'],
    ])
  })
})

describe('sweep', () => {
  /** A sweep environment that counts what it costs. */
  function counting() {
    const calls = { shard: 0, messages: [] as FlushMessage[] }
    const SHARD = new Proxy(env.SHARD, {
      get(target, prop) {
        if (prop === 'get') return (id: DurableObjectId) => (calls.shard++, target.get(id))
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    const FLUSH_QUEUE = {
      send: async (body: FlushMessage) => void calls.messages.push(body),
      sendBatch: async (list: Iterable<{ body: FlushMessage }>) => { for (const m of list) calls.messages.push(m.body) },
    } as unknown as Queue<FlushMessage>
    return { calls, env: { SHARD, CONFIG: env.CONFIG, FLUSH_QUEUE } }
  }
  const clearMarkers = async () => {
    for (const k of (await env.CONFIG.list({ prefix: PENDING_MARKER_PREFIX })).keys) await env.CONFIG.delete(k.name)
  }

  it('wakes no shard and sends nothing when no shard has a pending marker', async () => {
    await clearMarkers()
    // Shards exist and have data, but nothing sealed: they are not the sweep's business.
    const s = stream('sw0')
    await append(s.shard, s.tenant, someSamples(s.tenant, T0, 8))
    const c = counting()
    for (let i = 0; i < 3; i++) expect(await sweepPending(c.env, { olderThanMs: 0 })).toEqual({ markers: 0, shardsAsked: 0, deferred: 0, enqueued: [], failed: [], unsent: 0 })
    expect(c.calls).toEqual({ shard: 0, messages: [] })
  })

  it('re-enqueues streams whose segments have been pending long enough, and only those', async () => {
    await clearMarkers()
    const a = await sealed('sw1')
    const b = await sealed('sw2')
    // Tenant b was sealed "20 minutes ago".
    await runInDurableObject(b.shard, (_i, state) => state.storage.sql.exec(`UPDATE segment SET sealed_at = sealed_at - 1200000 WHERE tenant = ?`, b.tenant))
    const c = counting()
    const r = await sweepPending(c.env)
    expect(r).toMatchObject({ markers: 2, shardsAsked: 2 })
    expect(c.calls.messages).toEqual([b.msg])
    // With no age threshold both are due.
    expect((await sweepPending(c.env, { olderThanMs: 0 })).enqueued.sort((x, y) => (x.tenant < y.tenant ? -1 : 1))).toEqual([a.msg, b.msg].sort((x, y) => (x.tenant < y.tenant ? -1 : 1)))

    // The messages are consumed; the next sweep finds the markers, asks once, and the
    // shards clear them; after that the sweep costs nothing again.
    await deliver(batchOf([a.msg, b.msg]), { flush: settled })
    const after = counting()
    expect(await sweepPending(after.env, { olderThanMs: 0 })).toEqual({ markers: 2, shardsAsked: 2, deferred: 0, enqueued: [], failed: [], unsent: 0 })
    expect(await sweepPending(after.env, { olderThanMs: 0 })).toEqual({ markers: 0, shardsAsked: 0, deferred: 0, enqueued: [], failed: [], unsent: 0 })
    expect(after.calls).toEqual({ shard: 2, messages: [] })
  })

  it('full: finds a pending shard whose marker is missing, through the pool maps in KV', async () => {
    await clearMarkers()
    const a = await sealed('sw3')
    await env.CONFIG.delete(pendingMarkerKey(a.shardName)) // the marker was lost
    const c = counting()
    expect((await sweepPending(c.env, { olderThanMs: 0 })).enqueued).toEqual([])
    // The tenant's pool map names the shard (pool `pool-<id>`, slot 0).
    const pool = a.shardName.slice(0, a.shardName.lastIndexOf('/'))
    await env.CONFIG.put(`pool:${a.tenant}`, JSON.stringify({ pool, slots: 2, spread: 2, epoch: 1 }))
    expect(await shardsFromPoolMaps({ CONFIG: env.CONFIG, DEFAULT_POOL: JSON.stringify({ pool: 'shared/x', slots: 1, spread: 1, epoch: 1 }) })).toEqual(expect.arrayContaining([`${pool}/0`, `${pool}/1`, 'shared/x/0']))
    const full = await sweepPending(c.env, { olderThanMs: 0, full: true })
    expect(full.enqueued).toEqual([a.msg])
    expect(full.shardsAsked).toBeGreaterThanOrEqual(2)
    await env.CONFIG.delete(`pool:${a.tenant}`)
  })
})

/** A bucket that counts PUTs (and can be told to fail them). */
function countingBucket(fail = false) {
  const puts: string[] = []
  const BUCKET = new Proxy(env.BUCKET, {
    get(target, prop) {
      if (prop === 'put') return async (key: string, ...rest: unknown[]) => {
        puts.push(key)
        if (fail) throw new Error('injected: R2 down')
        return (target.put as (...a: unknown[]) => unknown)(key, ...rest)
      }
      const v = Reflect.get(target, prop)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  return { puts, env: { ...env, BUCKET } }
}

async function deliverWith(e: typeof env, batch: MessageBatch<unknown>, opts: Parameters<typeof consumeFlushBatch>[3] = {}) {
  const ctx = createExecutionContext()
  const outcomes = await consumeFlushBatch(batch, e, engine, opts)
  const result = await getQueueResult(batch, ctx)
  return { outcomes, acked: result.explicitAcks, retried: result.retryMessages.map((r) => r.msgId) }
}

// Review R-11(b): maintenance is asked for only when a flush changed something.
describe('review R-11(b): maintenance only after a flush that changed something', () => {
  it('a duplicate delivery that finds nothing does not ask for maintenance', async () => {
    const a = await sealed('r11-dup')
    const seen: FlushResult[] = []
    const first = await deliver(batchOf([a.msg]), { flush: settled, onFlushed: (r) => void seen.push(r) })
    expect(first.outcomes[0]!.action).toBe('done')
    expect(seen).toHaveLength(1)
    // The same message again (at-least-once): nothing pending, nothing written, nothing recorded.
    const again = await deliver(batchOf([a.msg]), { onFlushed: (r) => void seen.push(r) })
    expect(again.outcomes[0]!.action).toBe('done')
    expect(seen).toHaveLength(1)
  })

  it('a redelivery after the request for maintenance failed asks again, although it changes nothing', async () => {
    const a = await sealed('r11-redo')
    const bad = await deliver(batchOf([a.msg]), { flush: settled, onFlushed: () => { throw new Error('queue down') } })
    expect(bad.outcomes[0]).toMatchObject({ action: 'again', why: 'exception: queue down' })
    // The flush itself completed; the retry finds nothing to do, but it is a redelivery.
    const seen: string[] = []
    const retry = await deliver(batchOf([a.msg], [2]), { flush: settled, onFlushed: (r) => void seen.push(r.tenant) })
    expect(retry.outcomes[0]!.action).toBe('done')
    expect(retry.outcomes[0]!.result!.segments).toEqual([])
    expect(seen).toEqual([a.tenant])
  })

  it('a run that admitted something and then stopped with an error still asks for maintenance', async () => {
    const a = await sealed('r11-err')
    const stopped: FlushResult = {
      status: 'error', reason: 'object_conflict', detail: 'injected', tenant: a.tenant, shard: a.shardName,
      segments: [{ incarnation: 1, seqLo: 1, seqHi: 1, outcome: 'admitted', files: [] }], loggedThrough: 1, recordedThrough: 0, awaitingLog: false, remaining: 0, changed: true,
    } as FlushResult
    const seen: string[] = []
    const r = await deliver(batchOf([a.msg]), { flush: async () => stopped, onFlushed: (x) => void seen.push(x.tenant) })
    expect(r.outcomes[0]).toMatchObject({ action: 'again', why: 'object_conflict' })
    expect(seen).toEqual([a.tenant])
  })
})

// Review R-12 (flush part): dead letters are written as one object per invocation.
describe('review R-12: one R2 write per dead-letter batch', () => {
  it('consumeDeadLetters writes ONE object for the whole batch, and every letter can be listed', async () => {
    const queue = `viz-flush-dlq-r12-${Date.now().toString(36)}`
    const c = countingBucket()
    const batch = batchOf([1, 2, 3, 4, 5].map((i) => ({ tenant: `t${i}`, shard: 'p/0' })), [6, 6, 6, 6, 6], queue)
    const ctx = createExecutionContext()
    expect(await consumeDeadLetters(batch, c.env)).toBe(5)
    expect(c.puts).toHaveLength(1)
    expect((await getQueueResult(batch, ctx)).explicitAcks).toHaveLength(5)
    const letters = await listDeadLetters(env, queue)
    expect(letters.map((l) => [l.id, l.body, l.attempts, l.reason])).toEqual(batch.messages.map((m) => [m.id, m.body, 6, 'retries exhausted']))
  })

  it('if that one write fails, every message of the batch is retried, none acknowledged', async () => {
    const queue = `viz-flush-dlq-r12f-${Date.now().toString(36)}`
    const c = countingBucket(true)
    const batch = batchOf([{ tenant: 't1', shard: 'p/0' }, { tenant: 't2', shard: 'p/0' }], [6, 6], queue)
    const ctx = createExecutionContext()
    expect(await consumeDeadLetters(batch, c.env)).toBe(0)
    const result = await getQueueResult(batch, ctx)
    expect(result.explicitAcks).toEqual([])
    expect(result.retryMessages).toHaveLength(2)
    expect(c.puts).toHaveLength(1)
  })

  it('junk on the flush queue is dead-lettered with one write per batch', async () => {
    const queue = `viz-flush-r12j-${Date.now().toString(36)}`
    const c = countingBucket()
    const r = await deliverWith(c.env, batchOf(['garbage', { tenant: '../x', shard: 's' }, 42], [], queue))
    expect(r.acked).toHaveLength(3)
    expect(c.puts).toHaveLength(1)
    expect((await listDeadLetters(env, queue)).map((l) => l.body)).toEqual(['garbage', { tenant: '../x', shard: 's' }, 42])
  })
})

// contracts/COMPATIBILITY.md §3.2 and design/UPGRADES.md §7 item 6: a message of a version this
// release does not know is retried, never flushed on a guess, never dead-lettered.
describe('flush messages carry a version', () => {
  it('v absent or 1 is flushed; any other v is retried, even when the rest of the body looks invalid', async () => {
    const a = await sealed('ver')
    const runs: string[] = []
    const { flushTenant } = await import('../src/flush')
    const queue = `viz-flush-ver-${Date.now().toString(36)}`
    const batch = batchOf([{ ...a.msg, v: 2 }, { v: 2 }, { v: 'x', tenant: a.tenant, shard: a.shardName }], [], queue)
    const r = await deliver(batch, { flush: (t, s) => (runs.push(t), flushTenant(env, engine, t, s)) })
    expect(runs).toEqual([])
    expect(r.acked).toEqual([])
    expect(r.retried.map((x) => x.msgId).sort()).toEqual(batch.messages.map((m) => m.id).sort())
    expect(await listDeadLetters(env, queue)).toEqual([])
    expect(await a.shard.pendingSegments(a.tenant)).toHaveLength(1)
    // Version 1, spelt out or not, is flushed.
    const ok = await deliver(batchOf([{ ...a.msg, v: 1 }, a.msg], [], queue), { flush: (t, s) => (runs.push(t), settled(t, s)) })
    expect(runs).toEqual([a.tenant])
    expect(ok.acked).toHaveLength(2)
  })
})
