import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { RECORDED_SAMPLES_CALLERS, RECORDED_SAMPLES_ENTRYPOINT, RECORDED_SAMPLES_REFUSALS } from '../../contracts/ingest'
import type { SampleBatch } from '../../contracts/rules'
import type { PoolMap } from '../../shard/src/pool'
import { clearCaches } from '../src/index'
import * as main from '../src/index'
import { parsePromValue, writeRecorded } from '../src/recorded'
import { bitsOf, canon, newTenant, refSeriesId, setPool, shardStub, tail } from './helpers'

/**
 * The recorded-samples entrypoint (contracts/ingest.ts), called the way the ruler will call
 * it: through a service binding that names the entrypoint and carries `props.caller`
 * (wrangler.jsonc binds this script to itself three times: as the ruler, as viz-mcp, and
 * without props).
 */

async function tenantWithPool(slots = 2) {
  const tenant = newTenant('rec')
  const map: PoolMap = { pool: `rec/${tenant}`, slots, spread: slots, epoch: 1 }
  await setPool(tenant, map)
  clearCaches()
  return { tenant, map }
}

const now = Date.now()
const batch = (tenant: string, rule: string, samples: SampleBatch['samples'], at = now): SampleBatch => ({ id: `${tenant}/0/g/${rule}@${at}`, samples })

/** A rejection's message, or null if the call resolved. Errors cross the binding as values here. */
async function refusalOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

const expected = (samples: { labels: Record<string, string>; timeMs: number; value: number }[]) =>
  canon(samples.map((s) => ({ labels: Object.fromEntries(Object.entries(s.labels).filter(([, v]) => v !== '')), ts: s.timeMs, bits: bitsOf(s.value) })))

