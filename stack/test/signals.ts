/**
 * Spans and log records in the simulated deployment (stage 2 of traces and logs), for the
 * soak with `INGEST_SIGNALS` on and for the end-to-end test:
 *
 *   SignalModel   every acknowledged span and log record, minus what retention expired (a
 *                 span by the UTC day of its start, a record by the day of its time)
 *   sendSpans     an OTLP/JSON traces request through edge, written by edge's test-side
 *   sendLogs      writers (edge/test/otelhelpers.ts: no code shared with edge/src), resent
 *                 whole until acknowledged, as a sender does; recorded in the model only then
 *   readSignals   what a reader must see now: the ledger's live `spans` / `logs` files (read
 *                 with hyparquet, which shares no code with viz) and every shard's tail above
 *                 its watermark (read filtered by signal, decoded by edge's test-side decoder)
 *   checkSignals  the two equal, the files under the tenant's prefixes and keys
 */
import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import { parquetReadObjects } from '../../bench/node_modules/hyparquet/src/index.js'
import type { LiveFile } from '../../contracts/ledger'
import { decodeLogBatch, decodeSpanBatch, logsJson, postSignal, streamIdOf, tracesJson } from '../../edge/test/otelhelpers'
import type { ExpireResult } from '../../janitor/src/janitor'
import { type PoolMap, shardName, signalPool, slotFor } from '../../shard/src/pool'
import type { Shard, TailBatch } from '../../shard/src/shard'

export const DAY_MS = 86_400_000
const te = new TextEncoder()
const dayOfNs = (ns: bigint): string => new Date(Number(ns / 1_000_000n)).toISOString().slice(0, 10)
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** Accept spans and records up to four days old (the soak writes four UTC days), as `INGEST` does for samples. */
export const SIGNAL_INGEST = {
  INGEST_SIGNALS: 'traces,logs',
  INGEST_LIMITS: JSON.stringify({ acceptBackMs: 4 * DAY_MS + 3_600_000, spanAcceptBackMs: 4 * DAY_MS + 3_600_000, logAcceptBackMs: 4 * DAY_MS + 3_600_000 }),
}

/** What a span and a log record must read back as (a digest of the fields the checks compare). */
export class SignalModel {
  /** `trace/span` → `name @start` */
  readonly spans = new Map<string, { start: bigint; v: string }>()
  /** `stream_id|ts|line|metadata` → `severity` */
  readonly logs = new Map<string, { ts: bigint; v: string }>()
  expire(e: ExpireResult): void {
    for (const s of e.signals ?? []) {
      if (s.error !== undefined) continue
      if (s.tables.includes('spans')) for (const [k, x] of this.spans) if (dayOfNs(x.start) < s.beforeDay) this.spans.delete(k)
      if (s.tables.includes('logs')) for (const [k, x] of this.logs) if (dayOfNs(x.ts) < s.beforeDay) this.logs.delete(k)
    }
  }
  canon(): { spans: string[]; logs: string[] } {
    return { spans: [...this.spans].map(([k, x]) => `${k} ${x.v}`).sort(), logs: [...this.logs].map(([k, x]) => `${k} ${x.v}`).sort() }
  }
}

export const spanKey = (trace: string, span: string) => `${trace}/${span}`
export const logKey = (streamId: bigint, ts: bigint, line: string, metadata: [string, string][]) => `${streamId}|${ts}|${line}|${JSON.stringify(metadata)}`

/** A sender of spans and logs: its resource, and the slot its rows go to in each derived pool. */
export interface Sender {
  service: string
  instance: string
  slots: { traces: number; logs: number }
}

/** Senders of a tenant, so that some route to every slot of each derived pool. */
export function senders(map: PoolMap, tenant: string, n = 8): Sender[] {
  const out: Sender[] = []
  for (let i = 0; i < n; i++) {
    const service = `svc-${i % 3}`
    const instance = `pod-${i}`
    const key = `job=${service}\u0000instance=${instance}`
    out.push({ service, instance, slots: { traces: slotFor(signalPool(map, 'traces')!, tenant, key), logs: slotFor(signalPool(map, 'logs')!, tenant, key) } })
  }
  return out
}

/** The shard names of a pool map's derived pools. */
export const signalShards = (map: PoolMap): string[] => (['traces', 'logs'] as const).flatMap((s) => Array.from({ length: map.slots }, (_, slot) => shardName(signalPool(map, s)!, slot)))

