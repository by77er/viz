// node --test deploy/test/: configure.mjs, without the network.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkEntrypoints, configure, durableObjectsOf, exportedNames, generateWorker, loadPlan, queuesOf, stageVars } from '../configure.mjs'
import { GENERATED_DIR, REPO_ROOT, checkStage, parseJsonc, readJsonc, stagedName } from '../lib/common.mjs'
import { SCHEMAS_VAR, parseSource, readSchemas, schemaSources, schemasVar } from '../lib/schemas.mjs'

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
  assert.deepEqual(m.order, ['viz-citest-publisher', 'viz-citest-ingest', 'viz-citest-control', 'viz-citest-query', 'viz-citest-ruler', 'viz-citest-mcp', 'viz-citest-gateway'])
  assert.equal(m.releaseFrom, 'viz-citest-ingest')
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
      const callee = edge.split('→')[1].trim().split(/[:#]/)[0]
      assert.ok(callee.startsWith('viz-citest-'), `${w.name}: ${edge}`)
      assert.ok(m.order.indexOf(callee) >= 0, `${w.name} binds ${callee}, which is not deployed`)
      assert.ok(m.order.indexOf(callee) < m.order.indexOf(w.name), `${w.name} binds ${callee}, which must deploy first`)
    }
  }
  // The write path binds the cell's publisher, which therefore deploys first (callee first).
  const ingest = m.workers.find((w) => w.canonical === 'viz-ingest')
  assert.ok(ingest.crossScript.includes('PUBLISHER → viz-citest-publisher:Publisher'), ingest.crossScript.join(', '))
  const ruler = m.workers.find((w) => w.canonical === 'viz-ruler')
  assert.deepEqual(ruler.crossScript.sort(), ['INGEST → viz-citest-ingest', 'QUERY → viz-citest-query', 'SINK → viz-citest-ingest#RecordedSamples', 'TENANT → viz-citest-control:Tenant'])
  const mcp = m.workers.find((w) => w.canonical === 'viz-mcp')
  // mcp/ may bind more (its OAuth work binds control's Tenant too); the order check above covers every binding.
  for (const b of ['CONTROL → viz-citest-control', 'QUERY → viz-citest-query', 'RULER → viz-citest-ruler']) assert.ok(mcp.crossScript.includes(b), `${b} in ${mcp.crossScript.join(', ')}`)
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

// ───────────────────────────── the publisher, schemas, stage vars ─────────────────────────────

test('viz-publisher is deployed, first, with its health route; nothing deployed is left without a reason', () => {
  const pub = worker('viz-publisher')
  assert.equal(pub.deploy, true)
  assert.equal(plan.workers.findIndex((w) => w.name === 'viz-publisher'), 0)
  assert.equal(pub.health, '/healthz')
  // The route the record names is the one publisher/src/index.ts serves (its test calls it).
  assert.match(readFileSync(join(REPO_ROOT, 'publisher', 'src', 'index.ts'), 'utf8'), /pathname !== '\/healthz'/)
  const c = gen('viz-publisher', 'trial').config
  assert.equal(c.name, 'viz-trial-publisher')
  assert.equal(c.r2_buckets[0].bucket_name, 'viz-trial-lake')
  assert.equal(c.vars.ICEBERG_LOCATION_PREFIX, 's3://viz-trial-lake')
  assert.equal(c.workers_dev, false)
  for (const w of plan.workers) assert.ok(w.deploy || w.reason, w.name)
})

test('every Durable Object class a Worker defines has its schema declared, and the declaration is the spec its class opens storage with', () => {
  for (const w of plan.workers) {
    const cfg = readJsonc(join(REPO_ROOT, w.component, 'wrangler.jsonc'))
    for (const cls of durableObjectsOf(cfg).classes) {
      const ref = w.schemas?.[cls]
      if (ref === undefined) {
        assert.ok(w.unversioned?.[cls], `${w.name}: ${cls} is declared neither in schemas nor in unversioned`)
        continue
      }
      const { module, name } = parseSource(ref, w.name)
      assert.match(readFileSync(join(REPO_ROOT, module), 'utf8'), new RegExp(`export const ${name}: SchemaSpec`), `${module} exports ${name}`)
      // The class's own file opens its storage with that spec.
      const dir = join(REPO_ROOT, w.component, 'src')
      const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(join(dir, f), 'utf8'))
      const owner = files.concat(cls === 'Shard' ? [readFileSync(join(REPO_ROOT, 'shard/src/shard.ts'), 'utf8')] : [], cls === 'Ledger' ? [readFileSync(join(REPO_ROOT, 'ledger/src/ledger.ts'), 'utf8')] : [])
        .find((t) => new RegExp(`export class ${cls} extends`).test(t))
      assert.ok(owner, `${w.name}: no source defines class ${cls}`)
      assert.match(owner, new RegExp(`openSchema\\([^)]*\\b${name}\\)`), `${cls} opens its storage with ${name}`)
    }
  }
  // An undeclared class is an error, not a silently unchecked rollback.
  const bare = { ...worker('viz-control'), schemas: {} }
  assert.throws(() => generateWorker({ worker: bare, cfg: readJsonc(join(REPO_ROOT, 'control/wrangler.jsonc')), componentDir: join(REPO_ROOT, 'control'), plan, stage: 'trial', release: 'x', ids, outDir: GENERATED_DIR }), /Tenant has no "schemas" entry/)
})

