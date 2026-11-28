// node --test deploy/test/: the deploy workflow runs only main's own deploy tooling (design/DECISIONS.md
// D69; the review of D69, M-2, reproduced there as RV-3 with b322599). A run on another ref would run
// that ref's deploy/ and workflow: for a commit from before the rollback floors, tooling that judges
// none of them. The jobs that hold the Cloudflare credentials refuse such a run as their first step;
// the workflow of an older commit has no such step, which is why the `production` environment must
// also allow main only (deploy/README.md, One-time setup: a repository setting, not checked here).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { GENERATED_DIR, REPO_ROOT } from '../lib/common.mjs'
import { deploy } from '../release.mjs'
import { captured, cmd, installFakeAccount } from './fake-account.mjs'

const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'deploy.yml')

/** The jobs of a workflow file, by the two-space indentation GitHub's files here use: `[{ name, text }]`. */
function jobsOf(yml) {
  const lines = yml.split('\n')
  const start = lines.indexOf('jobs:')
  const jobs = []
  for (const line of lines.slice(start + 1)) {
    const m = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line)
    if (m) jobs.push({ name: m[1], lines: [] })
    else if (jobs.length && (line.startsWith('    ') || line.trim() === '')) jobs.at(-1).lines.push(line)
    else if (jobs.length && /^\S/.test(line)) break
  }
  return jobs.map((j) => ({ name: j.name, text: j.lines.join('\n') }))
}

/** The steps of a job: each `      - ` item, as text. */
function stepsOf(jobText) {
  const steps = []
  for (const line of jobText.split('\n')) {
    if (line.startsWith('      - ')) steps.push([line])
    else if (steps.length && (line.startsWith('        ') || line.trim() === '')) steps.at(-1).push(line)
    else if (steps.length && /^ {0,6}\S/.test(line)) break
  }
  return steps.map((s) => s.join('\n'))
}

/** A step's `run: |` script, unindented. */
function runOf(stepText) {
  const lines = stepText.split('\n')
  const i = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l))
  assert.ok(i >= 0, `no run block in:\n${stepText}`)
  const body = []
  for (const l of lines.slice(i + 1)) {
    if (l.trim() !== '' && !l.startsWith('          ')) break
    body.push(l.slice(10))
  }
  return body.join('\n')
}

test('M-2 (RV-3): only main is deployed, with main\'s own tooling: both jobs with the Cloudflare credentials refuse another ref first; nothing checks out or advises an older commit', () => {
  const yml = readFileSync(WORKFLOW, 'utf8')
  const prod = jobsOf(yml).filter((j) => /environment:\s*\n\s+name: production/.test(j.text))
  assert.deepEqual(prod.map((j) => j.name).sort(), ['deploy', 'rollback'])
  for (const job of prod) {
    assert.match(job.text, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/, `${job.name} holds the credentials`)
    const steps = stepsOf(job.text)
    assert.match(steps[0], /name: Only main, with main's own deploy tooling/, `${job.name}: the first step is the gate`)
    const script = runOf(steps[0])
    const at = (ref) => spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH, GITHUB_REF: ref }, encoding: 'utf8' })
    assert.equal(at('refs/heads/main').status, 0, `${job.name}: main passes`)
    // The review's RV-3: the Deploy workflow run on a branch at b322599, the commit before D62.
    for (const ref of ['refs/heads/rv-b322599', 'refs/heads/claude/some-branch', 'refs/tags/v1', 'refs/heads/main-old']) {
      const r = at(ref)
      assert.equal(r.status, 1, `${job.name}: ${ref} refused`)
      assert.match(r.stdout, /::error::This workflow deploys only main, with main's own deploy tooling/)
    }
    // It checks out the commit it runs for, never another one by input.
    for (const s of steps.filter((x) => /actions\/checkout@/.test(x))) assert.doesNotMatch(s, /^\s+ref:/m, `${job.name}: a checkout of another ref`)
  }
  // No input names a commit to deploy, and nothing advises running the workflow on an older commit.
  assert.doesNotMatch(yml, /deploy_commit|run this workflow on that commit/)
  const readme = readFileSync(join(REPO_ROOT, 'deploy', 'README.md'), 'utf8')
  assert.doesNotMatch(readme, /go back by deploying an old commit|run the workflow on\s+that commit/)
})

test('M-2 (RV-3): the release b322599 would make (a viz-query from before D62) is refused by the tooling main runs, once INGEST_SIGNALS has been on', async () => {
  const STAGE = 'wftest'
  const N = (w) => `viz-${STAGE}-${w}`
  const tmp = mkdtempSync(join(tmpdir(), 'viz-workflow-test-'))
  const stageDir = join(GENERATED_DIR, `stage-${STAGE}`)
  const account = installFakeAccount(tmp)
  account.writeState({ calls: [], counter: 100, workers: {} })
  const stamp = JSON.stringify({ v: 1, at: ['signal-data'] })
  const none = JSON.stringify({ v: 1, complete: true, formats: {} })
  const manifest = (name, { query = true, signals = null } = {}) => {
    const dir = join(tmp, name)
    mkdirSync(dir, { recursive: true })
    const workers = []
    const add = (worker, canonical, vars, extra) => {
      const config = join(dir, `${canonical}.jsonc`)
      writeFileSync(config, JSON.stringify({ name: worker, vars: { VIZ_RELEASE: name, VIZ_WORKER: canonical, VIZ_FORMATS: none, ...vars } }))
      workers.push({ name: worker, canonical, component: canonical, config: relative(REPO_ROOT, config), deploy: true, migrationTags: [], migrationTag: null, schemas: [], formats: [], ...extra })
    }
    add(N('ingest'), 'viz-ingest', { VIZ_FLOORS: stamp, ...(signals ? { INGEST_SIGNALS: signals } : {}) }, { floors: ['signal-data'] })
    add(N('query'), 'viz-query', query ? { VIZ_FLOORS: stamp } : {}, { floors: query ? ['signal-data'] : [] })
    mkdirSync(stageDir, { recursive: true })
    writeFileSync(join(stageDir, 'manifest.json'), JSON.stringify({ target: `stage-${STAGE}`, stage: STAGE, release: name, durableObjectsCodeUpdate: 'deferred 30s', order: workers.map((w) => w.name), releaseFrom: N('ingest'), workers }))
  }
  try {
    for (const [name, o] of [['r1', {}], ['r2', { signals: 'traces,logs' }]]) {
      manifest(name, o)
      const r = await captured(() => deploy({ stage: STAGE }))
      assert.equal(r.result?.exit, 0, r.log + (r.error?.stack ?? ''))
    }
    manifest('b322599', { query: false })
    const before = account.readState().calls.length
    const old = await captured(() => deploy({ stage: STAGE }))
    assert.equal(old.result?.exit, 3, old.log)
    assert.match(old.log, new RegExp(`${N('query')}: this release is below its floor \\(not stamped .*${N('ingest')} version \\S+ \\(release r2\\) set INGEST_SIGNALS=traces,logs`))
    assert.deepEqual(account.readState().calls.slice(before).map(cmd), [], 'nothing uploaded')
  } finally {
    account.restore()
    rmSync(stageDir, { recursive: true, force: true })
    rmSync(tmp, { recursive: true, force: true })
  }
})
