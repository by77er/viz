// Mutation check for the contracts v2 behaviour (and two of the older safety properties):
// break one thing, run the suite, expect it to FAIL, restore the file.
//   node scripts/mutants.mjs [substring of a mutant name]
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const F = 'src/ledger.ts'
const mutants = [
  ['a lower stream incarnation is registered', 'if (known && ref.incarnation < known.incarnation) {', 'if (false) {'],
  ['an empty unit is admitted', "if (unit.files.length === 0) return invalid('a unit must have at least one file')", ''],
  ['a key that is already live is not refused with invalid', 'if (this.liveFile(f.key)) return invalid(`file key already live in another unit: ${f.key}`)', ''],
  ['a malformed file throws instead of answering invalid', '    const bad = filesProblem(unit.files)\n    if (bad) return invalid(bad)', '    const bad = filesProblem(unit.files)\n    if (bad) throw new Error(bad)'],
  ['a unit below the watermark is not a replay', "if (unit.seqHi <= known.watermark) return { status: 'ok', version: this.version(), watermark: known.watermark }", ''],
  ['a unit straddling the watermark is taken as a replay', 'if (unit.seqHi <= known.watermark) return', 'if (unit.seqLo <= known.watermark) return'],
  ['the base entry is not of kind base', "      kind: 'base',\n", "      kind: 'replace',\n"],
  ['the base entry carries no watermarks', '      watermarks: [...streams.values()].map((st) => ({ shard: st.shard, incarnation: st.incarnation, seq: st.watermark })),', '      watermarks: [],'],
  ['add_unit changes do not carry the unit range', '    if (unit) change.unit = unit\n', ''],
  ['replay does not check the unit range', "      if (!c.unit || c.unit.seqLo !== s.watermark + 1 || c.unit.seqHi !== w.seq) throw bad('unit range is not contiguous with the watermark')\n", ''],
  ['tenant ids are not validated', "if (!TENANT_ID.test(tenant)) throw new Error('ledger: tenant id must match [A-Za-z0-9_-]{1,64}')", ''],
  ['replace admits an output whose key is already live as ok', '      if (this.liveFile(f.key)) return invalid(`file key already live: ${f.key}`)', "      if (this.liveFile(f.key)) return { status: 'ok', version: this.version() }"],
  ['a retried replace is not recognised', "    if (req.add.length > 0 && missing.length === remove.length && req.add.every((f) => this.liveFile(f.key))) {\n      return { status: 'ok', version: this.version() }\n    }\n", ''],
  ['drain returns a bare number', 'return { written: await this.drainSerial() }', 'return (await this.drainSerial()) as never'],
  // Two of the original properties, to show the suite still has them.
  ['loggedWatermarks returns the committed watermark', '.exec(`SELECT shard, incarnation, logged FROM stream ORDER BY shard`)', '.exec(`SELECT shard, incarnation, watermark AS logged FROM stream ORDER BY shard`)'],
  ['the contiguity check is dropped', "if (unit.seqLo !== known.watermark + 1) return { status: 'not_contiguous', watermark: known.watermark }", ''],
]

const only = process.argv[2]
let survived = 0
for (const [name, from, to] of mutants) {
  if (only && !name.includes(only)) continue
  const original = readFileSync(F, 'utf8')
  if (!original.includes(from)) {
    console.log(`NOT APPLIED  ${name} (pattern not found)`)
    survived++
    continue
  }
  writeFileSync(F, original.replace(from, to))
  let failed = false
  let detail = ''
  try {
    execSync('npx vitest run', { stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
  } catch (e) {
    failed = true
    const out = String(e.stdout) + String(e.stderr)
    detail = [...out.matchAll(/^\s+× (.+?)(?: \d+ms)?$/gm)].map((m) => m[1]).slice(0, 2).join(' | ') || (out.match(/Error: .*/)?.[0] ?? '')
  } finally {
    writeFileSync(F, original)
  }
  if (!failed) survived++
  console.log(`${failed ? 'KILLED  ' : 'SURVIVED'}  ${name}${detail ? `  ← ${detail}` : ''}`)
}
console.log(survived === 0 ? 'all mutants killed' : `${survived} mutant(s) survived`)
process.exit(survived === 0 ? 0 : 1)
