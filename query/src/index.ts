/**
 * The query Worker: the Prometheus HTTP API over one tenant's lake files and shard tails.
 *
 *   GET|POST /api/v1/query                 instant query
 *   GET|POST /api/v1/query_range           range query
 *   GET|POST /api/v1/labels                label names
 *   GET      /api/v1/label/<name>/values   label values
 *   GET|POST /api/v1/series                series by `match[]`
 *   GET      /api/v1/metadata              always empty (no metadata is stored)
 *   GET      /api/v1/status/buildinfo      minimal
 *   GET|POST /api/v1/plan                  what a query would read and how it would run, without running it
 *   GET      /healthz                      no authentication
 *
 * The tenant is the one the API key belongs to (`edge/src/auth.ts`, scope `read`). No
 * header, path segment, parameter or body field is read for it: a request cannot name a
 * tenant.
 */
import { authenticate } from '../../edge/src/auth'
import { HttpError } from '../../edge/src/errors'
import { EngineLoadError, type Grid, QueryError, type SplitPlan, createQueryEngine } from '../../engine/wasm-query/js/index'
import wasm from '../../engine/wasm-query/js/viz_query.wasm'
import { ConfigError, type Env, tenantLimits } from './config'
import { ApiError, type Context, type Cost, MAX_TS, MIN_TS, type QueryPlan, type SplitSpec, addStats, cardinality, gather, gatherSeries, newCost, timedOut } from './coordinator'
import { cardinalityParams, limitParam, parseTime, rangeParams, readParams, required, timeoutParam, windowParams } from './params'

export { Leaf } from './leaf'
export type { Env } from './config'

/** One engine per isolate. Calls are synchronous, so concurrent requests never interleave inside it. */
export const engine = createQueryEngine(wasm)

/** WASM memory never shrinks. After a query that grew it past this, drop the instance. */
const RESET_WASM_ABOVE = 48 << 20

const STATUS: Record<string, number> = {
  bad_data: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  // Prometheus: errorExec → 422. `unsupported` is not a Prometheus error type; valid
  // PromQL this engine does not implement is "cannot be executed" too.
  execution: 422,
  unsupported: 422,
  internal: 500,
  unavailable: 503,
  timeout: 503,
}

const COST_HEADERS: [string, keyof Cost][] = [
  ['X-Viz-Ledger-Version', 'ledgerVersion'],
  ['X-Viz-Plan-Attempts', 'planAttempts'],
  ['X-Viz-Files-Listed', 'filesListed'],
  ['X-Viz-Files-Skipped', 'filesSkipped'],
  ['X-Viz-Files-Read', 'filesRead'],
  ['X-Viz-Scan-Samples', 'scanSamples'],
  ['X-Viz-Series-Estimate', 'seriesEstimate'],
  ['X-Viz-Bytes-Read', 'bytesRead'],
  ['X-Viz-Cache-Hits', 'cacheHits'],
  ['X-Viz-R2-Gets', 'r2Gets'],
  ['X-Viz-Leaf-Calls', 'leafCalls'],
  ['X-Viz-Leaves-Used', 'leavesUsed'],
  ['X-Viz-Leaf-Rounds', 'leafRounds'],
  ['X-Viz-Shards-Asked', 'shardsAsked'],
  ['X-Viz-Shard-Calls', 'shardCalls'],
  ['X-Viz-Tail-Batches', 'tailBatches'],
  ['X-Viz-Tail-Bytes', 'tailBytes'],
  ['X-Viz-Series-Loaded', 'seriesLoaded'],
  ['X-Viz-Samples-Loaded', 'samplesLoaded'],
  ['X-Viz-Engine-Ms', 'engineMs'],
  ['X-Viz-Wasm-Memory-Bytes', 'wasmMemoryBytes'],
  ['X-Viz-Execution', 'execution'],
  ['X-Viz-Split-Reason', 'splitReason'],
  ['X-Viz-Split-Leaves', 'splitLeaves'],
  ['X-Viz-Reader-Calls', 'readerCalls'],
  ['X-Viz-Rpc-Bytes', 'rpcBytes'],
  ['X-Viz-Leaf-Peak-Wasm-Bytes', 'leafPeakWasmBytes'],
  ['X-Viz-Leaf-Max-Samples', 'leafMaxSamples'],
  ['X-Viz-Leaf-Reruns', 'leafReruns'],
  ['X-Viz-Pruning', 'pruning'],
  ['X-Viz-Tail-Mode', 'tailMode'],
  ['X-Viz-Series-Reads', 'seriesReads'],
]

