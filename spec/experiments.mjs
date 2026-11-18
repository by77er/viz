#!/usr/bin/env node
// Generates one Quint instance module per experiment, runs it through TLC (exhaustive,
// breadth-first, so counterexamples are shortest) or the Quint random simulator, and
// writes results/<name>.json + results/RESULTS.md.
//
//   node experiments.mjs                 run everything (what `npm run check` does)
//   node experiments.mjs teeth           only the guard-off experiments
//   node experiments.mjs literal         only the DESIGN-as-written runs
//   node experiments.mjs witness         only the reachability witnesses
//   node experiments.mjs fixed           only the exhaustive runs of the amended protocol
//   node experiments.mjs sim             only the random simulations
//   node experiments.mjs <name> [...]    named experiments
import { spawnSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, openSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const build = join(here, 'build')
const results = join(here, 'results')
const quint = join(here, 'node_modules', '.bin', 'quint')
mkdirSync(build, { recursive: true })
mkdirSync(results, { recursive: true })

// ----------------------------------------------------------------------------- configs

/** Small default bounds. */
const BOUNDS = {
  nb: 2, ns: 1, maxSend: 2, variants: 1, maxJobs: 2, maxFlush: 3,
  maxComp: 1, maxExp: 1, maxLL: 1, maxSL: 1, maxQ: 1, maxRestarts: 2, trace: false,
}

/** DESIGN.md draft 3.1 exactly as written (where it is silent, the charitable reading). */
const LITERAL = {
  fence: true, contiguous: true, recAt: 'logged', logPrefix: true, dedup: true, fpHorizon: true,
  replaceLive: true, delGrace: true, delLogged: true, missingErr: true, keying: 'content',
  sweep: 'spec', regFirst: true, regLogged: false, unknownStream: 'empty', replanWhole: true, retain: false,
  noRetryAcrossLoss: false, ...BOUNDS,
}

/** LITERAL + the fixes proposed in README "Findings" (F1, F2, F3). The baseline for the guard-off experiments. */
const FIXED = { ...LITERAL, sweep: 'fixed', regLogged: true, noRetryAcrossLoss: true, unknownStream: 'refuse' }

const off = { maxComp: 0, maxExp: 0, maxLL: 0, maxSL: 0 }   // switch fault/maintenance actions off

const ALL = 'Safety'

/**
 * kind: 'teeth' (expect a counterexample), 'literal' (design as written: a counterexample
 * is a finding), 'fixed' (expect none; exhaustive), 'sim' (random simulation).
 */
const EXPERIMENTS = [
  // ---- (a)..(h): the guards the task names; then the extra guards the model relies on
  { name: 'a_no_fence', kind: 'teeth', label: '(a) tail read without the fence check',
    cfg: { ...FIXED, ...off, fence: false, trace: true }, inv: 'I4_NoGapAtSeam' },
  { name: 'b_highest_seq', kind: 'teeth', label: '(b) watermark = highest seq seen (no contiguity check)',
    cfg: { ...FIXED, ...off, contiguous: false, trace: true }, inv: 'I4_NoGapAtSeam' },
  { name: 'b_highest_seq_I1', kind: 'teeth', label: '(b) same guard, storage property',
    cfg: { ...FIXED, ...off, contiguous: false, trace: true }, inv: 'I1_AckedIsDurable' },
  { name: 'c_recorded_at_committed', kind: 'teeth', label: '(c) shard told `recorded` at the committed, not logged, watermark; ledger loss + rebuild',
    cfg: { ...FIXED, ...off, maxLL: 1, recAt: 'committed', trace: true }, inv: 'I5_DiscardOnlyLogged' },
  { name: 'c_recorded_at_committed_I1', kind: 'teeth', label: '(c) same guard, carried through to data loss',
    cfg: { ...FIXED, ...off, maxLL: 1, recAt: 'committed', trace: true }, inv: 'I1_AckedIsDurable' },
  { name: 'd_no_dedup', kind: 'teeth', label: '(d) no dedup fingerprints, client retry',
    cfg: { ...FIXED, ...off, dedup: false, trace: true }, inv: 'I3_NoDuplicates' },
  { name: 'e_fp_expiry', kind: 'teeth', label: '(e) fingerprint TTL shorter than the client retry horizon',
    cfg: { ...FIXED, ...off, fpHorizon: false, trace: true }, inv: 'I3_NoDuplicates' },
  { name: 'f_replace_not_live', kind: 'teeth', label: '(f) replace without the inputs-live check, racing retention',
    cfg: { ...FIXED, ...off, maxComp: 1, maxExp: 1, replaceLive: false, trace: true }, inv: 'I9_NoResurrection' },
  { name: 'g_delete_no_grace_silent', kind: 'teeth', label: '(g) physical deletion without waiting; a missing file reads as empty',
    cfg: { ...FIXED, ...off, maxComp: 1, delGrace: false, missingErr: false, trace: true }, inv: 'I4_NoGapAtSeam' },
  { name: 'g_delete_no_grace_loud', kind: 'teeth', label: '(g) physical deletion without waiting; a missing file is an error (re-plan)',
    cfg: { ...FIXED, ...off, maxComp: 1, delGrace: false, retain: true, trace: true }, inv: 'L2_NoRestart' },
  { name: 'g_delete_before_logged', kind: 'teeth', label: '(g2) retired file deleted before its removal is logged; ledger loss + rebuild',
    cfg: { ...FIXED, ...off, maxComp: 1, maxLL: 1, delLogged: false, trace: true }, inv: 'I11_LiveFilesReadable' },
  { name: 'h_overwrite', kind: 'teeth', label: '(h) deterministic key, PUT overwrites (two encoder variants)',
    cfg: { ...FIXED, ...off, keying: 'overwrite', variants: 2, trace: true }, inv: 'I11_LiveFilesReadable' },
  { name: 'h_if_none_match', kind: 'teeth', label: '(h2) deterministic key + If-None-Match (draft 3): metadata describes the loser',
    cfg: { ...FIXED, ...off, keying: 'inm', variants: 2, trace: true }, inv: 'I11_LiveFilesReadable' },
  { name: 'h_overwrite_I4', kind: 'teeth', label: '(h) same guard, carried through to a query (unreadable file reads as empty)',
    cfg: { ...FIXED, ...off, keying: 'overwrite', variants: 2, missingErr: false, trace: true }, inv: 'I4_NoGapAtSeam' },
  { name: 'i_log_out_of_order', kind: 'teeth', label: '(i) outbox entries reach R2 out of order; "logged" = own entry is on R2',
    cfg: { ...FIXED, ...off, maxLL: 1, logPrefix: false, trace: true }, inv: 'I5_DiscardOnlyLogged' },
  { name: 'i_log_out_of_order_I1', kind: 'teeth', label: '(i) same guard, carried through to data loss',
    cfg: { ...FIXED, ...off, maxLL: 1, logPrefix: false, trace: true }, inv: 'I1_AckedIsDurable' },
  { name: 'j_no_handshake', kind: 'teeth', label: '(j) stream accepts writes without registering with the ledger (shard.ts today)',
    cfg: { ...FIXED, ...off, regFirst: false, regLogged: false, trace: true }, inv: 'I4_NoGapAtSeam' },
  { name: 'k_replan_watermark_only', kind: 'teeth', label: '(k) refused tail read refreshes the watermark but keeps the old file list',
    cfg: { ...FIXED, ...off, replanWhole: false, trace: true }, inv: 'I4_NoGapAtSeam' },
  { name: 'l_sweep_any', kind: 'teeth', label: '(l) orphan sweeper deletes any unreferenced object',
    cfg: { ...FIXED, ...off, sweep: 'any', trace: true }, inv: 'I11_LiveFilesReadable' },
  { name: 'm_sweep_compaction_output', kind: 'teeth', label: '(m) sweeper treats a compaction output as "below the logged watermark"',
    cfg: { ...FIXED, ...off, maxComp: 1, sweep: 'spec_comp', trace: true }, inv: 'I11_LiveFilesReadable' },

  // ---- the design as written: counterexamples here are findings
  { name: 'F1_registration_not_logged', kind: 'literal', label: 'F1: stream registration lost in a ledger rebuild',
    cfg: { ...FIXED, ...off, maxLL: 1, regLogged: false, trace: true }, inv: 'I4_NoGapAtSeam' },
  { name: 'F1_registration_not_logged_L1', kind: 'literal', label: 'F1: same, stuck-forever variant (re-registration after a shard loss)',
    cfg: { ...FIXED, ...off, maxLL: 1, maxSL: 1, regLogged: false, trace: true }, inv: 'L1_StreamRegistered' },
  { name: 'F2_sweeper_unlogged_removal', kind: 'literal', label: 'F2: sweeper (as specified) deletes inputs of an unlogged compaction; ledger rebuild',
    cfg: { ...FIXED, ...off, maxComp: 1, maxLL: 1, sweep: 'spec', trace: true }, inv: 'I11_LiveFilesReadable' },
  { name: 'F2_sweeper_unlogged_removal_I1', kind: 'literal', label: 'F2: same, as acknowledged-data loss',
    cfg: { ...FIXED, ...off, maxComp: 1, maxLL: 1, sweep: 'spec', trace: true }, inv: 'I1_AckedIsDurable' },
  { name: 'F2_sweeper_bypasses_grace', kind: 'literal', label: 'F2: sweeper (as specified) deletes a retired file under a running query; missing = empty',
    cfg: { ...FIXED, ...off, maxComp: 1, sweep: 'spec', missingErr: false, trace: true }, inv: 'I4_NoGapAtSeam' },
  { name: 'F2_sweeper_bypasses_grace_loud', kind: 'literal', label: 'F2: same with missing = error: the query is refused although the grace rule was respected',
    cfg: { ...FIXED, ...off, maxComp: 1, sweep: 'spec', retain: true, trace: true }, inv: 'L2_NoRestart' },
  { name: 'F3_retry_after_shard_loss', kind: 'literal', label: 'F3: fingerprints die with the shard storage; a retry is accepted twice',
    cfg: { ...FIXED, ...off, maxSL: 1, noRetryAcrossLoss: false, trace: true }, inv: 'I3_NoDuplicates' },
  { name: 'F6_unknown_stream_reads_empty', kind: 'literal', label: 'F6: tailRead on a stream the shard no longer holds answers ok/empty (shard.ts) instead of refusing',
    cfg: { ...FIXED, ...off, maxSL: 1, unknownStream: 'empty', trace: true }, inv: 'I4_NoGapAtSeam' },
  { name: 'F4_missing_file_must_be_error', kind: 'literal', label: 'F4: with every fix on, a planned file can still vanish (plan from an unlogged version); missing = empty',
    cfg: { ...FIXED, ...off, maxLL: 1, variants: 2, missingErr: false, trace: true }, inv: 'I4_NoGapAtSeam' },
  { name: 'F5_restart_without_timing', kind: 'literal', label: 'F5: untimed, a query attempt is refused once per discard',
    cfg: { ...FIXED, ...off, nb: 3, maxSend: 1, maxFlush: 3, maxRestarts: 3, trace: true }, inv: 'L2_RestartsBelow3' },
  { name: 'literal_all', kind: 'literal', label: 'DESIGN 3.1 as written, all actions, all safety invariants',
    cfg: { ...LITERAL, trace: true }, inv: ALL },

  // ---- the amended protocol: exhaustive, expect no counterexample
  { name: 'fixed_1shard', kind: 'fixed', label: 'amended protocol, 1 shard, 2 batches, every action',
    cfg: { ...FIXED }, inv: ALL },
  { name: 'fixed_1shard_variants', kind: 'fixed', label: 'amended protocol, 2 encoder variants (double flush with different bytes)',
    cfg: { ...FIXED, variants: 2, maxSL: 0, maxExp: 0 }, inv: ALL },
  { name: 'fixed_1shard_3batches', kind: 'fixed', label: 'amended protocol, 1 shard, 3 batches, no shard loss / retention',
    cfg: { ...FIXED, nb: 3, maxSL: 0, maxExp: 0, maxFlush: 3 }, inv: ALL },
  { name: 'fixed_2shards', kind: 'fixed', label: 'amended protocol, 2 shards, 2 batches',
    cfg: { ...FIXED, ns: 2, maxFlush: 2, maxExp: 0 }, inv: ALL },
  { name: 'fixed_3batches_shardloss', kind: 'fixed', label: 'amended protocol, 1 shard, 3 batches, shard loss + ledger loss, no compaction / retention',
    cfg: { ...FIXED, nb: 3, maxComp: 0, maxExp: 0 }, inv: ALL },
  { name: 'fixed_2shards_all', kind: 'fixed', label: 'amended protocol, 2 shards, 2 batches, every action',
    cfg: { ...FIXED, ns: 2 }, inv: ALL },
  { name: 'fixed_2ledgerlosses', kind: 'fixed', label: 'amended protocol, 2 ledger rebuilds, no shard loss / retention',
    cfg: { ...FIXED, maxLL: 2, maxSL: 0, maxExp: 0 }, inv: ALL },
  { name: 'fixed_2queries', kind: 'fixed', label: 'amended protocol, 2 consecutive queries, no compaction',
    cfg: { ...FIXED, maxQ: 2, maxComp: 0, maxSL: 0 }, inv: ALL },
  { name: 'fixed_timing_no_restart', kind: 'fixed', label: 'liveness proxy L2: with attempt < retainRecordedMs and no storage loss, no attempt is ever refused',
    cfg: { ...FIXED, retain: true, maxSL: 0, maxLL: 0 }, inv: 'L2_NoRestart' },

  // ---- reachability witnesses on the amended protocol: a "violation" means the action is reachable
  ...['W_stale', 'W_mismatch', 'W_fileMissing', 'W_sweep', 'W_deleteRetired', 'W_replaceConflict', 'W_reRegister',
    'W_addUnitReplay', 'W_fullQuery', 'W_queryAfterShardLoss'].map((w) => ({
    name: w, kind: 'witness', label: `reachable in the amended protocol: ${w.slice(2)}`,
    cfg: { ...FIXED, variants: w === 'W_fullQuery' ? 1 : 2, maxExp: 0, trace: true }, inv: w })),

  // ---- random simulation, larger bounds
  { name: 'sim_fixed_big', kind: 'sim', label: 'amended protocol, 2 shards, 4 batches, 3 sends, 2 variants, 2 of each fault',
    cfg: { ...FIXED, nb: 4, ns: 2, maxSend: 3, variants: 2, maxJobs: 3, maxFlush: 8, maxComp: 3, maxExp: 2, maxLL: 2, maxSL: 2, maxQ: 4, maxRestarts: 6 },
    inv: ALL, samples: 60000, steps: 120 },
  { name: 'sim_literal_big', kind: 'sim', label: 'DESIGN 3.1 as written, same bounds (expected to fail: findings)',
    cfg: { ...LITERAL, nb: 4, ns: 2, maxSend: 3, variants: 2, maxJobs: 3, maxFlush: 8, maxComp: 3, maxExp: 2, maxLL: 2, maxSL: 2, maxQ: 4, maxRestarts: 6, trace: true },
    inv: ALL, samples: 60000, steps: 120 },
]

// ----------------------------------------------------------------------------- running

// TRACE=1 forces action labels on; INV=<name> overrides the invariant (for diagnosis)
if (process.env.TRACE) for (const e of EXPERIMENTS) e.cfg = { ...e.cfg, trace: true }
if (process.env.INV) for (const e of EXPERIMENTS) e.inv = process.env.INV

const q = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v))

