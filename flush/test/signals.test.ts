/// <reference path="../../engine/wasm/js/wasm.d.ts" />
/**
 * Flush of span and log segments (stage 2 of traces and logs; contracts/TRACES.md and LOGS.md
 * "Object keys", contracts/BATCH.md "Streams per signal"):
 *
 *   - a sealed segment of a `{pool}/traces/{slot}` stream becomes ONE unit of `spans` files (one
 *     per hour of start time, keyed `…/day=D/hour=HH/`) and `trace_index` files (one per day);
 *     a `{pool}/logs/{slot}` segment one unit of `logs` files (one per day). The bytes are what
 *     the engine makes of the segment's batches, the keys what the contracts prescribe;
 *   - the unit and watermark rules are the metric ones: one unit per segment, contiguous, a
 *     second run adds nothing, a crash after PUT or after addUnit converges without a second
 *     object or unit, and the shard is told only what the ledger has LOGGED;
 *   - a segment whose batches are not all of one signal flush knows, or one whose engine lacks
 *     the encoder, is refused (`unreadable_segment`): nothing written, nothing admitted;
 *   - the full sweep lists the derived pools' shards for the signals `INGEST_SIGNALS` enables.
 *
 * Batches are written by the engine's test encoder (`engine/wasm/test/signal.ts`); the files
 * are read back with hyparquet, which shares no code with viz.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { parquetReadObjects } from '../../bench/node_modules/hyparquet/src/index.js'
import { dataKeyPrefix } from '../../contracts/ledger'
import { encodeLogBatch, encodeSpanBatch, id } from '../../engine/wasm/test/signal'
import { bitsOf, encodeBatch } from '../../engine/wasm/test/vzb1'
import type { Shard } from '../../shard/src/shard'
import { type FlushResult, engine, flushTenant, shardsFromPoolMaps } from '../src/index'
import { flushSettled, ledgerStub, listKeys, sha256Hex, shardStub } from './helpers'

let n = 0
const H = 3_600_000_000_000n
/** 2026-11-18T22:30:00Z in ns: a segment's rows reach into the next hour and the next day. */
const NS = BigInt(Date.UTC(2026, 10, 18, 22, 30)) * 1_000_000n

function signalStream(signal: 'traces' | 'logs') {
  const id = `${Date.now().toString(36)}-${n++}`
  const tenant = `sig-${id}`
  const shardName = `pool-${id}/${signal}/0`
  return { tenant, shardName, shard: shardStub(shardName), ledger: ledgerStub(tenant) }
}

const spanBatch = (k: number, start: bigint) =>
  encodeSpanBatch([{ resourceFp: BigInt(k), resource: [['service.name', { s: `svc-${k % 2}` }]] }], [
    { entry: 0, traceId: id(16, k), spanId: id(8, 1), start, end: start + 1_000n, name: `root ${k}`, kind: 2 },
    { entry: 0, traceId: id(16, k), spanId: id(8, 2), parentSpanId: id(8, 1), start: start + 10n, end: start + 20n, name: 'child', status: 2 },
  ])
const logBatch = (k: number, ts: bigint) => encodeLogBatch([{ labels: { service_name: 'api', k: String(k % 2) } }], [{ entry: 0, ts, line: `line ${k}` }, { entry: 0, ts: ts + 1n, line: `line ${k}b`, metadata: [['user', 'ann']] }])

async function put(shard: DurableObjectStub<Shard>, tenant: string, payload: Uint8Array): Promise<void> {
  const rows = new DataView(payload.buffer, payload.byteOffset).getUint32(8, true)
  const r = await shard.append({ tenant, epoch: 1, fingerprint: await sha256Hex(payload), payload, rows })
  if (r.status !== 'ok') throw new Error(`append: ${JSON.stringify(r)}`)
}

const read = async (key: string) => {
  const o = await env.BUCKET.get(key)
  return parquetReadObjects({ file: await o!.arrayBuffer() })
}

/** The key the contracts prescribe for a flush file, from the object's own bytes. */
async function prescribed(key: string, tenant: string, shardName: string, seg: { incarnation: number; seqLo: number; seqHi: number }): Promise<string> {
  const m = /\/data\/(spans|trace_index|logs)\/tenant=[^/]+\/day=(\d{4}-\d{2}-\d{2})\/(?:hour=(\d\d)\/)?L0-/.exec(key)!
  const bytes = new Uint8Array(await (await env.BUCKET.get(key))!.arrayBuffer())
  const hour = m[3] === undefined ? undefined : Number(m[3])
  return `${dataKeyPrefix(env.CELL, m[1] as 'spans', tenant, m[2]!, hour)}L0-${shardName.replaceAll('/', '_')}-${seg.incarnation}-${seg.seqLo}-${seg.seqHi}-${(await sha256Hex(bytes)).slice(0, 8)}.parquet`
}

