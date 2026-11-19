/**
 * Which signal a shard holds, and the check that a tail read got only its own signal.
 *
 * Spans and log records are appended to shards of their own (contracts/BATCH.md "Streams per
 * signal", D57): for a tenant whose pool is `{pool}`, `{pool}/traces/{slot}` and
 * `{pool}/logs/{slot}`. Each of those streams is registered with the tenant's ledger, so a
 * plan's watermarks name them next to the metric streams. A metrics tail read sent to one of
 * them would fail (the shard's filter throws on a batch that is not signal 1), and an
 * unfiltered one (a shard of the previous release) would hand span bytes to the metrics
 * engine. So every read asks only its signal's shards, by name, and every batch it gets back
 * is checked by its header: a batch of another signal refuses the query (503), it is never
 * read as the wrong signal and never dropped.
 *
 * The shard's tail filter has no signal field yet (`query/README.md`, "Needed changes
 * elsewhere"); until it has, the name is the only way to choose, and the header check is what
 * keeps a wrong choice from becoming a wrong answer.
 */
import type { Watermark } from '../../contracts/ledger'
import { poolMap, signalMap } from '../../edge/src/route'
import { shardName, tenantSlots } from '../../shard/src/pool'
import type { Env } from './config'

export type Signal = 'metrics' | 'traces' | 'logs'

const DERIVED = /^.+\/(traces|logs)\/\d+$/

/**
 * The signal of a shard by its name: `…/traces/{slot}` holds spans, `…/logs/{slot}` log
 * records, anything else metrics. A metric pool whose own name ends in `/traces` or `/logs`
 * would be misnamed here (edge allows such a base pool today: "Needed changes elsewhere");
 * the header check then refuses the read instead of misreading it.
 */
export function signalOfShard(name: string): Signal {
  const m = DERIVED.exec(name)
  return m ? (m[1] as Signal) : 'metrics'
}

const SIGNAL_BYTE: Record<Signal, 1 | 2 | 3> = { metrics: 1, traces: 2, logs: 3 }

/** A tail batch's signal byte (contracts/BATCH.md: offset 4), or null when it is no `VZB1` batch. */
export function batchSignal(payload: Uint8Array): number | null {
  if (payload.byteLength < 16 || payload[0] !== 0x56 || payload[1] !== 0x5a || payload[2] !== 0x42 || payload[3] !== 0x31) return null
  return payload[4]!
}

/** Thrown when a shard answered a read for one signal with a batch of another. Retryable (503): nothing was misread. */
export class WrongSignal extends Error {
  constructor(
    readonly shard: string,
    readonly got: number | null,
    readonly want: number,
  ) {
    super(`shard ${shard} answered a tail read for signal ${want} with a batch of signal ${got ?? 'unknown'}; the query was refused rather than read as the wrong signal`)
  }
}

export function checkSignal(shard: string, payload: Uint8Array, want: 1 | 2 | 3): void {
  const got = batchSignal(payload)
  if (got !== want) throw new WrongSignal(shard, got, want)
}

export const signalByte = (s: Signal): 1 | 2 | 3 => SIGNAL_BYTE[s]

/**
 * The shards a span or log read asks: the signal's pool slots the tenant may write to now
 * (`{pool}/{signal}/{slot}`), and every shard of that signal the ledger has a watermark for
 * (a stream on a shard that left the map is still read). In name order.
 */
export async function signalShards(env: Env, tenant: string, signal: 'traces' | 'logs', watermarks: Watermark[]): Promise<string[]> {
  const map = signalMap(await poolMap(env, tenant), signal)
  const names = new Set(tenantSlots(map, tenant).map((slot) => shardName(map, slot)))
  for (const w of watermarks) if (signalOfShard(w.shard) === signal) names.add(w.shard)
  return [...names].sort()
}
