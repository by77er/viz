/**
 * viz-gateway: the one public entry point (`vis.bitcru.sh`). It owns no data and makes no
 * decisions about tenants: it picks a backend by path and hands the request over through a
 * service binding, unchanged.
 *
 *   /api/v1/write, /api/v1/push, /v1/metrics                    → INGEST  (viz-ingest: edge)
 *   /v1/traces, /v1/logs, /loki/api/v1/push                     → INGEST  (OTLP/HTTP traces and logs, Loki push;
 *                                                                 edge serves them only with INGEST_SIGNALS, else 404)
 *   /api/v1/query, /query_range, /labels, /label/…, /series,
 *   /metadata, /status/…, /plan                                 → QUERY   (viz-query)
 *   Tempo: /api/traces/<id>, /api/v2/traces/<id>, /api/search,
 *   /api/search/tags, /api/v2/search/tags,
 *   /api/search/tag/<tag>/values, /api/v2/search/tag/<tag>/values,
 *   /api/metrics/query_range, /api/metrics/query, /api/echo     → QUERY   (viz-query serves them only with
 *   Loki: /loki/api/v1/query, /query_range, /labels,                        QUERY_SIGNALS, else 404)
 *   /label/<name>/values, /series                               → QUERY
 *   /api/v1/control, /api/v1/control/…                          → CONTROL (viz-control)
 *   /api/v1/rules, /api/v1/alerts, /api/v1/monitors,
 *   /api/v1/monitors/…                                          → RULER   (viz-ruler)
 *   /mcp, /api/v1/agent, /api/v1/agent/…                        → MCP     (viz-mcp)
 *   /.well-known/oauth-protected-resource[/mcp]                 → MCP     (OAuth protected resource metadata, RFC 9728)
 *   /.well-known/oauth-authorization-server, /oauth/register,
 *   /oauth/authorize, /oauth/token, /oauth/revoke               → CONTROL (the OAuth authorization server for MCP clients, D44)
 *   /healthz                                                    → this Worker: asks each backend's health route
 *   /api/v1/bootstrap (POST)                                    → this Worker: first key of a tenant, only while
 *                                                                 the one-time secret VIZ_BOOTSTRAP is set
 *   the web app's documents (/, /explore, …: GET and HEAD)      → this Worker: the document of the build this
 *                                                                 version was released with, from VIZ_APP
 *   the app's hashed assets and files (/assets/…, /favicon.svg) → never reach this Worker while they exist: they
 *                                                                 are this version's static assets, served by
 *                                                                 Cloudflare by exact path (deploy/lib/app.mjs)
 *   anything else                                               → 404, JSON listing the entry points; also a
 *                                                                 hashed asset this version does not hold
 *
 * The API comes first: a path `routeOf` routes is never the app's, whatever VIZ_APP says, and an
 * unknown API path is the JSON 404, never a page (design/DECISIONS.md D74).
 *
 * Transparency: the request object is passed on as it arrived (method, URL, headers, body
 * stream), and the backend's response is returned with its status, status text, headers and
 * body stream; the only change is the added `x-viz-route` header. Nothing is buffered.
 */

export interface Env {
  INGEST: Fetcher
  QUERY: Fetcher
  CONTROL: Fetcher
  RULER: Fetcher
  MCP: Fetcher
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
  /**
   * The web app this version serves, set by deploy/configure.mjs from app/serve.json and the build
   * (deploy/lib/app.mjs `appVar`): JSON `{ "v": 1, "build": "<hash>", "etag": "\"…\"", "documents":
   * ["/", …], "headers": { … }, "document": "<!doctype html>…" }`. Without it there is no app and
   * every such path is the ordinary 404.
   */
  VIZ_APP?: string
}

export type Backend = 'ingest' | 'query' | 'control' | 'ruler' | 'mcp'
export type Route = Backend | 'health' | 'bootstrap'

/** The web app as VIZ_APP describes it. */
export interface App {
  build: string
  etag: string
  documents: ReadonlySet<string>
  headers: Readonly<Record<string, string>>
  document: string
}

const INGEST_PATHS = new Set(['/api/v1/write', '/api/v1/push', '/v1/metrics'])
/**
 * Spans and log records (edge, behind `INGEST_SIGNALS`): the OTLP/HTTP default paths
 * (opentelemetry.io/docs/specs/otlp/, "OTLP/HTTP Request") and Loki's push path
 * (grafana.com/docs/loki/latest/reference/loki-http-api/, "Ingest logs"). Read 2026-11-19.
 */
