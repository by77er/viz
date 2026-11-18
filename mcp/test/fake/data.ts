/**
 * Deterministic synthetic telemetry for the fake query service. NOT real data.
 *
 * Every tenant gets the series the three example dashboards read (service RED, Kubernetes
 * nodes, viz ingest), on a 60 s grid over the eight hours before NOW, with incidents that
 * breach the examples' thresholds (checkout errors and latency, a node out of memory, a
 * cell that has not flushed). Values are a pure function of (tenant, series, time).
 * Tenant-specific extras (marker metrics, injection strings) are added by the caller.
 */
import type { Labels, Sample, SeriesSource, Storage } from './storage'

/** The tests' "now": 2026-11-18T12:00:00Z. */
export const NOW = Date.UTC(2026, 10, 18, 12) / 1000
export const NOW_MS = NOW * 1000
export const STEP = 60
export const SPAN = 8 * 3600

export type Meta = Record<string, { type: string; help: string; unit: string }[]>

export interface FakeStorage extends Storage {
  add(labels: Labels, f: (t: number) => number, kind?: 'gauge' | 'counter'): void
  setMeta(name: string, type: string, help: string, unit?: string): void
}

function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}
const noise = (seed: number, k: number): number => {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(k | 0, 0x85ebca6b)) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** A series held as two sorted arrays; window lookups are binary searches. */
function arraySeries(labels: Labels, ts: Float64Array, vs: Float64Array): SeriesSource {
  const lower = (t: number) => {
    let lo = 0
    let hi = ts.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (ts[m]! <= t) lo = m + 1
      else hi = m
    }
    return lo // first index with ts > t
  }
  return {
    labels,
    samples(from, to) {
      const a = lower(from)
      const b = lower(to)
      const out: Sample[] = []
      for (let i = a; i < b; i++) out.push({ t: ts[i]!, v: vs[i]! })
      return out
    },
    latest(from, to) {
      const b = lower(to) - 1
      return b >= 0 && ts[b]! > from ? { t: ts[b]!, v: vs[b]! } : undefined
    },
  }
}

export function fakeStorage(): FakeStorage {
  const series: SeriesSource[] = []
  const meta: Meta = {}
  const n = SPAN / STEP + 1
  return {
    all: () => series,
    metadata: () => meta,
    add(labels, f, kind = 'gauge') {
      const ts = new Float64Array(n)
      const vs = new Float64Array(n)
      let acc = 0
      for (let i = 0; i < n; i++) {
        const t = NOW - SPAN + i * STEP
        ts[i] = t
        if (kind === 'counter') {
          acc += Math.max(0, f(t)) * STEP
          vs[i] = acc
        } else vs[i] = f(t)
      }
      series.push(arraySeries(labels, ts, vs))
    },
    setMeta(name, type, help, unit = '') {
      meta[name] = [{ type, help, unit }]
    },
  }
}

/** The last 30 minutes before NOW: checkout's incident, node-b's memory, cell c2's flush stall. */
const incident = (t: number): boolean => t > NOW - 1800

const LE = ['0.05', '0.1', '0.25', '0.5', '1', '2.5', '5', '+Inf']

/** Fraction of requests at or under `le` for a log-normal latency with this median. */
function cdf(le: string, median: number): number {
  if (le === '+Inf') return 1
  const x = Math.log(Number(le) / median) / 0.6
  const tt = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2))
  const erf = 1 - ((((1.061405429 * tt - 1.453152027) * tt + 1.421413741) * tt - 0.284496736) * tt + 0.254829592) * tt * Math.exp(-(x * x) / 2)
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}