const allowedOrigins = (env: Env): string[] => (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '' && s !== '*')

/**
 * CORS for the app's origin: the request's origin is echoed only if it is on the
 * allow-list. Never `*`. The API is authenticated by a bearer key, not by cookies, so
 * `Access-Control-Allow-Credentials` is never sent.
 */
function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin')
  // Accept-Encoding too: the runtime compresses answers for clients that ask (app/README.md).
  const h: Record<string, string> = { Vary: 'Origin, Accept-Encoding' }
  if (origin && allowedOrigins(env).includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, Accept'
    h['Access-Control-Expose-Headers'] = COST_HEADERS.map(([n]) => n).join(', ')
    h['Access-Control-Max-Age'] = '600'
  }
  return h
}

const JSON_TYPE = { 'Content-Type': 'application/json' }

/** `data` is JSON text: the engine's results go out exactly as the engine wrote them. `warnings` only when there are some (Prometheus' envelope). */
function success(data: string, headers: Record<string, string>, warnings: string[] = []): Response {
  const w = warnings.length > 0 ? `,"warnings":${JSON.stringify(warnings)}` : ''
  return new Response(`{"status":"success","data":${data}${w}}`, { status: 200, headers: { ...JSON_TYPE, ...headers } })
}

/** Prometheus' warning when `limit` cut a result (`web/api/v1/api.go`). */
export const TRUNCATED = 'results truncated due to limit'

/**
 * A query's `data` (JSON text as the engine wrote it) with at most `limit` series (0: all):
 * a matrix or vector keeps its first `limit` series, a scalar or string is left alone
 * (Prometheus: "Doesn't affect scalars or strings but truncates the number of series for
 * matrices and vectors"). The text is cut between elements of `result`, never parsed, so no
 * sample value passes through a JavaScript number.
 */
export function limitResult(c: Context, data: string, limit: number): string {
  if (limit <= 0 || !/^\{"resultType":"(matrix|vector)","result":\[/.test(data)) return data
  const open = data.indexOf('[', data.indexOf('"result":'))
  let depth = 0
  let inString = false
  let elements = 0
  let cut = -1
  for (let i = open + 1; i < data.length; i++) {
    const ch = data[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      if (depth === 0) {
        // The end of `result`: fewer series than the limit, nothing to cut.
        return data
      }
      depth--
      if (depth === 0 && ++elements === limit) {
        cut = i + 1
        break
      }
    }
  }
  if (cut < 0) return data
  // Anything after the limit-th series is dropped up to the end of `result`.
  let end = cut
  depth = 0
  inString = false
  for (; end < data.length; end++) {
    const ch = data[end]
    if (inString) {
      if (ch === '\\') end++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      if (depth === 0) break
      depth--
    }
  }
  if (end === cut) return data
  c.warnings = [...(c.warnings ?? []), TRUNCATED]
  return data.slice(0, cut) + data.slice(end)
}

/** The first `limit` items of a sorted list (0: all), with Prometheus' warning when some were cut. */
function truncate<T>(c: Context, list: T[], limit: number): T[] {
  if (limit <= 0 || list.length <= limit) return list
  c.warnings = [...(c.warnings ?? []), TRUNCATED]
  return list.slice(0, limit)
}

function failure(errorType: string, error: string, headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ status: 'error', errorType, error }), { status: STATUS[errorType] ?? 500, headers: { ...JSON_TYPE, ...headers } })
}

