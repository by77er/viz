/**
 * Leaves: how reads are spread over the pool (at most six per leaf per round), what a
 * leaf does, the file cache, and pruning from the ledger's index fragments.
 */
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FileEntry } from '../../contracts/ledger'
import { MAX_PART_BYTES, type Piece, assign, byPrecedence, hooks, pieces } from '../src/coordinator'
import { MAX_BYTES_PER_CALL, MAX_READS_PER_CALL, type ReadItem, cacheUrl, fileCache } from '../src/leaf'
import { QUERIES, type Tenant, type WSeries, type World, api, cost, discardAll, expected, flushAll, ledgerOf, run, sealAll, workload, world, write } from './world'

const END = workload.end
const sec = (ms: number): string => String(ms / 1000)
const leaf = (n: number) => env.LEAF.get(env.LEAF.idFromName(`leaf/${env.CELL}/${n}`))
const POOL = Number(env.LEAF_POOL_SIZE)

afterEach(() => {
  delete hooks.beforeLeafCall
  delete hooks.maxPartBytes
})

/**
 * The whole workload of one tenant in MANY flush units: the first request one metric
 * name at a time (so every file holds one name), the second request in slices of time.
 * The write order of the workload is kept, so the result is the same as ever.
 */
async function ingestInManyFiles(w: World, t: Tenant): Promise<number> {
  const [first, second] = workload.requests[t.which] as [WSeries[], WSeries[]]
  let units = 0
  const unit = async (series: WSeries[]) => {
    if (series.length === 0) return
    await write(t, series)
    await sealAll(w, [t])
    await flushAll(w, [t])
    units++
  }
  for (const name of [...new Set(first.map((s) => s.labels.__name__!))]) await unit(first.filter((s) => s.labels.__name__ === name))
  const from = second[0]!.samples[0]![0]
  for (let lo = from; lo <= END; lo += 150_000) await unit(second.map((s) => ({ labels: s.labels, samples: s.samples.filter(([ts]) => ts >= lo && ts < lo + 150_000) })).filter((s) => s.samples.length > 0))
  return units
}

describe('spreading reads over the pool', () => {
  const mk = (n: number, bytes = 1000): Piece[] => Array.from({ length: n }, (_, i) => ({ key: `k/${i}`, file: i, part: 0, bytes }))

  it('no leaf gets more than six reads or more than the byte budget in one round; every piece is placed once', () => {
    for (const [n, pool] of [[1, 1], [6, 1], [7, 1], [48, 8], [49, 8], [500, 32], [192, 32], [193, 32], [5, 3]] as const) {
      const rounds = assign(mk(n), pool, 'q1')
      expect(rounds.length, `${n} files, pool ${pool}`).toBe(Math.ceil(n / (pool * MAX_READS_PER_CALL)))
      const seen = new Set<string>()
      for (const round of rounds) {
        for (const [l, list] of round) {
          expect(l).toBeGreaterThanOrEqual(0)
          expect(l).toBeLessThan(pool)
          expect(list.length).toBeLessThanOrEqual(MAX_READS_PER_CALL)
          for (const p of list) {
            expect(seen.has(p.key)).toBe(false)
            seen.add(p.key)
          }
        }
      }
      expect(seen.size).toBe(n)
    }
    // Bytes: 10 MiB pieces, two fit in 24 MiB.
    const big = assign(mk(20, 10 << 20), 4, 'q')
    for (const round of big) for (const [, list] of round) expect(list.reduce((a, p) => a + p.bytes, 0)).toBeLessThanOrEqual(MAX_BYTES_PER_CALL)
    expect(big.length).toBe(3) // 20 pieces, 2 per leaf, 4 leaves
  })

  it('different queries start on different leaves; one query spreads over the pool', () => {
    const first = new Set<number>()
    for (let q = 0; q < 40; q++) first.add([...assign(mk(1), 32, `query-${q}`)[0]!.keys()][0]!)
    expect(first.size).toBeGreaterThan(15)
    const one = assign(mk(32), 32, 'query-x')[0]!
    expect(one.size).toBeGreaterThan(16) // 32 reads do not pile onto a few leaves
    // Deterministic for one query id.
    expect([...assign(mk(10), 8, 'same')[0]!.entries()]).toEqual([...assign(mk(10), 8, 'same')[0]!.entries()])
  })

  it('an object above 16 MiB is cut into range reads that tile it exactly', () => {
    const out = pieces([{ key: 'small', bytes: 100 }, { key: 'exact', bytes: MAX_PART_BYTES }, { key: 'big', bytes: 2 * MAX_PART_BYTES + 5 }])
    expect(out.map((p) => [p.key, p.offset, p.length, p.file, p.part, p.bytes])).toEqual([
      ['small', undefined, undefined, 0, 0, 100],
      ['exact', undefined, undefined, 1, 0, MAX_PART_BYTES],
      ['big', 0, MAX_PART_BYTES, 2, 0, MAX_PART_BYTES],
      ['big', MAX_PART_BYTES, MAX_PART_BYTES, 2, 1, MAX_PART_BYTES],
      ['big', 2 * MAX_PART_BYTES, 5, 2, 2, 5],
    ])
    expect(MAX_PART_BYTES).toBeLessThanOrEqual(MAX_BYTES_PER_CALL)
    expect(MAX_BYTES_PER_CALL).toBeLessThan(32 << 20)
  })
})

