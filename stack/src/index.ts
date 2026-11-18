/**
 * The write path in one script: senders → edge → Shard → flush → R2 Parquet → Ledger.
 *
 *   default export   the edge Worker (`POST /api/v1/write`, `POST /v1/metrics`, `GET /healthz`)
 *   Flush            the flush entrypoint (`flushTenant(tenant, shardName)` over RPC)
 *   Shard, Ledger    the Durable Object classes
 *
 * Nothing here adds behaviour: it only puts the four components behind one set of
 * bindings so they can be tested together. Flush has no HTTP route in this script; it is
 * reached through `ctx.exports.Flush` (or a service binding to the `Flush` entrypoint).
 */
import edge from '../../edge/src/index'

export { Shard } from '../../shard/src/shard'
export { Ledger } from '../../ledger/src/ledger'
export { Flush, engine, flushTenant } from '../../flush/src/index'
export type { FlushOptions, FlushResult } from '../../flush/src/index'

export default edge
