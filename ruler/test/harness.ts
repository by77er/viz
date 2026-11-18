/**
 * The test worker: the production classes with their injection points overridden.
 *
 * Tests and Durable Objects run in the same isolate, so `world` is shared: a test scripts
 * the evaluator, the sink, the clock and the receiving endpoint, then drives alarms.
 * The fake clock starts in 2100 so that an alarm set from it never fires by itself; tests
 * advance `world.now` and call `runDurableObjectAlarm`.
 */
import type { PromScalar, PromVector } from '../../contracts/engine'
import type { AlertUpdate, Evaluator, IngestResult, SampleBatch, Sink } from '../contracts-proposal/rules'
import { Notifier } from '../src/notifier'
import { Ruler, type NotifierPort, type RulerEnv } from '../src/ruler'

export const T0 = Date.UTC(2100, 0, 1)

export type EvalFn = (promql: string, timeMs: number) => PromVector | PromScalar | Promise<PromVector | PromScalar>

export interface Received {
  url: string
  key: string | null
  body: unknown
  at: number
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
}

export const world = {
  now: T0,
  tenants: new Map<string, TenantWorld>(),
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
      const req: Received = { url, key: headers.get('Idempotency-Key'), body: JSON.parse(init.body as string), at: world.now }
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

export default {
  fetch: () => new Response('viz ruler test worker'),
} satisfies ExportedHandler<RulerEnv>
