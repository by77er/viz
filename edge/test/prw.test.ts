import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import * as snappyjs from 'snappyjs'
import { slotFor, tenantSlots } from '../../shard/src/pool'
import fixtures from './fixtures.json'
import { DEFAULT_MAP, PY_VECTORS, type PrwSeries, STALE_NAN, bitsOf, canon, makeKey, newTenant, postWrite, setPool, snappyCompress, tail, tailOfSlot, writeRequest } from './helpers'

const sentCanon = (series: PrwSeries[]) =>
  canon(
    series.flatMap((s) =>
      s.samples.map((x) => ({
        labels: Object.fromEntries(s.labels.filter(([, v]) => v !== '')),
        ts: x.ts,
        bits: typeof x.value === 'bigint' ? x.value : bitsOf(x.value),
      })),
    ),
  )

describe('Remote Write 1.0', () => {
  it('stores exactly the samples sent, bit for bit, with contract series ids', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const now = Date.now()
    const series: PrwSeries[] = [
      { labels: PY_VECTORS[0]![1], samples: [{ ts: now - 30_000, value: 1 }, { ts: now - 15_000, value: 0 }, { ts: now, value: STALE_NAN }] },
      { labels: PY_VECTORS[1]![1], samples: [{ ts: now, value: 12345.678 }, { ts: now + 1, value: -0 }] },
      { labels: PY_VECTORS[2]![1], samples: [{ ts: now, value: Infinity }, { ts: now, value: -Infinity }, { ts: now, value: 0x7ff8dead0000beefn }, { ts: now, value: 5e-324 }] },
    ]
    const res = await postWrite(key, series)
    expect(res.status).toBe(204)
    expect(res.headers.get('X-Prometheus-Remote-Write-Samples-Written')).toBe('9')
    expect(await res.text()).toBe('')

    const stored = await tail(DEFAULT_MAP, tenant)
    expect(canon(stored)).toEqual(sentCanon(series))
    // series_id is the Python-computed vector for each label set.
    for (const [id, labels] of PY_VECTORS.slice(0, 3)) {
      const name = labels[0]![1]
      const mine = stored.filter((s) => s.labels.__name__ === name)
      expect(mine.length).toBeGreaterThan(0)
      for (const s of mine) expect(s.id).toBe(id)
    }
    // The staleness marker and the NaN payload survived exactly.
    expect(stored.some((s) => s.bits === STALE_NAN)).toBe(true)
    expect(stored.some((s) => s.bits === 0x7ff8dead0000beefn)).toBe(true)
    expect(stored.some((s) => s.bits === 0x8000000000000000n)).toBe(true) // -0
  })

  it('accepts a body produced by protobufjs + snappyjs (independent tooling)', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const body = Uint8Array.from(atob(fixtures.prw.snappy), (ch) => ch.charCodeAt(0))
    const wide = { INGEST_LIMITS: JSON.stringify({ acceptBackMs: 1e15, acceptAheadMs: 1e15 }) }
    const res = await postWrite(key, body, { env: wide })
    expect(res.status).toBe(204)
    expect(res.headers.get('X-Prometheus-Remote-Write-Samples-Written')).toBe(String(fixtures.prw.expect.length))
    const stored = await tail(DEFAULT_MAP, tenant)
    expect(stored.length).toBe(600)
    expect(canon(stored)).toEqual(canon(fixtures.prw.expect.map((e) => ({ labels: e.labels, ts: e.ts, bits: bitsOf(e.value) }))))
  })

  it('accepts snappyjs compression of the test writer, and Basic auth with the key as password', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const now = Date.now()
    const series: PrwSeries[] = Array.from({ length: 50 }, (_, i) => ({ labels: [['__name__', 'm'], ['i', String(i)], ['job', 'j']], samples: [{ ts: now, value: i }] }))
    const res = await postWrite(key, new Uint8Array(snappyjs.compress(writeRequest(series))), { headers: { Authorization: `Basic ${btoa(`prometheus:${key}`)}` } })
    expect(res.status).toBe(204)
    expect(canon(await tail(DEFAULT_MAP, tenant))).toEqual(sentCanon(series))
  })

  it('canonicalises labels: unsorted input, empty values, repeats of one series, samples before labels', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const now = Date.now()
    const [id, labels] = PY_VECTORS[1]!
    const series: PrwSeries[] = [
      { labels: [...labels].reverse(), samples: [{ ts: now, value: 1 }] },
      { labels: [['unused', ''], ...labels], samples: [{ ts: now + 1, value: 2 }], samplesFirst: true },
      { labels, samples: [{ ts: now + 2, value: 3 }] },
    ]
    expect((await postWrite(key, series)).status).toBe(204)
    const slot = slotFor(DEFAULT_MAP, tenant, 'job=api\u0000instance=10.0.0.1:8080')
    const { batches, samples } = await tailOfSlot(DEFAULT_MAP, slot, tenant)
    expect(batches.length).toBe(1)
    expect(batches[0]!.series.length).toBe(1) // one series table entry for three rows
    expect(batches[0]!.series[0]!.id).toBe(id)
    expect(batches[0]!.series[0]!.labels).toEqual(labels)
    expect(samples.map((s) => Number(s.ts) - now)).toEqual([0, 1, 2]) // arrival order
  })

  it('rejects invalid series with 400 but still stores the valid ones, and says how many', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const now = Date.now()
    const good: PrwSeries = { labels: [['__name__', 'ok'], ['job', 'j']], samples: [{ ts: now, value: 1 }, { ts: now + 1, value: 2 }] }
    const res = await postWrite(key, [
      { labels: [['job', 'no-name']], samples: [{ ts: now, value: 1 }] },
      good,
      { labels: [['__name__', 'dup'], ['a', '1'], ['a', '2']], samples: [{ ts: now, value: 1 }, { ts: now, value: 1 }] },
      { labels: [['__name__', 'hist']], samples: [], histograms: 2 },
    ])
    expect(res.status).toBe(400)
    const msg = await res.text()
    expect(msg).toContain('rejected 5 of 7 samples')
    expect(msg).toContain('1 series without a __name__ label')
    expect(msg).toContain('2 duplicate label name')
    expect(msg).toContain('2 native histograms are not supported')
    expect(res.headers.get('X-Prometheus-Remote-Write-Samples-Written')).toBe('2')
    expect(canon(await tail(DEFAULT_MAP, tenant))).toEqual(sentCanon([good]))
  })

  it('enforces the accept window (1 h back, 5 min ahead by default) and its configuration', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const now = Date.now()
    const at = (name: string, ts: number | bigint): PrwSeries => ({ labels: [['__name__', name]], samples: [{ ts, value: 1 }] })
    const inside = [at('back_59m', now - 59 * 60_000), at('ahead_4m', now + 4 * 60_000)]
    const outside = [at('back_61m', now - 61 * 60_000), at('ahead_6m', now + 6 * 60_000), at('zero', 0), at('negative', -5), at('min', -(2n ** 63n)), at('max', 2n ** 63n - 1n)]
    const res = await postWrite(key, [...outside, ...inside])
    expect(res.status).toBe(400)
    const msg = await res.text()
    expect(msg).toContain('rejected 6 of 8 samples')
    expect(msg).toContain('4 timestamp older than the accept window')
    expect(msg).toContain('2 timestamp too far in the future')
    expect(canon(await tail(DEFAULT_MAP, tenant))).toEqual(sentCanon(inside))

    // The window is configuration, not code.
    const t2 = newTenant()
    const k2 = await makeKey(t2)
    const narrow = { INGEST_LIMITS: JSON.stringify({ acceptBackMs: 10_000, acceptAheadMs: 1000 }) }
    expect((await postWrite(k2, [at('a', now - 60_000)], { env: narrow })).status).toBe(400)
    expect((await postWrite(k2, [at('b', now + 60_000)], { env: narrow })).status).toBe(400)
    expect(await tail(DEFAULT_MAP, t2)).toEqual([])
    const wide = { INGEST_LIMITS: JSON.stringify({ acceptBackMs: 7 * 86_400_000 }) }
    expect((await postWrite(k2, [at('c', now - 3 * 86_400_000)], { env: wide })).status).toBe(204)
    expect((await tail(DEFAULT_MAP, t2)).map((s) => s.labels.__name__)).toEqual(['c'])
  })

  it('enforces size limits: 413 for too large a request, 400 for an oversized series', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const now = Date.now()
    const many = (n: number): PrwSeries[] => Array.from({ length: n }, (_, i) => ({ labels: [['__name__', 'm'], ['i', String(i)]], samples: [{ ts: now, value: i }] }))
    const lim = (o: object) => ({ env: { INGEST_LIMITS: JSON.stringify(o) } })

    const body = snappyCompress(writeRequest(many(200)))
    expect((await postWrite(key, body, lim({ maxBodyBytes: body.length - 1 }))).status).toBe(413)
    expect((await postWrite(key, body, lim({ maxDecompressedBytes: writeRequest(many(200)).length - 1 }))).status).toBe(413)
    expect((await postWrite(key, many(11), lim({ maxSeries: 10 }))).status).toBe(413)
    expect((await postWrite(key, [{ labels: [['__name__', 'm']], samples: Array.from({ length: 11 }, (_, i) => ({ ts: now + i, value: 1 })) }], lim({ maxSamples: 10 }))).status).toBe(413)
    // Nothing from the refused requests was stored.
    expect(await tail(DEFAULT_MAP, tenant)).toEqual([])
    expect((await postWrite(key, many(10), lim({ maxSeries: 10, maxBodyBytes: 1 << 20 }))).status).toBe(204)
    expect((await tail(DEFAULT_MAP, tenant)).length).toBe(10)

    const wide: [string, string][] = Array.from({ length: 5 }, (_, i) => [`l${i}`, 'v'] as [string, string])
    for (const [o, series] of [
      [{ maxLabelsPerSeries: 5 }, { labels: [['__name__', 'm'], ...wide], samples: [{ ts: now, value: 1 }] }],
      [{ maxLabelNameBytes: 8 }, { labels: [['__name__', 'm'], ['ninebytes', 'v']], samples: [{ ts: now, value: 1 }] }],
      [{ maxLabelValueBytes: 4 }, { labels: [['__name__', 'm'], ['a', 'fiveb']], samples: [{ ts: now, value: 1 }] }],
    ] as [object, PrwSeries][]) {
      const res = await postWrite(key, [series], lim(o))
      expect(res.status).toBe(400)
      expect(await res.text()).toMatch(/rejected 1 of 1 samples \(1 (too many labels|label name too long|label value too long)/)
    }
    expect((await tail(DEFAULT_MAP, tenant)).length).toBe(10)
  })

  it('answers 400 to malformed bodies and 415 to Remote Write 2.0', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const garbage = await postWrite(key, new Uint8Array([5, 0x04, 0x61, 0x62]))
    expect(garbage.status).toBe(400)
    expect(await garbage.text()).toContain('malformed snappy')
    // Valid snappy around a protobuf whose length prefix runs past the end.
    const badPb = await postWrite(key, snappyCompress(new Uint8Array([0x0a, 0x7f, 0x0a, 0x02])))
    expect(badPb.status).toBe(400)
    expect(await badPb.text()).toContain('malformed protobuf')
    const truncated = writeRequest([{ labels: [['__name__', 'm']], samples: [{ ts: Date.now(), value: 1 }] }])
    expect((await postWrite(key, snappyCompress(truncated.subarray(0, truncated.length - 3) as Uint8Array<ArrayBuffer>))).status).toBe(400)

    const v2 = await postWrite(key, new Uint8Array([0]), { headers: { 'Content-Type': 'application/x-protobuf;proto=io.prometheus.write.v2.Request' } })
    expect(v2.status).toBe(415)
    expect(await v2.text()).toContain('Remote Write 2.0 is not supported')
    expect((await postWrite(key, new Uint8Array([0]), { headers: { 'Content-Encoding': 'zstd' } })).status).toBe(415)
    expect(await tail(DEFAULT_MAP, tenant)).toEqual([])
  })

  it('splits a request larger than one Durable Object value into several batches, all stored', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    await setPool(tenant, { pool: `big/${tenant}`, slots: 1, spread: 1, epoch: 1 })
    const map = { pool: `big/${tenant}`, slots: 1, spread: 1, epoch: 1 }
    const now = Date.now()
    const filler = 'x'.repeat(100)
    const series: PrwSeries[] = Array.from({ length: 25_000 }, (_, i) => ({ labels: [['__name__', 'big'], ['filler', filler], ['i', String(i)], ['job', 'j']], samples: [{ ts: now, value: i }] }))
    const res = await postWrite(key, series)
    expect(res.status).toBe(204)
    const { batches, samples } = await tailOfSlot(map, 0, tenant)
    expect(batches.length).toBeGreaterThan(2) // > 3 MB of batch in ≤ 1 MiB pieces
    expect(samples.length).toBe(25_000)
    expect(samples.map((s) => s.labels.i)).toEqual(series.map((s) => s.labels[2]![1])) // order kept across batches
  })
})

