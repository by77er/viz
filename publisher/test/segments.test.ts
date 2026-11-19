/**
 * The ledger's segment log as the publisher reads it (contracts/LEDGER-LOG.md, "Readers of
 * the log"; contracts/COMPATIBILITY.md §3.6, §8.6).
 *
 *   - Golden: real segment bytes, written by the current ledger code through this test pool and
 *     checked in (`test/golden/formats/read.ledger-segment.v1.json`), are published stage by
 *     stage and across a new ledger incarnation; and the ledger still writes those bytes
 *     (timestamps aside), so a change of format without a new version fails here.
 *   - The first layout, written by the frozen as-built ledger, is still read, and so is the
 *     segment incarnation a current ledger starts when it takes such a tenant over.
 *   - The reader's rules: a cursor inside a segment, overlapping segments, both layouts in one
 *     incarnation, whole segments per publish, checkpoints never read.
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { encodeLedgerSegment, ledgerBaseKey, ledgerLogKey, ledgerSegmentKey, type FileEntry, type LedgerChange, type Table } from '../../contracts/ledger'
import { readTenantLog } from '../src/log'
import { FORMATS } from '../src/schema'
import { goldenFile } from './golden'
import {
  DAY_MS,
  T0,
  TABLES,
  addUnit,
  copyLog,
  dayOf,
  expectVerified,
  fileFor,
  fresh,
  icebergLive,
  ledger,
  ledgerVersion,
  listKeys,
  liveKeys,
  loseLedgerStorage,
  mirror,
  pairUnit,
  publisher,
  putObjects,
  putSegment,
  segmentsOf,
} from './helpers'

const GOLDEN = `formats/read.ledger-segment.v${FORMATS['read.ledger-segment']}.json`
/** The scenario's tenant. Only this file's first test drives a ledger of that name. */
const TENANT = 'segfix'

interface Stage {
  name: string
  /** Every log object in R2 at this stage, relative to the cell. */
  objects: string[]
  /** The ledger's committed (and, after its drain, logged) version. */
  cursor: { ledgerIncarnation: number; version: number }
  live: Record<Table, string[]>
}

interface SegmentGolden {
  format: string
  version: number
  note: string
  tenant: string
  /** Each log object's bytes, as the ledger wrote them, by key relative to the cell. */
  objects: Record<string, string>
  stages: Stage[]
}

/** The only thing in a log object that differs from run to run is the ledger's clock. */
const scrub = (body: string) => body.replace(/"at":\d+/g, '"at":0')

/**
 * The scenario, on the real `Ledger`: two units, a third, a compaction (a checkpoint follows its
 * segment: the pool sets `LEDGER_CHECKPOINT_EVERY` to 3), retention of the first day together
 * with a fourth unit in one segment, storage loss (incarnation 2 starts with a base segment,
 * rebuilt from the checkpoint), a fifth unit. Drains only where a stage says so.
 */
async function writeScenario(): Promise<{ objects: Record<string, string>; stages: Stage[] }> {
  const t = TENANT
  const stages: Stage[] = []
  const stage = async (name: string) => {
    await ledger(t).drain()
    const objects = (await listKeys(`${env.CELL}/ledger/tenant=${t}/`)).map((k) => k.slice(env.CELL.length + 1))
    const live = {} as Record<Table, string[]>
    for (const table of TABLES) live[table] = await liveKeys(t, table)
    stages.push({ name, objects, cursor: await ledgerVersion(t), live })
  }
  const unit = (seq: number, ts: number) => pairUnit(env.CELL, t, seq, seq, ts)
  await addUnit(t, unit(1, T0))
  const u2 = await addUnit(t, unit(2, T0 + DAY_MS))
  await stage('two units in one segment')
  const u3 = await addUnit(t, unit(3, T0 + DAY_MS + 60_000), { drain: true })
  const merged = fileFor(env.CELL, t, 'metric_samples', 'L1-day1', { minTs: T0 + DAY_MS, maxTs: T0 + DAY_MS + 60_999, level: 1, rows: 20, bytes: 100 })
  await putObjects([merged])
  expect(await ledger(t).replace({ remove: [u2.files[0]!.key, u3.files[0]!.key], add: [merged] })).toMatchObject({ status: 'ok' })
  await stage('a unit, then a compaction and its checkpoint')
  expect((await ledger(t).expire({ tables: ['metric_samples', 'metric_series'], beforeDay: dayOf(T0 + DAY_MS) })).removed).toHaveLength(2)
  await addUnit(t, unit(4, T0 + 2 * DAY_MS))
  await stage('retention and a unit in one segment')
  await loseLedgerStorage(t)
  await addUnit(t, unit(5, T0 + 2 * DAY_MS + 60_000))
  await stage('storage loss: a new incarnation, then a unit')
  const objects: Record<string, string> = {}
  for (const k of stages.at(-1)!.objects) objects[k] = await (await env.BUCKET.get(`${env.CELL}/${k}`))!.text()
  return { objects, stages }
}

