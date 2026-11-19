/**
 * A re-base from ledger checkpoints, read streaming (contracts/LEDGER-LOG.md, "Checkpoints";
 * design/DECISIONS.md, the publisher's re-base; README, "Reading a checkpoint"):
 *
 *   - the real `Ledger` writing checkpoints in parts (format 2), and in one object (format 1),
 *     and the release before it (ledger N-1, format 1 only), all published by this code;
 *   - the same state published from parts, from one object, and from the base gives the same
 *     Iceberg bytes;
 *   - a part missing (deleted under the reader) or not what its manifest says stops the re-base
 *     explicitly and publishes nothing; an eviction mid-stream leaves nothing behind that is used;
 *   - parts are read in order, a few at a time, and with everything else in flight never more
 *     than six R2 operations;
 *   - a checkpoint's tombstones are released, so a checkpoint never leaks the files it skipped.
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { encodeLedgerCheckpointPart, ledgerSegmentKey, parseLedgerLogKey, type FileEntry, type LedgerChange, type Table } from '../../contracts/ledger'
import { FORMATS } from '../src/schema'
import { goldenFile } from './golden'
import {
  DAY_MS,
  T0,
  TABLES,
  addUnit,
  dayOf,
  dropCheckpoints,
  expectVerified,
  fileFor,
  fresh,
  icebergLive,
  ledger,
  ledgerVersion,
  listKeys,
  liveKeys,
  loseLedgerStorage,
  metadataVersions,
  mirror,
  pairUnit,
  publisher,
  putObjects,
  opsOf,
  publishSettled,
  type LedgerStub,
  type PublisherStub,
} from './helpers'

/**
 * The bounds under test, as literals: six is the platform's (AGENTS.md: outbound connections per
 * invocation, R2 reads included); four is the window of parts (src/log.ts PART_WINDOW). Not
 * imported, so a change of either constant is a change these tests see.
 */
const CONNECTIONS = 6
const WINDOW = 4

type Knobs = { checkpointEvery: number; checkpointByLogBytes: boolean; checkpointOneObjectBytes: number; checkpointPartBytes: number }
const knobs = (l: LedgerStub | DurableObjectStub, k: Partial<Knobs>) => runInDurableObject(l as LedgerStub, (i: unknown) => void Object.assign(i as object, k))

type Format = 'parts' | 'one' | 'none'

/**
 * On the real ledger: ten units (each its own segment), a compaction and an expiry (removed
 * files, so the state has tombstones), then a checkpoint of `format` (none: no checkpoint), then
 * two more units after it. Parts are small (`partBytes`), so a state of a few dozen files is
 * many parts. Returns the version the checkpoint is at.
 */
async function scenario(cell: string, t: string, format: Format, partBytes = 700): Promise<{ checkpointAt: number; removedBeforeCheckpoint: string[] }> {
  const l = ledger(t)
  await l.plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })
  await knobs(l, { checkpointEvery: 1e9, checkpointByLogBytes: false, checkpointOneObjectBytes: format === 'one' ? 1e12 : -1, checkpointPartBytes: partBytes })
  const units = []
  for (let i = 1; i <= 10; i++) units.push(await addUnit(t, pairUnit(cell, t, i, i, T0 + (i % 3) * DAY_MS + i * 1000), { drain: true }))
  // A compaction of two day-1 samples files, and retention of day 0: removals, so tombstones.
  const merged = fileFor(cell, t, 'metric_samples', 'L1-day1', { minTs: T0 + DAY_MS, level: 1, rows: 20, bytes: 100 })
  await putObjects([merged])
  const compacted = [units[0]!.files[0]!.key, units[3]!.files[0]!.key]
  expect(await l.replace({ remove: compacted, add: [merged] })).toMatchObject({ status: 'ok' })
  const expired = await l.expire({ tables: ['metric_samples', 'metric_series'], beforeDay: dayOf(T0 + DAY_MS) })
  expect(expired.removed.length).toBeGreaterThan(0)
  await l.drain()
  if (format !== 'none') await knobs(l, { checkpointEvery: 1 })
  await addUnit(t, pairUnit(cell, t, 11, 11, T0 + DAY_MS + 11_000), { drain: true })
  const checkpointAt = (await ledgerVersion(t)).version
  await knobs(l, { checkpointEvery: 1e9 })
  for (let i = 12; i <= 13; i++) await addUnit(t, pairUnit(cell, t, i, i, T0 + 2 * DAY_MS + i * 1000), { drain: true })
  await mirror(t, cell)
  return { checkpointAt, removedBeforeCheckpoint: [...compacted, ...expired.removed] }
}

