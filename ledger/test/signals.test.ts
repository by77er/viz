/**
 * The span and log tables in the ledger (stage 2 of traces and logs; contracts/ledger.ts
 * `Table`, contracts/TRACES.md and LOGS.md "Object keys"), and the backoff fix of `drain()`:
 *
 *   - a unit of a traces stream holds `spans` files (keyed by hour) and `trace_index` files, a
 *     unit of a logs stream `logs` files; they are admitted, planned by time (milliseconds, as
 *     every table), logged, expired by day (spans with trace_index, in one change) and rebuilt
 *     from the log exactly;
 *   - every key is the tenant's own and lies under its table and day, and a `spans` key under
 *     the hour its times lie in: anything else is `invalid` (whatever the ledger lists, the
 *     janitor will one day delete);
 *   - a `drain()` that worked ends the backoff a failed drain left, as a drain by the alarm does.
 */
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { type FileEntry, type Table, dataKeyPrefix } from '../../contracts/ledger'
import type { Ledger } from '../src/ledger'
import { DAY_MS, INC, S, T0, breakR2, dayOf, dumpState, everything, heal, loseStorage, open, pair, readLog, sleep, tenantName, unit } from './helpers'

const H = 3_600_000
const TRACES = 'shared/c1/traces/0'
const LOGS = 'shared/c1/logs/1'

/** A file of a span or log table, keyed as flush keys it (the shard part of the name is the stream's). */
function sig(tenant: string, table: Table, minTs: number, maxTs: number, name: string, over: Partial<FileEntry> = {}): FileEntry {
  const day = over.day ?? dayOf(minTs)
  const hour = table === 'spans' ? Math.floor((minTs - Date.parse(`${day}T00:00:00Z`)) / H) : undefined
  return { table, day, key: `${dataKeyPrefix(env.CELL, table, tenant, day, hour)}L0-${name}.parquet`, bytes: 1000, rows: 5, minTs, maxTs, level: 0, index: '{"v":1,"rg":[]}', ...over }
}

