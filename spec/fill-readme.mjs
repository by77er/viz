#!/usr/bin/env node
// Prints the result tables of README.md from results/*.json (run after experiments.mjs).
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = join(dirname(fileURLToPath(import.meta.url)), 'results')
const rs = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
const order = readFileSync(join(dir, '..', 'experiments.mjs'), 'utf8')
rs.sort((a, b) => order.indexOf(`'${a.name}'`) - order.indexOf(`'${b.name}'`))
const short = (s) => s
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
  .replace(/logWrite\(outbox\[(\d+)\]\)/, (m, i) => (i === '0' ? 'log' : `log[${i}]`))
  .replace(/tailRead\(shard \d+, above (\d+)\) ok/, 'tail(>$1)=ok')
  .replace(/tailRead\(shard \d+, above (\d+)\) stale_watermark -> re-plan/, 'tail(>$1)=STALE')
  .replace(/tailRead\(shard \d+, above (\d+)\) incarnation_mismatch -> re-plan/, 'tail(>$1)=MISMATCH')
  .replace('ledgerLossRebuild', 'LEDGER-LOSS+REBUILD').replace('qPlan', 'plan').replace('qDone', 'done')
  .replace('qFileMissingReplan', 'file missing → re-plan')
const line = (r) => r.trace.map(short).join(' → ')
const out = {}
out.TEETH = ['| Guard switched off | Property violated | Steps | Shortest counterexample |', '|---|---|---|---|',
  ...rs.filter((r) => r.kind === 'teeth').map((r) => `| ${r.label} \`${r.name}\` | ${r.violated ? r.invariant : '**none found**'} | ${r.trace.length} | ${line(r)} |`)].join('\n')
out.LITERAL = ['| Experiment | Property violated | Steps | Shortest counterexample |', '|---|---|---|---|',
  ...rs.filter((r) => r.kind === 'literal').map((r) => `| ${r.label} \`${r.name}\` | ${r.violated ? r.invariant : '**none found**'} | ${r.trace.length} | ${line(r)} |`)].join('\n')
out.FIXED = ['| Run | Bounds that differ from the common ones | Checked | Result | Distinct states | States generated | Depth | Wall time | P(fingerprint collision) |', '|---|---|---|---|---|---|---|---|---|',
  ...rs.filter((r) => r.kind === 'fixed').map((r) => {
    const c = r.cfg
    const d = [c.ns !== 1 && `${c.ns} shards`, c.nb !== 2 && `${c.nb} batches`, c.variants !== 1 && `${c.variants} encoder variants`, c.maxLL !== 1 && `${c.maxLL} ledger losses`,
      c.maxSL !== 1 && `${c.maxSL} shard losses`, c.maxExp !== 1 && `${c.maxExp} retention removals`, c.maxComp !== 1 && `${c.maxComp} compactions`, c.maxQ !== 1 && `${c.maxQ} queries`,
      c.maxFlush !== 3 && `${c.maxFlush} flush attempts`, c.retain && 'timing assumption `retain`'].filter(Boolean).join(', ') || '—'
    return `| \`${r.name}\` | ${d} | ${r.invariant} | ${r.error ? 'ERROR' : r.violated ? `**VIOLATED** in ${r.trace.length} steps` : 'holds, exhaustive'} | ${r.distinct?.toLocaleString('en')} | ${r.generated?.toLocaleString('en')} | ${r.depth} | ${r.seconds} s | ${r.fpCollisionProb ?? ''} |`
  })].join('\n')
out.SIM = ['| Run | Bounds | Checked | Runs | Trace length | Result | Wall time | Runs that reached … |', '|---|---|---|---|---|---|---|---|',
  ...rs.filter((r) => r.kind === 'sim').map((r) => {
    const c = r.cfg
    return `| \`${r.name}\` ${r.label.split(',')[0]} | ${c.ns} shards, ${c.nb} batches, ≤ ${c.maxSend} sends, ${c.variants} variants, ≤ ${c.maxFlush} flushes, ${c.maxComp} compactions, ${c.maxExp} retention removals, ${c.maxLL} ledger losses, ${c.maxSL} shard losses, ${c.maxQ} queries | ${r.invariant} | ${r.samples.toLocaleString('en')} | ≤ ${r.maxSteps} (longest ${r.traceLen?.max}, mean ${r.traceLen?.avg}) | ${r.violated ? `violated in ${r.trace.length} steps: ${line(r)}` : 'no violation found (simulation, not exhaustive)'} | ${r.seconds} s | ${Object.entries(r.coverage ?? {}).map(([k, v]) => `${k.slice(2)}: ${v}`).join(', ')} |`
  })].join('\n')
const total = rs.reduce((a, r) => a + (r.seconds ?? 0), 0)
out.TOTAL = `${Math.round(total / 60)} minutes`
const which = process.argv[2]
console.log(which ? out[which] : Object.entries(out).map(([k, v]) => `@@${k}@@\n${v}\n`).join('\n'))