/** The checkpoint objects of a tenant's incarnation under a cell: manifests, and parts in part order. */
async function checkpointsOf(cell: string, t: string, inc: number) {
  const keys = await listKeys(`${cell}/ledger/tenant=${t}/${inc}/ckpt-`)
  const manifests = keys.filter((k) => parseLedgerLogKey(k)?.type === 'checkpoint')
  const parts = keys
    .map((k) => ({ k, p: parseLedgerLogKey(k) }))
    .filter((x) => x.p?.type === 'checkpoint_part')
    .sort((a, b) => (a.p as { part: number }).part - (b.p as { part: number }).part)
    .map((x) => x.k)
  return { manifests, parts }
}

const nothingPublished = async (cell: string, p: PublisherStub, t: string) => {
  for (const table of TABLES) expect(await metadataVersions(cell, table), table).toEqual([])
  expect(await p.cursors('metric_samples')).toEqual({})
  expect(await p.pending()).toEqual([t])
  expect(await p.scratch()).toEqual({ stage: 0, liveNext: 0 })
}

/** The tenant's files in the published tables are exactly its ledger's live files. */
const expectLedger = async (cell: string, t: string) => {
  for (const table of TABLES) expect((await icebergLive(cell, table)).filter((k) => k.includes(`/tenant=${t}/`)), table).toEqual(await liveKeys(t, table))
}

/** Every object under the cell's Iceberg prefix, with its bytes (hex). */
async function icebergObjects(cell: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const k of await listKeys(`${cell}/iceberg/`)) {
    const b = new Uint8Array(await (await env.BUCKET.get(k))!.arrayBuffer())
    out[k] = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  }
  return out
}

