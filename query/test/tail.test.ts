/**
 * Tail reads filtered and paged (D48; CARDINALITY.md "What is left" 1), through the whole
 * read path. The properties:
 *
 *   - Every answer is the same whether the shards filter and page (this release) or answer
 *     with their whole tail (the previous release), or one of each (contracts/COMPATIBILITY.md:
 *     N and N-1 side by side), and equal to the reference.
 *   - Pages are followed to the end; a refusal on ANY page sends the query back to the ledger
 *     (or fails it, past the bound), never a partial answer; a status this release does not
 *     act on is a retryable 503.
 *   - A tail over the byte cap is refused naming `max_fetch_bytes`, unless the query
 *     decomposes over a key the shards can cut: then each split part reads the rest of the
 *     tail in its own key range, and the answer is the one-place answer, byte for byte.
 *   - A leaf of the previous release (it ignores the rest it was given) and a series whose
 *     split key is not its id make the query fail closed.
 */
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { compileFilter, filterBatch, type TailFilter } from '../../shard/src/tail'
import { encodeBatch, type Row } from '../../engine/wasm/test/vzb1'
import { type TenantLimits, clearLimitsCache } from '../src/config'
import { hooks } from '../src/coordinator'
import { leafHooks } from '../src/leaf'
import { seriesIdsOf, tailEstimate, tailFilter, tailHooks, type TailRead } from '../src/tail'
import { QUERIES, type Query, type Tenant, type World, api, cost, expected, ingest, run, shardOf, workload, world, write } from './world'

const sec = (ms: number): string => String(ms / 1000)
const rateSumBy = QUERIES.find((q) => q.id === 'rate-sum-by')!

/** Aggregations whose split key the shards can cut (`without` at most `__type__`, `__unit__`), and some they cannot. */
const AGG = [
  'sum(rate(http_requests_total[5m]))',
  'sum by (job, code) (increase(http_requests_total[2m]))',
  'avg by (job) (memory_bytes)',
  'count by (job) (http_requests_total)',
  'max(temperature)',
  'topk(3, rate(http_requests_total[5m]))',
  'count_values("value", up)',
  'sum(special)',
  'stddev(special)',
  'sum by (job) (rate(http_requests_total{code=~"5.."}[5m])) / sum by (job) (rate(http_requests_total[5m]))',
  'histogram_quantile(0.5, sum by (le) (increase(http_request_duration_seconds_bucket[5m])))',
  'sum(http_requests_total offset 5m)',
  'sum(shared_metric)',
  // Not cut by the shards: the key leaves out `instance` or `__name__`.
  'sum by (job) (label_replace(up, "instance", "all", "instance", ".*"))',
  'count({__name__=~"up|memory_bytes"})',
]
const extra: Query[] = AGG.flatMap((query, i) => [
  { id: `agg-${i}`, kind: 'range' as const, query, start: rateSumBy.start, end: rateSumBy.end, step: rateSumBy.step },
  { id: `agg-${i}-i`, kind: 'instant' as const, query, time: rateSumBy.end },
])

async function setLimits(t: Tenant, limits: Partial<TenantLimits> | null): Promise<void> {
  if (limits === null) await env.CONFIG.delete(`limits:${t.name}`)
  else await env.CONFIG.put(`limits:${t.name}`, JSON.stringify(limits))
  clearLimitsCache()
}

/** The label endpoints and the report, as a client calls them. */
const META: [string, [string, string][]][] = [
  ['/api/v1/labels', []],
  ['/api/v1/labels', [['match[]', 'temperature']]],
  ['/api/v1/label/__name__/values', []],
  ['/api/v1/label/instance/values', [['match[]', 'up{job="web"}']]],
  ['/api/v1/label/instance/values', [['match[]', 'up'], ['start', sec(workload.t0 + 72 * 15_000)], ['end', sec(workload.t0 + 90 * 15_000)]]],
  ['/api/v1/series', [['match[]', 'up'], ['match[]', 'temperature']]],
  ['/api/v1/status/tsdb', [['start', sec(workload.t0)], ['end', sec(workload.end)]]],
  ['/api/v1/status/cardinality', [['range', '1h'], ['end', sec(workload.end)]]],
]

afterEach(() => {
  delete hooks.alterTail
  delete hooks.tailCap
  delete hooks.forceLeaves
  delete hooks.afterPlan
  delete tailHooks.previousRelease
  delete tailHooks.alter
  delete leafHooks.ignoreTailParts
})

