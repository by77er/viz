/**
 * The re-review of D62 (design/reviews/signals-end-to-end-r2.md) and the review of D72's query
 * side (design/reviews/d72-shard-bounds.md m-2, m-3), through edge, the real flush, the ledger
 * and the query Worker. Each case is the review's reproduction, scaled to what a workerd test can
 * hold; the engine-level cases at full size are `engine/wasm-query/src/sigtests.rs` (`r2_*`).
 *
 * Memory: `X-Viz-Wasm-Memory-Bytes` is the engine's high-water mark after a reset. A refused call
 * must stay within the budget (`maxDecodedBytes`, 32 MiB), the bytes it was handed and a stated
 * constant (12 MiB here: one file's copy while it is opened, the reader's pages, the module).
 */
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'
import { clearLimitsCache } from '../src/config'
import { engine } from '../src/index'
import { tailHooks } from '../src/tail'
import { flushSignals, post, signalShardsOf } from './signals-load'
import { type Tenant, api, cost, shardOf, world } from './world'

const T0 = BigInt(Date.UTC(2026, 10, 19, 11, 0, 0)) * 1_000_000n
const S = 1_000_000_000n
const MIN = 60n * S
const HOUR = 60n * MIN
const MiB = 1 << 20
const sec = (ns: bigint): string => String(ns / S)
const json = (path: string, body: unknown) => ({ path, contentType: 'application/json', body: btoa(JSON.stringify(body)) })
const SLACK = 12 * MiB

async function tenant(sealBytes = 4 << 20, slots = 2): Promise<{ t: Tenant; flush: () => Promise<number> }> {
  const w = await world(slots)
  for (const s of signalShardsOf(w)) await shardOf(s).configure({ sealBytes, sealAgeMs: 0 })
  return { t: w.a, flush: () => flushSignals(w, w.a) }
}

async function query(t: Tenant, path: string, params: [string, string][]): Promise<{ status: number; text: string; wasm: number; res: Response }> {
  engine.reset()
  const res = await api(t.key, path, params)
  return { status: res.status, text: await res.text(), wasm: cost(res, 'Wasm-Memory-Bytes'), res }
}

const hex = (n: number | bigint, w: number): string => n.toString(16).padStart(w, '0')
const span = (trace: string, id: string, start: bigint, end: bigint, attributes: unknown[] = [], parent?: string) => ({ traceId: trace, spanId: id, ...(parent ? { parentSpanId: parent } : {}), name: 'op', kind: 2, startTimeUnixNano: String(start), endTimeUnixNano: String(end), attributes })
const traces = (spans: unknown[]) => json('/v1/traces', { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] }, scopeSpans: [{ scope: {}, spans }] }] })
const str = (key: string, v: string) => ({ key, value: { stringValue: v } })

afterEach(() => {
  delete tailHooks.previousRelease
  clearLimitsCache()
})

describe('R2-M1: the Loki label endpoints have a byte budget', () => {
  it('100 streams of 31 labels of 8,000 bytes: /series is refused 422 max_decoded_bytes within the budget (113 MiB and a 200 before); /labels and one label\'s values answer', async () => {
    const { t, flush } = await tenant()
    for (let i = 0; i < 100; i += 20) {
      const streams = Array.from({ length: 20 }, (_, j) => {
        const k = i + j
        const stream: Record<string, string> = { job: 'a' }
        for (let l = 0; l < 31; l++) stream[`l${l}`] = `${k}-${l}-`.padEnd(8000, 'x')
        return { stream, values: [[String(T0 + BigInt(k) * 1_000_000n), 'line']] }
      })
      await post(t, json('/loki/api/v1/push', { streams }))
    }
    await flush()
    const range: [string, string][] = [['start', String(T0 - MIN)], ['end', String(T0 + HOUR)]]
    const series = await query(t, '/loki/api/v1/series', [['match[]', '{job="a"}'], ...range])
    console.log(`R2-M1 /series: ${series.status}, ${(series.wasm / MiB).toFixed(1)} MiB of WASM, ${cost(series.res, 'Bytes-Read')} bytes read`)
    // The label sets fit (23.7 MB); their answer, charged four times, does not.
    expect([series.status, /max_decoded_bytes: (the label sets it lists|its answer)/.test(series.text)], series.text.slice(0, 300)).toEqual([422, true])
    expect(series.wasm).toBeLessThan(32 * MiB + cost(series.res, 'Bytes-Read') + SLACK)
    const names = await query(t, '/loki/api/v1/labels', [['query', '{job="a"}'], ...range])
    expect(names.status, names.text.slice(0, 200)).toBe(200)
    expect(JSON.parse(names.text).data).toHaveLength(32)
    const values = await query(t, '/loki/api/v1/label/l0/values', [['query', '{job="a"}'], ...range])
    expect(values.status, values.text.slice(0, 200)).toBe(200)
    expect(JSON.parse(values.text).data).toHaveLength(100)
    console.log(`R2-M1 /labels ${(names.wasm / MiB).toFixed(1)} MiB, values ${(values.wasm / MiB).toFixed(1)} MiB`)
    // The tenant's budget reaches the label calls: 1 MiB cannot hold one value list.
    await env.CONFIG.put(`limits:${t.name}`, JSON.stringify({ maxDecodedBytes: 1 << 20 }))
    clearLimitsCache()
    expect((await query(t, '/loki/api/v1/label/l0/values', [['query', '{job="a"}'], ...range])).status).toBe(422)
  }, 180_000)
})

