/**
 * The label endpoints over leaves and Prometheus' `limit` (CARDINALITY.md "What is left" 3;
 * 2026-11-19). The properties:
 *
 *   - Over any number of parts, every label call answers byte for byte what one place
 *     answers, with the rows in the tails, in lake and tail, and in the lake; also when it
 *     goes over leaves by itself (series files over `maxFetchBytes`), and when the tail does
 *     not fit the coordinator and the parts read the rest themselves.
 *   - The cap on series listed counts distinct series over all parts and all waves.
 *   - Names and values sort by code point (UTF-8 bytes), as the engine sorts, not by UTF-16.
 *   - `limit` keeps the first `limit` items (series of a query) and says so in `warnings`;
 *     a bad `limit` is 400 naming the parameter.
 */
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type TenantLimits, clearLimitsCache } from '../src/config'
import { fileCache, cacheUrl, leafHooks } from '../src/leaf'
import { hooks } from '../src/coordinator'
import { limitResult } from '../src/index'
import { byCodePoint } from '../src/meta'
import { QUERIES, type Tenant, type World, api, cost, discardAll, flushAll, ingest, ledgerOf, run, sealAll, workload, world, write } from './world'

const sec = (ms: number): string => String(ms / 1000)
const [LO, HI] = [workload.t0 + 72 * 15_000, workload.t0 + 90 * 15_000]
const win: [string, string][] = [['start', sec(LO)], ['end', sec(HI)]]

/** Label calls as clients make them (Grafana's variables among them). */
const CALLS: [string, [string, string][]][] = [
  ['/api/v1/labels', []],
  ['/api/v1/labels', [['match[]', 'temperature'], ['match[]', 'http_request_duration_seconds_bucket']]],
  ['/api/v1/labels', win],
  ['/api/v1/label/__name__/values', []],
  ['/api/v1/label/instance/values', [['match[]', 'up']]],
  ['/api/v1/label/instance/values', [['match[]', 'up{job="web"}'], ...win]],
  ['/api/v1/label/job/values', [['match[]', 'http_requests_total'], ['match[]', 'up']]],
  ['/api/v1/label/owner/values', []],
  ['/api/v1/series', [['match[]', 'up']]],
  ['/api/v1/series', [['match[]', 'temperature'], ['match[]', 'shared_metric']]],
  ['/api/v1/series', [['match[]', 'up'], ...win]],
  ['/api/v1/series', [['match[]', '{__name__=~".+"}']]],
]

async function setLimits(t: Tenant, limits: Partial<TenantLimits> | null): Promise<void> {
  if (limits === null) await env.CONFIG.delete(`limits:${t.name}`)
  else await env.CONFIG.put(`limits:${t.name}`, JSON.stringify(limits))
  clearLimitsCache()
}

afterEach(() => {
  delete hooks.forceLeaves
  delete hooks.tailCap
  delete leafHooks.ignoreTailParts
})

/** Every call once in one place, then over each number of parts: identical bodies. Returns how many went over leaves. */
async function compare(w: World, moment: string, leaves: number[]): Promise<number> {
  let split = 0
  for (const t of [w.a, w.b]) {
    for (const [path, params] of CALLS) {
      delete hooks.forceLeaves
      const one = await api(t.key, path, params)
      const want = await one.text()
      expect(one.status, `${moment} ${path} ${want}`).toBe(200)
      expect(one.headers.get('X-Viz-Execution'), `${moment} ${path}`).toBe('single')
      for (const n of leaves) {
        hooks.forceLeaves = n
        const res = await api(t.key, path, params)
        expect(await res.text(), `${moment}: ${t.which} ${path}?${new URLSearchParams(params)} over ${n}`).toBe(want)
        if (res.headers.get('X-Viz-Execution') === 'split') split++
        expect(cost(res, 'Samples-Loaded')).toBe(0)
      }
    }
  }
  return split
}

