/// <reference path="../../engine/wasm/js/wasm.d.ts" />
/**
 * Time bounds of span and log batches against EDGE's real encoders (review of D72, m-6 and m-1;
 * design/reviews/d72-shard-bounds.md). Adopted from the review's reproduction (its blocks R1, R2
 * and R5b, `review-d72.test.ts`), with R2 now asserting the fixed behaviour.
 *
 *   R1   random OTLP/JSON traces, OTLP/JSON logs and Loki push requests with adversarial content,
 *        decoded and encoded by edge (`SpanCollector`, `LogCollector`): the walk's bounds equal the
 *        engine flush's floors on every batch edge builds, and no batch edge builds goes unbounded;
 *        also a batch at the contract's entry limits
 *   R2   (m-1) a batch whose flags or reserved bytes are not zero, and a modelled later layout that
 *        signals itself by a flag and adds a field after the entry table: no bounds, so a read of
 *        exactly its rows' time keeps it (before the fix the walk recorded wrong bounds and the
 *        read skipped it)
 *   R5b  (m-4) the most expensive shapes edge builds for the walk (every span its own resource of
 *        128 attributes; every log record its own stream): the walk still equals the flush (its
 *        cost is measured in bench/walk.node.mjs, not here)
 *
 * The engine's flush (`encodeSpans`, `encodeLogs`) is the independent reader. Edge's encoder shares
 * no code with the shard's walk.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, type Limits } from '../../edge/src/limits'
import { LogCollector, decodeLogsJson, decodeLokiJson } from '../../edge/src/logs'
import { SpanCollector, decodeTracesJson } from '../../edge/src/spans'
import { createEngine } from '../../engine/wasm/js/index'
import wasm from '../../engine/wasm/js/viz_engine.wasm'
import { MAX_BATCH_BYTES, type Shard, type TailBatch, type TailReadOptions } from '../src/shard'
import { batchTimeBounds } from '../src/tail'

const engine = createEngine(wasm)
const te = new TextEncoder()
const MS = 1_000_000n
const HOUR = 3_600_000n * MS
const MAX_NS = (1n << 63n) - 1n
type Stub = DurableObjectStub<Shard>
let uidN = 0
const uid = () => `${Date.now().toString(36)}-${uidN++}`

function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (k: number) => Math.floor(next() * k)
  const big = (k: bigint) => ((BigInt(int(2 ** 30)) << 60n) | (BigInt(int(2 ** 30)) << 30n) | BigInt(int(2 ** 30))) % k
  return { next, int, big }
}
type R = ReturnType<typeof rng>

// A wide accept window so times from 0 to 2^63 - 1 pass edge (a deployment's window is 24 h back).
const WIDE: Limits = { ...DEFAULT_LIMITS, spanAcceptBackMs: Number.MAX_SAFE_INTEGER, spanAcceptAheadMs: 2 ** 52, logAcceptBackMs: Number.MAX_SAFE_INTEGER, logAcceptAheadMs: 2 ** 52 }
const NOW = Date.UTC(2026, 10, 19, 12)
const NS_NOW = BigInt(NOW) * MS

const CHARS = ['a', 'Z', '_', '.', '/', 'é', '日本', '😀', '\u0000', '"', '\\', '\n', ' ', '0']
const str = (r: R, max: number) => {
  const n = r.int(max + 1)
  let s = ''
  while (s.length < n) s += CHARS[r.int(CHARS.length)]
  return s
}
const hex = (n: number, r: R) => Array.from({ length: n }, () => (1 + r.int(255)).toString(16).padStart(2, '0')).join('')

function anyValue(r: R, depth: number): Record<string, unknown> {
  switch (r.int(depth > 2 ? 5 : 8)) {
    case 0: return { stringValue: r.int(20) === 0 ? 'x'.repeat(r.int(3) === 0 ? 65_536 : 4000) : str(r, 30) }
    case 1: return { intValue: String(BigInt.asIntN(64, r.big(1n << 64n))) }
    case 2: return { doubleValue: [0.1, -0, 1e308, 'NaN', 'Infinity', '-Infinity', 5e-324][r.int(7)] }
    case 3: return { boolValue: r.int(2) === 0 }
    case 4: return { bytesValue: btoa(String.fromCharCode(...Array.from({ length: r.int(40) }, () => r.int(256)))) }
    case 5: return { arrayValue: r.int(5) === 0 ? {} : { values: Array.from({ length: r.int(5) }, () => anyValue(r, depth + 1)) } }
    case 6: return { kvlistValue: r.int(5) === 0 ? {} : { values: Array.from({ length: r.int(5) }, () => ({ key: str(r, 8) || 'k', value: anyValue(r, depth + 1) })) } }
    default: return {}
  }
}
function attrs(r: R, max: number): { key: string; value: Record<string, unknown> }[] {
  const n = r.int(6) === 0 ? max : r.int(Math.min(max, 12) + 1)
  return Array.from({ length: n }, (_, i) => ({
    key: r.int(30) === 0 ? 'k'.repeat(1024) : r.int(30) === 1 ? `${'é'.repeat(511)}${i}` : `${str(r, 12)}${i}`,
    value: anyValue(r, 0),
  }))
}

/** A time in ns as a decimal string, with mode-dependent distribution (edges of ms included). */
function time(r: R, mode: number): bigint {
  let t: bigint
  if (mode === 0) t = NS_NOW - r.big(30n * HOUR) + r.big(HOUR)
  else if (mode === 1) t = r.big(MAX_NS)
  else t = [0n, 1n, MS - 1n, MS, MAX_NS, MAX_NS - 1n, (MAX_NS / MS) * MS, (MAX_NS / MS) * MS - 1n][r.int(8)]!
  if (r.int(3) === 0) t = (t / MS) * MS + (r.int(2) === 0 ? 0n : MS - 1n)
  return t < 0n ? 0n : t > MAX_NS ? MAX_NS : t
}

