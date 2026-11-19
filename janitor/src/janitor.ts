import { TENANT_ID, type Table, type Watermark } from '../../contracts/ledger'
import { COMPACTION_INPUTS_META, DEFAULT_POLICY, decodeCompactionInputs } from '../../compact/src/compact'
import type { Ledger } from '../../ledger/src/ledger'
import type { Publisher } from '../../publisher/src/publisher'

/**
 * Retention and physical deletion for one tenant. Three stateless jobs; the state they
 * need (what was removed, when, and whether that is logged) is in the tenant's ledger.
 *
 *   expireTenant   ledger.expire for days older than the tenant's policy. Removes files
 *                  from the ledger only; no object is touched.
 *   purgeTenant    deletes the objects of keys the ledger removed (by expire or by
 *                  compaction), but only those the ledger itself calls deletable: removal
 *                  logged, grace passed, not live (contracts/ledger.ts, tombstones); and,
 *                  when the deployment publishes Iceberg tables, only those the cell's
 *                  publisher also releases (`safeToDelete`): removal published, no retained
 *                  snapshot references the file, its grace passed.
 *   sweepOrphans   deletes objects under the tenant's data prefix that the ledger has
 *                  never listed and never will (a flush or compaction that failed after
 *                  its PUT): a flush file once its stream's LOGGED watermark covers it, a
 *                  compaction output once one of its inputs is gone for good.
 *
 * No job writes an object, and deletes go to R2 as one request per thousand keys.
 */

export interface JanitorEnv {
  LEDGER: DurableObjectNamespace<Ledger>
  BUCKET: R2Bucket
  CONFIG: KVNamespace
  CELL?: string
  /**
   * The cell's publisher (publisher/), in a deployment that publishes Iceberg tables. Then an
   * object is deleted only once the publisher also releases it (`purgeTenant`). Absent: the
   * ledger's rules alone, as before the publisher existed.
   */
  PUBLISHER?: PublisherGateNamespace
}

/** What the janitor asks of the cell's publisher: its deletion hand-off (publisher/src/publisher.ts). */
export type PublisherGate = Pick<Publisher, 'safeToDelete' | 'acknowledgeDeleted'>

/** The publisher's namespace, as far as the janitor uses it: the cell's object is `idFromName(cell)`. */
export interface PublisherGateNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): PublisherGate
}

/**
 * How long a purge waits for the publisher's answer. `safeToDelete` is one SQLite read; this is
 * for a publisher that is overloaded, refusing during a deploy, or gone. No answer means nothing
 * is deleted this run (D15: the publisher is never upstream of anything but deletion).
 */
export const PUBLISHER_GATE_TIMEOUT_MS = 2_000

/** `p`, or a rejection after `ms`. The timer never outlives the call. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms) })])
  } finally {
    clearTimeout(timer)
  }
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

/**
 * The retention record `retention:<tenant>` (written by `control/`, format `kv.settings` v1:
 * `{"metric_samples_days":N, …}`; an absent `v` means 1, other fields are ignored).
 *
 *   - No record: the default, 30 days. The default IS the policy of a tenant that has none.
 *   - A record this code cannot read (not JSON, not an object, a `v` other than 1, or
 *     `metric_samples_days` not a positive integer): `unreadable`. Nothing is expired for the
 *     tenant until the record is fixed (review R-1: falling back to the default could be
 *     SHORTER than what the tenant asked for; refuse rather than guess).
 */
export type RetentionRead =
  | { status: 'ok'; policy: RetentionPolicy; source: 'record' | 'default' }
  | { status: 'unreadable'; reason: string }

/** Version of the retention record this code reads (contracts/COMPATIBILITY.md §3.1). */
export const RETENTION_RECORD_VERSION = 1

export function parseRetention(raw: string): RetentionRead {
  const unreadable = (reason: string): RetentionRead => ({ status: 'unreadable', reason })
  let rec: unknown
  try {
    rec = JSON.parse(raw)
  } catch {
    return unreadable('not JSON')
  }
  if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) return unreadable('not a JSON object')
  const v = (rec as { v?: unknown }).v ?? 1
  if (v !== RETENTION_RECORD_VERSION) return unreadable(`version ${JSON.stringify(v)}; this code reads version ${RETENTION_RECORD_VERSION}`)
  const days = (rec as Partial<RetentionPolicy>).metric_samples_days
  if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1) return unreadable(`metric_samples_days is ${JSON.stringify(days)}, not a positive integer`)
  return { status: 'ok', policy: { metric_samples_days: days }, source: 'record' }
}

