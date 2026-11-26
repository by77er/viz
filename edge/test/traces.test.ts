import { describe, expect, it } from 'vitest'
import { slotFor } from '../../shard/src/pool'
import { DEFAULT_MAP, gzip, makeKey, newTenant, postOtlp } from './helpers'
import {
  type Attrs,
  Gen,
  type ResourceM,
  type ScopeM,
  type SpanM,
  type StoredSpan,
  type V,
  canonL,
  decodeSpanBatch,
  fnv,
  partialProto,
  postSignal,
  rng,
  signalPool,
  storedBatches,
  storedSpans,
  tracesJson,
  tracesProto,
  typed,
} from './otelhelpers'

const te = new TextEncoder()
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const NOW = BigInt(Date.now()) * 1_000_000n
const MIN = 60_000_000_000n

/** What the shard must hold for one input span (contracts/BATCH.md, signal 2). */
function expected(r: ResourceM, sc: ScopeM, s: SpanM): StoredSpan {
  const clamped = s.end < s.start
  const attrs: Attrs = [...(s.attrs ?? []), ...(clamped ? ([['viz.clamped_end', { b: true }]] as Attrs) : [])]
  return {
    resourceFp: fnv(te.encode(canonL(r.attrs))),
    resource: typed(r.attrs),
    scopeName: sc.name ?? '',
    scopeVersion: sc.version ?? '',
    scopeAttrs: sc.attrs?.length ? canonL(sc.attrs) : '',
    traceId: hex(s.traceId),
    spanId: hex(s.spanId),
    parent: s.parent && s.parent.some((x) => x !== 0) ? hex(s.parent) : '0000000000000000',
    start: s.start,
    end: clamped ? s.start : s.end,
    flags: s.flags ?? 0,
    dropped: s.dropped ?? [0, 0, 0],
    kind: s.kind ?? 0,
    status: s.statusCode ?? 0,
    name: s.name,
    traceState: s.traceState ?? '',
    statusMessage: s.statusMessage ?? '',
    attrs: typed(attrs),
    events: (s.events ?? []).map((e) => ({ t: e.t, name: e.name, attrs: e.attrs?.length ? canonL(e.attrs) : '[]' })),
    links: (s.links ?? []).map((l) => ({ traceId: hex(l.traceId), spanId: hex(l.spanId), traceState: l.traceState ?? '', attrs: l.attrs?.length ? canonL(l.attrs) : '[]' })),
  }
}

const key = (s: { traceId: string; spanId: string }): string => `${s.traceId}/${s.spanId}`
const sorted = (xs: StoredSpan[]): StoredSpan[] => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : 1))

function expectAll(rs: ResourceM[]): StoredSpan[] {
  return sorted(rs.flatMap((r) => r.scopes.flatMap((sc) => sc.spans.map((s) => expected(r, sc, s)))))
}

/** JSON cannot carry -0 as a double: the model a JSON request stands for. */
function jsonModel(rs: ResourceM[]): ResourceM[] {
  const fix = (v: V): V => ('d' in v && Object.is(v.d, -0) ? { d: 0 } : 'a' in v ? { a: v.a.map(fix) } : 'l' in v ? { l: v.l.map(([k, x]) => [k, fix(x)]) } : v)
  const fa = (a?: Attrs): Attrs | undefined => a?.map(([k, v]) => [k, fix(v)])
  return rs.map((r) => ({
    attrs: fa(r.attrs)!,
    scopes: r.scopes.map((sc) => ({
      ...sc,
      attrs: fa(sc.attrs),
      spans: sc.spans.map((s) => ({ ...s, attrs: fa(s.attrs), events: s.events?.map((e) => ({ ...e, attrs: fa(e.attrs) })), links: s.links?.map((l) => ({ ...l, attrs: fa(l.attrs) })) })),
    })),
  }))
}