describe('a ledger that writes its checkpoints in parts', () => {
  it('is re-based from the parts: in order, a window at a time, with every R2 operation within six, and verified', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('parts')
    const { checkpointAt } = await scenario(cell, t, 'parts')
    const { manifests, parts } = await checkpointsOf(cell, t, 1)
    expect(manifests).toHaveLength(1)
    expect(parts.length).toBeGreaterThan(WINDOW + 2)
    const p = publisher(cell)
    await p.r2()
    const r = await p.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: await ledgerVersion(t) } })
    expect(r.tenants[0]!.rebase).toMatchObject({ source: 'checkpoint', format: 2, version: checkpointAt, objects: 1 + parts.length, passedOver: [] })
    expect(r.tenants[0]!.rebase!.tombstones).toBeGreaterThan(0)
    // Read ahead, but never more than the window.
    expect(r.tenants[0]!.rebase!.window).toBeGreaterThan(1)
    expect(r.tenants[0]!.rebase!.window).toBeLessThanOrEqual(WINDOW)
    const seen = await p.r2()
    expect(seen.max).toBeLessThanOrEqual(CONNECTIONS)
    // Requested in part order, each once; no segment at or before the checkpoint is read.
    expect(seen.gets.filter((k) => k.includes('/ckpt-') && !k.endsWith(`${String(checkpointAt).padStart(12, '0')}.jsonl`))).toEqual(parts)
    const segs = seen.gets.filter((k) => k.includes('/seg-')).map((k) => parseLedgerLogKey(k) as { firstVersion: number })
    expect(segs.length).toBe(2)
    for (const s of segs) expect(s.firstVersion).toBeGreaterThan(checkpointAt)
    await expectLedger(cell, t)
    await expectVerified(p)
    expect(await p.scratch()).toEqual({ stage: 0, liveNext: 0 })
    // Then from the cursor, as ever: nothing new, nothing written.
    expect((await p.publish([t])).ops.put).toBe(0)
  })

  it('the same state from parts, from one object and from the base: byte-identical Iceberg metadata and manifests', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('same')
    // The ledger writes the same state twice, once per checkpoint format (wiped in between).
    const one = await scenario(cell, t, 'one')
    const logOne = await copyOut(cell, t)
    await wipe(cell, t)
    const parts = await scenario(cell, t, 'parts')
    expect(parts.checkpointAt).toBe(one.checkpointAt)
    const logParts = await copyOut(cell, t)
    const live = { metric_samples: await liveKeys(t, 'metric_samples'), metric_series: await liveKeys(t, 'metric_series') }

    const runs: Record<string, { objects: Record<string, string>; ms: number; rebase: unknown }> = {}
    const variants: [string, Record<string, ArrayBuffer>, (k: string) => boolean][] = [
      ['parts', logParts, () => true],
      ['one', logOne, () => true],
      ['base', logParts, (k) => !k.includes('/ckpt-')],
    ]
    for (const [name, log, keep] of variants) {
      for (const k of await listKeys(`${cell}/`)) if (!k.includes('/data/')) await env.BUCKET.delete(k)
      for (const [k, body] of Object.entries(log)) if (keep(k)) await env.BUCKET.put(k, body)
      const p = publisher(`${cell}~${name}`) // the same cell, a publisher with storage of its own
      await p.determinism(20261119, Date.UTC(2026, 10, 19))
      const r = await p.publish([t])
      expect(r.tenants[0], name).toMatchObject({ status: 'ok' })
      for (const table of TABLES) expect(await icebergLive(cell, table), `${name} ${table}`).toEqual(live[table as Table])
      runs[name] = { objects: await icebergObjects(cell), ms: r.ms, rebase: r.tenants[0]!.rebase }
    }
    expect(runs.parts!.rebase).toMatchObject({ source: 'checkpoint', format: 2 })
    expect(runs.one!.rebase).toMatchObject({ source: 'checkpoint', format: 1, objects: 1 })
    expect(runs.base!.rebase).toMatchObject({ source: 'base', format: null, objects: 1 })
    const keys = Object.keys(runs.parts!.objects).sort()
    expect(keys.length).toBe(2 * 5) // per table: a manifest, the manifest list, cursors, metadata, hint
    for (const name of ['one', 'base']) {
      expect(Object.keys(runs[name]!.objects).sort(), name).toEqual(keys)
      for (const k of keys) expect(runs[name]!.objects[k], `${name}: ${k}`).toBe(runs.parts!.objects[k])
    }
    console.log(`COUNTERFACTUAL small ${JSON.stringify(Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v.ms])))}`)
  })

  it('across a new incarnation: a published tenant re-bases on the new incarnation\'s checkpoint in parts, removing and adding by difference', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('inc2')
    const units = []
    for (let i = 1; i <= 4; i++) units.push(await addUnit(t, pairUnit(cell, t, i, i, T0 + i * 1000), { drain: true }))
    await mirror(t, cell)
    await dropCheckpoints(cell, t)
    const p = publisher(cell)
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok' })
    await loseLedgerStorage(t)
    // Incarnation 2: a compaction of two published files, more units, then a checkpoint in parts.
    const l = ledger(t)
    await l.plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })
    await knobs(l, { checkpointEvery: 1e9, checkpointByLogBytes: false, checkpointOneObjectBytes: -1, checkpointPartBytes: 600 })
    const merged = fileFor(cell, t, 'metric_samples', 'L1-inc2', { level: 1, rows: 20, bytes: 100 })
    await putObjects([merged])
    expect(await l.replace({ remove: [units[0]!.files[0]!.key, units[1]!.files[0]!.key], add: [merged] })).toMatchObject({ status: 'ok' })
    for (let i = 5; i <= 8; i++) await addUnit(t, pairUnit(cell, t, i, i, T0 + i * 1000), { drain: true })
    await knobs(l, { checkpointEvery: 1 })
    await addUnit(t, pairUnit(cell, t, 9, 9, T0 + 9000), { drain: true })
    await knobs(l, { checkpointEvery: 1e9 })
    await addUnit(t, pairUnit(cell, t, 10, 10, T0 + 10_000), { drain: true })
    await mirror(t, cell)
    expect((await checkpointsOf(cell, t, 2)).parts.length).toBeGreaterThan(1)
    const r = await p.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: await ledgerVersion(t) }, rebase: { source: 'checkpoint', format: 2 } })
    expect(r.tables.metric_samples).toMatchObject({ added: 7, removed: 2 }) // the merged file and units 5-10; the two compacted away
    expect(r.tables.metric_series).toMatchObject({ added: 6, removed: 0 })
    await expectLedger(cell, t)
    await expectVerified(p)
  })

  it('a staged re-base across many manifests, with merges: SQLite rebuilt from R2 alone is the same, row for row', async () => {
    const { cell, tenant } = fresh()
    const [a, b] = [tenant('a'), tenant('b')]
    await scenario(cell, a, 'parts')
    await scenario(cell, b, 'one')
    const p = publisher(cell)
    // Tiny manifests and a short list: adds span several manifests, then merges fold them.
    await p.configure({ manifestTargetEntries: 4, maxManifests: 3 })
    const r = await p.publish()
    expect(r.tenants.map((x) => x.status)).toEqual(['ok', 'ok'])
    expect(r.tables.metric_samples.manifestsWritten).toBeGreaterThan(3)
    for (const x of [a, b]) await expectLedger(cell, x)
    await expectVerified(p)
    // One more unit each: the commit rewrites nothing, merges the small manifests.
    for (const [x, seq] of [[a, 14], [b, 14]] as const) {
      await addUnit(x, pairUnit(cell, x, seq, seq, T0 + 3 * DAY_MS))
      await mirror(x, cell)
    }
    // Larger manifests from here on: every existing one is now small, and they are merged.
    await p.configure({ manifestTargetEntries: 20 })
    const r2 = await p.publish()
    expect(r2.tables.metric_samples.manifestsMerged).toBeGreaterThan(1)
    await expectVerified(p)
    const rows = () => runInDurableObject(p, (_i, s) => s.storage.sql.exec(`SELECT tbl, key, tenant, day, rows, bytes, snapshot_id, seq, file_seq, stats, manifest FROM live ORDER BY tbl, key`).toArray())
    const before = await rows()
    await runInDurableObject(p, async (_i, s) => {
      await s.storage.deleteAll()
    })
    await evictDurableObject(p)
    expect(opsOf(await publishSettled(p)).put).toBe(0) // resync from R2, a table per publish; nothing new to commit
    expect(await rows()).toEqual(before)
    expect(await p.scratch()).toEqual({ stage: 0, liveNext: 0 })
  })
})