interface Rnd {
  int(n: number): number
  chance(p: number): boolean
}

/**
 * One OTLP/JSON traces request of `n` spans for `sender`, `daysBack` days ago, ids from `r`.
 * Resent whole while it is refused (503/429: a stream registering, an overloaded shard), at
 * most `tries` times; the spans enter the model only when it is acknowledged (200, nothing refused).
 */
export async function sendSpans(model: SignalModel, key: string, sender: Sender, r: Rnd, n: number, daysBack: number, now = Date.now(), tries = 200): Promise<number> {
  const base = BigInt(now - 120_000 - daysBack * DAY_MS - r.int(3 * 3_600_000)) * 1_000_000n
  const traceId = Uint8Array.from({ length: 16 }, () => 1 + r.int(255))
  const spans = Array.from({ length: n }, (_, i) => {
    const spanId = Uint8Array.from({ length: 8 }, () => 1 + r.int(255))
    const start = base + BigInt(i) * 1_000_000n + BigInt(r.int(1000))
    return { traceId, spanId, name: `op-${r.int(5)}`, kind: 1 + r.int(5), start, end: start + BigInt(r.int(1e9)), attrs: [['http.route', { s: `/r/${r.int(4)}` }]] as [string, { s: string }][], statusCode: r.chance(0.2) ? 2 : 0 }
  })
  const body = tracesJson([{ attrs: [['service.name', { s: sender.service }], ['service.instance.id', { s: sender.instance }]], scopes: [{ name: 'lib', spans }] }])
  const status = await resend(() => postSignal('/v1/traces', key, body, 'application/json', { env: SIGNAL_INGEST }), tries)
  // The later of two rows with one key wins (contracts/BATCH.md): so does the model.
  for (const s of spans) model.spans.set(spanKey(hex(s.traceId), hex(s.spanId)), { start: s.start, v: `${s.name} @${s.start}` })
  return status
}

/** One OTLP/JSON logs request of `n` records for `sender`, as `sendSpans`. */
export async function sendLogs(model: SignalModel, key: string, sender: Sender, r: Rnd, n: number, daysBack: number, now = Date.now(), tries = 200): Promise<number> {
  const base = BigInt(now - 120_000 - daysBack * DAY_MS - r.int(3 * 3_600_000)) * 1_000_000n
  const logs = Array.from({ length: n }, (_, i) => ({ time: base + BigInt(i * 1000 + r.int(1000)), severity: [9, 13, 17][r.int(3)]!, body: { s: `request ${r.int(20)} took ${r.int(900)}ms` } }))
  const body = logsJson([{ attrs: [['service.name', { s: sender.service }], ['service.instance.id', { s: sender.instance }]], scopes: [{ logs }] }])
  const status = await resend(() => postSignal('/v1/logs', key, body, 'application/json', { env: SIGNAL_INGEST }), tries)
  // contracts/LOGS.md §1: `service.name` is the stream label; `service.instance.id` is metadata.
  const streamId = streamIdOf([['service_name', sender.service]])
  const md: [string, string][] = [['service_instance_id', sender.instance]]
  for (const x of logs) model.logs.set(logKey(streamId, x.time, x.body.s, md), { ts: x.time, v: `sev ${x.severity}` })
  return status
}

async function resend(post: () => Promise<Response>, tries: number): Promise<number> {
  for (let i = 0; ; i++) {
    const res = await post()
    const text = await res.text()
    if (res.status === 200) {
      expect(text, 'acknowledged without partial success').not.toMatch(/rejected/)
      return i
    }
    if ((res.status !== 503 && res.status !== 429) || i >= tries) throw new Error(`signal ingest: ${res.status} ${text.slice(0, 300)}`)
    await new Promise((x) => setTimeout(x, 50))
  }
}

const SHARD = (name: string) => (env as unknown as { SHARD: DurableObjectNamespace<Shard> }).SHARD.get((env as unknown as { SHARD: DurableObjectNamespace<Shard> }).SHARD.idFromName(name))

