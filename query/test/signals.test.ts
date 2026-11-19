/**
 * Traces and logs through the query Worker (README, "Traces and logs"): Tempo's and Loki's
 * HTTP APIs over files the stage-1 encoders wrote and tails of span and log shards, against
 * the answers of the engines' IN-MEMORY sources on the same data.
 *
 * Fixtures (`tools/gen-signal-fixtures.sh`, git-ignored): per seed, `VZB1` span and log batches
 * that edge's own decoders made from OTLP and Loki push requests (`edge/scripts/otel-corpus.mjs`),
 * the first 70 % flushed into three units by `viz_storage::encode_spans`/`encode_logs`, and
 * cases with the answers `viz_traceql::MemSource` and `viz_logql::MemSource` give over every
 * batch (`engine/wasm-query/examples/signal_fixtures.rs`). Here every batch is appended to the
 * tenant's `{pool}/traces/0` or `{pool}/logs/0` shard, in order, as edge would, and each unit's
 * files go to R2 and to the ledger through `addUnit` (the ledger accepts the tables through the
 * test-only change of `vitest.ledger.ts`), so the tail is what lies above the units' watermark.
 */
import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FileEntry } from '../../contracts/ledger'
import { clearLimitsCache } from '../src/config'
import { hooks } from '../src/coordinator'
import query from '../src/index'
import { shardSignalFilter, signalOfShard } from '../src/shards'
import { tailHooks } from '../src/tail'
import seed1 from './fixtures/signals/seed-1.json'
import seed2 from './fixtures/signals/seed-2.json'
import seed3 from './fixtures/signals/seed-3.json'
import { type Case, type Fixture, appendBatches, load, loadSignal, unb64 } from './signals-load'
import { type Tenant, type World, api, cost, expected, ingest, ledgerOf, run, shardOf, QUERIES, world } from './world'

const SEEDS = [seed1, seed2, seed3] as unknown as Fixture[]

/** Tempo's body without its `metrics` (what was inspected: the read path reads less than the in-memory source holds, by design). */
function withoutMetrics(s: string): string {
  const at = s.lastIndexOf(',"metrics":{')
  if (at < 0) return s
  const end = s.indexOf('}', at) + 1
  return s.slice(0, at) + s.slice(end)
}

async function call(key: string, c: Case, extra: Record<string, string> = {}): Promise<Response> {
  return api(key, c.path, c.params, { headers: extra })
}

/** Check one case's answer against the in-memory one; returns a description of the difference, or null. */
async function check(res: Response, c: Case): Promise<string | null> {
  const text = await res.text()
  if (res.status !== c.status) return `${c.id}: status ${res.status} (${text.slice(0, 200)}), expected ${c.status}`
  if (c.compare === 'status') return null
  if (c.compare === 'tempo') return withoutMetrics(text) === c.body ? null : `${c.id}: ${withoutMetrics(text).slice(0, 300)}\n   expected ${String(c.body).slice(0, 300)}`
  if (c.compare === 'text-data') {
    const want = `{"status":"success","data":${c.body as string}}`
    return text === want ? null : `${c.id}: ${text.slice(0, 300)}\n   expected ${want.slice(0, 300)}`
  }
  try {
    expect(JSON.parse(text)).toEqual(c.body)
    return null
  } catch {
    // Where the two first differ, with some context.
    const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v)
    const a = JSON.stringify(canon(JSON.parse(text)))
    const b = JSON.stringify(canon(c.body))
    let k = 0
    while (k < a.length && a[k] === b[k]) k++
    return `${c.id}: differs at ${k}: …${a.slice(Math.max(0, k - 150), k + 150)}\n   expected …${b.slice(Math.max(0, k - 150), k + 150)}`
  }
}

async function runAll(t: Tenant, fx: Fixture, extra: Record<string, string> = {}): Promise<{ failures: string[]; skipped: number; listed: number }> {
  const failures: string[] = []
  let skipped = 0
  let listed = 0
  for (const c of fx.cases) {
    const res = await call(t.key, c, extra)
    skipped += cost(res, 'Files-Skipped')
    listed += cost(res, 'Files-Listed')
    const d = await check(res, c)
    if (d) failures.push(d)
  }
  return { failures, skipped, listed }
}

