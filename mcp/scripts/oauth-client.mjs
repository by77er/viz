#!/usr/bin/env node
/**
 * The whole OAuth flow of an MCP client against viz, scripted, with the official TypeScript SDK
 * v2 client (@modelcontextprotocol/client 2.4.0) doing the client's part: discovery from the 401,
 * dynamic registration, PKCE S256, the resource indicator, the issuer check, the code exchange,
 * calls, refresh with rotation, step-up on 403, and what happens when a used refresh token comes
 * back. The person's part (reading the authorization page, approving with their key, opening the
 * link) is scripted too, through the control API.
 *
 * Local only: `wrangler dev` on 127.0.0.1:8922 with test/oauth-dev (the real control plane and
 * agent surface, fake query service and ruler); nothing touches a Cloudflare account. The OAuth
 * signing key is generated for the run and passed in an env file, never on a command line.
 * Prints a transcript in which every credential is redacted, and checks that none leaked into it.
 *
 *   node scripts/oauth-client.mjs
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, InsufficientScopeError, StreamableHTTPClientTransport, UnauthorizedError, auth } from '@modelcontextprotocol/client'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8922
const BASE = `http://127.0.0.1:${PORT}`
const SERVER = `${BASE}/mcp`
const CALLBACK_PORT = 33418
const REDIRECT = `http://127.0.0.1:${CALLBACK_PORT}/callback`

const state = mkdtempSync(join(tmpdir(), 'viz-mcp-oauth-'))
const envFile = join(state, 'oauth.env')
writeFileSync(envFile, `OAUTH_CLIENT_KEY=${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 })
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }
delete env.CLOUDFLARE_API_TOKEN // local only: never authenticate to the account
delete env.CLOUDFLARE_ACCOUNT_ID

// ---- the transcript, with every credential redacted ----

const known = new Set()
const remember = (...xs) => xs.forEach((x) => typeof x === 'string' && x.length >= 8 && known.add(x))
function redact(s) {
  let out = String(s)
    .replace(/(vz[acr]1)\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9]{43}/g, '$1.<tenant>.<redacted>')
    .replace(/viz_[A-Za-z0-9]{16}_[A-Za-z0-9]{40}/g, 'viz_<redacted>')
    .replace(/vzk1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}/g, 'vzk1.<client id>')
    .replace(/"request":"[A-Za-z0-9_-]+"/g, '"request":"<handle>"')
    .replace(/request: [A-Za-z0-9_-]+/g, 'request: <handle>')
  for (const k of known) out = out.split(k).join('<redacted>')
  return out
}
const lines = []
const say = (s = '') => {
  const l = redact(s)
  lines.push(l)
  console.log(l)
}
const checks = []
function check(what, ok) {
  checks.push([what, ok])
  say(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
}

/** fetch, traced: method, path, the names of query parameters (values hidden), status, the challenge. */
async function traced(input, init) {
  const req = new Request(input, init)
  const res = await fetch(req)
  const u = new URL(req.url)
  const names = [...u.searchParams.keys()]
  const www = res.headers.get('WWW-Authenticate')
  say(`  ${req.method} ${u.pathname}${names.length ? `?${names.join('&')}` : ''} -> ${res.status}${www ? `   WWW-Authenticate: ${www}` : ''}`)
  return res
}

class Provider {
  info = undefined
  saved = undefined
  verifier = ''
  authUrl = null
  st = randomBytes(12).toString('base64url')
  get redirectUrl() {
    return REDIRECT
  }
  get clientMetadata() {
    return { client_name: 'viz scripted client', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native' }
  }
  state() {
    return this.st
  }
  clientInformation() {
    return this.info
  }
  saveClientInformation(i) {
    this.info = i
  }
  tokens() {
    return this.saved
  }
  saveTokens(t) {
    this.saved = t
    remember(t.access_token, t.refresh_token)
  }
  redirectToAuthorization(u) {
    this.authUrl = u
  }
  saveCodeVerifier(v) {
    this.verifier = v
    remember(v)
  }
  codeVerifier() {
    return this.verifier
  }
  // SEP-2352: the authorization server this flow started with, kept beside the verifier so the callback leg is bound to it.
  disc = undefined
  saveDiscoveryState(s) {
    this.disc = s
  }
  discoveryState() {
    return this.disc
  }
}

/** The client's redirect URI: a local listener, as a desktop MCP host has. Resolves with the callback's query. */
function callbackServer() {
  let resolve
  const got = new Promise((r) => (resolve = r))
  const server = createServer((req, res) => {
    const u = new URL(req.url, REDIRECT)
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('You can close this window.\n')
    resolve(u.searchParams)
  })
  return new Promise((ok) => server.listen(CALLBACK_PORT, '127.0.0.1', () => ok({ got, close: () => server.close() })))
}

async function ready(log) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('wrangler dev did not start:\n' + log().slice(-3000))
}

