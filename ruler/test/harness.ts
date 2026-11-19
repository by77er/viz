/**
 * The test worker: the production classes with their injection points overridden.
 *
 * Tests and Durable Objects run in the same isolate, so `world` is shared: a test scripts
 * the evaluator, the sink, the clock and the receiving endpoint, then drives alarms.
 * The fake clock starts in 2100 so that an alarm set from it never fires by itself; tests
 * advance `world.now` and call `runDurableObjectAlarm`.
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { PromMatrix, PromScalar, PromVector } from '../../contracts/engine'
import { authenticate } from '../../edge/src/auth'
import { HttpError } from '../../edge/src/errors'
import { snappyDecompress } from '../../edge/src/snappy'
import { batchFromSingle, permissiveValidator } from '../src/evaluator'
import type { AlertUpdate, BatchEvaluator, EvalRequest, EvalResult, Evaluator, IngestResult, RangeEvaluator, SampleBatch, Sink, Validator } from '../contracts-proposal/rules.v2'
import { createApi, type ApiEnv } from '../src/http'
import { Notifier } from '../src/notifier'
import { DEFAULT_PLACEMENT, type PlacementLimits } from '../src/placement'
import { RulerIndex } from '../src/registry'
import { Ruler, type NotifierPort, type RulerEnv } from '../src/ruler'

export const T0 = Date.UTC(2100, 0, 1)

export type EvalFn = (promql: string, timeMs: number) => PromVector | PromScalar | Promise<PromVector | PromScalar>

export interface Received {
  url: string
  key: string | null
  body: unknown
  at: number
  /** The `X-Viz-Signature` header, and the exact bytes it signs. */
  signature?: string | null
  raw?: string
}

export interface TenantWorld {
  evaluate: EvalFn
  /** Every evaluator call: [promql, timeMs]. */
  evalCalls: [string, number][]
  sinkWrites: SampleBatch[][]
  sinkFail: number
  /** Batches by id: what a de-duplicating sink would hold. */
  sinkById: Map<string, SampleBatch>
  /** Requests the fake receiver saw, including ones it then failed. */
  received: Received[]
  /** What the receiver does with request number `n` (0-based): a status, or 'timeout' = process it, then never answer in time. */
  respond: (req: Received, n: number) => number | 'timeout'
  notifierDown: boolean
  ingestCalls: AlertUpdate[][]
  faults: Set<string>
  /** True: the ruler is given a real batch evaluator (one call per group and tick) instead of the adapter. */
  batch: boolean
  /** Every batch call the batch evaluator received. */
  batchCalls: EvalRequest[][]
  /** Set: the whole batch call rejects with this message. */
  batchFail: string | null
  /** Save-time validator; unset = the permissive default. */
  validate: Validator['check'] | null
  /** The range evaluator backtests use. */
  range: ((promql: string, startMs: number, endMs: number, stepMs: number) => PromMatrix | Promise<PromMatrix>) | null
  rangeCalls: [string, number, number, number][]
  /**
   * True: the ruler uses its PRODUCTION wiring: viz-query's HTTP API (`FakeQuery`, which checks
   * the API key with edge's real `authenticate` and takes the tenant from it), Remote Write to
   * `FakeIngest`, and service keys from control's real `Tenant` object.
   */
  http: boolean
}

/** What the fake query and ingest services saw: the tenant is the one the presented key belongs to. */
export interface HttpCall {
  path: string
  /** The key's tenant, or the status the key got (401, 403). */
  tenant: string | number
  params: Record<string, string>
  authorization: string | null
  /** Engine calls in flight across the whole fake query service when this one started. */
  inFlight: number
  /** Remote Write: the decoded series. */
  series?: { labels: Record<string, string>; samples: [number, number][] }[]
}

/** Requests the fake query and ingest services received, in order, across tenants. */
export const services = {
  calls: [] as HttpCall[],
  inFlight: 0,
  maxInFlight: 0,
  /** Milliseconds each fake query takes (real time), to make overlap observable. */
  delayMs: 0,
  /** Status the services answer instead of working (e.g. 503), once per entry. */
  fail: [] as number[],
}

