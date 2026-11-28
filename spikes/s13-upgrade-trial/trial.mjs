#!/usr/bin/env node
// S13: drives a staged viz through the checks of README.md ("The steps"). Nothing secret is printed:
// keys, the PKCE verifier and OAuth tokens live only in files of --state (mode 0600).
//
//   node trial.mjs seed    --url <gateway> --state DIR   step 1: a known series; an OAuth client and one grant
//   node trial.mjs after   --url <gateway> --state DIR   step 2: data read back; the old client, token and refresh
//   node trial.mjs limits  --url <gateway> --state DIR   step 2: the source limit at /oauth/register, the
//                                                        credential limit at /oauth/token
//
// DIR holds admin.key and smoke.key (deploy/bootstrap.mjs --key-file / --smoke-key-file).
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { instantQuery, remoteWrite } from '../../deploy/lib/prw.mjs'

const args = Object.fromEntries(process.argv.slice(3).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []))
const cmd = process.argv[2]
const base = (args.url ?? '').replace(/\/$/, '')
const dir = args.state
if (!base.startsWith('https://') || !dir) throw new Error('usage: trial.mjs seed|after|limits --url https://… --state DIR')

const read = (f) => readFileSync(join(dir, f), 'utf8').trim()
const save = (f, v) => {
  writeFileSync(join(dir, f), typeof v === 'string' ? v : JSON.stringify(v, null, 2))
  chmodSync(join(dir, f), 0o600)
}
const b64url = (b) => Buffer.from(b).toString('base64url')
const REDIRECT = 'http://127.0.0.1:9/callback'
const UA = { 'User-Agent': 'viz-s13-trial/1' }
// The resource a token is issued for is the deployment's issuer + /mcp, as its metadata says
// (fb77292's stages advertise production's issuer: recorded in README.md).
const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`, { headers: UA })).json()
const RESOURCE = `${meta.issuer}/mcp`
const out = []
const report = (what, ok, detail = '') => {
  out.push({ what, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `: ${detail}` : ''}`)
}

async function register(name) {
  const res = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...UA },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  })
  return { status: res.status, retryAfter: res.headers.get('Retry-After'), body: await res.json().catch(() => null) }
}

async function authorize(clientId) {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: b64url(randomBytes(8)), resource: RESOURCE, scope: 'read dashboards:read monitors:read' })
  const res = await fetch(`${base}/oauth/authorize?${q}`, { headers: UA })
  const text = await res.text()
  const handle = /^request: (\S+)$/m.exec(text)?.[1]
  return { status: res.status, handle, verifier }
}

async function approve(handle) {
  const res = await fetch(`${base}/api/v1/control/oauth/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${read('admin.key')}`, 'Content-Type': 'application/json', ...UA },
    body: JSON.stringify({ request: handle }),
  })
  const body = await res.json().catch(() => null)
  const code = body?.redirect ? new URL(body.redirect).searchParams.get('code') : null
  return { status: res.status, code }
}

async function token(form) {
  const res = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...UA }, body: new URLSearchParams(form) })
  return { status: res.status, retryAfter: res.headers.get('Retry-After'), body: await res.json().catch(() => null) }
}

async function grant(clientId) {
  const a = await authorize(clientId)
  if (a.status !== 200 || !a.handle) return { ok: false, why: `authorize ${a.status}` }
  const p = await approve(a.handle)
  if (p.status < 200 || p.status > 299 || !p.code) return { ok: false, why: `approve ${p.status}` }
  const t = await token({ grant_type: 'authorization_code', code: p.code, code_verifier: a.verifier, redirect_uri: REDIRECT, client_id: clientId, resource: RESOURCE })
  if (t.status !== 200) return { ok: false, why: `token ${t.status} ${t.body?.error ?? ''}` }
  return { ok: true, access: t.body.access_token, refresh: t.body.refresh_token }
}

async function mcpList(access) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', ...UA },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  const text = await res.text()
  return { status: res.status, tools: (text.match(/"name":"[a-z_]+"/g) ?? []).length }
}

const SERIES = { __name__: 's13_trial_value', phase: 'before-upgrade', job: 's13' }

