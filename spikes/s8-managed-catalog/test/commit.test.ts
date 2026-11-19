/**
 * The committer's rules against an in-memory REST catalog (test/mock-catalog.ts) and against the
 * R2-native conditional write on a simulated bucket. What these show is the client's logic; what
 * the managed catalog does is what the spike measures on Cloudflare (README).
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { FileEntry, Table } from '../../../contracts/ledger'
import { readAvro } from '../../../publisher/src/avro'
import { emptyMetadata, STATUS_DELETED, type ManifestEntryRecord, type TableMetadata } from '../../../publisher/src/iceberg'
import fixture from '../../../publisher/test/fixtures/fixture.json'
import { R2NativeCatalog, RestCatalog, keyOfUri, type IcebergCatalog } from '../src/catalog'
import { appendPlan, chainOf, checkIds, commitWithRetry, newSnapshotId, readCurrent, readList, replacePlan, verifyTable, type Ctx, type Publish } from '../src/commit'
import { MockCatalog } from './mock-catalog'

const F = fixture as unknown as {
  files: Record<string, { tenant: string; entry: FileEntry }>
  compactions: Record<string, { remove: string[]; add: FileEntry[] }[]>
}

const rest = (mock: MockCatalog) => new RestCatalog({ uri: 'https://catalog.invalid/acct/viz-lake', warehouse: 'acct_viz-lake', token: 'not-a-token', bucket: 'viz-lake', fetch: mock.fetch })

async function table(cat: IcebergCatalog, name: string, t: Table = 'metric_samples'): Promise<Ctx> {
  await cat.create('cell_0', name, emptyMetadata(t, 's3://placeholder', 'cell-0', crypto.randomUUID(), Date.now()))
  return { cat, bucket: env.BUCKET, keyOf: (u) => keyOfUri(u, 'viz-lake'), ns: 'cell_0', name, table: t }
}

const template = Object.values(F.files).find((f) => f.entry.table === 'metric_samples') as { tenant: string; entry: FileEntry }
const file = (tag: string, tenant = 't0'): Publish => ({ tenant, entry: { ...template.entry, key: `bench/metric_samples/tenant=${tenant}/day=${template.entry.day}/${tag}.parquet` } })

const append = (c: Ctx, tag: string, o: Parameters<typeof commitWithRetry>[3] = {}) => {
  const id = newSnapshotId()
  return commitWithRetry(c, id, appendPlan(c, [file(tag)], id, {}), o)
}

describe('table creation', () => {
  it('keeps the publisher field ids, partition field ids and sort order when the catalog assigns fresh ids in field order', async () => {
    const mock = new MockCatalog()
    for (const t of ['metric_samples', 'metric_series'] as const) {
      const c = await table(rest(mock), `ids_${t}`, t)
      const loaded = await c.cat.load('cell_0', c.name)
      expect(checkIds(t, loaded!.metadata)).toBeNull()
      expect(loaded!.metadata.properties['schema.name-mapping.default']).toBeTruthy()
    }
  })

  it('refuses a table whose ids the catalog assigned differently (partition columns numbered first)', async () => {
    const mock = new MockCatalog()
    mock.reorder = (fields) => [...fields.filter((f) => f.name === 'tenant' || f.name === 'day'), ...fields.filter((f) => f.name !== 'tenant' && f.name !== 'day')]
    const c = await table(rest(mock), 'ids_reordered')
    const loaded = await c.cat.load('cell_0', c.name)
    expect(checkIds('metric_samples', loaded!.metadata)).toMatch(/catalog has id/)
  })
})

describe('publication of the publisher end-to-end stages', () => {
  it('makes the live set equal each stage, with DELETED entries and kept sequence numbers, and does nothing on a repeat', async () => {
    const mock = new MockCatalog()
    const c = await table(rest(mock), 'stages')
    const level0 = Object.values(F.files).filter((f) => f.entry.table === 'metric_samples' && f.entry.level === 0)
    const stage1: Publish[] = level0.map((f) => ({ tenant: f.tenant, entry: f.entry }))
    const id1 = newSnapshotId()
    expect((await commitWithRetry(c, id1, replacePlan(c, stage1, id1, { 'viz.stage': 'initial' }))).status).toBe('committed')
    let v = await verifyTable(c)
    expect(v.files).toEqual(stage1.map((p) => p.entry.key).sort())

    // A compaction per tenant: remove the inputs, add the outputs (this table's files only).
    const removed = new Set(Object.values(F.compactions).flatMap((cs) => (cs[0] as { remove: string[] }).remove))
    const added = Object.entries(F.compactions).flatMap(([tenant, cs]) => (cs[0] as { add: FileEntry[] }).add.filter((e) => e.table === 'metric_samples').map((entry) => ({ tenant, entry })))
    const stage2 = [...stage1.filter((p) => !removed.has(p.entry.key)), ...added]
    const gone = stage1.length - stage1.filter((p) => !removed.has(p.entry.key)).length
    expect(gone).toBeGreaterThan(0)
    const id2 = newSnapshotId()
    const r2 = await commitWithRetry(c, id2, replacePlan(c, stage2, id2, { 'viz.stage': 'compacted' }))
    expect(r2.status).toBe('committed')
    v = await verifyTable(c, [id1, id2])
    expect(v.ok).toBe(true)
    expect(v.files).toEqual(stage2.map((p) => p.entry.key).sort())
    const meta = (await c.cat.load('cell_0', 'stages'))!.metadata
    const snap = meta.snapshots.find((s) => s['snapshot-id'] === id2)!
    expect(snap.summary['deleted-data-files']).toBe(String(gone))
    expect(snap.summary.operation).toBe('overwrite')
    // DELETED entries are in the rewritten manifests; survivors keep sequence number 1.
    let deleted = 0
    for (const r of await readList(env.BUCKET, c.keyOf, meta)) {
      const o = await env.BUCKET.get(c.keyOf(r.manifest_path))
      deleted += (await readAvro<ManifestEntryRecord>(new Uint8Array(await o!.arrayBuffer()))).records.filter((e) => e.status === STATUS_DELETED).length
    }
    expect(deleted).toBe(gone)
    const cur = await readCurrent(env.BUCKET, c.keyOf, meta)
    for (const p of stage2) expect(cur.live.get(p.entry.key)!.file.seq).toBe(added.includes(p) ? 2 : 1)

    const id3 = newSnapshotId()
    expect((await commitWithRetry(c, id3, replacePlan(c, stage2, id3, {}))).status).toBe('nothing')
  })
})

describe('concurrent committers on one table (I10)', () => {
  const run = async (cats: IcebergCatalog[], name: string) => {
    const ctxs = await Promise.all(cats.map((cat) => table(cat, name)))
    const results = await Promise.all(
      ctxs.map(async (c, i) => {
        const out = []
        for (let j = 0; j < 5; j++) out.push(await append(c, `${name}-c${i}-${j}`))
        return out
      }),
    )
    const all = results.flat()
    const ids = all.map((r) => r.snapshotId)
    const v = await verifyTable(ctxs[0] as Ctx, ids)
    return { all, v }
  }

  it('REST: every commit lands exactly once and the chain is one straight line equal to what was intended', async () => {
    const mock = new MockCatalog()
    mock.jitterMs = 15
    const { all, v } = await run([0, 1, 2, 3].map(() => rest(mock)), 'contend_rest')
    expect(all.every((r) => r.status === 'committed')).toBe(true)
    expect(all.reduce((a, r) => a + r.conflicts, 0)).toBeGreaterThan(0)
    expect(v.problems).toEqual([])
    expect(v.chain).toHaveLength(20)
    expect(v.files).toHaveLength(20)
  })

  it('R2-native: the same, with the publisher conditional write', async () => {
    const root = `r2n-${crypto.randomUUID().slice(0, 8)}`
    const { all, v } = await run([0, 1, 2, 3].map(() => new R2NativeCatalog(env.BUCKET, 'viz-lake', root)), 'contend_r2')
    expect(all.every((r) => r.status === 'committed')).toBe(true)
    expect(all.reduce((a, r) => a + r.conflicts, 0)).toBeGreaterThan(0)
    expect(v.problems).toEqual([])
    expect(v.chain).toHaveLength(20)
    expect(v.files).toHaveLength(20)
  })
})

describe('unknown outcomes: a commit whose answer is lost is decided from the catalog and never applied twice', () => {
  // A catalog that would accept a snapshot id twice: the committer alone must prevent it.
  const lenient = () => {
    const m = new MockCatalog()
    m.lenientIds = true
    return m
  }
  const applied = (m: MockCatalog) => m.applied.filter((a) => a.ok).length

  it('applied, answer lost: found in the chain and not sent again', async () => {
    const mock = lenient()
    mock.faults = ['lose-after']
    const c = await table(rest(mock), 'u_after')
    const r = await append(c, 'a')
    expect(r.status).toBe('landed')
    expect(r.attempts.map((a) => a.kind)).toEqual(['unknown'])
    expect(applied(mock)).toBe(1)
    expect((await verifyTable(c, [r.snapshotId])).problems).toEqual([])
  })

  it('lost before it was applied: sent again, applied once', async () => {
    const mock = lenient()
    mock.faults = ['lose-before']
    const c = await table(rest(mock), 'u_before')
    const r = await append(c, 'b')
    expect(r.status).toBe('committed')
    expect(applied(mock)).toBe(1)
    expect((await verifyTable(c, [r.snapshotId])).problems).toEqual([])
  })

  it('arrives late, after the resubmission committed: fenced by its requirement', async () => {
    const mock = lenient()
    mock.faults = ['late']
    const c = await table(rest(mock), 'u_late')
    const r = await append(c, 'c')
    expect(r.status).toBe('committed')
    expect(mock.release()).toBe(1)
    expect(applied(mock)).toBe(1)
    expect(mock.applied.at(-1)).toMatchObject({ ok: false, status: 409 })
    expect((await verifyTable(c, [r.snapshotId])).problems).toEqual([])
  })

  it('arrives late, after another writer moved main: fenced; the commit is rebased with the same id', async () => {
    const mock = lenient()
    mock.faults = ['late']
    const c = await table(rest(mock), 'u_interfere')
    let other = 0
    const r = await append(c, 'd', {
      afterUnknown: async () => {
        const o = await append(await table(rest(mock), 'u_interfere'), 'd-other')
        other = o.snapshotId
      },
    })
    expect(r.status).toBe('committed')
    mock.release()
    expect(applied(mock)).toBe(2)
    const v = await verifyTable(c, [other, r.snapshotId])
    expect(v.problems).toEqual([])
    expect(v.chain).toEqual([r.snapshotId, other])
  })

  it('arrives late, just before the identical resubmission: the resubmission conflicts and the id is found', async () => {
    const mock = lenient()
    mock.faults = ['late']
    const c = await table(rest(mock), 'u_race')
    const r = await append(c, 'e', { afterUnknown: async () => void (mock.releaseOnNextCommit = true) })
    expect(r.status).toBe('landed')
    expect(r.landedLate).toBe(true)
    expect(r.attempts.map((a) => a.kind)).toEqual(['unknown', 'conflict'])
    expect(applied(mock)).toBe(1)
    expect((await verifyTable(c, [r.snapshotId])).problems).toEqual([])
  })

  it('aborted by the client while the catalog keeps working: applied once whichever copy wins', async () => {
    const mock = lenient()
    mock.processMs = 40
    const c = await table(rest(mock), 'u_abort')
    const r = await append(c, 'f', { abortFirstAfterMs: 5 })
    expect(r.attempts[0]!.kind).toBe('unknown')
    expect(['landed', 'committed']).toContain(r.status)
    await new Promise((res) => setTimeout(res, 100))
    expect(applied(mock)).toBe(1)
    expect((await verifyTable(c, [r.snapshotId])).problems).toEqual([])
  })

  it('refuses a plan that changes the snapshot id between attempts (rule 1)', async () => {
    const mock = lenient()
    mock.faults = ['lose-before']
    const c = await table(rest(mock), 'u_rule1')
    const id = newSnapshotId()
    const inner = appendPlan(c, [file('g')], id, {})
    let n = 0
    await expect(commitWithRetry(c, id, async (t) => (n++ === 0 ? inner(t) : { snapshot: { ...(await inner(t)).snapshot, 'snapshot-id': newSnapshotId() } }))).rejects.toThrow(/rule 1/)
  })
})

describe('chain verification', () => {
  const meta = (snaps: [number, number | undefined, number][], current: number): TableMetadata =>
    ({ refs: { main: { 'snapshot-id': current, type: 'branch' } }, snapshots: snaps.map(([id, parent, seq]) => ({ 'snapshot-id': id, ...(parent ? { 'parent-snapshot-id': parent } : {}), 'sequence-number': seq })) }) as unknown as TableMetadata
  it('finds a duplicate id, a fork and sequence numbers out of order', () => {
    expect(chainOf(meta([[1, undefined, 1], [2, 1, 2], [3, 2, 3]], 3))).toEqual({ chain: [3, 2, 1], problems: [] })
    expect(chainOf(meta([[1, undefined, 1], [2, 1, 2], [2, 1, 2]], 2)).problems.join()).toMatch(/listed twice/)
    expect(chainOf(meta([[1, undefined, 1], [2, 1, 2], [3, 1, 2]], 3)).problems.join()).toMatch(/fork/)
    expect(chainOf(meta([[1, undefined, 2], [2, 1, 2]], 2)).problems.join()).toMatch(/sequence number/)
  })
})
