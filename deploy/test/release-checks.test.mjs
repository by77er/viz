// node --test deploy/test/: what a release and a rollback refuse beyond Durable Object schemas
// (design/DECISIONS.md D69), through the real release.mjs deploy, plan and rollback against the
// fake account (test/fake-account.mjs, test/fake-wrangler.mjs) and the real deploy/workers.json:
//
// - the rollback floors INGEST_SIGNALS raises (D64; review of traces and logs, M-4): viz-publisher
//   at publisher.Publisher schema 4 or later, viz-query and viz-ingest stamped at the floor
//   (VIZ_FLOORS);
// - format versions (review of D60, m-13): store.anomaly-state version 2 written by a release, and
//   a rollback below the release that reads it.
//
// Each release is built here as configure.mjs would build it (its vars written out literally, so
// this file runs against the release tool from before these checks too, and pins the vars' shape).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { GENERATED_DIR, REPO_ROOT } from '../lib/common.mjs'
import { deploy, planOnly, rollback } from '../release.mjs'
import { callsLike, captured, cmd, installFakeAccount, serving } from './fake-account.mjs'

const STAGE = 'checkstest'
const N = (w) => `viz-${STAGE}-${w}`
const PUB = N('publisher')
const INGEST = N('ingest')
const QUERY = N('query')
const RULER = N('ruler')
const GATEWAY = N('gateway')

const tmp = mkdtempSync(join(tmpdir(), 'viz-release-checks-'))
const stageDir = join(GENERATED_DIR, `stage-${STAGE}`)
const account = installFakeAccount(tmp)
const { writeState, readState } = account