describe('flushing span segments', () => {
  it('one unit per segment: spans files by hour, trace_index files by day, the engine\'s bytes under the prescribed keys; the shard is told once logged', async () => {
    const { tenant, shardName, shard, ledger } = signalStream('traces')
    const batches = [spanBatch(1, NS), spanBatch(2, NS + H), spanBatch(3, NS + 2n * H)]
    for (const b of batches) await put(shard, tenant, b)
    await shard.seal(tenant)
    await put(shard, tenant, spanBatch(4, NS + 3n * H))
    await shard.seal(tenant)
    const r = await flushSettled(env, engine, tenant, shardName)
    expect(r).toMatchObject({ status: 'ok', awaitingLog: false, recordedThrough: 4 })
    expect(r.segments.map((s) => [s.seqLo, s.seqHi, s.outcome])).toEqual([[1, 3, 'admitted'], [4, 4, 'admitted']])
    const [one, two] = r.segments
    // Segment 1: hours 22 and 23 of the 18th and 00 of the 19th; its traces start on both days.
    expect(one!.files.map((f) => [f.table, f.day, /hour=(\d\d)/.exec(f.key)?.[1] ?? null])).toEqual([
      ['spans', '2026-11-18', '22'], ['spans', '2026-11-18', '23'], ['spans', '2026-11-19', '00'],
      ['trace_index', '2026-11-18', null], ['trace_index', '2026-11-19', null],
    ])
    const expected = engine.encodeSpans(batches)
    for (const [i, f] of one!.files.entries()) {
      expect(f.key).toBe(await prescribed(f.key, tenant, shardName, { incarnation: one!.incarnation, seqLo: 1, seqHi: 3 }))
      const bytes = new Uint8Array(await (await env.BUCKET.get(f.key))!.arrayBuffer())
      expect(await sha256Hex(bytes)).toBe(await sha256Hex(expected[i]!.bytes))
      expect(f.rows).toBe(expected[i]!.rows)
    }
    expect(two!.files.map((f) => f.table)).toEqual(['spans', 'trace_index'])
    // What a reader independent of viz sees: every span once, in the hour of its start.
    const spans = (await Promise.all([...one!.files, ...two!.files].filter((f) => f.table === 'spans').map((f) => read(f.key)))).flat()
    expect(spans.map((s) => s.span_name).sort()).toEqual(['child', 'child', 'child', 'child', 'root 1', 'root 2', 'root 3', 'root 4'])
    // The ledger lists exactly these files, planned by time in milliseconds.
    const plan = await ledger.plan({ table: 'spans', minTs: Number((NS + H) / 1_000_000n), maxTs: Number((NS + H) / 1_000_000n) })
    expect(plan.files.map((f) => f.key)).toEqual([one!.files[1]!.key])
    expect(plan.watermarks.find((w) => w.shard === shardName)).toMatchObject({ seq: 4 })
    const index = await ledger.plan({ table: 'trace_index', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
    expect(index.files.map((f) => f.key).sort()).toEqual([...one!.files, ...two!.files].filter((f) => f.table === 'trace_index').map((f) => f.key).sort())
    expect(await shard.pendingSegments(tenant)).toEqual([])
    // A second run finds nothing to do.
    const again = await flushTenant(env, engine, tenant, shardName)
    expect(again).toMatchObject({ status: 'ok', changed: false, segments: [] })
  })

  it('converges after a crash between PUT and addUnit and after one between addUnit and recorded: same objects, one unit', async () => {
    const { tenant, shardName, shard, ledger } = signalStream('traces')
    await put(shard, tenant, spanBatch(1, NS))
    await shard.seal(tenant)
    const crash = (where: 'afterPut' | 'afterAddUnit') => flushTenant(env, engine, tenant, shardName, { hooks: { [where]: () => { throw new Error(`crash ${where}`) } } })
    await expect(crash('afterPut')).rejects.toThrow('crash afterPut')
    const objects = await listKeys(`${env.CELL}/data/`).then((ks) => ks.filter((k) => k.includes(`tenant=${tenant}/`)))
    expect(objects).toHaveLength(2)
    expect((await ledger.plan({ table: 'spans', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files).toEqual([])
    await expect(crash('afterAddUnit')).rejects.toThrow('crash afterAddUnit')
    const r = await flushSettled(env, engine, tenant, shardName)
    expect(r).toMatchObject({ status: 'ok', recordedThrough: 1 })
    expect(r.segments[0]!.files.every((f) => f.put === 'exists')).toBe(true)
    expect((await listKeys(`${env.CELL}/data/`)).filter((k) => k.includes(`tenant=${tenant}/`))).toEqual(objects)
    const units = (await ledger.plan({ table: 'spans', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files
    expect(units.map((f) => f.key)).toEqual(objects.filter((k) => k.includes('/spans/')))
  })
})

describe('flushing log segments', () => {
  it('one unit per segment of logs files by day; rows across midnight in two files of one unit', async () => {
    const { tenant, shardName, shard, ledger } = signalStream('logs')
    const batches = [logBatch(1, NS), logBatch(2, NS + 2n * H), logBatch(1, NS)] // the third repeats the first: one row each
    for (const b of batches) await put(shard, tenant, b)
    await shard.seal(tenant)
    const r = await flushSettled(env, engine, tenant, shardName)
    expect(r).toMatchObject({ status: 'ok', awaitingLog: false, recordedThrough: 2 }) // the repeated batch was the same bytes: one stored batch
    const files = r.segments[0]!.files
    expect(files.map((f) => [f.table, f.day, f.key.includes('/hour=')])).toEqual([['logs', '2026-11-18', false], ['logs', '2026-11-19', false]])
    for (const f of files) expect(f.key).toBe(await prescribed(f.key, tenant, shardName, { incarnation: r.segments[0]!.incarnation, seqLo: 1, seqHi: 2 }))
    const rows = (await Promise.all(files.map((f) => read(f.key)))).flat()
    expect(rows.map((x) => [x.line, x.ts, x.metadata])).toEqual([['line 1', NS, {}], ['line 1b', NS + 1n, { user: 'ann' }], ['line 2', NS + 2n * H, {}], ['line 2b', NS + 2n * H + 1n, { user: 'ann' }]])
    expect((await ledger.plan({ table: 'logs', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files.map((f) => f.key)).toEqual(files.map((f) => f.key))
  })
})

describe('segments flush refuses', () => {
  const metric = encodeBatch([{ __name__: 'up', job: 'a' }], [{ series: 0, ts: Date.UTC(2026, 10, 18), bits: bitsOf(1) }])
  const cases: [string, Uint8Array[]][] = [
    ['spans and metrics in one segment', [spanBatch(1, NS), metric]],
    ['spans and logs in one segment', [spanBatch(1, NS), logBatch(1, NS)]],
    ['a signal flush does not know', [Object.assign(spanBatch(1, NS).slice(), { 4: 9 })]],
  ]
  for (const [what, payloads] of cases) {
    it(`${what}: unreadable_segment, nothing written or admitted, the segment stays pending`, async () => {
      const { tenant, shardName, shard, ledger } = signalStream('traces')
      for (const p of payloads) await put(shard, tenant, p)
      await shard.seal(tenant)
      const r: FlushResult = await flushTenant(env, engine, tenant, shardName)
      expect(r).toMatchObject({ status: 'error', reason: 'unreadable_segment' })
      expect((await listKeys(`${env.CELL}/data/`)).filter((k) => k.includes(`tenant=${tenant}/`))).toEqual([])
      expect((await ledger.plan({ table: 'spans', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).watermarks).toEqual([])
      expect(await shard.pendingSegments(tenant)).toHaveLength(1)
    })
  }

  it('an engine without the span encoder (an older binding) refuses the segment instead of guessing', async () => {
    const { tenant, shardName, shard } = signalStream('traces')
    await put(shard, tenant, spanBatch(1, NS))
    await shard.seal(tenant)
    const metricsOnly = { ...engine, encodeSpans: undefined, encodeLogs: undefined }
    expect(await flushTenant(env, metricsOnly, tenant, shardName)).toMatchObject({ status: 'error', reason: 'unreadable_segment' })
    expect(await flushSettled(env, engine, tenant, shardName)).toMatchObject({ status: 'ok', recordedThrough: 1 })
  })
})

describe('the full sweep and the derived pools', () => {
  it('lists `{pool}/traces` and `{pool}/logs` shards only for the signals INGEST_SIGNALS enables', async () => {
    const pool = `sweep-${Date.now().toString(36)}`
    const DEFAULT_POOL = JSON.stringify({ pool, slots: 2, spread: 2, epoch: 1 })
    const mine = (names: string[]) => names.filter((x) => x.startsWith(`${pool}/`))
    expect(mine(await shardsFromPoolMaps({ CONFIG: env.CONFIG, DEFAULT_POOL }))).toEqual([`${pool}/0`, `${pool}/1`])
    expect(mine(await shardsFromPoolMaps({ CONFIG: env.CONFIG, DEFAULT_POOL, INGEST_SIGNALS: 'logs' }))).toEqual([`${pool}/0`, `${pool}/1`, `${pool}/logs/0`, `${pool}/logs/1`])
    expect(mine(await shardsFromPoolMaps({ CONFIG: env.CONFIG, DEFAULT_POOL, INGEST_SIGNALS: 'traces,logs' }))).toEqual([`${pool}/0`, `${pool}/1`, `${pool}/logs/0`, `${pool}/logs/1`, `${pool}/traces/0`, `${pool}/traces/1`])
    // A base pool too long for its derived names keeps its own shards and gets no derived ones.
    const long = 'p'.repeat(115)
    expect(await shardsFromPoolMaps({ CONFIG: { list: async () => ({ keys: [], list_complete: true }) } as unknown as KVNamespace, DEFAULT_POOL: JSON.stringify({ pool: long, slots: 1, spread: 1, epoch: 1 }), INGEST_SIGNALS: 'traces' })).toEqual([`${long}/0`])
  })
})
