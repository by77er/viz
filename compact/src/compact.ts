import type { EncodedFile, Engine } from '../../contracts/engine'
import { TENANT_ID, type FileEntry, type LiveFile, type Plan, type Table } from '../../contracts/ledger'
import { putFile } from '../../flush/src/flush'
import { hex } from '../../flush/src/keys'
import type { Ledger } from '../../ledger/src/ledger'

/**
 * Compaction: the small per-segment files of one tenant become fewer, larger, sorted files
 * (design/DESIGN.md §5.2). One call of `compactStep` does ONE merge:
 *
 *   1. ledger.plan (both tables, one version)   the live files
 *   2. chooseJob                                the policy below picks the inputs
 *   3. GET the inputs                           in parallel, at most six at a time
 *   4. engine.mergeFiles, twice                 samples inputs → one samples file, series → one series file
 *   5. PUT both outputs, in parallel            content-hashed keys, If-None-Match: *
 *   6. ledger.replace                           ONE call: remove every input of both tables, add both outputs
 *
 * Nothing is remembered between steps: every step plans from the ledger, so steps can run
 * in any order, twice at once, or stop anywhere. What makes that safe:
 *
 *   - `replace` succeeds only if EVERY input is still live, and swaps both tables in one
 *     transaction. A samples file is therefore never listed without the series file it was
 *     merged with, and a file that retention or another merge removed cannot come back.
 *   - Output keys hold a hash of the input keys and of the bytes: the same inputs give the
 *     same keys and the same bytes, so a repeat finds its objects and its `replace` is
 *     answered as a replay.
 *   - `conflict` (an input is gone): the outputs are deleted and the caller plans again.
 *     This step can never make them live, because their key names an input that will not
 *     return. Only if the ledger knows them (an identical step won, and they are live or,
 *     removed since, tombstoned) are they left alone: then they are not this step's.
 *   - A step that has run longer than `maxStepMs` does not call `replace`. The orphan
 *     sweep (janitor/) deletes unreferenced compaction outputs only when they are much
 *     older than that, so it can never delete an output a step is about to make live.
 *
 * Policy (`chooseJob`), files being (samples, series) pairs:
 *
 *   closed day    A UTC day is closed `closeAfterMs` after it ends (the accept window, plus
 *                 time for the last segments to be flushed). Its pairs below level 2, and
 *                 level-2 pairs under `smallL2Bytes`, are merged in time order into
 *                 level-2 pairs, as many per merge as fit the budget. A late flush file for
 *                 a closed day is folded in the same way.
 *   open hour     Pairs are bucketed by the UTC hour of their newest sample. A bucket is
 *                 merged into a level-1 pair when it has `minL0Files` level-0 pairs, or
 *                 when it has at least one and its newest sample is `maxL0AgeMs` old (the
 *                 hour has gone quiet). The bucket's existing level-1 pairs are merged in
 *                 too, so an hour converges to one pair while it fits the budget.
 *   budget        A merge reads at most `maxInputBytes` and `maxInputPairs` pairs; both are
 *                 set from measured WASM memory (README). A pair that alone exceeds the
 *                 budget is left as it is.
 *
 * The level-1 files are clustered by hour, not hour-pure: a pair's bucket is the hour of its
 * newest row, and late rows travel with it. Time pruning uses each file's own range.
 *
 * Precedence (contracts/ledger.ts `LiveFile`): when two files hold the same (series, ts),
 * the one with the higher precedence wins. Inputs are merged in ascending precedence, so the
 * output keeps every row's latest write, and the output covers its inputs' range. A group is
 * chosen only if no other live file of the day that overlaps it in time ranks inside that
 * range ("jumping over" it would let an older row in the output beat that file's newer
 * one); the ledger refuses such a swap anyway (`conflict` with `blocking`). Within an open
 * hour that can leave files unmerged until their day closes; a closed day's merges are
 * runs in precedence order, which never jump over anything that overlaps them.
 */

export interface CompactEnv {
  LEDGER: DurableObjectNamespace<Ledger>
  BUCKET: R2Bucket
  CELL?: string
}

export interface CompactPolicy {
  /** K: merge an hour bucket once it holds this many level-0 pairs. */
  minL0Files: number
  /** M: or once its newest sample is this old. */
  maxL0AgeMs: number
  /** A day is closed this long after it ends. Must exceed the accept window. */
  closeAfterMs: number
  /** Bytes (samples + series) one merge may read. */
  maxInputBytes: number
  /** Pairs one merge may read: each open input holds a decoded row group in memory. */
  maxInputPairs: number
  /** Level-2 pairs smaller than this are merged again with their neighbours. */
  smallL2Bytes: number
  /** A step that has run this long gives up before `replace`. */
  maxStepMs: number
}

