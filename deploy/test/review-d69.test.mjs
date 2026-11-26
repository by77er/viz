// node --test deploy/test/: regression tests for the adversarial review of D69
// (design/reviews/d69-deploy-safety.md). Each is one of the review's reproductions (RV-n) of a finding
// fixed here, through the real release.mjs deploy and rollback against the fake account
// (test/fake-account.mjs, test/fake-wrangler.mjs with the review's `keep` and `uploadSecretLag`).
// Each failed against the release tool as the review read it (9958cb3) and passes now
// (deploy/README.md, "How it was verified"). M-2 (RV-3) is in test/workflow.test.mjs; the findings
// recorded as known risks instead (m-1 RV-4, m-4 RV-10) are not reproduced here.
//
// Releases are built as configure.mjs builds them now: every Worker that declares formats carries a
// complete VIZ_FORMATS (`complete: true`); `legacy` builds them as D69 did (no `complete`, viz-query
// declaring nothing).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { GENERATED_DIR, REPO_ROOT } from '../lib/common.mjs'
import { deploy, rollback } from '../release.mjs'
import { callsLike, captured, cmd, installFakeAccount, oauthGated, serving } from './fake-account.mjs'

const STAGE = 'rvtest'
const N = (w) => `viz-${STAGE}-${w}`
const PUB = N('publisher')
const INGEST = N('ingest')
const CONTROL = N('control')
const QUERY = N('query')
const KEY = 'OAUTH_CLIENT_KEY'

const tmp = mkdtempSync(join(tmpdir(), 'viz-review-d69-'))
const stageDir = join(GENERATED_DIR, `stage-${STAGE}`)
const account = installFakeAccount(tmp)
const { writeState, readState } = account
const empty = () => ({ calls: [], counter: 100, workers: {} })

