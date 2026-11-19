// Runs the explicit-state experiments and writes results/bfs/<name>.json and results/BFS.md.
//
//   node bfs/run.ts                 everything
//   node bfs/run.ts teeth           guard-off experiments (expect a counterexample each)
//   node bfs/run.ts findings        the design / implementation as written (a counterexample is a finding)
//   node bfs/run.ts amended         the amended protocol, exhaustive (expect none)
//   node bfs/run.ts liveness        AG EF query-done on the full state graph
//   node bfs/run.ts proposed        the proposed fixes (registration before writes, F16)
//   node bfs/run.ts <name> [...]    named experiments
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, type Result } from './check.ts'
import { type Cfg, SAFETY } from './model.ts'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'results', 'bfs')

// ------------------------------------------------------------------ configurations

/** Small bounds: 1 tenant, 1 shard, 2 batches, 2 sends each, 2 flush Workers at once; no faults or maintenance. */
const SMALL = {
  nt: 1, ns: 1, nb: 2, maxSend: 2, variants: 1, maxJobs: 2, maxCJobs: 1, maxCSteps: 3, maxComp: 0, maxExp: 0, maxLL: 0, maxSL: 0,
  maxQ: 1, maxRestarts: 2, sameContent: false, liveness: false,
} as const

/** Every rule as the README's amended protocol states it. The baseline of the guard-off experiments. */
export const AMENDED: Cfg = {
  ...SMALL,
  fence: true, contiguous: true, recAt: 'logged', dedup: true, fpHorizon: true, replaceLive: true, delGrace: true,
  delLogged: true, missingErr: true, keying: 'content', sweep: 'impl', sweepIncLogged: true, reg: 'logged', query: 'impl', unknownStream: 'refuse',
  f6Register: true, readBound: true, log: 'segments', rebuild: 'strict', drainRetrySame: true, baseFirst: true, baseTombstones: false, compKey: 'unique',
  compConflictDelete: true, fpScope: 'stream', tailScope: 'stream', noRetryAcrossLoss: true, retain: false,
  sweepSteps: false, sweepAge: true, purgeSteps: false, startSteps: false, goal: 'query', sweepGone: 'both', sweepOrder: 'listFirst',
  sweepNewerLogged: true, maxSweeps: 99, maxRB: 0, rbFix: 'none',
}

/**
 * DESIGN.md draft 3.1 + contracts/LEDGER-LOG.md (planned segment log), read literally. Where
 * the text is silent the charitable choice is made: a missing planned file is an error,
 * an unknown stream refuses a tail read, flush reads are bound to the stream, compaction
 * outputs have step-unique keys and are not deleted on conflict.
 */
export const DESIGN: Cfg = {
  ...AMENDED,
  reg: 'design', query: 'design', sweep: 'spec', sweepIncLogged: false, drainRetrySame: false, baseFirst: false, compConflictDelete: false,
  noRetryAcrossLoss: false,
}

/**
 * As built when this work started (2026-11-18 evening): shard.ts, flush.ts, query coordinator.ts,
 * compact.ts deleting its outputs on conflict, janitor.ts sweeping compaction outputs by age and
 * old incarnations by the committed incarnation. The ledger is the segment log (with the F10 and
 * F11 fixes, tombstones in the base) that replaced one object per change during this work.
 * F13, F14 and F15 are against this version.
 */
export const IMPL_V1: Cfg = {
  ...AMENDED,
  reg: 'impl', query: 'impl', unknownStream: 'empty', readBound: false, log: 'segments', drainRetrySame: true, baseFirst: true,
  baseTombstones: true, sweepIncLogged: false,
  sweep: 'impl', compKey: 'inputs', compConflictDelete: true, noRetryAcrossLoss: false,
}

/**
 * D30 (design/DECISIONS.md), compact/src/compact.ts and janitor/src/janitor.ts as of 6488856
 * (unchanged at 6ee76c8): output keys unchanged (hash of the input keys + of the bytes), each output carries
 * its inputs as R2 metadata `viz-inputs`, a step never deletes an output (not on conflict
 * either); the orphan sweep lists the prefix, then reads the ledger once, then deletes an
 * unreferenced, untombstoned output only if one of its inputs is absent from the listing and
 * not live; a newer incarnation makes an old flush file dead only once it has a logged
 * watermark above 0 (F15). Modelled with NO clock (no age floor), the sweep, the purge and the
 * ledger start as separate steps.
 */
export const D30: Partial<Cfg> = { sweep: 'inputs', sweepNewerLogged: true, sweepGone: 'both', sweepOrder: 'listFirst', sweepAge: false, sweepSteps: true, compKey: 'inputs', compConflictDelete: false, purgeSteps: true }
/** The ledger's segment log as built (contracts/LEDGER-LOG.md, ledger.ts): F10 and F11 fixed, tombstones in the base, the base PUT before the commit. */
export const LOG_AS_BUILT: Partial<Cfg> = { log: 'segments', drainRetrySame: true, baseFirst: true, baseTombstones: true, startSteps: true }

/**
 * The code as on disk at 6488856 (2026-11-19): IMPL_V1 with D30, the segment log as
 * built, shard.ts `readSegment` bound to (incarnation, seqLo, seqHi) and used so by flush.ts
 * (F12 fix), and `tailRead` refusing an incarnation it does not hold (`incarnation_mismatch(0)`)
 * but still answering ok/empty to incarnation 0; registration still lazy (by flush.ts), and
 * nothing re-registers a stream the shard lost (no `f6Register`).
 */
export const IMPL: Cfg = { ...IMPL_V1, ...D30, ...LOG_AS_BUILT, readBound: true, unknownStream: 'refuse', f6Register: false }

/** As built, with the segment log as LEDGER-LOG.md stated it at the start of this work (before F10 and F11 were fixed). */
export const IMPL_PLANNED: Cfg = { ...IMPL_V1, log: 'segments', drainRetrySame: false, baseFirst: false, baseTombstones: false, startSteps: false }

const ALLSAFE = SAFETY

export interface Exp {
  name: string
  kind: 'teeth' | 'finding' | 'amended' | 'liveness' | 'd30' | 'log' | 'proposed'
  label: string
  cfg: Cfg
  props: string[]
  expect: 'violated' | 'holds'
  maxStates?: number
}

