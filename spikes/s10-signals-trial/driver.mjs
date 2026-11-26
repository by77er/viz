// Drives the S10 trial from outside Cloudflare: deploys and deletes the load Worker, starts
// operations on its client Durable Objects (which send every request to the stage, inside
// Cloudflare), and writes what they report to the state directory. Nothing it sends reaches the
// system under test directly, except `smoke` (deploy/smoke.mjs) and the R2/KV calls below.
//
//   export VIZ_TREE=<checkout deployed from> STATE=<scratch dir>
//   node driver.mjs load-up --expires ISO        deploy viz-s10-load-client, set its secrets (stdin)
//   node driver.mjs load-down                    delete it (and its Durable Object namespace)
//   node driver.mjs ids                          record the stage's names and ids in STATE/ids.json
//   node driver.mjs <phase>                      markers | heavy | qdata | fat | queries | margin |
//                                                hostile | metrics | filepoll | tails | r2list
//   node driver.mjs op '<json>'                  one operation, printed
//
// Results: STATE/results/<phase>-<time>.json; phase windows (for analytics): STATE/phases.jsonl.
// Keys: STATE/keys/<tenant>.key (write and read scopes, from bootstrap.mjs --smoke-key-file, mode
// 0600). They go to the load Worker as one secret on wrangler's stdin and are never printed.
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

const TREE = process.env.VIZ_TREE
const STATE = process.env.STATE
if (!TREE || !STATE) throw new Error('VIZ_TREE and STATE must be set')
const HERE = new URL('.', import.meta.url).pathname
const cfm = await import(pathToFileURL(join(TREE, 'deploy', 'lib', 'cf.mjs')).href)
const { wrangler } = await import(pathToFileURL(join(TREE, 'deploy', 'lib', 'wrangler.mjs')).href)
const STAGE = 's10'
const LOAD = `viz-${STAGE}-load-client`
const GATEWAY = `viz-${STAGE}-gateway`
export const TENANTS = ['s10-load', 's10-q', 's10-fat', 's10-fatattr', 's10-hostile', 's10-load2']
mkdirSync(join(STATE, 'results'), { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const iso = (ms) => new Date(ms).toISOString()
const H = 3_600_000
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null
}
const stats = (xs) => (xs.length ? { n: xs.length, p50: pct(xs, 50), p90: pct(xs, 90), p99: pct(xs, 99), min: Math.min(...xs), max: Math.max(...xs) } : { n: 0 })
function save(phase, data) {
  const f = join(STATE, 'results', `${phase}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(f, JSON.stringify(data, null, 1) + '\n')
  return f
}
const mark = (phase, from, to, extra = {}) => appendFileSync(join(STATE, 'phases.jsonl'), JSON.stringify({ phase, from: iso(from), to: iso(to), ...extra }) + '\n')

// ───────────────────────────── the load Worker ─────────────────────────────

async function loadUrl() {
  return `https://${LOAD}.${await cfm.workersSubdomain()}.workers.dev/`
}
let urlCache = null
const loadKey = () => readFileSync(join(STATE, 'load.key'), 'utf8').trim()

/** One operation on client object `op.client`; retried only when the load Worker could not be reached. */
export async function call(op) {
  urlCache ??= await loadUrl()
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(urlCache, { method: 'POST', headers: { 'x-key': loadKey(), 'content-type': 'application/json' }, body: JSON.stringify(op), signal: AbortSignal.timeout(600_000) })
      const text = await res.text()
      let j
      try {
        j = JSON.parse(text)
      } catch {
        j = { error: `HTTP ${res.status}: ${text.slice(0, 300)}` }
      }
      if (res.status !== 200) return { error: j.error ?? `HTTP ${res.status}`, status: res.status }
      return j
    } catch (e) {
      if (attempt >= 2) return { error: `load Worker unreachable: ${e.cause?.code ?? e.message}` }
      await sleep(2000)
    }
  }
}