beforeEach(() => {
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  writeState(empty())
})
after(() => {
  account.restore()
  rmSync(stageDir, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
})

const migrations = (n) => Array.from({ length: n }, (_, i) => ({ version: i + 1, readableFrom: 1, name: `m${i + 1}` }))
const stamp = JSON.stringify({ v: 1, at: ['signal-data'] })

/**
 * One release, as configure.mjs writes it. `ingestReads`: viz-ingest's read list of kv.settings;
 * `controlWrites`/`controlReads`: viz-control's kv.settings (with `control`); `queryReads`:
 * viz-query's formats map, or null for a viz-query that declares nothing (as before this change);
 * `signals`: INGEST_SIGNALS (a string, or a list for a JSON var); `drop`: Workers left out of the
 * order; `legacy`: VIZ_FORMATS as D69 wrote it (no `complete`).
 */
function release(name, { publisher = 5, query = true, ingest = true, signals = null, ingestReads = [1], controlWrites = 1, controlReads = null, control = false, queryReads = {}, drop = [], legacy = false } = {}) {
  const dir = join(tmp, name)
  mkdirSync(dir, { recursive: true })
  const workers = []
  const add = (worker, canonical, vars, extra) => {
    const config = join(dir, `${canonical}.jsonc`)
    const { ratelimits, ...summary } = extra
    writeFileSync(config, JSON.stringify({ name: worker, vars: { VIZ_RELEASE: name, VIZ_WORKER: canonical, ...vars }, ...(ratelimits ? { ratelimits } : {}), ...(extra.migrationTag ? { migrations: [{ tag: extra.migrationTag }] } : {}) }))
    workers.push({ name: worker, canonical, component: canonical, config: relative(REPO_ROOT, config), deploy: true, migrationTags: extra.migrationTag ? [extra.migrationTag] : [], migrationTag: null, schemas: [], formats: [], floors: [], ...summary })
  }
  const declared = (map) =>
    map === null
      ? { vars: {}, formats: null }
      : { vars: { VIZ_FORMATS: JSON.stringify({ v: 1, ...(legacy ? {} : { complete: true }), formats: map }) }, formats: Object.entries(map).map(([format, f]) => ({ format, writes: f.w, reads: f.r })) }
  const pub = declared({ 'r2.cursors': { w: 1, r: [1] } })
  add(PUB, 'viz-publisher', { VIZ_SCHEMAS: JSON.stringify({ v: 1, classes: { 'publisher.Publisher': { latest: publisher, compat: 1, by: null } } }), ...pub.vars }, {
    schemas: [{ component: 'publisher.Publisher', latest: publisher, compat: 1, migrations: migrations(publisher) }],
    formats: pub.formats,
  })
  const ing = declared({ 'queue.flush': { w: 1, r: [1] }, 'kv.settings': { w: null, r: ingestReads } })
  add(INGEST, 'viz-ingest', { ...(ingest ? { VIZ_FLOORS: stamp } : {}), ...(signals ? { INGEST_SIGNALS: signals } : {}), ...ing.vars }, { floors: ingest ? ['signal-data'] : [], formats: ing.formats })
  if (control) {
    const ctl = declared({ 'kv.settings': { w: controlWrites, r: controlReads ?? [controlWrites] } })
    // A stage's viz-control as configure.mjs writes it since D70's gate: its rate limits, stamped at oauth-public.
    const gated = oauthGated()
    add(CONTROL, 'viz-control', { VIZ_SCHEMAS: JSON.stringify({ v: 1, classes: { 'control.Tenant': { latest: 1, compat: 1, by: null } } }), ...ctl.vars, ...gated.config.vars }, {
      ...gated.manifest,
      ratelimits: gated.config.ratelimits,
      migrationTag: 'v1',
      schemas: [{ component: 'control.Tenant', latest: 1, compat: 1, migrations: migrations(1) }],
      formats: ctl.formats,
    })
    workers.at(-1).migrationTag = 'v1'
  }
  const q = declared(queryReads)
  add(QUERY, 'viz-query', { ...(query ? { VIZ_FLOORS: stamp } : {}), ...q.vars }, { floors: query ? ['signal-data'] : [], formats: q.formats })
  const manifest = { target: `stage-${STAGE}`, stage: STAGE, release: name, durableObjectsCodeUpdate: 'deferred 30s', order: workers.map((w) => w.name).filter((n) => !drop.includes(n)), releaseFrom: INGEST, workers }
  writeFileSync(join(stageDir, 'manifest.json'), JSON.stringify(manifest))
  return { name, dir }
}

async function ship(name, opts = {}, rotateText = '') {
  release(name, opts)
  const { result, error, log } = await captured(() => deploy({ stage: STAGE, rotateText, ackText: 'viz-control@v1' }))
  return { exit: result?.exit, record: result?.record, error, log }
}
async function shipped(name, opts, rotateText) {
  const r = await ship(name, opts, rotateText)
  assert.equal(r.error, undefined, `${name}: ${r.error?.stack}\n${r.log}`)
  assert.equal(r.exit, 0, `${name} should deploy:\n${r.log}`)
  return r.record
}
const back = (record, opts = {}) => captured(() => rollback({ stage: STAGE, record, reason: 'review', ...opts }))
const servingRelease = (name) => serving(readState(), name).vars.VIZ_RELEASE
const without = (record, ...names) => ({ ...record, workers: record.workers.filter((w) => !names.includes(w.name)) })
const restoredNames = () => callsLike(readState(), 'versions deploy').filter((c) => c.argv.includes('--name')).map((c) => c.argv[c.argv.indexOf('--name') + 1])
const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

// ───────────────────────── M-1: format rollbacks judge the Workers a record leaves out ─────────────────────────

test('M-1 (RV-1a): a record that leaves viz-control out is judged with viz-control as it serves: refused under a kv.settings version it wrote and writes; allowed where the restored Workers read it', async () => {
  const a = await shipped('a', { control: true, ingestReads: [1], controlWrites: 1 })
  const b = await shipped('b', { control: true, ingestReads: [1, 2], controlWrites: 1, controlReads: [1, 2] })
  const c = await shipped('c', { control: true, ingestReads: [1, 2], controlWrites: 2, controlReads: [1, 2] })
  assert.equal(c.forwardOnly, false, 'c is not forward-only: b reads 2 (readers first, §3.3)')
  const whole = await back(a)
  assert.equal(whole.result.exit, 3, whole.log)
  assert.match(whole.log, /kv\.settings: release c .* wrote version 2, and a reads only 1/)
  // Before: allowed, viz-ingest back to a's janitor (reads 1 only) under viz-control writing 2.
  const partial = await back(without(a, CONTROL))
  assert.equal(partial.result?.exit, 3, partial.log)
  assert.match(partial.log, new RegExp(`kv\\.settings: ${CONTROL} is left serving by this rollback \\(the record does not restore it\\), and its version \\S+ \\(release c, serving now\\) writes version 2, and a reads only 1`))
  assert.deepEqual(restoredNames(), [], 'nothing moved')
  assert.equal(servingRelease(INGEST), 'c')
  // The same through --only.
  const only = await back(a, { only: `${PUB},${INGEST},viz-query` })
  assert.equal(only.result?.exit, 3, only.log)
  assert.match(only.log, /is left serving by this rollback/)
  // To b without viz-control: b's viz-ingest reads 2; allowed, and viz-control keeps serving c.
  const ok = await back(without(b, CONTROL))
  assert.equal(ok.result?.exit, 0, ok.log)
  assert.equal(servingRelease(INGEST), 'b')
  assert.equal(servingRelease(CONTROL), 'c')
})

test('M-1: a Worker left out that was itself rolled back since keeps what its newer versions wrote under the restored Workers: every kept version since the record\'s is judged, not only the serving one', async () => {
  const a = await shipped('a', { control: true, ingestReads: [1], controlWrites: 1 })
  const b = await shipped('b', { control: true, ingestReads: [1, 2], controlWrites: 1, controlReads: [1, 2] })
  await shipped('c', { control: true, ingestReads: [1, 2], controlWrites: 2, controlReads: [1, 2] })
  // viz-control alone back to b: it writes 1 again; what c's wrote (2) stays.
  const toB = await back(b, { only: 'viz-control' })
  assert.equal(toB.result?.exit, 0, toB.log)
  assert.equal(servingRelease(CONTROL), 'b')
  const r = await back(a, { only: `${PUB},${INGEST},${QUERY}` })
  assert.equal(r.result?.exit, 3, r.log)
  assert.match(r.log, new RegExp(`kv\\.settings: ${CONTROL} is left serving by this rollback \\(the record does not restore it\\), and its version \\S+ \\(release c\\) writes version 2, and a reads only 1`))
  assert.equal(servingRelease(INGEST), 'c')
})

test("M-1 (RV-1b): the rotation refusal no longer offers a bare record without viz-control; the way it offers is judged, and refused under what viz-control wrote", async () => {
  const a = await shipped('a', { control: true, ingestReads: [1], controlWrites: 1 })
  await shipped('b', { control: true, ingestReads: [1, 2], controlWrites: 1, controlReads: [1, 2] })
  await shipped('c', { control: true, ingestReads: [1, 2], controlWrites: 2, controlReads: [1, 2] }, KEY) // rotates the key too
  const whole = await back(a)
  assert.equal(whole.result.exit, 3, whole.log)
  assert.match(whole.log, /crosses a rotation/)
  assert.doesNotMatch(whole.log, /Roll back with a record that leaves \S+ out \(its serving version stays/)
  assert.match(whole.log, /release\.mjs rollback --only, naming them\): \S+ then keeps its serving version .* judged like any other, with \S+ as it serves/)
  const advised = await back(a, { only: [PUB, INGEST, QUERY].join(',') })
  assert.equal(advised.result?.exit, 3, advised.log)
  assert.match(advised.log, new RegExp(`kv\\.settings: ${CONTROL} is left serving by this rollback`))
  assert.equal(servingRelease(INGEST), 'c')
})

test('M-1 (c): a Worker that declares no formats is taken to read version 1 of every format: over such a viz-query, a release writing kv.settings 2 is forward-only, and a rollback to its record is refused', async () => {
  // As deployed before this change: viz-query declares nothing, the others' VIZ_FORMATS are D69's.
  const a = await shipped('a', { control: true, ingestReads: [1, 2], controlWrites: 1, controlReads: [1, 2], queryReads: null, legacy: true })
  const b = await ship('b', { control: true, ingestReads: [1, 2], controlWrites: 2, controlReads: [1, 2], queryReads: null, legacy: true })
  assert.equal(b.exit, 0, b.log)
  // Before: not forward-only (only the Workers declaring kv.settings were asked: viz-ingest and viz-control read 2).
  assert.equal(b.record.forwardOnly, true, b.log)
  assert.deepEqual(b.record.forwardOnlyBecause.map((f) => [f.worker, f.kind, f.format, f.writes, f.previousReads]), [[CONTROL, 'format', 'kv.settings', 2, [1]]])
  assert.match(b.record.forwardOnlyBecause[0].why, new RegExp(`\\(${QUERY} declares no format versions; ${PUB} does not list it, in a declaration from before declarations were complete: taken to read version 1\\)`))
  // Before: allowed (a's record: viz-ingest and viz-control read 1 and 2; viz-query was not asked).
  const r = await back(a)
  assert.equal(r.result.exit, 3, r.log)
  assert.match(r.log, new RegExp(`kv\\.settings: release b \\(${CONTROL} version \\S+\\) wrote version 2, and a reads only 1 \\(${QUERY} has no format versions in that record: taken to read version 1 of every format\\)`))
})

// ───────────────────────── m-2: the switch as a secret, or a JSON var ─────────────────────────

test('m-2 (RV-5): INGEST_SIGNALS set as a Worker secret is seen: a rollback below every floor is refused, and a release is refused while the secret is on viz-ingest', async () => {
  const r0 = await shipped('r0', { publisher: 3, query: false, ingest: false })
  await shipped('r1')
  // `wrangler secret put INGEST_SIGNALS` on viz-ingest: a new version with the secret, deployed at once.
  const s = readState()
  const w = s.workers[INGEST]
  const last = w.versions.at(-1)
  const v = { ...structuredClone(last), id: '00000000-0000-4000-8000-0000000009ff', number: last.number + 1, secrets: { ...last.secrets, INGEST_SIGNALS: 'traces,logs' } }
  w.versions.push(v)
  w.deployment = [{ version_id: v.id, percentage: 100 }]
  writeState(s)
  const r = await back(r0)
  assert.equal(r.result.exit, 3, r.log)
  assert.match(r.log, new RegExp(`${PUB}: this rollback would restore version .* and ${INGEST} version ${v.id} \\(release r1\\) set INGEST_SIGNALS=\\(a secret\\)`))
  assert.equal(servingRelease(PUB), 'r1')
  const before = readState().calls.length
  const next = await ship('r2')
  assert.equal(next.exit, 3, next.log)
  assert.match(next.log, new RegExp(`${INGEST}: INGEST_SIGNALS is a secret on its serving version ${v.id}\\. Every upload inherits`))
  assert.deepEqual(readState().calls.slice(before).map(cmd), [], 'nothing uploaded')
})

test('m-2: INGEST_SIGNALS as a JSON var is seen too: once a version had it, a rollback below the floors is refused', async () => {
  const r0 = await shipped('r0', { publisher: 3, query: false, ingest: false })
  await shipped('r1')
  await shipped('r2', { signals: ['traces'] })
  assert.deepEqual(serving(readState(), INGEST).vars.INGEST_SIGNALS, ['traces'], 'a JSON var, as the API shows it')
  await shipped('r3')
  const r = await back(r0)
  assert.equal(r.result.exit, 3, r.log)
  assert.match(r.log, /\(release r2\) set INGEST_SIGNALS=traces/)
})

// ───────────────────────── m-3: a floor Worker this release does not deploy ─────────────────────────

test('m-3 (RV-6): the switch is refused while a floor Worker that this release does not deploy serves below its floor; nothing is uploaded', async () => {
  await shipped('r0', { query: false })
  await shipped('r1', { query: false })
  const before = readState().calls.length
  const r = await ship('r2', { signals: 'traces,logs', drop: [QUERY] })
  assert.equal(r.exit, 3, r.log)
  assert.match(r.log, new RegExp(`the ${QUERY} serving now, which this release does not deploy, is below its floor \\(not stamped`))
  assert.deepEqual(readState().calls.slice(before).map(cmd), [], 'nothing uploaded')
  assert.equal(serving(readState(), INGEST).vars.INGEST_SIGNALS, undefined)
})

// ───────────────────────── m-5: the run-mark refusal on the wrangler deploy path ─────────────────────────

test('m-5 (RV-7): the run-mark refusal on a viz-control that goes out with wrangler deploy fails the release in phase 2 (exit 1) and says what serves; it no longer says nothing was promoted', async () => {
  writeState({ ...empty(), racePut: true })
  release('n1', { control: true })
  const { result, error, log } = await captured(() => deploy({ stage: STAGE, ackText: 'viz-control@v1' }))
  assert.equal(result, undefined)
  assert.match(String(error?.message), /built on an upload of another run/)
  assert.doesNotMatch(error.message, /Nothing is promoted/)
  assert.match(error.message, new RegExp(`${CONTROL} serves version \\S+, which wrangler deploy made in phase 2, without its generated secrets \\(/oauth/register answers 503\\), and the Workers before it in this release are promoted: the release fails in phase 2 \\(exit 1\\)`))
  assert.match(log, new RegExp(`REFUSED in phase 2, after promotion began \\(exit 1\\) at ${CONTROL}`))
  const st = readState()
  assert.equal(st.workers[PUB].deployment.length, 1, 'viz-publisher promoted')
  assert.equal(st.workers[INGEST].deployment.length, 1, 'viz-ingest promoted')
  assert.deepEqual(Object.keys(serving(st, CONTROL).secrets), [], 'viz-control serves, without the key')
})

// ───────────────────────── m-6: "set but missing from the upload" says what lifts it ─────────────────────────

test('m-6 (RV-8): the refusal of a key set but missing from the upload says that neither a rollback nor deploying again lifts it (both are still refused)', async () => {
  await shipped('k1', { control: true })
  writeState({ ...readState(), inherit: 'none' })
  const r1 = await ship('k2', { control: true })
  assert.equal(r1.exit, 3, r1.log)
  assert.match(r1.log, /Neither a rollback nor deploying again lifts this: the refused version is now the newest, and the next upload inherits from it/)
  writeState({ ...readState(), inherit: undefined })
  const r2 = await ship('k3', { control: true })
  assert.equal(r2.exit, 3, 'still refused, as the message says')
})

// ───────────────────────── m-7: the re-read waits for the inherited key; an empty budget is the default ─────────────────────────

test('m-7 (RV-11): an upload shown for its first read without the key it inherited is read again until the key shows: kept, not refused; VIZ_FRESH_READ_MS="" is the default budget, not 0', async () => {
  for (const budget of ['300', '']) {
    writeState(empty())
    await shipped('u0', { control: true })
    writeState({ ...readState(), uploadSecretLag: 1 })
    const r = await withEnv({ VIZ_FRESH_READ_MS: budget }, () => ship('u1', { control: true }))
    assert.equal(r.error, undefined, `${JSON.stringify(budget)}: ${r.error?.stack}\n${r.log}`)
    assert.equal(r.exit, 0, `${JSON.stringify(budget)}: ${r.log}`)
    assert.deepEqual(r.record.secrets.map((x) => x.action), ['kept'])
    assert.equal(callsLike(readState(), 'versions secret put').length, 1, 'only u0 put the key')
  }
})

// ───────────────────────── m-8: the one-Worker way out, as a command ─────────────────────────

test('m-8 (RV-9): with the switch on, a viz-query left in a gradual deployment refuses every release; --only restores viz-query alone, moving nothing else, and the next release goes out', async () => {
  await shipped('r1')
  const r2 = await shipped('r2', { signals: 'traces,logs' })
  const s = readState()
  const q = s.workers[QUERY]
  q.deployment = [{ version_id: q.versions.at(-1).id, percentage: 50 }, { version_id: q.versions.at(-2).id, percentage: 50 }]
  writeState(s)
  const r3 = await ship('r3', { signals: 'traces,logs' })
  assert.equal(r3.exit, 3, r3.log)
  assert.match(r3.log, new RegExp(`the ${QUERY} serving now is below its floor \\(not stamped`))
  const out = await back(r2, { only: 'viz-query' })
  assert.equal(out.result?.exit, 0, out.log)
  assert.deepEqual(restoredNames(), [QUERY], 'viz-query alone was restored')
  assert.equal(out.result.record.workers.length, 1)
  await shipped('r4', { signals: 'traces,logs' })
})

// Last: before the fix, the request below hangs, and the tests after it would be cancelled with it.
test('m-7: a Cloudflare API request that never answers is abandoned after VIZ_CF_TIMEOUT_MS and retried', { timeout: 20_000 }, async () => {
  const { cf } = await import('../lib/cf.mjs')
  const saved = globalThis.fetch
  // A request that hangs holds a socket, which keeps the process alive; the stub below holds nothing,
  // so this does, for long enough (and not for ever: without the timeout the test fails, not hangs).
  const alive = setTimeout(() => {}, 10_000)
  let calls = 0
  globalThis.fetch = (url, init = {}) => {
    calls++
    // The first request hangs until it is aborted; the retry answers.
    if (calls === 1) return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)))
    return Promise.resolve(new Response(JSON.stringify({ success: true, result: [] }), { status: 200 }))
  }
  try {
    const j = await withEnv({ VIZ_CF_TIMEOUT_MS: '200' }, () => cf('GET', '/workers/scripts'))
    assert.deepEqual(j.result, [])
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = saved
    clearTimeout(alive)
  }
})
