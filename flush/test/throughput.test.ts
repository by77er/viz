/**
 * D82, the write side's throughput: a run reads, encodes and writes the next segment while the
 * one before it is admitted, and admits strictly in sequence; it waits (bounded) for the ledger's
 * log so the shard is told `recorded` in the same run; the consumer runs a batch's streams at
 * once, at most `maxConcurrentRuns`, with every R2 request of the invocation under one limit of six.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { type FlushResult, Limiter, consumeFlushBatch, flushTenant } from '../src/index'
import { engine } from '../src/index'
import { T0, append, ledgerStub, someSamples, stream } from './helpers'
import { NONE, type Op, instrumented, sleep } from './instrument'

const DAY = 86_400_000

/** A stream with `segments` sealed segments, each of samples over `days` UTC days (one samples and one series file per day). */
async function sealed(segments: number, days = 1) {
  const s = stream('thr')
  for (let g = 0; g < segments; g++) {
    for (let d = 0; d < days; d++) await append(s.shard, s.tenant, someSamples(s.tenant, T0 + d * DAY + g * 60_000, 6, g * 100 + d))
    await s.shard.seal(s.tenant)
  }
  return s
}

function batchOf(groups: { tenant: string; shard: string }[]) {
  const acked: string[] = []
  const retried: string[] = []
  const messages = groups.map((b, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body: b, ack: () => acked.push(b.shard), retry: () => retried.push(b.shard) }))
  return { batch: { queue: 'viz-flush', messages, ackAll() {}, retryAll() {} } as unknown as MessageBatch<unknown>, acked, retried }
}

