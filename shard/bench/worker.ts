/**
 * The shard benchmark script: the shard, the frozen as-built shard (bench/asbuilt/), and a
 * client. Each client is its own Durable Object sending appends one after another, as S3's
 * load generator did (spikes/s3-ingest-throughput/loadgen.ts), so the clients are not one
 * caller's six connections.
 */
import { DurableObject } from 'cloudflare:workers'
import type { AppendResult } from '../src/shard'
import { Shard } from '../src/shard'
export { Shard }
export { Shard as ShardAsBuilt } from './asbuilt/shard'
/** The release before registration before writes (D57), for bench/registration.bench.test.ts. */
export { Shard as ShardPrereg } from './prereg/shard'
/** The tenants' ledgers, in the same script as in viz-ingest (D57). */
export { Ledger } from '../../ledger/src/ledger'

interface Env { SHARD: DurableObjectNamespace<Shard>; SHARD_ASBUILT: DurableObjectNamespace<Shard>; SHARD_PREREG: DurableObjectNamespace<Shard> }

/**
 * A batch the size edge makes for a Remote Write request of `series` series with one sample
 * each (contracts/BATCH.md: a series table entry of about 80 bytes for S3's five labels, then
 * 20 bytes per row), with a valid `n_series` header and the series ids, so metering runs.
 */
export function batchFor(client: number, i: number, series: number): { payload: Uint8Array; seriesIds: BigInt64Array } {
  const size = 16 + series * 80 + series * 20
  const payload = new Uint8Array(size)
  const v = new DataView(payload.buffer)
  v.setUint32(8, series, true)
  v.setUint32(12, series, true)
  v.setUint32(16, client, true)
  v.setUint32(20, i, true)
  const seriesIds = BigInt64Array.from({ length: series }, (_, s) => BigInt(client * 1_000_003 + s))
  return { payload, seriesIds }
}

async function sha(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export class Client extends DurableObject<Env> {
  /**
   * A sender's first request to a new stream (D57): sent, and sent again after each refusal's
   * `Retry-After` (`roundUp`: rounded up to whole seconds, as edge writes the header) until it
   * is acknowledged. Returns the time from the first send to the acknowledgement.
   */
  async firstAck(shard: string, tenant: string, roundUp: boolean): Promise<{ ms: number; refusals: number; codes: string[] }> {
    const stub = this.env.SHARD.get(this.env.SHARD.idFromName(shard))
    const { payload, seriesIds } = batchFor(0, 0, 50)
    const fingerprint = await sha(payload)
    const codes: string[] = []
    const t0 = performance.now()
    for (let refusals = 0; refusals < 100; refusals++) {
      const r = await stub.append({ tenant, epoch: 1, fingerprint, payload, rows: 50, seriesIds, seriesLimit: 1_000_000 })
      if (r.status === 'ok') return { ms: performance.now() - t0, refusals, codes }
      codes.push(r.status === 'backpressure' ? `backpressure:${r.scope}` : r.status)
      const wait = r.status === 'backpressure' ? r.retryAfterMs : 1000
      await new Promise((res) => setTimeout(res, roundUp ? Math.max(1, Math.ceil(wait / 1000)) * 1000 : wait))
    }
    throw new Error(`no acknowledgement after 100 refusals: ${codes.join(' ')}`)
  }

  async run(kind: 'asbuilt' | 'new' | 'prereg', shard: string, tenant: string, client: number, seconds: number, series: number): Promise<{ lat: number[]; codes: string[]; status: Record<string, number>; acked: string[]; refused: string[] }> {
    const ns = kind === 'asbuilt' ? this.env.SHARD_ASBUILT : kind === 'prereg' ? this.env.SHARD_PREREG : this.env.SHARD
    const stub = ns.get(ns.idFromName(shard))
    const lat: number[] = []
    const codes: string[] = []
    const status: Record<string, number> = {}
    const acked: string[] = []
    const refused: string[] = []
    const end = Date.now() + seconds * 1000
    for (let i = 0; Date.now() < end; i++) {
      const { payload, seriesIds } = batchFor(client, i, series)
      const fingerprint = await sha(payload)
      const t = performance.now()
      let r: AppendResult | { status: 'error' }
      try {
        r = await stub.append({ tenant, epoch: 1, fingerprint, payload, rows: series, seriesIds, seriesLimit: 1_000_000 })
      } catch {
        r = { status: 'error' } // the runtime refused the call (overloaded object)
      }
      lat.push(performance.now() - t)
      const key = r.status === 'backpressure' ? `backpressure:${(r as { scope: string }).scope}` : r.status
      status[key] = (status[key] ?? 0) + 1
      codes.push(key)
      if (r.status === 'ok') acked.push(fingerprint)
      else refused.push(fingerprint)
      // A refused client waits as a sender would (Retry-After), then sends the next request.
      if (r.status === 'backpressure') await new Promise((res) => setTimeout(res, Math.min(200, (r as { retryAfterMs: number }).retryAfterMs)))
    }
    return { lat, codes, status, acked, refused }
  }
}

export default { fetch: () => new Response('viz shard bench') } satisfies ExportedHandler