function traceRequest(r: R, mode: number) {
  return {
    resourceSpans: Array.from({ length: 1 + r.int(4) }, (_, k) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: `svc-${k}-${str(r, 4)}` } }, ...attrs(r, 127)] },
      scopeSpans: Array.from({ length: 1 + r.int(3) }, () => ({
        scope: { name: r.int(10) === 0 ? 'n'.repeat(8192) : str(r, 10), version: str(r, 5), attributes: r.int(2) === 0 ? [] : attrs(r, 20) },
        spans: Array.from({ length: 1 + r.int(40) }, () => {
          const start = time(r, mode)
          const end = r.int(4) === 0 ? (start > 5n ? start - 5n : 0n) : start + r.big(10n * HOUR) > MAX_NS ? MAX_NS : start + r.big(10n * HOUR)
          return {
            traceId: hex(16, r), spanId: hex(8, r), parentSpanId: r.int(2) === 0 ? '' : hex(8, r),
            name: str(r, 20), kind: r.int(6), startTimeUnixNano: String(start), endTimeUnixNano: String(end),
            attributes: attrs(r, 30), traceState: str(r, 5),
            events: Array.from({ length: r.int(3) }, () => ({ timeUnixNano: String(time(r, 1)), name: str(r, 5), attributes: attrs(r, 4) })),
            links: Array.from({ length: r.int(2) }, () => ({ traceId: hex(16, r), spanId: hex(8, r), traceState: '', attributes: attrs(r, 3) })),
            status: { code: r.int(3), message: str(r, 5) },
          }
        }),
      })),
    })),
  }
}

function logRequest(r: R, mode: number) {
  return {
    resourceLogs: Array.from({ length: 1 + r.int(4) }, (_, k) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: `svc-${k}` } }, { key: 'deployment.environment.name', value: anyValue(r, 1) }, ...attrs(r, 10).map((a) => ({ key: a.key.replace(/[^A-Za-z0-9_.]/g, '_') || 'k', value: a.value }))] },
      scopeLogs: Array.from({ length: 1 + r.int(3) }, () => ({
        scope: { name: str(r, 5), attributes: r.int(2) === 0 ? [] : attrs(r, 4).map((a) => ({ key: a.key.replace(/[^A-Za-z0-9_.]/g, '_') || 'k', value: a.value })) },
        logRecords: Array.from({ length: 1 + r.int(40) }, () => {
          const ts = time(r, mode)
          const which = r.int(4)
          // which 0: ts only; 1: observed only (edge takes it as ts); 2: both, observed far away; 3: both equal
          return {
            ...(which === 1 ? {} : { timeUnixNano: String(ts) }),
            ...(which === 0 ? {} : { observedTimeUnixNano: String(which === 2 ? (ts > HOUR ? ts - HOUR : ts + HOUR) : ts) }),
            severityNumber: r.int(25), severityText: str(r, 4), body: anyValue(r, 0),
            attributes: attrs(r, 6).map((a) => ({ key: a.key.replace(/[^A-Za-z0-9_.]/g, '_') || 'k', value: a.value })),
            traceId: r.int(2) === 0 ? '' : hex(16, r), spanId: r.int(2) === 0 ? '' : hex(8, r),
          }
        }),
      })),
    })),
  }
}