export async function readRetention(env: Pick<JanitorEnv, 'CONFIG'>, tenant: string): Promise<RetentionRead> {
  const raw = await env.CONFIG.get(`retention:${tenant}`)
  if (raw === null) return { status: 'ok', policy: DEFAULT_RETENTION, source: 'default' }
  return parseRetention(raw)
}

/**
 * The first day that is kept: files of days strictly before it expire. A policy longer than
 * the time since 1970 keeps everything (no file has an earlier day: contracts/TABLES.md).
 */
export const retentionCutoffDay = (now: number, policy: RetentionPolicy): string => {
  const cutoff = now - policy.metric_samples_days * DAY_MS
  return cutoff <= 0 ? '1970-01-01' : new Date(cutoff).toISOString().slice(0, 10)
}

export interface ExpireResult {
  /** The first day kept; null when the run was refused. */
  beforeDay: string | null
  /** The policy applied: whole days kept besides today. Day D expires at `D + keepDays + 1` days, 00:00 UTC. Null when refused. */
  keepDays: number | null
  /** Keys removed from the ledger by this run. */
  removed: string[]
  /** Set when the tenant's retention record cannot be read: nothing was expired. */
  refused?: string
}

export async function expireTenant(env: JanitorEnv, tenant: string, now = Date.now()): Promise<ExpireResult> {
  const ledger = ledgerOf(env, tenant)
  const read = await readRetention(env, tenant)
  if (read.status !== 'ok') {
    // Refuse rather than guess, and say so where an operator looks: the error log, the
    // maintenance report and marker, and the hourly cron's log (stack/src/maintain.ts).
    console.error(`janitor: retention:${tenant} cannot be read (${read.reason}); nothing is expired for this tenant until it is fixed`)
    return { beforeDay: null, keepDays: null, removed: [], refused: read.reason }
  }
  const policy = read.policy
  const beforeDay = retentionCutoffDay(now, policy)
  // Both tables in ONE ledger change, so a samples file and its series file leave together
  // (contracts/TABLES.md, "Pairing"; review R-5).
  const expired = await ledger.expire({ tables: ['metric_samples', 'metric_series'], beforeDay })
  return { beforeDay, keepDays: policy.metric_samples_days, removed: expired.removed }
}

export interface PurgeResult {
  deleted: string[]
  /**
   * Tombstones not deleted yet: inside the grace, their removal not logged, or (with a
   * publisher) not released by it.
   */
  waiting: number
  /**
   * With a publisher: of `waiting`, the tombstones the ledger would delete but the publisher has
   * not released (the removal is not published yet, a retained snapshot still references the
   * file, or the publisher's grace has not passed). Absent without a publisher.
   */
  unpublished?: number
  /** With a publisher that could not be asked (it refused, failed or did not answer): why. Nothing was deleted. */
  publisher?: string
}

/**
 * Delete the objects of removed keys that may never be read again. The ledger decides first:
 * the removal is logged, older than the grace by its clock, and the key is not live. With a
 * publisher bound, a key is deleted only if the publisher ALSO releases it (DESIGN §5.2, §5.3):
 * its removal is published and no retained Iceberg snapshot references it, so an external
 * reader holding any snapshot still finds every file that snapshot names. A publisher that
 * cannot answer releases nothing: the run deletes nothing and says why (fail closed).
 */