export const world = {
  now: T0,
  tenants: new Map<string, TenantWorld>(),
  /** Shard limits the HTTP API places groups with; tests lower them to force a split. */
  placement: { ...DEFAULT_PLACEMENT } as PlacementLimits,
  /** `<tenant>/<shard>` names the sweeper cannot reach. */
  unreachableRulers: new Set<string>(),
}

export function tenantWorld(tenant: string): TenantWorld {
  let w = world.tenants.get(tenant)
  if (!w) {
    w = {
      evaluate: () => ({ resultType: 'vector', result: [] }),
      evalCalls: [],
      sinkWrites: [],
      sinkFail: 0,
      sinkById: new Map(),
      received: [],
      respond: () => 200,
      notifierDown: false,
      ingestCalls: [],
      faults: new Set(),
      batch: false,
      batchCalls: [],
      batchFail: null,
      validate: null,
      range: null,
      rangeCalls: [],
      http: false,
    }
    world.tenants.set(tenant, w)
  }
  return w
}

export class Crash extends Error {
  constructor(point: string) {
    super(`injected crash at ${point}`)
  }
}

export class TestRuler extends Ruler {
  protected override now(): number {
    return world.now
  }
  protected override evaluator(): Evaluator {
    const w = tenantWorld(this.tenant)
    if (w.http) return super.evaluator()
    return {
      instant: async (promql, timeMs) => {
        w.evalCalls.push([promql, timeMs])
        if (promql === 'vector(1)') return { resultType: 'vector', result: [{ metric: {}, value: [timeMs / 1000, '1'] }] }
        return w.evaluate(promql, timeMs)
      },
    }
  }
  protected override batchEvaluator(): BatchEvaluator {
    const w = tenantWorld(this.tenant)
    if (w.http) return super.batchEvaluator()
    if (!w.batch) return batchFromSingle(this.evaluator())
    return {
      evaluate: async (requests) => {
        w.batchCalls.push(requests)
        if (w.batchFail !== null) throw new Error(w.batchFail)
        const out: EvalResult[] = []
        for (const r of requests) {
          w.evalCalls.push([r.promql, r.timeMs])
          try {
            const result: PromVector | PromScalar = r.promql === 'vector(1)' ? { resultType: 'vector', result: [{ metric: {}, value: [r.timeMs / 1000, '1'] }] } : await w.evaluate(r.promql, r.timeMs)
            out.push({ id: r.id, ok: true, result })
          } catch (e) {
            out.push({ id: r.id, ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        }
        return out
      },
    }
  }
  protected override rangeEvaluator(): RangeEvaluator {
    const w = tenantWorld(this.tenant)
    if (w.http) return super.rangeEvaluator()
    return {
      range: async (promql, startMs, endMs, stepMs) => {
        w.rangeCalls.push([promql, startMs, endMs, stepMs])
        if (!w.range) throw new Error('no range evaluator scripted')
        return w.range(promql, startMs, endMs, stepMs)
      },
    }
  }
  protected override validator(): Validator {
    const w = tenantWorld(this.tenant)
    if (w.http) return super.validator()
    return w.validate ? { check: w.validate } : permissiveValidator
  }
  protected override sink(): Sink {
    const w = tenantWorld(this.tenant)
    if (w.http) return super.sink()
    return {
      write: async (batches) => {
        if (w.sinkFail > 0) {
          w.sinkFail--
          throw new Error('sink unavailable')
        }
        w.sinkWrites.push(batches)
        for (const b of batches) w.sinkById.set(b.id, b)
      },
    }
  }
  protected override notifier(): NotifierPort {
    const w = tenantWorld(this.tenant)
    const real = super.notifier()
    return {
      ingest: async (source, updates): Promise<IngestResult> => {
        if (w.notifierDown) throw new Error('notifier unreachable')
        w.ingestCalls.push(updates)
        return real.ingest(source, updates)
      },
    }
  }
  protected override fault(point: string): void {
    const w = tenantWorld(this.tenant)
    if (w.faults.delete(`ruler:${point}`)) throw new Crash(point)
  }
}

export class TestNotifier extends Notifier {
  protected override now(): number {
    return world.now
  }
  protected override fetcher(): (url: string, init: RequestInit) => Promise<Response> {
    const w = tenantWorld(this.tenant)
    return async (url, init) => {
      const headers = new Headers(init.headers)
      const req: Received = { url, key: headers.get('Idempotency-Key'), body: JSON.parse(init.body as string), at: world.now, signature: headers.get('X-Viz-Signature'), raw: init.body as string }
      const n = w.received.length
      w.received.push(req)
      const r = w.respond(req, n)
      if (r === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      return new Response(r === 200 ? 'ok' : 'no', { status: r })
    }
  }
  protected override fault(point: string): void {
    const w = tenantWorld(this.tenant)
    if (w.faults.delete(`notifier:${point}`)) throw new Crash(point)
  }
}

export class TestRulerIndex extends RulerIndex {
  protected override now(): number {
    return world.now
  }
  protected override ruler(tenant: string, shard: string) {
    if (world.unreachableRulers.has(`${tenant}/${shard}`)) throw new Error('ruler unreachable')
    return super.ruler(tenant, shard)
  }
}

// ───────────────────────── fake services, reached through real service bindings ─────────────────────────

function promEnvelope(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function keyTenant(req: Request, env: { CONFIG: KVNamespace }, scope: 'read' | 'write'): Promise<string | number> {
  try {
    return (await authenticate(req, env.CONFIG, scope, world.now)).tenant
  } catch (e) {
    if (e instanceof HttpError) return e.status
    throw e
  }
}

/**
 * viz-query's Prometheus HTTP API, as far as the ruler uses it: `/api/v1/query`,
 * `/api/v1/query_range`, `/api/v1/plan`. The tenant is the presented key's (edge's real
 * `authenticate` against the shared KV), and the answer is that tenant's scripted world.
 * Expressions containing `syntax(` are parse errors (400 `bad_data`), as the engine would say.
 */
export class FakeQuery extends WorkerEntrypoint<{ CONFIG: KVNamespace }> {
  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const params = Object.fromEntries(new URLSearchParams(await req.text()))
    const tenant = await keyTenant(req, this.env, 'read')
    const call: HttpCall = { path: url.pathname, tenant, params, authorization: req.headers.get('Authorization'), inFlight: services.inFlight }
    services.calls.push(call)
    if (typeof tenant === 'number') return promEnvelope(tenant, { status: 'error', errorType: tenant === 401 ? 'unauthorized' : 'forbidden', error: 'invalid API key' })
    services.inFlight++
    services.maxInFlight = Math.max(services.maxInFlight, services.inFlight)
    try {
      if (services.delayMs > 0) await new Promise((r) => setTimeout(r, services.delayMs))
      const fail = services.fail.shift()
      if (fail !== undefined) return promEnvelope(fail, { status: 'error', errorType: 'unavailable', error: 'a storage component did not answer; retry' })
      const w = tenantWorld(tenant)
      const query = params.query ?? ''
      if (query.includes('syntax(')) return promEnvelope(400, { status: 'error', errorType: 'bad_data', error: '1:7: parse error: unexpected "("' })
      if (url.pathname === '/api/v1/plan') return promEnvelope(200, { status: 'success', data: { execution: 'single', refusal: null } })
      if (url.pathname === '/api/v1/query') {
        const timeMs = Math.round(Number(params.time) * 1000)
        w.evalCalls.push([query, timeMs])
        try {
          const data = query === 'vector(1)' ? { resultType: 'vector', result: [{ metric: {}, value: [timeMs / 1000, '1'] }] } : await w.evaluate(query, timeMs)
          return promEnvelope(200, { status: 'success', data })
        } catch (e) {
          return promEnvelope(422, { status: 'error', errorType: 'execution', error: e instanceof Error ? e.message : String(e) })
        }
      }
      if (url.pathname === '/api/v1/query_range') {
        const [start, end, step] = [params.start, params.end, params.step].map((x) => Math.round(Number(x) * 1000)) as [number, number, number]
        w.rangeCalls.push([query, start, end, step])
        if (!w.range) return promEnvelope(422, { status: 'error', errorType: 'execution', error: 'no range scripted' })
        return promEnvelope(200, { status: 'success', data: await w.range(query, start, end, step) })
      }
      return promEnvelope(404, { status: 'error', errorType: 'not_found', error: 'not found' })
    } finally {
      services.inFlight--
    }
  }
}

/** Remote Write 1.0, decoded with edge's own snappy decoder and a minimal protobuf reader. */
function decodeWriteRequest(body: Uint8Array): NonNullable<HttpCall['series']> {
  const buf = snappyDecompress(body, 1 << 24)
  let pos = 0
  const varint = (): number => {
    let x = 0n
    let shift = 0n
    for (;;) {
      const b = buf[pos++] as number
      x |= BigInt(b & 0x7f) << shift
      if (b < 0x80) break
      shift += 7n
    }
    return Number(BigInt.asIntN(64, x))
  }
  const text = (end: number) => new TextDecoder().decode(buf.subarray(pos, end))
  const out: NonNullable<HttpCall['series']> = []
  while (pos < buf.length) {
    if (varint() !== 0x0a) throw new Error('not a TimeSeries field')
    const end = pos + varint()
    const labels: Record<string, string> = {}
    const samples: [number, number][] = []
    while (pos < end) {
      const tag = varint()
      const len = varint()
      const stop = pos + len
      if (tag === 0x0a) {
        let name = ''
        let value = ''
        while (pos < stop) {
          const t = varint()
          const l = varint()
          if (t === 0x0a) name = text(pos + l)
          else value = text(pos + l)
          pos += l
        }
        labels[name] = value
      } else if (tag === 0x12) {
        if (buf[pos++] !== 0x09) throw new Error('sample value tag')
        const v = new DataView(buf.buffer, buf.byteOffset + pos, 8).getFloat64(0, true)
        pos += 8
        if (buf[pos++] !== 0x10) throw new Error('sample timestamp tag')
        samples.push([varint(), v])
      } else pos = stop
    }
    out.push({ labels, samples })
  }
  return out
}

/** viz-ingest's `/api/v1/write`: the tenant is the key's (scope `write`). */
export class FakeIngest extends WorkerEntrypoint<{ CONFIG: KVNamespace }> {
  override async fetch(req: Request): Promise<Response> {
    const tenant = await keyTenant(req, this.env, 'write')
    const call: HttpCall = { path: new URL(req.url).pathname, tenant, params: {}, authorization: req.headers.get('Authorization'), inFlight: 0 }
    services.calls.push(call)
    if (typeof tenant === 'number') return new Response('invalid API key', { status: tenant })
    const fail = services.fail.shift()
    if (fail !== undefined) return new Response('unavailable', { status: fail })
    if (req.headers.get('Content-Encoding') !== 'snappy' || req.headers.get('Content-Type') !== 'application/x-protobuf') return new Response('unsupported', { status: 415 })
    call.series = decodeWriteRequest(new Uint8Array(await req.arrayBuffer()))
    const w = tenantWorld(tenant)
    w.sinkWrites.push(call.series.map((s) => ({ id: `remote-write#${w.sinkWrites.length}`, samples: s.samples.map(([t, v]) => ({ labels: s.labels, timeMs: t, value: String(v) })) })))
    return new Response(null, { status: 204 })
  }
}

/** control's real `Tenant` object: the ruler's service keys and its default destination come from it. */
export { Tenant } from '../../control/src/tenant'

/** The production HTTP API on the fake clock. */
export const api = {
  fetch: (req: Request, env: ApiEnv) => createApi({ now: () => world.now, placement: world.placement }).fetch(req, env),
}

export default {
  fetch: (req, env) => api.fetch(req, env as unknown as ApiEnv),
} satisfies ExportedHandler<RulerEnv>
