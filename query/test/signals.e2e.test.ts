/**
 * Traces and logs end to end: the corpus's OTLP and Loki push requests (the same requests the
 * write side's end-to-end run used: `edge/scripts/otel-corpus.mjs --requests`, as
 * `stack/tools/signals_readback.mjs` drives them) go through edge into the shards of
 * `{pool}/traces` and `{pool}/logs`; the first part is sealed and flushed by the real `Flush`
 * entrypoint (engine/wasm, D63) into `spans`, `trace_index` and `logs` files the ledger lists, the
 * rest stays in the shards' tails; then every case of the fixture (tools/gen-signal-fixtures.sh)
 * runs over HTTP and must equal the engines' in-memory answer over every batch of the same
 * corpus. Twice: with the shards' signal filter (`signals`, D63), and as with shards of the
 * previous release, which ignore it and answer unfiltered (the name rule and the header check).
 */
import { runDurableObjectAlarm } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'
import { hooks } from '../src/coordinator'
import { shardSignalFilter } from '../src/shards'
import { tailHooks } from '../src/tail'
import type { Case, Fixture } from './signals-load'
import { type Tenant, type World, api, cost, ledgerOf, shardOf, world } from './world'

/** `seed-N.e2e.json` (tools/pack-requests.mjs): the corpus's requests and the fixture's cases. */
interface Requests extends Pick<Fixture, 'seed' | 'counts' | 'cases'> {
  nowMs: number
  requests: { path: string; contentType: string; contentEncoding?: string; body: string }[]
}