export async function purgeTenant(env: JanitorEnv, tenant: string, opts: { graceMs?: number; maxKeys?: number; publisherTimeoutMs?: number } = {}): Promise<PurgeResult> {
  const ledger = ledgerOf(env, tenant)
  const graceMs = opts.graceMs ?? DEFAULT_DELETE_GRACE_MS
  const maxKeys = opts.maxKeys ?? 10_000
  const timeoutMs = opts.publisherTimeoutMs ?? PUBLISHER_GATE_TIMEOUT_MS
  const deleted: string[] = []
  let waiting = 0

  // With a publisher: what it releases for this tenant, asked once per run.
  let gate: PublisherGate | null = null
  let released: Set<string> | null = null
  if (env.PUBLISHER) {
    const cell = cellOf(env)
    try {
      gate = env.PUBLISHER.get(env.PUBLISHER.idFromName(cell))
      released = new Set(await within(gate.safeToDelete(tenant), timeoutMs, `the publisher of ${cell}`))
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).slice(0, 300)
      console.error(`janitor: could not ask the publisher what ${tenant} may delete (${why}); nothing is deleted this run`)
      const batch = await ledger.deletable({ minAgeMs: graceMs, limit: 1 })
      return { deleted: [], waiting: batch.waiting + batch.tombstones.length, publisher: why }
    }
  }

  let held = 0 // deletable by the ledger, not released by the publisher: they stay at the head of its answer
  const offered = new Set<string>()
  while (deleted.length < maxKeys) {
    // The ledger decides: logged, older than the grace by its clock, not live. Lowest version
    // first, so the keys the publisher holds back come back first and are skipped again.
    const batch = await ledger.deletable({ minAgeMs: graceMs, limit: Math.min(10_000, held + Math.min(1000, maxKeys - deleted.length)) })
    const keys = batch.tombstones.map((t) => t.key)
    for (const k of keys) offered.add(k)
    const doomed = released ? keys.filter((k) => released!.has(k)) : keys
    held = keys.length - doomed.length
    waiting = batch.waiting + held
    if (doomed.length === 0) break
    await env.BUCKET.delete(doomed) // one request for the whole list
    // Forgotten only after the delete returned: a crash in between deletes again, harmlessly.
    await ledger.forget(doomed)
    deleted.push(...doomed)
  }
  if (!gate || !released) return { deleted, waiting }

  // The publisher forgets what was deleted. Also what it released and the ledger no longer has
  // at all (neither live nor tombstoned): deleted by an earlier run whose acknowledgement was
  // lost, so nothing is left to delete. Acknowledging deletes nothing; best effort.
  const ack = [...deleted]
  const unknown = [...released].filter((k) => !offered.has(k))
  for (let i = 0; i < unknown.length; i += 1000) {
    const chunk = unknown.slice(i, i + 1000)
    const known = await ledger.orphanCheck(chunk)
    const kept = new Set([...known.live, ...known.tombstoned])
    ack.push(...chunk.filter((k) => !kept.has(k)))
  }
  if (ack.length > 0) {
    await within(gate.acknowledgeDeleted(tenant, ack), timeoutMs, `the publisher of ${cellOf(env)}`).catch((e) =>
      console.error(`janitor: the publisher was not told about ${ack.length} deleted keys of ${tenant} (${e instanceof Error ? e.message : String(e)}); the next run tells it`),
    )
  }
  return { deleted, waiting, unpublished: held }
}

/** `L0-{shard}-{incarnation}-{seqLo}-{seqHi}-{hash8}.parquet`: a flush file (contracts/TABLES.md). */
const FLUSH_FILE = /\/L0-(.+)-(\d+)-(\d+)-(\d+)-[0-9a-f]{8}\.parquet$/
/** `L{level}-{span}-{inputs16}-{hash8}.parquet`: a compaction output. */
const COMPACTED_FILE = /\/L[1-9]\d*-(h\d\d|d)-[0-9a-f]{16}-[0-9a-f]{8}\.parquet$/

export interface OrphanResult {
  /** Objects under the tenant's data prefix. */
  listed: number
  deleted: string[]
  /**
   * Unreferenced objects that were kept, and why. `inputs_remain`: a compaction output some
   * step could still make live, because none of its inputs is gone for good. `unknown_inputs`:
   * a compaction output whose inputs cannot be read from its metadata (missing, a newer
   * version, or not matching its key); never deleted automatically.
   */
  kept: { key: string; why: 'young' | 'pending_unit' | 'unknown_stream' | 'unknown_name' | 'inputs_remain' | 'unknown_inputs'; detail?: string }[]
  /**
   * When the youngest object kept for something a write or time can still change (`young`,
   * `pending_unit`, `unknown_stream`, `inputs_remain`) was uploaded; absent when there is none.
   * Lets the caller stop sweeping for objects that have waited too long (review S-6).
   */
  waitingSince?: number
}

/**
 * Can this unreferenced flush file ever be admitted? Not if its stream's LOGGED watermark
 * has reached its range (a unit for that range is answered as a replay and adds no file),
 * and not if the ledger has a newer incarnation of the stream whose registration is LOGGED
 * (a lower one is then refused for good). Anything else may be the files of a unit that is
 * about to be reported.
 *
 * `orphanCheck` reports each stream's COMMITTED incarnation with the logged watermark of that
 * incarnation. A registration that is committed but not logged can be rolled back by a
 * rebuild, after which a late `addUnit` of the older incarnation is admitted again
 * (spec/README.md F15). The log is a prefix of versions and a unit's version is above its
 * stream's registration, so a logged watermark above 0 for the newer incarnation proves the
 * registration is logged; at 0 this keeps the file.
 */
