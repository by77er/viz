/**
 * The adversarial review of re-bases and rebuilds in steps (design/reviews/publisher-steps.md): its
 * findings as tests, most of them the reviewer's reproductions, adapted to assert what is now true.
 *
 *   - M-4: the release actually in production (main at PR #8: `test/n1/`, storage version 3) upgraded
 *     to this one (3 → 7 in one step), rolled back to in the middle of a staging and of a write ahead,
 *     and rolled forward again;
 *   - M-1: the publish that commits a re-base in steps does no other re-base work;
 *   - M-3: a commit cut off after its metadata write still releases the tombstones its re-base staged,
 *     in steps and whole;
 *   - M-2: `locationPrefix` cannot change while manifests are written ahead;
 *   - M-5: the checks that had no test (the added files counted again before a commit, the tombstone
 *     of a key removed after a re-base's start, the kept checkpoint continued while a newer one exists);
 *   - m-2, m-5: kept state that no longer applies is dropped.
 */
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { dayOf, fresh, icebergLive, keyOf, ledger, ledgerVersion, listKeys, liveKeys, loseLedgerStorage, metadataVersions, mirror, pairUnit, publisher, readAvroKey, readerView, readMetadata, addUnit, DAY_MS, T0, TABLES, type LedgerStub, type PublisherStub } from './helpers'
import { dumpOf, install } from './storage'
import type { PublishResult } from '../src/publisher'
import type { AnyPartition, ManifestEntryRecord, ManifestListRecord } from '../src/iceberg'
import {
  ALL,
  BUDGET,
  ENTRIES,
  HOUR,
  QUIET,
  alarmRun,
  alarmRuns,
  checkpointNow,
  keptRows,
  knobs,
  logUnit,
  m6,
  metricUnit,
  n1,
  next,
  partsOf,
  rebuilt,
  sameAsTwin,
  snapshotCursors,
  tenantLog,
  twinCells,
  units,
  workOf,
} from './steps.helpers'

/** Publish until no tenant waits and every one is read to its end. */
async function settle(p: PublisherStub, ts: string[], limit = 60): Promise<PublishResult[]> {
  const out: PublishResult[] = []
  for (let i = 0; i < limit; i++) {
    const r = await p.publish(ts)
    out.push(r)
    if (!r.tenants.some((x) => x.status === 'deferred' || x.status === 'more')) return out
  }
  throw new Error(`did not settle: ${JSON.stringify(out.at(-1)!.tenants)}`)
}

/** The `removed` rows of a publisher, as the release rule sees them. */
const removedOf = (p: PublisherStub) =>
  runInDurableObject(p, (_i, s) => s.storage.sql.exec(`SELECT tbl, tenant, key, removed_seq, free_at IS NULL AS held FROM removed ORDER BY tbl, key`).toArray())

// ───────────────────────────── M-4: the release in production ─────────────────────────────

/** A metric-only log (what production has with INGEST_SIGNALS off): units, an expiry (tombstones), a checkpoint in small parts, units after it. */
async function metricLog(t: string, rounds: number, after: number): Promise<LedgerStub> {
  const l = ledger(t)
  await l.plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })
  await knobs(l, { checkpointEvery: 1e9, checkpointByLogBytes: false, checkpointOneObjectBytes: -1, checkpointPartBytes: 600 })
  for (let i = 1; i <= rounds; i++) {
    const m = next(t, 'metric')
    await addUnit(t, pairUnit(env.CELL, t, m, m, T0 + (i % 3) * DAY_MS + i * 1000), { drain: true })
  }
  if (rounds >= 3) expect((await l.expire({ tables: ['metric_samples'], beforeDay: dayOf(T0 + DAY_MS) })).removed.length).toBeGreaterThan(0)
  await l.drain()
  await checkpointNow(l, t, rounds + 1)
  for (let i = 0; i < after; i++) await metricUnit(t, rounds + 2 + i)
  return l
}