afterEach(() => {
  delete hooks.signalPruning
  delete hooks.afterPlan
  delete hooks.alterTail
  delete hooks.tailCap
  delete tailHooks.previousRelease
  delete tailHooks.alter
  clearLimitsCache()
})

beforeAll(() => {
  // A fixture is a whole corpus: make sure it is the one this file was written for.
  for (const fx of SEEDS) expect(fx.cases.length).toBeGreaterThan(80)
})

describe('traces and logs: every endpoint equals the in-memory engines', () => {
  for (const [i, fx] of SEEDS.entries()) {
    it(`seed ${fx.seed}: ${fx.counts.spans} spans in ${fx.counts.traces} traces, ${fx.counts.logs} log rows; another tenant's data in the same shards`, async () => {
      const w = await world()
      await load(w, w.a, fx)
      // Tenant b's data (the next seed) shares every shard object and the bucket.
      await load(w, w.b, SEEDS[(i + 1) % SEEDS.length]!)
      const a = await runAll(w.a, fx)
      expect(a.failures).toEqual([])
      // Pruning by the index fragments did prune.
      expect(a.skipped).toBeGreaterThan(0)
      const b = await runAll(w.b, SEEDS[(i + 1) % SEEDS.length]!)
      expect(b.failures).toEqual([])
    })
  }
})

describe('pruning', () => {
  it('on and off give identical answers (every file whole, every span hour, no time pruning)', async () => {
    const fx = SEEDS[0]!
    const w = await world()
    await load(w, w.a, fx)
    const on = await runAll(w.a, fx)
    expect(on.failures).toEqual([])
    hooks.signalPruning = false
    const off = await runAll(w.a, fx)
    expect(off.failures).toEqual([])
    expect(off.skipped).toBe(0)
    expect(on.skipped).toBeGreaterThan(0)
  })

  it('trace by ID reads the trace_index row groups that can hold the id and the span hours its fragments name, and less than without pruning', async () => {
    const fx = SEEDS[1]!
    const w = await world()
    await load(w, w.a, fx)
    let pruned = 0
    let whole = 0
    for (const c of fx.cases.filter((x) => x.id.startsWith('trace/') && x.status === 200)) {
      const res = await call(w.a.key, c)
      expect(await check(res, c)).toBeNull()
      expect(res.headers.get('X-Viz-Pruning')).toBe('hours')
      pruned += cost(res, 'Bytes-Read')
      hooks.signalPruning = false
      const off = await call(w.a.key, c)
      expect(await check(off, c)).toBeNull()
      expect(off.headers.get('X-Viz-Pruning')).toBe('off')
      whole += cost(off, 'Bytes-Read')
      delete hooks.signalPruning
    }
    expect(pruned).toBeLessThan(whole / 2)
  })
})

describe('tenancy', () => {
  it('the tenant comes from the key only: headers and parameters naming another tenant change nothing', async () => {
    const fx = SEEDS[2]!
    const w = await world()
    await load(w, w.a, fx)
    await load(w, w.b, SEEDS[0]!)
    const sample = fx.cases.filter((_, k) => k % 7 === 0)
    for (const c of sample) {
      for (const extra of [{ 'X-Scope-OrgID': w.b.name }, { 'X-Viz-Tenant': w.b.name }] as Record<string, string>[]) {
        expect(await check(await call(w.a.key, c, extra), c)).toBeNull()
      }
      const withParam: Case = { ...c, params: [...c.params, ['tenant', w.b.name], ['orgId', w.b.name]] }
      expect(await check(await call(w.a.key, withParam), c)).toBeNull()
    }
  })

  it('a key without the read scope is 403, no key is 401', async () => {
    const w = await world()
    const c = SEEDS[0]!.cases[0]!
    expect((await api(null, c.path, c.params)).status).toBe(401)
    const { makeKey } = await import('../../edge/test/helpers')
    const writeOnly = await makeKey(w.a.name, { scopes: ['write'] })
    for (const path of ['/api/search', '/loki/api/v1/labels']) expect((await api(writeOnly, path, [])).status).toBe(403)
  })
})

