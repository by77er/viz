// node --test deploy/test/: D75's custom domains through the real configure.mjs and release.mjs, against
// the fake account (test/fake-account.mjs). viz-gateway holds viz.bitcru.sh and vis.bitcru.sh; a release
// that would detach vis, take over another Worker's hostname, or deploy hostnames other than the plan's is
// refused before anything is uploaded. Nothing reaches Cloudflare.
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
const { callsLike, captured, installFakeAccount, serving } = await import('./fake-account.mjs')
const { configure } = await import('../configure.mjs')
const { deploy, planOnly } = await import('../release.mjs')
const { customDomainProblems, customDomainsOf, domainsNow } = await import('../lib/domains.mjs')

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
