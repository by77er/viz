// node --test deploy/test/: deploy/resources.mjs's Rate Limiting namespace ids (D70): allocated once per
// deployment from viz's range, never one a script that is not viz's binds, never one another viz
// deployment holds; the account is only read. Nothing reaches Cloudflare: the fake account answers.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

const tmp = mkdtempSync(join(tmpdir(), 'viz-resources-test-'))
process.env.VIZ_RESOURCES_FILE = join(tmp, 'resources.json')
const { DEPLOY_DIR } = await import('../lib/common.mjs')
const { allocateRateLimitIds, ensureRateLimitIds, freeRateLimitIds, rateLimitIdsInUse, wantedRateLimits } = await import('../resources.mjs')
const { installFakeAccount } = await import('./fake-account.mjs')
const cfApi = await import('../lib/cf.mjs')
const plan = JSON.parse(readFileSync(join(DEPLOY_DIR, 'workers.json'), 'utf8'))
const RANGE = plan.resources.ratelimit_ids
const account = installFakeAccount(tmp)
after(() => {
  account.restore()
  rmSync(tmp, { recursive: true, force: true })
})
beforeEach(() => writeFileSync(process.env.VIZ_RESOURCES_FILE, JSON.stringify({ kv_namespaces: {}, ratelimit_namespaces: {} })))

const none = () => ({ used: new Map(), byScript: new Map() })
const inUse = (scripts) => ({
  used: new Map(Object.entries(scripts).flatMap(([s, b]) => Object.values(b).map((id) => [id, s])).reduce((m, [id, s]) => m.set(id, new Set([...(m.get(id) ?? []), s])), new Map())),
  byScript: new Map(Object.entries(scripts)),
})
const ids = (r) => Object.values(r.ids)

test('wanted: one key per binding of viz-control\'s component config, by deployed name', () => {
  assert.deepEqual(wantedRateLimits(undefined).map((w) => w.key), ['OAUTH_RL_SOURCE', 'OAUTH_RL_SOURCE_48', 'OAUTH_RL_CREDENTIAL', 'OAUTH_RL_TENANT', 'OAUTH_RL_BEARER', 'OAUTH_RL_BEARER_TENANT'].map((n) => `viz-control/${n}`))
  assert.ok(wantedRateLimits('trial').every((w) => w.key.startsWith('viz-trial-control/') && w.worker === 'viz-trial-control'))
})

