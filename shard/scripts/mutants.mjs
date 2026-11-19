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
  tail: `npx vitest run ${W} test/tail.test.ts`,
  pool: `npx vitest run ${W} test/pool.test.ts`,
  registration: `npx vitest run ${W} test/registration.test.ts`,
  bounds: `npx vitest run ${W} test/bounds.test.ts`,
  all: `npx vitest run ${W}`,
}
const TT = 'src/tail.ts'
const HULL = '           AND (min_ts IS NULL OR max_ts IS NULL OR (max_ts >= ? AND min_ts <= ?)) ORDER BY seq`,'
// [name, file, from, to, tests]
const mutants = [
  // ── early refusal ──
  ['early refusal: no in-flight limit', F, '    if (this.inFlight >= this.cfg.maxInFlight || this.pendingBytes + bytes > this.cfg.maxPendingBytes) {', '    if (false) {', T.group],
  ['early refusal: no Retry-After (0 ms)', F, '      return { status: \'backpressure\', scope: \'overload\', retryAfterMs: this.cfg.overloadRetryMs + Math.floor(Math.random() * this.cfg.overloadRetryMs) }', '      return { status: \'backpressure\', scope: \'overload\', retryAfterMs: 0 }', T.group],
  ['early refusal: the check reads the fingerprint first', F, '    if (this.inFlight >= this.cfg.maxInFlight || this.pendingBytes + bytes > this.cfg.maxPendingBytes) {', '    if (this.ctx.storage.sql.exec(`SELECT 1 AS x FROM batch WHERE tenant = ? AND fingerprint = ?`, req.tenant, req.fingerprint).toArray().length === 0 && (this.inFlight >= this.cfg.maxInFlight || this.pendingBytes + bytes > this.cfg.maxPendingBytes)) {', T.group],
  ['early refusal: in-flight appends are never released', F, '    this.inFlight -= group.length\n', '', T.group],
  // ── group commit ──
  ['group commit: a failed group answers ok', F, '        p.reject(e)\n        for (const j of p.joined) j.reject(e)', "        p.resolve({ status: 'ok', incarnation: 0, seq: 0, duplicate: false })\n        for (const j of p.joined) j.reject(e)", T.group],
  ['group commit: an append is answered before its group commits', F, '      this.group.push({ req, bytes, now, bounds, joined: [], resolve, reject })', "      this.group.push({ req, bytes, now, bounds, joined: [], resolve: () => undefined, reject })\n      resolve({ status: 'ok', incarnation: 0, seq: 0, duplicate: false })", T.group],
  ['group commit: a retry waiting in the open group is stored again', F, '    const twin = this.group.find((p) => p.req.tenant === req.tenant && p.req.fingerprint === req.fingerprint)', '    const twin = undefined as Pending | undefined', T.group],
  ['group commit: one transaction per append', F, '      else this.commitSoon(false)', '      else this.commitSoon(true)', T.group],
  ['group commit: the tenant cap ignores bytes waiting in the group', F, '    const held = (known?.bufferedBytes ?? 0) + waiting', '    const held = known?.bufferedBytes ?? 0', T.all],
  // ── review fixes ──
  ['R-6: the marker is believed present while it is deleted', F, '      this.setMarked(false)\n      await this.env.CONFIG.delete(key)', '      await this.env.CONFIG.delete(key)', T.trigger],
  ['R-10: a tail read of a stream the shard does not hold answers an empty ok', F, '      if (incarnation !== 0) {\n        if (!this.ledgerNs)', '      if (false) {\n        if (!this.ledgerNs)', T.shard],
  ['R-11(a): every metered append marks the window dirty', F, '      if (metered.w.add(req.seriesIds, req.seriesLimit ?? 0)) metered.dirtySince ??= now', '      metered.w.add(req.seriesIds, req.seriesLimit ?? 0)\n      metered.dirtySince ??= now', T.group],
  ['R-12: fingerprint expiry names no tenant', F, '        sql.exec(`DELETE FROM batch WHERE tenant = ? AND payload IS NULL AND at + ? <= ?`, tenant, this.cfg.fingerprintTtlMs, now)', '        sql.exec(`DELETE FROM batch WHERE payload IS NULL AND at + ? <= ?`, this.cfg.fingerprintTtlMs, now)', T.all],
  // ── spec F12: a segment read is bound to what was listed ──
  ['F12: readSegment ignores the incarnation', F, '    if (incarnation !== undefined && s?.incarnation !== incarnation) return null\n', '', T.review],
  ['F12: readSegment ignores the range', F, '    if (!seg || (seqHi !== undefined && seg.seq_hi !== seqHi)) return null', '    if (!seg) return null', T.review],
  // ── filtered, paged tail reads (D48) ──
  ['tail: the time range is ignored', 'src/tail.ts', '  const timed = f.minTs !== -Infinity || f.maxTs !== Infinity', '  const timed = false', T.tail],
  ['tail: series keys compared as signed, not unsigned', 'src/tail.ts', '      const id = (BigInt(dv.getUint32(p + 4, true)) << 32n) | BigInt(dv.getUint32(p, true))', '      const id = BigInt.asIntN(64, (BigInt(dv.getUint32(p + 4, true)) << 32n) | BigInt(dv.getUint32(p, true)))', T.tail],
  ['tail: the metric names are ignored', 'src/tail.ts', '      if (f.metrics && equalBytes(NAME, payload, nameAt, nameLen)) metricOk = (f.metrics.get(valueLen) ?? []).some((m) => equalBytes(m, payload, valueAt, valueLen))', '      if (f.metrics && equalBytes(NAME, payload, nameAt, nameLen)) metricOk = true', T.tail],
  ['tail: a label with another value does not exclude the series', 'src/tail.ts', '        else ok = false\n', '', T.tail],
  ['tail: a wanted label the series lacks does not exclude it', 'src/tail.ts', '    if (ok && matched !== f.present) ok = false', '    void matched', T.tail],
  ['tail: values copied as numbers', 'src/tail.ts', '    out.set(payload.subarray(valAt + 8 * i, valAt + 8 * i + 8), oVal + 8 * k)', '    ov.setFloat64(oVal + 8 * k, dv.getFloat64(valAt + 8 * i, true), true)', T.tail],
  ['tail: a page may pass its budget', F, '      if (bytes + kept.bytes.byteLength > limit) {', '      if (false) {', T.tail],
  ['tail: a batch that does not fit an empty page is dropped (truncation), not refused', F, "        if (batches.length === 0) return { status: 'page_limit', seq, bytes: kept.bytes.byteLength, maxBytes: limit }", '        if (batches.length === 0) break', T.tail],
  ['tail: a cursor is not bound to its filter', F, ' || c.f !== binding.f || ', ' || ', T.tail],
  ['tail: a paged read does not check the discard fence', F, "    if (aboveSeq < s.discardedThrough) return { status: 'stale_watermark', incarnation, discardedThrough: s.discardedThrough }", "    if (opts === undefined && aboveSeq < s.discardedThrough) return { status: 'stale_watermark', incarnation, discardedThrough: s.discardedThrough }", T.tail],
  ['tail: a later page reads to the current end, not the first page\'s through', F, '      through = c.through\n', '', T.tail],
  ['tail: the scan budget is ignored', F, '      if (scannedBytes >= this.cfg.tailScanMaxBytes) {', '      if (false) {', T.tail],
  // ── registration before writes (D61). The same mutants with the integration traces of flush/
  //    and janitor/ as well: shard/README.md, "Mutation checks" (run over a copy of the tree). ──
  ['D61: acknowledge before logged (a committed registration is taken as logged)', F, '        logged = answer.logged === true', '        logged = true', T.registration],
  ['D61: acknowledge before logged (a new stream is accepted unregistered)', F, "    return this.mode() === 'lazy' || s.registered || s.nextSeq > 1", '    return true', T.registration],
  ['D61: an append parks on the registration instead of being refused', F, '        if (!this.accepts(s)) return this.registeringRefusal()', '        if (!this.accepts(s)) { await this.register(req.tenant); if (!this.accepts(s)) return this.registeringRefusal() }', T.registration],
  ['D61: 429 instead of a retryable scope (refused as `tenant`)', F, "    return { status: 'backpressure', scope: 'registering', retryAfterMs: ms + Math.floor(Math.random() * ms) }", "    return { status: 'backpressure', scope: 'tenant', retryAfterMs: ms + Math.floor(Math.random() * ms) }", T.registration],
  ['D61: a read naming a lost stream does not start and register a fresh one', F, '        const fresh = this.createStream(tenant, 0, incarnation)', "        if (Date.now() > 0) return { status: 'incarnation_mismatch', incarnation: 0 }\n        const fresh = this.createStream(tenant, 0, incarnation)", T.registration],
  ['D61: an answer without `logged` (an older ledger) is taken as logged', F, '        logged = answer.logged === true', '        logged = answer.logged !== false', T.registration],
  ['D61: no single-flight', F, '    if (r.inFlight) return r.inFlight\n', '', T.registration],
  ['D61: no cap on registration calls in flight (m-5)', F, '    if (this.regSlots < Math.max(1, this.cfg.maxRegistrations)) {', '    if (true) {', T.registration],
  ['D61: S5 is not healed (m-7)', F, '    if (!s || s.registered || s.incarnation !== r.incarnation || s.nextSeq !== 1) return', '    return', T.registration],
  ['D61: the alarm does not retry registrations', F, '    const due = [...this.regs].filter(([, r]) => r.inFlight === null && r.at <= now)', '    const due = [...this.regs].filter(() => false)', T.registration],
  ["D61: a new stream's registration is not rebuilt from storage", F, '        if (!s.registered && s.nextSeq === 1 && !this.regs.has(tenant)) this.regs.set(tenant, this.newRegistration(s.incarnation, at))', '', T.registration],
  // ── time bounds of span and log batches (D72; review m-3 of design/reviews/signals-end-to-end.md) ──
  ['D72: hull lower edge off by one (a batch whose last start is exactly minTs is skipped)', F, HULL, HULL.replace('max_ts >= ?', 'max_ts > ?'), T.bounds],
  ['D72: hull upper edge off by one (a batch whose first start is exactly maxTs is skipped)', F, HULL, HULL.replace('min_ts <= ?', 'min_ts < ?'), T.bounds],
  ['D72: recorded min one ms late', TT, '  return { minTs: ms(minHi, minLo), maxTs: ms(maxHi, maxLo) }', '  return { minTs: ms(minHi, minLo) + 1, maxTs: ms(maxHi, maxLo) }', T.bounds],
  ['D72: recorded max one ms early', TT, '  return { minTs: ms(minHi, minLo), maxTs: ms(maxHi, maxLo) }', '  return { minTs: ms(minHi, minLo), maxTs: ms(maxHi, maxLo) - 1 }', T.bounds],
  ['D72: recorded bounds rounded up, not floored', TT, '((BigInt(hi) << 32n) | BigInt(lo)) / NS_PER_MS)', '(((BigInt(hi) << 32n) | BigInt(lo)) + NS_PER_MS - 1n) / NS_PER_MS)', T.bounds],
  ['D72: old rows (no bounds) dropped instead of kept', F, HULL, HULL.replace('(min_ts IS NULL OR max_ts IS NULL OR (max_ts >= ? AND min_ts <= ?))', '(max_ts >= ? AND min_ts <= ?)'), T.bounds],
  ['D72: the signal filter ignored', TT, '  if (f.signals && !f.signals.has(signal)) return null\n', '', T.bounds],
  ['D72: span bounds read from `end`, not `start`', TT, '  if (signal === 2) col += 32 * n', '  if (signal === 2) col += 40 * n', T.bounds],
  ['D72: log bounds read from `observed_ts`, not `ts`', TT, '  if (signal === 2) col += 32 * n', '  col += signal === 2 ? 32 * n : 8 * n', T.bounds],
  ['D72: a type-5 resource attribute is not walked', TT, '        if (type === 1 || type === 5) {', '        if (type === 1) {', T.bounds],
  ['D72: a batch the walk cannot follow refuses the append', TT, '    if (hi >= 0x80000000) return null // negative', "    if (hi >= 0x80000000) throw new Error('negative') // negative", T.bounds],
  ['D72: bounds computed but not stored (nothing is skipped)', F, 'p.bounds?.minTs ?? null, p.bounds?.maxTs ?? null,', 'null, null,', T.bounds],
  ['D72: migration 3 adds no columns', F, "      if (!have.has('min_ts')) sql.exec(`ALTER TABLE batch ADD COLUMN min_ts INTEGER`)", '', T.compat],
  // ── names, versions ──
  ['names: a shard addressed outside SHARD_NAME serves', F, '    if (ctx.id.name !== undefined && !SHARD_NAME.test(ctx.id.name)) throw', '    if (false) throw', T.pool],
  ['names: a pool name with `_` is valid', 'src/pool.ts', "export const validPoolName = (pool: unknown): pool is string => typeof pool === 'string' && POOL_NAME.test(pool)", "export const validPoolName = (pool: unknown): pool is string => typeof pool === 'string' && pool !== ''", T.pool],
  // review M-5 (design/reviews/signals-end-to-end.md): the one base-pool rule edge reads maps with and control writes them with
  ['names: a base pool ending in /logs is valid (validBasePool narrowed)', 'src/pool.ts', '!DERIVED_SIGNALS.some((s) => pool.endsWith(`/${s}`))', "!pool.endsWith('/traces')", T.pool],
  ['names: a base pool may contain `_` (validBasePool without POOL_NAME)', 'src/pool.ts', 'validPoolName(pool) && !DERIVED_SIGNALS', "typeof pool === 'string' && pool !== '' && !DERIVED_SIGNALS", T.pool],
  ['names: dedicatedPool keeps `_`', 'src/pool.ts', "  pool: `tenant/${tenant.replaceAll('_', '-')}`,", '  pool: `tenant/${tenant}`,', T.pool],
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