/** Two cells published by production's release (`test/n1/`, storage 3), then this release installed on that storage (3 → 7). */
async function fromProduction(ts: string[]): Promise<{ cell: string; twin: string; capped: PublisherStub; uncapped: PublisherStub; versions: number[] }> {
  const { cell } = fresh()
  const twin = `${cell}t`
  const out: PublisherStub[] = []
  const versions: number[] = []
  for (const c of [cell, twin]) {
    for (const t of ts) await mirror(t, c)
    const old = n1(c)
    expect((await old.publish(ts)).tenants.map((x) => x.status)).toEqual(ts.map(() => 'ok'))
    const dump = await runInDurableObject(old, (_i, s) => dumpOf(s))
    versions.push((dump.rows.viz_schema![0] as { version: number }).version)
    const p = publisher(c)
    await p.pending()
    await install(p, dump)
    out.push(p)
  }
  const [capped, uncapped] = out as [PublisherStub, PublisherStub]
  await capped.configure({ maxRebaseFilesPerPublish: BUDGET, manifestTargetEntries: ENTRIES, ...QUIET })
  await uncapped.configure({ manifestTargetEntries: ENTRIES, ...QUIET })
  versions.push(((await runInDurableObject(capped, (_i, s) => dumpOf(s))).rows.viz_schema![0] as { version: number }).version)
  return { cell, twin, capped, uncapped, versions }
}

/** The metric tables of two cells as a reader sees them, equal; verified; nothing kept; every table cursored. */
async function metricsAsTwin(cell: string, twin: string, p: PublisherStub, ts: string[]): Promise<void> {
  for (const table of TABLES) expect(await readerView(cell, table), table).toEqual(await readerView(twin, table))
  for (const table of TABLES) expect(await p.verify(table), `verify ${table}`).toMatchObject({ ok: true })
  for (const t of ts) for (const table of TABLES) expect((await icebergLive(cell, table)).filter((k) => k.includes(`/tenant=${t}/`)), `${t} ${table}`).toEqual(await liveKeys(t, table))
  expect(await p.steps()).toEqual({})
  expect(await p.scratch()).toEqual({ stage: 0, liveNext: 0 })
  for (const table of ALL) for (const t of ts) expect((await p.cursors(table))[t], `${table} cursor of ${t}`).toBeDefined()
}