export const E: Exp[] = []
const teeth = (name: string, label: string, over: Partial<Cfg>, prop: string) =>
  E.push({ name, kind: 'teeth', label, cfg: { ...AMENDED, ...over }, props: [prop], expect: 'violated' })
const finding = (name: string, label: string, cfg: Cfg, props: string[]) =>
  E.push({ name, kind: 'finding', label, cfg, props, expect: 'violated' })

// ---- (a)..(h): the guards the task names, each switched off alone against AMENDED
teeth('a_no_fence', '(a) tail read without the fence', { fence: false }, 'I4_NoGapAtSeam')
teeth('b_highest_seq', '(b) watermark = highest seq seen, not the contiguous prefix', { contiguous: false }, 'I4_NoGapAtSeam')
teeth('b_highest_seq_I1', '(b) same, as data loss', { contiguous: false }, 'I1_AckedIsDurable')
teeth('c_recorded_at_committed', '(c) shard told `recorded` at the committed watermark; ledger loss + rebuild', { recAt: 'committed', maxLL: 1 }, 'I5_DiscardOnlyLogged')
teeth('c_recorded_at_committed_I1', '(c) same, carried through to data loss', { recAt: 'committed', maxLL: 1 }, 'I1_AckedIsDurable')
teeth('d_no_dedup', '(d) no dedup fingerprints, client retry', { dedup: false }, 'I3_NoDuplicates')
teeth('e_fp_expiry', '(e) fingerprint TTL shorter than the retry horizon', { fpHorizon: false }, 'I3_NoDuplicates')
teeth('f_replace_not_live', '(f) replace without the inputs-live check, racing retention', { replaceLive: false, maxComp: 1, maxExp: 1 }, 'I9_NoResurrection')
teeth('g_delete_no_grace', '(g) physical deletion without waiting for queries holding an old plan; missing file read as empty', { delGrace: false, missingErr: false, maxComp: 1 }, 'I4_NoGapAtSeam')
teeth('g_delete_no_grace_loud', '(g) same, missing file is an error: the query is refused (with the `retain` timing assumption no other refusal exists)', { delGrace: false, maxComp: 1, retain: true }, 'L2_NoRefusal')
teeth('h_overwrite', '(h) flush key deterministic and the PUT overwrites; two encoder outputs', { keying: 'overwrite', variants: 2 }, 'I11_LiveFilesReadable')
teeth('h_if_none_match', '(h2) deterministic key + If-None-Match (draft 3): the ledger describes the loser', { keying: 'inm', variants: 2 }, 'I11_LiveFilesReadable')
// ---- further rules the model relies on
teeth('i_fingerprint_per_shard', '(i) fingerprints scoped per shard, not per stream; 2 tenants send identical bytes', { nt: 2, nb: 2, maxSend: 1, sameContent: true, fpScope: 'shard' }, 'I1_AckedIsDurable')
teeth('j_tail_read_per_shard', '(j) tail read not scoped to the tenant; 2 tenants in one pooled shard', { nt: 2, nb: 2, maxSend: 1, tailScope: 'shard' }, 'I20_TenantIsolation')
teeth('k_no_handshake', '(k) no registration before writes, query asks only streams in the plan', { reg: 'impl', query: 'design' }, 'I4_NoGapAtSeam')
teeth('l_sweep_any', '(l) orphan sweeper deletes any unreferenced object', { sweep: 'any' }, 'I11_LiveFilesReadable')
teeth('m_delete_before_logged', '(m) removed file deleted before its removal is logged; ledger loss + rebuild', { delLogged: false, maxComp: 1, maxLL: 1 }, 'I11_LiveFilesReadable')
teeth('n_unknown_stream_empty', '(n) tailRead on a stream the shard does not hold answers ok/empty', { unknownStream: 'empty', maxSL: 1 }, 'I4_NoGapAtSeam')
E.push({ name: 'o_read_unbound', kind: 'teeth', label: '(o) flush reads readSegment(tenant, seqLo) unbound to the incarnation. NO counterexample: with registration before writes (F1 fix) the stale unit is refused as incarnation_mismatch; it bites only with lazy registration (F12)', cfg: { ...AMENDED, readBound: false, maxSL: 1, maxSend: 1 }, props: ['I3_NoDuplicates'], expect: 'holds' })
teeth('p_drain_retry_new_bounds', '(p) a retried drain writes all pending changes (new bounds); strict replay', { drainRetrySame: false, maxLL: 1 }, 'AV_RebuildSucceeds')