test('allocation: six distinct ids in viz\'s range; none that a script which is not viz\'s binds, even one in viz\'s range', () => {
  const wanted = wantedRateLimits(undefined)
  const free = allocateRateLimitIds({ wanted, range: RANGE, inUse: none() })
  assert.equal(new Set(ids(free)).size, 6)
  assert.ok(ids(free).every((id) => Number(id) >= RANGE.from && Number(id) <= RANGE.to))
  // An unrelated script binds every one of those ids: none of them is taken again.
  const taken = allocateRateLimitIds({ wanted, range: RANGE, inUse: inUse({ 'unrelated-app': Object.fromEntries(ids(free).map((id, i) => [`L${i}`, id])) }) })
  assert.equal(new Set(ids(taken)).size, 6)
  for (const id of ids(taken)) assert.ok(!ids(free).includes(id), id)
  // A recorded id (resources.json) that an unrelated script now binds is refused, said so, and replaced.
  const key = wanted[0].key
  const r = allocateRateLimitIds({ wanted, range: RANGE, inUse: inUse({ 'unrelated-app': { X: '7042' } }), recorded: { [key]: '7042' } })
  assert.notEqual(r.ids[key], '7042')
  assert.match(r.notes.join('\n'), /viz-control\/OAUTH_RL_SOURCE: REFUSING to reuse 7042 \(recorded in resources\.json\): script unrelated-app, which is not viz's, binds it; a new id is taken and the counters reset/)
  // The same when the deployment's own viz-control binds it (it collided since): refused, replaced.
  const own = allocateRateLimitIds({ wanted, range: RANGE, inUse: inUse({ 'viz-control': { OAUTH_RL_SOURCE: '7042' }, 'unrelated-app': { X: '7042' } }) })
  assert.notEqual(own.ids[key], '7042')
  assert.match(own.notes.join('\n'), /REFUSING to reuse 7042 \(bound by viz-control\): script unrelated-app/)
})

test('allocation: production and stages never collide, whether their ids are bound on the account or only recorded; each keeps its own', () => {
  const prod = allocateRateLimitIds({ wanted: wantedRateLimits(undefined), range: RANGE, inUse: none() })
  // Stage a, configured from the same checkout before production was deployed: production's ids are only recorded.
  const a = allocateRateLimitIds({ wanted: wantedRateLimits('a1'), range: RANGE, inUse: none(), recorded: prod.ids })
  // Stage b after both are deployed: their ids are bound by their viz-controls; nothing is recorded here (another checkout).
  const bound = { 'viz-control': Object.fromEntries(Object.entries(prod.ids).map(([k, v]) => [k.split('/')[1], v])), 'viz-a1-control': Object.fromEntries(Object.entries(a.ids).map(([k, v]) => [k.split('/')[1], v])) }
  const b = allocateRateLimitIds({ wanted: wantedRateLimits('b1'), range: RANGE, inUse: inUse(bound) })
  const all = [...ids(prod), ...ids(a), ...ids(b)]
  assert.equal(new Set(all).size, 18, all.join(','))
  // A viz spike's binding is another deployment's too.
  const spike = allocateRateLimitIds({ wanted: wantedRateLimits('c1'), range: RANGE, inUse: inUse({ 'viz-s5-spike': Object.fromEntries(all.map((id, i) => [`S${i}`, id])) }) })
  for (const id of ids(spike)) assert.ok(!all.includes(id), id)
  // Production run again: keeps its ids (bound by its viz-control), even with a stage's recorded.
  const again = allocateRateLimitIds({ wanted: wantedRateLimits(undefined), range: RANGE, inUse: inUse(bound), recorded: a.ids })
  assert.deepEqual(again.ids, prod.ids)
  assert.ok(again.notes.every((n) => /kept \(bound by viz-control\)/.test(n)))
  // Not one id of another deployment, even when this deployment's own viz-control binds it (a copy by hand).
  const stolen = allocateRateLimitIds({ wanted: wantedRateLimits('a1'), range: RANGE, inUse: inUse({ ...bound, 'viz-a1-control': bound['viz-control'] }) })
  for (const id of ids(stolen)) assert.ok(!ids(prod).includes(id), id)
})

test('allocation: deterministic for an account state (CI starts from an empty resources.json); out-of-range ids are not kept; an exhausted range is an error', () => {
  const wanted = wantedRateLimits('d1')
  assert.deepEqual(allocateRateLimitIds({ wanted, range: RANGE, inUse: none() }), allocateRateLimitIds({ wanted, range: RANGE, inUse: none() }))
  const r = allocateRateLimitIds({ wanted, range: RANGE, inUse: inUse({ 'viz-d1-control': { OAUTH_RL_SOURCE: '1001' } }) })
  assert.notEqual(r.ids['viz-d1-control/OAUTH_RL_SOURCE'], '1001')
  assert.match(r.notes.join('\n'), /not reusing 1001 \(bound by viz-d1-control\): outside viz's range 7000–7999/)
  assert.throws(() => allocateRateLimitIds({ wanted, range: { from: 7000, to: 7004 }, inUse: none() }), /no free Rate Limiting namespace id left in viz's range 7000–7004/)
  assert.throws(() => allocateRateLimitIds({ wanted, range: { from: 0, to: 9 }, inUse: none() }), /ratelimit_ids/)
})

test('the account scan reads the serving and newest versions of every script, only with GET, and refuses a Rate Limiting binding whose id it cannot read', async () => {
  const methods = []
  const api = {
    listScripts: async () => [{ id: 'unrelated-app' }, { id: 'viz-control' }],
    currentDeployment: async (s) => ({ versions: [{ version_id: `${s}-serving` }] }),
    listVersions: async (s) => [{ id: `${s}-newest` }, { id: `${s}-serving` }],
    versionInfo: async (s, id) => {
      methods.push(id)
      if (s === 'unrelated-app') return { resources: { bindings: [{ type: 'ratelimit', name: 'L', namespace_id: id.endsWith('newest') ? '7777' : '7776', simple: { limit: 1, period: 60 } }, { type: 'durable_object_namespace', name: 'D', namespace_id: 'abc' }] } }
      return { resources: { bindings: [{ type: 'ratelimit', name: 'OAUTH_RL_SOURCE', namespace_id: id.endsWith('serving') ? '7000' : '7010' }] } }
    },
  }
  const r = await rateLimitIdsInUse(api)
  assert.deepEqual([...r.used.keys()].sort(), ['7000', '7010', '7776', '7777'], 'a Durable Object namespace id is not a Rate Limiting one')
  assert.deepEqual(r.byScript.get('viz-control'), { OAUTH_RL_SOURCE: '7000' }, 'the serving version first')
  assert.equal(methods.length, 4)
  await assert.rejects(rateLimitIdsInUse({ ...api, versionInfo: async () => ({ resources: { bindings: [{ type: 'ratelimit', name: 'L' }] } }) }), /a Rate Limiting binding L whose namespace id cannot be read/)
  await assert.rejects(rateLimitIdsInUse({ ...api, versionInfo: async () => ({ resources: { bindings: [{ type: 'rate_limiting', name: 'L', id: 5 }] } }) }), /of type rate_limiting, which resources\.mjs does not know how to read/)
})

test('ensure against the fake account: records the ids, reads only (no write to Cloudflare), keeps them next time; destroy --stage frees a stage\'s ids', async () => {
  const v = (id, ratelimits) => ({ id, number: 1, tag: null, vars: {}, secrets: {}, ratelimits })
  account.writeState({ calls: [], workers: { 'unrelated-app': { versions: [v('u1', [{ name: 'L', namespace_id: '7300', simple: { limit: 1, period: 60 } }])], deployment: [{ version_id: 'u1', percentage: 100 }] } } })
  const seen = []
  const fetch = globalThis.fetch
  globalThis.fetch = (url, init = {}) => {
    seen.push(init.method ?? 'GET')
    return fetch(url, init)
  }
  try {
    const r = await ensureRateLimitIds('e1', cfApi)
    assert.ok(seen.length > 0 && seen.every((m) => m === 'GET'), seen.join(','))
    assert.ok(!ids(r).includes('7300'))
    const file = () => JSON.parse(readFileSync(process.env.VIZ_RESOURCES_FILE, 'utf8')).ratelimit_namespaces
    assert.deepEqual(file(), r.ids)
    const p = await ensureRateLimitIds(undefined, cfApi)
    assert.deepEqual(file(), { ...r.ids, ...p.ids })
    assert.equal(new Set([...ids(r), ...ids(p)]).size, 12)
    assert.deepEqual(freeRateLimitIds('e1').length, 6)
    assert.deepEqual(file(), p.ids, 'only the stage\'s ids are freed')
    assert.throws(() => freeRateLimitIds(undefined), /only a stage frees/)
  } finally {
    globalThis.fetch = fetch
  }
})