function writeInstance(e) {
  const fields = Object.entries(e.cfg).map(([k, v]) => `${k}: ${q(v)}`).join(', ')
  const src = `// generated by experiments.mjs\nmodule ${e.name} {\n  import viz(G = { ${fields} }).* from "../viz"\n}\n`
  const file = join(build, `${e.name}.qnt`)
  writeFileSync(file, src)
  return file
}

function fmtAct(m) {
  const { n, a, b } = m
  switch (n) {
    case 'append': return `append(batch ${a} -> shard ${b})`
    case 'register': return `register(shard ${a}, incarnation ${b})`
    case 'reRegister': return `reRegister(shard ${a}, incarnation ${b})`
    case 'seal': return `seal(shard ${a}, through seq ${b})`
    case 'recorded': return `recorded(shard ${a}, through seq ${b})`
    case 'discard': return `discard(shard ${a}, through seq ${b})`
    case 'fpExpire': return `fingerprintsExpire(shard ${a}, through seq ${b})`
    case 'shardLoss': return `shardStorageLoss(shard ${a})`
    case 'flushRead': return `flushRead(shard ${a}, segment ..${b})`
    case 'flushWrite': return `flushPut(shard ${a}, segment ..${b})`
    case 'addUnit': return `addUnit(shard ${a}, ..${b}) admitted`
    case 'addUnitNoop': return `addUnit(shard ${a}, ..${b}) replay/refused, no change`
    case 'flushCrash': return `flushCrash(shard ${a}, segment ..${b})`
    case 'logWrite': return `logWrite(outbox[${a}])`
    case 'qTailOk': return `tailRead(shard ${a}, above ${b}) ok`
    case 'qTailStale': return `tailRead(shard ${a}, above ${b}) stale_watermark -> re-plan`
    case 'qTailIncarnationMismatch': return `tailRead(shard ${a}, above ${b}) incarnation_mismatch -> re-plan`
    default: return n
  }
}

