/**
 * Trace completeness (D62, review of signals end to end M-1): a trace the answer names is read
 * whole within the tenant's margin (`traceMarginMs`) around the query's window, wherever its
 * spans were flushed; spans further out are not part of the answer, the same with pruning on and
 * off. The review's case and its neighbours, through edge, the real flush and the ledger, each
 * piece of a trace in a flush unit of its own so that a unit's `trace_index` file lies wholly
 * inside or outside the window:
 *
 *   a  root 09:00–09:05 (unit 1), late child 11:00–11:01 (unit 3)       the review's case
 *   b  root 09:01–09:02 (unit 1)                                         a plain trace
 *   c  root 07:30–07:35 (unit 2), child 09:01–09:02 (unit 1)             found by its child
 *   d  span 08:30–08:35 (unit 2), span 09:40–09:45 (unit 3)              no piece in the window,
 *                                                                         its extent across it
 *   e  root 09:00–09:01 (unit 1), child 12:00–12:01 (unit 3)             beyond the margin
 *   f  root 09:02–09:03 (unit 1), child 10:30–10:31 (tail, never flushed)
 *   g  root 09:02–09:03 (unit 1), the same span again (unit 4)           a retry: one span
 *   h  root 09:05–09:06 (unit 1), child 11:30–11:31 (unit 3)             beyond the margin, in
 *                                                                         the same hour file as
 *                                                                         a's child (read, and
 *                                                                         dropped by the engine)
 *
 * The window is 08:55–09:10 and the default margin two hours, so the bound is 06:55–11:10.
 * Expected answers are written out by hand below, and checked again against the query with the
 * margin raised past all the data and pruning off (every file whole: "every span").
 */
import { afterEach, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { clearLimitsCache } from '../src/config'
import { hooks } from '../src/coordinator'
import { flushSignals, post, signalShardsOf } from './signals-load'
import { type Tenant, type World, api, cost, ledgerOf, shardOf, world } from './world'

const MIN = 60_000_000_000n
const T0 = BigInt(Date.UTC(2026, 10, 19, 9, 0, 0)) * 1_000_000n
const at = (m: number): bigint => T0 + BigInt(m) * MIN
const id = (c: string): string => c.repeat(32)
const sid = (n: number): string => n.toString(16).padStart(16, '0')

interface S {
  trace: string
  span: number
  parent?: number
  name: string
  from: number
  to: number
}
const span = (s: S) => ({
  traceId: id(s.trace),
  spanId: sid(s.span),
  ...(s.parent ? { parentSpanId: sid(s.parent) } : {}),
  name: s.name,
  kind: 2,
  startTimeUnixNano: String(at(s.from)),
  endTimeUnixNano: String(at(s.to)),
})
const request = (spans: S[]) => ({
  path: '/v1/traces',
  contentType: 'application/json',
  body: btoa(JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] }, scopeSpans: [{ scope: {}, spans: spans.map(span) }] }] })),
})

const UNITS: S[][] = [
  [
    { trace: 'a', span: 1, name: 'root', from: 0, to: 5 },
    { trace: 'b', span: 2, name: 'plain', from: 1, to: 2 },
    { trace: 'c', span: 4, parent: 3, name: 'c-child', from: 1, to: 2 },
    { trace: 'e', span: 6, name: 'e-root', from: 0, to: 1 },
    { trace: 'f', span: 8, name: 'f-root', from: 2, to: 3 },
    { trace: '9', span: 10, name: 'g-root', from: 2, to: 3 },
    { trace: '8', span: 13, name: 'h-root', from: 5, to: 6 },
  ],
  [
    { trace: 'c', span: 3, name: 'c-root', from: -90, to: -85 },
    { trace: 'd', span: 11, name: 'd-first', from: -30, to: -25 },
  ],
  [
    { trace: 'a', span: 5, parent: 1, name: 'late-child', from: 120, to: 121 },
    { trace: 'd', span: 12, parent: 11, name: 'd-second', from: 40, to: 45 },
    { trace: 'e', span: 7, parent: 6, name: 'e-child', from: 180, to: 181 },
    { trace: '8', span: 14, parent: 13, name: 'h-child', from: 150, to: 151 },
  ],
  [{ trace: '9', span: 10, name: 'g-root', from: 2, to: 3 }],
]
const TAIL: S[] = [{ trace: 'f', span: 9, parent: 8, name: 'f-child', from: 90, to: 91 }]

