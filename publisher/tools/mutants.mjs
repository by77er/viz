#!/usr/bin/env node
/**
 * Mutation checks (AGENTS.md, "Tests must have teeth"). Each mutant breaks one safety
 * property in the source; the workerd suite must fail.
 *
 * Mutants are applied to a COPY of the component, never in place: others commit and snapshot
 * the shared tree while this runs (AGENTS.md). The copy is made once, under `$MUTANT_DIR` (or a
 * fresh directory under the system temp dir), with the layout the imports need:
 *
 *   <dir>/publisher/   src, test, tools, configs; node_modules is a symlink to the real one
 *   <dir>/contracts/   copied
 *   <dir>/ledger/      src/, bench/asbuilt/ and bench/before/ copied (the test worker drives the real ledgers)
 *
 * Each mutant edits one file of the copy, runs the suites it names (at most 2 workers), and
 * puts the copy's file back. The shared tree is only read.
 *
 * Usage: node tools/mutants.mjs [id ...]
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const source = resolve(import.meta.dirname, '..')
const repo = resolve(source, '..')
const dir = process.env.MUTANT_DIR ? resolve(process.env.MUTANT_DIR) : mkdtempSync(join(tmpdir(), 'viz-publisher-mutants-'))
if (dir === repo || dir.startsWith(`${repo}/`)) throw new Error(`MUTANT_DIR must be outside the shared tree (${repo})`)
const root = join(dir, 'publisher')
mkdirSync(root, { recursive: true })
for (const f of ['src', 'test', 'tools/mutants.mjs', 'package.json', 'tsconfig.json', 'vitest.config.ts', 'wrangler.jsonc', 'wrangler.test.jsonc']) {
  cpSync(join(source, f), join(root, f), { recursive: true })
}
if (!existsSync(join(root, 'node_modules'))) symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'))
cpSync(join(repo, 'contracts'), join(dir, 'contracts'), { recursive: true })
cpSync(join(repo, 'ledger', 'src'), join(dir, 'ledger', 'src'), { recursive: true })
cpSync(join(repo, 'ledger', 'bench', 'asbuilt'), join(dir, 'ledger', 'bench', 'asbuilt'), { recursive: true })
cpSync(join(repo, 'ledger', 'bench', 'before'), join(dir, 'ledger', 'bench', 'before'), { recursive: true })
console.log(`mutating a copy under ${dir}`)

const P = 'src/publisher.ts'
const L = 'src/log.ts'
const I = 'src/iceberg.ts'
const N = 'src/nudge.ts'

const mutants = [
  { id: 'M1', what: 'skip the conditional write (metadata is written unconditionally)', file: P,
    edits: [["{ onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } }", "{ httpMetadata: { contentType: 'application/json' } }"]] },
  { id: 'M2', what: 'apply log entries out of order (changes replayed newest first)', file: P,
    edits: [['    for (const c of log.changes) {\n      if (c.version <= start) continue', '    for (const c of [...log.changes].reverse()) {\n      if (c.version <= start) continue']] },
  { id: 'M3', what: 'ignore a gap in the versions (first layout)', file: L, tests: ['test/segments.test.ts'],
    edits: [['while (run < listed.length && listed[run] === start + 1 + run) run++', 'while (run < listed.length) run++']] },
  { id: 'M4', what: 'publish gross instead of net changes (a removal of a not-yet-published file is ignored)', file: P,
    edits: [['          if (work.has(r.key)) work.delete(r.key)\n          else gone.add(r.key)', '          if (work.get(r.key) === null) work.delete(r.key)\n          else if (!work.has(r.key)) gone.add(r.key)']] },
  { id: 'M5', what: 'drop DELETED handling (a removed file stays a live entry in the rewritten manifest)', file: P,
    edits: [['return { file: toLive(r), status: gone ? STATUS_DELETED : STATUS_EXISTING }', 'return { file: toLive(r), status: STATUS_EXISTING }']] },
  { id: 'M6', what: 'removed files are not taken out of the manifests at all', file: P,
    edits: [['for (const r of removedRows) mark(r.manifest).add(r.key)', 'for (const r of [] as typeof removedRows) mark(r.manifest).add(r.key)']] },
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
  { id: 'M18', what: 'rebuilds its view from metadata a newer publisher wrote (no check in resync)', file: P, tests: ['test/compat.test.ts'],
    edits: [['    checkMetadata(meta, this.metaKey(table, version))\n    const current', '    const current']] },
  { id: 'M19', what: 'a ledger change of an unknown version is applied as if it were known (first layout)', file: L, tests: ['test/compat.test.ts'],
    edits: [["  if ('unsupported' in r) return new Unsupported(`version ${version}: ${r.unsupported}`)\n", "  if ('unsupported' in r) return { ...c, removedFiles: [] } as LogChange\n"]] },
  { id: 'M20', what: 'a released migration edited in place (version 1 loses an index)', file: 'src/schema.ts', tests: ['test/compat.test.ts'],
    edits: [['CREATE INDEX IF NOT EXISTS removed_tenant ON removed (tenant);\n', '']] },
  { id: 'M21', what: 'a field id reassigned (tenant of metric_samples takes the next id)', file: I, tests: ['test/golden.test.ts'],
    edits: [["    tenant: { id: 5, name: 'tenant', type: 'string' },\n    day: { id: 6, name: 'day', type: 'date' },", "    tenant: { id: 7, name: 'tenant', type: 'string' },\n    day: { id: 6, name: 'day', type: 'date' },"]] },
  { id: 'M22', what: 'the cursors object changes shape without a format version', file: P, tests: ['test/golden.test.ts'],
    edits: [['JSON.stringify({ v: CURSORS_FORMAT_VERSION, table, cell: this.cell, snapshotId, cursors })', 'JSON.stringify({ table, cell: this.cell, snapshotId, cursors })']] },
  // ── the segment log: stop at what is unknown, never skip a hole (contracts/LEDGER-LOG.md "Readers") ──
  { id: 'S1', what: 'a segment of an unknown version or kind is skipped and the segments after it applied', file: L, tests: ['test/compat.test.ts'],
    edits: [["      if (r.status !== 'ok') {\n        // Stop before this segment, whatever came after it. Never skip it.", "      if (r.status === 'unsupported') continue\n      if (r.status !== 'ok') {\n        // Stop before this segment, whatever came after it. Never skip it."]] },
  { id: 'S2', what: 'the reader claims a segment version it was not taught (its pin raised to 2)', file: L, tests: ['test/compat.test.ts'],
    edits: [['export const LEDGER_SEGMENT_VERSION = 1', 'export const LEDGER_SEGMENT_VERSION = 2']] },
  { id: 'S3', what: 'a file of a table this code does not know is ignored instead of refused', file: L, tests: ['test/compat.test.ts'],
    edits: [["    if (!TABLES.has(f.table)) return { unsupported: `change ${c.version} adds a file of table ${JSON.stringify(f.table)}, which this publisher does not know` }\n", '']] },
  { id: 'S4', what: 'a hole between two segments is read past', file: L,
    edits: [['      if (s.first > prev.last + 1) {', '      if (false) {']] },
  { id: 'S5', what: 'a hole right after the cursor is read past (no segment holds cursor + 1)', file: L,
    edits: [["    if (!holding) return result('gap', { base, start: after, gapAt: after + 1, detail: `version ${after + 1} of incarnation ${incarnation} is in no segment; the next one starts at ${refs[0]!.first}` })\n    refs = [holding, ...refs]", '    if (holding) refs = [holding, ...refs]']] },
  { id: 'S6', what: 'overlapping segments are accepted', file: L, tests: ['test/segments.test.ts'],
    edits: [['      if (s.first <= prev.last) {', '      if (false) {']] },
  { id: 'S7', what: 'a cursor inside a segment re-reads that segment from its start (changes at or below the cursor applied again)', file: L, tests: ['test/segments.test.ts'],
    edits: [['        if (c.version > start) changes.push(c)', '        changes.push(c)']] },
  // ── a re-base from checkpoint parts (test/checkpoints.test.ts): verified, never partial, in order, bounded ──
  { id: 'K1', what: 'skip the size check: parts that do not add up to the bytes the manifest names are used', file: L, tests: ['test/checkpoints.test.ts'],
    edits: [["    if (bytes !== man.bytes) throw new Stop('corrupt', `${where}: its parts are ${bytes} bytes, its manifest says ${man.bytes}`)\n", '']] },
  { id: 'K2', what: 'skip the record check: parts that do not hold the files and tombstones the manifest names are used', file: L, tests: ['test/checkpoints.test.ts'],
    edits: [['    if (files !== man.files || tombstones !== man.tombstones) {', '    if (false) {']] },
  { id: 'K3', what: 'a missing part is skipped (the checks after it still see the shortfall)', file: L, tests: ['test/checkpoints.test.ts'],
    edits: [["      if (!got) throw new Stop('incomplete', `${where} names part ${part} (attempt ${man.attempt}), which is not in R2`)", '      if (!got) continue']] },
  { id: 'K4', what: 'publish after a missing part: skipped, with no check left to notice', file: L, tests: ['test/checkpoints.test.ts'],
    edits: [
      ["      if (!got) throw new Stop('incomplete', `${where} names part ${part} (attempt ${man.attempt}), which is not in R2`)", '      if (!got) continue'],
      ['    if (files !== man.files || tombstones !== man.tombstones) {', '    if (false) {'],
      ["    if (bytes !== man.bytes) throw new Stop('corrupt', `${where}: its parts are ${bytes} bytes, its manifest says ${man.bytes}`)\n", ''],
    ] },
  { id: 'K5', what: 'read parts out of order (last to first, each checked against its own key)', file: L, tests: ['test/checkpoints.test.ts'],
    edits: [
      ['        const read = fetchPart(next++)', '        const read = fetchPart(man.parts - 1 - next++)'],
      ['{ tenant, ledgerIncarnation: incarnation, version: m.version, attempt: man.attempt, part })', '{ tenant, ledgerIncarnation: incarnation, version: m.version, attempt: man.attempt, part: man.parts - 1 - part })'],
    ] },
  { id: 'K6', what: 'parts applied without the key-order check (as a reader applying them as they arrive would need)', file: L, tests: ['test/checkpoints.test.ts'],
    edits: [['          if (lastFile !== null && compareKeys(f.key, lastFile) <= 0) throw', '          if (false) throw']] },
  { id: 'K7', what: 'the tombstones of a checkpoint are not recorded (the files it skipped leak)', file: P, tests: ['test/checkpoints.test.ts'],
    edits: [['      for (const x of staged) this.recordStagedTombstones(table, x.tenant, seq)\n', '']] },
  { id: 'C1', what: 'unbounded concurrency: every part requested at once, and no connection limit', file: L, tests: ['test/checkpoints.test.ts'],
    edits: [['export const PART_WINDOW = 4', 'export const PART_WINDOW = Number.MAX_SAFE_INTEGER'], ['export const R2_CONNECTIONS = 6', 'export const R2_CONNECTIONS = Number.MAX_SAFE_INTEGER']] },
  { id: 'C2', what: 'no connection limit (the window of parts kept)', file: L, tests: ['test/checkpoints.test.ts'],
    edits: [['export const R2_CONNECTIONS = 6', 'export const R2_CONNECTIONS = Number.MAX_SAFE_INTEGER']] },
  { id: 'C3', what: 'no window of parts (the connection limit kept): every part read ahead into memory', file: L, tests: ['test/checkpoints.test.ts'],
    edits: [['export const PART_WINDOW = 4', 'export const PART_WINDOW = Number.MAX_SAFE_INTEGER']] },
  { id: 'C4', what: 're-bases of one publish read their checkpoints all at once (no turns): a window of parts per tenant', file: P, tests: ['test/checkpoints.test.ts'],
    edits: [['      turn: () => turns.take(),\n', '']] },
  { id: 'K8', what: 'a re-base that stopped still hands on its base: what it staged is published', file: L, tests: ['test/checkpoints.test.ts'],
    edits: [["      return result(ck.status, { detail: ck.reason })", "      return result('ok', { detail: ck.reason, base: { version: 0, source: 'checkpoint', format: 2, files: 0, tombstones: 0, objects: 0, window: 0, passedOver: [] } })"]] },

  // ── the span and log tables: read, recorded, never published, never a stop (D64; test/signals.test.ts) ──
  { id: 'U1', what: 'stop on an unknown table: the span and log tables unknown again (a change naming one stops the tenant, metrics included)', file: L, tests: ['test/signals.test.ts'],
    edits: [['const TABLES: ReadonlySet<string> = new Set<string>([...PUBLISHED_TABLES, ...UNPUBLISHED_TABLES])', 'const TABLES: ReadonlySet<string> = new Set<string>([...PUBLISHED_TABLES])']] },
  { id: 'U2', what: 'a span file published into the metrics table (a tenant read from its cursor)', file: P, tests: ['test/signals.test.ts'],
    edits: [['        if (f.table !== table) continue\n        if (live(f.key))', "        if (f.table !== table && !(table === 'metric_samples' && f.table === 'spans')) continue\n        if (live(f.key))"]] },
  { id: 'U2b', what: 'a span file published into the metrics table (a re-base: the changes after its base)', file: P, tests: ['test/signals.test.ts'],
    edits: [['          if (f.table !== table) continue\n          if (this.staged(table, tenant, f.key))', "          if (f.table !== table && !(table === 'metric_samples' && f.table === 'spans')) continue\n          if (this.staged(table, tenant, f.key))"]] },
  { id: 'U2c', what: 'a span file published into the metrics table (a re-base: the files of its base or checkpoint staged as metric files)', file: L, tests: ['test/signals.test.ts'],
    edits: [
      ['    if (this.other.took(f)) return\n    this.f.push(f)', "    this.other.took(f)\n    if (!isPublished(f.table) && f.table !== 'spans') return\n    this.f.push(f.table === 'spans' ? { ...f, table: 'metric_samples' } : f)"],
      ['          if (other.took(f)) counted++\n          else fs.push(f)', "          if (other.took(f) && f.table !== 'spans') counted++\n          else fs.push(f.table === 'spans' ? { ...f, table: 'metric_samples' } : f)"],
    ] },
  { id: 'U3', what: 'removedFiles filtering out the new tables (their removals never read)', file: L, tests: ['test/signals.test.ts'],
    edits: [['      removedFiles.push({ key: r.key, table: r.table })', '      if (isPublished(r.table)) removedFiles.push({ key: r.key, table: r.table })']] },
  { id: 'U4', what: 'their removed files released although a newer publisher has a table of that name', file: P, tests: ['test/signals.test.ts'],
    edits: [['        if (owned.get(n.table)) continue\n', '']] },
  { id: 'U5', what: 'their removed files released at once, without the delete grace', file: P, tests: ['test/signals.test.ts'],
    edits: [['for (const key of n.release) this.recordRemoved(n.table, n.tenant, key, 0, now)', 'for (const key of n.release) this.recordRemoved(n.table, n.tenant, key, 0, now - 365 * 86_400_000)']] },

  // ── never upstream of ingest (D15), and nothing while idle (D34) ──
  { id: 'I1', what: 'a nudge waits for the publisher however long it takes', file: N, tests: ['test/triggers.test.ts'],
    edits: [['    return await Promise.race([call, late])', '    return await call']] },
  { id: 'I2', what: 'a refused nudge throws into its caller (the maintenance run): both the rejection handler and the catch removed', file: N, tests: ['test/triggers.test.ts'],
    edits: [['      () => true,\n      () => false,', '      () => true,\n      (e: unknown) => {\n        throw e\n      },'], ['  } catch {\n    return false\n  } finally {', '  } finally {']] },
  { id: 'I3', what: 'notify publishes at once instead of leaving it to the alarm', file: P, tests: ['test/triggers.test.ts'],
    edits: [["    this.dueNoLaterThan('publish', now + this.config().publishIntervalMs)\n    await this.rearm()\n  }", "    this.dueNoLaterThan('publish', now + this.config().publishIntervalMs)\n    await this.rearm()\n    await this.serial(() => this.publishNow(tenants.filter((t) => TENANT_ID.test(t))))\n  }"]] },
  { id: 'I4', what: 'the alarm keeps itself alive when nothing is due (an hourly wake)', file: P, tests: ['test/triggers.test.ts'],
    edits: [['      if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm()\n      return', '      await this.ctx.storage.setAlarm(Date.now() + 3_600_000)\n      return']] },
  { id: 'I5', what: 'a commit does not schedule the sweep of what it stopped referencing', file: P, tests: ['test/triggers.test.ts'],
    edits: [["    if (committed) this.dueNoLaterThan('sweep', this.now() + cfg.orphanGraceMs)\n", '']] },
]

const only = process.argv.slice(2)
const results = []
// DRY=1: only check that every mutant's text occurs exactly once (after an edit of the source).
if (process.env.DRY) {
  let bad = 0
  for (const m of mutants) {
    let text = readFileSync(join(root, m.file), 'utf8')
    for (const [from, to] of m.edits) {
      if (text.split(from).length !== 2) {
        bad++
        console.log(`${m.id}: not found exactly once in ${m.file}: ${from.slice(0, 80)}`)
      } else text = text.replace(from, () => to)
    }
  }
  console.log(`${mutants.length} mutants, ${bad} edits that do not apply`)
  process.exit(bad > 0 ? 1 : 0)
}
for (const m of mutants) {
  if (only.length > 0 && !only.includes(m.id)) continue
  const path = join(root, m.file)
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
    writeFileSync(path, original) // the copy's file, not the shared tree's
  }
  const tests = [...new Set([...out.matchAll(/^\s*×\s+(.*?)(?:\s+\d+ms)?$/gm)].map((x) => x[1].trim()))]
  const summary = /Tests\s+(.*)/.exec(out)?.[1] ?? '?'
  results.push({ id: m.id, what: m.what, killed: failed && tests.length > 0, failing: tests.length, first: tests[0] ?? '', summary })
  console.log(`${m.id} ${failed && tests.length > 0 ? 'KILLED  ' : 'SURVIVED'} (${tests.length} tests fail) ${m.what}\n      e.g. ${tests[0] ?? '-'}`)
}
console.log('\n| # | Mutation | Result | A test that fails |\n|---|---|---|---|')
for (const r of results) console.log(`| ${r.id} | ${r.what} | ${r.killed ? `killed (${r.failing})` : 'SURVIVED'} | ${r.first} |`)
if (results.some((r) => !r.killed)) process.exitCode = 1
