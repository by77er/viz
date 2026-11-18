/**
 * Writes known data into the real viz API with real Remote Write requests:
 *
 *   - every series of the development mock (mock/data.ts: 128 series of counters, a classic
 *     histogram, gauges with a 12-minute gap, `up`), sample for sample, so the same query
 *     can be asked of the mock and of the real API and the answers compared;
 *   - 200 `viz_synthetic_series` gauges, the 200-series case of e2e/measure.cjs, with the
 *     values that harness synthesises (so the real API answers what the harness fakes).
 *
 * The window is 2026-11-18 08:00 to 14:00 UTC, which holds the e2e suites' fixed window
 * (09:30 to 12:30, lib.cjs) with room for `rate(...[5m])`, zooming out and the picker.
 *
 *   node --import tsx real/seed.ts [--base http://127.0.0.1:8851] [--keys real/.wrangler/keys.json]
 *
 * The write key is read from the keys file (real/stack.mjs writes it) and never printed.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { syntheticStorage } from '../mock/data'
import { remoteWriteBody, remoteWriteHeaders, type WriteSeries } from './remoteWrite'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}
const HERE = path.dirname(new URL(import.meta.url).pathname)
const BASE = arg('base', process.env.VIZ_REAL_BASE ?? 'http://127.0.0.1:8851')
const KEYS = arg('keys', path.join(HERE, '.wrangler', 'keys.json'))

export const SEED_FROM = Date.UTC(2026, 10, 18, 8, 0) / 1000
export const SEED_TO = Date.UTC(2026, 10, 18, 14, 0) / 1000
const SLICE = 30 * 60
const SCRAPE = 15
const N_SYNTH = 200

/** e2e/measure.cjs `synthetic()`: the same labels and the same value at every timestamp. */
export function syntheticSeries(i: number): Record<string, string> {
  return {
    __name__: 'viz_synthetic_series',
    service: `svc-${String(i % 10).padStart(2, '0')}`,
    route: `/r/${Math.floor(i / 10) % 5}`,
    status: String(200 + 100 * (Math.floor(i / 50) % 4)),
  }
}
export const syntheticValue = (i: number, t: number) => Number((3 * (i + 1) + 2 * Math.sin(t / 600 + i)).toFixed(4))

async function main() {
  const keys = JSON.parse(readFileSync(KEYS, 'utf8')) as { write: string }
  const mock = syntheticStorage().all()
  let requests = 0
  let samples = 0
  for (let from = SEED_FROM - SCRAPE; from < SEED_TO; from += SLICE) {
    const to = Math.min(from + SLICE, SEED_TO)
    const series: WriteSeries[] = []
    for (const s of mock) {
      const got = s.samples(from, to)
      if (got.length) series.push({ labels: s.labels, samples: got.map((x) => [x.t * 1000, x.v]) })
    }
    for (let i = 0; i < N_SYNTH; i++) {
      const out: [number, number][] = []
      for (let t = Math.floor(from / SCRAPE) * SCRAPE + SCRAPE; t <= to; t += SCRAPE) out.push([t * 1000, syntheticValue(i, t)])
      series.push({ labels: syntheticSeries(i), samples: out })
    }
    const body = remoteWriteBody(series)
    let res: Response | null = null
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await fetch(`${BASE}/api/v1/write`, { method: 'POST', headers: remoteWriteHeaders(keys.write), body })
      if (res.status !== 429 && res.status < 500) break
      const wait = Number(res.headers.get('Retry-After') ?? '1')
      await res.arrayBuffer()
      await new Promise((r) => setTimeout(r, Math.min(10, wait) * 1000))
    }
    const text = await res!.text()
    if (res!.status !== 204 && res!.status !== 200) throw new Error(`write ${new Date(from * 1000).toISOString()}: HTTP ${res!.status} ${text.slice(0, 300)}`)
    requests++
    const n = series.reduce((a, s) => a + s.samples.length, 0)
    samples += n
    console.log(`wrote ${new Date(from * 1000).toISOString().slice(11, 16)}..${new Date(to * 1000).toISOString().slice(11, 16)}: ${series.length} series, ${n} samples, ${body.length} bytes -> ${res!.status}`)
  }
  console.log(`seed: ${requests} Remote Write requests, ${samples} samples`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
