import { TENANT_ID, type LoggedWatermark, type Table } from '../../contracts/ledger'
import { COMPACTION_INPUTS_META, DEFAULT_POLICY, decodeCompactionInputs } from '../../compact/src/compact'
import type { Ledger } from '../../ledger/src/ledger'
import type { Publisher } from '../../publisher/src/publisher'
import type { EnsureStreamResult } from '../../shard/src/shard'

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
 *                  its PUT): a flush file once its stream's LOGGED watermark covers it or a
 *                  newer incarnation's registration is LOGGED, a compaction output once one
 *                  of its inputs is gone for good. A flush file of the incarnation the ledger
 *                  names that waits past the grace makes it ask that stream's shard
 *                  (`ensureStream`): a shard that lost the stream starts and registers a fresh
 *                  one, after which the file is dead (spec F16; D61).
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
  /**
   * The shards (D61). The orphan sweep asks a shard about a stream whose flush files wait for a
   * unit that may never come (`ensureStream`). Absent: it does not ask, and those files wait
   * for the tenant's next write to that shard (spec F16, the leak this closes).
   */
  SHARD?: ShardGateNamespace
}

/** What the janitor asks of a shard (shard/src/shard.ts): `ensureStream`. */
export interface ShardGate {
  ensureStream(tenant: string): Promise<EnsureStreamResult>
}

/** The shards' namespace, as far as the janitor uses it: a shard is `idFromName(its exact name)`. */
export interface ShardGateNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): ShardGate
}

/** How long the sweep waits for a shard's `ensureStream` (which may wait up to its own registration timeout, 5 s). */
export const SHARD_GATE_TIMEOUT_MS = 10_000

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

  // Keys the ledger offers but the publisher holds back stay at the head of the ledger's answer
  // (lowest version first) until released, so each read asks for that many more, up to the
  // ledger's limit of 10,000: a held-back head never starves released keys behind it.
  let held = 0
  const offered = new Set<string>()
  while (deleted.length < maxKeys) {
    const want = Math.min(1000, maxKeys - deleted.length)
    const limit = Math.min(10_000, held + want)
    // The ledger decides: logged, older than the grace by its clock, not live.
    const batch = await ledger.deletable({ minAgeMs: graceMs, limit })
    const keys = batch.tombstones.map((t) => t.key)
    for (const k of keys) offered.add(k)
    const doomed = (released ? keys.filter((k) => released!.has(k)) : keys).slice(0, want)
    held = released ? keys.filter((k) => !released!.has(k)).length : 0
    waiting = batch.waiting + keys.length - doomed.length
    if (doomed.length === 0) {
      // Everything offered is held back: look further only while the ledger may have more.
      if (keys.length < limit || limit >= 10_000) break
      continue
    }
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
   * Shards asked about a stream whose flush files wait past the grace for a unit (D61; spec F16),
   * once per stream per run: what each answered, or why it could not (a shard of a release
   * before D61 has no `ensureStream`: review m-6). Their files are judged again by a later run.
   */
  ensured: { shard: string; incarnation?: number; registered?: boolean; error?: string }[]
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
 * about to be reported. (contracts/ledger.ts `orphanCheck`.)
 *
 * `orphanCheck` reports each stream's COMMITTED incarnation, the logged watermark of that
 * incarnation and (D61) `loggedIncarnation`, the newest incarnation whose registration is in
 * the logged prefix. Only the logged one counts: a registration that is committed but not
 * logged can be rolled back by a rebuild, after which a late `addUnit` of the older
 * incarnation is admitted again (spec/README.md F15). A ledger before D61 sends no
 * `loggedIncarnation`; then a newer incarnation counts only once its logged watermark is above
 * 0 (the log is a prefix of versions and a unit's version is above its stream's registration,
 * so that proves the registration is logged), as D30 built it.
 *
 * `w` is the stream as the ledger reports it, by its exact name (D38 makes `_` stand for `/`
 * in a key, so the match is one-to-one).
 */
function flushFileState(m: RegExpExecArray, logged: LoggedWatermark[]): { state: 'dead' | 'pending_unit' | 'unknown_stream'; w?: LoggedWatermark } {
  const [, shard, incText, , seqHiText] = m
  const inc = Number(incText)
  const w = logged.find((x) => x.shard.replaceAll('/', '_') === shard)
  if (!w) return { state: 'unknown_stream' }
  if (w.incarnation === inc && w.seq >= Number(seqHiText)) return { state: 'dead', w }
  const newer = w.loggedIncarnation !== undefined ? w.loggedIncarnation > inc : w.incarnation > inc && w.seq > 0
  return { state: newer ? 'dead' : 'pending_unit', w }
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
  const out: OrphanResult = { listed: 0, deleted: [], kept: [], ensured: [] }
  /** Streams to ask their shard about (exact shard names), after the deletions. */
  const ask = new Set<string>()

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
    const keysToCheck = new Set(chunk.map((o) => o.key))
    for (const o of chunk) {
      if (!COMPACTED_FILE.test(o.key)) continue
      const d = await decodeCompactionInputs(o.key, o.inputs)
      inputsOf.set(o.key, d)
      if ('inputs' in d) for (const k of d.inputs) if (!present.has(k)) keysToCheck.add(k)
    }
    const check = await ledger.orphanCheck([...keysToCheck])
    const live = new Set(check.live)
    const known = new Set([...check.live, ...check.tombstoned]) // tombstoned keys go through purgeTenant
    const doomed: string[] = []
    for (const o of chunk) {
      if (known.has(o.key)) continue
      const age = now - o.uploaded
      const flush = FLUSH_FILE.exec(o.key)
      if (flush) {
        const { state, w } = flushFileState(flush, check.logged)
        if (state !== 'dead') {
          out.kept.push({ key: o.key, why: state })
          // A file of the incarnation the ledger names, waiting past the grace for its unit: the
          // flush that wrote it may have died with the stream (the shard lost its storage), and
          // then nothing makes the ledger hear of a newer incarnation until the tenant writes to
          // that shard again. Ask the shard (spec F16).
          if (state === 'pending_unit' && w && w.incarnation === Number(flush[2]) && age >= graceMs) ask.add(w.shard)
        } else if (age < graceMs) out.kept.push({ key: o.key, why: 'young' })
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
  // 3. Ask each such stream's shard to hold a registered stream: one holding the stream changes
  //    nothing; one that lost it starts a fresh incarnation and registers it, which makes the
  //    old incarnation's files dead once that registration is logged, at a later run. Failures
  //    keep the files and go on (a shard of a release before D61 has no `ensureStream`).
  if (env.SHARD) {
    for (const shard of [...ask].sort()) {
      try {
        const r = await within(env.SHARD.get(env.SHARD.idFromName(shard)).ensureStream(tenant), SHARD_GATE_TIMEOUT_MS, `shard ${shard}`)
        out.ensured.push({ shard, incarnation: r.incarnation, registered: r.registered })
      } catch (e) {
        const why = (e instanceof Error ? e.message : String(e)).slice(0, 300)
        console.error(`janitor: could not ask shard ${shard} about ${tenant}'s stream (${why}); its flush files are kept`)
        out.ensured.push({ shard, error: why })
      }
    }
  }
  const uploaded = new Map(objects.map((o) => [o.key, o.uploaded]))
  for (const k of out.kept) {
    if (k.why === 'unknown_name' || k.why === 'unknown_inputs') continue
    out.waitingSince = Math.max(out.waitingSince ?? 0, uploaded.get(k.key) ?? 0)
  }
  return out
}