describe('label endpoints over leaves', () => {
  let w: World
  beforeAll(async () => {
    w = await world()
    await ingest(w)
  }, 300_000)

  it('every label call over 1, 2, 3 and 7 parts answers what one place answers, at the three moments', async () => {
    expect(await compare(w, 'all tail', [1, 2, 3, 7])).toBe(2 * CALLS.length * 4)
    await flushAll(w)
    expect(await compare(w, 'lake + tail', [2, 7])).toBe(2 * CALLS.length * 2)
    await sealAll(w)
    await flushAll(w)
    await discardAll(w)
    expect(await compare(w, 'all lake', [2, 3, 7])).toBe(2 * CALLS.length * 3)
  }, 900_000)

  it('by itself when the series files pass maxFetchBytes: over leaves, each listing in waves, the one-place answer', async () => {
    let split = 0
    for (const [path, params] of CALLS) {
      await setLimits(w.a, null)
      const one = await api(w.a.key, path, params)
      const want = await one.text()
      const bytes = cost(one, 'Bytes-Read')
      if (bytes < 2) continue
      // One byte less than one place reads: refused before; now each part reads in waves of half of it.
      await setLimits(w.a, { maxFetchBytes: bytes - 1 })
      const res = await api(w.a.key, path, params)
      const body = await res.text()
      if (res.status === 422) {
        // Only if one file's part alone is over the cap (a file is never cut): said so.
        expect(JSON.parse(body).error, path).toMatch(/^query exceeded limit max_fetch_bytes: the series files and unflushed tail of one of \d+ parts is at least \d+ bytes/)
        continue
      }
      expect(body, `${path}?${new URLSearchParams(params)}`).toBe(want)
      expect(res.headers.get('X-Viz-Execution')).toBe('split')
      split++
    }
    expect(split).toBeGreaterThanOrEqual(CALLS.length / 2)
    await setLimits(w.a, null)
  }, 600_000)

  it('the cap on series listed counts distinct series over every part and every wave', async () => {
    const params: [string, string][] = [['match[]', '{__name__=~".+"}']]
    const all = await api(w.a.key, '/api/v1/series', params)
    const n = (await all.json<{ data: unknown[] }>()).data.length
    const bytes = cost(all, 'Bytes-Read')
    expect(n).toBeGreaterThan(10)
    for (const leaves of [undefined, 2, 5]) {
      if (leaves) hooks.forceLeaves = leaves
      else delete hooks.forceLeaves
      // A cap under the series files: over leaves by itself, each part listing in several
      // waves of files, and a series in many files (and waves) counts once.
      await setLimits(w.a, { maxMetadataSeries: n, maxFetchBytes: bytes - 1 })
      const at = await api(w.a.key, '/api/v1/series', params)
      expect([at.headers.get('X-Viz-Execution'), at.status]).toEqual(['split', 200])
      expect((await api(w.a.key, '/api/v1/label/instance/values', params)).status, `${leaves} at the cap`).toBe(200)
      expect((await api(w.a.key, '/api/v1/series', params)).status).toBe(200)
      await setLimits(w.a, { maxMetadataSeries: n - 1, maxFetchBytes: bytes - 1 })
      for (const path of ['/api/v1/series', '/api/v1/label/instance/values', '/api/v1/labels']) {
        const res = await api(w.a.key, path, params)
        const body = await res.json<{ errorType: string; error: string; data?: unknown }>()
        expect([path, leaves, res.status, body.errorType, body.data]).toEqual([path, leaves, 422, 'execution', undefined])
        expect(body.error).toMatch(new RegExp(`^query exceeded limit max_series: \\d+ series listed, the limit is ${n - 1}$`))
      }
    }
    await setLimits(w.a, null)
  }, 600_000)

  it('`limit`: the first items of the sorted list, a warning when cut, none when not; 400 for a bad one', async () => {
    for (const leaves of [undefined, 3]) {
      if (leaves) hooks.forceLeaves = leaves
      else delete hooks.forceLeaves
      for (const [path, params] of CALLS) {
        const full = (await (await api(w.a.key, path, params)).json<{ data: unknown[] }>()).data
        for (const limit of [1, 2, full.length, full.length + 1, 0]) {
          const res = await api(w.a.key, path, [...params, ['limit', String(limit)]])
          const body = await res.json<{ status: string; data: unknown[]; warnings?: string[] }>()
          const cut = limit > 0 && full.length > limit
          expect([path, limit, body.status, body.data, body.warnings]).toEqual([path, limit, 'success', cut ? full.slice(0, limit) : full, cut ? ['results truncated due to limit'] : undefined])
        }
      }
    }
    for (const bad of ['-1', 'x', '1.5', '99999999999999999999']) {
      const res = await api(w.a.key, '/api/v1/labels', { limit: bad })
      const body = await res.json<{ errorType: string; error: string }>()
      expect([bad, res.status, body.errorType]).toEqual([bad, 400, 'bad_data'])
      expect(body.error).toMatch(/^invalid parameter "limit": /)
    }
    expect((await (await api(w.a.key, '/api/v1/labels', { limit: '-1' })).json<{ error: string }>()).error).toBe('invalid parameter "limit": limit must be non-negative')
  }, 600_000)

  it('`limit` on queries: matrices and vectors keep their first series, with the warning; scalars and strings are untouched', async () => {
    let cutSome = 0
    for (const q of QUERIES) {
      const res = await run(w.a.key, q)
      const full = await res.json<{ status: string; data?: { resultType: string; result: unknown } }>()
      if (full.status !== 'success') continue
      const series = Array.isArray(full.data!.result) && (full.data!.resultType === 'matrix' || full.data!.resultType === 'vector')
      const params: Record<string, string> = q.kind === 'range' ? { query: q.query, start: sec(q.start!), end: sec(q.end!), step: sec(q.step!), limit: '2' } : { query: q.query, time: sec(q.time!), limit: '2' }
      const limited = await api(w.a.key, q.kind === 'range' ? '/api/v1/query_range' : '/api/v1/query', params)
      const body = await limited.json<{ data: { resultType: string; result: unknown[] }; warnings?: string[] }>()
      if (series && (full.data!.result as unknown[]).length > 2) {
        cutSome++
        expect([q.id, body.data.result, body.warnings]).toEqual([q.id, (full.data!.result as unknown[]).slice(0, 2), ['results truncated due to limit']])
      } else expect([q.id, body.data, body.warnings]).toEqual([q.id, full.data, undefined])
    }
    expect(cutSome).toBeGreaterThan(5)
    const res = await api(w.a.key, '/api/v1/query', { query: 'up', limit: 'nope' })
    expect(res.status).toBe(400)
  }, 600_000)
})

