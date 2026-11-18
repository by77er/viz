/**
 * Writes known data into the real viz API with real Remote Write requests:
 *
 *   every series of the development mock (mock/data.ts), sample for sample, so the same query
 *   can be asked of the mock and of the real API and the answers compared: 128 series of
 *   counters, a classic histogram, gauges with a 12-minute gap and `up`, and the 200
 *   `viz_synthetic_series` gauges of e2e/measure.cjs's 200-series case.
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
import { SCRAPE_INTERVAL as SCRAPE, syntheticStorage } from '../mock/data'
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