test('the schemas are read from the components themselves, into the manifest and each version\'s VIZ_SCHEMAS var', () => {
  const read = readSchemas(schemaSources(plan.workers))
  const by = Object.fromEntries(read.map((s) => [s.component, s]))
  assert.deepEqual(Object.keys(by).sort(), ['control.Tenant', 'ledger.Ledger', 'publisher.Publisher', 'ruler.Notifier', 'ruler.Ruler', 'ruler.RulerIndex', 'shard.Shard'])
  // The ledger's migration 2 (the segment log) is forward-only: readableFrom 2.
  const m2 = by['ledger.Ledger'].migrations.find((m) => m.version === 2)
  assert.equal(m2.readableFrom, 2)
  assert.ok(by['ledger.Ledger'].compat >= 2)
  for (const s of read) {
    assert.equal(s.latest, s.migrations.length)
    assert.equal(s.compat, Math.max(...s.migrations.map((m) => m.readableFrom)))
  }
  const m = configure({ stage: 'citest', release: 'r1', idsOptional: true, quiet: true })
  for (const w of m.workers.filter((x) => x.deploy)) {
    const cfg = JSON.parse(readFileSync(join(REPO_ROOT, w.config), 'utf8').replace(/^\/\/.*\n/, ''))
    if (w.schemas.length === 0) assert.equal(cfg.vars[SCHEMAS_VAR], undefined, w.name)
    else assert.equal(cfg.vars[SCHEMAS_VAR], schemasVar(w.schemas), w.name)
  }
  const ingest = m.workers.find((w) => w.canonical === 'viz-ingest')
  assert.deepEqual(ingest.schemas.map((s) => s.component), ['shard.Shard', 'ledger.Ledger'])
  assert.deepEqual(JSON.parse(schemasVar(ingest.schemas)).classes['ledger.Ledger'], { latest: by['ledger.Ledger'].latest, compat: by['ledger.Ledger'].compat, by: `2: ${m2.name}` })
})

test('VIZ_STAGE_VARS: per Worker, strings only, and never for production', () => {
  assert.deepEqual(stageVars(undefined, 'trial'), {})
  assert.deepEqual(stageVars('{"viz-ingest":{"MAINTENANCE":"{}"}}', 'trial'), { 'viz-ingest': { MAINTENANCE: '{}' } })
  assert.throws(() => stageVars('{"viz-ingest":{"MAINTENANCE":"{}"}}', undefined), /stage only/)
  assert.throws(() => stageVars('{"viz-ingest":{"X":1}}', 'trial'), /strings/)
  assert.throws(() => stageVars('nope', 'trial'), /not JSON/)
  const g = generateWorker({ worker: worker('viz-ingest'), cfg: readJsonc(join(REPO_ROOT, 'stack/wrangler.jsonc')), componentDir: join(REPO_ROOT, 'stack'), plan, stage: 'trial', release: 'x', ids, outDir: GENERATED_DIR, extraVars: { MAINTENANCE: '{"deleteGraceMs":60000}' } })
  assert.equal(g.config.vars.MAINTENANCE, '{"deleteGraceMs":60000}')
})

