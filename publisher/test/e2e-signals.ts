/**
 * End to end for the span and log tables (design/DECISIONS.md D67), for readers viz did not
 * write. Real `spans`, `trace_index` and `logs` files made by viz's write path from the OTLP
 * corpus of stack/test (test/fixtures/signals.json, made by tools/signal_fixture.mjs: edge, the
 * shards, flush through engine/wasm, the ledger) go into the simulated bucket under two tenants of
 * their own; a real Ledger admits them as flush units, expires days and loses its storage; the
 * publisher publishes after each of four stages. Every object the tables reference, and their
 * metadata, is then dumped to `export/signals/`, with `expected.json` saying what each stage's
 * snapshot must hold according to the ledgers (each tenant's live files in the ledger's precedence
 * order, which a reader needs to resolve a span stored by two units).
 * `tools/verify_signal_readers.py` opens that directory with PyIceberg and DuckDB and compares what
 * they read with viz's own readers (engine/storage) and the TraceQL and LogQL engines.
 *
 * The publisher is configured with `locationPrefix = file://<export dir>/signals`, so the URIs in
 * the metadata are the files' real locations after the dump and nothing is rewritten.
 *
 * Run by two test files, each with storage of its own: `e2e-signals.test.ts` (into `export/signals/`,
 * every publish whole) and `e2e-signals-steps.test.ts` (into `export/signals-steps/`, stage 4's re-base
 * in steps, its added files written into manifests ahead of its commit: README, "Re-bases and rebuilds
 * in steps"). The same tenants and files, so the readers must find the same content in both.
 */
import { env } from 'cloudflare:workers'
import { expect, inject } from 'vitest'
import { dataKeyPrefix, type FileEntry, type FlushUnit, type LedgerTable, type SignalTable } from '../../contracts/ledger'
import fixtureJson from './fixtures/signals.json'
import { INC, icebergLive, ledger, ledgerVersion, listKeys, loseLedgerStorage, mirror, publisher, snapshotEntries } from './helpers'

interface SignalFixture {
  seed: number
  stack: unknown
  units: { signal: 'traces' | 'logs'; files: { table: SignalTable; day: string; hour: number | null; rows: number; bytes: number; minTs: number; maxTs: number; index: string; sha256: string; b64: string }[] }[]
}
const fixture = fixtureJson as unknown as SignalFixture
const SIGNALS: SignalTable[] = ['spans', 'trace_index', 'logs']
const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

interface Checkpoint {
  name: string
  tables: Record<string, { snapshotId: number | null; metadataVersion: number; files: Record<string, string[]> }>
}

