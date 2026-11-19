import { describe, expect, it } from 'vitest'
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