const sec = (m: number): string => String(Number(at(m) / 1_000_000_000n))
const WINDOW: [string, string][] = [['start', sec(-5)], ['end', sec(10)]]

async function corpus(): Promise<{ w: World; t: Tenant }> {
  const w = await world()
  const t = w.a
  for (const s of signalShardsOf(w)) await shardOf(s).configure({ sealBytes: 256 << 10, sealAgeMs: 0 })
  for (const unit of UNITS) {
    await post(t, request(unit))
    await flushSignals(w, t)
  }
  await post(t, request(TAIL))
  return { w, t }
}

function withoutMetrics(s: string): string {
  const at = s.lastIndexOf(',"metrics":{')
  return at < 0 ? s : s.slice(0, at) + s.slice(s.indexOf('}', at) + 1)
}

interface TraceHit {
  traceID: string
  durationMs?: number
  startTimeUnixNano: string
  serviceStats: Record<string, { spanCount: number }>
}

async function search(t: Tenant, q: string, window = WINDOW): Promise<{ text: string; traces: TraceHit[]; res: Response }> {
  const res = await api(t.key, '/api/search', [['q', q], ...window, ['limit', '100'], ['spss', '100']])
  const text = withoutMetrics(await res.text())
  expect(res.status, text).toBe(200)
  return { text, traces: (JSON.parse(text) as { traces: TraceHit[] }).traces, res }
}

const QUERIES = ['{ }', '{ trace:duration > 1h }', '{ name = "root" } >> { name = "late-child" }', '{ name = "c-root" } >> { name = "c-child" }', '{ trace:rootName = "c-root" }']
const METRICS: [string, string][][] = [
  [['q', '{ trace:duration > 1h } | count_over_time()'], ['start', sec(-5)], ['end', sec(10)], ['step', '60s']],
  [['q', '{ trace:rootName = "c-root" } | count_over_time() by (name)'], ['start', sec(-5)], ['end', sec(10)], ['step', '300s']],
]
const BY_ID: [string, [string, string][]][] = [
  [id('8'), WINDOW],
  [id('a'), []],
  [id('a'), WINDOW],
  [id('e'), []],
  [id('e'), WINDOW],
  [id('9'), WINDOW],
  [id('f'), WINDOW],
  [id('c'), WINDOW],
]

/** Every answer of the corpus, as text: searches, whole-trace metrics, trace by ID. */
async function answers(t: Tenant): Promise<string[]> {
  const out: string[] = []
  for (const q of QUERIES) out.push((await search(t, q)).text)
  for (const params of METRICS) {
    const res = await api(t.key, '/api/metrics/query_range', params)
    // Without `metrics` (what was inspected, which depends on what was read).
    out.push(`${res.status} ${withoutMetrics(await res.text())}`)
  }
  for (const [trace, params] of BY_ID) {
    const res = await api(t.key, `/api/traces/${trace}`, params)
    out.push(`${res.status} ${await res.text()}`)
  }
  return out
}

afterEach(() => {
  delete hooks.signalPruning
  clearLimitsCache()
})