async function loadUp(expires) {
  if (!expires || !(Date.parse(expires) > Date.now()) || Date.parse(expires) - Date.now() > 3 * H + 60_000) throw new Error('--expires: an ISO time at most 3 hours ahead')
  const cfg = {
    name: LOAD,
    main: join(HERE, 'load', 'worker.mjs'),
    compatibility_date: '2026-10-01',
    workers_dev: true,
    preview_urls: false,
    services: [{ binding: 'GATEWAY', service: GATEWAY }],
    durable_objects: { bindings: [{ name: 'CLIENT', class_name: 'Client' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Client'] }],
    vars: { DEADLINE: expires },
    alias: { snappyjs: join(TREE, 'edge', 'node_modules', 'snappyjs', 'index.js') },
    observability: { enabled: false },
  }
  const file = join(STATE, 'load-wrangler.json')
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
  await wrangler(['deploy', '-c', file], { label: 'load deploy' })
  if (!existsSync(join(STATE, 'load.key'))) writeFileSync(join(STATE, 'load.key'), randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
  const keys = {}
  for (const t of TENANTS) {
    const f = join(STATE, 'keys', `${t}.key`)
    if (existsSync(f)) keys[t] = readFileSync(f, 'utf8').trim()
  }
  await wrangler(['secret', 'put', 'LOAD_KEY', '--name', LOAD], { input: loadKey(), label: 'secret LOAD_KEY', quiet: true })
  await wrangler(['secret', 'put', 'TENANT_KEYS', '--name', LOAD], { input: JSON.stringify(keys), label: 'secret TENANT_KEYS', quiet: true })
  console.log(`load Worker ${LOAD} deployed; secrets LOAD_KEY and TENANT_KEYS (${Object.keys(keys).join(', ')}) set on stdin; deadline ${expires}`)
}

async function loadDown() {
  const gone = await cfm.deleteScript(LOAD)
  const left = (await cfm.listScripts()).some((s) => s.id === LOAD)
  console.log(`load Worker ${LOAD}: ${gone ? 'deleted' : 'not there'}; still listed: ${left}`)
}

async function recordIds() {
  const [scripts, dos, queues, kv] = await Promise.all([cfm.listScripts(), cfm.listDurableObjectNamespaces(), cfm.cfList('/queues'), cfm.cfList('/storage/kv/namespaces')])
  const mine = (n) => typeof n === 'string' && n.startsWith(`viz-${STAGE}-`)
  const ids = {
    scripts: scripts.map((s) => s.id).filter(mine),
    namespaces: Object.fromEntries(dos.filter((d) => mine(d.script)).map((d) => [d.id, `${d.script}:${d.class}`])),
    bucket: `viz-${STAGE}-lake`,
    queues: Object.fromEntries(queues.filter((q) => mine(q.queue_name)).map((q) => [q.queue_id, q.queue_name])),
    kv: Object.fromEntries(kv.filter((n) => mine(n.title)).map((n) => [n.id, n.title])),
  }
  writeFileSync(join(STATE, 'ids.json'), JSON.stringify(ids, null, 2) + '\n')
  console.log(JSON.stringify({ scripts: ids.scripts, namespaces: Object.values(ids.namespaces), queues: Object.values(ids.queues), kv: Object.values(ids.kv) }, null, 1))
}

// ───────────────────────────── summaries ─────────────────────────────

function summariseIngest(results) {
  const recs = results.flatMap((r) => r.records ?? [])
  const attempts = recs.flatMap((r) => r.attempts)
  const byStatus = {}
  for (const a of attempts) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1
  const ok = recs.filter((r) => r.status >= 200 && r.status < 300)
  const rejectedItems = recs.reduce((a, r) => a + (r.attempts.at(-1)?.partial?.rejected ?? 0), 0)
  const firstOk = attempts.filter((a) => a.status >= 200 && a.status < 300).map((a) => a.ms)
  return {
    requests: recs.length,
    accepted: ok.length,
    finallyRefused: recs.length - ok.length,
    attempts: attempts.length,
    attemptsByStatus: byStatus,
    retried: recs.filter((r) => r.attempts.length > 1).length,
    itemsAccepted: ok.reduce((a, r) => a + r.items, 0) - rejectedItems,
    itemsRejectedInPartialSuccess: rejectedItems,
    wireBytesP50: pct(recs.map((r) => r.wireBytes), 50),
    ackMs: stats(firstOk),
    errors: results.filter((r) => r.error).map((r) => r.error.slice(0, 300)),
    samples: [...new Set(attempts.filter((a) => a.status >= 300 || a.partial?.rejected).map((a) => `${a.status} ${(a.text ?? a.partial?.message ?? '').slice(0, 160)}`))].slice(0, 8),
  }
}

async function parallel(ops) {
  return Promise.all(ops.map((o) => call(o)))
}

// ───────────────────────────── phases ─────────────────────────────

/** Acknowledgement → queryable, from the tail: `runs` runs of 20 traces and 20 log lines (s10-q). */
async function markers(runs = 3, tenant = 's10-q', label = 'markers') {
  const all = []
  for (let r = 1; r <= runs; r++) {
    const t0 = Date.now()
    const tr = await call({ op: 'markers', client: `mk-${label}-${r}`, tenant, kind: 'trace', count: 20, pollMs: 50, timeoutMs: 60_000, tag: `${label}-t${r}` })
    const lg = await call({ op: 'markers', client: `mk-${label}-${r}`, tenant, kind: 'log', count: 20, pollMs: 50, timeoutMs: 60_000, tag: `${label}-l${r}` })
    all.push({ run: r, from: iso(t0), to: iso(Date.now()), traces: tr, logs: lg })
    const s = (x) => (x.records ?? [])
    console.log(`run ${r} (${tenant}): traces ack ${JSON.stringify(stats(s(tr).map((x) => x.ackMs)))}, ack→queryable ${JSON.stringify(stats(s(tr).filter((x) => x.queryableMs !== undefined).map((x) => x.queryableMs)))}, polls ${JSON.stringify(stats(s(tr).map((x) => x.polls)))}${tr.error ? ` ERROR ${tr.error}` : ''}`)
    console.log(`         logs ack ${JSON.stringify(stats(s(lg).map((x) => x.ackMs)))}, ack→queryable ${JSON.stringify(stats(s(lg).filter((x) => x.queryableMs !== undefined).map((x) => x.queryableMs)))}, polls ${JSON.stringify(stats(s(lg).map((x) => x.polls)))}${lg.error ? ` ERROR ${lg.error}` : ''}`)
    const bad = [...s(tr), ...s(lg)].filter((x) => x.timedOut || x.error || x.ackStatus >= 300)
    if (bad.length) console.log(`         not answered: ${JSON.stringify(bad.slice(0, 3))}`)
    mark(`${label}-run${r}`, t0, Date.now(), { tenant })
  }
  console.log(save(label, all))
}

/** The realistic 8,200-item bodies through the gateway: `clients` client objects per variant, one variant at a time. */
async function heavy(variants = ['traces', 'tracesJson', 'logs', 'logsJson', 'loki', 'lokiJson'], clients = 4, requests = 12, gapMs = 70_000, { tenant = 's10-load', uniq = false, seedBase = 0, pauseMs = 0, label = 'heavy' } = {}) {
  const all = []
  for (const [vi, gen] of variants.entries()) {
    const t0 = Date.now()
    // Seeds: per variant NAME (not its place in this call's list), per client and per request.
    const vn = ['traces', 'tracesJson', 'logs', 'logsJson', 'loki', 'lokiJson'].indexOf(gen) + 1
    const res = await parallel(Array.from({ length: clients }, (_, c) => ({ op: 'ingest', client: `${label}-${gen}-${c}`, tenant, gen, uniq, requests, seed: seedBase + 1_000_000 * vn + 1000 * c, attempts: 8, retryCapMs: 2000, maxMs: 240_000, pauseMs })))
    const t1 = Date.now()
    const sum = summariseIngest(res)
    all.push({ gen, from: iso(t0), to: iso(t1), summary: sum, results: res })
    mark(`${label}-${gen}`, t0, t1, { tenant, clients, requests, uniq, pauseMs })
    console.log(`${gen}: ${JSON.stringify(sum)}`)
    console.log(save(label, all))
    if (vi + 1 < variants.length) await sleep(gapMs)
  }
}

const NS = (ms) => `${BigInt(Math.round(ms)) * 1_000_000n}`
const SEC = (ms) => String(Math.floor(ms / 1000))

/** The query tenant's blocks (query/README.md "Memory" shapes), each in a window of its own. */
async function qdata() {
  const now = Date.now()
  const plan = {
    A: { gen: 'richSpans', t0Ms: now - 50 * 60_000, total: 17_280, per: 2_160, idBase: 0 },
    B: { gen: 'richSpans', t0Ms: now - 8 * H, total: 30_000, per: 2_000, idBase: 10_000_000 },
    C: { gen: 'richLogs', t0Ms: now - 45 * 60_000, total: 30_000, per: 5_000 },
    D: { gen: 'richLogs', t0Ms: now - 12 * H, total: 45_000, per: 5_000 },
  }
  writeFileSync(join(STATE, 'qdata.json'), JSON.stringify(plan, null, 1) + '\n')
  const t0 = Date.now()
  const res = await parallel(Object.entries(plan).map(([k, b]) => ({ op: 'ingest', client: `qdata-${k}`, tenant: 's10-q', gen: b.gen, requests: b.total / b.per, seed: 77 + k.charCodeAt(0), attempts: 10, retryCapMs: 3000, maxMs: 400_000, params: { t0Ms: b.t0Ms, per: b.per, from: 0, idBase: b.idBase } })))
  const t1 = Date.now()
  mark('qdata', t0, t1, { tenant: 's10-q' })
  for (const [i, k] of Object.keys(plan).entries()) console.log(`block ${k}: ${JSON.stringify(summariseIngest([res[i]]))}`)
  console.log(save('qdata', { plan, results: res }))
}

/** The review's fat shapes (s10-fat) and the README's fat attributes (s10-fatattr). */
async function fat() {
  const now = Date.now()
  const plan = {
    spans1000: { tenant: 's10-fat', gen: 'fatSpans', t0Ms: now - 10 * H, from: 0, per: 1000, requests: 1 },
    spans2000: { tenant: 's10-fat', gen: 'fatSpans', t0Ms: now - 4 * H, from: 100_000, per: 2000, requests: 1 },
    logsA: { tenant: 's10-fat', gen: 'fatLogs', t0Ms: now - 20 * H, job: 'a', lines: 400, per: 4, clients: 4 },
    logsB: { tenant: 's10-fat', gen: 'fatLogs', t0Ms: now - 22 * H, job: 'b', lines: 40, per: 4, clients: 1 },
    attrs600: { tenant: 's10-fatattr', gen: 'richSpans', t0Ms: now - 1 * H, from: 0, per: 100, requests: 6, fat: true },
  }
  writeFileSync(join(STATE, 'fat.json'), JSON.stringify(plan, null, 1) + '\n')
  const ops = []
  for (const [k, p] of Object.entries(plan)) {
    if (p.lines) {
      const each = p.lines / p.clients
      for (let c = 0; c < p.clients; c++) ops.push({ key: k, op: 'ingest', client: `fat-${k}-${c}`, tenant: p.tenant, gen: p.gen, requests: each / p.per, attempts: 20, retryCapMs: 3000, maxMs: 500_000, params: { t0Ms: p.t0Ms, per: p.per, from: c * each, job: p.job } })
    } else ops.push({ key: k, op: 'ingest', client: `fat-${k}`, tenant: p.tenant, gen: p.gen, requests: p.requests, attempts: 20, retryCapMs: 3000, maxMs: 500_000, params: { t0Ms: p.t0Ms, per: p.per, from: p.from, fat: p.fat } })
  }
  const t0 = Date.now()
  const res = await parallel(ops)
  mark('fat', t0, Date.now())
  for (const k of Object.keys(plan)) console.log(`${k}: ${JSON.stringify(summariseIngest(res.filter((_, i) => ops[i].key === k)))}`)
  console.log(save('fat', { plan, results: res }))
}

/** A query `repeat` times from one client object; prints status, ms and the cost headers. */
async function q(name, tenant, path, repeat = 3, keep = 300) {
  const r = await call({ op: 'query', client: `q-${tenant}`, tenant, path, repeat, keep })
  const recs = r.records ?? []
  const h = recs.at(-1)?.headers ?? {}
  const brief = (k) => h[`x-viz-${k}`]
  console.log(`${name.padEnd(46)} ${recs.map((x) => x.status).join(',')} ms ${recs.map((x) => x.ms).join(',')} wasm ${((Number(brief('wasm-memory-bytes')) || 0) / 2 ** 20).toFixed(1)} MiB, engine ${brief('engine-ms')} ms, files ${brief('files-read')}, bytes ${brief('bytes-read')}, tail ${brief('tail-batches')}/${brief('tail-bytes')}, decoded ${brief('rows-decoded')}${recs.at(-1)?.status >= 300 ? ` — ${recs.at(-1).body.slice(0, 160).replace(/\s+/g, ' ')}` : ''}${r.error ? ` ERROR ${r.error}` : ''}`)
  return { name, tenant, path, ...r }
}

async function queries(which = 'all') {
  const qd = JSON.parse(readFileSync(join(STATE, 'qdata.json'), 'utf8'))
  const fp = JSON.parse(readFileSync(join(STATE, 'fat.json'), 'utf8'))
  const out = []
  const t0 = Date.now()
  const A = qd.A
  const aEnd = A.t0Ms + (A.total * 50) + 1000
  const C = qd.C
  const cEnd = C.t0Ms + C.total * 50 + 1000
  const enc = encodeURIComponent
  if (which === 'all' || which === 'q') {
    out.push(await q('tempo search { } block A (17,280 spans)', 's10-q', `/api/search?q=${enc('{ }')}&limit=20&start=${SEC(A.t0Ms)}&end=${SEC(aEnd) }`, 5))
    out.push(await q('tempo search filter block A', 's10-q', `/api/search?q=${enc('{ resource.service.name = "svc-3" && span.http.response.status_code = 500 }')}&limit=20&start=${SEC(A.t0Ms)}&end=${SEC(aEnd)}`, 3))
    out.push(await q('tempo search { } block B (30,000 spans)', 's10-q', `/api/search?q=${enc('{ }')}&limit=20&start=${SEC(qd.B.t0Ms)}&end=${SEC(qd.B.t0Ms + 30_000 * 50 + 1000)}`, 2))
    out.push(await q('tempo trace by id (block A trace 1), no hint', 's10-q', `/api/traces/${(1).toString(16).padStart(32, '0')}`, 3, 200))
    out.push(await q('tempo trace by id, hint', 's10-q', `/api/v2/traces/${(1).toString(16).padStart(32, '0')}?start=${SEC(A.t0Ms - 60_000)}&end=${SEC(A.t0Ms + 60_000)}`, 3, 200))
    out.push(await q('traceql metrics rate by service, block A', 's10-q', `/api/metrics/query_range?q=${enc('{ } | rate() by (resource.service.name)')}&start=${SEC(A.t0Ms)}&end=${SEC(aEnd)}&step=60s`, 3))
    out.push(await q('traceql metrics quantile duration, block A', 's10-q', `/api/metrics/query_range?q=${enc('{ } | quantile_over_time(duration, .9) by (span.http.route)')}&start=${SEC(A.t0Ms)}&end=${SEC(aEnd)}&step=60s`, 2))
    out.push(await q('tempo tags', 's10-q', `/api/v2/search/tags?start=${SEC(A.t0Ms)}&end=${SEC(aEnd)}`, 2, 200))
    out.push(await q('tempo tag values service.name', 's10-q', `/api/v2/search/tag/resource.service.name/values?start=${SEC(A.t0Ms)}&end=${SEC(aEnd)}`, 2, 200))
    out.push(await q('loki query_range {namespace} limit 100, block C', 's10-q', `/loki/api/v1/query_range?query=${enc('{namespace="shop-prod"}')}&start=${NS(C.t0Ms)}&end=${NS(cEnd)}&limit=100`, 5))
    out.push(await q('loki query_range line filter, block C', 's10-q', `/loki/api/v1/query_range?query=${enc('{job="svc-3"} |= "status=500"')}&start=${NS(C.t0Ms)}&end=${NS(cEnd)}&limit=100`, 3))
    out.push(await q('loki metric count_over_time by job, block C', 's10-q', `/loki/api/v1/query_range?query=${enc('sum by (job) (count_over_time({namespace="shop-prod"}[1m]))')}&start=${NS(C.t0Ms)}&end=${NS(cEnd)}&step=60`, 3))
    out.push(await q('loki query_range block D (45,000 rows)', 's10-q', `/loki/api/v1/query_range?query=${enc('{namespace="shop-prod"}')}&start=${NS(qd.D.t0Ms)}&end=${NS(qd.D.t0Ms + 45_000 * 50 + 1000)}&limit=100`, 2))
    out.push(await q('loki labels', 's10-q', `/loki/api/v1/labels?start=${NS(C.t0Ms)}&end=${NS(cEnd)}`, 3, 300))
    out.push(await q('loki label values job', 's10-q', `/loki/api/v1/label/job/values?start=${NS(C.t0Ms)}&end=${NS(cEnd)}`, 3, 300))
  }
  if (which === 'all' || which === 'fat') {
    const s1 = fp.spans1000
    const s2 = fp.spans2000
    out.push(await q('fat: search { } 1,000 spans, 180 KB resource', 's10-fat', `/api/search?q=${enc('{ }')}&limit=20&spss=3&start=${SEC(s1.t0Ms)}&end=${SEC(s1.t0Ms + H)}`, 2))
    out.push(await q('fat: search { } 2,000 spans, 180 KB resource', 's10-fat', `/api/search?q=${enc('{ }')}&limit=20&spss=3&start=${SEC(s2.t0Ms)}&end=${SEC(s2.t0Ms + H)}`, 2))
    out.push(await q('fat: loki {job="a"} 400 lines of 200 KB', 's10-fat', `/loki/api/v1/query_range?query=${enc('{job="a"}')}&start=${NS(fp.logsA.t0Ms)}&end=${NS(fp.logsA.t0Ms + H)}&limit=100&step=14`, 2))
    out.push(await q('fat: loki {job="b"} 40 lines, limit 10', 's10-fat', `/loki/api/v1/query_range?query=${enc('{job="b"}')}&start=${NS(fp.logsB.t0Ms)}&end=${NS(fp.logsB.t0Ms + H)}&limit=10`, 2))
    const a = fp.attrs600
    out.push(await q('fat: search { } 600 spans of own 60 KB attr', 's10-fatattr', `/api/search?q=${enc('{ }')}&limit=20&start=${SEC(a.t0Ms - 60_000)}&end=${SEC(a.t0Ms + 60_000)}`, 2))
  }
  if (which === 'all' || which === 'load') {
    const now = Date.now()
    out.push(await q('load: search { } last hour', 's10-load', `/api/search?q=${enc('{ }')}&limit=20`, 2))
    out.push(await q('load: loki labels (6 h)', 's10-load', `/loki/api/v1/labels`, 2, 300))
    out.push(await q('load: loki {job="app-3"} last hour, limit 100', 's10-load', `/loki/api/v1/query_range?query=${enc('{job="app-3"}')}&limit=100`, 2))
    out.push(await q('load: loki count_over_time by job, 1 h', 's10-load', `/loki/api/v1/query_range?query=${enc('sum by (job) (count_over_time({namespace="prod"}[5m]))')}&start=${NS(now - H)}&end=${NS(now)}&step=300`, 2))
    out.push(await q('load: traceql rate, 1 h', 's10-load', `/api/metrics/query_range?q=${enc('{ } | rate()')}&start=${SEC(now - H)}&end=${SEC(now)}&step=300s`, 2))
  }
  if (which === 'load2') {
    // A trace the client recorded (its first span: start time and id), and windows around it.
    const files = readdirSync(join(STATE, 'results')).filter((f) => f.startsWith('heavy2-')).sort()
    const h2 = JSON.parse(readFileSync(join(STATE, 'results', files.at(-1)), 'utf8'))
    const rec = h2.find((v) => v.gen === 'traces').results.flatMap((r) => r.records ?? []).find((r) => r.status === 200 && r.info)
    const st = Number(BigInt(rec.info.startNs) / 1_000_000n)
    const now = Date.now()
    out.push(await q('load2: search { } last hour, limit 20', 's10-load2', `/api/search?q=${enc('{ }')}&limit=20`, 3))
    out.push(await q('load2: search filter, 10 s window', 's10-load2', `/api/search?q=${enc('{ resource.service.name = "svc-3" && span.http.response.status_code = 200 }')}&limit=20&start=${SEC(st - 5000)}&end=${SEC(st + 5000)}`, 3))
    out.push(await q('load2: search { } 2 s window', 's10-load2', `/api/search?q=${enc('{ }')}&limit=20&start=${SEC(st)}&end=${SEC(st + 2000)}`, 3))
    out.push(await q('load2: trace by id, no hint', 's10-load2', `/api/traces/${rec.info.traceId}`, 3, 200))
    out.push(await q('load2: trace by id, hint', 's10-load2', `/api/v2/traces/${rec.info.traceId}?start=${SEC(st - 60_000)}&end=${SEC(st + 60_000)}`, 3, 200))
    out.push(await q('load2: traceql rate, 1 h', 's10-load2', `/api/metrics/query_range?q=${enc('{ } | rate()')}&start=${SEC(now - H)}&end=${SEC(now)}&step=300s`, 2))
    out.push(await q('load2: traceql rate, 10 s', 's10-load2', `/api/metrics/query_range?q=${enc('{ } | rate() by (resource.service.name)')}&start=${SEC(st - 5000)}&end=${SEC(st + 5000)}&step=1s`, 2))
    out.push(await q('load2: loki {job="app-3"} 10 s, limit 100', 's10-load2', `/loki/api/v1/query_range?query=${enc('{job="app-3"}')}&start=${NS(st - 5000)}&end=${NS(st + 5000)}&limit=100`, 3))
    out.push(await q('load2: loki {job="app-3"} last hour', 's10-load2', `/loki/api/v1/query_range?query=${enc('{job="app-3"}')}&limit=100`, 2))
    out.push(await q('load2: loki labels', 's10-load2', `/loki/api/v1/labels`, 2, 300))
    out.push(await q('load2: loki label values job', 's10-load2', `/loki/api/v1/label/job/values`, 2, 300))
  }
  mark(`queries-${which}`, t0, Date.now())
  console.log(save(`queries-${which}`, out))
}

/** D62's margin experiment: the same narrow search on s10-load at traceMarginMs 0, 1 h, 2 h (KV limits:<tenant>). */
async function margin(windowStartMs, windowMs = 2000, tenant = 's10-load', traceId = null) {
  // Only the stage's own namespace (viz-s10-config), only the key limits:s10-load; deleted after.
  const kvId = Object.entries(JSON.parse(readFileSync(join(STATE, 'ids.json'), 'utf8')).kv).find(([, t]) => t === `viz-${STAGE}-config`)[0]
  const out = []
  const path = `/api/search?q=${encodeURIComponent('{ }')}&limit=20&start=${SEC(windowStartMs)}&end=${SEC(windowStartMs + windowMs)}`
  for (const m of [null, 0, H, 2 * H]) {
    if (m === null) {
      out.push({ margin: 'default (2 h, no record)', ...(await q('margin default', tenant, path, 3)) })
      if (traceId) out.push({ margin: 'default (2 h, no record)', ...(await q('margin default, trace by id + hint', tenant, `/api/v2/traces/${traceId}?start=${SEC(windowStartMs - 60_000)}&end=${SEC(windowStartMs + 60_000)}`, 2, 200)) })
      continue
    }
    const body = JSON.stringify({ traceMarginMs: m })
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${kvId}/values/${encodeURIComponent(`limits:${tenant}`)}`, { method: 'PUT', headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'text/plain' }, body })
    if (!res.ok) throw new Error(`KV put: ${res.status}`)
    await sleep(75_000) // KV propagation (up to 60 s) and the query's 30 s limits cache
    out.push({ margin: m, ...(await q(`margin ${m / H} h`, tenant, path, 3)) })
    if (traceId) out.push({ margin: m, ...(await q(`margin ${m / H} h, trace by id + hint`, tenant, `/api/v2/traces/${traceId}?start=${SEC(windowStartMs - 60_000)}&end=${SEC(windowStartMs + 60_000)}`, 2, 200)) })
  }
  const del = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${kvId}/values/${encodeURIComponent(`limits:${tenant}`)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } })
  console.log(`limits:${tenant} deleted: ${del.status}`)
  console.log(save(`margin-${tenant}`, out))
}

/** D71 on Cloudflare: edge/bench/bodies.mjs's hostile bodies (dumped by bench/memory.mjs --dump into STATE/hostile), and two oversized ones. */
async function hostile() {
  const dir = join(STATE, 'hostile')
  const snappy = (await import(pathToFileURL(join(TREE, 'edge', 'node_modules', 'snappyjs', 'index.js')).href)).default
  const files = readdirSync(dir).filter((f) => f.endsWith('.bin')).sort()
  const kind = (f) => (f.startsWith('traces') ? '/v1/traces' : f.startsWith('logs') ? '/v1/logs' : f.startsWith('loki') ? '/loki/api/v1/push' : f.startsWith('metrics') ? '/v1/metrics' : f.startsWith('realistic-traces') ? '/v1/traces' : f.startsWith('realistic-logs') ? '/v1/logs' : f.startsWith('realistic-Loki') ? '/loki/api/v1/push' : f.startsWith('realistic-metrics') ? '/v1/metrics' : null)
  const out = []
  const t0 = Date.now()
  for (const f of files) {
    const path = kind(f)
    if (!path) continue
    const isJson = /json/i.test(f)
    let raw = new Uint8Array(readFileSync(join(dir, f)))
    const headers = { 'Content-Type': isJson ? 'application/json' : 'application/x-protobuf' }
    // Loki protobuf goes snappy on the wire (bodies.mjs's realistic Loki case already is).
    if (path === '/loki/api/v1/push' && !isJson && !/snappy/i.test(f)) raw = snappy.compress(raw)
    const r = await call({ op: 'raw', client: 'hostile', tenant: 's10-hostile', path, headers, bodyB64: gzipSync(raw).toString('base64'), gunzip: true })
    out.push({ file: f, path, bytes: raw.length, ...r })
    console.log(`${f.padEnd(70)} ${String(r.status).padEnd(4)} ${r.ms} ms ${r.partial ? `partial ${JSON.stringify(r.partial).slice(0, 150)}` : (r.text ?? r.error ?? '').slice(0, 150).replace(/\s+/g, ' ')}`)
  }
  // Oversized: 9 MiB on the wire (413 before decoding), and a gzip body of 9 MiB inflated.
  const nine = new Uint8Array(9 << 20).fill(0x0a)
  for (const [name, headers, body] of [
    ['oversized: 9 MiB protobuf body', { 'Content-Type': 'application/x-protobuf' }, { bodyB64: gzipSync(nine).toString('base64'), gunzip: true }],
    ['oversized: gzip body inflating to 9 MiB', { 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'gzip' }, { bodyB64: gzipSync(nine).toString('base64'), gunzip: false }],
  ]) {
    const r = await call({ op: 'raw', client: 'hostile', tenant: 's10-hostile', path: '/v1/traces', headers, ...body })
    out.push({ file: name, path: '/v1/traces', ...r })
    console.log(`${name.padEnd(70)} ${String(r.status).padEnd(4)} ${r.ms} ms ${(r.text ?? r.error ?? JSON.stringify(r.partial)).slice(0, 150).replace(/\s+/g, ' ')}`)
  }
  mark('hostile', t0, Date.now(), { tenant: 's10-hostile' })
  console.log(save('hostile', out))
}

/** Metrics path sanity: Remote Write through the gateway, then read back. */
async function metrics() {
  const run = `s10-${Date.now()}`
  const t0 = Date.now()
  const w = []
  for (let i = 0; i < 3; i++) w.push(await call({ op: 'rw', client: 'metrics', tenant: 's10-q', name: 'viz_s10_sanity', run, series: 4 }))
  console.log(`remote write: ${w.map((x) => `${x.status} ${x.ms} ms`).join(', ')}`)
  const enc = encodeURIComponent
  const r1 = await q('count of the run\'s series', 's10-q', `/api/v1/query?query=${enc(`count(viz_s10_sanity{run="${run}"})`)}`, 2, 300)
  const r2 = await q('sum of the run\'s samples', 's10-q', `/api/v1/query?query=${enc(`sum(viz_s10_sanity{run="${run}"})`)}`, 1, 300)
  const r3 = await q('a metrics read with no series filter', 's10-q', `/api/v1/query?query=${enc('count({__name__=~".+"})')}`, 1, 300)
  const r4 = await q('series of the tenant (signals-aware)', 's10-q', `/api/v1/series?${new URLSearchParams({ 'match[]': '{__name__=~"viz_s10.*"}' })}`, 1, 300)
  mark('metrics', t0, Date.now(), { tenant: 's10-q' })
  console.log(save('metrics', { run, writes: w, reads: [r1, r2, r3, r4] }))
}

/** Acknowledgement → served from a file: ask for marker traces until the tail has nothing and a file answers. */
async function filepoll(file, maxMin = 25) {
  const res = JSON.parse(readFileSync(file, 'utf8'))
  const recs = res.flatMap((r) => r.traces.records ?? []).slice(0, 3)
  const out = []
  for (const m of recs) out.push({ id: m.id, ackAt: m.ackAt, polls: [] })
  const end = Date.now() + maxMin * 60_000
  while (Date.now() < end && out.some((o) => o.servedFromFileMs === undefined)) {
    for (const o of out) {
      if (o.servedFromFileMs !== undefined) continue
      const r = await call({ op: 'query', client: 'filepoll', tenant: 's10-q', path: `/api/traces/${o.id}`, repeat: 1, keep: 120 })
      const x = r.records?.[0]
      if (!x) continue
      const h = x.headers
      o.polls.push({ at: x.at, status: x.status, files: h['x-viz-files-read'], tail: h['x-viz-tail-batches'], tailBytes: h['x-viz-tail-bytes'] })
      if (x.status === 200 && Number(h['x-viz-tail-batches'] ?? 1) === 0 && Number(h['x-viz-files-read'] ?? 0) > 0) {
        o.servedFromFileMs = x.at - o.ackAt
        console.log(`trace ${o.id}: served from a file ${(o.servedFromFileMs / 1000).toFixed(1)} s after its acknowledgement (${o.polls.length} polls)`)
      }
    }
    await sleep(20_000)
  }
  console.log(save('filepoll', out))
}

/** Every object in the stage's bucket: key, size, upload time (R2 REST listing). */
async function r2list() {
  const bucket = `viz-${STAGE}-lake`
  const objs = []
  let cursor
  for (;;) {
    const p = new URLSearchParams({ per_page: '1000' })
    if (cursor) p.set('cursor', cursor)
    const j = await cfm.cf('GET', `/r2/buckets/${bucket}/objects?${p}`)
    for (const o of j.result ?? []) objs.push({ key: o.key, size: o.size, uploaded: o.last_modified })
    cursor = j.result_info?.cursor
    if (!cursor || !j.result_info?.is_truncated) break
  }
  const f = save('r2list', objs)
  const groups = {}
  for (const o of objs) {
    const m = /tenant=([^/]+)\/(spans|trace_index|logs|metric_samples|metric_series)\//.exec(o.key)
    const g = m ? `${m[1]} ${m[2]} ${/\/L[12]-/.test(o.key) ? 'compacted' : 'flushed'}` : o.key.split('/').slice(0, 3).join('/')
    groups[g] ??= { n: 0, bytes: 0, sizes: [] }
    groups[g].n++
    groups[g].bytes += o.size
    groups[g].sizes.push(o.size)
  }
  for (const [g, v] of Object.entries(groups).sort()) console.log(`${g.padEnd(60)} ${String(v.n).padStart(5)} objects, ${(v.bytes / 2 ** 20).toFixed(2)} MiB, size p50 ${pct(v.sizes, 50)} max ${Math.max(...v.sizes)}`)
  console.log(f)
}

/** A local copy of the bucket's Iceberg metadata and of some tenants' data files, for readback.py. */
async function fetchCopy(tenants, outDir) {
  const bucket = `viz-${STAGE}-lake`
  const keys = []
  let cursor
  for (;;) {
    const p = new URLSearchParams({ per_page: '1000' })
    if (cursor) p.set('cursor', cursor)
    const j = await cfm.cf('GET', `/r2/buckets/${bucket}/objects?${p}`)
    for (const o of j.result ?? []) keys.push(o.key)
    cursor = j.result_info?.cursor
    if (!cursor || !j.result_info?.is_truncated) break
  }
  const want = keys.filter((k) => /^cell-0\/iceberg\/(spans|trace_index|logs)\//.test(k) || tenants.some((t) => k.includes(`/tenant=${t}/`) && /^cell-0\/data\/(spans|trace_index|logs)\//.test(k)))
  let bytes = 0
  const queue = [...want]
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let k = queue.shift(); k !== undefined; k = queue.shift()) {
      const res = await cfm.cf('GET', `/r2/buckets/${bucket}/objects/${encodeURIComponent(k)}`, undefined, { raw: true })
      if (!res.ok) throw new Error(`GET ${k}: ${res.status}`)
      const b = new Uint8Array(await res.arrayBuffer())
      mkdirSync(join(outDir, k, '..'), { recursive: true })
      writeFileSync(join(outDir, k), b)
      bytes += b.length
    }
  }))
  console.log(`fetched ${want.length} objects, ${(bytes / 2 ** 20).toFixed(2)} MiB, into ${outDir}`)
}

const [cmd, ...rest] = process.argv.slice(2)
const flag = (k) => {
  const i = rest.indexOf(`--${k}`)
  return i >= 0 ? rest[i + 1] : undefined
}
if (cmd === 'load-up') await loadUp(flag('expires'))
else if (cmd === 'load-down') await loadDown()
else if (cmd === 'ids') await recordIds()
else if (cmd === 'op') console.log(JSON.stringify(await call(JSON.parse(rest[0])), null, 1))
else if (cmd === 'markers') await markers(Number(flag('runs') ?? 3), flag('tenant') ?? 's10-q', flag('label') ?? 'markers')
else if (cmd === 'heavy') await heavy(flag('variants')?.split(',') ?? undefined, Number(flag('clients') ?? 4), Number(flag('requests') ?? 12), Number(flag('gap') ?? 70_000), { tenant: flag('tenant') ?? 's10-load', uniq: rest.includes('--uniq'), seedBase: Number(flag('seed-base') ?? 0), pauseMs: Number(flag('pause') ?? 0), label: flag('label') ?? 'heavy' })
else if (cmd === 'qdata') await qdata()
else if (cmd === 'fat') await fat()
else if (cmd === 'queries') await queries(flag('which') ?? 'all')
else if (cmd === 'margin') await margin(Number(flag('start')), Number(flag('window') ?? 2000), flag('tenant') ?? 's10-load', flag('trace') ?? null)
else if (cmd === 'hostile') await hostile()
else if (cmd === 'metrics') await metrics()
else if (cmd === 'filepoll') await filepoll(flag('file'), Number(flag('max') ?? 25))
else if (cmd === 'r2list') await r2list()
else if (cmd === 'fetch') await fetchCopy(flag('tenants').split(','), flag('out'))
else throw new Error(`unknown command ${cmd}`)