function lokiRequest(r: R, mode: number) {
  return {
    streams: Array.from({ length: 1 + r.int(5) }, (_, k) => ({
      stream: { job: `j${k}`, instance: str(r, 6) || 'i', env: r.int(2) === 0 ? 'prod' : 'dev' },
      values: Array.from({ length: 1 + r.int(50) }, () => {
        const v: unknown[] = [String(time(r, mode)), r.int(20) === 0 ? 'L'.repeat(200_000) : str(r, 40)]
        if (r.int(2) === 0) v.push({ trace_id: hex(8, r), pod: str(r, 6) || 'p' })
        return v
      }),
    })),
  }
}

function flushBounds(batch: Uint8Array): { minTs: number; maxTs: number } {
  const files = batch[4] === 2 ? engine.encodeSpans([batch]).filter((f) => f.table === 'spans') : engine.encodeLogs([batch])
  if (files.length === 0) throw new Error('flush wrote nothing')
  const lo = files.reduce((a, f) => (BigInt(f.minNs) < a ? BigInt(f.minNs) : a), MAX_NS)
  const hi = files.reduce((a, f) => (BigInt(f.maxNs) > a ? BigInt(f.maxNs) : a), 0n)
  return { minTs: Number(lo / MS), maxTs: Number(hi / MS) }
}

function edgeBatches(kind: 'traces' | 'otlplogs' | 'loki', body: unknown, limits = WIDE, slots = 3, r?: R): { batches: Uint8Array[]; rejected: number; why: string } {
  const bytes = te.encode(JSON.stringify(body))
  if (kind === 'traces') {
    const c = new SpanCollector(limits, NOW)
    decodeTracesJson(bytes, c)
    const m = c.build(Array.from({ length: c.nSeries }, (_, i) => (r ? r.int(slots) : i % slots)), MAX_BATCH_BYTES)
    return { batches: [...m.values()].flat().map((b) => b.bytes), rejected: c.rejectedTotal, why: c.rejectionSummary() }
  }
  const c = new LogCollector(limits, NOW)
  if (kind === 'otlplogs') decodeLogsJson(bytes, c)
  else decodeLokiJson(bytes, c)
  const m = c.build(Array.from({ length: c.nSeries }, (_, i) => (r ? r.int(slots) : i % slots)), MAX_BATCH_BYTES)
  return { batches: [...m.values()].flat().map((b) => b.bytes), rejected: c.rejectedTotal, why: c.rejectionSummary() }
}

const rowsOf = (payload: Uint8Array) => new DataView(payload.buffer, payload.byteOffset).getUint32(8, true)
let fpN = 0
async function put(s: Stub, tenant: string, payload: Uint8Array): Promise<number> {
  const a = await s.append({ tenant, epoch: 1, fingerprint: `edge-${fpN++}`, payload, rows: rowsOf(payload) })
  if (a.status !== 'ok') throw new Error(JSON.stringify(a))
  return a.seq
}
async function readAll(s: Stub, tenant: string, inc: number, opts: TailReadOptions): Promise<TailBatch[]> {
  const out: TailBatch[] = []
  let cursor: string | undefined
  do {
    const r = await s.tailRead(tenant, inc, 0, { ...opts, ...(cursor ? { cursor } : {}) })
    if (r.status !== 'ok' || !r.page) throw new Error(`tail read: ${JSON.stringify(r).slice(0, 300)}`)
    out.push(...r.batches)
    cursor = r.page.next ?? undefined
  } while (cursor)
  return out
}