test('stack/wrangler.test.jsonc differs from the config production is generated from only by the publisher binding and the test main', () => {
  const prod = readJsonc(join(REPO_ROOT, 'stack/wrangler.jsonc'))
  const test = readJsonc(join(REPO_ROOT, 'stack/wrangler.test.jsonc'))
  const strip = (c, binding) => ({ ...c, main: null, durable_objects: { bindings: c.durable_objects.bindings.filter((b) => b.name !== binding) }, migrations: c.migrations.filter((m) => m.tag === 'v1') })
  assert.deepEqual(strip(test, 'TEST_PUBLISHER'), strip(prod, 'PUBLISHER'))
  assert.deepEqual(prod.durable_objects.bindings.find((b) => b.name === 'PUBLISHER'), { name: 'PUBLISHER', class_name: 'Publisher', script_name: 'viz-publisher' })
  assert.deepEqual(test.durable_objects.bindings.find((b) => b.name === 'TEST_PUBLISHER'), { name: 'TEST_PUBLISHER', class_name: 'TestPublisher' })
  assert.equal(test.main, 'test/worker.ts')
  assert.equal(prod.main, 'src/index.ts')
})

test('the ruler\'s SINK: viz-ingest\'s RecordedSamples entrypoint with props naming the ruler, a caller contracts/ingest.ts allows', () => {
  for (const stage of [undefined, 'trial']) {
    const { config, summary } = gen('viz-ruler', stage)
    const sink = config.services.find((s) => s.binding === 'SINK')
    assert.deepEqual(sink, { binding: 'SINK', service: stagedName('viz-ingest', stage), entrypoint: 'RecordedSamples', props: { caller: 'viz-ruler' } })
    assert.deepEqual(summary.entrypoints, [{ binding: 'SINK', callee: 'viz-ingest', entrypoint: 'RecordedSamples' }])
    // Remote Write stays bound for the fallback (D52).
    assert.deepEqual(config.services.find((s) => s.binding === 'INGEST'), { binding: 'INGEST', service: stagedName('viz-ingest', stage) })
  }
  // The entrypoint refuses any caller not in RECORDED_SAMPLES_CALLERS (contracts/ingest.ts).
  const contract = readFileSync(join(REPO_ROOT, 'contracts', 'ingest.ts'), 'utf8')
  const callers = JSON.parse(/RECORDED_SAMPLES_CALLERS: readonly string\[\] = (\[[^\]]*\])/.exec(contract)[1].replace(/'/g, '"'))
  assert.equal(/RECORDED_SAMPLES_ENTRYPOINT = '(\w+)'/.exec(contract)[1], 'RecordedSamples')
  assert.ok(callers.includes(gen('viz-ruler').config.services.find((s) => s.binding === 'SINK').props.caller), callers.join(', '))
})

test('an entrypoint a binding names is exported by the callee as deployed (a stage\'s ingest shim too); otherwise the release is refused', () => {
  const prodMain = join(REPO_ROOT, 'stack/src/index.ts')
  const stageMain = join(REPO_ROOT, 'deploy/stage/ingest.ts')
  assert.ok(exportedNames(prodMain).has('RecordedSamples'))
  assert.ok(exportedNames(stageMain).has('RecordedSamples'), 'followed through export * from the stage shim')
  assert.ok(!exportedNames(prodMain).has('FlushOptions'), '`export type { … }` exports no value')
  const e = [{ binding: 'SINK', callee: 'viz-ingest', entrypoint: 'RecordedSamples' }]
  checkEntrypoints('viz-ruler', e, new Map([['viz-ingest', prodMain]]))
  checkEntrypoints('viz-ruler', e, new Map([['viz-ingest', stageMain]]))
  // An ingest from before the entrypoint (its export removed), or a typo, or a callee not configured first.
  assert.throws(() => checkEntrypoints('viz-ruler', [{ ...e[0], entrypoint: 'RecordedSample' }], new Map([['viz-ingest', prodMain]])), /does not export: a callee ships an entrypoint before or with its first caller/)
  assert.throws(() => checkEntrypoints('viz-ruler', e, new Map()), /not configured before it/)
  // Malformed bindings are refused, not passed on.
  const cfg = readJsonc(join(REPO_ROOT, 'ruler/wrangler.jsonc'))
  const withSink = (sink) => ({ ...cfg, services: [...cfg.services.filter((s) => s.binding !== 'SINK'), sink] })
  assert.throws(() => gen('viz-ruler', undefined, withSink({ binding: 'SINK', service: 'viz-ingest', entrypoint: 'Recorded-Samples' })), /entrypoint must name an export/)
  assert.throws(() => gen('viz-ruler', undefined, withSink({ binding: 'SINK', service: 'viz-ingest', entrypoint: 'RecordedSamples', props: 'viz-ruler' })), /props must be an object/)
  assert.throws(() => gen('viz-ruler', undefined, withSink({ binding: 'SINK', service: 'viz-elsewhere', entrypoint: 'RecordedSamples' })), /not a Worker in deploy\/workers.json/)
})
