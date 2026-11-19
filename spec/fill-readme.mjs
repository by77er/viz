#!/usr/bin/env node
// Regenerates the result tables in README.md from results/*.json (TLC, experiments.mjs) and
// results/bfs/*.json (explicit-state checker, bfs/run.ts). Each table sits between
// `<!-- BEGIN NAME -->` and `<!-- END NAME -->`.
//
//   node fill-readme.mjs          print the tables
//   node fill-readme.mjs --write  replace them in README.md
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const load = (dir, orderFile) => {
  if (!existsSync(dir)) return []
  const rs = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ ...JSON.parse(readFileSync(join(dir, f), 'utf8')), mtime: statSync(join(dir, f)).mtimeMs }))
  const order = readFileSync(orderFile, 'utf8')
  return rs.sort((a, b) => order.indexOf(`'${a.name}'`) - order.indexOf(`'${b.name}'`))
}
const tlc = load(join(here, 'results'), join(here, 'experiments.mjs'))
const bfs = load(join(here, 'results', 'bfs'), join(here, 'bfs', 'run.ts'))
const n = (x) => (x == null ? '' : Number(x).toLocaleString('en'))
/** Results written before this pass started (2026-11-18 22:08 UTC) are the earlier pass's, not re-run. */
const PASS2 = Date.parse('2026-11-18T22:08:00Z')
const when = (r) => (r.mtime >= PASS2 ? 're-run' : 'earlier pass only')

// ---------------------------------------------------------------- TLC (viz.qnt) tables
const shortT = (s0) => {
  const m = /shard ([1-9])/.exec(s0)
  return s0
    .replace(/append\(batch (\d+) -> shard (\d+)\)/, 'append(b$1)')
    .replace(/register\(shard (\d+), incarnation (\d+)\)/, 'register(inc $2)')
    .replace(/reRegister\(shard (\d+), incarnation (\d+)\)/, 'reRegister(inc $2)')
    .replace(/seal\(shard \d+, through seq (\d+)\)/, 'seal(..$1)')
    .replace(/recorded\(shard \d+, through seq (\d+)\)/, 'recorded($1)')
    .replace(/discard\(shard \d+, through seq (\d+)\)/, 'discard($1)')
    .replace(/fingerprintsExpire\(shard \d+, through seq (\d+)\)/, 'fpExpire($1)')
    .replace(/shardStorageLoss\(shard \d+\)/, 'SHARD-LOSS')
    .replace(/flushRead\(shard \d+, segment \.\.(\d+)\)/, 'flushRead(..$1)')
    .replace(/flushPut\(shard \d+, segment \.\.(\d+)\)/, 'put(..$1)')
    .replace(/addUnit\(shard \d+, \.\.(\d+)\) admitted/, 'addUnit(..$1)')
    .replace(/addUnit\(shard \d+, \.\.(\d+)\) replay\/refused, no change/, 'addUnit(..$1)=noop')
    .replace(/logWrite\(outbox\[(\d+)\]\)/, (_m, i) => (i === '0' ? 'log' : `log[${i}]`))
    .replace(/tailRead\(shard \d+, above (\d+)\) ok/, 'tail(>$1)=ok')
    .replace(/tailRead\(shard \d+, above (\d+)\) stale_watermark -> re-plan/, 'tail(>$1)=STALE')
    .replace(/tailRead\(shard \d+, above (\d+)\) incarnation_mismatch -> re-plan/, 'tail(>$1)=MISMATCH')
    .replace('ledgerLossRebuild', 'LEDGER-LOSS+REBUILD').replace('qPlan', 'plan').replace('qDone', 'done')
    .replace('qFileMissingReplan', 'file missing → re-plan') + (m ? `@s${m[1]}` : '')
}
const tlcTable = (kind) => ['| Experiment | Property | Result | Steps | Distinct states | Run | Shortest counterexample |', '|---|---|---|---|---|---|---|',
  ...tlc.filter((r) => r.kind === kind).map((r) => `| \`${r.name}\` ${r.label} | ${r.invariant} | ${r.error ? 'ERROR' : r.violated ? 'violated' : '**none found**'} | ${r.violated ? r.trace.length : ''} | ${n(r.distinct)} | ${when(r)} | ${r.violated ? r.trace.map(shortT).join(' → ') : ''} |`)].join('\n')

