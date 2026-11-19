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
import { signalOfShard } from '../src/shards'
import { tailHooks } from '../src/tail'
import seed1 from './fixtures/signals/seed-1.json'
import seed2 from './fixtures/signals/seed-2.json'
import seed3 from './fixtures/signals/seed-3.json'
import { type Case, type Fixture, load, loadSignal, unb64 } from './signals-load'
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

  it('max_spans and max_rows as the engine decodes: the tail counts too', async () => {
    const fx = SEEDS[0]!
    const w = await world()
    await load(w, w.a, fx)
    // Above what the files hold, below files plus tail: the fragments pass it, the engine refuses.
    const probe = await call(w.a.key, pick(fx, 'metrics/0'))
    const lakeSpans = cost(probe, 'Scan-Rows')
    const probeLogs = await call(w.a.key, pick(fx, 'loki/0/'))
    const lakeRows = cost(probeLogs, 'Scan-Rows')
    expect(cost(probe, 'Rows-Decoded')).toBeGreaterThan(lakeSpans)
    await env.CONFIG.put(`limits:${w.a.name}`, JSON.stringify({ maxSpans: lakeSpans + 1, maxLogRows: lakeRows + 1 }))
    clearLimitsCache()
    for (const [prefix, name] of [['metrics/0', 'max_spans'], ['loki/0/', 'max_rows']] as const) {
      const res = await call(w.a.key, pick(fx, prefix))
      const text = await res.text()
      expect([prefix, res.status, text.includes(name)]).toEqual([prefix, 422, true])
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
