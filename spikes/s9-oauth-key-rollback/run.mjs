#!/usr/bin/env node
// Spike S9 driver: a rollback across the release that created viz-control's OAUTH_CLIENT_KEY
// (deploy/README.md, Known risks; design/DECISIONS.md D53). Read README.md first.
//
// Everything runs against a checkout named by --tree (a git worktree of the commit under test),
// never the shared tree: the deploy tooling, its generated/ directory and its resources.json are
// the worktree's. Only stage s9 is touched, and only viz-s9-control and viz-s9-config.
//
//   node run.mjs inventory --tree T --out F        account inventory: counts per kind and every name starting viz-
//   node run.mjs kv --tree T                       create KV viz-s9-config (only), record its id in T/deploy/resources.json
//   node run.mjs configure --tree T --release R --expires ISO
//                                                  configure.mjs --stage s9, then narrow the manifest to viz-s9-control
//                                                  and give that Worker a workers.dev URL (it has no other way in)
//   node run.mjs deploy-r0 --tree T                release.mjs deploy, with lib/secrets.mjs's GENERATED_SECRETS
//                                                  emptied in this process: the tooling as it was before D53
//   node run.mjs versions --tree T                 viz-s9-control's versions (number, tag, VIZ_RELEASE, secret
//                                                  NAMES), the deployment serving, and the secret list's names
//   node run.mjs probe --tree T --label L --state F [--rounds N] [--interval S] [--register]
//                                                  HTTP probes from outside, with wrangler tail running so each
//                                                  answer is tied to the version that served it
//   node run.mjs analytics --tree T --since ISO --until ISO
//                                                  Workers and Durable Object invocations of viz-s9-control (GraphQL)
//   node run.mjs leftovers --tree T                anything named viz-s9-… that is still on the account
//
// No secret is ever read, printed or written by this script. The OAuth key exists only inside
// release.mjs and wrangler. Which key serves is judged by whether a client id registered (signed)
// under an earlier release still verifies (/oauth/authorize answers 200) or not (400 "not
// registered"). The API token is read from the environment by the worktree's lib/cf.mjs and by
// wrangler, never placed on a command line.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const STAGE = 's9'
const WORKER = 'viz-s9-control'
const KV_TITLE = 'viz-s9-config'
const REDIRECT = 'https://example.invalid/s9/callback'
// A syntactically valid PKCE challenge (43 base64url characters); nothing is ever exchanged.
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

function args(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--register') out.register = true
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i]
    else out._.push(a)
  }
  return out
}

const A = args(process.argv.slice(2))
if (!A.tree && A._[0] !== 'help') throw new Error('--tree <worktree> is required')
const TREE = resolve(A.tree ?? '.')
const DEPLOY = join(TREE, 'deploy')
const mod = (p) => import(pathToFileURL(join(DEPLOY, p)).href)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString()

async function inventory() {
  const cf = await mod('lib/cf.mjs')
  const [scripts, buckets, kv, queues, domains, dos] = await Promise.all([
    cf.listScripts(),
    cf.cf('GET', '/r2/buckets?per_page=1000').then((j) => j.result?.buckets ?? []),
    cf.cfList('/storage/kv/namespaces'),
    cf.cfList('/queues'),
    cf.listCustomDomains(),
    cf.listDurableObjectNamespaces(),
  ])
  const viz = (names) => names.filter((n) => typeof n === 'string' && n.startsWith('viz-')).sort()
  const inv = {
    at: now(),
    counts: { workers: scripts.length, r2: buckets.length, kv: kv.length, queues: queues.length, customDomains: domains.length, durableObjectNamespaces: dos.length },
    viz: {
      workers: viz(scripts.map((s) => s.id)),
      r2: viz(buckets.map((b) => b.name)),
      kv: viz(kv.map((n) => n.title)),
      queues: viz(queues.map((q) => q.queue_name)),
      customDomains: domains.filter((d) => String(d.service).startsWith('viz-')).map((d) => `${d.hostname} → ${d.service}`),
      durableObjectNamespaces: [...new Set(viz(dos.map((d) => d.script ?? '')))].map((s) => `${s} (${dos.filter((d) => d.script === s).map((d) => d.class).join(', ')})`),
    },
  }
  const text = JSON.stringify(inv, null, 2)
  if (A.out) writeFileSync(A.out, text + '\n')
  console.log(text)
}

async function kv() {
  const cf = await mod('lib/cf.mjs')
  let ns = (await cf.cfList('/storage/kv/namespaces')).find((n) => n.title === KV_TITLE)
  if (ns) console.log(`${KV_TITLE} exists already (${ns.id})`)
  else {
    ns = (await cf.cf('POST', '/storage/kv/namespaces', { title: KV_TITLE })).result
    console.log(`created KV namespace ${KV_TITLE} (${ns.id})`)
  }
  const file = join(DEPLOY, 'resources.json')
  const r = JSON.parse(readFileSync(file, 'utf8'))
  r.kv_namespaces ??= {}
  r.kv_namespaces[KV_TITLE] = ns.id
  writeFileSync(file, JSON.stringify(r, null, 2) + '\n')
}