// ---- the design as written (DESIGN.md 3.1 + LEDGER-LOG.md) and the implementation as built
const FAULTS = { maxComp: 1, maxExp: 1, maxLL: 1, maxSL: 1 }
// "Peeling": the design as written is checked with every action and every safety property;
// each later run adds the fix for the finding the previous one reported, until none is left.
const DESIGN_PEEL: [string, Partial<Cfg>][] = [
  ['DESIGN_1_as_written', {}],
  ['DESIGN_2_fix_F11', { baseFirst: true }],
  ['DESIGN_3_fix_F1', { baseFirst: true, reg: 'logged' }],
  ['DESIGN_4_fix_F10', { baseFirst: true, reg: 'logged', drainRetrySame: true }],
  ['DESIGN_5_assume_F3', { baseFirst: true, reg: 'logged', drainRetrySame: true, noRetryAcrossLoss: true }],
  ['DESIGN_6_fix_F2', { baseFirst: true, reg: 'logged', drainRetrySame: true, noRetryAcrossLoss: true, sweep: 'impl' }],
  ['DESIGN_7_fix_F15', { baseFirst: true, reg: 'logged', drainRetrySame: true, noRetryAcrossLoss: true, sweep: 'impl', sweepIncLogged: true }],
]
for (const [name, over] of DESIGN_PEEL) {
  E.push({ name, kind: 'finding', label: `DESIGN.md 3.1 + LEDGER-LOG.md${Object.keys(over).length ? ` + ${Object.keys(over).join(', ')}` : ' as written'}; every action (1 compaction, 1 retention removal, 1 ledger loss, 1 shard loss), every safety property`,
    cfg: { ...DESIGN, ...FAULTS, ...over }, props: ALLSAFE, expect: name === 'DESIGN_7_fix_F15' ? 'holds' : 'violated' })
}
finding('F1_registration_rolled_back', 'F1: registration committed, not logged; ledger rebuild forgets the stream (design reg, others fixed)', { ...AMENDED, reg: 'design', query: 'design', maxLL: 1 }, ['I4_NoGapAtSeam'])
finding('F2_sweeper_spec_I1', 'F2: orphan sweeper as DESIGN §4.3 states it; ledger rebuild', { ...AMENDED, sweep: 'spec', maxComp: 1, maxLL: 1 }, ['I1_AckedIsDurable'])
finding('F2_sweeper_spec_grace', 'F2: same sweeper deletes a removed file under a running query (missing read as empty)', { ...AMENDED, sweep: 'spec', maxComp: 1, missingErr: false }, ['I4_NoGapAtSeam'])
finding('F3_retry_after_shard_loss', 'F3: fingerprints die with the shard storage; a retry is stored again', { ...AMENDED, noRetryAcrossLoss: false, maxSL: 1 }, ['I3_NoDuplicates'])
finding('F10_segments_overlap', 'F10 (LEDGER-LOG.md): drain PUTs v1..vk, dies before deleting the rows, a change commits, the retry PUTs v1..vk+1', { ...AMENDED, drainRetrySame: false }, ['LOG_SegmentsDisjoint'])
finding('F10_rebuild_refuses', 'F10: same, then the ledger loses its storage: a strict replay refuses the log', { ...AMENDED, drainRetrySame: false, maxLL: 1 }, ['AV_RebuildSucceeds'])
finding('F11_incarnation_reused', 'F11 (LEDGER-LOG.md): base is an ordinary first change; two ledger losses before it is drained', { ...AMENDED, baseFirst: false, maxLL: 2 }, ['V_IncarnationNotReused'])
// The code as built. "As built" = 6488856 (IMPL); the findings F6, F12, F13, F14 and F15
// were found against the code of 2026-11-18 evening (IMPL_V1) and are kept against it.
const IMPL_PEEL: [string, Partial<Cfg>][] = [
  ['IMPL_1_as_built', {}],
  ['IMPL_2_assume_F3', { noRetryAcrossLoss: true }],
]
for (const [name, over] of IMPL_PEEL) {
  E.push({ name, kind: 'finding', label: `code at 6488856 (shard.ts, ledger.ts, flush.ts, compact.ts + janitor.ts with D30, coordinator.ts)${Object.keys(over).length ? ` + ${Object.keys(over).join(', ')}` : ''}; every action (1 compaction, 1 retention removal, 1 ledger loss, 1 shard loss), every safety property`,
    cfg: { ...IMPL, ...FAULTS, ...over }, props: ALLSAFE, expect: 'violated', maxStates: 4_000_000 })
}
E.push({ name: 'IMPL_3_fix_F6b', kind: 'finding', label: 'code at HEAD + F3 assumed + registration before writes, logged (F1/F6 fix in shard.ts); every action, every safety property', cfg: { ...IMPL, ...FAULTS, noRetryAcrossLoss: true, reg: 'logged' }, props: ALLSAFE, expect: 'holds', maxStates: 4_000_000 })
finding('F6_impl_unknown_stream', 'F6: shard.ts (2026-11-18) tailRead answers ok/empty for a stream it lost (no client retry across the loss)', { ...IMPL_V1, maxSL: 1, noRetryAcrossLoss: true }, ['I4_NoGapAtSeam'])
finding('F6b_impl_now', 'F6(b) in the code at HEAD: tailRead still answers ok/empty to incarnation 0, which the coordinator sends for a stream the ledger has not registered (lazy registration)', { ...IMPL, maxSL: 1, noRetryAcrossLoss: true }, ['I4_NoGapAtSeam'])
finding('F12_impl_read_unbound', 'F12: shard.ts (2026-11-18) readSegment(tenant, seqLo) ignores the incarnation; a flush across a shard loss (no client retry across the loss)', { ...IMPL_V1, maxSL: 1, unknownStream: 'refuse', noRetryAcrossLoss: true }, ['I3_NoDuplicates'])
finding('F13_impl_comp_adopts_old_output', 'F13: compaction adopts an earlier step\'s output ("exists"); the sweeper judges it by the earlier upload', { ...IMPL_V1, maxComp: 1 }, ['I11_LiveFilesReadable'])
finding('F14_impl_comp_conflict_delete', 'F14: compaction deletes its output on conflict although an identical step made it live and it has been removed since (removal not yet logged); ledger rebuild', { ...IMPL_V1, sweep: 'off', maxSend: 1, maxJobs: 1, maxQ: 0, maxComp: 1, maxCJobs: 2, maxExp: 1, maxLL: 1 }, ['I11_LiveFilesReadable'])
finding('F15_sweeper_trusts_unlogged_registration', 'F15: janitor.ts (first version) calls an old-incarnation flush file dead because the ledger has a newer incarnation, whose registration is not yet logged; ledger rebuild', { ...AMENDED, sweepIncLogged: false, maxSL: 1, maxLL: 1 }, ['I11_LiveFilesReadable'])
finding('IMPL_PLANNED_fixed', 'As built with the fixes above (F6, F12, F13/F14, F15, F3 assumed), but the segment log as LEDGER-LOG.md stated it at the start of this work; ledger loss, compaction', { ...IMPL_PLANNED, unknownStream: 'refuse', noRetryAcrossLoss: true, readBound: true, compKey: 'unique', sweepIncLogged: true, maxLL: 1, maxComp: 1 }, ALLSAFE)

// ---- D30: the compaction fix as built (compact.ts + janitor.ts), checked independently.
// The F13, F14 and F15 bounds exactly as those findings were found, with D30 in place of the
// old rules and the sweeper ON, every safety property; then the amended protocol's suite with
// D30 and the ledger log as built; then teeth for each part of the rule.
const d30 = (name: string, label: string, cfg: Cfg, expect: 'holds' | 'violated' = 'holds', props: string[] = ALLSAFE, maxStates = 6_000_000) =>
  E.push({ name, kind: 'd30', label, cfg, props, expect, maxStates })
