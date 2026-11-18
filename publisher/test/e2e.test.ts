/**
 * End to end, for readers viz did not write. Real Parquet files from the flush encoder
 * (test/fixtures/fixture.json, made by tools/fixtures) go into the simulated bucket; a real
 * Ledger object is driven through addUnit / replace / expire / storage loss; the publisher
 * publishes after each stage. The whole `cell-0/` prefix is then dumped to `export/`, with
 * `expected.json` saying what each stage's snapshot must contain according to the ledgers.
 * `tools/verify_readers.py` opens that directory with PyIceberg and DuckDB.
 *
 * The publisher is configured with `locationPrefix = file://<export dir>`, so the URIs in
 * the metadata are the files' real locations after the dump and nothing is rewritten.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, inject, it } from 'vitest'
import type { FileEntry, FlushUnit, Table } from '../../contracts/ledger'
import fixtureJson from './fixtures/fixture.json'
import { TABLES, expectVerified, icebergLive, ledger, liveKeys, loseLedgerStorage, listKeys, publisher, snapshotEntries } from './helpers'

interface Fixture {
  cell: string
  tenants: string[]
  days: string[]
  units: Record<string, FlushUnit[]>
  compactions: Record<string, { remove: string[]; add: FileEntry[] }[]>
  files: Record<string, { tenant: string; entry: FileEntry; b64: string }>
}
const fixture = fixtureJson as unknown as Fixture

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

interface Checkpoint {
  name: string
  tables: Record<string, { snapshotId: number; metadataVersion: number; files: Record<string, string[]> }>
}

describe('end to end with real Parquet files and a real ledger', () => {
  it('publishes four stages and dumps the bucket for PyIceberg and DuckDB', async () => {
    const cell = fixture.cell
    expect(cell).toBe(env.CELL)
    const [acme, globex, initech] = fixture.tenants as [string, string, string]
    const prefix = `file://${inject('exportDir')}`
    const p = publisher(cell)
    await p.configure({ locationPrefix: prefix })

    for (const [key, f] of Object.entries(fixture.files)) await env.BUCKET.put(key, decode(f.b64))

    const checkpoints: Checkpoint[] = []
    const checkpoint = async (name: string) => {
      const r = await p.publish(fixture.tenants)
      expect(r.tenants.map((t) => t.status)).toEqual(['ok', 'ok', 'ok'])
      await expectVerified(p)
      const c: Checkpoint = { name, tables: {} }
      for (const table of TABLES) {
        const s = await p.status(table)
        const files: Record<string, string[]> = {}
        for (const t of fixture.tenants) files[t] = await liveKeys(t, table)
        // What the publisher wrote, read back with this repo's own Avro reader, equals the ledgers.
        expect(await icebergLive(cell, table, undefined, prefix)).toEqual(Object.values(files).flat().sort())
        c.tables[table] = { snapshotId: s.snapshotId as number, metadataVersion: s.version, files }
      }
      checkpoints.push(c)
      return r
    }
    const add = async (tenant: string, i: number) => expect(await ledger(tenant).addUnit(fixture.units[tenant]![i]!)).toMatchObject({ status: 'ok' })
    const compact = async (tenant: string, i: number) => expect(await ledger(tenant).replace(fixture.compactions[tenant]![i]!)).toMatchObject({ status: 'ok' })
    const expire = async (tenant: string, beforeDay: string) => {
      for (const table of TABLES) await ledger(tenant).expire({ table, beforeDay })
    }

    // Stage 1: four flush units per tenant, over three days.
    for (const t of fixture.tenants) for (let i = 0; i < 4; i++) await add(t, i)
    const first = await checkpoint('initial')
    expect(first.tables.metric_samples.added).toBe(18)

    // Stage 2: compaction of day 2 for every tenant (three L0 files become one L1 file).
    for (const t of fixture.tenants) await compact(t, 0)
    await checkpoint('compacted')

    // Stage 3: retention drops acme's first day; every tenant flushes a fifth unit; globex
    // compacts day 3 before the publisher runs, so the fifth unit's files are never published.
    await expire(acme, fixture.days[1]!)
    for (const t of fixture.tenants) await add(t, 4)
    await compact(globex, 1)
    await checkpoint('expired')
    const transient = fixture.units[globex]![4]!.files.map((f) => f.key)
    for (const table of TABLES) {
      const meta = await (await env.BUCKET.get(`${cell}/iceberg/${table}/metadata/v3.metadata.json`))!.json<{ snapshots: { 'snapshot-id': number }[] }>()
      for (const s of meta.snapshots) {
        const seen = (await snapshotEntries(cell, table as Table, s['snapshot-id'], prefix)).map((e) => e.key)
        for (const k of transient) expect(seen).not.toContain(k)
      }
    }

    // Stage 4: initech expires its first day, then its ledger loses its storage and rebuilds
    // from R2 under a new incarnation, then compacts day 3. The publisher must re-base.
    await expire(initech, fixture.days[1]!)
    await loseLedgerStorage(initech)
    await compact(initech, 1)
    const last = await checkpoint('rebased')
    expect(last.tenants.find((t) => t.tenant === initech)!.cursors.metric_samples!.ledgerIncarnation).toBe(2)

    // Nothing may be handed to deletion yet: every snapshot is still retained.
    for (const t of fixture.tenants) expect(await p.safeToDelete(t)).toEqual([])

    // Dump the cell.
    const url = inject('exportUrl')
    await fetch(`${url}/${cell}`, { method: 'DELETE' })
    const keys = await listKeys(`${cell}/`)
    for (const key of keys) {
      const o = await env.BUCKET.get(key)
      const res = await fetch(`${url}/${key}`, { method: 'PUT', body: await o!.arrayBuffer() })
      expect(res.status).toBe(200)
    }
    const expected = {
      cell,
      locationPrefix: prefix,
      tenants: fixture.tenants,
      days: fixture.days,
      tables: Object.fromEntries(TABLES.map((t) => [t, { metadata: `${cell}/iceberg/${t}/metadata/v${last.tables[t].version}.metadata.json` }])),
      checkpoints,
      objects: keys.length,
    }
    await fetch(`${url}/expected.json`, { method: 'PUT', body: JSON.stringify(expected, null, 1) })
  })
})
