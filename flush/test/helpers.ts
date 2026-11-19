import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import type { Ledger } from '../../ledger/src/ledger'
import type { Shard } from '../../shard/src/shard'
import { type Row, bitsOf, encodeBatch } from '../../engine/wasm/test/vzb1'
import type { Engine } from '../../contracts/engine'
import type { LedgerChange } from '../../contracts/ledger'
import { type FlushEnv, type FlushOptions, type FlushResult, flushTenant } from '../src/flush'
import { engine } from '../src/index'
import { readTenant } from './read'

export const T0 = Date.UTC(2026, 10, 18, 12)
export const DAY_MS = 86_400_000

let n = 0
/** A fresh tenant and shard, so tests never see each other's objects. */
export function stream(prefix = 't') {
  const id = `${Date.now().toString(36)}-${n++}`
  const tenant = `${prefix}-${id}`
  const shardName = `pool-${id}/0`
  return { tenant, shardName, shard: shardStub(shardName), ledger: ledgerStub(tenant) }
}
export const shardStub = (name: string): DurableObjectStub<Shard> => env.SHARD.get(env.SHARD.idFromName(name))
export const ledgerStub = (tenant: string): DurableObjectStub<Ledger> => env.LEDGER.get(env.LEDGER.idFromName(tenant))

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** What was sent, as the read path must return it: last write wins per (labels, ts). */
export class Sent {
  private readonly m = new Map<string, Map<number, bigint>>()
  add(labels: Record<string, string>, ts: number, bits: bigint): void {
    const key = JSON.stringify(Object.entries(labels).filter(([, v]) => v !== '').sort(([a], [b]) => (a < b ? -1 : 1)))
    let s = this.m.get(key)
    if (!s) this.m.set(key, (s = new Map()))
    s.set(ts, bits)
  }
  /** Every sample that a read must return: `[labels, ts, bits]`. */
  samples(): { labels: Record<string, string>; ts: number; bits: bigint }[] {
    const out: { labels: Record<string, string>; ts: number; bits: bigint }[] = []
    for (const [labels, s] of this.m) {
      const obj = Object.fromEntries(JSON.parse(labels) as [string, string][])
      for (const [ts, bits] of s) out.push({ labels: obj, ts, bits })
    }
    return out
  }
  get size(): number {
    let k = 0
    for (const s of this.m.values()) k += s.size
    return k
  }
  canon(): string[] {
    const out: string[] = []
    for (const [labels, s] of this.m) for (const [ts, bits] of s) out.push(`${labels} @${ts} =${bits.toString(16)}`)
    return out.sort()
  }
}

export interface Sample {
  labels: Record<string, string>
  ts: number
  value: number | bigint
}

/** Append one batch of samples to a shard, as `edge` would, and remember them in `sent`. */
export async function append(shard: DurableObjectStub<Shard>, tenant: string, samples: Sample[], sent?: Sent): Promise<Uint8Array> {
  const series: Record<string, string>[] = []
  const index = new Map<string, number>()
  const rows: Row[] = samples.map((s) => {
    const k = JSON.stringify(s.labels)
    let i = index.get(k)
    if (i === undefined) {
      i = series.length
      series.push(s.labels)
      index.set(k, i)
    }
    const bits = typeof s.value === 'bigint' ? s.value : bitsOf(s.value)
    sent?.add(s.labels, s.ts, bits)
    return { series: i, ts: s.ts, bits }
  })
  const payload = encodeBatch(series, rows)
  const r = await shard.append({ tenant, epoch: 1, fingerprint: await sha256Hex(payload), payload, rows: rows.length })
  if (r.status !== 'ok') throw new Error(`append: ${r.status}`)
  return payload
}

/** `count` samples of a few series for one tenant, values derived from `seed`. */
export function someSamples(tenant: string, t: number, count: number, seed = 0): Sample[] {
  return Array.from({ length: count }, (_, i) => ({
    labels: { __name__: i % 3 === 0 ? 'up' : 'http_requests_total', job: 'api', instance: `i-${i % 4}`, tenant_marker: tenant },
    ts: t + Math.floor(i / 4) * 15_000,
    value: seed * 1000 + i,
  }))
}

export const read = (tenant: string, shards: string[], opts: Parameters<typeof readTenant>[4] = {}) => readTenant(env, engine, tenant, shards, opts)

/**
 * Flush until the ledger's LOGGED watermark has caught up (`awaitingLog: false`), the way
 * production gets there: the ledger drains its log in the background (contracts/LEDGER-LOG.md),
 * the consumer retries `awaiting_log`, and the next run tells the shard `recorded`. Here the
 * drain is run at once (`drain()`, what the ledger's alarm does) and the flush repeated. With a
 * ledger that logs before it answers this is one plain run. The result is the last run's,
 * with every segment as the run that FIRST handled it saw it (what was written and admitted).
 */
