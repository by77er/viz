/**
 * Spike s14: a preview of the web app. NOT the product: the API under /api is the app's MOCK
 * (app/mock/handler.ts: synthetic data and a subset of PromQL), and the app says so in its banner.
 * Files are served by app/serve.json's rules, as the gateway will serve them.
 */
import { createMockApi } from '../../app/mock/handler'
import serve from '../../app/serve.json'

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  EXPIRES_AT: string
}

// Made on the first request, not at module load: a Worker's clock reads 0 outside a request, and the
// mock fixes its monitors' times when it is created.
let api: ReturnType<typeof createMockApi> | undefined
const NO_INDEX = { 'X-Robots-Tag': 'noindex, nofollow' }

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...NO_INDEX, ...headers } })
}

async function file(env: Env, request: Request, path: string, headers: Record<string, string>): Promise<Response> {
  const found = await env.ASSETS.fetch(new Request(new URL(path, request.url), { method: request.method }))
  if (found.status !== 200) return text(404, 'not found\n')
  const ext = path.slice(path.lastIndexOf('.'))
  const type = path === '/index.html' ? undefined : (serve.contentTypes as Record<string, string>)[ext]
  if (path !== '/index.html' && !type) return text(404, 'not found\n')
  const out = new Headers(headers)
  if (type) out.set('Content-Type', type)
  for (const [k, v] of Object.entries(NO_INDEX)) out.set(k, v)
  return new Response(request.method === 'HEAD' ? null : found.body, { status: 200, headers: out })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (Date.now() >= Date.parse(env.EXPIRES_AT)) return text(410, 'this preview has expired\n')
    const url = new URL(request.url)
    const path = url.pathname

    if (path.startsWith('/api/')) {
      const body = request.method === 'POST' ? await request.text() : ''
      api ??= createMockApi()
      const res = api.handle(request.method, path + url.search, body, {
        authorization: request.headers.get('authorization') ?? undefined,
        'content-type': request.headers.get('content-type') ?? undefined,
      })
      return new Response(JSON.stringify(res.body), {
        status: res.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Viz-Mock': '1', Vary: 'Origin, Accept-Encoding', ...NO_INDEX, ...res.headers },
      })
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'method not allowed\n', { Allow: 'GET, HEAD' })
    if (serve.documents.includes(path)) return file(env, request, '/index.html', serve.headers.document)
    if (path.startsWith(serve.assetsPrefix) && !path.includes('..')) return file(env, request, path, serve.headers.asset)
    if (serve.files.includes(path)) return file(env, request, path, serve.headers.file)
    return text(404, 'not found\n')
  },
}