function parseTlc(out) {
  const acts = [...out.matchAll(/_act = \[([^\]]*)\]/g)].map((m) => {
    const o = {}
    for (const kv of m[1].split(',')) {
      const [k, v] = kv.split('|->').map((x) => x.trim())
      o[k] = v.startsWith('"') ? v.slice(1, -1) : Number(v)
    }
    return o
  })
  const st = /(\d+) states generated, (\d+) distinct states found, (\d+) states left on queue/.exec(out)
  const depth = /depth of the complete state graph search is (\d+)/.exec(out)
  const coll = /calculated \(optimistic\):\s+val = ([0-9.E-]+)/.exec(out)
  return {
    violated: /Invariant q_inv is violated/.test(out),
    completed: /Model checking completed. No error has been found/.test(out),
    generated: st ? Number(st[1]) : null,
    distinct: st ? Number(st[2]) : null,
    queue: st ? Number(st[3]) : null,
    depth: depth ? Number(depth[1]) : null,
    fpCollisionProb: coll ? coll[1] : null,
    trace: acts.filter((a) => a.n !== 'init').map(fmtAct),
  }
}

function runTlc(e) {
  const file = writeInstance(e)
  const t0 = Date.now()
  const log = join(build, `${e.name}.log`)
  const fd = openSync(log, 'w')
  // one worker = strict breadth-first search = shortest counterexample; all cores for the big runs
  const tlcCfg = join(build, `tlc-${e.kind === 'fixed' ? 'auto' : 1}.json`)
  writeFileSync(tlcCfg, JSON.stringify(e.kind === 'fixed' ? { workers: 'auto' } : { workers: 1 }))
  spawnSync(quint, ['verify', '--backend', 'tlc', '--verbosity', '3', '--tlc-config', tlcCfg, '--invariant', e.inv, file],
    { cwd: build, stdio: ['ignore', fd, fd], timeout: 6 * 3600_000 })
  closeSync(fd)
  const out = readFileSync(log, 'utf8')
  const res = { ...parseTlc(out), seconds: Math.round((Date.now() - t0) / 100) / 10 }
  if (!res.violated && !res.completed) res.error = out.split('\n').filter((l) => /rror/.test(l)).slice(0, 5).join(' | ') || 'no verdict'
  return res
}

