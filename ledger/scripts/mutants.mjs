// Mutation check for the ledger: break one property at a time, run the tests that should
// notice, expect them to FAIL, restore the file.
//   node scripts/mutants.mjs [substring of a mutant name]       (from ledger/, in a COPY)
//   node scripts/mutants.mjs --check                             only check that every pattern applies
//
// AGENTS.md (Evidence): mutants are applied to a COPY of the component in a scratch area,
// never in place in the shared checkout (a mutant left in place was once captured for main).
// The script refuses to run inside a git checkout. Copy `contracts/` and `ledger/` (with a
// link to `ledger/node_modules`) elsewhere and run it there.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const check = process.argv[2] === '--check'
if (!check && existsSync(`${ROOT}.git`)) {
  console.error(`mutants: ${ROOT} is a git checkout. Run this on a copy in a scratch directory (AGENTS.md, Evidence).`)
  process.exit(2)
}

const F = 'src/ledger.ts'
const W = '--maxWorkers=2'
const T = {
  ledger: `npx vitest run ${W} test/ledger.test.ts`,
  segments: `npx vitest run ${W} test/segments.test.ts`,
  tombstone: `npx vitest run ${W} test/tombstone.test.ts`,
  // --bail=1: a killed mutant stops at its first failing test (the crash test alone is minutes under load).
  checkpoint: `npx vitest run ${W} --bail=1 test/checkpoint.test.ts`,
  registration: `npx vitest run ${W} test/registration.test.ts`,
  all: `npx vitest run ${W}`,
}
// [name, file, from, to, tests]
const mutants = [
  // ── registration before writes (D61): `logged` and `loggedIncarnation` derived from the outbox ──
  ['D61: logged at the commit', F, '    return !this.pendingRegistrations().get(shard)?.has(incarnation)', '    return true', T.registration],
  ['D61: loggedIncarnation is the committed incarnation', F, '      const loggedIncarnation = seq > 0 || !waiting?.has(incarnation) ? incarnation : prev !== null && !waiting.has(prev) ? prev : 0', '      const loggedIncarnation = incarnation', T.registration],
  ['D61: a registration still in the outbox reads as logged once a later segment is written (the outbox is not read)', F, "    for (const r of this.ctx.storage.sql.exec(`SELECT body FROM outbox WHERE instr(body, '\"kind\":\"register_stream\"') > 0`)) {", '    for (const r of [] as { body: string }[]) {', T.registration],
  // ── contracts v2 behaviour (patterns updated for the code as it now reads) ──
  ['a lower stream incarnation is registered', F, 'if (known && ref.incarnation < known.incarnation) {', 'if (false) {', T.ledger],
  ['an empty unit is admitted', F, "if (unit.files.length === 0) return invalid('a unit must have at least one file')", '', T.ledger],
  ['a key that is already live is not refused with invalid', F, 'if (this.liveFile(f.key)) return invalid(`file key already live in another unit: ${f.key}`)', '', T.ledger],
  ['a malformed file throws instead of answering invalid', F, '    const bad = filesProblem(unit.files, this.keyPrefix)\n    if (bad) return invalid(bad)', '    const bad = filesProblem(unit.files, this.keyPrefix)\n    if (bad) throw new Error(bad)', T.ledger],
  ['a unit below the watermark is not a replay', F, "if (unit.seqHi <= known.watermark) return { status: 'ok', version: this.version(), watermark: known.watermark }", '', T.ledger],
  ['a unit straddling the watermark is taken as a replay', F, 'if (unit.seqHi <= known.watermark) return', 'if (unit.seqLo <= known.watermark) return', T.ledger],
  ['the base entry is not of kind base', F, ',"kind":"base","added":[', ',"kind":"replace","added":[', T.all],
  ['the base entry carries no watermarks', F, 'yield `],"removed":[],"watermarks":${JSON.stringify(streams.map((r) => ({ shard: r.shard, incarnation: r.incarnation, seq: r.watermark })))}`', 'yield \'],"removed":[],"watermarks":[]\'', T.all],
  ['add_unit changes do not carry the unit range', F, '    if (unit) change.unit = unit\n', '', T.all],
  ['replay does not check the unit range', F, "      if (!c.unit || c.unit.seqLo !== st.watermark + 1 || c.unit.seqHi !== w.seq) throw bad('unit range is not contiguous with the watermark')\n", '', T.ledger],
  ['tenant ids are not validated', F, "if (!TENANT_ID.test(tenant)) throw new Error('ledger: tenant id must match [A-Za-z0-9_-]{1,64}')", '', T.ledger],
  ['replace admits an output whose key is already live as ok', F, '      if (this.liveFile(f.key)) return invalid(`file key already live: ${f.key}`)', "      if (this.liveFile(f.key)) return { status: 'ok', version: this.version() }", T.ledger],
  ['a retried replace is not recognised', F, "    if (req.add.length > 0 && missing.length === remove.length && req.add.every((f) => this.liveFile(f.key))) {\n      return { status: 'ok', version: this.version() }\n    }\n", '', T.ledger],
  ['drain returns a bare number', F, '      return { written }\n', '      return written as never\n', T.segments],
  ['loggedWatermarks returns the committed watermark', F, '.exec(`SELECT shard, incarnation, logged, prev_incarnation FROM stream ORDER BY shard`)', '.exec(`SELECT shard, incarnation, watermark AS logged, prev_incarnation FROM stream ORDER BY shard`)', T.ledger],
  ['the contiguity check is dropped', F, "if (unit.seqLo !== known.watermark + 1) return { status: 'not_contiguous', watermark: known.watermark }", '', T.ledger],

  // ── the segment log (contracts/LEDGER-LOG.md) ──
  ['F11: an incarnation commits without waiting for its base to be in R2', F, '    const baseBytes = await this.writeBase(incarnation, version)', '    const baseBytes = 0\n    void this.writeBase(incarnation, version)', T.segments],
  ['F10: a retry writes every pending row instead of the recorded segment', F, '    if (recordedFirst !== null && recordedLast !== null) {', '    if (false) {', T.segments],
  ['rows are deleted and marks advanced before the segment is written', F, '      await this.putLogObject(seg.key, seg.body)\n', '      this.ctx.storage.transactionSync(() => this.segmentWritten(seg))\n      await this.putLogObject(seg.key, seg.body)\n', T.segments],
  ['the recorded bounds are not made durable before the PUT', F, '      if (seg.fresh) await this.ctx.storage.sync()\n', '', T.segments],
  ['a segment write may overwrite (no If-None-Match)', F, "      onlyIf: { etagDoesNotMatch: '*' },\n", '', T.segments],
  ['an existing object with other bytes counts as written', F, '    if (there.length !== bytes.length || !there.every((b, i) => b === bytes[i])) {', '    if (false) {', T.segments],
  ['the drain deletes outbox rows beyond its segment', F, '    sql.exec(`DELETE FROM outbox WHERE version BETWEEN ? AND ?`, seg.first, seg.last)', '    sql.exec(`DELETE FROM outbox WHERE version >= ?`, seg.first)', T.segments],
  ['a logged mark moves a stream of another incarnation', F, 'UPDATE stream SET logged = MAX(logged, ?) WHERE shard = ? AND incarnation = ?`, w.seq, w.shard, w.incarnation)', 'UPDATE stream SET logged = MAX(logged, ?) WHERE shard = ?`, w.seq, w.shard)', T.segments],
  ['a checkpoint is written for a segment that does not end at the committed version', F, ' >= this.checkpointEvery && last === this.version()\n', ' >= this.checkpointEvery\n', T.segments],
  ['a rebuild accepts a gap between segments', F, '      if (seg.p.firstVersion !== version + 1) {', '      if (false) {', T.all],
  ['a rebuild skips a segment it cannot read (unsupported or corrupt)', F, "    if (d.status !== 'ok') throw new LogFault(`ledger: ${key} is ${d.status}: ${d.reason}`)", "    if (d.status !== 'ok') return []", T.segments],
  ['R-3: the start runs inside blockConcurrencyWhile', F, '      this.beginStart()\n      return\n    }\n    if (this.hasPending()', '      this.beginStart()\n      await this.starting?.catch(() => undefined)\n      return\n    }\n    if (this.hasPending()', T.segments],
  ['R-3: requests wait for a start without bound', F, 'const START_WAIT_MS = 2_000', 'const START_WAIT_MS = 600_000', T.segments],
  ['R-5: expire removes only the first table it is given', F, '    const named = [...new Set(tables)]', '    const named = [...new Set(tables)].slice(0, 1)', T.ledger],
  ['R-8: a key outside the tenant\'s prefix is accepted', F, "  if (!f.key.startsWith(p) || f.key.length === p.length || f.key.slice(p.length).includes('/')) return `file key ${f.key} is not under ${p}`\n", '', T.ledger],
  ['names: a shard name outside SHARD_NAME is accepted', F, '  if (!SHARD_NAME.test(ref.shard)) return', '  if (false) return', T.ledger],
  ['the alarm is left set after a drain that wrote everything', F, '        if (!this.hasPending()) this.afterDrain()', '        void 0', T.segments],

  // ── review of the segment log (design/reviews/segment-log-and-compaction.md) ──
  ['S-1: a rebuild skips first-layout objects in a segment incarnation', F, '    if (firstKey && CHANGE_OBJECT.test(firstKey)) {', '    if (false) {', T.segments],
  ['S-1: the rollback signature is not healed from SQLite', F, "    if (e instanceof LogDiscontinuity && foreign !== '' && !this.needsStart) {", '    if (false) {', T.segments],
  ['S-1: a log fault is not reported as stuck', F, "    this.stuck = `${e.message}${foreign}; operator: repair R2 or call restartFromSqlite()`\n", '', T.segments],
  ['S-1: the outbox may skip versions (the drain does not check it continues the log)', F, '      if (loggedThrough === null || rows[0]!.version !== loggedThrough + 1) {', '      if (loggedThrough === null) {', T.segments],
  ['S-1: storage of this release is readable by code that knows only version 1 (migrations 2 and 3 both readable from 1)', F, '    readableFrom: 2,\n    up: (sql) => {\n      sql.exec(`DELETE FROM meta WHERE k = \'state_bytes\'`)\n      sql.exec(`INSERT INTO meta (k, v) SELECT \'state_bytes\', ${ENTRY_BYTES_SQL} FROM file`)\n    },\n  }, {\n    // ADDITIVE (readableFrom 2): two new tables for a checkpoint written in parts across drains\n    // (contracts/LEDGER-LOG.md, "Checkpoints"). A release that knows only version 2 ignores them\n    // and changes files without recording pre-images; `ckpt.tracked` then stops following the\n    // version, and this code abandons that checkpoint instead of writing a wrong one.\n    version: 3,\n    name: \'a checkpoint in parts: its progress (ckpt) and the files changed since its version (ckpt_pre)\',\n    readableFrom: 2,', '    readableFrom: 1,\n    up: (sql) => {\n      sql.exec(`DELETE FROM meta WHERE k = \'state_bytes\'`)\n      sql.exec(`INSERT INTO meta (k, v) SELECT \'state_bytes\', ${ENTRY_BYTES_SQL} FROM file`)\n    },\n  }, {\n    // ADDITIVE (readableFrom 2): two new tables for a checkpoint written in parts across drains\n    // (contracts/LEDGER-LOG.md, "Checkpoints"). A release that knows only version 2 ignores them\n    // and changes files without recording pre-images; `ckpt.tracked` then stops following the\n    // version, and this code abandons that checkpoint instead of writing a wrong one.\n    version: 3,\n    name: \'a checkpoint in parts: its progress (ckpt) and the files changed since its version (ckpt_pre)\',\n    readableFrom: 1,', `npx vitest run ${W} test/compat.test.ts`],
  ['S-2: no limit on the state (addUnit never answers full)', F, '    if (stateBytes + adding > this.stateMaxBytes) {', '    if (false) {', T.segments],
  ['S-2: a checkpoint every N segments whatever the size of the log since the last', F, '      && (!this.checkpointByLogBytes || (this.meta(\'log_bytes_since_ckpt\') ?? 0) + body.length >= (this.meta(\'ckpt_bytes\') ?? 0))) {', ') {', T.segments],
  ['S-2: superseded checkpoints are kept', F, '    await this.deleteSuperseded(inc, c.version, null)\n', '', T.segments],
  ['S-2: expire does not shrink the state estimate', F, "      this.setMeta('state_bytes', Math.max(0, (this.meta('state_bytes') ?? 0) - freed))\n", '', T.segments],
  ['S-5: a ledger with no log starts empty over the tenant\'s data objects', F, '        if (data.objects.length > 0) {', '        if (false) {', T.segments],
  ['S-7: a drain of a replaced incarnation is applied to the new one', F, '    if (this.meta(\'incarnation\') !== seg.incarnation) return\n', '', T.segments],
  ['S-7: rebuildFromLog does not wait for a drain in flight', F, '    // A drain in flight finishes (or fails) before the storage is judged (review S-7).\n    await this.draining\n', '', T.segments],
  // ── review S-2's full fix: checkpoints in parts, a rebuild that streams (D47) ──
  ['migration 3 is forward-only (the release before cannot open this storage)', F, '    name: \'a checkpoint in parts: its progress (ckpt) and the files changed since its version (ckpt_pre)\',\n    readableFrom: 2,', '    name: \'a checkpoint in parts: its progress (ckpt) and the files changed since its version (ckpt_pre)\',\n    readableFrom: 3,', `npx vitest run ${W} test/compat.test.ts`],
  // chunk boundaries
  ['parts: a record that does not fit still goes in (a part may pass its budget)', F, '    const fits = (line: string) => lines.length === 0 || size + line.length + 1 <= this.checkpointPartBytes', '    const fits = (_line: string) => true', T.checkpoint],
  ['parts: a key that was not live at the version is written (pre-image "absent" ignored)', F, '        const row = c < 0 ? (a.value as Row) : b.value.absent === 0 ? (b.value as Row) : null', '        const row = c < 0 ? (a.value as Row) : (b.value as Row)', T.checkpoint],
  ['parts: the live row wins over its pre-image', F, '        const row = c < 0 ? (a.value as Row) : b.value.absent === 0 ? (b.value as Row) : null', '        const row = c <= 0 ? (a.value as Row) : b.value.absent === 0 ? (b.value as Row) : null', T.checkpoint],
  ['parts: keys merged in UTF-16 order, not SQLite\'s', F, '        const c = a.done ? 1 : b.done ? -1 : compareKeys(a.value.key as string, b.value.key as string)', '        const c = a.done ? 1 : b.done ? -1 : (a.value.key as string) < (b.value.key as string) ? -1 : (a.value.key as string) > (b.value.key as string) ? 1 : 0', T.checkpoint],
  ['parts: tombstones of removals after the version are written', F, '`SELECT key, tbl, version, at FROM tombstone WHERE version <= ? AND key > ? ORDER BY key`, ck.version, tombCursor', '`SELECT key, tbl, version, at FROM tombstone WHERE ? >= 0 AND key > ? ORDER BY key`, ck.version, tombCursor', T.checkpoint],
  ['pre-images: a removal ahead of the cursor keeps none', F, "        if (tracking) this.preimageOfDeleted('f.key = ?', k)\n", '', T.checkpoint],
  ['pre-images: an addition ahead of the cursor is not marked absent', F, '    if (tracking) this.preimageOfInserted(f.key)\n', '', T.checkpoint],
  ['tracking: a checkpoint goes on over versions a release without tracking committed', F, '    if (ck.tracked !== this.version()) {', '    if (false) {', T.checkpoint],
  // superseded checkpoints
  ['superseded: deleted before the newer manifest is written', F, '        await this.putLogObject(this.objectKey(ledgerCheckpointKey(this.tenant, inc, ck.version)), body)', '        await this.deleteSuperseded(inc, ck.version, ck.attempt)\n        await this.putLogObject(this.objectKey(ledgerCheckpointKey(this.tenant, inc, ck.version)), body)', T.checkpoint],
  ['superseded: parts deleted before their manifests', F, '      for (const list of [manifests, parts]) {', '      for (const list of [parts, manifests]) {', T.checkpoint],
  ['superseded: never deleted', F, '      if (done) await this.deleteSuperseded(inc, ck.version, ck.attempt)', '      void done', T.checkpoint],
  ['superseded: the new checkpoint\'s own parts are deleted too', F, "p.version <= version && !(p.version === version && p.attempt === attempt)) parts.push(k)", 'p.version <= version) parts.push(k)', T.checkpoint],
  // rebuild streaming
  ['streaming: the base is read whole before anything is written', F, '    const { lines, streamed } = await readLedgerLogStream(o.body, 1, sink.element, (index, value) => {', '    const { lines, streamed } = await readLedgerLogStream(new Response(await o.text()).body!, 1, sink.element, (index, value) => {', T.checkpoint],
  ['streaming: a base rows are all held until it ends', F, '      if (batch.length >= this.rebuildBatchRows) flush()', '      void flush', T.checkpoint],
  ['streaming: every part is read before any is written', F, '      while (ahead.length < REPLAY_FANOUT - 2 && part + ahead.length < m.parts) {', '      while (part + ahead.length < m.parts) {', T.checkpoint],
  ['streaming: parts that do not add up to the manifest are accepted', F, '    if (files !== m.files || tombstones !== m.tombstones) throw', '    if (false) throw', T.checkpoint],
  ['streaming: what an unreadable checkpoint loaded is kept', F, '        this.clearState()\n      }\n    }\n    const listed', '      }\n    }\n    const listed', T.checkpoint],
  ['S-9: deletable counts a recorded but unwritten segment as logged', F, "    const v = this.ctx.storage.sql.exec(`SELECT MIN(version) AS v FROM outbox`).one().v as number | null", "    const v = (this.meta('seg_last') !== null ? this.meta('seg_last')! + 1 : null) ?? (this.ctx.storage.sql.exec(`SELECT MIN(version) AS v FROM outbox`).one().v as number | null)", T.tombstone],
]