function costHeaders(cost: Cost): Record<string, string> {
  const h: Record<string, string> = {}
  // Header values are printable ASCII: a reason may quote a query.
  for (const [name, field] of COST_HEADERS) h[name] = String(cost[field]).replace(/[^\x20-\x7e]/g, '?').slice(0, 300)
  return h
}

/** The split spec of a query that decomposes; for one that does not, the reason is recorded. */
function splitSpec(c: Context, plan: SplitPlan, query: string, grid: Grid): SplitSpec<string> | undefined {
  if (!plan.split) {
    c.cost.execution = 'single'
    c.cost.splitReason = plan.reason
    return undefined
  }
  return {
    query,
    grid,
    fragments: plan.fragments,
    without: plan.without,
    done: (out) => {
      addStats(c, out.stats)
      return out.json
    },
  }
}

type Handler = (c: Context, params: URLSearchParams, label: string) => Promise<string>

const instant: Handler = async (c, params) => {
  const query = required(params, 'query')
  const limit = limitParam(params)
  const t = params.get('time')
  const time = t === null || t === '' ? Math.min(Math.max(Date.now(), MIN_TS), MAX_TS) : parseTime('time', t)
  const ranges = c.engine.plan(query, time, time, 1, c.limits)
  const split = splitSpec(c, c.engine.splitPlan(query, c.limits), query, { time })
  return gather(
    c,
    ranges,
    c.engine.selectors(query, time, time, 1, c.limits),
    (input) => {
      const out = c.engine.queryInstantJson(input, query, time, c.limits)
      addStats(c, out.stats)
      return out.json
    },
    split,
  ).then((data) => limitResult(c, data, limit))
}

const range: Handler = async (c, params) => {
  const query = required(params, 'query')
  const { start, end, step } = rangeParams(params)
  const limit = limitParam(params)
  const ranges = c.engine.plan(query, start, end, step, c.limits)
  const split = splitSpec(c, c.engine.splitPlan(query, c.limits), query, { start, end, step })
  return gather(
    c,
    ranges,
    c.engine.selectors(query, start, end, step, c.limits),
    (input) => {
      const out = c.engine.queryRangeJson(input, query, start, end, step, c.limits)
      addStats(c, out.stats)
      return out.json
    },
    split,
  ).then((data) => limitResult(c, data, limit))
}

/**
 * `/api/v1/plan`: what a query would read and how it would run, from one ledger read and
 * nothing else (no shard, leaf or R2 is touched; the tail is not read, so its bytes are
 * not in the answer). The parameters of `query_range` (`start`, `end`, `step`) or of
 * `query` (`time`, default now). A query the limits would refuse before fetching is
 * answered with 200 and the refusal in `refusal`, so a client can show why.
 */
const plan: Handler = async (c, params) => {
  const query = required(params, 'query')
  const isRange = params.has('start') || params.has('end') || params.has('step')
  const t = params.get('time')
  const instantTime = t === null || t === '' ? Math.min(Math.max(Date.now(), MIN_TS), MAX_TS) : parseTime('time', t)
  const { start, end, step } = isRange ? rangeParams(params) : { start: instantTime, end: instantTime, step: 1 }
  const ranges = c.engine.plan(query, start, end, step, c.limits)
  const split = splitSpec(c, c.engine.splitPlan(query, c.limits), query, isRange ? { start, end, step } : { time: start })
  const notEvaluated = (): string => {
    throw new ApiError('internal', 'a plan-only request reached evaluation')
  }
  return gather(c, ranges, c.engine.selectors(query, start, end, step, c.limits), notEvaluated, split, (p: QueryPlan) => JSON.stringify(p))
}

/** Fetch ranges of a metadata call: one per `match[]` set, or one for every series. */
function metaRanges(c: Context, match: string[], start: number, end: number) {
  const sets = match.length === 0 ? [[]] : c.engine.parseSelectors(match)
  return sets.map((matchers) => ({ matchers, minTs: start, maxTs: end }))
}

/**
 * The label endpoints read series files and the tail, never samples (`gatherSeries`), and
 * are bounded by the series they list (`maxMetadataSeries`) instead of a query's limits.
 */
