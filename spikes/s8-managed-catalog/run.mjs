// Driver for spike S8 (second half). Runs on this machine; every exercise runs inside Cloudflare,
// in the Worker's Durable Objects. Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and
// S8_STATE (a scratch directory outside the repository for the endpoint key and raw output).
//
//   node run.mjs precheck     can this token use the managed catalog at all? (exit 2 if not)
//   node run.mjs up           bucket, catalog, Worker, secrets, data files
//   node run.mjs deploy       Worker, secrets, data files only (the bucket must exist; no catalog needed)
//   node run.mjs probe        GET /v1/config from a Durable Object (reachability, front-door latency)
//   node run.mjs publish      the publisher's four end-to-end stages, both tables
//   node run.mjs contend      2, 4, 8 committers x 10 commits, REST and R2-native
//   node run.mjs unknown      lost responses, without and with an interfering writer
//   node run.mjs latency      200 uncontended commits each, REST and R2-native
//   node run.mjs probes       Idempotency-Key and duplicate snapshot id; expiry
//   node run.mjs readers      PyIceberg and DuckDB read the managed tables (S8_PYTHON = venv python)
//   node run.mjs analytics    Cloudflare's analytics API for the window of the run
//   node run.mjs down         drop tables, delete objects, disable the catalog, delete bucket and Worker, list
//
// Never prints the token or the key; secrets reach wrangler on stdin.
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const A = process.env.CLOUDFLARE_ACCOUNT_ID
const T = process.env.CLOUDFLARE_API_TOKEN
const STATE = process.env.S8_STATE
if (!A || !T || !STATE) throw new Error('needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and S8_STATE')
mkdirSync(STATE, { recursive: true })
const BUCKET = 'viz-spike-s8-catalog'
const WORKER = 'viz-spike-s8-managed-catalog'
const WAREHOUSE = `${A}_${BUCKET}`
const wrangler = join(here, 'node_modules/.bin/wrangler')
const results = join(here, 'results')
// Which implementations the contention and latency steps run: S8_CATALOGS=r2-native runs the baseline alone.
const CATALOGS = (process.env.S8_CATALOGS ?? 'rest,r2-native').split(',')
// Table names carry a run tag, so a rerun never appends to an earlier run's table.
const RUN = process.env.S8_RUN ?? 'a'
mkdirSync(results, { recursive: true })
const save = (name, v) => writeFileSync(join(results, name), JSON.stringify(v, null, 2) + '\n')
const stamp = () => new Date().toISOString()

