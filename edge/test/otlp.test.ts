import { describe, expect, it } from 'vitest'
import { PbReader } from '../src/pb'
import { metricName } from '../src/otlp'
import fixtures from './fixtures.json'
import { DEFAULT_MAP, STALE_NAN, bitsOf, canon, gzip, makeKey, newTenant, otlpProto, postOtlp, refSeriesId, tail } from './helpers'

const PROTO = 'application/x-protobuf'
const JSON_T = 'application/json'
const b64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))
const nanos = (ms: number, extra = 0n) => String(BigInt(ms) * 1_000_000n + extra)
const str = (key: string, v: string) => ({ key, value: { stringValue: v } })

/** Parse an ExportMetricsServiceResponse (protobuf) by hand. */
function parseResponse(b: Uint8Array): { rejected: number; message: string } {
  const out = { rejected: 0, message: '' }
  const r = new PbReader(b)
  while (r.pos < r.end) {
    const tag = r.uint32()
    if (tag !== 0x0a) throw new Error(`unexpected field ${tag}`)
    const end = r.len()
    while (r.pos < end) {
      const t = r.uint32()
      if (t === 0x08) out.rejected = r.uint32()
      else if (t === 0x12) {
        const e = r.len()
        out.message = new TextDecoder().decode(b.subarray(r.pos, e))
        r.pos = e
      } else throw new Error(`unexpected field ${t}`)
    }
  }
  return out
}

/** A request exercising the mapping; sent as protobuf and as JSON. */
function request(now: number) {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [str('service.name', 'checkout'), str('service.namespace', 'shop'), str('service.instance.id', 'i-1'), str('host.name', 'h1'), { key: 'k8s.pod.count', value: { intValue: '3' } }, str('empty.one', '')],
        },
        scopeMetrics: [
          {
            scope: { name: 'lib' },
            metrics: [
              {
                name: 'process.cpu.time',
                unit: 's',
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    { attributes: [str('cpu.mode', 'user')], timeUnixNano: nanos(now, 999_999n), asDouble: 12.5 },
                    { attributes: [str('cpu.mode', 'system')], timeUnixNano: nanos(now), asInt: '7' },
                  ],
                },
              },
              { name: 'queue.depth', unit: '{items}', gauge: { dataPoints: [{ attributes: [{ key: 'on', value: { boolValue: true } }, { key: 'tags', value: { arrayValue: { values: [{ stringValue: 'a' }, { intValue: '2' }] } } }], timeUnixNano: nanos(now - 1000), asInt: '-4' }] } },
              { name: 'active.sessions', unit: '1', sum: { aggregationTemporality: 2, isMonotonic: false, dataPoints: [{ timeUnixNano: nanos(now), asDouble: 3 }] } },
              { name: 'memory.usage', unit: 'By', gauge: { dataPoints: [{ attributes: [str('host.name', 'override')], timeUnixNano: nanos(now), asDouble: 1024 }] } },
              { name: 'gone', gauge: { dataPoints: [{ timeUnixNano: nanos(now), flags: 1 }] } },
            ],
          },
        ],
      },
      {
        resource: { attributes: [str('service.name', 'other')] },
        scopeMetrics: [{ metrics: [{ name: 'http.server.requests', unit: '{request}/s', gauge: { dataPoints: [{ timeUnixNano: nanos(now), asDouble: 0.5 }] } }] }],
      },
    ],
  }
}

function expected(now: number) {
  const res = { job: 'shop/checkout', instance: 'i-1', host_name: 'h1', k8s_pod_count: '3' }
  return canon([
    { labels: { ...res, __name__: 'process_cpu_time_seconds_total', cpu_mode: 'user' }, ts: now, bits: bitsOf(12.5) },
    { labels: { ...res, __name__: 'process_cpu_time_seconds_total', cpu_mode: 'system' }, ts: now, bits: bitsOf(7) },
    { labels: { ...res, __name__: 'queue_depth', on: 'true', tags: '["a",2]' }, ts: now - 1000, bits: bitsOf(-4) },
    { labels: { ...res, __name__: 'active_sessions_ratio' }, ts: now, bits: bitsOf(3) },
    { labels: { ...res, __name__: 'memory_usage_bytes', host_name: 'override' }, ts: now, bits: bitsOf(1024) },
    { labels: { ...res, __name__: 'gone' }, ts: now, bits: STALE_NAN },
    { labels: { job: 'other', __name__: 'http_server_requests_per_second' }, ts: now, bits: bitsOf(0.5) },
  ])
}

