/**
 * Publication without a caller (design/DECISIONS.md D31). The maintenance run, which every
 * flush that changed something already causes and which makes the ledger's other changes,
 * nudges the cell's publisher (`nudge`, best effort and bounded). The publisher's one alarm
 * then publishes, retries, expires old snapshots and sweeps, each at its own deadline, and is
 * deleted when nothing is due. Nothing on the ingest or flush path calls it (D15); the hourly
 * cron does not call it at all.
 */
import { runDurableObjectAlarm } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { CURSORS_KEY } from '../src/iceberg'
import { nudge } from '../src/nudge'
import { DAY_MS, T0, TABLES, addUnit, expectVerified, fileFor, fresh, icebergLive, keyOf, ledger, listKeys, liveKeys, metaDir, mirror, pairUnit, publisher, putObjects, readAvroKey, readMetadata, type PublisherStub } from './helpers'

const HOUR = 3_600_000

/** Every object the current metadata of a table references, with the current metadata file and the hint. */
async function referenced(cell: string, table: (typeof TABLES)[number]): Promise<string[]> {
  const meta = await readMetadata(cell, table)
  const versions = (await listKeys(metaDir(cell, table))).map((k) => /\/v(\d+)\.metadata\.json$/.exec(k)?.[1]).filter((v) => v !== undefined).map(Number)
  const need = new Set<string>([`${metaDir(cell, table)}v${Math.max(...versions)}.metadata.json`, `${metaDir(cell, table)}version-hint.text`])
  for (const m of meta['metadata-log']) need.add(keyOf(m['metadata-file']))
  for (const s of meta.snapshots) {
    need.add(keyOf(s['manifest-list']))
    need.add(keyOf(s.summary[CURSORS_KEY] as string))
    for (const m of await readAvroKey<{ manifest_path: string }>(keyOf(s['manifest-list']))) need.add(keyOf(m.manifest_path))
  }
  return [...need].sort()
}

/** Run the alarm at each deadline until none is left. Returns how many times it ran. */
async function settle(p: PublisherStub, limit = 10): Promise<number> {
  let runs = 0
  for (;;) {
    const s = await p.schedule()
    if (s.alarm === null) {
      expect(s.due, 'no deadline without an alarm').toEqual({})
      return runs
    }
    expect(runs, `still due after ${runs} alarms: ${JSON.stringify(s.due)}`).toBeLessThan(limit)
    await p.advanceClock(Math.max(0, Math.min(...Object.values(s.due)) - s.now))
    expect(await runDurableObjectAlarm(p)).toBe(true)
    runs++
  }
}

describe('nudges', () => {
  it('notify only records the nudge: no R2 operation, nothing published until the alarm, and later nudges never push the deadline back', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('a')
    await addUnit(t, pairUnit(cell, t, 1, 1))
    await mirror(t, cell)
    const p = publisher(cell)
    await p.notify([t])
    const first = await p.schedule()
    expect(Object.keys(first.due)).toEqual(['publish'])
    expect(first.due.publish! - first.now).toBeGreaterThan(119_000) // publishIntervalMs after the nudge
    expect(first.due.publish! - first.now).toBeLessThanOrEqual(120_000)
    expect(first.alarm).not.toBeNull()
    expect(await listKeys(`${cell}/iceberg/`)).toEqual([])
    await p.advanceClock(60_000)
    await p.notify([t, 'bad/tenant'])
    expect((await p.schedule()).due).toEqual(first.due) // coalesced: the first nudge's deadline stands
    expect(await p.pending()).toEqual([t])
    expect(await runDurableObjectAlarm(p)).toBe(true)
    for (const table of TABLES) expect(await icebergLive(cell, table)).toEqual(await liveKeys(t, table))
    expect(await p.pending()).toEqual([])
    expect((await p.schedule()).due.publish).toBeUndefined()
  })

  it('a nudge never holds or fails its caller: a slow publisher, a refusing one, none at all', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('a')
    const p = publisher(cell)
    await p.misbehave({ notifyDelayMs: 5_000 })
    let t0 = Date.now()
    expect(await nudge(env.PUBLISHER, cell, [t], 200)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(2_000)
    await p.misbehave({ notifyFails: true })
    t0 = Date.now()
    expect(await nudge(env.PUBLISHER, cell, [t], 200)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(await nudge(undefined, cell, [t])).toBe(false)
    expect(await nudge(env.PUBLISHER, cell, [])).toBe(true)
    await p.misbehave({})
    expect(await nudge(env.PUBLISHER, cell, [t])).toBe(true)
    expect(await p.pending()).toEqual([t])
  })
})