describe('tail reads (D48)', () => {
  let w: World
  beforeAll(async () => {
    w = await world()
    // Moment 1 of the invariance test: everything in the tails (one sealed segment, one not).
    await ingest(w)
  }, 300_000)

  it('the same answers from shards that filter and page, from shards of the previous release, and from one of each', async () => {
    const modes: [string, ((s: string) => boolean) | undefined][] = [
      ['filtered', undefined],
      ['previous', () => true],
      ['mixed', (s) => s === w.shards[0]],
    ]
    const bodies = new Map<string, string>()
    const bytes = new Map<string, number>()
    let smaller = 0
    for (const [mode, previous] of modes) {
      tailHooks.previousRelease = previous
      for (const t of [w.a, w.b]) {
        for (const q of QUERIES) {
          const res = await run(t.key, q)
          const body = await res.text()
          expect(JSON.parse(body), `${mode}: ${t.which} ${q.id}`).toEqual(expected[t.which][q.id])
          if (cost(res, 'Shards-Asked') > 0) expect(res.headers.get('X-Viz-Tail-Mode'), `${mode} ${q.id}`).toBe(mode === 'filtered' ? 'filtered' : 'unfiltered')
          const key = `${t.which}/${q.id}`
          if (mode === 'filtered') {
            bodies.set(key, body)
            bytes.set(key, cost(res, 'Tail-Bytes'))
          } else {
            expect(body, `${mode}: ${key}`).toBe(bodies.get(key))
            // A filter never keeps more than the whole tail.
            if (mode === 'previous') {
              expect(bytes.get(key)!, key).toBeLessThanOrEqual(cost(res, 'Tail-Bytes'))
              if (bytes.get(key)! < cost(res, 'Tail-Bytes')) smaller++
            }
          }
        }
        for (const [path, params] of META) {
          const res = await api(t.key, path, params)
          const body = await res.text()
          expect(res.status, `${mode} ${path}`).toBe(200)
          const key = `${t.which}/${path}?${new URLSearchParams(params)}`
          if (mode === 'filtered') bodies.set(key, body)
          else expect(body, `${mode}: ${key}`).toBe(bodies.get(key))
        }
      }
    }
    // Selective queries read less of the tail (by metric name and time).
    expect(smaller).toBeGreaterThan(QUERIES.length)
  }, 900_000)

  it('pages are followed to the end (a shard that examines one stored batch per call)', async () => {
    for (const s of w.shards) await shardOf(s).configure({ tailScanMaxBytes: 1 })
    try {
      for (const q of QUERIES.slice(0, 20)) {
        const res = await run(w.a.key, q)
        expect(await res.json(), q.id).toEqual(expected.a[q.id])
        if (cost(res, 'Shards-Asked') > 0) expect(cost(res, 'Shard-Calls'), q.id).toBeGreaterThan(cost(res, 'Shards-Asked'))
      }
      for (const [path, params] of META) expect((await api(w.a.key, path, params)).status, path).toBe(200)
    } finally {
      for (const s of w.shards) await shardOf(s).configure({ tailScanMaxBytes: 32 << 20 })
    }
  }, 600_000)

  it('a refusal on a later page sends the query back to the ledger; one that persists is 503; an unknown answer on any page is a retryable 503', async () => {
    for (const s of w.shards) await shardOf(s).configure({ tailScanMaxBytes: 1 })
    try {
      const q = rateSumBy
      // Once, on the second page of the first shard: re-planned, exact.
      let calls = 0
      hooks.alterTail = (shard, answer) => (shard === w.shards[0] && ++calls === 2 ? { status: 'stale_watermark', incarnation: 1, discardedThrough: 99 } : answer)
      let res = await run(w.a.key, q)
      expect(await res.json()).toEqual(expected.a[q.id])
      expect(cost(res, 'Plan-Attempts')).toBe(2)
      // On every second page: past the bound, 503 and no data.
      for (const refusal of [{ status: 'stale_watermark', incarnation: 1, discardedThrough: 99 }, { status: 'incarnation_mismatch', incarnation: 1 }]) {
        let n = 0
        hooks.alterTail = (shard, answer) => (shard === w.shards[0] && ++n % 2 === 0 ? refusal : answer)
        res = await run(w.a.key, q)
        const body = await res.json<{ errorType?: string; data?: unknown }>()
        expect([refusal.status, res.status, body.errorType, body.data]).toEqual([refusal.status, 503, 'unavailable', undefined])
      }
      // What this release does not act on, on a later page: 503 at once (not sent back to the ledger).
      const unknown = [
        { status: 'invalid', reason: 'the cursor belongs to another read' },
        { status: 'unsupported_version', version: 1, supported: 2 },
        { status: 'schema_too_new', component: 'shard.Shard', version: 9, compat: 9 },
        { status: 'ok', incarnation: 1, through: 9, batches: [], page: { v: 2, next: null, scannedBatches: 0, scannedBytes: 0 } },
        { status: 'ok', incarnation: 1, through: 9, batches: [] },
      ]
      for (const answer of unknown) {
        // The second page of a read (a call answered with `page`, after the first such answer).
        let pages = 0
        hooks.alterTail = (shard, a) => (shard === w.shards[0] && (a as { page?: unknown }).page !== undefined && ++pages === 2 ? answer : a)
        for (const path of ['/api/v1/query_range', '/api/v1/labels', '/api/v1/status/tsdb']) {
          pages = 0
          res = path === '/api/v1/query_range' ? await run(w.a.key, q) : await api(w.a.key, path, { start: sec(workload.t0), end: sec(workload.end) })
          const body = await res.json<{ errorType?: string; data?: unknown }>()
          expect([JSON.stringify(answer).slice(0, 40), path, res.status, body.errorType, body.data]).toEqual([JSON.stringify(answer).slice(0, 40), path, 503, 'unavailable', undefined])
          expect(cost(res, 'Plan-Attempts')).toBe(1)
        }
      }
    } finally {
      for (const s of w.shards) await shardOf(s).configure({ tailScanMaxBytes: 32 << 20 })
    }
  }, 600_000)

  it('a tail over the cap: refused naming max_fetch_bytes, or split with each part reading the rest of the tail in its key range, byte-identical to one place', async () => {
    // Not decomposable: refused, saying the tail is at least what was seen.
    hooks.tailCap = 1
    const rate = QUERIES.find((x) => x.id === 'rate')!
    let res = await run(w.a.key, rate)
    expect(res.status).toBe(422)
    expect((await res.json<{ error: string }>()).error).toMatch(/^query exceeded limit max_fetch_bytes: the data files in range plus the unflushed tail is at least \d+ bytes, the limit is \d+\. Narrow the time range/)
    delete hooks.tailCap
    let viaLeaves = 0
    for (const t of [w.a, w.b]) {
      for (const q of [...QUERIES, ...extra]) {
        const one = await run(t.key, q)
        const want = await one.text()
        const total = cost(one, 'Tail-Bytes')
        // Nothing read here (cap 1), part of it, and (with 3 leaves forced) part of it again.
        for (const [cap, leaves] of [[1, undefined], [Math.max(1, Math.floor(total / 2)), undefined], [Math.max(1, Math.floor(total / 3)), 3]] as [number, number | undefined][]) {
          hooks.tailCap = cap
          if (leaves) hooks.forceLeaves = leaves
          else delete hooks.forceLeaves
          res = await run(t.key, q)
          const body = await res.text()
          const mode = res.headers.get('X-Viz-Tail-Mode') ?? ''
          if (mode.endsWith('+leaves')) {
            viaLeaves++
            expect(body, `${t.which} ${q.id} (${q.query}), cap ${cap}`).toBe(want)
            expect(res.headers.get('X-Viz-Execution')).toBe('split')
            // Every sample of the tail reached the engine once: what was loaded is what one place loads.
            expect([cost(res, 'Samples-Loaded'), cost(res, 'Series-Loaded')], `${q.id} loaded`).toEqual([cost(one, 'Samples-Loaded'), cost(one, 'Series-Loaded')])
          } else if (body !== want) {
            // Fitted (the query reads no tail) or refused: never an answer that differs.
            expect([q.id, res.status], body).toEqual([q.id, 422])
            expect(JSON.parse(body).error).toMatch(/^query exceeded limit max_fetch_bytes: /)
          }
        }
      }
    }
    expect(viaLeaves).toBeGreaterThan(60)
  }, 1_200_000)

  it('a shard of the previous release next to one of this one, the rest read by the parts: the same answer', async () => {
    let viaLeaves = 0
    for (const [old, q] of w.shards.flatMap((s) => extra.filter((x) => !x.query.includes('label_replace') && !x.query.includes('__name__=~')).map((x) => [s, x] as const))) {
      tailHooks.previousRelease = (s) => s === old
      delete hooks.tailCap
      const want = await (await run(w.a.key, q)).text()
      hooks.tailCap = 1
      const res = await run(w.a.key, q)
      expect(await res.text(), q.id).toBe(want)
      // The previous release's shard answered whole (unfiltered); the other's rest, if it holds
      // any of the query's rows, went to the parts.
      expect(['unfiltered', 'unfiltered+leaves'], q.id).toContain(res.headers.get('X-Viz-Tail-Mode'))
      if (res.headers.get('X-Viz-Tail-Mode') === 'unfiltered+leaves') viaLeaves++
    }
    expect(viaLeaves).toBeGreaterThanOrEqual(4)
  }, 600_000)

  it('a shard rolled back between the coordinator\'s read and a part\'s (it answers the part with its whole tail): the part cuts it, the same answer', async () => {
    tailHooks.previousRelease = (_s, where) => where === 'leaf'
    let n = 0
    for (const q of extra.filter((x) => !x.query.includes('label_replace') && !x.query.includes('__name__=~'))) {
      delete hooks.tailCap
      const want = await (await run(w.a.key, q)).text()
      hooks.tailCap = 1
      const res = await run(w.a.key, q)
      expect(await res.text(), q.id).toBe(want)
      if (res.headers.get('X-Viz-Tail-Mode') === 'filtered+leaves') n++
    }
    expect(n).toBeGreaterThan(10)
  }, 600_000)

  it('a leaf of the previous release ignores the rest of the tail it is given: 503, never an answer without it', async () => {
    hooks.tailCap = 1
    leafHooks.ignoreTailParts = true
    const res = await run(w.a.key, rateSumBy)
    const body = await res.json<{ errorType?: string; error?: string; data?: unknown }>()
    expect([res.status, body.errorType, body.data]).toEqual([503, 'unavailable', undefined])
    expect(body.error).toMatch(/earlier release/)
    const card = await api(w.a.key, '/api/v1/status/tsdb', { start: sec(workload.t0), end: sec(workload.end) })
    expect(card.status).toBe(503)
  })

  it('a part whose shard refuses a page of the rest: back to the ledger once (exact), or 503 past the bound; over a part\'s cap: 422', async () => {
    hooks.tailCap = 1
    let n = 0
    tailHooks.alter = (_s, answer, where) => (where === 'leaf' && n++ === 0 ? { status: 'stale_watermark', incarnation: 1, discardedThrough: 99 } : answer)
    let res = await run(w.a.key, rateSumBy)
    expect(await res.json()).toEqual(expected.a[rateSumBy.id])
    expect(cost(res, 'Plan-Attempts')).toBe(2)
    tailHooks.alter = (_s, answer, where) => (where === 'leaf' ? { status: 'stale_watermark', incarnation: 1, discardedThrough: 99 } : answer)
    res = await run(w.a.key, rateSumBy)
    expect([res.status, (await res.json<{ errorType: string }>()).errorType]).toEqual([503, 'unavailable'])
    tailHooks.alter = (_s, answer, where) => (where === 'leaf' ? { status: 'paused' } : answer)
    res = await run(w.a.key, rateSumBy)
    expect([res.status, cost(res, 'Plan-Attempts')]).toEqual([503, 1])
    delete tailHooks.alter
    // Each part's tail is capped by maxFetchBytes as well: one byte for the parts too.
    await setLimits(w.a, { maxFetchBytes: 1, maxQueryFetchBytes: 1 << 30, splitAboveSamples: 0 })
    hooks.forceLeaves = 2
    res = await run(w.a.key, rateSumBy)
    expect(res.status).toBe(422)
    expect((await res.json<{ error: string }>()).error).toMatch(/^query exceeded limit max_fetch_bytes: the unflushed tail of one of 2 parts is at least \d+ bytes, the limit is 1\./)
    await setLimits(w.a, null)
  })

  it('the cardinality report: a tail over the cap is counted over leaves, each reading its key range, with the one-place answer', async () => {
    for (const t of [w.a, w.b]) {
      for (const [path, params] of META.filter(([p]) => p.includes('/status/'))) {
        delete hooks.tailCap
        const one = await api(t.key, path, params)
        const want = await one.text()
        expect(one.headers.get('X-Viz-Execution')).toBe('single')
        for (const cap of [1, Math.floor(cost(one, 'Tail-Bytes') / 2)]) {
          hooks.tailCap = cap
          const res = await api(t.key, path, params)
          expect(await res.text(), `${t.which} ${path} cap ${cap}`).toBe(want)
          expect([res.headers.get('X-Viz-Execution'), res.headers.get('X-Viz-Tail-Mode')]).toEqual(['split', 'filtered+leaves'])
        }
      }
    }
  }, 600_000)
})

