/**
 * The findings of the adversarial review of D54, D56 and D59 (design/reviews/d54-d56-d59.md),
 * each as a test that failed on the reviewed tree and passes on the fix. R-1 to R-7 are the
 * reviewer's reproductions (scratch `rv-d54/review-d54.test.ts`), with their expectations
 * turned around: they asserted the fault, these assert its absence.
 *
 *   B-1  a reader or split leaf of the previous release says nothing of foreign series: unknown, not 0
 *   M-1  every part reads a shard's tail to one end, learned before the split
 *   M-2  one byte budget across shards; the engine is not used to cut the tail
 *   M-3  parts that read the rest are bounded by `maxTailReadParts`
 *   m-1  an append past the end does not count against a part's budget
 *   m-2  a shard rolled back between the coordinator's read and a part's: only the part's rows count
 *   m-3  a split sized from a read that saw no page; a split sized too small is split again once
 *   m-4  the D59 rerun is needed (a wrong answer without it)
 *   m-5  label calls over leaves: `maxQueryFiles`, and every part's reads count against `maxQueryFetchBytes`
 *   m-7  a page that does not advance the read is refused, not asked for again forever
 */
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeBatch, type Row } from '../../engine/wasm/test/vzb1'
import { type TenantLimits, clearLimitsCache } from '../src/config'
import { hooks } from '../src/coordinator'
import { engine } from '../src/index'
import { Leaf, leafEngine, leafHooks } from '../src/leaf'
import { cutByKey, tailEstimate, tailHooks, type TailRead } from '../src/tail'
import { type Tenant, api, cost, discardAll, flushAll, ingest, sealAll, shardOf, world, write } from './world'

const sec = (ms: number): string => String(ms / 1000)
const BASE = Date.UTC(2026, 9, 1, 12)

async function setLimits(t: Tenant, limits: Partial<TenantLimits> | null): Promise<void> {
  if (limits === null) await env.CONFIG.delete(`limits:${t.name}`)
  else await env.CONFIG.put(`limits:${t.name}`, JSON.stringify(limits))
  clearLimitsCache()
}

afterEach(() => {
  for (const k of Object.keys(hooks)) delete (hooks as Record<string, unknown>)[k]
  delete tailHooks.previousRelease
  delete tailHooks.alter
  delete leafHooks.ignoreTailParts
})

/** n series of one sender (same job and instance: one shard), one sample each at `ts`. */
const gauge = (name: string, n: number, v: number, ts: number, extra: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, k) => ({ labels: { __name__: name, job: 'j', instance: 'i', k: String(k), ...extra }, samples: [[ts, v]] as [number, number][] }))

const payloadBytes = (answer: unknown): number => {
  const a = answer as { status?: string; batches?: { payload: Uint8Array }[] }
  return a.status === 'ok' && Array.isArray(a.batches) ? a.batches.reduce((x, b) => x + b.payload.byteLength, 0) : 0
}

