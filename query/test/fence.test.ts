/**
 * The seam between lake and tail (design §2), and every other way a query could return
 * a result with a hole in it: it must re-plan and return the exact answer, or fail with
 * 503. Never a partial result.
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'
import { hooks } from '../src/coordinator'
import type { Shard } from '../../shard/src/shard'
import { QUERIES, type Tenant, type World, api, cost, discardAll, expected, flushAll, ingest, ledgerOf, run, sealAll, shardOf, workload, world } from './world'

const END = workload.end
const sec = (ms: number): string => String(ms / 1000)
const Q = ['rate-sum-by', 'sel-rewritten', 'i-up', 'hq-sum-by', 'count-over-time-stale'].map((id) => QUERIES.find((q) => q.id === id)!)

async function exact(t: Tenant, what: string): Promise<Response[]> {
  const out: Response[] = []
  for (const q of Q) {
    const res = await run(t.key, q)
    expect(await res.json(), `${what}: ${q.id}`).toEqual(expected[t.which][q.id])
    out.push(res)
  }
  return out
}

async function all(w: World): Promise<World> {
  await ingest(w)
  return w
}

afterEach(() => {
  delete hooks.afterPlan
  delete hooks.betweenPlans
  delete hooks.beforeLeafCall
})

describe('the fence', () => {
  it('a flush and discard between the plan and the tail read: the query re-plans and returns the exact result', async () => {
    const w = await all(await world())
    await exact(w.a, 'before')
    // The plan says "no files, nothing registered". Then, before any shard is asked:
    // everything is sealed, flushed, recorded and DISCARDED by the shards.
    let fired = 0
    hooks.afterPlan = async (_tenant, attempt) => {
      if (attempt !== 1 || fired++ > 0) return
      await sealAll(w)
      await flushAll(w)
      await discardAll(w)
    }
    const q = Q[0]!
    const res = await run(w.a.key, q)
    expect(await res.json()).toEqual(expected.a[q.id])
    expect(fired).toBe(1)
    // It was refused, went back to the ledger, and answered from the lake.
    expect(cost(res, 'Plan-Attempts')).toBe(2)
    expect(cost(res, 'Tail-Batches')).toBe(0)
    expect(cost(res, 'Files-Read')).toBeGreaterThanOrEqual(4)
    await exact(w.a, 'after')
    await exact(w.b, 'after, other tenant')
  })

  it('the same with a watermark already registered (lake + tail, then the tail is flushed and discarded mid-query)', async () => {
    const w = await all(await world())
    await flushAll(w) // first segment recorded: the ledger has watermarks
    await exact(w.a, 'lake + tail')
    let fired = 0
    hooks.afterPlan = async (_tenant, attempt) => {
      if (attempt !== 1 || fired++ > 0) return
      await sealAll(w)
      await flushAll(w)
      await discardAll(w)
      // …and every object involved is evicted for good measure.
      for (const s of w.shards) await evictDurableObject(shardOf(s))
      await evictDurableObject(ledgerOf(w.a))
    }
    for (const q of Q.slice(0, 2)) {
      fired = 0
      const res = await run(w.a.key, q)
      expect(await res.json(), q.id).toEqual(expected.a[q.id])
    }
    const res = await run(w.a.key, Q[0]!)
    expect(cost(res, 'Plan-Attempts')).toBe(1)
  })

  it('a flush between the two plan calls: both tables are read again at one version', async () => {
    const w = await all(await world())
    let fired = 0
    hooks.betweenPlans = async () => {
      if (fired++ > 0) return
      await sealAll(w)
      await flushAll(w)
      await discardAll(w)
    }
    const q = Q[0]!
    const res = await run(w.a.key, q)
    // Without the version check: series files of the OLD version (none) with sample files
    // and watermarks of the NEW one, so every flushed sample would be dropped silently.
    expect(await res.json()).toEqual(expected.a[q.id])
    expect(cost(res, 'Plan-Attempts')).toBe(2)
  })

  it('a ledger that never stops changing is 503, not an answer from mixed versions', async () => {
    const w = await all(await world())
    let n = 0
    hooks.betweenPlans = async (tenant) => {
      // A new stream registration bumps the ledger version every time.
      await ledgerOf(w.a).registerStream({ shard: `ghost/${n++}`, incarnation: 1 })
      expect(tenant).toBe(w.a.name)
    }
    const res = await run(w.a.key, Q[0]!)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ status: 'error', errorType: 'unavailable' })
    expect(n).toBe(5)
  })

  it('a shard that has discarded past the ledger’s watermark for good: 503 after bounded retries, never a partial result', async () => {
    const w = await all(await world())
    await flushAll(w)
    await exact(w.a, 'healthy')
    // One shard claims to have discarded far beyond what the ledger has recorded (as if a
    // flush unit had been lost after the shard was told it was recorded).
    const broken = w.shards[0]!
    await runInDurableObject(shardOf(broken), (inst: Shard) => {
      const s = (inst as unknown as { streams: Map<string, { discardedThrough: number }> }).streams.get(w.a.name)!
      s.discardedThrough = 1_000_000
    })
    for (const q of Q) {
      const res = await run(w.a.key, q)
      const body = await res.json<{ status: string; errorType: string; error: string; data?: unknown }>()
      expect([q.id, res.status, body.errorType]).toEqual([q.id, 503, 'unavailable'])
      expect(body.data).toBeUndefined()
      expect(body.error).toContain('has discarded rows above the watermark')
      // 1 plan + 3 re-plans, then it gives up.
      expect(cost(res, 'Plan-Attempts')).toBe(4)
    }
    // Label endpoints go through the same seam.
    for (const path of ['/api/v1/labels', '/api/v1/label/job/values', '/api/v1/series?match[]=up']) expect((await api(w.a.key, path)).status, path).toBe(503)
    // The other tenant, in the same shard object, is not affected.
    await exact(w.b, 'other tenant')
    // A query that reads nothing still answers.
    expect((await api(w.a.key, '/api/v1/query', { query: '1 + 1', time: sec(END) })).status).toBe(200)
  })

  it('a shard whose stream was recreated (storage loss): the new stream is read from sequence 0; a shard behind the ledger is 503', async () => {
    const w = await all(await world())
    await sealAll(w)
    await flushAll(w)
    await exact(w.a, 'all flushed')
    const shard = w.shards[0]!
    const stream = (await shardOf(shard).describe(w.a.name))!
    // The ledger knows incarnation I. The shard now has I + 1000 (a stream created later):
    // after one look at the ledger, which still says I, everything in it is tail.
    const setIncarnation = (inc: number) =>
      runInDurableObject(shardOf(shard), (inst: Shard) => {
        ;(inst as unknown as { streams: Map<string, { incarnation: number }> }).streams.get(w.a.name)!.incarnation = inc
      })
    await setIncarnation(stream.incarnation + 1000)
    const res = await run(w.a.key, Q[0]!)
    // The lake still holds what the old incarnation flushed, and the "new" stream's rows
    // are the same samples: the answer is the same.
    expect(await res.json()).toEqual(expected.a[Q[0]!.id])
    expect(cost(res, 'Plan-Attempts')).toBe(2)
    // A shard OLDER than the ledger's registration cannot be answered correctly.
    await setIncarnation(stream.incarnation - 1000)
    const behind = await run(w.a.key, Q[0]!)
    expect(behind.status).toBe(503)
    expect(await behind.json()).toMatchObject({ errorType: 'unavailable' })
  })
})

describe('files', () => {
  it('a data file the ledger lists but R2 does not have: 503, never an answer without it', async () => {
    const w = await all(await world())
    await sealAll(w)
    await flushAll(w)
    await discardAll(w)
    const plan = await ledgerOf(w.a).plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
    const victim = plan.files[0]!.key
    const bytes = await (await env.BUCKET.get(victim))!.arrayBuffer()
    await env.BUCKET.delete(victim)
    const q = QUERIES.find((x) => x.id === 'sel-name-re')! // not read before in this world: nothing of it is cached
    const res = await run(w.a.key, q)
    expect(res.status).toBe(503)
    const body = await res.json<{ errorType: string; error: string; data?: unknown }>()
    expect(body.errorType).toBe('unavailable')
    expect(body.data).toBeUndefined()
    expect(cost(res, 'Plan-Attempts')).toBe(4)
    // Put it back: the same query answers exactly.
    await env.BUCKET.put(victim, bytes)
    expect(await (await run(w.a.key, q)).json()).toEqual(expected.a[q.id])
  })

  it('a file that vanishes and a plan that changes: the re-plan picks up the new file list', async () => {
    const w = await all(await world())
    await flushAll(w)
    // Before the leaves read anything, the rest is flushed too. The first plan's files are
    // all still there, so nothing is missing; the tail read is what refuses.
    let fired = 0
    hooks.beforeLeafCall = async () => {
      if (fired++ > 0) return
      await sealAll(w)
      await flushAll(w)
      await discardAll(w)
    }
    const res = await run(w.a.key, Q[1]!)
    expect(await res.json()).toEqual(expected.a[Q[1]!.id])
  })

  it('a leaf that fails once is retried on another leaf; leaves that keep failing are 503', async () => {
    const w = await all(await world())
    await sealAll(w)
    await flushAll(w)
    await discardAll(w)
    let calls = 0
    hooks.beforeLeafCall = async () => {
      if (calls++ === 0) throw new Error('injected leaf failure')
    }
    const q = QUERIES.find((x) => x.id === 'bin-or')!
    const ok = await run(w.a.key, q)
    expect(await ok.json()).toEqual(expected.a[q.id])
    expect(calls).toBeGreaterThanOrEqual(2) // the failed call and its retry on the next leaf
    // Both the call and its retry fail: 503. The files that could not be read are not left out.
    const q2 = QUERIES.find((x) => x.id === 'avg-without')!
    let failed = 0
    hooks.beforeLeafCall = async (leaf) => {
      if (leaf % 2 === 0 || failed++ >= 0) throw new Error('injected leaf failure')
    }
    const res = await run(w.a.key, q2)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ status: 'error', errorType: 'unavailable', error: 'could not read data files: injected leaf failure' })
    // A call the leaf itself refuses (more than six reads) is not retried anywhere: 503.
    const q3 = QUERIES.find((x) => x.id === 'deriv')!
    hooks.beforeLeafCall = async (_leaf, items) => {
      while (items.length <= 6) items.push({ key: 'x' })
    }
    const refused = await run(w.a.key, q3)
    expect(refused.status).toBe(503)
    expect(await refused.json()).toMatchObject({ status: 'error', errorType: 'unavailable', error: expect.stringContaining('reads in one call; the limit is 6') })
  })

  it('leaves hold no state: evicting every leaf between and during queries changes nothing', async () => {
    const w = await all(await world())
    await sealAll(w)
    await flushAll(w)
    await discardAll(w)
    const leaves = Array.from({ length: Number(env.LEAF_POOL_SIZE) }, (_, i) => env.LEAF.get(env.LEAF.idFromName(`leaf/${env.CELL}/${i}`)))
    await exact(w.a, 'first')
    for (const l of leaves) await evictDurableObject(l)
    await exact(w.a, 'after eviction')
    // Every second leaf is evicted right before each call to it. (A call that the
    // eviction breaks is retried on the next leaf, which this hook leaves alone: evicting
    // that one too could hit it in the middle of its own call.)
    let evictions = 0
    hooks.beforeLeafCall = async (leaf) => {
      if (leaf % 2 !== 0) return
      evictions++
      await evictDurableObject(leaves[leaf]!)
    }
    await exact(w.b, 'evicted before every call')
    expect(evictions).toBeGreaterThan(0)
    // Nothing was ever written to a leaf's storage.
    for (const l of leaves) {
      const keys = await runInDurableObject(l, async (_inst, state) => [...(await state.storage.list()).keys()])
      expect(keys).toEqual([])
      expect(await runInDurableObject(l, async (_inst, state) => state.storage.getAlarm())).toBeNull()
    }
  })
})

describe('release skew (contracts/COMPATIBILITY.md)', () => {
  afterEach(() => {
    delete hooks.alterTail
    delete hooks.betweenPlans
  })

  it('a shard status this release does not know, or schema_too_new, is a retryable 503, never an empty tail', async () => {
    const w = await world()
    await ingest(w)
    const q = QUERIES.find((x) => x.id === 'rate-sum-by')!
    const answers: unknown[] = [
      { status: 'schema_too_new', component: 'shard.Shard', version: 9, compat: 9, known: 1, retryAfterMs: 5000 },
      { status: 'paused', incarnation: 1 },
      { status: 'ok', incarnation: 1, through: 5 },
    ]
    for (const answer of answers) {
      hooks.alterTail = () => answer
      for (const path of ['/api/v1/query_range', '/api/v1/labels', '/api/v1/status/tsdb']) {
        const res = path === '/api/v1/query_range' ? await run(w.a.key, q) : await api(w.a.key, path, { start: String(workload.t0 / 1000), end: String(workload.end / 1000) })
        const body = await res.json<{ errorType?: string; data?: unknown }>()
        expect([path, JSON.stringify(answer).slice(0, 30), res.status, body.errorType, body.data]).toEqual([path, JSON.stringify(answer).slice(0, 30), 503, 'unavailable', undefined])
        expect(res.headers.get('Retry-After')).toBe('1')
      }
    }
    delete hooks.alterTail
    expect(await (await run(w.a.key, q)).json()).toEqual(expected.a[q.id])
  })

  it('a ledger whose storage is newer than this release reads (it throws schema_too_new) is a retryable 503', async () => {
    const w = await world()
    await ingest(w)
    hooks.betweenPlans = async () => {
      throw new Error('schema_too_new: ledger.Ledger storage is at version 9, this release knows 1')
    }
    const res = await run(w.a.key, QUERIES.find((x) => x.id === 'rate-sum-by')!)
    expect([res.status, (await res.json<{ errorType: string }>()).errorType, res.headers.get('Retry-After')]).toEqual([503, 'unavailable', '5'])
  })
})
