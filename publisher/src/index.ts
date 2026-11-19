export { Publisher } from './publisher'
export type {
  CommitStep,
  PublishResult,
  PublisherConfig,
  PublisherEnv,
  R2Ops,
  TableReport,
  TenantReport,
  TenantStatus,
  VerifyResult,
} from './publisher'
export type { Cursor } from './log'
export { nudge, NUDGE_TIMEOUT_MS, type PublisherNamespace } from './nudge'

/** What the Worker itself is bound to (wrangler.jsonc): the publisher's namespace and the cell's bucket. */
interface PublisherWorkerEnv {
  PUBLISHER?: DurableObjectNamespace
  BUCKET?: R2Bucket
}

/**
 * The Worker has no API: the publisher is reached over its Durable Object binding (the
 * maintenance run's nudge, the janitor's `safeToDelete`). It answers only `GET /healthz`, for
 * the deploy (deploy/workers.json): 200 `ok` when it runs with both bindings, 503 naming a
 * missing one. It calls no object and no bucket: a probe would wake the cell's publisher.
 * Anything else is 404.
 */
export function health(req: Request, env: PublisherWorkerEnv): Response {
  const text = (status: number, body: string, extra: Record<string, string> = {}) =>
    new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra } })
  if (new URL(req.url).pathname !== '/healthz') return text(404, 'not found\n')
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'method not allowed\n', { Allow: 'GET, HEAD' })
  const missing = (['PUBLISHER', 'BUCKET'] as const).filter((b) => !env[b])
  if (missing.length) return text(503, `misconfigured: no ${missing.join(' or ')} binding\n`)
  return text(200, 'ok\n')
}

export default {
  fetch: (req, env) => health(req, env),
} satisfies ExportedHandler<PublisherWorkerEnv>
