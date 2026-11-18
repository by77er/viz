/**
 * The read path and the write path in one script, for the tests: ingest paths go to the
 * edge Worker, everything else to the query Worker. Nothing here adds behaviour.
 *
 *   default export   edge (`POST /api/v1/write`, `POST /v1/metrics`) + query (the rest)
 *   Flush            the flush entrypoint (`flushTenant(tenant, shardName)` over RPC)
 *   Shard, Ledger    the write path's Durable Objects
 *   Leaf             the query leaves
 */
import edge from '../../edge/src/index'
import query, { type Env } from '../src/index'

export { Shard } from '../../shard/src/shard'
export { Ledger } from '../../ledger/src/ledger'
export { Flush } from '../../flush/src/index'
export { Leaf } from '../src/index'

const INGEST = new Set(['/api/v1/write', '/v1/metrics'])

export default {
  fetch(req: Request, env: Env & { INGEST_LIMITS?: string }): Promise<Response> {
    return INGEST.has(new URL(req.url).pathname) ? edge.fetch(req, env) : query.fetch(req, env)
  },
} satisfies ExportedHandler<Env & { INGEST_LIMITS?: string }>
