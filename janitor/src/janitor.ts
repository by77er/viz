import { TENANT_ID, type Table, type Watermark } from '../../contracts/ledger'
import { DEFAULT_POLICY } from '../../compact/src/compact'
import type { Ledger } from '../../ledger/src/ledger'

/**
 * Retention and physical deletion for one tenant. Three stateless jobs; the state they
 * need (what was removed, when, and whether that is logged) is in the tenant's ledger.
 *
 *   expireTenant   ledger.expire for days older than the tenant's policy. Removes files
 *                  from the ledger only; no object is touched.
 *   purgeTenant    deletes the objects of keys the ledger removed (by expire or by
 *                  compaction), but only those the ledger itself calls deletable: removal
 *                  logged, grace passed, not live (contracts/ledger.ts, tombstones).
 *   sweepOrphans   deletes objects under the tenant's data prefix that the ledger has
 *                  never listed and never will (a flush or compaction that failed after
 *                  its PUT), once they are old.
 *
 * No job writes an object, and deletes go to R2 as one request per thousand keys.
 */

export interface JanitorEnv {
  LEDGER: DurableObjectNamespace<Ledger>
  BUCKET: R2Bucket
  CONFIG: KVNamespace
  CELL?: string
}

export interface RetentionPolicy {
  /** Keep this many whole UTC days of metric samples (and their series files) besides today. */
  metric_samples_days: number
}

export const DEFAULT_RETENTION: RetentionPolicy = { metric_samples_days: 30 }
/** Grace between a key leaving the ledger and its object being deleted. Longer than any query may run. */
export const DEFAULT_DELETE_GRACE_MS = 3_600_000
/** Age at which an object the ledger does not know is taken for an orphan. */
export const DEFAULT_ORPHAN_GRACE_MS = 24 * 3_600_000

const DAY_MS = 86_400_000
const TABLES: readonly Table[] = ['metric_samples', 'metric_series']
const cellOf = (env: JanitorEnv): string => env.CELL || 'cell-0'
const ledgerOf = (env: JanitorEnv, tenant: string): DurableObjectStub<Ledger> => {
  if (!TENANT_ID.test(tenant)) throw new Error('janitor: tenant id must match [A-Za-z0-9_-]{1,64}')
  return env.LEDGER.get(env.LEDGER.idFromName(tenant))
}

/** `retention:<tenant>` in KV, else the default. A record that cannot be read keeps the default (never a shorter one). */
export async function retentionPolicy(env: Pick<JanitorEnv, 'CONFIG'>, tenant: string): Promise<RetentionPolicy> {
  const raw = await env.CONFIG.get(`retention:${tenant}`)
  if (raw === null) return DEFAULT_RETENTION
  try {
    const days = (JSON.parse(raw) as Partial<RetentionPolicy>).metric_samples_days
    if (typeof days === 'number' && Number.isInteger(days) && days >= 1) return { metric_samples_days: days }
  } catch {
    // fall through
  }
  return DEFAULT_RETENTION
}

/** The first day that is kept: files of days strictly before it expire. */
export const retentionCutoffDay = (now: number, policy: RetentionPolicy): string => new Date(now - policy.metric_samples_days * DAY_MS).toISOString().slice(0, 10)

export interface ExpireResult {
  beforeDay: string
  /** The policy applied: whole days kept besides today. Day D expires at `D + keepDays + 1` days, 00:00 UTC. */
  keepDays: number
  /** Keys removed from the ledger by this run. */
  removed: string[]
}

export async function expireTenant(env: JanitorEnv, tenant: string, now = Date.now()): Promise<ExpireResult> {
  const ledger = ledgerOf(env, tenant)
  const policy = await retentionPolicy(env, tenant)
  const beforeDay = retentionCutoffDay(now, policy)
  // Samples first: between the two calls a day may have series files without samples
  // (which no query returns), never samples without the series that describe them.
  const samples = await ledger.expire({ table: 'metric_samples', beforeDay })
  const series = await ledger.expire({ table: 'metric_series', beforeDay })
  return { beforeDay, keepDays: policy.metric_samples_days, removed: [...samples.removed, ...series.removed] }
}

export interface PurgeResult {
  deleted: string[]
  /** Tombstones not deletable yet: inside the grace, or their removal is not logged. */
  waiting: number
}

