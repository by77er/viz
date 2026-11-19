import { Problem } from './errors'
import { type Identity, type IdentityEnv, identify } from './identity'
import { OAUTH_PATHS, readCapped, serveOAuth } from './oauth-http'
import { deadListStatus } from './deadlist'
import { LIMITERS, type RateLimitEnv, limiterStatus } from './ratelimit'
import { type OpInput, type OpName, type OpResult, PREFIX, matchRoute } from './routes'
import type { TenantEnv } from './tenant'
import spec from '../openapi.json'

export { Tenant } from './tenant'
// The agent surface's one question (contracts/oauth.ts OAUTH_INTROSPECTION_ENTRYPOINT): bound by
// mcp/ as a service binding naming it, instead of the Tenant class.
export { OAuthIntrospection } from './introspection'
export { clearAuthCache } from '../../edge/src/auth'

/**
 * The tenant control plane's HTTP API: /api/v1/control/…
 *
 * This Worker does four things and nothing else: CORS, finding out who is calling
 * (`identify`), turning the request into an operation from the route table, and handing
 * it to the caller's own Tenant object. Which object that is comes from the credential
 * alone; a request that tries to name a tenant is refused.
 *
 * It also serves the OAuth authorization server's public endpoints for agents
 * (`/.well-known/oauth-authorization-server`, `/oauth/…`: src/oauth-http.ts, D44), and exports
 * `OAuthIntrospection`, the entrypoint the agent surface checks access tokens through
 * (src/introspection.ts).
 */
export interface Env extends IdentityEnv, TenantEnv, RateLimitEnv {
  /** Comma-separated origins allowed to call from a browser. */
  CORS_ALLOW_ORIGINS?: string
}

/** A dashboard's state as screen 1 shows it. It is computed from data, which the control plane never holds. */
export interface DashboardState {
  level: 'ok' | 'info' | 'warn' | 'crit' | 'no-data'
  label: string
  evaluatedAt: string
}

export interface Hooks {
  /**
   * The state hook. Whatever evaluates thresholds against data (the query layer) supplies
   * this; the list then carries its answer in each item's `state`. Without it, `state` is null.
   * It receives the tenant from the credential and only the ids on the page being returned.
   */
  dashboardStates?: (tenant: string, ids: string[]) => Promise<Record<string, DashboardState | undefined>>
}

const MAX_BODY_BYTES = 1024 * 1024
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin')
  const allowed = (env.CORS_ALLOW_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  // Not on the list: no CORS headers at all, so a browser on that origin cannot read the answer.
  if (!origin || !allowed.includes(origin)) return { Vary: 'Origin' }
  return {
    Vary: 'Origin',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match',
    'Access-Control-Expose-Headers': 'ETag, WWW-Authenticate',
    'Access-Control-Max-Age': '600',
  }
}

function respond(result: OpResult, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(result.body), { status: result.status, headers: { ...JSON_HEADERS, ...cors, ...(result.headers ?? {}) } })
}

const problemResult = (p: Problem): OpResult => ({ status: p.status, body: p.body(), headers: { ...p.headers, 'Content-Type': 'application/problem+json' } })

async function readBody(req: Request): Promise<unknown> {
  if (req.method === 'GET' || !req.body) return undefined
  // Read with a cap: a body without Content-Length is never buffered past it.
  const bytes = await readCapped(req, MAX_BODY_BYTES)
  if (bytes === null) throw new Problem(413, 'body-too-large', `The request body may be at most ${MAX_BODY_BYTES} bytes.`, 'Send a smaller request.')
  if (bytes.length === 0) return undefined
  const type = (req.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/json' && type !== 'application/json-patch+json') {
    throw new Problem(415, 'not-json', 'The request body must be JSON.', 'Send "Content-Type: application/json".')
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new Problem(400, 'bad-json', 'The request body is not valid JSON.', 'Send a JSON object.')
  }
}

function ifMatch(req: Request): string | undefined {
  const h = req.headers.get('If-Match')
  if (h === null) return undefined
  const m = /^\s*(?:W\/)?"([^"]*)"\s*$/.exec(h)
  if (!m) throw new Problem(400, 'bad-if-match', 'If-Match must be one quoted revision.', 'Send If-Match: "<revision>" with the ETag of your last read; "*" and lists are not supported.')
  return m[1]
}

const tenantNotAccepted = (where: string): Problem =>
  new Problem(400, 'tenant-not-accepted', `A tenant was named in the ${where}. This API never takes a tenant from a request.`, 'Remove it. The tenant is always the one your credential belongs to (see GET /api/v1/control/whoami).')

