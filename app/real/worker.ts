/**
 * The real viz API on one machine, for running the app against it (`real/stack.mjs`).
 *
 * Nothing here adds behaviour: it puts the deployed topology (deploy/README.md, "Topology
 * and routes") behind one script so that `wrangler dev --local` can serve it.
 *
 *   default export   deploy/gateway (fetch): routes by path, adds x-viz-route, /api/v1/bootstrap
 *                    stack (queue): flush and maintenance consumers, as viz-ingest has them
 *   Ingest           viz-ingest's fetch (edge), reached by the gateway's INGEST service binding
 *   Query            viz-query's fetch, reached by QUERY
 *   Control          viz-control's fetch, reached by CONTROL
 *   Shard, Ledger, Flush, Leaf, Tenant   the Durable Objects and entrypoint the three use
 *
 * In production these are four Workers bound to each other; here one script binds itself
 * (the same composition deploy/gateway/test/worker.ts and query/test/stack.ts use). Local only:
 * never deployed, and its config (real/wrangler.jsonc) has no account or route.
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import gateway from '../../deploy/gateway/src/index'
import stack from '../../stack/src/index'
import query from '../../query/src/index'
import control from '../../control/src/index'

export { Shard } from '../../shard/src/shard'
export { Ledger } from '../../ledger/src/ledger'
export { Flush } from '../../flush/src/index'
export { Leaf } from '../../query/src/index'
export { Tenant } from '../../control/src/tenant'

// The component handlers are typed against their own Env interfaces; this script's env is
// the union of all of them (wrangler.jsonc), so the casts below only widen.
type AnyEnv = never
type Handler = { fetch?: (req: Request, env: AnyEnv, ctx: ExecutionContext) => Response | Promise<Response> }

export class Ingest extends WorkerEntrypoint {
  fetch(req: Request): Promise<Response> {
    return Promise.resolve((stack as unknown as Handler).fetch!(req, this.env as AnyEnv, this.ctx))
  }
}

export class Query extends WorkerEntrypoint {
  fetch(req: Request): Promise<Response> {
    return Promise.resolve((query as unknown as Handler).fetch!(req, this.env as AnyEnv, this.ctx))
  }
}

export class Control extends WorkerEntrypoint {
  fetch(req: Request): Promise<Response> {
    return Promise.resolve((control as unknown as Handler).fetch!(req, this.env as AnyEnv, this.ctx))
  }
}

export default {
  fetch: gateway.fetch,
  queue: stack.queue,
  scheduled: stack.scheduled,
} as ExportedHandler