describe('OTLP/HTTP metrics', () => {
  it('maps gauges and cumulative sums identically from protobuf, JSON and gzip, and answers in kind', async () => {
    const now = Date.now()
    const req = request(now)
    const tails: string[][] = []
    for (const variant of ['proto', 'json', 'proto+gzip', 'json+gzip'] as const) {
      const tenant = newTenant()
      const key = await makeKey(tenant)
      const json = variant.startsWith('json')
      let body: Uint8Array<ArrayBuffer> = json ? new TextEncoder().encode(JSON.stringify(req)) : otlpProto(req)
      const headers: Record<string, string> = {}
      if (variant.endsWith('gzip')) {
        body = await gzip(body)
        headers['Content-Encoding'] = 'gzip'
      }
      const res = await postOtlp(key, body, json ? `${JSON_T}; charset=utf-8` : PROTO, { headers })
      expect(res.status, variant).toBe(200)
      // Full success: an empty ExportMetricsServiceResponse in the request's encoding.
      expect(res.headers.get('Content-Type')).toBe(json ? JSON_T : PROTO)
      if (json) expect(await res.json()).toEqual({})
      else expect((await res.arrayBuffer()).byteLength).toBe(0)
      const stored = await tail(DEFAULT_MAP, tenant)
      expect(canon(stored), variant).toEqual(expected(now))
      for (const s of stored) expect(s.id).toBe(refSeriesId(Object.entries(s.labels).sort(([a], [b]) => (a < b ? -1 : 1))))
      tails.push(canon(stored))
    }
    expect(new Set(tails.map((t) => JSON.stringify(t))).size).toBe(1)
  })

  it('accepts a body produced by protobufjs (independent tooling), plain and gzipped by node:zlib', async () => {
    const wide = { env: { INGEST_LIMITS: JSON.stringify({ acceptBackMs: 1e15, acceptAheadMs: 1e15 }) } }
    for (const [body, headers] of [[b64(fixtures.otlp.proto), {}], [b64(fixtures.otlp.gzip), { 'Content-Encoding': 'gzip' }]] as const) {
      const tenant = newTenant()
      const key = await makeKey(tenant)
      const res = await postOtlp(key, body, PROTO, { ...wide, headers })
      expect(res.status).toBe(200)
      const partial = parseResponse(new Uint8Array(await res.arrayBuffer()))
      expect(partial).toEqual({ rejected: fixtures.otlp.rejected, message: '2 histograms are not supported' })
      // …and timestamps with a 999999 ns remainder are floored to the millisecond exactly.
      expect(canon(await tail(DEFAULT_MAP, tenant))).toEqual(canon(fixtures.otlp.expect.map((e) => ({ labels: e.labels, ts: e.ts, bits: bitsOf(e.value) }))))
    }
  })

  it('reports everything it does not store in partial_success, never silently', async () => {
    const now = Date.now()
    const point = (ms: number) => ({ timeUnixNano: nanos(ms), asDouble: 1 })
    const req = {
      resourceMetrics: [
        {
          resource: { attributes: [str('service.name', 'svc')] },
          scopeMetrics: [
            {
              metrics: [
                { name: 'ok', gauge: { dataPoints: [point(now), point(now - 1)] } },
                { name: 'hist', histogram: { aggregationTemporality: 2, dataPoints: [point(now), point(now), point(now)] } },
                { name: 'exp', exponentialHistogram: { aggregationTemporality: 2, dataPoints: [point(now)] } },
                { name: 'summ', summary: { dataPoints: [point(now), point(now)] } },
                { name: 'delta', sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [point(now), point(now), point(now), point(now)] } },
                { name: 'unspecified', sum: { isMonotonic: true, dataPoints: [point(now)] } },
                { name: 'old', gauge: { dataPoints: [point(now - 2 * 3600_000), point(now)] } },
                { name: 'future', gauge: { dataPoints: [point(now + 3600_000)] } },
                { name: 'novalue', gauge: { dataPoints: [{ timeUnixNano: nanos(now) }] } },
              ],
            },
          ],
        },
      ],
    }
    const accepted = canon([
      { labels: { job: 'svc', __name__: 'ok' }, ts: now, bits: bitsOf(1) },
      { labels: { job: 'svc', __name__: 'ok' }, ts: now - 1, bits: bitsOf(1) },
      { labels: { job: 'svc', __name__: 'old' }, ts: now, bits: bitsOf(1) },
    ])
    const reasons = ['3 histograms are not supported', '1 exponential histograms are not supported', '2 summaries are not supported', '4 delta temporality sums are not supported', '1 sum without an aggregation temporality', '1 timestamp older than the accept window', '1 timestamp too far in the future', '1 data point without a value']

    for (const json of [false, true]) {
      const tenant = newTenant()
      const key = await makeKey(tenant)
      const res = await postOtlp(key, json ? JSON.stringify(req) : otlpProto(req), json ? JSON_T : PROTO)
      expect(res.status).toBe(200) // partial success is still 200 in OTLP
      let rejected: number
      let message: string
      if (json) {
        const body = (await res.json()) as { partialSuccess: { rejectedDataPoints: string; errorMessage: string } }
        rejected = Number(body.partialSuccess.rejectedDataPoints)
        message = body.partialSuccess.errorMessage
      } else ({ rejected, message } = parseResponse(new Uint8Array(await res.arrayBuffer())))
      expect(rejected).toBe(14)
      for (const r of reasons) expect(message).toContain(r)
      expect(canon(await tail(DEFAULT_MAP, tenant))).toEqual(accepted)
    }
  })

  it('answers errors as a Status in the request encoding: 400 malformed, 413 too large, 415 wrong type', async () => {
    const tenant = newTenant()
    const key = await makeKey(tenant)
    const badJson = await postOtlp(key, '{"resourceMetrics": [', JSON_T)
    expect(badJson.status).toBe(400)
    expect(await badJson.json()).toMatchObject({ code: 400, message: expect.stringContaining('malformed OTLP JSON') })
    expect((await postOtlp(key, '{"resourceMetrics": {"a": 1}}', JSON_T)).status).toBe(400)
    expect((await postOtlp(key, '[]', JSON_T)).status).toBe(400)

    const badProto = await postOtlp(key, new Uint8Array([0x0a, 0x10, 0x01]), PROTO)
    expect(badProto.status).toBe(400)
    expect(badProto.headers.get('Content-Type')).toBe(PROTO)
    expect(new TextDecoder().decode(await badProto.arrayBuffer())).toContain('malformed protobuf')

    const badGzip = await postOtlp(key, new Uint8Array([1, 2, 3, 4, 5]), PROTO, { headers: { 'Content-Encoding': 'gzip' } })
    expect(badGzip.status).toBe(400)

    const now = Date.now()
    const big = JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'm', gauge: { dataPoints: Array.from({ length: 500 }, () => ({ timeUnixNano: nanos(now), asDouble: 1 })) } }] }] }] })
    expect((await postOtlp(key, big, JSON_T, { env: { INGEST_LIMITS: JSON.stringify({ maxBodyBytes: 1000 }) } })).status).toBe(413)
    // A gzip bomb: small on the wire, over the decompressed limit when inflated.
    const bomb = await gzip(new TextEncoder().encode(big))
    expect(bomb.length).toBeLessThan(2000)
    expect((await postOtlp(key, bomb, JSON_T, { headers: { 'Content-Encoding': 'gzip' }, env: { INGEST_LIMITS: JSON.stringify({ maxBodyBytes: 2000, maxDecompressedBytes: 10_000 }) } })).status).toBe(413)
    expect((await postOtlp(key, big, JSON_T, { env: { INGEST_LIMITS: JSON.stringify({ maxSamples: 499 }) } })).status).toBe(413)

    expect((await postOtlp(key, 'x', 'text/plain')).status).toBe(415)
    expect((await postOtlp(key, 'x', JSON_T, { headers: { 'Content-Encoding': 'zstd' } })).status).toBe(415)
    expect(await tail(DEFAULT_MAP, tenant)).toEqual([])
  })

  it('names metrics per the OpenTelemetry → Prometheus rules', () => {
    expect(metricName('http.server.duration', 'ms', false)).toBe('http_server_duration_milliseconds')
    expect(metricName('http.server.requests', '1', true)).toBe('http_server_requests_total')
    expect(metricName('http.server.requests_total', '', true)).toBe('http_server_requests_total')
    expect(metricName('system.cpu.utilization', '1', false)).toBe('system_cpu_utilization_ratio')
    expect(metricName('system.network.io', 'By', true)).toBe('system_network_io_bytes_total')
    expect(metricName('disk_bytes', 'By', false)).toBe('disk_bytes')
    expect(metricName('2xx responses!', '{responses}', true)).toBe('_2xx_responses_total')
    expect(metricName('rate', 'By/s', false)).toBe('rate_bytes_per_second')
    expect(metricName('job:rule:sum', '', false)).toBe('job:rule:sum')
  })
})