describe('a part that is not there, or not what its manifest says, stops the re-base: nothing of it is published', () => {
  it('a part deleted while the checkpoint is read: incomplete, retried, and published once readable', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('gone')
    const { checkpointAt } = await scenario(cell, t, 'parts')
    const { manifests, parts } = await checkpointsOf(cell, t, 1)
    const body = await (await env.BUCKET.get(parts[2]!))!.arrayBuffer()
    const p = publisher(cell)
    // As the ledger does once a newer checkpoint is complete: the part goes after the manifest was read.
    await p.deleteOnGet(manifests[0]!.slice(manifests[0]!.lastIndexOf('/')), parts[2]!)
    const r = await p.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'incomplete', cursors: {} })
    expect(r.tenants[0]!.detail).toMatch(new RegExp(`checkpoint ${checkpointAt} of incarnation 1 names part 2 .*not in R2`))
    expect(r.tenants[0]!.rebase).toBeUndefined()
    expect(r.ops.put).toBe(0)
    await nothingPublished(cell, p, t)
    expect((await p.schedule()).due.publish).toBeDefined()
    // Still missing: the same, again.
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'incomplete' })
    await nothingPublished(cell, p, t)
    await env.BUCKET.put(parts[2]!, body)
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok', rebase: { source: 'checkpoint', format: 2 } })
    await expectLedger(cell, t)
    await expectVerified(p)
    expect(await p.pending()).toEqual([])
  })

  /** Rewrite part `i` of the tenant's checkpoint; the publish must stop with `corrupt` naming `reason`, publish nothing, and publish once restored. */
  async function tampered(name: string, change: (parts: string[], bodies: string[]) => Promise<void>, reason: RegExp, partBytes = 700) {
    const { cell, tenant } = fresh()
    const t = tenant(name)
    await scenario(cell, t, 'parts', partBytes)
    const { parts } = await checkpointsOf(cell, t, 1)
    const bodies = await Promise.all(parts.map(async (k) => (await env.BUCKET.get(k))!.text()))
    await change(parts, bodies)
    const p = publisher(cell)
    const r = await p.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'corrupt', cursors: {} })
    expect(r.tenants[0]!.detail).toMatch(reason)
    await nothingPublished(cell, p, t)
    for (const [i, k] of parts.entries()) await env.BUCKET.put(k, bodies[i]!)
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok' })
    await expectLedger(cell, t)
  }

  const records = (body: string) => body.split('\n').slice(1, -1)
  const header = (body: string) => JSON.parse(body.split('\n')[0]!) as { tenant: string; ledgerIncarnation: number; version: number; attempt: string; part: number }
  const rewrite = (body: string, recs: string[], h = header(body)) => encodeLedgerCheckpointPart(h.tenant, h.ledgerIncarnation, h.version, h.attempt, h.part, recs)

  it('a record changed, its size with it (rows 10 → 100): the parts do not add up to the bytes the manifest names', async () => {
    await tampered('size', async (parts, bodies) => {
      const recs = records(bodies[1]!)
      const i = recs.findIndex((r) => r.includes('"rows":10,'))
      expect(i).toBeGreaterThanOrEqual(0)
      recs[i] = recs[i]!.replace('"rows":10,', '"rows":100,')
      await env.BUCKET.put(parts[1]!, rewrite(bodies[1]!, recs))
    }, /its parts are \d+ bytes, its manifest says \d+/)
  })

  it('a record dropped, the bytes made up with spaces: the parts do not hold the files the manifest names', async () => {
    await tampered('count', async (parts, bodies) => {
      // A part of files with at least two records.
      const i = bodies.findIndex((b) => records(b).length >= 2 && records(b).every((r) => r.startsWith('{"file"')))
      expect(i).toBeGreaterThanOrEqual(0)
      const recs = records(bodies[i]!)
      recs.shift()
      // Same total size: what the dropped line took becomes whitespace inside another record.
      const short = bodies[i]!.length - rewrite(bodies[i]!, recs).length
      recs[0] = recs[0]!.replace('{', `{${' '.repeat(short)}`)
      const body = rewrite(bodies[i]!, recs)
      expect(body.length).toBe(bodies[i]!.length)
      await env.BUCKET.put(parts[i]!, body)
    }, /its parts hold \d+ files and \d+ tombstones, its manifest says \d+ and \d+/, 2_000)
  })

  it('two parts swapped: each says it is the other', async () => {
    await tampered('swap', async (parts, bodies) => {
      await env.BUCKET.put(parts[1]!, bodies[2]!)
      await env.BUCKET.put(parts[2]!, bodies[1]!)
    }, /part 1: part header says .*\/2, expected .*\/1/)
  })

  it('a part of another attempt in place of this one\'s', async () => {
    await tampered('attempt', async (parts, bodies) => {
      const h = header(bodies[1]!)
      await env.BUCKET.put(parts[1]!, encodeLedgerCheckpointPart(h.tenant, h.ledgerIncarnation, h.version, 'deadbeef', h.part, records(bodies[1]!)))
    }, /part 1: part header says .*deadbeef/)
  })

  it('records out of key order across parts (a reader that applies parts as they arrive would not see it otherwise)', async () => {
    await tampered('order', async (parts, bodies) => {
      // Parts 1 and 2 exchange their records, each keeping its own header: every check but the order passes.
      const [r1, r2] = [records(bodies[1]!), records(bodies[2]!)]
      await env.BUCKET.put(parts[1]!, rewrite(bodies[1]!, r2))
      await env.BUCKET.put(parts[2]!, rewrite(bodies[2]!, r1))
    }, /files out of key order/)
  })

  it('a manifest that is not a checkpoint: corrupt, explicitly, until the ledger writes a readable one', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('junk')
    await scenario(cell, t, 'parts')
    const { manifests } = await checkpointsOf(cell, t, 1)
    const body = await (await env.BUCKET.get(manifests[0]!))!.text()
    await env.BUCKET.put(manifests[0]!, 'not a checkpoint')
    const p = publisher(cell)
    const r = await p.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'corrupt', cursors: {} })
    await nothingPublished(cell, p, t)
    await env.BUCKET.put(manifests[0]!, body)
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok' })
    await expectLedger(cell, t)
  })

  it('a checkpoint of a format this code does not read is passed over for the base (a checkpoint is only a shortcut)', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('newer')
    await scenario(cell, t, 'parts')
    const { manifests } = await checkpointsOf(cell, t, 1)
    const [h, line] = (await (await env.BUCKET.get(manifests[0]!))!.text()).split('\n') as [string, string]
    await env.BUCKET.put(manifests[0]!, `${JSON.stringify({ ...(JSON.parse(h) as object), v: 3 })}\n${line}\n`)
    const p = publisher(cell)
    const r = await p.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'ok', rebase: { source: 'base', format: null } })
    expect(r.tenants[0]!.rebase!.passedOver).toEqual([expect.stringMatching(/version 3/)])
    await expectLedger(cell, t)
    await expectVerified(p)
  })
})

