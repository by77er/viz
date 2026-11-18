import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { FileEntry, Table } from '../../contracts/ledger'
import { writeAvro } from '../src/avro'
import { CURSORS_KEY, MANIFEST_ENTRY_SCHEMA, manifestHeader, type ManifestEntryRecord } from '../src/iceberg'
import type { CommitStep } from '../src/publisher'
import {
  DAY_MS,
  INC,
  PREFIX,
  T0,
  TABLES,
  addUnit,
  dayOf,
  expectVerified,
  fileFor,
  fresh,
  icebergLive,
  keyOf,
  ledger,
  ledgerVersion,
  listKeys,
  liveKeys,
  loseLedgerStorage,
  manifestList,
  metaDir,
  metadataVersions,
  mirror,
  pairUnit,
  publisher,
  putObjects,
  readAvroKey,
  readMetadata,
  snapshotEntries,
  type PublisherStub,
} from './helpers'

const HOUR = 3_600_000

/** The published live set of every table equals the ledgers' live sets. */
const expectPublished = async (cell: string, tenants: string[]) => {
  for (const table of TABLES) {
    const want = (await Promise.all(tenants.map((t) => liveKeys(t, table)))).flat().sort()
    expect(await icebergLive(cell, table), table).toEqual(want)
  }
}

/** Compaction of some live samples files of a tenant into one new file. */
const compact = async (cell: string, tenant: string, remove: string[], name: string, table: Table = 'metric_samples') => {
  const out = fileFor(cell, tenant, table, name, { level: 1, rows: 10 * remove.length, bytes: 100 })
  await putObjects([out])
  expect(await ledger(tenant).replace({ remove, add: [out] })).toMatchObject({ status: 'ok' })
  return out
}

/** Every object the current metadata references (all retained snapshots) is in R2. */
const expectReferencedObjectsExist = async (cell: string, table: Table) => {
  const meta = await readMetadata(cell, table)
  const need: string[] = meta['metadata-log'].map((m) => keyOf(m['metadata-file']))
  for (const s of meta.snapshots) {
    need.push(keyOf(s['manifest-list']), keyOf(s.summary[CURSORS_KEY] as string))
    for (const m of await readAvroKey<{ manifest_path: string }>(keyOf(s['manifest-list']))) need.push(keyOf(m.manifest_path))
  }
  for (const k of need) expect(await env.BUCKET.head(k), k).not.toBeNull()
  return need
}

describe('version order and gaps', () => {
  it('applies a log in version order and records the ledger version it reflects', async () => {
    const { cell, tenant } = fresh()
    const a = tenant('a')
    const u1 = await addUnit(a, pairUnit(cell, a, 1, 1))
    await addUnit(a, pairUnit(cell, a, 2, 2, T0 + DAY_MS))
    const merged = await compact(cell, a, [u1.files[0]!.key], 'L1-a')
    await addUnit(a, pairUnit(cell, a, 3, 3, T0 + 2 * DAY_MS))
    await ledger(a).expire({ table: 'metric_samples', beforeDay: dayOf(T0 + DAY_MS) }) // drops `merged`
    await mirror(a, cell)

    const p = publisher(cell)
    const r = await p.publish()
    expect(r.tenants).toEqual([{ tenant: a, status: 'ok', cursors: { metric_samples: await ledgerVersion(a), metric_series: await ledgerVersion(a) } }])
    await expectPublished(cell, [a])
    expect(await icebergLive(cell, 'metric_samples')).not.toContain(merged.key)
    await expectVerified(p)
    // The snapshot points at an immutable object holding the cursor of every tenant.
    const meta = await readMetadata(cell, 'metric_samples')
    const snap = meta.snapshots.at(-1)!
    const cursors = await (await env.BUCKET.get(keyOf(snap.summary[CURSORS_KEY]!)))!.json<{ cursors: Record<string, unknown> }>()
    expect(cursors.cursors).toEqual({ [a]: await ledgerVersion(a) })
    expect(snap.summary[CURSORS_KEY]).not.toContain(a) // a pointer, not the map inline
  })

  it('stops at a hole in the versions, reports it, and continues once the hole is filled', async () => {
    const { cell, tenant } = fresh()
    const [a, b] = [tenant('a'), tenant('b')]
    const u1 = await addUnit(a, pairUnit(cell, a, 1, 1))
    const u2 = await addUnit(a, pairUnit(cell, a, 2, 2))
    const u3 = await addUnit(a, pairUnit(cell, a, 3, 3))
    await addUnit(b, pairUnit(cell, b, 1, 1))
    const top = (await ledgerVersion(a)).version // base=0, register+unit1=1.., so the units are the last versions
    await mirror(a, cell, { skip: [top - 1] }) // unit 2 is missing; unit 3 is there
    await mirror(b, cell)

    const p = publisher(cell)
    const r = await p.publish()
    const ra = r.tenants.find((t) => t.tenant === a)!
    expect(ra.status).toBe('gap')
    expect(ra.gapAt).toBe(top - 1)
    expect(ra.cursors.metric_samples).toEqual({ ledgerIncarnation: 1, version: top - 2 })
    expect(r.tenants.find((t) => t.tenant === b)!.status).toBe('ok')
    // Published: unit 1 of a (before the hole) and all of b. Nothing after the hole.
    const live = await icebergLive(cell, 'metric_samples')
    expect(live).toContain(u1.files[0]!.key)
    expect(live).not.toContain(u2.files[0]!.key)
    expect(live).not.toContain(u3.files[0]!.key)
    expect(live.length).toBe(2)
    // The table is still exactly the ledgers at the published cursors.
    await expectVerified(p)
    // The tenant stays pending and the alarm will retry it.
    expect(await p.pending()).toEqual([a])
    expect(await runInDurableObject(p, (_i, state) => state.storage.getAlarm())).not.toBeNull()

    // Still a hole: the alarm changes nothing.
    await runDurableObjectAlarm(p)
    expect((await icebergLive(cell, 'metric_samples')).length).toBe(2)

    await mirror(a, cell)
    expect(await runDurableObjectAlarm(p)).toBe(true)
    await expectPublished(cell, [a, b])
    await expectVerified(p)
    expect(await p.pending()).toEqual([])
    expect(await runInDurableObject(p, (_i, state) => state.storage.getAlarm())).toBeNull()
  })

  it('refuses a log whose changes do not fit the published state', async () => {
    const { cell, tenant } = fresh()
    const a = tenant('a')
    const u1 = await addUnit(a, pairUnit(cell, a, 1, 1))
    await mirror(a, cell)
    const p = publisher(cell)
    await p.publish()
    // A forged change that removes a file which was never live.
    const v = (await ledgerVersion(a)).version + 1
    const ghost = fileFor(cell, a, 'metric_samples', 'ghost').key
    await env.BUCKET.put(
      `${cell}/ledger/tenant=${a}/1/${String(v).padStart(12, '0')}.json`,
      JSON.stringify({ ledgerIncarnation: 1, version: v, at: 0, kind: 'replace', added: [], removed: [ghost] }),
    )
    const r = await p.publish()
    expect(r.tenants[0]).toMatchObject({ status: 'inconsistent' })
    expect(r.tenants[0]!.detail).toContain(ghost)
    expect(await icebergLive(cell, 'metric_samples')).toEqual([u1.files[0]!.key])
    expect((await p.cursors('metric_samples'))[a]!.version).toBe(v - 1)
  })

  it('reports a tenant with no log and an invalid tenant id, and publishes the others', async () => {
    const { cell, tenant } = fresh()
    const a = tenant('a')
    await addUnit(a, pairUnit(cell, a, 1, 1))
    await mirror(a, cell)
    const r = await publisher(cell).publish([a, 'nobody-here', 'bad/tenant'])
    expect(Object.fromEntries(r.tenants.map((t) => [t.tenant, t.status]))).toEqual({ [a]: 'ok', 'nobody-here': 'no_log', 'bad/tenant': 'invalid' })
    await expectPublished(cell, [a])
  })
})