if (cmd === 'seed') {
  const now = Date.now()
  const w = await remoteWrite(base, read('smoke.key'), [{ labels: SERIES, samples: [[now - 60_000, 41], [now, 42]] }])
  report('Remote Write of the known series', w.status === 204 || w.status === 200, `${w.status}`)
  save('seed.json', { writtenAtMs: now })
  let q
  for (let i = 0; i < 20; i++) {
    q = await instantQuery(base, read('smoke.key'), 's13_trial_value{job="s13"}', Math.ceil(now / 1000) + 1)
    if (q.body?.data?.result?.length) break
    await new Promise((r) => setTimeout(r, 3000))
  }
  report('the series read back before the upgrade', q.body?.data?.result?.[0]?.value?.[1] === '42', JSON.stringify(q.body?.data?.result?.[0]?.value ?? q.status))
  const r = await register('s13 trial client')
  report('POST /oauth/register', r.status === 201 && !!r.body?.client_id, `${r.status}`)
  if (r.body?.client_id) {
    save('client.json', { client_id: r.body.client_id })
    const g = await grant(r.body.client_id)
    report('one grant: authorize, approve with the admin key, code exchanged with its PKCE verifier', g.ok, g.why ?? 'access and refresh token issued')
    if (g.ok) {
      save('access.token', g.access)
      save('refresh.token', g.refresh)
      const m = await mcpList(g.access)
      report('the access token answers at /mcp', m.status === 200 && m.tools > 0, `${m.status}, ${m.tools} tools`)
    }
  }
} else if (cmd === 'after') {
  const { writtenAtMs } = JSON.parse(read('seed.json'))
  const q = await instantQuery(base, read('smoke.key'), 's13_trial_value{job="s13"}', Math.ceil(writtenAtMs / 1000) + 1)
  report('the series written before the upgrade read after it', q.body?.data?.result?.[0]?.value?.[1] === '42', JSON.stringify(q.body?.data?.result?.[0]?.value ?? q.status))
  const clientId = JSON.parse(read('client.json')).client_id
  const a = await authorize(clientId)
  report('the client registered before the upgrade passes /oauth/authorize', a.status === 200 && !!a.handle, `${a.status}`)
  const m = await mcpList(read('access.token'))
  report('the access token issued before the upgrade answers at /mcp', m.status === 200 && m.tools > 0, `${m.status}, ${m.tools} tools`)
  const oldRefresh = read('refresh.token')
  const t1 = await token({ grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: clientId, resource: RESOURCE })
  report('the refresh token issued before the upgrade refreshes once', t1.status === 200 && !!t1.body?.access_token, `${t1.status} ${t1.body?.error ?? ''}`)
  if (t1.status === 200) {
    save('access.token', t1.body.access_token)
    save('refresh.token', t1.body.refresh_token)
  }
  const t2 = await token({ grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: clientId, resource: RESOURCE })
  report('the same refresh token a second time is refused', t2.status === 400 && t2.body?.error === 'invalid_grant', `${t2.status} ${t2.body?.error ?? ''}`)
} else if (cmd === 'limits') {
  // The source limit on registration (120 a minute in this release): 150 in under a minute.
  const statuses = {}
  let retryAfter = null
  let bodyError = null
  const t0 = Date.now()
  for (let i = 0; i < 150; i++) {
    const r = await register(`s13 limit ${i}`)
    statuses[r.status] = (statuses[r.status] ?? 0) + 1
    if (r.status === 429) {
      retryAfter ??= r.retryAfter
      bodyError ??= r.body?.error ?? null
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  report('150 registrations from one address: some refused with 429', (statuses[429] ?? 0) > 0, `${JSON.stringify(statuses)} in ${secs} s; Retry-After ${retryAfter}; error ${bodyError}`)
  // The credential limit (5 a minute per presented credential): one fresh code presented 30 times.
  const clientId = JSON.parse(read('client.json')).client_id
  const a = await authorize(clientId)
  const p = a.handle ? await approve(a.handle) : { status: 0 }
  const tStatuses = {}
  let tRetry = null
  let tError = null
  if (p.code) {
    for (let i = 0; i < 30; i++) {
      // A wrong verifier, so the code is never spent: every attempt counts against the code.
      const t = await token({ grant_type: 'authorization_code', code: p.code, code_verifier: b64url(randomBytes(32)), redirect_uri: REDIRECT, client_id: clientId, resource: RESOURCE })
      tStatuses[t.status] = (tStatuses[t.status] ?? 0) + 1
      if (t.status === 429) {
        tRetry ??= t.retryAfter
        tError ??= t.body?.error ?? null
      }
    }
  }
  report('one code presented 30 times at /oauth/token: refused with 429 past the limit', (tStatuses[429] ?? 0) > 0, `${JSON.stringify(tStatuses)}; Retry-After ${tRetry}; error ${tError}`)
} else {
  throw new Error(`unknown command ${cmd}`)
}

const file = join(dir, `result-${cmd}.json`)
writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), cmd, out }, null, 2))
process.exitCode = out.every((o) => o.ok) ? 0 : 1
if (existsSync(file)) console.log(`(written ${file})`)
