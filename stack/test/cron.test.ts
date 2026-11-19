import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sweepPending } from '../../flush/src/index'
import { PENDING_MARKER_PREFIX } from '../../shard/src/shard'
import { MAINT_QUEUE_NAME, type MaintMessage, type StackEnv, consumeMaintBatch, engine, handleScheduled, maintMarkerKey, maintainTenant } from '../src/index'
import { type Sim, createSim, ingest, rng, shard } from './sim'

const HOUR = 3_600_000
const clearKv = async (prefix: string) => {
  for (const k of (await env.CONFIG.list({ prefix })).keys) await env.CONFIG.delete(k.name)
}

/** A shard namespace whose objects answer `pendingTenants` from a table, or throw. */
function fakeShards(answers: Record<string, string[] | 'throw'>) {
  const asked: string[] = []
  const SHARD = {
    idFromName: (n: string) => n,
    get: (name: string) => ({
      pendingTenants: async () => {
        asked.push(name)
        const a = answers[name]
        if (a === 'throw' || a === undefined) throw new Error(`injected: shard ${name} fails`)
        return a.map((tenant) => ({ tenant, segments: 1, oldestSealedAt: 0 }))
      },
    }),
  } as unknown as StackEnv['SHARD']
  return { asked, SHARD }
}

function recordingQueue<T>() {
  const sent: T[] = []
  const queue = { send: async (b: T) => void sent.push(b), sendBatch: async (bs: Iterable<{ body: T }>) => { for (const x of bs) sent.push(x.body) } } as unknown as Queue<T>
  return { sent, queue }
}

describe('review R-7: one failing shard does not stop the hourly cron', () => {
  beforeAll(async () => {
    await clearKv(PENDING_MARKER_PREFIX)
    await clearKv('maint:')
  })

  // Ported from the reviewer's stack/test/review.test.ts.
  it('a tenant whose maintenance is due is still enqueued', async () => {
    const tag = Date.now().toString(36)
    const tenant = `rv-cron-${tag}`
    await env.CONFIG.put(maintMarkerKey(tenant), '1', { metadata: { due: 0, orphansAt: 0, sweep: false } })
    await env.CONFIG.put(`${PENDING_MARKER_PREFIX}rv-broken-${tag}/0`, '{}')
    const maint = recordingQueue<MaintMessage>()
    const fake: StackEnv = { ...(env as unknown as StackEnv), SHARD: fakeShards({}).SHARD, MAINT_QUEUE: maint.queue }
    await handleScheduled(fake).catch(() => undefined)
    expect(maint.sent).toContainEqual(expect.objectContaining({ tenant }))
    await clearKv(PENDING_MARKER_PREFIX)
    await clearKv('maint:')
  })

  it('the shards before and after a failing one are still swept, and the failure is reported', async () => {
    for (const s of ['a/0', 'b/0', 'c/0']) await env.CONFIG.put(`${PENDING_MARKER_PREFIX}${s}`, '{}')
    const f = fakeShards({ 'a/0': ['ta'], 'b/0': 'throw', 'c/0': ['tc'] })
    const flushQ = recordingQueue<unknown>()
    const r = await sweepPending({ SHARD: f.SHARD, CONFIG: env.CONFIG, FLUSH_QUEUE: flushQ.queue as never }, { olderThanMs: 0 })
    expect(f.asked.sort()).toEqual(['a/0', 'b/0', 'c/0'])
    expect(flushQ.sent).toEqual([{ v: 1, tenant: 'ta', shard: 'a/0' }, { v: 1, tenant: 'tc', shard: 'c/0' }])
    expect(r.failed).toEqual([{ shard: 'b/0', error: expect.stringContaining('injected') }])
    // And through the cron: the maintenance part runs although the flush part could not finish.
    await env.CONFIG.put(maintMarkerKey('t-due'), '1', { metadata: { due: 0, orphansAt: 0, sweep: false } })
    const maint = recordingQueue<MaintMessage>()
    const x = await handleScheduled({ ...(env as unknown as StackEnv), SHARD: f.SHARD, FLUSH_QUEUE: flushQ.queue as never, MAINT_QUEUE: maint.queue })
    expect(maint.sent).toEqual([{ v: 1, tenant: 't-due' }])
    expect(x.errors).toEqual([expect.stringContaining('b/0')])
    await clearKv(PENDING_MARKER_PREFIX)
    await clearKv('maint:')
  })

  it('a listing that fails stops only its own sweep', async () => {
    await env.CONFIG.put(maintMarkerKey('t-due2'), '1', { metadata: { due: 0, orphansAt: 0, sweep: false } })
    const CONFIG = new Proxy(env.CONFIG, {
      get: (t, p) => (p === 'list' ? async (o: KVNamespaceListOptions) => { if (o.prefix === PENDING_MARKER_PREFIX) throw new Error('injected: KV list failed'); return t.list(o) } : Reflect.get(t, p).bind(t)),
    })
    const maint = recordingQueue<MaintMessage>()
    const x = await handleScheduled({ ...(env as unknown as StackEnv), CONFIG, MAINT_QUEUE: maint.queue })
    expect(maint.sent).toEqual([{ v: 1, tenant: 't-due2' }])
    expect(x.flush).toBeNull()
    expect(x.errors).toEqual([expect.stringContaining('KV list failed')])
    await clearKv('maint:')
  })

  it('asks at most maxShards shards per cron, and successive hourly crons visit every marked shard', async () => {
    const names = Array.from({ length: 7 }, (_, i) => `rot${i}/0`)
    for (const s of names) await env.CONFIG.put(`${PENDING_MARKER_PREFIX}${s}`, '{}')
    const f = fakeShards(Object.fromEntries(names.map((n) => [n, [] as string[]])))
    const q = recordingQueue<unknown>()
    const e = { SHARD: f.SHARD, CONFIG: env.CONFIG, FLUSH_QUEUE: q.queue as never }
    const start = Date.UTC(2026, 10, 19, 5)
    const seen = new Set<string>()
    for (let hour = 0; hour < 3; hour++) {
      f.asked.length = 0
      const r = await sweepPending(e, { olderThanMs: 0, maxShards: 3, now: start + hour * HOUR })
      expect(r).toMatchObject({ markers: 7, shardsAsked: 3, deferred: 4 })
      expect(f.asked).toHaveLength(3)
      for (const s of f.asked) seen.add(s)
    }
    expect([...seen].sort()).toEqual(names)
    await clearKv(PENDING_MARKER_PREFIX)
  })
})