d30('D30_F13', 'F13\'s bounds exactly (code of 2026-11-18, client retries, 2 flush Workers, 1 compaction, sweeper on, sweep runs unbounded) with D30', { ...IMPL_V1, ...D30, maxComp: 1 })
// exhaustive variants: no client retry (irrelevant to compaction and the sweep), at most 2 sweep runs
const X = { maxSend: 1, maxSweeps: 2 }
d30('D30_F13x', 'F13\'s bounds with D30, no client retry, ≤ 2 sweep runs', { ...IMPL_V1, ...D30, ...X, maxComp: 1 }, 'holds', ALLSAFE, 6_000_000)
d30('D30_F14x', 'F14\'s bounds (two compaction steps at once, retention, ledger loss) with D30, the sweeper ON (F14 had it off), ≤ 2 sweep runs, the ledger log as built (two-step start)', { ...IMPL_V1, ...D30, ...LOG_AS_BUILT, ...X, maxJobs: 1, maxQ: 0, maxComp: 1, maxCJobs: 2, maxExp: 1, maxLL: 1 }, 'holds', ALLSAFE, 19_000_000)
d30('D30_F15x', 'F15\'s bounds (amended protocol, 2 flush Workers, shard loss + ledger loss) with D30\'s sweeper, no client retry, ≤ 2 sweep runs', { ...AMENDED, ...D30, ...X, maxSL: 1, maxLL: 1 }, 'holds', ALLSAFE, 6_000_000)
const AD = { ...AMENDED, ...D30, ...LOG_AS_BUILT }
d30('D30_retries_faults', 'amended protocol + D30 + log as built: client retries + two flush Workers, ledger loss + shard loss', { ...AD, maxLL: 1, maxSL: 1 }, 'holds', ALLSAFE, 6_000_000)
d30('D30_maintenance_faults', 'amended + D30 + log as built: two compaction steps at once + retention + ledger loss + shard loss, no client retry', { ...AD, maxSend: 1, maxComp: 1, maxCJobs: 2, maxExp: 1, maxLL: 1, maxSL: 1 }, 'holds', ALLSAFE, 6_000_000)
d30('D30_maintenance_2LL', 'amended + D30 + log as built: two compaction steps at once + retention + two ledger losses, no client retry, one flush Worker, ≤ 2 sweep runs', { ...AD, ...X, maxJobs: 1, maxComp: 1, maxCJobs: 2, maxExp: 1, maxLL: 2, maxSL: 0 }, 'holds', ALLSAFE, 6_000_000)
d30('D30_3batches', 'amended + D30 + log as built: 3 batches, ledger loss + shard loss + compaction, no client retry, ≤ 2 sweep runs', { ...AD, ...X, nb: 3, maxLL: 1, maxSL: 1, maxComp: 1 }, 'holds', ALLSAFE, 6_000_000)
d30('D30_2shards', 'amended + D30 + log as built: 2 shards, ledger loss + shard loss + compaction, no client retry, ≤ 2 sweep runs', { ...AD, ...X, ns: 2, maxLL: 1, maxSL: 1, maxComp: 1 }, 'holds', ALLSAFE, 6_000_000)
d30('D30_2tenants', 'amended + D30 + log as built: 2 tenants in one pooled shard sending identical bytes, ledger loss + shard loss + compaction, no client retry, ≤ 2 sweep runs', { ...AD, ...X, nt: 2, nb: 2, maxLL: 1, maxSL: 1, maxComp: 1, sameContent: true }, 'holds', ALLSAFE, 6_000_000)
d30('D30_variants', 'amended + D30 + log as built: two encoder outputs per segment, ledger loss + compaction + retention, no client retry, ≤ 2 sweep runs', { ...AD, ...X, variants: 2, maxLL: 1, maxComp: 1, maxExp: 1 }, 'holds', ALLSAFE, 6_000_000)
d30('D30_chain', 'amended + D30 + log as built: 3 batches, 2 compactions, so an output is an input of the next (the rule applied inductively), retention, ledger loss, no client retry, one flush Worker, no query, ≤ 2 sweep runs', { ...AD, ...X, nb: 3, maxJobs: 1, maxQ: 0, maxComp: 2, maxCJobs: 1, maxExp: 1, maxLL: 1 })
E.push({ name: 'W_chain_reachable', kind: 'd30', label: 'non-vacuity of D30_chain: a level-2 output (built from a compaction output) becomes live within its bounds', cfg: E.find((e) => e.name === 'D30_chain')!.cfg, props: ['W_NoChainedOutputLive'], expect: 'violated', maxStates: 6_000_000 })
// teeth: which parts of D30 are load-bearing (F14's bounds unless said otherwise)
const T14 = { ...X, maxJobs: 1, maxQ: 0, maxComp: 1, maxCJobs: 2, maxExp: 1, maxLL: 1 }
d30('D30_teeth_not_live_only', 'D30 teeth: an input counts as gone when it is merely not live (its object may still exist)', { ...AD, ...T14, sweepGone: 'notLive' }, 'violated', ['I11_LiveFilesReadable'], 6_000_000)
d30('D30_teeth_absent_only', 'D30 with the live test dropped (absent from the listing alone): expected to hold, since an object is deleted only once its key can never be live', { ...AD, ...T14, sweepGone: 'absent' }, 'holds', ALLSAFE, 6_000_000)
d30('D30_teeth_read_first', 'D30 teeth: the sweep reads the ledger BEFORE it lists R2', { ...AD, ...T14, sweepOrder: 'readFirst' }, 'violated', ['I11_LiveFilesReadable'], 6_000_000)
d30('D30_teeth_newer_unlogged', 'D30 teeth: a newer incarnation kills old flush files as soon as it is committed (no logged-watermark > 0 test); F15\'s bounds', { ...AMENDED, ...D30, maxSweeps: 2, sweepNewerLogged: false, maxSL: 1, maxLL: 1 }, 'violated', ['I11_LiveFilesReadable'], 6_000_000)
d30('D30_teeth_conflict_delete', 'D30 teeth: the step deletes its outputs on conflict again (F14 back); sweeper on', { ...IMPL_V1, ...D30, ...T14, compConflictDelete: true }, 'violated', ['I11_LiveFilesReadable'], 6_000_000)
d30('D30_teeth_purge_unlogged', 'D30 teeth: purge deletes a removed file before its removal is logged', { ...AD, ...T14, delLogged: false }, 'violated', ['I11_LiveFilesReadable'], 6_000_000)