describe('trace completeness within the margin (D62; review M-1)', () => {
  it('the corpus lies where it should: four units, one span still in the tail', async () => {
    const { t } = await corpus()
    const plan = await ledgerOf(t).plan({ table: 'trace_index', minTs: 0, maxTs: 9_000_000_000_000 })
    // Unit 2's and unit 3's trace_index files lie wholly outside the window: a reader of the
    // window's fragments alone never sees them.
    const lo = Number(at(-5) / 1_000_000n)
    const hi = Number(at(10) / 1_000_000n)
    const outside = plan.files.filter((f) => f.maxTs < lo || f.minTs > hi)
    expect(outside.length).toBeGreaterThanOrEqual(2)
  })

  it('every trace named is whole within the margin, wherever its spans were flushed; the same with pruning off', async () => {
    const { t } = await corpus()
    const all = await search(t, '{ }')
    const by = Object.fromEntries(all.traces.map((x) => [x.traceID, x]))
    // a: the review's case. Its late child (11:00, unit 3) is read: 09:00 to 11:01.
    expect([by[id('a')]?.durationMs, by[id('a')]?.serviceStats.api?.spanCount]).toEqual([7_260_000, 2])
    // c: found by its child in the window; its root (07:30, unit 2) is read: the trace starts at 07:30.
    expect([by[id('c')]?.startTimeUnixNano, by[id('c')]?.serviceStats.api?.spanCount]).toEqual([String(at(-90)), 2])
    // d: no piece in the window, its extent (08:30 to 09:45) across it.
    expect([by[id('d')]?.durationMs, by[id('d')]?.serviceStats.api?.spanCount]).toEqual([75 * 60_000, 2])
    // e: its child (12:00) is beyond the margin (11:10): not part of the answer.
    expect([by[id('e')]?.durationMs, by[id('e')]?.serviceStats.api?.spanCount]).toEqual([60_000, 1])
    // f: its child is still in the tail.
    expect([by[id('f')]?.durationMs, by[id('f')]?.serviceStats.api?.spanCount]).toEqual([89 * 60_000, 2])
    // g: one span, sent twice into two units (trace_index counts it twice; the answer once).
    expect(by[id('9')]?.serviceStats.api?.spanCount).toBe(1)
    // h: its child (11:30) is in the hour file read for a's child (11:00), beyond the bound
    // (11:10): read, and dropped by the engine.
    expect([by[id('8')]?.durationMs, by[id('8')]?.serviceStats.api?.spanCount]).toEqual([60_000, 1])
    expect(Object.keys(by).sort()).toEqual(['a', '9', '8', 'b', 'c', 'd', 'e', 'f'].map(id).sort())

    const long = await search(t, '{ trace:duration > 1h }')
    expect(long.traces.map((x) => x.traceID).sort()).toEqual(['a', 'c', 'd', 'f'].map(id).sort())
    const structural = await search(t, '{ name = "c-root" } >> { name = "c-child" }')
    expect(structural.traces.map((x) => x.traceID)).toEqual([id('c')])

    const on = await answers(t)
    hooks.signalPruning = false
    const off = await answers(t)
    expect(off).toEqual(on)
  }, 180_000)

  it('with the margin past every span and pruning off ("every span"), the answers differ only for the trace beyond the margin', async () => {
    const { t } = await corpus()
    const on = await answers(t)
    await env.CONFIG.put(`limits:${t.name}`, JSON.stringify({ traceMarginMs: 48 * 3_600_000 }))
    clearLimitsCache()
    hooks.signalPruning = false
    const every = await answers(t)
    const differ = on.flatMap((x, i) => (x === every[i] ? [] : [i]))
    // Only where e and h are concerned: their children (12:00, 11:30) are beyond 11:10. Over
    // every span they last hours, so they are in the `{ }` search with other summaries, in
    // `trace:duration > 1h` and its count, and each by ID with its hint has two spans.
    const hinted = (t: string) => QUERIES.length + METRICS.length + BY_ID.findIndex(([trace, p]) => trace === id(t) && p.length > 0)
    expect(differ).toEqual([0, 1, QUERIES.length, hinted('8'), hinted('e')].sort((x, y) => x - y))
    // e without a hint is whole in both.
    const eWhole = QUERIES.length + METRICS.length + BY_ID.findIndex(([trace, p]) => trace === id('e') && p.length === 0)
    expect((JSON.parse(on[eWhole]!.slice(4)) as { batches: { scopeSpans: { spans: unknown[] }[] }[] }).batches[0]!.scopeSpans[0]!.spans.length).toBe(2)
  }, 180_000)

  it('a search reads trace_index over the window and the margin, and spans over the hull only', async () => {
    const { t } = await corpus()
    // 11:55 to 12:05: only e's child is in it; its root (09:00) is beyond the margin (09:55).
    const late: [string, string][] = [['start', sec(175)], ['end', sec(185)]]
    const on = await search(t, '{ }', late)
    expect(on.traces.map((x) => [x.traceID, x.serviceStats.api?.spanCount])).toEqual([[id('e'), 1]])
    hooks.signalPruning = false
    const off = await search(t, '{ }', late)
    expect(off.text).toBe(on.text)
    // With pruning, the span files outside the hull (12:00 to 12:01) are skipped; without it,
    // every file over the bound is read.
    expect(cost(on.res, 'Files-Read')).toBeLessThan(cost(off.res, 'Files-Read'))
  }, 180_000)
})