/** FNV-1a 64 of a label set without `without` (storage `series_id`, engine `SplitKey::key`). */
const keyOf = (labels: Record<string, string>, without: string[] = []): bigint => {
  let h = 0xcbf29ce484222325n
  const te = new TextEncoder()
  for (const [n, v] of Object.entries(labels).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (without.includes(n)) continue
    for (const b of [...te.encode(n), 0, ...te.encode(v), 0]) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h
}
const partOf = (k: bigint, L: number): number => Number((k * BigInt(L)) >> 64n)

describe('M-1: every part reads a shard\'s tail to one end, fixed before the split (R-1)', () => {
  it('an append between two parts\' calls is in none of them, whether the coordinator\'s first page fitted or not', async () => {
    const w = await world()
    await write(w.a, gauge('rv_g', 40, 1, BASE))
    await write(w.a, gauge('rv_g', 40, 1, BASE + 15_000))
    const q = { query: 'sum(rv_g)', time: sec(BASE + 60_000) }
    const total = cost(await api(w.a.key, '/api/v1/query', q), 'Tail-Bytes')
    const value = async (): Promise<string> => (await (await api(w.a.key, '/api/v1/query', q)).json<{ data: { result: { value: [number, string] }[] } }>()).data.result[0]!.value[1]
    expect(await value()).toBe('40')
    const out: Record<string, { status: number; mode: string | null; split: string; before: string; after: string }> = {}
    // The end known from the first page (it fitted), then not (cap 1: the first page is over the cap).
    for (const [label, cap, v, at] of [['first page fitted', Math.floor(total * 0.6), 2, BASE + 30_000], ['first page over the cap', 1, 3, BASE + 45_000]] as const) {
      const before = await value()
      hooks.forceLeaves = 2
      hooks.sequentialLeaves = true
      hooks.tailCap = cap
      let appended = false
      // Between part 0's call and part 1's: one scrape of every series arrives.
      hooks.beforeSplitLeaf = async (part) => {
        if (part === 1 && !appended) {
          appended = true
          await write(w.a, gauge('rv_g', 40, v, at))
        }
      }
      const res = await api(w.a.key, '/api/v1/query', q)
      const body = await res.json<{ data: { result: { value: [number, string] }[] } }>()
      for (const k of ['beforeSplitLeaf', 'tailCap', 'forceLeaves', 'sequentialLeaves'] as const) delete hooks[k]
      out[label] = { status: res.status, mode: res.headers.get('X-Viz-Tail-Mode'), split: body.data.result[0]!.value[1], before, after: await value() }
    }
    console.log('M-1', JSON.stringify(out))
    for (const [label, o] of Object.entries(out)) {
      expect([label, o.status, o.mode], label).toEqual([label, 200, 'filtered+leaves'])
      // The parts answer the moment the coordinator fixed, never a mix of two.
      expect(o.split, label).toBe(o.before)
      expect(o.after, label).not.toBe(o.before)
    }
  }, 300_000)
})

describe('m-1: an append past the end does not count against a part\'s budget (R-2)', () => {
  it('the query whose tail fits answers, with the one-place body', async () => {
    const w = await world()
    const t = w.b
    await write(t, gauge('rv_h', 40, 1, BASE))
    await write(t, gauge('rv_h', 40, 1, BASE + 15_000))
    // The last batch the coordinator sees holds another metric: a part's filter keeps nothing of
    // it, so its read does not stop on a kept batch at the end and must meet the append below.
    await write(t, gauge('rv_h_other', 4, 1, BASE + 15_000))
    const q = { query: 'sum(rv_h)', time: sec(BASE + 60_000) }
    const one = await api(t.key, '/api/v1/query', q)
    const want = await one.text()
    const total = cost(one, 'Tail-Bytes')
    await setLimits(t, { maxFetchBytes: 4 * total })
    hooks.forceLeaves = 2
    hooks.sequentialLeaves = true
    hooks.tailCap = Math.floor(total * 0.6)
    const control = await api(t.key, '/api/v1/query', q)
    expect([control.status, await control.text(), control.headers.get('X-Viz-Tail-Mode')]).toEqual([200, want, 'filtered+leaves'])
    let appended = false
    hooks.beforeSplitLeaf = async (part) => {
      if (part === 0 && !appended) {
        appended = true
        // One large scrape after the coordinator's read: past the end, so never used, and larger than a part's budget.
        await write(t, Array.from({ length: 40 }, (_, k) => ({ labels: { __name__: 'rv_h', job: 'j', instance: 'i', k: String(k) }, samples: Array.from({ length: 1500 }, (_, i) => [BASE + 16_000 + i * 25, 1] as [number, number]) })))
      }
    }
    const res = await api(t.key, '/api/v1/query', q)
    const body = await res.text()
    await setLimits(t, null)
    console.log('m-1', JSON.stringify({ cap: 4 * total, status: res.status, mode: res.headers.get('X-Viz-Tail-Mode'), body: body.slice(0, 200) }))
    expect([res.status, body, res.headers.get('X-Viz-Tail-Mode')]).toEqual([200, want, 'filtered+leaves'])
  }, 300_000)
})

describe('M-2: the coordinator and a part hold one byte budget over every shard, not one per shard (R-3)', () => {
  it('bytes received from the shards never pass the cap', async () => {
    const w = await world()
    // Senders on several instances, so that both shards hold rows of the metric.
    const series = Array.from({ length: 16 }, (_, inst) =>
      Array.from({ length: 10 }, (_, k) => ({ labels: { __name__: 'rv_m', job: 'j', instance: `i${inst}`, k: String(k) }, samples: Array.from({ length: 30 }, (_, i) => [BASE + i * 10_000, i] as [number, number]) })),
    ).flat()
    for (let i = 0; i < 16; i++) await write(w.a, series.slice(i * 10, i * 10 + 10))
    const q = { query: 'rv_m', time: sec(BASE + 290_000) }
    const one = await api(w.a.key, '/api/v1/query', q)
    expect(one.status).toBe(200)
    const total = cost(one, 'Tail-Bytes')
    const perShard = new Map<string, number>()
    tailHooks.alter = (shard, answer, where) => {
      if (where === 'coordinator') perShard.set(shard, (perShard.get(shard) ?? 0) + payloadBytes(answer))
      return answer
    }
    const cap = Math.floor(total * 0.45)
    hooks.tailCap = cap
    const res = await api(w.a.key, '/api/v1/query', q)
    const received = [...perShard.values()].reduce((a, b) => a + b, 0)
    console.log('M-2 coordinator', JSON.stringify({ total, cap, status: res.status, received, perShard: [...perShard.values()] }))
    expect(perShard.size).toBe(2)
    expect([...perShard.values()].every((b) => b > 0)).toBe(true)
    expect(res.status).toBe(422)
    expect(received).toBeLessThanOrEqual(cap)

    // A part: its cap is the tenant's maxFetchBytes, over the rests of every shard together.
    delete tailHooks.alter
    hooks.tailCap = 1
    hooks.forceLeaves = 2
    hooks.sequentialLeaves = true
    const partCap = Math.floor(total * 0.3)
    await setLimits(w.a, { maxFetchBytes: partCap })
    const perPart: number[] = []
    let cur = -1
    hooks.beforeSplitLeaf = async (part) => {
      cur = part
      perPart[part] = 0
    }
    tailHooks.alter = (_shard, answer, where) => {
      if (where === 'leaf' && cur >= 0) perPart[cur] = (perPart[cur] ?? 0) + payloadBytes(answer)
      return answer
    }
    const res2 = await api(w.a.key, '/api/v1/query', { query: 'sum(rv_m)', time: sec(BASE + 290_000) })
    const body2 = await res2.text()
    await setLimits(w.a, null)
    console.log('M-2 part', JSON.stringify({ partCap, status: res2.status, perPart, body: body2.slice(0, 160) }))
    expect(res2.status).toBe(422)
    expect(Math.max(...perPart)).toBeGreaterThan(0)
    expect(Math.max(...perPart)).toBeLessThanOrEqual(partCap)
  }, 300_000)

  it('shards of the previous release (whole answers, no budget): tails that fit one by one but not together are over it', async () => {
    const w = await world()
    const series = Array.from({ length: 16 }, (_, inst) =>
      Array.from({ length: 10 }, (_, k) => ({ labels: { __name__: 'rv_w', job: 'j', instance: `i${inst}`, k: String(k) }, samples: Array.from({ length: 30 }, (_, i) => [BASE + i * 10_000, i] as [number, number]) })),
    ).flat()
    for (let i = 0; i < 16; i++) await write(w.a, series.slice(i * 10, i * 10 + 10))
    const q = { query: 'rv_w', time: sec(BASE + 290_000) }
    tailHooks.previousRelease = () => true
    const perShard = new Map<string, number>()
    tailHooks.alter = (shard, answer) => {
      perShard.set(shard, payloadBytes(answer))
      return answer
    }
    const one = await api(w.a.key, '/api/v1/query', q)
    expect([one.status, one.headers.get('X-Viz-Tail-Mode')]).toEqual([200, 'unfiltered'])
    const sizes = [...perShard.values()]
    expect(sizes.length).toBe(2)
    // Each shard's whole tail is under the cap; together they are over it.
    hooks.tailCap = Math.max(...sizes) + 1
    expect(sizes.reduce((a, b) => a + b, 0)).toBeGreaterThan(hooks.tailCap)
    const res = await api(w.a.key, '/api/v1/query', q)
    const body = await res.json<{ error: string }>()
    expect([res.status, body.error]).toEqual([422, expect.stringMatching(/^query exceeded limit max_fetch_bytes: the data files in range plus the unflushed tail is \d+ bytes/)])
  }, 300_000)

  it('neither the coordinator nor a leaf cuts the tail in the engine: the same answers with the engine\'s cut disabled', async () => {
    const w = await world()
    const typed = Array.from({ length: 6 }, (_, i) => ({ labels: { __name__: 'rv_c_total', __type__: 'counter', job: 'j', instance: 'i', s: `t${i}` }, samples: Array.from({ length: 20 }, (_, k) => [BASE + k * 15_000, k * (i + 1)] as [number, number]) }))
    const plain = Array.from({ length: 6 }, (_, i) => ({ labels: { __name__: 'rv_c_total', job: 'j', instance: 'i', s: `u${i}` }, samples: Array.from({ length: 20 }, (_, k) => [BASE + k * 15_000, k * (i + 2)] as [number, number]) }))
    await write(w.a, [...typed, ...plain])
    const queries = [
      { query: 'sum by (job) (rate(rv_c_total[1m]))', start: sec(BASE + 60_000), end: sec(BASE + 285_000), step: '15' },
      { query: 'sum by (job) (label_replace(rv_c_total, "s", "$1-x", "s", "(.*)"))', start: sec(BASE), end: sec(BASE + 285_000), step: '15' },
      { query: 'count({__name__=~"rv_c_total"})', start: sec(BASE), end: sec(BASE + 285_000), step: '15' },
    ]
    const wants = await Promise.all(queries.map(async (q) => (await api(w.a.key, '/api/v1/query_range', q)).text()))
    const coord = engine.splitTails
    const leaf = leafEngine.splitTails
    const refuse = (): never => {
      throw new Error('the engine cut the tail')
    }
    engine.splitTails = refuse
    leafEngine.splitTails = refuse
    try {
      for (const [i, q] of queries.entries()) {
        for (const L of [2, 3, 5]) {
          hooks.forceLeaves = L
          const res = await api(w.a.key, '/api/v1/query_range', q)
          expect([res.status, await res.text(), res.headers.get('X-Viz-Execution')], `${q.query} at ${L}`).toEqual([200, wants[i], 'split'])
        }
      }
      // The rest read by the parts (only where the shards can cut the key, and no part sees another's rows).
      hooks.tailCap = 1
      hooks.forceLeaves = 2
      const res = await api(w.a.key, '/api/v1/query_range', { ...queries[0]!, query: 'sum(rate(rv_c_total{__type__=""}[1m]))' })
      expect([res.status, res.headers.get('X-Viz-Tail-Mode')]).toEqual([200, 'filtered+leaves'])
    } finally {
      engine.splitTails = coord
      leafEngine.splitTails = leaf
    }
  }, 300_000)
})

describe('M-2: the coordinator\'s cut of a tail that fits is by split key, not by id', () => {
  it('a series whose key is not its id, with rows in the lake and in the tail: its tail rows meet its lake rows in one part (a rate across the seam)', async () => {
    const w = await world()
    const typed = Array.from({ length: 4 }, (_, i) => ({ __name__: 'rv_lt_total', job: 'j', instance: 'i', s: `t${i}`, __type__: 'counter' }))
    // A part count at which some typed series' id and key are in different parts.
    const L = [2, 3, 4, 5, 6, 7, 8].find((n) => typed.some((l) => partOf(keyOf(l), n) !== partOf(keyOf(l, ['__type__']), n)))!
    const all = [...typed, ...Array.from({ length: 4 }, (_, i) => ({ __name__: 'rv_lt_total', job: 'j', instance: 'i', s: `u${i}` }))]
    const samples = (i: number, from: number, to: number) => Array.from({ length: to - from }, (_, k) => [BASE + (from + k) * 15_000, (from + k) * (from + k) * (i + 1)] as [number, number])
    await write(w.a, all.map((labels, i) => ({ labels, samples: samples(i, 0, 20) })))
    await sealAll(w, [w.a])
    await flushAll(w, [w.a])
    await discardAll(w)
    await write(w.a, all.map((labels, i) => ({ labels, samples: samples(i, 20, 40) })))
    const q = { query: 'sum by (job) (rate(rv_lt_total[1m]))', start: sec(BASE + 15 * 15_000), end: sec(BASE + 30 * 15_000), step: '15' }
    const one = await api(w.a.key, '/api/v1/query_range', q)
    const want = await one.text()
    expect(cost(one, 'Tail-Bytes')).toBeGreaterThan(0)
    hooks.forceLeaves = L
    const res = await api(w.a.key, '/api/v1/query_range', q)
    console.log('M-2 seam', JSON.stringify({ L, status: res.status, mode: res.headers.get('X-Viz-Tail-Mode'), reads: res.headers.get('X-Viz-Series-Reads') }))
    expect([res.status, await res.text(), res.headers.get('X-Viz-Execution'), res.headers.get('X-Viz-Tail-Mode')]).toEqual([200, want, 'split', 'filtered'])
  }, 300_000)
})

describe('m-2: a shard rolled back between the coordinator\'s read and a part\'s, with a tight cap (R-5)', () => {
  it('only the part\'s rows of the whole answer count: the one-place body, not a 422', async () => {
    const w = await world()
    const t = w.a
    await write(t, gauge('rv_r', 40, 1, BASE))
    // Another metric, in between, on the same shard: filtered out by name in this release.
    await write(t, Array.from({ length: 40 }, (_, k) => ({ labels: { __name__: 'rv_other', job: 'j', instance: 'i', k: String(k) }, samples: Array.from({ length: 300 }, (_, i) => [BASE + 1 + i * 30, 1] as [number, number]) })))
    await write(t, gauge('rv_r', 40, 1, BASE + 15_000))
    const q = { query: 'sum(rv_r)', time: sec(BASE + 60_000) }
    const one = await api(t.key, '/api/v1/query', q)
    const want = await one.text()
    const total = cost(one, 'Tail-Bytes')
    await setLimits(t, { maxFetchBytes: 4 * total })
    hooks.forceLeaves = 2
    hooks.tailCap = Math.floor(total * 0.6)
    const filtered = await api(t.key, '/api/v1/query', q)
    expect([filtered.status, await filtered.text()]).toEqual([200, want])
    tailHooks.previousRelease = (_s, where) => where === 'leaf'
    const rolled = await api(t.key, '/api/v1/query', q)
    const body = await rolled.text()
    await setLimits(t, null)
    console.log('m-2', JSON.stringify({ cap: 4 * total, status: rolled.status, body: body.slice(0, 200) }))
    expect([rolled.status, body, rolled.headers.get('X-Viz-Tail-Mode')]).toEqual([200, want, 'filtered+leaves'])
  }, 300_000)
})

/**
 * D59's case (R-6): one series with `__type__` whose id is in one part and whose key is in
 * another, flushed to the lake, and eight without. Returns the query, the one-place answer, the
 * part count and the part the typed series' id is in.
 */
async function typedInTheLake(): Promise<{ w: Awaited<ReturnType<typeof world>>; q: Record<string, string>; want: string; L: number; idPart: number }> {
  const w = await world()
  const typed = { __name__: 'rv_dep_total', job: 'j', instance: 'i', s: 'typed', __type__: 'counter' }
  const id = keyOf(typed)
  const key = keyOf(typed, ['__type__'])
  const L = [2, 3, 4, 5, 6, 7, 8].find((n) => partOf(id, n) !== partOf(key, n))!
  await write(w.a, [
    { labels: typed, samples: Array.from({ length: 20 }, (_, k) => [BASE + k * 15_000, 100 * k] as [number, number]) },
    ...Array.from({ length: 8 }, (_, i) => ({ labels: { __name__: 'rv_dep_total', job: 'j', instance: 'i', s: `u${i}` }, samples: Array.from({ length: 20 }, (_, k) => [BASE + k * 15_000, k * (i + 1)] as [number, number]) })),
  ])
  await sealAll(w, [w.a])
  await flushAll(w, [w.a])
  await discardAll(w)
  const q = { query: 'sum by (job) (rate(rv_dep_total[1m]))', start: sec(BASE + 60_000), end: sec(BASE + 285_000), step: '15' }
  const want = await (await api(w.a.key, '/api/v1/query_range', q)).text()
  return { w, q, want, L, idPart: partOf(id, L) }
}

describe('B-1: during a deploy, a reader or split leaf of the previous release says nothing of foreign series (R-6)', () => {
  it('a reader of the previous release serving the part the typed series\' id is in: the split runs again by name and time, the exact answer', async () => {
    const { w, q, want, L, idPart } = await typedInTheLake()
    hooks.forceLeaves = L
    // The readers of that part run the previous release (ABI 4): they ignore `seriesByPart`,
    // read the series files by name and time, and answer without `foreign`.
    const orig = Leaf.prototype.extract
    let oldCalls = 0
    Leaf.prototype.extract = async function (this: InstanceType<typeof Leaf>, req) {
      if (req.part !== idPart) return orig.call(this, req)
      oldCalls++
      const { seriesByPart: _ignored, ...rest } = req
      const a = await orig.call(this, rest)
      if (a.status === 'ok') delete (a as { foreign?: number }).foreign
      return a
    }
    let res: Response
    let body: string
    try {
      res = await api(w.a.key, '/api/v1/query_range', q)
      body = await res.text()
    } finally {
      Leaf.prototype.extract = orig
    }
    console.log('B-1 reader', JSON.stringify({ L, idPart, oldCalls, status: res.status, reads: res.headers.get('X-Viz-Series-Reads') }))
    expect(oldCalls).toBeGreaterThan(0)
    expect([res.status, body, res.headers.get('X-Viz-Series-Reads')]).toEqual([200, want, 'id-range,name-time'])
  }, 300_000)

  it('a split leaf of the previous release on that part (no `foreign` in its statistics): the same', async () => {
    const { w, q, want, L, idPart } = await typedInTheLake()
    hooks.forceLeaves = L
    const orig = Leaf.prototype.evaluate
    let oldCalls = 0
    Leaf.prototype.evaluate = async function (this: InstanceType<typeof Leaf>, req) {
      if (req.part !== idPart) return orig.call(this, req)
      oldCalls++
      // It does not pass `seriesByPart` on, and its statistics have no `foreign`.
      const { seriesByPart: _ignored, ...rest } = req
      const a = await orig.call(this, rest)
      if (a.status === 'ok') {
        delete (a.stats as { foreign?: number }).foreign
        delete (a.stats as { foreignUnknown?: boolean }).foreignUnknown
      }
      return a
    }
    let res: Response
    let body: string
    try {
      res = await api(w.a.key, '/api/v1/query_range', q)
      body = await res.text()
    } finally {
      Leaf.prototype.evaluate = orig
    }
    console.log('B-1 split leaf', JSON.stringify({ L, idPart, oldCalls, status: res.status, reads: res.headers.get('X-Viz-Series-Reads') }))
    expect(oldCalls).toBeGreaterThan(0)
    expect([res.status, body, res.headers.get('X-Viz-Series-Reads')]).toEqual([200, want, 'id-range,name-time'])
  }, 300_000)
})

describe('m-4: the D59 rerun is needed', () => {
  it('every reader of this release: the typed series is foreign to the part its id is in, the split runs again and is exact; answered from the first run, it is wrong', async () => {
    const { w, q, want, L } = await typedInTheLake()
    hooks.forceLeaves = L
    const res = await api(w.a.key, '/api/v1/query_range', q)
    expect([res.status, await res.text(), res.headers.get('X-Viz-Series-Reads')]).toEqual([200, want, 'id-range,name-time'])
    hooks.ignoreForeign = true
    const first = await api(w.a.key, '/api/v1/query_range', q)
    const body = await first.text()
    console.log('m-4', JSON.stringify({ L, want: want.slice(0, 200), firstRun: body.slice(0, 200) }))
    expect([first.status, first.headers.get('X-Viz-Series-Reads')]).toEqual([200, 'id-range'])
    expect(body).not.toBe(want)
  }, 300_000)
})

describe('m-3: a split sized from a read that saw no page (R-7), and one sized too small', () => {
  it('the leaves as sized answer, with the one-place body', async () => {
    const w = await world()
    const t = w.a
    for (let b = 0; b < 12; b++) await write(t, Array.from({ length: 400 }, (_, k) => ({ labels: { __name__: 'rv_s', job: 'j', instance: 'i', k: String(k) }, samples: Array.from({ length: 3 }, (_, i) => [BASE + b * 10_000 + i * 1000, b] as [number, number]) })))
    const q = { query: 'sum(count_over_time(rv_s[5m]))', time: sec(BASE + 200_000) }
    const one = await api(t.key, '/api/v1/query', q)
    const want = await one.text()
    const total = cost(one, 'Tail-Bytes')
    // A part may hold a quarter of the tail; the coordinator nothing (as when the lake fills its budget).
    await setLimits(t, { maxFetchBytes: Math.ceil(total / 4) })
    hooks.tailCap = 1
    const sized = await api(t.key, '/api/v1/query', q)
    const body = await sized.text()
    await setLimits(t, null)
    console.log('m-3 sized', JSON.stringify({ total, status: sized.status, leaves: sized.headers.get('X-Viz-Split-Leaves'), body: body.slice(0, 160) }))
    expect([sized.status, body, sized.headers.get('X-Viz-Tail-Mode')]).toEqual([200, want, 'filtered+leaves'])
  }, 300_000)

  it('a part over its cap because the series fall unevenly is split again once, into parts that nest in it', async () => {
    const w = await world()
    const t = w.a
    // Six series of equal size: four whose key is in part 0 of 4 (two in each of parts 0 and 1 of
    // 8), two elsewhere. At 4 parts part 0 holds two thirds of the tail.
    const lab = (k: string) => ({ __name__: 'rv_u', job: 'j', instance: 'i', k })
    const inZero: string[] = []
    const inOne: string[] = []
    const other: string[] = []
    for (let i = 0; inZero.length < 2 || inOne.length < 2 || other.length < 2; i++) {
      const k = `s${i}`
      const id = keyOf(lab(k))
      if (partOf(id, 8) === 0 && inZero.length < 2) inZero.push(k)
      else if (partOf(id, 8) === 1 && inOne.length < 2) inOne.push(k)
      else if (partOf(id, 4) > 0 && other.length < 2) other.push(k)
    }
    await write(t, [...inZero, ...inOne, ...other].map((k) => ({ labels: lab(k), samples: Array.from({ length: 300 }, (_, i) => [BASE + i * 1000, i] as [number, number]) })))
    const q = { query: 'sum(count_over_time(rv_u[10m]))', time: sec(BASE + 300_000) }
    const one = await api(t.key, '/api/v1/query', q)
    const want = await one.text()
    const total = cost(one, 'Tail-Bytes')
    // Sized at ceil(total / (0.5 x 0.55 total)) = 4 parts; part 0 then holds about 0.67 of the tail.
    await setLimits(t, { maxFetchBytes: Math.floor(total * 0.55) })
    hooks.tailCap = 1
    const res = await api(t.key, '/api/v1/query', q)
    const body = await res.text()
    await setLimits(t, null)
    console.log('m-3 resplit', JSON.stringify({ total, status: res.status, leaves: res.headers.get('X-Viz-Split-Leaves'), body: body.slice(0, 200) }))
    expect([res.status, body, res.headers.get('X-Viz-Split-Leaves')]).toEqual([200, want, '8'])
  }, 300_000)

  it('the estimate counts the batches after the one that did not fit, at what the read kept per batch', () => {
    const b = encodeBatch([{ __name__: 'm', i: '1' }], [{ series: 0, ts: 1, bits: 0n }])
    // The first page did not fit: batch 11 of 11..30, 1,000 bytes kept of it; 19 batches after it.
    const read: TailRead = { status: 'ok', shard: 's', incarnation: 1, above: 10, through: 30, batches: [], bytes: 0, paged: true, filtered: true, complete: false, overBytes: 1000, overSeq: 11, overLast: false, resume: null, calls: 1, scannedBatches: 0, scannedBytes: 0 }
    expect(tailEstimate([read]).bytes).toBe(20 * 1000)
    // Ten batches examined (three kept, 300 bytes, and the one over, 100), ten after it.
    expect(tailEstimate([{ ...read, batches: [{ seq: 12, payload: b }], bytes: 300, overBytes: 100, overSeq: 20 }]).bytes).toBe(400 + 10 * 40)
  })
})

describe('M-3: the parts that read the rest of a tail are bounded', () => {
  it('past maxTailReadParts the query is refused naming the limit; at it, it answers', async () => {
    const w = await world()
    await write(w.a, gauge('rv_b', 40, 1, BASE))
    await write(w.a, gauge('rv_b', 40, 2, BASE + 15_000))
    const q = { query: 'sum(rv_b)', time: sec(BASE + 60_000) }
    const want = await (await api(w.a.key, '/api/v1/query', q)).text()
    hooks.tailCap = 1
    hooks.forceLeaves = 3
    await setLimits(w.a, { maxTailReadParts: 2 })
    const res = await api(w.a.key, '/api/v1/query', q)
    const body = await res.json<{ error: string }>()
    expect([res.status, body.error]).toEqual([422, expect.stringMatching(/^query exceeded limit max_tail_read_parts: .* needs 3 parts.*the limit is 2\./)])
    await setLimits(w.a, { maxTailReadParts: 3 })
    const ok = await api(w.a.key, '/api/v1/query', q)
    expect([ok.status, await ok.text(), ok.headers.get('X-Viz-Tail-Mode')]).toEqual([200, want, 'filtered+leaves'])
    // The report and the label calls are bounded alike.
    await setLimits(w.a, { maxTailReadParts: 2 })
    for (const [path, params] of [['/api/v1/status/tsdb', { start: sec(BASE - 60_000), end: sec(BASE + 60_000) }], ['/api/v1/label/k/values', { 'match[]': 'rv_b', start: sec(BASE - 60_000), end: sec(BASE + 60_000) }]] as const) {
      const r = await api(w.a.key, path, params)
      expect([path, r.status, (await r.json<{ error: string }>()).error], path).toEqual([path, 422, expect.stringMatching(/^query exceeded limit max_tail_read_parts: /)])
    }
    await setLimits(w.a, null)
  }, 300_000)
})

describe('m-5: label calls over leaves are bounded by the query-wide limits, counting every part\'s reads', () => {
  it('more series files than maxFiles: over leaves, the one-place answer; past maxQueryFetchBytes counting L copies: refused', async () => {
    const w = await world()
    await ingest(w, [w.a])
    await sealAll(w, [w.a])
    await flushAll(w, [w.a])
    await discardAll(w)
    const params: [string, string][] = [['match[]', 'up']]
    const one = await api(w.a.key, '/api/v1/label/instance/values', params)
    const want = await one.text()
    const files = cost(one, 'Files-Read')
    const bytes = cost(one, 'Bytes-Read')
    expect([one.status, one.headers.get('X-Viz-Execution')]).toEqual([200, 'single'])
    expect(files).toBeGreaterThanOrEqual(2)
    await setLimits(w.a, { maxFiles: files - 1 })
    const over = await api(w.a.key, '/api/v1/label/instance/values', params)
    expect([over.status, await over.text(), over.headers.get('X-Viz-Execution')]).toEqual([200, want, 'split'])
    const L = cost(over, 'Split-Leaves')
    // One copy fits; the parts' copies (each file is one row group, read by every part) do not.
    await setLimits(w.a, { maxFiles: files - 1, maxQueryFetchBytes: bytes + 1 })
    const refused = await api(w.a.key, '/api/v1/label/instance/values', params)
    const body = await refused.json<{ error: string }>()
    console.log('m-5', JSON.stringify({ files, bytes, L, error: body.error }))
    expect([refused.status, body.error]).toEqual([422, expect.stringMatching(new RegExp(`^query exceeded limit max_query_fetch_bytes: the ${L} parts would read \\d+ bytes of the ${files} series files in range, the limit is ${bytes + 1}\\.`))])
    expect(Number(/would read (\d+) bytes/.exec(body.error)![1])).toBeGreaterThan(bytes + 1)
    await setLimits(w.a, { maxFiles: files - 1, maxQueryFiles: files - 1 })
    const many = await api(w.a.key, '/api/v1/label/instance/values', params)
    expect([many.status, (await many.json<{ error: string }>()).error]).toEqual([422, expect.stringMatching(/^query exceeded limit max_query_files: /)])
    await setLimits(w.a, null)
  }, 300_000)
})

describe('m-7: a page that does not advance the read', () => {
  it('is a retryable 503, not a read asked for again until the CPU limit', async () => {
    const w = await world()
    await write(w.a, gauge('rv_p', 10, 1, BASE))
    await write(w.a, gauge('rv_p', 10, 1, BASE + 15_000))
    // A shard that examines nothing per call answers every page with the cursor it was given.
    for (const s of w.shards) await shardOf(s).configure({ tailScanMaxBytes: 0 })
    // A valve, so that code without the check ends too (and fails here) instead of spinning: after
    // 30 calls the shard answers a status this release does not know.
    let calls = 0
    tailHooks.alter = (_s, answer) => (++calls > 30 ? { status: 'valve' } : answer)
    try {
      const res = await api(w.a.key, '/api/v1/query', { query: 'sum(rv_p)', time: sec(BASE + 60_000) })
      const body = await res.json<{ errorType: string; error: string }>()
      expect([res.status, body.errorType, body.error]).toEqual([503, 'unavailable', expect.stringMatching(/answered a page that did not advance the read; retry$/)])
      expect(cost(res, 'Shard-Calls')).toBeLessThan(10)
    } finally {
      for (const s of w.shards) await shardOf(s).configure({ tailScanMaxBytes: 32 << 20 })
    }
  }, 60_000)
})

describe('cutByKey (the JavaScript cut that replaced the engine\'s, review M-2)', () => {
  /** Rows of a VZB1 batch, in order, as (labels, ts, value bits). */
  const rowsOf = (b: Uint8Array): string[] => {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    const nRows = dv.getUint32(8, true)
    const nSeries = dv.getUint32(12, true)
    const td = new TextDecoder()
    const labels: string[] = []
    let p = 16
    for (let s = 0; s < nSeries; s++) {
      const n = dv.getUint32(p + 8, true)
      p += 12
      const kv: string[] = []
      for (let l = 0; l < 2 * n; l++) {
        const len = dv.getUint16(p, true)
        kv.push(td.decode(b.subarray(p + 2, p + 2 + len)))
        p += 2 + len
      }
      labels.push(JSON.stringify(kv))
    }
    const idxAt = (p + 7) & ~7
    const tsAt = idxAt + ((4 * nRows + 7) & ~7)
    const valAt = tsAt + 8 * nRows
    return Array.from({ length: nRows }, (_, i) => `${labels[dv.getUint32(idxAt + 4 * i, true)]} ${dv.getBigInt64(tsAt + 8 * i, true)} ${dv.getBigUint64(valAt + 8 * i, true)}`)
  }

  it('puts every row in the part the engine\'s splitTails puts it (random batches, label sets with and without __type__/__unit__, several `without`)', () => {
    let seed = 7
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const withouts = [[], ['__type__', '__unit__'], ['__type__'], ['__name__'], ['__name__', '__type__', '__unit__'], ['instance'], ['zz']]
    const all = [{ matchers: [], minTs: 0, maxTs: 253_402_300_799_999 }]
    let moved = 0
    for (let trial = 0; trial < 150; trial++) {
      const series = Array.from({ length: 1 + rnd(25) }, (_, i) => ({
        __name__: `m${rnd(3)}`,
        instance: `h${rnd(4)}`,
        i: `${i}`,
        ...(rnd(3) === 0 ? { __type__: rnd(2) ? 'counter' : 'gauge' } : {}),
        ...(rnd(4) === 0 ? { __unit__: 'seconds' } : {}),
        ...(rnd(5) === 0 ? { zz: 'é'.repeat(1 + rnd(3)) } : {}),
      }))
      const rows: Row[] = Array.from({ length: 1 + rnd(60) }, () => ({ series: rnd(series.length), ts: rnd(1000), bits: BigInt(rnd(1 << 30)) }))
      const batch = encodeBatch(series, rows)
      const without = withouts[rnd(withouts.length)]!
      const parts = 1 + rnd(12)
      const got = cutByKey(batch, parts, without)
      const want = engine.splitTails([batch], without, parts, all)
      for (let j = 0; j < parts; j++) {
        expect(got[j] ? rowsOf(got[j]!) : [], `trial ${trial}, ${JSON.stringify(without)}, part ${j} of ${parts}`).toEqual(want[j]![0] ? rowsOf(want[j]![0]!) : [])
      }
      if (without.length > 0 && series.some((s) => without.some((x) => x in s))) moved++
    }
    expect(moved).toBeGreaterThan(30)
  })
})
