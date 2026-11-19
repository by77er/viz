/**
 * viz-gateway: the one public entry point (`vis.bitcru.sh`). It owns no data and makes no
 * decisions about tenants: it picks a backend by path and hands the request over through a
 * service binding, unchanged.
 *
 *   /api/v1/write, /api/v1/push, /v1/metrics                    → INGEST  (viz-ingest: edge)
 *   /api/v1/query, /query_range, /labels, /label/…, /series,
 *   /metadata, /status/…                                        → QUERY   (viz-query)
 *   /api/v1/control, /api/v1/control/…                          → CONTROL (viz-control)
 *   /healthz                                                    → this Worker: asks each backend's health route
 *   /api/v1/bootstrap (POST)                                    → this Worker: first key of a tenant, only while
 *                                                                 the one-time secret VIZ_BOOTSTRAP is set
 *   anything else                                               → 404, JSON listing the entry points
 *
 * Transparency: the request object is passed on as it arrived (method, URL, headers, body
 * stream), and the backend's response is returned with its status, status text, headers and
 * body stream; the only change is the added `x-viz-route` header. Nothing is buffered.
 */

export interface Env {
  INGEST: Fetcher
  QUERY: Fetcher
  CONTROL: Fetcher
  /** control's Tenant Durable Object, bound by script_name. Used only by /api/v1/bootstrap. */
  TENANT: DurableObjectNamespace
  /**
   * One-time bootstrap secret, set by deploy/bootstrap.mjs for a few seconds and then deleted:
   * JSON `{ "tenant": "...", "tokenSha256": "<hex>", "expiresAt": <unix ms> }`. The tenant is
   * part of the credential, never of the request.
   */
  VIZ_BOOTSTRAP?: string
  /** The release (git SHA) this version was built from; set by deploy/configure.mjs. */
  VIZ_RELEASE?: string
}

export type Backend = 'ingest' | 'query' | 'control'
export type Route = Backend | 'health' | 'bootstrap'

const INGEST_PATHS = new Set(['/api/v1/write', '/api/v1/push', '/v1/metrics'])
const QUERY_PATHS = new Set(['/api/v1/query', '/api/v1/query_range', '/api/v1/labels', '/api/v1/series', '/api/v1/metadata'])
const QUERY_PREFIXES = ['/api/v1/label/', '/api/v1/status/']
const CONTROL_ROOT = '/api/v1/control'

/** Which handler a path goes to, or null for 404. Exact paths, except the three prefixes. */
export function routeOf(path: string): Route | null {
  if (path === '/healthz') return 'health'
  if (path === '/api/v1/bootstrap') return 'bootstrap'
  if (INGEST_PATHS.has(path)) return 'ingest'
  if (QUERY_PATHS.has(path) || QUERY_PREFIXES.some((p) => path.startsWith(p))) return 'query'
  if (path === CONTROL_ROOT || path.startsWith(`${CONTROL_ROOT}/`)) return 'control'
  return null
}

/** The health route each backend serves without a credential, reached only through its service binding. */
export const HEALTH_PATHS: Record<Backend, string> = {
  ingest: '/healthz',
  query: '/healthz',
  control: '/healthz',
}

export const ENTRYPOINTS = {
  ingest: ['POST /api/v1/write (Prometheus Remote Write 1.0)', 'POST /v1/metrics (OTLP/HTTP metrics)', 'POST /api/v1/push'],
  query: [
    'GET|POST /api/v1/query',
    'GET|POST /api/v1/query_range',
    'GET|POST /api/v1/labels',
    'GET /api/v1/label/<name>/values',
    'GET|POST /api/v1/series',
    'GET /api/v1/metadata',
    'GET /api/v1/status/buildinfo',
  ],
  control: ['/api/v1/control/… (OpenAPI: GET /api/v1/control/openapi.json)'],
  health: ['GET /healthz'],
}

const BINDING: Record<Backend, keyof Pick<Env, 'INGEST' | 'QUERY' | 'CONTROL'>> = { ingest: 'INGEST', query: 'QUERY', control: 'CONTROL' }
const HEALTH_TIMEOUT_MS = 5_000
const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/ // contracts/ledger.ts TENANT_ID

function json(status: number, body: unknown, route: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'x-viz-route': route, ...extra },
  })
}

/** Hand the request to a backend and return its answer as it came, plus `x-viz-route`. */
async function forward(req: Request, env: Env, backend: Backend): Promise<Response> {
  let res: Response
  try {
    res = await env[BINDING[backend]].fetch(req)
  } catch (e) {
    // The backend threw instead of answering. Nothing was acknowledged: retryable.
    console.error(`gateway: ${backend} did not answer`, e instanceof Error ? e.message : String(e))
    return json(502, { status: 'error', errorType: 'unavailable', error: `${backend} did not answer; retry` }, backend, { 'Retry-After': '1' })
  }
  // `new Response(body, init)` keeps status, statusText and every header (Set-Cookie included);
  // the body is the same stream, not a copy. The headers of a fetched Response are immutable,
  // hence the new object.
  const out = new Response(res.body, res)
  out.headers.set('x-viz-route', backend)
  return out
}

