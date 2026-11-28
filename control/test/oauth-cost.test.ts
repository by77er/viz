/**
 * What each OAuth endpoint costs per request, as an unauthenticated caller or a client can drive it
 * (D70: what the rate limits have to bound, and per what key). Sequential requests in local
 * workerd: wall time, tenant objects reached, rows written there (`Tenant.rowsWritten`), alarm
 * writes (`setAlarm` + `deleteAlarm`, each billed as a row written), KV writes from the object, and
 * the Worker's own KV reads and writes (the list of dead credentials, src/deadlist.ts; D70 after its
 * second review). Printed as `OAUTH-COST` and recorded in control/README.md, "How it was verified";
 * the counts D70 rests on are asserted. Measured here, not on Cloudflare.
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import worker from '../src/index'
import { introspectFor } from '../src/introspection'
import { resetLimiterState } from '../src/ratelimit'
import type { Tenant } from '../src/tenant'
import { newTenant, stubOf, windowRoom } from './helpers'
import { ORIGIN, REDIRECT, RESOURCE, approve, authorize, authorizeUrl, codeOf, newClient, pkce } from './oauth'

// No test here may straddle the minute: the local binding's windows are the wall clock's (helpers.ts).
beforeEach(() => windowRoom(), 20_000)

interface Probe {
  alarms: number
  kv: number
}

/** Count this tenant's object's alarm writes and KV writes from now on. */
async function instrument(tenant: string, probe: Probe): Promise<void> {
  await runInDurableObject(stubOf(tenant), async (o: Tenant, state) => {
    const s = state.storage as unknown as { setAlarm: (...a: unknown[]) => Promise<void>; deleteAlarm: (...a: unknown[]) => Promise<void> }
    const set = s.setAlarm.bind(s)
    const del = s.deleteAlarm.bind(s)
    s.setAlarm = (...a: unknown[]) => (probe.alarms++, set(...a))
    s.deleteAlarm = (...a: unknown[]) => (probe.alarms++, del(...a))
    const kv = o.kv
    o.kv = {
      get: kv.get.bind(kv),
      put: (...a: Parameters<KVNamespace['put']>) => (probe.kv++, kv.put(...a)),
      delete: (...a: Parameters<KVNamespace['delete']>) => (probe.kv++, kv.delete(...a)),
    } as unknown as KVNamespace
  })
}

const rowsOf = (tenant: string) => runInDurableObject(stubOf(tenant), async (o: Tenant) => o.rowsWritten)

