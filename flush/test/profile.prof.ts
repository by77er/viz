/// <reference path="../../engine/wasm/js/wasm.d.ts" />
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { EncodedSignalFile, SignalMergeEngine } from '../../contracts/engine'
import type { SignalTable } from '../../contracts/ledger'
import { createEngine } from '../../engine/wasm/js/index'
import wasm from '../../engine/wasm/js/viz_engine.wasm'
import { type FlushEngine, consumeFlushBatch } from '../src/index'
import { ledgerStub, sha256Hex, shardStub } from './helpers'
import { type Latency, NONE, type Op, S10, instrumented } from './instrument'
import { logBatches, spanBatches } from './workload'

/**
 * Where flush spends its time, per unit (D82's profile). NOT part of the suite's claims: it
 * prints `PROFILE {json}` lines that flush/README.md ("Throughput") quotes. Two kinds of number:
 *
 *   - `here`: measured in local workerd (vitest), with miniflare's R2 and Durable Objects.
 *   - `modelled`: the same code with Cloudflare's latencies, as S10 measured them, added in
 *     front of each call (R2 PUT 335 ms, GET 207 ms, HEAD 100 ms (assumed), a ledger RPC 32 ms,
 *     addUnit 47 ms, a shard RPC 32 ms (assumed: the ledger's figure)). Local CPU is not scaled:
 *     Cloudflare's CPU for edge's decode was 1.3 to 2.5 times this machine's (S10), so the
 *     modelled runs are a lower bound where CPU matters.
 *
 * Workload: `streams` streams of one tenant each holding `segments` sealed segments of about
 * 4 MiB of span batches (the shard's default `sealBytes`), all flushed by ONE consumer batch
 * with one message per stream: what the queue hands an invocation under load.
 */

function timedEngine(ops: Op[], t0: number): FlushEngine {
  const eng = createEngine(wasm)
  const wrap = (name: string, f: (b: Uint8Array[]) => EncodedSignalFile[]) => (b: Uint8Array[]) => {
    const s = performance.now()
    try {
      return f(b)
    } finally {
      ops.push({ op: name, start: s - t0, ms: performance.now() - s, inFlightR2: 0 })
    }
  }
  return { ...eng, encodeSpans: wrap('encode', eng.encodeSpans), encodeLogs: wrap('encode', eng.encodeLogs) }
}

/** Fill `streams` streams with `segments` sealed ~4 MiB segments each. */
async function fill(signal: 'traces' | 'logs', streams: number, segments: number, tag: string) {
  const tenant = `p-${signal}-${tag}`
  const names: string[] = []
  for (let s = 0; s < streams; s++) {
    const shardName = `prof-${tag}/${signal}/${s}`
    names.push(shardName)
    const shard = shardStub(shardName)
    await shard.configure({ sealBytes: 1 << 30 })
    const batches = signal === 'traces' ? spanBatches(4 * segments, 7 + s) : logBatches(4 * segments, 11 + s)
    for (const [b, payload] of batches.entries()) {
      const rows = new DataView(payload.buffer, payload.byteOffset).getUint32(8, true)
      expect((await shard.append({ tenant, epoch: 1, fingerprint: await sha256Hex(payload), payload, rows })).status).toBe('ok')
      if (b % 4 === 3) await shard.seal(tenant)
    }
  }
  return { tenant, names }
}

function fakeBatch(tenant: string, names: string[]) {
  const acked: string[] = []
  const retried: string[] = []
  const messages = names.map((shard, i) => ({
    id: `m${i}`,
    timestamp: new Date(),
    attempts: 1,
    body: { tenant, shard },
    ack: () => acked.push(shard),
    retry: () => retried.push(shard),
  }))
  return { batch: { queue: 'viz-flush', messages, ackAll() {}, retryAll() {} } as unknown as MessageBatch<unknown>, acked, retried }
}

function summarise(ops: Op[]) {
  const by = new Map<string, number[]>()
  for (const o of ops) by.set(o.op, [...(by.get(o.op) ?? []), o.ms])
  const out: Record<string, { n: number; total_ms: number; p50_ms: number }> = {}
  for (const [k, v] of [...by].sort()) {
    const s = [...v].sort((a, b) => a - b)
    out[k] = { n: v.length, total_ms: Math.round(v.reduce((a, b) => a + b, 0)), p50_ms: Math.round(s[Math.floor(s.length / 2)]!) }
  }
  return out
}

