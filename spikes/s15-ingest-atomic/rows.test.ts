/**
 * Rows written per request, before and after D77, in the Workers test runtime (local workerd):
 * "measured here". Not part of any suite: copy it into `edge/test/` of each tree, run it alone
 * (`npx vitest run test/rows.test.ts`), and delete it.
 *
 * Every `sql.exec` of both span shards of a tenant is wrapped to sum its cursor's `rowsWritten`
 * (Cloudflare bills SQLite rows written; workerd counts them the same way, not verified against
 * Cloudflare's bill here). Shapes: one realistic 8,200-span body (S10's generator, protobuf, gzip:
 * two shards, several batches) accepted; the same shape refused (one shard full); and a retry of
 * the accepted body (all duplicates).
 */
import { runInDurableObject } from 'cloudflare:test'
import { expect, it } from 'vitest'
import { type PoolMap } from '../../shard/src/pool'
import { clearCaches } from '../src/index'
import { makeKey, newTenant, setPool, shardStub } from './helpers'
import { postSignal, signalPool } from './otelhelpers'
// @ts-expect-error plain JS
import { lcg32, realisticTraces, tracesProto } from '../../spikes/s10-signals-trial/load/bodies.mjs'

declare global {
  // eslint-disable-next-line no-var
  var __rows: Record<string, number> | undefined
}

async function gzip(b: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
}

async function instrument(map: PoolMap, slot: number): Promise<void> {
  await runInDurableObject(shardStub(map, slot), (_i, state) => {
    const sql = state.storage.sql as unknown as { exec: (...a: unknown[]) => { rowsWritten: number }; __wrapped?: boolean }
    if (sql.__wrapped) return
    sql.__wrapped = true
    const real = sql.exec.bind(sql)
    const name = `${map.pool}/${slot}`
    sql.exec = (...a: unknown[]) => {
      const c = real(...a)
      globalThis.__rows ??= {}
      globalThis.__rows[name] = (globalThis.__rows[name] ?? 0) + c.rowsWritten
      return c
    }
  })
}
const written = async (map: PoolMap): Promise<number> => {
  let n = 0
  for (const slot of [0, 1]) n += await runInDurableObject(shardStub(map, slot), () => globalThis.__rows?.[`${map.pool}/${slot}`] ?? 0)
  return n
}

it('rows written per request', async () => {
  const out: Record<string, number> = {}
  for (const shape of ['accepted', 'retry of accepted', 'refused (one shard full)']) {
    const t = newTenant('rows')
    const key = await makeKey(t)
    const map: PoolMap = { pool: `rows/${t}`, slots: 2, spread: 2, epoch: 1 }
    await setPool(t, map)
    clearCaches()
    const spans = signalPool(map, 'traces')
    // Create both streams first (their stream rows are not this request's cost), then count.
    for (const slot of [0, 1]) await shardStub(spans, slot).configure({})
    const body = await gzip(tracesProto(realisticTraces(lcg32(7), BigInt(Date.now()) * 1_000_000n, 8200)))
    if (shape === 'retry of accepted') expect((await postSignal('/v1/traces', key, body, 'application/x-protobuf', { headers: { 'Content-Encoding': 'gzip' } })).status).toBe(200)
    if (shape.startsWith('refused')) await shardStub(spans, 1).configure({ tenantMaxBytes: 1 })
    for (const slot of [0, 1]) await instrument(spans, slot)
    const before = await written(spans)
    const res = await postSignal('/v1/traces', key, body, 'application/x-protobuf', { headers: { 'Content-Encoding': 'gzip' } })
    expect(res.status).toBe(shape.startsWith('refused') ? 429 : 200)
    out[shape] = (await written(spans)) - before
  }
  console.log(`ROWS ${JSON.stringify(out)}`)
}, 120_000)
