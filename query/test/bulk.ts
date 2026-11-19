/**
 * The measurement workload: `http_requests_total` for 2,000 series (20 jobs x 100
 * instances), counters scraped at a fixed interval, each growing by a pseudo-random 0 to
 * 9 per scrape (so the Parquet files compress like counters do, not like a formula).
 * Used by the engine memory test and by the measurement run.
 */
import { hash32 } from '../../shard/src/pool'
import { type Row, bitsOf, encodeBatch } from '../../engine/wasm/test/vzb1'
import type { WSeries } from './world'

export const JOBS = 20
export const INSTANCES = 100
export const N_SERIES = JOBS * INSTANCES
/** Mean growth per scrape: increments are uniform on 0..9. */
export const MEAN_INCREMENT = 4.5

export const bulkLabels = (i: number): Record<string, string> => ({ __name__: 'http_requests_total', job: `job-${String(i % JOBS).padStart(2, '0')}`, instance: `10.0.${Math.floor(i / JOBS)}.1:9100` })

/** A stateful generator: scrape after scrape from `origin`, every `intervalMs`, of `n` series (20 jobs, n / 20 instances each). */
export class Bulk {
  private readonly value: Float64Array
  private k = 0
  constructor(
    readonly origin: number,
    readonly intervalMs: number,
    readonly n = N_SERIES,
    readonly labels: (i: number) => Record<string, string> = bulkLabels,
  ) {
    this.value = new Float64Array(n)
  }

  get nextTs(): number {
    return this.origin + this.k * this.intervalMs
  }

  private scrape(emit: (i: number, ts: number, v: number) => void): void {
    const ts = this.nextTs
    for (let i = 0; i < this.n; i++) {
      this.value[i]! += hash32(`${i}/${this.k}`) % 10
      emit(i, ts, this.value[i]!)
    }
    this.k++
  }

  /** The next `scrapes` scrapes as Remote Write series. */
  series(scrapes: number): WSeries[] {
    const out: WSeries[] = Array.from({ length: this.n }, (_, i) => ({ labels: this.labels(i), samples: [] }))
    for (let s = 0; s < scrapes; s++) this.scrape((i, ts, v) => out[i]!.samples.push([ts, v]))
    return out
  }

  /** The next `scrapes` scrapes as one `VZB1` batch. */
  batch(scrapes: number): Uint8Array {
    const rows: Row[] = []
    for (let s = 0; s < scrapes; s++) this.scrape((i, ts, v) => rows.push({ series: i, ts, bits: bitsOf(v) }))
    return encodeBatch(Array.from({ length: this.n }, (_, i) => this.labels(i)), rows)
  }
}

/**
 * Sanity of a `sum by (job)(rate(http_requests_total[5m]))` result: 20 jobs, the expected
 * number of points, and every value within 15% of the mean rate of 100 such counters.
 */
export function checkBulkRates(data: { result: { metric: Record<string, string>; values: [number, string][] }[] }, points: number, intervalMs: number, instances = INSTANCES): void {
  if (data.result.length !== JOBS) throw new Error(`expected ${JOBS} jobs, got ${data.result.length}`)
  const mean = (instances * MEAN_INCREMENT) / (intervalMs / 1000)
  for (const s of data.result) {
    if (s.values.length !== points) throw new Error(`${s.metric.job}: expected ${points} points, got ${s.values.length}`)
    for (const [t, v] of s.values) if (Math.abs(Number(v) - mean) > 0.15 * mean) throw new Error(`${s.metric.job} at ${t}: rate ${v}, expected about ${mean}`)
  }
}
