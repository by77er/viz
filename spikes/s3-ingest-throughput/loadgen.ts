// In-platform load generator. Each client is its own Durable Object (so each has its own
// connection budget, see spike S1) sending requests one after another to the ingest Worker.
import { DurableObject } from 'cloudflare:workers'
import { writeRequest, snappyCompress } from './codec'
interface Env { STACK: Fetcher; KEY: string; CLIENT: DurableObjectNamespace<Client> }
export class Client extends DurableObject<Env> {
  async run(id: number, seconds: number, series: number, key: string): Promise<{ lat: number[]; status: Record<string, number> }> {
    const lat: number[] = [], status: Record<string, number> = {}
    const end = Date.now() + seconds * 1000
    let i = 0
    while (Date.now() < end) {
      const now = Date.now()
      const b = snappyCompress(writeRequest(Array.from({ length: series }, (_, s) => ({
        labels: [['__name__', `load_metric_${s % 20}`], ['instance', 'load-0'], ['job', 'loadgen'], ['series', String(s)]] as [string, string][],
        samples: [{ ts: now - 300_000 + id * 1000 + (i++ % 1000), value: s + i / 1000 }],
      }))))
      const s = Date.now()
      const r = await this.env.STACK.fetch('https://stack/api/v1/write', { method: 'POST', body: b, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-protobuf', 'content-encoding': 'snappy', 'x-prometheus-remote-write-version': '0.1.0' } })
      await r.arrayBuffer()
      lat.push(Date.now() - s); status[r.status] = (status[r.status] ?? 0) + 1
    }
    return { lat, status }
  }
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.headers.get('x-key') !== env.KEY) return new Response('not found', { status: 404 })
    const u = new URL(req.url), q = (k: string, d: number) => Number(u.searchParams.get(k) ?? d)
    const conc = q('conc', 16), seconds = q('seconds', 10), series = q('series', 50), key = req.headers.get('x-ingest-key')!
    const t0 = Date.now()
    const rs = await Promise.all(Array.from({ length: conc }, (_, i) => env.CLIENT.get(env.CLIENT.idFromName(`c${i}`)).run(i, seconds, series, key)))
    const secs = (Date.now() - t0) / 1000
    const lat = rs.flatMap((r) => r.lat).sort((a, b) => a - b), status: Record<string, number> = {}
    for (const r of rs) for (const [k, v] of Object.entries(r.status)) status[k] = (status[k] ?? 0) + v
    const p = (x: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * x / 100))]
    return Response.json({ clients: conc, series, requests: lat.length, seconds: +secs.toFixed(2), rps: +(lat.length / secs).toFixed(1), samples_per_s: Math.round(lat.length * series / secs), status, p50: p(50), p90: p(90), p99: p(99), max: p(100) })
  },
} satisfies ExportedHandler<Env>
