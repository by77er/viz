// Runs the explicit-state experiments and writes results/bfs/<name>.json and results/BFS.md.
//
//   node bfs/run.ts                 everything
//   node bfs/run.ts teeth           guard-off experiments (expect a counterexample each)
//   node bfs/run.ts findings        the design / implementation as written (a counterexample is a finding)
//   node bfs/run.ts amended         the amended protocol, exhaustive (expect none)
//   node bfs/run.ts liveness        AG EF query-done on the full state graph
//   node bfs/run.ts <name> [...]    named experiments
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, type Result } from './check.ts'
import { type Cfg, SAFETY } from './model.ts'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'results', 'bfs')
mkdirSync(out, { recursive: true })

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
  f6Register: true, readBound: true, log: 'segments', rebuild: 'strict', drainRetrySame: true, baseFirst: true, compKey: 'unique',
  compConflictDelete: true, fpScope: 'stream', tailScope: 'stream', noRetryAcrossLoss: true, retain: false,
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

/** As built: shard.ts, ledger.ts (one R2 object per change), flush.ts, compact.ts, janitor.ts, query coordinator.ts. */
export const IMPL: Cfg = {
  ...AMENDED,
  reg: 'impl', query: 'impl', unknownStream: 'empty', readBound: false, log: 'perChange', baseFirst: true, sweepIncLogged: false,
  sweep: 'impl', compKey: 'inputs', compConflictDelete: true, noRetryAcrossLoss: false,
}

/** As built, with the ledger's log replaced by the PLANNED segments of LEDGER-LOG.md. */
export const IMPL_PLANNED: Cfg = { ...IMPL, log: 'segments', drainRetrySame: false, baseFirst: false }

const ALLSAFE = SAFETY

interface Exp {
  name: string
  kind: 'teeth' | 'finding' | 'amended' | 'liveness'
  label: string
  cfg: Cfg
  props: string[]
  expect: 'violated' | 'holds'
  maxStates?: number
}

const E: Exp[] = []
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
const IMPL_PEEL: [string, Partial<Cfg>][] = [
  ['IMPL_1_as_built', {}],
  ['IMPL_2_assume_F3', { noRetryAcrossLoss: true }],
  ['IMPL_3_fix_F12', { noRetryAcrossLoss: true, readBound: true }],
  ['IMPL_4_fix_F6', { noRetryAcrossLoss: true, readBound: true, unknownStream: 'refuse', reg: 'logged' }],
  ['IMPL_5_fix_F15', { noRetryAcrossLoss: true, readBound: true, unknownStream: 'refuse', reg: 'logged', sweepIncLogged: true }],
  ['IMPL_6_fix_F13_F14', { noRetryAcrossLoss: true, readBound: true, unknownStream: 'refuse', reg: 'logged', sweepIncLogged: true, compKey: 'unique' }],
]
for (const [name, over] of IMPL_PEEL) {
  E.push({ name, kind: 'finding', label: `as built (shard.ts, ledger.ts, flush.ts, compact.ts, janitor.ts, coordinator.ts)${Object.keys(over).length ? ` + ${Object.keys(over).join(', ')}` : ''}; every action (1 compaction, 1 retention removal, 1 ledger loss, 1 shard loss), every safety property`,
    cfg: { ...IMPL, ...FAULTS, ...over }, props: ALLSAFE, expect: name === 'IMPL_6_fix_F13_F14' ? 'holds' : 'violated', maxStates: 6_000_000 })
}
finding('F6_impl_unknown_stream', 'F6: shard.ts tailRead answers ok/empty for a stream it lost (no client retry across the loss)', { ...IMPL, maxSL: 1, noRetryAcrossLoss: true }, ['I4_NoGapAtSeam'])
finding('F12_impl_read_unbound', 'F12: shard.ts readSegment(tenant, seqLo) ignores the incarnation; a flush across a shard loss (no client retry across the loss)', { ...IMPL, maxSL: 1, unknownStream: 'refuse', noRetryAcrossLoss: true }, ['I3_NoDuplicates'])
finding('F13_impl_comp_adopts_old_output', 'F13: compaction adopts an earlier step\'s output ("exists"); the sweeper judges it by the earlier upload', { ...IMPL, maxComp: 1 }, ['I11_LiveFilesReadable'])
finding('F14_impl_comp_conflict_delete', 'F14: compaction deletes its output on conflict although an identical step made it live and it has been removed since (removal not yet logged); ledger rebuild', { ...IMPL, sweep: 'off', maxSend: 1, maxJobs: 1, maxQ: 0, maxComp: 1, maxCJobs: 2, maxExp: 1, maxLL: 1 }, ['I11_LiveFilesReadable'])
finding('F15_sweeper_trusts_unlogged_registration', 'F15: janitor.ts calls an old-incarnation flush file dead because the ledger has a newer incarnation, whose registration is not yet logged; ledger rebuild', { ...AMENDED, sweepIncLogged: false, maxSL: 1, maxLL: 1 }, ['I11_LiveFilesReadable'])
finding('IMPL_PLANNED_fixed', 'As built with the fixes above (F6, F12, F13/F14, F3 assumed), and the ledger log replaced by the PLANNED segments of LEDGER-LOG.md; ledger loss, compaction', { ...IMPL_PLANNED, unknownStream: 'refuse', noRetryAcrossLoss: true, readBound: true, compKey: 'unique', sweepIncLogged: true, maxLL: 1, maxComp: 1 }, ALLSAFE)