describe('R1: edge real encoders, adversarial content', () => {
  for (const kind of ['traces', 'otlplogs', 'loki'] as const) {
    it(`${kind}: walk == flush on every batch edge builds`, () => {
      let batches = 0
      let rows = 0
      let rejected = 0
      let nulls = 0
      for (let k = 0; k < 60; k++) {
        const r = rng(1000 * (kind === 'traces' ? 1 : kind === 'otlplogs' ? 2 : 3) + k)
        const mode = k % 3
        const body = kind === 'traces' ? traceRequest(r, mode) : kind === 'otlplogs' ? logRequest(r, mode) : lokiRequest(r, mode)
        const out = edgeBatches(kind, body, WIDE, 1 + r.int(4), r)
        rejected += out.rejected
        for (const b of out.batches) {
          batches++
          rows += rowsOf(b)
          const w = batchTimeBounds(b)
          if (w === null) nulls++
          expect(w, `${kind} request ${k}`).toEqual(flushBounds(b))
        }
      }
      // The review's run: 284 batches holding 11,247 rows over the three kinds; edge refused 6,176
      // items for its own limits, which never reach a shard.
      expect(batches).toBeGreaterThan(40)
      expect(rows).toBeGreaterThan(1000)
      expect(rejected).toBeGreaterThan(0)
      expect(nulls).toBe(0)
    })
  }

  it('traces: entries at the contract limits (128 resource attrs of 65,536-byte strings would exceed an entry; many entries, 1,024-byte keys)', () => {
    const r = rng(77)
    const resource = Array.from({ length: 128 }, (_, i) => ({ key: `${'K'.repeat(1000)}${String(i).padStart(3, '0')}`, value: i % 5 === 0 ? { stringValue: 'v'.repeat(1500) } : i % 5 === 1 ? { kvlistValue: { values: [{ key: 'a', value: { arrayValue: { values: [{ intValue: '1' }, {}] } } }] } } : i % 5 === 2 ? { doubleValue: 'NaN' } : i % 5 === 3 ? { bytesValue: '' } : { boolValue: true } }))
    const body = {
      resourceSpans: Array.from({ length: 30 }, (_, k) => ({
        resource: { attributes: [...resource, { key: 'service.name', value: { stringValue: `s${k}` } }].slice(0, 128) },
        scopeSpans: [{ scope: { name: 'n'.repeat(8192), version: 'v'.repeat(8192), attributes: [{ key: 'x', value: { stringValue: 'y'.repeat(60_000) } }] }, spans: Array.from({ length: 3 }, (_, i) => ({ traceId: hex(16, r), spanId: hex(8, r), name: '', kind: 0, startTimeUnixNano: String(NS_NOW - BigInt(k) * HOUR + BigInt(i)), endTimeUnixNano: String(NS_NOW) })) }],
      })),
    }
    const out = edgeBatches('traces', body, DEFAULT_LIMITS, 1)
    expect(out.batches.length).toBeGreaterThan(0)
    for (const b of out.batches) expect(batchTimeBounds(b)).toEqual(flushBounds(b))
  })
})