async function api(method, path, body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${A}/${path}`, {
    method,
    headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, json: await r.json().catch(() => null) }
}

const MISSING = {
  write: 'Workers R2 Data Catalog Write (permission group d229766a2f7f4d299f20eaa8c9b1fde9): enable the catalog, create tables, commit',
  read: 'Workers R2 Data Catalog Read (45db74139a62490b9b60eb7c4f34994b): load tables, the readers',
}
const denied = (r) => (r.json?.errors ?? []).some((e) => e.code === 40306 || e.code === 10000) || r.status === 403

async function precheck() {
  const r = await api('GET', `basin-catalog/${BUCKET}`)
  if (denied(r)) {
    console.log(`blocked: ${JSON.stringify(r.json?.errors)}\nThe token needs, on the account (or on bucket ${BUCKET}):\n  - ${MISSING.write}\n  - ${MISSING.read}\n  - Workers R2 Storage Bucket Item Write (2efd5506f9c8494dacb1fa10a3e7d5b6), which it has`)
    process.exit(2)
  }
  console.log(`catalog API answers: ${r.status} ${JSON.stringify(r.json?.errors ?? r.json?.result).slice(0, 300)}`)
}

const keyFile = join(STATE, 'key')
const key = () => readFileSync(keyFile, 'utf8').trim()
const urlFile = join(STATE, 'url')
const workerUrl = () => readFileSync(urlFile, 'utf8').trim()

function wr(args, input) {
  const r = spawnSync(wrangler, args, { cwd: here, encoding: 'utf8', input, env: process.env, timeout: 300_000 })
  const out = `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => !/Proxy environment/.test(l)).join('\n')
  if (r.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed:\n${out.slice(-2000)}`)
  return out
}

async function call(path, body) {
  const r = await fetch(workerUrl() + path, { method: 'POST', headers: { 'x-key': key(), 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json()
  if (j.error) throw new Error(`${path}: ${j.error}\n${(j.stack ?? []).join('\n')}`)
  return j
}

/** Start a job (idempotent on the Worker's side) and poll its result: no request stays open for long. */
async function job(path, body) {
  const { names } = await call(path, body)
  const deadline = Date.now() + 16 * 60_000
  for (;;) {
    await new Promise((r) => setTimeout(r, 3_000))
    const rs = await call('/result', { names })
    if (rs.every((r) => r.state === 'done' || r.state === 'failed')) {
      const bad = rs.filter((r) => r.state !== 'done')
      if (bad.length) throw new Error(`${path}: ${JSON.stringify(bad.map((b) => b.error))}`)
      return { names, results: rs.map((r) => r.result) }
    }
    if (Date.now() > deadline) throw new Error(`${path}: not done after 16 minutes: ${JSON.stringify(rs.map((r) => r.state))}`)
  }
}

const fixture = JSON.parse(readFileSync(join(repo, 'publisher/test/fixtures/fixture.json'), 'utf8'))
const template = (() => {
  const [, f] = Object.entries(fixture.files).find(([, f]) => f.entry.table === 'metric_samples')
  return { tenant: f.tenant, entry: f.entry }
})()

async function up() {
  await precheck()
  const b = await api('POST', 'r2/buckets', { name: BUCKET })
  console.log(`bucket: ${b.status} ${JSON.stringify(b.json?.errors)}`)
  const e = await api('POST', `basin-catalog/${BUCKET}/enable`)
  if (!e.json?.success) throw new Error(`enable: ${e.status} ${JSON.stringify(e.json?.errors)}`)
  const g = await api('GET', `basin-catalog/${BUCKET}`)
  save('catalog.json', { at: stamp(), enable: e.json.result, get: g.json?.result })
  console.log(`catalog: ${JSON.stringify(e.json.result)}`)
  const uri = e.json.result.catalog_uri
  const cfg = readFileSync(join(here, 'wrangler.jsonc'), 'utf8')
  if (uri && !cfg.includes(uri)) throw new Error(`the catalog URI is ${uri}; put it in wrangler.jsonc (CATALOG_URI) and run up again`)
  await deploy()
}

/** The Worker, its secrets and the publisher's data files. Needs the bucket; not the catalog (the R2-native baseline runs without it). */
async function deploy() {
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(24).toString('hex'), { mode: 0o600 })
  if (!existsSync(join(results, 'started.json'))) save('started.json', { at: stamp() })
  wr(['deploy'])
  wr(['secret', 'put', 'KEY'], key())
  wr(['secret', 'put', 'CATALOG_TOKEN'], T)
  const sub = await api('GET', 'workers/subdomain')
  writeFileSync(urlFile, `https://${WORKER}.${sub.json.result.subdomain}.workers.dev`)
  // The publisher's 54 data files, at the keys the ledgers list them under.
  const entries = Object.entries(fixture.files)
  for (let i = 0; i < entries.length; i += 6) {
    await Promise.all(
      entries.slice(i, i + 6).map(async ([k, f]) => {
        const r = await fetch(`${workerUrl()}/object?key=${encodeURIComponent(k)}`, { method: 'PUT', headers: { 'x-key': key() }, body: Buffer.from(f.b64, 'base64') })
        if (!r.ok) throw new Error(`upload ${k}: ${r.status}`)
      }),
    )
  }
  console.log(`deployed ${workerUrl()}; uploaded ${entries.length} data files`)
}

