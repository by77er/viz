import { describe, expect, it } from 'vitest'
import { type PoolMap, slotFor, tenantSlots } from '../../shard/src/pool'
import { MAX_BATCH_BYTES } from '../../shard/src/shard'
import { fnv1a64, seriesIdInput } from '../src/batch'
import { CONTRACT, DEFAULT_LIMITS, limitsFrom } from '../src/limits'
import { DEFAULT_MAP, type PrwSeries, bitsOf, canon, makeKey, newTenant, otlpProto, postOtlp, postWrite, setPool, shardStub, tail, tailOfSlot } from './helpers'

/** Tests for the rules contracts/BATCH.md gained in v2. */

const te = new TextEncoder()
const cmpUtf8 = (a: string, b: string): number => {
  const x = te.encode(a)
  const y = te.encode(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return x.length - y.length
}
const sentCanon = (series: PrwSeries[]) =>
  canon(series.flatMap((s) => s.samples.map((x) => ({ labels: Object.fromEntries(s.labels), ts: x.ts, bits: bitsOf(x.value as number) }))))

describe('label rules', () => {
  it('sorts label names in UTF-8 byte order, not JavaScript string order (astral-plane name)', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const now = Date.now()
    // U+FFFF is EF BF BF in UTF-8; U+10000 is F0 90 80 80. In UTF-16 the astral character is
    // the surrogate pair D800 DC00, which sorts BEFORE FFFF: the two orders disagree.
    const BMP = '￿'
    const ASTRAL = '\u{10000}'
    expect([BMP, ASTRAL].sort()).toEqual([ASTRAL, BMP]) // JavaScript's default order
    expect([BMP, ASTRAL].sort(cmpUtf8)).toEqual([BMP, ASTRAL]) // the contract's order
    const labels: [string, string][] = [['__name__', 'm'], [ASTRAL, 'astral'], [BMP, 'bmp'], ['a', '1']]
    const res = await postWrite(key, [
      { labels, samples: [{ ts: now, value: 1 }] },
      { labels: [...labels].reverse(), samples: [{ ts: now + 1, value: 2 }] }, // same series, other order
    ])
    expect(res.status).toBe(204)
    const stored = await Promise.all(tenantSlots(DEFAULT_MAP, tenant).map((slot) => tailOfSlot(DEFAULT_MAP, slot, tenant)))
    const entries = stored.flatMap((s) => s.batches.flatMap((b) => b.series))
    expect(entries).toHaveLength(1) // both senders' orders are one series
    expect(entries[0]!.labels.map(([n]) => n)).toEqual(['__name__', 'a', BMP, ASTRAL])
    const sorted = [...labels].sort((x, y) => cmpUtf8(x[0], y[0]))
    expect(entries[0]!.id).toBe(fnv1a64(seriesIdInput(sorted)))
    // The id a JavaScript-order sort would have produced is a different number.
    expect(entries[0]!.id).not.toBe(fnv1a64(seriesIdInput([...labels].sort((x, y) => (x[0] < y[0] ? -1 : 1)))))
    expect(stored.flatMap((s) => s.samples)).toHaveLength(2)
  })

  it('applies the contract label limits by default: 128 labels, 1,024-byte names, 8,192-byte values', async () => {
    expect(DEFAULT_LIMITS).toMatchObject({ maxLabelsPerSeries: 128, maxLabelNameBytes: 1024, maxLabelValueBytes: 8192 })
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const now = Date.now()
    const withLabels = (n: number): PrwSeries => ({
      labels: [['__name__', `m${n}`], ...Array.from({ length: n - 1 }, (_, i) => [`l${String(i).padStart(3, '0')}`, 'v'] as [string, string])],
      samples: [{ ts: now, value: n }],
    })
    const one = (name: string, value: string, id: string): PrwSeries => ({ labels: [['__name__', id], [name, value]], samples: [{ ts: now, value: 1 }] })
    const ok = [withLabels(128), one('n'.repeat(1024), 'v', 'name_at_limit'), one('k', 'v'.repeat(8192), 'value_at_limit'), one('é'.repeat(512), 'v', 'name_utf8_at_limit')]
    expect((await postWrite(key, ok)).status).toBe(204)
    expect(canon(await tail(DEFAULT_MAP, tenant))).toEqual(sentCanon(ok))

    for (const [series, reason] of [
      [withLabels(129), 'too many labels'],
      [one('n'.repeat(1025), 'v', 'x'), 'label name too long'],
      [one('k', 'v'.repeat(8193), 'x'), 'label value too long'],
      [one('é'.repeat(513), 'v', 'x'), 'label name too long'], // 1,026 bytes: the limit is bytes, not characters
      [one('k', 'a\u0000b', 'x'), 'invalid label'],
      [one('a\u0000b', 'v', 'x'), 'invalid label'],
    ] as [PrwSeries, string][]) {
      // INGEST_LIMITS cannot loosen a contract limit.
      const res = await postWrite(key, [series], { env: { INGEST_LIMITS: JSON.stringify({ maxLabelsPerSeries: 9999, maxLabelNameBytes: 60000, maxLabelValueBytes: 60000 }) } })
      expect(res.status).toBe(400)
      expect(await res.text()).toContain(reason)
    }
    // An empty-valued label does not count towards the 128.
    const padded = withLabels(128)
    padded.labels[0] = ['__name__', 'with_empties']
    padded.labels.push(['zz_empty', ''], ['zz_empty2', ''])
    expect((await postWrite(key, [padded])).status).toBe(204)
    expect((await tail(DEFAULT_MAP, tenant)).length).toBe(ok.length + 1)
  })

  it('rejects a label set that could not fit one batch, instead of sending a batch over the cap', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const now = Date.now()
    // 128 labels with 8,192-byte values: with 104-byte names one series table entry is 1,054,112 bytes, over 1 MiB.
    const huge: PrwSeries = {
      labels: [['__name__', 'huge'], ...Array.from({ length: 127 }, (_, i) => [`l${String(i).padStart(3, '0')}${'n'.repeat(100)}`, String.fromCharCode(97 + (i % 26)).repeat(8192)] as [string, string])],
      samples: [{ ts: now, value: 1 }],
    }
    const small: PrwSeries = { labels: [['__name__', 'small']], samples: [{ ts: now, value: 2 }] }
    const res = await postWrite(key, [huge, small])
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('1 label set too large to fit one batch')
    expect(canon(await tail(DEFAULT_MAP, tenant))).toEqual(sentCanon([small]))
  })
})

