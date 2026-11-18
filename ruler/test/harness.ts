/**
 * The test worker: the production classes with their injection points overridden.
 *
 * Tests and Durable Objects run in the same isolate, so `world` is shared: a test scripts
 * the evaluator, the sink, the clock and the receiving endpoint, then drives alarms.
 * The fake clock starts in 2100 so that an alarm set from it never fires by itself; tests
 * advance `world.now` and call `runDurableObjectAlarm`.
 */
import type { PromMatrix, PromScalar, PromVector } from '../../contracts/engine'
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
}

export const world = {
  now: T0,
  tenants: new Map<string, TenantWorld>(),
  /** Shard limits the HTTP API places groups with; tests lower them to force a split. */
  placement: { ...DEFAULT_PLACEMENT } as PlacementLimits,
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
    if (!w.batch) return super.batchEvaluator()
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
    return w.validate ? { check: w.validate } : super.validator()
  }
  protected override sink(): Sink {
    const w = tenantWorld(this.tenant)
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
}

/** The production HTTP API on the fake clock. */
export const api = {
  fetch: (req: Request, env: ApiEnv) => createApi({ now: () => world.now, placement: world.placement }).fetch(req, env),
}

export default {
  fetch: (req, env) => api.fetch(req, env as unknown as ApiEnv),
} satisfies ExportedHandler<RulerEnv>
