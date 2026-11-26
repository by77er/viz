// Per-invocation CPU and wall time from `wrangler tail --format json` captures (the events Cloudflare
// streams for each invocation: `cpuTime`, `wallTime`, `outcome`, the event), grouped by what was
// invoked and, for HTTP, the response status. The tail samples under load, so counts are a sample;
// each event's times are Cloudflare's.
//
//   node tails.mjs <tail.json> [--from ISO --to ISO] [--phases STATE/phases.jsonl] [--json]
//
// The analytics API cannot give these per Worker for Workers reached through a service binding:
// it attributes the callee's invocation and CPU to its caller (see README, "Where CPU is counted").
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const opt = (k) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? args[i + 1] : undefined
}

/** The concatenated (pretty-printed) JSON objects of a tail capture. */
export function* events(text) {
  let depth = 0
  let start = -1
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') {
      if (depth++ === 0) start = i
    } else if (c === '}' && --depth === 0) {
      try {
        yield JSON.parse(text.slice(start, i + 1))
      } catch {}
    }
  }
}

export function kind(o) {
  const e = o.event ?? {}
  const durable = o.executionModel === 'durableObject' ? 'DO ' : ''
  if (e.queue) return `queue ${e.queue}`
  if (e.request) return `${durable}fetch ${new URL(e.request.url).pathname.replace(/\/api\/traces\/[0-9a-f]+/, '/api/traces/:id').replace(/\/api\/v2\/traces\/[0-9a-f]+/, '/api/v2/traces/:id').replace(/\/tag\/[^/]+\/values/, '/tag/:tag/values').replace(/\/label\/[^/]+\/values/, '/label/:name/values')} ${e.response?.status ?? '-'}`
  if (e.cron !== undefined) return 'cron'
  if (e.scheduledTime !== undefined) return `${durable}alarm`
  if (e.rpcMethod) return `${durable}rpc ${e.rpcMethod}`
  return `other ${Object.keys(e).join(',')}`
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] : null
}

export function summarise(list) {
  const groups = new Map()
  for (const o of list) {
    const k = kind(o)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(o)
  }
  return [...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => {
    const cpu = v.map((o) => o.cpuTime ?? 0)
    const wall = v.map((o) => o.wallTime ?? 0)
    const outcomes = {}
    for (const o of v) outcomes[o.outcome] = (outcomes[o.outcome] ?? 0) + 1
    return { kind: k, n: v.length, cpuMs: { p50: pct(cpu, 50), p90: pct(cpu, 90), p99: pct(cpu, 99), max: Math.max(...cpu), sum: cpu.reduce((a, b) => a + b, 0) }, wallMs: { p50: pct(wall, 50), p90: pct(wall, 90), max: Math.max(...wall) }, outcomes }
  })
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const all = [...events(readFileSync(args[0], 'utf8'))]
  const windows = opt('phases')
    ? readFileSync(opt('phases'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : [{ phase: 'all', from: opt('from') ?? '1970-01-01T00:00:00Z', to: opt('to') ?? '2100-01-01T00:00:00Z' }]
  const out = []
  for (const w of windows) {
    const f = Date.parse(w.from)
    const t = Date.parse(w.to) + 1000
    const rows = summarise(all.filter((o) => o.eventTimestamp >= f && o.eventTimestamp <= t))
    out.push({ phase: w.phase, from: w.from, to: w.to, rows })
    if (!args.includes('--json')) {
      console.log(`== ${w.phase} ${w.from} .. ${w.to}`)
      for (const r of rows) console.log(`  ${r.kind.padEnd(52)} n ${String(r.n).padStart(4)}  cpu ms p50 ${r.cpuMs.p50} p90 ${r.cpuMs.p90} p99 ${r.cpuMs.p99} max ${r.cpuMs.max}  wall ms p50 ${r.wallMs.p50} p90 ${r.wallMs.p90} max ${r.wallMs.max}  ${JSON.stringify(r.outcomes)}`)
    }
  }
  if (args.includes('--json')) console.log(JSON.stringify(out, null, 1))
}
