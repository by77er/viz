// node --test deploy/test/: configure.mjs, without the network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { configure, durableObjectsOf, generateWorker, loadPlan, queuesOf } from '../configure.mjs'
import { GENERATED_DIR, REPO_ROOT, checkStage, parseJsonc, readJsonc, stagedName } from '../lib/common.mjs'

const { plan } = loadPlan()
const worker = (name) => plan.workers.find((w) => w.name === name)
const ids = { 'viz-config': 'a'.repeat(32), 'viz-trial-config': 'b'.repeat(32) }
const gen = (name, stage, cfg) => {
  const w = worker(name)
  const componentDir = join(REPO_ROOT, w.component)
  return generateWorker({ worker: w, cfg: cfg ?? readJsonc(join(componentDir, 'wrangler.jsonc')), componentDir, plan, stage, release: 'abc123', ids, outDir: join(GENERATED_DIR, stage ? `stage-${stage}` : 'production') })
}

test('JSONC: comments and trailing commas go, strings stay', () => {
  const v = parseJsonc('{\n // a comment\n "a": "x // not a comment", /* block */ "b": [1, 2,],\n "c": "\\"/*\\"",\n}')
  assert.deepEqual(v, { a: 'x // not a comment', b: [1, 2], c: '"/*"' })
})

test('query: SHARD and LEDGER point at viz-ingest, whatever name query/ uses today', () => {
  const { config } = gen('viz-query')
  const dob = Object.fromEntries(config.durable_objects.bindings.map((b) => [b.name, b]))
  assert.equal(dob.SHARD.script_name, 'viz-ingest')
  assert.equal(dob.LEDGER.script_name, 'viz-ingest')
  assert.equal(dob.LEAF.script_name, undefined)
  assert.equal(config.name, 'viz-query')
  assert.equal(config.kv_namespaces[0].id, 'a'.repeat(32))
  assert.equal(config.workers_dev, false)
  assert.equal(config.routes, undefined)
  assert.equal(config.vars.VIZ_RELEASE, 'abc123')
  assert.equal(config.observability.enabled, true)
  assert.ok(config.observability.head_sampling_rate > 0 && config.observability.head_sampling_rate <= 0.1)
  assert.equal(config.main, '../../../query/src/index.ts')
  // Everything else is the component's own: migrations, placement, compatibility date.
  const own = readJsonc(join(REPO_ROOT, 'query/wrangler.jsonc'))
  assert.deepEqual(config.migrations, own.migrations)
  assert.deepEqual(config.placement, own.placement)
  assert.equal(config.compatibility_date, own.compatibility_date)
})

test('a stage prefixes every Worker and resource and uses workers.dev for the gateway only', () => {
  const q = gen('viz-query', 'trial').config
  assert.equal(q.name, 'viz-trial-query')
  assert.equal(q.r2_buckets[0].bucket_name, 'viz-trial-lake')
  assert.equal(q.kv_namespaces[0].id, 'b'.repeat(32))
  assert.ok(q.durable_objects.bindings.filter((b) => b.script_name).every((b) => b.script_name === 'viz-trial-ingest'))
  assert.equal(q.workers_dev, false)
  const g = gen('viz-gateway', 'trial').config
  assert.equal(g.workers_dev, true)
  assert.equal(g.routes, undefined)
  assert.deepEqual(g.services.map((s) => s.service).sort(), ['viz-trial-control', 'viz-trial-ingest', 'viz-trial-mcp', 'viz-trial-query', 'viz-trial-ruler'])
  assert.equal(g.durable_objects.bindings[0].script_name, 'viz-trial-control')
  const i = gen('viz-ingest', 'trial').config
  assert.deepEqual(queuesOf(i).sort(), ['viz-trial-flush', 'viz-trial-flush-dlq', 'viz-trial-maint', 'viz-trial-maint-dlq'])
  assert.equal(i.main, '../../stage/ingest.ts')
  assert.equal(i.vars.VIZ_STAGE_PREFIX, 'viz-trial-')
})

test('production: the gateway, and only it, is on the custom domain; nothing on workers.dev', () => {
  for (const w of plan.workers.filter((x) => x.deploy)) {
    const c = gen(w.name).config
    assert.equal(c.workers_dev, false, w.name)
    if (w.public) assert.deepEqual(c.routes, [{ pattern: 'vis.bitcru.sh', custom_domain: true }])
    else assert.equal(c.routes, undefined, w.name)
  }
  assert.equal(gen('viz-ingest').config.main, '../../../stack/src/index.ts')
})

test('deployment-wide vars override a disagreeing component, with a note', () => {
  const g = gen('viz-ingest')
  assert.equal(g.config.vars.DEFAULT_POOL, plan.shared_vars.DEFAULT_POOL)
  const own = readJsonc(join(REPO_ROOT, 'stack/wrangler.jsonc'))
  if (own.vars.DEFAULT_POOL !== plan.shared_vars.DEFAULT_POOL) assert.match(g.summary.warnings.join('\n'), /DEFAULT_POOL/)
  // Every deployed Worker that declares DEFAULT_POOL gets the same value.
  for (const w of plan.workers.filter((x) => x.deploy)) {
    const c = gen(w.name).config
    if ('DEFAULT_POOL' in c.vars) assert.equal(c.vars.DEFAULT_POOL, plan.shared_vars.DEFAULT_POOL, w.name)
  }
})