// ---- the ledger's segment log as built (LEDGER-LOG.md, ledger.ts): the IMPL_PLANNED bounds and more
// at most 2 orphan sweep runs: the sweep is not what these check, and it multiplies the states
const logrun = (name: string, label: string, cfg: Cfg, expect: 'holds' | 'violated' = 'holds', props: string[] = ALLSAFE) =>
  E.push({ name, kind: 'log', label: `${label}; ≤ 2 sweep runs`, cfg: { ...cfg, maxSweeps: 2 }, props, expect, maxStates: 6_000_000 })
logrun('LOG_as_built', 'IMPL_PLANNED_fixed\'s bounds with the segment log as built (base PUT before the commit, two-step start, F10 fix, tombstones in the base) and the code at HEAD; F3 assumed', { ...IMPL, noRetryAcrossLoss: true, maxLL: 1, maxComp: 1 })
logrun('LOG_as_built_2LL', 'as LOG_as_built, two ledger losses (F11 needed two), compaction, one flush Worker', { ...IMPL, noRetryAcrossLoss: true, maxLL: 2, maxComp: 1, maxJobs: 1 })
logrun('LOG_as_built_3LL', 'as LOG_as_built, three ledger losses, no compaction, one flush Worker', { ...IMPL, noRetryAcrossLoss: true, maxLL: 3, maxComp: 0, maxJobs: 1 })
logrun('LOG_as_built_faults', 'as LOG_as_built, + retention + shard loss, registration logged before writes (so F6(b) does not mask the log)', { ...IMPL, reg: 'logged', noRetryAcrossLoss: true, maxLL: 1, maxComp: 1, maxExp: 1, maxSL: 1 })
logrun('LOG_teeth_commit_first', 'segment log teeth: the incarnation commits before its base is in R2 (the plan before F11)', { ...IMPL, baseFirst: false, startSteps: false, noRetryAcrossLoss: true, maxLL: 2, maxComp: 0, maxJobs: 1 }, 'violated', ['V_IncarnationNotReused'])
logrun('LOG_teeth_retry_new_bounds', 'segment log teeth: a retried drain takes every pending row (F10)', { ...IMPL, drainRetrySame: false, noRetryAcrossLoss: true, maxLL: 1, maxComp: 0 }, 'violated', ['AV_RebuildSucceeds'])

// review S-1 (design/reviews/segment-log-and-compaction.md): a rollback to the first-layout
// release on segment storage, then a roll-forward; then a ledger storage loss
logrun('LOG_S1_rollback', 'review S-1, as built: one rollback to the first-layout ledger and back, one ledger loss, retention, compaction, registration logged before writes', { ...IMPL, reg: 'logged', noRetryAcrossLoss: true, maxRB: 1, maxLL: 1, maxComp: 1, maxExp: 1, maxJobs: 1 }, 'violated')
logrun('LOG_S1_rollback_I1', 'review S-1, as built, carried through to acknowledged-row loss', { ...IMPL, reg: 'logged', noRetryAcrossLoss: true, maxRB: 1, maxLL: 1, maxComp: 0, maxExp: 0, maxJobs: 1 }, 'violated', ['I1_AckedIsDurable'])
logrun('LOG_S1_rollback_I11', 'review S-1, as built, carried through to a listed file with no object (a removal the first-layout drain logged, purged, then undone by the rebuild)', { ...IMPL, reg: 'logged', noRetryAcrossLoss: true, maxRB: 1, maxLL: 1, maxComp: 0, maxExp: 1, maxJobs: 1 }, 'violated', ['I11_LiveFilesReadable'])
logrun('LOG_S1_heal_1batch', 'review S-1 with fix (b), one batch, one ledger loss, one flush Worker (small enough to be exhaustive)', { ...IMPL, reg: 'logged', noRetryAcrossLoss: true, maxRB: 1, rbFix: 'heal', maxLL: 1, maxSend: 1, maxJobs: 1, nb: 1 })
logrun('LOG_S1_heal', 'review S-1 with fix (b): on roll-forward an outbox that does not continue the segment log starts a new incarnation from SQLite; same bounds', { ...IMPL, reg: 'logged', noRetryAcrossLoss: true, maxRB: 1, rbFix: 'heal', maxLL: 1, maxComp: 1, maxExp: 1, maxJobs: 1 })

// ---- the amended protocol: exhaustive within bounds, expect no violation
const amended = (name: string, label: string, over: Partial<Cfg>, maxStates?: number) =>
  E.push({ name, kind: 'amended', label, cfg: { ...AMENDED, ...over }, props: ALLSAFE, expect: 'holds', maxStates })
amended('A_retries_faults', 'client retries + two flush Workers, ledger loss + shard loss', { maxLL: 1, maxSL: 1 }, 4_000_000)
amended('A_maintenance_faults', 'compaction (2 steps at once) + retention + ledger loss + shard loss, no client retry', { maxSend: 1, maxComp: 1, maxCJobs: 2, maxExp: 1, maxLL: 1, maxSL: 1 }, 4_000_000)
amended('A_3batches', '3 batches, ledger loss + shard loss, no client retry', { nb: 3, maxSend: 1, maxLL: 1, maxSL: 1 }, 4_000_000)
amended('A_2shards', '2 shards, ledger loss + shard loss + compaction, no client retry', { ns: 2, maxSend: 1, maxLL: 1, maxSL: 1, maxComp: 1 }, 4_000_000)
amended('A_2tenants', '2 tenants in one pooled shard sending identical bytes, ledger loss + shard loss, no client retry', { nt: 2, nb: 2, maxSend: 1, maxLL: 1, maxSL: 1, sameContent: true }, 4_000_000)

