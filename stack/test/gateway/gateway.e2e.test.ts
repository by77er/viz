/**
 * Traces and logs, stage 3: the public path end to end. Every request goes through viz-gateway's
 * routing (deploy/gateway/src/index.ts) into the real viz-ingest code (edge → Shard → the flush
 * queue → flush → R2 → Ledger) or the real viz-query code (ledger plan, leaves, shard tails, the
 * engines), all in one script (test/gateway/worker.ts).
 *
 * Thin by design: the answers of every Tempo and Loki endpoint against the engines' in-memory
 * answers over whole corpora are query's `test/signals.e2e.test.ts` (and `test/signals.test.ts`).
 * Here: each new path reaches the right Worker and answers from what was sent through the gateway,
 * the same before and after the flush; with the flags off each new path answers 404 from its
 * Worker and nothing is stored, and metrics answer the same as with the flags on; a base pool
 * ending in `/logs` is refused by both Workers; and how long an acknowledged span or log line
 * takes to be answered through the gateway (printed, `GATEWAY_E2E_LATENCY`).
 */
import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { handle } from '../../../deploy/gateway/src/index'
import { type PrwSeries, makeKey, setPool, snappyCompress, writeRequest } from '../../../edge/test/helpers'
import { type ResourceM, logsJson, lokiProto, tracesJson, tracesProto } from '../../../edge/test/otelhelpers'
import { ledgerStub, shardStub } from '../../../flush/test/helpers'
import { type PoolMap, shardName, signalPool } from '../../../shard/src/pool'
import type { E2EEnv } from './worker'

const E = env as unknown as E2EEnv
const BASE = 'https://vis.bitcru.sh'
const OFF_ENV = (): E2EEnv => ({ ...E, INGEST: E.INGEST_OFF, QUERY: E.QUERY_OFF })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const b64hex = (s: string) => hex(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))
let n = 0
const uid = () => `${Date.now().toString(36)}${n++}`

interface Answer {
  status: number
  route: string | null
  text: string
  headers: Headers
}