describe('the order of sample files', () => {
  it('a sample rewritten by a later flush wins, also once sequence numbers have two digits', async () => {
    // One shard, so every write of this tenant is one more sequence number in one stream.
    const w = await world(1)
    const T = END - 60_000
    const x = { __name__: 'rewritten', job: 'j', instance: 'i' }
    const unit = async (series: WSeries[]) => {
      await write(w.a, series)
      await sealAll(w, [w.a])
      await flushAll(w, [w.a])
    }
    for (let seq = 1; seq <= 12; seq++) {
      const filler: WSeries = { labels: { __name__: 'filler', job: 'j', instance: 'i' }, samples: [[T + seq * 1000, seq]] }
      // Written with value 1 in the 2nd flush, rewritten with 2 in the 11th and with 3 in the 12th.
      await unit(seq === 2 ? [filler, { labels: x, samples: [[T, 1]] }] : seq === 11 ? [filler, { labels: x, samples: [[T, 2]] }] : seq === 12 ? [filler, { labels: x, samples: [[T, 3], [T + 1000, 30]] }] : [filler])
    }
    const keys = (await ledgerOf(w.a).plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files.map((f) => f.key)
    // The hazard is real: in the ledger's (key) order the 11th flush comes BEFORE the 2nd.
    const at = (seq: number) => keys.findIndex((k) => k.includes(`-${seq}-${seq}-`))
    expect(at(11)).toBeLessThan(at(2))
    const value = async () => (await (await api(w.a.key, '/api/v1/query', { query: 'rewritten', time: sec(T) })).json<{ data: { result: { value: [number, string] }[] } }>()).data.result[0]!.value[1]
    expect(await value()).toBe('3')
    await discardAll(w)
    expect(await value()).toBe('3')
  })

  it('byPrecedence: compaction outputs first (higher level first), then flush files by shard, incarnation and sequence as numbers', () => {
    const f = (key: string, level = 0): FileEntry => ({ table: 'metric_samples', day: '2026-11-18', key: `c/data/metric_samples/tenant=t/day=2026-11-18/${key}`, bytes: 1, rows: 1, minTs: 0, maxTs: 0, level, index: '' })
    const files = [
      f('L0-pool_0-900-10-12-aaaaaaaa.parquet'),
      f('L0-pool_0-900-2-9-bbbbbbbb.parquet'),
      f('L0-pool_0-1000-1-1-cccccccc.parquet'),
      f('L0-pool_0-900-1-1-dddddddd.parquet'),
      f('L1-h05-0123456789abcdef-eeeeeeee.parquet', 1),
      f('L2-d-0123456789abcdef-ffffffff.parquet', 2),
      f('L0-pool_1-5-100-100-99999999.parquet'),
      f('L0-my-odd-shard-name-7-3-4-11111111.parquet'),
    ]
    expect(byPrecedence(files).map((x) => x.key.split('/').pop())).toEqual([
      'L2-d-0123456789abcdef-ffffffff.parquet',
      'L1-h05-0123456789abcdef-eeeeeeee.parquet',
      'L0-my-odd-shard-name-7-3-4-11111111.parquet',
      'L0-pool_0-900-1-1-dddddddd.parquet',
      'L0-pool_0-900-2-9-bbbbbbbb.parquet',
      'L0-pool_0-900-10-12-aaaaaaaa.parquet',
      'L0-pool_0-1000-1-1-cccccccc.parquet',
      'L0-pool_1-5-100-100-99999999.parquet',
    ])
    expect(byPrecedence([])).toEqual([])
  })
})

describe('a leaf', () => {
  it('reads whole objects and ranges, says missing for an absent key, and refuses a seventh read', async () => {
    const key = `leaf-test/${crypto.randomUUID()}-00000000.parquet`
    const bytes = crypto.getRandomValues(new Uint8Array(5000))
    await env.BUCKET.put(key, bytes)
    const l = leaf(0)
    const answer = await l.read([{ key }, { key, offset: 100, length: 50 }, { key: `${key}.nope` }, { key, offset: 4990 }], 0)
    const out = answer.status === 'ok' ? answer.results : []
    expect(out.map((r) => r.status)).toEqual(['ok', 'ok', 'missing', 'ok'])
    const got = out.map((r) => (r.status === 'ok' ? Array.from(r.bytes) : null))
    expect(got[0]).toEqual(Array.from(bytes))
    expect(got[1]).toEqual(Array.from(bytes.subarray(100, 150)))
    expect(got[3]).toEqual(Array.from(bytes.subarray(4990)))
    const seven: ReadItem[] = Array.from({ length: MAX_READS_PER_CALL + 1 }, () => ({ key }))
    expect(await l.read(seven, 0)).toEqual({ status: 'refused', reason: '7 reads in one call; the limit is 6' })
    expect(await l.read(seven.slice(0, 6), 0)).toMatchObject({ status: 'ok', results: { length: 6 } })
    expect(await l.read([], 0)).toEqual({ status: 'ok', results: [] })
  })

  it('caches by object key with a bounded lifetime; a ttl of 0 neither reads nor fills the cache', async () => {
    const key = `leaf-test/${crypto.randomUUID()}-11111111.parquet`
    await env.BUCKET.put(key, new Uint8Array([1, 2, 3, 4]))
    const read = async (n: number, items: ReadItem[], ttl: number) => {
      const a = await leaf(n).read(items, ttl)
      return a.status === 'ok' ? a.results : []
    }
    expect(await read(1, [{ key }], 0)).toMatchObject([{ cached: false }])
    expect(await fileCache().match(cacheUrl({ key }))).toBeUndefined()
    expect(await read(1, [{ key }], 600)).toMatchObject([{ cached: false }])
    const hit = await fileCache().match(cacheUrl({ key }))
    expect(hit?.headers.get('Cache-Control')).toBe('public, max-age=600')
    // Another leaf gets the hit: the cache belongs to the location, not to the object.
    const again = await read(2, [{ key }, { key, offset: 1, length: 2 }], 600)
    expect(again.map((r) => r.status === 'ok' && [r.cached, Array.from(r.bytes)])).toEqual([[true, [1, 2, 3, 4]], [false, [2, 3]]])
    // A range is cached under its own key, never under the whole object's.
    expect(cacheUrl({ key, offset: 1, length: 2 })).not.toBe(cacheUrl({ key }))
    expect(await read(3, [{ key, offset: 1, length: 2 }], 600)).toMatchObject([{ cached: true }])
    // The cache key is the whole object key: tenant, day and content hash included.
    const k = 'cell-0/data/metric_samples/tenant=t1/day=2026-11-18/L0-s_0-5-1-2-abcdef12.parquet'
    for (const part of ['tenant%3Dt1', 'day%3D2026-11-18', 'L0-s_0-5-1-2-abcdef12.parquet']) expect(cacheUrl({ key: k })).toContain(part)
    expect(cacheUrl({ key: k })).not.toBe(cacheUrl({ key: k.replace('tenant=t1', 'tenant=t2') }))
    expect(cacheUrl({ key: k })).not.toBe(cacheUrl({ key: k.replace('abcdef12', 'abcdef13') }))
  })
})

describe('many files', () => {
  let w: World
  let units = 0
  beforeAll(async () => {
    w = await world()
    units = await ingestInManyFiles(w, w.a)
    await discardAll(w)
  })

  it('a query over many files reads them in rounds of at most six per leaf, and the whole table still equals the reference', async () => {
    const plan = await ledgerOf(w.a).plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
    expect(units).toBeGreaterThanOrEqual(15)
    expect(plan.files.length).toBeGreaterThanOrEqual(units)
    const calls: number[] = []
    hooks.beforeLeafCall = async (_leaf, items) => {
      calls.push(items.length)
    }
    const everything = await api(w.a.key, '/api/v1/query_range', { query: 'count({__name__=~".+"})', start: sec(workload.t0), end: sec(END), step: '60' })
    expect(everything.status).toBe(200)
    const files = cost(everything, 'Files-Read')
    expect(files).toBeGreaterThan(POOL * MAX_READS_PER_CALL / 2)
    expect(Math.max(...calls)).toBeLessThanOrEqual(MAX_READS_PER_CALL)
    expect(calls.reduce((a, b) => a + b, 0)).toBe(files)
    expect(cost(everything, 'Leaf-Rounds')).toBe(Math.ceil(files / (POOL * MAX_READS_PER_CALL)))
    expect(cost(everything, 'Leaves-Used')).toBeGreaterThan(POOL / 2)
    expect(cost(everything, 'Leaf-Calls')).toBe(calls.length)
    delete hooks.beforeLeafCall
    for (const q of QUERIES) expect(await (await run(w.a.key, q)).json(), q.id).toEqual(expected.a[q.id])
  })

  it('files are skipped by time and by metric name from their index fragments, and skipping never changes a result', async () => {
    // By name: every file of the first request holds one metric name.
    const up = await run(w.a.key, QUERIES.find((q) => q.id === 'sel-name')!)
    expect(await up.json()).toEqual(expected.a['sel-name'])
    expect(cost(up, 'Files-Skipped')).toBeGreaterThan(10)
    expect(cost(up, 'Files-Read') + cost(up, 'Files-Skipped')).toBe(cost(up, 'Files-Listed'))
    // A regex on the name prunes nothing by name.
    const re = await api(w.a.key, '/api/v1/query_range', { query: '{__name__=~"up"}', start: sec(END - 1_200_000), end: sec(END), step: '30' })
    expect(await re.text()).toBe(await (await run(w.a.key, QUERIES.find((q) => q.id === 'sel-name')!)).text())
    expect(cost(re, 'Files-Read')).toBeGreaterThan(cost(up, 'Files-Read'))
    // By time. The ledger lists only files that overlap the hull of the query's ranges; a
    // query with two ranges far apart lists the files in between, and the index skips them.
    const late = await api(w.a.key, '/api/v1/query', { query: 'count({__name__=~".+"})', time: sec(END) })
    const two = await api(w.a.key, '/api/v1/query', { query: 'count({__name__=~".+"}) + count({__name__=~".+"} offset 24m)', time: sec(END) })
    const count = async (time: number): Promise<number> => Number((await (await api(w.a.key, '/api/v1/query', { query: 'count({__name__=~".+"})', time: sec(time) })).json<{ data: { result: { value: [number, string] }[] } }>()).data.result[0]!.value[1])
    expect(await two.json()).toMatchObject({ data: { result: [{ value: [END / 1000, String((await count(END)) + (await count(END - 24 * 60_000)))] }] } })
    expect(cost(late, 'Files-Listed')).toBeLessThan(cost(two, 'Files-Listed'))
    expect(cost(two, 'Files-Skipped')).toBeGreaterThan(0)
    expect(cost(two, 'Files-Read')).toBeLessThan(cost(two, 'Files-Listed'))
    // A name no file can hold: nothing is read at all, and the answer is still right (empty).
    const none = await api(w.a.key, '/api/v1/query_range', { query: 'zzz_no_such_metric', start: sec(workload.t0), end: sec(END), step: '30' })
    expect(await none.json()).toEqual({ status: 'success', data: { resultType: 'matrix', result: [] } })
    expect(cost(none, 'Files-Listed')).toBeGreaterThan(30)
    expect([cost(none, 'Files-Read'), cost(none, 'Leaf-Calls')]).toEqual([0, 0])
    // A name inside some files' [min, max] that no file holds: those files are read (statistics are a range).
    const inside = await run(w.a.key, QUERIES.find((q) => q.id === 'sel-none')!)
    expect(await inside.json()).toEqual(expected.a['sel-none'])
    expect(cost(inside, 'Files-Read')).toBeGreaterThan(0)
    expect(cost(inside, 'Files-Skipped')).toBeGreaterThan(10)
    // The whole table with pruning in force was checked against the reference above; the
    // samples a query scans are bounded by what the index said.
    for (const q of QUERIES.filter((x) => expected.a[x.id]!.status === 'success').slice(0, 20)) {
      const res = await run(w.a.key, q)
      expect(cost(res, 'Samples-Loaded'), q.id).toBeLessThanOrEqual(cost(res, 'Scan-Samples'))
    }
  })

  it('reading every file in small ranges (the path for objects above 16 MiB) gives identical results', async () => {
    const whole = new Map<string, string>()
    for (const q of QUERIES.slice(0, 15)) whole.set(q.id, await (await run(w.a.key, q)).text())
    hooks.maxPartBytes = 700
    const sizes: number[] = []
    hooks.beforeLeafCall = async (_leaf, items) => {
      sizes.push(items.length)
      for (const i of items) expect(i.length ?? 0).toBeLessThanOrEqual(700)
    }
    for (const q of QUERIES.slice(0, 15)) {
      const res = await run(w.a.key, q)
      expect(await res.text(), q.id).toBe(whole.get(q.id))
    }
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_READS_PER_CALL)
    expect(sizes.length).toBeGreaterThan(30)
  })

  it('every cached file sits under its own content-hashed object key, and hits are counted', async () => {
    const q = QUERIES.find((x) => x.id === 'rate-sum-by')!
    const first = await run(w.a.key, q)
    const second = await run(w.a.key, q)
    expect(await second.json()).toEqual(expected.a[q.id])
    expect(cost(second, 'Cache-Hits')).toBe(cost(second, 'Files-Read'))
    expect(cost(second, 'R2-Gets')).toBe(0)
    expect(cost(first, 'Cache-Hits') + cost(first, 'R2-Gets')).toBe(cost(first, 'Files-Read'))
    for (const table of ['metric_samples', 'metric_series'] as const) {
      const plan = await ledgerOf(w.a).plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
      let checked = 0
      for (const f of plan.files) {
        const hit = await fileCache().match(cacheUrl({ key: f.key }))
        if (!hit) continue // not every file was needed by a query yet
        const bytes = await hit.arrayBuffer()
        const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('')
        expect(f.key.endsWith(`-${sha.slice(0, 8)}.parquet`), f.key).toBe(true)
        expect(bytes.byteLength).toBe(f.bytes)
        checked++
      }
      expect(checked).toBeGreaterThan(5)
    }
  })
})
