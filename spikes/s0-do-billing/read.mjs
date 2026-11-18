// Reads billed Durable Object usage for this spike, per class, from Cloudflare's analytics API.
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Usage: node read.mjs [since-ISO] [until-ISO]
const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID
const api = async (path, init) => (await fetch('https://api.cloudflare.com/client/v4/' + path, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })).json()
const ns = (await api(`accounts/${account}/workers/durable_objects/namespaces?per_page=100`)).result.filter((n) => n.script === 'viz-spike-s0-do-billing')
const since = process.argv[2] ?? new Date(Date.now() - 24 * 3600_000).toISOString()
const until = process.argv[3] ?? new Date().toISOString()
const q = `query($a:String!,$ids:[String!],$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){
  durableObjectsPeriodicGroups(limit:1000,filter:{namespaceId_in:$ids,datetimeHour_geq:$s,datetimeHour_leq:$u}){sum{activeTime duration cpuTime}dimensions{namespaceId}}
  durableObjectsInvocationsAdaptiveGroups(limit:1000,filter:{namespaceId_in:$ids,datetimeHour_geq:$s,datetimeHour_leq:$u}){sum{requests}dimensions{namespaceId}}}}}`
const r = await api('graphql', { method: 'POST', body: JSON.stringify({ query: q, variables: { a: account, ids: ns.map((n) => n.id), s: since, u: until } }) })
if (r.errors) { console.log(JSON.stringify(r.errors)); process.exit(1) }
const acc = r.data.viewer.accounts[0]
const hours = (new Date(until) - new Date(since)) / 3600_000
const rows = ns.map((n) => {
  const p = acc.durableObjectsPeriodicGroups.filter((g) => g.dimensions.namespaceId === n.id)
  const i = acc.durableObjectsInvocationsAdaptiveGroups.filter((g) => g.dimensions.namespaceId === n.id)
  const activeS = p.reduce((s, g) => s + g.sum.activeTime, 0) / 1e6, gbs = p.reduce((s, g) => s + g.sum.duration, 0)
  return { class: n.class, requests: i.reduce((s, g) => s + g.sum.requests, 0), active_s: +activeS.toFixed(1), billed_GBs: +gbs.toFixed(2), duty_pct: +((activeS / (hours * 3600)) * 100).toFixed(1) }
}).sort((a, b) => a.class.localeCompare(b.class, 'en', { numeric: true }))
console.log(`window ${since} .. ${until} (${hours.toFixed(1)} h). duty_pct = billed active time / wall time, over the whole window.`)
console.table(rows)
