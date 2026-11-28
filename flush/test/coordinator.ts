/**
 * The query coordinator's protocol for the seam, for integration tests of the write path
 * (flush/test/registration.test.ts): which shards it asks, with which incarnation and
 * watermark, what it learns from a refusal, when it re-plans and when it gives up. It follows
 * query/src/coordinator.ts as of 2026-11-19 statement for statement where it matters:
 *
 *   shardsOf   every shard of the tenant's pool, plus every stream the plan names
 *   readTail   `incarnation = w?.incarnation ?? 0`, `above = w?.seq ?? 0`; a learned newer
 *              incarnation is read from 0; `stale_watermark` refuses; `incarnation_mismatch`
 *              below the one asked refuses ("behind the ledger"); above it is learned, and
 *              refuses if the plan named the shard, else is read from 0 (two calls at most)
 *   gather     a refusal re-plans; more than MAX_REFUSALS (3) for one shard or file is 503
 *
 * Not the coordinator itself (query/ is another component and is not in this script); the
 * same traces against the real coordinator are listed for query/ in shard/README.md, "Needed
 * changes elsewhere". Lake files and tail batches are merged by the real engine.
 */
import type { Plan, Watermark } from '../../contracts/ledger'
import type { VizEngine } from '../../engine/wasm/js/index'
import type { Ledger } from '../../ledger/src/ledger'
import type { Shard } from '../../shard/src/shard'
import { canonOf } from './read'

export const MAX_REFUSALS = 3

export interface CoordinatorEnv {
  SHARD: DurableObjectNamespace<Shard>
  LEDGER: DurableObjectNamespace<Ledger>
  BUCKET: R2Bucket
}

export interface Answer {
  canon: string[]
  /** Plans taken (1 + one per refusal). */
  attempts: number
  /** Why each refused attempt was refused. */
  refusals: string[]
  /** The tail read of each shard in the attempt that answered: the incarnation and watermark asked. */
  asked: { shard: string; incarnation: number; above: number }[]
}

export class Unavailable extends Error {}

type Tail = { status: 'ok'; batches: Uint8Array[]; asked: { incarnation: number; above: number } } | { status: 'refused'; why: string }

async function readTail(env: CoordinatorEnv, tenant: string, shard: string, w: Watermark | undefined, known: Map<string, number>): Promise<Tail> {
  const stub = env.SHARD.get(env.SHARD.idFromName(shard))
  let incarnation = w?.incarnation ?? 0
  let above = w?.seq ?? 0
  const learned = known.get(shard)
  if (learned !== undefined && learned > incarnation) {
    incarnation = learned
    above = 0
  }
  for (let call = 0; call < 2; call++) {
    const r = await stub.tailRead(tenant, incarnation, above)
    if (r.status === 'ok') return { status: 'ok', batches: r.batches.map((b) => b.payload), asked: { incarnation, above } }
    if (r.status === 'stale_watermark') return { status: 'refused', why: `shard ${shard} has discarded rows above the watermark` }
    if (r.status !== 'incarnation_mismatch') throw new Unavailable(`shard ${shard} answered ${r.status}`)
    if (r.incarnation < incarnation) return { status: 'refused', why: `shard ${shard} is behind the ledger` }
    known.set(shard, r.incarnation)
    if (w) return { status: 'refused', why: `shard ${shard} has a newer stream than the ledger knows` }
    incarnation = r.incarnation
    above = 0
  }
  return { status: 'refused', why: `shard ${shard} changed its stream twice during one read` }
}

/**
 * One query of everything of `tenant`, as the coordinator runs it. `afterPlan(attempt, plan)`
 * runs after each plan and before anything is read (the coordinator's `hooks.afterPlan`).
 */
export async function query(env: CoordinatorEnv, engine: VizEngine, tenant: string, pool: string[], hooks: { afterPlan?: (attempt: number, plan: Plan) => Promise<void> } = {}): Promise<Answer> {
  const ledger = env.LEDGER.get(env.LEDGER.idFromName(tenant))
  const known = new Map<string, number>()
  const refusals = new Map<string, number>()
  const why: string[] = []
  const refused = (who: string, reason: string) => {
    why.push(reason)
    const n = (refusals.get(who) ?? 0) + 1
    refusals.set(who, n)
    if (n > MAX_REFUSALS) throw new Unavailable(`${reason}, and the ledger does not catch up; retry later`)
  }
  for (let attempt = 1; ; attempt++) {
    const samples = await ledger.plan({ table: 'metric_samples', minTs: 0, maxTs: 253_402_300_799_999 })
    const series = await ledger.plan({ table: 'metric_series', minTs: 0, maxTs: 253_402_300_799_999 })
    if (samples.version !== series.version || samples.ledgerIncarnation !== series.ledgerIncarnation) {
      refused('ledger', 'the ledger changed between the two plans')
      continue
    }
    await hooks.afterPlan?.(attempt, samples)
    const shards = [...new Set([...pool, ...samples.watermarks.map((w) => w.shard)])].sort()
    const tails = await Promise.all(shards.map((s) => readTail(env, tenant, s, samples.watermarks.find((w) => w.shard === s), known)))
    let again = false
    tails.forEach((t, i) => {
      if (t.status === 'refused') {
        refused(`shard ${shards[i]}`, t.why)
        again = true
      }
    })
    if (again) continue
    const fetchAll = async (keys: string[]) => {
      const out: Uint8Array[] = []
      for (const k of keys) {
        const o = await env.BUCKET.get(k)
        if (!o) return { missing: k }
        out.push(new Uint8Array(await o.arrayBuffer()))
      }
      return { files: out }
    }
    const sf = await fetchAll(samples.files.map((f) => f.key))
    const rf = await fetchAll(series.files.map((f) => f.key))
    if ('missing' in sf || 'missing' in rf) {
      const k = 'missing' in sf ? sf.missing : (rf as { missing: string }).missing
      refused(`file ${k}`, `data file ${k} is listed by the ledger but is not in R2`)
      continue
    }
    const ok = tails as Extract<Tail, { status: 'ok' }>[]
    const out = engine.select({ sampleFiles: sf.files, seriesFiles: rf.files, tailBatches: ok.flatMap((t) => t.batches) }, [], 0, 253_402_300_799_999)
    return { canon: canonOf(out), attempts: attempt, refusals: why, asked: ok.map((t, i) => ({ shard: shards[i]!, ...t.asked })) }
  }
}