describe('net changes', () => {
  it('never publishes a file that was added and removed between two publications', async () => {
    const { cell, tenant } = fresh()
    const a = tenant('a')
    const p = publisher(cell)
    await p.configure({ deleteGraceMs: HOUR })
    const u1 = await addUnit(a, pairUnit(cell, a, 1, 1))
    await mirror(a, cell)
    await p.publish()

    const u2 = await addUnit(a, pairUnit(cell, a, 2, 2)) // flushed ...
    const merged = await compact(cell, a, [u1.files[0]!.key, u2.files[0]!.key], 'L1-a') // ... and compacted away before the next publish
    await mirror(a, cell)
    const r = await p.publish()
    expect(r.tables.metric_samples).toMatchObject({ added: 1, removed: 1 })

    const transient = u2.files[0]!.key
    const meta = await readMetadata(cell, 'metric_samples')
    expect(meta.snapshots.length).toBe(2)
    for (const s of meta.snapshots) {
      const entries = await snapshotEntries(cell, 'metric_samples', s['snapshot-id'])
      expect(entries.map((e) => e.key)).not.toContain(transient) // in no manifest, with any status
    }
    expect(await icebergLive(cell, 'metric_samples')).toEqual([merged.key])
    await expectVerified(p)

    // Hand-off: the never-published file is free after the grace period; the published one
    // (u1's) is still referenced by the first snapshot, so it is not.
    expect(await p.safeToDelete(a)).toEqual([])
    await p.advanceClock(HOUR + 1)
    expect(await p.safeToDelete(a)).toEqual([transient])
  })

  it('catches up on many ledger versions in one commit per table', async () => {
    const { cell, tenant } = fresh()
    const [a, b] = [tenant('a'), tenant('b')]
    const units: Record<string, FileEntry[]> = { [a]: [], [b]: [] }
    for (const t of [a, b]) {
      for (let i = 1; i <= 40; i++) units[t]!.push((await addUnit(t, pairUnit(cell, t, i, i, T0 + (i % 4) * DAY_MS))).files[0]!)
      await compact(cell, t, units[t]!.slice(0, 30).filter((f) => f.day === dayOf(T0)).map((f) => f.key), 'L1-d0')
      await ledger(t).expire({ table: 'metric_series', beforeDay: dayOf(T0 + DAY_MS) })
      await mirror(t, cell)
    }
    expect((await ledgerVersion(a)).version).toBeGreaterThanOrEqual(42)

    const p = publisher(cell)
    const r = await p.publish()
    expect(r.tenants.map((t) => t.status)).toEqual(['ok', 'ok'])
    for (const table of TABLES) {
      expect(await metadataVersions(cell, table)).toEqual([1]) // one commit, not a replay
      expect((await readMetadata(cell, table)).snapshots.length).toBe(1)
    }
    expect(r.tables.metric_samples.removed).toBe(0) // nothing was published before, so nothing is removed
    await expectPublished(cell, [a, b])
    await expectVerified(p)
  })

  it('finishes a backlog larger than one publish reads, from the alarm', async () => {
    const { cell, tenant } = fresh()
    const a = tenant('a')
    for (let i = 1; i <= 12; i++) await addUnit(a, pairUnit(cell, a, i, i))
    await mirror(a, cell)
    const p = publisher(cell)
    await p.configure({ maxChangesPerTenant: 5 })
    const r = await p.publish()
    expect(r.tenants[0]!.status).toBe('more')
    // Five changes: the stream's registration and four units.
    expect((await icebergLive(cell, 'metric_samples')).length).toBe(4)
    await expectVerified(p)
    expect(await p.pending()).toEqual([a])
    for (let i = 0; i < 5 && (await p.pending()).length > 0; i++) await runDurableObjectAlarm(p)
    expect(await p.pending()).toEqual([])
    await expectPublished(cell, [a])
    await expectVerified(p)
  })
})

