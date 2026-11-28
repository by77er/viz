import { describe, expect, it } from 'vitest'
import { slotFor } from '../../shard/src/pool'
import { DEFAULT_MAP, gzip, makeKey, newTenant, refSeriesId } from './helpers'
import {
  type Attrs,
  Gen,
  type LogM,
  type LogResourceM,
  type LokiStreamM,
  type StoredLog,
  type V,
  logsJson,
  logsProto,
  lokiProto,
  partialProto,
  plainT,
  postSignal,
  rng,
  signalPool,
  storedBatches,
  storedLogs,
  streamIdOf,
  utf8Cmp,
} from './otelhelpers'

const te = new TextEncoder()
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const NOW = BigInt(Date.now()) * 1_000_000n
const MIN = 60_000_000_000n
const Z16 = '0'.repeat(32)
const Z8 = '0'.repeat(16)

// ───────────────────── the contract's OTLP mapping, as an oracle ─────────────────────

const LABEL_KEYS = [
  'service.name', 'service.namespace', 'deployment.environment.name', 'cloud.region', 'cloud.availability_zone', 'k8s.cluster.name',
  'k8s.namespace.name', 'k8s.container.name', 'container.name', 'k8s.replicaset.name', 'k8s.deployment.name', 'k8s.statefulset.name',
  'k8s.daemonset.name', 'k8s.cronjob.name', 'k8s.job.name',
]
const sanitize = (k: string): string => {
  const s = k.replace(/[^A-Za-z0-9_]/gu, '_')
  return /^[0-9]/.test(s) ? `_${s}` : s
}
const byName = (xs: [string, string][]): [string, string][] => xs.filter(([, v]) => v !== '').sort((a, b) => utf8Cmp(a[0], b[0]))

function leaves(path: string, v: V, out: [string, string][]): void {
  if ('l' in v) for (const [k, x] of v.l) leaves(`${path}_${k}`, x, out)
  else out.push([sanitize(path), plainT(v)])
}
function levelOf(attrs: Attrs, skipLabels: boolean): Map<string, string> {
  const ls: [string, string][] = []
  for (const [k, v] of attrs) if (!(skipLabels && LABEL_KEYS.includes(k))) leaves(k, v, ls)
  const m = new Map<string, string>()
  for (const [n, v] of ls) if (v !== '') m.set(n, m.has(n) ? `${m.get(n)};${v}` : v)
  return m
}
function labelsOf(attrs: Attrs): [string, string][] {
  const m = new Map<string, string>()
  for (const [k, v] of attrs) if (LABEL_KEYS.includes(k)) m.set(sanitize(k), plainT(v))
  if (!m.get('service_name')) m.set('service_name', 'unknown_service')
  return byName([...m])
}

function expectedOtlp(rs: LogResourceM[]): StoredLog[] {
  const out: StoredLog[] = []
  for (const r of rs) {
    const labels = labelsOf(r.attrs)
    for (const sc of r.scopes) {
      for (const x of sc.logs) {
        const md = new Map<string, string>()
        for (const l of [levelOf(r.attrs, true), levelOf(sc.attrs ?? [], false), levelOf(x.attrs ?? [], false)]) for (const [n, v] of l) md.set(n, v)
        out.push({
          streamId: streamIdOf(labels),
          labels,
          ts: x.time ? x.time : x.observed!,
          observed: x.observed ?? 0n,
          traceId: x.traceId && x.traceId.some((b) => b !== 0) ? hex(x.traceId) : Z16,
          spanId: x.spanId && x.spanId.some((b) => b !== 0) ? hex(x.spanId) : Z8,
          flags: x.flags ?? 0,
          severity: x.severity ?? 0,
          line: x.body && !('n' in x.body) ? plainT(x.body) : '',
          severityText: x.severityText ?? '',
          metadata: byName([...md]),
        })
      }
    }
  }
  return out
}

