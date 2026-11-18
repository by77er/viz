// Spike S5: R2 write latency and parallel write throughput, from a Worker and from Durable Objects.
//   /seq?n=&bytes=                 n sequential PUTs from this invocation
//   /par?n=&bytes=                 n PUTs at once from this invocation
//   /do?objects=&per=&bytes=       `objects` Durable Objects, each doing `per` PUTs at once
//   /do-seq?n=&bytes=              one Durable Object doing n sequential PUTs
//   /cond?n=                       n PUTs with onlyIf (If-None-Match: *) to fresh keys
//   /del?n=                        delete n keys in one call
//   /purge                         delete everything this spike wrote
import { DurableObject } from 'cloudflare:workers'
interface Env { BUCKET: R2Bucket; W: DurableObjectNamespace<Writer>; KEY: string }
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p / 100))] }
const sum = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p90: pct(xs, 90), p99: pct(xs, 99), max: Math.max(...xs) })
const body = (bytes: number) => { const b = new Uint8Array(bytes); for (let i = 0; i < bytes; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(bytes, i + 65536))); return b }
async function put(b: R2Bucket, key: string, data: Uint8Array, cond = false): Promise<number> {
  const t = Date.now(); await b.put(key, data, cond ? { onlyIf: new Headers({ 'if-none-match': '*' }) } : undefined); return Date.now() - t
}
const run = () => crypto.randomUUID().slice(0, 8)
export class Writer extends DurableObject<Env> {
  async many(prefix: string, per: number, bytes: number): Promise<number[]> {
    const d = body(bytes); return Promise.all(Array.from({ length: per }, (_, i) => put(this.env.BUCKET, `${prefix}/${i}`, d)))
  }
  async seq(prefix: string, n: number, bytes: number): Promise<number[]> {
    const d = body(bytes), out: number[] = []; for (let i = 0; i < n; i++) out.push(await put(this.env.BUCKET, `${prefix}/${i}`, d)); return out
  }
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.headers.get('x-key') !== env.KEY) return new Response('not found', { status: 404 })
    const u = new URL(req.url), q = (k: string, d: number) => Number(u.searchParams.get(k) ?? d), r = run(), colo = (req as unknown as { cf?: { colo?: string } }).cf?.colo
    const t0 = Date.now()
    if (u.pathname === '/seq') { const d = body(q('bytes', 1500)), lat: number[] = []; for (let i = 0; i < q('n', 20); i++) lat.push(await put(env.BUCKET, `s5/${r}/seq/${i}`, d)); return Response.json({ colo, kind: 'worker-seq', bytes: q('bytes', 1500), wall: Date.now() - t0, put: sum(lat) }) }
    if (u.pathname === '/par') { const d = body(q('bytes', 1500)); const lat = await Promise.all(Array.from({ length: q('n', 6) }, (_, i) => put(env.BUCKET, `s5/${r}/par/${i}`, d))); return Response.json({ colo, kind: 'worker-par', n: q('n', 6), bytes: q('bytes', 1500), wall: Date.now() - t0, put: sum(lat) }) }
    if (u.pathname === '/do') { const objs = q('objects', 8), per = q('per', 6); const lat = (await Promise.all(Array.from({ length: objs }, (_, i) => env.W.get(env.W.idFromName(`w${i}`)).many(`s5/${r}/do/${i}`, per, q('bytes', 1500))))).flat(); const wall = Date.now() - t0; return Response.json({ colo, kind: 'do-par', objects: objs, per, puts: lat.length, bytes: q('bytes', 1500), wall, puts_per_s: +(lat.length / (wall / 1000)).toFixed(1), put: sum(lat) }) }
    if (u.pathname === '/do-seq') { const lat = await env.W.get(env.W.idFromName('wseq')).seq(`s5/${r}/doseq`, q('n', 20), q('bytes', 1500)); return Response.json({ colo, kind: 'do-seq', bytes: q('bytes', 1500), wall: Date.now() - t0, put: sum(lat) }) }
    if (u.pathname === '/cond') { const d = body(1500), lat: number[] = []; for (let i = 0; i < q('n', 20); i++) lat.push(await put(env.BUCKET, `s5/${r}/cond/${i}`, d, true)); return Response.json({ colo, kind: 'conditional-seq', wall: Date.now() - t0, put: sum(lat) }) }
    if (u.pathname === '/del') { const keys = Array.from({ length: q('n', 100) }, (_, i) => `s5/${r}/del/${i}`); const d = body(100); await Promise.all(keys.slice(0, 6).map((k) => env.BUCKET.put(k, d))); const t = Date.now(); await env.BUCKET.delete(keys); return Response.json({ colo, kind: 'batch-delete', keys: keys.length, ms: Date.now() - t }) }
    if (u.pathname === '/purge') { let n = 0; for (;;) { const l = await env.BUCKET.list({ prefix: 's5/', limit: 1000 }); if (!l.objects.length) break; await env.BUCKET.delete(l.objects.map((o) => o.key)); n += l.objects.length } return Response.json({ deleted: n }) }
    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
