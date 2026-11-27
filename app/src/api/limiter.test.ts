import { describe, expect, it } from 'vitest'
import { PromClient, REQUESTS } from './client'

const body = JSON.stringify({ status: 'success', data: { version: 'x' } })
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('every request of the page goes through one limiter of six (api/client.ts REQUESTS)', () => {
  it('ten requests from two clients: six are sent, the rest when one has been answered and read', async () => {
    const gates: (() => void)[] = []
    let sent = 0
    const fetchFn: typeof fetch = async () => {
      sent++
      await new Promise<void>((r) => gates.push(r))
      return new Response(body, { status: 200 })
    }
    const a = new PromClient({ fetch: fetchFn, token: 'viz_a_b' })
    const b = new PromClient({ fetch: fetchFn })
    const all = [...Array.from({ length: 5 }, () => a.buildInfo()), ...Array.from({ length: 3 }, () => b.labels()), a.whoami().catch(() => null), b.dashboards().catch(() => null)]
    await tick()
    expect(sent).toBe(6)
    expect(REQUESTS.inFlight).toBe(6)
    expect(REQUESTS.queued).toBe(4)
    gates.shift()!()
    await tick()
    await tick()
    expect(sent).toBe(7)
    while (gates.length) {
      gates.shift()!()
      await tick()
      await tick()
    }
    await Promise.all(all)
    expect(sent).toBe(10)
    expect(REQUESTS.inFlight).toBe(0)
    expect(REQUESTS.peak).toBe(6)
  })

  it('a request cancelled while it waits for its turn is never sent', async () => {
    const gates: (() => void)[] = []
    const urls: string[] = []
    const fetchFn: typeof fetch = async (input) => {
      urls.push(String(input))
      await new Promise<void>((r) => gates.push(r))
      return new Response(body, { status: 200 })
    }
    const client = new PromClient({ fetch: fetchFn })
    const first = Array.from({ length: 6 }, () => client.buildInfo())
    const controller = new AbortController()
    const waiting = client.queryRangeMatrix('up', 0, 60, 15, { signal: controller.signal }).catch((e: Error) => e.name)
    await tick()
    controller.abort()
    expect(await waiting).toBe('AbortError')
    gates.splice(0).forEach((g) => g())
    await Promise.all(first)
    await tick()
    expect(urls.filter((u) => u.includes('query_range'))).toEqual([])
    expect(REQUESTS.inFlight).toBe(0)
  })
})