export async function flushSettled(
  e: FlushEnv,
  eng: Engine,
  tenant: string,
  shardName: string,
  opts: FlushOptions = {},
): Promise<FlushResult> {
  const first = await flushTenant(e, eng, tenant, shardName, opts)
  let last = first
  const seen = new Map(first.segments.map((g) => [g.seqLo, g]))
  let changed = first.changed
  for (let i = 0; i < 5 && last.status === 'ok' && last.awaitingLog; i++) {
    await e.LEDGER.get(e.LEDGER.idFromName(tenant)).drain()
    last = await flushTenant(e, eng, tenant, shardName, opts)
    changed ||= last.changed
    for (const g of last.segments) if (!seen.has(g.seqLo)) seen.set(g.seqLo, g)
  }
  return { ...last, changed, segments: [...seen.values()].sort((a, b) => a.seqLo - b.seqLo) }
}

/**
 * Make the ledger's R2 writes fail (its change log cannot be written). Lasts until `heal` or
 * eviction. Waits first until the ledger has started (its base segment is written before it
 * serves anything: contracts/LEDGER-LOG.md), so what fails is the log, not the start.
 */
export const breakLedgerLog = async (l: DurableObjectStub<Ledger>) => {
  await l.loggedWatermarks()
  await runInDurableObject(l, (inst: Ledger) => {
    const real = env.BUCKET
    const broken = new Proxy(real, {
      get(target, prop) {
        if (prop === 'put') return async () => { throw new Error('injected R2 failure') }
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    ;(inst as unknown as { bucket: R2Bucket }).bucket = broken
  })
}
export const healLedgerLog = (l: DurableObjectStub<Ledger>) =>
  runInDurableObject(l, (inst: Ledger) => { (inst as unknown as { bucket: R2Bucket }).bucket = env.BUCKET })

/** The ledger loses its Durable Object storage and restarts (it rebuilds from its R2 log). */
export async function loseLedgerStorage(l: DurableObjectStub<Ledger>): Promise<void> {
  await runInDurableObject(l, async (_i, state) => { await state.storage.deleteAll() })
  await evictDurableObject(l)
}

/** Let the shard discard everything that is recorded (retention 0), as its alarm would later. */
export async function discardRecorded(shard: DurableObjectStub<Shard>): Promise<void> {
  await shard.configure({ retainRecordedMs: 0 })
  await runDurableObjectAlarm(shard)
}

export async function listKeys(prefix: string): Promise<string[]> {
  const out: string[] = []
  let cursor: string | undefined
  do {
    const page = await env.BUCKET.list({ prefix, cursor })
    out.push(...page.objects.map((o) => o.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out.sort()
}

/**
 * Every change in a tenant's ledger log in R2, in order, read from the objects alone (not with
 * the ledger's codec): contracts/LEDGER-LOG.md segments `{inc}/seg-{first}-{last}.jsonl` (a
 * header line, then one change per line) and checkpoints are both accepted, as is the first
 * layout (`{inc}/{version}.json`). Each segment is checked against its key. Bases and
 * checkpoints are left out. Reads only what is logged: drain the ledger first to see more.
 */
export async function loggedChanges(tenant: string): Promise<LedgerChange[]> {
  const out: LedgerChange[] = []
  for (const key of await listKeys(`${env.CELL}/ledger/tenant=${tenant}/`)) {
    const text = await (await env.BUCKET.get(key))!.text()
    const seg = /\/(\d+)\/seg-(\d{12})-(\d{12})\.jsonl$/.exec(key)
    if (seg) {
      const [head, ...lines] = text.split('\n')
      const h = JSON.parse(head!) as { v: number; kind: string; ledgerIncarnation: number; firstVersion: number; lastVersion: number; changes: number }
      if (h.v !== 1 || h.kind !== 'viz.ledger.segment' || h.ledgerIncarnation !== Number(seg[1]) || h.firstVersion !== Number(seg[2]) || h.lastVersion !== Number(seg[3])) {
        throw new Error(`${key}: header ${head} does not match its key`)
      }
      if (lines.pop() !== '' || lines.length !== h.changes) throw new Error(`${key}: ${lines.length} lines for ${h.changes} changes`)
      lines.forEach((line, i) => {
        const c = JSON.parse(line) as LedgerChange
        if (c.version !== h.firstVersion + i) throw new Error(`${key}: line ${i + 2} is version ${c.version}`)
        out.push(c)
      })
    } else if (/\/\d+\/\d{12}\.json$/.test(key)) out.push(JSON.parse(text) as LedgerChange)
  }
  return out.filter((c) => c.kind !== 'base').sort((a, b) => a.ledgerIncarnation - b.ledgerIncarnation || a.version - b.version)
}

/** Data objects of one tenant in R2, whatever the ledger says. */
export const dataKeys = async (tenant: string): Promise<string[]> =>
  [...(await listKeys(`${env.CELL}/data/metric_samples/tenant=${tenant}/`)), ...(await listKeys(`${env.CELL}/data/metric_series/tenant=${tenant}/`))].sort()

/** Live files of both tables according to the ledger. */
export async function liveKeys(l: DurableObjectStub<Ledger>): Promise<string[]> {
  const a = await l.plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
  const b = await l.plan({ table: 'metric_series', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
  return [...a.files, ...b.files].map((f) => f.key).sort()
}
