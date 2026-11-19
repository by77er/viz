/**
 * Counterfactual (AGENTS.md, "Evidence"): the same workload against the as-built ledger
 * (one R2 object per change, written before `addUnit` answers) and against the segment log.
 * Both must end in the same state, and each one's log must rebuild to it, before any time is
 * compared. Measured here, in local workerd; R2 latency is injected (see bench/README.md).
 *
 *   npm run bench                      every run below
 *   BENCH=admission npm run bench      only these
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Plan } from '../../contracts/ledger'
import type { Ledger } from '../src/ledger'
import type { Writer } from './worker'

type Kind = 'asbuilt' | 'segments'
type Stub = DurableObjectStub<Ledger>
const E = env as unknown as { LEDGER: DurableObjectNamespace<Ledger>; LEDGER_ASBUILT: DurableObjectNamespace<Ledger>; WRITER: DurableObjectNamespace<Writer>; BUCKET: R2Bucket; BENCH: string }
const only = (name: string) => E.BENCH === '' || E.BENCH === name
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : Math.round(s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]! * 10) / 10
}
let runN = 0
const stubOf = (kind: Kind, tenant: string): Stub => (kind === 'asbuilt' ? E.LEDGER_ASBUILT : E.LEDGER).get((kind === 'asbuilt' ? E.LEDGER_ASBUILT : E.LEDGER).idFromName(tenant))

/** Every R2 write of this ledger instance takes `ms` longer (S5: a PUT costs 0.17–0.4 s whatever its size). */
async function injectPutLatency(l: Stub, ms: number): Promise<void> {
  if (ms === 0) return
  await runInDurableObject(l, (inst: Ledger) => {
    const real = E.BUCKET
    ;(inst as unknown as { bucket: R2Bucket }).bucket = new Proxy(real, {
      get(target, prop) {
        if (prop === 'put') return async (...a: unknown[]) => { await sleep(ms); return (target.put as (...x: unknown[]) => unknown)(...a) }
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
  })
}

interface Run {
  kind: Kind
  putMs: number
  drainDelayMs: number | null
  writers: number
  units: number
  seconds: number
  unitsPerSecond: number
  ackMs: { p50: number; p90: number; p99: number; max: number }
  /** Time from the last answer until every admitted unit was in R2 (`loggedWatermarks`). */
  loggedLagMs: number
  r2Writes: number
  tenant: string
}

async function run(kind: Kind, putMs: number, writers: number, unitsPerWriter: number, drainDelayMs: number | null = null): Promise<Run> {
  const tenant = `bench-${kind}-${putMs}-${Date.now().toString(36)}-${runN++}`
  const l = stubOf(kind, tenant)
  await l.plan({ table: 'metric_samples', minTs: 0, maxTs: 0 }) // started, base written
  await injectPutLatency(l, putMs)
  if (drainDelayMs !== null) await runInDurableObject(l, (inst: Ledger) => { (inst as unknown as { drainDelayMs: number }).drainDelayMs = drainDelayMs })
  const before = (await E.BUCKET.list({ prefix: `cell-0/ledger/tenant=${tenant}/` })).objects.length
  const t0 = performance.now()
  const results = await Promise.all(Array.from({ length: writers }, (_, id) => E.WRITER.get(E.WRITER.idFromName(`${tenant}-w${id}`)).run(kind, tenant, id, unitsPerWriter, 2)))
  const seconds = (performance.now() - t0) / 1000
  const lat = results.flatMap((r) => r.lat)
  for (const r of results) expect(r.statuses).toEqual({ ok: unitsPerWriter })
  // Until every unit is logged: immediate for the as-built ledger, one drain cycle or so for segments.
  const t1 = performance.now()
  for (;;) {
    const logged = await l.loggedWatermarks()
    if (logged.length === writers && logged.every((w) => w.seq === unitsPerWriter * 4)) break
    if (performance.now() - t1 > 120_000) throw new Error('not logged after 120 s')
    await sleep(20)
  }
  const loggedLagMs = Math.round(performance.now() - t1)
  const r2Writes = (await E.BUCKET.list({ prefix: `cell-0/ledger/tenant=${tenant}/` })).objects.length - before
  return {
    kind, putMs, drainDelayMs, writers, units: lat.length, seconds: Math.round(seconds * 100) / 100,
    unitsPerSecond: Math.round((lat.length / seconds) * 10) / 10,
    ackMs: { p50: pct(lat, 50), p90: pct(lat, 90), p99: pct(lat, 99), max: pct(lat, 100) },
    loggedLagMs, r2Writes, tenant,
  }
}

const everything = async (l: Stub, table: 'metric_samples' | 'metric_series'): Promise<Plan> => l.plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
/**
 * The state with the tenant's name taken out of keys. Precedence is left out too: it is the
 * admitting version, and concurrent writers are admitted in a different order in each run.
 */
const normal = (p: Plan, tenant: string) => ({
  files: p.files.map(({ precedence: _p, precedenceLow: _q, ...f }) => ({ ...f, key: f.key.replace(`tenant=${tenant}/`, 'tenant=T/') })).sort((x, y) => (x.key < y.key ? -1 : 1)),
  watermarks: p.watermarks,
  version: p.version,
})

/** Both ledgers hold the same state, and each one's R2 log rebuilds into it. */
async function sameResults(a: Run, b: Run): Promise<void> {
  const la = stubOf('asbuilt', a.tenant)
  const lb = stubOf('segments', b.tenant)
  for (const t of ['metric_samples', 'metric_series'] as const) {
    expect(normal(await everything(lb, t), b.tenant), `${t}: same state`).toEqual(normal(await everything(la, t), a.tenant))
  }
  // The as-built log (one object per change) read by this ledger: an object with empty storage, same tenant.
  const fromOld = E.LEDGER.get(E.LEDGER.idFromName(a.tenant))
  for (const t of ['metric_samples', 'metric_series'] as const) {
    const [x, y] = [await everything(la, t), await everything(fromOld, t)]
    expect({ files: y.files, watermarks: y.watermarks, version: y.version }, `${t}: rebuilt from the as-built log`).toEqual({ files: x.files, watermarks: x.watermarks, version: x.version })
  }
  // The segment log, after the segment ledger loses its storage.
  const want = await everything(lb, 'metric_samples')
  await runInDurableObject(lb, async (_i, s) => { await s.storage.deleteAll() })
  await evictDurableObject(lb)
  const got = await everything(lb, 'metric_samples')
  expect({ files: got.files, watermarks: got.watermarks, version: got.version }, 'rebuilt from segments').toEqual({ files: want.files, watermarks: want.watermarks, version: want.version })
}

const report = (rows: Run[]) => console.log(`BENCH ${JSON.stringify(rows.map(({ tenant: _t, ...r }) => r))}`)

describe('ledger admission rate: as built vs segments (measured here, workerd)', () => {
  it.runIf(only('admission'))('8 writers, 2 files per unit, R2 writes delayed 0 and 250 ms; then 1 writer', async () => {
    const rows: Run[] = []
    for (const putMs of [0, 250]) {
      for (const writers of [8, 1]) {
        const units = putMs === 0 ? 50 : writers === 8 ? 12 : 25
        const a = await run('asbuilt', putMs, writers, units)
        const b = await run('segments', putMs, writers, units)
        await sameResults(a, b)
        rows.push(a, b)
      }
    }
    report(rows)
  })

  it.runIf(only('tuning'))('segments, tuning the drain delay (8 writers, R2 writes delayed 250 ms)', async () => {
    const rows: Run[] = []
    for (const delay of [0, 50, 200, 1000]) rows.push(await run('segments', 250, 8, 40, delay))
    report(rows)
  })

  it.runIf(only('sustained'))('segments, sustained: 8 writers × 200 units (R2 writes delayed 250 ms)', async () => {
    const rows = [await run('segments', 250, 8, 200)]
    report(rows)
  })
})