const metaLimits = (c: Context) => ({ ...c.limits, maxSeries: c.limits.maxMetadataSeries })

/**
 * The three label endpoints: one place, or over leaves when the series files or the tail do
 * not fit one place (`gatherSeries`), with the same answer; then Prometheus' `limit`: the
 * first `limit` of the sorted list, and a warning when some were cut (as Prometheus does for
 * these three). The cap on series listed (`maxMetadataSeries`) binds before the limit.
 */
async function listing(c: Context, params: URLSearchParams, kind: 'names' | 'values' | 'series', name: string): Promise<string> {
  const { start, end } = windowParams(params)
  const match = params.getAll('match[]')
  if (kind === 'series' && match.length === 0) throw new ApiError('bad_data', 'no match[] parameter provided')
  const limit = limitParam(params)
  const ranges = metaRanges(c, match, start, end)
  const limits = metaLimits(c)
  const json = await gatherSeries(c, ranges, { kind, name, match, start, end, limits }, (input) =>
    JSON.stringify(kind === 'names' ? c.engine.labelNames(input, match, start, end, limits) : kind === 'values' ? c.engine.labelValues(input, name, match, start, end, limits) : c.engine.series(input, match, start, end, limits)),
  )
  if (limit === 0) return json
  return JSON.stringify(truncate(c, JSON.parse(json) as unknown[], limit))
}

const labels: Handler = (c, params) => listing(c, params, 'names', '')
const labelValues: Handler = (c, params, label) => listing(c, params, 'values', label)
const series: Handler = (c, params) => listing(c, params, 'series', '')

/**
 * Prometheus' `/api/v1/status/tsdb`: cardinality of the tenant over a window (default the
 * last day; `start`, `end` or `range` move it), `limit` items per list (default 10).
 * `chunkCount` is null: viz has no chunks.
 */
const tsdbStatus: Handler = async (c, params) => {
  const w = cardinalityParams(params, Date.now())
  return (await cardinality(c, w.start, w.end, w.lookbackStart, w.limit)).tsdb
}

/** viz's `/api/v1/status/cardinality?range=&limit=`: the same counts, plus churn and per-metric label cardinality. */
const cardinalityStatus: Handler = async (c, params) => {
  const w = cardinalityParams(params, Date.now())
  return (await cardinality(c, w.start, w.end, w.lookbackStart, w.limit)).cardinality
}

/** Nothing here reads storage; both still require a key, like every other API path. */
const metadata: Handler = async () => '{}'
const buildinfo: Handler = async () => JSON.stringify({ version: '0.1.0-viz', revision: '', branch: '', buildUser: '', buildDate: '', goVersion: '' })

function route(path: string): { handler: Handler; methods: string[]; label: string } | null {
  switch (path) {
    case '/api/v1/query':
      return { handler: instant, methods: ['GET', 'POST'], label: '' }
    case '/api/v1/query_range':
      return { handler: range, methods: ['GET', 'POST'], label: '' }
    case '/api/v1/labels':
      return { handler: labels, methods: ['GET', 'POST'], label: '' }
    case '/api/v1/series':
      return { handler: series, methods: ['GET', 'POST'], label: '' }
    case '/api/v1/metadata':
      return { handler: metadata, methods: ['GET'], label: '' }
    case '/api/v1/status/buildinfo':
      return { handler: buildinfo, methods: ['GET'], label: '' }
    case '/api/v1/status/tsdb':
      return { handler: tsdbStatus, methods: ['GET'], label: '' }
    case '/api/v1/status/cardinality':
      return { handler: cardinalityStatus, methods: ['GET'], label: '' }
    case '/api/v1/plan':
      return { handler: plan, methods: ['GET', 'POST'], label: '' }
  }
  const m = /^\/api\/v1\/label\/([^/]+)\/values$/.exec(path)
  if (!m) return null
  let label: string
  try {
    label = decodeURIComponent(m[1]!)
  } catch {
    return null
  }
  return { handler: labelValues, methods: ['GET'], label }
}

