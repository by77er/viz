// node --test deploy/test/: D70's gate and the oauth-public rollback floor, through the real release.mjs
// deploy, plan and rollback against the fake account (test/fake-account.mjs, test/fake-wrangler.mjs):
// - OAUTH_CLIENT_KEY is not created or rotated on a viz-control whose generated config lacks its rate
//   limits (lib/secrets.mjs keyGateProblems), refused before anything is uploaded; a stage only with
//   --oauth-without-rate-limits, which the record says; a manifest with placeholder ids is not deployed;
// - OAUTH_PUBLIC raises viz-control's floor (rule oauth-public, D69 point 6): over a serving viz-control
//   below it the release is forward-only, not refused; once a kept version had it, a rollback or a
//   release below the floor is refused.
// Releases are built as configure.mjs writes them (test/fake-account.mjs oauthGated). Production names
// are safe here: generated/ is this test's own directory.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, beforeEach, test } from 'node:test'

const tmp = mkdtempSync(join(tmpdir(), 'viz-oauth-gate-'))
process.env.VIZ_GENERATED_DIR = join(tmp, 'generated')
const { GENERATED_DIR, REPO_ROOT } = await import('../lib/common.mjs')
const { callsLike, captured, cmd, installFakeAccount, oauthGated, serving } = await import('./fake-account.mjs')
const { deploy, planOnly, rollback } = await import('../release.mjs')
const { SecretRefused, ensureSecrets, keyGateProblems } = await import('../lib/secrets.mjs')

const account = installFakeAccount(tmp)
const { writeState, readState } = account
const KEY = 'OAUTH_CLIENT_KEY'
const OLD = `a-key-that-must-survive-${'x'.repeat(24)}`
after(() => {
  account.restore()
  rmSync(tmp, { recursive: true, force: true })
})
beforeEach(() => writeState({ calls: [], counter: 100, workers: {} }))

const DECLARED = { VIZ_SCHEMAS: JSON.stringify({ v: 1, classes: { 'control.Tenant': { latest: 1, compat: 1, by: null } } }), VIZ_FORMATS: JSON.stringify({ v: 1, complete: true, formats: {} }) }

/**
 * One release of viz-control and the gateway, for production (`stage` null) or a stage. `gated`: what
 * configure.mjs writes for viz-control (oauthGated's options), or `false` for a config without the gate
 * (no ratelimits, no oauth record, unstamped: as fb77292's configure wrote it). `manifest`: extra fields.
 */
function release(name, { stage = 'gatetest', gated = {}, manifest: extra = {} } = {}) {
  const N = (w) => (stage ? `viz-${stage}-${w}` : `viz-${w}`)
  const dir = join(tmp, `${stage ?? 'production'}-${name}`)
  mkdirSync(dir, { recursive: true })
  const g = gated === false ? null : oauthGated(gated)
  const ctl = join(dir, 'control.jsonc')
  writeFileSync(ctl, JSON.stringify({ name: N('control'), ...(g?.config.ratelimits ? { ratelimits: g.config.ratelimits } : {}), vars: { VIZ_RELEASE: name, ...DECLARED, ...(g?.config.vars ?? {}) }, migrations: [{ tag: 'v1' }] }))
  const gw = join(dir, 'gateway.jsonc')
  writeFileSync(gw, JSON.stringify({ name: N('gateway'), vars: { VIZ_RELEASE: name, VIZ_FORMATS: DECLARED.VIZ_FORMATS } }))
  const target = stage ? `stage-${stage}` : 'production'
  const workers = [
    { name: N('control'), canonical: 'viz-control', component: 'control', config: relative(REPO_ROOT, ctl), deploy: true, migrationTags: ['v1'], migrationTag: 'v1', schemas: [{ component: 'control.Tenant', latest: 1, compat: 1, migrations: [{ version: 1, readableFrom: 1, name: 't1' }] }], formats: [], floors: [], ...(g?.manifest ?? {}) },
    { name: N('gateway'), canonical: 'viz-gateway', component: 'deploy/gateway', config: relative(REPO_ROOT, gw), deploy: true, public: true, migrationTags: [], migrationTag: null, schemas: [], formats: [], floors: [] },
  ]
  const m = { target, stage: stage ?? null, release: name, durableObjectsCodeUpdate: 'deferred 30s', order: workers.map((w) => w.name), releaseFrom: N('control'), workers, ...extra }
  mkdirSync(join(GENERATED_DIR, target), { recursive: true })
  writeFileSync(join(GENERATED_DIR, target, 'manifest.json'), JSON.stringify(m))
  return { control: N('control'), gateway: N('gateway'), stage: stage ?? undefined }
}
const ship = async (name, opts = {}, args = {}) => {
  const r = release(name, opts)
  const out = await captured(() => deploy({ stage: r.stage, ackText: `viz-control@v1`, ...args }))
  return { ...out, ...r, exit: out.result?.exit, record: out.result?.record }
}
const shipped = async (name, opts, args) => {
  const r = await ship(name, opts, args)
  assert.equal(r.error, undefined, `${name}: ${r.error?.stack}\n${r.log}`)
  assert.equal(r.exit, 0, `${name}: ${r.log}`)
  return r
}
/** An account where viz-control and the gateway serve; viz-control with the key or without, unstamped (fb77292's). */
function serves({ stage = 'gatetest', key = true } = {}) {
  const N = (w) => (stage ? `viz-${stage}-${w}` : `viz-${w}`)
  const v = (id, secrets, vars = {}) => ({ id, number: 1, tag: 'old', vars: { VIZ_RELEASE: 'old', ...vars }, secrets })
  writeState({
    calls: [], counter: 100,
    workers: {
      [N('control')]: { migrationTag: 'v1', versions: [v('00000000-0000-4000-8000-00000000000a', key ? { [KEY]: OLD } : {}, DECLARED)], deployment: [{ version_id: '00000000-0000-4000-8000-00000000000a', percentage: 100 }] },
      [N('gateway')]: { migrationTag: null, versions: [v('00000000-0000-4000-8000-00000000000b', {})], deployment: [{ version_id: '00000000-0000-4000-8000-00000000000b', percentage: 100 }] },
    },
  })
}
const uploads = () => callsLike(readState(), 'versions upload').length + callsLike(readState(), 'deploy --config').length