export const DEFAULT_POLICY: CompactPolicy = {
  minL0Files: 4,
  maxL0AgeMs: 10 * 60_000,
  closeAfterMs: 2 * 3_600_000,
  maxInputBytes: 16 << 20,
  maxInputPairs: 8,
  smallL2Bytes: 4 << 20,
  maxStepMs: 5 * 60_000,
}

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** A samples file and the series file written with it. They enter and leave the ledger together. */
export interface Pair {
  samples: LiveFile
  series: LiveFile
  day: string
  level: number
  bytes: number
  minTs: number
  maxTs: number
  /** The samples file's precedence range (the series file's is the same version range: contracts/ledger.ts `LiveFile`). */
  precedenceLow: number
  precedence: number
}

/** A live file a merge must not jump over in precedence, if it overlaps the merge in time. */
export interface Span {
  key: string
  day: string
  minTs: number
  maxTs: number
  precedenceLow: number
  precedence: number
}

const spanOf = (f: LiveFile): Span => ({ key: f.key, day: f.day, minTs: f.minTs, maxTs: f.maxTs, precedenceLow: f.precedenceLow, precedence: f.precedence })
export const byPrecedence = (a: Pair, b: Pair): number => a.precedence - b.precedence || (a.samples.key < b.samples.key ? -1 : a.samples.key > b.samples.key ? 1 : 0)

/**
 * Would merging `group` put its precedence range across a file outside it that could hold
 * the same rows (same day, overlapping time range)? Then an older row of the group would
 * beat that file's newer one. `universe` is every live file of the day.
 */
export function jumpsOver(group: Pair[], universe: Span[]): string[] {
  const lo = Math.min(...group.map((p) => p.minTs))
  const hi = Math.max(...group.map((p) => p.maxTs))
  const plo = Math.min(...group.map((p) => p.precedenceLow))
  const phi = Math.max(...group.map((p) => p.precedence))
  const inside = new Set(group.flatMap((p) => [p.samples.key, p.series.key]))
  return universe.filter((o) => !inside.has(o.key) && o.maxTs >= lo && o.minTs <= hi && o.precedence >= plo && o.precedenceLow <= phi).map((o) => o.key)
}

export interface Job {
  day: string
  /** Level of the output. */
  level: 1 | 2
  /** For level 1: the UTC hour (0–23) of the bucket. */
  hour?: number
  inputs: Pair[]
  why: 'closed_day' | 'l0_count' | 'l0_age'
}

/**
 * What a samples key and its series key have in common: the key without the table and
 * without the content hash. Flush names both files of a unit after the segment, and
 * compaction names both outputs of a merge after its inputs.
 */