const golden = (): SegmentGolden => {
  const g = goldenFile(GOLDEN) as SegmentGolden | undefined
  if (!g) throw new Error(`no golden file test/golden/${GOLDEN}; run the first test of this file to print it`)
  return g
}

/** Placeholder data objects of the recorded sizes for every file the golden log adds, so `verify` finds them. */
async function putGoldenData(g: SegmentGolden): Promise<void> {
  const files = new Map<string, FileEntry>()
  for (const body of Object.values(g.objects)) {
    for (const line of body.split('\n').slice(1)) {
      if (line) for (const f of (JSON.parse(line) as LedgerChange).added) files.set(f.key, f)
    }
  }
  await putObjects([...files.values()])
}

const install = async (g: SegmentGolden, cell: string, keys: string[]) => {
  for (const k of keys) await env.BUCKET.put(`${cell}/${k}`, g.objects[k]!)
}

describe('golden: real segment bytes from the ledger', () => {
  it('the ledger writes what this publisher reads at this format version (timestamps aside)', async () => {
    const got = await writeScenario()
    const g = goldenFile(GOLDEN) as SegmentGolden | undefined
    if (!g) {
      const doc: SegmentGolden = {
        format: 'read.ledger-segment',
        version: FORMATS['read.ledger-segment'],
        note: 'Written by ledger/src/ledger.ts through publisher/test/segments.test.ts (writeScenario). Bytes as the ledger wrote them; only "at" differs between runs.',
        tenant: TENANT,
        ...got,
      }
      console.log(`GOLDEN ${GOLDEN} ${JSON.stringify(doc)}`)
      throw new Error(`no golden file test/golden/${GOLDEN}. Review the JSON printed above and check it in under that name.`)
    }
    // The layout the reader was built for: base first, a checkpoint beside the segments, two incarnations.
    expect(Object.keys(got.objects)).toEqual(Object.keys(g.objects))
    for (const k of Object.keys(g.objects)) expect(scrub(got.objects[k]!), k).toBe(scrub(g.objects[k]!))
    expect(got.stages).toEqual(g.stages)
    expect(Object.keys(g.objects).filter((k) => k.includes('/ckpt-'))).toHaveLength(1)
  })

  it('publishes the checked-in segments stage by stage, and re-bases on the new incarnation', async () => {
    const g = golden()
    const { cell } = fresh()
    await putGoldenData(g)
    const p = publisher(cell)
    for (const s of g.stages) {
      await install(g, cell, s.objects)
      const r = await p.publish([g.tenant])
      expect(r.tenants[0], s.name).toMatchObject({ status: 'ok', cursors: { metric_samples: s.cursor, metric_series: s.cursor } })
      for (const table of TABLES) expect(await icebergLive(cell, table), `${s.name}: ${table}`).toEqual(s.live[table])
      await expectVerified(p)
    }
  })

  it('publishes all of it at once from the newest incarnation\'s base', async () => {
    const g = golden()
    const { cell } = fresh()
    await putGoldenData(g)
    await install(g, cell, Object.keys(g.objects))
    const p = publisher(cell)
    const last = g.stages.at(-1)!
    const r = await p.publish()
    expect(r.tenants).toEqual([{ tenant: g.tenant, status: 'ok', cursors: { metric_samples: last.cursor, metric_series: last.cursor }, rebase: expect.objectContaining({ source: 'base', format: null, objects: 1 }) }])
    for (const table of TABLES) expect(await icebergLive(cell, table)).toEqual(last.live[table])
    // Incarnation 2's base segment and one more: the older incarnation and the checkpoint are not read.
    expect(r.ops.get).toBeLessThanOrEqual(2 + 2 * 2) // two segments, then per table: current metadata (none yet) and the hint
    await expectVerified(p)
  })
})