function flushFileState(m: RegExpExecArray, logged: Watermark[]): 'dead' | 'pending_unit' | 'unknown_stream' {
  const [, shard, inc, , seqHi] = m
  const w = logged.find((x) => x.shard.replaceAll('/', '_') === shard)
  if (!w) return 'unknown_stream'
  if (w.incarnation > Number(inc)) return w.seq > 0 ? 'dead' : 'pending_unit'
  return w.incarnation === Number(inc) && w.seq >= Number(seqHi) ? 'dead' : 'pending_unit'
}

/** Fault-injection points (tests). A hook that runs other work stands for a concurrent job at that point. */
export interface SweepHooks {
  /** After the listing, before the ledger is asked. */
  afterList?(keys: string[]): void | Promise<void>
  /** After the ledger was asked, before the doomed objects of that chunk are deleted. */
  beforeDelete?(doomed: string[]): void | Promise<void>
}

export async function sweepOrphans(env: JanitorEnv, tenant: string, opts: { graceMs?: number; maxCompactStepMs?: number; now?: number; hooks?: SweepHooks } = {}): Promise<OrphanResult> {
  const ledger = ledgerOf(env, tenant)
  const now = opts.now ?? Date.now()
  const graceMs = opts.graceMs ?? DEFAULT_ORPHAN_GRACE_MS
  // An age floor for compaction outputs. It is NOT what makes deleting one safe (that is the
  // inputs rule below); it only keeps the sweep off objects a step wrote moments ago.
  const compactGraceMs = Math.max(graceMs, 2 * (opts.maxCompactStepMs ?? DEFAULT_POLICY.maxStepMs))
  const out: OrphanResult = { listed: 0, deleted: [], kept: [] }

  // 1. List first, with each object's metadata (a compaction output's inputs). Whatever is
  //    written after this is not a candidate in this run, and an object missing from this
  //    listing was deleted before it.
  const objects: { key: string; uploaded: number; inputs?: string }[] = []
  for (const table of TABLES) {
    let cursor: string | undefined
    do {
      const page = await env.BUCKET.list({ prefix: `${cellOf(env)}/data/${table}/tenant=${tenant}/`, cursor, include: ['customMetadata'] })
      for (const o of page.objects) objects.push({ key: o.key, uploaded: o.uploaded.getTime(), inputs: o.customMetadata?.[COMPACTION_INPUTS_META] })
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  }
  out.listed = objects.length
  const present = new Set(objects.map((o) => o.key))
  await opts.hooks?.afterList?.(objects.map((o) => o.key))

  // 2. Then ask the ledger, in one consistent read per thousand objects: about the objects,
  //    and about every input of a compaction output among them that is no longer in R2.
  for (let i = 0; i < objects.length; i += 1000) {
    const chunk = objects.slice(i, i + 1000)
    const inputsOf = new Map<string, Awaited<ReturnType<typeof decodeCompactionInputs>>>()
    const ask = new Set(chunk.map((o) => o.key))
    for (const o of chunk) {
      if (!COMPACTED_FILE.test(o.key)) continue
      const d = await decodeCompactionInputs(o.key, o.inputs)
      inputsOf.set(o.key, d)
      if ('inputs' in d) for (const k of d.inputs) if (!present.has(k)) ask.add(k)
    }
    const check = await ledger.orphanCheck([...ask])
    const live = new Set(check.live)
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
        // `replace` admits an output only with EVERY input live. An input that is not live
        // and whose object is gone can never be live again: objects are deleted only after a
        // logged removal (purge) or once they can never be listed (this sweep), never while a
        // rebuild could bring the key back. So the output can never be listed, whoever
        // wrote it, adopted it or will, and however old it is. Anything else may be about to
        // become live (an adopted leftover: review R-2), and is kept.
        const d = inputsOf.get(o.key)!
        if ('unreadable' in d) out.kept.push({ key: o.key, why: 'unknown_inputs', detail: d.unreadable })
        else if (!d.inputs.some((k) => !present.has(k) && !live.has(k))) out.kept.push({ key: o.key, why: 'inputs_remain' })
        else if (age < compactGraceMs) out.kept.push({ key: o.key, why: 'young' })
        else doomed.push(o.key)
      } else {
        out.kept.push({ key: o.key, why: 'unknown_name' }) // not ours to judge
      }
    }
    await opts.hooks?.beforeDelete?.(doomed)
    if (doomed.length > 0) await env.BUCKET.delete(doomed)
    out.deleted.push(...doomed)
  }
  const uploaded = new Map(objects.map((o) => [o.key, o.uploaded]))
  for (const k of out.kept) {
    if (k.why === 'unknown_name' || k.why === 'unknown_inputs') continue
    out.waitingSince = Math.max(out.waitingSince ?? 0, uploaded.get(k.key) ?? 0)
  }
  return out
}
