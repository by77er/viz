/// <reference path="../../engine/wasm/js/wasm.d.ts" />
/**
 * Spans and log records in shards (stage 2 of traces and logs; contracts/BATCH.md "Streams per
 * signal", D57):
 *
 *   - a shard of a derived pool (`{pool}/traces/{slot}`, `{pool}/logs/{slot}`) stores, seals,
 *     lists and serves span and log batches like metric batches; registration before writes
 *     (D61) applies to its streams exactly as to a metric pool's;
 *   - a filtered tail read never throws on a span or log batch, and `signals` chooses batches by
 *     their signal byte: a metrics read (`signals: [1]`) gets only metric rows, which the engine
 *     selects exactly as from a shard holding nothing else; a span or log read gets its batches
 *     whole, as stored; a filter naming series keeps nothing of them;
 *   - a batch of a signal this code does not know is skipped when the read leaves it out, and
 *     fails the read otherwise; a cursor is bound to its signals.
 *
 * Batches are written by the engine's test encoders (`engine/wasm/test/vzb1.ts`, `signal.ts`)
 * and metric pages are read back by the engine.
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createEngine } from '../../engine/wasm/js/index'
import wasm from '../../engine/wasm/js/viz_engine.wasm'
import { encodeLogBatch, encodeSpanBatch, id } from '../../engine/wasm/test/signal'
import { bitsFromBytes, bitsOf, encodeBatch } from '../../engine/wasm/test/vzb1'
import { type AppendResult, type Shard, type TailBatch, type TailReadOptions, type TailResult } from '../src/shard'

type Stub = DurableObjectStub<Shard>
const engine = createEngine(wasm)
let n = 0
const uid = () => `${Date.now().toString(36)}-${n++}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const T = Date.UTC(2026, 10, 19, 10)
const NS = BigInt(T) * 1_000_000n

const spans = (k: number) => encodeSpanBatch([{ resourceFp: 1n, resource: [['service.name', { s: 'api' }]] }], [
  { entry: 0, traceId: id(16, k), spanId: id(8, k), start: NS + BigInt(k), end: NS + BigInt(k) + 10n, name: `s${k}` },
])
const logs = (k: number) => encodeLogBatch([{ labels: { service_name: 'api' } }], [{ entry: 0, ts: NS + BigInt(k), line: `line ${k}` }])
const metrics = (k: number) => encodeBatch([{ __name__: 'up', job: 'a' }, { __name__: 'cpu', job: 'a' }], [
  { series: 0, ts: T + k * 1000, bits: bitsOf(k) },
  { series: 1, ts: T + k * 1000, bits: bitsOf(-k) },
])

async function append(s: Stub, tenant: string, payload: Uint8Array, k: number): Promise<AppendResult> {
  return s.append({ tenant, epoch: 1, fingerprint: `fp-${k}-${payload.length}-${payload[4]}`, payload, rows: new DataView(payload.buffer, payload.byteOffset).getUint32(8, true) })
}

async function readAll(s: Stub, tenant: string, inc: number, opts: TailReadOptions): Promise<{ batches: TailBatch[]; pages: number }> {
  const batches: TailBatch[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const r = await s.tailRead(tenant, inc, 0, { ...opts, ...(cursor ? { cursor } : {}) })
    if (r.status !== 'ok' || !r.page) throw new Error(`tail read: ${JSON.stringify(r)}`)
    batches.push(...r.batches)
    cursor = r.page.next ?? undefined
    pages++
  } while (cursor)
  return { batches, pages }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const flat = (batches: Uint8Array[]) =>
  engine.select({ seriesFiles: [], sampleFiles: [], tailBatches: batches }, [], 0, 253_402_300_799_999).map((x) => ({ labels: x.labels, ts: Array.from(x.ts), bits: bitsFromBytes(x.values) }))

describe('the shards of the derived pools (D57)', () => {
  for (const [pool, batch] of [['traces', spans], ['logs', logs]] as const) {
    it(`a ${pool} shard stores, seals, lists, serves and records its batches like a metrics shard`, async () => {
      const name = `shared-${uid()}/${pool}/0`
      const s = env.SHARD.get(env.SHARD.idFromName(name))
      const tenant = `t-${uid()}`
      await s.configure({ sealBytes: 1 << 20 })
      for (let k = 1; k <= 3; k++) expect(await append(s, tenant, batch(k), k)).toMatchObject({ status: 'ok', seq: k })
      expect((await append(s, tenant, batch(2), 2))).toMatchObject({ status: 'ok', seq: 2, duplicate: true })
      await s.seal(tenant)
      const [seg] = await s.pendingSegments(tenant)
      expect(seg).toMatchObject({ seqLo: 1, seqHi: 3 })
      const read = await s.readSegment(tenant, 1, seg!.incarnation, 3)
      expect(read!.map((b) => hex(b.payload))).toEqual([1, 2, 3].map((k) => hex(batch(k))))
      // Unfiltered and filtered reads hand the batches back whole.
      const whole = await s.tailRead(tenant, seg!.incarnation, 0)
      expect(whole.status === 'ok' && whole.batches.map((b) => hex(b.payload))).toEqual([1, 2, 3].map((k) => hex(batch(k))))
      const signal = pool === 'traces' ? 2 : 3
      const own = await readAll(s, tenant, seg!.incarnation, { signals: [signal], minTs: T, maxTs: T })
      expect(own.batches.map((b) => [b.seq, b.rows, hex(b.payload)])).toEqual([1, 2, 3].map((k) => [k, 1, hex(batch(k))]))
      expect((await readAll(s, tenant, seg!.incarnation, { signals: [1] })).batches).toEqual([])
      expect((await readAll(s, tenant, seg!.incarnation, { minTs: 0 })).batches).toHaveLength(3)
      expect((await readAll(s, tenant, seg!.incarnation, { metrics: ['up'] })).batches).toEqual([])
      expect((await readAll(s, tenant, seg!.incarnation, { signals: [signal], labels: [{ name: 'job', value: 'a' }] })).batches).toEqual([])
      expect(await s.recorded(tenant, seg!.incarnation, 3)).toEqual({ status: 'ok', recordedThrough: 3 })
      expect(await s.pendingSegments(tenant)).toEqual([])
    })
  }

  it('registration before writes (D61) applies to a derived pool\'s new streams: refused until the ledger has LOGGED it', async () => {
    const name = `shared-${uid()}/traces/1`
    const s = env.SHARD.get(env.SHARD.idFromName(name))
    const tenant = `t-${uid()}`
    const l = env.LEDGER.get(env.LEDGER.idFromName(tenant))
    await s.configure({ registration: 'logged', registerBackoffMs: 20, registerBackoffMaxMs: 200 })
    const first = await append(s, tenant, spans(1), 1)
    expect(first).toMatchObject({ status: 'backpressure', scope: 'registering' })
    expect(await s.describe(tenant)).toMatchObject({ registered: false, nextSeq: 1 })
    for (let i = 0; ; i++) {
      await l.drain()
      if ((await s.describe(tenant))?.registered) break
      expect(i).toBeLessThan(200)
      await sleep(20)
    }
    expect((await l.loggedWatermarks()).find((w) => w.shard === name)).toMatchObject({ seq: 0 })
    expect(await append(s, tenant, spans(1), 1)).toMatchObject({ status: 'ok', seq: 1 })
  })
})

describe('signals in a filtered tail read', () => {
  async function mixed() {
    // Not what edge writes (a stream holds one signal), but the filter must not depend on it.
    const s = env.SHARD.get(env.SHARD.idFromName(`mixed-${uid()}/0`))
    const tenant = `t-${uid()}`
    const sent: Uint8Array[] = []
    for (let k = 1; k <= 9; k++) {
      const b = k % 3 === 1 ? metrics(k) : k % 3 === 2 ? spans(k) : logs(k)
      sent.push(b)
      expect(await append(s, tenant, b, k)).toMatchObject({ status: 'ok', seq: k })
    }
    const inc = (await s.describe(tenant))!.incarnation
    return { s, tenant, inc, sent }
  }

  it('a metrics read (`signals: [1]`) gets only metric rows, which the engine selects as from metric batches alone; nothing throws', async () => {
    const { s, tenant, inc, sent } = await mixed()
    const onlyMetrics = sent.filter((b) => b[4] === 1)
    for (const opts of [{ signals: [1] }, { signals: [1], minTs: T + 2000, maxTs: T + 4000 }, { signals: [1], metrics: ['cpu'] }, { signals: [1], maxBytes: 200 }] as TailReadOptions[]) {
      const got = await readAll(s, tenant, inc, opts)
      for (const b of got.batches) expect(b.payload[4], JSON.stringify(opts)).toBe(1)
      const want = engine.select({ seriesFiles: [], sampleFiles: [], tailBatches: onlyMetrics }, opts.metrics ? [{ name: '__name__', op: '=', value: 'cpu' }] : [], opts.minTs ?? 0, opts.maxTs ?? 253_402_300_799_999)
      expect(flat(got.batches.map((b) => b.payload)), JSON.stringify(opts)).toEqual(want.map((x) => ({ labels: x.labels, ts: Array.from(x.ts), bits: bitsFromBytes(x.values) })))
    }
    // The same metric filter WITHOUT signals keeps the metric rows and drops the span and log batches it names no series of.
    expect((await readAll(s, tenant, inc, { metrics: ['up', 'cpu'] })).batches.map((b) => b.seq)).toEqual([1, 4, 7])
  })

  it('a span or log read gets its batches whole and in order; several signals at once; a cursor is bound to its signals', async () => {
    const { s, tenant, inc, sent } = await mixed()
    const two = await readAll(s, tenant, inc, { signals: [2] })
    expect(two.batches.map((b) => [b.seq, hex(b.payload)])).toEqual([[2, hex(sent[1]!)], [5, hex(sent[4]!)], [8, hex(sent[7]!)]])
    const both = await readAll(s, tenant, inc, { signals: [3, 2], maxBytes: 600 })
    expect(both.batches.map((b) => b.seq)).toEqual([2, 3, 5, 6, 8, 9])
    expect(both.pages).toBeGreaterThan(1)
    const r = await s.tailRead(tenant, inc, 0, { signals: [2], maxBytes: 600 })
    expect(r.status === 'ok' && r.page?.next).toBeTruthy()
    const cursor = (r as Extract<TailResult, { status: 'ok' }>).page!.next!
    expect(await s.tailRead(tenant, inc, 0, { signals: [3], maxBytes: 600, cursor })).toMatchObject({ status: 'invalid' })
    expect(await s.tailRead(tenant, inc, 0, { signals: [2], maxBytes: 600, cursor })).toMatchObject({ status: 'ok' })
    for (const bad of [[], [0], [1.5], [256], ['1']]) expect(await s.tailRead(tenant, inc, 0, { signals: bad as number[] })).toMatchObject({ status: 'invalid' })
  })

  it('a filter without signals has the cursor it had before the field existed', async () => {
    const { s, tenant, inc } = await mixed()
    const r = await s.tailRead(tenant, inc, 0, { metrics: ['up'], maxBytes: 100 })
    const c = (r as Extract<TailResult, { status: 'ok' }>).page!.next!
    // `f` in the cursor is FNV-1a 64 of the filter's canonical text, which has no `signals` key.
    const f = JSON.parse(atob(c.slice(3).replaceAll('-', '+').replaceAll('_', '/') + '=='.slice(0, (4 - ((c.length - 3) % 4)) % 4))).f
    const { fnv64 } = await import('../src/tail')
    expect(f).toBe(fnv64(JSON.stringify({ minTs: null, maxTs: null, metrics: ['up'], labels: null, keyRange: null })))
  })

  it('a batch of a signal this code does not know is skipped when the read leaves it out, and fails the read otherwise; after eviction too', async () => {
    const { s, tenant } = await mixed()
    const odd = metrics(10).slice()
    odd[4] = 9
    expect(await append(s, tenant, odd, 10)).toMatchObject({ status: 'ok', seq: 10 })
    await evictDurableObject(s)
    const inc = (await s.describe(tenant))!.incarnation
    expect((await readAll(s, tenant, inc, { signals: [1, 2, 3] })).batches.map((b) => b.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    // Inside the object: an exception thrown across RPC also surfaces as an uncaught error there.
    await runInDurableObject(s, async (inst: Shard) => {
      await expect(inst.tailRead(tenant, inc, 0, { minTs: 0 })).rejects.toThrow(/batch 10 is unreadable/)
      await expect(inst.tailRead(tenant, inc, 0, { signals: [9] })).rejects.toThrow(/batch 10 is unreadable/)
    })
    // The unfiltered form returns every stored batch as before, without looking inside.
    const all = await s.tailRead(tenant, inc, 0)
    expect(all.status === 'ok' && all.batches).toHaveLength(10)
  })
})