describe('limitResult (the text of a query result cut between series)', () => {
  it('cuts after the limit-th series whatever the strings hold, and leaves the rest of the text as it was', () => {
    const c = { warnings: [] as string[] } as unknown as Parameters<typeof limitResult>[0]
    const series = [
      '{"metric":{"a":"x]y}","b":"\\"q\\""},"values":[[1,"1"],[2,"NaN"]]}',
      '{"metric":{"[":"{"},"values":[[1,"+Inf"]]}',
      '{"metric":{},"values":[]}',
    ]
    const data = `{"resultType":"matrix","result":[${series.join(',')}]}`
    for (const n of [1, 2]) {
      const out = limitResult(c, data, n)
      expect(out).toBe(`{"resultType":"matrix","result":[${series.slice(0, n).join(',')}]}`)
      expect(JSON.parse(out).result).toEqual(JSON.parse(data).result.slice(0, n))
    }
    for (const n of [0, 3, 4]) expect(limitResult(c, data, n)).toBe(data)
    for (const other of ['{"resultType":"scalar","result":[1,"2"]}', '{"resultType":"string","result":[1,"a]b"]}', '{"resultType":"vector","result":[]}']) expect(limitResult(c, other, 1)).toBe(other)
    expect((c as unknown as { warnings: string[] }).warnings).toEqual(['results truncated due to limit', 'results truncated due to limit'])
  })
})

