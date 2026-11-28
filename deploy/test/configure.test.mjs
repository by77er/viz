// node --test deploy/test/: configure.mjs, without the network.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ORIGIN_VARS, UNKNOWN_SUBDOMAIN, checkEntrypoints, checkFloorSchemas, configure, durableObjectsOf, exportedNames, generateWorker, hostsOf, loadPlan, publicOrigin, queuesOf, readOAuthGates, stageVars } from '../configure.mjs'
import { GENERATED_DIR, REPO_ROOT, checkStage, parseJsonc, readJsonc, stagedName } from '../lib/common.mjs'
import { FLOORS_VAR, floorRules, stampedFloors } from '../lib/floors.mjs'
import { FORMATS_VAR, formatSources, formatsVar, readFormats } from '../lib/formats.mjs'
import { SCHEMAS_VAR, evaluateExports, parseSource, readSchemas, schemaSources, schemasVar } from '../lib/schemas.mjs'

const { plan } = loadPlan()
const worker = (name) => plan.workers.find((w) => w.name === name)
const ids = { 'viz-config': 'a'.repeat(32), 'viz-trial-config': 'b'.repeat(32) }
const gates = readOAuthGates(plan)
const RL = gates.get('viz-control').required
/** Rate Limiting namespace ids as deploy/resources.mjs records them (production 7000…, the trial stage 7100…). */
const ratelimitIds = Object.fromEntries(RL.flatMap((n, i) => [[`viz-control/${n}`, String(7000 + i)], [`viz-trial-control/${n}`, String(7100 + i)]]))
/** A made-up workers.dev subdomain: the account's real one is never written into the repository. */
const SUB = 'example-sub'
const stageUrl = (stage) => `https://viz-${stage}-gateway.${SUB}.workers.dev`
const gen = (name, stage, cfg, opts = {}) => {
  const w = worker(name)
  const componentDir = join(REPO_ROOT, w.component)
  return generateWorker({ worker: w, cfg: cfg ?? readJsonc(join(componentDir, 'wrangler.jsonc')), componentDir, plan, stage, release: 'abc123', ids, outDir: join(GENERATED_DIR, stage ? `stage-${stage}` : 'production'), gate: gates.get(name) ?? null, ratelimitIds, publicUrl: stage ? stageUrl(stage) : undefined, ...opts })
}
// configure() reads the subdomain from VIZ_WORKERS_SUBDOMAIN when not given (the command line reads it from the account).
process.env.VIZ_WORKERS_SUBDOMAIN = SUB

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

test('production: the gateway, and only it, holds both custom domains, viz first; nothing on workers.dev', () => {
  for (const w of plan.workers.filter((x) => x.deploy)) {
    const c = gen(w.name).config
    assert.equal(c.workers_dev, false, w.name)
    // D75: one list, viz canonical first, vis kept: wrangler replaces the Worker's whole set of custom domains with it.
    if (w.public) assert.deepEqual(c.routes, [{ pattern: 'viz.bitcru.sh', custom_domain: true }, { pattern: 'vis.bitcru.sh', custom_domain: true }])
    else assert.equal(c.routes, undefined, w.name)
  }
  assert.equal(gen('viz-ingest').config.main, '../../../stack/src/index.ts')
})

test('D75: the gateway decides by host: PUBLIC_URL is viz, vis is an alias with its deprecation date; a stage has none', () => {
  const g = gen('viz-gateway').config.vars
  assert.equal(g.PUBLIC_URL, 'https://viz.bitcru.sh')
  assert.deepEqual(JSON.parse(g.VIZ_HOST_ALIASES), [{ host: 'vis.bitcru.sh', deprecated: Date.parse('2026-11-28T00:00:00Z') / 1000 }])
  const s = gen('viz-gateway', 'trial').config
  assert.equal(s.vars.PUBLIC_URL, stageUrl('trial'))
  assert.equal(s.vars.VIZ_HOST_ALIASES, '[]')
  assert.equal(s.routes, undefined)
  // The manifest says which hosts production holds.
  const m = configure({ release: 'r-hosts', idsOptional: true, quiet: true })
  assert.equal(m.domain, 'viz.bitcru.sh')
  assert.deepEqual(m.domainAliases, ['vis.bitcru.sh'])
  const ms = configure({ stage: 'citest', release: 'r-hosts', idsOptional: true, quiet: true })
  assert.deepEqual([ms.domain, ms.domainAliases], [null, []])
})

