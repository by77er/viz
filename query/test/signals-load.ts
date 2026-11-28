/**
 * Loading span and log fixtures into a test world (test/signals.test.ts, test/signals.bench.ts):
 * every batch appended to the tenant's `{pool}/traces/0` or `{pool}/logs/0` shard in order, as
 * edge would, and each flush unit's files put in R2 and admitted by the ledger (`addUnit`), so
 * that the tail is what lies above the units' watermark.
 */
import { runDurableObjectAlarm } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import type { FileEntry } from '../../contracts/ledger'
import { type Tenant, type World, ledgerOf, shardOf } from './world'

export interface FileFx {
  table: 'spans' | 'trace_index' | 'logs'
  day: string
  hour: number | null
  rows: number
  minNs: string
  maxNs: string
  index: string
  bytes: string
}
export interface SignalFx {
  batches: string[]
  units: { seqLo: number; seqHi: number; files: FileFx[] }[]
  lake: number
}
export interface Case {
  id: string
  path: string
  params: [string, string][]
  status: number
  body: unknown
  compare: 'tempo' | 'json' | 'text-data' | 'status'
}
export interface Fixture {
  seed: number
  spans: SignalFx
  logs: SignalFx
  counts: { spans: number; traces: number; logs: number }
  cases: Case[]
}

export const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const hexOf = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const sha = async (b: Uint8Array): Promise<string> => hexOf(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>))
const NS_PER_MS = 1_000_000n

/** Batches (base64) appended to one shard for the tenant, in order, as edge would. */
export async function appendBatches(w: World, t: Tenant, shard: string, batches: string[]): Promise<void> {
  const stub = shardOf(shard)
  for (const b64 of batches) {
    const payload = unb64(b64)
    const r = await stub.append({ tenant: t.name, epoch: w.map.epoch, fingerprint: await sha(payload), payload, rows: 1 })
    if (r.status !== 'ok') throw new Error(`append to ${shard}: ${JSON.stringify(r)}`)
  }
}

/** Every batch of a signal appended to the tenant's shard of that signal (slot 0), in order; each unit's files to R2 and the ledger. */
export async function loadSignal(w: World, t: Tenant, signal: 'traces' | 'logs', fx: SignalFx): Promise<{ shard: string; files: number }> {
  const shard = `${w.map.pool}/${signal}/0`
  const stub = shardOf(shard)
  // The ledger starts before any object of the tenant is in R2, as it does in production (a
  // ledger that finds data objects and no change log refuses to start empty over them).
  await ledgerOf(t).loggedWatermarks()
  await appendBatches(w, t, shard, fx.batches)
  const inc = (await stub.describe(t.name))!.incarnation
  let files = 0
  for (const u of fx.units) {
    const entries: FileEntry[] = []
    for (const f of u.files) {
      const bytes = unb64(f.bytes)
      const hour = f.hour === null ? '' : `hour=${String(f.hour).padStart(2, '0')}/`
      const key = `${env.CELL}/data/${f.table}/tenant=${t.name}/day=${f.day}/${hour}L0-${shard.replaceAll('/', '_')}-${inc}-${u.seqLo}-${u.seqHi}-${(await sha(bytes)).slice(0, 8)}.parquet`
      await env.BUCKET.put(key, bytes)
      entries.push({ table: f.table, day: f.day, key, bytes: bytes.byteLength, rows: f.rows, minTs: Number(BigInt(f.minNs) / NS_PER_MS), maxTs: Number(BigInt(f.maxNs) / NS_PER_MS), level: 0, index: f.index })
      files++
    }
    const r = await ledgerOf(t).addUnit({ shard, incarnation: inc, seqLo: u.seqLo, seqHi: u.seqHi, files: entries })
    if (r.status !== 'ok') throw new Error(`addUnit ${shard} ${u.seqLo}-${u.seqHi}: ${JSON.stringify(r)}`)
  }
  return { shard, files }
}

export async function load(w: World, t: Tenant, fx: Fixture): Promise<void> {
  await loadSignal(w, t, 'traces', fx.spans)
  await loadSignal(w, t, 'logs', fx.logs)
}


// ─────────── through edge and the real flush (test/signals.e2e.test.ts, test/completeness.test.ts) ───────────

/** A push request as sent: path, content type and encoding, the body in base64. */
export interface PushRequest {
  path: string
  contentType: string
  contentEncoding?: string
  body: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Every slot of the derived pools (the tenant's slots are all of them in the test world). */
export const signalShardsOf = (w: World): string[] => (['traces', 'logs'] as const).flatMap((s) => Array.from({ length: w.map.slots }, (_, i) => `${w.map.pool}/${s}/${i}`))

/** One request through edge, resent whole while it is refused for a retryable reason (a new stream registering, backpressure), as a sender does. */
export async function post(t: Tenant, q: PushRequest): Promise<void> {
  for (let i = 0; ; i++) {
    const headers: Record<string, string> = { Authorization: `Bearer ${t.key}`, 'Content-Type': q.contentType, ...(q.contentEncoding ? { 'Content-Encoding': q.contentEncoding } : {}) }
    const res = await exports.default.fetch(`https://viz.test${q.path}`, { method: 'POST', headers, body: unb64(q.body) as Uint8Array<ArrayBuffer> })
    const text = await res.text()
    if (res.status === 200 || res.status === 204) {
      // Nothing of a corpus is refused by validation (the corpus's own decode accepted all of it).
      if (/rejected/i.test(text)) throw new Error(`${q.path}: ${text.slice(0, 300)}`)
      return
    }
    if (![429, 503].includes(res.status) || i > 100) throw new Error(`${q.path}: ${res.status} ${text.slice(0, 300)}`)
    await ledgerOf(t).drain()
    await sleep(20)
  }
}

/** Seal and flush every derived shard of the tenant through the Flush entrypoint, until the ledger has logged what it admitted (its alarm's work, done here). */
export async function flushSignals(w: World, t: Tenant): Promise<number> {
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
