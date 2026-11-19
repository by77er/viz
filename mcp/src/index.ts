import { AuthError, identify } from './auth'
import { type ControlClient, type MonitorsClient, type QueryClient, type Fetcher, httpControlClient, httpMonitorsClient, httpQueryClient } from './clients'
import { serveMcp } from './mcp'
import { REST_PREFIX, problem, serveRest } from './rest'
import { type BudgetHook, type Limits, type Session, limitsFrom, namesLoader, newUsage, returnedCounters } from './session'

export { clearAuthCache } from '../../edge/src/auth'
export { clearNamesCache } from './session'

/**
 * The agent surface Worker: a stateless remote MCP server at /mcp (Streamable HTTP) and
 * the same operations as JSON under /api/v1/agent/…. No Durable Object.
 *
 * Bindings (wrangler.jsonc): CONFIG (edge's key store, KV), QUERY (the query service),
 * CONTROL (the tenant control plane), RULER (monitors), APP_URL (deep links),
 * MCP_LIMITS (JSON overrides of the limits), ALLOWED_ORIGINS (browser origins).
 */
export interface Env {
  CONFIG: KVNamespace
  QUERY?: Fetcher
  CONTROL?: Fetcher
  RULER?: Fetcher
  APP_URL?: string
  MCP_LIMITS?: string
  ALLOWED_ORIGINS?: string
}

/** What a deployment (or a test) plugs in. Every client is made per request with the caller's own credential. */
export interface Deps {
  query?: (env: Env, authorization: string) => QueryClient
  control?: (env: Env, authorization: string) => ControlClient | null
  monitors?: (env: Env, authorization: string) => MonitorsClient | null
  budget?: BudgetHook
  /** Unix milliseconds. */
  now?: () => number
  limits?: Partial<Limits>
}

const unavailableQuery = (): QueryClient => {
  const no = async () => ({ ok: false as const, status: 503, errorType: 'unavailable', error: 'The query service is not connected to this deployment.' })
  return { instant: no, range: no, labelNames: no, labelValues: no, series: no, metadata: no, plan: no }
}

const defaults: Required<Pick<Deps, 'query' | 'control' | 'monitors'>> = {
  query: (env, auth) => (env.QUERY ? httpQueryClient(env.QUERY, auth) : unavailableQuery()),
  control: (env, auth) => (env.CONTROL ? httpControlClient(env.CONTROL, auth) : null),
  monitors: (env, auth) => (env.RULER ? httpMonitorsClient(env.RULER, auth) : null),
}

export const MCP_PATH = '/mcp'

/**
 * `GET /healthz`, without a credential (the gateway asks it through its service binding and
 * never forwards the path): 200 `ok` when the Worker has the key store and the three services
 * it calls, 503 naming what is missing. It calls none of them: without a credential there is
 * nothing it may ask.
 */
export function health(req: Request, env: Env): Response {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed\n', { status: 405, headers: { Allow: 'GET, HEAD' } })
  const missing = (['CONFIG', 'QUERY', 'CONTROL', 'RULER'] as const).filter((b) => !env[b])
  const body = missing.length === 0 ? 'ok\n' : `missing binding: ${missing.join(', ')}\n`
  return new Response(req.method === 'HEAD' ? null : body, { status: missing.length === 0 ? 200 : 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
}

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/

/**
 * DNS-rebinding protection (MCP transport spec): a browser Origin must be one the operator
 * listed. A server reached on a localhost Host (local development) also accepts
 * localhost-class Origins; a deployed one never does.
 */
function originAllowed(req: Request, env: Env): boolean {
  const origin = req.headers.get('Origin')
  if (!origin) return true // non-browser MCP clients send none
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  if (allowed.includes(origin)) return true
  try {
    const host = new URL(req.url).hostname
    return LOCAL.test(host) && LOCAL.test(new URL(origin).hostname)
  } catch {
    return false
  }
}

function authFailure(e: AuthError, mcp: boolean): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  if (e.status === 401) headers['WWW-Authenticate'] = 'Bearer realm="viz", error="invalid_token"'
  const body = mcp
    ? { jsonrpc: '2.0', id: null, error: { code: -32001, message: `${e.message} ${e.fix}`, data: { code: e.code, status: e.status } } }
    : { type: `https://vis.bitcru.sh/problems/${e.code}`, title: e.code, status: e.status, code: e.code, detail: e.message, fix: e.fix }
  return new Response(JSON.stringify(body), { status: e.status, headers })
}

export function createWorker(deps: Deps = {}): ExportedHandler<Env> {
  const make = { ...defaults, ...deps }
  const budget = deps.budget ?? returnedCounters
  return {
    async fetch(req, env): Promise<Response> {
      const url = new URL(req.url)
      const path = url.pathname.replace(/\/+$/, '') || '/'
      if (path === '/healthz') return health(req, env)
      const isMcp = path === MCP_PATH
      if (!isMcp && path !== REST_PREFIX && !path.startsWith(REST_PREFIX + '/')) return problem(404, 'not-found', 'No such route.', `MCP is at ${MCP_PATH}; JSON at ${REST_PREFIX}.`)
      if (!originAllowed(req, env)) return problem(403, 'origin-not-allowed', 'Requests from this browser origin are not accepted.', 'Call from a server, or ask the operator to add the origin to ALLOWED_ORIGINS.')
      if (isMcp && req.method !== 'POST') {
        // Stateless: no server-initiated stream (GET) and no session to delete (DELETE).
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed: this server is stateless; send JSON-RPC with POST.' } }), { status: 405, headers: { Allow: 'POST', 'Content-Type': 'application/json' } })
      }
      // The tenant is the credential's. A request that tries to name one is refused, not ignored.
      if (url.searchParams.has('tenant')) return problem(400, 'tenant-not-accepted', 'A tenant was named in the query string. This surface never takes a tenant from a request.', 'Remove it; the tenant is always the one your credential belongs to.')

      let session: Session
      try {
        const authorization = req.headers.get('Authorization') ?? ''
        const control = make.control(env, authorization)
        const id = await identify(req, env, control ? (a: string) => make.control(env, a)! : null)
        const limits = { ...limitsFrom(env.MCP_LIMITS), ...(deps.limits ?? {}) }
        const now = deps.now?.() ?? Date.now()
        const usage = newUsage()
        const partial = { id, query: make.query(env, authorization), limits, now, usage }
        session = {
          ...partial,
          control,
          monitors: make.monitors(env, authorization),
          deadline: performance.now() + limits.deadlineMs,
          appUrl: env.APP_URL ?? 'https://vis.bitcru.sh',
          metricNames: namesLoader(partial),
        }
      } catch (e) {
        if (e instanceof AuthError) return authFailure(e, isMcp)
        console.error('mcp: identify failed', e instanceof Error ? e.message : String(e))
        return problem(503, 'unavailable', 'The credential could not be checked.', 'Retry in a moment.')
      }
      if (isMcp) return serveMcp(req, { session, budget })
      return serveRest(req, path, session, budget)
    },
  }
}

export default createWorker()