function run(cmd, argv, { cwd = TREE, env = {} } = {}) {
  return new Promise((res, rej) => {
    const c = spawn(cmd, argv, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] })
    c.on('error', rej)
    c.on('close', (code) => res(code))
  })
}

async function configure() {
  if (!A.release || !A.expires) throw new Error('configure needs --release and --expires')
  const code = await run('node', ['deploy/configure.mjs', '--stage', STAGE, '--release', A.release, '--expires', A.expires])
  if (code !== 0) throw new Error(`configure.mjs exited ${code}`)
  const dir = join(DEPLOY, 'generated', `stage-${STAGE}`)
  const mf = join(dir, 'manifest.json')
  const m = JSON.parse(readFileSync(mf, 'utf8'))
  const before = m.order
  m.order = m.order.filter((n) => n === WORKER)
  if (m.order.length !== 1) throw new Error(`${WORKER} is not in the manifest`)
  m.s9 = { narrowedFrom: before, why: 'spike S9: only viz-control is deployed (spikes/s9-oauth-key-rollback/README.md)' }
  writeFileSync(mf, JSON.stringify(m, null, 2) + '\n')
  const w = m.workers.find((x) => x.name === WORKER)
  const cfgFile = join(TREE, w.config)
  const text = readFileSync(cfgFile, 'utf8')
  const nl = text.indexOf('\n')
  const cfg = JSON.parse(text.slice(nl + 1))
  cfg.workers_dev = true
  writeFileSync(cfgFile, text.slice(0, nl + 1) + JSON.stringify(cfg, null, 2) + '\n')
  console.log(`manifest order narrowed to [${m.order}] (was ${before.length} Workers); ${w.config}: workers_dev true; VIZ_RELEASE ${cfg.vars.VIZ_RELEASE}`)
}

async function deployR0() {
  // The tooling before D53: no generated secrets. ES modules are singletons, so release.mjs sees the emptied array.
  const secrets = await mod('lib/secrets.mjs')
  const removed = secrets.GENERATED_SECRETS.splice(0)
  console.error(`s9: GENERATED_SECRETS emptied for this run (was: ${removed.map((s) => `${s.worker} ${s.name}`).join(', ')})`)
  const release = await mod('release.mjs')
  const r = await release.deploy({ stage: STAGE, ackText: A.ack ?? '' })
  console.error(`s9: release.mjs deploy returned exit ${r.exit}`)
  process.exit(r.exit)
}

async function versions() {
  const cf = await mod('lib/cf.mjs')
  const { secretNamesOf } = await mod('lib/secrets.mjs')
  const list = await cf.listVersions(WORKER)
  const dep = await cf.currentDeployment(WORKER)
  const serving = new Set((dep?.versions ?? []).map((v) => v.version_id))
  const rows = []
  for (const v of list) {
    const info = await cf.versionInfo(WORKER, v.id)
    const bindings = info?.resources?.bindings ?? []
    rows.push({
      number: v.number,
      id: v.id,
      serving: serving.has(v.id),
      tag: info?.annotations?.['workers/tag'] ?? v.annotations?.['workers/tag'] ?? null,
      message: info?.annotations?.['workers/message'] ?? v.annotations?.['workers/message'] ?? null,
      triggeredBy: info?.annotations?.['workers/triggered_by'] ?? v.annotations?.['workers/triggered_by'] ?? null,
      VIZ_RELEASE: bindings.find((b) => b.type === 'plain_text' && b.name === 'VIZ_RELEASE')?.text ?? null,
      secretNames: secretNamesOf(info),
    })
  }
  const secretList = (await cf.listSecrets(WORKER)).map((s) => `${s.name} (${s.type})`)
  const out = { at: now(), deployment: dep, secretList, versions: rows }
  console.log(JSON.stringify(out, null, 2))
  if (A.out) writeFileSync(A.out, JSON.stringify(out, null, 2) + '\n')
}

/** Top-level JSON objects in a stream of (possibly pretty-printed) JSON. */
function jsonObjects(text) {
  const out = []
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
    if (c === '"') inStr = depth > 0
    else if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}' && depth > 0) {
      depth--
      if (depth === 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)))
        } catch {}
      }
    }
  }
  return out
}

