/**
 * The benchmark script: the ledger, the frozen as-built ledger (bench/asbuilt/), and a
 * writer client. Each writer is its own Durable Object with its own stream, so the clients
 * are not what limits the measurement (AGENTS.md, "load-test ... each client its own Durable
 * Object").
 */
import { DurableObject } from 'cloudflare:workers'
import type { FileEntry, FlushUnit } from '../../contracts/ledger'
import { Ledger } from '../src/ledger'
export { Ledger }
export { Ledger as LedgerAsBuilt } from './asbuilt/ledger'

interface Env {
  LEDGER: DurableObjectNamespace<Ledger>
  LEDGER_ASBUILT: DurableObjectNamespace<Ledger>
  CELL: string
}

/** S4's index fragment: three row groups, about 700 bytes of JSON per file. */
const INDEX = JSON.stringify({ v: 1, groups: Array.from({ length: 3 }, (_, g) => ({ rows: 100000, offset: 4 + g * 4_000_000, length: 4_000_000, minName: 'http_requests_total', maxName: 'process_cpu_seconds_total', minTs: 1795000000000, maxTs: 1795003600000 })) })
const DAY0 = Date.UTC(2026, 9, 20)

export function unitFor(cell: string, tenant: string, id: number, seqLo: number, seqHi: number, filesPerUnit: number): FlushUnit {
  const day = new Date(DAY0 + ((id * 7 + seqLo) % 30) * 86_400_000).toISOString().slice(0, 10)
  const files: FileEntry[] = Array.from({ length: filesPerUnit }, (_, f) => {
    const table = f % 2 === 0 ? 'metric_samples' : 'metric_series'
    return {
      table, day,
      key: `${cell}/data/${table}/tenant=${tenant}/day=${day}/L0-pool_b_${id}-${1000 + id}-${seqLo}-${seqHi}-${f}${((seqLo * 2654435761) >>> 0).toString(16).padStart(8, '0')}.parquet`,
      bytes: 8_000_000, rows: 300_000, minTs: Date.parse(day), maxTs: Date.parse(day) + 86_399_000, level: 0, index: INDEX,
    }
  })
  return { shard: `pool/b/${id}`, incarnation: 1000 + id, seqLo, seqHi, files }
}

export class Writer extends DurableObject<Env> {
  /** Admit `units` consecutive units on stream `id` of `tenant`'s ledger, one after another. Returns each call's latency (ms). */
  async run(kind: 'asbuilt' | 'segments', tenant: string, id: number, units: number, filesPerUnit: number): Promise<{ lat: number[]; statuses: Record<string, number> }> {
    const ns = kind === 'asbuilt' ? this.env.LEDGER_ASBUILT : this.env.LEDGER
    const ledger = ns.get(ns.idFromName(tenant))
    const lat: number[] = []
    const statuses: Record<string, number> = {}
    for (let u = 0; u < units; u++) {
      const t = performance.now()
      const r = await ledger.addUnit(unitFor(this.env.CELL, tenant, id, u * 4 + 1, u * 4 + 4, filesPerUnit))
      lat.push(performance.now() - t)
      statuses[r.status] = (statuses[r.status] ?? 0) + 1
      if (r.status !== 'ok') break
    }
    return { lat, statuses }
  }
}

export default { fetch: () => new Response('viz ledger bench') } satisfies ExportedHandler