describe('a series whose split key is not its id', () => {
  it('in a tail the coordinator cuts, the exact answer; in the rest of a tail the shards cut by key, refused (never a wrong answer)', async () => {
    const w = await world()
    const at = workload.t0 + 60_000
    // `__type__` is left out of the split key of a `rate` under `sum`: these series' keys are
    // not their ids, so a shard's key range of ids is not a part.
    const samples = (k: number) => Array.from({ length: 20 }, (_, i) => [at + i * 15_000, k * i] as [number, number])
    await write(w.a, [
      ...Array.from({ length: 8 }, (_, i) => ({ labels: { __name__: 'typed_total', __type__: 'counter', job: 'j', i: `t${i}` }, samples: samples(i + 1) })),
      ...Array.from({ length: 8 }, (_, i) => ({ labels: { __name__: 'typed_total', job: 'j', i: `u${i}` }, samples: samples(i + 2) })),
    ])
    const q = { query: 'sum by (job) (rate(typed_total[1m]))', start: sec(at + 120_000), end: sec(at + 240_000), step: '15' }
    const one = await api(w.a.key, '/api/v1/query_range', q)
    const want = await one.text()
    expect(one.status, want).toBe(200)
    let refused = 0
    for (const n of [2, 3, 5]) {
      hooks.forceLeaves = n
      const cut = await api(w.a.key, '/api/v1/query_range', q)
      expect(await cut.text(), `${n} leaves, cut here`).toBe(want)
      hooks.tailCap = 1
      const rest = await api(w.a.key, '/api/v1/query_range', q)
      const body = await rest.text()
      // Unless every typed series' id falls in the part of its key, a part sees a row of another part: refused.
      if (rest.status === 200) expect(body, `${n} leaves`).toBe(want)
      else {
        refused++
        expect([rest.status, JSON.parse(body).error]).toEqual([422, expect.stringMatching(/__type__ or __unit__ label, which the shards cannot cut by key/)])
      }
      delete hooks.tailCap
    }
    expect(refused).toBeGreaterThan(0)
  }, 300_000)
})