async function probe() {
  const colo = await (await fetch(workerUrl() + '/colo', { headers: { 'x-key': key() } })).json()
  const p = await call('/probe', { n: 20 })
  save('probe.json', { at: stamp(), colo, ...p })
  console.log(JSON.stringify({ colo, ...p }, null, 1))
}

async function publish() {
  const exp = join(repo, 'publisher/export/expected.json')
  if (!existsSync(exp)) throw new Error('publisher/export/expected.json is missing: run `npm test` in publisher/ first (its end-to-end test writes it)')
  const expected = JSON.parse(readFileSync(exp, 'utf8'))
  const out = { at: stamp(), ns: 'cell_0', setup: {}, stages: [] }
  for (const table of ['metric_samples', 'metric_series']) out.setup[table] = await call('/setup', { catalog: 'rest', ns: 'cell_0', name: table, table })
  for (const cp of expected.checkpoints) {
    const stage = { name: cp.name, tables: {} }
    for (const table of ['metric_samples', 'metric_series']) {
      const keys = Object.values(cp.tables[table].files).flat()
      const files = keys.map((k) => ({ tenant: fixture.files[k].tenant, entry: fixture.files[k].entry }))
      const r = await call('/publish', { catalog: 'rest', ns: 'cell_0', name: table, table, stage: cp.name, files })
      stage.tables[table] = { snapshotId: r.snapshotId, status: r.result.status, attempts: r.result.attempts.length, liveEqualsStage: r.liveEqualsStage, files: r.live, problems: r.problems, r2NativeSnapshotId: cp.tables[table].snapshotId, r2NativeMetadataVersion: cp.tables[table].metadataVersion }
      console.log(`${cp.name} ${table}: ${r.result.status}, live = stage: ${r.liveEqualsStage}, ${r.live} files, problems ${JSON.stringify(r.problems)}`)
    }
    out.stages.push(stage)
  }
  save('publish.json', out)
}

async function contend() {
  const out = []
  for (const catalog of CATALOGS) {
    for (const n of (process.env.S8_COMMITTERS ?? '2,4,8').split(',').map(Number)) {
      const name = `contend_${catalog.replace('-', '')}_${n}_${RUN}`
      await call('/setup', { catalog, ns: 'bench', name, table: 'metric_samples' })
      const { names } = await job('/contend', { catalog, ns: 'bench', name, table: 'metric_samples', committers: n, commits: 10, template, run: `${name}-${Date.now()}` })
      const r = await call('/contend-summary', { catalog, ns: 'bench', name, table: 'metric_samples', names })
      out.push({ catalog, name, ...r })
      console.log(`${catalog} x${n}: ${r.succeeded}/${r.commits} committed, ${r.conflicts} conflicts, ${r.unknowns} unknown, attempts/commit p50 ${r.attemptsPerCommit.p50} max ${r.attemptsPerCommit.max}, statuses ${JSON.stringify(r.statuses)}, chain ok ${r.verify.ok} (${r.verify.chain})`)
    }
  }
  save(`contend${CATALOGS.length === 1 ? '-' + CATALOGS[0] : ''}-${RUN}.json`, { at: stamp(), runs: out })
}

async function unknown() {
  const delays = [0, 10, 25, 50, 75, 100, 150, 200, 300, 500]
  const out = {}
  for (const [name, interfere, trials] of [['unknown_alone', false, 30], ['unknown_interfere', true, 20]]) {
    await call('/setup', { catalog: 'rest', ns: 'bench', name, table: 'metric_samples' })
    out[name] = (await job('/unknown', { catalog: 'rest', ns: 'bench', name, table: 'metric_samples', trials, delays, interfere, template, run: `${name}-${Date.now()}`, settleMs: 10_000 })).results[0]
    const t = out[name].trials
    console.log(`${name}: ${t.length} trials; ${t.filter((x) => x.attempts.length === 1).length} landed despite the lost answer; ${t.filter((x) => x.status === 'committed').length} committed by a resubmission or rebase; ${t.filter((x) => x.landedLate).length} landed late; verify ${JSON.stringify(out[name].verify)}`)
  }
  save('unknown.json', { at: stamp(), delays, ...out })
}

