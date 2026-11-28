#!/usr/bin/env node
// The format versions a release from before format records (D69) writes and reads, made from that
// release's own sources by this tree's reader, into deploy/records/<sha>.formats.json (review of D69,
// round 2, M2-1). release.mjs uses such a file wherever a record or a version of that release declares
// no formats, instead of taking it to read version 1 of everything.
//
//   node deploy/scripts/record-formats.mjs <full sha>     (from the repository; needs git and deploy/node_modules)
//
// How: `git archive <sha>` of the components into a scratch directory, with this tree's deploy/lib,
// deploy/workers.json and deploy/node_modules put beside them; then lib/formats.mjs's own
// formatSources and readFormats for each Worker of this tree's workers.json, evaluated against that
// release's sources. So the `FORMATS` maps, `READS` lists and version constants are that release's;
// the declarations that are not code (`reads_v1`, which formats a Worker reads at all) are this tree's,
// which a test holds to this tree's bundled sources. A declared source that release lacks is an error.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEPLOY_DIR, REPO_ROOT } from '../lib/common.mjs'

const sha = process.argv[2]
if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('usage: record-formats.mjs <full 40-character sha>')
const dir = mkdtempSync(join(tmpdir(), `viz-record-formats-${sha.slice(0, 7)}-`))
try {
  const dirs = ['contracts', 'publisher', 'stack', 'shard', 'ledger', 'edge', 'flush', 'compact', 'janitor', 'control', 'query', 'ruler', 'mcp', 'dashboard', 'anomaly']
  const present = execFileSync('git', ['ls-tree', '--name-only', sha], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n')
  execFileSync('sh', ['-c', `git archive ${sha} ${dirs.filter((d) => present.includes(d)).join(' ')} | tar -x -C "${dir}"`], { cwd: REPO_ROOT })
  const here = join(dir, 'deploy')
  cpSync(join(DEPLOY_DIR, 'lib'), join(here, 'lib'), { recursive: true })
  cpSync(join(DEPLOY_DIR, 'workers.json'), join(here, 'workers.json'))
  cpSync(join(DEPLOY_DIR, 'package.json'), join(here, 'package.json'))
  symlinkSync(join(DEPLOY_DIR, 'node_modules'), join(here, 'node_modules'))
  const { formatSources, readFormats } = await import(pathToFileURL(join(here, 'lib', 'formats.mjs')).href)
  const plan = (await import(pathToFileURL(join(here, 'workers.json')).href, { with: { type: 'json' } })).default
  const formats = {}
  for (const w of plan.workers.filter((x) => x.deploy !== false)) {
    formats[w.name] = Object.fromEntries(readFormats(formatSources([w])).map((f) => [f.format, { writes: f.writes, reads: f.reads }]))
  }
  const out = {
    $comment: `The format versions release ${sha} writes and reads, made on ${new Date().toISOString().slice(0, 10)} by deploy/scripts/record-formats.mjs: this tree's lib/formats.mjs and workers.json declarations, evaluated against that commit's own sources (git archive). Its own deploy tooling predates format records (D69), so neither its record nor its versions say this. release.mjs uses it wherever a record or a version of that release declares no formats (review of D69, round 2, M2-1).`,
    release: sha,
    formatsComplete: true,
    formats,
  }
  const file = join(DEPLOY_DIR, 'records', `${sha}.formats.json`)
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
  console.log(file)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