const WITNESSES = ['C_queryDone', 'C_queryDoneAfterDiscard', 'C_ledgerRebuilt', 'C_shardLost', 'C_compacted', 'C_queryRefused']

/** Random simulation: PROCS independent simulator processes with different seeds. */
async function runSim(e) {
  const file = writeInstance(e)
  const PROCS = 4
  const per = Math.ceil(e.samples / PROCS)
  const t0 = Date.now()
  const runs = await Promise.all([...Array(PROCS).keys()].map((i) => new Promise((resolve) => {
    const itf = join(build, `${e.name}.${i}.itf.json`)
    rmSync(itf, { force: true })
    const p = spawn(quint, ['run', '--backend', 'typescript', '--invariant', e.inv, '--max-samples', String(per),
      '--max-steps', String(e.steps), '--seed', `0x5eed${i}`, '--witnesses', ...WITNESSES, '--out-itf', itf, file], { cwd: build })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ code, out, itf }))
  })))
  const bad = runs.find((r) => r.code !== 0)
  let trace = []
  if (bad && existsSync(bad.itf)) {
    try {
      const j = JSON.parse(readFileSync(bad.itf, 'utf8'))
      const num = (x) => (x && typeof x === 'object' && '#bigint' in x ? Number(x['#bigint']) : x)
      trace = j.states.map((s) => Object.entries(s).find(([k]) => k.endsWith('act'))?.[1]).filter(Boolean)
        .map((a) => ({ n: a.n, a: num(a.a), b: num(a.b) })).filter((a) => a.n && a.n !== 'init').map(fmtAct)
    } catch { /* keep empty */ }
  }
  // "C_x was witnessed in N trace(s) out of M explored (p%)"
  const coverage = {}
  for (const r of runs) for (const m of r.out.matchAll(/(C_\w+) was witnessed in (\d+) trace\(s\) out of (\d+)/g)) {
    coverage[m[1]] = (coverage[m[1]] ?? 0) + Number(m[2])
  }
  const lens = runs.map((r) => /max=(\d+), min=(\d+), average=([\d.]+)/.exec(r.out)).filter(Boolean)
  return { simulation: true, violated: !!bad, completed: !bad, samples: per * PROCS, maxSteps: e.steps,
    traceLen: lens.length ? { max: Math.max(...lens.map((l) => Number(l[1]))), avg: Math.round(lens.reduce((a, l) => a + Number(l[3]), 0) / lens.length) } : null,
    coverage, seconds: Math.round((Date.now() - t0) / 100) / 10, trace,
    error: bad && !/Invariant violated|violation/.test(bad.out) ? bad.out.trim().split('\n').slice(-2).join(' | ') : undefined }
}

