// S3 re-run load generator: each client is its own Durable Object sending real Remote Write
// requests one after another to a target script through a service binding (as ../loadgen.ts),
// with each request's status and latency recorded, and a refused client waiting as a sender
// would: the response's Retry-After, capped at `backoff` ms.
import { DurableObject } from 'cloudflare:workers'
import { snappyCompress, writeRequest } from '../codec'

interface Env { NEW: Fetcher; ASBUILT: Fetcher; KEY: string; CLIENT: DurableObjectNamespace<Client> }

export class Client extends DurableObject<Env> {
  async run(target: 'new' | 'asbuilt', id: number, seconds: number, series: number, key: string, backoff: number): Promise<{ lat: number[]; codes: number[] }> {
    const stack = target === 'new' ? this.env.NEW : this.env.ASBUILT
    const lat: number[] = []
    const codes: number[] = []
    const end = Date.now() + seconds * 1000
    let i = 0
    while (Date.now() < end) {
      const now = Date.now()
      const body = snappyCompress(writeRequest(Array.from({ length: series }, (_, s) => ({
        labels: [['__name__', `load_metric_${s % 20}`], ['instance', 'load-0'], ['job', 'loadgen'], ['series', String(s)]] as [string, string][],
        samples: [{ ts: now - 300_000 + id * 1000 + (i++ % 1000), value: s + i / 1000 }],
      }))))
      const t = Date.now()
      const r = await stack.fetch('https://stack/api/v1/write', { method: 'POST', body, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-protobuf', 'content-encoding': 'snappy', 'x-prometheus-remote-write-version': '0.1.0' } })
      await r.arrayBuffer()
      lat.push(Date.now() - t)
      codes.push(r.status)
      if (r.status === 429 || r.status === 503) {
        const after = Number(r.headers.get('retry-after') ?? '1') * 1000
        await new Promise((res) => setTimeout(res, Math.min(backoff, after)))
      }
    }
    return { lat, codes }
  }
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? null : s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.KEY || req.headers.get('x-key') !== env.KEY) return new Response('not found', { status: 404 })
    const u = new URL(req.url)
    const q = (k: string, d: number) => Number(u.searchParams.get(k) ?? d)
    const target = (u.searchParams.get('target') ?? 'new') as 'new' | 'asbuilt'
    const conc = q('conc', 16), seconds = q('seconds', 10), series = q('series', 50), backoff = q('backoff', 1000)
    const key = req.headers.get('x-ingest-key')!
    const run = `${Date.now().toString(36)}`
    const t0 = Date.now()
    const rs = await Promise.all(Array.from({ length: conc }, (_, i) => env.CLIENT.get(env.CLIENT.idFromName(`${run}-c${i}`)).run(target, i, seconds, series, key, backoff)))
    const secs = (Date.now() - t0) / 1000
    const ok = rs.flatMap((r) => r.lat.filter((_, i) => r.codes[i]! < 300))
    const refused = rs.flatMap((r) => r.lat.filter((_, i) => r.codes[i]! >= 300))
    const status: Record<string, number> = {}
    for (const r of rs) for (const c of r.codes) status[c] = (status[c] ?? 0) + 1
    return Response.json({
      target, clients: conc, series, seconds: +secs.toFixed(2), requests: ok.length + refused.length,
      acked_per_s: +(ok.length / secs).toFixed(1), samples_per_s: Math.round((ok.length * series) / secs), status,
      ack_ms: { p50: pct(ok, 50), p90: pct(ok, 90), p99: pct(ok, 99), max: pct(ok, 100) },
      refusal_ms: refused.length ? { p50: pct(refused, 50), p99: pct(refused, 99) } : null,
    })
  },
} satisfies ExportedHandler<Env>