// ───────────────────────── the gate on the key ─────────────────────────

test('gate: production viz-control without its rate limits gets no key: refused (exit 3) before anything is uploaded, naming the missing bindings; one missing binding, named', async () => {
  serves({ stage: null, key: false })
  const r = await ship('p1', { stage: null, gated: { drop: ['OAUTH_RL_CREDENTIAL'] } })
  assert.equal(r.exit, 3, r.log)
  assert.match(r.log, /viz-control: its generated config lacks the rate-limit binding OAUTH_RL_CREDENTIAL \(each with period 60, a positive limit and an allocated namespace_id\), so OAUTH_CLIENT_KEY is not put on it/)
  assert.equal(uploads(), 0, 'nothing uploaded')
  const all = await ship('p2', { stage: null, gated: { without: true } })
  assert.equal(all.exit, 3, all.log)
  assert.match(all.log, /lacks the rate-limit bindings OAUTH_RL_SOURCE, OAUTH_RL_SOURCE_48, OAUTH_RL_CREDENTIAL, OAUTH_RL_TENANT, OAUTH_RL_BEARER, OAUTH_RL_BEARER_TENANT/)
  // A manifest from another configure (no oauth record): refused too, never guessed.
  const bare = await ship('p3', { stage: null, gated: false })
  assert.equal(bare.exit, 3, bare.log)
  assert.match(bare.log, /the manifest does not say which rate-limit bindings it needs/)
  // A rotation is a put too.
  serves({ stage: null, key: true })
  const rot = await ship('p4', { stage: null, gated: { drop: ['OAUTH_RL_TENANT'] } }, { rotateText: KEY })
  assert.equal(rot.exit, 3, rot.log)
  assert.match(rot.log, /lacks the rate-limit binding OAUTH_RL_TENANT/)
  assert.equal(serving(readState(), 'viz-control').secrets[KEY], OLD)
  // plan says the same, and changes nothing.
  release('p5', { stage: null, gated: { drop: ['OAUTH_RL_BEARER'] } })
  serves({ stage: null, key: false })
  const plan = await captured(() => planOnly({ stage: undefined, ackText: 'viz-control@v1' }))
  assert.equal(plan.result.exit, 3, plan.log)
  assert.match(plan.result.problems.join('\n'), /lacks the rate-limit binding OAUTH_RL_BEARER/)
})

test('gate: production with all six and allocated ids gets its key; a key already there is kept without the gate being asked (nothing is put)', async () => {
  serves({ stage: null, key: false })
  const r = await shipped('p6', { stage: null, gated: { public: true } })
  assert.deepEqual(r.record.secrets.map((x) => [x.name, x.action]), [[KEY, 'created']])
  assert.deepEqual(r.record.oauth, [{ worker: 'viz-control', ratelimits: Object.fromEntries(oauthGated().config.ratelimits.map((x) => [x.name, x.namespace_id])), withoutRateLimits: false, public: true }])
  assert.equal(r.record.oauthWithoutRateLimits, false)
  assert.equal(serving(readState(), 'viz-control').ratelimits.length, 6)
})