it('what each OAuth endpoint costs: time, objects reached, rows, alarms and KV writes per request', async () => {
  const gets: string[] = []
  const TENANT = new Proxy(env.TENANT, {
    get(t, p) {
      if (p === 'get') return (id: DurableObjectId) => (gets.push(id.toString()), t.get(id))
      const v = Reflect.get(t, p) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
    },
  })
  // The Worker's own KV calls (the list of dead credentials), apart from the object's.
  const workerKv = { reads: 0, writes: 0 }
  const CONFIG = {
    get: (...a: Parameters<KVNamespace['get']>) => (workerKv.reads++, (env.CONFIG.get as (...x: unknown[]) => unknown)(...a)),
    put: (...a: Parameters<KVNamespace['put']>) => (workerKv.writes++, env.CONFIG.put(...a)),
  } as unknown as KVNamespace
  const e = { ...env, TENANT, CONFIG }
  resetLimiterState()
  const send = async (path: string, init: RequestInit): Promise<{ status: number; body: any }> => {
    const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, init) as never, e as never, {} as ExecutionContext)
    const text = await res.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      // a page
    }
    return { status: res.status, body }
  }
  const form = (path: string, params: Record<string, string>) =>
    send(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() })

  const probe: Probe = { alarms: 0, kv: 0 }
  const tenants: string[] = []
  const out: Record<string, { n: number; msPerRequest: number; objectsReached: number; rowsWritten: number; alarmWrites: number; kvWrites: number; workerKvReads: number; workerKvWrites: number }> = {}
  async function measure(name: string, n: number, run: (i: number) => Promise<void>): Promise<void> {
    gets.length = 0
    const a0 = probe.alarms
    const k0 = probe.kv
    const r0 = workerKv.reads
    const p0 = workerKv.writes
    const w0 = await Promise.all(tenants.map(rowsOf))
    const t0 = performance.now()
    for (let i = 0; i < n; i++) await run(i)
    const ms = (performance.now() - t0) / n
    const w1 = await Promise.all(tenants.map(rowsOf))
    const rows = w1.reduce((s, w, i) => s + (w - w0[i]!), 0)
    out[name] = { n, msPerRequest: Number(ms.toFixed(3)), objectsReached: gets.length, rowsWritten: rows, alarmWrites: probe.alarms - a0, kvWrites: probe.kv - k0, workerKvReads: workerKv.reads - r0, workerKvWrites: workerKv.writes - p0 }
  }

  // ---- no credential: registration, the authorization page, a made-up credential ----
  const N = 100
  await measure('register', N, async () => {
    const r = await send('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Cost agent', redirect_uris: [REDIRECT] }) })
    expect(r.status).toBe(201)
  })
  const clientId = await newClient()
  const { challenge } = await pkce()
  await measure('authorize page', N, async () => {
    expect((await send(authorizeUrl(clientId, challenge, { scope: 'read dashboards:read monitors:read' }), {})).status).toBe(200)
  })

  // Two tenants with 20 grants each (the most approvals a tenant may make in an hour).
  const G = 20
  const flows: { tenant: string; admin: string; clientId: string; verifier: string; handle: string; code?: string; access?: string; refresh?: string; spent?: string }[][] = []
  for (const label of ['costa', 'costb']) {
    const { tenant, admin } = await newTenant(label)
    tenants.push(tenant)
    await instrument(tenant, probe)
    const client = await newClient()
    const list = []
    for (let i = 0; i < G; i++) {
      const p = await pkce()
      const { handle } = await authorize(client, p.challenge)
      list.push({ tenant, admin, clientId: client, verifier: p.verifier, handle: handle! })
    }
    flows.push(list)
  }
  const [a, b] = flows as [typeof flows[0], typeof flows[0]]
  const forged = (prefix: string, tenant: string, i: number) => `${prefix}.${tenant}.${'A'.repeat(39)}${String(i).padStart(4, '0')}`
  await measure('token: forged code (no tag)', N, async (i) => {
    expect((await form('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code: forged('vzc1', a[0]!.tenant, i), code_verifier: 'x'.repeat(43), redirect_uri: REDIRECT })).status).toBe(400)
  })

  // ---- the consent step (control API, a person's admin key): what approval spam would cost ----
  await measure('approve (control API, admin key)', 2 * G, async (i) => {
    const f = (i < G ? a : b)[i % G]!
    const r = await approve(f.admin, f.handle)
    expect(r.status).toBe(201)
    f.code = codeOf(r.body.redirect).code
  })

  // ---- genuine credentials ----
  await measure('token: code exchange', 2 * G, async (i) => {
    const f = (i < G ? a : b)[i % G]!
    const r = await form('/oauth/token', { grant_type: 'authorization_code', client_id: f.clientId, code: f.code!, code_verifier: f.verifier, redirect_uri: REDIRECT, resource: RESOURCE })
    expect(r.status).toBe(200)
    f.access = r.body.access_token
    f.refresh = r.body.refresh_token
  })
  await measure('introspection: live token (entrypoint logic)', G, async (i) => {
    expect((await introspectFor(e, 'viz-mcp', a[i]!.access, RESOURCE)).status).toBe('active')
  })
  await measure('introspection: live token (through the OAUTH binding)', G, async (i) => {
    expect((await env.MCP_OAUTH.introspectAccessToken(a[i]!.access!, RESOURCE)).status).toBe('active')
  })
  await measure('token: refresh', G, async (i) => {
    const f = a[i]!
    const r = await form('/oauth/token', { grant_type: 'refresh_token', client_id: f.clientId, refresh_token: f.refresh! })
    expect(r.status).toBe(200)
    f.spent = f.refresh
    f.access = r.body.access_token
    f.refresh = r.body.refresh_token
  })
  await measure('revoke: live access token', G, async (i) => {
    const f = a[i]!
    expect((await form('/oauth/revoke', { client_id: f.clientId, token: f.access! })).status).toBe(200)
  })
  await measure('token: rotated refresh token presented again (ends the grant; listed)', G, async (i) => {
    const f = a[i]!
    expect((await form('/oauth/token', { grant_type: 'refresh_token', client_id: f.clientId, refresh_token: f.spent! })).status).toBe(400)
  })
  // The grant's newest refresh token, which nobody has presented since the grant ended: its first
  // replay reaches the object, which calls it dead, and the Worker lists it (R2-M2).
  await measure('token: first replay of a genuine refresh token whose grant ended (listed)', G, async (i) => {
    const f = a[i]!
    expect((await form('/oauth/token', { grant_type: 'refresh_token', client_id: f.clientId, refresh_token: f.refresh! })).status).toBe(400)
  })
  await measure('token: replay of a listed refresh token (this isolate)', G, async (i) => {
    const f = a[i]!
    expect((await form('/oauth/token', { grant_type: 'refresh_token', client_id: f.clientId, refresh_token: f.spent! })).status).toBe(400)
  })
  await measure('token: replay of a listed refresh token (a new isolate: read from KV)', G, async (i) => {
    const f = a[i]!
    resetLimiterState()
    expect((await form('/oauth/token', { grant_type: 'refresh_token', client_id: f.clientId, refresh_token: f.refresh! })).status).toBe(400)
  })
  await measure('revoke: live refresh token (ends the grant; listed)', G, async (i) => {
    const f = b[i]!
    expect((await form('/oauth/revoke', { client_id: f.clientId, token: f.refresh! })).status).toBe(200)
  })
  await measure('revoke: replay of a listed token (this isolate)', G, async (i) => {
    const f = b[i]!
    expect((await form('/oauth/revoke', { client_id: f.clientId, token: f.refresh! })).status).toBe(200)
  })
  // The access tokens of the grants just ended, which nobody has presented since.
  await measure('introspection: first replay of a genuine token whose grant ended (listed)', G, async (i) => {
    expect((await introspectFor(e, 'viz-mcp', b[i]!.access, RESOURCE)).status).toBe('inactive')
  })
  await measure('introspection: replay of a listed token (this isolate)', G, async (i) => {
    expect((await introspectFor(e, 'viz-mcp', b[i]!.access, RESOURCE)).status).toBe('inactive')
  })

  // ---- the limiters themselves (D70), as miniflare implements them: a Durable Object with SQLite on
  // disk per call, so this is an upper bound for local workerd, not what Cloudflare's locally cached
  // count costs. Limits large enough not to refuse, except where a refusal is what is measured.
  const lim = { ...e, OAUTH_RL_SOURCE: env.RL_TEST_SOURCE, OAUTH_RL_SOURCE_48: env.RL_TEST_TENANT, OAUTH_RL_CREDENTIAL: env.RL_TEST_TENANT, OAUTH_RL_TENANT: env.RL_TEST_TENANT, OAUTH_RL_BEARER: env.RL_TEST_TENANT, OAUTH_RL_BEARER_TENANT: env.RL_TEST_TENANT }
  const sendFrom = async (path: string, init: RequestInit, from: string) => {
    const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), 'CF-Connecting-IP': from } }) as never, lim as never, {} as ExecutionContext)
    await res.arrayBuffer()
    return res.status
  }
  const regInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Cost agent', redirect_uris: [REDIRECT] }) }
  let net = 0
  await measure('register, source limit asked and allowing', N, async () => {
    expect(await sendFrom('/oauth/register', regInit, `10.250.${net >> 8}.${net++ & 255}`)).toBe(201)
  })
  for (let i = 0; i < 5; i++) await sendFrom('/oauth/register', regInit, '10.251.0.1') // the test binding allows 5 a minute
  await measure('register, refused by the source limit', N, async () => {
    expect(await sendFrom('/oauth/register', regInit, '10.251.0.1')).toBe(429)
  })
  console.log(`OAUTH-COST ${JSON.stringify(out)}`)
  const r = (name: string) => out[name]!
  // No credential, or a made-up one: no tenant's object, nothing written. Only the Worker's CPU.
  for (const name of ['register', 'authorize page', 'token: forged code (no tag)', 'register, source limit asked and allowing', 'register, refused by the source limit']) {
    expect(r(name).objectsReached, name).toBe(0)
    expect(r(name).rowsWritten + r(name).alarmWrites + r(name).kvWrites, name).toBe(0)
  }
  // A genuine credential not listed dead reaches its tenant's object once per request.
  const firstAnswers = ['token: rotated refresh token presented again (ends the grant; listed)', 'token: first replay of a genuine refresh token whose grant ended (listed)', 'revoke: live refresh token (ends the grant; listed)', 'introspection: first replay of a genuine token whose grant ended (listed)']
  for (const name of ['token: code exchange', 'token: refresh', 'revoke: live access token', 'introspection: live token (entrypoint logic)', ...firstAnswers]) {
    expect(r(name).objectsReached, name).toBe(r(name).n)
  }
  // The object's answer that it is dead lists it: one KV write each, by the Worker (R2-M2).
  for (const name of firstAnswers) expect(r(name).workerKvWrites, name).toBe(r(name).n)
  // A listed one reaches no object, and writes nothing anywhere; in a new isolate it costs one KV read.
  const listed = ['token: replay of a listed refresh token (this isolate)', 'token: replay of a listed refresh token (a new isolate: read from KV)', 'introspection: replay of a listed token (this isolate)', 'revoke: replay of a listed token (this isolate)']
  for (const name of listed) {
    expect(r(name).objectsReached, name).toBe(0)
    expect(r(name).rowsWritten + r(name).alarmWrites + r(name).kvWrites + r(name).workerKvWrites, name).toBe(0)
  }
  for (const name of ['token: replay of a listed refresh token (this isolate)', 'introspection: replay of a listed token (this isolate)', 'revoke: replay of a listed token (this isolate)']) expect(r(name).workerKvReads, name).toBe(0)
  expect(r('token: replay of a listed refresh token (a new isolate: read from KV)').workerKvReads).toBe(G)
  // A live token is read from the list once per isolate a minute at most.
  expect(r('introspection: live token (entrypoint logic)').workerKvReads).toBeLessThanOrEqual(G)
  expect(r('introspection: live token (entrypoint logic)').workerKvWrites).toBe(0)
  // What a client can make the object write: an exchange and a refresh write rows and re-arm the alarm.
  expect(r('token: code exchange').rowsWritten).toBeGreaterThanOrEqual(3 * 2 * G)
  expect(r('token: refresh').rowsWritten).toBeGreaterThanOrEqual(3 * G)
  expect(r('token: refresh').alarmWrites).toBeGreaterThan(0)
  // The first answer about a dead credential reaches the object and writes nothing there.
  for (const name of ['token: first replay of a genuine refresh token whose grant ended (listed)', 'introspection: first replay of a genuine token whose grant ended (listed)', 'introspection: live token (entrypoint logic)']) {
    expect(r(name).rowsWritten + r(name).alarmWrites + r(name).kvWrites, name).toBe(0)
  }
})