/** Every batch of `signal` a shard holds for the tenant above `above`, read filtered and paged. */
async function tail(shard: string, tenant: string, signal: 2 | 3, watermark: { incarnation: number; seq: number } | undefined): Promise<TailBatch[]> {
  const s = SHARD(shard)
  const d = await s.describe(tenant)
  if (!d) return []
  const above = watermark && watermark.incarnation === d.incarnation ? watermark.seq : 0
  const out: TailBatch[] = []
  let cursor: string | undefined
  do {
    const r = await s.tailRead(tenant, d.incarnation, above, { signals: [signal], maxBytes: 1 << 20, ...(cursor ? { cursor } : {}) })
    if (r.status !== 'ok' || !r.page) throw new Error(`tail of ${shard}: ${JSON.stringify(r)}`)
    for (const b of r.batches) expect(b.payload[4], `${shard}: a batch of another signal in a filtered read`).toBe(signal)
    out.push(...r.batches)
    cursor = r.page.next ?? undefined
  } while (cursor)
  return out
}

const rows = async (f: LiveFile) => {
  const o = await env.BUCKET.get(f.key)
  expect(o, `${f.key} is listed but not in R2`).not.toBeNull()
  return parquetReadObjects({ file: await o!.arrayBuffer() })
}

export interface SignalRead {
  spans: string[]
  logs: string[]
  files: LiveFile[]
}

/** What a reader sees now: live files (one ledger version) and every signal shard's tail above its watermark, later winning. */
export async function readSignals(tenant: string, shards: string[]): Promise<SignalRead> {
  const ledger = (env as unknown as { LEDGER: DurableObjectNamespace<import('../../ledger/src/ledger').Ledger> }).LEDGER
  const l = ledger.get(ledger.idFromName(tenant))
  for (let i = 0; ; i++) {
    const [sp, ix, lg] = [await l.plan({ table: 'spans', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER }), await l.plan({ table: 'trace_index', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER }), await l.plan({ table: 'logs', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })]
    if (sp.version !== lg.version || sp.version !== ix.version) {
      expect(i).toBeLessThan(5)
      continue
    }
    const spans = new Map<string, string>()
    const logs = new Map<string, string>()
    for (const f of sp.files) {
      for (const x of await rows(f)) spans.set(spanKey(hex(x.trace_id as Uint8Array), hex(x.span_id as Uint8Array)), `${x.span_name} @${x.start_unix_nano}`)
    }
    for (const f of lg.files) {
      for (const x of await rows(f)) {
        const md = Object.entries((x.metadata ?? {}) as Record<string, string>).sort(([a], [b]) => cmp(a, b))
        logs.set(logKey(x.stream_id as bigint, x.ts as bigint, x.line as string, md), `sev ${x.severity_number ?? 0}`)
      }
    }
    const mark = (s: string) => sp.watermarks.find((w) => w.shard === s)
    for (const s of shards) {
      if (s.includes('/traces/')) for (const b of await tail(s, tenant, 2, mark(s))) for (const x of decodeSpanBatch(b.payload)) spans.set(spanKey(x.traceId, x.spanId), `${x.name} @${x.start}`)
      else for (const b of await tail(s, tenant, 3, mark(s))) for (const x of decodeLogBatch(b.payload)) logs.set(logKey(x.streamId, x.ts, x.line, x.metadata), `sev ${x.severity}`)
    }
    return { spans: [...spans].map(([k, v]) => `${k} ${v}`).sort(), logs: [...logs].map(([k, v]) => `${k} ${v}`).sort(), files: [...sp.files, ...ix.files, ...lg.files] }
  }
}

/** UTF-8 byte order, as the batches sort names. */
function cmp(a: string, b: string): number {
  const x = te.encode(a)
  const y = te.encode(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return x.length - y.length
}

/** A reader sees exactly the model's spans and log records; every signal file is the tenant's. */
export async function checkSignals(tenant: string, model: SignalModel, shards: string[], where: string): Promise<SignalRead> {
  const got = await readSignals(tenant, shards)
  const want = model.canon()
  expect(got.spans.length, `${where}: ${tenant} span count`).toBe(want.spans.length)
  expect(got.spans, `${where}: ${tenant} spans`).toEqual(want.spans)
  expect(got.logs.length, `${where}: ${tenant} log record count`).toBe(want.logs.length)
  expect(got.logs, `${where}: ${tenant} log records`).toEqual(want.logs)
  for (const f of got.files) {
    expect(f.key.includes(`/tenant=${tenant}/`), `${where}: ${f.key} outside the tenant's prefix`).toBe(true)
    if (f.table === 'spans') expect(f.key, `${where}: a spans file keyed by its hour`).toMatch(/\/day=\d{4}-\d{2}-\d{2}\/hour=\d\d\/L0-/)
  }
  return got
}

export { te }