/**
 * KV allows one write per second to a key, and answers a second one with 429
 * (https://developers.cloudflare.com/kv/platform/limits/, "Writes to same key: 1 per second";
 * https://developers.cloudflare.com/kv/api/write-key-value-pairs/). This wrapper does the same
 * for every key, and holds the first write of `barrierKey` until a second one arrives, so two
 * runs finishing together collide deterministically.
 */
function perKeyRateLimited(kv: KVNamespace, barrierKey: string, windowMs = 1000) {
  const last = new Map<string, number>()
  const writes: { key: string; ok: boolean }[] = []
  let arrived = 0
  let release: () => void = () => {}
  const both = new Promise<void>((r) => { release = r })
  const guard = async (key: string) => {
    if (key === barrierKey && arrived < 2) {
      if (++arrived === 2) release()
      await both
    }
    const now = Date.now()
    const prev = last.get(key)
    const ok = prev === undefined || now - prev >= windowMs
    writes.push({ key, ok })
    if (!ok) throw new Error('KV PUT failed: 429 Too Many Requests')
    last.set(key, now)
  }
  const proxy = new Proxy(kv, {
    get(t, p) {
      if (p === 'put') return async (k: string, v: string, o?: KVNamespacePutOptions) => { await guard(k); return t.put(k, v, o) }
      if (p === 'delete') return async (k: string) => { await guard(k); return t.delete(k) }
      const v = Reflect.get(t, p)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
  return { writes, kv: proxy }
}

describe('review R-11(c): the maintenance marker tolerates KV\'s per-key write rate', () => {
  let sim: Sim
  beforeAll(async () => {
    sim = await createSim(1, 6)
  })
  afterAll(() => sim.restore())

  it('two runs of one tenant that finish together both succeed, and the marker is written', async () => {
    const [t] = sim.tenants
    expect(await ingest(sim, t!, rng(3), 4, 2, 0)).toBe(204)
    for (const s of sim.shards) await shard(s).seal(t!.name)
    await clearKv(maintMarkerKey(t!.name))
    const limited = perKeyRateLimited(env.CONFIG, maintMarkerKey(t!.name))
    const e = { ...sim.env, CONFIG: limited.kv } as StackEnv
    const opts = { deleteGraceMs: 3_600_000, orphanEveryMs: 0, orphanGraceMs: 0 }
    const [a, b] = await Promise.all([maintainTenant(e, engine, t!.name, opts), maintainTenant(e, engine, t!.name, opts)])
    expect(a.tenant).toBe(t!.name)
    expect(b.tenant).toBe(t!.name)
    // One of the two marker writes was refused once and written again after KV's second.
    const markerWrites = limited.writes.filter((w) => w.key === maintMarkerKey(t!.name))
    expect(markerWrites.filter((w) => !w.ok)).toHaveLength(1)
    expect(markerWrites.filter((w) => w.ok)).toHaveLength(2)
    expect(await env.CONFIG.get(maintMarkerKey(t!.name))).not.toBeNull()
  })

  it('a run whose marker is unchanged does not write it again', async () => {
    const [t] = sim.tenants
    const opts = { deleteGraceMs: 3_600_000, orphanEveryMs: 0, orphanGraceMs: 0 }
    await maintainTenant(sim.env, engine, t!.name, opts)
    const limited = perKeyRateLimited(env.CONFIG, 'none')
    await maintainTenant({ ...sim.env, CONFIG: limited.kv } as StackEnv, engine, t!.name, opts)
    expect(limited.writes.filter((w) => w.key === maintMarkerKey(t!.name))).toEqual([])
  })
})

// contracts/COMPATIBILITY.md §3.2, design/UPGRADES.md §7 item 6: maintenance messages carry a
// version; one this release does not know is retried, never run on a guess, never dead-lettered.
describe('maintenance messages carry a version', () => {
  it('v absent or 1 runs; any other v is retried, even when the rest of the body looks invalid', async () => {
    const runs: string[] = []
    const dead: unknown[] = []
    const bodies = [{ v: 2, tenant: 'tv' }, { v: 2 }, { v: 1, tenant: 'tv1' }, { tenant: 'tv0' }, { nope: true }]
    const batch = createMessageBatch(MAINT_QUEUE_NAME, bodies.map((body, i) => ({ id: `v${i}`, timestamp: Date.now(), attempts: 1, body })))
    const ctx = createExecutionContext()
    await consumeMaintBatch(batch, env as unknown as StackEnv, engine, {
      run: async (_e, _eng, tenant) => (runs.push(tenant), { more: false } as never),
      deadLetter: async (ms) => void dead.push(...ms.map((m) => m.body)),
    })
    const result = await getQueueResult(batch, ctx)
    expect(runs.sort()).toEqual(['tv0', 'tv1'])
    expect(result.retryMessages.map((m) => m.msgId).sort()).toEqual(['v0', 'v1'])
    expect(dead).toEqual([{ nope: true }])
  })
})
