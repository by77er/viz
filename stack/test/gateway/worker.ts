/**
 * TESTS ONLY (vitest.gateway.config.ts, test/gateway/wrangler.jsonc): the public path of a
 * deployment in one script, so that a request goes through the gateway's routing and reaches the
 * real Worker code behind it.
 *
 *   default fetch   viz-gateway (deploy/gateway/src/index.ts `handle`), unchanged
 *   default queue   viz-ingest's consumers (stack/src/index.ts): a seal's flush message is flushed
 *   Ingest          viz-ingest's fetch (stack/src/index.ts: edge), reached by the gateway's INGEST
 *   Query           viz-query's fetch (query/src/index.ts), reached by the gateway's QUERY
 *   Elsewhere       control, the ruler and mcp: not part of this test (501)
 *   Shard, Ledger, Flush, Leaf   the Durable Objects and the flush entrypoint of both Workers
 *
 * The bindings INGEST and QUERY run with the script's vars (`INGEST_SIGNALS` and `QUERY_SIGNALS`
 * both on); INGEST_OFF and QUERY_OFF reach the same entrypoints with `props: {signals: "off"}`,
 * which take the flag away, as a deployment that has not set it. Nothing here adds behaviour.
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import { type Env as GatewayEnv, handle } from '../../../deploy/gateway/src/index'
import query, { type Env as QueryEnv } from '../../../query/src/index'
import stack, { type StackEnv, handleQueue } from '../../src/index'

export { Flush, Ledger, Shard } from '../../src/index'
export { Leaf } from '../../../query/src/index'

export type E2EEnv = StackEnv &
  QueryEnv &
  GatewayEnv & {
    INGEST_SIGNALS?: string
    QUERY_SIGNALS?: string
    INGEST_OFF: Fetcher
    QUERY_OFF: Fetcher
  }

const flagsOff = (props: unknown): boolean => (props as { signals?: unknown } | undefined)?.signals === 'off'

export default {
  fetch: (req, env) => handle(req, env),
  queue: (batch, env) => handleQueue(batch, env),
} satisfies ExportedHandler<E2EEnv>

/** viz-ingest's fetch, as the gateway's INGEST (or INGEST_OFF) binding reaches it. */
export class Ingest extends WorkerEntrypoint<E2EEnv> {
  async fetch(req: Request): Promise<Response> {
    const env = flagsOff(this.ctx.props) ? { ...this.env, INGEST_SIGNALS: undefined } : this.env
    return stack.fetch(req as Parameters<typeof stack.fetch>[0], env)
  }
}

/** viz-query's fetch, as the gateway's QUERY (or QUERY_OFF) binding reaches it. */
export class Query extends WorkerEntrypoint<E2EEnv> {
  async fetch(req: Request): Promise<Response> {
    const env = flagsOff(this.ctx.props) ? { ...this.env, QUERY_SIGNALS: undefined } : this.env
    return query.fetch(req, env)
  }
}

/** The gateway's other backends: not exercised here. */
export class Elsewhere extends WorkerEntrypoint<E2EEnv> {
  async fetch(): Promise<Response> {
    return new Response('not part of this test', { status: 501 })
  }
}
