/**
 * Spike S4, re-run after the segment log (2026-11-19). The same writer clients as `../driver.ts`
 * (each its own Durable Object and stream), against the ledger as built now (`LEDGER`) and the
 * frozen as-built ledger of dc2a1c3 (`LEDGER_ASBUILT`, ledger/bench/asbuilt/), on the same day.
 *
 *   /rate?kind=segments|asbuilt&clients=&seconds=&files=   units admitted per second, addUnit latency
 *   /logged?kind=&tenant=&shards=&seq=                     ms until loggedWatermarks covers seq on every shard
 *   /fill?files=&units=                                    grow one segment ledger (for the rebuild)
 *   /rebuild?tenant=                                       wipe that ledger's storage; ms until it plans again
 *   /status?tenant=                                        logStatus
 * Every route needs header x-key (a Worker secret). See ../README.md.
 */
import { DurableObject } from 'cloudflare:workers'
import type { FileEntry, FlushUnit } from '../../../contracts/ledger'
import { Ledger as Current } from '../../../ledger/src/ledger'
export { Ledger as LedgerAsBuilt } from '../../../ledger/bench/asbuilt/ledger'

/** The ledger as built now, plus one operator method this spike needs: lose storage on purpose. */
export class Ledger extends Current {
  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll()
    this.ctx.abort('storage wiped by the S4 spike')
  }
}

interface Env {
  LEDGER: DurableObjectNamespace<Ledger>
  LEDGER_ASBUILT: DurableObjectNamespace<Current>
  WRITER: DurableObjectNamespace<Writer>
  KEY: string
  CELL: string
}
type Kind = 'segments' | 'asbuilt'

const INDEX = JSON.stringify({ v: 1, groups: Array.from({ length: 3 }, (_, g) => ({ rows: 100000, offset: 4 + g * 4_000_000, length: 4_000_000, minName: 'http_requests_total', maxName: 'process_cpu_seconds_total', minTs: 1795000000000, maxTs: 1795003600000 })) })
const DAY0 = Date.UTC(2026, 9, 20)

function unitFor(cell: string, tenant: string, id: number, seqLo: number, seqHi: number, filesPerUnit: number): FlushUnit {
  const day = new Date(DAY0 + ((id * 7 + seqLo) % 30) * 86_400_000).toISOString().slice(0, 10)
  const files: FileEntry[] = Array.from({ length: filesPerUnit }, (_, f) => {
    const table = f % 2 === 0 ? 'metric_samples' : 'metric_series'
    return {
      table, day,
      key: `${cell}/data/${table}/tenant=${tenant}/day=${day}/L0-pool_s4_${id}-${1000 + id}-${seqLo}-${seqHi}-${f}${((seqLo * 2654435761) >>> 0).toString(16).padStart(8, '0')}.parquet`,
      bytes: 8_000_000, rows: 300_000, minTs: Date.parse(day), maxTs: Date.parse(day) + 86_399_000, level: 0, index: INDEX,
    }
  })
  return { shard: `pool/s4/${id}`, incarnation: 1000 + id, seqLo, seqHi, files }
}

const ledgerOf = (env: Env, kind: Kind, tenant: string) => (kind === 'asbuilt' ? env.LEDGER_ASBUILT : env.LEDGER).get((kind === 'asbuilt' ? env.LEDGER_ASBUILT : env.LEDGER).idFromName(tenant)) as unknown as DurableObjectStub<Current>

