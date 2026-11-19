// Mutation checks for the committer's safety rules. Copies the spike (and the publisher sources
// and fixture it imports) to $MUTANT_DIR, outside the shared tree, applies one mutant at a time
// to the copy, runs the tests there with at most 2 workers, and restores the copy's file.
// The shared tree is only read (AGENTS.md). Usage: MUTANT_DIR=<scratch> node mutants.mjs
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const out = process.env.MUTANT_DIR
if (!out) throw new Error('set MUTANT_DIR to a scratch directory outside the repository')
rmSync(out, { recursive: true, force: true })
const spike = join(out, 'spikes/s8-managed-catalog')
mkdirSync(spike, { recursive: true })
for (const f of ['src', 'test', 'package.json', 'tsconfig.json', 'vitest.config.ts', 'wrangler.test.jsonc']) cpSync(join(here, f), join(spike, f), { recursive: true })
symlinkSync(join(repo, 'publisher/node_modules'), join(spike, 'node_modules'))
cpSync(join(repo, 'publisher/src'), join(out, 'publisher/src'), { recursive: true })
mkdirSync(join(out, 'publisher/test/fixtures'), { recursive: true })
cpSync(join(repo, 'publisher/test/fixtures/fixture.json'), join(out, 'publisher/test/fixtures/fixture.json'))
cpSync(join(repo, 'contracts'), join(out, 'contracts'), { recursive: true })

const mutants = [
  ['R3', 'rule 3 removed: no look in the chain before a resubmission', 'src/commit.ts', 'if (inMainChain(t.metadata, snapshotId)) return result', "if (false && inMainChain(t.metadata, snapshotId)) return result"],
  ['R2', "rule 2 removed: the REST commit does not require main to be where it was read", 'src/catalog.ts', "        { type: 'assert-ref-snapshot-id', ref: 'main', 'snapshot-id': currentId(req.base.metadata) },\n", ''],
  ['R2b', 'the R2-native commit writes the next metadata version unconditionally', 'src/catalog.ts', "{ onlyIf: { etagDoesNotMatch: '*' }, httpMetadata", '{ httpMetadata'],
  ['R1', 'rule 1 broken: a rebuilt commit gets a new snapshot id (guard removed)', 'src/commit.ts', "    if (body.snapshot['snapshot-id'] !== snapshotId) throw new Error", "    if (false) throw new Error"],
  ['V1', 'chain verification does not report a snapshot listed twice', 'src/commit.ts', "    if (byId.has(s['snapshot-id'])) problems.push(`snapshot ${s['snapshot-id']} listed twice`)\n", ''],
  ['V2', 'chain verification does not report a fork', 'src/commit.ts', "  for (const s of byId.values()) if (!seen.has(s['snapshot-id'])) problems.push", '  for (const s of byId.values()) if (false) problems.push'],
  ['P1', 'publication ignores removed files (gross, not net)', 'src/commit.ts', 'const removes = [...cur.live.values()].filter((l) => !wantKeys.has(l.file.key))', 'const removes = [...cur.live.values()].filter(() => false)'],
  ['J1', 'a repeated job start runs the exercise again (the harness double-counts)', 'src/index.ts', '    if (cur) return { state: cur.state, started: false }\n', ''],
  ['L1', 'after main moved, the old request is resubmitted instead of a rebuilt one', 'src/commit.ts', 'last && last.parent === parent ? last.body : await plan(t)', 'last && last.parent !== parent ? last.body : await plan(t)'],
]

const results = []
for (const [id, what, file, from, to] of mutants) {
  const path = join(spike, file)
  const orig = readFileSync(path, 'utf8')
  if (!orig.includes(from)) throw new Error(`${id}: pattern not found in ${file}`)
  writeFileSync(path, orig.replace(from, to))
  const r = spawnSync(join(spike, 'node_modules/.bin/vitest'), ['run', '--reporter=json', '--outputFile=' + join(out, `${id}.json`)], { cwd: spike, encoding: 'utf8', timeout: 300_000 })
  writeFileSync(path, orig)
  let failed = []
  try {
    const j = JSON.parse(readFileSync(join(out, `${id}.json`), 'utf8'))
    failed = j.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === 'failed').map((a) => a.title))
  } catch {
    failed = [`(no result: exit ${r.status})`]
  }
  results.push({ id, what, killed: failed.length > 0, failing: failed.length, first: failed[0] ?? null })
  console.log(`${id} ${failed.length > 0 ? 'killed' : 'SURVIVED'} (${failed.length}): ${what}${failed[0] ? ' — e.g. "' + failed[0] + '"' : ''}`)
}
// The unmutated copy passes.
const clean = spawnSync(join(spike, 'node_modules/.bin/vitest'), ['run'], { cwd: spike, encoding: 'utf8', timeout: 300_000 })
console.log(`unmutated copy: exit ${clean.status}`)
console.log(`${results.filter((r) => r.killed).length} of ${results.length} killed`)
void execFileSync
