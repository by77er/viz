/**
 * Deterministic synthetic telemetry for the development mock. NOT real data.
 *
 * Every value is a pure function of (series, time), so any time range can be queried and
 * the same query always returns the same numbers. Samples sit on a 15 s scrape grid.
 * Counters are built from a 24 h table of per-scrape increments (daily shape + hourly wobble
 * + hashed noise + incident windows) and its prefix sum, so they are monotonic and exact.
 */
import type { Labels, Sample, SeriesSource, Storage } from './storage'

export const SCRAPE_INTERVAL = 15
export const DAY_SAMPLES = 86400 / SCRAPE_INTERVAL
/** Series begin here (2026-01-01T00:00:00Z); earlier queries return nothing. */
export const SERIES_START = Date.UTC(2026, 0, 1) / 1000
const K0 = SERIES_START / SCRAPE_INTERVAL

/** Deterministic hash of two integers to [0, 1). */
export function hash01(seed: number, k: number): number {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(k | 0, 0x85ebca6b)) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d)
  h ^= h >>> 15
  h = Math.imul(h, 0x846ca68b)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

function strSeed(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 erf, |error| < 1.5e-7). */
function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}

const TAU = Math.PI * 2

interface ServiceDef {
  name: string
  routes: { route: string; rps: number }[]
  /** Median latency in seconds. */
  median: number
  pods: string[]
  node: string[]
}

export const SERVICES: ServiceDef[] = [
  {
    name: 'checkout',
    routes: [{ route: '/cart', rps: 42 }, { route: '/pay', rps: 18 }, { route: '/confirm', rps: 9 }],
    median: 0.085,
    pods: ['checkout-6b7f9-x2k4p', 'checkout-6b7f9-m8qvz', 'checkout-6b7f9-c5jtn'],
    node: ['node-a', 'node-b', 'node-c'],
  },
  {
    name: 'catalog',
    routes: [{ route: '/search', rps: 120 }, { route: '/product', rps: 210 }, { route: '/category', rps: 65 }],
    median: 0.022,
    pods: ['catalog-9c4d2-7hwlr', 'catalog-9c4d2-pz3ks', 'catalog-9c4d2-d6nfb'],
    node: ['node-a', 'node-b', 'node-c'],
  },
  {
    name: 'auth',
    routes: [{ route: '/login', rps: 14 }, { route: '/token', rps: 95 }, { route: '/logout', rps: 4 }],
    median: 0.012,
    pods: ['auth-5f8a1-q9xgc', 'auth-5f8a1-t2vbm', 'auth-5f8a1-k7rwd'],
    node: ['node-b', 'node-c', 'node-a'],
  },
  {
    name: 'orders',
    routes: [{ route: '/orders', rps: 30 }, { route: '/orders/:id', rps: 55 }, { route: '/refund', rps: 1.2 }],
    median: 0.14,
    pods: ['orders-3e6b8-w4ypj', 'orders-3e6b8-n1sfh', 'orders-3e6b8-g8czt'],
    node: ['node-c', 'node-a', 'node-b'],
  },
]

export const STATUSES = ['200', '400', '500'] as const
export const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, Infinity] as const
const SIGMA = 0.9

/** Load multiplier for sample-of-day k: daily cycle, hourly wobble, per-service phase. */
function load(k: number, seed: number): number {
  const day = k / DAY_SAMPLES
  const phase = (seed % 97) / 97
  return (
    1 +
    0.35 * Math.sin(TAU * (day - 0.3)) +
    0.12 * Math.sin(TAU * (day * 24 + phase)) +
    0.05 * Math.sin(TAU * (day * 24 * 7.3 + phase * 3))
  )
}

/** Incident windows: `checkout` degrades for 12 minutes starting at minute 40 of every 3rd hour. */
function incident(service: string, k: number): number {
  if (service !== 'checkout') return 0
  const minute = (k * SCRAPE_INTERVAL) / 60
  const inWindow = minute % 180
  if (inWindow < 40 || inWindow >= 52) return 0
  // Smooth ramp in and out.
  return Math.sin((Math.PI * (inWindow - 40)) / 12)
}

/** Stochastic rounding: the expected value is preserved and the result is an integer. */
function roundHashed(x: number, seed: number, k: number): number {
  const f = Math.floor(x)
  return f + (hash01(seed, k) < x - f ? 1 : 0)
}