/**
 * `GET /healthz`: outside the API and without a credential, as viz-ingest and viz-query
 * serve it, for the gateway's `/healthz` to call through its service binding (the gateway
 * answers the public `/healthz` itself and never forwards it, so this is not public).
 * 200 when this Worker runs with its two bindings; 503 naming a missing one. It calls
 * no Tenant object and no KV: without a credential there is no tenant to ask, and a probe
 * object would be storage of its own to migrate on every release.
 *
 * The body's first line is `ok`; the lines after it say whether OAuth can issue anything
 * (`OAUTH_CLIENT_KEY` set or absent; never its value) and, for each rate limiter in front of OAuth
 * (D70), whether it is `bound`, `absent`, or `skipped` (bound, and failed in this isolate in the
 * last few seconds: src/ratelimit.ts), and the same of the list of dead credentials
 * (`OAUTH_DEAD_LIST`, src/deadlist.ts: `skipped` after a failed KV read). An absent limiter does not make this 503: the checks fail
 * open by design, and whether a deployment may run without them is the deploy's gate to keep
 * (control/README.md, "Needed changes elsewhere"). The gateway reads only the status.
 */
function health(req: Request, env: Env): Response {
  const text = (status: number, body: string, extra: Record<string, string> = {}) =>
    new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra } })
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'method not allowed\n', { Allow: 'GET, HEAD' })
  const missing = (['TENANT', 'CONFIG'] as const).filter((b) => !env[b])
  if (missing.length) return text(503, `misconfigured: no ${missing.join(' or ')} binding\n`)
  const limits = limiterStatus(env)
  const oauthKey = typeof env.OAUTH_CLIENT_KEY === 'string' && env.OAUTH_CLIENT_KEY.length >= 32 ? 'set' : 'absent'
  return text(200, ['ok', `OAUTH_CLIENT_KEY: ${oauthKey}`, ...LIMITERS.map((n) => `${n}: ${limits[n]}`), `OAUTH_DEAD_LIST: ${deadListStatus(env)}`, ''].join('\n'))
}

export function createWorker(hooks: Hooks = {}): ExportedHandler<Env> {
  async function handle(req: Request, env: Env): Promise<OpResult> {
    const url = new URL(req.url)
    if (!url.pathname.startsWith(`${PREFIX}/`)) throw new Problem(404, 'not-found', 'No such resource.', `The control API lives under ${PREFIX}/; see ${PREFIX}/openapi.json.`)
    const path = url.pathname.slice(PREFIX.length)
    if (path === '/openapi.json' && req.method === 'GET') return { status: 200, body: spec }
    const match = matchRoute(req.method, path)
    if (match.kind === 'none') throw new Problem(404, 'not-found', 'No such resource.', `See ${PREFIX}/openapi.json for the routes.`)
    if (match.kind === 'method') throw new Problem(405, 'method-not-allowed', `${req.method} is not supported here.`, `Use one of: ${match.allow.join(', ')}.`, {}, { Allow: match.allow.join(', ') })

    const identity: Identity = await identify(req, env)

    if (url.searchParams.has('tenant')) throw tenantNotAccepted('query string')
    const query: Record<string, string[]> = {}
    for (const [k, v] of url.searchParams) (query[k] ??= []).push(v)
    const body = await readBody(req)
    if (typeof body === 'object' && body !== null && !Array.isArray(body) && 'tenant' in body) throw tenantNotAccepted('body')
    const input: OpInput = { params: match.params, query, body, ifMatch: ifMatch(req) }

    // The one place a Tenant object is chosen: by the credential's tenant.
    const tenant = env.TENANT.get(env.TENANT.idFromName(identity.tenant))
    // (The RPC stub's mapped type cannot express `unknown` bodies, hence the plain signature.)
    const rpc = tenant as unknown as { invoke(id: Identity, op: OpName, input: OpInput): Promise<OpResult> }
    const result = await rpc.invoke(identity, match.route.op as OpName, input)

    if (match.route.op === 'dashboards.list' && result.status === 200 && hooks.dashboardStates) {
      const page = result.body as { items: { id: string; state: DashboardState | null }[] }
      const states = await hooks.dashboardStates(identity.tenant, page.items.map((d) => d.id))
      for (const item of page.items) item.state = states[item.id] ?? null
    }
    return result
  }

  return {
    async fetch(req, env, ctx): Promise<Response> {
      const pathname = new URL(req.url).pathname
      if (pathname === '/healthz') return health(req, env)
      if (OAUTH_PATHS.has(pathname)) return serveOAuth(req, env, ctx)
      const cors = corsHeaders(req, env)
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
      try {
        return respond(await handle(req, env), cors)
      } catch (e) {
        if (e instanceof Problem) return respond(problemResult(e), cors)
        // Never echo an internal error: it could carry another request's data.
        console.error('control: unhandled error', e instanceof Error ? e.message : String(e))
        return respond(problemResult(new Problem(500, 'internal', 'Something went wrong on our side. Nothing was changed.', 'Retry. If it keeps failing, report the time of the request.')), cors)
      }
    },
  }
}

export default createWorker()