describe('the filter a read sends (tailFilter)', () => {
  /** A tiny PromQL matcher, for the property. */
  const matches = (m: { name: string; op: string; value: string }, labels: Record<string, string>): boolean => {
    const v = labels[m.name] ?? ''
    if (m.op === '=') return v === m.value
    if (m.op === '!=') return v !== m.value
    const re = new RegExp(`^(?:${m.value})$`)
    return m.op === '=~' ? re.test(v) : !re.test(v)
  }

  it('keeps every row some range selects (random ranges, series and rows), through the shard\'s own filter', () => {
    let seed = 7
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const NAMES = ['a', 'b', 'c']
    const pick = <T>(xs: T[]): T => xs[rnd(xs.length)]!
    let kept = 0
    let total = 0
    for (let trial = 0; trial < 400; trial++) {
      const series: Record<string, string>[] = Array.from({ length: 12 }, () => {
        const l: Record<string, string> = { __name__: pick(NAMES) }
        if (rnd(3)) l.job = pick(['x', 'y'])
        if (rnd(2)) l.env = pick(['p', 'q'])
        return l
      })
      const rows: Row[] = Array.from({ length: 40 }, () => ({ series: rnd(series.length), ts: 1000 * rnd(50), bits: 0x3ff0000000000000n }))
      const ranges = Array.from({ length: 1 + rnd(3) }, () => {
        const matchers: { name: string; op: '=' | '!=' | '=~' | '!~'; value: string }[] = []
        if (rnd(4)) matchers.push({ name: '__name__', op: '=', value: pick(NAMES) })
        else if (rnd(2)) matchers.push({ name: '__name__', op: '=~', value: 'a|b' })
        for (const name of ['job', 'env']) {
          const k = rnd(5)
          if (k === 0) matchers.push({ name, op: '=', value: pick(['x', 'y', 'p', '']) })
          if (k === 1) matchers.push({ name, op: '!=', value: pick(['x', 'p']) })
          if (k === 2) matchers.push({ name, op: '=~', value: pick(['x|y', 'p', '.*']) })
        }
        const lo = 1000 * rnd(50)
        return { matchers, minTs: lo, maxTs: lo + 1000 * rnd(20) }
      })
      const f: TailFilter = tailFilter(ranges)
      const compiled = compileFilter(f)
      if ('invalid' in compiled) throw new Error(compiled.invalid)
      const out = filterBatch(encodeBatch(series, rows), compiled)
      const keptRows = new Set<string>()
      if (out) {
        // Read back what the shard kept: (series labels, ts) pairs.
        const dv = new DataView(out.bytes.buffer, out.bytes.byteOffset, out.bytes.byteLength)
        const n = dv.getUint32(8, true)
        const ns = dv.getUint32(12, true)
        const td = new TextDecoder()
        const kept: string[] = []
        let p = 16
        for (let s = 0; s < ns; s++) {
          const nl = dv.getUint32(p + 8, true)
          p += 12
          const l: Record<string, string> = {}
          for (let i = 0; i < nl; i++) {
            const a = dv.getUint16(p, true)
            const name = td.decode(out.bytes.subarray(p + 2, p + 2 + a))
            p += 2 + a
            const b = dv.getUint16(p, true)
            l[name] = td.decode(out.bytes.subarray(p + 2, p + 2 + b))
            p += 2 + b
          }
          kept.push(JSON.stringify(Object.entries(l).sort()))
        }
        const idx = (p + 7) & ~7
        const ts = idx + ((4 * n + 7) & ~7)
        for (let i = 0; i < n; i++) keptRows.add(`${kept[dv.getUint32(idx + 4 * i, true)]}@${Number(dv.getBigInt64(ts + 8 * i, true))}`)
      }
      for (const r of rows) {
        const l = series[r.series]!
        const wanted = ranges.some((g) => r.ts >= g.minTs && r.ts <= g.maxTs && g.matchers.every((m) => matches(m, l)))
        total++
        if (wanted) {
          kept++
          expect(keptRows.has(`${JSON.stringify(Object.entries(l).sort())}@${r.ts}`), `trial ${trial}: ${JSON.stringify({ ranges, l, ts: r.ts, f })}`).toBe(true)
        }
      }
    }
    // The property was exercised: many rows wanted, and the filter narrowed some reads.
    expect(kept).toBeGreaterThan(total / 10)
  })

  it('sends only what every range pins', () => {
    const r = (matchers: { name: string; op: '=' | '!=' | '=~' | '!~'; value: string }[], minTs = 10, maxTs = 20) => ({ matchers, minTs, maxTs })
    expect(tailFilter([r([{ name: '__name__', op: '=', value: 'm' }, { name: 'job', op: '=', value: 'x' }]), r([{ name: '__name__', op: '=', value: 'n' }, { name: 'job', op: '=', value: 'x' }], 5, 15)])).toEqual({
      minTs: 5, maxTs: 20, metrics: ['m', 'n'], labels: [{ name: 'job', value: 'x' }],
    })
    // One range without a name: no metric filter; a label only one range pins: none.
    expect(tailFilter([r([{ name: '__name__', op: '=', value: 'm' }, { name: 'job', op: '=', value: 'x' }]), r([{ name: '__name__', op: '=~', value: 'm|n' }])])).toEqual({ minTs: 10, maxTs: 20 })
    expect(tailFilter([r([{ name: 'env', op: '=', value: '' }])], false)).toEqual({ labels: [{ name: 'env', value: '' }] })
    expect(tailFilter([])).toEqual({})
  })

  it('sizes a split from what a read saw: series ids, and the stored batches left', () => {
    const b = encodeBatch([{ __name__: 'm', i: '1' }, { __name__: 'm', i: '2' }], [{ series: 0, ts: 1, bits: 0n }, { series: 1, ts: 1, bits: 0n }])
    expect(seriesIdsOf([b, b]).size).toBe(2)
    const read: TailRead = { status: 'ok', shard: 's', incarnation: 1, above: 10, through: 30, batches: [{ seq: 11, payload: b }], bytes: b.byteLength, paged: true, complete: false, overBytes: 0, calls: 1, scannedBatches: 10, scannedBytes: 10 * b.byteLength }
    // 10 batches left of the 20 above the watermark, each like the 10 seen, of which a tenth was kept.
    const est = tailEstimate([read])
    expect(est.bytes).toBe(b.byteLength + Math.ceil(10 * b.byteLength * 0.1))
    expect(est.series).toBe(Math.ceil((2 * est.bytes) / b.byteLength))
    expect(tailEstimate([{ ...read, complete: true }])).toEqual({ bytes: b.byteLength, series: 2 })
  })
})
