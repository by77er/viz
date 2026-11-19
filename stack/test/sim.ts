/**
 * A simulated deployment for the property test and the soak test: several tenants sharing
 * one pool of two shards, real requests through the edge Worker, and every queue under the
 * test's control.
 *
 *   - Seal notifications are captured (`Shard.prototype.announce` is replaced) instead of
 *     going to the real queue, and maintenance messages go to an in-memory queue, so the
 *     test decides when, how often and in what order they are delivered, and can fail them.
 *   - `Model` is what a query must return: every acknowledged sample, minus what retention
 *     has expired. A sample's value is a function of (series, timestamp), so the same
 *     sample sent twice is the same row.
 *   - `checkTenant` asserts the invariants.
 */
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import { pairFiles } from '../../compact/src/compact'
import type { FileEntry, Tombstone } from '../../contracts/ledger'
import { type PrwSeries, bitsOf, makeKey, postWrite, setPool } from '../../edge/test/helpers'
import { ledgerStub, read, shardStub } from '../../flush/test/helpers'
import { type PoolMap, shardName, slotFor } from '../../shard/src/pool'
import { type FlushMessage, Shard } from '../../shard/src/shard'
import type { MaintMessage, StackEnv } from '../src/index'

export const DAY_MS = 86_400_000
export const dayOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10)

/** mulberry32: a small seeded generator, so a failing run can be repeated from its seed. */
export function rng(seed: number) {
  let a = seed >>> 0
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (n: number): number => Math.floor(next() * n), chance: (p: number): boolean => next() < p, pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]! }
}
export type Rng = ReturnType<typeof rng>

export class Model {
  /** `labels @ts` → [ts, canonical line]. */
  private readonly rows = new Map<string, [number, string]>()
  add(labels: Record<string, string>, ts: number, bits: bigint): void {
    const l = JSON.stringify(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1)))
    this.rows.set(`${l} @${ts}`, [ts, `${l} @${ts} =${bits.toString(16)}`])
  }
  /** Retention removed every file of days before `beforeDay`. */
  expire(beforeDay: string): number {
    let n = 0
    for (const [k, [ts]] of this.rows) {
      if (dayOf(ts) < beforeDay) {
        this.rows.delete(k)
        n++
      }
    }
    return n
  }
  canon(): string[] {
    return [...this.rows.values()].map((r) => r[1]).sort()
  }
  get size(): number {
    return this.rows.size
  }
}

export interface SimTenant {
  name: string
  key: string
  model: Model
  /** Series of this tenant: labels, and the slot its sender routes to. */
  series: { labels: [string, string][]; slot: number }[]
}

export interface Queued<T> {
  id: string
  body: T
  attempts: number
}

export interface Sim {
  map: PoolMap
  shards: string[]
  tenants: SimTenant[]
  flushQueue: Queued<FlushMessage>[]
  maintQueue: Queued<MaintMessage>[]
  /** Messages the queues gave up on (attempts over the limit). */
  dead: Queued<unknown>[]
  /** `env` with both queues replaced by the in-memory ones. */
  env: StackEnv
  restore(): void
}

let simN = 0
let msgN = 0

/** The value of a series at a time: deterministic, so a re-sent sample is the same row. */
export const valueAt = (seriesIndex: number, ts: number): number => seriesIndex * 1000 + (ts % 86_400_000) / 1000

export async function createSim(nTenants: number, seriesPerTenant: number): Promise<Sim> {
  const id = `${Date.now().toString(36)}${simN++}`
  const map: PoolMap = { pool: `sim-${id}`, slots: 2, spread: 2, epoch: 1 }
  const shards = [shardName(map, 0), shardName(map, 1)]
  const tenants: SimTenant[] = []
  for (let t = 0; t < nTenants; t++) {
    const name = `sim${t}-${id}`
    await setPool(name, map)
    const series: SimTenant['series'] = []
    for (let i = 0; i < seriesPerTenant; i++) {
      const job = `job-${i % 3}`
      const instance = `10.0.${t}.${i % 5}:9100`
      series.push({
        labels: [['__name__', i % 4 === 0 ? 'up' : `http_requests_total_${i % 2}`], ['job', job], ['instance', instance], ['owner', name], ['k', String(i)]],
        slot: slotFor(map, name, `job=${job}\u0000instance=${instance}`),
      })
    }
    tenants.push({ name, key: await makeKey(name), model: new Model(), series })
  }

  const flushQueue: Queued<FlushMessage>[] = []
  const maintQueue: Queued<MaintMessage>[] = []
  const queueOf = <T>(list: Queued<T>[]): Queue<T> =>
    ({
      send: async (body: T) => void list.push({ id: `m${msgN++}`, body, attempts: 1 }),
      sendBatch: async (bodies: Iterable<{ body: T }>) => {
        for (const b of bodies) list.push({ id: `m${msgN++}`, body: b.body, attempts: 1 })
      },
    }) as unknown as Queue<T>
  const proto = Shard.prototype as unknown as { announce(msg: FlushMessage): Promise<void> }
  const original = proto.announce
  const mine = new Set(shards)
  proto.announce = async function (this: unknown, msg: FlushMessage) {
    if (mine.has(msg.shard)) flushQueue.push({ id: `m${msgN++}`, body: msg, attempts: 1 })
  }
  return {
    map, shards, tenants, flushQueue, maintQueue, dead: [],
    env: { ...env, FLUSH_QUEUE: queueOf(flushQueue), MAINT_QUEUE: queueOf(maintQueue) } as StackEnv,
    restore: () => { proto.announce = original },
  }
}

