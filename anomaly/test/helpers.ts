import type { DetectResult, Point, Series } from '../src/types.ts'

export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR
export const T0 = Date.UTC(2026, 0, 5) // a Monday, 00:00 UTC

/** Deterministic PRNG for tests (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function gauss(r: () => number) {
  const u = Math.max(r(), 1e-12)
  const v = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export function make(n: number, stepMs: number, f: (i: number, t: number) => number, t0 = T0): Series {
  const ts = new Float64Array(n)
  const values = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    ts[i] = t0 + i * stepMs
    values[i] = f(i, ts[i]!)
  }
  return { ts, values }
}

export const anomalies = (r: DetectResult<unknown>) => r.points.flatMap((p, i) => (p.anomalous ? [i] : []))

export function slice(s: Series, a: number, b: number): Series {
  return { ts: s.ts.slice(a, b), values: s.values.slice(a, b) }
}

/** Run a detector over chunks, round-tripping state through JSON as a Durable Object row would. */
export function chunked<S>(detect: (s: Series, st: S | null) => DetectResult<S>, s: Series, cuts: number[]): Point[] {
  const bounds = [0, ...cuts.filter((c) => c > 0 && c < s.ts.length).sort((a, b) => a - b), s.ts.length]
  let st: S | null = null
  const out: Point[] = []
  for (let i = 0; i + 1 < bounds.length; i++) {
    const r = detect(slice(s, bounds[i]!, bounds[i + 1]!), st)
    out.push(...r.points)
    st = r.state === null ? null : (JSON.parse(JSON.stringify(r.state)) as S)
  }
  return out
}

/** Numeric content of a point (no prose), for equality checks. */
export const numeric = (p: Point) => ({ ts: p.ts, value: p.value, expected: p.expected, lower: p.lower, upper: p.upper, score: p.score, anomalous: p.anomalous, status: p.status })
