// node --test deploy/test/: the first release this tool makes over the production the owner deployed
// on 2026-11-19 from main at fb77292 (PR #8) with that commit's own tooling, which predates D69: its
// records have no formats, its versions no VIZ_FORMATS, VIZ_FLOORS or VIZ_DEPLOY_RUN, viz-control has
// OAUTH_CLIENT_KEY but no Rate Limiting bindings and no OAUTH_PUBLIC. Each step runs the real
// resources.mjs (the rate-limit ids only), configure.mjs (production, the real component configs) and
// release.mjs (plan, deploy, rollback) against the fake account (test/fake-account.mjs,
// test/fake-wrangler.mjs), loaded with production as fb77292's tool left it
// (test/fixtures/production-fb77292.json). deploy/README.md, "The first release over the 2026-11-19
// production", reports what this shows. Nothing reaches Cloudflare.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// Before the deploy modules load: their generated/ and resources.json are this test's own, so a real
// deploy/generated/production/ and deploy/resources.json are never touched.
const tmp = mkdtempSync(join(tmpdir(), 'viz-upgrade-production-'))
process.env.VIZ_GENERATED_DIR = join(tmp, 'generated')
process.env.VIZ_RESOURCES_FILE = join(tmp, 'resources.json')
writeFileSync(process.env.VIZ_RESOURCES_FILE, JSON.stringify({ kv_namespaces: { 'viz-config': 'c'.repeat(32) }, ratelimit_namespaces: {} }))
mkdirSync(process.env.VIZ_GENERATED_DIR, { recursive: true })
const { DEPLOY_DIR } = await import('../lib/common.mjs')
const { appBuilt, callsLike, captured, cmd, installFakeAccount, serving } = await import('./fake-account.mjs')
const { configure } = await import('../configure.mjs')
const { deploy, planOnly, rollback } = await import('../release.mjs')
const { allocateRateLimitIds, ensureRateLimitIds, wantedRateLimits } = await import('../resources.mjs')
const cfApi = await import('../lib/cf.mjs')

const FB = JSON.parse(readFileSync(join(DEPLOY_DIR, 'test', 'fixtures', 'production-fb77292.json'), 'utf8'))
const account = installFakeAccount(tmp)
const { writeState, readState } = account
after(() => {
  account.restore()
  rmSync(tmp, { recursive: true, force: true })
})

const KEY = 'OAUTH_CLIENT_KEY'
const OLD_KEY = `the-key-fb77292-created-${'k'.repeat(24)}`
const vid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/**
 * Production as fb77292's tool left it (its release.mjs and bootstrap.mjs, read at fb77292): every
 * Worker created by `wrangler deploy` (a first deploy: migrations), tagged with the release, vars as
 * its configure.mjs generated them; then viz-control's key by `versions secret put` (message "…;
 * OAUTH_CLIENT_KEY created") and `versions deploy`; then the first tenant's bootstrap, whose
 * `wrangler secret put` and `secret delete` each deploy a gateway version. Two scripts of the account
 * that are not viz's bind Rate Limiting namespaces (one at the id viz would otherwise take first), and
 * a viz spike binds another.
 */