describe('batch size cap', () => {
  it('uses the one constant the shard enforces, and INGEST_LIMITS cannot raise it', () => {
    expect(MAX_BATCH_BYTES).toBe(1_048_576)
    expect(CONTRACT.maxBatchBytes).toBe(MAX_BATCH_BYTES)
    expect(DEFAULT_LIMITS.maxBatchBytes).toBe(MAX_BATCH_BYTES)
    expect(limitsFrom(JSON.stringify({ maxBatchBytes: 5_000_000 })).maxBatchBytes).toBe(MAX_BATCH_BYTES)
    expect(limitsFrom(JSON.stringify({ maxBatchBytes: 4096 })).maxBatchBytes).toBe(4096)
  })

  async function oneSlot() {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const map: PoolMap = { pool: `cap/${tenant}`, slots: 1, spread: 1, epoch: 1 }
    await setPool(tenant, map)
    const now = Date.now()
    const series: PrwSeries[] = Array.from({ length: 400 }, (_, i) => ({
      labels: [['__name__', 'requests_total'], ['job', 'api'], ['path', `/p/${i}`]],
      samples: [{ ts: now - 1000, value: i }, { ts: now, value: i + 0.5 }],
    }))
    return { tenant, key, map, series }
  }

  it('re-splits at the shard\'s cap when a shard answers too_large, and then succeeds', async () => {
    const { tenant, key, map, series } = await oneSlot()
    await shardStub(map, 0).configure({ maxBatchBytes: 4096 })
    const res = await postWrite(key, series)
    expect(res.status).toBe(204)
    const stub = shardStub(map, 0)
    const d = (await stub.describe(tenant))!
    const t = await stub.tailRead(tenant, d.incarnation, 0)
    if (t.status !== 'ok') throw new Error(t.status)
    expect(t.batches.length).toBeGreaterThan(5)
    for (const b of t.batches) expect(b.payload.byteLength).toBeLessThanOrEqual(4096)
    expect(canon((await tailOfSlot(map, 0, tenant)).samples)).toEqual(sentCanon(series))
  })

  it('answers a retryable 503, never 2xx, when a row cannot fit the shard\'s cap', async () => {
    const { tenant, key, map, series } = await oneSlot()
    await shardStub(map, 0).configure({ maxBatchBytes: 16 })
    const res = await postWrite(key, series)
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('1')
    expect(await res.text()).toContain('retry the whole request')
    expect((await tailOfSlot(map, 0, tenant)).samples).toEqual([])
  })
})

