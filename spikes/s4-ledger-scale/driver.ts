// Spike S4: the tenant ledger at scale, on Cloudflare.
//   /rate?clients=&seconds=&files=   clients (each its own Durable Object, each its own stream) admit flush units as fast as they can
//   /plan?days=                      time plan() over the last N days at the ledger's current size
//   /stats                           live file count, outbox depth, version
import { DurableObject } from 'cloudflare:workers'
import { Ledger } from '../../ledger/src/ledger'
import type { FileEntry, FlushUnit } from '../../contracts/ledger'
export { Ledger }
interface Env { LEDGER: DurableObjectNamespace<Ledger>; WRITER: DurableObjectNamespace<Writer>; KEY: string }
const TENANT = 's4'
const DAY0 = Date.UTC(2026, 9, 20)
const INDEX = JSON.stringify({ v: 1, groups: Array.from({ length: 3 }, (_, g) => ({ rows: 100000, offset: 4 + g * 4_000_000, length: 4_000_000, minName: 'http_requests_total', maxName: 'process_cpu_seconds_total', minTs: 1795000000000, maxTs: 1795003600000 })) })

export class Writer extends DurableObject<Env> {
  async run(id: number, seconds: number, filesPerUnit: number): Promise<{ lat: number[]; status: Record<string, number>; err?: string }> {
    const ledger = this.env.LEDGER.get(this.env.LEDGER.idFromName(TENANT))
    const shard = `pool/s4/${id}`
    let st = (await this.ctx.storage.get<{ incarnation: number; seq: number }>('st')) ?? { incarnation: Date.now() * 1024 + id, seq: 0 }
    const lat: number[] = [], status: Record<string, number> = {}
    const end = Date.now() + seconds * 1000
    try {
      if (st.seq === 0) await ledger.registerStream({ shard, incarnation: st.incarnation })
      while (Date.now() < end) {
        const seqLo = st.seq + 1, seqHi = st.seq + 4
        const day = new Date(DAY0 + ((id * 7 + seqLo) % 30) * 86400_000).toISOString().slice(0, 10)
        const files: FileEntry[] = Array.from({ length: filesPerUnit }, (_, f) => ({
          table: f % 2 === 0 ? 'metric_samples' : 'metric_series', day,
          key: `cell-0/data/${f % 2 === 0 ? 'metric_samples' : 'metric_series'}/tenant=${TENANT}/day=${day}/L0-pool_s4_${id}-${st.incarnation}-${seqLo}-${seqHi}-${f}${(seqLo * 2654435761 >>> 0).toString(16).padStart(8, '0')}.parquet`,
          bytes: 8_000_000, rows: 300_000, minTs: Date.parse(day), maxTs: Date.parse(day) + 86_399_000, level: 0, index: INDEX,
        }))
        const unit: FlushUnit = { shard, incarnation: st.incarnation, seqLo, seqHi, files }
        const s = Date.now()
        const r = await ledger.addUnit(unit)
        lat.push(Date.now() - s); status[r.status] = (status[r.status] ?? 0) + 1
        if (r.status !== 'ok') break
        st = { ...st, seq: seqHi }
      }
    } catch (e) { return { lat, status, err: String(e).slice(0, 200) } }
    finally { await this.ctx.storage.put('st', st) }
    return { lat, status }
  }
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p / 100))] }
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.headers.get('x-key') !== env.KEY) return new Response('not found', { status: 404 })
    const u = new URL(req.url), q = (k: string, d: number) => Number(u.searchParams.get(k) ?? d)
    const ledger = env.LEDGER.get(env.LEDGER.idFromName(TENANT))
    if (u.pathname === '/rate') {
      const clients = q('clients', 4), seconds = q('seconds', 10), files = q('files', 2), base = q('base', 0)
      const t0 = Date.now()
      const rs = await Promise.all(Array.from({ length: clients }, (_, i) => env.WRITER.get(env.WRITER.idFromName(`w${base + i}`)).run(base + i, seconds, files)))
      const secs = (Date.now() - t0) / 1000, lat = rs.flatMap((r) => r.lat), status: Record<string, number> = {}
      for (const r of rs) for (const [k, v] of Object.entries(r.status)) status[k] = (status[k] ?? 0) + v
      return Response.json({ clients, files, seconds: +secs.toFixed(1), units: lat.length, units_per_s: +(lat.length / secs).toFixed(1), status, errors: rs.map((r) => r.err).filter(Boolean).slice(0, 3), p50: pct(lat, 50), p90: pct(lat, 90), p99: pct(lat, 99), max: Math.max(0, ...lat) })
    }
    if (u.pathname === '/plan') {
      const days = q('days', 1), n = q('n', 15), lat: number[] = []
      let files = 0, bytes = 0
      const maxTs = DAY0 + 30 * 86400_000, minTs = maxTs - days * 86400_000
      for (let i = 0; i < n; i++) { const s = Date.now(); const p = await ledger.plan({ table: 'metric_samples', minTs, maxTs }); lat.push(Date.now() - s); files = p.files.length; if (i === 0) bytes = JSON.stringify(p).length }
      return Response.json({ days, files, responseBytes: bytes, p50: pct(lat, 50), p90: pct(lat, 90), max: Math.max(...lat) })
    }
    if (u.pathname === '/put') { // raw R2 PUT latency for a small object, for comparison
      const lat: number[] = []
      for (let i = 0; i < 20; i++) { const t = Date.now(); await (env as unknown as { BUCKET: R2Bucket }).BUCKET.put(`probe/${i}.json`, 'x'.repeat(q('bytes', 1500))); lat.push(Date.now() - t) }
      return Response.json({ bytes: q('bytes', 1500), p50: pct(lat, 50), p90: pct(lat, 90), max: Math.max(...lat) })
    }
    if (u.pathname === '/purge') {
      const b = (env as unknown as { BUCKET: R2Bucket }).BUCKET; let n = 0
      for (;;) { const l = await b.list({ limit: 500 }); if (!l.objects.length) break; await b.delete(l.objects.map((o) => o.key)); n += l.objects.length }
      return Response.json({ deleted: n })
    }
    if (u.pathname === '/stats') {
      const s0 = Date.now(); const depth = await ledger.outboxDepth(); const wm = await ledger.loggedWatermarks()
      const p = await ledger.plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })
      return Response.json({ outboxDepth: depth, streams: wm.length, version: p.version, ms: Date.now() - s0 })
    }
    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
