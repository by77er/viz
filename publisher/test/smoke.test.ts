import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import worker from '../src/index'
import { addUnit, expectVerified, fresh, icebergLive, liveKeys, mirror, pairUnit, publisher } from './helpers'

describe('smoke', () => {
  it('publishes a tenant and verifies', async () => {
    const { cell, tenant } = fresh()
    const a = tenant('a')
    await addUnit(a, pairUnit(cell, a, 1, 1))
    await mirror(a, cell)
    const p = publisher(cell)
    const r = await p.publish()
    expect(r.tables.metric_samples.added).toBe(1)
    expect(await icebergLive(cell, 'metric_samples')).toEqual(await liveKeys(a, 'metric_samples'))
    await expectVerified(p)
  })
})

describe('the Worker (src/index.ts)', () => {
  it('answers GET /healthz with 200 when bound, 503 naming a missing binding, and nothing else', async () => {
    const get = (path: string, e: object, method = 'GET') => worker.fetch!(new Request(`https://publisher.internal${path}`, { method }) as never, e as never, {} as never) as Promise<Response>
    const bound = { PUBLISHER: env.PUBLISHER, BUCKET: env.BUCKET }
    const ok = await get('/healthz', bound)
    expect([ok.status, await ok.text()]).toEqual([200, 'ok\n'])
    expect((await get('/healthz', bound, 'HEAD')).status).toBe(200)
    const missing = await get('/healthz', { PUBLISHER: env.PUBLISHER })
    expect([missing.status, await missing.text()]).toEqual([503, 'misconfigured: no BUCKET binding\n'])
    expect((await get('/healthz', bound, 'POST')).status).toBe(405)
    expect((await get('/', bound)).status).toBe(404)
    expect((await get('/publish', bound)).status).toBe(404)
  })
})