/** A case of each kind, for the cap tests. */
const pick = (fx: Fixture, prefix: string): Case => fx.cases.find((c) => c.id.startsWith(prefix) && c.status === 200)!

describe('caps: refused before anything is fetched, or by the engine as it decodes', () => {
  async function capped(limits: Record<string, number>): Promise<{ w: World; fx: Fixture }> {
    const fx = SEEDS[0]!
    const w = await world()
    await load(w, w.a, fx)
    await env.CONFIG.put(`limits:${w.a.name}`, JSON.stringify(limits))
    clearLimitsCache()
    return { w, fx }
  }

  it('max_fetch_bytes', async () => {
    const { w, fx } = await capped({ maxFetchBytes: 4096 })
    for (const prefix of ['search/0/', 'loki/0/', 'trace/0', 'metrics/0', 'tags/v1', 'loki-labels']) {
      const res = await call(w.a.key, pick(fx, prefix))
      const text = await res.text()
      expect([prefix, res.status, /max_fetch_bytes/.test(text)]).toEqual([prefix, 422, true])
      // Refused from the ledger's sizes: nothing was read from R2.
      expect(cost(res, 'R2-Gets') + cost(res, 'Cache-Hits')).toBe(0)
    }
  })

  it('max_files', async () => {
    const { w, fx } = await capped({ maxFiles: 1 })
    for (const prefix of ['search/0/', 'loki/0/']) {
      const res = await call(w.a.key, pick(fx, prefix))
      expect([res.status, /max_files/.test(await res.text())]).toEqual([422, true])
    }
  })

  it('max_spans and max_log_rows from the fragments, before any fetch', async () => {
    const { w, fx } = await capped({ maxSpans: 10, maxLogRows: 10 })
    for (const [prefix, name] of [['search/0/', 'max_spans'], ['loki/0/', 'max_log_rows']] as const) {
      const res = await call(w.a.key, pick(fx, prefix))
      const text = await res.text()
      expect([res.status, text.includes(name)]).toEqual([422, true])
      expect(cost(res, 'R2-Gets') + cost(res, 'Cache-Hits')).toBe(0)
    }
  })

  it('max_spans and max_rows as the engine decodes: the rows it holds from the tail count, the ones outside the query do not', async () => {
    const fx = SEEDS[0]!
    const w = await world()
    // Every batch in the tail, nothing flushed: the fragments hold no row, so only the engine can refuse.
    await loadSignal(w, w.a, 'traces', { ...fx.spans, units: [], lake: 0 })
    await loadSignal(w, w.a, 'logs', { ...fx.logs, units: [], lake: 0 })
    await env.CONFIG.put(`limits:${w.a.name}`, JSON.stringify({ maxSpans: 1, maxLogRows: 1 }))
    clearLimitsCache()
    for (const [prefix, name] of [['metrics/0', 'max_spans'], ['search/0/', 'max_spans'], ['loki/2/', 'max_rows']] as const) {
      const res = await call(w.a.key, pick(fx, prefix))
      const text = await res.text()
      expect([prefix, res.status, text.includes(name), cost(res, 'Scan-Rows')]).toEqual([prefix, 422, true, 0])
    }
    // The same tail, under the same caps, read by queries that hold none of it (review m-3: the
    // tail is read whole, but what lies outside the query costs no row): a log selector that no
    // stream matches, and a search whose window, widened by the margin, ends days before the data.
    const logs = { ...pick(fx, 'loki/2/'), params: pick(fx, 'loki/2/').params.map(([k, v]): [string, string] => [k, k === 'query' ? '{service_name="no-such-service"}' : v]) }
    const early = { ...pick(fx, 'search/0/'), params: pick(fx, 'search/0/').params.map(([k, v]): [string, string] => [k, k === 'start' || k === 'end' ? String(Number(v) - 7 * 86_400) : v]) }
    for (const c of [logs, early]) {
      const res = await call(w.a.key, c)
      expect([c.id, res.status, cost(res, 'Rows-Decoded') > 0]).toEqual([c.id, 200, true])
    }
  })
})