describe('OTLP routing labels', () => {
  const str = (key: string, v: string) => ({ key, value: { stringValue: v } })
  const nanos = (ms: number) => String(BigInt(ms) * 1_000_000n)

  it('renames point attributes job/instance to exported_job/exported_instance, so they cannot move a sender\'s data', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const map: PoolMap = { pool: `otlp/${tenant}`, slots: 16, spread: 16, epoch: 1 }
    await setPool(tenant, map)
    const now = Date.now()
    const N = 40
    const req = {
      resourceMetrics: [{
        resource: { attributes: [str('service.name', 'checkout'), str('service.instance.id', 'i-1'), str('job', 'resource-job'), str('instance', 'resource-instance')] },
        scopeMetrics: [{
          metrics: [{
            name: 'queue_depth',
            gauge: {
              dataPoints: Array.from({ length: N }, (_, i) => ({
                timeUnixNano: nanos(now),
                asDouble: i,
                attributes: i === 0 ? [] : [str('job', `point-job-${i}`), str('instance', `point-instance-${i}`)],
              })),
            },
          }],
        }],
      }],
    }
    const res = await postOtlp(key, otlpProto(req), 'application/x-protobuf')
    expect(res.status).toBe(200)

    // Everything is in the one slot the resource's service attributes route to.
    const home = slotFor(map, tenant, 'job=checkout\u0000instance=i-1')
    for (let slot = 0; slot < map.slots; slot++) {
      const { samples } = await tailOfSlot(map, slot, tenant)
      expect(samples.length).toBe(slot === home ? N : 0)
    }
    // (Without the rename the 39 distinct job/instance pairs would have spread over the pool.)
    expect(new Set(Array.from({ length: N - 1 }, (_, i) => slotFor(map, tenant, `job=point-job-${i + 1}\u0000instance=point-instance-${i + 1}`))).size).toBeGreaterThan(1)

    const { samples } = await tailOfSlot(map, home, tenant)
    for (const s of samples) {
      expect(s.labels.job).toBe('checkout')
      expect(s.labels.instance).toBe('i-1')
    }
    const plain = samples.find((s) => s.bits === bitsOf(0))!
    // A resource attribute literally named job/instance is not the routing label either.
    expect(plain.labels).toEqual({ __name__: 'queue_depth', job: 'checkout', instance: 'i-1', exported_job: 'resource-job', exported_instance: 'resource-instance' })
    const seven = samples.find((s) => s.bits === bitsOf(7))!
    // A point attribute replaces the resource attribute of the same (renamed) name.
    expect(seven.labels).toEqual({ __name__: 'queue_depth', job: 'checkout', instance: 'i-1', exported_job: 'point-job-7', exported_instance: 'point-instance-7' })
  })

  it('does the same for OTLP/JSON', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const now = Date.now()
    const req = {
      resourceMetrics: [{
        resource: { attributes: [str('service.name', 'svc')] },
        scopeMetrics: [{ metrics: [{ name: 'g', gauge: { dataPoints: [{ timeUnixNano: nanos(now), asDouble: 1, attributes: [str('job', 'x'), str('instance', 'y')] }] } }] }],
      }],
    }
    expect((await postOtlp(key, JSON.stringify(req), 'application/json')).status).toBe(200)
    const stored = await tail(DEFAULT_MAP, tenant)
    expect(stored.map((s) => s.labels)).toEqual([{ __name__: 'g', job: 'svc', exported_job: 'x', exported_instance: 'y' }])
  })
})