// Its own process group, so that stopping it stops wrangler and workerd too, not only npx.
const dev = spawn('npx', ['wrangler', 'dev', '--config', 'test/oauth-dev/wrangler.jsonc', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state, '--env-file', envFile, '--log-level', 'warn'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
async function stopDev() {
  try {
    process.kill(-dev.pid, 'SIGTERM')
  } catch {}
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(-dev.pid, 0)
    } catch {
      return // the group is gone
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  try {
    process.kill(-dev.pid, 'SIGKILL')
  } catch {}
}
let devLog = ''
dev.stdout.on('data', (d) => (devLog += d))
dev.stderr.on('data', (d) => (devLog += d))

let code = 1
try {
  await ready(() => devLog)
  say(`viz OAuth flow, scripted: ${new Date().toISOString()}, wrangler dev on ${BASE} (local), client @modelcontextprotocol/client 2.4.0`)
  const prov = await (await fetch(`${BASE}/__local/provision`, { method: 'POST' })).json()
  const person = prov.person
  remember(person)
  say(`\n0. setup (local only): tenant ${prov.tenant} with telemetry; a person's key "Dana" (admin and the five grantable scopes)`)

  say('\n1. the client connects with no token: 401, then discovery, registration and the authorization URL')
  const provider = new Provider()
  const opts = { authProvider: provider, fetch: traced, onInsufficientScope: 'throw' }
  let client = new Client({ name: 'viz-scripted-client', version: '1.0.0' })
  let transport = new StreamableHTTPClientTransport(new URL(SERVER), opts)
  const first = await client.connect(transport).then(() => null, (e) => e)
  check('connect without a token ends in UnauthorizedError after redirectToAuthorization', first instanceof UnauthorizedError && provider.authUrl !== null)
  const au = provider.authUrl
  check('registered as a public client (vzk1 client id, no secret)', /^vzk1\./.test(provider.info?.client_id ?? '') && provider.info?.client_secret === undefined)
  check('authorization URL: S256 challenge, resource = the MCP endpoint, scope from the 401 challenge', au.searchParams.get('code_challenge_method') === 'S256' && au.searchParams.get('resource') === SERVER && au.searchParams.get('scope') === 'read dashboards:read monitors:read')

  say('\n2. the person opens the authorization URL (a plain-text page; no sign-in page exists yet)')
  const pageRes = await traced(au)
  const page = await pageRes.text()
  for (const l of page.split('\n').slice(0, 12)) say(`  | ${l}`)
  const handle = /^request: (\S+)$/m.exec(page)?.[1]
  check('the page shows the client name, the redirect host and the approval command', page.includes('viz scripted client') && page.includes(`127.0.0.1:${CALLBACK_PORT}`) && page.includes('/api/v1/control/oauth/approve') && Boolean(handle))

  say('\n3. the person previews (dryRun), then approves with their key')
  const approve = async (body) => {
    const r = await traced(`${BASE}/api/v1/control/oauth/approve`, { method: 'POST', headers: { Authorization: `Bearer ${person}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json() }
  }
  const preview = await approve({ request: handle, dryRun: true })
  say(`  preview: scopes ${preview.body.grant.scopes.join(' ')}; returns to ${preview.body.returnsTo.host}; redirect ${preview.body.redirect}`)
  for (const w of preview.body.warnings) say(`  warning: ${w}`)
  const approved = await approve({ request: handle })
  check('approved: 201, grant live with the asked scopes, a redirect carrying code, state and iss', approved.status === 201 && approved.body.grant.status === 'live' && /[?&]code=vzc1\./.test(approved.body.redirect) && approved.body.redirect.includes('iss='))
  const grantId = approved.body.grant.id

  say('\n4. the browser opens the redirect; the client\'s listener gets the code; the SDK checks iss and exchanges it')
  const cb = await callbackServer()
  await fetch(approved.body.redirect)
  const params = await cb.got
  cb.close()
  remember(params.get('code'))
  check('state is the one the client sent', params.get('state') === provider.st)
  await transport.finishAuth(params.get('code'), params.get('iss') ?? undefined)
  check('tokens: Bearer, 3600 s, the granted scopes, a refresh token', provider.saved?.token_type === 'Bearer' && provider.saved?.expires_in === 3600 && provider.saved?.scope === 'read dashboards:read monitors:read' && Boolean(provider.saved?.refresh_token))

  say('\n5. connected: tools for the granted scopes, and the tenant\'s data')
  client = new Client({ name: 'viz-scripted-client', version: '1.0.0' })
  transport = new StreamableHTTPClientTransport(new URL(SERVER), opts)
  await client.connect(transport)
  const tools = (await client.listTools()).tools.map((t) => t.name)
  say(`  tools: ${tools.join(', ')}`)
  check('read tools offered, write_dashboard not (no dashboards:write)', tools.includes('search_telemetry') && tools.includes('list_monitors') && !tools.includes('write_dashboard'))
  const found = await client.callTool({ name: 'search_telemetry', arguments: { q: 'checkout latency', max_tokens: 300 } })
  say(`  search_telemetry: ${found.content[0].text.split('\n')[0]}`)
  check('search_telemetry answers from the tenant\'s telemetry', found.isError === false && found.content[0].text.includes('http_server_request_duration_seconds_bucket'))

  say('\n6. a tool the grant lacks: 403 insufficient_scope; the SDK reports the scopes to ask for (step-up)')
  const denied = await client.callTool({ name: 'write_dashboard', arguments: { id: 'x', ops: [] } }).then(() => null, (e) => e)
  check(`InsufficientScopeError, required scope "${denied?.requiredScope}"`, denied instanceof InsufficientScopeError && denied.requiredScope === 'dashboards:write read')

  say('\n7. refresh: the SDK refreshes; the refresh token rotates')
  const oldRefresh = provider.saved.refresh_token
  const r = await auth(provider, { serverUrl: SERVER, fetchFn: traced })
  check('refreshed (AUTHORIZED), with a new refresh token', r === 'AUTHORIZED' && provider.saved.refresh_token !== oldRefresh)
  const again = await client.callTool({ name: 'list_monitors', arguments: {} })
  check('the new access token works', again.isError === false)

  say('\n8. the old refresh token comes back (someone kept a copy): refused, and the whole grant is revoked')
  const reuse = await traced(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: provider.info.client_id }) })
  const reuseBody = await reuse.json()
  say(`  answer: ${JSON.stringify(reuseBody)}`)
  check('400 invalid_grant', reuse.status === 400 && reuseBody.error === 'invalid_grant')
  const raw = await traced(SERVER, { method: 'POST', headers: { Authorization: `Bearer ${provider.saved.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
  check('the current access token is refused at once: 401 invalid_token', raw.status === 401 && (raw.headers.get('WWW-Authenticate') ?? '').includes('error="invalid_token"'))
  const grants = await (await traced(`${BASE}/api/v1/control/oauth/grants?status=all`, { headers: { Authorization: `Bearer ${person}` } })).json()
  const g = grants.items.find((x) => x.id === grantId)
  say(`  grant ${g.id}: status ${g.status}, reason ${g.revokeReason}, revoked by ${g.revokedBy?.subject}, key ${g.key}`)
  check('the person sees the grant revoked for refresh-reuse, its key gone', g.status === 'revoked' && g.revokeReason === 'refresh-reuse' && g.key === null)

  const leaked = [...known].filter((k) => lines.some((l) => l.includes(k)))
  check(`no credential in this transcript (${known.size} checked)`, leaked.length === 0)
  const failed = checks.filter(([, ok]) => !ok)
  say(`\n${checks.length - failed.length} of ${checks.length} checks passed`)
  code = failed.length ? 1 : 0
} catch (e) {
  console.error(redact(e instanceof Error ? e.stack ?? e.message : String(e)))
  console.error(redact(devLog.slice(-3000)))
} finally {
  await stopDev()
  rmSync(state, { recursive: true, force: true })
}
process.exit(code)
