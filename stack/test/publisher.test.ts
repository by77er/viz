import { createExecutionContext, runDurableObjectAlarm, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readAvro } from '../../publisher/src/avro'
import type { ManifestEntryRecord, ManifestListRecord, TableMetadata } from '../../publisher/src/iceberg'
import { NUDGE_TIMEOUT_MS } from '../../publisher/src/nudge'
import { bitsOf, snappyCompress, writeRequest } from '../../edge/test/helpers'
import { ledgerStub } from '../../flush/test/helpers'
import { FLUSH_QUEUE_NAME, MAINT_QUEUE_NAME, type StackEnv, consumeMaintBatch, engine, handleQueue, maintMarkerKey, maintainTenant } from '../src/index'
import worker from '../src/index'
import { DAY_MS, type Sim, type SimTenant, checkTenant, createSim, deliver, ingest, rng, shard, take } from './sim'

/**
 * The publisher wired into the write path (D34, D15; publisher/README.md "Needed changes" 1):
 * every maintenance run ends with a bounded nudge to the cell's publisher, and nothing on the
 * ingest or flush path calls it. TEST_PUBLISHER is the real `Publisher` (with a test clock),
 * passed as PUBLISHER; the stand-ins below hang or refuse.
 */

let sim: Sim
const r = rng(11)
beforeAll(async () => {
  sim = await createSim(2, 8)
  for (const s of sim.shards) await shard(s).configure({ sealBytes: 1 << 20, sealAgeMs: 3_600_000, retainRecordedMs: 0, fingerprintTtlMs: 0, seriesPersistMs: 0 })
})
afterAll(() => sim.restore())

const cell = env.CELL
const publisherStub = () => env.TEST_PUBLISHER.get(env.TEST_PUBLISHER.idFromName(cell))
const withPublisher = (base: StackEnv, ns: unknown = env.TEST_PUBLISHER): StackEnv => ({ ...base, PUBLISHER: ns as StackEnv['PUBLISHER'] })
const markerOf = async (t: SimTenant) => (await env.CONFIG.getWithMetadata<{ due: number }>(maintMarkerKey(t.name))).metadata

/** A publisher that never answers, or refuses every call; counts what it is asked. */
function badPublisher(mode: 'hang' | 'refuse') {
  const calls: string[] = []
  const answer = async (what: string): Promise<never> => {
    calls.push(what)
    if (mode === 'refuse') throw new Error('schema_too_new: publisher.Publisher storage is at version 9 (injected)')
    return new Promise<never>(() => {})
  }
  const ns = {
    idFromName: (name: string) => {
      calls.push(`idFromName:${name}`)
      return { name } as unknown as DurableObjectId
    },
    get: () => ({
      notify: () => answer('notify'),
      safeToDelete: () => answer('safeToDelete'),
      acknowledgeDeleted: () => answer('acknowledgeDeleted'),
    }),
  }
  return { ns, calls }
}

/** One Remote Write request of `t`'s series through the ingest Worker's own fetch, with `e` as its env. */
async function remoteWrite(t: SimTenant, e: StackEnv): Promise<{ status: number; ms: number }> {
  const at = Math.floor((Date.now() - 120_000) / 60_000) * 60_000
  const series = t.series.slice(0, 4).map((s, i) => ({ labels: s.labels, samples: [{ ts: at - i * 60_000, value: i }] }))
  const body = snappyCompress(writeRequest(series))
  const ctx = createExecutionContext()
  const started = Date.now()
  const res = await worker.fetch!(
    new Request('https://ingest.test/api/v1/write', {
      method: 'POST',
      headers: { Authorization: `Bearer ${t.key}`, 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'snappy', 'X-Prometheus-Remote-Write-Version': '0.1.0' },
      body,
    }) as never,
    e,
  )
  await waitOnExecutionContext(ctx)
  // Acknowledged: a query must return it from now on (the model checkTenant compares with).
  if (res.status === 204) for (const s of series) t.model.add(Object.fromEntries(s.labels), s.samples[0]!.ts, bitsOf(s.samples[0]!.value))
  return { status: res.status, ms: Date.now() - started }
}

