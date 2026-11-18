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
  nt: 1, ns: 1, nb: 2, maxSend: 2, variants: 1, maxJobs: 2, maxCJobs: 1, maxComp: 0, maxExp: 0, maxLL: 0, maxSL: 0,
  maxQ: 1, maxRestarts: 2, sameContent: false, liveness: false,
} as const

/** Every rule as the README's amended protocol states it. The baseline of the guard-off experiments. */
export const AMENDED: Cfg = {
  ...SMALL,
  fence: true, contiguous: true, recAt: 'logged', dedup: true, fpHorizon: true, replaceLive: true, delGrace: true,
  delLogged: true, missingErr: true, keying: 'content', sweep: 'impl', reg: 'logged', query: 'impl', unknownStream: 'refuse',
  readBound: true, log: 'segments', rebuild: 'strict', drainRetrySame: true, baseFirst: true, compKey: 'unique',
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
  reg: 'design', query: 'design', sweep: 'spec', drainRetrySame: false, baseFirst: false, compConflictDelete: false,
  noRetryAcrossLoss: false,
}

/** As built: shard.ts, ledger.ts (one R2 object per change), flush.ts, compact.ts, janitor.ts, query coordinator.ts. */
export const IMPL: Cfg = {
  ...AMENDED,
  reg: 'impl', query: 'impl', unknownStream: 'empty', readBound: false, log: 'perChange', baseFirst: true,
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
E.push({ name: 'o_read_unbound', kind: 'teeth', label: '(o) flush reads readSegment(tenant, seqLo) unbound to the incarnation. NO counterexample: with registration before writes (F1 fix) the stale unit is refused as incarnation_mismatch; it bites only with lazy registration (F12)', cfg: { ...AMENDED, readBound: false, maxSL: 1 }, props: ['I3_NoDuplicates'], expect: 'holds' })
teeth('p_drain_retry_new_bounds', '(p) a retried drain writes all pending changes (new bounds); strict replay', { drainRetrySame: false, maxLL: 1 }, 'AV_RebuildSucceeds')

// ---- the design as written (DESIGN.md 3.1 + LEDGER-LOG.md) and the implementation as built
const FAULTS = { maxComp: 1, maxExp: 1, maxLL: 1, maxSL: 1 }
finding('DESIGN_all', 'DESIGN.md 3.1 + LEDGER-LOG.md as written, every action, every safety property', { ...DESIGN, ...FAULTS }, ALLSAFE)
finding('F1_registration_rolled_back', 'F1: registration committed, not logged; ledger rebuild forgets the stream (design reg, others fixed)', { ...AMENDED, reg: 'design', query: 'design', maxLL: 1 }, ['I4_NoGapAtSeam'])
finding('F2_sweeper_spec_I1', 'F2: orphan sweeper as DESIGN §4.3 states it; ledger rebuild', { ...AMENDED, sweep: 'spec', maxComp: 1, maxLL: 1 }, ['I1_AckedIsDurable'])
finding('F2_sweeper_spec_grace', 'F2: same sweeper deletes a removed file under a running query (missing read as empty)', { ...AMENDED, sweep: 'spec', maxComp: 1, missingErr: false }, ['I4_NoGapAtSeam'])
finding('F3_retry_after_shard_loss', 'F3: fingerprints die with the shard storage; a retry is stored again', { ...AMENDED, noRetryAcrossLoss: false, maxSL: 1 }, ['I3_NoDuplicates'])
finding('F10_segments_overlap', 'F10 (LEDGER-LOG.md): drain PUTs v1..vk, dies before deleting the rows, a change commits, the retry PUTs v1..vk+1', { ...AMENDED, drainRetrySame: false }, ['LOG_SegmentsDisjoint'])
finding('F10_rebuild_refuses', 'F10: same, then the ledger loses its storage: a strict replay refuses the log', { ...AMENDED, drainRetrySame: false, maxLL: 1 }, ['AV_RebuildSucceeds'])
finding('F11_incarnation_reused', 'F11 (LEDGER-LOG.md): base is an ordinary first change; two ledger losses before it is drained', { ...AMENDED, baseFirst: false, maxLL: 2 }, ['V_IncarnationNotReused'])
finding('IMPL_all', 'As built (shard.ts, ledger.ts, flush.ts, compact.ts, janitor.ts, coordinator.ts), every action, every safety property', { ...IMPL, ...FAULTS }, ALLSAFE)
finding('F6_impl_unknown_stream', 'F6: shard.ts tailRead answers ok/empty for a stream it lost', { ...IMPL, maxSL: 1 }, ['I4_NoGapAtSeam'])
finding('F12_impl_read_unbound', 'F12: shard.ts readSegment(tenant, seqLo) ignores the incarnation; a flush across a shard loss', { ...IMPL, maxSL: 1, unknownStream: 'refuse' }, ['I3_NoDuplicates'])
finding('F13_impl_comp_adopts_old_output', 'F13: compaction adopts an earlier step\'s output ("exists"); the sweeper judges it by the earlier upload', { ...IMPL, maxComp: 1 }, ['I11_LiveFilesReadable'])
finding('F14_impl_comp_conflict_delete', 'F14: compaction deletes its output on conflict although an identical step made it live and it has been removed since (removal not yet logged); ledger rebuild', { ...IMPL, sweep: 'off', maxComp: 1, maxCJobs: 2, maxExp: 1, maxLL: 1 }, ['I11_LiveFilesReadable'])
finding('IMPL_PLANNED_all', 'As built + the planned segment log of LEDGER-LOG.md', { ...IMPL_PLANNED, maxLL: 1 }, ALLSAFE)

// ---- the amended protocol: exhaustive within bounds, expect no violation
const amended = (name: string, label: string, over: Partial<Cfg>, maxStates?: number) =>
  E.push({ name, kind: 'amended', label, cfg: { ...AMENDED, ...over }, props: ALLSAFE, expect: 'holds', maxStates })
amended('A_1shard_2batches', '1 tenant, 1 shard, 2 batches, 1 of each fault and maintenance action', { ...FAULTS })
amended('A_1shard_3batches', '1 tenant, 1 shard, 3 batches (1 send each), ledger loss + shard loss', { nb: 3, maxSend: 1, maxLL: 1, maxSL: 1 })
amended('A_2shards', '1 tenant, 2 shards, 2 batches, ledger loss + shard loss + compaction', { ns: 2, maxLL: 1, maxSL: 1, maxComp: 1 })
amended('A_2tenants', '2 tenants in 1 pooled shard, 2 batches, ledger loss + shard loss', { nt: 2, nb: 2, maxLL: 1, maxSL: 1, sameContent: true })
amended('A_impl_fixed', 'as built + the fixes for F3 (assumed), F6, F12, F13/F14 (step-unique compaction keys); ledger loss, shard loss, compaction, retention', { ...IMPL, unknownStream: 'refuse', readBound: true, compKey: 'unique', noRetryAcrossLoss: true, ...FAULTS })
amended('A_variants_2LL', '2 encoder outputs per segment, 2 ledger losses, 2 compaction steps at once', { variants: 2, maxLL: 2, maxComp: 1, maxCJobs: 2 })

// ---- liveness: AG EF (query done) on the whole graph; unbounded refusals
const live = (name: string, label: string, cfg: Cfg, expect: 'holds' | 'violated') =>
  E.push({ name, kind: 'liveness', label, cfg: { ...cfg, liveness: true }, props: [], expect })
live('LIVE_amended', 'amended protocol, ledger loss + shard loss + compaction', { ...AMENDED, maxLL: 1, maxSL: 1, maxComp: 1 }, 'holds')
live('LIVE_design', 'DESIGN as written, ledger loss + shard loss', { ...DESIGN, maxLL: 1, maxSL: 1 }, 'violated')
live('LIVE_impl', 'as built, ledger loss + shard loss + compaction', { ...IMPL, maxLL: 1, maxSL: 1, maxComp: 1 }, 'holds')

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
  const ok = (e.expect === 'violated') === (r.verdict === 'violated') && r.verdict !== 'stopped'
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