describe('idempotence', () => {
  it('writes nothing when nothing changed, also after eviction', async () => {
    const { cell, tenant } = fresh()
    const a = tenant('a')
    await addUnit(a, pairUnit(cell, a, 1, 1))
    await mirror(a, cell)
    const p = publisher(cell)
    const first = await p.publish()
    expect(first.ops.put).toBe(10) // per table: manifest, manifest list, cursors, metadata, hint
    const objects = await listKeys(`${cell}/iceberg/`)

    const again = await p.publish()
    expect(again.ops.put).toBe(0)
    expect(again.tables.metric_samples).toMatchObject({ version: 1, snapshotId: null, added: 0, removed: 0 })
    await evictDurableObject(p)
    const third = await p.publish([a])
    expect(third.ops.put).toBe(0)
    expect(await listKeys(`${cell}/iceberg/`)).toEqual(objects)
    await expectVerified(p)
  })

  it('moves the cursor without a commit when a change does not touch the table', async () => {
    const { cell, tenant } = fresh()
    const a = tenant('a')
    await addUnit(a, pairUnit(cell, a, 1, 1))
    await mirror(a, cell)
    const p = publisher(cell)
    await p.publish()
    // Only the series table changes.
    const extra = fileFor(cell, a, 'metric_series', 'L1-only-series')
    await putObjects([extra])
    await ledger(a).replace({ remove: [], add: [extra] })
    await mirror(a, cell)
    const r = await p.publish()
    expect(r.tables.metric_samples.snapshotId).toBeNull()
    expect(r.tables.metric_series.added).toBe(1)
    expect(await metadataVersions(cell, 'metric_samples')).toEqual([1])
    expect(await metadataVersions(cell, 'metric_series')).toEqual([1, 2])
    expect((await p.cursors('metric_samples'))[a]).toEqual(await ledgerVersion(a))
    await expectVerified(p)
  })

  it('rebuilds its state from R2 after losing its storage, without a new commit', async () => {
    const { cell, tenant } = fresh()
    const a = tenant('a')
    const u1 = await addUnit(a, pairUnit(cell, a, 1, 1))
    await mirror(a, cell)
    const p = publisher(cell)
    await p.publish()
    await addUnit(a, pairUnit(cell, a, 2, 2))
    await compact(cell, a, [u1.files[0]!.key], 'L1-a')
    await mirror(a, cell)
    await p.publish()

    await runInDurableObject(p, async (_i, state) => { await state.storage.deleteAll() })
    await evictDurableObject(p)
    expect((await p.verify('metric_samples')).ok).toBe(false) // empty state, table at v2: reported
    const r = await p.publish()
    expect(r.ops.put).toBe(0)
    for (const table of TABLES) expect(await metadataVersions(cell, table)).toEqual([1, 2])
    expect(await p.status('metric_samples')).toMatchObject({ version: 2, files: 2 })
    await expectPublished(cell, [a])
    await expectVerified(p)
    // And it continues from there.
    await addUnit(a, pairUnit(cell, a, 3, 3))
    await mirror(a, cell)
    await p.publish()
    expect(await metadataVersions(cell, 'metric_samples')).toEqual([1, 2, 3])
    await expectPublished(cell, [a])
    await expectVerified(p)
  })
})

describe('concurrency', () => {
  it('serialises two publishes on one object', async () => {
    const { cell, tenant } = fresh()
    const [a, b] = [tenant('a'), tenant('b')]
    for (const t of [a, b]) {
      await addUnit(t, pairUnit(cell, t, 1, 1))
      await mirror(t, cell)
    }
    const p = publisher(cell)
    const [r1, r2] = await Promise.all([p.publish(), p.publish()])
    expect(r1.ops.put + r2.ops.put).toBe(10)
    for (const table of TABLES) expect(await metadataVersions(cell, table)).toEqual([1])
    await expectPublished(cell, [a, b])
    await expectVerified(p)
  })

  it('lets only one of two writers create a metadata version; the other takes its state and retries', async () => {
    const { cell, tenant } = fresh()
    const [x, y] = [tenant('x'), tenant('y')]
    for (const t of [x, y]) {
      await addUnit(t, pairUnit(cell, t, 1, 1))
      await mirror(t, cell)
    }
    const A = publisher(cell)
    const B = publisher(`${cell}~b`) // a second writer on the same cell

    // B prepares its commit of tenant y and stops just before writing the metadata file.
    const reached = B.pauseAt('cursors-written', 'metric_samples')
    const bDone = B.publish([y])
    await reached
    // Meanwhile A commits tenant x: v1 of both tables.
    const a = await A.publish([x])
    expect(a.tables.metric_samples.version).toBe(1)
    await B.resume()
    const b = await bDone
    expect(b.conflicts).toBeGreaterThanOrEqual(1)
    expect(b.tables.metric_samples.version).toBe(2)

    for (const table of TABLES) {
      expect(await metadataVersions(cell, table)).toEqual([1, 2])
      const meta = await readMetadata(cell, table)
      expect(meta.snapshots.map((s) => s['sequence-number'])).toEqual([1, 2])
      // v1 is A's commit, untouched: tenant x only. v2 has both.
      expect(await icebergLive(cell, table, meta.snapshots[0]!['snapshot-id'])).toEqual(await liveKeys(x, table))
      expect((await readMetadata(cell, table, 1)).snapshots.length).toBe(1)
      expect(await (await env.BUCKET.get(`${metaDir(cell, table)}version-hint.text`))!.text()).toBe('2')
    }
    await expectPublished(cell, [x, y])
    await expectVerified(B)
    // A is behind R2 now. It says so, and its next publish converges without a commit.
    expect((await A.verify('metric_samples')).problems.join()).toContain('R2 is at v2')
    const a2 = await A.publish([x, y])
    expect(a2.ops.put).toBe(0)
    for (const table of TABLES) expect(await metadataVersions(cell, table)).toEqual([1, 2])
    await expectVerified(A)
  })
})