test('gate: a stage without them is refused unless configured --oauth-without-rate-limits, and then its record says so; production ignores the flag', async () => {
  serves({ key: false })
  const no = await ship('s1', { gated: { without: true } })
  assert.equal(no.exit, 3, no.log)
  assert.match(no.log, /or a stage with --oauth-without-rate-limits/)
  // The worker says so but the manifest does not (or the reverse): refused.
  const half = await ship('s2', { gated: { without: true }, manifest: { oauthWithoutRateLimits: false } })
  assert.equal(half.exit, 3, half.log)
  const ok = await shipped('s3', { gated: { without: true }, manifest: { oauthWithoutRateLimits: true } })
  assert.equal(ok.record.oauthWithoutRateLimits, true)
  assert.deepEqual(ok.record.oauth.map((o) => [o.worker, o.withoutRateLimits]), [['viz-gatetest-control', true]])
  assert.deepEqual(ok.record.secrets.map((x) => x.action), ['created'])
  serves({ stage: null, key: false })
  const prod = await ship('p7', { stage: null, gated: { without: true }, manifest: { oauthWithoutRateLimits: true } })
  assert.equal(prod.exit, 3, prod.log)
})

test('gate: a manifest configured with --ids-optional is not deployed (placeholder ids), refused before anything is uploaded', async () => {
  serves({ stage: null, key: true })
  const r = await ship('p8', { stage: null, gated: {}, manifest: { idsOptional: true } })
  assert.equal(r.exit, 3, r.log)
  assert.match(r.log, /configured with --ids-optional: its KV and Rate Limiting namespace ids are placeholders, so it is not deployed/)
  assert.equal(uploads(), 0)
})

test('gate at the put itself: ensureSecrets refuses before any wrangler call when the gate has a problem for the key', async () => {
  const calls = []
  const api = { versionInfo: async () => ({ id: 'v', resources: { bindings: [] } }), listVersions: async () => [{ id: 'v' }], wrangler: async (...a) => void calls.push(a) }
  const gate = keyGateProblems({ stage: null, order: ['viz-control'], workers: [{ name: 'viz-control', canonical: 'viz-control', oauth: oauthGated().manifest.oauth }] }, () => ({ ratelimits: [] }))
  assert.equal(gate.length, 1)
  await assert.rejects(
    ensureSecrets({ worker: 'viz-control', versionId: 'v', specs: [{ worker: 'viz-control', name: KEY, bytes: 32, gate: 'oauth' }], now: [{ worker: 'viz-control', name: KEY, known: false }], rotate: new Set(), release: 'r', run: 'run', tag: 't', message: 'm', api, gate }),
    (e) => e instanceof SecretRefused && /lacks the rate-limit bindings OAUTH_RL_SOURCE/.test(e.message),
  )
  assert.deepEqual(calls, [])
  // keyGateProblems: two bindings with one id, and a period of 10, are problems; the good six are not.
  const good = oauthGated()
  const w = [{ name: 'viz-control', canonical: 'viz-control', oauth: good.manifest.oauth }]
  assert.deepEqual(keyGateProblems({ stage: null, order: ['viz-control'], workers: w }, () => good.config), [])
  const dup = good.config.ratelimits.map((r, i) => (i === 1 ? { ...r, namespace_id: '7000' } : r))
  assert.match(keyGateProblems({ stage: null, order: ['viz-control'], workers: w }, () => ({ ratelimits: dup }))[0].problem, /binds namespace_id 7000 twice/)
  const ten = good.config.ratelimits.map((r, i) => (i === 0 ? { ...r, simple: { ...r.simple, period: 10 } } : r))
  assert.match(keyGateProblems({ stage: null, order: ['viz-control'], workers: w }, () => ({ ratelimits: ten }))[0].problem, /lacks the rate-limit binding OAUTH_RL_SOURCE /)
  const zero = good.config.ratelimits.map((r, i) => (i === 0 ? { ...r, namespace_id: '0' } : r))
  assert.match(keyGateProblems({ stage: null, order: ['viz-control'], workers: w }, () => ({ ratelimits: zero }))[0].problem, /lacks the rate-limit binding OAUTH_RL_SOURCE /)
})

// ───────────────────────── the oauth-public floor (D69 point 6) ─────────────────────────