function span(g: Gen, o: Partial<SpanM> = {}): SpanM {
  return {
    traceId: g.id(16),
    spanId: g.id(8),
    parent: g.chance(0.6) ? g.id(8) : undefined,
    traceState: g.chance(0.3) ? 'vendor=x' : undefined,
    flags: g.chance(0.5) ? 0x301 : undefined,
    name: g.text(12),
    kind: g.int(6),
    start: NOW - BigInt(g.int(3600)) * 1_000_000_000n,
    end: 0n,
    attrs: g.attrs(),
    dropped: [g.int(3), g.int(2), g.int(2)],
    events: Array.from({ length: g.int(3) }, () => ({ t: NOW + BigInt(g.int(1000)), name: g.text(5), attrs: g.chance(0.5) ? g.attrs(3) : undefined })),
    links: Array.from({ length: g.int(2) }, () => ({ traceId: g.id(16), spanId: g.id(8), traceState: g.chance(0.5) ? 'k=v' : undefined, attrs: g.chance(0.5) ? g.attrs(2) : undefined })),
    statusMessage: g.chance(0.3) ? g.text(8) : undefined,
    statusCode: g.int(3),
    ...o,
  }
}

function request(g: Gen): ResourceM[] {
  return Array.from({ length: 1 + g.int(3) }, (_, k) => ({
    attrs: [['service.name', { s: `svc-${g.int(4)}` }], ['service.instance.id', { s: `i-${k}` }], ...g.attrs(4, ['host.name', 'k8s.pod.name', 'deployment.environment.name', 'é'])] as Attrs,
    scopes: Array.from({ length: 1 + g.int(2) }, () => ({
      name: g.chance(0.7) ? 'io.lib' : undefined,
      version: g.chance(0.5) ? '1.2.3' : undefined,
      attrs: g.chance(0.3) ? g.attrs(2) : undefined,
      spans: Array.from({ length: 1 + g.int(8) }, () => {
        const s = span(g)
        s.end = g.chance(0.1) ? s.start - 5n : s.start + BigInt(g.int(1e9))
        return s
      }),
    })),
  }))
}