describe('signals in shard tails', () => {
  it('shards are told apart by name: …/traces/N and …/logs/N hold spans and log records', () => {
    expect(['p/0', 'shared/c1/3', 'shared/c1/traces/3', 'shared/c1/logs/0', 'x/traces', 'x/logs-2/1'].map(signalOfShard)).toEqual(['metrics', 'metrics', 'traces', 'logs', 'metrics', 'metrics'])
  })

  it('a metrics query of a tenant whose ledger names span and log streams reads only metric shards, and answers exactly', async () => {
    const w = await world()
    await ingest(w)
    await load(w, w.a, SEEDS[0]!)
    // The ledger's watermarks name the span and log streams too.
    const plan = await ledgerOf(w.a).plan({ table: 'metric_samples', minTs: 0, maxTs: 1 })
    expect(plan.watermarks.map((x) => signalOfShard(x.shard)).sort()).toEqual(['logs', 'traces'])
    for (const q of QUERIES.filter((_, k) => k % 5 === 0)) {
      const res = await run(w.a.key, q)
      expect(await res.json(), q.id).toEqual(expected.a[q.id])
    }
    // Shards of an earlier release answer unfiltered (no signal filter): only the name rule keeps
    // the span and log shards out of a metrics read, and the answers stay exact.
    tailHooks.previousRelease = () => true
    for (const q of QUERIES.filter((_, k) => k % 5 === 0)) {
      const res = await run(w.a.key, q)
      expect(await res.json(), `${q.id} (unfiltered shards)`).toEqual(expected.a[q.id])
    }
  })

  it('a batch of another signal in a tail read is refused (503), never read as the wrong signal', async () => {
    const fx = SEEDS[0]!
    const w = await world()
    await ingest(w)
    await load(w, w.a, fx)
    const spanBatch = unb64(fx.spans.batches.at(-1)!)
    const logBatch = unb64(fx.logs.batches.at(-1)!)
    // A metrics read answered with a span batch (a shard of the previous release, or a misnamed pool).
    hooks.alterTail = (_shard, answer) => {
      const a = answer as { status: string; batches?: { seq: number; rows: number; payload: Uint8Array }[] }
      return a.status === 'ok' ? { ...a, batches: [...(a.batches ?? []), { seq: 1_000_000, rows: 1, payload: spanBatch }] } : answer
    }
    const res = await run(w.a.key, QUERIES[0]!)
    const body = await res.json<{ errorType?: string; error?: string }>()
    expect([res.status, body.errorType, /signal 2/.test(body.error ?? '')]).toEqual([503, 'unavailable', true])
    // A log read answered with a span batch, and a span read with a log batch.
    for (const [prefix, wrong] of [['loki/0/', spanBatch], ['search/0/', logBatch]] as const) {
      hooks.alterTail = (_shard, answer) => {
        const a = answer as { status: string; batches?: { seq: number; rows: number; payload: Uint8Array }[] }
        return a.status === 'ok' ? { ...a, batches: [...(a.batches ?? []), { seq: 1_000_000, rows: 1, payload: wrong }] } : answer
      }
      const r = await call(w.a.key, pick(fx, prefix))
      expect([prefix, r.status, /answered a tail read for signal/.test(await r.text())]).toEqual([prefix, 503, true])
    }
  })

  it('without the signal field in the tail options (as before the shard had it): the same answers', async () => {
    const fx = SEEDS[1]!
    const w = await world()
    await ingest(w)
    await load(w, w.a, fx)
    shardSignalFilter.enabled = false
    try {
      const r = await runAll(w.a, { ...fx, cases: fx.cases.filter((_, k) => k % 5 === 0) })
      expect(r.failures).toEqual([])
      for (const q of QUERIES.filter((_, k) => k % 9 === 0)) expect(await (await run(w.a.key, q)).json(), q.id).toEqual(expected.a[q.id])
    } finally {
      shardSignalFilter.enabled = true
    }
  })

  it('a shard of the previous release (no paging) gives the same answers', async () => {
    const fx = SEEDS[0]!
    const w = await world()
    await load(w, w.a, fx)
    tailHooks.previousRelease = () => true
    const r = await runAll(w.a, { ...fx, cases: fx.cases.filter((_, k) => k % 4 === 0) })
    expect(r.failures).toEqual([])
  })
})