describe('label endpoints over leaves: the tail, files, tenants, order', () => {
  it('a tail too large for the coordinator: the parts read the rest, the one-place answer; a previous-release leaf is 503', async () => {
    const w = await world()
    await ingest(w)
    let viaLeaves = 0
    for (const [path, params] of CALLS) {
      const want = await (await api(w.a.key, path, params)).text()
      for (const cap of [1, 300]) {
        hooks.tailCap = cap
        const res = await api(w.a.key, path, params)
        expect(await res.text(), `${path}?${new URLSearchParams(params)} cap ${cap}`).toBe(want)
        if (res.headers.get('X-Viz-Tail-Mode') === 'filtered+leaves') viaLeaves++
      }
      delete hooks.tailCap
    }
    expect(viaLeaves).toBeGreaterThan(CALLS.length)
    hooks.tailCap = 1
    leafHooks.ignoreTailParts = true
    const res = await api(w.a.key, '/api/v1/labels', [])
    expect([res.status, (await res.json<{ errorType: string }>()).errorType]).toEqual([503, 'unavailable'])
  }, 600_000)

  it('a series file missing from R2 sends the call back to the ledger; never a listing without it', async () => {
    const w = await world()
    await ingest(w)
    await sealAll(w)
    await flushAll(w)
    await discardAll(w)
    hooks.forceLeaves = 3
    const plan = await ledgerOf(w.a).plan({ table: 'metric_series', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
    const victim = plan.files[0]!.key
    const obj = await env.BUCKET.get(victim)
    const bytes = new Uint8Array(await obj!.arrayBuffer())
    // Nothing has read the new world's files yet, so no copy of the victim is in the Cache API.
    await env.BUCKET.delete(victim)
    await fileCache().delete(cacheUrl({ key: victim }))
    try {
      const res = await api(w.a.key, '/api/v1/label/__name__/values')
      const body = await res.json<{ errorType?: string; data?: unknown }>()
      expect([res.status, body.errorType, body.data, cost(res, 'Plan-Attempts')]).toEqual([503, 'unavailable', undefined, 4])
    } finally {
      await env.BUCKET.put(victim, bytes)
    }
    const back = await (await api(w.a.key, '/api/v1/label/__name__/values')).text()
    delete hooks.forceLeaves
    expect(back).toBe(await (await api(w.a.key, '/api/v1/label/__name__/values')).text())
    expect(JSON.parse(back).data.length).toBeGreaterThan(3)
  }, 300_000)

  it('names and values sort by code point, as the engine does, over leaves too; tenants stay apart', async () => {
    const w = await world()
    const at = workload.t0
    const values = ['a', 'z', 'é', '', '�', '\u{1F600}', '\u{10FFFF}', 'Z', '0']
    await write(w.a, values.map((v, i) => ({ labels: { __name__: 'cp', v, i: String(i) }, samples: [[at, i] as [number, number]] })))
    await write(w.b, [{ labels: { __name__: 'cp', v: 'secret-b', i: '0' }, samples: [[at, 1] as [number, number]] }])
    const one = await api(w.a.key, '/api/v1/label/v/values')
    const want = await one.text()
    const got = (JSON.parse(want) as { data: string[] }).data
    // Code-point order is UTF-8 byte order.
    const te = new TextEncoder()
    const bytesOrder = (x: string, y: string): number => {
      const [a, b] = [te.encode(x), te.encode(y)]
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!
      return a.length - b.length
    }
    const utf8 = [...values].sort(bytesOrder)
    // JavaScript's own order differs for these (U+E000 and U+FFFD after the surrogates of U+1F600).
    expect([...values].sort()).not.toEqual(utf8)
    expect(got).toEqual(utf8)
    expect([...values].sort(byCodePoint)).toEqual(utf8)
    for (const n of [2, 3, 5]) {
      hooks.forceLeaves = n
      expect(await (await api(w.a.key, '/api/v1/label/v/values')).text(), `${n}`).toBe(want)
      expect(await (await api(w.a.key, '/api/v1/series', [['match[]', 'cp']])).text()).toBe(await (async () => {
        delete hooks.forceLeaves
        const t = await (await api(w.a.key, '/api/v1/series', [['match[]', 'cp']])).text()
        hooks.forceLeaves = n
        return t
      })())
      const b = await api(w.b.key, '/api/v1/label/v/values')
      expect((await b.json<{ data: string[] }>()).data).toEqual(['secret-b'])
      const leak = await (await api(w.a.key, '/api/v1/label/v/values')).text()
      expect(leak).not.toContain('secret-b')
    }
  }, 300_000)
})
