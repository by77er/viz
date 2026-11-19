import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FLUSH_MESSAGE_VERSION, type FlushMessage, PENDING_MARKER_PREFIX, Shard, pendingMarkerKey } from '../src/shard'
import { expectGolden } from './golden'

/**
 * The seal notification. The transport is one method, `announce`; these tests replace it
 * on the prototype (the Durable Objects run in this isolate), so they hold whatever the
 * transport is and across evictions.
 */
const proto = Shard.prototype as unknown as { announce(msg: FlushMessage): Promise<void> }
const original = proto.announce
let sent: FlushMessage[] = []
let failing = false
beforeEach(() => {
  sent = []
  failing = false
  proto.announce = async (msg) => {
    if (failing) throw new Error('injected: queue unavailable')
    sent.push(msg)
  }
})
afterEach(() => {
  proto.announce = original
})

let n = 0
const fresh = () => {
  const name = `trig-${Date.now().toString(36)}/${n++}`
  return { name, s: env.SHARD.get(env.SHARD.idFromName(name)) }
}
const put = async (s: DurableObjectStub<Shard>, tenant: string, fp: string, size = 100) => {
  const r = await s.append({ tenant, epoch: 1, fingerprint: fp, payload: new Uint8Array(size).fill(1), rows: 1 })
  if (r.status !== 'ok') throw new Error(r.status)
  return r
}
const alarmOf = (s: DurableObjectStub<Shard>) => runInDurableObject(s, (_i, state) => state.storage.getAlarm())
const outbox = (s: DurableObjectStub<Shard>) =>
  runInDurableObject(s, (_i, state) => state.storage.sql.exec(`SELECT tenant FROM notify ORDER BY tenant`).toArray().map((r) => r.tenant as string))
const markers = async () => (await env.CONFIG.list({ prefix: PENDING_MARKER_PREFIX })).keys.map((k) => k.name)

describe('a seal causes a flush', () => {
  it('announces {tenant, shard} once when a stream seals on size, and not before', async () => {
    const { name, s } = fresh()
    await s.configure({ sealBytes: 250, sealAgeMs: 3_600_000 })
    await put(s, 'a', 'f1')
    await put(s, 'b', 'f1')
    await put(s, 'a', 'f2')
    expect(sent).toEqual([])
    await put(s, 'a', 'f3') // 300 bytes: seals tenant a only
    expect(sent).toEqual([{ v: 1, tenant: 'a', shard: name }])
    // The message's format, pinned (contracts/COMPATIBILITY.md §8): what flush/src/consumer.ts reads.
    expectGolden(`formats/queue.flush.v${FLUSH_MESSAGE_VERSION}.json`, { format: 'queue.flush', version: FLUSH_MESSAGE_VERSION, onSeal: JSON.stringify(sent[0]).replace(name, '<shard>') })
    expect(await s.pendingSegments('a')).toHaveLength(1)
    expect(await outbox(s)).toEqual([])
    // More appends below the threshold announce nothing more.
    await put(s, 'a', 'f4')
    expect(sent).toHaveLength(1)
  })

  it('announces when a stream seals on age (the alarm) and when sealed by hand', async () => {
    const { name, s } = fresh()
    await s.configure({ sealBytes: 1 << 20, sealAgeMs: 0 })
    await put(s, 'a', 'f1')
    expect(sent).toEqual([])
    await runDurableObjectAlarm(s)
    expect(sent).toEqual([{ v: 1, tenant: 'a', shard: name }])
    await put(s, 'b', 'f1')
    await s.configure({ sealAgeMs: 3_600_000 })
    await s.seal('b')
    expect(sent).toEqual([{ v: 1, tenant: 'a', shard: name }, { v: 1, tenant: 'b', shard: name }])
    // Sealing a stream with nothing unsealed is not a seal.
    await s.seal('b')
    expect(sent).toHaveLength(2)
  })

  it('keeps an unsent notification durably and retries it from the alarm, across an eviction', async () => {
    const { name, s } = fresh()
    await s.configure({ sealBytes: 150, sealAgeMs: 3_600_000, notifyRetryMs: 5_000 })
    failing = true
    await put(s, 'a', 'f1')
    const r = await put(s, 'a', 'f2') // seals; the send fails; the append is still acknowledged
    expect(r.status).toBe('ok')
    expect(sent).toEqual([])
    expect(await outbox(s)).toEqual(['a'])
    const due = await alarmOf(s)
    expect(due).not.toBeNull()
    expect(due! - Date.now()).toBeLessThanOrEqual(5_000)

    await evictDurableObject(s)
    expect(await outbox(s)).toEqual(['a'])
    // Still failing: the alarm keeps it and re-arms.
    await runInDurableObject(s, (_i, state) => state.storage.sql.exec(`UPDATE notify SET due = 0 WHERE tenant = 'a'`))
    await runDurableObjectAlarm(s)
    expect(await outbox(s)).toEqual(['a'])
    expect(await alarmOf(s)).not.toBeNull()

    failing = false
    await runInDurableObject(s, (_i, state) => state.storage.sql.exec(`UPDATE notify SET due = 0 WHERE tenant = 'a'`))
    await runInDurableObject(s, (_i, state) => state.storage.setAlarm(Date.now()))
    await runDurableObjectAlarm(s)
    expect(sent).toEqual([{ v: 1, tenant: 'a', shard: name }])
    expect(await outbox(s)).toEqual([])
  })
})