// ---- the amended protocol: exhaustive within bounds, expect no violation
const amended = (name: string, label: string, over: Partial<Cfg>, maxStates?: number) =>
  E.push({ name, kind: 'amended', label, cfg: { ...AMENDED, ...over }, props: ALLSAFE, expect: 'holds', maxStates })
amended('A_retries_faults', 'client retries + two flush Workers, ledger loss + shard loss', { maxLL: 1, maxSL: 1 }, 4_000_000)
amended('A_maintenance_faults', 'compaction (2 steps at once) + retention + ledger loss + shard loss, no client retry', { maxSend: 1, maxComp: 1, maxCJobs: 2, maxExp: 1, maxLL: 1, maxSL: 1 }, 4_000_000)
amended('A_3batches', '3 batches, ledger loss + shard loss, no client retry', { nb: 3, maxSend: 1, maxLL: 1, maxSL: 1 }, 4_000_000)
amended('A_2shards', '2 shards, ledger loss + shard loss + compaction, no client retry', { ns: 2, maxSend: 1, maxLL: 1, maxSL: 1, maxComp: 1 }, 4_000_000)
amended('A_2tenants', '2 tenants in one pooled shard sending identical bytes, ledger loss + shard loss, no client retry', { nt: 2, nb: 2, maxSend: 1, maxLL: 1, maxSL: 1, sameContent: true }, 4_000_000)

// ---- liveness: AG EF (query done) on the whole graph; unbounded refusals
const live = (name: string, label: string, cfg: Cfg, expect: 'holds' | 'violated') =>
  E.push({ name, kind: 'liveness', label, cfg: { ...cfg, liveness: true }, props: [], expect })
live('LIVE_amended', 'amended protocol, ledger loss + shard loss + compaction (1 send per batch)', { ...AMENDED, maxSend: 1, maxLL: 1, maxSL: 1, maxComp: 1 }, 'holds')
live('LIVE_design', 'DESIGN as written, ledger loss + shard loss (1 send per batch)', { ...DESIGN, maxSend: 1, maxLL: 1, maxSL: 1 }, 'violated')
live('LIVE_impl', 'as built, ledger loss + shard loss, no compaction (1 send per batch)', { ...IMPL, maxSend: 1, maxLL: 1, maxSL: 1 }, 'holds')
live('LIVE_impl_F6_refuse_only', 'as built + tailRead refuses an unknown stream but nothing re-registers it; shard loss (1 send per batch)', { ...IMPL, unknownStream: 'refuse', f6Register: false, maxSend: 1, maxSL: 1 }, 'violated')
live('LIVE_impl_F6_fixed', 'as built + F6 fixed completely (refuse, and register before writes, so the refusing shard re-registers), + F15 fix; ledger loss + shard loss (1 send per batch)', { ...IMPL, unknownStream: 'refuse', reg: 'logged', sweepIncLogged: true, maxSend: 1, maxLL: 1, maxSL: 1 }, 'holds')

// ------------------------------------------------------------------ main

const args = process.argv.slice(2)
const kinds = new Set(['teeth', 'finding', 'amended', 'liveness'])
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
const names: Record<string, string> = { teeth: 'Guard switched off (expect a counterexample)', finding: 'Design and implementation as written (a counterexample is a finding)', amended: 'Amended protocol (expect none; exhaustive)', liveness: 'Liveness: AG EF query-done' }
for (const k of ['teeth', 'finding', 'amended', 'liveness']) {
  md.push(`## ${names[k]}`, '', '| experiment | checked | result | distinct states | transitions | depth | time | P(collision) |', '|---|---|---|---|---|---|---|---|')
  for (const r of rows.filter((x) => x.kind === k)) {
    const res = r.verdict === 'violated' ? `**violated** ${r.violated} in ${r.trace.length} steps` : r.verdict === 'holds' ? 'holds (exhaustive)' : `stopped: ${r.note}`
    md.push(`| \`${r.name}\` ${r.label} | ${r.props.length > 3 ? 'all safety' : r.props.join(', ') || 'AG EF done'} | ${res}${r.asExpected ? '' : ' (unexpected)'} | ${r.states.toLocaleString('en')} | ${r.transitions.toLocaleString('en')} | ${r.depth} | ${r.seconds} s | ${r.collisionProb} |`)
  }
  md.push('')
}
md.push('## Counterexamples', '')
for (const r of rows.filter((x) => x.trace)) md.push(`### ${r.name}`, '', r.label, '', `Violates \`${r.violated}\`.`, '', ...r.trace.map((l: string, i: number) => `${i + 1}. ${l}`), '')
writeFileSync(join(here, '..', 'results', 'BFS.md'), md.join('\n'))
console.log(`\nwrote results/BFS.md; ${unexpected} not as expected`)
process.exit(unexpected ? 1 : 0)