export async function purgeTenant(env: JanitorEnv, tenant: string, opts: { graceMs?: number; maxKeys?: number } = {}): Promise<PurgeResult> {
  const ledger = ledgerOf(env, tenant)
  const graceMs = opts.graceMs ?? DEFAULT_DELETE_GRACE_MS
  const maxKeys = opts.maxKeys ?? 10_000
  const deleted: string[] = []
  let waiting = 0
  while (deleted.length < maxKeys) {
    // The ledger decides: logged, older than the grace by its clock, not live.
    const batch = await ledger.deletable({ minAgeMs: graceMs, limit: Math.min(1000, maxKeys - deleted.length) })
    waiting = batch.waiting
    const keys = batch.tombstones.map((t) => t.key)
    if (keys.length === 0) break
    await env.BUCKET.delete(keys) // one request for the whole list
    // Forgotten only after the delete returned: a crash in between deletes again, harmlessly.
    await ledger.forget(keys)
    deleted.push(...keys)
  }
  return { deleted, waiting }
}

/** `L0-{shard}-{incarnation}-{seqLo}-{seqHi}-{hash8}.parquet`: a flush file (contracts/TABLES.md). */
const FLUSH_FILE = /\/L0-(.+)-(\d+)-(\d+)-(\d+)-[0-9a-f]{8}\.parquet$/
/** `L{level}-{span}-{inputs16}-{hash8}.parquet`: a compaction output. */
const COMPACTED_FILE = /\/L[1-9]\d*-(h\d\d|d)-[0-9a-f]{16}-[0-9a-f]{8}\.parquet$/

export interface OrphanResult {
  /** Objects under the tenant's data prefix. */
  listed: number
  deleted: string[]
  /** Unreferenced objects that were kept, and why. */
  kept: { key: string; why: 'young' | 'pending_unit' | 'unknown_stream' | 'unknown_name' }[]
}

/**
 * Can this unreferenced flush file ever be admitted? Not if its stream's LOGGED watermark
 * has reached its range (a unit for that range is answered as a replay and adds no file),
 * and not if the ledger has a newer incarnation of the stream (a lower one is refused).
 * Anything else may be the files of a unit that is about to be reported.
 */
function flushFileState(m: RegExpExecArray, logged: Watermark[]): 'dead' | 'pending_unit' | 'unknown_stream' {
  const [, shard, inc, , seqHi] = m
  const w = logged.find((x) => x.shard.replaceAll('/', '_') === shard)
  if (!w) return 'unknown_stream'
  if (w.incarnation > Number(inc)) return 'dead'
  return w.incarnation === Number(inc) && w.seq >= Number(seqHi) ? 'dead' : 'pending_unit'
}

export async function sweepOrphans(env: JanitorEnv, tenant: string, opts: { graceMs?: number; maxCompactStepMs?: number; now?: number } = {}): Promise<OrphanResult> {
  const ledger = ledgerOf(env, tenant)
  const now = opts.now ?? Date.now()
  const graceMs = opts.graceMs ?? DEFAULT_ORPHAN_GRACE_MS
  // A compaction output is protected only by its age: a step gives up before `replace`
  // once it has run `maxStepMs`, so an output at least twice that old cannot be in flight.
  const compactGraceMs = graceMs
  const out: OrphanResult = { listed: 0, deleted: [], kept: [] }

  // 1. List first. Whatever is written after this is not a candidate in this run.
  const objects: { key: string; uploaded: number }[] = []
  for (const table of TABLES) {
    let cursor: string | undefined
    do {
      const page = await env.BUCKET.list({ prefix: `${cellOf(env)}/data/${table}/tenant=${tenant}/`, cursor })
      for (const o of page.objects) objects.push({ key: o.key, uploaded: o.uploaded.getTime() })
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  }
  out.listed = objects.length

  // 2. Then ask the ledger, in one consistent read per thousand keys.
  for (let i = 0; i < objects.length; i += 1000) {
    const chunk = objects.slice(i, i + 1000)
    const check = await ledger.orphanCheck(chunk.map((o) => o.key))
    const known = new Set([...check.live, ...check.tombstoned]) // tombstoned keys go through purgeTenant
    const doomed: string[] = []
    for (const o of chunk) {
      if (known.has(o.key)) continue
      const age = now - o.uploaded
      const flush = FLUSH_FILE.exec(o.key)
      if (flush) {
        const state = flushFileState(flush, check.logged)
        if (state !== 'dead') out.kept.push({ key: o.key, why: state })
        else if (age < graceMs) out.kept.push({ key: o.key, why: 'young' })
        else doomed.push(o.key)
      } else if (COMPACTED_FILE.test(o.key)) {
        if (age < compactGraceMs) out.kept.push({ key: o.key, why: 'young' })
        else doomed.push(o.key)
      } else {
        out.kept.push({ key: o.key, why: 'unknown_name' }) // not ours to judge
      }
    }
    if (doomed.length > 0) await env.BUCKET.delete(doomed)
    out.deleted.push(...doomed)
  }
  return out
}