function fb77292Production(foreignIds) {
  let n = 0
  const workers = {}
  for (const w of FB.workers) {
    const v1 = { id: vid(++n), number: 1, tag: FB.release, message: `viz ${FB.release}`, vars: w.vars, secrets: {} }
    workers[w.name] = { migrationTag: w.migrationTag, versions: [v1], deployment: [{ version_id: v1.id, percentage: 100 }], active: [v1.id] }
  }
  const control = workers['viz-control']
  const keyed = { ...structuredClone(control.versions[0]), id: vid(++n), number: 2, message: `viz ${FB.release}; ${KEY} created`, secrets: { [KEY]: OLD_KEY } }
  control.versions.push(keyed)
  control.deployment = [{ version_id: keyed.id, percentage: 100 }]
  control.active.push(keyed.id)
  const gw = workers['viz-gateway']
  for (const [i, secrets] of [[2, { VIZ_BOOTSTRAP: 'a-one-time-secret' }], [3, {}]]) {
    const v = { ...structuredClone(gw.versions[0]), id: vid(++n), number: i, tag: null, message: null, secrets }
    gw.versions.push(v)
    gw.deployment = [{ version_id: v.id, percentage: 100 }]
    gw.active.push(v.id)
  }
  const rl = (name, id) => ({ name, namespace_id: id, simple: { limit: 10, period: 60 } })
  const foreign = (name, ratelimits) => ({ migrationTag: null, versions: [{ id: vid(++n), number: 1, tag: null, vars: {}, secrets: {}, ratelimits }], deployment: [], active: [] })
  workers['unrelated-app'] = foreign('unrelated-app', [rl('LIMITER', foreignIds[0]), rl('OTHER', '1001')])
  workers['unrelated-app'].deployment = [{ version_id: workers['unrelated-app'].versions[0].id, percentage: 100 }]
  workers['viz-s5-spike'] = foreign('viz-s5-spike', [rl('SPIKE_RL', foreignIds[1])])
  workers['viz-s5-spike'].deployment = [{ version_id: workers['viz-s5-spike'].versions[0].id, percentage: 100 }]
  return { calls: [], counter: 1000, workers }
}

/** The record fb77292's release.mjs wrote for that deploy (the artifact release-fb77292…): schemas, no formats. */
const fb77292Record = (state) => ({
  kind: 'release', target: 'production', stage: null, release: FB.release, previousRelease: null,
  migrations: FB.workers.filter((w) => w.migrationTag).map((w) => ({ worker: w.name, from: null, to: w.migrationTag })),
  schemas: FB.schemas, forwardOnly: false, forwardOnlyBecause: [],
  via: Object.fromEntries(FB.workers.map((w) => [w.name, 'deploy'])),
  secrets: [{ worker: 'viz-control', name: KEY, action: 'created', versionId: state.workers['viz-control'].deployment[0].version_id }],
  workers: FB.workers.map((w) => ({ name: w.name, versionId: state.workers[w.name].deployment[0].version_id, versions: state.workers[w.name].deployment, migrationTag: w.migrationTag, release: FB.release })),
})

/** deploy.sh's own FORWARD_ONLY expression, run on a record: non-empty means it does not roll back automatically. */
function deployShForwardOnly(recordFile) {
  const sh = readFileSync(join(DEPLOY_DIR, 'deploy.sh'), 'utf8')
  const js = /FORWARD_ONLY=\$\(node -e '([^']+)'/.exec(sh)[1]
  return execFileSync(process.execPath, ['-e', js, recordFile], { encoding: 'utf8' }).trim()
}

const ACK = '' // no Durable Object migration between fb77292 and this tree (the test checks it)
/** No stage has been deployed, so none is recorded: the first release with the web app goes out by the owner's override (review of D74, M-2). */
const NO_EVIDENCE = join(tmp, 'no-app-stage-evidence.json')
const FIRST = { appStageEvidence: NO_EVIDENCE, appStageOverride: 'test: the owner accepts the first contact with Cloudflare in production' }
/** VIZ_TEST_SHOW=1 prints what each step logged (deploy/README.md quotes it). */
const show = (label, r) => process.env.VIZ_TEST_SHOW && process.stderr.write(`\n===== ${label}\n${r.log}\n`)

