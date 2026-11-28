// node --test deploy/test/: D75's custom domains through the real configure.mjs and release.mjs, against
// the fake account (test/fake-account.mjs). viz-gateway holds viz.bitcru.sh and vis.bitcru.sh; a release
// that would detach vis, take over another Worker's hostname, or deploy hostnames other than the plan's is
// refused before anything is uploaded. Nothing reaches Cloudflare. Production serves the web app (D74):
// each release here is configured with the fixture build staged as deploy/app.mjs stages it, and is the
// first with the app over fb77292, so it carries a stage-evidence entry for this checkout's serving code
// (D74 point 6); the last test holds the two gates apart (D75 with D74).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const tmp = mkdtempSync(join(tmpdir(), 'viz-domains-'))
process.env.VIZ_GENERATED_DIR = join(tmp, 'generated')
process.env.VIZ_RESOURCES_FILE = join(tmp, 'resources.json')
mkdirSync(process.env.VIZ_GENERATED_DIR, { recursive: true })
const { DEPLOY_DIR, REPO_ROOT, readJsonc } = await import('../lib/common.mjs')
const { appBuilt, callsLike, captured, installFakeAccount, serving } = await import('./fake-account.mjs')
const { configure: configureOnly } = await import('../configure.mjs')
const { APP_STAGE_BY_HAND, deploy: deployOnly, planOnly: planOnlyOnly } = await import('../release.mjs')
const { customDomainProblems, customDomainsOf, domainsNow } = await import('../lib/domains.mjs')
const A = await import('../lib/app.mjs')

const FB = JSON.parse(readFileSync(join(DEPLOY_DIR, 'test', 'fixtures', 'production-fb77292.json'), 'utf8'))
const account = installFakeAccount(tmp)
const { writeState, readState } = account
after(() => {
  account.restore()
  rmSync(tmp, { recursive: true, force: true })
})

const KEY = 'OAUTH_CLIENT_KEY'
const vid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const RL = ['OAUTH_RL_SOURCE', 'OAUTH_RL_SOURCE_48', 'OAUTH_RL_CREDENTIAL', 'OAUTH_RL_TENANT', 'OAUTH_RL_BEARER', 'OAUTH_RL_BEARER_TENANT']
writeFileSync(process.env.VIZ_RESOURCES_FILE, JSON.stringify({ kv_namespaces: { 'viz-config': 'c'.repeat(32) }, ratelimit_namespaces: Object.fromEntries(RL.map((n, i) => [`viz-control/${n}`, String(7000 + i)])) }))

/** Production serving (from the fb77292 fixture's Workers and vars), with the account's custom domains `domains`. */
function production(domains) {
  let n = 0
  const workers = {}
  for (const w of FB.workers) {
    const v1 = { id: vid(++n), number: 1, tag: FB.release, message: `viz ${FB.release}`, vars: w.vars, secrets: w.name === 'viz-control' ? { [KEY]: `a-key-${'k'.repeat(40)}` } : {} }
    workers[w.name] = { migrationTag: w.migrationTag, versions: [v1], deployment: [{ version_id: v1.id, percentage: 100 }], active: [v1.id] }
  }
  return { calls: [], counter: 1000, workers, domains }
}