export const pairStem = (key: string): string => key.replace(/\/metric_(samples|series)\//, '/T/').replace(/-[0-9a-f]{8}\.parquet$/, '')

export function pairFiles(samples: LiveFile[], series: LiveFile[]): { pairs: Pair[]; unpaired: string[] } {
  const byStem = new Map<string, LiveFile>()
  for (const f of series) byStem.set(pairStem(f.key), f)
  const pairs: Pair[] = []
  const unpaired: string[] = []
  for (const s of samples) {
    const stem = pairStem(s.key)
    const r = byStem.get(stem)
    if (!r || r.day !== s.day || r.level !== s.level) {
      unpaired.push(s.key)
      continue
    }
    byStem.delete(stem)
    pairs.push({ samples: s, series: r, day: s.day, level: s.level, bytes: s.bytes + r.bytes, minTs: s.minTs, maxTs: s.maxTs, precedenceLow: s.precedenceLow, precedence: s.precedence })
  }
  for (const r of byStem.values()) unpaired.push(r.key)
  return { pairs, unpaired: unpaired.sort() }
}

const dayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`)

/**
 * The group a merge starting at `candidates[start]` takes: candidates in ascending
 * precedence, each added only if the group still fits the budget and still jumps over no
 * live file that overlaps it in time (`jumpsOver`). Empty if the first pair alone is over
 * the budget.
 */
function grow(candidates: Pair[], start: number, universe: Span[], policy: CompactPolicy): Pair[] {
  const first = candidates[start]!
  if (first.bytes > policy.maxInputBytes) return []
  const group = [first]
  let bytes = first.bytes
  for (let j = start + 1; j < candidates.length && group.length < policy.maxInputPairs; j++) {
    const p = candidates[j]!
    if (bytes + p.bytes > policy.maxInputBytes) continue
    if (jumpsOver([...group, p], universe).length > 0) continue
    group.push(p)
    bytes += p.bytes
  }
  return group
}

/**
 * The next merge to run, or null, and when to look again if nothing changes (`nextDueAt`:
 * the earliest moment a bucket goes quiet or a day closes; null if time alone will never
 * make a job). `strays` are live files that are not in a pair: a merge must not jump over
 * them either.
 */
export function chooseJob(pairs: Pair[], now: number, policy: CompactPolicy = DEFAULT_POLICY, strays: Span[] = []): { job: Job | null; nextDueAt: number | null } {
  const days = new Map<string, Pair[]>()
  for (const p of pairs) days.set(p.day, [...(days.get(p.day) ?? []), p])
  let nextDueAt: number | null = null
  const due = (t: number) => {
    if (t > now) nextDueAt = nextDueAt === null ? t : Math.min(nextDueAt, t)
  }

  for (const day of [...days.keys()].sort()) {
    const list = days.get(day)!.sort(byPrecedence)
    const universe = [...list.flatMap((p) => [spanOf(p.samples), spanOf(p.series)]), ...strays.filter((x) => x.day === day)]
    const closesAt = dayStart(day) + DAY_MS + policy.closeAfterMs
    if (now >= closesAt) {
      // Closed day: everything below level 2, and small level-2 pairs, in precedence order.
      const candidates = list.filter((p) => p.level < 2 || p.bytes < policy.smallL2Bytes)
      for (let i = 0; i < candidates.length; i++) {
        const group = grow(candidates, i, universe, policy)
        // Worth doing if it merges something, or lifts a lower-level pair to level 2.
        if (group.length >= 2 || (group.length === 1 && group[0]!.level < 2)) return { job: { day, level: 2, inputs: group, why: 'closed_day' }, nextDueAt: null }
      }
      continue
    }
    if (list.some((p) => p.level < 2)) due(closesAt)

    // Open day: hour buckets of level 0 and 1.
    const buckets = new Map<number, Pair[]>()
    for (const p of list) {
      if (p.level > 1) continue
      const hour = Math.floor((p.maxTs - dayStart(day)) / HOUR_MS)
      buckets.set(hour, [...(buckets.get(hour) ?? []), p])
    }
    for (const hour of [...buckets.keys()].sort((a, b) => a - b)) {
      const bucket = buckets.get(hour)!
      const l0 = bucket.filter((p) => p.level === 0)
      if (l0.length === 0 || bucket.length < 2) continue
      const quietAt = Math.max(...l0.map((p) => p.maxTs)) + policy.maxL0AgeMs
      const why = l0.length >= policy.minL0Files ? 'l0_count' : now >= quietAt ? 'l0_age' : null
      if (why === null) {
        due(quietAt)
        continue
      }
      // The hour's pairs in precedence order; a group must merge at least one level-0 pair.
      for (let i = 0; i < bucket.length; i++) {
        const inputs = grow(bucket, i, universe, policy)
        if (inputs.length >= 2 && inputs.some((p) => p.level === 0)) return { job: { day, level: 1, hour, inputs, why }, nextDueAt: null }
      }
    }
  }
  return { job: null, nextDueAt }
}

export type StepResult =
  /** Nothing to merge now. */
  | { status: 'idle'; nextDueAt: number | null; unpaired: string[] }
  | { status: 'merged'; job: JobSummary; version: number; outputs: FileEntry[]; put: ('created' | 'exists')[] }
  /**
   * The live set changed since the plan: an input was no longer live (`missing`), or another
   * merge made a file the outputs would jump over in precedence (`blocking`). The outputs
   * were deleted unless the ledger knows them. Plan again.
   */
  | { status: 'conflict'; job: JobSummary; missing: string[]; blocking: string[]; discarded: string[] }
  /** The ledger refused the swap as malformed, the merge lost rows, or the step ran too long. Nothing changed. */
  | { status: 'error'; job: JobSummary; reason: 'invalid' | 'row_count' | 'too_slow'; detail: string }

export interface JobSummary {
  day: string
  level: number
  hour?: number
  why: Job['why']
  inputs: string[]
  inputBytes: number
  inputRows: number
}

export interface StepOptions {
  policy?: Partial<CompactPolicy>
  /** Injected clock for the policy (tests). The step deadline always uses the real clock. */
  now?: number
  /** Fault-injection points. A hook that throws stands for a crash there. */
  hooks?: {
    afterPlan?(job: Job): void | Promise<void>
    afterPut?(outputs: FileEntry[]): void | Promise<void>
  }
}

async function consistentPlans(ledger: DurableObjectStub<Ledger>): Promise<{ samples: Plan; series: Plan }> {
  for (let i = 0; i < 10; i++) {
    const samples = await ledger.plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
    const series = await ledger.plan({ table: 'metric_series', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
    if (samples.version === series.version && samples.ledgerIncarnation === series.ledgerIncarnation) return { samples, series }
  }
  throw new Error('compact: the ledger kept changing between the two plan calls')
}

/** Whole objects, at most six requests in flight (the connection budget of one invocation). */
async function fetchAll(bucket: R2Bucket, keys: string[]): Promise<Uint8Array[]> {
  const out: Uint8Array[] = new Array(keys.length)
  for (let i = 0; i < keys.length; i += 6) {
    await Promise.all(
      keys.slice(i, i + 6).map(async (key, j) => {
        const o = await bucket.get(key)
        if (!o) throw new Error(`compact: the ledger lists ${key} but it is not in R2`)
        out[i + j] = new Uint8Array(await o.arrayBuffer())
      }),
    )
  }
  return out
}

/**
 * Object key of a compaction output (contracts/TABLES.md, "Object keys"):
 *
 *   {cell}/data/{table}/tenant={tenant}/day={day}/L{level}-{span}-{inputs16}-{hash8}.parquet
 *
 * `span` is `h{HH}` for a level-1 hour bucket and `d` for a level-2 day file; `inputs16` is
 * the first 16 hex characters of the SHA-256 of the input keys of BOTH tables (sorted,
 * newline-separated), the same in the samples and the series key, which is what pairs them.
 */
export function compactedKey(p: { cell: string; table: Table; tenant: string; day: string; level: number; hour?: number; inputs16: string; sha256Hex: string }): string {
  if (!TENANT_ID.test(p.tenant)) throw new Error('compact: tenant id must match [A-Za-z0-9_-]{1,64}')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.day) || !/^[0-9a-f]{16}$/.test(p.inputs16) || !/^[0-9a-f]{64}$/.test(p.sha256Hex)) throw new Error('compact: bad key part')
  const span = p.level === 1 ? `h${String(p.hour ?? 0).padStart(2, '0')}` : 'd'
  return `${p.cell}/data/${p.table}/tenant=${p.tenant}/day=${p.day}/L${p.level}-${span}-${p.inputs16}-${p.sha256Hex.slice(0, 8)}.parquet`
}

const sha256 = (bytes: Uint8Array): Promise<ArrayBuffer> => crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)

export async function compactStep(env: CompactEnv, engine: Engine, tenant: string, opts: StepOptions = {}): Promise<StepResult> {
  if (!TENANT_ID.test(tenant)) throw new Error('compact: tenant id must match [A-Za-z0-9_-]{1,64}')
  const started = Date.now()
  const policy = { ...DEFAULT_POLICY, ...opts.policy }
  const cell = env.CELL || 'cell-0'
  const ledger = env.LEDGER.get(env.LEDGER.idFromName(tenant))

  const plans = await consistentPlans(ledger)
  const { pairs, unpaired } = pairFiles(plans.samples.files, plans.series.files)
  const stray = new Set(unpaired)
  const strays = [...plans.samples.files, ...plans.series.files].filter((f) => stray.has(f.key)).map(spanOf)
  const { job, nextDueAt } = chooseJob(pairs, opts.now ?? started, policy, strays)
  if (!job) return { status: 'idle', nextDueAt, unpaired }
  await opts.hooks?.afterPlan?.(job)

  // Inputs in ascending precedence, the order a query reads them in (the ledger's plan): the
  // engine lets the later file win, so every row of the output is its latest write.
  const ordered = [...job.inputs].sort(byPrecedence)
  const inSamples = ordered.map((p) => p.samples)
  const inSeries = ordered.map((p) => p.series)
  // The key lists (for `remove` and the output name) are sorted by key, per contracts/TABLES.md.
  const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  const summary: JobSummary = {
    day: job.day,
    level: job.level,
    ...(job.hour !== undefined ? { hour: job.hour } : {}),
    why: job.why,
    inputs: [...inSamples.map((f) => f.key).sort(byKey), ...inSeries.map((f) => f.key).sort(byKey)],
    inputBytes: job.inputs.reduce((a, p) => a + p.bytes, 0),
    inputRows: inSamples.reduce((a, f) => a + f.rows, 0),
  }

  // One table at a time, so only one table's inputs are in memory with the engine's copy.
  const merged: EncodedFile[] = []
  for (const [table, files] of [['metric_samples', inSamples], ['metric_series', inSeries]] as const) {
    const all = await fetchAll(env.BUCKET, files.map((f) => f.key))
    const out = engine.mergeFiles(table, table === 'metric_series' ? all.slice(0, 1) : all)
    // A merge only removes duplicates: it cannot have more rows than its inputs together,
    // nor fewer than its largest input. Anything else is a bug; publish nothing.
    const total = files.reduce((a, f) => a + f.rows, 0)
    const largest = Math.max(...files.map((f) => f.rows))
    if (out.rows > total || out.rows < largest || out.day !== job.day || out.table !== table) {
      return { status: 'error', job: summary, reason: 'row_count', detail: `${table}: merged ${out.rows} rows of day ${out.day} from inputs of ${total} rows (largest ${largest}) of day ${job.day}` }
    }
    merged.push(out)
  }

  const inputs16 = hex(await sha256(new TextEncoder().encode(summary.inputs.join('\n')))).slice(0, 16)
  const outputs: FileEntry[] = []
  const digests: ArrayBuffer[] = []
  for (const f of merged) {
    const digest = await sha256(f.bytes)
    const key = compactedKey({ cell, table: f.table, tenant, day: f.day, level: job.level, hour: job.hour, inputs16, sha256Hex: hex(digest) })
    outputs.push({ table: f.table, day: f.day, key, bytes: f.bytes.byteLength, rows: f.rows, minTs: f.minTs, maxTs: f.maxTs, level: job.level, index: f.index })
    digests.push(digest)
  }
  // Both PUTs at once: a PUT costs about the same however large it is.
  const put = await Promise.all(merged.map((f, i) => putFile(env.BUCKET, outputs[i]!.key, f.bytes, digests[i]!)))
  await opts.hooks?.afterPut?.(outputs)

  if (Date.now() - started > policy.maxStepMs) {
    return { status: 'error', job: summary, reason: 'too_slow', detail: `the step took longer than ${policy.maxStepMs} ms; its outputs are left for the orphan sweep` }
  }
  // ONE replace for both tables: the series file and the samples file stay paired.
  const r = await ledger.replace({ remove: summary.inputs, add: outputs })
  if (r.status === 'ok') return { status: 'merged', job: summary, version: r.version, outputs, put }
  if (r.status === 'invalid') return { status: 'error', job: summary, reason: 'invalid', detail: r.reason }
  // Conflict: an input is gone for good, so these outputs can never be listed by THIS step.
  // Delete them, unless the ledger (asked once more, in one read) knows them. Keys are a
  // function of the inputs, so an identical step may have made the same objects live; if a
  // later merge or retention has since removed them they are tombstoned, a reader holding
  // an older plan may still be reading them, and only the janitor may delete them, after
  // the grace. Either way they are not this step's to delete.
  const keys = outputs.map((f) => f.key)
  const check = await ledger.orphanCheck(keys)
  const discarded = check.live.length === 0 && check.tombstoned.length === 0 ? keys : []
  if (discarded.length > 0) await env.BUCKET.delete(discarded)
  return { status: 'conflict', job: summary, missing: r.missing, blocking: r.blocking ?? [], discarded }
}

export interface CompactRun {
  steps: StepResult[]
  merged: number
  /** True if the run stopped because of `maxSteps` while there was still work. */
  more: boolean
  nextDueAt: number | null
}

/** Run steps until there is nothing to merge, an error, or `maxSteps`. */
export async function compactTenant(env: CompactEnv, engine: Engine, tenant: string, opts: StepOptions & { maxSteps?: number } = {}): Promise<CompactRun> {
  const maxSteps = opts.maxSteps ?? 8
  const run: CompactRun = { steps: [], merged: 0, more: false, nextDueAt: null }
  for (let i = 0; i < maxSteps; i++) {
    const r = await compactStep(env, engine, tenant, opts)
    run.steps.push(r)
    if (r.status === 'idle') {
      run.nextDueAt = r.nextDueAt
      return run
    }
    if (r.status === 'merged') run.merged++
    if (r.status === 'error') return run
  }
  run.more = true
  return run
}