describe('eviction and concurrency', () => {
  it('an eviction mid-stream: what was staged is never used, and the next publish reads it all again', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('evict')
    await scenario(cell, t, 'parts')
    const { parts } = await checkpointsOf(cell, t, 1)
    expect(parts.length).toBeGreaterThan(WINDOW + 2)
    const p = publisher(cell)
    const reached = p.pauseOnGet(parts[WINDOW + 1]!.slice(parts[0]!.lastIndexOf('/', parts[0]!.lastIndexOf('/') - 1)))
    const done = p.publish([t]).then(
      () => 'finished',
      (e: unknown) => `failed: ${String(e)}`,
    )
    await reached
    // The runtime resets the object there (as an eviction or a crash does: no `finally` runs),
    // and the next call constructs it afresh on its storage.
    // (evictDurableObject refuses an object with a request in flight; ctx.abort() is the same reset.)
    expect(await p.abortNow().then(() => 'returned', () => 'reset')).toBe('reset')
    expect(await done).toMatch(/^failed/)
    const q = publisher(cell) // a stub to the object as constructed afresh (the old one is broken by the reset)
    // Some parts reached SQLite before the eviction; none of it was committed.
    expect((await q.scratch()).stage).toBeGreaterThan(0)
    for (const table of TABLES) expect(await metadataVersions(cell, table)).toEqual([])
    const r = await q.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'ok', rebase: { source: 'checkpoint', format: 2, objects: 1 + parts.length } })
    expect(await q.scratch()).toEqual({ stage: 0, liveNext: 0 })
    for (const table of TABLES) expect(await metadataVersions(cell, table)).toEqual([1])
    await expectLedger(cell, t)
    await expectVerified(q)
  })

  it('a read that fails at a part, then an eviction: nothing published, the next publish reads it all again', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('crash')
    await scenario(cell, t, 'parts')
    const { parts } = await checkpointsOf(cell, t, 1)
    const p = publisher(cell)
    await p.failOnGet(parts[WINDOW + 1]!.slice(parts[0]!.lastIndexOf('/', parts[0]!.lastIndexOf('/') - 1)))
    expect((await p.tryPublish([t])).error).toMatch(/injected: R2 failed/)
    await nothingPublished(cell, p, t)
    await evictDurableObject(p)
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok', rebase: { source: 'checkpoint', format: 2 } })
    await expectLedger(cell, t)
    await expectVerified(p)
  })

  it('six tenants re-basing at once, each from parts: never more than six R2 operations in flight, and one tenant\'s parts at a time', async () => {
    const { cell, tenant } = fresh()
    const ts = Array.from({ length: 6 }, (_, i) => tenant(`c${i}`))
    for (const t of ts) await scenario(cell, t, 'parts', 500)
    const p = publisher(cell)
    await p.r2()
    const r = await p.publish(ts)
    expect(r.tenants.map((x) => x.status)).toEqual(ts.map(() => 'ok'))
    const seen = await p.r2()
    expect(seen.max).toBeGreaterThan(2) // they do overlap
    expect(seen.max).toBeLessThanOrEqual(CONNECTIONS)
    const all: string[] = []
    for (const t of ts) {
      const { parts } = await checkpointsOf(cell, t, 1)
      expect(seen.gets.filter((k) => k.includes(`tenant=${t}/`) && parts.includes(k)), t).toEqual(parts)
      all.push(...parts)
    }
    // Re-bases take turns: the part reads of each tenant form one run, never interleaved with
    // another's, so the parts held at once are one window whatever the number of tenants.
    const order = seen.gets.filter((k) => all.includes(k)).map((k) => /tenant=([^/]+)\//.exec(k)![1]!)
    const runs = order.filter((t, i) => i === 0 || order[i - 1] !== t)
    expect(runs).toHaveLength(ts.length)
    for (const t of ts) await expectLedger(cell, t)
    await expectVerified(p)
  })
})