describe('R2-M2: derived structures and answers are charged as they grow, before they are built', () => {
  it('histogram_over_time by 8 groups of 60 buckets over 10,800 points: refused within the budget (513.7 MiB before)', async () => {
    const { t, flush } = await tenant()
    const spans = []
    let n = 1
    for (let g = 0; g < 8; g++) for (let k = 0; k < 60; k++, n++) spans.push(span(hex(n, 32), '0000000000000001', T0 + BigInt(n) * 1000n, T0 + BigInt(n) * 1000n + (1n << BigInt(k)), [str('g', `g${g}`)]))
    await post(t, traces(spans))
    await flush()
    const params: [string, string][] = [['q', '{ } | histogram_over_time(duration) by (span.g)'], ['start', sec(T0 - 12n * HOUR)], ['end', sec(T0 + 12n * HOUR - 16n * S)], ['step', '8s']]
    const r = await query(t, '/api/metrics/query_range', params)
    console.log(`R2-M2 histogram: ${r.status}, ${(r.wasm / MiB).toFixed(1)} MiB of WASM`)
    expect([r.status, /max_decoded_bytes: the histogram's series/.test(r.text)], r.text.slice(0, 300)).toEqual([422, true])
    expect(r.wasm).toBeLessThan(32 * MiB + cost(r.res, 'Bytes-Read') + SLACK)
    // Over an hour at a minute, it answers.
    const hour = await query(t, '/api/metrics/query_range', [['q', '{ } | histogram_over_time(duration) by (span.g)'], ['start', sec(T0 - 30n * MIN)], ['end', sec(T0 + 30n * MIN)], ['step', '60s']])
    expect(hour.status, hour.text.slice(0, 300)).toBe(200)
    // One series per group and bucket: 59 buckets (a duration of 1 ns has none, Tempo's rule).
    expect(JSON.parse(hour.text).series.length).toBe(8 * 59)
  }, 120_000)

  it('tag values of 500 spans with their own 60 KB value: refused within the budget (107.7 MiB before)', async () => {
    const { t, flush } = await tenant()
    for (let k = 0; k < 5; k++) {
      const spans = Array.from({ length: 100 }, (_, j) => {
        const i = k * 100 + j
        return span(hex(i + 1, 32), '0000000000000001', T0 + BigInt(i) * 1_000_000n, T0 + BigInt(i) * 1_000_000n + 1000n, [str('blob', String(i).padEnd(60_000, 'x'))])
      })
      await post(t, traces(spans))
    }
    await flush()
    const r = await query(t, '/api/v2/search/tag/span.blob/values', [['start', sec(T0)], ['end', sec(T0 + HOUR)]])
    console.log(`R2-M2 tag values: ${r.status}, ${(r.wasm / MiB).toFixed(1)} MiB of WASM, ${cost(r.res, 'Bytes-Read')} bytes read`)
    expect([r.status, /max_decoded_bytes: the tag values it lists/.test(r.text)], r.text.slice(0, 300)).toEqual([422, true])
    expect(r.wasm).toBeLessThan(32 * MiB + cost(r.res, 'Bytes-Read') + SLACK)
  }, 120_000)

  it('LogQL: a series per line from regexp and label_format is refused as the series are made (221.4 MiB and a 200 before)', async () => {
    const { t, flush } = await tenant()
    for (let i = 0; i < 14_000; i += 3500) {
      const values = Array.from({ length: 3500 }, (_, j) => [String(T0 + BigInt(i + j) * 1_000_000n), String(i + j).padStart(8, '0') + 'y'.repeat(2000)])
      await post(t, json('/loki/api/v1/push', { streams: [{ stream: { job: 'a' }, values }] }))
      await flush()
    }
    const q = 'count(sum by (x, y, z) (count_over_time({job="a"} | regexp "(?P<x>.+)" | label_format y="{{.x}}{{.x}}", z="{{.y}}{{.y}}" [1h])))'
    const r = await query(t, '/loki/api/v1/query', [['query', q], ['time', String(T0 + HOUR)]])
    console.log(`R2-M2 LogQL label_format: ${r.status}, ${(r.wasm / MiB).toFixed(1)} MiB of WASM, ${cost(r.res, 'Bytes-Read')} bytes read`)
    expect([r.status, /max_decoded_bytes: the series its pipeline makes/.test(r.text)], r.text.slice(0, 300)).toEqual([422, true])
    expect(r.wasm).toBeLessThan(32 * MiB + cost(r.res, 'Bytes-Read') + SLACK)
    // Grouped by nothing the lines make, the same rows answer.
    const ok = await query(t, '/loki/api/v1/query', [['query', 'sum(count_over_time({job="a"} [1h]))'], ['time', String(T0 + HOUR)]])
    expect(ok.status, ok.text.slice(0, 300)).toBe(200)
  }, 180_000)
})

describe('R2-M3: the margin\'s cost is the found traces\' own pieces, and its refusals say so', () => {
  it('one long trace adds the flush units its pieces lie in, not the hull (39,002 rows and 422 before, at 5 spans a second)', async () => {
    // Twenty-four 10-minute units of 300 spans (the review's 3,000, scaled by ten with maxSpans),
    // from 08:00; a trace with its root at 10:01 and a child at 11:50 in the 11:50 unit.
    const { t, flush } = await tenant()
    const base = T0 - 3n * HOUR // 08:00
    const t0 = base + 2n * HOUR // 10:00
    const long = 'f'.repeat(32)
    for (let u = 0n; u < 24n; u++) {
      const from = base + u * 10n * MIN
      const spans = Array.from({ length: 300 }, (_, k) => span(hex(Number(u) * 1000 + k + 1, 32), '0000000000000001', from + BigInt(k) * 2n * S, from + BigInt(k) * 2n * S + S / 2n))
      if (from === t0) spans.push(span(long, '00000000000000aa', t0 + MIN, t0 + 2n * MIN))
      if (from === t0 + 110n * MIN) spans.push(span(long, '00000000000000ab', t0 + 110n * MIN, t0 + 111n * MIN, [], '00000000000000aa'))
      await post(t, traces(spans))
      await flush()
    }
    await env.CONFIG.put(`limits:${t.name}`, JSON.stringify({ maxSpans: 1800 }))
    clearLimitsCache()
    const params: [string, string][] = [['q', '{ }'], ['start', sec(t0)], ['end', sec(t0 + 5n * MIN)], ['limit', '1000']]
    // The hull (10:01 to 11:51) holds eleven units, 3,300 spans: over maxSpans (1,800), refused
    // before. The window's unit and the child's unit, about 600, answer.
    const r = await query(t, '/api/search', params)
    console.log(`R2-M3b: ${r.status}, ${cost(r.res, 'Rows-Decoded')} spans read, ${cost(r.res, 'Files-Read')} files read`)
    expect(r.status, r.text.slice(0, 300)).toBe(200)
    expect(cost(r.res, 'Rows-Decoded')).toBeLessThanOrEqual(2 * 301)
    const found = JSON.parse(r.text).traces.find((x: { traceID: string }) => x.traceID === long)
    expect(found.durationMs).toBe(110 * 60_000)
    // Where the margin's pieces do not fit and the window's do, the refusal names the margin.
    await env.CONFIG.put(`limits:${t.name}`, JSON.stringify({ maxSpans: 450 }))
    clearLimitsCache()
    const over = await query(t, '/api/search', params)
    expect([over.status, /max_spans: the traces that overlap the window have spans up to traceMarginMs/.test(over.text), over.text.includes('Narrow the time range')], over.text.slice(0, 400)).toEqual([422, true, false])
  }, 240_000)
})

describe('R2-M4a: trace by ID counts the trace\'s own spans', () => {
  it('a trace in a flush unit of 20,000 spans (one row group, the README\'s benchmark unit) answers under max_spans 18,000 (422 before, before any fetch)', async () => {
    // One shard, one request, one segment: the unit's spans file is one row group of 20,000 rows.
    const w = await world(1)
    for (const s of signalShardsOf(w)) await shardOf(s).configure({ sealBytes: 64 << 20, sealAgeMs: 3_600_000 })
    const t = w.a
    const spans = Array.from({ length: 20_000 }, (_, j) => span(hex(j + 1, 32), '0000000000000001', T0 + BigInt(j + 1) * 150_000_000n, T0 + BigInt(j + 1) * 150_000_000n + 1000n))
    await post(t, traces(spans))
    await flushSignals(w, t)
    const r = await query(t, `/api/traces/${hex(7, 32)}`, [])
    console.log(`R2-M4a: ${r.status}, ${cost(r.res, 'Rows-Decoded')} spans read, ${(r.wasm / MiB).toFixed(1)} MiB of WASM`)
    expect(r.status, r.text.slice(0, 300)).toBe(200)
    expect(cost(r.res, 'Rows-Decoded')).toBe(20_000)
    expect(JSON.parse(r.text).batches[0].scopeSpans[0].spans).toHaveLength(1)
  }, 180_000)
})

describe('review of D72: the query side of the time range', () => {
  it('m-3: a Loki query_range with start == end on a whole millisecond answers 200 (never sends minTs > maxTs)', async () => {
    const { t } = await tenant()
    await post(t, json('/loki/api/v1/push', { streams: [{ stream: { job: 'j' }, values: [[String(T0), 'line']] }] }))
    // In the tail: the shard would refuse an inverted range ("invalid"), and the query 503.
    const r = await query(t, '/loki/api/v1/query_range', [['query', '{job="j"}'], ['start', String(T0)], ['end', String(T0)]])
    expect([r.status, r.text.slice(0, 200)]).toEqual([200, r.text.slice(0, 200)])
    expect(JSON.parse(r.text).data.result).toEqual([])
    const all = await query(t, '/loki/api/v1/query_range', [['query', '{job="j"}'], ['start', String(T0)], ['end', String(T0 + S)]])
    expect(JSON.parse(all.text).data.result).toHaveLength(1)
  }, 60_000)

  it('n-1: when every batch after the one that does not fit is outside the range, the refusal gives the exact size (no "at least")', async () => {
    const { t } = await tenant(64 << 20, 1)
    // One batch of about 300 KB in the window, then small ones two hours later (outside it).
    await post(t, traces(Array.from({ length: 300 }, (_, i) => span(hex(i + 1, 32), '0000000000000001', T0 + BigInt(i) * S, T0 + BigInt(i) * S + 1000n, [str('pad', 'p'.repeat(1000))]))))
    for (let k = 0; k < 3; k++) await post(t, traces([span(hex(1000 + k, 32), '0000000000000001', T0 + 2n * HOUR + BigInt(k) * S, T0 + 2n * HOUR + BigInt(k) * S + 1000n)]))
    await env.CONFIG.put(`limits:${t.name}`, JSON.stringify({ maxFetchBytes: 100_000 }))
    clearLimitsCache()
    const r = await query(t, '/api/search/tags', [['start', sec(T0)], ['end', sec(T0 + HOUR)]])
    expect([r.status, /max_fetch_bytes: .* are \d+ bytes/.test(r.text), r.text.includes('at least')], r.text.slice(0, 300)).toEqual([422, true, false])
  }, 60_000)

  it('m-2: tags, tag values and span-local metrics cut to their window before de-duplication: a later copy outside it changes nothing, whether its batch is skipped or read', async () => {
    const { t } = await tenant()
    const id = 'ab'.repeat(16)
    const sid = 'cd'.repeat(8)
    // Sent with a start inside the window, then re-sent (same ids) with a start 3 h later.
    await post(t, traces([span(id, sid, T0 + 10n * MIN, T0 + 10n * MIN + 1000n, [str('first.copy', 'v')])]))
    await post(t, traces([span(id, sid, T0 + 4n * HOUR, T0 + 4n * HOUR + 1000n, [str('second.copy', 'v')])]))
    const w: [string, string][] = [['start', sec(T0)], ['end', sec(T0 + HOUR)]]
    const ask = async () => [
      (await query(t, '/api/search/tags', w)).text,
      (await query(t, '/api/v2/search/tag/span.first.copy/values', w)).text,
      JSON.parse((await query(t, '/api/metrics/query', [['q', '{ } | count_over_time()'], ...w])).text).series,
    ]
    const skipped = await ask()
    tailHooks.previousRelease = () => true
    const read = await ask()
    expect(read).toEqual(skipped)
    expect(skipped[0]).toContain('first.copy')
    expect(skipped[2][0].samples[0].value).toBe(1)
  }, 60_000)
})