describe('the seam for traces and logs', () => {
  it('a shard that refuses the tail read (it discarded above the watermark) sends the query back to the ledger; it answers exactly on the next attempt, or 503 after bounded retries, never a partial answer', async () => {
    const fx = SEEDS[0]!
    const w = await world()
    await load(w, w.a, fx)
    for (const prefix of ['loki/0/', 'search/0/', 'trace/0', 'metrics/0', 'tags/v1', 'loki-labels']) {
      const c = pick(fx, prefix)
      {
        let calls = 0
        hooks.alterTail = (shard, answer) => {
          if (!/\/(traces|logs)\/0$/.test(shard) || calls++ > 0) return answer
          return { status: 'stale_watermark', incarnation: (answer as { incarnation: number }).incarnation, discardedThrough: 99 }
        }
        const res = await call(w.a.key, c)
        expect([prefix, await check(res, c)]).toEqual([prefix, null])
        expect([prefix, cost(res, 'Plan-Attempts')]).toEqual([prefix, prefix === 'search/0/' || prefix === 'trace/0' ? 3 : 2])
      }
      // A shard that keeps refusing: 503 once the bound is passed.
      hooks.alterTail = (shard, answer) => (/\/(traces|logs)\/0$/.test(shard) ? { status: 'stale_watermark', incarnation: (answer as { incarnation: number }).incarnation, discardedThrough: 99 } : answer)
      const res = await call(w.a.key, c)
      expect([prefix, res.status]).toEqual([prefix, 503])
      delete hooks.alterTail
    }
  })
})

describe('the flag', () => {
  it('without QUERY_SIGNALS the Tempo and Loki paths are 404', async () => {
    const w = await world()
    for (const path of ['/api/search', '/api/traces/00ff', '/api/metrics/query_range', '/api/v2/search/tags', '/loki/api/v1/query_range', '/loki/api/v1/labels']) {
      const req = new Request(`https://viz.test${path}`, { headers: { Authorization: `Bearer ${w.a.key}` } })
      const res = await query.fetch(req, { ...env, QUERY_SIGNALS: undefined } as never)
      expect([path, res.status]).toEqual([path, 404])
    }
    void exports
  })
})

/**
 * The review of D54 (design/reviews/d54-d56-d59.md) on the span and log reads, which go through
 * the same `readTails` as metrics: one byte budget over the signal's shards (M-2), resumed in a
 * second round with the signal's filter; shards of the previous release checked together (whole
 * answers); a page that does not advance the read (m-7). Each signal's tail is spread over its two
 * shards, so that the budget has two reads to share.
 */
