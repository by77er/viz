/**
 * Registration before writes (D57), measured here in local workerd (one process: the shard, the
 * ledger, R2 and the clients share it; the machine's load is printed with each result).
 *
 *   first-ack     a new stream's first acknowledgement: a sender sends a batch to a stream that
 *                 does not exist yet and sends it again after each refusal's Retry-After (the
 *                 shard's, and rounded up to whole seconds as edge writes it), until it is
 *                 acknowledged. The ledger drains on its own (200 ms after a commit, the
 *                 default), so this is the real path: refusal, background registration, drain,
 *                 the shard's next call, the sender's retry. Local R2 PUTs take milliseconds,
 *                 not the 180–494 ms measured on Cloudflare, so this is a lower bound.
 *   established   appends per second of streams whose registration is confirmed, this release
 *                 in mode `logged` against the release before D57 (bench/prereg/), same clients,
 *                 same batches; each run must have stored exactly what it acknowledged.
 *
 *   BENCH=registration npm run bench
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Ledger } from '../../ledger/src/ledger'
import type { Shard } from '../src/shard'
import type { Client } from './worker'

const E = env as unknown as { SHARD: DurableObjectNamespace<Shard>; SHARD_PREREG: DurableObjectNamespace<Shard>; LEDGER: DurableObjectNamespace<Ledger>; CLIENT: DurableObjectNamespace<Client>; BENCH: string }
const only = (name: string) => E.BENCH === '' || E.BENCH === name
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : Math.round(s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]!)
}
let n = 0
const id = () => `${Date.now().toString(36)}-${n++}`

describe('registration before writes (measured here, workerd)', () => {
  it.runIf(only('registration'))('first acknowledgement of a new stream: 30 streams per policy, one at a time', async () => {
    const rows: Record<string, unknown>[] = []
    for (const roundUp of [false, true]) {
      const ms: number[] = []
      const refusals: number[] = []
      for (let i = 0; i < 30; i++) {
        const shard = `benchreg-${id()}/0`
        await E.SHARD.get(E.SHARD.idFromName(shard)).configure({ registration: 'logged' })
        const r = await E.CLIENT.get(E.CLIENT.idFromName(`fa-${shard}`)).firstAck(shard, `t-${id()}`, roundUp)
        expect(r.codes.every((c) => c === 'backpressure:registering'), r.codes.join(' ')).toBe(true)
        ms.push(r.ms)
        refusals.push(r.refusals)
      }
      rows.push({ retryAfter: roundUp ? 'rounded up to whole seconds (edge)' : 'as the shard says (500–1000 ms)', n: ms.length, firstAckMs: { min: pct(ms, 0), p50: pct(ms, 50), p90: pct(ms, 90), max: pct(ms, 100) }, refusals: { min: Math.min(...refusals), p50: pct(refusals, 50), max: Math.max(...refusals) } })
    }
    console.log(`BENCH ${JSON.stringify(rows)}`)
  })

  it.runIf(only('registration'))('appends per second of established streams: the release before D57 against this one in mode `logged`, 1, 16 and 64 clients, 4 s, three runs each', async () => {
    const rows: Record<string, unknown>[] = []
    for (let rep = 0; rep < 3; rep++) {
      for (const clients of [1, 16, 64]) {
        for (const kind of ['prereg', 'new'] as const) {
          const shard = `benchest/${kind}/${id()}`
          const tenant = 't'
          const ns = kind === 'prereg' ? E.SHARD_PREREG : E.SHARD
          const stub = ns.get(ns.idFromName(shard))
          await stub.configure({ tenantMaxBytes: 1 << 30, shardMaxBytes: 1 << 30, sealBytes: 1 << 30, ...(kind === 'new' ? { registration: 'logged' as const } : {}) })
          if (kind === 'new') {
            // The stream is established: registered and confirmed before the clock starts.
            await (stub as DurableObjectStub<Shard>).ensureStream(tenant)
            await E.LEDGER.get(E.LEDGER.idFromName(tenant)).drain()
            for (let i = 0; !(await (stub as DurableObjectStub<Shard>).ensureStream(tenant)).registered; i++) expect(i).toBeLessThan(50)
          }
          const t0 = performance.now()
          const rs = await Promise.all(Array.from({ length: clients }, (_, c) => E.CLIENT.get(E.CLIENT.idFromName(`${shard}-c${c}`)).run(kind, shard, tenant, c, 4, 50)))
          const secs = (performance.now() - t0) / 1000
          const acked = rs.flatMap((r) => r.acked)
          const fps = await runInDurableObject(stub as DurableObjectStub<Shard>, (_i: Shard, s) => s.storage.sql.exec(`SELECT fingerprint FROM batch WHERE tenant = ?`, tenant).toArray().map((r) => r.fingerprint as string))
          expect([...fps].sort(), `${kind} ${clients}: stored = acknowledged`).toEqual([...new Set(acked)].sort())
          const okLat = rs.flatMap((r) => r.lat.filter((_, i) => r.codes[i] === 'ok'))
          const status: Record<string, number> = {}
          for (const r of rs) for (const [k, v] of Object.entries(r.status)) status[k] = (status[k] ?? 0) + v
          rows.push({ rep, kind, clients, ackedPerSecond: Math.round((acked.length / secs) * 10) / 10, ackMs: { p50: pct(okLat, 50), p99: pct(okLat, 99) }, status })
        }
      }
    }
    console.log(`BENCH ${JSON.stringify(rows)}`)
  })
})
