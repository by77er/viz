// node --test deploy/test/: the secrets the deploy generates (lib/secrets.mjs, D53), through the real
// release.mjs deploy and plan, against a fake wrangler run as a child process (test/fake-wrangler.mjs)
// and a fake Cloudflare API (test/fake-account.mjs). Nothing here reaches Cloudflare: the token is a
// dummy and any request the fake does not know is answered 400.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { GENERATED_DIR, REPO_ROOT } from '../lib/common.mjs'
import { GENERATED_SECRETS, generateSecretValue, secretNamesOf } from '../lib/secrets.mjs'
import { deploy, newRunId, planOnly, rollback } from '../release.mjs'
import { callsLike, captured, cmd, installFakeAccount, oauthGated, promotions, serving } from './fake-account.mjs'

const STAGE = 'oauthkeytest'
const CONTROL = `viz-${STAGE}-control`
const GATEWAY = `viz-${STAGE}-gateway`
const KEY = 'OAUTH_CLIENT_KEY'
const OLD = `an-old-key-that-must-survive-${'x'.repeat(24)}`
const RELEASE = 'rel-2'

const tmp = mkdtempSync(join(tmpdir(), 'viz-secrets-test-'))
const stageDir = join(GENERATED_DIR, `stage-${STAGE}`)
const account = installFakeAccount(tmp)
const { writeState, readState } = account
const controlCfg = join(tmp, 'control.jsonc')
const gatewayCfg = join(tmp, 'gateway.jsonc')
/** What configure.mjs puts on every viz-control version, so that a rollback can judge it (D46, D69). */
const DECLARED = { VIZ_SCHEMAS: JSON.stringify({ v: 1, classes: { 'control.Tenant': { latest: 1, compat: 1, by: null } } }), VIZ_FORMATS: JSON.stringify({ v: 1, formats: {} }) }
// As configure.mjs writes a stage's viz-control that passed D70's gate: its six rate limits with ids, stamped at oauth-public (OAUTH_PUBLIC off: not asked).
const GATED = oauthGated()
writeFileSync(controlCfg, JSON.stringify({ name: CONTROL, ratelimits: GATED.config.ratelimits, vars: { VIZ_RELEASE: RELEASE, ...DECLARED, ...GATED.config.vars }, migrations: [{ tag: 'v1' }] }))
writeFileSync(gatewayCfg, JSON.stringify({ name: GATEWAY, vars: { VIZ_RELEASE: RELEASE } }))

const manifest = {
  target: `stage-${STAGE}`,
  stage: STAGE,
  release: RELEASE,
  durableObjectsCodeUpdate: 'deferred 30s',
  order: [CONTROL, GATEWAY],
  releaseFrom: CONTROL,
  workers: [
    { name: CONTROL, canonical: 'viz-control', component: 'control', config: relative(REPO_ROOT, controlCfg), deploy: true, migrationTags: ['v1'], migrationTag: 'v1', schemas: [], ...GATED.manifest },
    { name: GATEWAY, canonical: 'viz-gateway', component: 'deploy/gateway', config: relative(REPO_ROOT, gatewayCfg), deploy: true, public: true, migrationTags: [], migrationTag: null, schemas: [] },
  ],
}

/** An account where both Workers serve release rel-1; control with the key or without. */
function existing({ key }) {
  const v = (id, secrets, declared = {}) => ({ id, number: 1, tag: 'rel-1', vars: { VIZ_RELEASE: 'rel-1', ...declared }, secrets })
  return {
    calls: [],
    counter: 100,
    workers: {
      [CONTROL]: { migrationTag: 'v1', versions: [v('00000000-0000-4000-8000-00000000000a', key ? { [KEY]: OLD } : {}, DECLARED)], deployment: [{ version_id: '00000000-0000-4000-8000-00000000000a', percentage: 100 }] },
      [GATEWAY]: { migrationTag: null, versions: [v('00000000-0000-4000-8000-00000000000b', {})], deployment: [{ version_id: '00000000-0000-4000-8000-00000000000b', percentage: 100 }] },
    },
  }
}
beforeEach(() => {
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  writeFileSync(join(stageDir, 'manifest.json'), JSON.stringify(manifest))
})
after(() => {
  account.restore()
  rmSync(stageDir, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
})

const filesUnder = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(d.parentPath ?? d.path, d.name))