describe('the first layout (one object per change)', () => {
  it('is still read, and a current ledger that takes the tenant over is followed into segments', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('trial')
    const old = env.LEDGER_ASBUILT.get(env.LEDGER_ASBUILT.idFromName(t))
    const u1 = pairUnit(cell, t, 1, 1)
    const u2 = pairUnit(cell, t, 2, 2, T0 + DAY_MS)
    for (const u of [u1, u2]) {
      await putObjects(u.files)
      expect(await old.addUnit(u)).toMatchObject({ status: 'ok' })
    }
    const merged = fileFor(cell, t, 'metric_samples', 'L1-trial', { level: 1, rows: 10, bytes: 100 })
    await putObjects([merged])
    expect(await old.replace({ remove: [u1.files[0]!.key], add: [merged] })).toMatchObject({ status: 'ok' })
    const logged = await listKeys(`${env.CELL}/ledger/tenant=${t}/1/`)
    expect(logged.some((k) => k.endsWith('/base.json'))).toBe(true)
    expect(logged.some((k) => k.includes('/seg-'))).toBe(false)
    await copyLog(t, env.CELL, cell)

    const p = publisher(cell)
    const oldPlan = await old.plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
    // A hole in the first layout stops the tenant before it, as one in segments does.
    const hole = `${cell}/${ledgerLogKey(t, 1, oldPlan.version - 1)}`
    await env.BUCKET.delete(hole)
    const stopped = await p.publish([t])
    expect(stopped.tenants[0]).toMatchObject({ status: 'gap', gapAt: oldPlan.version - 1, cursors: { metric_samples: { ledgerIncarnation: 1, version: oldPlan.version - 2 } } })
    expect(await icebergLive(cell, 'metric_samples')).not.toContain(merged.key)
    await copyLog(t, env.CELL, cell)
    const r = await p.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: { ledgerIncarnation: 1, version: oldPlan.version } } })
    expect(await icebergLive(cell, 'metric_samples')).toEqual(oldPlan.files.map((f) => f.key).sort())
    await expectVerified(p)

    // The current ledger, on empty storage, rebuilds from the first layout and starts
    // incarnation 2 in segments (base first); the publisher re-bases on it.
    const u3 = await addUnit(t, pairUnit(cell, t, 3, 3, T0 + DAY_MS))
    await mirror(t, cell)
    const segs = await segmentsOf(cell, t, 2)
    expect(segs[0]).toMatchObject({ first: oldPlan.version, last: oldPlan.version })
    const r2 = await p.publish([t])
    expect(r2.tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: await ledgerVersion(t) } })
    expect(r2.tables.metric_samples).toMatchObject({ added: 1, removed: 0 })
    expect(await icebergLive(cell, 'metric_samples')).toContain(u3.files[0]!.key)
    for (const table of TABLES) expect(await icebergLive(cell, table)).toEqual(await liveKeys(t, table))
    await expectVerified(p)
  })

  it('refuses an incarnation that holds both layouts', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('both')
    await addUnit(t, pairUnit(cell, t, 1, 1))
    await mirror(t, cell)
    await env.BUCKET.put(`${cell}/${ledgerBaseKey(t, 1)}`, JSON.stringify({ ledgerIncarnation: 1, version: 0, at: 0, kind: 'base', added: [], removed: [], watermarks: [] }))
    const p = publisher(cell)
    const r = await p.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'corrupt' })
    expect(r.tenants[0]!.detail).toMatch(/both segments and a base\.json/)
    expect(r.ops.put).toBe(0)
    expect(await p.pending()).toEqual([t])
  })
})