describe('without a caller', () => {
  it('maintenance runs nudge, the alarm publishes, expires and sweeps, then is gone; 48 idle hourly ticks wake nothing and write nothing', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('a')
    const p = publisher(cell)
    await p.configure({ snapshotWindowMs: 6 * HOUR, orphanGraceMs: HOUR })
    // A tenant's working day: four flushes, then a compaction, each followed (as in the stack)
    // by a maintenance run that nudges the publisher. The alarm publishes at its deadline.
    const step = async () => {
      await mirror(t, cell)
      expect(await nudge(env.PUBLISHER, cell, [t])).toBe(true)
      const s = await p.schedule()
      await p.advanceClock(s.due.publish! - s.now)
      expect(await runDurableObjectAlarm(p)).toBe(true)
      for (const table of TABLES) expect(await icebergLive(cell, table)).toEqual(await liveKeys(t, table))
      await p.advanceClock(30 * 60_000)
    }
    const units = []
    for (let i = 1; i <= 4; i++) {
      units.push(await addUnit(t, pairUnit(cell, t, i, i, T0 + (i % 2) * DAY_MS)))
      await step()
    }
    const merged = fileFor(cell, t, 'metric_samples', 'L1-a', { level: 1, rows: 20, bytes: 100 })
    await putObjects([merged])
    expect(await ledger(t).replace({ remove: [units[1]!.files[0]!.key, units[3]!.files[0]!.key], add: [merged] })).toMatchObject({ status: 'ok' })
    await step()
    expect((await readMetadata(cell, 'metric_samples')).snapshots).toHaveLength(5)
    const due = (await p.schedule()).due
    expect(Object.keys(due).sort()).toEqual(['expire:metric_samples', 'expire:metric_series', 'sweep'])

    // What time alone still has to do: a sweep after the last commit, the expiry of the
    // snapshots beyond the newest two once they leave the window, and the sweep of what that
    // expiry stopped referencing (marked, then deleted a grace period later). Then nothing.
    const runs = await settle(p)
    // The sweep after the last commit (nothing unreferenced yet); the expiry of each table (the
    // series table's snapshots are older: the compaction did not commit to it); the sweep that
    // marks what the expiries dropped; the sweep that deletes it a grace period later.
    expect(runs).toBe(5)
    for (const table of TABLES) {
      expect((await readMetadata(cell, table)).snapshots).toHaveLength(2)
      expect((await listKeys(metaDir(cell, table))).sort(), `${table}: what remains is exactly what is referenced`).toEqual(await referenced(cell, table))
    }
    await expectVerified(p)

    // Idle: the hourly cron reads KV only and enqueues nothing for idle tenants (stack/), so no
    // maintenance run nudges. The publisher has no alarm: no wake, no R2 operation. It has no
    // queue binding at all.
    const before = await listKeys(`${cell}/`)
    let wakes = 0
    for (let hour = 0; hour < 48; hour++) {
      await p.advanceClock(HOUR)
      if (await runDurableObjectAlarm(p)) wakes++
    }
    expect(wakes).toBe(0)
    expect(await listKeys(`${cell}/`)).toEqual(before)
    expect(await p.schedule()).toMatchObject({ due: {}, alarm: null })
  })
})