test('the first release over the 2026-11-19 production (fb77292): ids allocated clear of other scripts, gate passed, forward-only, key kept, OAUTH_PUBLIC raises the floor; the way back refused; the next release is ordinary', async () => {
  // The id viz would take first in an empty account, so that the scripts that are not viz's sit on it.
  const wanted = wantedRateLimits(undefined)
  const natural = allocateRateLimitIds({ wanted, range: JSON.parse(readFileSync(join(DEPLOY_DIR, 'workers.json'), 'utf8')).resources.ratelimit_ids, inUse: { used: new Map(), byScript: new Map() } }).ids
  const first = Object.values(natural)
  writeState(fb77292Production([first[0], first[1]]))
  const fb = fb77292Record(readState())

  // 1. resources.mjs: six ids, none an unrelated script's or the spike's; only read calls.
  const ids = await captured(() => ensureRateLimitIds(undefined, cfApi))
  show('resources.mjs ensure', ids)
  assert.equal(ids.error, undefined, `${ids.error?.stack}\n${ids.log}`)
  const got = ids.result.ids
  assert.deepEqual(Object.keys(got).sort(), wanted.map((w) => w.key).sort())
  assert.equal(new Set(Object.values(got)).size, 6)
  for (const id of Object.values(got)) assert.ok(!first.slice(0, 2).includes(id) && id !== '1001' && Number(id) >= 7000 && Number(id) <= 7999, id)
  assert.equal(readState().calls.length, 0, 'no wrangler call: the account was only read')
  assert.deepEqual(JSON.parse(readFileSync(process.env.VIZ_RESOURCES_FILE, 'utf8')).ratelimit_namespaces, got)

  // 2. configure.mjs, production, the real component configs: the gate passes, OAUTH_PUBLIC on, stamped.
  appBuilt({ release: 'rel-a' }) // the web app's build, staged as deploy/app.mjs stages it (D74; the fixture build)
  const m = configure({ release: 'rel-a', quiet: true })
  assert.equal(m.idsOptional, false)
  const control = m.workers.find((w) => w.name === 'viz-control')
  assert.deepEqual(control.oauth.ratelimits, Object.fromEntries(Object.entries(got).map(([k, v]) => [k.split('/')[1], v])))
  assert.equal(control.oauth.public, true)
  assert.ok(control.floors.includes('oauth-public'))
  // No Durable Object migration since fb77292: nothing to acknowledge.
  for (const w of FB.workers) assert.equal(m.workers.find((x) => x.name === w.name).migrationTag, w.migrationTag, w.name)

  // 3a. It is also the first production release with the web app (fb77292's gateway serves none), in a
  // release that is forward-only: refused, by that one problem, until a stage is recorded to have gone
  // before it or the owner overrides with a reason (review of D74, M-2). Nothing is uploaded.
  const bare = await captured(() => planOnly({ stage: undefined, ackText: ACK, appStageEvidence: NO_EVIDENCE }))
  assert.equal(bare.result?.exit, 3, bare.log)
  assert.equal(bare.result.problems.length, 1, bare.result.problems.join('\n'))
  assert.match(bare.result.problems[0], /viz-gateway: this is the first production release that carries the web app \(the viz-gateway serving now has none\), and no stage is recorded to have gone before it/)
  const bareDeploy = await captured(() => deploy({ stage: undefined, ackText: ACK, appStageEvidence: NO_EVIDENCE }))
  assert.equal(bareDeploy.result?.exit, 3, bareDeploy.log)
  assert.equal(readState().calls.length, 0, 'refused before anything is uploaded')

  // 3. plan: not refused; forward-only by format and by the oauth-public floor; the key kept.
  const plan = await captured(() => planOnly({ stage: undefined, ackText: ACK, ...FIRST }))
  show('release.mjs plan', plan)
  assert.equal(plan.error, undefined, `${plan.error?.stack}\n${plan.log}`)
  assert.equal(plan.result.exit, 0, plan.log)
  assert.deepEqual(plan.result.plan.migrations, [])
  assert.deepEqual(plan.result.secrets, [{ worker: 'viz-control', name: KEY, action: 'keep' }])
  // Forward-only by the oauth-public floor only: fb77292's Workers read every format version this release
  // writes (deploy/records/fb77292….formats.json, from its own sources; r2.dead-letters 2 is read by its ingest).
  assert.deepEqual(plan.result.forwardOnly.map((f) => [f.worker, f.kind, f.format ?? f.rule]), [['viz-control', 'floor', 'oauth-public']])
  assert.equal(readState().calls.length, 0, 'plan changes nothing')

  // 4. deploy: every Worker uploaded, then promoted; the record says why it is forward-only.
  const r = await captured(() => deploy({ stage: undefined, ackText: ACK, ...FIRST }))
  show('release.mjs deploy', r)
  assert.deepEqual(r.result?.record?.appStage?.override, FIRST.appStageOverride, 'the record carries the override and its reason')
  assert.equal(r.error, undefined, `${r.error?.stack}\n${r.log}`)
  assert.equal(r.result.exit, 0, r.log)
  const rec = r.result.record
  assert.deepEqual(Object.values(rec.via), FB.workers.map(() => 'versions'))
  assert.equal(rec.forwardOnly, true)
  assert.deepEqual(rec.forwardOnlyBecause.map((f) => [f.worker, f.kind]), [['viz-control', 'floor']])
  assert.deepEqual(rec.secrets.map((x) => [x.worker, x.name, x.action]), [['viz-control', KEY, 'kept']])
  assert.deepEqual(rec.oauth, [{ worker: 'viz-control', ratelimits: control.oauth.ratelimits, withoutRateLimits: false, public: true }])
  assert.deepEqual(rec.floors.find((f) => f.name === 'oauth-public'), { name: 'oauth-public', writer: 'viz-control', var: 'OAUTH_PUBLIC', value: '1', on: true, workers: [{ worker: 'viz-control', atFloor: true, servingAtFloor: false }] })
  assert.equal(rec.floors.find((f) => f.name === 'signal-data').on, false)
  const s = readState()
  assert.equal(callsLike(s, 'versions secret').length, 0, 'no put: the key is kept')
  const ctl = serving(s, 'viz-control')
  assert.equal(ctl.secrets[KEY], OLD_KEY, 'the same key: every registered client stays registered')
  assert.equal(ctl.vars.OAUTH_PUBLIC, '1')
  assert.deepEqual(ctl.ratelimits.map((x) => x.namespace_id), Object.values(control.oauth.ratelimits))
  for (const w of FB.workers) assert.equal(serving(s, w.name).vars.VIZ_RELEASE, 'rel-a', w.name)
  const recordFile = join(process.env.VIZ_GENERATED_DIR, 'production', 'release.json')
  // deploy.sh would not roll it back after a failed smoke test.
  assert.equal(deployShForwardOnly(recordFile), 'viz-control below the oauth-public floor before it')

  // 5. The way back to fb77292, whole, is refused before anything moves: by viz-control's floor, and by nothing else.
  for (const target of [r.result.previous, fb]) {
    const back = await captured(() => rollback({ stage: undefined, record: target, reason: 'test' }))
    show(`rollback to ${target.kind} ${target.release}`, back)
    assert.equal(back.result?.exit, 3, back.log)
    assert.equal(back.result.problems.length, 1, back.log)
    assert.match(back.result.problems[0], /^viz-control: this rollback would restore version \S+ \(release \S+\), below its floor .* viz-control version \S+ \(release rel-a\) set OAUTH_PUBLIC=1/)
  }
  assert.deepEqual(callsLike(readState(), 'versions deploy').filter((c) => c.argv.includes('--name')), [], 'nothing restored')

  // 6. The next release: the same ids (kept, bound by viz-control), not forward-only, exit 0.
  const again = await captured(() => ensureRateLimitIds(undefined, cfApi))
  assert.deepEqual(again.result.ids, got)
  assert.ok(again.result.notes.every((x) => / kept \(bound by viz-control\)/.test(x)), again.result.notes.join('\n'))
  appBuilt({ release: 'rel-b' }) // the web app's build, staged as deploy/app.mjs stages it (D74; the fixture build)
  configure({ release: 'rel-b', quiet: true })
  // The app serves now: no stage is asked for, and no override is given.
  const next = await captured(() => deploy({ stage: undefined, ackText: ACK, appStageEvidence: NO_EVIDENCE }))
  show('next release', next)
  assert.equal(next.result?.record?.appStage, null)
  assert.equal(next.result?.exit, 0, next.log)
  assert.equal(next.result.record.forwardOnly, false, next.log)
  assert.deepEqual(next.result.record.floors.find((f) => f.name === 'oauth-public').workers, [{ worker: 'viz-control', atFloor: true, servingAtFloor: true }])
  assert.equal(serving(readState(), 'viz-control').secrets[KEY], OLD_KEY)
  // ... and a rollback from it to the first release (both at the floor) is allowed.
  const toA = await captured(() => rollback({ stage: undefined, record: rec, reason: 'test' }))
  assert.equal(toA.result?.exit, 0, toA.log)
  assert.equal(serving(readState(), 'viz-control').vars.VIZ_RELEASE, 'rel-a')
  void cmd
})

