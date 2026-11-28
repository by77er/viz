// S15, item 1: was anything of a refused request stored? For each traces request of a `heavy` run
// whose every attempt was refused, ask for its first trace by ID through the stage (from inside
// Cloudflare, through the load Worker's `query` op); as a control, the same for accepted requests.
// Bodies are `--uniq` (lcg32), so a trace id belongs to exactly one request.
//
//   VIZ_TREE=… STATE=… SPIKE_STAGE=s15 SPIKE_TENANTS=s15-load node refused.mjs <heavy-results.json> [--control N]
//
// Prints, per group, how many trace ids were found. Expected after D77: none of the refused.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [file, ...rest] = process.argv.slice(2)
const control = Number(rest[rest.indexOf('--control') + 1] ?? 10) || 10
const driver = join(process.env.VIZ_TREE, 'spikes', 's10-signals-trial', 'driver.mjs')
const run = JSON.parse(readFileSync(file, 'utf8'))
const traces = run.find((v) => v.gen === 'traces')
const recs = traces.results.flatMap((r) => (r.records ?? []).map((x) => ({ ...x, tenant: r.tenant })))
const refused = recs.filter((r) => r.status !== 200)
const accepted = recs.filter((r) => r.status === 200).slice(0, control)

function ask(rec, label) {
  const op = { op: 'query', client: `refused-check-${label}`, tenant: rec.tenant, path: `/api/traces/${rec.info.traceId}`, keep: 200 }
  const out = JSON.parse(execFileSync('node', [driver, 'op', JSON.stringify(op)], { encoding: 'utf8', env: process.env }))
  const r = out.records?.[0]
  return { trace: rec.info.traceId, status: r?.status ?? null, statuses: rec.attempts.map((a) => a.status), body: r?.body?.slice(0, 80) }
}

for (const [label, group] of [['refused', refused], ['accepted', accepted]]) {
  const answers = group.map((r) => ask(r, label))
  const found = answers.filter((a) => a.status === 200).length
  console.log(`${label}: ${group.length} requests, first trace found for ${found}; answers ${JSON.stringify(answers.reduce((m, a) => ((m[a.status] = (m[a.status] ?? 0) + 1), m), {}))}`)
  for (const a of answers.filter((x) => (label === 'refused' ? x.status === 200 : x.status !== 200))) console.log(`  ${JSON.stringify(a)}`)
}
