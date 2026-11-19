/**
 * Stage 2 of traces and logs, end to end in one script (stack/README.md, "Traces and logs end
 * to end"): OTLP traces and logs and Loki push through edge, appended to the shards of the
 * derived pools (`{pool}/traces`, `{pool}/logs`), flushed into `spans`, `trace_index` and `logs`
 * files, listed by the ledger, and read back by a reader that shares no code with viz
 * (hyparquet for the files; edge's test-side decoder for the tails).
 *
 * Also: with `INGEST_SIGNALS` off nothing of it runs, and metrics are written byte for byte
 * the same whatever the flag; and, driven by tools/signals_readback.mjs, a whole OTLP corpus
 * through the same path, exported for viz-storage's readers and viz-traceql and viz-logql
 * (tools/signals-readback).
 */
import { env } from 'cloudflare:workers'
import { afterAll, describe, expect, it } from 'vitest'
import { parquetReadObjects } from '../../bench/node_modules/hyparquet/src/index.js'
import { PRECEDENCE_PER_VERSION, TABLES, type LiveFile } from '../../contracts/ledger'
import { makeKey, postWrite, setPool } from '../../edge/test/helpers'
import { lokiProto, postSignal, streamIdOf, tracesProto } from '../../edge/test/otelhelpers'
import { loggedChanges, sha256Hex } from '../../flush/test/helpers'
import { type PoolMap, signalPool, shardName } from '../../shard/src/pool'
import { engine, flushTenant } from '../src/index'
import { quiesce } from './settle'
import { SIGNAL_INGEST, checkSignals, logKey, sendLogs, sendSpans, signalShards, spanKey } from './signals'
import { INGEST, type Sim, checkTenant, createSim, ingest, ledger, rng, shard } from './sim'

let sim: Sim | undefined
afterAll(() => sim?.restore())
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const allFiles = async (tenant: string): Promise<LiveFile[]> =>
  (await Promise.all(TABLES.map((table) => env.LEDGER.get(env.LEDGER.idFromName(tenant)).plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })))).flatMap((p) => p.files)