export function standardTelemetry(tenant: string): FakeStorage {
  const s = fakeStorage()
  const seed = hash(tenant)
  const wobble = (k: string, t: number) => 1 + 0.08 * Math.sin((t / 3600) * 2 * Math.PI + (hash(k) % 7)) + 0.04 * (noise(seed ^ hash(k), Math.floor(t / STEP)) - 0.5)

  // --- service RED ---
  const services = { checkout: ['/cart', '/pay', '/confirm'], payments: ['/charge', '/refund'], cart: ['/items', '/add'] } as Record<string, string[]>
  for (const env of ['prod', 'staging']) {
    for (const [svc, routes] of Object.entries(services)) {
      for (const route of routes) {
        const base = (env === 'prod' ? 20 : 2) * (route.length % 3 + 1)
        const errShare = (t: number) => (svc === 'checkout' && env === 'prod' && incident(t) ? 0.06 : 0.0004)
        for (const status of ['200', '404', '500', '503']) {
          const share = (t: number) => (status === '200' ? 1 - 0.01 - errShare(t) : status === '404' ? 0.01 : errShare(t) / 2)
          s.add({ __name__: 'http_server_requests_total', env, service: svc, route, status }, (t) => base * share(t) * wobble(`${svc}${route}${status}`, t), 'counter')
        }
        const median = (t: number) => (svc === 'checkout' && env === 'prod' && incident(t) ? 0.45 : 0.06)
        for (const le of LE) s.add({ __name__: 'http_server_request_duration_seconds_bucket', env, service: svc, route, le }, (t) => base * cdf(le, median(t)) * wobble(`${svc}${route}`, t), 'counter')
      }
    }
    for (const peer of ['postgres', 'payments-api']) {
      for (const outcome of ['ok', 'error']) {
        s.add({ __name__: 'http_client_requests_total', env, service: 'checkout', peer_service: peer, outcome }, (t) => (env === 'prod' ? 30 : 3) * (outcome === 'ok' ? 0.995 : 0.005) * wobble(peer + outcome, t), 'counter')
      }
      for (const le of LE) s.add({ __name__: 'http_client_request_duration_seconds_bucket', env, service: 'checkout', peer_service: peer, le }, (t) => (env === 'prod' ? 30 : 3) * cdf(le, peer === 'postgres' ? 0.01 : 0.08) * wobble(peer, t), 'counter')
    }
  }
  s.setMeta('http_server_requests_total', 'counter', 'HTTP requests served, by route and status.')
  s.setMeta('http_server_request_duration_seconds_bucket', 'histogram', 'HTTP request latency.', 'seconds')

  // --- Kubernetes nodes ---
  const nodes = ['node-a', 'node-b', 'node-c', 'node-d']
  for (const node of nodes) {
    const cluster = 'prod-eu'
    s.add({ __name__: 'kube_node_info', cluster, node }, () => 1)
    s.add({ __name__: 'kube_node_status_condition', cluster, node, condition: 'Ready', status: 'true' }, () => 1)
    for (const cpu of ['0', '1']) {
      const idle = node === 'node-c' ? 0.1 : 0.55
      s.add({ __name__: 'node_cpu_seconds_total', cluster, node, cpu, mode: 'idle' }, (t) => idle * wobble(node + cpu, t), 'counter')
      s.add({ __name__: 'node_cpu_seconds_total', cluster, node, cpu, mode: 'user' }, (t) => (1 - idle) * wobble(node + cpu + 'u', t), 'counter')
    }
    const total = 16e9
    s.add({ __name__: 'node_memory_MemTotal_bytes', cluster, node }, () => total)
    s.add({ __name__: 'node_memory_MemAvailable_bytes', cluster, node }, (t) => (node === 'node-b' && incident(t) ? 0.04 : 0.45) * total * wobble(node + 'm', t))
    s.add({ __name__: 'node_filesystem_size_bytes', cluster, node, mountpoint: '/' }, () => 100e9)
    s.add({ __name__: 'node_filesystem_avail_bytes', cluster, node, mountpoint: '/' }, () => (node === 'node-a' ? 0.2 : 0.6) * 100e9)
    s.add({ __name__: 'node_load5', cluster, node }, (t) => (node === 'node-c' ? 1.7 : 0.6) * wobble(node + 'l', t))
    for (const device of ['eth0', 'lo']) {
      s.add({ __name__: 'node_network_receive_bytes_total', cluster, node, device }, (t) => 2e6 * wobble(node + device, t), 'counter')
      s.add({ __name__: 'node_network_transmit_bytes_total', cluster, node, device }, (t) => 1e6 * wobble(node + device + 't', t), 'counter')
    }
    s.add({ __name__: 'kube_node_status_allocatable', cluster, node, resource: 'pods' }, () => 110)
    for (let p = 0; p < 3; p++) {
      const pod = `${node}-pod-${p}`
      s.add({ __name__: 'kube_pod_info', cluster, node, pod, namespace: 'default' }, () => 1)
      s.add({ __name__: 'kube_pod_container_status_restarts_total', cluster, pod, namespace: 'default' }, () => (pod === 'node-b-pod-1' ? 0.002 : 0), 'counter')
    }
  }

  // --- viz ingest pipeline ---
  for (const cell of ['c1', 'c2']) {
    for (const signal of ['metrics', 'traces', 'logs']) {
      s.add({ __name__: 'viz_ingest_samples_total', cell, signal, outcome: 'accepted' }, (t) => 5000 * wobble(cell + signal, t), 'counter')
      for (const reason of ['too_old', 'invalid']) s.add({ __name__: 'viz_ingest_samples_total', cell, signal, outcome: 'rejected', reason }, (t) => 20 * wobble(cell + signal + reason, t), 'counter')
      for (const status of ['200', '429', '503']) s.add({ __name__: 'viz_ingest_requests_total', cell, signal, status }, (t) => (status === '200' ? 50 : 0.02) * wobble(cell + signal + status, t), 'counter')
      for (const shard of ['0', '1']) for (const le of LE) s.add({ __name__: 'viz_ingest_ack_duration_seconds_bucket', cell, signal, shard, le }, (t) => 50 * cdf(le, cell === 'c2' ? 0.12 : 0.05) * wobble(cell + shard, t), 'counter')
      s.add({ __name__: 'viz_shard_flushed_bytes_total', cell, signal }, (t) => 1e6 * wobble(cell + signal + 'b', t), 'counter')
    }
    s.add({ __name__: 'viz_shard_oldest_unflushed_seconds', cell }, (t) => (cell === 'c2' && incident(t) ? 150 + (t - (NOW - 1800)) / 60 : 12))
    for (const le of LE) s.add({ __name__: 'viz_shard_flush_duration_seconds_bucket', cell, le }, (t) => 0.2 * cdf(le, 0.8) * wobble(cell + 'f', t), 'counter')
    for (const stage of ['encode', 'put']) s.add({ __name__: 'viz_shard_flush_failures_total', cell, stage }, () => 0, 'counter')
    s.add({ __name__: 'viz_ledger_commit_lag_seconds', cell }, (t) => 2 * wobble(cell + 'lag', t))
    for (const shard of ['0', '1']) {
      s.add({ __name__: 'viz_shard_buffer_bytes', cell, shard }, () => (cell === 'c2' && shard === '1' ? 0.85 : 0.3) * 64e6)
      s.add({ __name__: 'viz_shard_buffer_limit_bytes', cell, shard }, () => 64e6)
      s.add({ __name__: 'viz_shard_active_series', cell, shard }, () => 12000 + Number(shard) * 500)
    }
    s.add({ __name__: 'viz_compaction_pending_files', cell }, () => 120)
  }
  return s
}