describe('routing', () => {
  it('sends each series to the slot of its job/instance routing key, and nowhere else', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const map = { pool: `route/${tenant}`, slots: 8, spread: 4, epoch: 1 }
    await setPool(tenant, map)
    const now = Date.now()
    const series: PrwSeries[] = []
    for (let j = 0; j < 12; j++) {
      for (let i = 0; i < 3; i++) {
        const labels: [string, string][] = [['__name__', `m${i}`]]
        if (j % 4 !== 3) labels.push(['instance', `host-${j}:9100`]) // some series have no instance
        if (j % 6 !== 5) labels.push(['job', `job-${j % 5}`]) // …or no job
        labels.push(['zz', String(j)])
        series.push({ labels, samples: [{ ts: now, value: j * 10 + i }] })
      }
    }
    expect((await postWrite(key, series)).status).toBe(204)

    const expected = new Map<number, PrwSeries[]>()
    for (const s of series) {
      const l = Object.fromEntries(s.labels)
      // contracts/BATCH.md: `job=<job>\u0000instance=<instance>`, missing label = empty string
      const slot = slotFor(map, tenant, `job=${l.job ?? ''}\u0000instance=${l.instance ?? ''}`)
      expected.set(slot, [...(expected.get(slot) ?? []), s])
    }
    expect(expected.size).toBeGreaterThan(1) // the request really was split
    for (let slot = 0; slot < map.slots; slot++) {
      const { batches, samples } = await tailOfSlot(map, slot, tenant)
      expect(canon(samples)).toEqual(sentCanon(expected.get(slot) ?? []))
      expect(batches.length).toBe(expected.has(slot) ? 1 : 0) // one batch per slot
      if (!tenantSlots(map, tenant).includes(slot)) expect(samples).toEqual([])
    }
    // Nothing leaked into the default pool.
    expect(await tail(DEFAULT_MAP, tenant)).toEqual([])
  })

  it('falls back to the default pool, and 503s when there is none', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const s: PrwSeries[] = [{ labels: [['__name__', 'm']], samples: [{ ts: Date.now(), value: 1 }] }]
    const res = await postWrite(key, s, { env: { DEFAULT_POOL: undefined } })
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect((await postWrite(key, s, { env: { DEFAULT_POOL: JSON.stringify({ pool: `alt/${tenant}`, slots: 2, spread: 2, epoch: 1 }) } })).status).toBe(204)
    expect((await tail({ pool: `alt/${tenant}`, slots: 2, spread: 2, epoch: 1 }, tenant)).length).toBe(1)
    void env
  })
})