const SIGNAL_INGEST_PATHS = new Set(['/v1/traces', '/v1/logs', '/loki/api/v1/push'])
const QUERY_PATHS = new Set(['/api/v1/query', '/api/v1/query_range', '/api/v1/labels', '/api/v1/series', '/api/v1/metadata', '/api/v1/plan'])
const QUERY_PREFIXES = ['/api/v1/label/', '/api/v1/status/']
/**
 * Tempo's and Loki's read paths that viz-query serves (behind `QUERY_SIGNALS`; query/src/sigroutes.ts),
 * as their documentation writes them (grafana.com/docs/tempo/latest/api_docs/, "Query" section;
 * grafana.com/docs/loki/latest/reference/loki-http-api/, "Query"; read 2026-11-19). Exact paths;
 * a path parameter (`<traceid>`, `<tag>`, `<name>`) is exactly one non-empty segment. Tempo's
 * `/api/echo` ("Returns status code 200 and body `echo` when the query frontend is up", a data
 * source's check: D62, query review m-4) is one of them. Their other
 * paths (Tempo's `/api/status/buildinfo`, `/api/overrides`; Loki's index, volume,
 * patterns, tail, detected fields, rules, delete, `/otlp/v1/logs`, the deprecated `/api/prom/…`)
 * are not served and stay 404 here.
 */
const SIGNAL_QUERY_PATHS = new Set([
  '/api/search',
  '/api/search/tags',
  '/api/v2/search/tags',
  '/api/metrics/query_range',
  '/api/metrics/query',
  '/api/echo',
  '/loki/api/v1/query',
  '/loki/api/v1/query_range',
  '/loki/api/v1/labels',
  '/loki/api/v1/series',
])
const SIGNAL_QUERY_PATTERNS = [/^\/api\/(?:v2\/)?traces\/[^/]+$/, /^\/api\/(?:v2\/)?search\/tag\/[^/]+\/values$/, /^\/loki\/api\/v1\/label\/[^/]+\/values$/]
const CONTROL_ROOT = '/api/v1/control'
/** The ruler's Prometheus-compatible reads, and the monitors API with everything under it (ruler/src/http.ts ROUTES). */
const RULER_PATHS = new Set(['/api/v1/rules', '/api/v1/alerts'])
const MONITORS_ROOT = '/api/v1/monitors'
/** The MCP endpoint (exactly; mcp/src/index.ts MCP_PATH) and the JSON agent API with everything under it. */
const MCP_PATH = '/mcp'
const AGENT_ROOT = '/api/v1/agent'
/** OAuth for MCP clients (contracts/oauth.ts): the resource's metadata is mcp's, the authorization server is control. Exact paths. */
const MCP_OAUTH_PATHS = new Set(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'])
const CONTROL_OAUTH_PATHS = new Set(['/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/authorize', '/oauth/token', '/oauth/revoke'])

/** Which handler a path goes to, or null for 404. Exact paths (one segment for a path parameter), except the prefixes. */
export function routeOf(path: string): Route | null {
  if (path === '/healthz') return 'health'
  if (path === '/api/v1/bootstrap') return 'bootstrap'
  if (INGEST_PATHS.has(path) || SIGNAL_INGEST_PATHS.has(path)) return 'ingest'
  if (QUERY_PATHS.has(path) || QUERY_PREFIXES.some((p) => path.startsWith(p))) return 'query'
  if (SIGNAL_QUERY_PATHS.has(path) || SIGNAL_QUERY_PATTERNS.some((p) => p.test(path))) return 'query'
  if (path === CONTROL_ROOT || path.startsWith(`${CONTROL_ROOT}/`) || CONTROL_OAUTH_PATHS.has(path)) return 'control'
  if (RULER_PATHS.has(path) || path === MONITORS_ROOT || path.startsWith(`${MONITORS_ROOT}/`)) return 'ruler'
  if (path === MCP_PATH || path === AGENT_ROOT || path.startsWith(`${AGENT_ROOT}/`) || MCP_OAUTH_PATHS.has(path)) return 'mcp'
  return null
}

/** The health route each backend serves without a credential, reached only through its service binding. */
export const HEALTH_PATHS: Record<Backend, string> = {
  ingest: '/healthz',
  query: '/healthz',
  control: '/healthz',
  ruler: '/healthz',
  mcp: '/healthz',
}

export const ENTRYPOINTS = {
  ingest: [
    'POST /api/v1/write (Prometheus Remote Write 1.0)',
    'POST /v1/metrics (OTLP/HTTP metrics)',
    'POST /api/v1/push',
    'POST /v1/traces, POST /v1/logs (OTLP/HTTP traces and logs; when the deployment enables them)',
    'POST /loki/api/v1/push (Loki push; when the deployment enables logs)',
  ],
  query: [
    'GET|POST /api/v1/query',
    'GET|POST /api/v1/query_range',
    'GET|POST /api/v1/labels',
    'GET /api/v1/label/<name>/values',
    'GET|POST /api/v1/series',
    'GET /api/v1/metadata',
    'GET /api/v1/status/buildinfo',
    'GET|POST /api/v1/plan (what a query would read, without running it)',
    'GET /api/traces/<id>, /api/v2/traces/<id>, /api/search, /api/search/tags, /api/v2/search/tags, /api/search/tag/<tag>/values, /api/v2/search/tag/<tag>/values, /api/metrics/query_range, /api/metrics/query, /api/echo (Tempo; when the deployment enables traces)',
    'GET|POST /loki/api/v1/query, /loki/api/v1/query_range, /loki/api/v1/labels, /loki/api/v1/label/<name>/values, /loki/api/v1/series (Loki; when the deployment enables logs)',
  ],
  control: [
    '/api/v1/control/… (OpenAPI: GET /api/v1/control/openapi.json)',
    'GET /.well-known/oauth-authorization-server (OAuth for MCP clients)',
    'POST /oauth/register, GET /oauth/authorize, POST /oauth/token, POST /oauth/revoke',
  ],
  ruler: ['GET /api/v1/rules', 'GET /api/v1/alerts', '/api/v1/monitors, /api/v1/monitors/… (monitors, groups, rule files, notifier, silences)'],
  mcp: ['POST /mcp (Model Context Protocol, Streamable HTTP)', '/api/v1/agent, /api/v1/agent/… (the same tools as JSON)', 'GET /.well-known/oauth-protected-resource/mcp (OAuth protected resource metadata)'],
  health: ['GET /healthz'],
}

const BINDING: Record<Backend, keyof Pick<Env, 'INGEST' | 'QUERY' | 'CONTROL' | 'RULER' | 'MCP'>> = { ingest: 'INGEST', query: 'QUERY', control: 'CONTROL', ruler: 'RULER', mcp: 'MCP' }
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
  const names: Backend[] = ['ingest', 'query', 'control', 'ruler', 'mcp']
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

// ---- the web app ----

/**
 * VIZ_APP, parsed and checked; null when it is absent or not what configure.mjs writes (then there
 * is no app, rather than a page with headers guessed). A document path is a plain path that
 * `routeOf` does not route: the API's paths are never the app's.
 */
export function parseApp(raw: string | undefined): App | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { v?: unknown; build?: unknown; etag?: unknown; documents?: unknown; headers?: unknown; document?: unknown }
    if (v.v !== 1 || typeof v.build !== 'string' || typeof v.document !== 'string' || v.document === '') return null
    if (typeof v.etag !== 'string' || !/^"[0-9a-f]{8,64}"$/.test(v.etag)) return null
    if (!Array.isArray(v.documents) || v.documents.length === 0 || !v.documents.every((p) => typeof p === 'string' && p.startsWith('/') && routeOf(p) === null)) return null
    if (typeof v.headers !== 'object' || v.headers === null || Array.isArray(v.headers)) return null
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(v.headers)) {
      if (typeof value !== 'string' || !/^[\x20-\x7e]+$/.test(value)) return null
      headers[name] = value
    }
    const lower = new Map(Object.entries(headers).map(([k, x]) => [k.toLowerCase(), x]))
    // A document without its policy, or one a cache may keep, is not served at all.
    if (!lower.get('content-security-policy') || !/^text\/html\b/.test(lower.get('content-type') ?? '') || !/\bno-cache\b|\bno-store\b/.test(lower.get('cache-control') ?? '')) return null
    return { build: v.build, etag: v.etag, documents: new Set(v.documents as string[]), headers, document: v.document }
  } catch {
    return null
  }
}