function startTail() {
  const bin = join(DEPLOY, 'node_modules', '.bin', 'wrangler')
  const child = spawn(bin, ['tail', WORKER, '--format', 'json'], { cwd: DEPLOY, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const t = { child, out: '', err: '', connected: false }
  child.stdout.on('data', (d) => {
    t.out += d.toString()
  })
  child.stderr.on('data', (d) => {
    t.err += d.toString()
  })
  return t
}

async function http(base, method, path, body) {
  const url = `${base}${path}${path.includes('?') ? '&' : '?'}s9=${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  const init = { method, headers: { 'user-agent': 'viz-spike-s9' } }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const t0 = Date.now()
  try {
    const res = await fetch(url, init)
    const text = await res.text()
    return { status: res.status, ms: Date.now() - t0, text }
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, text: String(e.cause?.code ?? e.message) }
  }
}

async function probe() {
  const cf = await mod('lib/cf.mjs')
  const sub = await cf.workersSubdomain()
  const base = `https://${WORKER}.${sub}.workers.dev`
  const stateFile = A.state
  if (!stateFile) throw new Error('probe needs --state <file> (client ids registered so far)')
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { clients: [] }
  const rounds = Number(A.rounds ?? 3)
  const interval = Number(A.interval ?? 10) * 1000
  const tail = startTail()
  // Give the tail time to attach; events before it attaches are not seen.
  for (let i = 0; i < 30 && !/Connected|waiting for logs/i.test(tail.out + tail.err); i++) await sleep(500)
  await sleep(2000)
  const results = []
  for (let r = 0; r < rounds; r++) {
    if (r > 0) await sleep(interval)
    const round = { round: r + 1, at: now() }
    const h = await http(base, 'GET', '/healthz')
    round.healthz = h.status
    const md = await http(base, 'GET', '/.well-known/oauth-authorization-server')
    let meta = null
    try {
      meta = JSON.parse(md.text)
    } catch {}
    round.metadata = { status: md.status, registration_endpoint: Boolean(meta?.registration_endpoint) }
    const reg = await http(base, 'POST', '/oauth/register', { redirect_uris: [REDIRECT], client_name: `s9 ${A.label}`, token_endpoint_auth_method: 'none' })
    let rj = null
    try {
      rj = JSON.parse(reg.text)
    } catch {}
    round.register = { status: reg.status, error: rj?.error ?? null }
    if (reg.status === 201 && A.register && !state.clients.some((c) => c.label === A.label)) {
      state.clients.push({ label: A.label, at: now(), clientId: rj.client_id })
      writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n')
      round.registered = `saved the client registered now as "${A.label}"`
    }
    round.authorize = {}
    for (const c of state.clients) {
      const q = new URLSearchParams({ client_id: c.clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 's9' })
      const a = await http(base, 'GET', `/oauth/authorize?${q}`)
      round.authorize[c.label] = a.status === 200 ? '200 verifies' : a.status === 400 && /not registered/.test(a.text) ? '400 not registered' : `${a.status} ${a.text.slice(0, 80)}`
    }
    results.push(round)
    console.error(`s9 probe ${A.label} round ${r + 1}: ${JSON.stringify(round)}`)
  }
  await sleep(4000)
  tail.child.kill('SIGINT')
  await sleep(1500)
  if (tail.child.exitCode === null) tail.child.kill('SIGKILL')
  const events = jsonObjects(tail.out)
    .filter((e) => e && e.event && e.event.request)
    .map((e) => ({ path: new URL(e.event.request.url).pathname, status: e.event.response?.status ?? null, version: e.scriptVersion?.id ?? null, outcome: e.outcome }))
  const byVersion = {}
  for (const e of events) byVersion[e.version ?? 'unknown'] = (byVersion[e.version ?? 'unknown'] ?? 0) + 1
  const dep = await cf.currentDeployment(WORKER)
  const summary = {
    label: A.label,
    at: now(),
    deployment: dep?.versions ?? null,
    tail: { events: events.length, byVersion, connected: /Connected|waiting/i.test(tail.out + tail.err) || events.length > 0 },
    rounds: results,
    tailEvents: events,
  }
  console.log(JSON.stringify(summary, null, 2))
  if (A.out) writeFileSync(A.out, JSON.stringify(summary, null, 2) + '\n')
}

async function analytics() {
  const { account } = await mod('lib/cf.mjs')
  const acct = account()
  const query = `query($a: String!, $since: Time!, $until: Time!, $w: String!) {
    viewer { accounts(filter: {accountTag: $a}) {
      workersInvocationsAdaptive(limit: 100, filter: {scriptName: $w, datetime_geq: $since, datetime_leq: $until}) {
        sum { requests subrequests errors } quantiles { cpuTimeP50 cpuTimeP99 } dimensions { scriptName status }
      }
      durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: {scriptName: $w, datetime_geq: $since, datetime_leq: $until}) {
        sum { requests } dimensions { scriptName }
      }
    } }
  }`
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { a: acct, since: A.since, until: A.until, w: A.worker ?? WORKER } }),
  })
  const j = await res.json()
  console.log(JSON.stringify({ window: [A.since, A.until], worker: A.worker ?? WORKER, status: res.status, errors: j.errors ?? null, data: j.data?.viewer?.accounts?.[0] ?? null }, null, 2))
}

async function leftovers() {
  const { leftovers: left } = await mod('resources.mjs')
  console.log(JSON.stringify(await left(STAGE), null, 2))
}

const cmds = { inventory, kv, configure, 'deploy-r0': deployR0, versions, probe, analytics, leftovers }
const cmd = cmds[A._[0]]
if (!cmd) {
  console.error(`usage: run.mjs ${Object.keys(cmds).join('|')} --tree <worktree> …`)
  process.exit(2)
}
await cmd()
