// Custom domains (D75): what the public Worker's generated config will make it hold, checked
// against what the account holds now, before anything is uploaded.
//
// `wrangler triggers deploy` (and `wrangler deploy`) give a Worker its custom domains with one
// PUT of `/domains/records` carrying `override_scope: true` and, when stdout is not a terminal (the
// deploy workflow), `override_existing_origin: true` and `override_existing_dns_record: true`
// (wrangler 4.164.0, publishCustomDomains in wrangler-dist/cli.js, read here). So, unchecked, a
// production deploy would:
//   - detach every custom domain the Worker holds that its config does not list (vis.bitcru.sh,
//     if a config listed only viz.bitcru.sh);
//   - take over a listed hostname that is another Worker's custom domain;
//   - replace a DNS record that already exists for a listed hostname.
// The first two are refused here, from the account's custom-domain list (GET /workers/domains,
// which deploy/resources.mjs reads already). The third cannot be seen from that list (a DNS
// record that is not a custom domain needs the zone's DNS records, which this token is not known
// to read): deploy/README.md says how to check it before the first deploy of a new hostname.

/** The hostnames a generated config gives its Worker as custom domains, in order. */
export const customDomainsOf = (config) => (config.routes ?? []).filter((r) => r && r.custom_domain === true).map((r) => r.pattern)

/**
 * Problems (strings) with the custom domains this release would set. `configOf(w)` reads a
 * manifest Worker's generated config; `domains` is the account's custom-domain list
 * (`[{ hostname, service }]`), or null when it was not read (a stage: none is asked for).
 */
export function customDomainProblems(manifest, configOf, domains) {
  const problems = []
  for (const w of manifest.workers.filter((x) => x.deploy !== false && x.config)) {
    const cfg = configOf(w)
    const hosts = customDomainsOf(cfg)
    const routes = (cfg.routes ?? []).length + (cfg.route ? 1 : 0)
    if (manifest.stage) {
      if (routes > 0) problems.push(`${w.name}: a stage's generated config has routes (${hosts.join(', ') || 'zone routes'}); a stage is served on workers.dev only and touches no hostname`)
      continue
    }
    if (!w.public) {
      if (routes > 0) problems.push(`${w.name}: only the public Worker holds a hostname, and its generated config has routes (${hosts.join(', ') || 'zone routes'})`)
      continue
    }
    if (routes !== hosts.length) problems.push(`${w.name}: its generated config has a zone route; the public Worker holds custom domains only`)
    const planned = manifest.domain ? [manifest.domain, ...(manifest.domainAliases ?? [])] : null
    if (planned && JSON.stringify(planned) !== JSON.stringify(hosts)) {
      problems.push(`${w.name}: its generated config gives it the custom domains [${hosts.join(', ')}], not the manifest's [${planned.join(', ')}] (deploy/workers.json domain, then domain_aliases): run deploy/configure.mjs again; never edit a generated config`)
    }
    if (domains === null) continue
    for (const d of domains) {
      if (hosts.includes(d.hostname) && d.service !== w.name) {
        problems.push(`${d.hostname} is a custom domain of ${d.service ?? 'another Worker'}, not ${w.name}: wrangler, run by the deploy, would take it over without asking. Nothing of viz may change another Worker's hostname (AGENTS.md); free it by hand, or change deploy/workers.json`)
      }
      if (d.service === w.name && !hosts.includes(d.hostname)) {
        problems.push(`${w.name} holds ${d.hostname} now, and this release does not list it: wrangler would detach it (it replaces the Worker's set of custom domains). Keep it in deploy/workers.json domain_aliases (D75); ending a transition is a change of its own, which must also change this check`)
      }
    }
  }
  return problems
}

/** The account's custom domains when this manifest deploys any (production), else null. */
export async function domainsNow(manifest, list) {
  if (manifest.stage) return null
  if (!manifest.workers.some((w) => w.public && w.deploy !== false)) return null
  return list()
}