describe('spans and logs end to end (INGEST_SIGNALS on)', () => {
  it('through edge, the derived pools\' shards, flush and the ledger: a reader sees every acknowledged span and record, from tails, then from files keyed and united as the contracts say', { timeout: 120_000 }, async () => {
    const r = rng(20261119)
    sim = await createSim(1, 8, { signals: true })
    const t = sim.tenants[0]!
    const model = t.signals!
    for (const s of [...sim.shards, ...sim.signalShards]) await shard(s).configure({ sealBytes: 1 << 20, sealAgeMs: 0, retainRecordedMs: 0 })
    // Metrics alongside, as a sender of all three signals would.
    expect(await ingest(sim, t, r, 6, 3, 0)).toBe(204)
    // OTLP/JSON from every sender, over today and the three days before (hour and day boundaries).
    for (const [i, sender] of t.senders!.entries()) {
      await sendSpans(model, t.key, sender, r, 2 + r.int(4), i % 4)
      await sendLogs(model, t.key, sender, r, 2 + r.int(6), i % 4)
    }
    // OTLP/protobuf traces, written by edge's test-side protobuf writer.
    const now = BigInt(Date.now() - 600_000) * 1_000_000n
    const pbSpans = [1, 2, 3].map((k) => ({ traceId: new Uint8Array(16).fill(0x40 + k), spanId: new Uint8Array(8).fill(k), name: `pb ${k}`, start: now + BigInt(k), end: now + BigInt(k) + 50n, kind: 2 }))
    const pb = tracesProto([{ attrs: [['service.name', { s: 'svc-0' }], ['service.instance.id', { s: 'pod-0' }]], scopes: [{ name: 'lib', spans: pbSpans }] }])
    expect((await postSignal('/v1/traces', t.key, pb, 'application/x-protobuf', { env: SIGNAL_INGEST })).status).toBe(200)
    for (const s of pbSpans) model.spans.set(spanKey(hex(s.traceId), hex(s.spanId)), { start: s.start, v: `${s.name} @${s.start}` })
    // Loki push (protobuf, snappy-compressed by the writer), one stream with structured metadata.
    const loki = [{ labels: '{job="nginx", instance="n-1"}', entries: [{ ts: now, line: 'GET / 200', md: [['user', 'ann']] as [string, string][] }, { ts: now + 1n, line: 'GET /x 404' }] }]
    const pushed = await postSignal('/loki/api/v1/push', t.key, lokiProto(loki), 'application/x-protobuf', { env: SIGNAL_INGEST })
    expect(pushed.status, await pushed.clone().text()).toBe(204)
    const sid = streamIdOf([['instance', 'n-1'], ['job', 'nginx']])
    model.logs.set(logKey(sid, now, 'GET / 200', [['user', 'ann']]), { ts: now, v: 'sev 0' })
    model.logs.set(logKey(sid, now + 1n, 'GET /x 404', []), { ts: now + 1n, v: 'sev 0' })

    // Nothing flushed yet: everything comes from the tails, and nothing from the metric pool.
    expect((await checkSignals(t.name, model, sim.signalShards, 'before flush')).files).toEqual([])
    const metricShard = shard(sim.shards[0]!)
    const inc = (await metricShard.describe(t.name))?.incarnation
    if (inc !== undefined) {
      const tail = await metricShard.tailRead(t.name, inc, 0, { signals: [2, 3] })
      expect(tail.status === 'ok' && tail.batches).toEqual([])
    }

    // Seal and flush every shard until the ledger has logged it all (test/settle.ts `quiesce`).
    await quiesce(sim, t)
    const read = await checkSignals(t.name, model, sim.signalShards, 'after flush')
    expect(read.files.length).toBeGreaterThan(0)
    for (const s of sim.signalShards) expect(await shard(s).pendingSegments(t.name)).toEqual([])
    await checkTenant(sim, t, 1000, 'after flush')

    // Units: one per sealed segment, of one signal; spans with their trace_index files.
    const units = (await loggedChanges(t.name)).filter((c) => c.kind === 'add_unit')
    const derived = units.filter((c) => /\/(traces|logs)\/\d+$/.test(c.watermark!.shard))
    expect(derived.length).toBeGreaterThan(0)
    for (const c of derived) {
      const tables = new Set(c.added.map((f) => f.table))
      if (c.watermark!.shard.includes('/traces/')) expect([...tables].sort()).toEqual(['spans', 'trace_index'])
      else expect([...tables]).toEqual(['logs'])
    }
    // Keys and bounds: a spans file under the hour its starts lie in, the others by day.
    for (const f of read.files) {
      const m = /\/data\/(spans|trace_index|logs)\/tenant=([^/]+)\/day=(\d{4}-\d{2}-\d{2})\/(?:hour=(\d\d)\/)?L0-(.+)-(\d+)-(\d+)-(\d+)-([0-9a-f]{8})\.parquet$/.exec(f.key)
      expect(m, f.key).not.toBeNull()
      expect([m![1], m![2], m![3]]).toEqual([f.table, t.name, f.day])
      expect(sim.signalShards).toContain(m![5]!.replaceAll('_', '/'))
      const o = await env.BUCKET.get(f.key)
      const bytes = new Uint8Array(await o!.arrayBuffer())
      expect((await sha256Hex(bytes)).slice(0, 8)).toBe(m![9])
      expect(bytes.byteLength).toBe(f.bytes)
      if (f.table === 'spans') {
        const start = Date.parse(`${f.day}T${m![4]}:00:00Z`)
        expect(f.minTs >= start && f.maxTs < start + 3_600_000, `${f.key}: [${f.minTs}, ${f.maxTs}] inside its hour`).toBe(true)
      } else expect(m![4]).toBeUndefined()
    }
    // trace_index: one row per (trace, unit), counting that unit's spans.
    const idx = read.files.filter((f) => f.table === 'trace_index')
    let counted = 0
    for (const f of idx) for (const row of await parquetReadObjects({ file: await (await env.BUCKET.get(f.key))!.arrayBuffer() })) counted += row.span_count as number
    expect(counted).toBe(model.spans.size)
  })

  it('with INGEST_SIGNALS off nothing of it runs, and metrics are written byte for byte as with it on', { timeout: 120_000 }, async () => {
    const off = `sig-off-${Date.now().toString(36)}`
    const on = `sig-on-${Date.now().toString(36)}`
    const map: PoolMap = { pool: `sigpool-${Date.now().toString(36)}`, slots: 1, spread: 1, epoch: 1 }
    for (const x of [off, on]) await setPool(x, map)
    const [keyOff, keyOn] = [await makeKey(off), await makeKey(on)]
    const body = JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'a' } }] }, scopeSpans: [{ spans: [{ traceId: '01'.repeat(16), spanId: '02'.repeat(8), name: 'x', startTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n), endTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n) }] }] }] })
    for (const [path, ct] of [['/v1/traces', 'application/json'], ['/v1/logs', 'application/json'], ['/loki/api/v1/push', 'application/json']] as const) {
      expect((await postSignal(path, keyOff, path === '/v1/traces' ? body : '{}', ct, { env: { INGEST_SIGNALS: '' } })).status, path).toBe(404)
    }
    for (const s of signalShards(map)) expect(await shard(s).describe(off), s).toBeNull()
    // The same Remote Write request for both tenants, one with the flag on: the same files.
    const T = Date.now() - 300_000
    const series = Array.from({ length: 20 }, (_, i) => ({ labels: [['__name__', 'up'], ['job', 'a'], ['k', String(i)]] as [string, string][], samples: [{ ts: T - i * 1000, value: i }] }))
    expect((await postWrite(keyOff, series, { env: { ...INGEST, INGEST_SIGNALS: '' } })).status).toBe(204)
    expect((await postWrite(keyOn, series, { env: SIGNAL_INGEST })).status).toBe(204)
    const hashes: string[][] = []
    for (const x of [off, on]) {
      const s = shard(shardName(map, 0))
      await s.seal(x)
      for (let i = 0; i < 5; i++) {
        const res = await flushTenant(env, engine, x, shardName(map, 0))
        expect(res.status).toBe('ok')
        if (!res.awaitingLog) break
        await ledger({ name: x } as never).drain()
      }
      const files = await allFiles(x)
      expect(files.map((f) => f.table).sort()).toEqual(['metric_samples', 'metric_series'])
      hashes.push(await Promise.all(files.map(async (f) => `${f.table} ${f.rows} ${await sha256Hex(new Uint8Array(await (await env.BUCKET.get(f.key))!.arrayBuffer()))}`)))
      // Only metric streams in the ledger.
      expect((await env.LEDGER.get(env.LEDGER.idFromName(x)).loggedWatermarks()).map((w) => w.shard)).toEqual([shardName(map, 0)])
    }
    expect(hashes[0]).toEqual(hashes[1])
  })
})