/** The four stages, dumped into `export/{dir}/`; with `steps`, stage 4's re-base goes on in steps. */
export async function signalsEndToEnd(dir: string, steps: boolean): Promise<void> {
    // Fixed names, as the metric end-to-end test's: the content hashes the readers print include the tenant.
    const cell = 'sig-cell'
    const tenants = ['sig-a', 'sig-b'] as const
    const [a, b] = tenants
    const prefix = `file://${inject('exportDir')}/${dir}`
    const p = publisher(cell)
    await p.configure({ locationPrefix: prefix })
    for (const t of tenants) await ledger(t).plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })

    // The fixture's units, re-keyed under the tenants (traces and logs units alternate between them).
    const files: Record<string, FileEntry & { tenant: string; hour: number | null; sha256: string }> = {}
    const units: Record<string, { traces: FlushUnit[]; logs: FlushUnit[] }> = { [a]: { traces: [], logs: [] }, [b]: { traces: [], logs: [] } }
    const seq: Record<string, number> = {}
    const perSignal = { traces: 0, logs: 0 }
    for (const u of fixture.units) {
      const tenant = tenants[perSignal[u.signal]++ % 2]!
      const shard = `pool/${u.signal}/0`
      const s = (seq[`${tenant}/${shard}`] = (seq[`${tenant}/${shard}`] ?? 0) + 1)
      const unit: FlushUnit = { shard, incarnation: INC, seqLo: s, seqHi: s, files: [] }
      for (const f of u.files) {
        const key = `${dataKeyPrefix(env.CELL, f.table, tenant, f.day, f.hour ?? undefined)}L0-pool_${u.signal}_0-${INC}-${s}-${s}-${f.sha256.slice(0, 8)}.parquet`
        const entry: FileEntry = { table: f.table, day: f.day, key, bytes: f.bytes, rows: f.rows, minTs: f.minTs, maxTs: f.maxTs, level: 0, index: f.index }
        await env.BUCKET.put(key, decode(f.b64))
        files[key] = { ...entry, tenant, hour: f.hour, sha256: f.sha256 }
        unit.files.push(entry)
      }
      units[tenant]![u.signal].push(unit)
    }
    expect(Object.keys(files)).toHaveLength(fixture.units.reduce((n, u) => n + u.files.length, 0))

    const checkpoints: Checkpoint[] = []
    const published: Awaited<ReturnType<typeof p.publish>>[] = []
    const checkpoint = async (name: string) => {
      for (const t of tenants) await mirror(t, cell)
      // In steps (a re-base too large for the budget): publish until no tenant waits and every one is read to its end.
      const all = [await p.publish([...tenants])]
      while (all.at(-1)!.tenants.some((t) => t.status === 'deferred' || t.status === 'more')) {
        expect(all.length, `stage ${name}`).toBeLessThan(40)
        all.push(await p.publish([...tenants]))
      }
      const r = all.at(-1)!
      published.push(...all)
      expect(r.tenants.map((t) => [t.tenant, t.status])).toEqual(tenants.map((t) => [t, 'ok']))
      for (const table of SIGNALS) {
        const v = await p.verify(table)
        expect(v, `verify(${table})`).toMatchObject({ ok: true, missingFromIceberg: [], extraInIceberg: [], mismatched: [], missingObjects: [], sizeMismatch: [], problems: [] })
      }
      const c: Checkpoint = { name, tables: {} }
      for (const table of SIGNALS) {
        const s = await p.status(table)
        const live: Record<string, string[]> = {}
        // Each tenant's live files in the ledger's precedence order (ascending: a later file wins a duplicate row).
        for (const t of tenants) live[t] = (await ledger(t).plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files.map((f) => f.key)
        // What the publisher wrote, read back with this repository's own Avro reader, equals the ledgers.
        expect(await icebergLive(cell, table, undefined, prefix)).toEqual(Object.values(live).flat().sort())
        c.tables[table] = { snapshotId: s.snapshotId, metadataVersion: s.version, files: live }
      }
      checkpoints.push(c)
      return r
    }
    const add = async (t: string, signal: 'traces' | 'logs', i: number) => expect(await ledger(t).addUnit(units[t]![signal][i]!)).toMatchObject({ status: 'ok' })
    const expire = async (t: string, tables: LedgerTable[], beforeDay: string) => (await ledger(t).expire({ tables, beforeDay })).removed

    // Stage 1: a traces unit and a logs unit per tenant (two days, four hours of spans). In steps: both
    // ledgers then lose their storage, so each first publication is a re-base from a base holding every
    // file (a new tenant's first base is empty: its files come in the changes after it, which a commit
    // writes as from a cursor), and both are written ahead, two files per manifest, within a budget of two.
    if (steps) await p.configure({ maxRebaseFilesPerPublish: 2, manifestTargetEntries: 2, continueMs: 1e9, retryMs: 1e9 })
    for (const t of tenants) for (const s of ['traces', 'logs'] as const) await add(t, s, 0)
    if (steps) for (const t of tenants) await loseLedgerStorage(t)
    await checkpoint('initial')
    const added = (table: SignalTable) => published.reduce((n, r) => n + r.tables[table].added, 0)
    expect(added('spans')).toBe(8)
    expect(added('trace_index')).toBe(4)
    expect(added('logs')).toBe(4)
    if (steps) {
      const stepped = published.flatMap((r) => r.tenants.filter((t) => t.step).map((t) => t.step!))
      expect(stepped.filter((x) => x.written > 0).length, 'publishes that wrote ahead').toBeGreaterThanOrEqual(2)
      expect(stepped.filter((x) => x.phase === 'committed')).toHaveLength(2)
    } else expect(published).toHaveLength(1)

    // Stage 2: one more of each per tenant.
    for (const t of tenants) for (const s of ['traces', 'logs'] as const) await add(t, s, 1)
    await checkpoint('appended')

    // Stage 3: the third of each, then retention: a's logs and b's traces of the first day. The
    // first day's files of the third units are added and removed between two publications.
    for (const t of tenants) for (const s of ['traces', 'logs'] as const) await add(t, s, 2)
    const day1 = fixture.units[0]!.files.map((f) => f.day).sort().at(-1)!
    expect((await expire(a, ['logs'], day1)).length).toBe(3)
    expect((await expire(b, ['spans', 'trace_index'], day1)).length).toBe(9)
    await checkpoint('expired')
    const transient = [...units[a]!.logs[2]!.files, ...units[b]!.traces[2]!.files].filter((f) => f.day < day1).map((f) => f.key)
    expect(transient).toHaveLength(4)
    for (const table of SIGNALS) {
      const meta = await (await env.BUCKET.get(`${cell}/iceberg/${table}/metadata/v3.metadata.json`))!.json<{ snapshots: { 'snapshot-id': number }[] }>()
      for (const s of meta.snapshots) {
        const seen = (await snapshotEntries(cell, table, s['snapshot-id'], prefix)).map((e) => e.key)
        for (const k of transient) expect(seen).not.toContain(k)
      }
    }

    // Stage 4: b's ledger loses its storage and rebuilds from R2 as incarnation 2, then expires
    // b's logs of the first day: the publisher re-bases b from the new incarnation's base. In steps:
    // its added files written ahead of the commit, two per manifest, a manifest or two per publish.
    await loseLedgerStorage(b)
    expect((await expire(b, ['logs'], day1)).length).toBe(3)
    const before = published.length
    const last = await checkpoint('rebased')
    const rebasedBy = published.slice(before).find((r) => r.tenants.some((t) => t.tenant === b && t.rebase))!
    expect(rebasedBy.tenants.find((t) => t.tenant === b)).toMatchObject({ rebase: { source: 'base' }, cursors: { spans: await ledgerVersion(b), logs: await ledgerVersion(b) } })
    // In steps, the base (staged whole) took the publish past its budget: the re-base went on in steps (it removes files only).
    if (steps) expect(published.slice(before).flatMap((r) => r.tenants.filter((t) => t.tenant === b && t.step).map((t) => t.step!.phase))).toContain('committed')
    else expect(published.length - before).toBe(1)
    expect((await ledgerVersion(b)).ledgerIncarnation).toBe(steps ? 3 : 2)
    for (const t of tenants) expect(await p.safeToDelete(t)).toEqual([])

    // Dump: the publisher's cell (its metadata and its copy of the logs) and the tenants' data files.
    const url = inject('exportUrl')
    await fetch(`${url}/${dir}`, { method: 'DELETE' })
    const keys = [...(await listKeys(`${cell}/`)), ...Object.keys(files)]
    for (const key of keys) {
      const o = await env.BUCKET.get(key)
      expect(o, key).not.toBeNull()
      const res = await fetch(`${url}/${dir}/${key}`, { method: 'PUT', body: await o!.arrayBuffer() })
      expect(res.status).toBe(200)
    }
    const expected = {
      cell,
      locationPrefix: prefix,
      tenants,
      day1,
      fixture: { seed: fixture.seed, stack: fixture.stack },
      tables: Object.fromEntries(SIGNALS.map((t) => [t, { metadata: `${cell}/iceberg/${t}/metadata/v${last.tables[t].version}.metadata.json` }])),
      checkpoints,
      files: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, { table: f.table, tenant: f.tenant, day: f.day, hour: f.hour, rows: f.rows, bytes: f.bytes, minTs: f.minTs, maxTs: f.maxTs, sha256: f.sha256, index: f.index }])),
      objects: keys.length,
    }
    await fetch(`${url}/${dir}/expected.json`, { method: 'PUT', body: JSON.stringify(expected, null, 1) })
}