describe('the six connections on the ordinary path', () => {
  it('six tenants with a backlog of segments, read from their cursors at once: never more than six R2 operations in flight', async () => {
    const { cell, tenant } = fresh()
    const ts = Array.from({ length: 6 }, (_, i) => tenant(`b${i}`))
    for (const t of ts) {
      await addUnit(t, pairUnit(cell, t, 1, 1), { drain: true })
      await mirror(t, cell)
    }
    const p = publisher(cell)
    expect((await p.publish(ts)).tenants.map((x) => x.status)).toEqual(ts.map(() => 'ok'))
    // Eight more units each, a segment each: a reader fetches up to six segments at once, for
    // six tenants at once. Without the shared slots that is 36 GETs in flight.
    for (const t of ts) {
      for (let i = 2; i <= 9; i++) await addUnit(t, pairUnit(cell, t, i, i, T0 + i * 1000), { drain: true })
      await mirror(t, cell)
    }
    await p.r2()
    const r = await p.publish(ts)
    expect(r.tenants.map((x) => x.status)).toEqual(ts.map(() => 'ok'))
    const seen = await p.r2()
    expect(seen.gets.filter((k) => k.includes('/seg-')).length).toBe(6 * 8)
    expect(seen.max).toBeGreaterThan(2)
    expect(seen.max).toBeLessThanOrEqual(CONNECTIONS)
    for (const t of ts) await expectLedger(cell, t)
  })
})

describe('tombstones in a checkpoint', () => {
  it('files added and removed before the checkpoint, never published, are released once no snapshot can reference them', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('tomb')
    const { removedBeforeCheckpoint } = await scenario(cell, t, 'parts')
    const p = publisher(cell)
    await p.configure({ deleteGraceMs: 60_000 })
    expect((await p.publish([t])).tenants[0]).toMatchObject({ status: 'ok', rebase: { source: 'checkpoint' } })
    expect(await p.safeToDelete(t)).toEqual([])
    await p.advanceClock(60_001)
    const released = await p.safeToDelete(t)
    expect(released).toEqual([...removedBeforeCheckpoint].sort())
    for (const k of released) for (const table of TABLES) expect(await icebergLive(cell, table)).not.toContain(k)
  })
})