// The web app (D74): every production release here is configured with the fixture build staged for it,
// and is judged against a stage-evidence file of this test's own (complete for this checkout's serving
// code unless a test says otherwise).
const PLAN = JSON.parse(readFileSync(join(DEPLOY_DIR, 'workers.json'), 'utf8'))
const fingerprint = () => A.servingFingerprint({ repoRoot: REPO_ROOT, serve: A.readServe(join(REPO_ROOT, A.appWorker(PLAN).app.serve)), worker: A.appWorker(PLAN).worker }).fingerprint
const entry = () => ({ serving: fingerprint(), stage: 'pretrial', release: 'a'.repeat(40), deployedAt: '2026-11-28T10:00:00.000Z', smoke: { passed: true, app: true, requests: 30 }, byHand: Object.fromEntries(APP_STAGE_BY_HAND.map((n) => [n, { result: 'pass', note: `seen ${n}` }])), by: 'a test' })
const EVIDENCE = join(tmp, 'app-stage-evidence.json')
writeFileSync(EVIDENCE, JSON.stringify({ v: 1, evidence: [entry()] }))
const NO_EVIDENCE = join(tmp, 'no-app-stage-evidence.json')
const configure = (opts) => (appBuilt({ stage: opts.stage ?? null, release: opts.release }), configureOnly(opts))
const deploy = (opts) => deployOnly({ appStageEvidence: EVIDENCE, ...opts })
const planOnly = (opts) => planOnlyOnly({ appStageEvidence: EVIDENCE, ...opts })

const VIS = { hostname: 'vis.bitcru.sh', service: 'viz-gateway', zone_name: 'bitcru.sh' }
const OTHER = { hostname: 'blog.bitcru.sh', service: 'unrelated-app', zone_name: 'bitcru.sh' }
const gatewayConfigFile = () => join(process.env.VIZ_GENERATED_DIR, 'production', 'viz-gateway.jsonc')

test('production: the gateway is deployed holding viz first and vis kept; its triggers are applied from that config; no other hostname is touched', async () => {
  writeState(production([VIS, OTHER]))
  const m = configure({ release: 'rel-d75', quiet: true })
  assert.deepEqual([m.domain, m.domainAliases], ['viz.bitcru.sh', ['vis.bitcru.sh']])
  const plan = await captured(() => planOnly({ stage: undefined }))
  assert.equal(plan.result?.exit, 0, plan.log)
  const r = await captured(() => deploy({ stage: undefined }))
  assert.equal(r.result?.exit, 0, r.log)
  const s = readState()
  // `wrangler triggers deploy --config <the generated gateway config>`: that config names both, viz first.
  const triggers = callsLike(s, 'triggers deploy').filter((c) => c.argv.includes(gatewayConfigFile()))
  assert.equal(triggers.length, 1)
  assert.deepEqual(customDomainsOf(readJsonc(gatewayConfigFile())), ['viz.bitcru.sh', 'vis.bitcru.sh'])
  // No other Worker's config carries a route (their triggers deploy touches no hostname).
  for (const w of m.workers.filter((x) => x.deploy && !x.public)) assert.equal(readJsonc(join(REPO_ROOT, w.config)).routes, undefined, w.name)
  const gw = serving(s, 'viz-gateway')
  assert.equal(gw.vars.PUBLIC_URL, 'https://viz.bitcru.sh')
  assert.deepEqual(JSON.parse(gw.vars.VIZ_HOST_ALIASES).map((a) => a.host), ['vis.bitcru.sh'])
  assert.equal(serving(s, 'viz-control').vars.PUBLIC_URL, 'https://viz.bitcru.sh')
  assert.equal(serving(s, 'viz-mcp').vars.PUBLIC_URL, 'https://viz.bitcru.sh')
})

