/**
 * Counterfactual (AGENTS.md, "Evidence"): one shard under C concurrent clients, as built
 * (dc2a1c3) and with early refusal + group commit, same clients, same batches. Before any
 * rate is compared, each run must have stored exactly the batches it acknowledged, each once,
 * and none it refused. Measured here, in local workerd (one process, one thread for the
 * shard, its clients and SQLite: see bench/README.md).
 *
 *   npm run bench                     everything
 *   BENCH=saturation npm run bench    the as-built / new sweep only
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Shard, ShardConfig } from '../src/shard'
import type { Client } from './worker'

type Kind = 'asbuilt' | 'new'
const E = env as unknown as { SHARD: DurableObjectNamespace<Shard>; SHARD_ASBUILT: DurableObjectNamespace<Shard>; CLIENT: DurableObjectNamespace<Client>; BENCH: string }
const only = (name: string) => E.BENCH === '' || E.BENCH === name
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : Math.round(s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]!)
}
let runN = 0

interface Row {
  kind: Kind
  variant: string
  clients: number
  seconds: number
  requests: number
  ackedPerSecond: number
  status: Record<string, number>
  /** Latency of acknowledged appends (ms). */
  ackMs: { p50: number; p90: number; p99: number; max: number }
  /** Latency of refusals (ms): how fast a sender learns to back off. */
  refusalMs?: { p50: number; p99: number }
  groups?: unknown
}

async function run(kind: Kind, clients: number, seconds: number, series: number, variant = 'default', cfg: Partial<ShardConfig> = {}): Promise<Row> {
  const shard = `bench/${kind}/${Date.now().toString(36)}-${runN++}`
  const tenant = 't'
  const ns = kind === 'asbuilt' ? E.SHARD_ASBUILT : E.SHARD
  const stub = ns.get(ns.idFromName(shard))
  // Flush is not running (as in S3): seals stay unrecorded; the tenant cap is lifted so the buffer is not what refuses.
  await stub.configure({ tenantMaxBytes: 1 << 30, shardMaxBytes: 1 << 30, sealBytes: 1 << 30, ...cfg })
  const t0 = performance.now()
  const rs = await Promise.all(Array.from({ length: clients }, (_, c) => E.CLIENT.get(E.CLIENT.idFromName(`${shard}-c${c}`)).run(kind, shard, tenant, c, seconds, series)))
  const secs = (performance.now() - t0) / 1000
  const acked = rs.flatMap((r) => r.acked)
  const refused = rs.flatMap((r) => r.refused)
  // Same results: the shard holds exactly what it acknowledged, each once, and nothing it refused.
  const fps = await runInDurableObject(stub, (_i: Shard, s) => s.storage.sql.exec(`SELECT fingerprint FROM batch WHERE tenant = ?`, tenant).toArray().map((r) => r.fingerprint as string))
  expect(new Set(fps).size, `${kind} ${clients}: rows`).toBe(fps.length)
  expect([...fps].sort(), `${kind} ${clients}: stored = acknowledged`).toEqual([...new Set(acked)].sort())
  const stored = new Set(fps)
  for (const f of refused) if (!acked.includes(f)) expect(stored.has(f), `${kind}: a refused batch was stored`).toBe(false)
  const status: Record<string, number> = {}
  for (const r of rs) for (const [k, v] of Object.entries(r.status)) status[k] = (status[k] ?? 0) + v
  const okLat = rs.flatMap((r) => r.lat.filter((_, i) => r.codes[i] === 'ok'))
  const noLat = rs.flatMap((r) => r.lat.filter((_, i) => r.codes[i] !== 'ok'))
  const row: Row = {
    kind, variant, clients, seconds: Math.round(secs * 100) / 100, requests: okLat.length + noLat.length,
    ackedPerSecond: Math.round((acked.length / secs) * 10) / 10, status,
    ackMs: { p50: pct(okLat, 50), p90: pct(okLat, 90), p99: pct(okLat, 99), max: pct(okLat, 100) },
  }
  if (noLat.length > 0) row.refusalMs = { p50: pct(noLat, 50), p99: pct(noLat, 99) }
  if (kind === 'new') row.groups = await (stub as unknown as { stats(): Promise<unknown> }).stats()
  return row
}

const report = (rows: Row[]) => console.log(`BENCH ${JSON.stringify(rows)}`)

describe('shard saturation: as built vs early refusal + group commit (measured here, workerd)', () => {
  it.runIf(only('saturation'))('50-series batches, 1 to 64 clients, 4 s each', async () => {
    const rows: Row[] = []
    for (const clients of [1, 8, 16, 32, 64]) {
      rows.push(await run('asbuilt', clients, 4, 50))
      rows.push(await run('new', clients, 4, 50))
    }
    report(rows)
  })

  it.runIf(only('tuning'))('the new shard: group commit alone, then the in-flight limit and window, at 32 and 64 clients', async () => {
    const rows: Row[] = []
    for (const clients of [32, 64]) {
      rows.push(await run('new', clients, 4, 50, 'group commit, no limit', { maxInFlight: 1e9, maxPendingBytes: 1e12 }))
      rows.push(await run('new', clients, 4, 50, 'limit 16', { maxInFlight: 16 }))
      rows.push(await run('new', clients, 4, 50, 'limit 64 (default)'))
      rows.push(await run('new', clients, 4, 50, 'limit 64, window 2 ms', { groupWindowMs: 2 }))
      rows.push(await run('new', clients, 4, 50, 'limit 256', { maxInFlight: 256 }))
    }
    report(rows)
  })
})