describe('reading segments', () => {
  it('advances over whole segments only, and finishes a cursor that sits inside one', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('mid')
    for (let i = 1; i <= 3; i++) await addUnit(t, pairUnit(cell, t, i, i, T0 + i * 1000))
    await ledger(t).drain() // [1, 4]: the registration and three units
    for (let i = 4; i <= 5; i++) await addUnit(t, pairUnit(cell, t, i, i, T0 + i * 1000))
    await mirror(t, cell) // [5, 6]: units 4 and 5
    const real = (await segmentsOf(cell, t, 1)).find((s) => s.first === 5)!
    expect((await segmentsOf(cell, t, 1)).map((s) => [s.first, s.last])).toEqual([[0, 0], [1, 4], [5, 6]])

    const p = publisher(cell)
    // At most two changes per publish, but never part of a segment: the first publish reads [1, 4].
    await p.configure({ maxChangesPerTenant: 2 })
    const r = await p.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'more', cursors: { metric_samples: { version: 4 }, metric_series: { version: 4 } } })
    await expectVerified(p)

    // A cursor inside [5, 6], as a release that advanced mid-segment would leave it: publish
    // through a segment [5, 5] holding the ledger's own line for version 5, then put [5, 6] back.
    const body = await (await env.BUCKET.get(real.key))!.text()
    const alone = `${cell}/${ledgerSegmentKey(t, 1, 5, 5)}`
    await env.BUCKET.delete(real.key)
    await env.BUCKET.put(alone, encodeLedgerSegment(t, 1, [{ version: 5, json: body.split('\n')[1]! }]))
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: { version: 5 } } })
    await env.BUCKET.delete(alone)
    await env.BUCKET.put(real.key, body)
    await expectVerified(p) // the table is right at 5, inside [5, 6]
    // Nothing starts after it yet: the rest of [5, 6] waits for the next segment (README, "Reading the log").
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: { version: 5 } } })
    const u = await addUnit(t, pairUnit(cell, t, 6, 6, T0 + 6000))
    await mirror(t, cell) // [7, 7] starts above 6: the reader looks for the segment holding 6
    // The reader's own promise: the changes after the cursor, contiguous, the holding segment's
    // lines at or below the cursor left out.
    const read = await readTenantLog(env.BUCKET, cell, t, { ledgerIncarnation: 1, version: 5 }, 2000, { reset: () => {}, files: () => {}, tombstones: () => {} })
    expect({ status: read.status, start: read.start, versions: read.changes.map((c) => c.version) }).toEqual({ status: 'ok', start: 5, versions: [6, 7] })
    const again = await p.publish([t])
    expect(again.tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: { version: 7 }, metric_series: { version: 7 } } })
    // Units 5 and 6; version 5 (unit 4), at the cursor, is not applied again.
    expect(again.tables.metric_samples).toMatchObject({ added: 2, removed: 0 })
    expect(await icebergLive(cell, 'metric_samples')).toContain(u.files[0]!.key)
    for (const table of TABLES) expect(await icebergLive(cell, table)).toEqual(await liveKeys(t, table))
    await expectVerified(p)
  })

  it('refuses overlapping segments (a retried drain that took other rows) and stops before them', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('overlap')
    const u1 = await addUnit(t, pairUnit(cell, t, 1, 1), { drain: true })
    await mirror(t, cell) // [0,0] base, [1,2]
    const p = publisher(cell)
    await p.publish([t])
    const u2 = pairUnit(cell, t, 2, 2)
    const u3 = pairUnit(cell, t, 3, 3)
    await putObjects([...u2.files, ...u3.files])
    const change = (v: number, u: typeof u2) => ({ ledgerIncarnation: 1, version: v, at: 0, kind: 'add_unit' as const, added: u.files.map((f, i) => ({ ...f, precedence: v * 4096 + i, precedenceLow: v * 4096 + i })), removed: [], watermark: { shard: u.shard, incarnation: u.incarnation, seq: u.seqHi }, unit: { seqLo: u.seqLo, seqHi: u.seqHi } })
    await putSegment(cell, t, 1, [change(3, u2)])
    await putSegment(cell, t, 1, [change(3, u2), change(4, u3)])
    const r = await p.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'corrupt', cursors: { metric_samples: { version: 2 } } })
    expect(r.tenants[0]!.detail).toMatch(/overlap/)
    expect(await icebergLive(cell, 'metric_samples')).toEqual([u1.files[0]!.key])
  })

  it('never reads a checkpoint, even an unreadable one', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('ckpt')
    for (let i = 1; i <= 4; i++) await addUnit(t, pairUnit(cell, t, i, i, T0 + i * 1000), { drain: true })
    await mirror(t, cell)
    const ckpts = (await listKeys(`${cell}/ledger/tenant=${t}/1/`)).filter((k) => k.includes('/ckpt-'))
    expect(ckpts.length).toBeGreaterThan(0)
    for (const k of ckpts) await env.BUCKET.put(k, 'not a checkpoint')
    const p = publisher(cell)
    const r = await p.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: await ledgerVersion(t) } })
    for (const table of TABLES) expect(await icebergLive(cell, table)).toEqual(await liveKeys(t, table))
    await expectVerified(p)
  })

  it('takes the table of a removed file from removedFiles, and refuses removedFiles that disagree with removed', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('rf')
    const u1 = await addUnit(t, pairUnit(cell, t, 1, 1), { drain: true })
    await mirror(t, cell)
    const p = publisher(cell)
    await p.publish([t])
    const v = (await ledgerVersion(t)).version + 1
    const samples = u1.files[0]!.key
    // A removal whose removedFiles names the other table: the key is live as a samples file.
    await putSegment(cell, t, 1, [{ ledgerIncarnation: 1, version: v, at: 0, kind: 'replace', added: [], removed: [samples], removedFiles: [{ key: samples, table: 'metric_series' }] }])
    const r = await p.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'inconsistent', cursors: { metric_samples: { version: v - 1 }, metric_series: { version: v - 1 } } })
    expect(r.tenants[0]!.detail).toMatch(new RegExp(`change ${v} removes`))
    // removedFiles that is not removed, key for key: not what the ledger writes.
    await env.BUCKET.delete((await segmentsOf(cell, t, 1)).at(-1)!.key)
    await putSegment(cell, t, 1, [{ ledgerIncarnation: 1, version: v, at: 0, kind: 'replace', added: [], removed: [samples], removedFiles: [] }])
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'corrupt', cursors: { metric_samples: { version: v - 1 } } })
    expect(await icebergLive(cell, 'metric_samples')).toEqual([samples])
  })
})