describe('Limiter', () => {
  it('lets at most `size` calls run at once and runs every one, in order of arrival', async () => {
    const l = new Limiter(3)
    let active = 0
    let peak = 0
    const order: number[] = []
    await Promise.all(Array.from({ length: 10 }, (_, i) => l.run(async () => {
      peak = Math.max(peak, ++active)
      order.push(i)
      await sleep(5 + (i % 3))
      active--
      return i
    })))
    expect(peak).toBe(3)
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('releases its slot when the call throws', async () => {
    const l = new Limiter(1)
    await expect(l.run(async () => { throw new Error('x') })).rejects.toThrow('x')
    expect(await l.run(async () => 7)).toBe(7)
  })
})

describe('a run pipelines its segments (D82)', () => {
  it('writes the next segment while the one before it is admitted, and admits in sequence even when a later write finishes first', async () => {
    const s = await sealed(4)
    const ops: Op[] = []
    // The FIRST segment's PUTs are slow: the second's finish first.
    const e = instrumented(NONE, ops, performance.now(), (op, args) => (op === 'r2.put' && /-1-1-[0-9a-f]{8}\.parquet$/.test(String(args[0])) ? 150 : 0))
    const r = await flushTenant(e, engine, s.tenant, s.shardName)
    expect(r).toMatchObject({ status: 'ok', segments: [1, 2, 3, 4].map((seqLo) => ({ seqLo, outcome: 'admitted' })) })
    const adds = ops.filter((o) => o.op === 'ledger.addUnit')
    expect(adds.map((o) => o.arg)).toEqual(['seqLo=1', 'seqLo=2', 'seqLo=3', 'seqLo=4'])
    // Segment 2's objects were written before segment 1 was admitted: the overlap.
    const put2 = ops.find((o) => o.op === 'r2.put' && /-2-2-[0-9a-f]{8}\.parquet$/.test(o.arg ?? ''))!
    expect(put2.start).toBeLessThan(adds[0]!.start)
    // Never more than `pipeline` segments ahead: segment 3's PUTs start only once segment 1 is admitted.
    const put3 = ops.find((o) => o.op === 'r2.put' && /-3-3-[0-9a-f]{8}\.parquet$/.test(o.arg ?? ''))!
    expect(put3.start).toBeGreaterThanOrEqual(adds[0]!.start)
    expect((await ledgerStub(s.tenant).plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).watermarks).toEqual([{ shard: s.shardName, incarnation: r.segments[0]!.incarnation, seq: 4 }])
  })

  it('with pipeline 1 it writes one segment at a time, as before D82', async () => {
    const s = await sealed(3)
    const ops: Op[] = []
    const r = await flushTenant(instrumented(NONE, ops, performance.now()), engine, s.tenant, s.shardName, { pipeline: 1 })
    expect(r.status).toBe('ok')
    const add1 = ops.find((o) => o.op === 'ledger.addUnit')!
    const put2 = ops.find((o) => o.op === 'r2.put' && /-2-2-[0-9a-f]{8}\.parquet$/.test(o.arg ?? ''))!
    expect(put2.start).toBeGreaterThan(add1.start)
  })
})

describe('a run waits for the ledger\'s log (D82)', () => {
  // The suite's ledgers drain only when asked (vitest.config.ts): a drain is started by hand.
  it('tells the shard `recorded` in the same run once the log reaches its last unit', async () => {
    const s = await sealed(2)
    setTimeout(() => void ledgerStub(s.tenant).drain(), 300)
    const r = await flushTenant(env, engine, s.tenant, s.shardName, { logWaitMs: 5000, logPollMs: 50 })
    expect(r).toMatchObject({ status: 'ok', awaitingLog: false, recordedThrough: 2, loggedThrough: 2 })
  })

  it('waits no longer than `logWaitMs`, and then leaves it to a retry as before', async () => {
    const s = await sealed(1)
    const t = Date.now()
    const r = await flushTenant(env, engine, s.tenant, s.shardName, { logWaitMs: 400, logPollMs: 50 })
    const waited = Date.now() - t
    expect(r).toMatchObject({ status: 'ok', awaitingLog: true, recordedThrough: 0 })
    expect(waited).toBeGreaterThanOrEqual(400)
    expect(waited).toBeLessThan(3000)
  })

  it('does not wait at all by default (a direct caller is answered at once)', async () => {
    const s = await sealed(1)
    const t = Date.now()
    const r = await flushTenant(env, engine, s.tenant, s.shardName)
    expect(r).toMatchObject({ status: 'ok', awaitingLog: true })
    expect(Date.now() - t).toBeLessThan(2000)
  })
})

describe('the consumer runs a batch\'s streams at once (D82)', () => {
  it('at most `maxConcurrentRuns` at a time, every group acknowledged by its own outcome, outcomes in batch order', async () => {
    let active = 0
    let peak = 0
    const flush = async (tenant: string, shard: string): Promise<FlushResult> => {
      peak = Math.max(peak, ++active)
      await sleep(30)
      active--
      return { status: shard.endsWith('/bad') ? 'error' : 'ok', reason: shard.endsWith('/bad') ? 'gap' : undefined, tenant, shard, segments: [], loggedThrough: 0, recordedThrough: 0, awaitingLog: false, remaining: 0, changed: false } as FlushResult
    }
    const groups = ['a/0', 'a/1', 'b/0', 'b/bad', 'c/0', 'c/1', 'd/0'].map((shard) => ({ tenant: `t-${shard[0]}`, shard }))
    const { batch, acked, retried } = batchOf(groups)
    const out = await consumeFlushBatch(batch, env, engine, { flush, maxConcurrentRuns: 3 })
    expect(peak).toBe(3)
    expect(out.map((o) => o.shard)).toEqual(groups.map((g) => g.shard))
    expect(retried).toEqual(['b/bad'])
    expect(acked.sort()).toEqual(groups.map((g) => g.shard).filter((x) => x !== 'b/bad').sort())
    peak = 0
    await consumeFlushBatch(batchOf(groups).batch, env, engine, { flush, maxConcurrentRuns: 1 })
    expect(peak).toBe(1)
  })

  it('every R2 request of the invocation shares one limit of six, however many runs and files', async () => {
    // Three streams, each two segments of samples over 5 days: 10 files a segment.
    const streams = [await sealed(2, 5), await sealed(2, 5), await sealed(2, 5)]
    const ops: Op[] = []
    const e = instrumented({ ...NONE, put: 20 }, ops, performance.now())
    const groups = streams.map((s) => ({ tenant: s.tenant, shard: s.shardName }))
    const { batch } = batchOf(groups)
    const out = await consumeFlushBatch(batch, e, engine, { logWaitMs: 0 })
    expect(out.every((o) => o.result?.status === 'ok' && o.result.segments.length === 2)).toBe(true)
    expect(ops.filter((o) => o.op === 'r2.put')).toHaveLength(60)
    expect(e.peakR2()).toBe(6)
  })
})
