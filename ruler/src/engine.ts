/**
 * The query engine as the ruler reaches it in production: viz-query's Prometheus HTTP API,
 * over the `QUERY` service binding, with the ruler's service key for the tenant
 * (`credential.ts`). This is the closest faithful form of the contract's batch evaluator the
 * query Worker allows today: it has no RPC entrypoint (README, "Needed changes"), so a batch
 * of N expressions is N `/api/v1/query` requests.
 *
 * Six connections. A Worker reached through a service binding spends from its caller's six
 * simultaneous connections (AGENTS.md; spike S1), and one query of viz-query may itself open
 * several at once (ledger, then shards and leaves in parallel). So every engine call of one
 * Ruler object goes through one gate that admits `ENGINE_CALLS_IN_FLIGHT` (1) call at a time,
 * across all of the object's groups (which run up to `maxConcurrentGroups` at once) and its
 * save-time validation: the ruler adds no connection of its own beyond the one call whose
 * callee may use the rest. Notification delivery runs in the Notifier, another object with
 * its own six.
 *
 * Nothing secret leaves this module: errors carry the query service's status and message
 * (never the key, never a URL), and a refused key is reported to the credential, which
 * decides whether to ask control for a new one.
 */
import type { PromMatrix, PromScalar, PromVector } from '../../contracts/engine'
import type { EvalRequest, EvalResult, HistoryPlan, Validator } from '../contracts-proposal/rules.v2'
import { errorText } from './evaluator'

export const ENGINE_CALLS_IN_FLIGHT = 1

/** Something with a `fetch`: a service binding. */
export interface Fetcher {
  fetch(req: Request): Promise<Response>
}

/** The ruler's service key, and what to do when the query service refuses it. */
export interface CredentialSource {
  get(): Promise<string>
  /** The callee answered 401 to `key`. */
  rejected(key: string): void
}

/** A counting semaphore: at most `limit` holders; waiters are served in order. */
export class Gate {
  private held = 0
  private readonly waiting: (() => void)[] = []
  constructor(readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.held >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve))
    else this.held++
    try {
      return await fn()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.held--
    }
  }

  get inFlight(): number {
    return this.held
  }
}

const BASE = 'https://query.internal'

/** Unix ms → the seconds Prometheus parses, exact to the millisecond (no float multiplication on the far side). */
export function promTime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const rem = ms - s * 1000
  return rem === 0 ? String(s) : `${s}.${String(rem).padStart(3, '0')}`
}

interface Envelope {
  status?: string
  data?: unknown
  errorType?: unknown
  error?: unknown
}

class EngineError extends Error {}

/**
 * One POST to the query API. Resolves to the envelope's `data`, or throws an `EngineError`
 * whose message is `<errorType>: <error>` as the query service said it.
 */