/** Seal both shards for `t` and deliver the flush queue through the script's queue handler with env `e`, settling the ledger's log. */
async function flushThrough(t: SimTenant, e: StackEnv) {
  for (const s of sim.shards) await shard(s).seal(t.name)
  let acked = 0
  let retried = 0
  for (let i = 0; i < 6 && sim.flushQueue.length > 0; i++) {
    const batch = take(sim.flushQueue, 10)
    if (batch.some((m) => m.attempts > 1)) await ledgerStub(t.name).drain()
    const d = await deliver(sim, sim.flushQueue, FLUSH_QUEUE_NAME, batch, 8, (b) => handleQueue(b, e))
    acked += d.acked
    retried += d.retried
  }
  return { acked, retried }
}

/** The data files a table's current snapshot lists for a tenant. */
async function published(table: string, tenant: string): Promise<string[] | null> {
  const dir = `${cell}/iceberg/${table}/metadata/`
  const versions = (await env.BUCKET.list({ prefix: dir })).objects.map((o) => /\/v(\d+)\.metadata\.json$/.exec(o.key)?.[1]).filter((v) => v !== undefined).map(Number)
  if (versions.length === 0) return null
  const meta = await (await env.BUCKET.get(`${dir}v${Math.max(...versions)}.metadata.json`))!.json<TableMetadata>()
  const snap = meta.snapshots.find((x) => x['snapshot-id'] === meta['current-snapshot-id'])!
  const avro = async <T>(uri: string) => (await readAvro<T>(new Uint8Array(await (await env.BUCKET.get(uri.replace(/^s3:\/\/viz-lake\//, '')))!.arrayBuffer()))).records
  const out: string[] = []
  for (const m of await avro<ManifestListRecord>(snap['manifest-list'])) {
    for (const e of await avro<ManifestEntryRecord>(m.manifest_path)) if (e.status !== 2 && e.data_file.partition.tenant === tenant) out.push(e.data_file.file_path.replace(/^s3:\/\/viz-lake\//, ''))
  }
  return out.sort()
}

describe('the publisher wired into maintenance', () => {
  it('a flush leads to a maintenance run, the run nudges the cell\'s publisher, and its own alarm publishes the tenant: nobody calls publish', async () => {
    const [a] = sim.tenants
    const e = withPublisher(sim.env)
    expect(await ingest(sim, a!, r, 6, 3, 0)).toBe(204)
    await flushThrough(a!, e)
    expect(sim.maintQueue.length).toBeGreaterThan(0)
    // The maintenance queue delivers; the run ends with a nudge.
    const d = await deliver(sim, sim.maintQueue, MAINT_QUEUE_NAME, take(sim.maintQueue, 10), 5, (b) => consumeMaintBatch(b, e, engine))
    expect(d.outcomes[0]!.report!.nudged).toBe(true)
    // The nudge only recorded the tenant and a deadline (publishIntervalMs): nothing published yet.
    const sched = await publisherStub().schedule()
    expect(sched.due.publish).toBeGreaterThan(sched.now)
    expect(sched.alarm).not.toBeNull()
    expect(await published('metric_samples', a!.name)).toBeNull()
    // The publisher's alarm, at its deadline, publishes: the current snapshot lists exactly the ledger's live files.
    await ledgerStub(a!.name).drain()
    expect(await runDurableObjectAlarm(publisherStub())).toBe(true)
    const live = (await ledgerStub(a!.name).plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files.map((f) => f.key).sort()
    expect(live.length).toBeGreaterThan(0)
    expect(await published('metric_samples', a!.name)).toEqual(live)
    expect((await env.BUCKET.get(`${cell}/iceberg/metric_series/metadata/version-hint.text`)) !== null).toBe(true)
  })

  it('a publisher that hangs or refuses never slows or fails ingest or flush; the maintenance run returns within its bound and looks again within the hour', async () => {
    const [, b] = sim.tenants
    for (const mode of ['hang', 'refuse'] as const) {
      const bad = badPublisher(mode)
      const e = withPublisher(sim.env, bad.ns)
      // Ingest: every request acknowledged, none waits for the publisher (one that hangs would hold it for ever).
      for (let i = 0; i < 3; i++) {
        const w = await remoteWrite(b!, e)
        expect(w.status).toBe(204)
        expect(w.ms).toBeLessThan(NUDGE_TIMEOUT_MS)
      }
      // Flush: every message acknowledged, through the same handler and env; maintenance requested.
      sim.maintQueue.length = 0
      const f = await flushThrough(b!, e)
      expect(f.acked).toBeGreaterThan(0)
      expect(sim.flushQueue).toEqual([])
      for (const s of sim.shards) expect(await shard(s).pendingSegments(b!.name)).toEqual([])
      expect(sim.maintQueue.length).toBeGreaterThan(0)
      // Neither path asked the publisher anything.
      expect(bad.calls).toEqual([])

      // The maintenance run asks it (the nudge, the deletion gate), waits at most its bounds, and
      // is acknowledged; the nudge was not recorded, so the tenant is due again within the hour.
      const started = Date.now()
      const d = await deliver(sim, sim.maintQueue, MAINT_QUEUE_NAME, take(sim.maintQueue, 10), 5, (x) => consumeMaintBatch(x, e, engine))
      const ms = Date.now() - started
      expect(d.retried).toBe(0)
      const report = d.outcomes[0]!.report!
      expect(report.nudged).toBe(false)
      expect(bad.calls).toContain('notify')
      expect(bad.calls).toContain('safeToDelete')
      expect(report.purged.deleted).toEqual([])
      expect(ms).toBeLessThan(2 * NUDGE_TIMEOUT_MS + 20_000)
      if (mode === 'hang') expect(ms).toBeGreaterThanOrEqual(NUDGE_TIMEOUT_MS)
      expect((await markerOf(b!))!.due).toBeLessThanOrEqual(Date.now() + 3_600_000)
      // Every row acknowledged is still there.
      await checkTenant(sim, b!, 0, `bad publisher (${mode})`)
    }
  })

  it('without a publisher bound, a run neither nudges nor waits, and is not made due hourly', async () => {
    const [a] = sim.tenants
    const report = await maintainTenant(sim.env, engine, a!.name)
    // Not even a failed nudge (which would make the tenant due within the hour): none at all.
    expect(report.nudged).toBeNull()
    expect(report.purged.unpublished).toBeUndefined()
  })

  it('a removal waiting only for publication is looked at again after publicationRecheckMs, not every grace', async () => {
    const [a] = sim.tenants
    const e = withPublisher(sim.env)
    // Merge what the first test flushed; the removed inputs wait for the ledger's grace, then for the publisher.
    const opts = { now: Date.now() + 2 * DAY_MS, deleteGraceMs: 0, orphanEveryMs: 0, orphanGraceMs: 0, maxCompactStepMs: 0 }
    let report = await maintainTenant(e, engine, a!.name, opts)
    for (let i = 0; i < 5 && (report.more || report.compaction.merged > 0); i++) {
      await ledgerStub(a!.name).drain()
      report = await maintainTenant(e, engine, a!.name, opts)
    }
    await ledgerStub(a!.name).drain()
    // The orphan sweep at its usual daily pace, so only the purge decides how soon to look again.
    report = await maintainTenant(e, engine, a!.name, { now: opts.now, deleteGraceMs: 0 })
    expect(report.purged.waiting).toBeGreaterThan(0)
    expect(report.purged.unpublished).toBe(report.purged.waiting)
    expect(report.purged.deleted).toEqual([])
    const due = (await markerOf(a!))!.due
    expect(due).toBeGreaterThan(Date.now() + 5 * 3_600_000)
    await checkTenant(sim, a!, 0, 'waiting for publication')
  })
})
