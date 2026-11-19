import { authenticate, clearAuthCache } from './auth'
import { Collector } from './batch'
import { HttpError, badRequest, tooLarge } from './errors'
import { type Limits, limitsFrom } from './limits'
import { decodeOtlpJson, decodeOtlpProto, exportResponse, statusBody } from './otlp'
import { decodeRemoteWrite } from './prw'
import { type Limited, type Outcome, type RouteEnv, appendAll, clearMapCache, refuseEarly } from './route'
import { snappyDecompress } from './snappy'

// For now the shard is deployed in the same script as the edge Worker.
export { Shard } from '../../shard/src/shard'

export interface Env extends RouteEnv {
  /** JSON overriding any of `Limits` (src/limits.ts). */
  INGEST_LIMITS?: string
}

/** Drop the in-memory key and pool-map caches (tests; also harmless in production). */
export function clearCaches(): void {
  clearAuthCache()
  clearMapCache()
}

const text = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } })

/** The request body, refused with 413 as soon as it is known to exceed `max`. */
async function readBody(req: Request, max: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get('Content-Length') ?? '')
  if (declared > max) throw tooLarge(`body of ${declared} bytes exceeds the limit of ${max}`)
  if (!req.body) return new Uint8Array(0)
  return drain(req.body, max, 'body')
}

async function drain(stream: ReadableStream<Uint8Array>, max: number, what: string): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw tooLarge(`${what} exceeds the limit of ${max} bytes`)
    }
    chunks.push(value)
  }
  if (chunks.length === 1) return chunks[0]!
  const out = new Uint8Array(total)
  let p = 0
  for (const ch of chunks) {
    out.set(ch, p)
    p += ch.byteLength
  }
  return out
}

