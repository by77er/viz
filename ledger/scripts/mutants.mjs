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
  all: `npx vitest run ${W}`,
}
// [name, file, from, to, tests]
const mutants = [
  // ── contracts v2 behaviour (patterns updated for the code as it now reads) ──
  ['a lower stream incarnation is registered', F, 'if (known && ref.incarnation < known.incarnation) {', 'if (false) {', T.ledger],
  ['an empty unit is admitted', F, "if (unit.files.length === 0) return invalid('a unit must have at least one file')", '', T.ledger],
  ['a key that is already live is not refused with invalid', F, 'if (this.liveFile(f.key)) return invalid(`file key already live in another unit: ${f.key}`)', '', T.ledger],
  ['a malformed file throws instead of answering invalid', F, '    const bad = filesProblem(unit.files, this.keyPrefix)\n    if (bad) return invalid(bad)', '    const bad = filesProblem(unit.files, this.keyPrefix)\n    if (bad) throw new Error(bad)', T.ledger],
  ['a unit below the watermark is not a replay', F, "if (unit.seqHi <= known.watermark) return { status: 'ok', version: this.version(), watermark: known.watermark }", '', T.ledger],
  ['a unit straddling the watermark is taken as a replay', F, 'if (unit.seqHi <= known.watermark) return', 'if (unit.seqLo <= known.watermark) return', T.ledger],
  ['the base entry is not of kind base', F, "      kind: 'base',\n", "      kind: 'replace',\n", T.all],
  ['the base entry carries no watermarks', F, '      watermarks: streams.map((st) => ({ shard: st.shard, incarnation: st.incarnation, seq: st.watermark })),', '      watermarks: [],', T.all],
  ['add_unit changes do not carry the unit range', F, '    if (unit) change.unit = unit\n', '', T.all],
  ['replay does not check the unit range', F, "      if (!c.unit || c.unit.seqLo !== st.watermark + 1 || c.unit.seqHi !== w.seq) throw bad('unit range is not contiguous with the watermark')\n", '', T.ledger],
  ['tenant ids are not validated', F, "if (!TENANT_ID.test(tenant)) throw new Error('ledger: tenant id must match [A-Za-z0-9_-]{1,64}')", '', T.ledger],
  ['replace admits an output whose key is already live as ok', F, '      if (this.liveFile(f.key)) return invalid(`file key already live: ${f.key}`)', "      if (this.liveFile(f.key)) return { status: 'ok', version: this.version() }", T.ledger],
  ['a retried replace is not recognised', F, "    if (req.add.length > 0 && missing.length === remove.length && req.add.every((f) => this.liveFile(f.key))) {\n      return { status: 'ok', version: this.version() }\n    }\n", '', T.ledger],
  ['drain returns a bare number', F, 'return { written: await this.drainSerial(Number.MAX_SAFE_INTEGER) }', 'return (await this.drainSerial(Number.MAX_SAFE_INTEGER)) as never', T.segments],
  ['loggedWatermarks returns the committed watermark', F, '.exec(`SELECT shard, incarnation, logged FROM stream ORDER BY shard`)', '.exec(`SELECT shard, incarnation, watermark AS logged FROM stream ORDER BY shard`)', T.ledger],
  ['the contiguity check is dropped', F, "if (unit.seqLo !== known.watermark + 1) return { status: 'not_contiguous', watermark: known.watermark }", '', T.ledger],

  // ── the segment log (contracts/LEDGER-LOG.md) ──
  ['F11: an incarnation commits without waiting for its base to be in R2', F, '    await this.putLogObject(\n      this.objectKey(ledgerSegmentKey(this.tenant, incarnation, state.version, state.version)),', '    void this.putLogObject(\n      this.objectKey(ledgerSegmentKey(this.tenant, incarnation, state.version, state.version)),', T.segments],
  ['F10: a retry writes every pending row instead of the recorded segment', F, '    if (recordedFirst !== null && recordedLast !== null) {', '    if (false) {', T.segments],
  ['rows are deleted and marks advanced before the segment is written', F, '      await this.putLogObject(seg.key, seg.body)\n', '      this.ctx.storage.transactionSync(() => this.segmentWritten(seg))\n      await this.putLogObject(seg.key, seg.body)\n', T.segments],
  ['the recorded bounds are not made durable before the PUT', F, '      if (seg.fresh) await this.ctx.storage.sync()\n', '', T.segments],
  ['a segment write may overwrite (no If-None-Match)', F, "      onlyIf: { etagDoesNotMatch: '*' },\n", '', T.segments],
  ['an existing object with other bytes counts as written', F, '    if (there.length !== bytes.length || !there.every((b, i) => b === bytes[i])) {', '    if (false) {', T.segments],
  ['the drain deletes outbox rows beyond its segment', F, '    sql.exec(`DELETE FROM outbox WHERE version BETWEEN ? AND ?`, seg.first, seg.last)', '    sql.exec(`DELETE FROM outbox WHERE version >= ?`, seg.first)', T.segments],
  ['a logged mark moves a stream of another incarnation', F, 'UPDATE stream SET logged = MAX(logged, ?) WHERE shard = ? AND incarnation = ?`, w.seq, w.shard, w.incarnation)', 'UPDATE stream SET logged = MAX(logged, ?) WHERE shard = ?`, w.seq, w.shard)', T.segments],
  ['a checkpoint is written for a segment that does not end at the committed version', F, ' && last === this.version()) {', ') {', T.segments],
  ['a rebuild accepts a gap between segments', F, '        if (version !== null && seg.firstVersion !== version + 1) {', '        if (false) {', T.all],
  ['a rebuild skips a segment it cannot read (unsupported or corrupt)', F, "    if (d.status !== 'ok') throw new Error(`ledger: ${key} is ${d.status}: ${d.reason}`)", "    if (d.status !== 'ok') return []", T.segments],
  ['R-3: the start runs inside blockConcurrencyWhile', F, '      this.beginStart()\n      return\n    }\n    if (this.hasPending()', '      this.beginStart()\n      await this.starting?.catch(() => undefined)\n      return\n    }\n    if (this.hasPending()', T.segments],
  ['R-3: requests wait for a start without bound', F, 'const START_WAIT_MS = 2_000', 'const START_WAIT_MS = 600_000', T.segments],
  ['R-5: expire removes only the first table it is given', F, '    const named = [...new Set(tables)]', '    const named = [...new Set(tables)].slice(0, 1)', T.ledger],
  ['R-8: a key outside the tenant\'s prefix is accepted', F, "  if (!f.key.startsWith(p) || f.key.length === p.length || f.key.slice(p.length).includes('/')) return `file key ${f.key} is not under ${p}`\n", '', T.ledger],
  ['names: a shard name outside SHARD_NAME is accepted', F, '  if (!SHARD_NAME.test(ref.shard)) return', '  if (false) return', T.ledger],
  ['the alarm is left set after a drain that wrote everything', F, '        if (this.alarmAt !== null && !this.hasPending()) {', '        if (false) {', T.segments],
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
