import { WorkerEntrypoint } from 'cloudflare:workers'
import { TENANT_ID } from '../../contracts/ledger'
import { createEngine } from '../../engine/wasm/js/index'
import wasm from '../../engine/wasm/js/viz_engine.wasm'
import { consumeDeadLetters, consumeFlushBatch } from './consumer'
import { type FlushEnv, type FlushResult, flushTenant } from './flush'

// For now the shard and the ledger ship in the same script (see wrangler.jsonc).
export { Shard } from '../../shard/src/shard'
export { Ledger } from '../../ledger/src/ledger'
export * from './flush'
export * from './consumer'
export * from './sweep'
export { dataFileKey } from './keys'

/** One engine per isolate. Its linear memory is reused across segments and requests. */
export const engine = createEngine(wasm)

/**
 * The flush Worker. Two ways in, both doing the same thing:
 *
 *   RPC    `env.FLUSH.flushTenant(tenant, shardName)` over a service binding
 *   fetch  `POST /flush` with a JSON body `{ "tenant": "...", "shard": "..." }`
 *   queue  `{tenant, shard}` messages from the flush queue (src/consumer.ts); a queue whose
 *          name ends in `-dlq` is taken to be its dead-letter queue
 *
 * This Worker has no public route. The tenant here is not a claim made by a sender: the
 * caller is viz itself (the seal notification or the sweep, see the README), naming a
 * stream that already exists in a shard.
 */
export class Flush extends WorkerEntrypoint<FlushEnv> {
  flushTenant(tenant: string, shardName: string): Promise<FlushResult> {
    return flushTenant(this.env, engine, tenant, shardName)
  }

  async queue(batch: MessageBatch<unknown>): Promise<void> {
    if (batch.queue.endsWith('-dlq')) await consumeDeadLetters(batch, this.env)
    else await consumeFlushBatch(batch, this.env, engine)
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') return new Response('ok\n')
    if (url.pathname !== '/flush') return new Response('not found', { status: 404 })
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { Allow: 'POST' } })
    let body: { tenant?: unknown; shard?: unknown }
    try {
      body = await req.json()
    } catch {
      return Response.json({ error: 'body must be JSON: { "tenant": "...", "shard": "..." }' }, { status: 400 })
    }
    if (typeof body.tenant !== 'string' || !TENANT_ID.test(body.tenant) || typeof body.shard !== 'string' || body.shard === '') {
      return Response.json({ error: 'tenant must match [A-Za-z0-9_-]{1,64} and shard must be a non-empty string' }, { status: 400 })
    }
    const result = await this.flushTenant(body.tenant, body.shard)
    // 409: the run stopped on a state it must not guess about; the body says which.
    return Response.json(result, { status: result.status === 'ok' ? 200 : 409 })
  }
}

export default Flush