describe('crash between steps', () => {
  const steps: CommitStep[] = ['manifests-written', 'manifest-list-written', 'cursors-written', 'metadata-written', 'hint-written', 'state-saved']
  for (const step of steps) {
    it(`converges after a crash right after "${step}"`, async () => {
      const { cell, tenant } = fresh()
      const a = tenant('a')
      const p = publisher(cell)
      await p.configure({ orphanGraceMs: HOUR })
      const u1 = await addUnit(a, pairUnit(cell, a, 1, 1))
      await mirror(a, cell)
      await p.publish()
      const before = await icebergLive(cell, 'metric_samples')

      await addUnit(a, pairUnit(cell, a, 2, 2))
      await compact(cell, a, [u1.files[0]!.key], 'L1-a')
      await mirror(a, cell)
      await p.failAt(step, 'metric_samples')
      expect((await p.tryPublish()).error).toMatch(/injected crash/)

      const committed = steps.indexOf(step) >= steps.indexOf('metadata-written')
      // Right after the crash, the table readers see is one of the two valid states, and it
      // agrees with the cursor object it points at.
      expect(await icebergLive(cell, 'metric_samples')).toEqual(committed ? await liveKeys(a, 'metric_samples') : before)
      expect(await p.verify('metric_samples', { cursors: 'snapshot' })).toMatchObject({ missingFromIceberg: [], extraInIceberg: [], mismatched: [], missingObjects: [] })
      if (!committed) {
        // Nothing was committed, so the publisher's own cursors must not have moved either.
        await expectVerified(p)
        expect((await p.cursors('metric_samples'))[a]!.version).toBeLessThan((await ledgerVersion(a)).version)
      }
      // The failed publish left the tenant pending for the alarm.
      expect(await runInDurableObject(p, (_i, state) => state.storage.getAlarm())).not.toBeNull()

      await evictDurableObject(p) // the process is gone; only storage and R2 remain
      const r = await p.publish()
      expect(r.tenants[0]!.status).toBe('ok')
      for (const table of TABLES) {
        expect(await metadataVersions(cell, table)).toEqual([1, 2]) // exactly one commit happened
        expect(await (await env.BUCKET.get(`${metaDir(cell, table)}version-hint.text`))!.text()).toBe('2')
        await expectReferencedObjectsExist(cell, table)
      }
      await expectPublished(cell, [a])
      await expectVerified(p)

      // Leftovers of the attempt that did not commit are orphans; the sweep removes them
      // after the grace period and nothing else.
      const marked = (await p.sweep()).metric_samples
      expect(marked.deleted).toBe(0)
      expect(marked.marked).toBe(committed ? 0 : { 'manifests-written': 2, 'manifest-list-written': 3, 'cursors-written': 4 }[step as string])
      await p.advanceClock(HOUR + 1)
      expect((await p.sweep()).metric_samples).toEqual({ marked: 0, deleted: marked.marked })
      for (const table of TABLES) await expectReferencedObjectsExist(cell, table)
      await expectVerified(p)
      await p.publish()
      expect(await metadataVersions(cell, 'metric_samples')).toEqual([1, 2])
    })
  }
})

describe('verify', () => {
  const published = async () => {
    const { cell, tenant } = fresh()
    const [a, b] = [tenant('a'), tenant('b')]
    const ua = await addUnit(a, pairUnit(cell, a, 1, 1))
    const ub = await addUnit(b, pairUnit(cell, b, 1, 1))
    await mirror(a, cell)
    await mirror(b, cell)
    const p = publisher(cell)
    await p.publish()
    await expectVerified(p)
    return { cell, a, b, ua, ub, p, tenant }
  }

  /** Rewrite the first manifest of the current snapshot with different entries. */
  const tamper = async (cell: string, change: (entries: ManifestEntryRecord[]) => ManifestEntryRecord[]) => {
    const [m] = await manifestList(cell, 'metric_samples')
    const key = keyOf(m!.manifest_path)
    const entries = change(await readAvroKey<ManifestEntryRecord>(key))
    await env.BUCKET.put(key, await writeAvro(MANIFEST_ENTRY_SCHEMA, entries, manifestHeader('metric_samples')))
  }

  it('reports a data object that is gone, and one with the wrong size', async () => {
    const { p, ua, ub } = await published()
    await env.BUCKET.delete(ua.files[0]!.key)
    await env.BUCKET.put(ub.files[0]!.key, new Uint8Array(7))
    const v = await p.verify('metric_samples')
    expect(v.ok).toBe(false)
    expect(v.missingObjects).toEqual([ua.files[0]!.key])
    expect(v.sizeMismatch).toEqual([{ key: ub.files[0]!.key, recorded: 64, actual: 7 }])
    expect(v.missingFromIceberg).toEqual([])
    expect((await p.verify('metric_series')).ok).toBe(true)
  })

  it('reports an extra file in a manifest', async () => {
    const { cell, p, a } = await published()
    const extra = fileFor(cell, a, 'metric_samples', 'not-in-any-ledger')
    await putObjects([extra])
    await tamper(cell, (entries) => [...entries, { ...entries[0]!, data_file: { ...entries[0]!.data_file, file_path: `${PREFIX}/${extra.key}` } }])
    const v = await p.verify('metric_samples')
    expect(v.ok).toBe(false)
    expect(v.extraInIceberg).toEqual([extra.key])
    expect(v.missingFromIceberg).toEqual([])
  })

  it('reports a file missing from the manifests, and a duplicate', async () => {
    const { cell, p, ua } = await published()
    await tamper(cell, (entries) => entries.filter((e) => !e.data_file.file_path.endsWith(ua.files[0]!.key)))
    expect(await p.verify('metric_samples')).toMatchObject({ ok: false, missingFromIceberg: [ua.files[0]!.key], extraInIceberg: [] })
    await tamper(cell, (entries) => [...entries, entries[0]!])
    expect((await p.verify('metric_samples')).duplicates.length).toBe(1)
  })

  it('reports a wrong partition value, row count or size in a manifest entry', async () => {
    const { cell, p, a, b, ua } = await published()
    await tamper(cell, (entries) =>
      entries.map((e) => (e.data_file.file_path.endsWith(ua.files[0]!.key) ? { ...e, data_file: { ...e.data_file, partition: { tenant: b, day: e.data_file.partition.day! + 1 }, record_count: 11 } } : e)),
    )
    const v = await p.verify('metric_samples')
    expect(v.ok).toBe(false)
    expect(v.mismatched).toEqual([
      { key: ua.files[0]!.key, field: 'tenant', iceberg: b, ledger: a },
      { key: ua.files[0]!.key, field: 'day', iceberg: dayOf(T0 + DAY_MS), ledger: dayOf(T0) },
      { key: ua.files[0]!.key, field: 'rows', iceberg: 11, ledger: 10 },
    ])
  })

  it('reports a cursor that is ahead of what the metadata holds', async () => {
    const { cell, p, a } = await published()
    const u2 = await addUnit(a, pairUnit(cell, a, 2, 2))
    await mirror(a, cell)
    const next = await ledgerVersion(a)
    // The cursor claims the new unit is published; the table does not have it.
    await runInDurableObject(p, (_i, state) => {
      state.storage.sql.exec(`UPDATE cursor SET version = ? WHERE tbl = 'metric_samples' AND tenant = ?`, next.version, a)
    })
    const v = await p.verify('metric_samples')
    expect(v.ok).toBe(false)
    expect(v.missingFromIceberg).toEqual([u2.files[0]!.key])
    // The cursor object in R2 is the other witness: against it, the table is still right.
    expect((await p.verify('metric_samples', { cursors: 'snapshot' })).missingFromIceberg).toEqual([])
  })

  it('reports a cursor that is behind the snapshot, and a missing manifest', async () => {
    const { cell, p, a } = await published()
    await runInDurableObject(p, (_i, state) => {
      state.storage.sql.exec(`UPDATE cursor SET version = version - 1 WHERE tbl = 'metric_samples' AND tenant = ?`, a)
    })
    const v = await p.verify('metric_samples')
    expect(v.ok).toBe(false)
    expect(v.problems.join()).toContain('behind the snapshot')
    const [m] = await manifestList(cell, 'metric_series')
    await env.BUCKET.delete(keyOf(m!.manifest_path))
    expect((await p.verify('metric_series')).missingObjects).toEqual([keyOf(m!.manifest_path)])
  })
})