function expectedLoki(streams: LokiStreamM[], labels: [string, string][][]): StoredLog[] {
  return streams.flatMap((s, i) =>
    s.entries.map((e) => ({
      streamId: streamIdOf(byName(labels[i]!)),
      labels: byName(labels[i]!),
      ts: e.ts,
      observed: 0n,
      traceId: Z16,
      spanId: Z8,
      flags: 0,
      severity: 0,
      line: e.line,
      severityText: '',
      metadata: byName(e.md ?? []),
    })),
  )
}

const order = (xs: StoredLog[]): StoredLog[] =>
  [...xs].sort((a, b) => {
    const k = (x: StoredLog) => JSON.stringify([String(x.streamId), String(x.ts), x.line, x.metadata])
    return k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0
  })

/** Text without NUL (label and metadata values may not hold one). */
const clean = (g: Gen, n = 8): string => g.text(n).replace(/\u0000/g, '')
/** Strings that end up raw in a label or metadata value lose their NUL bytes (inside JSON they are escaped). */
function noNul(v: V): V {
  if ('s' in v) return { s: v.s.replace(/\u0000/g, '') }
  if ('l' in v) return { l: v.l.map(([k, x]) => [k, noNul(x)]) }
  return v
}
const cleanValue = (g: Gen): V => noNul(g.value())

function otlpRequest(g: Gen): LogResourceM[] {
  const keys = ['service.name', 'k8s.pod.name', 'host.name', 'deployment.environment.name', 'k8s.namespace.name', 'process.pid', 'a.b', 'é']
  return Array.from({ length: 1 + g.int(3) }, () => ({
    attrs: Array.from({ length: g.int(5) }, () => [g.pick(keys), g.chance(0.7) ? { s: clean(g, 6) } : cleanValue(g)] as [string, V]),
    scopes: Array.from({ length: 1 + g.int(2) }, () => ({
      attrs: g.chance(0.4) ? ([['scope.attr', cleanValue(g)]] as Attrs) : undefined,
      logs: Array.from({ length: 1 + g.int(6) }, (): LogM => {
        const t = NOW - BigInt(g.int(3600)) * 1_000_000_000n - BigInt(g.int(1000))
        const timeless = g.chance(0.2)
        return {
          time: timeless ? undefined : t,
          observed: timeless || g.chance(0.5) ? t + 7n : undefined,
          severity: g.int(25),
          severityText: g.chance(0.5) ? g.pick(['INFO', 'warn', 'Érreur']) : undefined,
          body: g.chance(0.85) ? (g.chance(0.7) ? { s: g.text(30) } : g.value()) : undefined,
          attrs: Array.from({ length: g.int(4) }, () => [g.pick(['http.status', 'user.id', 'a', 'a.b', 'é', '1x']), cleanValue(g)] as [string, V]),
          flags: g.chance(0.3) ? 1 : undefined,
          traceId: g.chance(0.4) ? g.id(16) : g.chance(0.2) ? new Uint8Array(16) : undefined,
          spanId: g.chance(0.4) ? g.id(8) : undefined,
        }
      }),
    })),
  }))
}

function lokiRequest(g: Gen): { streams: LokiStreamM[]; labels: [string, string][][]; json: unknown } {
  const labels: [string, string][][] = []
  const streams: LokiStreamM[] = Array.from({ length: 1 + g.int(3) }, () => {
    const ls: [string, string][] = Object.entries(
      Object.fromEntries(Array.from({ length: 1 + g.int(4) }, () => [g.pick(['job', 'instance', 'service_name', 'env', '_x', 'Zé'.replace('é', 'e')]), clean(g, 6) || 'v'])),
    )
    labels.push(ls)
    const text = `{${ls.map(([n, v]) => `${n}=${JSON.stringify(v)}`).join(', ')}}`
    return {
      labels: text,
      entries: Array.from({ length: 1 + g.int(6) }, () => ({
        ts: NOW - BigInt(g.int(3600)) * 1_000_000_000n - BigInt(g.int(999_999_999)),
        line: g.text(40),
        md: g.chance(0.5) ? Object.entries(Object.fromEntries(Array.from({ length: 1 + g.int(3) }, () => [g.pick(['trace_id', 'user', 'level', 'k_1']), clean(g, 5)]))) : undefined,
      })),
    }
  })
  const json = { streams: streams.map((s, i) => ({ stream: Object.fromEntries(labels[i]!), values: s.entries.map((e) => (e.md ? [String(e.ts), e.line, Object.fromEntries(e.md)] : [String(e.ts), e.line])) })) }
  return { streams, labels, json }
}