describe('pending tenants and the pending marker', () => {
  it('lists tenants with unrecorded segments older than a threshold, per tenant', async () => {
    const { s } = fresh()
    await s.configure({ sealBytes: 1 << 20, sealAgeMs: 3_600_000 })
    await put(s, 'a', 'f1')
    await put(s, 'b', 'f1')
    await put(s, 'c', 'f1')
    expect(await s.pendingTenants()).toEqual([])
    const before = Date.now()
    await s.seal('a')
    await s.seal('a') // nothing new
    await put(s, 'a', 'f2')
    await s.seal('a')
    await s.seal('b')
    const pending = await s.pendingTenants()
    expect(pending.map((p) => [p.tenant, p.segments])).toEqual([['a', 2], ['b', 1]])
    for (const p of pending) expect(p.oldestSealedAt).toBeGreaterThanOrEqual(before)
    // Nothing is older than an hour.
    expect(await s.pendingTenants(3_600_000)).toEqual([])

    const a = (await s.describe('a'))!
    expect(await s.recorded('a', a.incarnation, 1)).toMatchObject({ status: 'ok' })
    expect((await s.pendingTenants()).map((p) => [p.tenant, p.segments])).toEqual([['a', 1], ['b', 1]])
    expect(await s.recorded('a', a.incarnation, 2)).toMatchObject({ status: 'ok' })
    expect((await s.pendingTenants()).map((p) => p.tenant)).toEqual(['b'])
  })

  it('writes the marker at the first seal and removes it only when asked and nothing is pending', async () => {
    const { name, s } = fresh()
    await s.configure({ sealBytes: 1 << 20, sealAgeMs: 3_600_000 })
    await put(s, 'a', 'f1')
    expect(await markers()).not.toContain(pendingMarkerKey(name))
    await s.seal('a')
    expect(await markers()).toContain(pendingMarkerKey(name))
    // Still pending: asking keeps the marker.
    await s.pendingTenants()
    expect(await markers()).toContain(pendingMarkerKey(name))
    const a = (await s.describe('a'))!
    await s.recorded('a', a.incarnation, 1)
    // Recording does not touch KV (a busy shard would rewrite the key all day)...
    expect(await markers()).toContain(pendingMarkerKey(name))
    // ...the sweep's question does.
    expect(await s.pendingTenants()).toEqual([])
    expect(await markers()).not.toContain(pendingMarkerKey(name))
    // And the next seal writes it again, also after an eviction.
    await evictDurableObject(s)
    await put(s, 'a', 'f2')
    await s.seal('a')
    expect(await markers()).toContain(pendingMarkerKey(name))
  })

  it('retries a marker that could not be written, from the alarm', async () => {
    const { name, s } = fresh()
    await s.configure({ sealBytes: 1 << 20, sealAgeMs: 3_600_000, notifyRetryMs: 5_000 })
    await put(s, 'a', 'f1')
    const breakKv = (broken: boolean) =>
      runInDurableObject(s, (inst: Shard) => {
        const e = (inst as unknown as { env: { CONFIG: KVNamespace } }).env
        ;(inst as unknown as { env: object }).env = {
          ...e,
          CONFIG: broken ? new Proxy(env.CONFIG, { get: (t, p) => (p === 'put' ? async () => { throw new Error('injected: KV unavailable') } : Reflect.get(t, p).bind(t)) }) : env.CONFIG,
        }
      })
    await breakKv(true)
    await s.seal('a')
    expect(sent).toHaveLength(1) // the notification itself went out
    expect(await markers()).not.toContain(pendingMarkerKey(name))
    expect(await alarmOf(s)).not.toBeNull()
    await breakKv(false)
    await runDurableObjectAlarm(s)
    expect(await markers()).toContain(pendingMarkerKey(name))
  })

  it('an idle shard has no alarm, no outbox row and, once asked, no marker', async () => {
    const { name, s } = fresh()
    await s.configure({ sealBytes: 1 << 20, sealAgeMs: 3_600_000, retainRecordedMs: 0, fingerprintTtlMs: 0, seriesPersistMs: 0 })
    const payload = new Uint8Array(32)
    new DataView(payload.buffer).setUint32(12, 1, true)
    await s.append({ tenant: 'a', epoch: 1, fingerprint: 'f1', payload, rows: 1, seriesIds: BigInt64Array.of(7n) })
    await s.seal('a')
    const a = (await s.describe('a'))!
    await s.recorded('a', a.incarnation, 1)
    // Housekeeping: discard, forget fingerprints, save the series window. Then nothing is left to do.
    for (let i = 0; i < 3 && (await alarmOf(s)) !== null; i++) await runDurableObjectAlarm(s)
    expect(await alarmOf(s)).toBeNull()
    expect(await outbox(s)).toEqual([])
    expect(await s.pendingTenants()).toEqual([])
    expect(await markers()).not.toContain(pendingMarkerKey(name))
    expect(await alarmOf(s)).toBeNull()
    expect(sent).toHaveLength(1)
  })
})
