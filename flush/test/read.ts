/**
 * A reference read path for tests: the "seam" of design/DESIGN.md §2 in its smallest form.
 * It is NOT the query Worker (which does not exist yet); it is here so tests can ask "what
 * would a query see right now?" the way a query must:
 *
 *   1. one ledger version: the live files of both tables and the watermark of each stream;
 *   2. each shard is asked only for rows above its watermark;
 *   3. a shard that has discarded rows above the watermark it is asked about refuses, and
 *      the read starts again from a fresh plan. It never returns a gap;
 *   4. the engine merges lake files and tail batches and removes duplicates.
 */
import type { Matcher, SeriesData } from '../../contracts/engine'
import type { Plan } from '../../contracts/ledger'
import type { Ledger } from '../../ledger/src/ledger'
import type { Shard } from '../../shard/src/shard'
import type { VizEngine } from '../../engine/wasm/js/index'
import { bitsFromBytes } from '../../engine/wasm/test/vzb1'

export interface ReadEnv {
  SHARD: DurableObjectNamespace<Shard>
  LEDGER: DurableObjectNamespace<Ledger>
  BUCKET: R2Bucket
}

export interface ReadOptions {
  matchers?: Matcher[]
  minTs?: number
  maxTs?: number
  /**
   * `watermark` (default): the seam, rows above each stream's ledger watermark.
   * `zero`: deliberately ask every shard for everything it still holds, so rows that are
   * both in lake files and in the tail overlap. The answer must be the same.
   */
  tailFrom?: 'watermark' | 'zero'
}

export interface ReadResult {
  series: SeriesData[]
  /** Order-independent form: one string per sample. */
  canon: string[]
  sampleFiles: string[]
  seriesFiles: string[]
  tailBatches: number
  tailRows: number
  /** Samples in the lake files and rows in the tail, before de-duplication. */
  lakeRows: number
  ledgerVersion: number
  attempts: number
}

export class StaleTail extends Error {}

export const canonOf = (series: SeriesData[]): string[] =>
  series
    .flatMap((s) => {
      const labels = JSON.stringify(Object.entries(s.labels).sort(([a], [b]) => (a < b ? -1 : 1)))
      const bits = bitsFromBytes(s.values)
      return Array.from(s.ts, (t, i) => `${labels} @${t} =${bits[i]!.toString(16)}`)
    })
    .sort()

async function consistentPlans(ledger: DurableObjectStub<Ledger>, minTs: number, maxTs: number): Promise<{ samples: Plan; series: Plan }> {
  for (let i = 0; i < 10; i++) {
    const samples = await ledger.plan({ table: 'metric_samples', minTs, maxTs })
    const series = await ledger.plan({ table: 'metric_series', minTs, maxTs })
    if (samples.version === series.version && samples.ledgerIncarnation === series.ledgerIncarnation) return { samples, series }
  }
  throw new Error('read: the ledger kept changing between the two plan calls')
}

export async function readTenant(env: ReadEnv, engine: VizEngine, tenant: string, shards: string[], opts: ReadOptions = {}): Promise<ReadResult> {
  const minTs = opts.minTs ?? 0
  const maxTs = opts.maxTs ?? 253_402_300_799_999
  const ledger = env.LEDGER.get(env.LEDGER.idFromName(tenant))
  for (let attempt = 1; attempt <= 5; attempt++) {
    const { samples, series } = await consistentPlans(ledger, minTs, maxTs)
    const fetchAll = (keys: string[]) =>
      Promise.all(
        keys.map(async (key) => {
          const o = await env.BUCKET.get(key)
          if (!o) throw new Error(`read: the ledger lists ${key} but it is not in R2`)
          return new Uint8Array(await o.arrayBuffer())
        }),
      )
    const sampleFiles = await fetchAll(samples.files.map((f) => f.key))
    const seriesFiles = await fetchAll(series.files.map((f) => f.key))

    const tailBatches: Uint8Array[] = []
    let tailRows = 0
    let stale = false
    for (const name of shards) {
      const shard = env.SHARD.get(env.SHARD.idFromName(name))
      const stream = await shard.describe(tenant)
      if (!stream) continue // this tenant has never written to that shard
      const w = samples.watermarks.find((x) => x.shard === name)
      if (w && w.incarnation > stream.incarnation) throw new Error(`read: the ledger has a newer incarnation of ${name} than the shard`)
      // A stream the ledger has not registered (yet) has nothing in the lake: all of it is tail.
      const above = opts.tailFrom === 'zero' || !w || w.incarnation !== stream.incarnation ? 0 : w.seq
      const tail = await shard.tailRead(tenant, stream.incarnation, above)
      if (tail.status === 'stale_watermark') {
        if (opts.tailFrom === 'zero') throw new StaleTail(`shard ${name} has discarded through ${tail.discardedThrough}`)
        stale = true // the plan is older than the shard's discard: read the ledger again
        break
      }
      if (tail.status !== 'ok') throw new Error(`read: tailRead answered ${tail.status}`)
      for (const b of tail.batches) {
        tailBatches.push(b.payload)
        tailRows += b.rows
      }
    }
    if (stale) continue

    const out = engine.select({ seriesFiles, sampleFiles, tailBatches }, opts.matchers ?? [], minTs, maxTs)
    return {
      series: out,
      canon: canonOf(out),
      sampleFiles: samples.files.map((f) => f.key),
      seriesFiles: series.files.map((f) => f.key),
      tailBatches: tailBatches.length,
      tailRows,
      lakeRows: samples.files.reduce((a, f) => a + f.rows, 0),
      ledgerVersion: samples.version,
      attempts: attempt,
    }
  }
  throw new Error('read: shards kept refusing the watermark')
}