// ----------------------------------------------------------------------------- main

const args = process.argv.slice(2)
const kinds = new Set(['teeth', 'literal', 'witness', 'fixed', 'sim'])
const selected = EXPERIMENTS.filter((e) => args.length === 0 || args.includes(e.name) || (kinds.has(e.kind) && args.includes(e.kind)))
if (selected.length === 0) { console.error('no such experiment; names:\n  ' + EXPERIMENTS.map((e) => e.name).join('\n  ')); process.exit(2) }

let bad = 0
for (const e of selected) {
  process.stdout.write(`${e.name} ... `)
  const res = e.kind === 'sim' ? await runSim(e) : runTlc(e)
  const expectViolation = e.kind === 'teeth' || e.kind === 'literal' || e.kind === 'witness' || e.name === 'sim_literal_big'
  const asExpected = !res.error && res.violated === expectViolation
  if (!asExpected) bad++
  const rec = { name: e.name, kind: e.kind, label: e.label, invariant: e.invName ?? e.inv, cfg: e.cfg, expectViolation, asExpected, ...res }
  writeFileSync(join(results, `${e.name}.json`), JSON.stringify(rec, null, 2) + '\n')
  console.log(`${res.error ? 'ERROR ' + res.error : res.violated ? `VIOLATION of ${rec.invariant} in ${res.trace.length} steps` : 'no violation'}`
    + (res.distinct != null ? `; ${res.distinct} distinct states, depth ${res.depth}` : '')
    + (res.simulation ? `; ${res.samples} runs x <=${res.maxSteps} steps; coverage ${JSON.stringify(res.coverage)}` : '')
    + `; ${res.seconds}s${asExpected ? '' : '   <-- NOT AS EXPECTED'}`)
  if (res.violated) for (const [i, s] of res.trace.entries()) console.log(`    ${String(i + 1).padStart(2)}. ${s}`)
}