describe('ledger N-1 and N+1 (contracts/COMPATIBILITY.md)', () => {
  it('the release before checkpoints in parts (format 1 only) is read: its checkpoint, then its new incarnation after a storage loss', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('nminus1')
    const old = env.LEDGER_BEFORE.get(env.LEDGER_BEFORE.idFromName(t))
    await old.plan({ table: 'metric_samples', minTs: 0, maxTs: 0 })
    await knobs(old, { checkpointEvery: 3, checkpointByLogBytes: false })
    const units = []
    for (let i = 1; i <= 7; i++) {
      const u = pairUnit(cell, t, i, i, T0 + i * 1000)
      await putObjects(u.files)
      expect(await old.addUnit(u)).toMatchObject({ status: 'ok' })
      await old.drain()
      units.push(u)
    }
    await knobs(old, { checkpointEvery: 1e9 })
    const u8 = pairUnit(cell, t, 8, 8, T0 + 8000)
    await putObjects(u8.files)
    await old.addUnit(u8)
    await old.drain()
    const prefix = `${env.CELL}/ledger/tenant=${t}/`
    const copy = async () => {
      for (const k of await listKeys(prefix)) await env.BUCKET.put(`${cell}/${k.slice(env.CELL.length + 1)}`, await (await env.BUCKET.get(k))!.arrayBuffer())
    }
    await copy()
    expect((await checkpointsOf(cell, t, 1)).manifests).toHaveLength(1)
    expect((await checkpointsOf(cell, t, 1)).parts).toHaveLength(0)
    const live = async (table: Table) => (await old.plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files.map((f) => f.key).sort()
    const p = publisher(cell)
    const r = await p.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'ok', rebase: { source: 'checkpoint', format: 1 } })
    for (const table of TABLES) expect(await icebergLive(cell, table)).toEqual(await live(table))
    await expectVerified(p)
    // Its storage lost: it rebuilds (from its checkpoint) and starts incarnation 2 with a base segment.
    await runInDurableObject(old, async (_i, s) => {
      await s.storage.deleteAll()
    })
    await evictDurableObject(old)
    const u9 = pairUnit(cell, t, 9, 9, T0 + 9000)
    await putObjects(u9.files)
    // Refused (retryably) while it rebuilds.
    let added = await old.addUnit(u9)
    for (let i = 0; i < 20 && added.status !== 'ok'; i++) added = await old.addUnit(u9)
    expect(added).toMatchObject({ status: 'ok' })
    await old.drain()
    await copy()
    const r2 = await p.publish([t])
    expect(r2.tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: { ledgerIncarnation: 2 } }, rebase: { source: 'base' } })
    for (const table of TABLES) expect(await icebergLive(cell, table)).toEqual(await live(table))
    await expectVerified(p)
  })

  it('a segment written after the base in the base\'s own segment is applied once (a base segment that is not alone)', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('withbase')
    const u1 = pairUnit(cell, t, 1, 1)
    await putObjects(u1.files)
    const files = u1.files.map((f, i) => ({ ...f, precedence: i, precedenceLow: i }))
    const key = `${cell}/${ledgerSegmentKey(t, 1, 0, 1)}`
    const header = { v: 1, kind: 'viz.ledger.segment', tenant: t, ledgerIncarnation: 1, firstVersion: 0, lastVersion: 1, changes: 2 }
    const base = { ledgerIncarnation: 1, version: 0, at: 0, kind: 'base', added: [files[0]], removed: [], watermarks: [] }
    const change = { ledgerIncarnation: 1, version: 1, at: 0, kind: 'add_unit', added: [files[1]], removed: [], watermark: { shard: u1.shard, incarnation: u1.incarnation, seq: 1 } }
    await env.BUCKET.put(key, `${JSON.stringify(header)}\n${JSON.stringify(base)}\n${JSON.stringify(change)}\n`)
    const p = publisher(cell)
    const r = await p.publish([t])
    expect(r.tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: { ledgerIncarnation: 1, version: 1 } }, rebase: { source: 'base', version: 0, files: 1 } })
    expect(await icebergLive(cell, 'metric_samples')).toEqual([u1.files[0]!.key])
    expect(await icebergLive(cell, 'metric_series')).toEqual([u1.files[1]!.key])
  })
})

// ───────────────────────────── golden: a checkpoint in parts as the ledger writes it ─────────────────────────────

const GOLDEN = `formats/read.ledger-checkpoint.v${FORMATS['read.ledger-checkpoint']}.json`
/** The golden's tenant. Only the first test below drives a ledger of that name. */
const FIX = 'ckptfix'

interface CheckpointGolden {
  format: string
  version: number
  note: string
  tenant: string
  checkpointAt: number
  /** Every log object, as the ledger wrote it, by key relative to the cell. */
  objects: Record<string, string>
  cursor: { ledgerIncarnation: number; version: number }
  live: Record<Table, string[]>
}

/** What differs from run to run: the ledger's clock and the checkpoint's attempt name. */
const scrubbed = (s: string, attempt: string) => s.replace(/"at":\d+/g, '"at":0').replaceAll(attempt, 'ATTEMPT')
const attemptOf = (keys: string[]) => /ckpt-\d{12}-([0-9a-f]{8})\//.exec(keys.find((k) => k.includes('/ckpt-') && k.endsWith('.jsonl') && /-[0-9a-f]{8}\//.test(k)) ?? '')?.[1] ?? 'none'

