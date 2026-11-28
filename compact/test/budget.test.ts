/**
 * D82: compaction is priced in CPU before it runs. Workers cannot read their own CPU, so each merge
 * is modelled (`modelledCpuMs`: ms per MiB of input by table, plus a fixed part); a merge's inputs
 * are chosen to fit `maxStepCpuMs`, and a run (`cpuBudgetMs`) never starts the merge that would
 * take it past its budget: it stops with `budget` and `more`, having read and written nothing for
 * that merge, and a later run does it. S10 measured runs of 8 merges at 21 and 28 s of CPU and one
 * killed at the 30 s limit.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { LiveFile } from '../../contracts/ledger'
import { encodeLogBatch } from '../../engine/wasm/test/signal'
import { DAY_MS, T0, dataKeys, flushSettled, ledgerStub, sha256Hex, shardStub } from '../../flush/test/helpers'
import { CPU_MS_PER_MIB, DEFAULT_POLICY, STEP_CPU_MS, type Unit, chooseJob, compactStep, compactTenant, engine, modelledCpuMs } from '../src/index'

const MiB = 1 << 20
const HOUR = 3_600_000
const NS = 1_000_000n

const unit = (i: number, bytes: number, day = '2026-11-18'): Unit => {
  const f = { key: `cell-0/data/logs/tenant=t/day=${day}/L0-s-1-${i}-${i}-0000000${i % 10}.parquet`, table: 'logs', day, bytes, rows: 10, minTs: T0 + i, maxTs: T0 + i, level: 0, precedenceLow: i, precedence: i } as unknown as LiveFile
  return { files: [f], key: f.key, day, level: 0, bytes, minTs: f.minTs, maxTs: f.maxTs, precedenceLow: i, precedence: i }
}

describe('the CPU model (D82)', () => {
  it('prices a merge by table and input bytes', () => {
    expect(modelledCpuMs('logs', 0)).toBe(STEP_CPU_MS)
    expect(modelledCpuMs('logs', 10 * MiB)).toBe(STEP_CPU_MS + 10 * CPU_MS_PER_MIB.logs)
    expect(modelledCpuMs('metric', 16 * MiB)).toBe(STEP_CPU_MS + 16 * CPU_MS_PER_MIB.metric)
    // A step at the byte budget of a span or log table is over the step's CPU cap: the cap binds.
    expect(modelledCpuMs('spans', DEFAULT_POLICY.maxInputBytes)).toBeGreaterThan(DEFAULT_POLICY.maxStepCpuMs)
    expect(modelledCpuMs('metric', DEFAULT_POLICY.maxInputBytes)).toBeLessThanOrEqual(DEFAULT_POLICY.maxStepCpuMs)
  })

  it('chooses a merge\'s inputs to fit the step\'s CPU cap, by the table\'s price', () => {
    const units = Array.from({ length: 8 }, (_, i) => unit(i, 3 * MiB))
    const closed = Date.parse('2026-11-18T00:00:00Z') + 2 * DAY_MS + DEFAULT_POLICY.closeAfterMs
    // logs: 3 x 3 MiB = 6,400 ms modelled fits 8,000; a fourth (8,500) does not.
    const logs = chooseJob(units, closed, DEFAULT_POLICY, [], 'logs').job!
    expect(logs.inputs).toHaveLength(3)
    expect(modelledCpuMs('logs', logs.inputs.reduce((a, u) => a + u.bytes, 0))).toBeLessThanOrEqual(DEFAULT_POLICY.maxStepCpuMs)
    // The same files priced as metrics: the byte budget binds first (5 x 3 MiB <= 16 MiB).
    expect(chooseJob(units, closed, DEFAULT_POLICY, [], 'metric').job!.inputs).toHaveLength(5)
    // A file that alone is over the cap is left as it is (as one over the byte budget is).
    const big = [unit(0, 12 * MiB), unit(1, 12 * MiB)]
    expect(chooseJob(big, closed, DEFAULT_POLICY, [], 'logs').job).toBeNull()
    expect(chooseJob(big, closed, { ...DEFAULT_POLICY, maxStepCpuMs: 60_000, maxInputBytes: 32 * MiB }, [], 'logs').job!.inputs).toHaveLength(2)
  })
})

let n = 0
/** A log stream with `perHour` flushed one-batch units in each of hours 12 and 13 of T0's day. */
async function logUnits(perHour: number) {
  const id = `bud-${Date.now().toString(36)}-${n++}`
  const tenant = `cb-${id}`
  const shardName = `pool-${id}/logs/0`
  const shard = shardStub(shardName)
  for (const hour of [0, 1]) {
    for (let i = 0; i < perHour; i++) {
      const ts = BigInt(T0 + hour * HOUR + i * 60_000) * NS
      const payload = encodeLogBatch([{ labels: { service_name: 'api' } }], [{ entry: 0, ts, line: `line ${hour} ${i}` }])
      const rows = new DataView(payload.buffer, payload.byteOffset).getUint32(8, true)
      expect((await shard.append({ tenant, epoch: 1, fingerprint: await sha256Hex(payload), payload, rows })).status).toBe('ok')
      await shard.seal(tenant)
    }
  }
  expect(await flushSettled(env, engine, tenant, shardName)).toMatchObject({ status: 'ok', awaitingLog: false })
  return { tenant, ledger: ledgerStub(tenant) }
}
const QUIET = T0 + 3 * HOUR
const liveLogs = async (l: ReturnType<typeof ledgerStub>) => (await l.plan({ table: 'logs', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files.map((f) => f.key).sort()

describe('a run spends at most its CPU budget (D82)', () => {
  it('a step whose merge costs more than the budget reads and writes nothing, and says so', async () => {
    const t = await logUnits(4)
    const before = { live: await liveLogs(t.ledger), objects: await dataKeys(t.tenant) }
    const r = await compactStep(env, engine, t.tenant, { now: QUIET, cpuBudgetMs: STEP_CPU_MS - 1 })
    expect(r).toMatchObject({ status: 'budget', cpuBudgetMs: STEP_CPU_MS - 1, job: { table: 'logs', level: 1 } })
    expect(r.status === 'budget' && r.job.modelledCpuMs).toBeGreaterThan(STEP_CPU_MS - 1)
    expect(await liveLogs(t.ledger)).toEqual(before.live)
    expect(await dataKeys(t.tenant)).toEqual(before.objects)
  })

  it('a run merges while the next merge fits what is left, then stops with `more`; the next run finishes', async () => {
    const t = await logUnits(4)
    // Room for one small merge (about STEP_CPU_MS) but not two.
    const one = await compactTenant(env, engine, t.tenant, { now: QUIET, cpuBudgetMs: 1.5 * STEP_CPU_MS })
    expect(one.steps.map((s) => s.status)).toEqual(['merged', 'budget'])
    expect(one).toMatchObject({ merged: 1, more: true })
    expect(one.modelledCpuMs).toBeLessThanOrEqual(1.5 * STEP_CPU_MS)
    expect(one.modelledCpuMs).toBe(one.steps[0]!.status === 'merged' ? one.steps[0]!.job.modelledCpuMs : -1)
    const rest = await compactTenant(env, engine, t.tenant, { now: QUIET, cpuBudgetMs: 10 * STEP_CPU_MS })
    expect(rest.steps.map((s) => s.status)).toEqual(['merged', 'idle'])
    expect(rest.more).toBe(false)
    // Two level-1 files, one per hour: the same result as one run with no budget would give.
    const live = await t.ledger.plan({ table: 'logs', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
    expect(live.files.map((f) => f.level)).toEqual([1, 1])
  })

  it('without a budget it runs as before D82 (the Workflow and direct callers)', async () => {
    const t = await logUnits(4)
    const r = await compactTenant(env, engine, t.tenant, { now: QUIET })
    expect(r.steps.map((s) => s.status)).toEqual(['merged', 'merged', 'idle'])
    expect(r.modelledCpuMs).toBeGreaterThan(2 * STEP_CPU_MS)
  })
})
