// node --test deploy/test/: the secrets the deploy generates (lib/secrets.mjs, D53), through the real
// release.mjs deploy and plan, against a fake wrangler run as a child process (test/fake-wrangler.mjs)
// and a fake Cloudflare API (fetch stubbed here). Nothing here reaches Cloudflare: the token is a
// dummy and any request the fake does not know is answered 400.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { DEPLOY_DIR, GENERATED_DIR, REPO_ROOT } from '../lib/common.mjs'
import { GENERATED_SECRETS, generateSecretValue, secretNamesOf } from '../lib/secrets.mjs'
import { deploy, planOnly } from '../release.mjs'

const STAGE = 'oauthkeytest'
const CONTROL = `viz-${STAGE}-control`
const GATEWAY = `viz-${STAGE}-gateway`
const KEY = 'OAUTH_CLIENT_KEY'
const OLD = `an-old-key-that-must-survive-${'x'.repeat(24)}`
const RELEASE = 'rel-2'

const tmp = mkdtempSync(join(tmpdir(), 'viz-secrets-test-'))
const stageDir = join(GENERATED_DIR, `stage-${STAGE}`)
const statePath = join(tmp, 'state.json')
const bin = join(tmp, 'wrangler')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(DEPLOY_DIR, 'test', 'fake-wrangler.mjs')}" "$@"\n`)
chmodSync(bin, 0o755)
const controlCfg = join(tmp, 'control.jsonc')
const gatewayCfg = join(tmp, 'gateway.jsonc')
writeFileSync(controlCfg, JSON.stringify({ name: CONTROL, vars: { VIZ_RELEASE: RELEASE }, migrations: [{ tag: 'v1' }] }))
writeFileSync(gatewayCfg, JSON.stringify({ name: GATEWAY, vars: { VIZ_RELEASE: RELEASE } }))

const manifest = {
  target: `stage-${STAGE}`,
  stage: STAGE,
  release: RELEASE,
  durableObjectsCodeUpdate: 'deferred 30s',
  order: [CONTROL, GATEWAY],
  releaseFrom: CONTROL,
  workers: [
    { name: CONTROL, canonical: 'viz-control', component: 'control', config: relative(REPO_ROOT, controlCfg), deploy: true, migrationTags: ['v1'], migrationTag: 'v1', schemas: [] },
    { name: GATEWAY, canonical: 'viz-gateway', component: 'deploy/gateway', config: relative(REPO_ROOT, gatewayCfg), deploy: true, public: true, migrationTags: [], migrationTag: null, schemas: [] },
  ],
}

/** An account where both Workers serve release rel-1; control with the key or without. */
function existing({ key }) {
  const v = (id, secrets) => ({ id, number: 1, tag: 'rel-1', vars: { VIZ_RELEASE: 'rel-1' }, secrets })
  return {
    calls: [],
    counter: 100,
    workers: {
      [CONTROL]: { migrationTag: 'v1', versions: [v('00000000-0000-4000-8000-00000000000a', key ? { [KEY]: OLD } : {})], deployment: [{ version_id: '00000000-0000-4000-8000-00000000000a', percentage: 100 }] },
      [GATEWAY]: { migrationTag: null, versions: [v('00000000-0000-4000-8000-00000000000b', {})], deployment: [{ version_id: '00000000-0000-4000-8000-00000000000b', percentage: 100 }] },
    },
  }
}
const writeState = (s) => writeFileSync(statePath, JSON.stringify(s))
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'))

/** The Cloudflare API, as much of it as release.mjs reads, answered from the fake's state. */
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url)
  const method = init.method ?? 'GET'
  const state = readState()
  const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 })
  const notFound = () => new Response(JSON.stringify({ success: false, errors: [{ code: 10007, message: 'not found' }] }), { status: 404 })
  const path = u.pathname.replace(/^\/client\/v4\/accounts\/[^/]+/, '')
  const m = /^\/workers\/scripts(?:\/([^/]+)(?:\/(deployments|versions|secrets)(?:\/([^/]+))?)?)?$/.exec(path)
  if (u.hostname !== 'api.cloudflare.com' || method !== 'GET' || !m) return new Response(JSON.stringify({ success: false, errors: [{ code: 0, message: `fake API: no ${method} ${path}` }] }), { status: 400 })
  const [, name, sub, id] = m
  if (!name) return ok(Object.entries(state.workers).map(([n, w]) => ({ id: n, migration_tag: w.migrationTag ?? undefined })))
  const w = state.workers[decodeURIComponent(name)]
  if (!w) return notFound()
  const version = (vid) => w.versions.find((v) => v.id === vid)
  const shown = (v) => ({
    id: v.id,
    number: v.number,
    annotations: { 'workers/tag': v.tag },
    // Secrets are listed by name and type only, as Cloudflare does.
    resources: { bindings: [...Object.entries(v.vars).map(([n, text]) => ({ type: 'plain_text', name: n, text })), ...Object.keys(v.secrets).map((n) => ({ type: 'secret_text', name: n }))] },
  })
  if (sub === 'deployments') return ok({ deployments: [{ id: 'd1', created_on: '2026-11-19T00:00:00Z', versions: w.deployment }] })
  if (sub === 'versions' && id) return version(id) ? ok(shown(version(id))) : notFound()
  if (sub === 'versions') return ok({ items: [...w.versions].reverse().map((v) => ({ id: v.id, number: v.number })) })
  if (sub === 'secrets') return ok(Object.keys(version(w.deployment[0]?.version_id)?.secrets ?? {}).map((n) => ({ name: n, type: 'secret_text' })))
  return notFound()
}

const savedEnv = { ...process.env }
process.env.VIZ_WRANGLER_BIN = bin
process.env.VIZ_FAKE_WRANGLER_STATE = statePath
process.env.CLOUDFLARE_ACCOUNT_ID = 'fake-account'
process.env.CLOUDFLARE_API_TOKEN = 'fake-token-not-a-credential'
delete process.env.GITHUB_STEP_SUMMARY
delete process.env.VIZ_ROTATE_SECRETS

beforeEach(() => {
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  writeFileSync(join(stageDir, 'manifest.json'), JSON.stringify(manifest))
})
after(() => {
  globalThis.fetch = realFetch
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
  Object.assign(process.env, savedEnv)
  rmSync(stageDir, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
})

/** Runs `fn` with everything it logs captured (console and stderr, where wrangler's output is relayed). */
async function captured(fn) {
  const out = []
  const saved = { write: process.stderr.write, log: console.log, error: console.error }
  process.stderr.write = (chunk, ...rest) => {
    out.push(String(chunk))
    const cb = rest.find((x) => typeof x === 'function')
    if (cb) cb()
    return true
  }
  console.log = (...a) => out.push(a.join(' '))
  console.error = (...a) => out.push(a.join(' '))
  try {
    return { result: await fn(), log: out.join('\n') }
  } catch (error) {
    return { error, log: out.join('\n') }
  } finally {
    Object.assign(process.stderr, { write: saved.write })
    console.log = saved.log
    console.error = saved.error
  }
}

const cmd = (call) => call.argv.join(' ')
const callsLike = (state, prefix) => state.calls.filter((c) => cmd(c).startsWith(prefix))
const serving = (state, name) => state.workers[name].versions.find((v) => v.id === state.workers[name].deployment[0].version_id)
const promotions = (state) => state.calls.filter((c) => (c.argv[0] === 'versions' && c.argv[1] === 'deploy') || c.argv[0] === 'triggers' || (c.argv[0] === 'deploy' && !c.argv.includes('--dry-run')))
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
