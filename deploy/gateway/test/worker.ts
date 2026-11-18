/**
 * The test Worker's main module: the gateway itself as the default export, the REAL control
 * plane's Tenant object (so /api/v1/bootstrap is tested against control/'s `provision`), and
 * three fake backends reached through service bindings to this same Worker, as the gateway
 * reaches viz-ingest, viz-query and viz-control in production.
 */
import { WorkerEntrypoint } from 'cloudflare:workers'

export { default } from '../src/index'
export { Tenant } from '../../../control/src/tenant'

/** What a fake backend saw, echoed in its response so a test can compare it with what was sent. */
async function echo(name: string, req: Request): Promise<Response> {
  const url = new URL(req.url)
  // Behaviour selected by the test through the path below /__fake/.
  if (url.pathname.endsWith('/__fake/status')) {
    const status = Number(url.searchParams.get('code') ?? '200')
    const headers = new Headers({ 'x-fake-backend': name, 'Retry-After': '7', 'WWW-Authenticate': 'Bearer realm="viz"' })
    headers.append('Set-Cookie', 'a=1; Path=/')
    headers.append('Set-Cookie', 'b=2; Path=/')
    return new Response(status === 204 || status === 304 ? null : `status ${status}`, { status, statusText: `Fake ${status}`, headers })
  }
  if (url.pathname.endsWith('/__fake/stream')) {
    // First chunk at once, the second after a pause: a gateway that buffers delivers both together.
    const ts = new TransformStream<Uint8Array, Uint8Array>()
    const writer = ts.writable.getWriter()
    const enc = new TextEncoder()
    void (async () => {
      await writer.write(enc.encode('first;'))
      await new Promise((r) => setTimeout(r, 600))
      await writer.write(enc.encode('second'))
      await writer.close()
    })()
    return new Response(ts.readable, { headers: { 'x-fake-backend': name, 'Content-Type': 'text/plain' } })
  }
  if (url.pathname.endsWith('/__fake/throw')) throw new Error('fake backend failure')
  if (url.pathname === '/healthz' || url.pathname === '/api/v1/control/openapi.json') return new Response('ok', { headers: { 'x-fake-backend': name } })
  // Default: describe the request exactly.
  let bytes = 0
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', req.body ? await new Response(req.body).arrayBuffer().then((b) => ((bytes = b.byteLength), b)) : new ArrayBuffer(0)))
  const headers: Record<string, string> = {}
  req.headers.forEach((v, k) => (headers[k] = v))
  return Response.json(
    { backend: name, method: req.method, url: req.url, headers, bodyBytes: bytes, bodySha256: [...hash].map((b) => b.toString(16).padStart(2, '0')).join('') },
    { headers: { 'x-fake-backend': name } },
  )
}

export class FakeIngest extends WorkerEntrypoint {
  fetch(req: Request) {
    return echo('ingest', req)
  }
}
export class FakeQuery extends WorkerEntrypoint {
  fetch(req: Request) {
    return echo('query', req)
  }
}
export class FakeControl extends WorkerEntrypoint {
  fetch(req: Request) {
    return echo('control', req)
  }
}