describe('OTLP/HTTP traces', () => {
  it('is not served unless INGEST_SIGNALS enables it', async () => {
    const tenant = newTenant()
    const k = await makeKey(tenant)
    const body = tracesProto(request(new Gen(rng(1))))
    for (const env of [{ INGEST_SIGNALS: '' }, { INGEST_SIGNALS: 'logs' }]) {
      const res = await postSignal('/v1/traces', k, body, 'application/x-protobuf', { env })
      expect(res.status).toBe(404)
    }
    expect(await storedSpans(DEFAULT_MAP, tenant)).toEqual([])
    expect((await postSignal('/v1/traces', k, body, 'application/x-protobuf')).status).toBe(200)
  })

  it('stores every span exactly, in protobuf, JSON and gzip, in the traces pool only', async () => {
    for (const [mode, seed] of [['proto', 11], ['json', 12], ['gzip', 13], ['json-gzip', 14]] as const) {
      const tenant = newTenant()
      const k = await makeKey(tenant)
      const rs = request(new Gen(rng(seed)))
      const json = mode.startsWith('json')
      let body: Uint8Array<ArrayBuffer> = json ? te.encode(tracesJson(rs, seed % 2 === 0)) : tracesProto(rs)
      if (mode.endsWith('gzip')) body = await gzip(body)
      const res = await postSignal('/v1/traces', k, body, json ? 'application/json' : 'application/x-protobuf', { headers: mode.endsWith('gzip') ? { 'Content-Encoding': 'gzip' } : {} })
      expect(res.status, mode).toBe(200)
      if (json) expect(await res.json()).toEqual({})
      else expect(new Uint8Array(await res.arrayBuffer()).length).toBe(0)
      expect(sorted(await storedSpans(DEFAULT_MAP, tenant)), mode).toEqual(expectAll(json ? jsonModel(rs) : rs))
      // Nothing in the metrics pool.
      expect([...(await storedBatches(DEFAULT_MAP, tenant)).values()].flat()).toEqual([])
    }
  })

  it('refuses each invalid span on its own and counts it in partial_success', async () => {
    const g = new Gen(rng(5))
    const tenant = newTenant()
    const k = await makeKey(tenant)
    const ok = [span(g, { end: NOW }), span(g, { end: NOW })]
    ok[0]!.start = NOW - 1000n
    ok[1]!.start = NOW - 5n
    const clamped = span(g, { start: NOW - 10n, end: NOW - 20n })
    const many = (n: number): Attrs => Array.from({ length: n }, (_, i) => [`k${i}`, { i: BigInt(i) }] as [string, V])
    const bad: [string, SpanM][] = [
      ['invalid trace_id', span(g, { traceId: new Uint8Array(15), end: NOW })],
      ['invalid trace_id', span(g, { traceId: new Uint8Array(16), end: NOW })],
      ['invalid span_id', span(g, { spanId: new Uint8Array(0), end: NOW })],
      ['invalid parent_span_id', span(g, { parent: new Uint8Array(4), end: NOW })],
      ['unknown kind', span(g, { kind: 9, end: NOW })],
      ['unknown status code', span(g, { statusCode: 5, end: NOW })],
      ['older than the accept window', span(g, { start: NOW - 25n * 60n * MIN, end: NOW })],
      ['too far in the future', span(g, { start: NOW + 10n * MIN, end: NOW + 11n * MIN })],
      ['over 8,192 bytes', span(g, { name: 'x'.repeat(8193), end: NOW })],
      ['empty key', span(g, { attrs: [['', { s: 'v' }]], end: NOW })],
      ['more than 128 attributes', span(g, { attrs: many(129), end: NOW })],
      ['more than 128 events', span(g, { events: Array.from({ length: 129 }, () => ({ t: NOW, name: 'e' })), end: NOW })],
      ['link with an invalid', span(g, { links: [{ traceId: new Uint8Array(15), spanId: g.id(8) }], end: NOW })],
      ['attribute value over 65,536 bytes', span(g, { attrs: [['big', { s: 'v'.repeat(65_537) }]], end: NOW })],
      ['span over 256 KiB', span(g, { attrs: [0, 1, 2, 3, 4].map((i) => [`k${i}`, { s: 'v'.repeat(60_000) }] as [string, V]), end: NOW })],
    ]
    for (const s of [...ok, ...bad.map((b) => b[1])]) if (s.end === NOW && s.start > NOW) s.end = s.start
    const badResource: ResourceM = { attrs: [['', { s: 'x' }]], scopes: [{ spans: [span(g, { end: NOW }), span(g, { end: NOW })] }] }
    const rs: ResourceM[] = [{ attrs: [['service.name', { s: 'api' }]], scopes: [{ spans: [...ok, clamped, ...bad.map((b) => b[1])] }] }, badResource]
    for (const json of [false, true]) {
      const t = newTenant()
      const kk = json ? await makeKey(t) : k
      const res = await postSignal('/v1/traces', kk, json ? tracesJson(rs) : tracesProto(rs), json ? 'application/json' : 'application/x-protobuf')
      expect(res.status).toBe(200)
      let rejected: number
      let message: string
      if (json) {
        const p = ((await res.json()) as { partialSuccess: { rejectedSpans: string; errorMessage: string } }).partialSuccess
        rejected = Number(p.rejectedSpans)
        message = p.errorMessage
      } else [rejected, message] = partialProto(new Uint8Array(await res.arrayBuffer()))
      expect(rejected).toBe(bad.length + 2)
      for (const [why] of bad) expect(message).toContain(why)
      expect(message).toContain('2 resource attribute with an empty key')
      const stored = sorted(await storedSpans(DEFAULT_MAP, json ? t : tenant))
      expect(stored).toEqual(sorted([...ok, clamped].map((s) => expected(rs[0]!, rs[0]!.scopes[0]!, s))))
      expect(stored.find((s) => s.spanId === hex(clamped.spanId))!.attrs).toContainEqual(['viz.clamped_end', 'b', 'true'])
    }
  })

  it('reports partial_success in JSON with the same counts', async () => {
    const g = new Gen(rng(6))
    const tenant = newTenant()
    const k = await makeKey(tenant)
    const rs: ResourceM[] = [{ attrs: [], scopes: [{ spans: [span(g, { end: NOW, start: NOW - 1n }), span(g, { kind: 7, end: NOW, start: NOW - 1n }), span(g, { spanId: new Uint8Array(8), end: NOW, start: NOW - 1n })] }] }]
    const res = await postSignal('/v1/traces', k, tracesJson(rs), 'application/json')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    const body = (await res.json()) as { partialSuccess: { rejectedSpans: string; errorMessage: string } }
    expect(body.partialSuccess.rejectedSpans).toBe('2')
    expect(body.partialSuccess.errorMessage).toContain('1 span with an unknown kind')
    expect(body.partialSuccess.errorMessage).toContain('1 span with an invalid span_id')
    expect((await storedSpans(DEFAULT_MAP, tenant)).length).toBe(1)
  })

  it('takes the tenant from the credential only', async () => {
    const a = newTenant('a')
    const b = newTenant('b')
    const ka = await makeKey(a)
    const rs: ResourceM[] = [{ attrs: [['tenant', { s: b }], ['viz.tenant', { s: b }], ['service.name', { s: b }]], scopes: [{ spans: [span(new Gen(rng(9)), { start: NOW - 1n, end: NOW })] }] }]
    for (const [path, body, type] of [['/v1/traces', tracesProto(rs), 'application/x-protobuf'], [`/v1/traces?tenant=${b}`, tracesJson(rs), 'application/json']] as const) {
      const res = await postSignal(path, ka, body, type, { headers: { 'X-Scope-OrgID': b, 'X-Tenant': b, Tenant: b } })
      expect(res.status).toBe(200)
    }
    // The JSON request carried the same span as the protobuf one: the same batch bytes, so the
    // shard recognised it by its fingerprint and stored it once.
    expect((await storedSpans(DEFAULT_MAP, a)).length).toBe(1)
    expect((await storedBatches(signalPool(DEFAULT_MAP, 'traces'), a)).size).toBe(1)
    expect(await storedSpans(DEFAULT_MAP, b)).toEqual([])
    const res = await postSignal('/v1/traces', 'viz_nokey_notasecret', tracesProto(rs), 'application/x-protobuf')
    expect(res.status).toBe(401)
  })

  it('routes by sender: a resource takes one slot, the same slot number its metrics take', async () => {
    const tenant = newTenant()
    const k = await makeKey(tenant)
    const g = new Gen(rng(21))
    const resources: ResourceM[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({
      attrs: [['service.namespace', { s: 'shop' }], ['service.name', { s: n }], ['service.instance.id', { s: `${n}-1` }]],
      scopes: [{ spans: Array.from({ length: 5 }, () => span(g, { start: NOW - 1n, end: NOW, attrs: [['job', { s: 'other' }], ['instance', { s: 'x' }]] })) }],
    }))
    expect((await postSignal('/v1/traces', k, tracesProto(resources), 'application/x-protobuf')).status).toBe(200)
    const bySlot = await storedBatches(signalPool(DEFAULT_MAP, 'traces'), tenant)
    for (const r of resources) {
      const name = (r.attrs[1]![1] as { s: string }).s
      const want = slotFor(DEFAULT_MAP, tenant, `job=shop/${name}\u0000instance=${name}-1`)
      for (const [slot, batches] of bySlot) {
        const ids = batches.flatMap((b) => (slot === want ? [] : decodeIds(b)))
        for (const s of r.scopes[0]!.spans) expect(ids).not.toContain(hex(s.spanId))
      }
      // The sender's metrics go to the same slot number of the metrics pool.
      const otlp = JSON.stringify({ resourceMetrics: [{ resource: { attributes: r.attrs.map(([k2, v]) => ({ key: k2, value: { stringValue: (v as { s: string }).s } })) }, scopeMetrics: [{ metrics: [{ name: 'm', gauge: { dataPoints: [{ timeUnixNano: String(NOW), asDouble: 1 }] } }] }] }] })
      expect((await postOtlp(k, otlp, 'application/json')).status).toBe(200)
      const metrics = await storedBatches(DEFAULT_MAP, tenant)
      expect(metrics.get(want)?.length).toBeGreaterThan(0)
    }
  })

  it('splits a slot into batches of at most 1 MiB, in arrival order', async () => {
    const tenant = newTenant()
    const k = await makeKey(tenant)
    const g = new Gen(rng(31))
    const spans = Array.from({ length: 60 }, (_, i) => span(g, { start: NOW - 1000n + BigInt(i), end: NOW, attrs: [['blob', { s: 'x'.repeat(40_000) }]], events: [], links: [] }))
    const rs: ResourceM[] = [{ attrs: [['service.name', { s: 'big' }]], scopes: [{ spans }] }]
    expect((await postSignal('/v1/traces', k, tracesProto(rs), 'application/x-protobuf')).status).toBe(200)
    const batches = [...(await storedBatches(signalPool(DEFAULT_MAP, 'traces'), tenant)).values()].flat()
    expect(batches.length).toBeGreaterThan(2)
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(1 << 20)
    expect((await storedSpans(DEFAULT_MAP, tenant)).map((s) => s.spanId)).toEqual(spans.map((s) => hex(s.spanId)))
  })

  it('refuses malformed bodies with 400 and a Status, and too many spans with 413', async () => {
    const tenant = newTenant()
    const k = await makeKey(tenant)
    for (const [body, type] of [[new Uint8Array([0x0a, 0x05, 0x01]), 'application/x-protobuf'], ['{"resourceSpans": 3}', 'application/json'], ['not json', 'application/json']] as const) {
      const res = await postSignal('/v1/traces', k, body, type)
      expect(res.status).toBe(400)
      expect(res.headers.get('Content-Type')).toBe(type)
    }
    const g = new Gen(rng(41))
    const rs: ResourceM[] = [{ attrs: [], scopes: [{ spans: Array.from({ length: 3 }, () => span(g, { start: NOW - 1n, end: NOW })) }] }]
    const res = await postSignal('/v1/traces', k, tracesProto(rs), 'application/x-protobuf', { env: { INGEST_LIMITS: JSON.stringify({ maxSpans: 2 }) } })
    expect(res.status).toBe(413)
    expect((await postSignal('/v1/traces', k, tracesProto(rs), 'text/plain')).status).toBe(415)
    expect(await storedSpans(DEFAULT_MAP, tenant)).toEqual([])
  })

  it('round-trips random requests (property: decode, store, decode again equals the input)', async () => {
    for (let seed = 100; seed < 140; seed++) {
      const tenant = newTenant()
      const k = await makeKey(tenant)
      const g = new Gen(rng(seed))
      const rs = request(g)
      const mode = seed % 3
      const body = mode === 1 ? te.encode(tracesJson(rs)) : tracesProto(rs)
      const res = await postSignal('/v1/traces', k, mode === 2 ? await gzip(body) : body, mode === 1 ? 'application/json' : 'application/x-protobuf', { headers: mode === 2 ? { 'Content-Encoding': 'gzip' } : {} })
      expect(res.status, `seed ${seed}`).toBe(200)
      expect(sorted(await storedSpans(DEFAULT_MAP, tenant)), `seed ${seed}`).toEqual(expectAll(mode === 1 ? jsonModel(rs) : rs))
    }
  })
})

const decodeIds = (b: Uint8Array): string[] => decodeSpanBatch(b).map((s) => s.spanId)
