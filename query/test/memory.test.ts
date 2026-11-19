/**
 * What a span or log query holds is bounded by bytes, not rows (review of signals end to end
 * M-2; README "Memory"): the review's inputs, through edge, the real flush and the query Worker.
 * A resource repeated on every span is held once; a span's or a line's own bytes are counted by
 * the engine, which refuses past `maxDecodedBytes` (422 `max_decoded_bytes`) before the isolate
 * is in danger. `X-Viz-Wasm-Memory-Bytes` is the engine's high-water mark, after a reset.
 */
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'
import { clearLimitsCache } from '../src/config'
import { engine } from '../src/index'
import { flushSignals, post, signalShardsOf } from './signals-load'
import { type Tenant, api, cost, shardOf, world } from './world'

const T0 = BigInt(Date.UTC(2026, 10, 19, 11, 0, 0)) * 1_000_000n
const sec = (ns: bigint): string => String(ns / 1_000_000_000n)
const json = (path: string, body: unknown) => ({ path, contentType: 'application/json', body: btoa(JSON.stringify(body)) })
const MiB = 1 << 20

async function tenant(): Promise<{ t: Tenant; flush: () => Promise<number> }> {
  const w = await world()
  for (const s of signalShardsOf(w)) await shardOf(s).configure({ sealBytes: 4 << 20, sealAgeMs: 0 })
  return { t: w.a, flush: () => flushSignals(w, w.a) }
}

function spans(n: number, from: number, attrs: (i: number) => unknown[]) {
  return Array.from({ length: n }, (_, k) => {
    const i = from + k
    const start = T0 + BigInt(i) * 1_000_000n
    return { traceId: (i + 1).toString(16).padStart(32, '0'), spanId: '0000000000000001', name: 'op', kind: 2, startTimeUnixNano: String(start), endTimeUnixNano: String(start + 1000n), attributes: attrs(i) }
  })
}

async function query(t: Tenant, path: string, params: [string, string][]): Promise<{ status: number; text: string; wasm: number; res: Response }> {
  engine.reset()
  const res = await api(t.key, path, params)
  return { status: res.status, text: await res.text(), wasm: cost(res, 'Wasm-Memory-Bytes'), res }
}

const SEARCH: [string, string][] = [['q', '{ }'], ['start', sec(T0)], ['end', sec(T0 + 3_600_000_000_000n)], ['limit', '20']]

afterEach(() => clearLimitsCache())

describe('memory is bounded by bytes held (review M-2)', () => {
  it('a 180 KB resource on 2,000 spans is held once: the search answers in a few MiB (349 MiB before)', async () => {
    const { t, flush } = await tenant()
    const resource = { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }, ...[0, 1, 2].map((i) => ({ key: `blob${i}`, value: { stringValue: 'x'.repeat(60_000) + i } }))] }
    for (let k = 0; k < 2; k++) await post(t, json('/v1/traces', { resourceSpans: [{ resource, scopeSpans: [{ scope: {}, spans: spans(1000, k * 1000, () => []) }] }] }))
    await flush()
    const r = await query(t, '/api/search', SEARCH)
    expect([r.status, cost(r.res, 'Rows-Decoded')], r.text.slice(0, 300)).toEqual([200, 2000])
    console.log(`MEMORY fat resource, 2,000 spans: ${(r.wasm / MiB).toFixed(1)} MiB of WASM, ${cost(r.res, 'Bytes-Read')} bytes read`)
    expect(r.wasm).toBeLessThan(16 * MiB)
    // The tenant's own `maxDecodedBytes` is the engine's: 1 MiB cannot hold the resource itself.
    await env.CONFIG.put(`limits:${t.name}`, JSON.stringify({ maxDecodedBytes: 1 << 20 }))
    clearLimitsCache()
    const small = await query(t, '/api/search', SEARCH)
    expect([small.status, /max_decoded_bytes: .* the limit is 1048576/.test(small.text)], small.text.slice(0, 300)).toEqual([422, true])
  }, 120_000)

  it('600 spans with their own 60 KB attribute each: refused by max_decoded_bytes, under the budget plus what was fetched', async () => {
    const { t, flush } = await tenant()
    const resource = { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] }
    for (let k = 0; k < 6; k++) await post(t, json('/v1/traces', { resourceSpans: [{ resource, scopeSpans: [{ scope: {}, spans: spans(100, k * 100, (i) => [{ key: 'blob', value: { stringValue: 'w'.repeat(60_000) + i } }]) }] }] }))
    await flush()
    const r = await query(t, '/api/search', SEARCH)
    expect([r.status, /max_decoded_bytes/.test(r.text)], r.text.slice(0, 300)).toEqual([422, true])
    console.log(`MEMORY 600 spans of 60 KB: ${r.status}, ${(r.wasm / MiB).toFixed(1)} MiB of WASM, ${cost(r.res, 'Bytes-Read')} bytes read`)
    // The budget (32 MiB) plus the files as fetched and the engine's own few MiB.
    expect(r.wasm).toBeLessThan(32 * MiB + cost(r.res, 'Bytes-Read') + 12 * MiB)
  }, 120_000)

  it('400 log lines of 200 KB: refused by max_decoded_bytes (158 MiB and a 19 MiB answer before); 40 of them answer', async () => {
    const { t, flush } = await tenant()
    for (let k = 0; k < 8; k++) {
      const values = Array.from({ length: 50 }, (_, j) => [String(T0 + BigInt(k * 50 + j) * 1_000_000n), 'x'.repeat(200_000) + (k * 50 + j)])
      await post(t, json('/loki/api/v1/push', { streams: [{ stream: { job: 'a' }, values }] }))
      // 10 MB a request: flushed as it goes, under the shard's per-tenant bytes.
      await flush()
    }
    const params: [string, string][] = [['query', '{job="a"}'], ['start', String(T0)], ['end', String(T0 + 3_600_000_000_000n)], ['limit', '100']]
    const r = await query(t, '/loki/api/v1/query_range', params)
    expect([r.status, /max_decoded_bytes/.test(r.text)], r.text.slice(0, 300)).toEqual([422, true])
    console.log(`MEMORY 400 lines of 200 KB: ${r.status}, ${(r.wasm / MiB).toFixed(1)} MiB of WASM, ${cost(r.res, 'Bytes-Read')} bytes read`)
    expect(r.wasm).toBeLessThan(32 * MiB + cost(r.res, 'Bytes-Read') + 12 * MiB)
    // Loki answers errors as plain text (review m-4).
    expect(r.res.headers.get('Content-Type')).toMatch(/^text\/plain/)
    // The first 40 lines (8 MB held, a 4 x 8 MB answer would not fit; 10 lines do).
    const few = await query(t, '/loki/api/v1/query_range', [...params.filter(([k]) => k !== 'end' && k !== 'limit'), ['end', String(T0 + 40n * 1_000_000n - 1n)], ['limit', '10']])
    expect(few.status, few.text.slice(0, 300)).toBe(200)
    console.log(`MEMORY 40 lines of 200 KB, limit 10: ${few.status}, ${(few.wasm / MiB).toFixed(1)} MiB of WASM`)
    expect(few.wasm).toBeLessThan(32 * MiB + cost(few.res, 'Bytes-Read') + 12 * MiB)
  }, 180_000)
})
