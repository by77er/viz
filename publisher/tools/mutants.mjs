#!/usr/bin/env node
/**
 * Mutation checks (AGENTS.md, "Tests must have teeth"). Each mutant breaks one safety
 * property in the source; the workerd suite must fail. The source is restored after each
 * run, also on error. Usage: node tools/mutants.mjs [id ...]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const P = 'src/publisher.ts'
const L = 'src/log.ts'
const I = 'src/iceberg.ts'

const mutants = [
  { id: 'M1', what: 'skip the conditional write (metadata is written unconditionally)', file: P,
    edits: [["{ onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } }", "{ httpMetadata: { contentType: 'application/json' } }"]] },
  { id: 'M2', what: 'apply log entries out of order (changes replayed newest first)', file: P,
    edits: [['for (const c of log.changes) {\n        if (c.version <= start) continue', 'for (const c of [...log.changes].reverse()) {\n        if (c.version <= start) continue']] },
  { id: 'M3', what: 'ignore a gap in the versions', file: L,
    edits: [['while (run < listed.length && listed[run] === start + 1 + run) run++', 'while (run < listed.length) run++']] },
  { id: 'M4', what: 'publish gross instead of net changes (a removal of a not-yet-published file is ignored)', file: P,
    edits: [['if (work.delete(k)) dropped.push(k)', 'if (work.get(k) === null ? work.delete(k) : work.has(k)) dropped.push(k)']] },
  { id: 'M5', what: 'drop DELETED handling (a removed file stays a live entry in the rewritten manifest)', file: P,
    edits: [['status: keys.has(r.key as string) ? STATUS_DELETED : STATUS_EXISTING', 'status: STATUS_EXISTING']] },
  { id: 'M6', what: 'removed files are not taken out of the manifests at all', file: P,
    edits: [['for (const { tenant, key } of plan.removes) {\n      const r = this.sql.exec(`SELECT manifest', 'for (const { tenant, key } of [] as { tenant: string; key: string }[]) {\n      const r = this.sql.exec(`SELECT manifest']] },
  { id: 'M7', what: 'sweep without a grace period (an unreferenced object is deleted when first seen)', file: P,
    edits: [['if (!row) {\n          this.sql.exec(`INSERT INTO orphan', 'if (false) {\n          this.sql.exec(`INSERT INTO orphan'], ['} else if ((row.since as number) + cfg.orphanGraceMs <= now) {', '} else if (true) {']] },
  { id: 'M8', what: 'cursor saved before the metadata is written', file: P,
    edits: [['    report.bytes.metadata = await this.putMetadata(', '    this.ctx.storage.transactionSync(() => {\n      for (const [tenant, c] of plan.cursors) this.setCursor(table, tenant, c)\n    })\n    report.bytes.metadata = await this.putMetadata(']] },
  { id: 'M9', what: 'wrong partition value (day off by one)', file: I,
    edits: [['partition: { tenant: f.tenant, day: dayToInt(f.day) },', 'partition: { tenant: f.tenant, day: dayToInt(f.day) + 1 },']] },
  { id: 'M10', what: 'sweep on a stale view (no check that R2 has a newer metadata version)', file: P,
    edits: [['    if (await store.head(this.metaKey(table, state.version + 1))) {\n      await this.resync(store, cfg, table)\n      state = this.state(table)', '    if (false) {\n      await this.resync(store, cfg, table)\n      state = this.state(table)']] },
  { id: 'M11', what: 'sweep treats only the current snapshot as referenced', file: P,
    edits: [['      if (!files) return out\n      for (const f of files) referenced.add(f)', "      if (!files) return out\n      if (s['snapshot-id'] !== meta['current-snapshot-id']) continue\n      for (const f of files) referenced.add(f)"]] },
  { id: 'M12', what: 'a removed file is handed to deletion while a retained snapshot references it', file: P,
    edits: [['this.recordRemoved(table, f.tenant, f.key, seq, null)', 'this.recordRemoved(table, f.tenant, f.key, seq, now - 365 * 86_400_000)']] },
  { id: 'M13', what: 'snapshot expiry does not keep a minimum of two', file: I,
    edits: [['Math.max(0, byAge.length - Math.max(2, r.minSnapshots))', 'byAge.length']] },
  { id: 'M14', what: 'a lost conditional write is treated as success', file: P,
    edits: [["    if (put === null) {\n      // Another writer committed this version. Take its state and start over.", "    if (put === null && false) {\n      // Another writer committed this version. Take its state and start over."]] },
  { id: 'M15', what: 're-base ignores the new base (an older incarnation cursor continues as if nothing happened)', file: P,
    edits: [['const rebase = !cursor || cursor.ledgerIncarnation < log.incarnation', 'const rebase = !cursor']] },
  // ── versioned storage and formats (contracts/COMPATIBILITY.md): run against compat and golden tests ──
  { id: 'M16', what: 'the publisher serves storage a newer release wrote (guard removed)', file: P, tests: ['test/compat.test.ts'],
    edits: [['    if (refused) throw new SchemaTooNewError(refused)\n', '']] },
  { id: 'M17', what: 'a refusing publisher publishes from its alarm (and writes)', file: P, tests: ['test/compat.test.ts'],
    edits: [["    if (refused) {\n      // Keep the alarm for the release that owns this storage; touch nothing else.\n      await this.ctx.storage.setAlarm(Date.now() + refused.retryAfterMs)\n      return\n    }\n    const tenants", '    const tenants']] },
  { id: 'M18', what: 'commits over metadata a newer publisher wrote (no check when rebuilding from R2)', file: P, tests: ['test/compat.test.ts'],
    edits: [['    checkMetadata(meta, this.metaKey(table, version))\n    const current', '    const current']] },
  { id: 'M19', what: 'a ledger change of an unknown version is applied as if it were known', file: L, tests: ['test/compat.test.ts'],
    edits: [['  if (why) return new Unsupported(`version ${version}: ${why}`)\n', '']] },
  { id: 'M20', what: 'a released migration edited in place (version 1 loses an index)', file: 'src/schema.ts', tests: ['test/compat.test.ts'],
    edits: [['CREATE INDEX IF NOT EXISTS removed_tenant ON removed (tenant);\n', '']] },
  { id: 'M21', what: 'a field id reassigned (tenant of metric_samples takes the next id)', file: I, tests: ['test/golden.test.ts'],
    edits: [["    tenant: { id: 5, name: 'tenant', type: 'string' },\n    day: { id: 6, name: 'day', type: 'date' },", "    tenant: { id: 7, name: 'tenant', type: 'string' },\n    day: { id: 6, name: 'day', type: 'date' },"]] },
  { id: 'M22', what: 'the cursors object changes shape without a format version', file: P, tests: ['test/golden.test.ts'],
    edits: [['JSON.stringify({ v: CURSORS_FORMAT_VERSION, table, cell: this.cell, snapshotId, cursors })', 'JSON.stringify({ table, cell: this.cell, snapshotId, cursors })']] },
]

const only = process.argv.slice(2)
const results = []
for (const m of mutants) {
  if (only.length > 0 && !only.includes(m.id)) continue
  const path = resolve(root, m.file)
  const original = readFileSync(path, 'utf8')
  let text = original
  for (const [from, to] of m.edits) {
    if (text.split(from).length !== 2) throw new Error(`${m.id}: the text to replace must occur exactly once in ${m.file}:\n${from}`)
    text = text.replace(from, () => to)
  }
  let out = ''
  let failed = false
  try {
    writeFileSync(path, text)
    try {
      out = execFileSync('npx', ['vitest', 'run', '--maxWorkers=2', ...(m.tests ?? ['test/publisher.test.ts'])], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 })
    } catch (e) {
      failed = true
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    }
  } finally {
    writeFileSync(path, original)
  }
  const tests = [...new Set([...out.matchAll(/^\s*×\s+(.*?)(?:\s+\d+ms)?$/gm)].map((x) => x[1].trim()))]
  const summary = /Tests\s+(.*)/.exec(out)?.[1] ?? '?'
  results.push({ id: m.id, what: m.what, killed: failed && tests.length > 0, failing: tests.length, first: tests[0] ?? '', summary })
  console.log(`${m.id} ${failed && tests.length > 0 ? 'KILLED  ' : 'SURVIVED'} (${tests.length} tests fail) ${m.what}\n      e.g. ${tests[0] ?? '-'}`)
}
console.log('\n| # | Mutation | Result | A test that fails |\n|---|---|---|---|')
for (const r of results) console.log(`| ${r.id} | ${r.what} | ${r.killed ? `killed (${r.failing})` : 'SURVIVED'} | ${r.first} |`)
if (results.some((r) => !r.killed)) process.exitCode = 1
