#!/usr/bin/env node
// The real viz API, locally: `wrangler dev --local` of real/wrangler.jsonc (the gateway, the
// write path, the query Worker and the control plane in one script), a tenant provisioned
// through the gateway's one-time bootstrap, its keys, and the seed data.
//
//   node real/stack.mjs start  [--port 8851]   start wrangler dev in the background, provision, make keys
//   node real/stack.mjs seed                   real/seed.ts: Remote Write the mock's data and 200 synthetic series
//   node real/stack.mjs status                 is it up; which keys exist (names only)
//   node real/stack.mjs stop                   stop wrangler dev
//
// Everything it writes is under real/.wrangler/ (git-ignored): the local state (Durable
// Objects, R2, KV, queues), wrangler.pid, the log, and keys.json (mode 0600). Keys are never
// printed. The Cloudflare credentials are removed from wrangler's environment, and --local
// keeps every binding local: nothing here reaches Cloudflare.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const DIR = path.join(HERE, '.wrangler')
const STATE = path.join(DIR, 'state')
const PID = path.join(DIR, 'wrangler.pid')
const LOG = path.join(DIR, 'wrangler.log')
const KEYS = path.join(DIR, 'keys.json')
const ENVFILE = path.join(DIR, 'bootstrap.env')
const WRANGLER = path.resolve(APP, '../query/node_modules/wrangler/bin/wrangler.js')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const PORT = Number(arg('port', process.env.VIZ_REAL_PORT ?? '8851'))
const BASE = `http://127.0.0.1:${PORT}`
export const TENANT = 'viz-app-e2e'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 200 when the gateway and the three backends this script serves (ingest, query, control)
 * answer. The gateway's /healthz also asks ruler and MCP, which this local stack does not
 * include, and then answers 503 with each backend's state: that counts as up when those three are.
 */
async function up() {
  try {
    const res = await fetch(`${BASE}/healthz`)
    const text = await res.text()
    if (res.status !== 503) return res.status
    const b = JSON.parse(text).backends ?? {}
    return ['ingest', 'query', 'control'].every((k) => b[k]?.ok) ? 200 : 503
  } catch {
    return 0
  }
}

function running() {
  try {
    const pid = Number(fs.readFileSync(PID, 'utf8'))
    process.kill(pid, 0)
    return pid
  } catch {
    return 0
  }
}

async function post(url, key, body) {
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  let json = null
  try {
    json = await res.json()
  } catch {}
  return { status: res.status, json }
}

async function start() {
  if (running()) throw new Error(`already running (pid ${running()}); node real/stack.mjs stop first`)
  fs.mkdirSync(DIR, { recursive: true })
  // A fresh state every time: the seed is deterministic and the tenant is provisioned once per state.
  fs.rmSync(STATE, { recursive: true, force: true })
  fs.rmSync(KEYS, { force: true })
  // The one-time bootstrap secret (deploy/bootstrap.mjs's shape): only the token's hash goes
  // to the Worker, through an env file, never a command line.
  const token = randomBytes(32).toString('base64url')
  const secret = JSON.stringify({ tenant: TENANT, tokenSha256: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 10 * 60_000 })
  fs.writeFileSync(ENVFILE, `VIZ_BOOTSTRAP='${secret}'\n`, { mode: 0o600 })
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }
  delete env.CLOUDFLARE_API_TOKEN
  delete env.CLOUDFLARE_ACCOUNT_ID
  const out = fs.openSync(LOG, 'w')
  const child = spawn(
    process.execPath,
    [WRANGLER, 'dev', '--local', '-c', path.join(HERE, 'wrangler.jsonc'), '--ip', '127.0.0.1', '--port', String(PORT), '--persist-to', STATE, '--env-file', ENVFILE, '--show-interactive-dev-session=false', '--log-level', 'warn'],
    { cwd: HERE, env, detached: true, stdio: ['ignore', out, out] },
  )
  fs.writeFileSync(PID, String(child.pid))
  child.unref()
  const t0 = Date.now()
  while ((await up()) !== 200) {
    if (!running()) throw new Error(`wrangler dev exited; see ${LOG}`)
    if (Date.now() - t0 > 180_000) throw new Error(`not healthy after 180 s; see ${LOG}`)
    await sleep(1000)
  }
  console.log(`stack: healthy at ${BASE} after ${((Date.now() - t0) / 1000).toFixed(1)} s (pid ${child.pid})`)

  const boot = await post(`${BASE}/api/v1/bootstrap`, token)
  fs.rmSync(ENVFILE, { force: true })
  if (boot.status !== 201) throw new Error(`bootstrap: HTTP ${boot.status} ${JSON.stringify(boot.json)}`)
  const admin = boot.json.key
  const keys = { tenant: TENANT, admin }
  // A key per use: the app reads, the seed writes, and one of each kind lacks the other scope.
  for (const [name, scopes] of [['read', ['read']], ['write', ['write']]]) {
    const r = await post(`${BASE}/api/v1/control/keys`, admin, { name: `app-${name}`, scopes, kind: 'key' })
    if (r.status !== 201) throw new Error(`create key ${name}: HTTP ${r.status} ${JSON.stringify(r.json)}`)
    keys[name] = r.json.secret
  }
  fs.writeFileSync(KEYS, JSON.stringify(keys, null, 2), { mode: 0o600 })
  console.log(`stack: tenant ${TENANT} provisioned; keys admin, read, write written to ${path.relative(APP, KEYS)} (not printed)`)
}

function stop() {
  const pid = running()
  if (!pid) return console.log('stack: not running')
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    process.kill(pid, 'SIGTERM')
  }
  fs.rmSync(PID, { force: true })
  console.log(`stack: stopped (pid ${pid})`)
}

async function main() {
  const cmd = process.argv[2]
  if (cmd === 'start') await start()
  else if (cmd === 'stop') stop()
  else if (cmd === 'seed') {
    const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(HERE, 'seed.ts'), '--base', BASE, '--keys', KEYS], { cwd: APP, stdio: 'inherit' })
    process.exit(r.status ?? 1)
  } else if (cmd === 'status') {
    const keys = fs.existsSync(KEYS) ? Object.keys(JSON.parse(fs.readFileSync(KEYS, 'utf8'))).filter((k) => k !== 'tenant') : []
    console.log(`stack: pid ${running() || 'none'}, ${BASE}/healthz -> ${await up()}, keys: ${keys.join(', ') || 'none'}`)
  } else {
    console.error('usage: node real/stack.mjs start|seed|status|stop [--port 8851]')
    process.exit(2)
  }
}

main().catch((e) => {
  console.error(`stack: ${e.message}`)
  process.exit(1)
})