/** Production as fb77292 left it, then the first release of this tree over it: { fb (its record), r (the deploy) }. */
async function firstRelease() {
  const wanted = wantedRateLimits(undefined)
  const natural = Object.values(allocateRateLimitIds({ wanted, range: JSON.parse(readFileSync(join(DEPLOY_DIR, 'workers.json'), 'utf8')).resources.ratelimit_ids, inUse: { used: new Map(), byScript: new Map() } }).ids)
  writeState(fb77292Production([natural[0], natural[1]]))
  writeFileSync(process.env.VIZ_RESOURCES_FILE, JSON.stringify({ kv_namespaces: { 'viz-config': 'c'.repeat(32) }, ratelimit_namespaces: {} }))
  const fb = fb77292Record(readState())
  await ensureRateLimitIds(undefined, cfApi)
  appBuilt({ release: 'rel-a' }) // the web app's build, staged as deploy/app.mjs stages it (D74; the fixture build)
  configure({ release: 'rel-a', quiet: true })
  const r = await captured(() => deploy({ stage: undefined, ackText: ACK, ...FIRST }))
  assert.equal(r.result?.exit, 0, r.log)
  return { fb, r }
}

// The review of D69, round 2, RV2-1 (design/reviews/d69-deploy-safety-r2.md, M2-1): it showed every one of
// these refused by r2.dead-letters, which fb77292 itself writes at 2 and reads at 1 and 2. With fb77292's
// formats from its own sources (deploy/records/), only viz-control stays refused: by its oauth-public floor.
test('RV2-1, fixed: after the first release, each Worker but viz-control can go back to fb77292 alone (--only), to its record and to previous.json; viz-control stays refused by its floor', async () => {
  const open = ['viz-query', 'viz-gateway', 'viz-mcp', 'viz-ruler', 'viz-ingest', 'viz-publisher']
  for (const [i, only] of open.entries()) {
    const { fb, r } = await firstRelease()
    for (const target of i === 0 ? [fb, r.result.previous] : [i % 2 ? fb : r.result.previous]) {
      const back = await captured(() => rollback({ stage: undefined, record: target, only, reason: 'rv2-1' }))
      show(`--only ${only} to ${target.kind}`, back)
      assert.equal(back.result?.exit, 0, `${only} to ${target.kind}: ${back.log}`)
      assert.equal(serving(readState(), only).vars.VIZ_RELEASE, FB.release, only)
    }
    for (const other of ['viz-control', ...open.filter((n) => n !== only)]) assert.equal(serving(readState(), other).vars.VIZ_RELEASE, 'rel-a', `${other} is left as it serves`)
  }
  const { fb, r } = await firstRelease()
  for (const target of [fb, r.result.previous]) {
    const back = await captured(() => rollback({ stage: undefined, record: target, only: 'viz-control', reason: 'rv2-1' }))
    assert.equal(back.result?.exit, 3, back.log)
    assert.deepEqual(back.result.problems.map((p) => p.split(':')[0]), ['viz-control'])
    assert.match(back.result.problems[0], /below its floor .* set OAUTH_PUBLIC=1/)
  }
  assert.equal(serving(readState(), 'viz-control').vars.VIZ_RELEASE, 'rel-a')
})