/** One request through the gateway: the deployment's public fetch, or (`off`) the gateway in front of the same Workers without their flags. */
async function call(path: string, init: RequestInit & { off?: boolean } = {}): Promise<Answer> {
  const { off, ...rest } = init
  const req = new Request(`${BASE}${path}`, rest)
  const res = off ? await handle(req, OFF_ENV()) : await exports.default.fetch(req)
  return { status: res.status, route: res.headers.get('x-viz-route'), text: await res.text(), headers: res.headers }
}
const auth = (key: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${key}`, ...extra })
const qs = (params: [string, string][]) => (params.length ? `?${new URLSearchParams(params).toString()}` : '')
const get = (key: string, path: string, params: [string, string][] = [], off = false) => call(`${path}${qs(params)}`, { headers: auth(key), off })

/** A sender's POST, resent while refused for a retryable reason (429, 503), as senders do. */
async function send(key: string, path: string, body: BodyInit, contentType: string, extra: Record<string, string> = {}, off = false): Promise<Answer> {
  for (let i = 0; ; i++) {
    const a = await call(path, { method: 'POST', headers: auth(key, { 'Content-Type': contentType, ...extra }), body, off })
    if (![429, 503].includes(a.status) || i >= 50) return a
    await sleep(50)
  }
}

async function tenant(prefix: string, map: PoolMap): Promise<{ name: string; key: string; map: PoolMap }> {
  const name = `${prefix}-${uid()}`
  await setPool(name, map)
  return { name, key: await makeKey(name, { scopes: ['write', 'read'] }), map }
}

const shardsOf = (map: PoolMap): { metrics: string[]; signals: string[] } => ({
  metrics: Array.from({ length: map.slots }, (_, s) => shardName(map, s)),
  signals: (['traces', 'logs'] as const).flatMap((sig) => Array.from({ length: map.slots }, (_, s) => shardName(signalPool(map, sig)!, s))),
})

/** Seal every shard of the tenant; the seals' flush messages go through the real flush queue and its consumer. Waits until every sealed segment is recorded. */
async function flushThroughQueue(t: { name: string; map: PoolMap }): Promise<void> {
  const { metrics, signals } = shardsOf(t.map)
  const all = [...metrics, ...signals]
  for (const s of all) await shardStub(s).seal(t.name)
  const deadline = Date.now() + 60_000
  for (;;) {
    let pending = 0
    for (const s of all) pending += (await shardStub(s).pendingSegments(t.name)).length
    if (pending === 0) break
    if (Date.now() > deadline) throw new Error(`${t.name}: ${pending} sealed segment(s) not recorded after 60 s`)
    await sleep(100)
  }
}

// ─────────────────────────────── the workload ───────────────────────────────

const NOW = Date.now()
const NS = (ms: number) => BigInt(ms) * 1_000_000n
const TRACE_ID = Uint8Array.from({ length: 16 }, (_, i) => 0x81 + i)
const SPAN_IDS = [1, 2, 3].map((k) => Uint8Array.from({ length: 8 }, (_, i) => 0x10 * k + i + 1))
const t0 = NS(NOW - 120_000)
const TRACE: ResourceM[] = [
  {
    attrs: [['service.name', { s: 'gw-svc-a' }], ['service.instance.id', { s: 'a-0' }]],
    scopes: [{ name: 'gw', spans: [
      { traceId: TRACE_ID, spanId: SPAN_IDS[0]!, name: 'GET /checkout', kind: 2, start: t0, end: t0 + 40_000_000n, attrs: [['gw.attr', { s: 'root' }]] },
      { traceId: TRACE_ID, spanId: SPAN_IDS[1]!, parent: SPAN_IDS[0], name: 'render', kind: 1, start: t0 + 1_000_000n, end: t0 + 30_000_000n, attrs: [['gw.attr', { s: 'child' }]] },
    ] }],
  },
  {
    attrs: [['service.name', { s: 'gw-svc-b' }], ['service.instance.id', { s: 'b-0' }]],
    scopes: [{ name: 'gw', spans: [{ traceId: TRACE_ID, spanId: SPAN_IDS[2]!, parent: SPAN_IDS[1], name: 'SELECT', kind: 3, start: t0 + 2_000_000n, end: t0 + 20_000_000n, statusCode: 2 }] }],
  },
]
const OTLP_LOGS = logsJson([{ attrs: [['service.name', { s: 'gw-svc-a' }]], scopes: [{ logs: [
  { time: NS(NOW - 90_000), severity: 9, body: { s: 'gateway line one' }, traceId: TRACE_ID, spanId: SPAN_IDS[0] },
  { time: NS(NOW - 80_000), severity: 13, body: { s: 'gateway line two' }, attrs: [['user', { s: 'ann' }]] },
] }] }])
const LOKI = lokiProto([{ labels: '{job="gw-loki", instance="i-1"}', entries: [{ ts: NS(NOW - 70_000), line: 'loki line 1', md: [['user', 'bob']] }, { ts: NS(NOW - 60_000), line: 'loki line 2' }] }])
const PRW: PrwSeries[] = Array.from({ length: 6 }, (_, i) => ({
  labels: [['__name__', i % 2 ? 'up' : 'gw_requests_total'], ['job', 'gw-svc-a'], ['instance', `a-${i % 3}`], ['k', String(i)]],
  samples: Array.from({ length: 5 }, (_, j) => ({ ts: NOW - 300_000 + j * 60_000, value: i * 10 + j })),
}))
const remoteWrite = (key: string, off = false) =>
  send(key, '/api/v1/write', snappyCompress(writeRequest(PRW)), 'application/x-protobuf', { 'Content-Encoding': 'snappy', 'X-Prometheus-Remote-Write-Version': '0.1.0' }, off)

// Tempo's search, tags and metrics take Unix seconds; Loki reads an integer as nanoseconds.
const START_S = String(Math.floor(NOW / 1000) - 3600)
const END_S = String(Math.ceil(NOW / 1000) + 60)
const START_NS = `${START_S}000000000`
const END_NS = `${END_S}000000000`
const TRACE_HEX = hex(TRACE_ID)

/** The new read paths with what each must answer, from the workload above. */
const READS: { name: string; path: string; params: [string, string][]; method?: 'POST'; check: (body: unknown) => void }[] = [
  { name: 'Tempo trace by ID', path: `/api/traces/${TRACE_HEX}`, params: [], check: (b) => expect(spanIdsOf(b).sort()).toEqual(SPAN_IDS.map(hex).sort()) },
  { name: 'Tempo trace by ID (v2)', path: `/api/v2/traces/${TRACE_HEX}`, params: [], check: (b) => expect(spanIdsOf((b as { trace: unknown }).trace).sort()).toEqual(SPAN_IDS.map(hex).sort()) },
  { name: 'Tempo search', path: '/api/search', params: [['q', '{ resource.service.name = "gw-svc-b" }'], ['start', START_S], ['end', END_S]], check: (b) => {
    const traces = (b as { traces: { traceID: string; rootServiceName: string }[] }).traces
    expect(traces.map((x) => [x.traceID.padStart(32, '0'), x.rootServiceName])).toEqual([[TRACE_HEX, 'gw-svc-a']])
  } },
  { name: 'Tempo tags', path: '/api/search/tags', params: [['start', START_S], ['end', END_S]], check: (b) => expect((b as { tagNames: string[] }).tagNames).toContain('gw.attr') },
  { name: 'Tempo tags (v2)', path: '/api/v2/search/tags', params: [['start', START_S], ['end', END_S]], check: (b) => expect((b as { scopes: { tags: string[] }[] }).scopes.flatMap((s) => s.tags)).toContain('gw.attr') },
  { name: 'Tempo tag values', path: '/api/search/tag/service.name/values', params: [['start', START_S], ['end', END_S]], check: (b) => expect([...(b as { tagValues: string[] }).tagValues].sort()).toEqual(['gw-svc-a', 'gw-svc-b']) },
  { name: 'Tempo tag values (v2)', path: '/api/v2/search/tag/resource.service.name/values', params: [['start', START_S], ['end', END_S]], check: (b) =>
    expect((b as { tagValues: { value: string }[] }).tagValues.map((v) => v.value).sort()).toEqual(['gw-svc-a', 'gw-svc-b']) },
  { name: 'TraceQL metrics, range', path: '/api/metrics/query_range', params: [['q', '{ resource.service.name = "gw-svc-a" } | count_over_time()'], ['start', START_S], ['end', END_S], ['step', '60s']], check: (b) => expect(sumOf(b)).toBe(2) },
  { name: 'TraceQL metrics, instant', path: '/api/metrics/query', params: [['q', '{ } | count_over_time()'], ['start', START_S], ['end', END_S]], check: (b) => expect(sumOf(b)).toBe(3) },
  { name: 'LogQL range (OTLP logs)', path: '/loki/api/v1/query_range', params: [['query', '{service_name="gw-svc-a"}'], ['start', START_NS], ['end', END_NS], ['limit', '100']], check: (b) =>
    expect(linesOf(b).sort()).toEqual(['gateway line one', 'gateway line two']) },
  { name: 'LogQL range (Loki push), POST', path: '/loki/api/v1/query_range', method: 'POST', params: [['query', '{job="gw-loki"}'], ['start', START_NS], ['end', END_NS], ['direction', 'forward']], check: (b) =>
    expect(linesOf(b)).toEqual(['loki line 1', 'loki line 2']) },
  { name: 'LogQL instant', path: '/loki/api/v1/query', params: [['query', 'sum(count_over_time({job="gw-loki"}[1h]))'], ['time', `${Math.floor(NOW / 1000)}000000000`]], check: (b) =>
    expect((b as { data: { result: { value: [number, string] }[] } }).data.result.map((r) => r.value[1])).toEqual(['2']) },
  { name: 'Loki labels', path: '/loki/api/v1/labels', params: [['start', START_NS], ['end', END_NS]], check: (b) => expect((b as { data: string[] }).data).toEqual(expect.arrayContaining(['instance', 'job', 'service_name'])) },
  { name: 'Loki label values', path: '/loki/api/v1/label/job/values', params: [['start', START_NS], ['end', END_NS]], check: (b) => expect((b as { data: string[] }).data).toEqual(['gw-loki']) },
  { name: 'Loki series', path: '/loki/api/v1/series', params: [['match[]', '{job="gw-loki"}'], ['start', START_NS], ['end', END_NS]], check: (b) => expect((b as { data: unknown[] }).data).toEqual([{ instance: 'i-1', job: 'gw-loki' }]) },
]

/** Every `spanId` in an OTLP JSON trace (Grafana's trace JSON: base64 ids), as hex. */
function spanIdsOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) spanIdsOf(x, out)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) k === 'spanId' && typeof x === 'string' ? out.push(b64hex(x)) : spanIdsOf(x, out)
  return out
}
/** The sum of every sample value of a TraceQL metrics answer. */
function sumOf(v: unknown): number {
  let s = 0
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk)
    else if (x && typeof x === 'object') {
      for (const [k, y] of Object.entries(x)) {
        if (k === 'samples' && Array.isArray(y)) for (const p of y) s += Number((p as { value: unknown }).value ?? 0)
        else if (k === 'value' && Array.isArray(y) && y.length === 2) s += Number(y[1])
        else walk(y)
      }
    }
  }
  walk(v)
  return s
}
const linesOf = (b: unknown): string[] => (b as { data: { result: { values: [string, string][] }[] } }).data.result.flatMap((r) => r.values.map((x) => x[1]))

/** An answer's body as compared before and after the flush: without what depends on how it was read (Tempo's `metrics`, Loki's `stats`). */
function stable(text: string): unknown {
  const v = JSON.parse(text) as Record<string, unknown>
  delete v.metrics
  if (v.data && typeof v.data === 'object') delete (v.data as Record<string, unknown>).stats
  return v
}

async function read(key: string, r: (typeof READS)[number], off = false): Promise<Answer> {
  if (r.method === 'POST') {
    return call(r.path, { method: 'POST', headers: auth(key, { 'Content-Type': 'application/x-www-form-urlencoded' }), body: new URLSearchParams(r.params).toString(), off })
  }
  return get(key, r.path, r.params, off)
}

// ─────────────────────────────── the tests ───────────────────────────────

describe('through the gateway, both flags on', () => {
  it('OTLP traces and logs and Loki push reach viz-ingest; every Tempo and Loki read path reaches viz-query and answers what was sent, from the tails and again from flushed files', async () => {
    const map: PoolMap = { pool: `gw-${uid()}`, slots: 2, spread: 2, epoch: 1 }
    const t = await tenant('gw-on', map)
    const pb = await send(t.key, '/v1/traces', tracesProto(TRACE), 'application/x-protobuf')
    expect([pb.status, pb.route]).toEqual([200, 'ingest'])
    // The same spans as OTLP/JSON: the same rows, stored once (fingerprint or row key).
    const js = await send(t.key, '/v1/traces', tracesJson(TRACE), 'application/json')
    expect([js.status, js.route, js.text]).toEqual([200, 'ingest', '{}'])
    const lg = await send(t.key, '/v1/logs', OTLP_LOGS, 'application/json')
    expect([lg.status, lg.route, lg.text]).toEqual([200, 'ingest', '{}'])
    const lk = await send(t.key, '/loki/api/v1/push', LOKI, 'application/x-protobuf')
    expect([lk.status, lk.route]).toEqual([204, 'ingest'])
    expect((await remoteWrite(t.key)).status).toBe(204)

    // Nothing flushed: every answer comes from the shards' tails.
    const before = new Map<string, Answer>()
    for (const r of READS) {
      const a = await read(t.key, r)
      expect([r.name, a.status, a.route], a.text.slice(0, 300)).toEqual([r.name, 200, 'query'])
      expect(Number(a.headers.get('X-Viz-Files-Read')), r.name).toBe(0)
      r.check(JSON.parse(a.text))
      before.set(r.name, a)
    }
    const plan = await get(t.key, '/api/v1/plan', [['query', 'sum(up)'], ['time', String(Math.floor(NOW / 1000))]])
    expect([plan.status, plan.route]).toEqual([200, 'query'])
    expect((JSON.parse(plan.text) as { data: { execution: string } }).data.execution).toMatch(/^(single|split|none)$/)
    // A trace that is not there: Tempo's 404, from viz-query.
    const missing = await get(t.key, `/api/traces/${'ab'.repeat(16)}`)
    expect([missing.status, missing.route]).toEqual([404, 'query'])

    // Seal every shard; the flush queue's consumer flushes and the ledger lists the files.
    await flushThroughQueue(t)
    const files = await Promise.all((['spans', 'trace_index', 'logs'] as const).map((table) => ledgerStub(t.name).plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })))
    expect(files.map((p) => p.files.length > 0)).toEqual([true, true, true])
    for (const r of READS) {
      const a = await read(t.key, r)
      expect([r.name, a.status, a.route]).toEqual([r.name, 200, 'query'])
      expect(Number(a.headers.get('X-Viz-Files-Read')), r.name).toBeGreaterThan(0)
      expect(Number(a.headers.get('X-Viz-Tail-Batches')), r.name).toBe(0)
      expect(stable(a.text), r.name).toEqual(stable(before.get(r.name)!.text))
    }
  })
})

describe('through the gateway, both flags off', () => {
  it('each new path answers 404 from its own Worker and nothing is stored; metrics answer exactly as with the flags on, from tails and from files', async () => {
    const on = await tenant('gw-flag-on', { pool: `gwon-${uid()}`, slots: 2, spread: 2, epoch: 1 })
    const off = await tenant('gw-flag-off', { pool: `gwoff-${uid()}`, slots: 2, spread: 2, epoch: 1 })

    // Ingest paths: routed to viz-ingest, which serves them only with INGEST_SIGNALS.
    for (const [path, body, ct] of [['/v1/traces', tracesProto(TRACE), 'application/x-protobuf'], ['/v1/logs', OTLP_LOGS, 'application/json'], ['/loki/api/v1/push', LOKI, 'application/x-protobuf']] as const) {
      const a = await send(off.key, path, body, ct, {}, true)
      expect([path, a.status, a.route, a.text]).toEqual([path, 404, 'ingest', 'not found'])
    }
    for (const s of shardsOf(off.map).signals) expect(await shardStub(s).describe(off.name), s).toBeNull()
    // Read paths: routed to viz-query, which serves them only with QUERY_SIGNALS (authenticated or not).
    for (const r of READS) {
      for (const key of [off.key, 'viz_nokey_notavalidsecret']) {
        const a = await read(key, r, true)
        expect([r.name, a.status, a.route]).toEqual([r.name, 404, 'query'])
        expect(JSON.parse(a.text)).toMatchObject({ status: 'error', errorType: 'not_found' })
      }
    }
    // The plan endpoint is not behind a flag.
    expect((await get(off.key, '/api/v1/plan', [['query', 'up'], ['time', String(Math.floor(NOW / 1000))]], true)).status).toBe(200)

    // Metrics: the same Remote Write for both; the tenant with the flags on also has span and log
    // streams in its ledger (every plan names them, D62), the other has none.
    expect((await remoteWrite(off.key, true)).status).toBe(204)
    expect((await remoteWrite(on.key)).status).toBe(204)
    expect((await send(on.key, '/v1/traces', tracesProto(TRACE), 'application/x-protobuf')).status).toBe(200)
    expect((await send(on.key, '/loki/api/v1/push', LOKI, 'application/x-protobuf')).status).toBe(204)
    const metricReads: [string, [string, string][]][] = [
      ['/api/v1/query_range', [['query', 'sum by (instance) (gw_requests_total)'], ['start', String(Math.floor((NOW - 300_000) / 1000))], ['end', String(Math.floor(NOW / 1000))], ['step', '60']]],
      ['/api/v1/query', [['query', 'up'], ['time', String(Math.floor(NOW / 1000))]]],
      ['/api/v1/series', [['match[]', '{job="gw-svc-a"}'], ['start', START_S], ['end', END_S]]],
      ['/api/v1/labels', [['start', START_S], ['end', END_S]]],
      ['/api/v1/label/k/values', [['start', START_S], ['end', END_S]]],
    ]
    const compare = async (where: string) => {
      for (const [path, params] of metricReads) {
        const a = await get(on.key, path, params)
        const b = await get(off.key, path, params, true)
        expect([where, path, a.status, a.route, b.status, b.route]).toEqual([where, path, 200, 'query', 200, 'query'])
        expect(a.text, `${where} ${path}`).toBe(b.text)
        expect(a.text, `${where} ${path}`).not.toMatch(/"result":\[\]|"data":\[\]/)
      }
    }
    await compare('tails')
    await flushThroughQueue(on)
    await flushThroughQueue(off)
    await compare('files')
  })
})

describe('a base pool ending in /traces or /logs (contracts/BATCH.md, "Streams per signal")', () => {
  it('is refused by viz-ingest and by viz-query, through the gateway; the tenant whose log shards it would share is untouched', async () => {
    const good = await tenant('gw-pool-good', { pool: `gwp-${uid()}`, slots: 2, spread: 2, epoch: 1 })
    // Its metric shards `…/logs/{slot}` would be `good`'s log shards.
    const bad = await tenant('gw-pool-bad', { ...good.map, pool: `${good.map.pool}/logs` })
    expect((await send(good.key, '/loki/api/v1/push', LOKI, 'application/x-protobuf')).status).toBe(204)
    const w = await call('/api/v1/write', { method: 'POST', headers: auth(bad.key, { 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'snappy' }), body: snappyCompress(writeRequest(PRW)) })
    expect([w.status, w.route, w.text]).toEqual([503, 'ingest', 'shard pool map is invalid'])
    const l = await call('/loki/api/v1/push', { method: 'POST', headers: auth(bad.key, { 'Content-Type': 'application/x-protobuf' }), body: LOKI })
    expect([l.status, l.route]).toEqual([503, 'ingest'])
    for (const s of shardsOf(bad.map).metrics) expect(await shardStub(s).describe(bad.name), s).toBeNull()
    for (const [path, params] of [['/api/v1/query', [['query', 'up']]], ['/loki/api/v1/labels', [['start', START_NS], ['end', END_NS]]]] as [string, [string, string][]][]) {
      const q = await get(bad.key, path, params)
      expect([path, q.status, q.route], q.text).toEqual([path, 503, 'query'])
    }
    const g = await read(good.key, READS.find((r) => r.name === 'Loki series')!)
    expect([g.status, (JSON.parse(g.text) as { data: unknown }).data]).toEqual([200, [{ instance: 'i-1', job: 'gw-loki' }]])
  })
})

describe('ingest to queryable, through the gateway (measured here)', () => {
  it('an acknowledged span or log line is answered by the first query after the acknowledgement', async () => {
    const t = await tenant('gw-lat', { pool: `gwl-${uid()}`, slots: 2, spread: 2, epoch: 1 })
    const N = 20
    const out: Record<'trace' | 'log', { ack: number[]; visible: number[]; polls: number[] }> = { trace: { ack: [], visible: [], polls: [] }, log: { ack: [], visible: [], polls: [] } }
    for (let i = 0; i < N; i++) {
      // A trace of one span, then trace by ID until it is answered.
      const id = crypto.getRandomValues(new Uint8Array(16))
      id[0] = 0x40 | (id[0]! & 0x3f)
      const now = NS(Date.now())
      const body = tracesJson([{ attrs: [['service.name', { s: 'lat' }]], scopes: [{ name: 'lat', spans: [{ traceId: id, spanId: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, i + 1), name: `op ${i}`, kind: 2, start: now, end: now + 1_000_000n }] }] }])
      let s0 = Date.now()
      const a = await send(t.key, '/v1/traces', body, 'application/json')
      const ack = Date.now()
      expect(a.status).toBe(200)
      let polls = 0
      for (;;) {
        polls++
        if ((await get(t.key, `/api/traces/${hex(id)}`)).status === 200) break
        expect(polls, `trace ${i} not answered`).toBeLessThan(200)
        await sleep(10)
      }
      out.trace.ack.push(ack - s0)
      out.trace.visible.push(Date.now() - ack)
      out.trace.polls.push(polls)

      // A log line through Loki push, then a LogQL range query for it.
      const line = `lat ${i} ${crypto.randomUUID()}`
      s0 = Date.now()
      const p = await send(t.key, '/loki/api/v1/push', JSON.stringify({ streams: [{ stream: { job: 'lat' }, values: [[String(NS(Date.now())), line]] }] }), 'application/json')
      const ack2 = Date.now()
      expect(p.status).toBe(204)
      polls = 0
      for (;;) {
        polls++
        const q = await get(t.key, '/loki/api/v1/query_range', [['query', `{job="lat"} |= "${line}"`], ['start', `${Math.floor(Date.now() / 1000) - 600}000000000`], ['end', `${Math.ceil(Date.now() / 1000) + 5}000000000`]])
        if (q.status === 200 && linesOf(JSON.parse(q.text)).includes(line)) break
        expect(polls, `log line ${i} not answered`).toBeLessThan(200)
        await sleep(10)
      }
      out.log.ack.push(ack2 - s0)
      out.log.visible.push(Date.now() - ack2)
      out.log.polls.push(polls)
    }
    // Shards are read above the ledger's watermark: nothing waits for a flush.
    expect(out.trace.polls.every((x) => x === 1) && out.log.polls.every((x) => x === 1), JSON.stringify(out)).toBe(true)

    // And from a file: seal the tenant's shards, and time until a trace by ID is answered from a
    // flushed file with nothing left in the tail (through the flush queue, max_batch_timeout 1 s).
    const fromFile: number[] = []
    const { signals } = shardsOf(t.map)
    for (let i = 0; i < 5; i++) {
      const id = crypto.getRandomValues(new Uint8Array(16))
      id[0] = 0x40 | (id[0]! & 0x3f)
      const now = NS(Date.now())
      expect((await send(t.key, '/v1/traces', tracesJson([{ attrs: [['service.name', { s: 'lat' }]], scopes: [{ name: 'lat', spans: [{ traceId: id, spanId: Uint8Array.of(9, 9, 9, 9, 9, 9, 9, i + 1), name: 'f', kind: 2, start: now, end: now + 1n }] }] }]), 'application/json')).status).toBe(200)
      const s0 = Date.now()
      for (const s of signals) await shardStub(s).seal(t.name)
      for (let k = 0; ; k++) {
        const q = await get(t.key, `/api/traces/${hex(id)}`)
        if (q.status === 200 && Number(q.headers.get('X-Viz-Files-Read')) > 0 && Number(q.headers.get('X-Viz-Tail-Batches')) === 0) break
        expect(k, 'not answered from a file within 30 s').toBeLessThan(3000)
        await sleep(10)
      }
      fromFile.push(Date.now() - s0)
    }
    const stats = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b)
      return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] }
    }
    console.log(`GATEWAY_E2E_LATENCY ${JSON.stringify({
      trace: { firstAckMs: out.trace.ack[0], firstVisibleAfterAckMs: out.trace.visible[0], ackMs: stats(out.trace.ack.slice(1)), visibleAfterAckMs: stats(out.trace.visible.slice(1)), polls: stats(out.trace.polls) },
      log: { firstAckMs: out.log.ack[0], firstVisibleAfterAckMs: out.log.visible[0], ackMs: stats(out.log.ack.slice(1)), visibleAfterAckMs: stats(out.log.visible.slice(1)), polls: stats(out.log.polls) },
      sealToServedFromFileMs: stats(fromFile),
    })}`)
  })
})