// ---- liveness: AG EF (goal) on the whole graph; unbounded refusals
// The whole graph is kept (edges in memory), so these use one flush Worker and are capped at
// 3 M states; a run that hits the cap cannot decide AG EF and says so.
const live = (name: string, label: string, cfg: Cfg, expect: 'holds' | 'violated') =>
  E.push({ name, kind: 'liveness', label, cfg: { ...cfg, sweepSteps: false, purgeSteps: false, maxJobs: 1, liveness: true }, props: [], expect, maxStates: 3_000_000 })
live('LIVE_amended', 'amended protocol, ledger loss + shard loss, no compaction (1 send per batch; with compaction the graph passed the 3 M cap)', { ...AMENDED, maxSend: 1, maxLL: 1, maxSL: 1 }, 'holds')
live('LIVE_amended_ll', 'amended protocol, ledger loss, compaction, no shard loss (1 send per batch)', { ...AMENDED, maxSend: 1, maxLL: 1, maxComp: 1 }, 'holds')
live('LIVE_amended_sl', 'amended protocol, shard loss, no ledger loss, no compaction (1 send per batch)', { ...AMENDED, maxSend: 1, maxSL: 1 }, 'holds')
live('LIVE_design', 'DESIGN as written, ledger loss + shard loss (1 send per batch)', { ...DESIGN, maxSend: 1, maxLL: 1, maxSL: 1 }, 'violated')
live('LIVE_impl_V1', 'code of 2026-11-18 (tailRead ok/empty for a lost stream), ledger loss + shard loss, no compaction (1 send per batch)', { ...IMPL_V1, sweep: 'inputs', compConflictDelete: false, maxSend: 1, maxLL: 1, maxSL: 1 }, 'holds')
live('LIVE_impl', 'code at HEAD: tailRead refuses an incarnation it lost, but nothing re-registers the stream; shard loss (1 send per batch)', { ...IMPL, maxSend: 1, maxSL: 1 }, 'violated')
live('LIVE_impl_F6_fixed', 'code at HEAD + F6 fixed completely (register before writes, so a refusing shard re-registers); ledger loss + shard loss (1 send per batch)', { ...IMPL, reg: 'logged', maxSend: 1, maxLL: 1, maxSL: 1 }, 'holds')
// ---- no leak (I11, second half): AG EF every object in R2 is live. Retention may remove any
// live file (maxExp large: it eventually removes everything), no query (purge's grace is then
// free), one flush Worker.
const leak = (name: string, label: string, cfg: Cfg, expect: 'holds' | 'violated', maxStates = 3_000_000) =>
  E.push({ name, kind: 'liveness', label: `${label}; sweep, purge and ledger start as single steps (they only delete; the graph must fit in memory)`, cfg: { ...cfg, sweepSteps: false, purgeSteps: false, startSteps: false, maxJobs: 1, maxQ: 0, liveness: true, goal: cfg.goal === 'cleanComp' ? 'cleanComp' : 'clean' }, props: [], expect, maxStates })
leak('LEAK_D30_maintenance', 'no leak, D30 + log as built: compaction (2 steps at once), retention of every file, ledger loss, no client retry', { ...AD, maxSend: 1, maxComp: 1, maxCJobs: 2, maxExp: 4, maxLL: 1 }, 'holds')
leak('LEAK_D30_shardloss', 'no leak, D30 + log as built: shard loss, ledger loss, retention of every file, compaction, no client retry', { ...AD, maxSend: 1, maxComp: 1, maxExp: 4, maxLL: 1, maxSL: 1 }, 'violated')
leak('LEAK_V1_shardloss', 'no leak, the rules before D30 (age-swept outputs, committed newer incarnation): same bounds as LEAK_D30_shardloss', { ...AD, sweep: 'impl', sweepIncLogged: false, compConflictDelete: true, maxSend: 1, maxComp: 1, maxExp: 4, maxLL: 1, maxSL: 1 }, 'violated')
// smaller bounds, so that the whole graph fits (the runs above stop at 3 M states, undecided)
const LS = { maxSend: 1, maxCJobs: 1, maxComp: 1, maxExp: 2, maxLL: 1 }
leak('LEAK_D30_ll', 'no leak, D30 + log as built: compaction, retention (2 removals), ledger loss, no shard loss', { ...AD, ...LS }, 'holds')
leak('LEAK_D30_sl', 'no leak, D30 + log as built: compaction, retention (2 removals), shard loss, no ledger loss', { ...AD, ...LS, maxLL: 0, maxSL: 1 }, 'violated')
leak('LEAK_V1_sl', 'no leak, the rules before D30: same bounds as LEAK_D30_sl', { ...AD, ...LS, sweep: 'impl', sweepIncLogged: false, compConflictDelete: true, maxLL: 0, maxSL: 1 }, 'violated')
// compaction outputs only: one retention removal is enough to release an output (one input gone)
leak('LEAK_D30_sl_comp', 'no leaked compaction output, D30 + log as built: compaction, retention (1 removal), ledger loss + shard loss', { ...AD, ...LS, maxExp: 1, maxSL: 1, goal: 'cleanComp' }, 'violated', 8_000_000)
leak('LEAK_V1_sl_comp', 'no leaked compaction output, the rules before D30: same bounds as LEAK_D30_sl_comp', { ...AD, ...LS, maxExp: 1, sweep: 'impl', sweepIncLogged: false, compConflictDelete: true, maxSL: 1, goal: 'cleanComp' }, 'holds', 8_000_000)
E.push({ name: 'W_leak_behind_lost_flush', kind: 'd30', label: 'F16 witness: an unlisted compaction output kept because an input is an unlisted flush file of an incarnation its shard lost, which the sweep keeps (D30 + log as built, ledger loss + shard loss, compaction)', cfg: { ...AD, maxSend: 1, maxSweeps: 2, maxComp: 1, maxCJobs: 1, maxExp: 1, maxLL: 1, maxSL: 1 }, props: ['W_NoLeakBehindLostFlush'], expect: 'violated', maxStates: 6_000_000 })