class Table {
  readonly prefix: Float64Array
  readonly total: number
  constructor(inc: Float64Array) {
    this.prefix = new Float64Array(DAY_SAMPLES)
    let sum = 0
    for (let i = 0; i < DAY_SAMPLES; i++) {
      sum += inc[i]!
      this.prefix[i] = sum
    }
    this.total = sum
  }
  /** Counter value at absolute sample index k. */
  at(k: number): number | null {
    const rel = k - K0
    if (rel < 0) return null
    const day = Math.floor(rel / DAY_SAMPLES)
    return day * this.total + this.prefix[rel - day * DAY_SAMPLES]!
  }
}

function gridSeries(labels: Labels, at: (k: number) => number | null): SeriesSource {
  return {
    labels,
    samples(from, to) {
      const out: Sample[] = []
      const kTo = Math.floor(to / SCRAPE_INTERVAL)
      const kFrom = Math.floor(from / SCRAPE_INTERVAL) + 1
      for (let k = kFrom; k <= kTo; k++) {
        const v = at(k)
        if (v !== null) out.push({ t: k * SCRAPE_INTERVAL, v })
      }
      return out
    },
    latest(from, to) {
      const kFrom = Math.floor(from / SCRAPE_INTERVAL) + 1
      for (let k = Math.floor(to / SCRAPE_INTERVAL); k >= kFrom; k--) {
        const v = at(k)
        if (v !== null) return { t: k * SCRAPE_INTERVAL, v }
      }
      return undefined
    },
  }
}

function buildSeries(): SeriesSource[] {
  const out: SeriesSource[] = []

  for (const svc of SERVICES) {
    const svcSeed = strSeed(svc.name)
    const svcInc = new Float64Array(DAY_SAMPLES)

    // http_requests_total{job, service, route, status}
    for (const r of svc.routes) {
      const incs = STATUSES.map(() => new Float64Array(DAY_SAMPLES))
      const seed = strSeed(`${svc.name}${r.route}`)
      for (let k = 0; k < DAY_SAMPLES; k++) {
        const noise = 0.85 + 0.3 * hash01(seed, k)
        const expected = r.rps * SCRAPE_INTERVAL * load(k, svcSeed) * noise
        const errFrac = 0.004 + 0.09 * incident(svc.name, k)
        const badFrac = 0.02 + 0.01 * Math.sin(TAU * (k / DAY_SAMPLES) * 5)
        const n500 = roundHashed(expected * errFrac, seed + 1, k)
        const n400 = roundHashed(expected * badFrac, seed + 2, k)
        const n200 = Math.max(0, Math.round(expected) - n500 - n400)
        incs[0]![k] = n200
        incs[1]![k] = n400
        incs[2]![k] = n500
        svcInc[k]! += n200 + n400 + n500
      }
      STATUSES.forEach((status, i) => {
        const table = new Table(incs[i]!)
        out.push(
          gridSeries(
            { __name__: 'http_requests_total', job: 'api', service: svc.name, route: r.route, status },
            (k) => table.at(k),
          ),
        )
      })
    }

    // http_request_duration_seconds histogram per service, consistent with the request counts.
    const bucketInc = BUCKETS.map(() => new Float64Array(DAY_SAMPLES))
    const sumInc = new Float64Array(DAY_SAMPLES)
    for (let k = 0; k < DAY_SAMPLES; k++) {
      const n = svcInc[k]!
      const median = svc.median * (1 + 0.25 * (load(k, svcSeed) - 1) + 0.08 * (hash01(svcSeed + 7, k) - 0.5) + 4 * incident(svc.name, k))
      const mu = Math.log(median)
      BUCKETS.forEach((le, i) => {
        const frac = le === Infinity ? 1 : normCdf((Math.log(le) - mu) / SIGMA)
        bucketInc[i]![k] = Math.round(n * frac)
      })
      sumInc[k] = n * Math.exp(mu + (SIGMA * SIGMA) / 2)
    }
    BUCKETS.forEach((le, i) => {
      const table = new Table(bucketInc[i]!)
      out.push(
        gridSeries(
          { __name__: 'http_request_duration_seconds_bucket', job: 'api', service: svc.name, le: le === Infinity ? '+Inf' : String(le) },
          (k) => table.at(k),
        ),
      )
    })
    const countTable = new Table(svcInc)
    const sumTable = new Table(sumInc)
    out.push(gridSeries({ __name__: 'http_request_duration_seconds_count', job: 'api', service: svc.name }, (k) => countTable.at(k)))
    out.push(gridSeries({ __name__: 'http_request_duration_seconds_sum', job: 'api', service: svc.name }, (k) => sumTable.at(k)))

    // Per-pod gauges.
    svc.pods.forEach((pod, i) => {
      const seed = strSeed(pod)
      const labels = { job: 'kubelet', service: svc.name, pod, node: svc.node[i]! }
      const cpuBase = 0.15 + 1.1 * hash01(seed, 1)
      // One pod restarts every two hours and is absent for 12 minutes: a real gap in the data.
      const down = (k: number) => {
        if (pod !== 'checkout-6b7f9-x2k4p') return false
        const minute = ((k * SCRAPE_INTERVAL) / 60) % 120
        return minute >= 50 && minute < 62
      }
      const alive = (k: number) => k >= K0 && !down(k)
      out.push(
        gridSeries({ __name__: 'pod_cpu_usage_cores', ...labels }, (k) => {
          if (!alive(k)) return null
          const kd = ((k - K0) % DAY_SAMPLES + DAY_SAMPLES) % DAY_SAMPLES
          const v = cpuBase * (0.55 + 0.45 * load(kd, svcSeed)) * (0.9 + 0.2 * hash01(seed, k)) + 0.9 * incident(svc.name, kd)
          // A rare one-sample spike, to show that downsampling keeps extremes.
          const spike = hash01(seed + 3, k) > 0.9985 ? 1.4 : 0
          return Math.round((v + spike) * 1000) / 1000
        }),
      )
      out.push(
        gridSeries({ __name__: 'pod_memory_working_set_bytes', ...labels }, (k) => {
          if (!alive(k)) return null
          // Slow growth with a periodic collection (sawtooth), period 37–58 minutes.
          const period = 148 + Math.floor(hash01(seed, 2) * 84)
          const saw = ((k % period) + period) % period / period
          const base = (180 + 420 * hash01(seed, 4)) * 1024 * 1024
          return Math.round(base * (1 + 0.45 * saw) + 4e6 * hash01(seed + 5, k))
        }),
      )
      out.push(gridSeries({ __name__: 'up', job: 'kubelet', service: svc.name, instance: pod }, (k) => (k < K0 ? null : down(k) ? 0 : 1)))
    })
  }
  return out
}

