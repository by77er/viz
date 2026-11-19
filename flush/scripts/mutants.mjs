// Mutation check on the flush logic: break one property at a time, run the suite, expect
// it to FAIL, restore the file.
//   node scripts/mutants.mjs [substring of a mutant name]
//   node scripts/mutants.mjs --stack      the same mutants against the end-to-end suite in ../stack
//
// AGENTS.md (Evidence): mutants are applied to a COPY of the tree in a scratch area, never in
// place in the shared checkout. The script refuses to run in a git checkout; copy the tree
// (with each component's node_modules linked) and run it from the copy's flush/.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
if (existsSync(`${ROOT}.git`)) {
  console.error(`mutants: ${ROOT} is a git checkout. Run this on a copy in a scratch directory (AGENTS.md, Evidence).`)
  process.exit(2)
}

const F = 'src/flush.ts'
const mutants = [
  ['shard acknowledged with the COMMITTED watermark instead of the logged one', F,
    'const logged = await loggedWatermark(c, seg.incarnation)',
    'const cw = await committedWatermark(c)\n          const logged = cw && cw.incarnation === seg.incarnation ? cw.seq : 0'],
  ['PUT without If-None-Match', F, "    onlyIf: { etagDoesNotMatch: '*' },\n", ''],
  ['contiguity handling dropped (not_contiguous taken as admitted)', F,
    "      if (w >= seg.seqLo) throw new Stop('overlap', `the ledger's watermark ${w} is inside segment ${seg.seqLo}..${seg.seqHi}`)",
    "      if (w < seg.seqHi) return { outcome: 'admitted', result }"],
  ['two segments in one unit', F,
    '  const batches = await c.shard.readSegment(c.tenant, seg.seqLo, seg.incarnation, seg.seqHi)\n',
    `  let batches = await c.shard.readSegment(c.tenant, seg.seqLo, seg.incarnation, seg.seqHi)
  const following = (await c.shard.pendingSegments(c.tenant)).find((p) => p.seqLo === seg.seqHi + 1)
  if (batches && following) {
    batches = [...batches, ...((await c.shard.readSegment(c.tenant, following.seqLo, following.incarnation, following.seqHi)) ?? [])]
    seg = { ...seg, seqHi: following.seqHi }
  }
`],
  // spec/README.md F12: the read is bound to the incarnation and range the segment was listed with.
  ['F12: a segment is read unbound to its incarnation and range', F,
    'c.shard.readSegment(c.tenant, seg.seqLo, seg.incarnation, seg.seqHi)', 'c.shard.readSegment(c.tenant, seg.seqLo)'],
  ['F12: a refused bound read is not reported as an incarnation change', F,
    "    if (now?.incarnation !== seg.incarnation) throw new Stop('shard_incarnation_changed',", "    if (false) throw new Stop('shard_incarnation_changed',"],
  ['series file omitted from the unit', F,
    '  for (const f of encoded) {', "  for (const f of encoded.filter((x) => x.table !== 'metric_series')) {"],
  ['a refused PUT trusted without comparing the existing object', F,
    "  if (created !== null) return 'created'\n", "  if (created !== null) return 'created'\n  if (created === null) return 'exists'\n"],
  ['existing object compared by size only, not by hash', F,
    "  if (!sameBytes(stored, sha256)) throw new Stop('object_conflict', `${key} exists with a different SHA-256`)", ''],
  ['existing object compared by hash only when R2 kept a checksum', F,
    '  if (!stored) {\n', "  if (!stored) return 'exists'\n  if (!stored) {\n"],
  ['key hash not derived from the file bytes', F, '      sha256Hex: hex(digest),', "      sha256Hex: '0'.repeat(64),"],
  ['shard name not sanitised in the key', 'src/keys.ts', "const shard = p.shard.replaceAll('/', '_')", 'const shard = p.shard'],
  ['new shard incarnation not registered on incarnation_mismatch', F,
    '    await c.ledger.registerStream({ shard: c.shardName, incarnation: seg.incarnation })\n', ''],
  ['an older shard incarnation registered over a newer one', F, '    if (result.incarnation > seg.incarnation) {', '    if (false) {'],
  ['invalid answer from the ledger ignored', F,
    "      throw new Stop('invalid_unit', result.reason)", "      return { outcome: 'admitted', result }"],
  ['already-admitted segments encoded and reported again', F,
    'if (committed && committed.incarnation === seg.incarnation && seg.seqHi <= committed.seq) {', 'if (false) {'],
  ['gap in front of the first pending segment not detected', F,
    'if (first && first.seqLo > next && !(committed && committed.incarnation > incarnation)) {', 'if (false) {'],
  ['shard never told recorded', F, '          if (logged > 0) {', '          if (false) {'],
  ['shard told recorded BEFORE the unit is reported', F,
    '            const { outcome, result } = await report(c, seg, unit)',
    '            await c.shard.recorded(tenant, seg.incarnation, seg.seqHi)\n            const { outcome, result } = await report(c, seg, unit)'],
  ['one unit per file instead of one per segment', F,
    '  let result = await c.ledger.addUnit(unit)\n',
    '  for (const f of unit.files.slice(0, -1)) await c.ledger.addUnit({ ...unit, files: [f] })\n  let result = await c.ledger.addUnit({ ...unit, files: unit.files.slice(-1) })\n'],
]

const stack = process.argv.includes('--stack')
const only = process.argv.slice(2).find((a) => a !== '--stack')
let survived = 0
for (const [name, file, from, to] of mutants) {
  if (only && !name.includes(only)) continue
  const path = `${ROOT}flush/${file}`
  const original = readFileSync(path, 'utf8')
  if (!original.includes(from)) {
    console.log(`NOT APPLIED  ${name} (pattern not found in ${file})`)
    survived++
    continue
  }
  writeFileSync(path, original.replace(from, to))
  let failed = false
  let detail = ''
  try {
    // At most two test workers (AGENTS.md, shared machine).
    execSync(stack ? 'npx vitest run --maxWorkers=2 test/e2e.test.ts' : 'npx vitest run --maxWorkers=2 test/flush.test.ts', { cwd: stack ? `${ROOT}stack` : `${ROOT}flush`, stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
  } catch (e) {
    failed = true
    const out = String(e.stdout) + String(e.stderr)
    detail = [...out.matchAll(/^\s+× (.+?)(?: \d+ms)?$/gm)].map((m) => m[1]).slice(0, 3).join(' | ') || (out.match(/Error: .*/)?.[0] ?? '')
  } finally {
    writeFileSync(path, original)
  }
  if (!failed) survived++
  console.log(`${failed ? 'KILLED  ' : 'SURVIVED'}  ${name}${detail ? `  ← ${detail}` : ''}`)
}
console.log(survived === 0 ? 'all mutants killed' : `${survived} mutant(s) survived`)
process.exit(survived === 0 ? 0 : 1)