/** Accept samples up to four days old, so one run has open days, closed days and expired days. */
export const INGEST = { INGEST_LIMITS: JSON.stringify({ acceptBackMs: 4 * DAY_MS + 3_600_000 }) }

/**
 * One Remote Write request: `nSeries` random series of the tenant, each with `nSamples`
 * samples on a one-minute grid, `daysBack` days ago. Recorded in the model only if acknowledged.
 */
export async function ingest(sim: Sim, t: SimTenant, r: Rng, nSeries: number, nSamples: number, daysBack: number, now = Date.now()): Promise<number> {
  const picked = new Set<number>()
  while (picked.size < Math.min(nSeries, t.series.length)) picked.add(r.int(t.series.length))
  // The newest sample is at least two minutes old; older days use the same time of day.
  const base = Math.floor((now - 120_000) / 60_000) * 60_000 - daysBack * DAY_MS
  const body: PrwSeries[] = []
  const rows: [Record<string, string>, number, bigint][] = []
  for (const i of picked) {
    const samples = Array.from({ length: nSamples }, () => base - r.int(180) * 60_000).map((ts) => ({ ts, value: valueAt(i, ts) }))
    body.push({ labels: t.series[i]!.labels, samples })
    for (const s of samples) rows.push([Object.fromEntries(t.series[i]!.labels), s.ts, bitsOf(s.value)])
  }
  const res = await postWrite(t.key, body, { env: INGEST })
  if (res.status === 204) for (const [labels, ts, bits] of rows) t.model.add(labels, ts, bits)
  else if (res.status !== 429 && res.status !== 503) throw new Error(`ingest: unexpected ${res.status} ${await res.text()}`)
  return res.status
}

export interface Delivery<R> {
  outcomes: R
  acked: number
  retried: number
}

/**
 * Deliver `messages` to a consumer as one batch, the way the queue would, and apply what
 * the consumer did with each: acknowledged messages are gone, retried ones go back with
 * one more attempt, and one past `maxRetries` is dead-lettered.
 */
export async function deliver<T, R>(sim: Sim, queue: Queued<T>[], queueName: string, messages: Queued<T>[], maxRetries: number, consume: (batch: MessageBatch<unknown>) => Promise<R>): Promise<Delivery<R>> {
  const batch = createMessageBatch(queueName, messages.map((m) => ({ id: m.id, timestamp: Date.now(), attempts: m.attempts, body: m.body })))
  const ctx = createExecutionContext()
  let outcomes: R
  let result
  try {
    outcomes = await consume(batch)
    result = await getQueueResult(batch, ctx)
  } catch (e) {
    // The consumer itself threw: the queue retries the whole batch.
    for (const m of messages) requeue(sim, queue, m, maxRetries)
    throw e
  }
  const retried = new Set(result.retryMessages.map((m) => m.msgId))
  const acked = new Set(result.explicitAcks)
  let nRetried = 0
  for (const m of messages) {
    // Neither acknowledged nor retried explicitly counts as acknowledged only if the handler returned (it did).
    if (retried.has(m.id) || (result.retryBatch.retry && !acked.has(m.id))) {
      requeue(sim, queue, m, maxRetries)
      nRetried++
    }
  }
  return { outcomes, acked: messages.length - nRetried, retried: nRetried }
}

function requeue<T>(sim: Sim, queue: Queued<T>[], m: Queued<T>, maxRetries: number): void {
  if (m.attempts > maxRetries) sim.dead.push(m)
  else queue.push({ ...m, attempts: m.attempts + 1 })
}

/** Remove and return up to `n` messages from a queue, in random order if `r` is given. */
export function take<T>(queue: Queued<T>[], n: number, r?: Rng): Queued<T>[] {
  const out: Queued<T>[] = []
  while (out.length < n && queue.length > 0) out.push(queue.splice(r ? r.int(queue.length) : 0, 1)[0]!)
  return out
}