test('a release that would detach vis.bitcru.sh (a config listing only viz) is refused before anything is uploaded', async () => {
  writeState(production([VIS]))
  configure({ release: 'rel-detach', quiet: true })
  // A generated config that lost the alias (as a regression in configure.mjs, or a hand edit, would make it).
  const file = gatewayConfigFile()
  const cfg = readJsonc(file)
  cfg.routes = [{ pattern: 'viz.bitcru.sh', custom_domain: true }]
  writeFileSync(file, JSON.stringify(cfg))
  const r = await captured(() => deploy({ stage: undefined }))
  assert.equal(r.result?.exit, 3, r.log)
  assert.match(r.log, /viz-gateway holds vis\.bitcru\.sh now, and this release does not list it: wrangler would detach it/)
  assert.match(r.log, /gives it the custom domains \[viz\.bitcru\.sh\], not the manifest's \[viz\.bitcru\.sh, vis\.bitcru\.sh\]/)
  assert.equal(readState().calls.length, 0, 'nothing uploaded or promoted')
  const plan = await captured(() => planOnly({ stage: undefined }))
  assert.equal(plan.result?.exit, 3, plan.log)
})

test('a release that would take over another Worker\'s hostname is refused; so is one the plan does not name', async () => {
  writeState(production([VIS, { hostname: 'viz.bitcru.sh', service: 'unrelated-app' }]))
  configure({ release: 'rel-steal', quiet: true })
  const r = await captured(() => deploy({ stage: undefined }))
  assert.equal(r.result?.exit, 3, r.log)
  assert.match(r.log, /viz\.bitcru\.sh is a custom domain of unrelated-app, not viz-gateway: wrangler, run by the deploy, would take it over/)
  assert.equal(readState().calls.length, 0)
  // A hand edit adding a hostname of the zone that the plan does not name.
  writeState(production([VIS]))
  configure({ release: 'rel-extra', quiet: true })
  const cfg = readJsonc(gatewayConfigFile())
  cfg.routes.push({ pattern: 'blog.bitcru.sh', custom_domain: true })
  writeFileSync(gatewayConfigFile(), JSON.stringify(cfg))
  const e = await captured(() => deploy({ stage: undefined }))
  assert.equal(e.result?.exit, 3, e.log)
  assert.match(e.log, /not the manifest's/)
})

test('customDomainProblems: stages hold none, only the public Worker holds any, zone routes refused; domains are read for production only', async () => {
  const cfgs = {
    gw: { routes: [{ pattern: 'viz.bitcru.sh', custom_domain: true }, { pattern: 'vis.bitcru.sh', custom_domain: true }] },
    q: {},
  }
  const workers = [{ name: 'viz-gateway', public: true, deploy: true, config: 'gw' }, { name: 'viz-query', deploy: true, config: 'q' }]
  const manifest = { stage: null, domain: 'viz.bitcru.sh', domainAliases: ['vis.bitcru.sh'], workers }
  const of = (w) => cfgs[w.config]
  assert.deepEqual(customDomainProblems(manifest, of, [VIS, OTHER]), [])
  assert.deepEqual(customDomainProblems(manifest, of, null), [])
  cfgs.q = { routes: [{ pattern: 'viz.bitcru.sh/api/*', zone_name: 'bitcru.sh' }] }
  assert.match(customDomainProblems(manifest, of, [])[0], /viz-query: only the public Worker holds a hostname/)
  cfgs.q = {}
  cfgs.gw.route = 'viz.bitcru.sh/*'
  assert.match(customDomainProblems(manifest, of, [])[0], /zone route/)
  delete cfgs.gw.route
  const stage = { stage: 'trial', domain: null, domainAliases: [], workers: [{ ...workers[0], name: 'viz-trial-gateway' }] }
  assert.deepEqual(customDomainProblems(stage, () => ({}), null), [])
  assert.match(customDomainProblems(stage, () => cfgs.gw, null)[0], /a stage's generated config has routes/)
  let asked = 0
  const list = async () => (asked++, [])
  assert.equal(await domainsNow(stage, list), null)
  assert.deepEqual(await domainsNow(manifest, list), [])
  assert.equal(asked, 1)
})

test('D75 with D74: the hostnames and the first-release stage evidence are two gates; neither excuses the other, and a stage\'s evidence (no custom domain) is evidence for production (two)', async () => {
  // The serving fingerprint is the same for a stage configured without any custom domain and for
  // production with both: the hosts are configuration, not serving code, so a stage can vouch for it.
  writeState(production([VIS]))
  const prod = configure({ release: 'rel-fp', quiet: true })
  const gwProd = prod.workers.find((w) => w.canonical === 'viz-gateway')
  const stage = configure({ stage: 'fptest', release: 'rel-fp', quiet: true, idsOptional: true, workersSubdomain: 'example' })
  const gwStage = stage.workers.find((w) => w.canonical === 'viz-gateway')
  assert.deepEqual([prod.domain, prod.domainAliases, stage.domain, stage.domainAliases], ['viz.bitcru.sh', ['vis.bitcru.sh'], null, []])
  assert.equal(gwProd.app.serving.fingerprint, fingerprint())
  assert.equal(gwStage.app.serving.fingerprint, gwProd.app.serving.fingerprint)
  const detach = () => {
    const cfg = readJsonc(gatewayConfigFile())
    cfg.routes = [{ pattern: 'viz.bitcru.sh', custom_domain: true }]
    writeFileSync(gatewayConfigFile(), JSON.stringify(cfg))
  }
  const DOMAIN = /viz-gateway holds vis\.bitcru\.sh now, and this release does not list it/
  const STAGE = /this is the first production release that carries the web app .* and no stage is recorded to have gone before it/
  // Complete evidence, a config that would detach vis: refused for the hostname alone.
  writeState(production([VIS]))
  configure({ release: 'rel-gates-1', quiet: true })
  detach()
  for (const run of [() => planOnly({ stage: undefined }), () => deploy({ stage: undefined })]) {
    const r = await captured(run)
    assert.equal(r.result?.exit, 3, r.log)
    assert.match(r.log, DOMAIN)
    assert.doesNotMatch(r.log, STAGE)
    assert.match(r.log, /stage "pretrial" went before it/)
  }
  assert.equal(readState().calls.length, 0, 'nothing uploaded or promoted')
  // The hostnames right, no evidence: refused for the stage alone.
  writeState(production([VIS]))
  configure({ release: 'rel-gates-2', quiet: true })
  for (const run of [() => planOnly({ stage: undefined, appStageEvidence: NO_EVIDENCE }), () => deploy({ stage: undefined, appStageEvidence: NO_EVIDENCE })]) {
    const r = await captured(run)
    assert.equal(r.result?.exit, 3, r.log)
    assert.match(r.log, STAGE)
    assert.doesNotMatch(r.log, DOMAIN)
  }
  assert.equal(readState().calls.length, 0)
  // Both wrong: both reasons, in one refusal.
  configure({ release: 'rel-gates-3', quiet: true })
  detach()
  const both = await captured(() => deploy({ stage: undefined, appStageEvidence: NO_EVIDENCE }))
  assert.equal(both.result?.exit, 3, both.log)
  assert.match(both.log, DOMAIN)
  assert.match(both.log, STAGE)
  assert.equal(readState().calls.length, 0)
  // Evidence for other serving code (the gateway's host rules changed since the stage, say) is no evidence.
  writeFileSync(join(tmp, 'other-evidence.json'), JSON.stringify({ v: 1, evidence: [{ ...entry(), serving: 'f'.repeat(64) }] }))
  configure({ release: 'rel-gates-4', quiet: true })
  const other = await captured(() => deploy({ stage: undefined, appStageEvidence: join(tmp, 'other-evidence.json') }))
  assert.equal(other.result?.exit, 3, other.log)
  assert.match(other.log, /none for this release's serving code/)
  // Both right: released, holding both hostnames, with the evidence in its record.
  writeState(production([VIS]))
  configure({ release: 'rel-gates-5', quiet: true })
  const ok = await captured(() => deploy({ stage: undefined }))
  assert.equal(ok.result?.exit, 0, ok.log)
  assert.deepEqual(customDomainsOf(readJsonc(gatewayConfigFile())), ['viz.bitcru.sh', 'vis.bitcru.sh'])
  assert.equal(ok.result.record.appStage.evidence.stage, 'pretrial')
  assert.equal(JSON.parse(serving(readState(), 'viz-gateway').vars.VIZ_APP).build, gwProd.app.build)
})
