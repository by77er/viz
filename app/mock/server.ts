/**
 * Development mock of the viz query API. NOT a real backend: synthetic data, PromQL subset.
 *
 *   npx tsx mock/server.ts [--port 8821] [--require-token secret] [--delay 0]
 */
import { createServer } from 'node:http'
import { createMockApi, MOCK_VERSION } from './handler'
import { syntheticStorage } from './data'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const port = Number(arg('port', process.env.VIZ_MOCK_PORT ?? '8821'))
const delay = Number(arg('delay', '0'))
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
    if (delay > 0) setTimeout(send, delay)
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
