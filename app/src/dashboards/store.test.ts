import { describe, expect, it } from 'vitest'
import { resolve } from '../../../dashboard/src/index.ts'
import { SEED_DASHBOARDS } from '../../mock/dashboards'
import { createMockApi } from '../../mock/handler'
import { PromApiError, PromClient } from '../api/client'
import { resolveFor } from './model'
import { DashboardStore, NotSent } from './store'

const T1 = Date.UTC(2026, 10, 18, 12, 30) / 1000
const W = { start: T1 - 3 * 3600, end: T1, step: 60 }
const spec = (id: string) => SEED_DASHBOARDS.find((d) => d.spec.metadata.id === id)!.spec
const KEY = 'viz_storeTestKey00000_storeTestSecret000000000000000000000000'

interface Seen {
  url: string
  auth: string | null
  body: string
  signal: AbortSignal | null
}

/**
 * A client over the in-process mock whose requests can be watched, held back and counted.
 * `hold`: a request waits until the test releases it. `deaf`: it ignores its abort signal, so
 * its answer arrives although nobody waits for it (a `fetch` honours the signal; this is the
 * worse case).
 */
function harness(opts: { hold?: boolean; deaf?: boolean } = {}) {
  const api = createMockApi({ requireToken: 'r', dashboardsToken: KEY })
  const seen: Seen[] = []
  const gates: (() => void)[] = []
  let inFlight = 0
  let most = 0
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input)
    const signal = init?.signal ?? null
    seen.push({ url, auth: new Headers(init?.headers).get('authorization'), body: typeof init?.body === 'string' ? init.body : '', signal })
    inFlight++
    most = Math.max(most, inFlight)
    try {
      await new Promise<void>((resolve, reject) => {
        if (!opts.deaf) signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true })
        if (opts.hold) gates.push(resolve)
        else setTimeout(resolve, 1)
      })
      return await api.fetch(input, { ...init, signal: undefined })
    } finally {
      inFlight--
    }
  }
  const client = new PromClient({ token: KEY, fetch: fetchFn })
  return { client, seen, gates, most: () => most, release: () => gates.splice(0).forEach((g) => g()) }
}
const settle = async (store: DashboardStore, tries = 200) => {
  for (let i = 0; i < tries && store.summary().waiting > 0; i++) await new Promise((r) => setTimeout(r, 2))
}

