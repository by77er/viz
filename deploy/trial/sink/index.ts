/**
 * viz-<stage>-sink: a webhook receiver for a staged trial (deploy/README.md, "Trial 2"). It is
 * the notifier's destination, set through control's notification settings, and it records
 * what arrives so the trial can check content and measure latency.
 *
 *   POST /hook/<SINK_TOKEN>   store { receivedAt, idempotencyKey, signature, signatureValid,
 *                             contentType, body } in KV under `recv:<receivedAt>:<random>`
 *   GET  /received            every stored record (Authorization: Bearer <SINK_TOKEN>)
 *
 * `receivedAt` is this Worker's clock when the request arrived. `signatureValid` is the
 * receiver's check of `X-Viz-Signature` with the shared secret (HMAC-SHA256 over
 * "<t>.<Idempotency-Key>.<body>", ruler/src/signature.ts), so the secret is used here and never
 * stored or returned. Nothing is accepted after EXPIRES_AT (410), so the trial stops by itself.
 */
interface Env {
  RECEIVED: KVNamespace
  SINK_TOKEN: string
  SINK_SECRET: string
  EXPIRES_AT: string
}

const enc = new TextEncoder()
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

async function signatureValid(secret: string, header: string | null, key: string, body: string, now: number): Promise<boolean> {
  const m = header === null ? null : /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header)
  if (!m) return false
  const t = Number(m[1])
  if (Math.abs(now - t * 1000) > 5 * 60_000) return false
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return same(hex(await crypto.subtle.sign('HMAC', k, enc.encode(`${t}.${key}.${body}`))), m[2]!)
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const receivedAt = Date.now()
    const url = new URL(req.url)
    if (receivedAt >= Date.parse(env.EXPIRES_AT)) return new Response('this trial receiver has expired\n', { status: 410 })
    if (req.method === 'POST' && url.pathname.startsWith('/hook/')) {
      if (!same(url.pathname.slice('/hook/'.length), env.SINK_TOKEN)) return new Response('not found\n', { status: 404 })
      const body = await req.text()
      const idempotencyKey = req.headers.get('Idempotency-Key')
      const signature = req.headers.get('X-Viz-Signature')
      const record = {
        receivedAt,
        idempotencyKey,
        signature,
        signatureValid: await signatureValid(env.SINK_SECRET, signature, idempotencyKey ?? '', body, receivedAt),
        contentType: req.headers.get('Content-Type'),
        userAgent: req.headers.get('User-Agent'),
        body,
      }
      await env.RECEIVED.put(`recv:${String(receivedAt).padStart(15, '0')}:${crypto.randomUUID()}`, JSON.stringify(record), { expirationTtl: 86_400 })
      return new Response(null, { status: 204 })
    }
    if (req.method === 'GET' && url.pathname === '/received') {
      if (!same(req.headers.get('Authorization') ?? '', `Bearer ${env.SINK_TOKEN}`)) return new Response('unauthorized\n', { status: 401 })
      const out: unknown[] = []
      let cursor: string | undefined
      do {
        const page = await env.RECEIVED.list({ prefix: 'recv:', cursor })
        for (const k of page.keys) {
          const v = await env.RECEIVED.get(k.name)
          if (v) out.push(JSON.parse(v))
        }
        cursor = page.list_complete ? undefined : page.cursor
      } while (cursor)
      return Response.json(out)
    }
    return new Response('not found\n', { status: 404 })
  },
} satisfies ExportedHandler<Env>