/** Inflate gzip with the size limit enforced while streaming, so a bomb is cut off early. */
async function gunzip(body: Uint8Array, max: number): Promise<Uint8Array> {
  const inflated = new Blob([body as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'))
  try {
    return await drain(inflated, max, 'decompressed body')
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw badRequest('malformed gzip body')
  }
}

const retryAfter = (ms: number): string => String(Math.max(1, Math.ceil(ms / 1000)))

/** What the sender is told when new series were refused: which limit, how full, how much was dropped. */
export const limitMessage = (l: Limited): string =>
  `active series limit reached: the limit is ${l.limit} active series per tenant (${l.share} on each of its shards, ${l.current} active on the fullest); ` +
  `${l.series} new series with ${l.rows} samples refused; samples of series that are already active were accepted`

// ───────────────────────── Prometheus Remote Write ─────────────────────────

async function remoteWrite(req: Request, env: Env, limits: Limits): Promise<Response> {
  const { tenant } = await authenticate(req, env.CONFIG, 'write')

  const contentType = (req.headers.get('Content-Type') ?? '').toLowerCase()
  if (contentType.includes('io.prometheus.write.v2')) {
    return text(415, 'Remote Write 2.0 is not supported; send Remote Write 1.0 (prometheus.WriteRequest)', {
      Accept: 'application/x-protobuf',
      'Accept-Encoding': 'snappy',
    })
  }
  if (contentType !== '' && !contentType.startsWith('application/x-protobuf')) {
    return text(415, 'unsupported content type; expected application/x-protobuf', { Accept: 'application/x-protobuf', 'Accept-Encoding': 'snappy' })
  }
  const encoding = (req.headers.get('Content-Encoding') ?? 'snappy').toLowerCase()
  if (encoding !== 'snappy') return text(415, 'unsupported content encoding; expected snappy', { 'Accept-Encoding': 'snappy' })
  // Every shard this tenant may write to is shedding load: refuse before reading or decoding.
  const early = await refuseEarly(env, tenant)
  if (early) return refusal(early, (status, message, headers) => text(status, message, headers))

  const compressed = await readBody(req, limits.maxBodyBytes)
  const body = snappyDecompress(compressed, limits.maxDecompressedBytes)
  const c = new Collector(limits, Date.now(), body.byteLength)
  decodeRemoteWrite(body, c)

  const outcome = await appendAll(env, tenant, c)
  if (outcome.status !== 'ok') return refusal(outcome, (status, message, headers) => text(status, message, headers))
  const written = { 'X-Prometheus-Remote-Write-Samples-Written': String(outcome.rows) }
  // New series over the tenant's limit: 400, naming the limit and what was refused. The
  // samples of series the tenant already has are durably written. Not 429: a sender that
  // retries 429 would resend the same new series for ever and fall behind on the series it
  // has (review R-4); Remote Write senders "MUST NOT retry ... 4xx responses other than
  // 429", and invalid samples are answered 400 (prometheus.io remote write spec 1.0).
  if (outcome.limited) {
    const also = c.rejectedTotal > 0 ? `; also rejected ${c.rejectedTotal} samples (${c.rejectionSummary()})` : ''
    return text(400, `${limitMessage(outcome.limited)}; ${outcome.rows} samples written${also}`, written)
  }
  // Remote Write has no partial success: if anything was rejected the answer is 400
  // (not retried by the sender), saying what was wrong and how much was still written.
  if (c.rejectedTotal > 0) {
    return text(400, `rejected ${c.rejectedTotal} of ${c.received} samples (${c.rejectionSummary()}); ${outcome.rows} written`, written)
  }
  return new Response(null, { status: 204, headers: written })
}

// ──────────────────────────────── OTLP/HTTP ────────────────────────────────

async function otlpMetrics(req: Request, env: Env, limits: Limits): Promise<Response> {
  const contentType = (req.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase()
  const json = contentType === 'application/json'
  const type = json ? 'application/json' : 'application/x-protobuf'
  // OTLP error bodies are a google.rpc.Status in the request's encoding.
  const fail = (status: number, message: string, headers: Record<string, string> = {}): Response =>
    new Response(statusBody(json, status, message), { status, headers: { 'Content-Type': type, ...headers } })
  try {
    const { tenant } = await authenticate(req, env.CONFIG, 'write')
    if (!json && contentType !== 'application/x-protobuf') {
      return text(415, 'unsupported content type; expected application/x-protobuf or application/json')
    }
    const encoding = (req.headers.get('Content-Encoding') ?? 'identity').toLowerCase()
    if (encoding !== 'identity' && encoding !== 'gzip') return fail(415, 'unsupported content encoding; expected gzip or none', { 'Accept-Encoding': 'gzip' })

    const early = await refuseEarly(env, tenant)
    if (early) return refusal(early, fail)

    let body = await readBody(req, limits.maxBodyBytes)
    if (encoding === 'gzip') body = await gunzip(body, limits.maxDecompressedBytes)
    else if (body.byteLength > limits.maxDecompressedBytes) throw tooLarge(`body exceeds the limit of ${limits.maxDecompressedBytes} bytes`)

    const c = new Collector(limits, Date.now(), body.byteLength)
    if (json) decodeOtlpJson(body, c)
    else decodeOtlpProto(body, c)

    const outcome = await appendAll(env, tenant, c)
    if (outcome.status !== 'ok') return refusal(outcome, fail)
    // 200 means: every point not listed as rejected is durably appended.
    // Series refused for the active-series limit are a partial success too: a retry would not fix them.
    const l = outcome.limited
    const message = [c.rejectionSummary(), l ? limitMessage(l) : ''].filter((x) => x !== '').join('; ')
    return new Response(exportResponse(json, c.rejectedTotal + (l?.rows ?? 0), message), { status: 200, headers: { 'Content-Type': type } })
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.message, e.headers)
    throw e
  }
}

/** A request that was not (entirely) appended: never 2xx, always retryable with a hint. */
function refusal(
  outcome: Exclude<Outcome, { status: 'ok' }>,
  render: (status: number, message: string, headers: Record<string, string>) => Response,
): Response {
  if (outcome.status === 'backpressure') {
    return render(429, 'ingest buffer is full; retry the whole request', { 'Retry-After': retryAfter(outcome.retryAfterMs) })
  }
  if (outcome.status === 'overloaded') {
    return render(503, 'ingest shard is overloaded; retry the whole request', { 'Retry-After': retryAfter(outcome.retryAfterMs) })
  }
  return render(503, `${outcome.reason}; retry the whole request`, { 'Retry-After': '1' })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname
    try {
      if (path === '/healthz') {
        return req.method === 'GET' || req.method === 'HEAD' ? text(200, 'ok\n') : text(405, 'method not allowed', { Allow: 'GET' })
      }
      if (path === '/api/v1/write' || path === '/v1/metrics') {
        if (req.method !== 'POST') return text(405, 'method not allowed', { Allow: 'POST' })
        const limits = limitsFrom(env.INGEST_LIMITS)
        return await (path === '/v1/metrics' ? otlpMetrics(req, env, limits) : remoteWrite(req, env, limits))
      }
      return text(404, 'not found')
    } catch (e) {
      if (e instanceof HttpError) return text(e.status, e.message, e.headers)
      // Details of unexpected errors stay in the logs; nothing from the request is echoed.
      console.error('edge: unhandled error', e instanceof Error ? e.stack : String(e))
      return text(500, 'internal error')
    }
  },
} satisfies ExportedHandler<Env>
