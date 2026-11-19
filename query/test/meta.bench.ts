/**
 * Local measurement of the label endpoints over leaves (CARDINALITY.md "What is left" 3):
 * `npm run measure -- test/meta.bench.ts`.
 *
 *   C   150,000 series of one metric (`mb_requests_total{job, instance}`, 20 jobs) at 60 s for
 *       an hour, flushed in ten-minute units on two shards: about 20 MiB of series files in
 *       the hour, over `maxFetchBytes` (16 MiB).
 *   D   100,000 series, ten minutes flushed and seven in the tails, one request a minute
 *       (about 68 MiB of tail; `tail.bench.ts` dataset B).
 *
 * Both ways on the same data, three calls each: before = one place (`maxFetchBytes` raised to
 * 64 MiB so that it answers at all, and with the default limits, as a tenant saw it); after =
 * this release with the default limits (over leaves by itself). Bodies must be identical.
 * LOCAL: workerd on this machine, R2 and the objects in one process; times say how much work is
 * done, not what Cloudflare takes.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { clearLimitsCache } from '../src/config'
import { engine } from '../src/index'
import { tailHooks } from '../src/tail'
import { Bulk, JOBS } from './bulk'
import { type Tenant, type World, api, cost, discardAll, flushAll, sealAll, world, write } from './world'

const END = Date.UTC(2026, 10, 18, 12)
const HOUR = 3_600_000
const sec = (ms: number): string => String(ms / 1000)
const mib = (b: number): string => (b / 2 ** 20).toFixed(2)

const labelsOf = (name: string) => (i: number): Record<string, string> => ({
  __name__: name,
  job: `job-${String(i % JOBS).padStart(2, '0')}`,
  instance: `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}:9100`,
})

async function setLimits(t: Tenant, limits: Record<string, number>): Promise<void> {
  await env.CONFIG.put(`limits:${t.name}`, JSON.stringify({ timeoutMs: 600_000, ...limits }))
  clearLimitsCache()
}

async function three(label: string, t: Tenant, path: string, params: [string, string][]): Promise<{ status: number; body: string }> {
  const wall: number[] = []
  let last: { res: Response; body: string } | null = null
  for (let i = 0; i < 3; i++) {
    engine.reset()
    const t0 = performance.now()
    const res = await api(t.key, path, params)
    const body = await res.text()
    wall.push(performance.now() - t0)
    if (last && body !== last.body) throw new Error(`${label}: run ${i} answered differently`)
    last = { res, body }
  }
  const { res, body } = last!
  const n = (h: string) => cost(res, h)
  const err = res.status === 200 ? '' : ` ${(JSON.parse(body) as { error: string }).error.slice(0, 150)}`
  const median = [...wall].sort((a, b) => a - b)[1]!
  console.log(
    `MEASURE ${label} (local): HTTP ${res.status}${err} | wall ${wall.map((x) => x.toFixed(0)).join(' / ')} ms (median ${median.toFixed(0)}) | engine ${n('Engine-Ms')} ms, coordinator WASM ${mib(n('Wasm-Memory-Bytes'))} MiB | ` +
      `${res.headers.get('X-Viz-Execution') || '-'}${n('Split-Leaves') ? ` over ${n('Split-Leaves')} parts` : ''} | files ${n('Files-Read')}, ${mib(n('Bytes-Read'))} MiB read, R2 ${n('R2-Gets')} + cache ${n('Cache-Hits')} | ` +
      `tail ${res.headers.get('X-Viz-Tail-Mode') || '-'} ${mib(n('Tail-Bytes'))} MiB, ${n('Shard-Calls')} shard calls | leaf calls ${n('Leaf-Calls')}, RPC ${mib(n('Rpc-Bytes'))} MiB | series estimate ${n('Series-Estimate')} | response ${body.length} B`,
  )
  return { status: res.status, body }
}

async function compare(name: string, t: Tenant, calls: [string, string, [string, string][]][]): Promise<void> {
  for (const [what, path, params] of calls) {
    tailHooks.previousRelease = () => true
    await setLimits(t, {})
    const refused = await three(`${name} BEFORE (one place as before: previous-release shards, default limits): ${what}`, t, path, params)
    await setLimits(t, { maxFetchBytes: 64 << 20 })
    const before = await three(`${name} BEFORE (one place, maxFetchBytes 64 MiB): ${what}`, t, path, params)
    delete tailHooks.previousRelease
    await setLimits(t, {})
    const after = await three(`${name} AFTER (default limits): ${what}`, t, path, params)
    if (before.status === 200 && after.status === 200) expect(after.body, what).toBe(before.body)
    console.log(`MEASURE   ${before.status === 200 && after.status === 200 ? 'identical bodies' : 'not both answered'}; before with the default limits: HTTP ${refused.status}`)
  }
}

describe('label endpoints over leaves (local)', () => {
  it('C: 150,000 series over an hour, about 20 MiB of series files', async () => {
    const w: World = await world()
    const t = w.a
    const M = 'mb_requests_total'
    await setLimits(t, {})
    const t0 = performance.now()
    const bulk = new Bulk(END - HOUR + 60_000, 60_000, 150_000, labelsOf(M))
    while (bulk.nextTs <= END) {
      await write(t, bulk.series(Math.min(10, (END - bulk.nextTs) / 60_000 + 1)))
      await sealAll(w, [t])
      await flushAll(w, [t])
      await discardAll(w)
    }
    console.log(`MEASURE dataset C: 150000 series (${M}, 60 s), one hour flushed in ten-minute units on 2 shards; loading took ${((performance.now() - t0) / 1000).toFixed(0)} s`)
    await api(t.key, '/api/v1/query', { query: '1 + 1', time: sec(END) })
    const win: [string, string][] = [['start', sec(END - HOUR)], ['end', sec(END)]]
    await compare('C', t, [
      ['/label/job/values?match[]=m, 1 h', '/api/v1/label/job/values', [['match[]', M], ...win]],
      ['/label/instance/values?match[]=m, 1 h (150,000 values)', '/api/v1/label/instance/values', [['match[]', M], ...win]],
      ['/label/instance/values?match[]=m&limit=100, 1 h', '/api/v1/label/instance/values', [['match[]', M], ['limit', '100'], ...win]],
      ['/labels?match[]=m, 1 h', '/api/v1/labels', [['match[]', M], ...win]],
      ['/series?match[]=m{job="job-07"}, 1 h (7,500 series)', '/api/v1/series', [['match[]', `${M}{job="job-07"}`], ...win]],
    ])
  }, 1_800_000)

  it('D: 100,000 series, about 68 MiB unflushed', async () => {
    const w: World = await world()
    const t = w.a
    const M = 'md_requests_total'
    for (const s of w.shards) await env.SHARD.get(env.SHARD.idFromName(s)).configure({ tenantMaxBytes: 256 << 20 })
    await setLimits(t, {})
    const t0 = performance.now()
    const bulk = new Bulk(END - 17 * 60_000 + 60_000, 60_000, 100_000, labelsOf(M))
    await write(t, bulk.series(10))
    await sealAll(w, [t])
    await flushAll(w, [t])
    await discardAll(w)
    for (let k = 0; k < 7; k++) await write(t, bulk.series(1))
    console.log(`MEASURE dataset D: 100000 series (${M}, 60 s), 10 minutes flushed + 7 minutes in the tails, one request a minute; loading took ${((performance.now() - t0) / 1000).toFixed(0)} s`)
    await api(t.key, '/api/v1/query', { query: '1 + 1', time: sec(END) })
    const win: [string, string][] = [['start', sec(END - 15 * 60_000)], ['end', sec(END)]]
    await compare('D', t, [
      ['/label/job/values?match[]=m, 15 min', '/api/v1/label/job/values', [['match[]', M], ...win]],
      ['/labels?match[]=m, 15 min', '/api/v1/labels', [['match[]', M], ...win]],
    ])
  }, 1_800_000)
})