describe('M-4: the release in production (main at PR #8: test/n1/, storage version 3)', () => {
  it('upgraded to this release (3 → 7); rolled back to in the middle of a staging, it publishes and leaves what was kept; rolled forward, the cell ends as the twin', async () => {
    const { tenant } = fresh()
    const ts = [tenant('pb'), tenant('po')]
    const [big, other] = ts as [string, string]
    await metricLog(big, 8, 2)
    await metricLog(other, 1, 1)
    const { cell, twin, capped, uncapped, versions } = await fromProduction(ts)
    expect(versions).toEqual([3, 3, 7])
    await capped.notify(ts)
    for (let i = 0; ; i++) {
      expect(i).toBeLessThan(30)
      await alarmRun(capped)
      const kept = (await capped.steps())[big]
      if (kept && kept.target === null && kept.done > 0) break
    }
    const left = await runInDurableObject(capped, (_i, s) => dumpOf(s))
    expect(left.rows.rebase_stage!.length).toBeGreaterThan(0)

    // Rollback: production's code on storage version 7, mid re-base. New metric units for both tenants.
    const old = n1(cell)
    await install(old, left)
    await metricUnit(big, 90)
    await metricUnit(other, 91)
    for (const c of [cell, twin]) for (const t of ts) await mirror(t, c)
    expect((await old.publish(ts)).tenants.map((x) => x.status)).toEqual(['ok', 'ok'])
    for (let i = 0; i < 2; i++) {
      await old.advanceClock(2 * HOUR)
      await old.maintain()
    }
    const after = await runInDurableObject(old, (_i, s) => dumpOf(s))
    expect(keptRows(after)).toEqual(keptRows(left))
    expect(after.rows.viz_schema![0]).toMatchObject({ version: 7, compat: 1 })

    // Rolled forward.
    await install(capped, after)
    await capped.notify(ts)
    await alarmRuns(capped, 60)
    await settle(uncapped, ts)
    await metricsAsTwin(cell, twin, capped, ts)
  })

  for (const what of ['sweeps the manifests written ahead', 're-bases the tenant whole itself'] as const) {
    it(`a new ledger incarnation re-based in steps, manifests written ahead; rolled back to, production ${what}; rolled forward, the cell ends as the twin`, async () => {
      const { tenant } = fresh()
      const ts = [tenant('qb'), tenant('qo')]
      const [big, other] = ts as [string, string]
      await metricLog(big, 8, 2)
      await metricLog(other, 1, 1)
      const { cell, twin, capped, uncapped } = await fromProduction(ts)
      // The upgrade, whole, in both cells.
      await capped.configure({ maxRebaseFilesPerPublish: 1e9 })
      await settle(capped, ts)
      await settle(uncapped, ts)
      await capped.configure({ maxRebaseFilesPerPublish: BUDGET })
      // The big tenant's ledger loses its storage: incarnation 2, removals, units, a checkpoint in small parts.
      await loseLedgerStorage(big)
      const l = ledger(big)
      expect((await ledgerVersion(big)).ledgerIncarnation).toBe(2)
      await knobs(l, { checkpointEvery: 1e9, checkpointByLogBytes: false, checkpointOneObjectBytes: -1, checkpointPartBytes: 600 })
      expect((await l.expire({ tables: ['metric_samples', 'metric_series'], beforeDay: dayOf(T0 + DAY_MS) })).removed.length).toBeGreaterThan(0)
      for (let i = 0; i < 4; i++) await metricUnit(big, 40 + i)
      await checkpointNow(l, big, 50)
      await metricUnit(big, 51)
      for (const c of [cell, twin]) await mirror(big, c)
      await capped.notify([big])
      for (let i = 0; ; i++) {
        expect(i).toBeLessThan(40)
        await alarmRun(capped)
        const kept = (await capped.steps())[big]
        if (kept && kept.ahead >= 2) break
      }
      const left = await runInDurableObject(capped, (_i, s) => dumpOf(s))
      const ahead = left.rows.rebase_manifest!.map((x) => x.path as string)
      expect(ahead.every((k) => /iceberg\/metric_(samples|series)\//.test(k))).toBe(true)

      const old = n1(cell)
      await install(old, left)
      if (what === 'sweeps the manifests written ahead') {
        await metricUnit(other, 92)
        for (const c of [cell, twin]) await mirror(other, c)
        expect((await old.publish([other])).tenants[0]!.status).toBe('ok')
        for (let i = 0; i < 2; i++) {
          await old.advanceClock(2 * HOUR)
          await old.maintain()
        }
        for (const k of ahead) expect(await env.BUCKET.head(k), k).toBeNull()
      } else expect((await old.publish([big])).tenants[0]).toMatchObject({ status: 'ok' })
      const after = await runInDurableObject(old, (_i, s) => dumpOf(s))
      expect(keptRows(after)).toEqual(keptRows(left))

      await install(capped, after)
      await capped.notify(ts)
      await alarmRuns(capped, 60)
      await settle(uncapped, ts)
      await metricsAsTwin(cell, twin, capped, ts)
      for (const table of TABLES) {
        const current = (await readMetadata(cell, table))['current-snapshot-id']
        for (const [id, cursors] of await snapshotCursors(cell, table)) if (cursors[big] && id === current) expect(cursors[big]!.ledgerIncarnation).toBe(2)
      }
    })
  }
})

// ───────────────────────────── M-1: the commit's publish ─────────────────────────────

describe('M-1: the publish that commits a re-base in steps', () => {
  it('does no other re-base work, though other tenants wait for theirs', async () => {
    const { tenant } = fresh()
    const ts = [tenant('big'), ...Array.from({ length: 8 }, (_, i) => tenant(`s${i}`))]
    await tenantLog(ts[0]!, 12)
    for (const t of ts.slice(1)) await tenantLog(t, 1, 1)
    const { cell, twin, capped, uncapped } = await twinCells('new tenant', ts)
    // A budget that admits two small tenants whole (about 10 records each), and makes the big one take steps.
    await capped.configure({ maxRebaseFilesPerPublish: 20 })
    await capped.notify(ts)
    const runs = await alarmRuns(capped, 90)
    const big = ts[0]!
    const commits = runs.filter((r) => r.tenants.some((x) => x.step?.phase === 'committed'))
    expect(commits.map((r) => r.tenants.find((x) => x.step?.phase === 'committed')!.tenant)).toContain(big)
    // No staging, no writing ahead, no re-base read whole: neither the committing tenant's nor another's.
    for (const r of commits) expect(workOf(r), JSON.stringify(r.tenants.map((x) => [x.tenant.split('-')[0], x.status, x.step?.phase ?? null]))).toBe(0)
    // While others were waiting: some publish before and after it re-based other tenants.
    const at = runs.indexOf(commits.find((r) => r.tenants.some((x) => x.tenant === big && x.step?.phase === 'committed'))!)
    expect(runs.slice(at + 1).some((r) => workOf(r) > 0)).toBe(true)
    expect((await uncapped.publish(ts)).tenants.every((x) => x.status === 'ok')).toBe(true)
    await sameAsTwin(cell, twin, capped, ts)
  })
})

// ───────────────────────────── M-3: a commit cut off after its metadata write ─────────────────────────────

describe('M-3: a re-base whose commit of `logs` is cut off after the metadata write (R2 committed, SQLite not)', () => {
  it('releases the tombstones its checkpoint carried, as the twin does, in steps and whole', async () => {
    const { tenant } = fresh()
    const t = tenant('tb')
    await tenantLog(t, 6)
    const { cell, twin, capped, uncapped } = await twinCells('new tenant', [t])
    // A third cell: the whole (uncapped) path with the same cut.
    const third = `${cell}u`
    await mirror(t, third)
    const whole = publisher(third)
    await whole.configure({ manifestTargetEntries: ENTRIES, ...QUIET })
    expect((await uncapped.publish([t])).tenants[0]!.status).toBe('ok')

    await capped.notify([t])
    for (let i = 0; ; i++) {
      expect(i).toBeLessThan(40)
      await alarmRun(capped)
      const kept = (await capped.steps())[t]
      if (kept && kept.target !== null && ALL.every((x) => kept.written[x] === 'done')) break
    }
    await capped.failAt('metadata-written', 'logs')
    expect((await capped.tryPublish([t])).error).toContain('injected crash after metadata-written (logs)')
    await settle(capped, [t])
    await whole.failAt('metadata-written', 'logs')
    expect((await whole.tryPublish([t])).error).toContain('injected crash after metadata-written (logs)')
    await settle(whole, [t])

    // The same clock on all three: three days, each with a unit, a publish and maintenance.
    const cells: [string, PublisherStub][] = [[cell, capped], [twin, uncapped], [third, whole]]
    for (let d = 0; d < 3; d++) {
      await addUnit(t, logUnit(t, next(t, 'log'), T0 + 2 * DAY_MS + (200 + d) * 1000 + 7), { drain: true })
      for (const [c] of cells) await mirror(t, c)
      for (const [, p] of cells) {
        await p.advanceClock(25 * HOUR)
        await settle(p, [t])
        await p.maintain()
        await p.advanceClock(2 * HOUR)
        await p.maintain()
      }
    }
    const tw = await uncapped.safeToDelete(t)
    expect(tw.filter((k) => k.includes('/logs/')).length, 'the twin releases the tombstoned logs files').toBeGreaterThan(0)
    expect(await capped.safeToDelete(t), 'in steps, cut after the metadata write of logs').toEqual(tw)
    expect(await whole.safeToDelete(t), 'whole, cut after the metadata write of logs').toEqual(tw)
    for (const table of ALL) expect((await capped.verify(table)).ok, table).toBe(true)
  })
})

// ───────────────────────────── M-2: the location prefix ─────────────────────────────

describe('M-2: locationPrefix while manifests are written ahead', () => {
  it('cannot change (no table has a commit yet, so before this it could); once committed, the snapshot lists data files under the table location', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('lp')
    await tenantLog(t, 5, 1)
    await mirror(t, cell)
    const p = publisher(cell)
    await p.configure({ maxRebaseFilesPerPublish: BUDGET, manifestTargetEntries: ENTRIES, ...QUIET })
    await p.notify([t])
    for (let i = 0; ; i++) {
      expect(i).toBeLessThan(40)
      await alarmRun(p)
      const kept = (await p.steps())[t]
      if (kept && kept.ahead >= 2) break
    }
    for (const table of ALL) expect(await metadataVersions(cell, table)).toEqual([])
    expect((await p.tryConfigure({ locationPrefix: 's3://other-lake' })).error).toMatch(/while a re-base has manifests written ahead/)
    await alarmRuns(p, 60)
    for (const table of ALL) {
      const meta = await readMetadata(cell, table)
      const snap = meta.snapshots.find((x) => x['snapshot-id'] === meta['current-snapshot-id'])!
      for (const m of await readAvroKey<ManifestListRecord>(keyOf(snap['manifest-list']))) {
        for (const e of await readAvroKey<ManifestEntryRecord<AnyPartition>>(keyOf(m.manifest_path))) expect(e.data_file.file_path.startsWith(`${meta.location.split('/').slice(0, 3).join('/')}/`), e.data_file.file_path).toBe(true)
      }
      expect((await p.verify(table)).ok, table).toBe(true)
    }
  })
})

// ───────────────────────────── M-5: the checks that had no test ─────────────────────────────

describe('M-5: what is kept is checked before it is used', () => {
  it('a manifest written ahead whose record is lost: the added files no longer add up, the table is written again, and the cell ends as the twin', async () => {
    const { tenant } = fresh()
    const t = tenant('lost')
    await tenantLog(t, 6)
    const { cell, twin, capped, uncapped } = await twinCells('new tenant', [t])
    await capped.notify([t])
    let table: string | undefined
    for (let i = 0; ; i++) {
      expect(i).toBeLessThan(40)
      await alarmRun(capped)
      const kept = (await capped.steps())[t]
      table = kept && ALL.find((x) => kept.written[x] === 'done' && kept.tables.includes(x))
      const n = table ? await runInDurableObject(capped, (_i, s) => s.storage.sql.exec(`SELECT COUNT(*) AS n FROM rebase_manifest WHERE tbl = ?`, table).one().n as number) : 0
      if (n >= 2) break
    }
    // One record of that table's manifests is lost (its object stays in R2, unreferenced).
    await runInDurableObject(capped, (_i, s) => void s.storage.sql.exec(`DELETE FROM rebase_manifest WHERE rowid = (SELECT MIN(rowid) FROM rebase_manifest WHERE tbl = ?)`, table))
    await alarmRuns(capped, 40)
    expect((await uncapped.publish([t])).tenants[0]!.status).toBe('ok')
    await sameAsTwin(cell, twin, capped, [t])
  })

  it('files removed after a re-base\'s checkpoint (staged, then removed by the changes after it): released as the twin releases them', async () => {
    const { tenant } = fresh()
    const t = tenant('after')
    const l = await tenantLog(t, 6, 1)
    // After the checkpoint: the second day's logs expire, files the checkpoint holds.
    expect((await l.expire({ tables: ['logs'], beforeDay: dayOf(T0 + 2 * DAY_MS) })).removed.length).toBeGreaterThan(0)
    await l.drain()
    const { cell, twin, capped, uncapped } = await twinCells('new tenant', [t])
    expect((await uncapped.publish([t])).tenants[0]!.status).toBe('ok')
    await capped.notify([t])
    await alarmRuns(capped, 40)
    await sameAsTwin(cell, twin, capped, [t])
    for (const p of [capped, uncapped]) {
      await p.advanceClock(2 * HOUR)
      await p.maintain()
    }
    const released = await uncapped.safeToDelete(t)
    expect(released.filter((k) => k.includes('/logs/') && k.includes(`day=${dayOf(T0 + DAY_MS)}`)).length, 'the twin releases them').toBeGreaterThan(0)
    expect(await capped.safeToDelete(t)).toEqual(released)
  })

  it('a newer checkpoint while a staging is kept, the kept one still readable: the kept one is continued, not started over', async () => {
    const { tenant } = fresh()
    const t = tenant('kc')
    const l = await tenantLog(t, 5, 1)
    const { cell, twin, capped, uncapped } = await twinCells('new tenant', [t])
    await capped.notify([t])
    for (let i = 0; ; i++) {
      expect(i).toBeLessThan(30)
      await alarmRun(capped)
      const kept = (await capped.steps())[t]
      if (kept && kept.target === null && kept.done >= 2) break
    }
    const old = (await capped.steps())[t]!
    // The ledger checkpoints again; the cell keeps the older checkpoint's objects (they are copied, not moved).
    await units(t, 70, 1)
    await checkpointNow(l, t, 80)
    await units(t, 81, 1)
    for (const c of [cell, twin]) await mirror(t, c)
    expect((await partsOf(cell, t, 1)).some((k) => !k.includes(`/ckpt-${String(old.version).padStart(12, '0')}-`))).toBe(true)
    const runs = await alarmRuns(capped, 60)
    const versions = new Set(runs.flatMap((r) => r.tenants.filter((x) => x.step).map((x) => x.step!.version)))
    expect([...versions]).toEqual([old.version])
    expect((await uncapped.publish([t])).tenants[0]!.status).toBe('ok')
    await sameAsTwin(cell, twin, capped, [t])
  })
})

// ───────────────────────────── minors ─────────────────────────────

describe('kept state that no longer applies is dropped (review m-2, m-5)', () => {
  it('m-5: a staging kept for a tenant whose log is gone', async () => {
    const { tenant } = fresh()
    const t = tenant('gone')
    await tenantLog(t, 5, 1)
    const { cell, capped } = await twinCells('new tenant', [t])
    await capped.notify([t])
    await alarmRun(capped)
    expect((await capped.steps())[t]).toMatchObject({ target: null })
    await env.BUCKET.delete(await listKeys(`${cell}/ledger/tenant=${t}/`))
    expect((await capped.publish([t])).tenants[0]!.status).toBe('no_log')
    expect(await capped.steps()).toEqual({})
    expect(await capped.scratch()).toEqual({ stage: 0, liveNext: 0 })
  })

  it('m-2: the release before (test/m6/) rebuilds whole over a rebuild left in steps; rolled forward, nothing of it is left and the next commit is right', async () => {
    const { cell, tenant } = fresh()
    const ts = [tenant('x0'), tenant('x1')]
    for (const t of ts) {
      await tenantLog(t, 4, 1)
      await mirror(t, cell)
    }
    const first = publisher(`${cell}~first`)
    await first.configure({ manifestTargetEntries: 2, ...QUIET })
    expect((await first.publish(ts)).tenants.map((x) => x.status)).toEqual(ts.map(() => 'ok'))
    const steps = publisher(`${cell}~steps`)
    await steps.configure({ maxRebaseFilesPerPublish: 2, ...QUIET })
    for (let i = 0; ; i++) {
      expect(i).toBeLessThan(60)
      await steps.publish(ts)
      const b = Object.values(await steps.rebuilds())
      if ((await rebuilt(steps)).tbl.length >= 1 && b.some((x) => x.done > 0 && x.done < x.of)) break
    }
    const left = await runInDurableObject(steps, (_i, s) => dumpOf(s))
    const old = m6(`${cell}~steps`)
    await old.pending()
    await install(old, left)
    await old.configure(QUIET)
    await settle(old as unknown as PublisherStub, ts)
    const after = await runInDurableObject(old, (_i, s) => dumpOf(s))
    expect(after.rows.rebuild!.length).toBeGreaterThan(0) // m6 knows nothing of them
    await install(steps, after)
    await metricUnit(ts[0]!, 95)
    await mirror(ts[0]!, cell)
    await settle(steps, ts)
    expect(await steps.rebuilds()).toEqual({})
    for (const table of ALL) expect((await steps.verify(table)).ok, table).toBe(true)
    for (const t of ts) for (const table of ALL) expect((await icebergLive(cell, table)).filter((x) => x.includes(`/tenant=${t}/`)), `${t} ${table}`).toEqual(await liveKeys(t, table))
  })
})

void runDurableObjectAlarm