describe('profile: where flush spends its time (D82)', () => {
  // Before and after alternate, twice each: `before` is this code with D82's three changes turned
  // off (one run at a time, no pipeline, no wait for the log), which is the order of main at 39468db.
  const MODES = { before: { maxConcurrentRuns: 1, pipeline: 1, logWaitMs: 0 }, after: {} } as const
  for (const rep of [1, 2])
  for (const [label, lat] of [['here', NONE], ['modelled', S10]] as const)
  for (const mode of ['before', 'after'] as const) {
    for (const signal of ['traces', 'logs'] as const) {
      it(`one consumer batch, 3 streams x 4 segments of ${signal} (${label}, ${mode}, run ${rep})`, async () => {
        const tag = `${label}-${mode}-${rep}-${signal}-${Date.now().toString(36)}`
        const { tenant, names } = await fill(signal, 3, 4, tag)
        const ops: Op[] = []
        const t0 = performance.now()
        const e = instrumented(lat, ops, t0)
        const { batch, acked, retried } = fakeBatch(tenant, names)
        const outcomes = await consumeFlushBatch(batch, e, timedEngine(ops, t0), MODES[mode])
        const wall = performance.now() - t0
        const segs = outcomes.reduce((a, o) => a + (o.result?.segments.filter((s) => s.outcome === 'admitted').length ?? 0), 0)
        expect(segs).toBe(12)
        // How much of the shards' buffer the batch freed (recorded), and when the last was told.
        const recorded = await Promise.all(names.map(async (n) => (await shardStub(n).describe(tenant))?.recordedThrough ?? 0))
        const ledger = ledgerStub(tenant)
        const files = (await Promise.all((['spans', 'trace_index', 'logs'] as const).map((t) => ledger.plan({ table: t, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })))).flatMap((p) => p.files)
        console.error(
          `PROFILE flush ${JSON.stringify({
            kind: label === 'here' ? 'measured here (local workerd)' : 'modelled (local CPU + S10 Cloudflare latencies)',
            mode,
            rep,
            signal,
            streams: names.length,
            segments: segs,
            wall_ms: Math.round(wall),
            ms_per_segment: Math.round(wall / segs),
            mib_per_s: +((12 * 4) / (wall / 1000)).toFixed(2),
            recorded_through: recorded,
            acked: acked.length,
            retried: retried.length,
            why: outcomes.map((o) => o.why ?? 'done'),
            peak_r2_in_flight: e.peakR2(),
            files: files.length,
            ops: summarise(ops),
          })}`,
        )
      }, 600_000)
    }
  }
})

describe('profile: compaction CPU per input byte (D82)', () => {
  it('merges 2, 4 and 8 flush files of each signal table', async () => {
    const tag = `cmp-${Date.now().toString(36)}`
    const out: unknown[] = []
    for (const signal of ['traces', 'logs'] as const) {
      const { tenant, names } = await fill(signal, 1, 8, `${tag}-${signal}`)
      const eng = createEngine(wasm) as ReturnType<typeof createEngine> & FlushEngine & SignalMergeEngine
      const ops: Op[] = []
      const { batch } = fakeBatch(tenant, names)
      await consumeFlushBatch(batch, instrumented(NONE, ops, 0), eng, {})
      const ledger = ledgerStub(tenant)
      for (const table of (signal === 'traces' ? ['spans', 'trace_index'] : ['logs']) as SignalTable[]) {
        const files = (await ledger.plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files
        // spans: one hour partition (the workload's spans lie in one or two hours); others: one day.
        const groups = new Map<string, typeof files>()
        for (const f of files) {
          const part = table === 'spans' ? /hour=(\d\d)/.exec(f.key)![1]! : f.day
          groups.set(part, [...(groups.get(part) ?? []), f])
        }
        const biggest = [...groups.values()].sort((a, b) => b.length - a.length)[0]!
        const bytes = await Promise.all(biggest.map(async (f) => new Uint8Array(await (await env.BUCKET.get(f.key))!.arrayBuffer())))
        for (const n of [2, 4, 8].filter((k) => k <= bytes.length)) {
          const inputs = bytes.slice(0, n)
          const inBytes = inputs.reduce((a, b) => a + b.byteLength, 0)
          const runs: number[] = []
          for (let i = 0; i < 3; i++) {
            const s = performance.now()
            const m = eng.mergeSignalFiles(table, inputs)
            runs.push(performance.now() - s)
            expect(m.table).toBe(table)
          }
          runs.sort((a, b) => a - b)
          out.push({ table, inputs: n, input_mib: +(inBytes / 1048576).toFixed(2), ms_min: Math.round(runs[0]!), ms_med: Math.round(runs[1]!), ms_per_input_mib: Math.round(runs[1]! / (inBytes / 1048576)), wasm_mb: +(eng.memoryBytes() / 1048576).toFixed(1) })
        }
      }
    }
    console.error(`PROFILE merge ${JSON.stringify({ kind: 'measured here (local workerd, WASM engine)', out })}`)
  }, 600_000)
})