const out = {}
out.TLC_TEETH = tlcTable('teeth')
out.TLC_LITERAL = tlcTable('literal')
out.TLC_WITNESS = ['| Witness (reachable in the amended protocol) | Steps to reach | Distinct states | Time | Run |', '|---|---|---|---|---|',
  ...tlc.filter((r) => r.kind === 'witness').map((r) => `| \`${r.name}\` | ${r.violated ? r.trace.length : r.error ? 'ERROR' : '**not reached**'} | ${n(r.distinct)} | ${r.seconds} s | ${when(r)} |`)].join('\n')
out.TLC_FIXED = ['| Run | Bounds that differ from the common ones | Checked | Result | Distinct states | States generated | Depth | Wall time | Workers | P(fingerprint collision) | Run |', '|---|---|---|---|---|---|---|---|---|---|---|',
  ...tlc.filter((r) => r.kind === 'fixed').map((r) => {
    const c = r.cfg
    const d = [c.ns !== 1 && `${c.ns} shards`, c.nb !== 2 && `${c.nb} batches`, c.variants !== 1 && `${c.variants} encoder variants`, c.maxLL !== 1 && `${c.maxLL} ledger losses`,
      c.maxSL !== 1 && `${c.maxSL} shard losses`, c.maxExp !== 1 && `${c.maxExp} retention removals`, c.maxComp !== 1 && `${c.maxComp} compactions`, c.maxQ !== 1 && `${c.maxQ} queries`,
      c.maxFlush !== 3 && `${c.maxFlush} flush attempts`, c.retain && 'timing assumption `retain`'].filter(Boolean).join(', ') || '—'
    return `| \`${r.name}\` | ${d} | ${r.invariant} | ${r.error ? 'ERROR' : r.violated ? `**VIOLATED** in ${r.trace.length} steps` : 'holds, exhaustive'} | ${n(r.distinct)} | ${n(r.generated)} | ${r.depth} | ${r.seconds} s | ${r.workers ?? 'auto (4)'} | ${r.fpCollisionProb ?? ''} | ${when(r)} |`
  })].join('\n')
out.TLC_SIM = ['| Run | Bounds | Checked | Runs | Trace length | Result | Wall time | Runs that reached … | Run |', '|---|---|---|---|---|---|---|---|---|',
  ...tlc.filter((r) => r.kind === 'sim').map((r) => {
    const c = r.cfg
    return `| \`${r.name}\` | ${c.ns} shards, ${c.nb} batches, ≤ ${c.maxSend} sends, ${c.variants} variants, ≤ ${c.maxFlush} flushes, ${c.maxComp} compactions, ${c.maxExp} retention removals, ${c.maxLL} ledger losses, ${c.maxSL} shard losses, ${c.maxQ} queries | ${r.invariant} | ${n(r.samples)} | ≤ ${r.maxSteps} ${r.traceLen ? `(longest ${r.traceLen.max}, mean ${r.traceLen.avg})` : ''} | ${r.violated ? `violated (random, unminimised ${r.trace.length}-step trace)` : 'no violation found (simulation, not exhaustive)'} | ${r.seconds} s | ${Object.entries(r.coverage ?? {}).map(([k, v]) => `${k.slice(2)}: ${v}`).join(', ')} | ${when(r)} |`
  })].join('\n')