// ---- proposed fixes (README "Proposed fixes"): registration before writes, three variants, on
// the code as built (IMPL; F3 assumed away as in IMPL_3), then the F16 fix on the chosen one.
/** R1: the shard registers before its first write and waits only for the ledger's COMMIT (one round trip, no R2); flush.ts's lazy paths stay; a read naming an incarnation the shard does not hold makes it register a fresh one. */
export const R1: Partial<Cfg> = { reg: 'committed', regOnRead: 'named' }
/** R2: as R1, but the shard accepts writes only once the registration is LOGGED (appends refused, retryably, until then; each attempt repeats the idempotent registration). */
export const R2: Partial<Cfg> = { reg: 'logged', regOnRead: 'named' }
/** R3: R2's write side; no registration on the read path: the coordinator settles a lost incarnation after one re-plan. */
export const R3: Partial<Cfg> = { reg: 'logged', regOnRead: 'none', lostEmpty: true }
/** The F16 fix: the janitor makes a shard that lost a stream register a fresh incarnation; a newer incarnation kills old flush files once its registration is logged. */
export const F16FIX: Partial<Cfg> = { regOnSweep: true, sweepNewerReg: true }
const BASE: Cfg = { ...IMPL, noRetryAcrossLoss: true }
/** The recommended protocol: the code as built + R2 + the F16 fix. */
export const PROPOSED: Cfg = { ...BASE, ...R2, ...F16FIX }
const prop = (name: string, label: string, cfg: Cfg, expect: 'holds' | 'violated' = 'holds', props: string[] = ALLSAFE, maxStates = 4_000_000) =>
  E.push({ name, kind: 'proposed', label, cfg, props, expect, maxStates })
const propLive = (name: string, label: string, cfg: Cfg, expect: 'holds' | 'violated') =>
  E.push({ name, kind: 'proposed', label, cfg: { ...cfg, sweepSteps: false, purgeSteps: false, maxJobs: 1, liveness: true }, props: [], expect, maxStates: 3_000_000 })
const propLeak = (name: string, label: string, cfg: Cfg, expect: 'holds' | 'violated', maxStates = 8_000_000) =>
  E.push({ name, kind: 'proposed', label: `${label}; sweep, purge and ledger start as single steps`, cfg: { ...cfg, sweepSteps: false, purgeSteps: false, startSteps: false, maxJobs: 1, maxQ: 0, liveness: true, goal: cfg.goal === 'cleanComp' ? 'cleanComp' : 'clean' }, props: [], expect, maxStates })
const VARIANTS: [string, string, Partial<Cfg>, 'holds' | 'violated'][] = [
  ['R1', 'R1 (registration committed before writes)', R1, 'violated'],
  ['R2', 'R2 (registration logged before writes; shard registers on a read naming a lost incarnation)', R2, 'holds'],
  ['R3', 'R3 (registration logged before writes; coordinator settles a lost incarnation)', R3, 'holds'],
]
for (const [v, what, over, expect] of VARIANTS) {
  prop(`${v}_safety`, `${what}: client retries, two flush Workers, 1 compaction, 1 retention removal, ledger loss + shard loss`, { ...BASE, ...FAULTS, ...over }, expect)
  if (expect === 'holds') {
    prop(`${v}_2shards`, `${what}: 2 shards, ledger loss + shard loss + compaction, no client retry, ≤ 2 sweep runs`, { ...BASE, ...over, ...X, ns: 2, maxLL: 1, maxSL: 1, maxComp: 1 })
    prop(`${v}_2tenants`, `${what}: 2 tenants in one pooled shard sending identical bytes, ledger loss + shard loss + compaction, no client retry, ≤ 2 sweep runs`, { ...BASE, ...over, ...X, nt: 2, nb: 2, maxLL: 1, maxSL: 1, maxComp: 1, sameContent: true })
  }
  propLive(`LIVE_${v}_sl`, `${what}: shard loss (1 send per batch)`, { ...BASE, ...over, maxSend: 1, maxSL: 1 }, 'holds')
  propLive(`LIVE_${v}_llsl`, `${what}: ledger loss + shard loss (1 send per batch)`, { ...BASE, ...over, maxSend: 1, maxLL: 1, maxSL: 1 }, 'holds')
}
// teeth: each step of the recommended variant, removed alone (R1 is R2 with "logged" removed)
propLive('LIVE_R2_teeth_no_read_trigger', 'R2 teeth: nothing registers a fresh incarnation on a read (only a write does): shard loss', { ...BASE, ...R2, regOnRead: 'none', maxSend: 1, maxSL: 1 }, 'violated')
propLive('LIVE_R3_teeth_no_settle', 'R3 teeth: the coordinator does not settle a lost incarnation: shard loss', { ...BASE, ...R3, lostEmpty: false, maxSend: 1, maxSL: 1 }, 'violated')
prop('R_teeth_lost_read_as_empty', 'R2/R3 teeth: tailRead answers ok/empty to an incarnation it does not hold (no refusal, so no re-plan); shard loss', { ...BASE, ...R2, unknownStream: 'empty', maxSL: 1 }, 'violated', ['I4_NoGapAtSeam'])
// the F16 fix on the recommended protocol: safety (I11's safety half; F13, F14, F15 not back) and no leak
prop('P_safety', 'proposed (as built + R2 + F16 fix): client retries, two flush Workers, 1 compaction, 1 retention removal, ledger loss + shard loss', { ...PROPOSED, ...FAULTS })
prop('P_maintenance', 'proposed: two compaction steps at once + retention + ledger loss + shard loss, no client retry, ≤ 2 sweep runs', { ...PROPOSED, ...X, maxComp: 1, maxCJobs: 2, maxExp: 1, maxLL: 1, maxSL: 1 })
prop('P_F13x', 'proposed at F13\'s bounds (1 compaction, sweeper on), no client retry, ≤ 2 sweep runs', { ...PROPOSED, ...X, maxComp: 1 }, 'holds', ALLSAFE, 6_000_000)
prop('P_F14x', 'proposed at F14\'s bounds (two compaction steps at once, retention, ledger loss), sweeper on, ≤ 2 sweep runs', { ...PROPOSED, ...T14 }, 'holds', ALLSAFE, 6_000_000)
prop('P_F15x', 'proposed at F15\'s bounds (2 flush Workers, shard loss + ledger loss), no client retry, ≤ 2 sweep runs', { ...PROPOSED, ...X, maxSL: 1, maxLL: 1 }, 'holds', ALLSAFE, 6_000_000)
prop('P_teeth_newer_committed', 'F16 fix teeth: a newer incarnation kills old flush files once COMMITTED (not logged); F15\'s bounds', { ...PROPOSED, ...X, sweepNewerReg: false, sweepNewerLogged: false, maxSL: 1, maxLL: 1 }, 'violated', ['I11_LiveFilesReadable'], 6_000_000)
propLeak('LEAK_P_sl', 'no leak, proposed: compaction, retention (2 removals), shard loss, no ledger loss (LEAK_D30_sl\'s bounds)', { ...PROPOSED, ...LS, maxLL: 0, maxSL: 1 }, 'holds')
propLeak('LEAK_P_sl_comp', 'no leaked compaction output, proposed: compaction, retention (1 removal), ledger loss + shard loss (LEAK_D30_sl_comp\'s bounds)', { ...PROPOSED, ...LS, maxExp: 1, maxSL: 1, goal: 'cleanComp' }, 'holds')
propLeak('LEAK_P_llsl', 'no leak of any object, proposed: compaction, retention (1 removal), ledger loss + shard loss', { ...PROPOSED, ...LS, maxExp: 1, maxSL: 1 }, 'holds')
propLeak('LEAK_P_teeth_no_trigger', 'F16 fix teeth: the janitor does not ask the shard (the rule alone); LEAK_P_sl_comp\'s bounds', { ...PROPOSED, ...LS, regOnSweep: false, maxExp: 1, maxSL: 1, goal: 'cleanComp' }, 'violated')
propLeak('LEAK_P_teeth_wm_rule', 'F16 fix teeth: the sweep keeps the rule as built (a newer incarnation counts once it has a logged UNIT); LEAK_P_sl_comp\'s bounds', { ...PROPOSED, ...LS, sweepNewerReg: false, maxExp: 1, maxSL: 1, goal: 'cleanComp' }, 'violated')

