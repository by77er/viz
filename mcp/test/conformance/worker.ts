/**
 * LOCAL ONLY. The agent surface as `wrangler dev` serves it to the official MCP conformance
 * suite (@modelcontextprotocol/conformance), which sends no credential. On first use this
 * Worker provisions a throwaway tenant in the local Durable Object, mints an agent key
 * through the real control plane, and adds it to requests that carry no Authorization
 * header. Everything else — protocol handling, auth, tools — is the production code path.
 */
import { createWorker as createControlWorker } from '../../../control/src/index'
import type { Tenant } from '../../../control/src/tenant'
import { createWorker } from '../../src/index'
import { httpControlClient, httpMonitorsClient, httpQueryClient } from '../../src/clients'
import { NOW_MS, NOW, standardTelemetry } from '../fake/data'
import { fakeProm, fakeRuler } from '../fake/services'
import service from '../../../dashboard/examples/service-red.json'

export { Tenant } from '../../../control/src/tenant'

interface Env {
  TENANT: DurableObjectNamespace<Tenant>
  CONFIG: KVNamespace
  DEFAULT_POOL?: string
}

const control = createControlWorker()
let setup: Promise<string> | null = null
let kv: KVNamespace | null = null
const prom = fakeProm(() => kv!, NOW)
const ruler = fakeRuler(() => kv!)

async function provision(env: Env, ctx: ExecutionContext): Promise<string> {
  const tenant = `conformance-${crypto.randomUUID().slice(0, 8)}`
  const { key: admin } = await env.TENANT.get(env.TENANT.idFromName(tenant)).provision(tenant)
  const call = async (path: string, body: unknown) =>
    (await control.fetch!(new Request(`https://control.local/api/v1/control${path}`, { method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) as never, env as never, ctx)).json() as Promise<any>
  await call('/dashboards', { spec: service })
  const k = await call('/keys', { name: 'conformance agent', scopes: ['read', 'dashboards:read', 'dashboards:write'], kind: 'agent' })
  prom.storages.set(tenant, standardTelemetry(tenant))
  return k.secret as string
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    kv = env.CONFIG
    const controlFetcher = { fetch: (r: Request) => control.fetch!(r as never, env as never, ctx) as Promise<Response> }
    const mcp = createWorker({
      query: (_e, a) => httpQueryClient(prom.fetcher, a),
      control: (_e, a) => httpControlClient(controlFetcher, a),
      monitors: (_e, a) => httpMonitorsClient(ruler.fetcher, a),
      now: () => NOW_MS,
    })
    if (!req.headers.get('Authorization') && new URL(req.url).pathname !== '/healthz') {
      setup ??= provision(env, ctx)
      const key = await setup
      const headers = new Headers(req.headers)
      headers.set('Authorization', `Bearer ${key}`)
      req = new Request(req, { headers })
    }
    return mcp.fetch!(req as never, env as never, ctx) as Promise<Response>
  },
}