async function latency() {
  const out = {}
  for (const catalog of CATALOGS) {
    const name = `latency_${catalog.replace('-', '')}_${RUN}`
    await call('/setup', { catalog, ns: 'bench', name, table: 'metric_samples' })
    const batches = []
    for (let b = 0; b < 4; b++) batches.push((await job('/latency', { catalog, ns: 'bench', name, table: 'metric_samples', n: 50, template, run: `${name}-${b}-${Date.now()}` })).results[0])
    out[catalog] = batches
    console.log(`${catalog}: ${batches.map((x) => `commit p50 ${x.commit.p50} p90 ${x.commit.p90} p99 ${x.commit.p99}`).join(' | ')}`)
  }
  const tag = CATALOGS.length === 1 ? '-' + CATALOGS[0] : ''
  save(`latency${tag}.raw.json`, out)
  // Quantiles over all 200 per catalog, from the raw attempts (first attempt of each commit).
  const q = (xs) => {
    const s = [...xs].sort((a, b) => a - b)
    const at = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]
    return { n: s.length, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: s.at(-1) }
  }
  const summary = {}
  for (const [catalog, batches] of Object.entries(out)) {
    const first = batches.flatMap((b) => b.raw.map((attempts) => attempts[0]))
    summary[catalog] = { load: q(first.map((a) => a[2])), build: q(first.map((a) => a[3])), commit: q(first.map((a) => a[4])), notFirstTime: batches.reduce((a, b) => a + b.notFirstTime, 0) }
  }
  save(`latency${tag}.json`, { at: stamp(), summary })
  console.log(JSON.stringify(summary, null, 1))
}

async function probes() {
  await call('/setup', { catalog: 'rest', ns: 'bench', name: 'probe', table: 'metric_samples' })
  const idem = await call('/idempotency', { catalog: 'rest', ns: 'bench', name: 'probe', table: 'metric_samples', template, run: `idem-${Date.now()}` })
  const exp = await call('/expire', { catalog: 'rest', ns: 'bench', name: `latency_rest_${RUN}`, table: 'metric_samples', keep: 2, template, run: `exp-${Date.now()}` })
  save('probes.json', { at: stamp(), idempotency: idem, expire: exp })
  console.log(JSON.stringify({ idem, exp }, null, 1))
}

function readers() {
  const py = process.env.S8_PYTHON ?? 'python3'
  const r = spawnSync(py, ['-I', join(here, 'readers.py'), '--catalog-uri', JSON.parse(readFileSync(join(results, 'catalog.json'), 'utf8')).enable.catalog_uri, '--warehouse', WAREHOUSE], {
    cwd: here,
    encoding: 'utf8',
    env: { ...process.env, S8_CATALOG_TOKEN: T },
    timeout: 900_000,
  })
  console.log(r.stdout.slice(-6000), r.stderr.slice(-3000))
  if (r.status !== 0) process.exit(r.status ?? 1)
}