describe('a dashboard\'s panels, loaded through the app\'s client', () => {
  it('twelve panels and fourteen queries: never more than six requests in flight, every panel answered', async () => {
    const h = harness()
    const store = new DashboardStore(h.client)
    const r = resolveFor(spec('services_overview'), {}, W)
    store.load(r, W, 'a')
    expect(store.summary()).toEqual({ total: 12, answered: 0, failed: 0, waiting: 12 })
    await settle(store)
    expect(store.summary()).toEqual({ total: 12, answered: 12, failed: 0, waiting: 0 })
    expect(h.seen).toHaveLength(14)
    expect(h.most()).toBe(6)
    expect(store.limiter.peak).toBe(6)
    expect(store.get('routes').result!.data.route_rate!.length).toBe(12)
    expect(store.get('routes').result!.window).toEqual(W)
  })

  it('the key goes in the Authorization header of every request and in no URL or body', async () => {
    const h = harness()
    const store = new DashboardStore(h.client)
    store.load(resolveFor(spec('service_red'), { service: 'orders' }, W), W, 'a')
    await settle(store)
    await h.client.dashboards({ q: 'check', tag: 'on-call', limit: 200 })
    await h.client.dashboard('service_red')
    expect(h.seen.length).toBeGreaterThan(6)
    for (const s of h.seen) {
      expect(s.auth).toBe(`Bearer ${KEY}`)
      expect(s.url).not.toContain('viz_')
      expect(s.url).not.toContain('Secret')
      expect(s.body).not.toContain('viz_storeTestKey')
    }
    expect(h.seen.map((s) => s.url)).toContain('/api/v1/control/dashboards?q=check&tag=on-call&limit=200')
    expect(h.seen.map((s) => s.url)).toContain('/api/v1/control/dashboards/service_red')
  })

  it('one panel\'s refused query is that panel\'s error; the other five panels are answered', async () => {
    const h = harness()
    const store = new DashboardStore(h.client)
    const r = resolveFor(spec('pod_capacity'), {}, W)
    store.load(r, W, 'a')
    await settle(store)
    expect(store.summary()).toEqual({ total: 6, answered: 5, failed: 1, waiting: 0 })
    const failed = store.get('sample')
    expect(failed.error).toBeInstanceOf(PromApiError)
    expect(failed.error).toMatchObject({ status: 422, errorType: 'unsupported' })
    expect(failed.result).toBeNull()
    for (const id of ['cpu', 'memory', 'durations', 'restarts', 'notes']) expect(store.get(id), id).toMatchObject({ error: null, waiting: false, stale: false })
    expect(store.get('cpu').result!.data.cpu).toHaveLength(12)
    // Matched nothing: an answer, not an error.
    expect(store.get('restarts').result!.data.restarts).toEqual([])
    // A text note asks nothing and is answered at once.
    expect(store.get('notes').result!.data).toEqual({})
  })

  it('a query the model could not write is not sent, and fails its panel only', async () => {
    const h = harness()
    const store = new DashboardStore(h.client)
    const base = spec('service_red')
    const broken = { ...base, queries: { ...base.queries, cpu: { lang: 'promql' as const, expr: 'topk($service, pod_cpu_usage_cores)' }, by_status: { lang: 'logql' as const, expr: '{app="x"}' } } }
    const r = resolve(broken, { variables: { service: 'not a number' } })
    expect(r.queries.cpu!.error).toBeDefined()
    store.load(r, W, 'a')
    await settle(store)
    expect(store.get('cpu').error).toBeInstanceOf(NotSent)
    expect(store.get('statuses').error).toBeInstanceOf(NotSent)
    expect((store.get('statuses').error as Error).message).toContain('logql')
    expect(store.get('rate').error).toBeNull()
    expect(h.seen.some((s) => s.body.includes('topk') || s.body.includes('app%3D'))).toBe(false)
  })

  it('a superseded answer is never put into a panel: the range changed while the first answers were on their way', async () => {
    const h = harness({ hold: true, deaf: true })
    const store = new DashboardStore(h.client)
    const r = resolveFor(spec('checkout_path'), {}, W)
    // Two panels, so that both ranges' requests fit in the six (a request that ignores its abort keeps its place until it ends).
    const two = { ...r, panels: { 'orders.rate': r.panels['orders.rate']!, 'orders.latency': r.panels['orders.latency']! }, order: ['orders.rate', 'orders.latency'] }
    store.load(two, W, 'range A')
    await new Promise((res) => setTimeout(res, 5))
    const first = h.gates.splice(0)
    expect(first).toHaveLength(2)
    const W2 = { start: W.start + 3600, end: W.end + 3600, step: 60 }
    store.load(two, W2, 'range B')
    // The requests of range A were told to stop.
    expect(h.seen.slice(0, 2).every((s) => s.signal?.aborted)).toBe(true)
    await new Promise((res) => setTimeout(res, 5))
    // Range B answers first; range A's answers arrive after it.
    h.release()
    await settle(store)
    first.forEach((g) => g())
    await new Promise((res) => setTimeout(res, 20))
    for (const id of two.order) {
      const s = store.get(id)
      expect(s.result!.window, id).toEqual(W2)
      expect(s).toMatchObject({ waiting: false, stale: false, error: null })
    }
    expect(store.summary()).toEqual({ total: 2, answered: 2, failed: 0, waiting: 0 })
    // And the other order: range A's answers arrive first, while range B still waits. Nothing of A is drawn as B's.
    const h2 = harness({ hold: true, deaf: true })
    const store2 = new DashboardStore(h2.client)
    store2.load(two, W, 'range A')
    await new Promise((res) => setTimeout(res, 5))
    const stale = h2.gates.splice(0)
    store2.load(two, W2, 'range B')
    await new Promise((res) => setTimeout(res, 5))
    stale.forEach((g) => g())
    await new Promise((res) => setTimeout(res, 20))
    expect(store2.get('orders.rate')).toMatchObject({ waiting: true, result: null })
    h2.release()
    await settle(store2)
    expect(store2.get('orders.rate').result!.window).toEqual(W2)
  })

  it('while a new range waits, the answer drawn stays and is marked as the earlier range\'s; a refresh of the same range is not', async () => {
    const h = harness({ hold: true })
    const store = new DashboardStore(h.client)
    const r = resolveFor(spec('checkout_path'), {}, W)
    store.load(r, W, 'range A')
    await new Promise((res) => setTimeout(res, 5))
    h.release()
    await settle(store)
    store.load(r, W, 'range A')
    expect(store.get('orders.rate')).toMatchObject({ waiting: true, stale: false })
    const W2 = { start: W.start + 3600, end: W.end + 3600, step: 60 }
    store.load(resolveFor(spec('checkout_path'), {}, W2), W2, 'range B')
    const waiting = store.get('orders.rate')
    expect(waiting).toMatchObject({ waiting: true, stale: true })
    expect(waiting.result!.window).toEqual(W)
    await new Promise((res) => setTimeout(res, 5))
    h.release()
    await settle(store)
    expect(store.get('orders.rate')).toMatchObject({ waiting: false, stale: false })
    expect(store.get('orders.rate').result!.window).toEqual(W2)
  })

  it('leaving the view aborts every request in flight, sends none of the waiting ones, and nothing is delivered afterwards', async () => {
    const h = harness({ hold: true })
    const store = new DashboardStore(h.client)
    store.load(resolveFor(spec('services_overview'), {}, W), W, 'a')
    await new Promise((res) => setTimeout(res, 5))
    expect(h.seen).toHaveLength(6)
    store.dispose()
    expect(h.seen.every((s) => s.signal?.aborted)).toBe(true)
    h.release()
    await new Promise((res) => setTimeout(res, 20))
    expect(h.seen).toHaveLength(6)
    expect(store.summary().answered).toBe(0)
    expect(store.get('requests').result).toBeNull()
  })

  it('Cancel ends one panel\'s wait and no other\'s; running it again answers it', async () => {
    const h = harness({ hold: true })
    const store = new DashboardStore(h.client)
    store.load(resolveFor(spec('checkout_path'), {}, W), W, 'a')
    await new Promise((res) => setTimeout(res, 5))
    store.cancelPanel('checkout.rate')
    await new Promise((res) => setTimeout(res, 5))
    expect(store.get('checkout.rate')).toMatchObject({ waiting: false, halted: 'cancelled', error: null })
    expect(store.get('orders.rate').waiting).toBe(true)
    h.release()
    await settle(store)
    expect(store.summary()).toEqual({ total: 4, answered: 3, failed: 1, waiting: 0 })
    store.reload('checkout.rate')
    await new Promise((res) => setTimeout(res, 5))
    h.release()
    await settle(store)
    expect(store.get('checkout.rate')).toMatchObject({ halted: null, error: null })
    expect(store.get('checkout.rate').result).not.toBeNull()
  })
})
