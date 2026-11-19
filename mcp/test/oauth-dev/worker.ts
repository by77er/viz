/**
 * LOCAL ONLY. viz's OAuth flow for MCP clients under `wrangler dev`, for scripts/oauth-client.mjs:
 * one Worker that routes as the gateway does (deploy/gateway/src/index.ts) to the REAL control
 * plane (its OAuth endpoints, its API, its Tenant object) and the REAL agent surface, with the
 * fake query service and ruler behind it. Everything a client touches is production code; only
 * `POST /__local/provision` is not, and it exists only here.
 */
import { createWorker as createControlWorker } from '../../../control/src/index'
import type { Tenant } from '../../../control/src/tenant'
import { OAUTH_SCOPES } from '../../../contracts/oauth'
import { createWorker } from '../../src/index'
import { httpControlClient, httpMonitorsClient, httpQueryClient } from '../../src/clients'
import { NOW_MS, NOW, standardTelemetry } from '../fake/data'
import { fakeProm, fakeRuler } from '../fake/services'

export { Tenant } from '../../../control/src/tenant'

interface Env {
  TENANT: DurableObjectNamespace<Tenant>
  CONFIG: KVNamespace
  DEFAULT_POOL?: string
  PUBLIC_URL?: string
  OAUTH_CLIENT_KEY?: string
}

const control = createControlWorker()
let kv: KVNamespace | null = null
const prom = fakeProm(() => kv!, NOW)
const ruler = fakeRuler(() => kv!)

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    kv = env.CONFIG
    const path = new URL(req.url).pathname
    const toControl = (r: Request) => control.fetch!(r as never, env as never, ctx) as Promise<Response>
    if (path === '/healthz') return new Response('ok\n')
    if (path === '/__local/provision' && req.method === 'POST') {
      // A tenant with telemetry, and a person's key (admin plus every grantable scope) to approve with.
      const tenant = `oauth-local-${crypto.randomUUID().slice(0, 8)}`
      const { key: admin } = await env.TENANT.get(env.TENANT.idFromName(tenant)).provision(tenant)
      const res = await toControl(new Request('http://local/api/v1/control/keys', { method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Dana', scopes: ['admin', ...OAUTH_SCOPES], kind: 'key' }) }))
      const person = ((await res.json()) as { secret: string }).secret
      prom.storages.set(tenant, standardTelemetry(tenant))
      return Response.json({ tenant, person })
    }
    if (path === '/mcp' || path === '/api/v1/agent' || path.startsWith('/api/v1/agent/') || path.startsWith('/.well-known/oauth-protected-resource')) {
      const controlFetcher = { fetch: toControl }
      const mcp = createWorker({
        query: (_e, a) => httpQueryClient(prom.fetcher, a),
        control: (_e, a) => httpControlClient(controlFetcher, a),
        monitors: (_e, a) => httpMonitorsClient(ruler.fetcher, a),
        now: () => NOW_MS,
      })
      return mcp.fetch!(req as never, env as never, ctx) as Promise<Response>
    }
    return toControl(req)
  },
}