async function call(q: Fetcher, cred: CredentialSource, path: string, params: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; data: unknown }> {
  const key = await cred.get()
  let res: Response
  try {
    res = await q.fetch(
      new Request(`${BASE}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'viz-ruler' },
        body: new URLSearchParams(params).toString(),
        signal: signal ?? null,
      }),
    )
  } catch (e) {
    if (signal?.aborted) throw signal.reason
    throw new EngineError(`the query service could not be reached: ${errorText(e)}`)
  }
  let env: Envelope | null = null
  try {
    env = (await res.json()) as Envelope
  } catch {
    env = null
  }
  if (res.status === 401) {
    cred.rejected(key)
    throw new EngineError('unauthorized: the query service refused the ruler\'s service key; a new one is requested from the control plane when this one is old enough that KV propagation is not the reason')
  }
  if (res.ok && env?.status === 'success') return { status: res.status, data: env.data }
  const type = typeof env?.errorType === 'string' ? env.errorType : `HTTP ${res.status}`
  const message = typeof env?.error === 'string' ? env.error : `the query service answered ${res.status}`
  const err = new EngineError(`${type}: ${message}`.slice(0, 500))
  ;(err as EngineError & { status?: number; errorType?: string }).status = res.status
  ;(err as EngineError & { status?: number; errorType?: string }).errorType = typeof env?.errorType === 'string' ? env.errorType : undefined
  throw err
}

export interface HttpEngine {
  evaluate(requests: EvalRequest[], opts?: { signal?: AbortSignal }): Promise<EvalResult[]>
  range(promql: string, startMs: number, endMs: number, stepMs: number): Promise<PromMatrix>
  plan(promql: string, startMs: number, endMs: number, stepMs: number): Promise<HistoryPlan>
  check: Validator['check']
}

export function httpEngine(q: Fetcher, cred: CredentialSource, gate: Gate): HttpEngine {
  return {
    /**
     * Every request in order, one at a time through the gate. A failing request fails alone;
     * once `signal` aborts, the request in flight and every later one fail with its reason.
     */
    async evaluate(requests, opts) {
      const signal = opts?.signal
      const out: EvalResult[] = []
      for (const r of requests) {
        const started = Date.now()
        try {
          if (signal?.aborted) throw signal.reason
          const { data } = await gate.run(() => call(q, cred, '/api/v1/query', { query: r.promql, time: promTime(r.timeMs) }, signal))
          const d = data as PromVector | PromScalar | { resultType?: string }
          if (d?.resultType !== 'vector' && d?.resultType !== 'scalar') {
            throw new EngineError(`the expression returns a ${String(d?.resultType)}; a rule needs an instant vector or a scalar`)
          }
          out.push({ id: r.id, ok: true, result: d as PromVector | PromScalar, durationMs: Date.now() - started })
        } catch (e) {
          out.push({ id: r.id, ok: false, error: errorText(e), durationMs: Date.now() - started })
        }
      }
      return out
    },

    async range(promql, startMs, endMs, stepMs) {
      const { data } = await gate.run(() => call(q, cred, '/api/v1/query_range', { query: promql, start: promTime(startMs), end: promTime(endMs), step: promTime(stepMs) }))
      const d = data as PromMatrix
      if (d?.resultType !== 'matrix') throw new EngineError(`the range query returned a ${String((d as { resultType?: string })?.resultType)}, not a matrix`)
      return d
    },

    /**
     * What a range read would cost, from `/api/v1/plan` with `start`, `end` and `step` (one ledger
     * read; nothing fetched). A request the engine refuses outright (`bad_data`, `unsupported`:
     * too many steps, a parse error) comes back as the plan's refusal; an outage throws. A field
     * the answer lacks is NaN, which the caller refuses rather than guesses.
     */
    async plan(promql, startMs, endMs, stepMs) {
      try {
        const { data } = await gate.run(() => call(q, cred, '/api/v1/plan', { query: promql, start: promTime(startMs), end: promTime(endMs), step: promTime(stepMs) }))
        const d = (data ?? {}) as Record<string, unknown>
        const n = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : NaN)
        const r = d.refusal as { errorType?: unknown; error?: unknown } | null | undefined
        return {
          scanSamples: n('scanSamples'),
          bytesToRead: n('bytesToRead'),
          seriesEstimate: n('seriesEstimate'),
          refusal: r ? { errorType: String(r.errorType ?? 'execution'), error: String(r.error ?? '') } : null,
        }
      } catch (e) {
        const type = (e as { errorType?: string }).errorType
        if (e instanceof EngineError && (type === 'bad_data' || type === 'unsupported')) return { scanSamples: NaN, bytesToRead: NaN, seriesEstimate: NaN, refusal: { errorType: type, error: e.message.replace(/^[a-z_]+: /, '') } }
        throw e
      }
    },

    /**
     * Save-time validation through `/api/v1/plan`: the engine parses and plans the expression
     * (one ledger read; nothing is fetched or evaluated). A parse error (`bad_data`) or an
     * expression the engine does not implement (`unsupported`) is a finding; anything else
     * (a refused key, an outage) throws, and the caller saves without blocking.
     */
    async check(promql) {
      try {
        await gate.run(() => call(q, cred, '/api/v1/plan', { query: promql }))
        return { ok: true, errors: [], selectors: [] }
      } catch (e) {
        const type = (e as { errorType?: string }).errorType
        if (e instanceof EngineError && (type === 'bad_data' || type === 'unsupported')) {
          return { ok: false, errors: [{ message: e.message.replace(/^[a-z_]+: /, ''), fix: type === 'unsupported' ? 'Rewrite it with PromQL the engine implements.' : 'Correct the expression; try it in Explore first.' }], selectors: [] }
        }
        throw e
      }
    },
  }
}