async function analytics() {
  const since = JSON.parse(readFileSync(join(results, 'started.json'), 'utf8')).at
  const until = stamp()
  const gql = async (query, variables) => {
    const r = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) })
    return r.json()
  }
  const catalog = await gql(
    `query($a:String!,$w:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){
      r2CatalogDataOperationsAdaptiveGroups(limit:1000,filter:{warehouseName:$w,datetime_geq:$s,datetime_leq:$u}){count dimensions{operation httpStatus} sum{requestDurationMs} quantiles{requestDurationMsP50 requestDurationMsP90 requestDurationMsP99}}
      r2CatalogTableMaintenanceAdaptiveGroups(limit:100,filter:{warehouseName:$w,datetime_geq:$s,datetime_leq:$u}){count dimensions{jobType tableName success}}}}}`,
    { a: A, w: WAREHOUSE, s: since, u: until },
  )
  const workers = await gql(
    `query($a:String!,$n:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){
      workersInvocationsAdaptive(limit:100,filter:{scriptName:$n,datetime_geq:$s,datetime_leq:$u}){sum{requests subrequests errors} quantiles{cpuTimeP50 cpuTimeP99}}}}}`,
    { a: A, n: WORKER, s: since, u: until },
  )
  const r2 = await gql(
    `query($a:String!,$b:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){
      r2OperationsAdaptiveGroups(limit:100,filter:{bucketName:$b,datetime_geq:$s,datetime_leq:$u}){sum{requests} dimensions{actionType}}
      r2StorageAdaptiveGroups(limit:10,filter:{bucketName:$b,datetime_geq:$s,datetime_leq:$u}){max{objectCount payloadSize metadataSize}}}}}`,
    { a: A, b: BUCKET, s: since, u: until },
  )
  const ns = ((await api('GET', 'workers/durable_objects/namespaces?per_page=100')).json?.result ?? []).filter((n) => n.script === WORKER)
  const dobj = ns.length
    ? await gql(
        `query($a:String!,$ids:[String!],$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){
          durableObjectsPeriodicGroups(limit:100,filter:{namespaceId_in:$ids,datetimeHour_geq:$s,datetimeHour_leq:$u}){sum{activeTime duration cpuTime}}
          durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{namespaceId_in:$ids,datetimeHour_geq:$s,datetimeHour_leq:$u}){sum{requests}}}}}`,
        { a: A, ids: ns.map((n) => n.id), s: since.slice(0, 13) + ':00:00Z', u: until },
      )
    : null
  save('analytics.json', { window: { since, until }, catalog, workers, durableObjects: dobj, r2 })
  console.log(JSON.stringify({ window: { since, until }, catalog, workers, durableObjects: dobj, r2 }, null, 1).slice(0, 8000))
}

async function down() {
  const log = []
  if (existsSync(urlFile) && existsSync(keyFile)) {
    try {
      log.push({ drop: await call('/drop', { ns: 'cell_0', names: ['metric_samples', 'metric_series'], purge: true }) })
      const bench = [...[2, 4, 8].map((n) => `contend_rest_${n}_${RUN}`), 'unknown_alone', 'unknown_interfere', `latency_rest_${RUN}`, 'probe']
      log.push({ drop: await call('/drop', { ns: 'bench', names: bench, purge: true }) })
      log.push({ wipe: await call('/wipe', { prefix: '' }) })
    } catch (e) {
      log.push({ error: String(e) })
    }
    try {
      wr(['delete', '--name', WORKER, '--force'])
      log.push({ worker: 'deleted' })
    } catch (e) {
      log.push({ worker: String(e).slice(0, 300) })
    }
  }
  log.push({ disable: (await api('POST', `basin-catalog/${BUCKET}/disable`)).json })
  log.push({ bucket: (await api('DELETE', `r2/buckets/${BUCKET}`)).json })
  const buckets = (await api('GET', 'r2/buckets?per_page=100')).json?.result?.buckets?.map((b) => b.name).filter((n) => n.startsWith('viz-spike-s8')) ?? null
  const scripts = (await api('GET', 'workers/scripts')).json?.result?.map((s) => s.id).filter((n) => n.startsWith('viz-spike-s8')) ?? null
  const catalogs = (await api('GET', 'basin-catalog')).json?.result?.warehouses?.map((w) => w.name).filter((n) => n.includes('viz-spike-s8')) ?? null
  log.push({ after: { at: stamp(), buckets, scripts, catalogs } })
  save('down.json', log)
  console.log(JSON.stringify(log, null, 1))
}

const steps = { precheck, up, deploy, probe, publish, contend, unknown, latency, probes, readers, analytics, down }
const step = process.argv[2]
if (!steps[step]) throw new Error(`step: one of ${Object.keys(steps).join(', ')}`)
await steps[step]()
