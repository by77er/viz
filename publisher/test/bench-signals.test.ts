/**
 * Measurements for the span and log tables (design/DECISIONS.md D67), not assertions about speed:
 * the time and the metadata bytes of publishing 10,000 `spans` files (with their 1,000 `trace_index`
 * files) and 10,000 `logs` files, then a steady-state commit and a retention expiry on those tables.
 * Shaped as `test/bench.test.ts` for the metric tables: 10 tenants, 10 flush units each of 100 files
 * over 10 days (spans: 10 hours of each day; logs: 10 files a day), keys of realistic length and
 * entropy, index fragments of the contract's shape. The ledger logs are written by real Ledger
 * objects; the data objects are not created. Results go to `export/bench-signals.json`.
 *
 * Times are from workerd's clock on this machine with a simulated R2: local, not Cloudflare.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, inject, it } from 'vitest'
import { dataKeyPrefix, type FileEntry, type LedgerTable, type SignalTable } from '../../contracts/ledger'
import type { PublishResult } from '../src/publisher'
import { DAY_MS, INC, T0, dayOf, fresh, icebergLive, ledger, liveKeys, mirror, publisher } from './helpers'

const HOUR = 3_600_000
const mix = (seq: number, i: number, salt: number) => {
  // hash8 is the start of a SHA-256 in real keys: incompressible. A 32-bit mix stands in for it.
  let h = (seq * 0x9e3779b1 + i * 0x85ebca6b + salt * 0xc2b2ae35) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

/** File `i` of unit `seq`: spans over 10 days × 10 hours, logs 10 a day over 10 days, trace_index one a day. */
function file(tenant: string, table: SignalTable, seq: number, i: number): FileEntry {
  const h = mix(seq, i, tenant.length + table.length)
  const minTs = table === 'spans' ? T0 + (i % 10) * DAY_MS + (Math.floor(i / 10) + 2) * HOUR + seq * 60_000 : T0 + (i % 10) * DAY_MS + seq * 60_000 + Math.floor(i / 10) * 1000
  const maxTs = minTs + 59_999
  const day = dayOf(minTs)
  const signal = table === 'logs' ? 'logs' : 'traces'
  const ns = (ms: number) => `${ms}000000`
  const rg =
    table === 'spans'
      ? { rows: 1200, off: 4, len: 180_000, min_name: '', max_name: 'payment-service', min_ts: ns(minTs), max_ts: ns(maxTs), min_dur: 406, max_dur: 2_100_000_993 }
      : table === 'trace_index'
        ? { rows: 400, off: 4, len: 20_000, min_tid: '01' + h.toString(16).padStart(30, '0'), max_tid: 'fe' + h.toString(16).padStart(30, 'f'), min_ts: ns(minTs), max_ts: ns(maxTs) }
        : { rows: 3000, off: 4, len: 400_000, min_name: 'api-gateway', max_name: 'worker', min_ts: ns(minTs), max_ts: ns(maxTs), sid: ['-4404893536155934876', '8812345678901234567'] }
  return {
    table,
    day,
    key: `${dataKeyPrefix(env.CELL, table, tenant, day, table === 'spans' ? new Date(minTs).getUTCHours() : undefined)}L0-pool_${signal}_0-${INC}-${seq}-${seq}-${h.toString(16).padStart(8, '0')}.parquet`,
    bytes: 200_000 + (h % 400_000),
    rows: rg.rows,
    minTs,
    maxTs,
    level: 0,
    index: JSON.stringify({ v: 1, rg: [rg], foot: [rg.len + 4, rg.len + 2000] }),
  }
}

const row = (name: string, tables: LedgerTable[], r: PublishResult, wallMs: number) => ({
  case: name,
  tables: Object.fromEntries(
    tables.map((t) => {
      const x = r.tables[t]
      return [t, { added: x.added, removed: x.removed, manifestsWritten: x.manifestsWritten, bytes: x.bytes, totalMetadataBytes: x.bytes.manifests + x.bytes.manifestList + x.bytes.cursors + x.bytes.metadata, commitMs: x.commitMs }]
    }),
  ),
  r2: r.ops,
  publishMs: r.ms,
  wallMs: Math.round(wallMs),
})

describe('measurements: the span and log tables', () => {
  it('reports metadata bytes and time for 10,000 spans files and 10,000 logs files', async () => {
    const results: unknown[] = []
    for (const signal of ['traces', 'logs'] as const) {
      const { cell, tenant } = fresh()
      const tenants = Array.from({ length: 10 }, (_, i) => tenant(`${signal}${i}`))
      const tables: SignalTable[] = signal === 'traces' ? ['spans', 'trace_index'] : ['logs']
      for (const t of tenants) {
        await ledger(t).plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })
        for (let seq = 1; seq <= 10; seq++) {
          const files = signal === 'traces'
            ? [...Array.from({ length: 100 }, (_, i) => file(t, 'spans', seq, i)), ...Array.from({ length: 10 }, (_, i) => file(t, 'trace_index', seq, i))]
            : Array.from({ length: 100 }, (_, i) => file(t, 'logs', seq, i))
          expect(await ledger(t).addUnit({ shard: `pool/${signal}/0`, incarnation: INC, seqLo: seq, seqHi: seq, files })).toMatchObject({ status: 'ok' })
        }
        await mirror(t, cell)
      }
      const p = publisher(cell)
      let t0 = performance.now()
      let r = await p.publish()
      results.push(row(`${signal}: first publication, ${signal === 'traces' ? '10,000 spans + 1,000 trace_index files' : '10,000 logs files'} (10 tenants, 110 ledger changes)`, tables, r, performance.now() - t0))
      expect(r.tables[tables[0]!].added).toBe(10_000)
      expect((await icebergLive(cell, tables[0]!)).length).toBe(10_000)
      for (const table of tables) expect((await p.verify(table, { checkObjects: false })).ok, table).toBe(true)

      // Steady state: one more unit of one tenant.
      const t = tenants[0]!
      const one = signal === 'traces' ? [file(t, 'spans', 11, 0), file(t, 'trace_index', 11, 0)] : [file(t, 'logs', 11, 0)]
      expect(await ledger(t).addUnit({ shard: `pool/${signal}/0`, incarnation: INC, seqLo: 11, seqHi: 11, files: one })).toMatchObject({ status: 'ok' })
      await mirror(t, cell)
      t0 = performance.now()
      r = await p.publish([t])
      results.push(row(`${signal}: +1 unit on the 10,000-file table`, tables, r, performance.now() - t0))

      // Retention: every tenant's first day (1,000 of the 10,000 files) expires.
      for (const x of tenants) {
        expect((await ledger(x).expire({ tables, beforeDay: dayOf(T0 + DAY_MS) })).removed.length).toBeGreaterThan(0)
        await mirror(x, cell)
      }
      t0 = performance.now()
      r = await p.publish()
      results.push(row(`${signal}: a day expired for every tenant (1,001 ${tables[0]} files removed: 1,000 and the extra unit's)`, tables, r, performance.now() - t0))
      expect(r.tables[tables[0]!].removed).toBe(1_001)
      for (const table of tables) {
        expect((await p.verify(table, { checkObjects: false })).ok, table).toBe(true)
        expect((await icebergLive(cell, table)).length).toBe((await Promise.all(tenants.map((x) => liveKeys(x, table)))).flat().length)
      }
    }
    const res = await fetch(`${inject('exportUrl')}/bench-signals.json`, { method: 'PUT', body: JSON.stringify({ results }, null, 1) })
    expect(res.status).toBe(200)
  })
})
