/**
 * Trial 3 only: a stand-in for the ruler's future `SINK` binding, to check on Cloudflare that
 * viz-ingest's `RecordedSamples` entrypoint (contracts/ingest.ts) is reachable through a service
 * binding that names it, and refuses a binding that names another caller. Deployed as
 * `viz-<stage>-probe` on workers.dev for the length of a trial, then deleted.
 *
 * Bindings (deploy/trial/probe/wrangler.jsonc, staged by hand in the trial):
 *   SINK   viz-<stage>-ingest, entrypoint RecordedSamples, props { caller: "viz-ruler" }
 *   OTHER  the same entrypoint, props { caller: "viz-mcp" }
 *   PROBE_TOKEN  a secret set at deploy time; a request without it is 404
 *
 * POST / with `x-probe-token` and `{ "via": "SINK" | "OTHER", "tenant": "...", "batches": [...] }`:
 * calls `env[via].write(tenant, batches)` and answers `{ ok: true }` or `{ ok: false, error }`.
 */
interface Env {
  SINK: { write(tenant: string, batches: unknown[]): Promise<void> }
  OTHER: { write(tenant: string, batches: unknown[]): Promise<void> }
  PROBE_TOKEN?: string
}

async function sameToken(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))])
  return (crypto.subtle as unknown as { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean }).timingSafeEqual(x, y)
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const token = req.headers.get('x-probe-token') ?? ''
    if (req.method !== 'POST' || !env.PROBE_TOKEN || !(await sameToken(token, env.PROBE_TOKEN))) return new Response('not found', { status: 404 })
    const body = (await req.json()) as { via: 'SINK' | 'OTHER'; tenant: string; batches: unknown[] }
    const binding = body.via === 'OTHER' ? env.OTHER : env.SINK
    const started = Date.now()
    try {
      await binding.write(body.tenant, body.batches)
      return Response.json({ ok: true, ms: Date.now() - started })
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started })
    }
  },
} satisfies ExportedHandler<Env>