test('D75: the hostnames of the plan are checked; no wildcard, no duplicate, a deprecation date', () => {
  assert.deepEqual(hostsOf(plan).map((h) => h.host), ['viz.bitcru.sh', 'vis.bitcru.sh'])
  const p = (over) => ({ ...plan, ...over })
  assert.throws(() => hostsOf(p({ domain: '*.bitcru.sh' })), /not a hostname/)
  assert.throws(() => hostsOf(p({ domain: 'VIZ.bitcru.sh' })), /not a hostname/)
  assert.throws(() => hostsOf(p({ domain_aliases: [{ host: 'viz.bitcru.sh', deprecated: '2026-11-28T00:00:00Z' }] })), /listed twice/)
  assert.throws(() => hostsOf(p({ domain_aliases: [{ host: 'vis.bitcru.sh', deprecated: '2026-11-28T00:00:00Z' }, { host: 'vis.bitcru.sh', deprecated: '2026-11-28T00:00:00Z' }] })), /listed twice/)
  assert.throws(() => hostsOf(p({ domain_aliases: [{ host: 'vis.bitcru.sh' }] })), /deprecated must be/)
  assert.throws(() => hostsOf(p({ domain_aliases: [{ host: 'vis.bitcru.sh', deprecated: '2026-11-28' }] })), /deprecated must be/)
  assert.throws(() => hostsOf(p({ domain_aliases: [{ host: 'vis.bitcru.sh', deprecated: '2026-11-28T00:00:00Z', zone: 'x' }] })), /host, deprecated/)
  // Without aliases the gateway holds only the domain (the change that ends the transition).
  const g = generateWorker({ worker: worker('viz-gateway'), cfg: readJsonc(join(REPO_ROOT, 'deploy/gateway/wrangler.jsonc')), componentDir: join(REPO_ROOT, 'deploy/gateway'), plan: p({ domain_aliases: [] }), release: 'x', ids, outDir: join(GENERATED_DIR, 'production') })
  assert.deepEqual([g.config.routes, g.config.vars.VIZ_HOST_ALIASES], [[{ pattern: 'viz.bitcru.sh', custom_domain: true }], '[]'])
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

test('PUBLIC_URL: control (OAuth issuer), mcp (resource) and the gateway get the same origin, from the domain; APP_URL too', () => {
  const pub = 'https://viz.bitcru.sh'
  assert.equal(publicOrigin(plan), pub)
  const declaring = plan.workers.filter((w) => w.deploy && 'PUBLIC_URL' in gen(w.name).config.vars)
  assert.deepEqual(declaring.map((w) => w.name).sort(), ['viz-control', 'viz-gateway', 'viz-mcp'])
  for (const w of declaring) assert.equal(gen(w.name).config.vars.PUBLIC_URL, pub, w.name)
  assert.equal(gen('viz-mcp').config.vars.APP_URL, pub)
  // A component that disagrees is overridden, with a note.
  const cfg = readJsonc(join(REPO_ROOT, 'mcp/wrangler.jsonc'))
  cfg.vars.PUBLIC_URL = 'https://elsewhere.example'
  cfg.vars.APP_URL = 'https://vis.bitcru.sh'
  const g = gen('viz-mcp', undefined, cfg)
  assert.deepEqual([g.config.vars.PUBLIC_URL, g.config.vars.APP_URL], [pub, pub])
  assert.match(g.summary.warnings.join('\n'), /PUBLIC_URL: .*elsewhere\.example/)
  assert.match(g.summary.warnings.join('\n'), /APP_URL: .*vis\.bitcru\.sh/)
})

test('S13-1: a stage\'s PUBLIC_URL (issuer, resource) and APP_URL are its gateway\'s workers.dev URL, never production\'s', () => {
  const url = stageUrl('trial')
  for (const name of ['viz-control', 'viz-mcp', 'viz-gateway']) {
    const v = gen(name, 'trial').config.vars
    assert.equal(v.PUBLIC_URL, url, name)
    for (const k of ORIGIN_VARS) if (k in v) assert.doesNotMatch(v[k], /bitcru\.sh/, `${name} ${k}`)
  }
  assert.equal(gen('viz-mcp', 'trial').config.vars.APP_URL, url)
  // configure() builds it from the subdomain, and refuses a stage without one (placeholders only with --ids-optional).
  assert.equal(publicOrigin(plan, 'trial', SUB), url)
  assert.throws(() => publicOrigin(plan, 'trial', undefined), /workers\.dev subdomain: none given/)
  assert.throws(() => publicOrigin(plan, 'trial', 'a.b'), /not one DNS label/)
  assert.throws(() => configure({ stage: 'citest', release: 'r', quiet: true, workersSubdomain: 'bad label' }), /not one DNS label/)
  const saved = process.env.VIZ_WORKERS_SUBDOMAIN
  delete process.env.VIZ_WORKERS_SUBDOMAIN
  try {
    assert.throws(() => configure({ stage: 'citest', release: 'r', quiet: true, ids: {} }), /workers\.dev subdomain/)
    configure({ stage: 'citest', release: 'r', quiet: true, idsOptional: true })
    const c = readJsonc(join(GENERATED_DIR, 'stage-citest', 'viz-control.jsonc'))
    assert.equal(c.vars.PUBLIC_URL, `https://viz-citest-gateway.${UNKNOWN_SUBDOMAIN}.workers.dev`)
  } finally {
    process.env.VIZ_WORKERS_SUBDOMAIN = saved
  }
  configure({ stage: 'citest', release: 'r', quiet: true, idsOptional: true })
  for (const n of ['viz-control', 'viz-mcp', 'viz-gateway']) assert.equal(readJsonc(join(GENERATED_DIR, 'stage-citest', `${n}.jsonc`)).vars.PUBLIC_URL, stageUrl('citest'), n)
  // generateWorker without an origin for a stage is refused rather than falling back to production's.
  assert.throws(() => gen('viz-control', 'trial', undefined, { publicUrl: undefined }), /public origin is needed/)
  // and VIZ_STAGE_VARS may not set them.
  assert.throws(() => gen('viz-mcp', 'trial', undefined, { extraVars: { PUBLIC_URL: 'https://vis.bitcru.sh' } }), /set by deploy\/configure\.mjs only/)
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
  // mcp/ binds control's OAuthIntrospection entrypoint, never its Tenant class (review of D44, M-1).
  assert.deepEqual(mcp.crossScript.sort(), ['CONTROL → viz-citest-control', 'OAUTH → viz-citest-control#OAuthIntrospection', 'QUERY → viz-citest-query', 'RULER → viz-citest-ruler'])
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

test('viz-mcp: control\'s OAuthIntrospection entrypoint with props naming viz-mcp, a caller contracts/oauth.ts allows, and no Durable Object class of control\'s (review of D44, M-1)', () => {
  for (const stage of [undefined, 'trial']) {
    const { config, summary } = gen('viz-mcp', stage)
    assert.deepEqual(config.services.find((s) => s.binding === 'OAUTH'), { binding: 'OAUTH', service: stagedName('viz-control', stage), entrypoint: 'OAuthIntrospection', props: { caller: 'viz-mcp' } })
    assert.deepEqual(config.durable_objects?.bindings ?? [], [])
    assert.deepEqual(summary.entrypoints, [{ binding: 'OAUTH', callee: 'viz-control', entrypoint: 'OAuthIntrospection' }])
    assert.ok(!summary.crossScript.some((b) => b.includes(':Tenant')), summary.crossScript.join(', '))
  }
  const contract = readFileSync(join(REPO_ROOT, 'contracts', 'oauth.ts'), 'utf8')
  assert.equal(/OAUTH_INTROSPECTION_ENTRYPOINT = '(\w+)'/.exec(contract)[1], 'OAuthIntrospection')
  const callers = JSON.parse(/OAUTH_INTROSPECTION_CALLERS: readonly string\[\] = (\[[^\]]*\])/.exec(contract)[1].replace(/'/g, '"'))
  assert.deepEqual(callers, ['viz-mcp'])
  // control's main module exports it (callee first), and a control without it is refused.
  const controlMain = join(REPO_ROOT, 'control/src/index.ts')
  assert.ok(exportedNames(controlMain).has('OAuthIntrospection'))
  const e = [{ binding: 'OAUTH', callee: 'viz-control', entrypoint: 'OAuthIntrospection' }]
  checkEntrypoints('viz-mcp', e, new Map([['viz-control', controlMain]]))
  assert.throws(() => checkEntrypoints('viz-mcp', e, new Map([['viz-control', join(REPO_ROOT, 'control/src/tenant.ts')]])), /does not export: a callee ships an entrypoint before or with its first caller/)
})

test('a Durable Object class of another Worker is bound only where workers.json lists it: viz-mcp with control\'s Tenant class is refused', () => {
  const cfg = readJsonc(join(REPO_ROOT, 'mcp/wrangler.jsonc'))
  const withTenant = { ...cfg, durable_objects: { bindings: [{ name: 'TENANT', class_name: 'Tenant', script_name: 'viz-control' }] } }
  assert.throws(() => gen('viz-mcp', undefined, withTenant), /binds viz-control's Durable Object class Tenant, which deploy\/workers.json does not list under viz-mcp's "binds_classes"/)
  assert.throws(() => gen('viz-mcp', 'trial', withTenant), /does not list under viz-mcp's "binds_classes"/)
  // The listed ones, each with a reason, by the owner's canonical name (aliases resolved).
  const listed = Object.fromEntries(plan.workers.filter((w) => w.binds_classes).map((w) => [w.name, Object.keys(w.binds_classes).sort()]))
  assert.deepEqual(listed, { 'viz-ingest': ['viz-publisher:Publisher'], 'viz-query': ['viz-ingest:Ledger', 'viz-ingest:Shard'], 'viz-ruler': ['viz-control:Tenant'], 'viz-gateway': ['viz-control:Tenant'] })
  for (const w of plan.workers) for (const [k, why] of Object.entries(w.binds_classes ?? {})) assert.ok(typeof why === 'string' && why.length > 10, `${w.name} ${k}`)
  // query names the write path by an alias (viz-edge, viz-flush): still matched, and still refused once unlisted.
  const q = readJsonc(join(REPO_ROOT, 'query/wrangler.jsonc'))
  const queryW = { ...worker('viz-query'), binds_classes: { 'viz-ingest:Shard': 'x' } }
  assert.throws(() => generateWorker({ worker: queryW, cfg: q, componentDir: join(REPO_ROOT, 'query'), plan, stage: undefined, release: 'r', ids, outDir: join(GENERATED_DIR, 'production') }), /viz-ingest's Durable Object class Ledger/)
})

// ───────────────────────────── format versions and rollback floors (D69) ─────────────────────────────

test('formats: what each Worker writes and reads is read from the components, into the manifest and each version\'s VIZ_FORMATS', () => {
  const read = readFormats(formatSources(plan.workers))
  const of = (w, f) => read.find((x) => x.worker === w && x.format === f)
  // The ruler's gate (D60): written at ANOMALY_STATE_WRITE, read at 1 and 2.
  const gate = Number(/export const ANOMALY_STATE_WRITE: 1 \| 2 = (\d)/.exec(readFileSync(join(REPO_ROOT, 'ruler/src/schema.ts'), 'utf8'))[1])
  assert.deepEqual(of('viz-ruler', 'store.anomaly-state'), { worker: 'viz-ruler', format: 'store.anomaly-state', writes: gate, reads: [1, 2] })
  assert.deepEqual(of('viz-ruler', 'rpc.alert-update'), { worker: 'viz-ruler', format: 'rpc.alert-update', writes: 1, reads: [1] })
  // viz-ingest: flush's dead letters (writes 2, reads 1 and 2), the janitor's reads of what others write.
  assert.deepEqual(of('viz-ingest', 'r2.dead-letters'), { worker: 'viz-ingest', format: 'r2.dead-letters', writes: 2, reads: [1, 2] })
  assert.deepEqual(of('viz-ingest', 'kv.settings'), { worker: 'viz-ingest', format: 'kv.settings', writes: null, reads: [1] })
  assert.deepEqual(of('viz-ingest', 'r2.compaction-inputs'), { worker: 'viz-ingest', format: 'r2.compaction-inputs', writes: 1, reads: [1] })
  assert.ok(of('viz-control', 'kv.settings') && of('viz-publisher', 'iceberg.metadata'))
  // What other Workers read of control's records and answers (review of D69, M-1 (c)): a reader's constant, or version 1.
  assert.deepEqual(of('viz-query', 'kv.key'), { worker: 'viz-query', format: 'kv.key', writes: null, reads: [1] })
  assert.deepEqual(of('viz-query', 'kv.settings'), { worker: 'viz-query', format: 'kv.settings', writes: null, reads: [1] })
  assert.deepEqual(of('viz-ruler', 'rpc.notification-target'), { worker: 'viz-ruler', format: 'rpc.notification-target', writes: null, reads: [1] })
  assert.deepEqual(of('viz-mcp', 'rpc.oauth'), { worker: 'viz-mcp', format: 'rpc.oauth', writes: null, reads: [1] })
  // The publisher's `read.…` entries name what another component writes: not recorded.
  assert.deepEqual(read.filter((x) => x.format.startsWith('read.')), [])
  assert.deepEqual([...new Set(read.map((x) => x.worker))].sort(), ['viz-control', 'viz-ingest', 'viz-mcp', 'viz-publisher', 'viz-query', 'viz-ruler'])
  const m = configure({ stage: 'citest', release: 'r1', idsOptional: true, quiet: true })
  for (const w of m.workers.filter((x) => x.deploy)) {
    const cfg = readJsonc(join(REPO_ROOT, w.config))
    const mine = read.filter((x) => x.worker === w.canonical)
    assert.deepEqual(w.formats, mine.map(({ format, writes, reads }) => ({ format, writes, reads })), w.name)
    // Every deployed Worker carries a complete VIZ_FORMATS, the gateway's empty.
    assert.equal(cfg.vars[FORMATS_VAR], formatsVar(mine), w.name)
    assert.equal(JSON.parse(cfg.vars[FORMATS_VAR]).complete, true, w.name)
  }
  assert.equal(readJsonc(join(REPO_ROOT, m.workers.find((w) => w.canonical === 'viz-gateway').config)).vars[FORMATS_VAR], '{"v":1,"complete":true,"formats":{}}')
  assert.deepEqual(JSON.parse(readJsonc(join(REPO_ROOT, m.workers.find((w) => w.canonical === 'viz-ruler').config)).vars[FORMATS_VAR]).formats['store.anomaly-state'], { w: gate, r: [1, 2] })
})

test('formats: every FORMATS map in the sources of a deployed component is declared in workers.json, so no written format goes unrecorded', () => {
  const declared = new Set(plan.workers.flatMap((w) => w.formats?.writes ?? []))
  const dirs = ['contracts', 'publisher', 'stack', 'edge', 'shard', 'ledger', 'flush', 'compact', 'janitor', 'control', 'query', 'ruler', 'mcp']
  const found = []
  for (const d of dirs) {
    const src = join(REPO_ROOT, d, d === 'contracts' ? '' : 'src')
    if (!existsSync(src)) continue
    for (const f of readdirSync(src, { recursive: true }).filter((x) => String(x).endsWith('.ts'))) {
      if (/export const FORMATS = \{/.test(readFileSync(join(src, f), 'utf8'))) found.push(`${d}/${d === 'contracts' ? '' : 'src/'}${f}#FORMATS`)
    }
  }
  assert.ok(found.length >= 6, found.join(', '))
  for (const f of found) assert.ok(declared.has(f), `${f} is not under any Worker's formats.writes in deploy/workers.json`)
})

test('formats: every deployed Worker declares what it reads; one without a declaration is refused (review of D69, M-1 (c))', () => {
  for (const w of plan.workers.filter((x) => x.deploy !== false)) assert.ok(w.formats !== undefined, `${w.name} has no "formats" in deploy/workers.json`)
  const without = { ...plan, workers: plan.workers.map((w) => (w.name === 'viz-query' ? { ...w, formats: undefined } : w)) }
  assert.throws(() => configure({ stage: 'citest', release: 'r1', idsOptional: true, quiet: true, plan: without }), /deploy\/workers\.json viz-query: no "formats"\. Every deployed Worker says completely what it reads/)
})

/**
 * What a Worker's code reads, from the sources it is bundled from (esbuild's list of inputs, as
 * wrangler bundles its main; packages left out): each signature names a format another Worker writes.
 */
const READ_SIGNATURES = [
  [/`key:\$\{/, 'kv.key'],
  [/`pool:\$\{/, 'kv.pool'],
  [/`(?:limits|retention):\$\{/, 'kv.settings'],
  [/`revocation:\$\{/, 'kv.revocation'],
  [/\bKEY_RE\b/, 'credential.api-key'],
  [/\bnotificationTarget\(/, 'rpc.notification-target'],
  [/\bserviceKey\(/, 'rpc.service-key'],
  [/\bintrospectAccessToken\(/, 'rpc.oauth'],
  [/\bparseCredential\(/, 'credential.oauth'],
]

test('formats: each Worker declares the formats of control\'s KV records, API key and RPC answers that its bundled sources read (review of D69, M-1 (c))', async () => {
  const { buildSync } = (await import('node:module')).createRequire(join(REPO_ROOT, 'deploy', 'package.json'))('esbuild')
  const read = readFormats(formatSources(plan.workers))
  const found = []
  for (const w of plan.workers.filter((x) => x.deploy !== false)) {
    const cfg = readJsonc(join(REPO_ROOT, w.component, 'wrangler.jsonc'))
    const r = buildSync({ entryPoints: [join(REPO_ROOT, w.component, cfg.main)], absWorkingDir: REPO_ROOT, bundle: true, write: false, metafile: true, platform: 'neutral', format: 'esm', packages: 'external', external: ['cloudflare:*', '*.wasm', 'node:*'], logLevel: 'silent', loader: { '.wasm': 'empty' } })
    const sources = Object.keys(r.metafile.inputs).map((f) => readFileSync(join(REPO_ROOT, f), 'utf8'))
    for (const [re, format] of READ_SIGNATURES) {
      if (!sources.some((t) => re.test(t))) continue
      found.push(`${w.name} ${format}`)
      assert.ok(read.some((x) => x.worker === w.name && x.format === format), `${w.name}'s sources read ${format} (${re}), and deploy/workers.json does not declare it`)
    }
  }
  // The readers this pins (a change to a component that adds or drops one shows here).
  for (const f of ['viz-ingest kv.pool', 'viz-query kv.pool', 'viz-query kv.settings', 'viz-ruler rpc.service-key', 'viz-mcp rpc.oauth', 'viz-mcp credential.oauth']) assert.ok(found.includes(f), `${f}: ${found.join(', ')}`)
})

test('formats: a Worker that writes a version it does not read, or one format at two versions, is refused', () => {
  const dir = join(GENERATED_DIR, 'test-formats')
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(join(dir, 'a.ts'), "export const FORMATS = { 'x.one': 2, 'read.other': 3 } as const\nexport const ONLY_1 = [1] as const\n")
    writeFileSync(join(dir, 'b.ts'), "export const FORMATS = { 'x.one': 3 } as const\nexport const READS = { 'x.one': [2, 3], 'x.two': [1] } as const\n")
    const src = (w, f) => formatSources([{ name: w, formats: f }])
    const rel = (x) => `deploy/generated/test-formats/${x}`
    assert.throws(() => readFormats(src('w', { writes: [rel('a.ts#FORMATS')], reads_of: { 'x.one': rel('a.ts#ONLY_1') } })), /w: writes x\.one version 2 but reads only 1: a release must read what it writes/)
    assert.throws(() => readFormats(src('w', { writes: [rel('a.ts#FORMATS'), rel('b.ts#FORMATS')] })), /x\.one is written at version 2 .* and at 3/)
    // Read lists intersect; `read.…` entries are skipped; a format only read has writes null.
    assert.deepEqual(readFormats(src('w', { writes: [rel('b.ts#FORMATS')], reads: [rel('b.ts#READS')] })), [{ worker: 'w', format: 'x.one', writes: 3, reads: [2, 3] }, { worker: 'w', format: 'x.two', writes: null, reads: [1] }])
    assert.deepEqual(readFormats(src('w', { writes: [rel('a.ts#FORMATS')] })), [{ worker: 'w', format: 'x.one', writes: 2, reads: [2] }])
    // Two read lists of one format in one Worker: it reads what both read. None in common: refused.
    assert.throws(() => readFormats(src('w', { reads: [rel('b.ts#READS')], reads_of: { 'x.one': rel('a.ts#ONLY_1') } })), /w: the read lists of x\.one have no version in common/)
    assert.throws(() => readFormats(src('w', { writes: [rel('a.ts#NOPE')] })), /does not export NOPE/)
    assert.throws(() => formatSources([{ name: 'w', formats: { write: [] } }]), /"write" is not one of/)
    // One version (a reader's constant) reads that version; reads_v1 reads version 1 and says where.
    writeFileSync(join(dir, 'c.ts'), 'export const V = 2\n')
    assert.deepEqual(readFormats(src('w', { reads_of: { 'x.one': rel('c.ts#V') }, reads_v1: { 'x.two': 'c.ts: somewhere' } })), [{ worker: 'w', format: 'x.one', writes: null, reads: [2] }, { worker: 'w', format: 'x.two', writes: null, reads: [1] }])
    assert.throws(() => readFormats(src('w', { writes: [rel('b.ts#FORMATS')], reads_v1: { 'x.one': 'reads 1 only' } })), /w: writes x\.one version 3 but reads only/)
    assert.throws(() => formatSources([{ name: 'w', formats: { reads_v1: { 'x.one': '' } } }]), /say where the code reads it/)
    assert.throws(() => formatSources([{ name: 'w', formats: { reads_v1: { '*': 'x' } } }]), /is not a format name/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('floors: viz-query and viz-ingest are stamped at the floor of INGEST_SIGNALS on the evidence of their sources; a declaration the code does not bear out is refused', () => {
  const rules = floorRules(plan, 'citest')
  const m = configure({ stage: 'citest', release: 'r1', idsOptional: true, quiet: true })
  for (const w of m.workers.filter((x) => x.deploy)) {
    const stamped = ['viz-query', 'viz-ingest'].includes(w.canonical)
    const at = stamped ? ['signal-data'] : w.canonical === 'viz-control' ? ['oauth-public'] : []
    assert.deepEqual(w.floors, at, w.name)
    assert.equal(readJsonc(join(REPO_ROOT, w.config)).vars[FLOORS_VAR], at.length ? JSON.stringify({ v: 1, at }) : undefined, w.name)
  }
  // Evidence missing: an error at configure, never a stamp.
  const bad = floorRules({ ...plan, rollback_floors: [{ ...plan.rollback_floors[0], floors: { ...plan.rollback_floors[0].floors, 'viz-query': { evidence: ['query/src/shards.ts#noSuchExport'], why: 'x' } } }] }, 'citest')
  assert.throws(() => stampedFloors(bad, 'viz-query', exportedNames), /viz-query is declared at or above its floor on the evidence of query\/src\/shards\.ts#noSuchExport, which does not export it/)
  assert.deepEqual(stampedFloors(rules, 'viz-publisher', exportedNames), [], 'the publisher is judged by its schema, not stamped')
  // A schema floor must name a class the Worker has.
  const schemas = readSchemas(schemaSources(plan.workers))
  checkFloorSchemas(rules, schemas)
  const wrong = floorRules({ ...plan, rollback_floors: [{ ...plan.rollback_floors[0], floors: { 'viz-publisher': { schema: 'publisher.Nope', at_least: 4, why: 'x' } } }] }, 'citest')
  assert.throws(() => checkFloorSchemas(wrong, schemas), /names schema publisher\.Nope, which none of its classes has \(publisher\.Publisher\)/)
  // configure() itself runs that check, before writing anything.
  const wrongPlan = { ...plan, rollback_floors: [{ ...plan.rollback_floors[0], floors: { 'viz-publisher': { schema: 'publisher.Nope', at_least: 4, why: 'x' } } }] }
  assert.throws(() => configure({ stage: 'citest', release: 'r1', idsOptional: true, quiet: true, plan: wrongPlan }), /names schema publisher\.Nope/)
})

test('floors: the publisher\'s floor, schema 4, is the release that first reads the span and log tables (the frozen releases in publisher/test/)', () => {
  const at = (module) => readSchemas([{ worker: 'viz-publisher', class: 'Publisher', module, name: 'PUBLISHER_SCHEMA' }])[0].latest
  const floor = plan.rollback_floors[0].floors['viz-publisher']
  assert.deepEqual([floor.schema, floor.at_least], ['publisher.Publisher', 4])
  // The release before D64 (test/n1): schema 3, and its log reader knows the metric tables only.
  assert.equal(at('publisher/test/n1/schema.ts'), 3)
  const n1 = readFileSync(join(REPO_ROOT, 'publisher/test/n1/log.ts'), 'utf8')
  assert.match(n1, /const TABLES: ReadonlySet<string> = new Set<Table>\(\['metric_samples', 'metric_series'\]\)/)
  assert.doesNotMatch(n1, /'spans'|'trace_index'|'logs'/)
  // D64 (test/d64): schema 4, and it reads the three span and log tables (without publishing them).
  assert.equal(at('publisher/test/d64/schema.ts'), 4)
  const { values: [d64] } = evaluateExports([{ module: 'publisher/test/d64/log.ts', name: 'UNPUBLISHED_TABLES' }])
  assert.deepEqual([...d64], ['spans', 'trace_index', 'logs'])
  // This release: at or above the floor (D67's migration 5 is additive), and it publishes them.
  assert.ok(at('publisher/src/schema.ts') >= 4)
  const { values: [now] } = evaluateExports([{ module: 'publisher/src/log.ts', name: 'PUBLISHED_TABLES' }])
  for (const t of ['spans', 'trace_index', 'logs']) assert.ok([...now].includes(t), t)
})

// ───────────────────────────── rate limits in front of OAuth (D70; review of D70, M-2, m-8) ─────────────────────────────

const controlCfg = () => readJsonc(join(REPO_ROOT, 'control/wrangler.jsonc'))
const withLimits = (f) => {
  const c = controlCfg()
  c.ratelimits = f(c.ratelimits)
  return c
}

test('D70 gate: the bindings and the period are read from control\'s source; control/wrangler.jsonc declares all six with the proposed limits, period 60, placeholder ids', () => {
  const g = gates.get('viz-control')
  assert.deepEqual(g.required, ['OAUTH_RL_SOURCE', 'OAUTH_RL_SOURCE_48', 'OAUTH_RL_CREDENTIAL', 'OAUTH_RL_TENANT', 'OAUTH_RL_BEARER', 'OAUTH_RL_BEARER_TENANT'])
  assert.equal(g.period, 60)
  assert.equal(g.publicVar, 'OAUTH_PUBLIC')
  assert.deepEqual([...gates.keys()], ['viz-control'])
  assert.deepEqual(controlCfg().ratelimits.map((r) => [r.name, r.namespace_id, r.simple.limit, r.simple.period]), [
    ['OAUTH_RL_SOURCE', '0', 120, 60], ['OAUTH_RL_SOURCE_48', '0', 1200, 60], ['OAUTH_RL_CREDENTIAL', '0', 5, 60],
    ['OAUTH_RL_TENANT', '0', 6000, 60], ['OAUTH_RL_BEARER', '0', 1200, 60], ['OAUTH_RL_BEARER_TENANT', '0', 30000, 60],
  ])
})

test('D70 gate: production with all six and allocated ids passes; each placeholder id is replaced by the deployment\'s own; OAUTH_PUBLIC is set and viz-control is stamped at oauth-public', () => {
  const { config, summary } = gen('viz-control')
  assert.deepEqual(config.ratelimits.map((r) => r.namespace_id), ['7000', '7001', '7002', '7003', '7004', '7005'])
  assert.equal(config.vars.OAUTH_PUBLIC, '1')
  assert.deepEqual(summary.oauth, { required: RL, period: 60, ratelimits: Object.fromEntries(RL.map((n, i) => [n, String(7000 + i)])), withoutRateLimits: false, public: true })
  // A stage gets ids of its own, never production's; OAUTH_PUBLIC only when asked.
  const t = gen('viz-control', 'trial')
  assert.deepEqual(t.config.ratelimits.map((r) => r.namespace_id), ['7100', '7101', '7102', '7103', '7104', '7105'])
  assert.equal(t.config.vars.OAUTH_PUBLIC, undefined)
  assert.equal(gen('viz-control', 'trial', undefined, { oauthPublic: true }).config.vars.OAUTH_PUBLIC, '1')
  // A stage with no ids of its own recorded is refused, even with production's recorded (ids are by deployed name).
  assert.throws(() => gen('viz-control', 'other', undefined, { ids: { ...ids, 'viz-other-config': 'd'.repeat(32) } }), /no namespace_id recorded for viz-other-control\/OAUTH_RL_SOURCE; run deploy\/resources\.mjs ensure --stage other first/)
  const m = configure({ stage: 'citest', release: 'r1', idsOptional: true, quiet: true })
  const c = m.workers.find((w) => w.canonical === 'viz-control')
  assert.deepEqual(c.floors, ['oauth-public'])
  assert.equal(m.idsOptional, true, 'the manifest says its ids are placeholders (release.mjs refuses it)')
  assert.deepEqual(readJsonc(join(REPO_ROOT, c.config)).ratelimits.map((r) => r.namespace_id), ['0', '0', '0', '0', '0', '0'])
})

test('D70 gate: production without the block is refused, naming all six; with five of the six, naming the sixth', () => {
  const none = controlCfg()
  delete none.ratelimits
  assert.throws(() => gen('viz-control', undefined, none), /production viz-control without the rate-limit bindings OAUTH_RL_SOURCE, OAUTH_RL_SOURCE_48, OAUTH_RL_CREDENTIAL, OAUTH_RL_TENANT, OAUTH_RL_BEARER, OAUTH_RL_BEARER_TENANT: OAuth is not served/)
  for (const gone of RL) {
    const five = withLimits((l) => l.filter((r) => r.name !== gone))
    assert.throws(() => gen('viz-control', undefined, five), new RegExp(`production viz-control without the rate-limit binding ${gone}: `), gone)
  }
  // The command itself exits non-zero, before anything is uploaded: production without allocated ids (resources.mjs not run).
  const dir = mkdtempSync(join(tmpdir(), 'viz-configure-gate-'))
  try {
    writeFileSync(join(dir, 'resources.json'), JSON.stringify({ kv_namespaces: { 'viz-config': 'a'.repeat(32) } }))
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'deploy', 'configure.mjs'), '--release', 'r1', '--quiet'], { encoding: 'utf8', env: { ...process.env, VIZ_RESOURCES_FILE: join(dir, 'resources.json'), VIZ_GENERATED_DIR: join(dir, 'generated') } })
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stderr, /configure: no namespace_id recorded for viz-control\/OAUTH_RL_SOURCE; run deploy\/resources\.mjs ensure first/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('D70 gate: a period of 10, a limit that is not a positive integer, a name control does not list, a binding twice, an unknown key, a placeholder that survives, an id outside viz\'s range and two bindings with one id are refused', () => {
  const at = (i, patch) => withLimits((l) => l.map((r, j) => (j === i ? { ...r, ...patch(r) } : r)))
  assert.throws(() => gen('viz-control', undefined, at(2, (r) => ({ simple: { ...r.simple, period: 10 } }))), /OAUTH_RL_CREDENTIAL\): period must be 60, not 10/)
  for (const limit of [0, -5, 1.5, '5']) assert.throws(() => gen('viz-control', undefined, at(0, (r) => ({ simple: { ...r.simple, limit } }))), /limit must be a positive integer/, String(limit))
  assert.throws(() => gen('viz-control', undefined, at(0, () => ({ name: 'OAUTH_RL_CLIENT' }))), /"OAUTH_RL_CLIENT" is not one of viz-control's rate-limit bindings/)
  assert.throws(() => gen('viz-control', undefined, withLimits((l) => [...l, l[0]])), /OAUTH_RL_SOURCE is bound twice/)
  assert.throws(() => gen('viz-control', undefined, at(0, () => ({ extra: 1 }))), /"extra" is not something configure\.mjs knows how to deploy/)
  const ids0 = { ...ratelimitIds, 'viz-control/OAUTH_RL_TENANT': '0' }
  assert.throws(() => gen('viz-control', undefined, undefined, { ratelimitIds: ids0 }), /viz-control\/OAUTH_RL_TENANT: recorded namespace_id "0" is not in viz's range 7000–7999/)
  assert.throws(() => gen('viz-control', undefined, undefined, { ratelimitIds: { ...ratelimitIds, 'viz-control/OAUTH_RL_TENANT': '1001' } }), /"1001" is not in viz's range/)
  assert.throws(() => gen('viz-control', undefined, undefined, { ratelimitIds: { ...ratelimitIds, 'viz-control/OAUTH_RL_TENANT': '7000' } }), /OAUTH_RL_TENANT and OAUTH_RL_SOURCE have the same namespace_id 7000/)
  // Placeholders stay only with --ids-optional; and then a deploy refuses the manifest.
  assert.throws(() => gen('viz-control', undefined, undefined, { ratelimitIds: {} }), /no namespace_id recorded for viz-control\/OAUTH_RL_SOURCE/)
  assert.deepEqual(gen('viz-control', undefined, undefined, { ratelimitIds: {}, idsOptional: true }).summary.oauth.ratelimits, Object.fromEntries(RL.map((n) => [n, null])))
  // A Worker without an oauth gate may not carry ratelimits at all.
  const q = readJsonc(join(REPO_ROOT, 'query/wrangler.jsonc'))
  assert.throws(() => gen('viz-query', undefined, { ...q, ratelimits: controlCfg().ratelimits }), /declares no "oauth" gate for viz-query/)
})

test('D70 gate: a stage without the bindings passes only with --oauth-without-rate-limits, which drops them and is recorded; production refuses the flag; --oauth-public needs the bindings', () => {
  const none = controlCfg()
  delete none.ratelimits
  assert.throws(() => gen('viz-control', 'trial', none), /stage trial viz-control without the rate-limit bindings .* or configure the stage with --oauth-without-rate-limits/)
  const ok = gen('viz-control', 'trial', none, { oauthWithoutRateLimits: true })
  assert.equal(ok.config.ratelimits, undefined)
  assert.deepEqual(ok.summary.oauth, { required: RL, period: 60, ratelimits: {}, withoutRateLimits: true, public: false })
  // With the block present the flag drops it (a stage that runs without them, as asked).
  assert.equal(gen('viz-control', 'trial', undefined, { oauthWithoutRateLimits: true }).config.ratelimits, undefined)
  assert.throws(() => gen('viz-control', undefined, undefined, { oauthWithoutRateLimits: true }), /--oauth-without-rate-limits is for a stage only/)
  assert.throws(() => configure({ release: 'r1', idsOptional: true, quiet: true, oauthWithoutRateLimits: true }), /is for a stage only/)
  assert.throws(() => gen('viz-control', 'trial', undefined, { oauthWithoutRateLimits: true, oauthPublic: true }), /--oauth-public and --oauth-without-rate-limits together/)
  const m = configure({ stage: 'citest', release: 'r1', idsOptional: true, quiet: true, oauthWithoutRateLimits: true })
  assert.equal(m.oauthWithoutRateLimits, true)
  assert.equal(m.workers.find((w) => w.canonical === 'viz-control').oauth.withoutRateLimits, true)
  configure({ stage: 'citest', release: 'r1', idsOptional: true, quiet: true })
})

test('D70: OAUTH_PUBLIC is set by configure only: a component config or VIZ_STAGE_VARS that sets it is refused', () => {
  const c = controlCfg()
  c.vars.OAUTH_PUBLIC = '1'
  assert.throws(() => gen('viz-control', 'trial', c), /OAUTH_PUBLIC is set by deploy\/configure\.mjs only/)
  assert.throws(() => gen('viz-control', 'trial', undefined, { extraVars: { OAUTH_PUBLIC: '' } }), /OAUTH_PUBLIC is set by deploy\/configure\.mjs only/)
})

test('m-8: placement is refused on viz-control and viz-mcp (D70 counts per location); viz-query keeps its Smart Placement', () => {
  assert.deepEqual(plan.workers.filter((w) => w.no_placement).map((w) => w.name), ['viz-control', 'viz-mcp'])
  for (const name of ['viz-control', 'viz-mcp']) {
    const cfg = readJsonc(join(REPO_ROOT, worker(name).component, 'wrangler.jsonc'))
    for (const stage of [undefined, 'trial']) assert.throws(() => gen(name, stage, { ...cfg, placement: { mode: 'smart' } }), new RegExp(`"placement" is refused on ${name}: `), `${name} ${stage}`)
  }
  assert.deepEqual(gen('viz-query').config.placement, readJsonc(join(REPO_ROOT, 'query/wrangler.jsonc')).placement)
})

test('D70 round 2: viz-control declares kv.oauth-dead 1, its list of dead credentials in CONFIG (viz-config), written and read by it alone', () => {
  const read = readFormats(formatSources(plan.workers))
  assert.deepEqual(read.filter((x) => x.format === 'kv.oauth-dead'), [{ worker: 'viz-control', format: 'kv.oauth-dead', writes: 1, reads: [1] }])
  assert.equal(plan.resources.kv.CONFIG, 'viz-config')
})

test('oauth-public: the rule parses, viz-control is its writer and its one floor, on the evidence of four exports only D70\'s third round has all of; a viz-control without one is refused at configure', () => {
  const rule = floorRules(plan, undefined).find((r) => r.name === 'oauth-public')
  assert.deepEqual([rule.writer, rule.var, rule.servingBelow], ['viz-control', 'OAUTH_PUBLIC', 'forward-only'])
  assert.deepEqual(rule.floors.map((f) => [f.worker, f.evidence.map((e) => `${e.module}#${e.name}`)]), [['viz-control', ['contracts/oauth.ts#CREDENTIAL_LAYOUT', 'contracts/oauth.ts#DEAD_INACTIVE_REASONS', 'control/src/deadlist.ts#recordDead', 'control/src/ratelimit.ts#LISTED']]])
  assert.deepEqual(stampedFloors(floorRules(plan, undefined), 'viz-control', exportedNames), ['oauth-public'])
  const r = plan.rollback_floors.find((x) => x.name === 'oauth-public')
  const bad = floorRules({ ...plan, rollback_floors: [{ ...r, floors: { 'viz-control': { ...r.floors['viz-control'], evidence: ['control/src/deadlist.ts#recordDeadX'] } } }] }, undefined)
  assert.throws(() => stampedFloors(bad, 'viz-control', exportedNames), /viz-control is declared at or above its floor on the evidence of control\/src\/deadlist\.ts#recordDeadX, which does not export it/)
  assert.throws(() => floorRules({ ...plan, rollback_floors: [{ ...r, serving_below_floor: 'allow' }] }, undefined), /serving_below_floor is "refuse" \(the default\) or "forward-only"/)
})