/** The app of the var last seen: an isolate parses each value once. */
let appCache: { raw: string | undefined; app: App | null } | null = null
function appOf(env: Env): App | null {
  if (appCache === null || appCache.raw !== env.VIZ_APP) {
    appCache = { raw: env.VIZ_APP, app: parseApp(env.VIZ_APP) }
    if (env.VIZ_APP && appCache.app === null) console.error('gateway: VIZ_APP is not a description of the web app; no page is served')
  }
  return appCache.app
}

/** `If-None-Match` names this entity tag (weak comparison: a compressing proxy weakens the tag), or `*`. */
function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false
  return header.split(',').some((t) => {
    const tag = t.trim()
    return tag === '*' || tag === etag || tag === `W/${etag}`
  })
}

/**
 * A document of the web app: 200 with the build's document and exactly the headers app/serve.json
 * gives a document, for GET and HEAD of a listed path; null for everything else (the caller
 * answers 404). The path is compared as it was sent: `/explore/`, `/Explore` and `/index.html` are
 * not documents. A revalidation that names the document's entity tag gets 304.
 */
function appDocument(req: Request, env: Env, path: string): Response | null {
  const app = appOf(env)
  if (app === null || !app.documents.has(path)) return null
  if (req.method !== 'GET' && req.method !== 'HEAD') return null
  const headers = new Headers(app.headers)
  headers.set('ETag', app.etag)
  headers.set('x-viz-route', 'app')
  if (matchesEtag(req.headers.get('If-None-Match'), app.etag)) return new Response(null, { status: 304, headers })
  return new Response(req.method === 'HEAD' ? null : app.document, { status: 200, headers })
}

export async function handle(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const path = new URL(req.url).pathname
  const route = routeOf(path)
  // Not the API's: a document of the app, or the 404 (also for an asset this version does not hold,
  // which Cloudflare hands to the Worker: never the document, never cached).
  if (route === null) return appDocument(req, env, path) ?? notFound()
  if (route === 'health') return health(req, env)
  if (route === 'bootstrap') return bootstrap(req, env, now)
  return forward(req, env, route)
}

export default {
  fetch: (req, env) => handle(req, env),
} satisfies ExportedHandler<Env>