export interface TenantState {
  canon: string[]
  live: FileEntry[]
  objects: string[]
  tombstones: Tombstone[]
  /** Objects that are neither live nor tombstoned: what only the orphan sweep can remove. */
  unreferenced: string[]
}

/** Names the orphan sweep can judge (janitor/src/janitor.ts): a flush file, or a compaction output. */
const FLUSH_FILE = /\/L0-(.+)-(\d+)-(\d+)-(\d+)-[0-9a-f]{8}\.parquet$/
const COMPACTED_FILE = /\/L[1-9]\d*-(h\d\d|d)-[0-9a-f]{16}-[0-9a-f]{8}\.parquet$/

/** Every object under the tenant's data prefix, with its size. */
async function objectSizes(tenant: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const table of ['metric_samples', 'metric_series']) {
    let cursor: string | undefined
    do {
      const page = await env.BUCKET.list({ prefix: `${env.CELL}/data/${table}/tenant=${tenant}/`, cursor })
      for (const o of page.objects) out.set(o.key, o.size)
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  }
  return out
}

/**
 * The invariants, for one tenant, right now:
 *
 *   1. a query returns exactly the model: no acknowledged row lost, none twice, none invented;
 *   2. every row returned belongs to this tenant, and every live key is under its prefix;
 *   3. every live file is an object in R2 of the listed size;
 *   4. every samples file is listed with its series file;
 *   5. every tombstone younger than the delete grace still has its object (nothing is
 *      deleted while a query holding an older plan may read it);
 *   6. no object under the tenant's prefix belongs to another tenant's ledger;
 *   7. the ledger's live set is exactly the set of objects it references: every live key is
 *      an object of the listed size, no key is both live and tombstoned, and every other
 *      object is either tombstoned (the janitor deletes it after the grace) or has a name
 *      the orphan sweep can judge (nothing is leaked where no job would ever look).
 */
export async function checkTenant(sim: Sim, t: SimTenant, graceMs: number, where: string): Promise<TenantState> {
  const ledger = ledgerStub(t.name)
  const r = await read(t.name, sim.shards)
  expect(r.canon.length, `${where}: ${t.name} row count`).toBe(t.model.size)
  expect(r.canon, `${where}: ${t.name} rows`).toEqual(t.model.canon())
  for (const s of r.series) expect(s.labels.owner, `${where}: a row of another tenant`).toBe(t.name)

  const samples = (await ledger.plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files
  const series = (await ledger.plan({ table: 'metric_series', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files
  const live = [...samples, ...series]
  const sizes = await objectSizes(t.name)
  const objects = [...sizes.keys()].sort()
  const have = new Set(objects)
  for (const f of live) {
    expect(f.key.includes(`/tenant=${t.name}/`), `${where}: live key outside the tenant prefix: ${f.key}`).toBe(true)
    expect(have.has(f.key), `${where}: live file missing from R2: ${f.key}`).toBe(true)
    expect(sizes.get(f.key), `${where}: live file ${f.key} has another size in R2`).toBe(f.bytes)
  }
  expect(pairFiles(samples, series).unpaired, `${where}: ${t.name} unpaired files`).toEqual([])

  const tombstones = await ledger.removedSince(0, 10_000)
  const now = Date.now()
  for (const x of tombstones) {
    if (now - x.at < graceMs) expect(have.has(x.key), `${where}: ${x.key} deleted ${now - x.at} ms after removal, inside the grace of ${graceMs} ms`).toBe(true)
  }
  const liveKeys = new Set(live.map((f) => f.key))
  const buried = new Set(tombstones.map((x) => x.key))
  for (const k of buried) expect(liveKeys.has(k), `${where}: ${k} is both live and tombstoned`).toBe(false)
  const unreferenced = objects.filter((k) => !liveKeys.has(k) && !buried.has(k))
  for (const k of unreferenced) expect(FLUSH_FILE.test(k) || COMPACTED_FILE.test(k), `${where}: ${k} is referenced by nothing and no job would delete it`).toBe(true)
  return { canon: r.canon, live, objects, tombstones, unreferenced }
}

/** Order-independent digest of a result: row count, wrapping sum of timestamps, XOR of value bits. */
export function checksum(canon: string[]): { rows: number; tsSum: bigint; bitsXor: bigint } {
  let tsSum = 0n
  let bitsXor = 0n
  for (const line of canon) {
    const m = / @(\d+) =([0-9a-f]+)$/.exec(line)!
    tsSum = BigInt.asUintN(64, tsSum + BigInt(m[1]!))
    bitsXor ^= BigInt(`0x${m[2]!}`)
  }
  return { rows: canon.length, tsSum, bitsXor }
}

export const shard = (name: string) => shardStub(name)
export const ledger = (t: SimTenant) => ledgerStub(t.name)
