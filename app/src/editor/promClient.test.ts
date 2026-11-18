import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromClient } from '../api/client'
import { completionClient } from './promClient'

/** A stand-in for the API client that records each lookup and lets the test answer it. */
function fakeClient() {
  const calls: { kind: string; arg: string; signal?: AbortSignal; resolve: (v: string[]) => void }[] = []
  const lookup = (kind: string, arg: string, signal?: AbortSignal) =>
    new Promise<string[]>((resolve, reject) => {
      calls.push({ kind, arg, signal, resolve })
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
  const client = {
    labels: (p: { match?: string[] }, o?: { signal?: AbortSignal }) => lookup('labels', p.match?.[0] ?? '', o?.signal),
    labelValues: (name: string, p: { match?: string[] } = {}, o?: { signal?: AbortSignal }) => lookup('values', `${name}|${p.match?.[0] ?? ''}`, o?.signal),
    series: () => Promise.resolve([]),
    metadata: () => Promise.resolve({}),
  } as unknown as PromClient
  return { client, calls }
}

describe('autocomplete lookups are debounced and cancelled (B3)', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('sends nothing until the debounce has passed, and only the newest lookup of a kind', async () => {
    const { client, calls } = fakeClient()
    const c = completionClient(client, { debounceMs: 150 })
    const a = c.labelNames('http_r')
    const b = c.labelNames('http_re')
    const d = c.labelNames('http_requests_total')
    await vi.advanceTimersByTimeAsync(149)
    expect(calls.length).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.map((x) => x.arg)).toEqual(['http_requests_total'])
    // The replaced lookups answer at once with nothing, and are not cached.
    expect(await a).toEqual([])
    expect(await b).toEqual([])
    calls[0]!.resolve(['service', 'route'])
    expect(await d).toEqual(['service', 'route'])
  })
  it('aborts a lookup in flight when a newer one of the same kind arrives', async () => {
    const { client, calls } = fakeClient()
    const c = completionClient(client, { debounceMs: 150 })
    const first = c.labelValues('service', 'a_total')
    await vi.advanceTimersByTimeAsync(150)
    expect(calls.length).toBe(1)
    expect(calls[0]!.signal!.aborted).toBe(false)
    const second = c.labelValues('route', 'a_total')
    expect(calls[0]!.signal!.aborted).toBe(true)
    expect(await first).toEqual([])
    await vi.advanceTimersByTimeAsync(150)
    calls[1]!.resolve(['/cart'])
    expect(await second).toEqual(['/cart'])
  })
  it('caches an answer, and asks again for one that was replaced', async () => {
    const { client, calls } = fakeClient()
    const c = completionClient(client, { debounceMs: 150 })
    const p = c.labelNames('m')
    await vi.advanceTimersByTimeAsync(150)
    calls[0]!.resolve(['x'])
    expect(await p).toEqual(['x'])
    expect(await c.labelNames('m')).toEqual(['x'])
    expect(calls.length).toBe(1)
    void c.labelNames('n') // replaced before it is sent
    const again = c.labelNames('m') // cached: does not disturb the pending lookup
    expect(await again).toEqual(['x'])
    const n2 = c.labelNames('n')
    await vi.advanceTimersByTimeAsync(150)
    expect(calls.map((x) => x.arg)).toEqual(['m', 'n'])
    calls[1]!.resolve(['y'])
    expect(await n2).toEqual(['y'])
  })
  it('lookups of different kinds do not cancel each other', async () => {
    const { client, calls } = fakeClient()
    const c = completionClient(client, { debounceMs: 150 })
    void c.labelNames('m')
    void c.labelValues('service', 'm')
    await vi.advanceTimersByTimeAsync(150)
    expect(calls.map((x) => x.kind).sort()).toEqual(['labels', 'values'])
  })
})