// Rebuild the summary from everything in results/ (so partial runs keep the table whole).
const rows = EXPERIMENTS.map((e) => join(results, `${e.name}.json`)).filter(existsSync).map((f) => JSON.parse(readFileSync(f, 'utf8')))
const md = ['# Results (generated by experiments.mjs; do not edit)', '']
for (const kind of ['teeth', 'literal', 'witness', 'fixed', 'sim']) {
  md.push(`## ${kind}`, '', '| experiment | checked | result | states (distinct / generated) | depth | time |', '|---|---|---|---|---|---|')
  for (const r of rows.filter((x) => x.kind === kind)) {
    const result = r.error ? `ERROR ${r.error}` : r.violated ? `violated in ${r.trace.length} steps` : r.simulation ? 'no violation found' : 'holds (exhaustive)'
    const states = r.simulation ? `${r.samples} runs, <= ${r.maxSteps} steps (longest ${r.traceLen?.max}, mean ${r.traceLen?.avg}); traces reaching: ${Object.entries(r.coverage ?? {}).map(([k, v]) => `${k.slice(2)} ${v}`).join(', ')}` : `${r.distinct} / ${r.generated}`
    md.push(`| \`${r.name}\` ${r.label} | ${r.invariant} | ${result}${r.asExpected ? '' : ' **(unexpected)**'} | ${states} | ${r.depth ?? ''} | ${r.seconds}s |`)
  }
  md.push('')
}
md.push('## Counterexamples', '')
for (const r of rows.filter((x) => x.violated && x.kind !== 'witness')) {
  md.push(`### ${r.name}: ${r.label}`, '', `Violates \`${r.invariant}\`.`, '', ...r.trace.map((s, i) => `${i + 1}. ${s}`), '')
}
writeFileSync(join(results, 'RESULTS.md'), md.join('\n'))
console.log(`\nwrote results/RESULTS.md; ${bad} experiment(s) not as expected`)
process.exit(bad ? 1 : 0)