export class Writer extends DurableObject<Env> {
  /** Admit units on stream `id` as fast as answers come, for `seconds` (or `units` units). */
  async run(kind: Kind, tenant: string, id: number, seconds: number, filesPerUnit: number, units = Infinity, from = 0): Promise<{ lat: number[]; status: Record<string, number>; err?: string; lastSeq: number }> {
    const ledger = ledgerOf(this.env, kind, tenant)
    const lat: number[] = []
    const status: Record<string, number> = {}
    const end = Date.now() + seconds * 1000
    let seq = from
    try {
      for (let u = 0; u < units && Date.now() < end; u++) {
        const t = Date.now()
        const r = await ledger.addUnit(unitFor(this.env.CELL, tenant, id, seq + 1, seq + 4, filesPerUnit))
        lat.push(Date.now() - t)
        status[r.status] = (status[r.status] ?? 0) + 1
        if (r.status !== 'ok') break
        seq += 4
      }
    } catch (e) {
      return { lat, status, err: String(e).slice(0, 300), lastSeq: seq }
    }
    return { lat, status, lastSeq: seq }
  }
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.KEY || req.headers.get('x-key') !== env.KEY) return new Response('not found', { status: 404 })
    const u = new URL(req.url)
    const q = (k: string, d: number) => Number(u.searchParams.get(k) ?? d)
    const kind = (u.searchParams.get('kind') ?? 'segments') as Kind
    if (u.pathname === '/rate') {
      const clients = q('clients', 8), seconds = q('seconds', 10), files = q('files', 2)
      const tenant = u.searchParams.get('tenant') ?? `s4-${kind}-${Date.now().toString(36)}`
      const ledger = ledgerOf(env, kind, tenant)
      await ledger.plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })
      const t0 = Date.now()
      const rs = await Promise.all(Array.from({ length: clients }, (_, i) => env.WRITER.get(env.WRITER.idFromName(`${tenant}-w${i}`)).run(kind, tenant, i, seconds, files)))
      const secs = (Date.now() - t0) / 1000
      const lat = rs.flatMap((r) => r.lat)
      const status: Record<string, number> = {}
      for (const r of rs) for (const [k, v] of Object.entries(r.status)) status[k] = (status[k] ?? 0) + v
      // How long until every admitted unit is in R2 (immediate for the as-built ledger).
      const t1 = Date.now()
      let loggedMs = -1
      while (Date.now() - t1 < 60_000) {
        const w = await ledger.loggedWatermarks()
        if (rs.every((r, i) => (w.find((x) => x.shard === `pool/s4/${i}`)?.seq ?? 0) >= r.lastSeq)) { loggedMs = Date.now() - t1; break }
        await new Promise((r) => setTimeout(r, 50))
      }
      const st = kind === 'segments' ? await (ledger as unknown as Ledger).logStatus() : null
      return Response.json({
        kind, tenant, clients, files, seconds: +secs.toFixed(1), units: lat.length, units_per_s: +(lat.length / secs).toFixed(1), status,
        errors: rs.map((r) => r.err).filter(Boolean).slice(0, 3), p50: pct(lat, 50), p90: pct(lat, 90), p99: pct(lat, 99), max: Math.max(0, ...lat),
        logged_after_ms: loggedMs, segments: st?.segmentsWritten ?? null, segment_write_ms: st?.segmentWriteMs ?? null,
      })
    }
    if (u.pathname === '/fill') {
      // Grow one segment ledger: `clients` writers × `units` units of `files` files each.
      const tenant = u.searchParams.get('tenant') ?? `s4-fill-${Date.now().toString(36)}`
      const clients = q('clients', 8), units = q('units', 100), files = q('files', 2), from = q('from', 0)
      const t0 = Date.now()
      const rs = await Promise.all(Array.from({ length: clients }, (_, i) => env.WRITER.get(env.WRITER.idFromName(`${tenant}-w${i}`)).run('segments', tenant, i, 600, files, units, from)))
      await ledgerOf(env, 'segments', tenant).drain()
      return Response.json({ tenant, units: rs.reduce((a, r) => a + r.lat.length, 0), lastSeq: rs.map((r) => r.lastSeq), ms: Date.now() - t0, errors: rs.map((r) => r.err).filter(Boolean), status: await (ledgerOf(env, 'segments', tenant) as unknown as Ledger).logStatus() })
    }
    if (u.pathname === '/rebuild') {
      const tenant = u.searchParams.get('tenant')!
      const ledger = env.LEDGER.get(env.LEDGER.idFromName(tenant))
      const before = await ledger.plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
      await ledger.drain()
      await ledger.wipe().catch(() => undefined) // the object resets itself
      const t0 = Date.now()
      let refusals = 0
      let after
      for (;;) {
        try {
          after = await ledger.plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
          break
        } catch (e) {
          if (!String(e).includes('ledger_unavailable')) throw e
          refusals++
        }
        if (Date.now() - t0 > 120_000) return Response.json({ error: 'not rebuilt after 120 s', refusals }, { status: 500 })
      }
      const ms = Date.now() - t0
      const same = after.files.length === before.files.length && JSON.stringify(after.watermarks) === JSON.stringify(before.watermarks)
      return Response.json({ tenant, ms, refusals, files: after.files.length, same, version: after.version, incarnation: after.ledgerIncarnation })
    }
    if (u.pathname === '/agree') {
      // The counterfactual's precondition: the same workload (one writer, `units` units, in
      // order) on both ledgers gives the same state, and each reads the other's output: the
      // ledger as built now, started with empty storage on the AS-BUILT tenant, rebuilds from
      // the as-built ledger's first-layout log and must list exactly what that ledger lists.
      const units = q('units', 40)
      const run = Date.now().toString(36)
      const ta = `s4-agree-a-${run}`
      const tb = `s4-agree-b-${run}`
      const a = await env.WRITER.get(env.WRITER.idFromName(`${ta}-w0`)).run('asbuilt', ta, 0, 600, 2, units)
      const b = await env.WRITER.get(env.WRITER.idFromName(`${tb}-w0`)).run('segments', tb, 0, 600, 2, units)
      const norm = (p: { files: { key: string }[] }, t: string) => p.files.map((f) => ({ ...f, key: f.key.replace(`tenant=${t}/`, 'tenant=T/') }))
      const out: Record<string, unknown> = { units, asbuilt: a.status, segments: b.status }
      for (const table of ['metric_samples', 'metric_series'] as const) {
        const range = { table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER }
        const pa = await ledgerOf(env, 'asbuilt', ta).plan(range)
        const pb = await ledgerOf(env, 'segments', tb).plan(range)
        const rebuilt = await env.LEDGER.get(env.LEDGER.idFromName(ta)).plan(range) // empty storage: rebuilds from ta's log
        out[table] = {
          files: pa.files.length,
          same_workload_same_state: JSON.stringify(norm(pa, ta)) === JSON.stringify(norm(pb, tb)) && JSON.stringify(pa.watermarks) === JSON.stringify(pb.watermarks) && pa.version === pb.version,
          rebuilt_from_asbuilt_log_equal: JSON.stringify(rebuilt.files) === JSON.stringify(pa.files) && JSON.stringify(rebuilt.watermarks) === JSON.stringify(pa.watermarks) && rebuilt.version === pa.version,
          rebuilt_incarnation: rebuilt.ledgerIncarnation,
        }
      }
      return Response.json(out)
    }
    if (u.pathname === '/status') return Response.json(await env.LEDGER.get(env.LEDGER.idFromName(u.searchParams.get('tenant')!)).logStatus())
    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