test('refuses what it does not understand instead of guessing', () => {
  const base = readJsonc(join(REPO_ROOT, 'query/wrangler.jsonc'))
  assert.throws(() => gen('viz-query', undefined, { ...base, d1_databases: [{ binding: 'DB' }] }), /d1_databases/)
  const badScript = structuredClone(base)
  badScript.durable_objects.bindings[1].script_name = 'some-other-worker'
  assert.throws(() => gen('viz-query', undefined, badScript), /not a Worker/)
  assert.throws(() => gen('viz-query', undefined, { ...base, r2_buckets: [{ binding: 'X', bucket_name: 'not-ours' }] }), /not in deploy\/workers.json/)
  assert.throws(() => gen('viz-query', undefined, { ...base, kv_namespaces: [{ binding: 'OTHER', id: '0'.repeat(32) }] }), /no namespace/)
  const w = worker('viz-query')
  assert.throws(
    () => generateWorker({ worker: w, cfg: base, componentDir: join(REPO_ROOT, 'query'), plan, stage: undefined, release: 'x', ids: {}, outDir: GENERATED_DIR }),
    /run deploy\/resources.mjs first/,
  )
})

test('migration tags and classes are read from the component', () => {
  assert.deepEqual(durableObjectsOf({ durable_objects: { bindings: [{ name: 'A', class_name: 'A' }, { name: 'B', class_name: 'B', script_name: 'x' }] }, migrations: [{ tag: 'v1' }, { tag: 'v2' }] }), { classes: ['A'], migrationTags: ['v1', 'v2'], migrationTag: 'v2' })
  assert.throws(() => durableObjectsOf({ migrations: [{ tag: 'v1' }, { tag: 'v1' }] }), /duplicate/)
})

test('stage names that would overlap production are refused; names must start viz-', () => {
  for (const bad of ['flush', 'ingest', 'config', 'Trial', 'x', 'a-b', 'production']) assert.throws(() => checkStage(bad))
  checkStage('trial')
  assert.equal(stagedName('viz-flush-dlq', 'trial'), 'viz-trial-flush-dlq')
  assert.throws(() => stagedName('CONFIG', 'trial'), /viz-/)
})

test('configure writes every config and a manifest in dependency order', () => {
  const m = configure({ stage: 'citest', release: 'r1', idsOptional: true, quiet: true })
  assert.deepEqual(m.order, ['viz-citest-ingest', 'viz-citest-control', 'viz-citest-query', 'viz-citest-ruler', 'viz-citest-mcp', 'viz-citest-gateway'])
  assert.deepEqual(m.resources.r2, ['viz-citest-lake'])
  assert.ok(m.workers.filter((w) => !w.deploy).every((w) => w.reason))
})

test('the health path recorded for each backend is the one the gateway asks through its binding', () => {
  // gateway/src/index.ts HEALTH_PATHS, read from the source (it is TypeScript for workerd).
  const src = readFileSync(join(REPO_ROOT, 'deploy', 'gateway', 'src', 'index.ts'), 'utf8')
  const block = /export const HEALTH_PATHS[^=]*= \{([^}]*)\}/.exec(src)[1]
  const asked = Object.fromEntries([...block.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]))
  assert.deepEqual(Object.keys(asked).sort(), ['control', 'ingest', 'mcp', 'query', 'ruler'])
  for (const [backend, path] of Object.entries(asked)) assert.equal(worker(`viz-${backend}`).health, path, `viz-${backend}`)
})

test('every service a Worker binds is deployed before it, and resolves to a deployed Worker of the same stage', () => {
  const m = configure({ stage: 'citest', release: 'r1', idsOptional: true, quiet: true })
  for (const w of m.workers.filter((x) => x.deploy)) {
    for (const edge of w.crossScript) {
      const callee = edge.split('→')[1].trim().split(':')[0]
      assert.ok(callee.startsWith('viz-citest-'), `${w.name}: ${edge}`)
      assert.ok(m.order.indexOf(callee) >= 0, `${w.name} binds ${callee}, which is not deployed`)
      assert.ok(m.order.indexOf(callee) < m.order.indexOf(w.name), `${w.name} binds ${callee}, which must deploy first`)
    }
  }
  const ruler = m.workers.find((w) => w.canonical === 'viz-ruler')
  assert.deepEqual(ruler.crossScript.sort(), ['INGEST → viz-citest-ingest', 'QUERY → viz-citest-query', 'TENANT → viz-citest-control:Tenant'])
  const mcp = m.workers.find((w) => w.canonical === 'viz-mcp')
  assert.deepEqual(mcp.crossScript.sort(), ['CONTROL → viz-citest-control', 'QUERY → viz-citest-query', 'RULER → viz-citest-ruler'])
  const gateway = m.workers.find((w) => w.canonical === 'viz-gateway')
  assert.ok(gateway.crossScript.includes('RULER → viz-citest-ruler') && gateway.crossScript.includes('MCP → viz-citest-mcp'))
})

test('--expires sets the stage deadline in every Worker; production refuses one', () => {
  const m = configure({ stage: 'citest', release: 'r1', idsOptional: true, quiet: true, expires: '2026-11-20T06:00:00Z' })
  assert.equal(m.expires, '2026-11-20T06:00:00Z')
  for (const w of m.workers.filter((x) => x.deploy)) {
    const cfg = JSON.parse(readFileSync(join(REPO_ROOT, w.config), 'utf8').replace(/^\/\/.*\n/, ''))
    assert.equal(cfg.vars.VIZ_STAGE_EXPIRES_AT, '2026-11-20T06:00:00Z', w.name)
  }
  assert.throws(() => configure({ release: 'r1', idsOptional: true, quiet: true, expires: '2026-11-20T06:00:00Z' }), /stage only/)
  assert.throws(() => configure({ stage: 'citest', release: 'r1', idsOptional: true, quiet: true, expires: 'tomorrow' }), /ISO 8601/)
  configure({ stage: 'citest', release: 'r1', idsOptional: true, quiet: true })
})
