import { type Attrs, type LogRow, type SpanEntry, type SpanRow, encodeLogBatch, encodeSpanBatch } from '../../engine/wasm/test/signal'

/**
 * Deterministic span and log workloads for the local measurements (measure-signals.test.ts,
 * profile.test.ts): spans of 20 services x 5 instances, 200 span names, traces of about 12 spans,
 * 7 attributes a span (route, method, status code, a high-cardinality user id, a peer name, a
 * bool, and in 30% a SQL statement of 40 to 200 bytes); no events or links (the test encoder
 * writes none). Log lines of 80 to 260 bytes of logfmt with a random request id, 50 streams of 3
 * labels, 2 to 4 metadata entries, 30% with trace ids. Batches of about 1 MiB (what edge cuts).
 */
export function rnd(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { int: (n: number) => Math.floor(next() * n), chance: (p: number) => next() < p }
}
export const T0 = BigInt(Date.UTC(2026, 10, 18, 12)) * 1_000_000n
export const MiB = 1 << 20
const ids = (r: ReturnType<typeof rnd>, n: number) => Uint8Array.from({ length: n }, () => 1 + r.int(255))
const word = (r: ReturnType<typeof rnd>, n: number) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[r.int(26)]).join('')

export function spanBatches(count: number, seed = 7): Uint8Array[] {
  const r = rnd(seed)
  const entries: SpanEntry[] = Array.from({ length: 100 }, (_, i) => ({
    resourceFp: BigInt(i + 1),
    resource: [['deployment.environment.name', { s: 'prod' }], ['host.name', { s: `host-${i}` }], ['service.instance.id', { s: `svc-${i % 20}-${i % 5}` }], ['service.name', { s: `svc-${i % 20}` }]] as Attrs,
    scopeName: 'io.opentelemetry.http',
    scopeVersion: '1.2.0',
  }))
  const out: Uint8Array[] = []
  let t = T0
  for (let b = 0; b < count; b++) {
    const rows: SpanRow[] = []
    let bytes = 4096
    while (bytes < MiB - 64 * 1024) {
      const traceId = ids(r, 16)
      const entry = r.int(100)
      const root = ids(r, 8)
      for (let k = 0; k < 6 + r.int(13); k++) {
        const start = t + BigInt(k * 1_000_000)
        const attrs: Attrs = [
          ['enduser.id', { s: `user-${r.int(100_000)}` }],
          ['http.request.method', { s: ['GET', 'POST', 'PUT'][r.int(3)]! }],
          ['http.response.status_code', { i: BigInt([200, 200, 200, 404, 500][r.int(5)]!) }],
          ['http.route', { s: `/api/v1/${word(r, 6)}` }],
          ['net.peer.name', { s: `peer-${r.int(50)}` }],
          ['retry', { b: r.chance(0.1) }],
        ]
        if (r.chance(0.3)) attrs.splice(0, 0, ['db.statement', { s: `SELECT ${word(r, 20 + r.int(160))} FROM t WHERE id = ?` }])
        rows.push({ entry, traceId, spanId: k === 0 ? root : ids(r, 8), parentSpanId: k === 0 ? undefined : root, start, end: start + BigInt(r.int(5e8)), kind: 1 + r.int(5), status: r.chance(0.05) ? 2 : 0, name: `op-${r.int(200)}`, attrs })
        bytes += 94 + 40 + attrs.reduce((a, [k2, v]) => a + k2.length + 9 + ('s' in v ? v.s.length : 8), 0)
      }
      t += 10_000_000n
    }
    out.push(encodeSpanBatch(entries, rows))
  }
  return out
}

export function logBatches(count: number, seed = 11): Uint8Array[] {
  const r = rnd(seed)
  const streams = Array.from({ length: 50 }, (_, i) => ({ labels: { service_name: `svc-${i % 20}`, k8s_namespace_name: `ns-${i % 5}`, deployment_environment_name: 'prod' } }))
  const out: Uint8Array[] = []
  let t = T0
  for (let b = 0; b < count; b++) {
    const rows: LogRow[] = []
    let bytes = 4096
    while (bytes < MiB - 64 * 1024) {
      const line = `level=${['info', 'warn', 'error'][r.int(3)]} msg="${word(r, 10 + r.int(60))}" request_id=${word(r, 16)} duration=${r.int(900)}ms route=/api/${word(r, 8)} ${word(r, 10 + r.int(100))}`.slice(0, 260)
      const md: [string, string][] = [['pod', `pod-${r.int(40)}`], ['service_instance_id', `inst-${r.int(5)}`]]
      if (r.chance(0.5)) md.push(['user', String(r.int(1000))])
      if (r.chance(0.3)) md.push(['zone', `z${r.int(3)}`])
      md.sort((a, b2) => (a[0] < b2[0] ? -1 : 1))
      rows.push({ entry: r.int(50), ts: t, line, metadata: md, severity: 9, ...(r.chance(0.3) ? { traceId: ids(r, 16), spanId: ids(r, 8) } : {}) })
      bytes += 64 + 24 + line.length + md.reduce((a, [k, v]) => a + 4 + k.length + v.length, 0) + 40
      t += 1_000_000n
    }
    out.push(encodeLogBatch(streams, rows))
  }
  return out
}