/** The corpus mode (tools/signals_readback.mjs): only when the config handed it the requests. */
const corpus = (env as unknown as { SIGNALS_CORPUS_REQUESTS?: string; SIGNALS_CORPUS_NOW_MS?: string })
describe.skipIf(!corpus.SIGNALS_CORPUS_REQUESTS)('an OTLP corpus through the write path, exported for the engines (tools/signals_readback.mjs)', () => {
  it('posts every request through edge, flushes everything, and prints the ledger\'s live files', { timeout: 1_800_000 }, async () => {
    const requests = JSON.parse(corpus.SIGNALS_CORPUS_REQUESTS!) as { path: string; contentType: string; contentEncoding?: string; body: string }[]
    // The corpus was decoded with its own clock: accept everything around it (contract limits stay).
    const limits = { maxSpans: 1e7, maxLogRecords: 1e7, maxDecompressedBytes: 1 << 30, maxBodyBytes: 1 << 30, spanAcceptBackMs: 1e13, spanAcceptAheadMs: 1e13, logAcceptBackMs: 1e13, logAcceptAheadMs: 1e13 }
    const ingestEnv = { INGEST_SIGNALS: 'traces,logs', INGEST_LIMITS: JSON.stringify(limits) }
    sim = await createSim(1, 1, { signals: true })
    const t = sim.tenants[0]!
    // Small segments: many units, so duplicates and retries cross units as they do in production.
    for (const s of sim.signalShards) await shard(s).configure({ sealBytes: 256 << 10, sealAgeMs: 0, retainRecordedMs: 0 })
    let refusals = 0
    for (const q of requests) {
      const body = Uint8Array.from(atob(q.body), (c) => c.charCodeAt(0))
      for (let i = 0; ; i++) {
        const res = await postSignal(q.path, t.key, body, q.contentType, { env: ingestEnv, headers: q.contentEncoding ? { 'Content-Encoding': q.contentEncoding } : {} })
        const text = await res.text()
        if (res.status === 200 || res.status === 204) {
          expect(text, q.path).not.toMatch(/rejected/)
          break
        }
        expect([429, 503], `${q.path}: ${res.status} ${text.slice(0, 200)}`).toContain(res.status)
        expect(i).toBeLessThan(200)
        refusals++
        await new Promise((x) => setTimeout(x, 50))
      }
    }
    await quiesce(sim, t)
    for (const s of sim.signalShards) expect(await shard(s).pendingSegments(t.name)).toEqual([])
    const files = (await allFiles(t.name)).filter((f) => f.table === 'spans' || f.table === 'trace_index' || f.table === 'logs')
    const units = (await loggedChanges(t.name)).filter((c) => c.kind === 'add_unit' && /\/(traces|logs)\/\d+$/.test(c.watermark!.shard))
    console.log(`SIGNALS_EXPORT_SUMMARY ${JSON.stringify({ requests: requests.length, refusals, units: units.length, files: files.length, bytes: files.reduce((a, f) => a + f.bytes, 0), rows: Object.fromEntries(['spans', 'trace_index', 'logs'].map((x) => [x, files.filter((f) => f.table === x).reduce((a, f) => a + f.rows, 0)])) })}`)
    for (const [i, f] of files.entries()) {
      const m = /\/L0-(.+)-(\d+)-(\d+)-(\d+)-[0-9a-f]{8}\.parquet$/.exec(f.key)!
      const bytes = new Uint8Array(await (await env.BUCKET.get(f.key))!.arrayBuffer())
      let b64 = ''
      for (let k = 0; k < bytes.length; k += 0x8000) b64 += btoa(String.fromCharCode(...bytes.subarray(k, k + 0x8000)))
      const hour = /\/hour=(\d\d)\//.exec(f.key)?.[1]
      console.log(`SIGNALS_EXPORT_FILE ${JSON.stringify({ i, key: f.key, table: f.table, day: f.day, hour: hour === undefined ? null : Number(hour), rows: f.rows, bytes: f.bytes, minTs: f.minTs, maxTs: f.maxTs, order: Math.floor(f.precedence / PRECEDENCE_PER_VERSION), unit: `${m[1]}:${m[2]}:${m[3]}-${m[4]}`, index: f.index, parts: Math.ceil(b64.length / 60_000) })}`)
      for (let k = 0, part = 0; k < b64.length; k += 60_000, part++) console.log(`SIGNALS_EXPORT_PART ${i} ${part} ${b64.slice(k, k + 60_000)}`)
    }
    console.log('SIGNALS_EXPORT_END')
  })
})