// ---------------------------------------------------------------- explicit-state (bfs/) tables
const shortB = (s) => s
  .replace(/^registerStream\((s\d)(?: (t\d))?, inc (\d+)\)$/, (_m, sh, t, i) => `register(${t ? t + ' ' : ''}inc ${i})`)
  .replace(/^registration logged -> .*$/, 'regLogged')
  .replace(/^reRegister\(.*inc (\d+)\)$/, 'reRegister(inc $1)')
  .replace(/^ledger( t\d)? drain: PUT (change|segment) v(\d+)\.\.v(\d+)$/, (_m, t, k, a, b) => `${k === 'change' ? 'log' : 'drainPUT'}${t ?? ''}(v${a}${a === b ? '' : `-v${b}`})`)
  .replace(/^ledger( t\d)? drain: delete outbox rows .*$/, (_m, t) => `drainCommit${t ?? ''}`)
  .replace(/^ledger( t\d)? drain crash after PUT$/, (_m, t) => `DRAIN-CRASH${t ?? ''}`)
  .replace(/^append\((b\d)(?: t\d)? -> s\d\)=duplicate.*$/, 'append($1)=dup')
  .replace(/^append\((b\d)(?: t\d)? -> s\d\) seq \d+ \[retry\]$/, 'retry($1)')
  .replace(/^append\((b\d)(?: t\d)? -> (s\d)\) seq \d+$/, 'append($1)')
  .replace(/^seal\(s\d(?: t\d)?, \.\.(\d+)\)$/, 'seal(..$1)')
  .replace(/^recorded\(s\d(?: t\d)?, \.\.(\d+)\)$/, 'recorded($1)')
  .replace(/^discard\(s\d(?: t\d)?, \.\.(\d+)\)$/, 'discard($1)')
  .replace(/^fingerprintsExpire\(.*\.\.(\d+)\)$/, 'fpExpire($1)')
  .replace(/^flush: pendingSegments\(.*\) -> inc (\d+) (\d+\.\.\d+)$/, 'list(inc$1 $2)')
  .replace(/^flush readSegment\(s\d inc (\d+) (\d+\.\.\d+)\)( \[rows of inc (\d+)\])?.*$/, (_m, i, r, x, j) => `read(inc${i} ${r}${x ? `, gets inc${j}'s rows` : ''})`)
  .replace(/^flush readSegment\((.*)\) -> segment gone, stop$/, 'read=gone')
  .replace(/^flush PUT L0\(s\d inc(\d+) (\d+\.\.\d+)( v\d)?\)$/, (_m, i, r, v) => `put(${r}${v ? v.trim() : ''})`)
  .replace(/^flush crash .*$/, 'flushCrash')
  .replace(/^flush registerStream\(.*inc (\d+)\)$/, 'flush registers inc $1')
  .replace(/^addUnit\(s\d(?: t\d)? inc (\d+) (\d+\.\.\d+)\) admitted \(registers the stream\)$/, 'addUnit(inc$1 $2, registers)')
  .replace(/^addUnit\(s\d(?: t\d)? inc (\d+) (\d+\.\.\d+)\) admitted$/, 'addUnit(inc$1 $2)')
  .replace(/^addUnit\(s\d(?: t\d)? inc \d+ (\d+\.\.\d+)\) = (.*)$/, 'addUnit($1)=$2')
  .replace(/^query( t\d)?: plan \((.*)\)$/, (_m, t) => `plan${t ?? ''}`)
  .replace(/^query: tailRead\(s\d, inc (\d+), above (\d+)\) = ok (.*)$/, (_m, i, a, g) => `tail(inc${i} >${a})=${g === 'nothing' ? '∅' : g}`)
  .replace(/^query: tailRead\(s\d, inc (\d+), above (\d+)\) = (.*) -> re-plan$/, (_m, i, a, w) => `tail(inc${i} >${a})=${w.toUpperCase()} → re-plan`)
  .replace(/^query: read files, merge -> (.*?)( \(.*\))?$/, (_m, g, u) => `done{${g === 'nothing' ? '' : g}}${u ? ' (file unreadable, read as empty)' : ''}`)
  .replace(/^query: .* missing -> re-plan$/, 'file missing → re-plan')
  .replace(/^compact( t\d)?: read .*$/, 'compRead')
  .replace(/^compact PUT .*$/, 'compPut')
  .replace(/^compact crash .*$/, 'compCrash')
  .replace(/^replace\(.*\) committed$/, 'replace')
  .replace(/^replace\(.*\) = (.*)$/, 'replace=$1')
  .replace(/^expire( t\d)? (.*)$/, 'expire($2)')
  .replace(/^purge( t\d)?: delete (.*)$/, 'purge($2)')
  .replace(/^orphan sweep: delete (.*)$/, 'sweep($1)')
  .replace(/^orphan sweep( t\d)?: list (.*)$/, 'sweepList')
  .replace(/^orphan sweep( t\d)?: orphanCheck first$/, 'sweepRead')
  .replace(/^orphan sweep: orphanCheck -> doomed (.*)$/, 'sweepRead→doomed $1')
  .replace(/^orphan sweep: list -> doomed (.*)$/, 'sweepList→doomed $1')
  .replace(/^orphan sweep: (orphanCheck|list) -> nothing to delete$/, 'sweep: nothing')
  .replace(/^orphan sweep: stops$/, 'sweepStops')
  .replace(/^purge( t\d)?: forget (.*)$/, 'forget($2)')
  .replace(/^ledger( t\d)? start: PUT base segment of incarnation (\d+)$/, 'start: PUT base(inc $2)')
  .replace(/^ledger( t\d)? start: commit incarnation (\d+), serve$/, 'start: commit(inc $2)')
  .replace(/^LEDGER( t\d)? STORAGE LOSS -> rebuild from R2(.*)$/, (_m, t, x) => `LEDGER-LOSS+rebuild${x.includes('REFUSED') ? ' REFUSED' : x.includes('reused') ? ' (incarnation reused)' : ''}${/start incarnation (\d+)/.test(x) ? ` → inc ${/start incarnation (\d+)/.exec(x)[1]}` : ''}`)
  .replace(/^SHARD STORAGE LOSS\(s\d\)$/, 'SHARD-LOSS')
const bres = (r) => (r.verdict === 'violated' ? `**${r.violated}** violated` : r.verdict === 'holds' ? 'holds (exhaustive)' : `stopped (memory bound): ${r.note}`)
const bfsTraceTable = (kind) => ['| Experiment | Checked | Result | Steps | Distinct states | Time | Shortest counterexample |', '|---|---|---|---|---|---|---|',
  ...bfs.filter((r) => r.kind === kind).map((r) => `| \`${r.name}\` ${r.label} | ${r.props.length > 3 ? 'all safety' : r.props.join(', ')} | ${bres(r)} | ${r.trace ? r.trace.length : ''} | ${n(r.states)} | ${r.seconds} s | ${r.trace ? r.trace.map(shortB).join(' → ') : ''} |`)].join('\n')
out.BFS_TEETH = bfsTraceTable('teeth')
out.BFS_FINDINGS = bfsTraceTable('finding')
out.BFS_D30 = bfsTraceTable('d30')
out.BFS_LOG = bfsTraceTable('log')
const bounds = (c) => `${c.nt} tenant${c.nt > 1 ? 's' : ''}, ${c.ns} shard${c.ns > 1 ? 's' : ''}, ${c.nb} batches × ≤ ${c.maxSend} sends, ≤ ${c.maxJobs} flush Workers and ≤ ${c.maxCJobs} compaction steps at once, ${c.variants} encoder output${c.variants > 1 ? 's' : ''}, ≤ ${c.maxComp} compaction / ${c.maxExp} retention / ${c.maxLL} ledger loss / ${c.maxSL} shard loss, ${c.maxQ} quer${c.maxQ > 1 ? 'ies' : 'y'}${c.liveness ? ', unbounded refusals' : `, ≤ ${c.maxRestarts} refusals`}`
out.BFS_AMENDED = ['| Run | Bounds | Checked | Result | Distinct states | Transitions | Depth | Wall time | P(collision) |', '|---|---|---|---|---|---|---|---|---|',
  ...bfs.filter((r) => r.kind === 'amended' || r.kind === 'liveness').map((r) => `| \`${r.name}\` ${r.label} | ${bounds(r.cfg)} | ${r.kind === 'liveness' ? (r.cfg.goal === 'clean' ? 'AG EF no leak' : r.cfg.goal === 'cleanComp' ? 'AG EF no leaked compaction output' : 'AG EF query done') : 'all safety'} | ${bres(r)}${r.trace ? ` in ${r.trace.length} steps${r.cfg.goal && r.cfg.goal !== 'query' && r.note ? `; ${r.note.replace(/^.*unlisted then: /, 'left: ')}` : ''}` : ''} | ${n(r.states)} | ${n(r.transitions)} | ${r.depth} | ${r.seconds} s | ${r.collisionProb} |`)].join('\n')
const total = [...tlc, ...bfs].reduce((a, r) => a + (r.seconds ?? 0), 0)
out.TOTAL = `${Math.round(total / 60)} minutes of wall time in total (sum over all runs recorded in results/)`

if (process.argv.includes('--write')) {
  const p = join(here, 'README.md')
  let md = readFileSync(p, 'utf8')
  for (const [k, v] of Object.entries(out)) {
    const re = new RegExp(`<!-- BEGIN ${k} -->[\\s\\S]*?<!-- END ${k} -->`)
    md = md.replace(re, () => `<!-- BEGIN ${k} -->\n${v}\n<!-- END ${k} -->`)
  }
  writeFileSync(p, md)
  console.log('README.md tables regenerated')
} else console.log(Object.entries(out).map(([k, v]) => `<!-- ${k} -->\n${v}\n`).join('\n'))