// ------------------------------------------------------------------ main

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()

function main(): void {
mkdirSync(out, { recursive: true })
const args = process.argv.slice(2)
const kinds = new Set(['teeth', 'finding', 'amended', 'liveness', 'd30', 'log', 'proposed'])
const sel = E.filter((e) => args.length === 0 || args.includes(e.name) || (kinds.has(e.kind) && args.includes(e.kind)))
if (sel.length === 0) {
  console.error('names:\n  ' + E.map((e) => e.name).join('\n  '))
  process.exit(2)
}
let unexpected = 0
for (const e of sel) {
  process.stdout.write(`${e.name} ... `)
  let r: Result
  try {
    r = check(e.cfg, { name: e.name, props: e.props, maxStates: e.maxStates, log: process.env.VERBOSE ? (s) => console.log(s) : undefined })
  } catch (err) {
    console.log(`ERROR ${(err as Error).message}`)
    unexpected++
    continue
  }
  // a run stopped by the memory bound without a violation counts as expected for 'holds', and says so
  const ok = (e.expect === 'violated') === (r.verdict === 'violated')
  if (!ok) unexpected++
  console.log(`${r.verdict === 'violated' ? `VIOLATED ${r.violated} in ${r.trace!.length} steps` : r.verdict}; ${r.states} states, ${r.transitions} transitions, depth ${r.depth}; ${r.seconds}s${ok ? '' : '   <-- NOT AS EXPECTED'}`)
  if (r.trace) r.trace.forEach((l, i) => console.log(`    ${String(i + 1).padStart(2)}. ${l}`))
  writeFileSync(join(out, `${e.name}.json`), JSON.stringify({ ...e, cfg: e.cfg, asExpected: ok, ...r }, null, 2) + '\n')
}

// summary of everything in results/bfs, in the order above
const rows = E.map((e) => join(out, `${e.name}.json`)).filter(existsSync).map((f) => JSON.parse(readFileSync(f, 'utf8')))
const md = ['# Explicit-state results (generated by bfs/run.ts; do not edit)', '',
  'Breadth-first, exhaustive within the bounds of each row; every counterexample is a shortest one in the model.', '']
const names: Record<string, string> = { teeth: 'Guard switched off (expect a counterexample)', finding: 'Design and implementation as written (a counterexample is a finding)', d30: 'D30: the compaction fix as built (compact.ts + janitor.ts)', log: 'The ledger segment log as built', amended: 'Amended protocol (expect none; exhaustive)', liveness: 'Liveness: AG EF query-done, or every object live (no leak)', proposed: 'Proposed fixes: registration before writes (R1-R3) and F16' }
for (const k of ['teeth', 'finding', 'd30', 'log', 'amended', 'liveness', 'proposed']) {
  md.push(`## ${names[k]}`, '', '| experiment | checked | result | distinct states | transitions | depth | time | P(collision) |', '|---|---|---|---|---|---|---|---|')
  for (const r of rows.filter((x) => x.kind === k)) {
    const res = r.verdict === 'violated' ? `**violated** ${r.violated} in ${r.trace.length} steps` : r.verdict === 'holds' ? 'holds (exhaustive)' : `stopped: ${r.note}`
    md.push(`| \`${r.name}\` ${r.label} | ${r.props.length > 3 ? 'all safety' : r.props.join(', ') || (r.cfg.goal === 'clean' ? 'AG EF no leak' : r.cfg.goal === 'cleanComp' ? 'AG EF no leaked compaction output' : 'AG EF done')} | ${res}${r.asExpected ? '' : ' (unexpected)'} | ${r.states.toLocaleString('en')} | ${r.transitions.toLocaleString('en')} | ${r.depth} | ${r.seconds} s | ${r.collisionProb} |`)
  }
  md.push('')
}
md.push('## Counterexamples', '')
for (const r of rows.filter((x) => x.trace)) md.push(`### ${r.name}`, '', r.label, '', `Violates \`${r.violated}\`.${r.note ? ` ${r.note}.` : ''}`, '', ...r.trace.map((l: string, i: number) => `${i + 1}. ${l}`), '')
writeFileSync(join(here, '..', 'results', 'BFS.md'), md.join('\n'))
console.log(`\nwrote results/BFS.md; ${unexpected} not as expected`)
process.exit(unexpected ? 1 : 0)
}