// ─────────────────────────────── tests ───────────────────────────────

describe('OTLP/HTTP logs and Loki push', () => {
  it('are not served unless INGEST_SIGNALS enables logs', async () => {
    const tenant = newTenant()
    const k = await makeKey(tenant)
    for (const path of ['/v1/logs', '/loki/api/v1/push']) {
      const res = await postSignal(path, k, '{}', 'application/json', { env: { INGEST_SIGNALS: 'traces' } })
      expect(res.status).toBe(404)
    }
  })

  it('maps OTLP resources, scopes and records to stream labels, metadata and columns', async () => {
    const tenant = newTenant()
    const k = await makeKey(tenant)
    const rs: LogResourceM[] = [
      {
        attrs: [
          ['service.name', { s: 'api' }], ['k8s.pod.name', { s: 'p-1' }], ['host.name', { s: 'h' }], ['service.instance.id', { s: 'i-1' }],
          ['deployment.environment.name', { s: 'prod' }], ['process.pid', { i: 42n }], ['k8s.cluster.name', { s: '' }],
        ],
        scopes: [{
          attrs: [['lib.x', { b: true }]],
          logs: [
            { time: NOW, severity: 9, severityText: 'INFO', body: { s: 'hello' }, attrs: [['http.status', { i: 200n }], ['a', { l: [['b', { i: 1n }], ['c', { l: [['d', { s: 'x' }]] }]] }], ['a.b', { s: 'y' }]], traceId: new Uint8Array(16).fill(0xab), spanId: new Uint8Array(8).fill(0xcd), flags: 1 },
            { observed: NOW + 1n, body: { l: [['z', { d: 1.5 }], ['a', { a: [{ s: 'q' }, { i: 3n }] }]] } },
            { body: { s: 'no timestamp at all' } },
          ],
        }],
      },
      { attrs: [], scopes: [{ logs: [{ time: NOW + 2n, body: { b: false } }] }] },
    ]
    const res = await postSignal('/v1/logs', k, logsProto(rs), 'application/x-protobuf')
    expect(res.status).toBe(200)
    expect(partialProto(new Uint8Array(await res.arrayBuffer()))).toEqual([1, '1 log record without a timestamp'])
    const stored = order(await storedLogs(DEFAULT_MAP, tenant))
    const api = stored.filter((s) => s.labels.some(([n, v]) => n === 'service_name' && v === 'api'))
    expect(api[0]!.labels).toEqual([['deployment_environment_name', 'prod'], ['service_name', 'api']])
    expect(api[0]!.streamId).toBe(-6885192872746987382n) // computed in Python
    const first = api.find((s) => s.line === 'hello')!
    expect(first.metadata).toEqual([['a_b', '1;y'], ['a_c_d', 'x'], ['host_name', 'h'], ['http_status', '200'], ['k8s_pod_name', 'p-1'], ['lib_x', 'true'], ['process_pid', '42'], ['service_instance_id', 'i-1']])
    expect([first.ts, first.severity, first.severityText, first.traceId, first.spanId, first.flags]).toEqual([NOW, 9, 'INFO', 'ab'.repeat(16), 'cd'.repeat(8), 1])
    const second = api.find((s) => s.ts === NOW + 1n)!
    expect([second.line, second.observed]).toEqual(['{"a":["q",3],"z":1.5}', NOW + 1n])
    const other = stored.find((s) => s.line === 'false')!
    expect(other.labels).toEqual([['service_name', 'unknown_service']])
    expect(other.streamId).toBe(-8006275101411530976n)
    expect(stored.length).toBe(3)
  })

  it('stream ids are series ids of the stream labels (BATCH.md)', async () => {
    const tenant = newTenant()
    const k = await makeKey(tenant)
    const vectors: [bigint, [string, string][]][] = [
      [6447695193390096079n, [['job', 'api'], ['service_name', 'checkout']]],
      [-8985038429467426396n, [['app', 'Zürich'], ['emoji', '🌡'], ['service_name', 'x']]],
    ]
    const json = { streams: vectors.map(([, l]) => ({ stream: Object.fromEntries([...l].reverse()), values: [[String(NOW), 'x']] })) }
    expect((await postSignal('/loki/api/v1/push', k, JSON.stringify(json), 'application/json')).status).toBe(204)
    const stored = await storedLogs(DEFAULT_MAP, tenant)
    for (const [id, l] of vectors) {
      const s = stored.find((x) => x.streamId === id)!
      expect(s.labels).toEqual(l)
      expect(refSeriesId(l)).toBe(id)
    }
  })

  it('Loki push: protobuf with snappy and JSON (also gzip) store exactly the entries; 204', async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const tenant = newTenant()
      const k = await makeKey(tenant)
      const { streams, labels, json } = lokiRequest(new Gen(rng(seed)))
      const mode = seed % 3
      const body = mode === 0 ? lokiProto(streams) : mode === 1 ? JSON.stringify(json) : await gzip(te.encode(JSON.stringify(json)))
      const res = await postSignal('/loki/api/v1/push', k, body, mode === 0 ? 'application/x-protobuf' : 'application/json', { headers: mode === 2 ? { 'Content-Encoding': 'gzip' } : {} })
      expect(res.status, `seed ${seed}: ${await res.clone().text()}`).toBe(204)
      expect(order(await storedLogs(DEFAULT_MAP, tenant)), `seed ${seed}`).toEqual(order(expectedLoki(streams, labels)))
    }
  })

  it('OTLP logs round-trip random requests (property), protobuf, JSON and gzip', async () => {
    for (let seed = 200; seed < 236; seed++) {
      const tenant = newTenant()
      const k = await makeKey(tenant)
      const rs = otlpRequest(new Gen(rng(seed)))
      const mode = seed % 3
      const raw = mode === 1 ? te.encode(logsJson(rs)) : logsProto(rs)
      const res = await postSignal('/v1/logs', k, mode === 2 ? await gzip(raw) : raw, mode === 1 ? 'application/json' : 'application/x-protobuf', { headers: mode === 2 ? { 'Content-Encoding': 'gzip' } : {} })
      expect(res.status, `seed ${seed}`).toBe(200)
      const want = expectedOtlp(rs).filter((x) => x.ts !== undefined)
      expect(order(await storedLogs(DEFAULT_MAP, tenant)), `seed ${seed}`).toEqual(order(want))
    }
  })

  it('refuses each invalid OTLP record on its own, counted in partial_success', async () => {
    const tenant = newTenant()
    const k = await makeKey(tenant)
    const many = Array.from({ length: 129 }, (_, i) => [`m${i}`, { s: 'v' }] as [string, V])
    const bad: [string, LogM][] = [
      ['severity number above 24', { time: NOW, severity: 30 }],
      ['trace_id that is not 16 bytes', { time: NOW, traceId: new Uint8Array(10) }],
      ['span_id that is not 8 bytes', { time: NOW, spanId: new Uint8Array(3) }],
      ['log line over 256 KiB', { time: NOW, body: { s: 'x'.repeat(262_145) } }],
      ['older than the accept window', { time: NOW - 25n * 60n * MIN }],
      ['too far in the future', { time: NOW + 10n * MIN }],
      ['metadata value over 8,192 bytes or with a NUL byte', { time: NOW, attrs: [['k', { s: 'a\u0000b' }]] }],
      ['more than 128 structured metadata entries', { time: NOW, attrs: many }],
      ['without a timestamp', {}],
      ['attribute with an empty key', { time: NOW, attrs: [['', { s: 'v' }]] }],
      ['severity text over 1,024 bytes', { time: NOW, severityText: 's'.repeat(1025) }],
    ]
    const good: LogM[] = [{ time: NOW, body: { s: 'ok' } }, { time: NOW + 1n, body: { s: 'x'.repeat(262_144) } }]
    const rs: LogResourceM[] = [
      { attrs: [['service.name', { s: 'api' }]], scopes: [{ logs: [...good, ...bad.map((b) => b[1])] }] },
      { attrs: [['service.name', { s: 'v'.repeat(8193) }]], scopes: [{ logs: [{ time: NOW }, { time: NOW }] }] },
    ]
    for (const json of [false, true]) {
      const t = json ? newTenant() : tenant
      const kk = json ? await makeKey(t) : k
      const res = await postSignal('/v1/logs', kk, json ? logsJson(rs) : logsProto(rs), json ? 'application/json' : 'application/x-protobuf')
      expect(res.status).toBe(200)
      let rejected: number
      let message: string
      if (json) {
        const p = ((await res.json()) as { partialSuccess: { rejectedLogRecords: string; errorMessage: string } }).partialSuccess
        ;[rejected, message] = [Number(p.rejectedLogRecords), p.errorMessage]
      } else [rejected, message] = partialProto(new Uint8Array(await res.arrayBuffer()))
      expect(rejected).toBe(bad.length + 2)
      for (const [why] of bad) expect(message).toContain(why)
      expect(message).toContain('2 stream label value over 8,192 bytes')
      expect((await storedLogs(DEFAULT_MAP, t)).map((s) => s.line.length).sort()).toEqual([2, 262_144])
    }
  })

  it('Loki push: invalid entries and streams are refused with 400, the rest written', async () => {
    const tenant = newTenant()
    const k = await makeKey(tenant)
    const json = {
      streams: [
        { stream: { job: 'ok' }, values: [[String(NOW), 'a'], ['12x', 'bad ts'], [String(NOW - 25n * 60n * MIN), 'old'], [String(NOW + 1n), 'b', { user: 'u', 'not.ok': 'x' }], [String(NOW + 2n), 'x'.repeat(262_145)]] },
        { stream: { 'a.b': 'x' }, values: [[String(NOW), 'c'], [String(NOW), 'd']] },
        { stream: {}, values: [[String(NOW), 'e']] },
        { stream: { job: 'ok2' }, values: [[String(NOW), 'f', { k: 'v' }]] },
      ],
    }
    const res = await postSignal('/loki/api/v1/push', k, JSON.stringify(json), 'application/json')
    expect(res.status).toBe(400)
    const msg = await res.text()
    expect(msg).toMatch(/^rejected 7 of 9 entries \(/)
    for (const why of ['log timestamp outside 1970 to 2262, or malformed', 'older than the accept window', 'structured metadata name breaks', 'log line over 256 KiB', '2 stream label name breaks', '1 stream without labels']) expect(msg).toContain(why)
    expect(msg).toMatch(/; 2 written$/)
    expect((await storedLogs(DEFAULT_MAP, tenant)).map((s) => s.line).sort()).toEqual(['a', 'f'])

    // Protobuf: labels that do not parse, a repeated label name, repeated metadata names.
    const t2 = newTenant()
    const k2 = await makeKey(t2)
    const body = lokiProto([
      { labels: '{job="x", job="y"}', entries: [{ ts: NOW, line: 'dup label' }] },
      { labels: 'job=x', entries: [{ ts: NOW, line: 'no braces' }] },
      { labels: '{job="a\\"b\\u00e9\\x41"}', entries: [{ ts: NOW, line: 'escaped', md: [['m', '1'], ['m', '2']] }, { ts: NOW + 1n, line: 'kept', md: [['m', '1']] }] },
    ])
    const r2 = await postSignal('/loki/api/v1/push', k2, body, 'application/x-protobuf')
    expect(r2.status).toBe(400)
    const m2 = await r2.text()
    expect(m2).toContain('1 stream label name repeated')
    expect(m2).toContain('1 stream labels do not parse')
    expect(m2).toContain('1 structured metadata name repeated')
    const stored = await storedLogs(DEFAULT_MAP, t2)
    expect(stored.map((s) => [s.line, s.labels, s.metadata])).toEqual([['kept', [['job', 'a"béA']], [['m', '1']]]])
  })

  it('Loki push: encodings and content types', async () => {
    const tenant = newTenant()
    const k = await makeKey(tenant)
    const { streams } = lokiRequest(new Gen(rng(77)))
    expect((await postSignal('/loki/api/v1/push', k, lokiProto(streams), 'application/x-protobuf', { headers: { 'Content-Encoding': 'gzip' } })).status).toBe(415)
    expect((await postSignal('/loki/api/v1/push', k, lokiProto(streams), 'text/plain')).status).toBe(415)
    expect((await postSignal('/loki/api/v1/push', k, new Uint8Array([0xff, 0xff, 0xff]), 'application/x-protobuf')).status).toBe(400)
    expect((await postSignal('/loki/api/v1/push', k, '{"streams":{}}', 'application/json')).status).toBe(400)
    expect((await postSignal('/loki/api/v1/push', k, '{"streams":[{"stream":{"a":"b"},"values":[["1"]]}]}', 'application/json')).status).toBe(400)
    expect(await storedLogs(DEFAULT_MAP, tenant)).toEqual([])
  })

  it('takes the tenant from the credential only (X-Scope-OrgID is ignored)', async () => {
    const a = newTenant('a')
    const b = newTenant('b')
    const ka = await makeKey(a)
    const json = { streams: [{ stream: { job: 'x', tenant: b, __tenant_id__: b }, values: [[String(NOW), 'line']] }] }
    expect((await postSignal('/loki/api/v1/push', ka, JSON.stringify(json), 'application/json', { headers: { 'X-Scope-OrgID': b } })).status).toBe(204)
    const rs: LogResourceM[] = [{ attrs: [['tenant', { s: b }]], scopes: [{ logs: [{ time: NOW, attrs: [['tenant', { s: b }]] }] }] }]
    expect((await postSignal('/v1/logs', ka, logsProto(rs), 'application/x-protobuf', { headers: { 'X-Scope-OrgID': b } })).status).toBe(200)
    expect((await storedLogs(DEFAULT_MAP, a)).length).toBe(2)
    expect(await storedLogs(DEFAULT_MAP, b)).toEqual([])
  })

  it('routes Loki streams by job and instance, OTLP logs by resource, to the logs pool', async () => {
    const tenant = newTenant()
    const k = await makeKey(tenant)
    const json = { streams: ['a', 'b', 'c', 'd'].map((j) => ({ stream: { job: j, instance: `${j}:1`, other: 'z' }, values: [[String(NOW), j]] })) }
    expect((await postSignal('/loki/api/v1/push', k, JSON.stringify(json), 'application/json')).status).toBe(204)
    const rs: LogResourceM[] = [{ attrs: [['service.name', { s: 'svc' }], ['service.instance.id', { s: 'i9' }]], scopes: [{ logs: [{ time: NOW, body: { s: 'otlp' } }] }] }]
    expect((await postSignal('/v1/logs', k, logsProto(rs), 'application/x-protobuf')).status).toBe(200)
    const bySlot = await storedBatches(signalPool(DEFAULT_MAP, 'logs'), tenant)
    const where = new Map<string, number>()
    const { decodeLogBatch } = await import('./otelhelpers')
    for (const [slot, batches] of bySlot) for (const b of batches) for (const r of decodeLogBatch(b)) where.set(r.line, slot)
    for (const j of ['a', 'b', 'c', 'd']) expect(where.get(j)).toBe(slotFor(DEFAULT_MAP, tenant, `job=${j}\u0000instance=${j}:1`))
    expect(where.get('otlp')).toBe(slotFor(DEFAULT_MAP, tenant, 'job=svc\u0000instance=i9'))
    expect([...(await storedBatches(DEFAULT_MAP, tenant)).values()].flat()).toEqual([])
  })
})