describe('R2: a layout the walk does not know gets no bounds (m-1)', () => {
  it('non-zero flags or reserved bytes: no bounds (the engine refuses them too)', () => {
    const r = rng(5)
    const b = edgeBatches('traces', traceRequest(r, 0), WIDE, 1).batches[0]!
    expect(batchTimeBounds(b)).toEqual(flushBounds(b))
    for (const at of [5, 6, 7]) {
      const x = b.slice()
      x[at] = 1
      expect(batchTimeBounds(x), `byte ${at}`).toBeNull()
      expect(() => engine.encodeSpans([x]), `byte ${at}`).toThrow()
    }
  })

  it('a later layout signalled by a flag, with 8 more bytes after the entry table: no bounds, and a read of exactly its rows\' time keeps it', async () => {
    // The review's model of a revision of signal 2 that sets a flag and inserts one u64 after the
    // entry table. Before the fix the walk read it with this layout, recorded {0, T+3} for rows at
    // T … T+4, and a read of [T+4, T+4] skipped it.
    const rows = 5
    const starts = Array.from({ length: rows }, (_, i) => NS_NOW + BigInt(i) * MS)
    const body = { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] }, scopeSpans: [{ scope: { name: 'lib' }, spans: starts.map((s, i) => ({ traceId: `${'ab'.repeat(15)}${(i + 1).toString(16).padStart(2, '0')}`, spanId: `${'cd'.repeat(7)}${(i + 1).toString(16).padStart(2, '0')}`, name: 'op', kind: 1, startTimeUnixNano: String(s), endTimeUnixNano: String(s + 10n) })) }] }] }
    const b = edgeBatches('traces', body, DEFAULT_LIMITS, 1).batches[0]!
    expect(batchTimeBounds(b)).toEqual({ minTs: NOW, maxTs: NOW + rows - 1 })
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    let colStart = -1
    for (let at = 16; at + 8 * rows <= b.length; at += 8) {
      if (dv.getBigInt64(at, true) === starts[0]) {
        colStart = at
        break
      }
    }
    expect(colStart).toBeGreaterThan(0)
    const entryAt = colStart - 32 * rows - ((4 * rows + 7) & ~7)
    const x = new Uint8Array(b.length + 8)
    x.set(b.subarray(0, entryAt), 0)
    new DataView(x.buffer).setBigUint64(entryAt, 0x0102030405060708n, true) // the new field
    x.set(b.subarray(entryAt), entryAt + 8)
    x[5] = 1 // flags: the revision says so
    expect(batchTimeBounds(x)).toBeNull()
    // Unsignalled (flags left 0), the same bytes still get bounds from the wrong place: why BATCH.md
    // requires a later layout to signal itself, or to update the shard first.
    const unsignalled = x.slice()
    unsignalled[5] = 0
    expect(batchTimeBounds(unsignalled)).not.toEqual({ minTs: NOW, maxTs: NOW + rows - 1 })
    const s = env.SHARD.get(env.SHARD.idFromName(`edge-${uid()}/traces/0`))
    await put(s, 't', x)
    const inc = (await s.describe('t'))!.incarnation
    const got = await readAll(s, 't', inc, { signals: [2], minTs: NOW + rows - 1, maxTs: NOW + rows - 1 })
    expect(got.map((g) => g.seq)).toEqual([1])
  })
})

describe('R5b: the most expensive shapes edge builds for the walk (m-4)', () => {
  it('spans: every span its own resource of 128 attributes; logs: every record its own one-label stream: the walk equals the flush', () => {
    const r = rng(99)
    const res = (k: number) => [{ key: 'service.name', value: { stringValue: `s${k}` } }, ...Array.from({ length: 127 }, (_, i) => ({ key: String.fromCharCode(33 + (i % 90)) + (i >= 90 ? 'x' : ''), value: { boolValue: true } }))]
    const body = { resourceSpans: Array.from({ length: 1600 }, (_, k) => ({ resource: { attributes: res(k) }, scopeSpans: [{ scope: {}, spans: [{ traceId: hex(16, r), spanId: hex(8, r), name: '', kind: 0, startTimeUnixNano: String(NS_NOW - BigInt(k) * MS), endTimeUnixNano: String(NS_NOW) }] }] })) }
    const sp = edgeBatches('traces', body, { ...DEFAULT_LIMITS, maxJsonTokens: 1 << 22 }, 1)
    const loki = { streams: Array.from({ length: 20000 }, (_, k) => ({ stream: { a: `${k}` }, values: [[String(NS_NOW - BigInt(k) * MS), '']] })) }
    const lg = edgeBatches('loki', loki, { ...DEFAULT_LIMITS, maxJsonTokens: 1 << 22 }, 1)
    for (const [name, bs] of [['spans', sp.batches], ['logs', lg.batches]] as const) {
      expect(bs.length, name).toBeGreaterThan(1)
      for (const b of bs) expect(batchTimeBounds(b), name).toEqual(flushBounds(b))
      const big = bs.reduce((a, x) => (x.length > a.length ? x : a))
      // Near the batch cap, and as many entries as rows: the walk's worst case among what edge sends.
      expect(big.length, name).toBeGreaterThan(MAX_BATCH_BYTES - 64 * 1024)
      expect(new DataView(big.buffer, big.byteOffset).getUint32(12, true), name).toBe(rowsOf(big))
    }
  })
})