describe('snapshot expiry and the orphan sweep', () => {
  it('keeps snapshots inside the window and at least two, and sweeps only what nothing references, after the grace period', async () => {
    const { cell, tenant } = fresh()
    const a = tenant('a')
    const p = publisher(cell)
    await p.configure({ snapshotWindowMs: HOUR, orphanGraceMs: HOUR, metadataLogMax: 2 })
    const snapshots: number[] = []
    for (let i = 1; i <= 5; i++) {
      await addUnit(a, pairUnit(cell, a, i, i))
      await mirror(a, cell)
      await p.publish()
      snapshots.push((await p.status('metric_samples')).snapshotId!)
      await p.advanceClock(25 * 60_000)
    }
    // Commit 5 was at t=100min: snapshots newer than t=40min are 3 (50), 4 (75), 5 (100).
    const meta = await readMetadata(cell, 'metric_samples')
    expect(meta.snapshots.map((s) => s['snapshot-id'])).toEqual(snapshots.slice(2))
    expect(meta['snapshot-log'].map((s) => s['snapshot-id'])).toEqual(snapshots.slice(2))
    expect(meta['metadata-log'].length).toBe(2)
    expect(meta.refs.main!['snapshot-id']).toBe(snapshots[4])

    // Time travel to every retained snapshot still works before and after sweeping.
    const travel = async () => {
      for (const [i, id] of snapshots.slice(2).entries()) expect((await icebergLive(cell, 'metric_samples', id)).length).toBe(i + 3)
    }
    await travel()
    const before = await listKeys(metaDir(cell, 'metric_samples'))
    const referenced = await expectReferencedObjectsExist(cell, 'metric_samples')

    const first = await p.sweep()
    expect(first.metric_samples.deleted).toBe(0) // first sighting only marks
    expect(first.metric_samples.marked).toBeGreaterThan(0)
    expect(await listKeys(metaDir(cell, 'metric_samples'))).toEqual(before)
    await p.advanceClock(HOUR - 60_000)
    expect((await p.sweep()).metric_samples).toEqual({ marked: 0, deleted: 0 }) // still inside the grace period
    await p.advanceClock(2 * 60_000)
    const swept = await p.sweep()
    expect(swept.metric_samples.deleted).toBe(first.metric_samples.marked)

    const after = await listKeys(metaDir(cell, 'metric_samples'))
    // What is left is exactly: the current metadata, the hint, and everything referenced.
    expect(after).toEqual([...new Set([...referenced, `${metaDir(cell, 'metric_samples')}v5.metadata.json`, `${metaDir(cell, 'metric_samples')}version-hint.text`])].sort())
    expect(after).not.toContain(`${metaDir(cell, 'metric_samples')}v1.metadata.json`)
    await expectReferencedObjectsExist(cell, 'metric_samples')
    await travel()
    await expectVerified(p)
    // Sweeping never touches data files.
    expect((await listKeys(`${cell}/data/`)).length).toBe(10)
  })

  it('does not delete the files of a commit that is in flight', async () => {
    const { cell, tenant } = fresh()
    const [x, y] = [tenant('x'), tenant('y')]
    for (const t of [x, y]) {
      await addUnit(t, pairUnit(cell, t, 1, 1))
      await mirror(t, cell)
    }
    const A = publisher(cell)
    const B = publisher(`${cell}~b`)
    await A.configure({ orphanGraceMs: HOUR })
    await A.publish([x])

    // B has written its manifest and manifest list but not yet the metadata file.
    const reached = B.pauseAt('manifest-list-written', 'metric_samples')
    const bDone = B.publish([y])
    await reached
    const inFlight = (await listKeys(metaDir(cell, 'metric_samples'))).filter((k) => k.endsWith('.avro'))
    expect(inFlight.length).toBe(4) // A's manifest and list, B's manifest and list
    const s1 = await A.sweep()
    expect(s1.metric_samples).toEqual({ marked: 2, deleted: 0 }) // seen, not deleted
    for (const k of inFlight) expect(await env.BUCKET.head(k), k).not.toBeNull()

    await B.resume()
    await bDone
    // Long after: B's files are referenced now. A must notice before it deletes anything.
    await A.advanceClock(2 * HOUR)
    const s2 = await A.sweep()
    expect(s2.metric_samples.deleted).toBe(0)
    await expectReferencedObjectsExist(cell, 'metric_samples')
    await expectPublished(cell, [x, y])
    await expectVerified(B)
  })

  it('expires snapshots from maintain() when no publish does it', async () => {
    const { cell, tenant } = fresh()
    const a = tenant('a')
    const p = publisher(cell)
    await p.configure({ snapshotWindowMs: HOUR })
    for (let i = 1; i <= 4; i++) {
      await addUnit(a, pairUnit(cell, a, i, i))
      await mirror(a, cell)
      await p.publish()
    }
    expect((await readMetadata(cell, 'metric_samples')).snapshots.length).toBe(4)
    expect((await p.maintain()).expired).toEqual({ metric_samples: 0, metric_series: 0 })
    await p.advanceClock(2 * HOUR)
    const m = await p.maintain()
    expect(m.expired).toEqual({ metric_samples: 2, metric_series: 2 }) // never fewer than two are kept
    const meta = await readMetadata(cell, 'metric_samples')
    expect(meta.snapshots.length).toBe(2)
    expect(await metadataVersions(cell, 'metric_samples')).toEqual([1, 2, 3, 4, 5])
    expect(meta['current-snapshot-id']).toBe((await p.status('metric_samples')).snapshotId)
    expect((await p.maintain()).expired).toEqual({ metric_samples: 0, metric_series: 0 })
    await expectPublished(cell, [a])
    await expectVerified(p)
  })

  it('merges small manifests when the list grows past the limit', async () => {
    const { cell, tenant } = fresh()
    const a = tenant('a')
    const p = publisher(cell)
    await p.configure({ maxManifests: 4 })
    const counts: number[] = []
    let merged = 0
    for (let i = 1; i <= 9; i++) {
      await addUnit(a, pairUnit(cell, a, i, i, T0 + (i % 3) * DAY_MS))
      await mirror(a, cell)
      merged += (await p.publish()).tables.metric_samples.manifestsMerged
      counts.push((await manifestList(cell, 'metric_samples')).length)
      await expectVerified(p)
    }
    expect(Math.max(...counts)).toBeLessThanOrEqual(4)
    expect(merged).toBeGreaterThan(0)
    await expectPublished(cell, [a])
    // A merged manifest carries its files as EXISTING with their original sequence numbers.
    const entries = await snapshotEntries(cell, 'metric_samples')
    const existing = entries.filter((e) => e.status === 0)
    expect(existing.length).toBeGreaterThan(0)
    for (const e of existing) {
      expect(e.entry.sequence_number).not.toBeNull()
      expect(e.entry.sequence_number).toBe(e.entry.file_sequence_number)
      expect(e.entry.sequence_number!).toBeLessThan(9)
    }
    expect(entries.filter((e) => e.status !== 2).map((e) => e.seq).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})

describe('safeToDelete', () => {
  it('returns a removed file only after its removal is published, its snapshots have expired and the grace period has passed', async () => {
    const { cell, tenant } = fresh()
    const [a, b] = [tenant('a'), tenant('b')]
    const p = publisher(cell)
    await p.configure({ snapshotWindowMs: HOUR, deleteGraceMs: 30 * 60_000 })
    const u1 = await addUnit(a, pairUnit(cell, a, 1, 1))
    const u2 = await addUnit(a, pairUnit(cell, a, 2, 2))
    await addUnit(b, pairUnit(cell, b, 1, 1))
    await mirror(a, cell)
    await mirror(b, cell)
    await p.publish() // snapshot 1

    const removed = [u1.files[0]!.key, u2.files[0]!.key].sort()
    await compact(cell, a, removed, 'L1-a')
    await mirror(a, cell)
    expect(await p.safeToDelete(a)).toEqual([]) // removed from the ledger, removal not published
    await p.publish() // snapshot 2 drops them
    expect(await p.safeToDelete(a)).toEqual([]) // snapshot 1 still references them

    await p.advanceClock(3 * HOUR)
    await p.maintain()
    // Snapshot 1 is outside the window but is one of the two newest, so it is kept.
    expect((await readMetadata(cell, 'metric_samples')).snapshots.length).toBe(2)
    expect(await p.safeToDelete(a)).toEqual([])

    await addUnit(a, pairUnit(cell, a, 3, 3))
    await mirror(a, cell)
    await p.publish() // snapshot 3: snapshot 1 expires
    expect((await readMetadata(cell, 'metric_samples')).snapshots.map((s) => s['sequence-number'])).toEqual([2, 3])
    expect(await p.safeToDelete(a)).toEqual([]) // unreferenced now, but inside the grace period
    await p.advanceClock(29 * 60_000)
    expect(await p.safeToDelete(a)).toEqual([])
    await p.advanceClock(2 * 60_000)
    expect(await p.safeToDelete(a)).toEqual(removed)

    // Conservative: nothing live, nothing of another tenant, nothing a retained snapshot references.
    expect(await p.safeToDelete(b)).toEqual([])
    const meta = await readMetadata(cell, 'metric_samples')
    for (const s of meta.snapshots) {
      const referenced = (await snapshotEntries(cell, 'metric_samples', s['snapshot-id'])).filter((e) => e.status !== 2).map((e) => e.key)
      for (const k of removed) expect(referenced).not.toContain(k)
    }
    for (const k of await liveKeys(a, 'metric_samples')) expect(removed).not.toContain(k)

    await p.acknowledgeDeleted(a, removed)
    expect(await p.safeToDelete(a)).toEqual([])
  })
})

describe('a new ledger incarnation', () => {
  it('re-bases from the base of the new incarnation: removes what is gone, adds what is new', async () => {
    const { cell, tenant } = fresh()
    const [a, b] = [tenant('a'), tenant('b')]
    const u1 = await addUnit(a, pairUnit(cell, a, 1, 1))
    await addUnit(a, pairUnit(cell, a, 2, 2, T0 + DAY_MS))
    await addUnit(b, pairUnit(cell, b, 1, 1))
    await mirror(a, cell)
    await mirror(b, cell)
    const p = publisher(cell)
    await p.publish()

    // Logged but not yet published in incarnation 1: retention drops day 1, a new unit arrives.
    for (const table of TABLES) await ledger(a).expire({ table, beforeDay: dayOf(T0 + DAY_MS) })
    const u3 = await addUnit(a, pairUnit(cell, a, 3, 3, T0 + DAY_MS))
    await loseLedgerStorage(a) // rebuilt from R2 as incarnation 2
    expect((await ledgerVersion(a)).ledgerIncarnation).toBe(2)
    const u4 = await addUnit(a, pairUnit(cell, a, 4, 4, T0 + 2 * DAY_MS)) // first change of incarnation 2
    await mirror(a, cell)

    const r = await p.publish()
    expect(r.tenants.find((t) => t.tenant === a)).toMatchObject({ status: 'ok', cursors: { metric_samples: await ledgerVersion(a) } })
    expect(r.tables.metric_samples).toMatchObject({ added: 2, removed: 1 })
    const live = await icebergLive(cell, 'metric_samples')
    expect(live).not.toContain(u1.files[0]!.key)
    expect(live).toContain(u3.files[0]!.key)
    expect(live).toContain(u4.files[0]!.key)
    await expectPublished(cell, [a, b])
    await expectVerified(p)
    // The snapshot that removed the file lists it as DELETED; survivors of that manifest are EXISTING.
    const entries = await snapshotEntries(cell, 'metric_samples')
    expect(entries.filter((e) => e.status === 2).map((e) => e.key)).toEqual([u1.files[0]!.key])
    expect(entries.filter((e) => e.status === 0).length).toBe(2)
    expect(entries.filter((e) => e.status === 1).length).toBe(2)

    // A second loss in a row, with nothing new: no commit, cursor moves to incarnation 3.
    await loseLedgerStorage(a)
    await ledger(a).plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })
    await mirror(a, cell)
    const again = await p.publish()
    expect(again.ops.put).toBe(0)
    expect((await p.cursors('metric_samples'))[a]!.ledgerIncarnation).toBe(3)
    await expectVerified(p)
  })

  it('refuses a cursor from an incarnation newer than anything in R2', async () => {
    const { cell, tenant } = fresh()
    const a = tenant('a')
    await addUnit(a, pairUnit(cell, a, 1, 1))
    await mirror(a, cell)
    const p = publisher(cell)
    await p.publish()
    await runInDurableObject(p, (_i, state) => { state.storage.sql.exec(`UPDATE cursor SET incarnation = 9 WHERE tenant = ?`, a) })
    const r = await p.publish()
    expect(r.tenants[0]).toMatchObject({ status: 'cursor_ahead' })
    expect(r.ops.put).toBe(0)
  })
})

describe('what is written', () => {
  it('writes a format-version 2 table with identity partitions whose values match the files', async () => {
    const { cell, tenant } = fresh()
    const [a, b] = [tenant('a'), tenant('b')]
    const ua = await addUnit(a, pairUnit(cell, a, 1, 1, T0 + 5_000))
    const ub = await addUnit(b, pairUnit(cell, b, 1, 1, T0 + 2 * DAY_MS))
    await mirror(a, cell)
    await mirror(b, cell)
    const p = publisher(cell)
    await p.publish()

    for (const table of TABLES) {
      const meta = await readMetadata(cell, table)
      expect(meta['format-version']).toBe(2)
      expect(meta.location).toBe(`${PREFIX}/${cell}/iceberg/${table}`)
      const schema = meta.schemas[0] as { fields: { id: number; name: string; required: boolean; type: string }[] }
      const byName = Object.fromEntries(schema.fields.map((f) => [f.name, f]))
      expect(byName.tenant).toMatchObject({ required: false, type: 'string' })
      expect(byName.day).toMatchObject({ required: false, type: 'date' })
      expect(meta['partition-specs']).toEqual([
        { 'spec-id': 0, fields: [
          { name: 'tenant', transform: 'identity', 'source-id': byName.tenant!.id, 'field-id': 1000 },
          { name: 'day', transform: 'identity', 'source-id': byName.day!.id, 'field-id': 1001 },
        ] },
      ])
      // The Parquet files have no field ids: the name mapping covers exactly the file's columns.
      const mapping = JSON.parse(meta.properties['schema.name-mapping.default']!) as { 'field-id': number; names: string[] }[]
      expect(mapping.map((m) => m.names[0]).sort()).toEqual(schema.fields.map((f) => f.name).filter((n) => n !== 'tenant' && n !== 'day').sort())
      for (const m of mapping) expect(byName[m.names[0]!]!.id).toBe(m['field-id'])
      expect(meta['last-column-id']).toBe(Math.max(...schema.fields.map((f) => f.id)))
      expect(meta.refs.main!['snapshot-id']).toBe(meta['current-snapshot-id'])

      // Partition values, derived here from the key layout of contracts/TABLES.md, not from the entry.
      const entries = await snapshotEntries(cell, table)
      expect(entries.length).toBe(2)
      for (const e of entries) {
        const m = /\/tenant=([^/]+)\/day=(\d{4}-\d{2}-\d{2})\//.exec(e.key)!
        expect(e.tenant).toBe(m[1])
        expect(e.day).toBe(Date.parse(`${m[2]}T00:00:00Z`) / DAY_MS)
        expect(e.status).toBe(1)
        expect(e.entry.data_file.file_format).toBe('PARQUET')
        expect(e.entry.data_file.content).toBe(0)
      }
    }

    // Per-file statistics, from the ledger's FileEntry.
    const long = (b: Uint8Array) => Number(new DataView(b.buffer, b.byteOffset, 8).getBigInt64(0, true))
    const text = (b: Uint8Array) => new TextDecoder().decode(b)
    const f = ua.files[0]!
    const e = (await snapshotEntries(cell, 'metric_samples')).find((x) => x.key === f.key)!.entry.data_file
    expect(e.record_count).toBe(f.rows)
    expect(e.file_size_in_bytes).toBe(f.bytes)
    expect(e.value_counts).toEqual([1, 2, 3, 4].map((key) => ({ key, value: f.rows })))
    expect(e.null_value_counts).toEqual([1, 2, 3, 4].map((key) => ({ key, value: 0 })))
    expect(e.lower_bounds!.map((x) => x.key)).toEqual([1, 3])
    expect(text(e.lower_bounds![0]!.value)).toBe('cpu')
    expect(text(e.upper_bounds![0]!.value)).toBe('up')
    expect(long(e.lower_bounds![1]!.value)).toBe(f.minTs)
    expect(long(e.upper_bounds![1]!.value)).toBe(f.maxTs)
    expect(e.split_offsets).toEqual([4])
    const s = (await snapshotEntries(cell, 'metric_series')).find((x) => x.key === ua.files[1]!.key)!.entry.data_file
    expect(s.lower_bounds!.map((x) => x.key)).toEqual([1, 4, 5])

    // The manifest list: counts and partition ranges.
    const [m] = await manifestList(cell, 'metric_samples')
    expect(m).toMatchObject({ content: 0, sequence_number: 1, min_sequence_number: 1, added_files_count: 2, existing_files_count: 0, deleted_files_count: 0, added_rows_count: 20 })
    expect(m!.manifest_length).toBe((await env.BUCKET.head(keyOf(m!.manifest_path)))!.size)
    expect(text(m!.partitions![0]!.lower_bound!)).toBe([a, b].sort()[0])
    expect(text(m!.partitions![0]!.upper_bound!)).toBe([a, b].sort()[1])
    const int = (x: Uint8Array) => new DataView(x.buffer, x.byteOffset, 4).getInt32(0, true)
    expect(int(m!.partitions![1]!.lower_bound!)).toBe(T0 / DAY_MS)
    expect(int(m!.partitions![1]!.upper_bound!)).toBe(T0 / DAY_MS + 2)

    // The snapshot summary.
    const snap = (await readMetadata(cell, 'metric_samples')).snapshots[0]!
    expect(snap.summary).toMatchObject({ operation: 'append', 'added-data-files': '2', 'added-records': '20', 'total-data-files': '2', 'total-records': '20', 'viz.tenants': '2' })
    expect(ub.files.length).toBe(2)
  })

  it('tolerates an index fragment it cannot read, at the cost of optional statistics only', async () => {
    const { cell, tenant } = fresh()
    const a = tenant('a')
    const u = pairUnit(cell, a, 1, 1)
    u.files[0]!.index = 'opaque, not JSON'
    await addUnit(a, u)
    await mirror(a, cell)
    const p = publisher(cell)
    await p.publish()
    const e = (await snapshotEntries(cell, 'metric_samples'))[0]!.entry.data_file
    expect(e.lower_bounds!.map((x) => x.key)).toEqual([3])
    expect(e.split_offsets).toBeNull()
    await expectVerified(p)
  })
})

describe('driving', () => {
  it('publishes from its alarm after a notify, and has no alarm when idle', async () => {
    const { cell, tenant } = fresh()
    const a = tenant('a')
    await addUnit(a, pairUnit(cell, a, 1, 1))
    await mirror(a, cell)
    const p = publisher(cell)
    const alarm = () => runInDurableObject(p, (_i, state) => state.storage.getAlarm())
    expect(await alarm()).toBeNull()
    await p.notify([a])
    await p.notify([a]) // nudges coalesce
    expect(await alarm()).not.toBeNull()
    expect(await p.pending()).toEqual([a])
    expect(await metadataVersions(cell, 'metric_samples')).toEqual([])

    await evictDurableObject(p) // the pending set and the alarm are in storage
    expect(await runDurableObjectAlarm(p)).toBe(true)
    await expectPublished(cell, [a])
    expect(await p.pending()).toEqual([])
    expect(await alarm()).toBeNull()
    expect(await runDurableObjectAlarm(p)).toBe(false)
    // An idle publish does not create an alarm either.
    await p.publish()
    expect(await alarm()).toBeNull()
  })

  it('keeps a nudge that arrives while a publish is running', async () => {
    const { cell, tenant } = fresh()
    const a = tenant('a')
    await addUnit(a, pairUnit(cell, a, 1, 1))
    await mirror(a, cell)
    const p = publisher(cell)
    const reached = p.pauseAt('manifests-written', 'metric_samples')
    const done = p.publish([a])
    await reached // the log has been read
    await addUnit(a, pairUnit(cell, a, 2, 2))
    await mirror(a, cell)
    await p.advanceClock(1000)
    await p.notify([a])
    await p.resume()
    expect((await done).tenants[0]!.status).toBe('ok')
    expect((await icebergLive(cell, 'metric_samples')).length).toBe(1)
    // The nudge was about a change this publish did not read, so it is still pending.
    expect(await p.pending()).toEqual([a])
    expect(await runDurableObjectAlarm(p)).toBe(true)
    await expectPublished(cell, [a])
    expect(await p.pending()).toEqual([])
  })

  it('does not let the location prefix change once a table exists', async () => {
    const { cell, tenant } = fresh()
    const a = tenant('a')
    await addUnit(a, pairUnit(cell, a, 1, 1))
    await mirror(a, cell)
    const p = publisher(cell)
    await p.configure({ locationPrefix: 's3://other-bucket' })
    await p.publish()
    expect((await readMetadata(cell, 'metric_samples')).location).toBe(`s3://other-bucket/${cell}/iceberg/metric_samples`)
    expect((await p.tryConfigure({ locationPrefix: 's3://moved' })).error).toMatch(/cannot change/)
    expect((await p.tryConfigure({ minSnapshots: 1 })).error).toMatch(/at least 2/)
    expect(INC).toBe(7001)
  })
})