const METADATA: Record<string, { type: string; help: string; unit: string }[]> = {
  http_requests_total: [{ type: 'counter', help: 'Total HTTP requests handled, by service, route and status code. (synthetic)', unit: '' }],
  http_request_duration_seconds: [{ type: 'histogram', help: 'HTTP request latency in seconds, by service. (synthetic)', unit: 'seconds' }],
  pod_cpu_usage_cores: [{ type: 'gauge', help: 'CPU cores in use per pod. (synthetic)', unit: 'cores' }],
  pod_memory_working_set_bytes: [{ type: 'gauge', help: 'Working-set memory per pod in bytes. (synthetic)', unit: 'bytes' }],
  up: [{ type: 'gauge', help: '1 if the last scrape of the target succeeded. (synthetic)', unit: '' }],
  viz_synthetic_series: [{ type: 'gauge', help: 'Two hundred slow sine waves: the speed harness\'s 200-series case. (synthetic)', unit: '' }],
}

/** Series in the 200-series speed case (e2e/measure.cjs); real/seed.ts writes the same series to the real API. */
export const SYNTHETIC_COUNT = 200

/** The labels of synthetic series i: ten services, five routes, four statuses. */
export function syntheticLabels(i: number): Labels {
  return {
    __name__: 'viz_synthetic_series',
    service: `svc-${String(i % 10).padStart(2, '0')}`,
    route: `/r/${Math.floor(i / 10) % 5}`,
    status: String(200 + 100 * (Math.floor(i / 50) % 4)),
  }
}

/** Its value at time t (epoch seconds), to four decimals: a slow sine around 3 (i + 1). */
export const syntheticValue = (i: number, t: number): number => Number((3 * (i + 1) + 2 * Math.sin(t / 600 + i)).toFixed(4))

function buildSynthetic(): SeriesSource[] {
  return Array.from({ length: SYNTHETIC_COUNT }, (_, i) =>
    gridSeries(syntheticLabels(i), (k) => (k < K0 ? null : syntheticValue(i, k * SCRAPE_INTERVAL))),
  )
}

let cached: SeriesSource[] | undefined

/** The synthetic data set (built once, lazily). */
export function syntheticStorage(): Storage {
  return {
    all: () => (cached ??= [...buildSeries(), ...buildSynthetic()]),
    metadata: () => METADATA,
  }
}