describe('golden: a checkpoint in parts, real bytes from the ledger', () => {
  it('the ledger writes what this publisher reads at this format version (timestamps and attempt aside)', async () => {
    const { cell } = fresh()
    const { checkpointAt } = await scenario(cell, FIX, 'parts')
    const objects: Record<string, string> = {}
    for (const k of await listKeys(`${cell}/ledger/tenant=${FIX}/`)) objects[k.slice(cell.length + 1)] = await (await env.BUCKET.get(k))!.text()
    const live = { metric_samples: await liveKeys(FIX, 'metric_samples'), metric_series: await liveKeys(FIX, 'metric_series') }
    const got = { checkpointAt, objects, cursor: await ledgerVersion(FIX), live }
    const g = goldenFile(GOLDEN) as CheckpointGolden | undefined
    if (!g) {
      const doc: CheckpointGolden = {
        format: 'read.ledger-checkpoint',
        version: FORMATS['read.ledger-checkpoint'],
        note: 'Written by ledger/src/ledger.ts through publisher/test/checkpoints.test.ts (scenario, format 2, parts of 700 characters). Bytes as the ledger wrote them; only "at" and the attempt name differ between runs.',
        tenant: FIX,
        ...got,
      }
      console.log(`GOLDEN ${GOLDEN} ${JSON.stringify(doc)}`)
      throw new Error(`no golden file test/golden/${GOLDEN}. Review the JSON printed above and check it in under that name.`)
    }
    const [a, b] = [attemptOf(Object.keys(objects)), attemptOf(Object.keys(g.objects))]
    expect(Object.keys(objects).map((k) => k.replaceAll(a, 'ATTEMPT')).sort()).toEqual(Object.keys(g.objects).map((k) => k.replaceAll(b, 'ATTEMPT')).sort())
    for (const k of Object.keys(g.objects)) expect(scrubbed(objects[k.replaceAll(b, a)]!, a), k).toBe(scrubbed(g.objects[k]!, b))
    expect({ checkpointAt: got.checkpointAt, cursor: got.cursor, live: got.live }).toEqual({ checkpointAt: g.checkpointAt, cursor: g.cursor, live: g.live })
    expect(Object.keys(g.objects).filter((k) => parseLedgerLogKey(k)?.type === 'checkpoint_part').length).toBeGreaterThan(4)
  })

  it('publishes the checked-in log from its checkpoint in parts', async () => {
    const g = goldenFile(GOLDEN) as CheckpointGolden
    const { cell } = fresh()
    const files = new Map<string, FileEntry>()
    for (const [k, body] of Object.entries(g.objects)) {
      await env.BUCKET.put(`${cell}/${k}`, body)
      for (const line of body.split('\n').slice(1)) {
        if (!line) continue
        const x = JSON.parse(line) as Partial<LedgerChange> & { file?: FileEntry }
        if (x.file) files.set(x.file.key, x.file)
        for (const f of x.added ?? []) files.set(f.key, f)
      }
    }
    await putObjects([...files.values()])
    const p = publisher(cell)
    const r = await p.publish([g.tenant])
    expect(r.tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: g.cursor, metric_series: g.cursor }, rebase: { source: 'checkpoint', format: 2, version: g.checkpointAt } })
    for (const table of TABLES) expect(await icebergLive(cell, table), table).toEqual(g.live[table])
    await expectVerified(p)
  })

  it('the segment golden\'s format-1 checkpoint is re-based from too (its incarnation 1, from scratch)', async () => {
    const g = goldenFile(`formats/read.ledger-segment.v${FORMATS['read.ledger-segment']}.json`) as { tenant: string; objects: Record<string, string>; stages: { objects: string[]; cursor: { ledgerIncarnation: number; version: number }; live: Record<Table, string[]> }[] }
    const stage = g.stages[1]! // a unit, then a compaction and its checkpoint
    expect(stage.objects.some((k) => parseLedgerLogKey(k)?.type === 'checkpoint')).toBe(true)
    const { cell } = fresh()
    const files = new Map<string, FileEntry>()
    for (const k of stage.objects) {
      await env.BUCKET.put(`${cell}/${k}`, g.objects[k]!)
      for (const line of g.objects[k]!.split('\n').slice(1)) if (line) for (const f of (JSON.parse(line) as LedgerChange).added) files.set(f.key, f)
    }
    await putObjects([...files.values()])
    const p = publisher(cell)
    const r = await p.publish([g.tenant])
    expect(r.tenants[0]).toMatchObject({ status: 'ok', cursors: { metric_samples: stage.cursor }, rebase: { source: 'checkpoint', format: 1 } })
    for (const table of TABLES) expect(await icebergLive(cell, table), table).toEqual(stage.live[table])
    await expectVerified(p)
  })
})

// ───────────────────────────── helpers ─────────────────────────────

/** The tenant's log under the cell, byte for byte. */
async function copyOut(cell: string, t: string): Promise<Record<string, ArrayBuffer>> {
  const out: Record<string, ArrayBuffer> = {}
  for (const k of await listKeys(`${cell}/ledger/tenant=${t}/`)) out[k] = await (await env.BUCKET.get(k))!.arrayBuffer()
  return out
}

/** Forget a tenant everywhere: its ledger's storage, its log (both cells) and its data objects, so the same scenario can run again. */
async function wipe(cell: string, t: string): Promise<void> {
  const l = ledger(t)
  await runInDurableObject(l, async (_i, s) => {
    await s.storage.deleteAll()
  })
  await evictDurableObject(l)
  const keys = [...(await listKeys(`${env.CELL}/`)), ...(await listKeys(`${cell}/`))].filter((k) => k.includes(`tenant=${t}/`))
  for (let i = 0; i < keys.length; i += 500) await env.BUCKET.delete(keys.slice(i, i + 500))
}