describe('span and log tails under one byte budget over the signal\'s shards (review of D54)', () => {
  const PREFIXES = ['search/0/', 'loki/0/', 'trace/0', 'metrics/0', 'tags/v1', 'loki-labels']
  const payloadBytes = (answer: unknown): number => {
    const a = answer as { status?: string; batches?: { payload: Uint8Array }[] }
    return a.status === 'ok' && Array.isArray(a.batches) ? a.batches.reduce((x, b) => x + b.payload.byteLength, 0) : 0
  }

  /** Seed 1 with each signal's tail over two shards: slot 0 the lake and the first half of the tail, slot 1 the rest (a stream with no flushed unit). */
  async function twoShards(): Promise<{ w: World; fx: Fixture }> {
    const fx = SEEDS[0]!
    const w = await world()
    for (const [signal, s] of [['traces', fx.spans], ['logs', fx.logs]] as const) {
      const half = s.lake + Math.ceil((s.batches.length - s.lake) / 2)
      expect(half).toBeLessThan(s.batches.length)
      await loadSignal(w, w.a, signal, { ...s, batches: s.batches.slice(0, half) })
      await appendBatches(w, w.a, `${w.map.pool}/${signal}/1`, s.batches.slice(half))
    }
    return { w, fx }
  }

  it('the tail over two shards: the same answers; at its size they answer, resumed with the signal\'s filter; under it, 422 with never more than the cap received', async () => {
    const { w, fx } = await twoShards()
    const all = await runAll(w.a, { ...fx, cases: fx.cases.filter((_, k) => k % 4 === 0) })
    expect(all.failures).toEqual([])
    for (const prefix of PREFIXES) {
      const c = pick(fx, prefix)
      const free = await call(w.a.key, c)
      const tail = cost(free, 'Tail-Bytes')
      expect([prefix, await check(free, c), tail > 0]).toEqual([prefix, null, true])
      const got = new Map<string, number>()
      tailHooks.alter = (shard, answer, where) => {
        if (where === 'coordinator') got.set(shard, (got.get(shard) ?? 0) + payloadBytes(answer))
        return answer
      }
      // Exactly the tail: each read first under half of it; one then goes on with what the other
      // left (from the page that stopped: its cursor is bound to the signal's filter).
      hooks.tailCap = tail
      const at = await call(w.a.key, c)
      expect([prefix, await check(at, c), cost(at, 'Tail-Bytes')]).toEqual([prefix, null, tail])
      expect([prefix, got.size]).toEqual([prefix, 2])
      for (const cap of [tail - 1, Math.floor(tail * 0.45)]) {
        got.clear()
        hooks.tailCap = cap
        const res = await call(w.a.key, c)
        const text = await res.text()
        const received = [...got.values()].reduce((a, b) => a + b, 0)
        expect([prefix, cap, res.status, /max_fetch_bytes/.test(text), received <= cap]).toEqual([prefix, cap, 422, true, true])
      }
      delete hooks.tailCap
      delete tailHooks.alter
    }
  }, 300_000)

  it('shards of the previous release (whole answers): tails that fit one by one but not together are over the budget', async () => {
    const { w, fx } = await twoShards()
    tailHooks.previousRelease = () => true
    for (const prefix of ['search/0/', 'loki/0/']) {
      const c = pick(fx, prefix)
      const free = await call(w.a.key, c)
      const tail = cost(free, 'Tail-Bytes')
      expect([prefix, await check(free, c), free.headers.get('X-Viz-Tail-Mode')]).toEqual([prefix, null, 'unfiltered'])
      hooks.tailCap = tail
      expect([prefix, await check(await call(w.a.key, c), c)]).toEqual([prefix, null])
      hooks.tailCap = tail - 1
      const res = await call(w.a.key, c)
      expect([prefix, res.status, /max_fetch_bytes: the data files in range plus the unflushed tail is \d+ bytes/.test(await res.text())]).toEqual([prefix, 422, true])
      delete hooks.tailCap
    }
  }, 300_000)

  it('a span or log shard whose pages do not advance the read: 503, not asked for again (m-7)', async () => {
    const fx = SEEDS[0]!
    const w = await world()
    await load(w, w.a, fx)
    const shards = (['traces', 'logs'] as const).map((s) => `${w.map.pool}/${s}/0`)
    // A shard that examines nothing per call answers every page with the cursor it was given.
    for (const s of shards) await shardOf(s).configure({ tailScanMaxBytes: 0 })
    // A valve, so that code without the check ends (and fails here) instead of spinning.
    let calls = 0
    tailHooks.alter = (_s, answer) => (++calls > 60 ? { status: 'valve' } : answer)
    try {
      for (const prefix of ['loki/0/', 'search/0/']) {
        calls = 0
        const res = await call(w.a.key, pick(fx, prefix))
        expect([prefix, res.status, /answered a page that did not advance the read/.test(await res.text()), cost(res, 'Shard-Calls') < 10]).toEqual([prefix, 503, true, true])
      }
    } finally {
      for (const s of shards) await shardOf(s).configure({ tailScanMaxBytes: 32 << 20 })
    }
  }, 120_000)
})
