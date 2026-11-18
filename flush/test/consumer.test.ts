import { createExecutionContext, createMessageBatch, getQueueResult, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type FlushMessage, PENDING_MARKER_PREFIX, Shard, pendingMarkerKey } from '../../shard/src/shard'
import { consumeDeadLetters, consumeFlushBatch, engine, listDeadLetters, retryDelaySeconds, shardsFromPoolMaps, sweepPending, type FlushResult } from '../src/index'
import { T0, append, breakLedgerLog, dataKeys, healLedgerLog, liveKeys, read, Sent, someSamples, stream } from './helpers'

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
  return { ...s, sent, msg: { tenant: s.tenant, shard: s.shardName } }
}

describe('flush queue consumer', () => {
  it('flushes each (tenant, shard) of a batch once, however many messages name it, and acknowledges them all', async () => {
    const a = await sealed('qa')
    const b = await sealed('qb')
    expect(announced).toEqual([a.msg, b.msg])
    let runs = 0
    const { flushTenant } = await import('../src/flush')
    const batch = batchOf([a.msg, b.msg, a.msg, a.msg])
    const r = await deliver(batch, { flush: (t, s) => (runs++, flushTenant(env, engine, t, s)) })
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
    await deliver(batchOf([a.msg]))
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

    const second = await deliver(batchOf([a.msg], [2]))
    expect(second.outcomes[0]).toMatchObject({ action: 'done' })
    expect(second.outcomes[0]!.result!.segments[0]!.files.every((f) => f.put === 'exists')).toBe(true)
    expect(await a.shard.pendingSegments(a.tenant)).toEqual([])
    expect((await read(a.tenant, [a.shardName])).canon).toEqual(a.sent.canon())
  })

  it('retries when flush stops with an error status, with a delay that grows with the attempts', async () => {
    const a = await sealed('qe')
    const failed: FlushResult = { status: 'error', reason: 'object_conflict', detail: 'injected', tenant: a.tenant, shard: a.shardName, segments: [], loggedThrough: 0, recordedThrough: 0, awaitingLog: false, remaining: 0 }
    const r = await deliver(batchOf([a.msg], [4]), { flush: async () => failed })
    expect(r.outcomes[0]).toMatchObject({ action: 'again', why: 'object_conflict' })
    expect(r.retried).toEqual([expect.objectContaining({ delaySeconds: 40 })])
    expect([1, 2, 3, 4, 7, 20].map(retryDelaySeconds)).toEqual([5, 10, 20, 40, 300, 300])
  })

  it('retries while the ledger has admitted the unit but not logged it, and is done once it has', async () => {
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

  it('calls onFlushed after every successful run, and retries the group if it throws', async () => {
    const a = await sealed('qh')
    const seen: string[] = []
    const ok = await deliver(batchOf([a.msg]), { onFlushed: (r) => void seen.push(`${r.tenant}:${r.segments.length}`) })
    expect(ok.outcomes[0]!.action).toBe('done')
    expect(seen).toEqual([`${a.tenant}:1`])
    const bad = await deliver(batchOf([a.msg]), { onFlushed: () => { throw new Error('KV down') } })
    expect(bad.outcomes[0]).toMatchObject({ action: 'again', why: 'exception: KV down' })
    expect(bad.retried).toHaveLength(1)
  })

  it('writes a message that can never be flushed to the dead letters at once, where it can be listed', async () => {
    const a = await sealed('qd')
    const queue = `viz-flush-${a.tenant}`
    const r = await deliver(batchOf([{ tenant: '../etc', shard: 'x' }, 'garbage', a.msg, { tenant: a.tenant }], [], queue))
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
    for (let i = 0; i < 3; i++) expect(await sweepPending(c.env, { olderThanMs: 0 })).toEqual({ markers: 0, shardsAsked: 0, enqueued: [] })
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
    await deliver(batchOf([a.msg, b.msg]))
    const after = counting()
    expect(await sweepPending(after.env, { olderThanMs: 0 })).toEqual({ markers: 2, shardsAsked: 2, enqueued: [] })
    expect(await sweepPending(after.env, { olderThanMs: 0 })).toEqual({ markers: 0, shardsAsked: 0, enqueued: [] })
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
