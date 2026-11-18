/**
 * Development mock of the viz query API. NOT a real backend: synthetic data, PromQL subset.
 *
 *   npx tsx mock/server.ts [--port 8821] [--require-token secret] [--readless-token other] [--delay 0]
 *
 * Artificial latency, to exercise the waiting states:
 *   --delay <ms> or VIZ_MOCK_DELAY=<ms>   every response waits this long
 *   ?delay=<ms> on a request              that response waits this long
 *   GET /__mock/delay?ms=<ms>             from now on, query and query_range responses wait this long
 *                                         (0 turns it off; the answer reports the current value)
 *   GET /__mock/delay?ms=<ms>&stall=1     the same, as a stalled connection: the API's time limit
 *                                         does not apply (the real API answers 503 `timeout` at 30 s)
 *
 * Failures the real API (or the platform in front of it) answers with, to exercise the error
 * states. Each is the exact response the real stack gives for that case (e2e/contract.cjs):
 *   GET /__mock/fail?kind=<kind>&count=<n>   the next n query and query_range requests fail
 *     busy      503 unavailable "the query service is busy; retry"       (no Retry-After)
 *     storage   503 unavailable "a storage component did not answer; retry", Retry-After: 1
 *     config    503 unavailable (an unreadable limits record), Retry-After: 30
 *     gateway   502 unavailable "query did not answer; retry", Retry-After: 1 (deploy/gateway)
 *     timeout   503 timeout "query timed out"
 *     ratelimit 429, plain text, Retry-After: 10 (NOT the viz API: a rate limit in front of it)
 *   GET /__mock/fail?count=0                 clears it
 *
 * The time limit: like the real API (`timeoutMs`, 30 s, lowered by a `timeout` parameter), a
 * query that would take longer is answered 503 `timeout` at the limit.
 */
import { createServer } from 'node:http'
import { costHeaders, createMockApi, fail, MOCK_VERSION, type MockResponse } from './handler'
import { syntheticStorage } from './data'
import { durationSeconds } from './promql'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const port = Number(arg('port', process.env.VIZ_MOCK_PORT ?? '8821'))
const delay = Number(arg('delay', process.env.VIZ_MOCK_DELAY ?? '0'))
/** The real API's default query time limit (query/src/config.ts `timeoutMs`). */
const TIME_LIMIT_MS = 30_000
/** Set at run time through /__mock/delay; applies to the two query endpoints only. */
let queryDelay = 0
let stall = false
/** Set at run time through /__mock/fail. */
let failure: { kind: string; left: number } = { kind: '', left: 0 }
const requireToken = arg('require-token', '') || undefined
const readlessToken = arg('readless-token', '') || undefined
const api = createMockApi({ requireToken, readlessToken })

const FAILURES: Record<string, () => MockResponse & { text?: string }> = {
  busy: () => fail('unavailable', 'the query service is busy; retry', costHeaders(0)),
  storage: () => fail('unavailable', 'a storage component did not answer; retry', { ...costHeaders(0), 'Retry-After': '1' }),
  // Refused before any work: the real API sends no cost headers with it.
  config: () => fail('unavailable', "the tenant's query limits: maxSamples must be a non-negative integer", { 'Retry-After': '30' }),
  gateway: () => ({ status: 502, body: { status: 'error', errorType: 'unavailable', error: 'query did not answer; retry' }, headers: { 'Retry-After': '1', 'x-viz-route': 'query' } }),
  timeout: () => fail('timeout', 'query timed out', costHeaders(TIME_LIMIT_MS)),
  ratelimit: () => ({ status: 429, body: null, text: 'error code: 1015', headers: { 'Retry-After': '10', 'Content-Type': 'text/plain; charset=UTF-8' } }),
}

/** The CORS headers of the real API for an origin it allows; the mock allows every origin (it is for development). */
function cors(origin: string | undefined): Record<string, string> {
  const h: Record<string, string> = { Vary: 'Origin' }
  if (!origin) return h
  return {
    ...h,
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Expose-Headers': Object.keys(costHeaders(0)).join(', '),
    'Access-Control-Max-Age': '600',
  }
}

/** The query's time limit: the API's, lowered by a `timeout` parameter (a number of seconds or a duration). */
function timeLimitMs(params: URLSearchParams): number {
  const t = params.get('timeout')
  if (!t) return TIME_LIMIT_MS
  const n = Number(t)
  const s = Number.isFinite(n) ? n : /^(?:\d+(?:ms|[smhdwy]))+$/.test(t) ? durationSeconds(t) : NaN
  return Number.isFinite(s) && s > 0 ? Math.min(TIME_LIMIT_MS, s * 1000) : TIME_LIMIT_MS
}

const server = createServer((req, res) => {
  const c = cors(req.headers.origin)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, c).end()
    return
  }
  const reqUrl = new URL(req.url ?? '/', 'http://mock.invalid')
  if (reqUrl.pathname === '/__mock/delay') {
    const ms = Number(reqUrl.searchParams.get('ms'))
    if (reqUrl.searchParams.has('ms') && Number.isFinite(ms) && ms >= 0) {
      queryDelay = ms
      stall = reqUrl.searchParams.get('stall') === '1'
    }
    res.writeHead(200, { ...c, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ queryDelayMs: queryDelay, stall }))
    return
  }
  if (reqUrl.pathname === '/__mock/fail') {
    const kind = reqUrl.searchParams.get('kind') ?? ''
    const count = Number(reqUrl.searchParams.get('count') ?? '1')
    failure = count > 0 && FAILURES[kind] ? { kind, left: count } : { kind: '', left: 0 }
    res.writeHead(200, { ...c, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(failure))
    return
  }
  const isQuery = /\/api\/v1\/query(_range)?$/.test(reqUrl.pathname)
  const perRequest = Number(reqUrl.searchParams.get('delay'))
  const wait = Math.max(delay, isQuery ? queryDelay : 0, Number.isFinite(perRequest) ? perRequest : 0)
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const started = performance.now()
    const body = Buffer.concat(chunks).toString('utf8')
    let out: MockResponse & { text?: string } = api.handle(req.method ?? 'GET', req.url ?? '/', body, {
      authorization: req.headers.authorization,
      'content-type': req.headers['content-type'],
    })
    let after = wait
    if (isQuery && out.status !== 401 && out.status !== 403) {
      if (failure.left > 0) {
        failure.left--
        out = FAILURES[failure.kind]!()
      } else if (!stall) {
        // The real API stops a query at its time limit and says so; a stalled connection does not.
        const params = new URLSearchParams(reqUrl.search)
        if (req.method === 'POST') for (const [k, v] of new URLSearchParams(body)) params.append(k, v)
        const limit = timeLimitMs(params)
        if (wait > limit) {
          out = fail('timeout', 'query timed out', costHeaders(limit))
          after = limit
        }
      }
    }
    const payload = out.text ?? JSON.stringify(out.body)
    const send = () => {
      res.writeHead(out.status, { ...c, 'Content-Type': 'application/json', 'X-Viz-Mock': '1', 'Cache-Control': 'no-store', ...out.headers })
      res.end(payload)
    }
    if (after > 0) setTimeout(send, after)
    else send()
    if (process.env.VIZ_MOCK_LOG) {
      console.log(`${req.method} ${req.url?.split('?')[0]} -> ${out.status} ${(performance.now() - started).toFixed(1)} ms ${payload.length} B`)
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  const n = syntheticStorage().all().length
  console.log(`viz MOCK backend ${MOCK_VERSION} listening on http://127.0.0.1:${port} (${n} synthetic series; PromQL subset)`)
})
