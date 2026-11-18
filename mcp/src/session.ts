import type { ControlClient, MonitorsClient, QueryClient } from './clients'
import type { Identity } from './auth'

/**
 * Limits on one tool call. Every number can be overridden per deployment with the
 * `MCP_LIMITS` variable (JSON, any subset); the tenant's own query limits are enforced
 * by the query service on top of these.
 */
export interface Limits {
  /** Series digested per query. Over it, the largest by last value are digested and the rest counted. */
  maxSeries: number
  /** Panels evaluated per read_dashboard or write_dashboard preview. */
  maxPanels: number
  /** Downstream queries in flight at once in one call. A Worker has six outbound connections. */
  maxParallel: number
  /** Wall time for one tool call; what has not finished is reported as not evaluated. */
  deadlineMs: number
  /** Timeout passed to the query service per query. */
  queryTimeoutMs: number
  /** Points a range query may ask for (Prometheus' own cap is 11,000). */
  maxPoints: number
  /** Metrics described in detail per search page (one series call each). */
  maxDescribed: number
  /** How long a tenant's metric names are reused in this isolate. */
  namesTtlMs: number
}

export const DEFAULT_LIMITS: Limits = {
  maxSeries: 2000,
  maxPanels: 40,
  maxParallel: 6,
  deadlineMs: 10_000,
  queryTimeoutMs: 8_000,
  maxPoints: 11_000,
  maxDescribed: 20,
  namesTtlMs: 30_000,
}

export function limitsFrom(json: string | undefined): Limits {
  if (!json) return DEFAULT_LIMITS
  try {
    const v = JSON.parse(json) as Record<string, unknown>
    const out = { ...DEFAULT_LIMITS }
    for (const k of Object.keys(out) as (keyof Limits)[]) {
      const x = v[k]
      if (typeof x === 'number' && Number.isFinite(x) && x > 0) out[k] = Math.floor(x)
    }
    return out
  } catch {
    return DEFAULT_LIMITS
  }
}

/**
 * Returned counters: what one call used. Every result carries them (`usage` in the
 * structured content, and the REST response). See README "Per-identity budgets".
 */
export interface Usage {
  queries: number
  series: number
  points: number
  upstreamCalls: number
  ms: number
}

export const newUsage = (): Usage => ({ queries: 0, series: 0, points: 0, upstreamCalls: 0, ms: 0 })

/**
 * The per-identity budget hook. `admit` runs before a tool, `record` after it with the
 * returned counters. The default admits everything and records nothing: the counters go
 * back to the caller, whose runtime (an agentic monitor's Workflow, an agent host, AI
 * Gateway) sums them and stops. A deployment that wants a server-side cap supplies its
 * own hook; it must not be a Durable Object on this path.
 */
export interface BudgetHook {
  admit(id: Identity, tool: string): Promise<{ ok: true } | { ok: false; reason: string; retryAfterSeconds?: number }>
  record(id: Identity, tool: string, usage: Usage): Promise<void>
}

export const returnedCounters: BudgetHook = {
  admit: async () => ({ ok: true }),
  record: async () => {},
}

export interface Session {
  id: Identity
  query: QueryClient
  control: ControlClient | null
  monitors: MonitorsClient | null
  limits: Limits
  /** Unix milliseconds, fixed for the whole call so every part of it agrees on "now". */
  now: number
  /** Monotonic deadline for this call (performance.now() based). */
  deadline: number
  /** Base URL of the app, for deep links. */
  appUrl: string
  usage: Usage
  /** The tenant's metric names, from the query service with the caller's credential. */
  metricNames(): Promise<string[]>
}

// ---- metric names, reused briefly per tenant ----

/**
 * The names cache is keyed by the credential's tenant. Every key of a tenant sees the same
 * names today; when label-matcher policies exist (DESIGN §9) the key must include the
 * caller's policy. It is never keyed by anything a request says.
 */
const namesCache = new Map<string, { names: string[]; expires: number }>()
const MAX_CACHED_TENANTS = 1000
const MAX_NAMES = 50_000

export function clearNamesCache(): void {
  namesCache.clear()
}

export function namesLoader(s: Pick<Session, 'id' | 'query' | 'limits' | 'now' | 'usage'>): () => Promise<string[]> {
  let mine: Promise<string[]> | null = null
  return () => {
    if (mine) return mine
    const key = s.id.tenant
    const hit = namesCache.get(key)
    if (hit && hit.expires > s.now) return (mine = Promise.resolve(hit.names))
    mine = (async () => {
      s.usage.upstreamCalls++
      // Names seen in the last day: enough for discovery and did-you-mean, cheap for the index.
      const r = await s.query.labelValues('__name__', [], { start: Math.floor(s.now / 1000) - 86_400, end: Math.floor(s.now / 1000) })
      if (!r.ok) return []
      const names = r.data.filter((n) => typeof n === 'string').slice(0, MAX_NAMES)
      if (namesCache.size >= MAX_CACHED_TENANTS) namesCache.clear()
      namesCache.set(key, { names, expires: s.now + s.limits.namesTtlMs })
      return names
    })()
    return mine
  }
}

// ---- bounded parallelism with a deadline ----

export type Settled<T> = { ok: true; value: T } | { ok: false; reason: 'deadline' | 'error'; error?: unknown }

/**
 * Run `fn` over `items` with at most `limit` in flight. Work not started by the deadline is
 * not started; work in flight at the deadline is abandoned (its signal is aborted).
 * Results come back in input order.
 */
export async function mapBounded<I, T>(items: I[], limit: number, deadline: number, fn: (item: I, signal: AbortSignal) => Promise<T>): Promise<Settled<T>[]> {
  const out: Settled<T>[] = new Array(items.length)
  const ctrl = new AbortController()
  let next = 0
  let finished = false
  const remaining = () => deadline - performance.now()
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length || finished) return
      if (remaining() <= 0) {
        out[i] = { ok: false, reason: 'deadline' }
        continue
      }
      try {
        out[i] = { ok: true, value: await fn(items[i]!, ctrl.signal) }
      } catch (e) {
        out[i] = { ok: false, reason: remaining() <= 0 ? 'deadline' : 'error', error: e }
      }
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort(new DOMException('deadline', 'TimeoutError'))
      resolve()
    }, Math.max(0, remaining()))
  })
  const all = Promise.all(Array.from({ length: Math.max(1, items.length) }, worker))
  await Promise.race([all, stop])
  finished = true
  clearTimeout(timer)
  // A snapshot: work abandoned at the deadline may still settle later and must not change the answer.
  const result = out.slice()
  for (let i = 0; i < items.length; i++) if (result[i] === undefined) result[i] = { ok: false, reason: 'deadline' }
  return result
}
