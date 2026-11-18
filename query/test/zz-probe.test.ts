import { beforeAll, describe, expect, it } from 'vitest'
import { hooks } from '../src/coordinator'
import { QUERIES, type World, expected, ingest, run, world, flushAll } from './world'

describe('probe', () => {
  let w: World
  beforeAll(async () => {
    w = await world()
    await ingest(w)
    await flushAll(w)
  })
  it('split', async () => {
    for (const L of [1, 2, 7]) {
      hooks.forceLeaves = L
      for (const id of ['rate-sum-by', 'i-rate-sum-by', 'sum', 'stddev', 'topk', 'bin-ratio']) {
        const q = QUERIES.find((x) => x.id === id)!
        const res = await run(w.a.key, q)
        const body = await res.text()
        console.log(L, id, res.status, res.headers.get('X-Viz-Execution'), res.headers.get('X-Viz-Split-Leaves'), res.headers.get('X-Viz-Reader-Calls'), body.slice(0, 200))
        expect(JSON.parse(body)).toEqual(expected.a[id])
      }
    }
    hooks.forceLeaves = undefined
  })
})