test('oauth-public: a release setting OAUTH_PUBLIC over an unstamped serving viz-control goes out FORWARD-ONLY for it (not refused); its automatic rollback target is refused', async () => {
  serves({ key: true })
  const r = await shipped('f1', { gated: { public: true } })
  assert.equal(r.record.forwardOnly, true)
  assert.deepEqual(r.record.forwardOnlyBecause.map((f) => [f.worker, f.kind, f.rule]), [['viz-gatetest-control', 'floor', 'oauth-public']])
  assert.match(r.log, /FORWARD-ONLY: oauth-public: this release sets OAUTH_PUBLIC=1, and the viz-gatetest-control serving now is below its floor/)
  assert.deepEqual(r.record.floors.find((f) => f.name === 'oauth-public').workers, [{ worker: 'viz-gatetest-control', atFloor: true, servingAtFloor: false }])
  const back = await captured(() => rollback({ stage: 'gatetest', record: r.result.previous, reason: 'test' }))
  assert.equal(back.result?.exit, 3, back.log)
  assert.match(back.log, /viz-gatetest-control: this rollback would restore version 00000000-0000-4000-8000-00000000000a \(release old\), below its floor .* set OAUTH_PUBLIC=1/)
  assert.equal(serving(readState(), 'viz-gatetest-control').vars.VIZ_RELEASE, 'f1')
})

test('oauth-public: over a stamped serving viz-control it is an ordinary release; a rollback to a stamped release is allowed', async () => {
  serves({ key: true })
  const a = await shipped('f2', { gated: {} }) // stamped, switch off (a stage not asked)
  assert.equal(a.record.forwardOnly, false)
  const b = await shipped('f3', { gated: { public: true } })
  assert.equal(b.record.forwardOnly, false, b.log)
  assert.deepEqual(b.record.floors.find((f) => f.name === 'oauth-public').workers, [{ worker: 'viz-gatetest-control', atFloor: true, servingAtFloor: true }])
  const back = await captured(() => rollback({ stage: 'gatetest', record: a.record, reason: 'test' }))
  assert.equal(back.result?.exit, 0, back.log)
})

test('oauth-public: once a kept viz-control version had OAUTH_PUBLIC, an unstamped viz-control is refused, as a release (switch off) or a rollback; while it never had, nothing is', async () => {
  serves({ key: true })
  const old = await shipped('f4', { gated: false })
  // f4 has no oauth record: the key is kept (no put), so the gate is not asked; it is unstamped.
  assert.equal(old.record.forwardOnly, false)
  await shipped('f5', { gated: { public: true } })
  const below = await ship('f6', { gated: false })
  assert.equal(below.exit, 3, below.log)
  assert.match(below.log, /viz-gatetest-control: this release is below its floor .* viz-gatetest-control version \S+ \(release f5\) set OAUTH_PUBLIC=1/)
  const back = await captured(() => rollback({ stage: 'gatetest', record: old.record, reason: 'test' }))
  assert.equal(back.result?.exit, 3, back.log)
  assert.match(back.log, /below its floor/)
  void cmd
})

test('oauth-public: the signal-data rule keeps D69\'s refusal (serving_below_floor defaults to refuse)', async () => {
  const { floorRules, floorForwardOnly, deployFloorProblems } = await import('../lib/floors.mjs')
  const plan = JSON.parse((await import('node:fs')).readFileSync(new URL('../workers.json', import.meta.url), 'utf8'))
  const [signals, oauth] = floorRules(plan, undefined)
  assert.deepEqual([signals.servingBelow, oauth.servingBelow], ['refuse', 'forward-only'])
  const below = (rule) => ({ value: 'x', workers: rule.floors.map((f) => ({ floor: f, now: { schemas: { 'publisher.Publisher': { latest: 9 } }, floors: [rule.name] }, serving: { schemas: null, floors: null } })) })
  assert.equal(deployFloorProblems(signals, below(signals)).length, 3)
  assert.deepEqual(floorForwardOnly(signals, below(signals)), [])
  assert.deepEqual(deployFloorProblems(oauth, below(oauth)), [])
  assert.deepEqual(floorForwardOnly(oauth, below(oauth)).map((f) => [f.worker, f.kind]), [['viz-control', 'floor']])
  // Not deployed in this release (now null): judged as it serves, refused, as for any rule.
  assert.equal(deployFloorProblems(oauth, { value: '1', workers: [{ floor: oauth.floors[0], now: null, serving: { floors: null } }] }).length, 1)
  // Switch off: nothing forward-only.
  assert.deepEqual(floorForwardOnly(oauth, { ...below(oauth), value: null }), [])
})