/** Asserts that `value` appears nowhere the deploy could have leaked it. */
function assertNotLeaked(value, state, log, extra = '') {
  assert.ok(value && value.length >= 32, 'a value to look for')
  for (const c of state.calls) assert.ok(!c.argv.some((a) => a.includes(value)), `on the command line of: ${cmd(c).replace(value, '<value>')}`)
  assert.ok(!state.calls.some((c) => c.envHasStdin), "in a wrangler process's environment")
  assert.ok(!log.includes(value), 'in the log')
  assert.ok(!extra.includes(value), 'in an error message')
  for (const f of filesUnder(stageDir)) assert.ok(!readFileSync(f, 'utf8').includes(value), `in ${f}`)
  assert.ok(!Object.values(process.env).some((v) => v?.includes(value)), "in this process's environment")
}

test('the generated value: 32 bytes from the CSPRNG, base64url, never twice the same; fewer bytes refused', () => {
  const a = generateSecretValue(32)
  const b = generateSecretValue(32)
  assert.match(a, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(a, b)
  assert.throws(() => generateSecretValue(16), /at least 32/)
  assert.deepEqual(GENERATED_SECRETS.map((s) => [s.worker, s.name, s.bytes >= 32]), [['viz-control', KEY, true]])
  assert.deepEqual(secretNamesOf({ resources: { bindings: [{ type: 'plain_text', name: 'A', text: 'x' }, { type: 'secret_text', name: KEY }] } }), [KEY])
})

test('absent: created on the version phase 1 uploaded, value on stdin only, and that keyed version is what phase 2 promotes', async () => {
  writeState(existing({ key: false }))
  const { result, error, log } = await captured(() => deploy({ stage: STAGE }))
  assert.equal(error, undefined, `${error?.stack}\n${log}`)
  assert.equal(result.exit, 0, log)
  const s = readState()
  const puts = callsLike(s, `versions secret put ${KEY} --name ${CONTROL}`)
  assert.equal(puts.length, 1, 'one versions secret put')
  const value = serving(s, CONTROL).secrets[KEY]
  assert.match(value, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(puts[0].stdinLength, value.length, 'the value arrived on stdin')
  // Put on this release's upload, before anything was promoted.
  const order = s.calls.map(cmd)
  const putAt = order.findIndex((c) => c.startsWith('versions secret put'))
  assert.ok(putAt > order.findIndex((c) => c.startsWith('versions upload') && c.includes('control.jsonc')))
  assert.ok(promotions(s).every((p) => order.indexOf(cmd(p)) > putAt), 'nothing promoted before the put')
  // What serves is this release's code and config plus the key; the record names that version.
  const keyed = serving(s, CONTROL)
  assert.equal(keyed.vars.VIZ_RELEASE, RELEASE)
  assert.equal(keyed.tag, RELEASE)
  const record = JSON.parse(readFileSync(join(stageDir, 'release.json'), 'utf8'))
  assert.equal(record.workers.find((w) => w.name === CONTROL).versionId, keyed.id)
  assert.deepEqual(record.secrets, [{ worker: CONTROL, name: KEY, action: 'created', versionId: keyed.id }])
  assert.doesNotMatch(log, /warning: .* serves/)
  assertNotLeaked(value, s, log)
})

test('present: left alone; no put, and the new version inherits the same value', async () => {
  writeState(existing({ key: true }))
  const { result, error, log } = await captured(() => deploy({ stage: STAGE }))
  assert.equal(error, undefined, `${error?.stack}\n${log}`)
  assert.equal(result.exit, 0, log)
  const s = readState()
  assert.equal(callsLike(s, 'versions secret').length, 0)
  assert.equal(serving(s, CONTROL).secrets[KEY], OLD)
  assert.equal(serving(s, CONTROL).vars.VIZ_RELEASE, RELEASE)
  assert.match(log, /secret OAUTH_CLIENT_KEY on viz-oauthkeytest-control: set .*kept/)
  assert.equal(result.record.secrets[0].action, 'kept')
  assertNotLeaked(OLD, s, log)
})

test('a failed put stops the release before anything is promoted, and the value is not in the error or the log', async () => {
  writeState({ ...existing({ key: false }), failOn: 'versions secret put' })
  const { error, log } = await captured(() => deploy({ stage: STAGE }))
  assert.ok(error, 'the deploy fails')
  assert.match(error.message, /versions secret put|putting OAUTH_CLIENT_KEY/)
  const s = readState()
  assert.deepEqual(promotions(s).map(cmd), [], 'nothing promoted')
  assert.equal(s.workers[CONTROL].deployment[0].version_id, '00000000-0000-4000-8000-00000000000a')
  assert.equal(s.workers[GATEWAY].deployment[0].version_id, '00000000-0000-4000-8000-00000000000b')
  // The fake echoed what it was given, as a careless tool might: none of it may surface.
  assertNotLeaked(s.rejectedStdin, s, log, `${error.message}\n${error.stack}`)
})

test('set now but missing from the upload: refused (exit 3) before promotion, nothing generated', async () => {
  writeState({ ...existing({ key: true }), inherit: 'none' })
  const { result, error, log } = await captured(() => deploy({ stage: STAGE }))
  assert.equal(error, undefined, `${error?.stack}\n${log}`)
  assert.equal(result.exit, 3)
  assert.match(log, /OAUTH_CLIENT_KEY is set \(.*serving version.*\), but version .* does not carry it/)
  assert.match(log, /VIZ_ROTATE_SECRETS=OAUTH_CLIENT_KEY/)
  const s = readState()
  assert.equal(callsLike(s, 'versions secret').length, 0)
  assert.deepEqual(promotions(s).map(cmd), [])
  assert.equal(serving(s, CONTROL).secrets[KEY], OLD)
})

test('the newest version is not this release upload: refused, nothing put on it, nothing promoted', async () => {
  writeState({ ...existing({ key: false }), afterUpload: 'foreign' })
  const { result, error, log } = await captured(() => deploy({ stage: STAGE }))
  assert.equal(error, undefined, `${error?.stack}\n${log}`)
  assert.equal(result.exit, 3)
  assert.match(log, /the newest version is .*, not .* which this release made/)
  const s = readState()
  assert.equal(callsLike(s, 'versions secret').length, 0)
  assert.deepEqual(promotions(s).map(cmd), [])
})

test('rotation only when asked: a new value replaces the old one; an unknown name is refused before anything', async () => {
  writeState(existing({ key: true }))
  const { result, error, log } = await captured(() => deploy({ stage: STAGE, rotateText: KEY }))
  assert.equal(error, undefined, `${error?.stack}\n${log}`)
  assert.equal(result.exit, 0, log)
  const s = readState()
  assert.equal(callsLike(s, 'versions secret put').length, 1)
  const value = serving(s, CONTROL).secrets[KEY]
  assert.notEqual(value, OLD)
  assert.match(value, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(result.record.secrets[0].action, 'rotated')
  assertNotLeaked(value, s, log)

  writeState(existing({ key: true }))
  const unknown = await captured(() => deploy({ stage: STAGE, rotateText: 'SOMETHING_ELSE' }))
  assert.equal(unknown.result.exit, 3)
  assert.match(unknown.log, /SOMETHING_ELSE, which is not a secret this deploy generates/)
  assert.deepEqual(readState().calls, [], 'no wrangler call at all')
})

test('a first deploy: viz-control goes out with wrangler deploy, gets the key right after, and the keyed version serves before the gateway is promoted', async () => {
  writeState({ calls: [], counter: 100, workers: {} })
  const { result, error, log } = await captured(() => deploy({ stage: STAGE, ackText: 'viz-control@v1' }))
  assert.equal(error, undefined, `${error?.stack}\n${log}`)
  assert.equal(result.exit, 0, log)
  const s = readState()
  const order = s.calls.map(cmd).filter((c) => !c.includes('--dry-run'))
  const controlDeploy = order.findIndex((c) => c.startsWith('deploy --config') && c.includes('control.jsonc'))
  const put = order.findIndex((c) => c.startsWith(`versions secret put ${KEY} --name ${CONTROL}`))
  const keyed = serving(s, CONTROL)
  const promoteKeyed = order.findIndex((c) => c.startsWith(`versions deploy ${keyed.id}@100%`))
  const gateway = order.findIndex((c) => c.startsWith('deploy --config') && c.includes('gateway.jsonc'))
  assert.ok(controlDeploy >= 0 && controlDeploy < put && put < promoteKeyed && promoteKeyed < gateway, order.join('\n'))
  assert.match(keyed.secrets[KEY], /^[A-Za-z0-9_-]{43}$/)
  assert.equal(keyed.vars.VIZ_RELEASE, RELEASE)
  assert.equal(result.record.workers.find((w) => w.name === CONTROL).versionId, keyed.id)
  assert.equal(result.record.secrets[0].action, 'created')
  assertNotLeaked(keyed.secrets[KEY], s, log)
})

test('plan: says it would create the key, and creates nothing (no wrangler call)', async () => {
  writeState(existing({ key: false }))
  const absent = await captured(() => planOnly({ stage: STAGE }))
  assert.equal(absent.error, undefined, `${absent.error?.stack}\n${absent.log}`)
  assert.deepEqual(absent.result.secrets, [{ worker: CONTROL, name: KEY, action: 'create' }])
  assert.match(absent.log, /secret OAUTH_CLIENT_KEY on viz-oauthkeytest-control: not set; would be created on the version uploaded in phase 1, before anything is promoted/)
  assert.deepEqual(readState().calls, [])
  assert.deepEqual(Object.keys(serving(readState(), CONTROL).secrets), [])

  writeState(existing({ key: true }))
  const present = await captured(() => planOnly({ stage: STAGE }))
  assert.deepEqual(present.result.secrets, [{ worker: CONTROL, name: KEY, action: 'keep' }])
  assert.deepEqual(readState().calls, [])
})

// ---- review of D53 (design/reviews/d44-d52-d53-d60.md) ----

/** An account where a rollback restored control's version without the key, while the version that created it is still kept (newer). */
function rolledBack() {
  const s = existing({ key: false })
  s.workers[CONTROL].versions.push({ id: '00000000-0000-4000-8000-00000000000c', number: 2, tag: 'rel-k', vars: { VIZ_RELEASE: 'rel-k' }, secrets: { [KEY]: OLD } })
  return s
}

test('m-9: after a rollback across the key\'s creation, an upload that does not inherit it is refused (exit 3), not given a new key', async () => {
  writeState({ ...rolledBack(), inherit: 'none' })
  const { result, error, log } = await captured(() => deploy({ stage: STAGE }))
  assert.equal(error, undefined, `${error?.stack}\n${log}`)
  assert.equal(result.exit, 3, log)
  assert.match(log, /OAUTH_CLIENT_KEY is set \(version 00000000-0000-4000-8000-00000000000c \(number 2\), newer than the one serving: a rollback left it\), but version .* does not carry it/)
  const s = readState()
  assert.equal(callsLike(s, 'versions secret').length, 0, 'nothing generated')
  assert.deepEqual(promotions(s).map(cmd), [], 'nothing promoted')
  // plan says the same before anything: the key is known, so it is not "would be created".
  writeState({ ...rolledBack(), inherit: 'none' })
  const plan = await captured(() => planOnly({ stage: STAGE }))
  assert.deepEqual(plan.result.secrets, [{ worker: CONTROL, name: KEY, action: 'keep' }])
})

test('m-9: after the same rollback, an upload that inherits from the newest version keeps the key (no put)', async () => {
  writeState(rolledBack())
  const { result, error, log } = await captured(() => deploy({ stage: STAGE }))
  assert.equal(error, undefined, `${error?.stack}\n${log}`)
  assert.equal(result.exit, 0, log)
  assert.equal(result.record.secrets[0].action, 'kept')
  assert.equal(callsLike(readState(), 'versions secret').length, 0)
  assert.equal(serving(readState(), CONTROL).secrets[KEY], OLD)
})

test('m-10: a secret on stdin runs wrangler with WRANGLER_LOG_SANITIZE=true and WRANGLER_WRITE_LOGS=false, whatever the deploy\'s environment says', async () => {
  const saved = { a: process.env.WRANGLER_LOG, b: process.env.WRANGLER_LOG_SANITIZE, c: process.env.WRANGLER_WRITE_LOGS }
  process.env.WRANGLER_LOG = 'debug'
  process.env.WRANGLER_LOG_SANITIZE = 'false'
  process.env.WRANGLER_WRITE_LOGS = 'true'
  try {
    writeState(existing({ key: false }))
    const { result, error, log } = await captured(() => deploy({ stage: STAGE }))
    assert.equal(error, undefined, `${error?.stack}\n${log}`)
    assert.equal(result.exit, 0, log)
    const s = readState()
    const put = callsLike(s, `versions secret put ${KEY}`)
    assert.equal(put.length, 1)
    assert.equal(put[0].logEnv.WRANGLER_LOG_SANITIZE, 'true')
    assert.equal(put[0].logEnv.WRANGLER_WRITE_LOGS, 'false')
    // Only runs with something on stdin are changed: an upload keeps the deploy's own settings.
    const upload = callsLike(s, 'versions upload')[0]
    assert.equal(upload.logEnv.WRANGLER_LOG_SANITIZE, 'false')
    assert.equal(upload.logEnv.WRANGLER_WRITE_LOGS, 'true')
    assertNotLeaked(serving(s, CONTROL).secrets[KEY], s, log)
  } finally {
    for (const [k, v] of [['WRANGLER_LOG', saved.a], ['WRANGLER_LOG_SANITIZE', saved.b], ['WRANGLER_WRITE_LOGS', saved.c]]) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

// ---- review of D53, m-11: another run of the same release ----

test('m-11: another run of the same release uploads between the check and the put: the key is on its version, and nothing is promoted (exit 3)', async () => {
  writeState({ ...existing({ key: false }), racePut: true })
  const { result, error, log } = await captured(() => deploy({ stage: STAGE }))
  assert.equal(error, undefined, `${error?.stack}\n${log}`)
  const s = readState()
  // The put was applied to the other run's version (same release, its own VIZ_DEPLOY_RUN), as Cloudflare's "latest" would.
  const keyed = s.workers[CONTROL].versions.at(-1)
  assert.equal(keyed.vars.VIZ_RELEASE, RELEASE)
  assert.equal(keyed.vars.VIZ_DEPLOY_RUN, 'another-run-of-the-same-release')
  assert.ok(keyed.secrets[KEY], 'the put went on the other run’s version')
  // Before m-11 was fixed this run promoted that version (exit 0): the VIZ_RELEASE check cannot tell the two runs apart.
  assert.equal(result.exit, 3, log)
  assert.match(log, /OAUTH_CLIENT_KEY went on version .*, built on an upload of another run \(VIZ_DEPLOY_RUN another-run-of-the-same-release, this run is (gh\d+\.\d+-)?[0-9a-f-]{36}\)/)
  assert.deepEqual(promotions(s).map(cmd), [], 'nothing promoted')
  assert.equal(serving(s, CONTROL).id, '00000000-0000-4000-8000-00000000000a')
  assertNotLeaked(keyed.secrets[KEY], s, log)
})

test('m-11: every version a run uploads carries VIZ_DEPLOY_RUN; two runs carry different values, and the record names its run', async () => {
  const runs = []
  for (let i = 0; i < 2; i++) {
    writeState(existing({ key: i === 0 ? false : true }))
    const { result, error, log } = await captured(() => deploy({ stage: STAGE }))
    assert.equal(error, undefined, `${error?.stack}\n${log}`)
    assert.equal(result.exit, 0, log)
    const s = readState()
    const uploads = callsLike(s, 'versions upload')
    assert.equal(uploads.length, 2)
    for (const u of uploads) assert.deepEqual(u.argv.slice(-2), ['--var', `VIZ_DEPLOY_RUN:${result.record.run}`])
    assert.equal(serving(s, CONTROL).vars.VIZ_DEPLOY_RUN, result.record.run)
    assert.equal(serving(s, GATEWAY).vars.VIZ_DEPLOY_RUN, result.record.run)
    runs.push(result.record.run)
  }
  // On GitHub Actions the id also names the workflow run and its attempt (release.mjs newRunId); CI runs this test there.
  assert.match(runs[0], /^(gh\d+\.\d+-)?[0-9a-f-]{36}$/)
  assert.notEqual(runs[0], runs[1])
})

test('m-11: the run id is a UUID, prefixed on GitHub Actions with the workflow run and its attempt', () => {
  const saved = { id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT }
  const set = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v))
  try {
    set('GITHUB_RUN_ID', undefined)
    set('GITHUB_RUN_ATTEMPT', undefined)
    assert.match(newRunId(), /^[0-9a-f-]{36}$/)
    set('GITHUB_RUN_ID', '45882355070')
    assert.match(newRunId(), /^gh45882355070\.1-[0-9a-f-]{36}$/)
    set('GITHUB_RUN_ATTEMPT', '3')
    assert.match(newRunId(), /^gh45882355070\.3-[0-9a-f-]{36}$/)
    assert.notEqual(newRunId(), newRunId())
  } finally {
    set('GITHUB_RUN_ID', saved.id)
    set('GITHUB_RUN_ATTEMPT', saved.attempt)
  }
})

test('m-11: an upload that does not carry this run\'s VIZ_DEPLOY_RUN gets no put at all (refused before it, exit 3)', async () => {
  writeState({ ...existing({ key: false }), ignoreVar: true })
  const { result, error, log } = await captured(() => deploy({ stage: STAGE }))
  assert.equal(error, undefined, `${error?.stack}\n${log}`)
  assert.equal(result.exit, 3, log)
  assert.match(log, /carries VIZ_DEPLOY_RUN \(none\), not this run's/)
  const s = readState()
  assert.equal(callsLike(s, 'versions secret').length, 0, 'no put')
  assert.deepEqual(promotions(s).map(cmd), [])
})

// ---- measured on Cloudflare, 2026-11-19, spike S9 (spikes/s9-oauth-key-rollback/README.md) ----

test('S9: a version read right after it is created may not be there yet (a 404, or without the secret just put): the deploy reads it again, and goes on', async () => {
  for (const lag of [{ readLag: 2 }, { secretLag: 2 }]) {
    writeState({ ...existing({ key: false }), ...lag })
    const { result, error, log } = await captured(() => deploy({ stage: STAGE }))
    assert.equal(error, undefined, `${JSON.stringify(lag)}: ${error?.stack}\n${log}`)
    assert.equal(result.exit, 0, log)
    assert.equal(result.record.secrets[0].action, 'created')
    assert.equal(serving(readState(), CONTROL).id, result.record.secrets[0].versionId)
  }
})

test('S9: a version that does not show within the budget stops the release with nothing promoted', async () => {
  const saved = process.env.VIZ_FRESH_READ_MS
  process.env.VIZ_FRESH_READ_MS = '300'
  try {
    writeState({ ...existing({ key: false }), readLag: 50 })
    const { error, log } = await captured(() => deploy({ stage: STAGE }))
    assert.match(String(error?.message), /was not found \(after retrying for 300 ms\), so its secrets cannot be checked/, log)
    assert.deepEqual(promotions(readState()).map(cmd), [])
  } finally {
    if (saved === undefined) delete process.env.VIZ_FRESH_READ_MS
    else process.env.VIZ_FRESH_READ_MS = saved
  }
})

test('S9, created: a rollback across the release that created the key is refused up front (exit 3), nothing moved; accepted, it serves without the key, and the next deploy brings it back', async () => {
  writeState(existing({ key: false }))
  const r = await captured(() => deploy({ stage: STAGE }))
  assert.equal(r.result.exit, 0, r.log)
  const created = serving(readState(), CONTROL)
  const refused = await captured(() => rollback({ stage: STAGE, record: r.result.previous, reason: 'test' }))
  assert.equal(refused.error, undefined, `${refused.error?.stack}\n${refused.log}`)
  assert.equal(refused.result.exit, 3, refused.log)
  assert.match(refused.log, /restores version 00000000-0000-4000-8000-00000000000a, which does not carry OAUTH_CLIENT_KEY, .*crosses the release that created the key/)
  assert.match(refused.log, /--accept-secret-loss OAUTH_CLIENT_KEY/)
  assert.deepEqual(callsLike(readState(), 'versions deploy').filter((c) => c.argv.includes('--name')), [], 'no Worker moved')
  assert.equal(serving(readState(), CONTROL).id, created.id)
  // Accepted: Cloudflare allows it (S9), and the restored version has no key.
  const accepted = await captured(() => rollback({ stage: STAGE, record: r.result.previous, reason: 'test', acceptSecretLoss: KEY }))
  assert.equal(accepted.result?.exit, 0, accepted.log)
  assert.deepEqual(serving(readState(), CONTROL).secrets, {})
  // The next release inherits the newest version's key (S9): kept, the same value, no put.
  writeFileSync(join(stageDir, 'manifest.json'), JSON.stringify({ ...manifest, release: 'rel-3' }))
  const next = await captured(() => deploy({ stage: STAGE }))
  assert.equal(next.result.exit, 0, next.log)
  assert.equal(next.result.record.secrets[0].action, 'kept')
  assert.equal(serving(readState(), CONTROL).secrets[KEY], created.secrets[KEY])
})

test('S9, rotated: a rollback across a rotation is refused up front (exit 3), also when asked to accept the loss; a record that leaves viz-control out goes ahead', async () => {
  writeState(existing({ key: true }))
  const r = await captured(() => deploy({ stage: STAGE, rotateText: KEY }))
  assert.equal(r.result.exit, 0, r.log)
  const rotated = serving(readState(), CONTROL)
  for (const acceptSecretLoss of ['', KEY]) {
    const refused = await captured(() => rollback({ stage: STAGE, record: r.result.previous, reason: 'test', acceptSecretLoss }))
    assert.equal(refused.result?.exit, 3, `${refused.error?.stack ?? ''}\n${refused.log}`)
    assert.match(refused.log, /differs from the one put since on version .* "viz rel-2; OAUTH_CLIENT_KEY rotated"\): it crosses a rotation\. Cloudflare refuses that rollback \(10220/)
  }
  const s = readState()
  assert.deepEqual(callsLike(s, 'versions deploy').filter((c) => c.argv.includes('--name')), [], 'no Worker moved, the gateway neither')
  assert.equal(serving(s, CONTROL).id, rotated.id)
  const without = await captured(() => rollback({ stage: STAGE, record: { ...r.result.previous, workers: r.result.previous.workers.filter((w) => w.name !== CONTROL) }, reason: 'test' }))
  assert.equal(without.result?.exit, 0, without.log)
  assert.equal(serving(readState(), GATEWAY).id, '00000000-0000-4000-8000-00000000000b')
  assert.equal(serving(readState(), CONTROL).secrets[KEY], rotated.secrets[KEY])
})

test('S9: a failed promotion after viz-control got a rotated key leaves viz-control on it (Cloudflare would refuse its restore, 10220)', async () => {
  writeState({ ...existing({ key: true }), failOn: `triggers deploy --config ${gatewayCfg}` })
  const { error, log } = await captured(() => deploy({ stage: STAGE, rotateText: KEY }))
  assert.ok(error, 'the deploy fails')
  assert.match(error.message, /exited 1/)
  assert.match(log, new RegExp(`${CONTROL}: left on this release's version: its generated secret was rotated by it`))
  const s = readState()
  assert.notEqual(serving(s, CONTROL).secrets[KEY], OLD, 'viz-control keeps the rotated key')
  assert.deepEqual(callsLike(s, 'versions deploy').filter((c) => c.argv.includes('--name')), [], 'nothing restored')
})

test('a serving version that cannot be read stops the release: whether the key is set is unknown, so none is made', async () => {
  const s = { ...existing({ key: true }), inherit: 'none' }
  s.workers[CONTROL].versions[0].lag = 3 // read by liveState, by the oauth-public floor's look for a secret switch, then by the secret check: all 404
  writeState(s)
  const { error, log } = await captured(() => deploy({ stage: STAGE }))
  assert.match(String(error?.message), /serving version 00000000-0000-4000-8000-00000000000a could not be read, so whether OAUTH_CLIENT_KEY is set is unknown/, log)
  assert.equal(callsLike(readState(), 'versions').length, 0, 'nothing uploaded or put')
})