async function probe(env: Env, backend: Backend): Promise<{ ok: boolean; status: number | null; ms: number; error?: string }> {
  const start = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS)
  try {
    const res = await env[BINDING[backend]].fetch(new Request(`https://gateway.internal${HEALTH_PATHS[backend]}`, { signal: ctrl.signal }))
    await res.body?.cancel()
    return { ok: res.status === 200, status: res.status, ms: Date.now() - start }
  } catch (e) {
    return { ok: false, status: null, ms: Date.now() - start, error: ctrl.signal.aborted ? 'timeout' : 'no answer' }
  } finally {
    clearTimeout(timer)
  }
}

async function health(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'method not allowed' }, 'health', { Allow: 'GET, HEAD' })
  const names: Backend[] = ['ingest', 'query', 'control']
  const results = await Promise.all(names.map((b) => probe(env, b)))
  const backends = Object.fromEntries(names.map((b, i) => [b, results[i]]))
  const healthy = results.every((r) => r.ok)
  return json(healthy ? 200 : 503, { status: healthy ? 'healthy' : 'unhealthy', release: env.VIZ_RELEASE ?? null, backends }, 'health')
}

// ---- bootstrap ----

interface BootstrapSecret {
  tenant: string
  tokenSha256: string
  expiresAt: number
}

function parseSecret(raw: string): BootstrapSecret | null {
  try {
    const v = JSON.parse(raw) as Partial<BootstrapSecret>
    if (typeof v.tenant !== 'string' || !TENANT_ID.test(v.tenant)) return null
    if (typeof v.tokenSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.tokenSha256)) return null
    if (typeof v.expiresAt !== 'number' || !Number.isFinite(v.expiresAt)) return null
    return { tenant: v.tenant, tokenSha256: v.tokenSha256, expiresAt: v.expiresAt }
  } catch {
    return null
  }
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16)
  return out
}

/** Equal-length comparison without an early exit. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

function bearer(req: Request): string | null {
  const h = req.headers.get('Authorization')
  const m = h ? /^Bearer\s+(\S+)$/i.exec(h.trim()) : null
  return m ? m[1]! : null
}

interface TenantRpc {
  provision(tenant: string, keyName?: string): Promise<{ key: string; id: string }>
}

/**
 * POST /api/v1/bootstrap: the first API key of a tenant, created by control's
 * `Tenant.provision` (which refuses a tenant that already has a key). Exists only while the
 * one-time secret is set; otherwise this path is the ordinary 404. The tenant comes from the
 * secret the operator set, never from the request: the request carries only the token.
 */
async function bootstrap(req: Request, env: Env, now: number): Promise<Response> {
  if (!env.VIZ_BOOTSTRAP) return notFound()
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' }, 'bootstrap', { Allow: 'POST' })
  const secret = parseSecret(env.VIZ_BOOTSTRAP)
  if (!secret) return json(503, { error: 'bootstrap is misconfigured; run deploy/bootstrap.mjs again' }, 'bootstrap')
  const token = bearer(req)
  const presented = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token ?? '')))
  // Compare even when no token was sent, so both paths cost the same.
  const match = sameBytes(presented, hexBytes(secret.tokenSha256))
  if (token === null || !match) return json(401, { error: 'invalid bootstrap token' }, 'bootstrap', { 'WWW-Authenticate': 'Bearer realm="viz-bootstrap"' })
  if (now >= secret.expiresAt) return json(403, { error: 'the bootstrap window has closed; run deploy/bootstrap.mjs again' }, 'bootstrap')
  const url = new URL(req.url)
  const body = req.body ? await req.arrayBuffer() : new ArrayBuffer(0)
  if (url.search !== '' || body.byteLength > 0) {
    return json(400, { error: 'bootstrap takes no parameters and no body: the tenant is the one bound into the one-time secret' }, 'bootstrap')
  }
  const stub = env.TENANT.get(env.TENANT.idFromName(secret.tenant)) as unknown as TenantRpc
  try {
    const out = await stub.provision(secret.tenant, 'first admin key')
    return json(201, { tenant: secret.tenant, keyId: out.id, key: out.key, scopes: ['admin'], shownOnce: true }, 'bootstrap')
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (/already provisioned/.test(message)) return json(409, { error: 'this tenant already has keys; create further keys through /api/v1/control/keys' }, 'bootstrap')
    // control's storage for this tenant was written by a newer release (contracts/COMPATIBILITY.md §2.4):
    // nothing was created, and the same call works once that release serves the object again.
    if (/^schema_too_new/.test(message)) {
      return json(503, { error: 'a newer release holds this tenant\'s control-plane storage (a deploy or rollback is in progress); nothing was created; retry' }, 'bootstrap', { 'Retry-After': '30' })
    }
    console.error('gateway: provision failed', message)
    return json(500, { error: 'provisioning failed; nothing was created' }, 'bootstrap')
  }
}

function notFound(): Response {
  return json(404, { status: 'error', errorType: 'not_found', error: 'not found', entrypoints: ENTRYPOINTS }, 'gateway')
}

export async function handle(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const route = routeOf(new URL(req.url).pathname)
  if (route === null) return notFound()
  if (route === 'health') return health(req, env)
  if (route === 'bootstrap') return bootstrap(req, env, now)
  return forward(req, env, route)
}

export default {
  fetch: (req, env) => handle(req, env),
} satisfies ExportedHandler<Env>