beforeEach(() => {
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  writeState({ calls: [], counter: 100, workers: {} })
})
after(() => {
  account.restore()
  rmSync(stageDir, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
})

const migrations = (n) => Array.from({ length: n }, (_, i) => ({ version: i + 1, readableFrom: 1, name: `m${i + 1}` }))

/**
 * Writes the generated configs and the manifest of one release, as configure.mjs would:
 * `publisher` the publisher's schema version; `query`/`ingest` whether they are stamped at the
 * floor of signal-data; `signals` viz-ingest's INGEST_SIGNALS; `anomaly` what the ruler writes and
 * reads of store.anomaly-state (null: no Worker declares formats, as before D69); `ingestFormats`
 * viz-ingest's (workers.json declares formats for every Worker: viz-query and the gateway read none
 * here). Every declaring Worker carries a complete VIZ_FORMATS, also an empty one (review of D69, M-1).
 */
function release(name, { publisher = 5, query = true, ingest = true, signals = null, anomaly = { w: 1, r: [1, 2] }, ingestFormats = { 'queue.flush': { w: 1, r: [1] } }, gateway = false } = {}) {
  const dir = join(tmp, name)
  mkdirSync(dir, { recursive: true })
  const workers = []
  const add = (worker, canonical, vars, extra) => {
    const config = join(dir, `${canonical}.jsonc`)
    writeFileSync(config, JSON.stringify({ name: worker, vars: { VIZ_RELEASE: name, VIZ_WORKER: canonical, ...vars } }))
    workers.push({ name: worker, canonical, component: canonical, config: relative(REPO_ROOT, config), deploy: true, migrationTags: [], migrationTag: null, schemas: [], formats: [], floors: [], ...extra })
  }
  const stamp = JSON.stringify({ v: 1, at: ['signal-data'] })
  const declared = anomaly !== null
  const formatsOf = (map) => ({
    vars: declared ? { VIZ_FORMATS: JSON.stringify({ v: 1, complete: true, formats: map }) } : {},
    formats: declared ? Object.entries(map).map(([format, f]) => ({ format, writes: f.w, reads: f.r })) : null,
  })
  const pubFormats = formatsOf({ 'r2.cursors': { w: 1, r: [1] } })
  add(PUB, 'viz-publisher', { VIZ_SCHEMAS: JSON.stringify({ v: 1, classes: { 'publisher.Publisher': { latest: publisher, compat: 1, by: null } } }), ...pubFormats.vars }, {
    schemas: [{ component: 'publisher.Publisher', latest: publisher, compat: 1, migrations: migrations(publisher) }],
    formats: pubFormats.formats,
  })
  const ingFormats = formatsOf(ingestFormats)
  add(INGEST, 'viz-ingest', { ...(ingest ? { VIZ_FLOORS: stamp } : {}), ...(signals ? { INGEST_SIGNALS: signals } : {}), ...ingFormats.vars }, { floors: ingest ? ['signal-data'] : [], formats: ingFormats.formats })
  const none = formatsOf({})
  add(QUERY, 'viz-query', { ...(query ? { VIZ_FLOORS: stamp } : {}), ...none.vars }, { floors: query ? ['signal-data'] : [], formats: none.formats })
  const rulerFormats = formatsOf(anomaly ? { 'store.anomaly-state': { w: anomaly.w, r: anomaly.r } } : {})
  add(RULER, 'viz-ruler', rulerFormats.vars, { formats: rulerFormats.formats })
  if (gateway) add(GATEWAY, 'viz-gateway', none.vars, { formats: none.formats })
  const manifest = { target: `stage-${STAGE}`, stage: STAGE, release: name, durableObjectsCodeUpdate: 'deferred 30s', order: workers.map((w) => w.name), releaseFrom: INGEST, workers }
  writeFileSync(join(stageDir, 'manifest.json'), JSON.stringify(manifest))
  return { name, dir }
}

/** Builds and deploys a release; returns its record (and the deploy's exit and log). */
async function ship(name, opts) {
  release(name, opts)
  const { result, error, log } = await captured(() => deploy({ stage: STAGE }))
  assert.equal(error, undefined, `${name}: ${error?.stack}\n${log}`)
  return { exit: result.exit, record: result.record, previous: result.previous, log }
}
async function shipped(name, opts) {
  const r = await ship(name, opts)
  assert.equal(r.exit, 0, `${name} should deploy:\n${r.log}`)
  return r.record
}
const back = (record) => captured(() => rollback({ stage: STAGE, record, reason: 'test' }))
const restores = (state) => callsLike(state, 'versions deploy').filter((c) => c.argv.includes('--name'))
const servingRelease = (name) => serving(readState(), name).vars.VIZ_RELEASE

// ───────────────────────── rollback floors of INGEST_SIGNALS (D64, M-4, D69) ─────────────────────────

test('floors: a release that sets INGEST_SIGNALS is refused while the serving publisher, query or ingest is below its floor; nothing is uploaded', async () => {
  await shipped('r0', { publisher: 3, query: false, ingest: false })
  const before = readState().calls.length
  release('r1', { signals: 'traces,logs' })
  const { result, log } = await captured(() => deploy({ stage: STAGE }))
  assert.equal(result.exit, 3, log)
  assert.match(log, new RegExp(`the ${PUB} serving now is below its floor \\(publisher\\.Publisher schema 3, floor 4`))
  assert.match(log, new RegExp(`the ${QUERY} serving now is below its floor \\(not stamped`))
  assert.match(log, new RegExp(`the ${INGEST} serving now is below its floor \\(not stamped`))
  assert.deepEqual(readState().calls.slice(before).map(cmd), [], 'no wrangler call: nothing uploaded or promoted')
  // plan says the same, and changes nothing.
  const plan = await captured(() => planOnly({ stage: STAGE }))
  assert.equal(plan.result.exit, 3)
  assert.equal(plan.result.problems.length, 3)
})

test('floors: a release that sets INGEST_SIGNALS with one of its own Workers below its floor is refused', async () => {
  await shipped('r0')
  const r = await ship('r1', { signals: 'traces', query: false })
  assert.equal(r.exit, 3, r.log)
  assert.match(r.log, new RegExp(`this release sets INGEST_SIGNALS=traces, and its own ${QUERY} is below its floor`))
  const p = await ship('r1b', { signals: 'logs', publisher: 3 })
  assert.equal(p.exit, 3, p.log)
  assert.match(p.log, new RegExp(`its own ${PUB} is below its floor \\(publisher\\.Publisher schema 3, floor 4`))
})

test('floors: once a release at every floor has served, INGEST_SIGNALS goes on; the record says what each floor saw', async () => {
  await shipped('r0', { publisher: 3, query: false, ingest: false })
  await shipped('r1')
  const r2 = await shipped('r2', { signals: 'traces,logs' })
  assert.deepEqual(r2.floors.filter((f) => f.name === 'signal-data'), [{
    name: 'signal-data', writer: INGEST, var: 'INGEST_SIGNALS', value: 'traces,logs', on: true,
    workers: [PUB, QUERY, INGEST].map((worker) => ({ worker, atFloor: true, servingAtFloor: true })),
  }])
  assert.equal(servingRelease(INGEST), 'r2')
})

test('floors: once a kept viz-ingest version set INGEST_SIGNALS, a release with a Worker below its floor is refused even with the switch off', async () => {
  await shipped('r1')
  await shipped('r2', { signals: 'traces' })
  const old = await ship('r3', { publisher: 3 })
  assert.equal(old.exit, 3, old.log)
  assert.match(old.log, new RegExp(`${PUB}: this release is below its floor \\(publisher\\.Publisher schema 3, floor 4.*${INGEST} version \\S+ \\(release r2\\) set INGEST_SIGNALS=traces`))
  const q = await ship('r3b', { query: false })
  assert.equal(q.exit, 3, q.log)
  assert.match(q.log, new RegExp(`${QUERY}: this release is below its floor`))
  // At every floor with the switch off: allowed (the data stays; every Worker reads it).
  await shipped('r4')
  // The newest viz-ingest version (r4) has the switch off; an older one (r2) had it on: still refused.
  const older = await ship('r5', { publisher: 3 })
  assert.equal(older.exit, 3, older.log)
  assert.match(older.log, /\(release r2\) set INGEST_SIGNALS=traces/)
})

test('floors: a rollback that would leave any of them below its floor after the switch was on is refused, for the whole release or one Worker; nothing is restored', async () => {
  const r0 = await shipped('r0', { publisher: 3, query: false, ingest: false })
  await shipped('r1')
  await shipped('r2', { signals: 'traces,logs' })
  const whole = await back(r0)
  assert.equal(whole.result.exit, 3, whole.log)
  assert.equal(whole.result.problems.length, 3)
  for (const w of [PUB, QUERY, INGEST]) assert.match(whole.log, new RegExp(`${w}: this rollback would restore version .* below its floor`))
  // A record naming one Worker: the others keep what serves now (review of traces and logs, M-4: viz-query alone).
  for (const w of [QUERY, PUB, INGEST]) {
    const one = await back({ ...r0, workers: r0.workers.filter((x) => x.name === w) })
    assert.equal(one.result.exit, 3, one.log)
    assert.equal(one.result.problems.length, 1, one.log)
    assert.match(one.result.problems[0], new RegExp(`^${w}: this rollback would restore`))
  }
  assert.deepEqual(restores(readState()), [], 'nothing restored')
  assert.equal(servingRelease(QUERY), 'r2')
})

test('floors: rollbacks at or above every floor stay allowed: to the release before the switch, and the publisher from D67 to D64 (schema 5 to 4)', async () => {
  const r0 = await shipped('r0', { publisher: 3, query: false, ingest: false })
  const r1 = await shipped('r1', { publisher: 4 })
  await shipped('r2', { publisher: 5, signals: 'traces,logs' })
  const ok = await back(r1)
  assert.equal(ok.result.exit, 0, ok.log)
  assert.equal(servingRelease(PUB), 'r1')
  assert.equal(serving(readState(), INGEST).vars.INGEST_SIGNALS, undefined, 'the switch is off again')
  // The data the switch let in is still there: below the floors stays refused.
  const below = await back(r0)
  assert.equal(below.result.exit, 3, below.log)
})

test('floors: a Worker the record does not name is judged as it serves (put below its floor outside the tool)', async () => {
  const r0 = await shipped('r0', { query: false })
  const r1 = await shipped('r1')
  await shipped('r2', { signals: 'traces' })
  // Someone deploys r0's viz-query by hand (wrangler, not release.mjs): it serves below its floor.
  const s = readState()
  s.workers[QUERY].deployment = [{ version_id: r0.workers.find((w) => w.name === QUERY).versionId, percentage: 100 }]
  writeState(s)
  const partial = await back({ ...r1, workers: r1.workers.filter((w) => w.name !== QUERY) })
  assert.equal(partial.result.exit, 3, partial.log)
  assert.match(partial.result.problems.join('\n'), new RegExp(`^${QUERY}: this rollback would leave serving version .*\\(release r0\\), below its floor`))
})

test('floors: while the switch was never on, they refuse nothing', async () => {
  const r0 = await shipped('r0', { publisher: 3, query: false, ingest: false })
  await shipped('r1')
  const r = await back(r0)
  assert.equal(r.result.exit, 0, r.log)
  assert.equal(servingRelease(PUB), 'r0')
})

// ───────────────────────── format versions (review of D60, m-13; D69) ─────────────────────────

test('m-13: a rollback below the release that reads store.anomaly-state 2 is refused once a release wrote it; to the reader it is allowed', async () => {
  const a = await shipped('a', { anomaly: { w: 1, r: [1] } })
  const b = await shipped('b', { anomaly: { w: 1, r: [1, 2] } })
  const c = await shipped('c', { anomaly: { w: 2, r: [1, 2] } })
  assert.equal(c.forwardOnly, false, 'b reads version 2: c is not forward-only')
  assert.deepEqual(c.formats?.[RULER], { 'store.anomaly-state': { writes: 2, reads: [1, 2] } })
  const toB = await back(b)
  assert.equal(toB.result.exit, 0, toB.log)
  assert.equal(servingRelease(RULER), 'b')
  // b serves now, but c ran since a: what it wrote is judged, not what serves.
  const toA = await back(a)
  assert.equal(toA.result.exit, 3, toA.log)
  assert.match(toA.log, /store\.anomaly-state: release c \(viz-checkstest-ruler version \S+\) wrote version 2, and a reads only 1\./)
  assert.equal(servingRelease(RULER), 'b')
})

test('m-13: a release that writes a format version the serving release does not read is forward-only, and the rollback to it is refused', async () => {
  await shipped('a', { anomaly: { w: 1, r: [1] } })
  const c = await ship('c', { anomaly: { w: 2, r: [1, 2] } })
  assert.equal(c.exit, 0, c.log)
  assert.equal(c.record.forwardOnly, true)
  assert.deepEqual(c.record.forwardOnlyBecause.map((f) => [f.worker, f.kind, f.format, f.writes, f.previousReads]), [[RULER, 'format', 'store.anomaly-state', 2, [1]]])
  assert.match(c.log, /FORWARD-ONLY: store\.anomaly-state: viz-checkstest-ruler writes version 2, and the release serving before it reads only 1/)
  // The automatic rollback's target, previous.json, is refused.
  const auto = await back(c.previous)
  assert.equal(auto.result.exit, 3, auto.log)
})

test('m-13: a record from before format versions is taken to read version 1 of every format: allowed while only 1 was written since, refused once 2 was', async () => {
  const a = await shipped('a', { anomaly: { w: 1, r: [1] } })
  const old = { ...a }
  delete old.formats
  await shipped('b', { anomaly: { w: 1, r: [1, 2] } })
  const ok = await back(old)
  assert.equal(ok.result.exit, 0, ok.log)
  await shipped('c', { anomaly: { w: 2, r: [1, 2] } })
  const refused = await back(old)
  assert.equal(refused.result.exit, 3, refused.log)
  assert.match(refused.log, /wrote version 2, and a reads only 1 \(its record predates format versions: taken to read version 1 of every format\)/)
})

test('m-13: what that costs today: viz-ingest already writes r2.dead-letters 2, so a rollback to a record from before format versions across a viz-ingest upload is refused', async () => {
  const a = await shipped('a')
  const old = { ...a }
  delete old.formats
  await shipped('b', { ingestFormats: { 'r2.dead-letters': { w: 2, r: [1, 2] } } })
  const r = await back(old)
  assert.equal(r.result.exit, 3, r.log)
  assert.match(r.log, /r2\.dead-letters: release b \(viz-checkstest-ingest version \S+\) wrote version 2, and a reads only 1 \(its record predates format versions/)
})

test('m-13: a version since the target that declares no format versions is refused as unknown', async () => {
  const a = await shipped('a')
  await shipped('x', { anomaly: null })
  const r = await back(a)
  assert.equal(r.result.exit, 3, r.log)
  assert.match(r.log, new RegExp(`${RULER}: version \\S+ \\(release x\\), newer than the one being restored, does not declare its format versions`))
})

test('a failed promotion after a Worker the release is forward-only for was promoted puts nothing back', async () => {
  await shipped('a', { anomaly: { w: 1, r: [1] }, gateway: true })
  const c = release('c', { anomaly: { w: 2, r: [1, 2] }, gateway: true })
  writeState({ ...readState(), failOn: `triggers deploy --config ${join(c.dir, 'viz-gateway.jsonc')}` })
  const { error, log } = await captured(() => deploy({ stage: STAGE }))
  assert.ok(error, 'the deploy fails')
  assert.match(log, /forward-only for what was promoted .*store\.anomaly-state.*nothing is rolled back/)
  assert.deepEqual(restores(readState()), [], 'nothing restored')
  assert.equal(servingRelease(RULER), 'c', 'the ruler keeps the release that wrote version 2')
})