describe('recorded samples over a service binding (contracts/ingest.ts)', () => {
  it('the ingest script exports the entrypoint the contract names, and only the ruler is an allowed caller', () => {
    expect(RECORDED_SAMPLES_ENTRYPOINT in main).toBe(true)
    expect([...RECORDED_SAMPLES_CALLERS]).toEqual(['viz-ruler'])
  })

  it('writes what the ruler recorded, exactly: values in Prometheus text form, labels canonical, series ids per the contract', async () => {
    const { tenant, map } = await tenantWithPool()
    const batches = [
      batch(tenant, 'r1', [
        { labels: { job: 'api', __name__: 'job:up:sum', instance: 'a:1' }, timeMs: now, value: '1.5' },
        { labels: { __name__: 'job:up:sum', job: 'db', instance: 'b:1', empty: '' }, timeMs: now, value: '+Inf' },
        { labels: { __name__: 'job:up:sum', job: 'web', instance: 'c:1' }, timeMs: now, value: '-Inf' },
      ]),
      batch(tenant, 'r2', [
        { labels: { __name__: 'ratio', job: 'api', instance: 'a:1' }, timeMs: now - 1000, value: 'NaN' },
        { labels: { __name__: 'ratio', job: 'api', instance: 'a:1' }, timeMs: now, value: '-0' },
        { labels: { __name__: 'ratio', job: 'db', instance: 'b:1' }, timeMs: now, value: '1e3' },
        { labels: { __name__: 'ratio', job: 'web', instance: 'c:1' }, timeMs: now, value: 'Inf' },
      ]),
    ]
    expect(await env.RULER_SINK.write(tenant, batches)).toBeUndefined()
    const stored = await tail(map, tenant)
    const values = [1.5, Infinity, -Infinity, NaN, -0, 1000, Infinity]
    const sent = batches.flatMap((b) => b.samples).map((s, i) => ({ labels: s.labels, timeMs: s.timeMs, value: values[i]! }))
    expect(canon(stored)).toEqual(expected(sent))
    for (const s of stored) expect(s.id).toBe(refSeriesId(Object.entries(s.labels).sort(([a], [b]) => (Buffer.compare(Buffer.from(a), Buffer.from(b))))))
    // Sent again (the ruler's at-least-once retry): the same batch bytes, stored once.
    await env.RULER_SINK.write(tenant, batches)
    expect(canon(await tail(map, tenant))).toEqual(canon(stored))
  })

  it('refuses a binding that does not name the ruler, and writes nothing', async () => {
    const { tenant, map } = await tenantWithPool()
    const b = [batch(tenant, 'r', [{ labels: { __name__: 'x' }, timeMs: now, value: '1' }])]
    expect(await refusalOf(env.MCP_SINK.write(tenant, b))).toMatch(/^unauthorized: /)
    expect(await refusalOf(env.BARE_SINK.write(tenant, b))).toMatch(/^unauthorized: /)
    expect(await tail(map, tenant)).toEqual([])
  })

  it('takes the tenant only from its argument, validated: a bad tenant id, or a batch of another tenant, writes nothing', async () => {
    const a = await tenantWithPool()
    const b = await tenantWithPool()
    const ok = (t: string) => batch(t, 'r', [{ labels: { __name__: 'x', job: 'j' }, timeMs: now, value: '1' }])
    for (const bad of ['', 'a/b', 'x'.repeat(65), 'a b', '../x']) expect(await refusalOf(env.RULER_SINK.write(bad, [ok(bad)])), JSON.stringify(bad)).toMatch(/^invalid: tenant id/)
    expect(await refusalOf(env.RULER_SINK.write(42 as unknown as string, [ok(a.tenant)]))).toMatch(/^invalid: tenant id/)
    // B's batch in A's call (and a batch whose id only starts with A's name).
    expect(await refusalOf(env.RULER_SINK.write(a.tenant, [ok(a.tenant), ok(b.tenant)]))).toMatch(/^invalid: batch .* is not one of tenant/)
    expect(await refusalOf(env.RULER_SINK.write(a.tenant, [{ id: `${a.tenant}x/0/g/r@1`, samples: ok(a.tenant).samples }]))).toMatch(/^invalid: /)
    expect(await refusalOf(env.RULER_SINK.write(a.tenant, [{ id: undefined as unknown as string, samples: ok(a.tenant).samples }]))).toMatch(/^invalid: /)
    expect(await tail(a.map, a.tenant)).toEqual([])
    expect(await tail(b.map, b.tenant)).toEqual([])
  })

  it('a call with any sample the HTTP API would reject writes nothing at all', async () => {
    const { tenant, map } = await tenantWithPool()
    const good = batch(tenant, 'good', [{ labels: { __name__: 'x', job: 'j' }, timeMs: now, value: '2' }])
    const cases: [string, SampleBatch['samples'][number]][] = [
      ['not a value', { labels: { __name__: 'x' }, timeMs: now, value: 'abc' }],
      ['hex is not Prometheus text', { labels: { __name__: 'x' }, timeMs: now, value: '0x10' }],
      ['empty value', { labels: { __name__: 'x' }, timeMs: now, value: '' }],
      ['no __name__', { labels: { job: 'j' }, timeMs: now, value: '1' }],
      ['older than the accept window', { labels: { __name__: 'x' }, timeMs: now - 2 * 3_600_000, value: '1' }],
      ['too far ahead', { labels: { __name__: 'x' }, timeMs: now + 3_600_000, value: '1' }],
      ['fractional time', { labels: { __name__: 'x' }, timeMs: now + 0.5, value: '1' }],
      ['NUL in a label', { labels: { __name__: 'x', a: 'b\u0000c' }, timeMs: now, value: '1' }],
      ['a label value that is not a string', { labels: { __name__: 'x', a: 1 as unknown as string }, timeMs: now, value: '1' }],
    ]
    for (const [why, sample] of cases) {
      expect(await refusalOf(env.RULER_SINK.write(tenant, [good, batch(tenant, 'bad', [sample])])), why).toMatch(/^invalid: .*nothing was written/)
    }
    expect(await tail(map, tenant)).toEqual([])
  })

  it('a full shard buffer is a retryable refusal, never a success; the same call succeeds once there is room', async () => {
    const { tenant, map } = await tenantWithPool(1)
    const b = [batch(tenant, 'r', [{ labels: { __name__: 'x', job: 'j' }, timeMs: now, value: '3' }])]
    await shardStub(map, 0).configure({ tenantMaxBytes: 16 })
    try {
      expect(await refusalOf(env.RULER_SINK.write(tenant, b))).toMatch(/^backpressure: /)
      expect(await tail(map, tenant)).toEqual([])
    } finally {
      await shardStub(map, 0).configure({ tenantMaxBytes: 64 << 20 })
    }
    expect(await refusalOf(env.RULER_SINK.write(tenant, b))).toBeNull()
    expect(await tail(map, tenant)).toHaveLength(1)
  })

  it('new series over the tenant\'s active-series limit are refused (series_limit), the existing ones written', async () => {
    const { tenant, map } = await tenantWithPool(1)
    await env.CONFIG.put(`limits:${tenant}`, JSON.stringify({ active_series: 2 }))
    clearCaches()
    const s = (i: number, at = now) => ({ labels: { __name__: 'x', job: 'j', n: String(i) }, timeMs: at, value: String(i) })
    expect(await refusalOf(env.RULER_SINK.write(tenant, [batch(tenant, 'r', [s(0), s(1)])]))).toBeNull()
    // The next tick: the two series the tenant has, and one new one.
    expect(await refusalOf(env.RULER_SINK.write(tenant, [batch(tenant, 'r', [s(0, now + 1), s(1, now + 1), s(2, now + 1)], now + 1)]))).toMatch(/^series_limit: .*1 new series/)
    expect((await tail(map, tenant)).map((x) => x.labels.n).sort()).toEqual(['0', '0', '1', '1'])
  })

  it('every refusal word is one the contract lists; nothing to write resolves', async () => {
    const { tenant } = await tenantWithPool()
    const msgs = [
      await refusalOf(writeRecorded(env, 'viz-mcp', tenant, [])),
      await refusalOf(writeRecorded(env, 'viz-ruler', 'a/b', [])),
      await refusalOf(writeRecorded(env, 'viz-ruler', tenant, 'not a list')),
      await refusalOf(writeRecorded({ ...env, INGEST_LIMITS: '{"maxSamples":1}' }, 'viz-ruler', tenant, [batch(tenant, 'r', [{ labels: { __name__: 'x' }, timeMs: now, value: '1' }, { labels: { __name__: 'y' }, timeMs: now, value: '1' }])])),
    ]
    expect(msgs.map((m) => m?.split(':')[0])).toEqual(['unauthorized', 'invalid', 'invalid', 'too_large'])
    for (const m of msgs) expect(RECORDED_SAMPLES_REFUSALS as readonly string[]).toContain(m!.split(':')[0])
    expect(await refusalOf(writeRecorded(env, 'viz-ruler', tenant, []))).toBeNull()
    expect(await refusalOf(writeRecorded(env, 'viz-ruler', tenant, [batch(tenant, 'r', [])]))).toBeNull()
  })

  it('parses exactly Prometheus\' text form of a value', () => {
    expect(parsePromValue('1')).toBe(1)
    expect(parsePromValue('-2.5e-3')).toBe(-0.0025)
    expect(parsePromValue('.5')).toBe(0.5)
    expect(Object.is(parsePromValue('-0'), -0)).toBe(true)
    expect(parsePromValue('+Inf')).toBe(Infinity)
    expect(parsePromValue('Inf')).toBe(Infinity)
    expect(parsePromValue('-Inf')).toBe(-Infinity)
    expect(Number.isNaN(parsePromValue('NaN'))).toBe(true)
    for (const bad of ['', ' 1', '1 ', '0x10', '1_000', 'nan', 'inf', 'Infinity', '1e', '--1', undefined, 1]) expect(parsePromValue(bad), String(bad)).toBeNull()
  })
})
