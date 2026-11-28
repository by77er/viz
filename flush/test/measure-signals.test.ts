/// <reference path="../../engine/wasm/js/wasm.d.ts" />
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { EncodedSignalFile } from '../../contracts/engine'
import { createEngine } from '../../engine/wasm/js/index'
import wasm from '../../engine/wasm/js/viz_engine.wasm'
import { type FlushEngine, flushTenant } from '../src/index'
import { sha256Hex, shardStub, ledgerStub } from './helpers'
import { MiB, logBatches, spanBatches } from './workload'

/**
 * Local measurements in workerd (vitest; NOT Cloudflare) of flushing spans and logs (stage 2):
 * the figures quoted in flush/README.md, "Spans and logs". Each signal: 12 batches of about
 * 1 MiB (what edge cuts), sealed every 4 batches, so a segment is about 4 MiB (the shard's
 * default `sealBytes`); three segments flushed one per run, each run timed around
 * `flushTenant` (read the segment, encode in WASM, SHA-256, PUTs, addUnit, the ledger's logged
 * mark) with the encode call timed inside it. Bytes are what R2 holds: the Parquet files the
 * ledger lists, divided by the rows they hold.
 *
 * The workload (deterministic): spans of 20 services × 5 instances, 200 span names, traces of
 * about 12 spans, 7 attributes a span (route, method, status code, a high-cardinality user id,
 * a peer name, a bool, and in 30% a SQL statement of 40 to 200 bytes); no events or links (the
 * test encoder writes none). Log lines of 80 to 260 bytes of logfmt with a random request id,
 * 50 streams of 3 labels, 2 to 4 metadata entries, 30% with trace ids.
 */
describe('measurements in workerd: flushing spans and logs', () => {
  for (const signal of ['traces', 'logs'] as const) {
    it(`flushes ~4 MiB segments of ${signal === 'traces' ? 'spans' : 'log records'}`, async () => {
      const id = `${Date.now().toString(36)}`
      const tenant = `m-${signal}-${id}`
      const shardName = `meas-${id}/${signal}/0`
      const shard = shardStub(shardName)
      const ledger = ledgerStub(tenant)
      await shard.configure({ sealBytes: 1 << 30 })
      const batches = signal === 'traces' ? spanBatches(12) : logBatches(12)
      const segmentBytes: number[] = []
      for (const [b, payload] of batches.entries()) {
        expect(payload.byteLength).toBeLessThanOrEqual(MiB)
        const rows = new DataView(payload.buffer, payload.byteOffset).getUint32(8, true)
        expect((await shard.append({ tenant, epoch: 1, fingerprint: await sha256Hex(payload), payload, rows })).status).toBe('ok')
        if (b % 4 === 3) segmentBytes.push((await shard.seal(tenant))!.bytes)
      }
      const eng = createEngine(wasm)
      let encodeMs = 0
      let produced: EncodedSignalFile[] = []
      const wrap = (f: (b: Uint8Array[]) => EncodedSignalFile[]) => (b: Uint8Array[]) => {
        const s = performance.now()
        produced = f(b)
        encodeMs = performance.now() - s
        return produced
      }
      const timed: FlushEngine = { ...eng, encodeSpans: wrap(eng.encodeSpans), encodeLogs: wrap(eng.encodeLogs) }
      const runs = []
      for (let i = 0; i < 3; i++) {
        const s = performance.now()
        const r = await flushTenant(env, timed, tenant, shardName, { maxSegments: 1 })
        const wall = performance.now() - s
        expect(r).toMatchObject({ status: 'ok', segments: [{ seqLo: 4 * i + 1, outcome: 'admitted' }] })
        await ledger.drain()
        expect(await flushTenant(env, timed, tenant, shardName, { maxSegments: 1 })).toMatchObject({ status: 'ok', recordedThrough: 4 * (i + 1) })
        const files = r.segments[0]!.files
        const rows = files.filter((f) => f.table !== 'trace_index').reduce((a, f) => a + f.rows, 0)
        const bytes = files.reduce((a, f) => a + f.bytes, 0)
        runs.push({
          segment_bytes: segmentBytes[i],
          rows,
          files: files.map((f) => `${f.table}:${f.bytes}`).join(' '),
          r2_bytes: bytes,
          r2_bytes_per_row: +(bytes / rows).toFixed(1),
          batch_bytes_per_row: +(segmentBytes[i]! / rows).toFixed(1),
          wall_ms: Math.round(wall),
          encode_cpu_ms: Math.round(encodeMs),
          rows_per_s_flush: Math.round(rows / (wall / 1000)),
          rows_per_s_encode: Math.round(rows / (encodeMs / 1000)),
          wasm_memory_mb: +(eng.memoryBytes() / 1048576).toFixed(1),
        })
      }
      // Everything the three units listed is in R2 at the listed size.
      for (const table of signal === 'traces' ? (['spans', 'trace_index'] as const) : (['logs'] as const)) {
        for (const f of (await ledger.plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files) expect((await env.BUCKET.head(f.key))!.size).toBe(f.bytes)
      }
      console.error(`MEASURE ${signal} ${JSON.stringify({ where: 'local workerd (vitest), 1 ms timers; not Cloudflare', runs })}`)
    }, 300_000)
  }
})
