import type { EncodedFile, EncodedSignalFile, Engine } from '../../contracts/engine'
import { TENANT_ID, dataKeyPrefix, type FileEntry, type LedgerTable, type LiveFile, type Plan, type SignalTable, type Table } from '../../contracts/ledger'
import type { SignalMergeEngine } from '../../engine/wasm/js/index'
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
 *   5. PUT both outputs, in parallel            content-hashed keys, If-None-Match: *, each
 *                                               carrying the list of its inputs (R2 metadata)
 *   6. ledger.replace                           ONE call: remove every input of both tables, add both outputs
 *
 * Nothing is remembered between steps: every step plans from the ledger, so steps can run
 * in any order, twice at once, or stop anywhere. What makes that safe:
 *
 *   - `replace` succeeds only if EVERY input is still live, and swaps both tables in one
 *     transaction. A samples file is therefore never listed without the series file it was
 *     merged with, and a file that retention or another merge removed cannot come back.
 *   - Output keys hold a hash of the input keys and of the bytes: the same inputs give the
 *     same keys and the same bytes, so a repeat finds its objects (`exists`, it ADOPTS them)
 *     and its `replace` is answered as a replay.
 *   - No step ever deletes an output, not even on `conflict`: an adopted or shared object may
 *     be about to become live through another step (spec/README.md F14). Unreferenced outputs
 *     are the orphan sweep's (janitor/), which deletes one only when an input of it is gone
 *     for good (not live, and its object deleted, which happens only after a logged removal).
 *     `replace` needs every input live, so such an output can never be listed again. No clock
 *     is involved: an output adopted by a retry, however old, is safe (review R-2).
 *   - A step that has run longer than `maxStepMs` does not call `replace` (bounded work per
 *     step; the sweep keeps an age floor of twice that, which is no longer what makes it safe).
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
 * Spans and logs (contracts/TRACES.md and LOGS.md, "Compaction"): when the metric tables have
 * nothing to merge, the step looks at `spans`, `trace_index` and `logs` in turn, each table on
 * its own (a unit is one file; nothing pairs them), with the same policy, budget, keys, inputs
 * record and `replace`. `spans` files are hour-pure and stay so: a span merge takes files of one
 * hour, and a closed day's spans become one level-2 file per hour. `trace_index` and `logs`
 * merge per day as metrics do. The engine merges them (`mergeSignalFiles`, engine/wasm ABI 4);
 * an engine without it compacts metrics only.
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

/**
 * What a merge takes or leaves whole: files that enter and leave the ledger together. A metric
 * pair (two files), or one span, trace_index or log file.
 */
export interface Unit {
  files: LiveFile[]
  /** The key that orders units of equal precedence (a pair's samples key). */
  key: string
  day: string
  level: number
  bytes: number
  minTs: number
  maxTs: number
  /** The precedence range (a pair's files share one: contracts/ledger.ts `LiveFile`). */
  precedenceLow: number
  precedence: number
  /** `spans` only: the hour partition (0 to 23) the file lies in. A merge never crosses it. */
  hour?: number
}

/** A samples file and the series file written with it. They enter and leave the ledger together. */
export interface Pair extends Unit {
  samples: LiveFile
  series: LiveFile
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
export const byPrecedence = (a: Unit, b: Unit): number => a.precedence - b.precedence || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

/**
 * Would merging `group` put its precedence range across a file outside it that could hold
 * the same rows (same day, overlapping time range)? Then an older row of the group would
 * beat that file's newer one. `universe` is every live file of the day.
 */
export function jumpsOver(group: Unit[], universe: Span[]): string[] {
  const lo = Math.min(...group.map((p) => p.minTs))
  const hi = Math.max(...group.map((p) => p.maxTs))
  const plo = Math.min(...group.map((p) => p.precedenceLow))
  const phi = Math.max(...group.map((p) => p.precedence))
  const inside = new Set(group.flatMap((p) => p.files.map((f) => f.key)))
  return universe.filter((o) => !inside.has(o.key) && o.maxTs >= lo && o.minTs <= hi && o.precedence >= plo && o.precedenceLow <= phi).map((o) => o.key)
}

export interface Job<T extends Unit = Pair> {
  day: string
  /** Level of the output. */
  level: 1 | 2
  /** For level 1: the UTC hour (0–23) of the bucket. For `spans`, at both levels: the hour partition. */
  hour?: number
  inputs: T[]
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
    pairs.push({ samples: s, series: r, files: [s, r], key: s.key, day: s.day, level: s.level, bytes: s.bytes + r.bytes, minTs: s.minTs, maxTs: s.maxTs, precedenceLow: s.precedenceLow, precedence: s.precedence })
  }
  for (const r of byStem.values()) unpaired.push(r.key)
  return { pairs, unpaired: unpaired.sort() }
}

const dayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`)

/** The hour partition of a `spans` key (`…/day=D/hour=HH/…`), or undefined for another table's. */
export const spanHourOf = (key: string): number | undefined => {
  const m = /\/data\/spans\/tenant=[^/]+\/day=\d{4}-\d{2}-\d{2}\/hour=(\d\d)\//.exec(key)
  return m ? Number(m[1]) : undefined
}

/** One file of a span or log table as a unit of the policy. */
export const signalUnit = (f: LiveFile): Unit => ({ files: [f], key: f.key, day: f.day, level: f.level, bytes: f.bytes, minTs: f.minTs, maxTs: f.maxTs, precedenceLow: f.precedenceLow, precedence: f.precedence, ...(f.table === 'spans' ? { hour: spanHourOf(f.key) ?? Math.floor((f.minTs - dayStart(f.day)) / HOUR_MS) } : {}) })

/**
 * The group a merge starting at `candidates[start]` takes: candidates in ascending
 * precedence, each added only if the group still fits the budget and still jumps over no
 * live file that overlaps it in time (`jumpsOver`). Empty if the first pair alone is over
 * the budget.
 */
function grow<T extends Unit>(candidates: T[], start: number, universe: Span[], policy: CompactPolicy): T[] {
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
export function chooseJob<T extends Unit = Pair>(pairs: T[], now: number, policy: CompactPolicy = DEFAULT_POLICY, strays: Span[] = []): { job: Job<T> | null; nextDueAt: number | null } {
  const days = new Map<string, T[]>()
  for (const p of pairs) days.set(p.day, [...(days.get(p.day) ?? []), p])
  let nextDueAt: number | null = null
  const due = (t: number) => {
    if (t > now) nextDueAt = nextDueAt === null ? t : Math.min(nextDueAt, t)
  }

  for (const day of [...days.keys()].sort()) {
    const list = days.get(day)!.sort(byPrecedence)
    const universe = [...list.flatMap((p) => p.files.map(spanOf)), ...strays.filter((x) => x.day === day)]
    const closesAt = dayStart(day) + DAY_MS + policy.closeAfterMs
    if (now >= closesAt) {
      // Closed day: everything below level 2, and small level-2 pairs, in precedence order; for
      // `spans`, each hour partition on its own (a merge never crosses an hour).
      const partitions = new Map<number | undefined, T[]>()
      for (const p of list.filter((p) => p.level < 2 || p.bytes < policy.smallL2Bytes)) partitions.set(p.hour, [...(partitions.get(p.hour) ?? []), p])
      for (const hour of [...partitions.keys()].sort((a, b) => (a ?? -1) - (b ?? -1))) {
        const candidates = partitions.get(hour)!
        for (let i = 0; i < candidates.length; i++) {
          const group = grow(candidates, i, universe, policy)
          // Worth doing if it merges something, or lifts a lower-level pair to level 2.
          if (group.length >= 2 || (group.length === 1 && group[0]!.level < 2)) return { job: { day, level: 2, ...(hour !== undefined ? { hour } : {}), inputs: group, why: 'closed_day' }, nextDueAt: null }
        }
      }
      continue
    }
    if (list.some((p) => p.level < 2)) due(closesAt)

    // Open day: hour buckets of level 0 and 1 (a `spans` file's bucket is its hour partition;
    // a trace_index file's newest end can lie in a later day: its bucket is then hour 23).
    const buckets = new Map<number, T[]>()
    for (const p of list) {
      if (p.level > 1) continue
      const hour = p.hour ?? Math.min(23, Math.floor((p.maxTs - dayStart(day)) / HOUR_MS))
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
   * are left for the orphan sweep (never deleted by the step: spec/README.md F14). Plan again.
   */
  | { status: 'conflict'; job: JobSummary; missing: string[]; blocking: string[] }
  /**
   * The ledger refused the swap as malformed, the merge lost rows, the step ran too long, or
   * the input names do not fit in the outputs' metadata (`too_many_inputs`). Nothing changed.
   */
  | { status: 'error'; job: JobSummary; reason: 'invalid' | 'row_count' | 'too_slow' | 'too_many_inputs'; detail: string }

export interface JobSummary {
  /** For a merge of a span or log table: which (a metric merge names both metric tables in `inputs`). */
  table?: SignalTable
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
    afterPlan?(job: Job<Unit>): void | Promise<void>
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
export function compactedKey(p: { cell: string; table: LedgerTable; tenant: string; day: string; level: number; hour?: number; inputs16: string; sha256Hex: string }): string {
  if (!TENANT_ID.test(p.tenant)) throw new Error('compact: tenant id must match [A-Za-z0-9_-]{1,64}')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.day) || !/^[0-9a-f]{16}$/.test(p.inputs16) || !/^[0-9a-f]{64}$/.test(p.sha256Hex)) throw new Error('compact: bad key part')
  // `spans` (contracts/TRACES.md, "Compaction"): under its hour, named after it at both levels.
  if (p.table === 'spans' && (p.hour === undefined || !Number.isInteger(p.hour) || p.hour < 0 || p.hour > 23)) throw new Error('compact: a spans output needs its hour')
  const hh = String(p.hour ?? 0).padStart(2, '0')
  const span = p.table === 'spans' || p.level === 1 ? `h${hh}` : 'd'
  return `${dataKeyPrefix(p.cell, p.table, p.tenant, p.day, p.table === 'spans' ? p.hour : undefined)}L${p.level}-${span}-${p.inputs16}-${p.sha256Hex.slice(0, 8)}.parquet`
}

const sha256 = (bytes: Uint8Array): Promise<ArrayBuffer> => crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)

/** `inputs16` of a merge: the first 16 hex characters of the SHA-256 of its input keys, as listed in `JobSummary.inputs`. */
export const inputsHash16 = async (inputs: readonly string[]): Promise<string> => hex(await sha256(new TextEncoder().encode(inputs.join('\n')))).slice(0, 16)

/**
 * What a compaction output was made from, kept with the object as R2 custom metadata under
 * `COMPACTION_INPUTS_META` (format `r2.compaction-inputs` v1, `FORMATS` in src/formats.ts):
 *
 *   {"v":1,"inputs":["<cell>/data/metric_samples/tenant=…/day=…/L0-….parquet", …]}
 *
 * The keys in the order their hash is the key's `inputs16` (samples keys sorted, then series
 * keys sorted). The orphan sweep (janitor/) reads it to delete an unreferenced output only
 * once one of its inputs is gone for good: `replace` needs every input live, so such an
 * output can never be listed, whoever wrote it and however old it is (review R-2).
 */
export const COMPACTION_INPUTS_META = 'viz-inputs'
export const COMPACTION_INPUTS_VERSION = 1
/** R2 allows 8,192 bytes of object metadata (developers.cloudflare.com/r2/platform/limits/); this leaves room. */
export const COMPACTION_INPUTS_MAX_BYTES = 6144

export const encodeCompactionInputs = (inputs: readonly string[]): string => JSON.stringify({ v: COMPACTION_INPUTS_VERSION, inputs })

/**
 * The inputs of the compaction output `key`, or why they cannot be known. Refuses (returns a
 * reason) for an unknown version, for keys outside the output's own tenant and day, and for a
 * list whose hash is not the key's `inputs16`: a reader that cannot tell must keep the object.
 */
export async function decodeCompactionInputs(key: string, meta: string | undefined): Promise<{ inputs: string[] } | { unreadable: string }> {
  const m = /^(.+)\/data\/(metric_samples|metric_series|spans|trace_index|logs)\/tenant=([A-Za-z0-9_-]{1,64})\/day=(\d{4}-\d{2}-\d{2})\/(?:hour=(\d\d)\/)?L[1-9]\d*-(?:h\d\d|d)-([0-9a-f]{16})-[0-9a-f]{8}\.parquet$/.exec(key)
  if (!m || (m[2] === 'spans') !== (m[5] !== undefined)) return { unreadable: 'not a compaction output key' }
  const [, cell, table, tenant, day, hour, inputs16] = m
  if (meta === undefined) return { unreadable: 'no inputs recorded' }
  let rec: { v?: unknown; inputs?: unknown }
  try {
    rec = JSON.parse(meta) as typeof rec
  } catch {
    return { unreadable: 'inputs record is not JSON' }
  }
  if (typeof rec !== 'object' || rec === null) return { unreadable: 'inputs record is not an object' }
  if (rec.v !== COMPACTION_INPUTS_VERSION) return { unreadable: `inputs record version ${JSON.stringify(rec.v)}; this code reads ${COMPACTION_INPUTS_VERSION}` }
  const inputs = rec.inputs
  // A metric output's inputs are of both metric tables; a span or log output's of its own table
  // (and, for `spans`, its own hour): always this tenant and day.
  const prefixes = table!.startsWith('metric_')
    ? (['metric_samples', 'metric_series'] as const).map((t) => dataKeyPrefix(cell!, t, tenant!, day!))
    : [dataKeyPrefix(cell!, table as SignalTable, tenant!, day!, hour === undefined ? undefined : Number(hour))]
  if (!Array.isArray(inputs) || inputs.length === 0 || !inputs.every((k) => typeof k === 'string' && prefixes.some((p) => k.startsWith(p) && !k.slice(p.length).includes('/')))) {
    return { unreadable: 'inputs are not keys of this tenant and day' }
  }
  if ((await inputsHash16(inputs as string[])) !== inputs16) return { unreadable: 'inputs do not hash to the key' }
  return { inputs: inputs as string[] }
}

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
  if (!job) {
    // Nothing for the metric tables: the span and log tables, each on its own.
    const signals = signalEngine(engine)
    let due = nextDueAt
    if (signals) {
      for (const table of SIGNAL_TABLES) {
        const r = await signalStep(env, signals, ledger, tenant, table, cell, policy, started, opts)
        if (r.status !== 'idle') return r
        if (r.nextDueAt !== null) due = due === null ? r.nextDueAt : Math.min(due, r.nextDueAt)
      }
    }
    return { status: 'idle', nextDueAt: due, unpaired }
  }
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
  // The outputs must carry their inputs (R2 metadata); a merge too wide for that is refused
  // before any work, never written without them (the sweep could then never judge it).
  const record = encodeCompactionInputs(summary.inputs)
  if (new TextEncoder().encode(record).byteLength > COMPACTION_INPUTS_MAX_BYTES) {
    return { status: 'error', job: summary, reason: 'too_many_inputs', detail: `the names of ${summary.inputs.length} inputs do not fit in ${COMPACTION_INPUTS_MAX_BYTES} bytes of object metadata; lower maxInputPairs` }
  }

  // One table at a time, so only one table's inputs are in memory with the engine's copy.
  const merged: EncodedFile[] = []
  for (const [table, files] of [['metric_samples', inSamples], ['metric_series', inSeries]] as const) {
    const out = engine.mergeFiles(table, await fetchAll(env.BUCKET, files.map((f) => f.key)))
    // A merge only removes duplicates: it cannot have more rows than its inputs together,
    // nor fewer than its largest input. Anything else is a bug; publish nothing.
    const total = files.reduce((a, f) => a + f.rows, 0)
    const largest = Math.max(...files.map((f) => f.rows))
    if (out.rows > total || out.rows < largest || out.day !== job.day || out.table !== table) {
      return { status: 'error', job: summary, reason: 'row_count', detail: `${table}: merged ${out.rows} rows of day ${out.day} from inputs of ${total} rows (largest ${largest}) of day ${job.day}` }
    }
    merged.push(out)
  }

  const inputs16 = await inputsHash16(summary.inputs)
  const outputs: FileEntry[] = []
  const digests: ArrayBuffer[] = []
  for (const f of merged) {
    const digest = await sha256(f.bytes)
    const key = compactedKey({ cell, table: f.table, tenant, day: f.day, level: job.level, hour: job.hour, inputs16, sha256Hex: hex(digest) })
    outputs.push({ table: f.table, day: f.day, key, bytes: f.bytes.byteLength, rows: f.rows, minTs: f.minTs, maxTs: f.maxTs, level: job.level, index: f.index })
    digests.push(digest)
  }
  // Both PUTs at once: a PUT costs about the same however large it is. Each object carries
  // the list of its inputs, which is what lets the orphan sweep judge it (see above).
  const put = await Promise.all(merged.map((f, i) => putFile(env.BUCKET, outputs[i]!.key, f.bytes, digests[i]!, { [COMPACTION_INPUTS_META]: record })))
  await opts.hooks?.afterPut?.(outputs)

  if (Date.now() - started > policy.maxStepMs) {
    return { status: 'error', job: summary, reason: 'too_slow', detail: `the step took longer than ${policy.maxStepMs} ms; its outputs are left for the orphan sweep` }
  }
  // ONE replace for both tables: the series file and the samples file stay paired.
  const r = await ledger.replace({ remove: summary.inputs, add: outputs })
  if (r.status === 'ok') return { status: 'merged', job: summary, version: r.version, outputs, put }
  if (r.status === 'invalid') return { status: 'error', job: summary, reason: 'invalid', detail: r.reason }
  // Conflict: nothing was swapped. The outputs are LEFT where they are, for the orphan sweep.
  // "An input is gone, so no step can list them" is true only once that removal is logged:
  // a ledger rebuilt from its log can bring the input back, and an identical step (same
  // inputs, so the same keys) can then commit these very objects (spec/README.md F14). The
  // sweep deletes them once one of their inputs is gone for good (janitor/, review R-2).
  if (r.status === 'conflict') return { status: 'conflict', job: summary, missing: r.missing, blocking: r.blocking ?? [] }
  // An answer this code does not know (a newer ledger, `schema_too_new`): fail closed, so the
  // maintenance run is retried; never take it for a conflict or a success.
  throw new Error(`compact: the ledger answered replace with ${JSON.stringify((r as { status?: unknown }).status)}; nothing was swapped, retry`)
}

/** The span and log tables, in the order a step looks at them. */
export const SIGNAL_TABLES: readonly SignalTable[] = ['spans', 'trace_index', 'logs']

/** The engine's signal merge, if it has one (engine/wasm ABI 4); without it only metrics are compacted. */
const signalEngine = (engine: Engine): (Engine & SignalMergeEngine) | null =>
  typeof (engine as Partial<SignalMergeEngine>).mergeSignalFiles === 'function' ? (engine as Engine & SignalMergeEngine) : null

/**
 * One merge of a span or log table, by the rules of the metric step above (D30): plan, choose
 * (`chooseJob` over one-file units; `spans` never across an hour), GET the inputs, merge them in
 * ascending precedence, refuse a result that is not a merge of them, PUT the output with its
 * inputs record under its content-hashed key (`If-None-Match: *`, adopting an identical object),
 * then ONE `replace`. It never deletes an object. `idle` when the table has nothing to merge.
 */
async function signalStep(
  env: CompactEnv,
  engine: Engine & SignalMergeEngine,
  ledger: DurableObjectStub<Ledger>,
  tenant: string,
  table: SignalTable,
  cell: string,
  policy: CompactPolicy,
  started: number,
  opts: StepOptions,
): Promise<StepResult> {
  const plan = await ledger.plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
  const { job, nextDueAt } = chooseJob(plan.files.map(signalUnit), opts.now ?? started, policy)
  if (!job) return { status: 'idle', nextDueAt, unpaired: [] }
  await opts.hooks?.afterPlan?.(job)
  const ordered = [...job.inputs].sort(byPrecedence).map((u) => u.files[0]!)
  const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  const summary: JobSummary = {
    table,
    day: job.day,
    level: job.level,
    ...(job.hour !== undefined ? { hour: job.hour } : {}),
    why: job.why,
    inputs: ordered.map((f) => f.key).sort(byKey),
    inputBytes: ordered.reduce((a, f) => a + f.bytes, 0),
    inputRows: ordered.reduce((a, f) => a + f.rows, 0),
  }
  const record = encodeCompactionInputs(summary.inputs)
  if (new TextEncoder().encode(record).byteLength > COMPACTION_INPUTS_MAX_BYTES) {
    return { status: 'error', job: summary, reason: 'too_many_inputs', detail: `the names of ${summary.inputs.length} inputs do not fit in ${COMPACTION_INPUTS_MAX_BYTES} bytes of object metadata; lower maxInputPairs` }
  }
  const out: EncodedSignalFile = engine.mergeSignalFiles(table, await fetchAll(env.BUCKET, ordered.map((f) => f.key)))
  // A merge only removes duplicates (spans, logs) or joins one trace's rows (trace_index): never
  // more rows than its inputs together, nor fewer than its largest input; one partition.
  const largest = Math.max(...ordered.map((f) => f.rows))
  if (out.rows > summary.inputRows || out.rows < largest || out.day !== job.day || out.table !== table || (table === 'spans' && out.hour !== job.hour)) {
    return { status: 'error', job: summary, reason: 'row_count', detail: `${table}: merged ${out.rows} rows of day ${out.day} hour ${out.hour} from inputs of ${summary.inputRows} rows (largest ${largest}) of day ${job.day} hour ${job.hour}` }
  }
  const inputs16 = await inputsHash16(summary.inputs)
  const digest = await sha256(out.bytes)
  const key = compactedKey({ cell, table, tenant, day: out.day, level: job.level, hour: table === 'spans' ? out.hour! : job.hour, inputs16, sha256Hex: hex(digest) })
  const output: FileEntry = { table, day: out.day, key, bytes: out.bytes.byteLength, rows: out.rows, minTs: out.minTs, maxTs: out.maxTs, level: job.level, index: out.index }
  const put = await putFile(env.BUCKET, key, out.bytes, digest, { [COMPACTION_INPUTS_META]: record })
  await opts.hooks?.afterPut?.([output])
  if (Date.now() - started > policy.maxStepMs) {
    return { status: 'error', job: summary, reason: 'too_slow', detail: `the step took longer than ${policy.maxStepMs} ms; its outputs are left for the orphan sweep` }
  }
  const r = await ledger.replace({ remove: summary.inputs, add: [output] })
  if (r.status === 'ok') return { status: 'merged', job: summary, version: r.version, outputs: [output], put: [put] }
  if (r.status === 'invalid') return { status: 'error', job: summary, reason: 'invalid', detail: r.reason }
  // Conflict: nothing swapped, the output LEFT for the orphan sweep (D30), as for metrics.
  if (r.status === 'conflict') return { status: 'conflict', job: summary, missing: r.missing, blocking: r.blocking ?? [] }
  throw new Error(`compact: the ledger answered replace with ${JSON.stringify((r as { status?: unknown }).status)}; nothing was swapped, retry`)
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