const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Every slot of the derived pools (the tenant's slots are all of them in the test world). */
const signalShardsOf = (w: World): string[] => (['traces', 'logs'] as const).flatMap((s) => Array.from({ length: w.map.slots }, (_, i) => `${w.map.pool}/${s}/${i}`))

/** One request through edge, resent whole while it is refused for a retryable reason (a new stream registering, backpressure), as a sender does. */
async function post(t: Tenant, q: Requests['requests'][number]): Promise<void> {
  for (let i = 0; ; i++) {
    const headers: Record<string, string> = { Authorization: `Bearer ${t.key}`, 'Content-Type': q.contentType, ...(q.contentEncoding ? { 'Content-Encoding': q.contentEncoding } : {}) }
    const res = await exports.default.fetch(`https://viz.test${q.path}`, { method: 'POST', headers, body: unb64(q.body) as Uint8Array<ArrayBuffer> })
    const text = await res.text()
    if (res.status === 200 || res.status === 204) {
      // Nothing of the corpus is refused by validation (the corpus's own decode accepted all of it).
      expect(text, q.path).not.toMatch(/rejected/i)
      return
    }
    if (![429, 503].includes(res.status) || i > 100) throw new Error(`${q.path}: ${res.status} ${text.slice(0, 300)}`)
    await ledgerOf(t).drain()
    await sleep(20)
  }
}

/** Seal and flush every derived shard of the tenant through the Flush entrypoint, until the ledger has logged what it admitted (its alarm's work, done here). */
async function flushSignals(w: World, t: Tenant): Promise<number> {
  let units = 0
  for (const s of signalShardsOf(w)) {
    await shardOf(s).seal(t.name)
    let r = await exports.Flush.flushTenant(t.name, s)
    for (let i = 0; i < 5 && r.status === 'ok' && r.awaitingLog; i++) {
      await runDurableObjectAlarm(ledgerOf(t))
      r = await exports.Flush.flushTenant(t.name, s)
    }
    if (r.status !== 'ok' || r.awaitingLog) throw new Error(`flush ${s}: ${JSON.stringify(r)}`)
    units += (r as { units?: number }).units ?? 0
  }
  return units
}

function withoutMetrics(s: string): string {
  const at = s.lastIndexOf(',"metrics":{')
  return at < 0 ? s : s.slice(0, at) + s.slice(s.indexOf('}', at) + 1)
}

async function check(res: Response, c: Case): Promise<string | null> {
  const text = await res.text()
  if (res.status !== c.status) return `${c.id}: status ${res.status} (${text.slice(0, 200)}), expected ${c.status}`
  if (c.compare === 'status') return null
  if (c.compare === 'tempo') return withoutMetrics(text) === c.body ? null : `${c.id}: ${withoutMetrics(text).slice(0, 200)} … expected ${String(c.body).slice(0, 200)}`
  if (c.compare === 'text-data') return text === `{"status":"success","data":${c.body as string}}` ? null : `${c.id}: ${text.slice(0, 200)} … expected ${String(c.body).slice(0, 200)}`
  try {
    expect(JSON.parse(text)).toEqual(c.body)
    return null
  } catch {
    return `${c.id}: ${text.slice(0, 200)} … expected ${JSON.stringify(c.body).slice(0, 200)}`
  }
}

async function runAll(t: Tenant, fx: Fixture): Promise<{ failures: string[]; filesRead: number; tailBatches: number }> {
  const failures: string[] = []
  let filesRead = 0
  let tailBatches = 0
  for (const c of fx.cases) {
    const res = await api(t.key, c.path, c.params)
    filesRead += cost(res, 'Files-Read')
    tailBatches += cost(res, 'Tail-Batches')
    const d = await check(res, c)
    if (d) failures.push(d)
  }
  return { failures, filesRead, tailBatches }
}

afterEach(() => {
  shardSignalFilter.enabled = true
  delete tailHooks.previousRelease
  delete hooks.signalPruning
})

describe('traces and logs end to end: the corpus through edge, the shards, flush and the ledger', () => {
  // Imported inside each test, one seed at a time: a module reaches the runner in one message of at
  // most 32 MiB (the e2e fixture holds the requests and cases only, not the batches and files).
  const seeds: [number, () => Promise<Requests>][] = [
    [1, async () => (await import('./fixtures/signals/seed-1.e2e.json')).default as unknown as Requests],
    [3, async () => (await import('./fixtures/signals/seed-3.e2e.json')).default as unknown as Requests],
  ]
  for (const [seed, get] of seeds) {
    it(`seed ${seed}: answers over real flushed files and tails equal the in-memory engines', with the shards' signal filter and without it`, async () => {
      const rq = await get()
      const fx = rq as unknown as Fixture
      const w = await world()
      const t = w.a
      // Small segments, so the flushed part is many units and retried rows cross units.
      for (const s of signalShardsOf(w)) await shardOf(s).configure({ sealBytes: 256 << 10, sealAgeMs: 0 })
      const cut = Math.ceil(rq.requests.length * 0.6)
      for (const q of rq.requests.slice(0, cut)) await post(t, q)
      const units = await flushSignals(w, t)
      for (const q of rq.requests.slice(cut)) await post(t, q)
      // The ledger lists span, trace_index and log files of units the real flush wrote.
      const listed = await Promise.all((['spans', 'trace_index', 'logs'] as const).map(async (table) => (await ledgerOf(t).plan({ table, minTs: 0, maxTs: 9_000_000_000_000 })).files.length))
      expect(listed.every((n) => n > 0), JSON.stringify({ listed, units })).toBe(true)
      console.log(`E2E seed ${fx.seed}: ${rq.requests.length} requests (${cut} before the flush), files listed spans/trace_index/logs ${listed.join('/')}`)

      // 1. With the shards' signal filter (D63).
      const on = await runAll(t, fx)
      expect(on.failures).toEqual([])
      expect(on.filesRead).toBeGreaterThan(0)
      expect(on.tailBatches).toBeGreaterThan(0)
      console.log(`E2E seed ${fx.seed}: ${fx.cases.length} cases equal; files read ${on.filesRead}, tail batches read ${on.tailBatches}`)
      // 2. As with shards of the previous release: no filter sent, and the shards answer unfiltered.
      shardSignalFilter.enabled = false
      tailHooks.previousRelease = () => true
      const prev = await runAll(t, { ...fx, cases: fx.cases.filter((_, k) => k % 2 === 0) })
      expect(prev.failures).toEqual([])
      // 3. Pruning off over the same real files.
      shardSignalFilter.enabled = true
      delete tailHooks.previousRelease
      hooks.signalPruning = false
      const off = await runAll(t, { ...fx, cases: fx.cases.filter((_, k) => k % 3 === 0) })
      expect(off.failures).toEqual([])
    })
  }
})