describe('spans, trace_index and logs in the ledger', () => {
  it('admits, plans by time and logs the files of a traces unit and a logs unit beside metrics; a rebuild restores them exactly', async () => {
    const { tenant, l } = open()
    expect(await l.addUnit(pair(1, 1))).toMatchObject({ status: 'ok' })
    const spansA = sig(tenant, 'spans', T0 + 22 * H + 5, T0 + 22 * H + 900_000, 'a')
    const spansB = sig(tenant, 'spans', T0 + 23 * H, T0 + 24 * H - 1, 'b')
    const index = sig(tenant, 'trace_index', T0 + 22 * H + 5, T0 + 24 * H + 1_000, 'i')
    expect(await l.addUnit(unit(1, 2, [spansA, spansB, index], TRACES, INC))).toMatchObject({ status: 'ok' })
    const logs = sig(tenant, 'logs', T0 + 10, T0 + 2 * H, 'l')
    expect(await l.addUnit(unit(1, 1, [logs], LOGS, INC))).toMatchObject({ status: 'ok' })

    const plan = async (table: Table, minTs: number, maxTs: number) => (await l.plan({ table, minTs, maxTs })).files.map((f) => f.key)
    expect(await plan('spans', 0, Number.MAX_SAFE_INTEGER)).toEqual([spansA.key, spansB.key])
    expect(await plan('spans', T0 + 22 * H + 900_001, T0 + 23 * H - 1)).toEqual([])
    expect(await plan('spans', T0 + 23 * H - 1, T0 + 23 * H)).toEqual([spansB.key])
    expect(await plan('trace_index', T0 + 24 * H, T0 + 24 * H)).toEqual([index.key])
    expect(await plan('logs', T0 + 2 * H, T0 + 3 * H)).toEqual([logs.key])
    expect(await plan('metric_samples', 0, Number.MAX_SAFE_INTEGER)).toHaveLength(1)
    expect((await everything(l)).watermarks.map((w) => [w.shard, w.seq]).sort()).toEqual([[S, 1], [LOGS, 1], [TRACES, 2]].sort())

    const log = await readLog(tenant, l)
    const added = log.filter((c) => c.kind === 'add_unit').map((c) => c.added.map((f) => f.table))
    expect(added).toEqual([['metric_samples', 'metric_series'], ['spans', 'spans', 'trace_index'], ['logs']])
    const before = await dumpState(l)
    await loseStorage(l)
    expect(await dumpState(l)).toEqual(before)
  })

  it('a spans key lies under the hour its times lie in; every key under the tenant, table and day; otherwise `invalid`', async () => {
    const { tenant, l } = open()
    const other = tenantName('other')
    const at = T0 + 5 * H + 1
    const good = sig(tenant, 'spans', at, at + 1000, 'good')
    const bad: [string, FileEntry][] = [
      ['no hour level', { ...good, key: `${dataKeyPrefix(env.CELL, 'spans', tenant, dayOf(at))}L0-x.parquet` }],
      ['another hour', { ...good, key: `${dataKeyPrefix(env.CELL, 'spans', tenant, dayOf(at), 6)}L0-x.parquet` }],
      ['hour 24', { ...good, key: `${dataKeyPrefix(env.CELL, 'spans', tenant, dayOf(at))}hour=24/L0-x.parquet` }],
      ['times across two hours', { ...good, maxTs: at + H }],
      ['times on another day', sig(tenant, 'spans', at, at + 1, 'd', { day: dayOf(at + DAY_MS) })],
      ['a level below the hour', { ...good, key: `${dataKeyPrefix(env.CELL, 'spans', tenant, dayOf(at), 5)}x/L0-x.parquet` }],
      ['spans of another tenant', sig(other, 'spans', at, at + 1000, 'o')],
      ['trace_index of another tenant', sig(other, 'trace_index', at, at + 1000, 'o')],
      ['logs of another tenant', sig(other, 'logs', at, at + 1000, 'o')],
      ['logs under another table', { ...sig(tenant, 'logs', at, at + 1, 'w'), key: `${dataKeyPrefix(env.CELL, 'metric_samples', tenant, dayOf(at))}L0-w.parquet` }],
      ['trace_index with an hour level', { ...sig(tenant, 'trace_index', at, at + 1, 't'), key: `${dataKeyPrefix(env.CELL, 'trace_index', tenant, dayOf(at), 5)}L0-t.parquet` }],
      ['an unknown table', { ...sig(tenant, 'logs', at, at + 1, 'u'), table: 'events' as Table, key: `${env.CELL}/data/events/tenant=${tenant}/day=${dayOf(at)}/L0-u.parquet` }],
    ]
    for (const [why, f] of bad) expect(await l.addUnit(unit(1, 1, [f], TRACES)), why).toMatchObject({ status: 'invalid' })
    expect((await everything(l)).watermarks).toEqual([])
    expect(await l.addUnit(unit(1, 1, [good, sig(tenant, 'trace_index', at, at + 1000, 'i')], TRACES))).toMatchObject({ status: 'ok' })
  })

  it('retention: spans and trace_index leave in one change by day; logs on their own; tombstones for every key', async () => {
    const { tenant, l } = open()
    const d0 = T0
    const d1 = T0 + DAY_MS
    expect(await l.addUnit(unit(1, 1, [sig(tenant, 'spans', d0 + 23 * H, d0 + 23 * H + 1, 's0'), sig(tenant, 'spans', d1 + 1, d1 + 2, 's1'), sig(tenant, 'trace_index', d0 + 23 * H, d1 + 2, 'i0')], TRACES))).toMatchObject({ status: 'ok' })
    expect(await l.addUnit(unit(1, 1, [sig(tenant, 'logs', d0, d0 + 1, 'l0'), sig(tenant, 'logs', d1, d1 + 1, 'l1')], LOGS))).toMatchObject({ status: 'ok' })
    const v = (await everything(l)).version
    const r = await l.expire({ tables: ['spans', 'trace_index'], beforeDay: dayOf(d1) })
    expect(r.removed.map((k) => k.slice(k.lastIndexOf('/') + 1)).sort()).toEqual(['L0-i0.parquet', 'L0-s0.parquet'])
    expect(r.version).toBe(v + 1)
    expect((await l.plan({ table: 'spans', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files).toHaveLength(1)
    expect((await l.plan({ table: 'logs', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files).toHaveLength(2)
    expect((await l.expire({ table: 'logs', beforeDay: dayOf(d1) })).removed).toHaveLength(1)
    expect((await l.removedSince(0)).map((t) => t.table).sort()).toEqual(['logs', 'spans', 'trace_index'])
    const log = await readLog(tenant, l)
    expect(log.filter((c) => c.kind === 'expire').map((c) => c.removedFiles!.map((x) => x.table).sort())).toEqual([['spans', 'trace_index'], ['logs']])
  })
})

describe('drain() ends the backoff of earlier failures (as the background drain does)', () => {
  it('after failed drains and a healed log, an explicit drain lets the next commit be logged at the usual delay', async () => {
    const { l } = open()
    await runInDurableObject(l, (inst: Ledger) => { (inst as unknown as { drainDelayMs: number }).drainDelayMs = 50 })
    expect(await l.addUnit(pair(1, 1))).toMatchObject({ status: 'ok' })
    await breakR2(l)
    // Four failed drains by the alarm: the next is not tried for 8 s.
    for (let i = 0; i < 4; i++) expect(await runDurableObjectAlarm(l)).toBe(true)
    const status = await l.logStatus()
    expect(status.lastError).toMatch(/injected R2 failure/)
    expect(status.alarmAt! - Date.now()).toBeGreaterThan(5000)
    await heal(l)
    expect((await l.drain()).written).toBeGreaterThan(0)
    expect(await l.outboxDepth()).toBe(0)
    // A commit now: its drain is due at the usual delay, not when the old backoff would have ended.
    const t = Date.now()
    expect(await l.addUnit(pair(2, 2))).toMatchObject({ status: 'ok' })
    expect((await l.logStatus()).alarmAt! - t).toBeLessThan(1000)
    for (let i = 0; (await l.outboxDepth()) > 0; i++) {
      expect(i, 'logged by the background drain within 2 s').toBeLessThan(40)
      await sleep(50)
    }
  })
})