function timeout(ms: number, why: string): { promise: Promise<never>; cancel: () => void } {
  let id: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<never>((_, reject) => {
    id = setTimeout(() => reject(new ApiError('timeout', timedOut(why))), ms)
  })
  return { promise, cancel: () => clearTimeout(id) }
}

async function api(req: Request, env: Env, path: string, corsHeaders: Record<string, string>): Promise<Response> {
  const r = route(path)
  if (!r) return failure('not_found', 'not found', corsHeaders)
  if (!r.methods.includes(req.method)) return failure('method_not_allowed', 'method not allowed', { ...corsHeaders, Allow: r.methods.join(', ') })

  const cost = newCost()
  let headers = corsHeaders
  let warnings: string[] = []
  try {
    // The ONLY source of the tenant.
    const { tenant } = await authenticate(req, env.CONFIG, 'read')
    const limits = await tenantLimits(env, tenant)
    const params = await readParams(req)
    const ms = timeoutParam(params, limits.timeoutMs)
    const why = `${ms / 1000} s (${ms < limits.timeoutMs ? 'the timeout parameter' : 'the tenant’s limit, timeoutMs'})`
    const c: Context = { env, engine, tenant, limits, cost, deadline: Date.now() + ms, deadlineWhy: why, queryId: crypto.randomUUID() }
    const t = timeout(ms, why)
    let data: string
    try {
      data = await Promise.race([r.handler(c, params, r.label), t.promise])
      warnings = c.warnings ?? []
    } finally {
      t.cancel()
      headers = { ...corsHeaders, ...costHeaders(cost) }
      if (engine.memoryBytes() > RESET_WASM_ABOVE) engine.reset()
    }
    return success(data, headers, warnings)
  } catch (e) {
    // The engine could not be loaded: retrying cannot help, so 500, not a retryable 503.
    if (e instanceof EngineLoadError) {
      console.error('query: the engine did not load', e.message)
      return failure('internal', 'the query engine could not be loaded', headers)
    }
    // A component whose storage is newer than this release reads (contracts/COMPATIBILITY.md
    // §2.4): retryable, nothing happened.
    if (e instanceof Error && e.message.startsWith('schema_too_new')) return failure('unavailable', 'a storage component runs a newer schema than this release reads; retry', { ...headers, 'Retry-After': '5' })
    if (e instanceof ApiError && e.errorType === 'unavailable') return failure(e.errorType, e.message, { ...headers, 'Retry-After': '1' })
    if (e instanceof ApiError) return failure(e.errorType, e.message, headers)
    if (e instanceof QueryError) return failure(e.errorType, e.message, headers)
    if (e instanceof ConfigError) return failure('unavailable', e.message, { ...headers, 'Retry-After': '30' })
    if (e instanceof HttpError) {
      // From edge's key check (401, 403) and pool-map lookup (503).
      const type = e.status === 401 ? 'unauthorized' : e.status === 403 ? 'forbidden' : e.status === 503 ? 'unavailable' : 'internal'
      return failure(type, e.message, { ...headers, ...e.headers })
    }
    // Nothing of the failure or of the request is echoed.
    if (e instanceof RangeError || e instanceof TypeError) {
      console.error('query: internal error', e.stack)
      return failure('internal', 'internal error', headers)
    }
    // A shard, the ledger or a leaf threw (overloaded, reset): retryable.
    console.error('query: unhandled error', e instanceof Error ? e.stack : String(e))
    return failure('unavailable', 'a storage component did not answer; retry', { ...headers, 'Retry-After': '1' })
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname
    if (path === '/healthz') {
      return req.method === 'GET' || req.method === 'HEAD'
        ? new Response('ok\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
        : new Response('method not allowed', { status: 405, headers: { Allow: 'GET' } })
    }
    const corsHeaders = cors(req, env)
    // A preflight carries no credentials; it is answered from the allow-list alone.
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
    return api(req, env, path, corsHeaders)
  },
} satisfies ExportedHandler<Env>
