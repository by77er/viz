// Mutation check for the shard's newer safety properties (early refusal, group commit, review
// fixes R-6, R-10, R-11(a), R-12, spec F12, names, versioned storage and messages): break one at
// a time, run the tests that should notice, expect them to FAIL, restore the file. The older
// trigger and limit mutants are in stack/scripts/mutants.mjs.
//   node scripts/mutants.mjs [substring of a mutant name]       (from shard/, in a COPY)
//   node scripts/mutants.mjs --check                             only check that every pattern applies
//
// AGENTS.md (Evidence): never in place in the shared checkout; the script refuses to run inside
// a git checkout. Copy `contracts/` and `shard/` (with a link to `shard/node_modules`) elsewhere.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const check = process.argv[2] === '--check'
if (!check && existsSync(`${ROOT}.git`)) {
  console.error(`mutants: ${ROOT} is a git checkout. Run this on a copy in a scratch directory (AGENTS.md, Evidence).`)
  process.exit(2)
}

const F = 'src/shard.ts'
const W = '--maxWorkers=2'
const T = {
  group: `npx vitest run ${W} test/groupcommit.test.ts`,
  shard: `npx vitest run ${W} test/shard.test.ts`,
  review: `npx vitest run ${W} test/review.test.ts`,
  trigger: `npx vitest run ${W} test/trigger.test.ts test/review.test.ts`,
  compat: `npx vitest run ${W} test/compat.test.ts`,
  pool: `npx vitest run ${W} test/pool.test.ts`,
  all: `npx vitest run ${W}`,
}
// [name, file, from, to, tests]
const mutants = [
  // ── early refusal ──
  ['early refusal: no in-flight limit', F, '    if (this.inFlight >= this.cfg.maxInFlight || this.pendingBytes + bytes > this.cfg.maxPendingBytes) {', '    if (false) {', T.group],
  ['early refusal: no Retry-After (0 ms)', F, '      return { status: \'backpressure\', scope: \'overload\', retryAfterMs: this.cfg.overloadRetryMs + Math.floor(Math.random() * this.cfg.overloadRetryMs) }', '      return { status: \'backpressure\', scope: \'overload\', retryAfterMs: 0 }', T.group],
  ['early refusal: the check reads the fingerprint first', F, '    if (this.inFlight >= this.cfg.maxInFlight || this.pendingBytes + bytes > this.cfg.maxPendingBytes) {', '    if (this.ctx.storage.sql.exec(`SELECT 1 AS x FROM batch WHERE tenant = ? AND fingerprint = ?`, req.tenant, req.fingerprint).toArray().length === 0 && (this.inFlight >= this.cfg.maxInFlight || this.pendingBytes + bytes > this.cfg.maxPendingBytes)) {', T.group],
  ['early refusal: in-flight appends are never released', F, '    this.inFlight -= group.length\n', '', T.group],
  // ── group commit ──
  ['group commit: a failed group answers ok', F, '        p.reject(e)\n        for (const j of p.joined) j.reject(e)', "        p.resolve({ status: 'ok', incarnation: 0, seq: 0, duplicate: false })\n        for (const j of p.joined) j.reject(e)", T.group],
  ['group commit: an append is answered before its group commits', F, '      this.group.push({ req, bytes, now, joined: [], resolve, reject })', "      this.group.push({ req, bytes, now, joined: [], resolve: () => undefined, reject })\n      resolve({ status: 'ok', incarnation: 0, seq: 0, duplicate: false })", T.group],
  ['group commit: a retry waiting in the open group is stored again', F, '    const twin = this.group.find((p) => p.req.tenant === req.tenant && p.req.fingerprint === req.fingerprint)', '    const twin = undefined as Pending | undefined', T.group],
  ['group commit: one transaction per append', F, '      else this.commitSoon(false)', '      else this.commitSoon(true)', T.group],
  ['group commit: the tenant cap ignores bytes waiting in the group', F, '    const held = (known?.bufferedBytes ?? 0) + waiting', '    const held = known?.bufferedBytes ?? 0', T.all],
  // ── review fixes ──
  ['R-6: the marker is believed present while it is deleted', F, '      this.setMarked(false)\n      await this.env.CONFIG.delete(key)', '      await this.env.CONFIG.delete(key)', T.trigger],
  ['R-10: a tail read of a stream the shard does not hold answers an empty ok', F, "      return incarnation === 0 ? { status: 'ok', incarnation: 0, through: aboveSeq, batches: [] } : { status: 'incarnation_mismatch', incarnation: 0 }", "      return { status: 'ok', incarnation, through: aboveSeq, batches: [] }", T.shard],
  ['R-11(a): every metered append marks the window dirty', F, '      if (metered.w.add(req.seriesIds, req.seriesLimit ?? 0)) metered.dirtySince ??= now', '      metered.w.add(req.seriesIds, req.seriesLimit ?? 0)\n      metered.dirtySince ??= now', T.group],
  ['R-12: fingerprint expiry names no tenant', F, '        sql.exec(`DELETE FROM batch WHERE tenant = ? AND payload IS NULL AND at + ? <= ?`, tenant, this.cfg.fingerprintTtlMs, now)', '        sql.exec(`DELETE FROM batch WHERE payload IS NULL AND at + ? <= ?`, this.cfg.fingerprintTtlMs, now)', T.all],
  // ── spec F12: a segment read is bound to what was listed ──
  ['F12: readSegment ignores the incarnation', F, '    if (incarnation !== undefined && s?.incarnation !== incarnation) return null\n', '', T.review],
  ['F12: readSegment ignores the range', F, '    if (!seg || (seqHi !== undefined && seg.seq_hi !== seqHi)) return null', '    if (!seg) return null', T.review],
  // ── names, versions ──
  ['names: a shard addressed outside SHARD_NAME serves', F, '    if (ctx.id.name !== undefined && !SHARD_NAME.test(ctx.id.name)) throw', '    if (false) throw', T.pool],
  ['names: a pool name with `_` is valid', 'src/pool.ts', "export const validPoolName = (pool: unknown): pool is string => typeof pool === 'string' && POOL_NAME.test(pool)", "export const validPoolName = (pool: unknown): pool is string => typeof pool === 'string' && pool !== ''", T.pool],
  ['versions: the flush message carries no v', F, '{ v: FLUSH_MESSAGE_VERSION, tenant, shard: name }', '{ tenant, shard: name }', T.trigger],
  ['versions: storage from before sealed_at is not migrated', F, "      if (!columnsOf(sql, 'segment').has('sealed_at')) sql.exec(`ALTER TABLE segment ADD COLUMN sealed_at INTEGER NOT NULL DEFAULT 0`)", '', T.compat],
  ['versions: an unreadable series window starts empty (limit loosened)', F, '        this.unreadableWindows.add(tenant)\n', '', T.compat],
]

const only = check ? undefined : process.argv[2]
let survived = 0
let missing = 0
for (const [name, file, from, to, tests] of mutants) {
  if (only && !name.includes(only)) continue
  const path = `${ROOT}shard/${file}`
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
    execSync(tests, { cwd: `${ROOT}shard`, stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
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
