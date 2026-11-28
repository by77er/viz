/// <reference path="../../engine/wasm/js/wasm.d.ts" />
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { EncodedSignalFile } from '../../contracts/engine'
import { createEngine } from '../../engine/wasm/js/index'
import wasm from '../../engine/wasm/js/viz_engine.wasm'
import { type Attrs, type LogRow, type SpanEntry, type SpanRow, encodeLogBatch, encodeSpanBatch } from '../../engine/wasm/test/signal'
import { type FlushEngine, flushTenant } from '../src/index'
import { sha256Hex, shardStub, ledgerStub } from './helpers'

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
function rnd(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { int: (n: number) => Math.floor(next() * n), chance: (p: number) => next() < p }
}
const T0 = BigInt(Date.UTC(2026, 10, 18, 12)) * 1_000_000n
const MiB = 1 << 20
const ids = (r: ReturnType<typeof rnd>, n: number) => Uint8Array.from({ length: n }, () => 1 + r.int(255))
const word = (r: ReturnType<typeof rnd>, n: number) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[r.int(26)]).join('')

function spanBatches(count: number): Uint8Array[] {
  const r = rnd(7)
  const entries: SpanEntry[] = Array.from({ length: 100 }, (_, i) => ({
    resourceFp: BigInt(i + 1),
    resource: [['deployment.environment.name', { s: 'prod' }], ['host.name', { s: `host-${i}` }], ['service.instance.id', { s: `svc-${i % 20}-${i % 5}` }], ['service.name', { s: `svc-${i % 20}` }]] as Attrs,
    scopeName: 'io.opentelemetry.http',
    scopeVersion: '1.2.0',
  }))
  const out: Uint8Array[] = []
  let t = T0
  for (let b = 0; b < count; b++) {
    const rows: SpanRow[] = []
    let bytes = 4096
    while (bytes < MiB - 64 * 1024) {
      const traceId = ids(r, 16)
      const entry = r.int(100)
      const root = ids(r, 8)
      for (let k = 0; k < 6 + r.int(13); k++) {
        const start = t + BigInt(k * 1_000_000)
        const attrs: Attrs = [
          ['enduser.id', { s: `user-${r.int(100_000)}` }],
          ['http.request.method', { s: ['GET', 'POST', 'PUT'][r.int(3)]! }],
          ['http.response.status_code', { i: BigInt([200, 200, 200, 404, 500][r.int(5)]!) }],
          ['http.route', { s: `/api/v1/${word(r, 6)}` }],
          ['net.peer.name', { s: `peer-${r.int(50)}` }],
          ['retry', { b: r.chance(0.1) }],
        ]
        if (r.chance(0.3)) attrs.splice(0, 0, ['db.statement', { s: `SELECT ${word(r, 20 + r.int(160))} FROM t WHERE id = ?` }])
        rows.push({ entry, traceId, spanId: k === 0 ? root : ids(r, 8), parentSpanId: k === 0 ? undefined : root, start, end: start + BigInt(r.int(5e8)), kind: 1 + r.int(5), status: r.chance(0.05) ? 2 : 0, name: `op-${r.int(200)}`, attrs })
        bytes += 94 + 40 + attrs.reduce((a, [k2, v]) => a + k2.length + 9 + ('s' in v ? v.s.length : 8), 0)
      }
      t += 10_000_000n
    }
    out.push(encodeSpanBatch(entries, rows))
  }
  return out
}

function logBatches(count: number): Uint8Array[] {
  const r = rnd(11)
  const streams = Array.from({ length: 50 }, (_, i) => ({ labels: { service_name: `svc-${i % 20}`, k8s_namespace_name: `ns-${i % 5}`, deployment_environment_name: 'prod' } }))
  const out: Uint8Array[] = []
  let t = T0
  for (let b = 0; b < count; b++) {
    const rows: LogRow[] = []
    let bytes = 4096
    while (bytes < MiB - 64 * 1024) {
      const line = `level=${['info', 'warn', 'error'][r.int(3)]} msg="${word(r, 10 + r.int(60))}" request_id=${word(r, 16)} duration=${r.int(900)}ms route=/api/${word(r, 8)} ${word(r, 10 + r.int(100))}`.slice(0, 260)
      const md: [string, string][] = [['pod', `pod-${r.int(40)}`], ['service_instance_id', `inst-${r.int(5)}`]]
      if (r.chance(0.5)) md.push(['user', String(r.int(1000))])
      if (r.chance(0.3)) md.push(['zone', `z${r.int(3)}`])
      md.sort((a, b2) => (a[0] < b2[0] ? -1 : 1))
      rows.push({ entry: r.int(50), ts: t, line, metadata: md, severity: 9, ...(r.chance(0.3) ? { traceId: ids(r, 16), spanId: ids(r, 8) } : {}) })
      bytes += 64 + 24 + line.length + md.reduce((a, [k, v]) => a + 4 + k.length + v.length, 0) + 40
      t += 1_000_000n
    }
    out.push(encodeLogBatch(streams, rows))
  }
  return out
}

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