const only = check ? undefined : process.argv[2]
let survived = 0
let missing = 0
for (const [name, file, from, to, tests] of mutants) {
  if (only && !name.includes(only)) continue
  const path = `${ROOT}ledger/${file}`
  const original = readFileSync(path, 'utf8')
  if (!original.includes(from)) {
    console.log(`NOT APPLIED  ${name} (pattern not found in ${file})`)
    missing++
    continue
  }
  if (check) continue
  writeFileSync(path, original.replace(from, to))
  let failed = false
  let detail = ''
  try {
    execSync(tests, { cwd: `${ROOT}ledger`, stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
  } catch (e) {
    failed = true
    const out = String(e.stdout) + String(e.stderr)
    detail = [...out.matchAll(/^\s+× (.+?)(?: \d+ms)?$/gm)].map((m) => m[1]).slice(0, 2).join(' | ') || (out.match(/Error: .*/)?.[0] ?? '')
  } finally {
    writeFileSync(path, original)
  }
  if (!failed) survived++
  console.log(`${failed ? 'KILLED  ' : 'SURVIVED'}  ${name}${detail ? `  ← ${detail}` : ''}`)
}
if (check) {
  console.log(missing === 0 ? `all ${mutants.length} patterns apply` : `${missing} pattern(s) do not apply`)
  process.exit(missing === 0 ? 0 : 1)
}
console.log(survived + missing === 0 ? 'all mutants killed' : `${survived} survived, ${missing} not applied`)
process.exit(survived + missing === 0 ? 0 : 1)
