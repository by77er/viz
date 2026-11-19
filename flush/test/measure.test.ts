import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Engine } from '../../contracts/engine'
import { createEngine } from '../../engine/wasm/js/index'
import wasm from '../../engine/wasm/js/viz_engine.wasm'
import { scrapeBatch } from '../../engine/wasm/test/vzb1'
import { flushTenant } from '../src/index'
import { sha256Hex, stream } from './helpers'

/**
 * Local measurements in workerd (vitest; NOT Cloudflare): the figures quoted in the README.
 * One hour of data for 2,000 series at a 15 s interval: 480,000 samples in 12 batches of
 * about 1 MB (20 scrapes each), sealed every 4 batches, so a segment is about 4 MB.
 * Two segments are flushed (40 minutes in the lake); the third stays in the shard's tail.
 *
 * Timers in workerd have 1 ms resolution. "encode" is the synchronous WASM call, so its wall
 * time is CPU time; the rest of a flush is I/O against local Durable Objects and local R2.
 */
describe('measurements in workerd', () => {
  it('flushes ~4 MB segments and selects one hour for 2,000 series from lake + tail', async () => {
    const { tenant, shardName, shard, ledger } = stream('m')
    await shard.configure({ sealBytes: 1 << 30 })
    const T = Date.UTC(2026, 10, 18, 12)
    const STEP = 15_000
    const segmentBytes: number[] = []
    let rows = 0
    for (let b = 0; b < 12; b++) {
      const payload = scrapeBatch(2000, T + b * 20 * STEP, STEP, 20, b * 40_000)
      expect(payload.byteLength).toBeLessThanOrEqual(1 << 20)
      const r = await shard.append({ tenant, epoch: 1, fingerprint: await sha256Hex(payload), payload, rows: 40_000 })
      expect(r.status).toBe('ok')
      rows += 40_000
      if (b % 4 === 3) segmentBytes.push((await shard.seal(tenant))!.bytes)
    }
    expect(rows).toBe(480_000)

    // ── flush, one segment per run ──
    const flushEngine = createEngine(wasm)
    let encodeMs = 0
    const timed: Engine = {
      ...flushEngine,
      encodeSegment: (batches) => {
        const s = performance.now()
        const out = flushEngine.encodeSegment(batches)
        encodeMs = performance.now() - s
        return out
      },
    }
    const flushes = []
    for (let i = 0; i < 2; i++) {
      const s = performance.now()
      const r = await flushTenant(env, timed, tenant, shardName, { maxSegments: 1 })
      const wall = performance.now() - s
      expect(r).toMatchObject({ status: 'ok', awaitingLog: true, segments: [{ seqLo: 4 * i + 1, outcome: 'admitted' }] })
      // Not timed: the ledger's log catches up (its alarm), and a run records the segment.
      await ledger.drain()
      expect(await flushTenant(env, timed, tenant, shardName, { maxSegments: 1 })).toMatchObject({ status: 'ok', recordedThrough: 4 * (i + 1), awaitingLog: false })
      flushes.push({
        segment_bytes: segmentBytes[i],
        rows: r.segments[0]!.files[0]!.rows,
        parquet_bytes: r.segments[0]!.files.map((f) => f.bytes),
        wall_ms: Math.round(wall),
        encode_cpu_ms: Math.round(encodeMs),
        io_and_hash_ms: Math.round(wall - encodeMs),
        wasm_memory_mb: +(flushEngine.memoryBytes() / 1048576).toFixed(1),
      })
    }

    // ── select: 1 hour, 2,000 series, lake (40 min) + tail (20 min) ──
    const select = []
    let last = { series: 0, samples: 0 }
    for (let i = 0; i < 5; i++) {
      const reader = createEngine(wasm) // fresh instance: its memory is this query's peak
      const t0 = performance.now()
      const plan = await ledger.plan({ table: 'metric_samples', minTs: T, maxTs: T + 3_600_000 })
      const seriesPlan = await ledger.plan({ table: 'metric_series', minTs: T, maxTs: T + 3_600_000 })
      const get = async (key: string) => new Uint8Array(await (await env.BUCKET.get(key))!.arrayBuffer())
      const sampleFiles = await Promise.all(plan.files.map((f) => get(f.key)))
      const seriesFiles = await Promise.all(seriesPlan.files.map((f) => get(f.key)))
      const w = plan.watermarks[0]!
      const tail = await shard.tailRead(tenant, w.incarnation, w.seq)
      if (tail.status !== 'ok') throw new Error(tail.status)
      const t1 = performance.now()
      const out = reader.select({ seriesFiles, sampleFiles, tailBatches: tail.batches.map((b) => b.payload) }, [], T, T + 3_600_000)
      const t2 = performance.now()
      last = { series: out.length, samples: out.reduce((a, s) => a + s.ts.length, 0) }
      const one = reader.select({ seriesFiles, sampleFiles, tailBatches: tail.batches.map((b) => b.payload) }, [{ name: '__name__', op: '=', value: 'http_requests_total_7' }], T, T + 3_600_000)
      const t3 = performance.now()
      expect(one.length).toBe(100)
      select.push({
        fetch_io_ms: Math.round(t1 - t0),
        select_cpu_ms: Math.round(t2 - t1),
        select_one_metric_cpu_ms: Math.round(t3 - t2),
        wasm_memory_mb: +(reader.memoryBytes() / 1048576).toFixed(1),
        lake_bytes: sampleFiles.reduce((a, f) => a + f.byteLength, 0) + seriesFiles.reduce((a, f) => a + f.byteLength, 0),
        tail_bytes: tail.batches.reduce((a, b) => a + b.payload.byteLength, 0),
      })
    }
    expect(last).toEqual({ series: 2000, samples: 480_000 })
    console.error('MEASURE ' + JSON.stringify({ where: 'local workerd (vitest), 1 ms timers; not Cloudflare', flushes, select_1h_2000_series: { ...last, runs: select } }))
  }, 120_000)
})
