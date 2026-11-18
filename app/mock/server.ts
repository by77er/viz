/**
 * Development mock of the viz query API. NOT a real backend: synthetic data, PromQL subset.
 *
 *   npx tsx mock/server.ts [--port 8821] [--require-token secret] [--delay 0]
 *
 * Artificial latency, to exercise the waiting states:
 *   --delay <ms> or VIZ_MOCK_DELAY=<ms>   every response waits this long
 *   ?delay=<ms> on a request              that response waits this long
 *   GET /__mock/delay?ms=<ms>             from now on, query and query_range responses wait this long
 *                                         (0 turns it off; the answer reports the current value)
 */
import { createServer } from 'node:http'
import { createMockApi, MOCK_VERSION } from './handler'
import { syntheticStorage } from './data'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const port = Number(arg('port', process.env.VIZ_MOCK_PORT ?? '8821'))
const delay = Number(arg('delay', process.env.VIZ_MOCK_DELAY ?? '0'))
/** Set at run time through /__mock/delay; applies to the two query endpoints only. */
let queryDelay = 0
const requireToken = arg('require-token', '') || undefined
const api = createMockApi({ requireToken })

const server = createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end()
    return
  }
  const reqUrl = new URL(req.url ?? '/', 'http://mock.invalid')
  if (reqUrl.pathname === '/__mock/delay') {
    const ms = Number(reqUrl.searchParams.get('ms'))
    if (reqUrl.searchParams.has('ms') && Number.isFinite(ms) && ms >= 0) queryDelay = ms
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ queryDelayMs: queryDelay }))
    return
  }
  const isQuery = /\/api\/v1\/query(_range)?$/.test(reqUrl.pathname)
  const perRequest = Number(reqUrl.searchParams.get('delay'))
  const wait = Math.max(delay, isQuery ? queryDelay : 0, Number.isFinite(perRequest) ? perRequest : 0)
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const started = performance.now()
    const out = api.handle(req.method ?? 'GET', req.url ?? '/', Buffer.concat(chunks).toString('utf8'), {
      authorization: req.headers.authorization,
    })
    const payload = JSON.stringify(out.body)
    const send = () => {
      res.writeHead(out.status, { ...cors, 'Content-Type': 'application/json', 'X-Viz-Mock': '1', 'Cache-Control': 'no-store' })
      res.end(payload)
    }
    if (wait > 0) setTimeout(send, wait)
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
