/**
 * What a made-up OAuth credential costs, per request (review of D44, M-2): wall time in local
 * workerd, how many tenant objects it reaches, and what it writes there. Sequential requests
 * against a tenant that has a live grant (so the object has OAuth deadlines to re-arm). The numbers
 * are printed (`FORGED-COST`) and recorded in control/README.md, "How it was verified", next to the
 * same run on the tree the review read; the counts are asserted.
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import worker from '../src/index'
import { introspectFor } from '../src/introspection'
import type { Tenant } from '../src/tenant'
import { newTenant, stubOf } from './helpers'
import { ORIGIN, REDIRECT, RESOURCE, connect, newClient } from './oauth'

const N = 300

it(`${N} forged /oauth/token, /oauth/revoke and introspections against a tenant with a live grant: time, objects reached, rows and alarms written`, async () => {
  const { tenant, admin } = await newTenant('cost')
  await connect(admin)
  const stub = stubOf(tenant)
  const alarms = { set: 0, del: 0 }
  await runInDurableObject(stub, async (_o, state) => {
    const s = state.storage as unknown as { setAlarm: (...a: unknown[]) => Promise<void>; deleteAlarm: (...a: unknown[]) => Promise<void> }
    const set = s.setAlarm.bind(s)
    const del = s.deleteAlarm.bind(s)
    s.setAlarm = (...a: unknown[]) => (alarms.set++, set(...a))
    s.deleteAlarm = (...a: unknown[]) => (alarms.del++, del(...a))
  })
  const written = () => runInDurableObject(stub, async (o: Tenant) => (o as unknown as { rowsWritten?: number }).rowsWritten ?? -1)
  const gets: string[] = []
  const TENANT = new Proxy(env.TENANT, {
    get(t, p) {
      if (p === 'get') return (id: DurableObjectId) => (gets.push(id.toString()), t.get(id))
      const v = Reflect.get(t, p) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
    },
  })
  const e = { ...env, TENANT }
  const clientId = await newClient()
  const post = async (path: string, params: Record<string, string>) => {
    const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() }) as never, e as never, {} as ExecutionContext)
    await res.arrayBuffer()
    return res.status
  }
  const forged = (prefix: string, i: number) => `${prefix}.${tenant}.${'A'.repeat(39)}${String(i).padStart(4, '0')}`
  const runs: Record<string, () => Promise<unknown>> = {
    token: async () => {
      for (let i = 0; i < N; i++) expect(await post('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code: forged('vzc1', i), code_verifier: 'x'.repeat(43), redirect_uri: REDIRECT })).toBe(400)
    },
    refresh: async () => {
      for (let i = 0; i < N; i++) expect(await post('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: forged('vzr1', i) })).toBe(400)
    },
    revoke: async () => {
      for (let i = 0; i < N; i++) expect(await post('/oauth/revoke', { client_id: clientId, token: forged('vzr1', i) })).toBe(200)
    },
    // What every forged bearer at /mcp costs: the agent surface's introspection. The entrypoint's
    // logic with the counting namespace (objects reached), then through the binding mcp/ holds (time).
    introspect: async () => {
      for (let i = 0; i < N; i++) expect((await introspectFor(e, 'viz-mcp', forged('vza1', i), RESOURCE)).status).toBe('inactive')
    },
    introspectViaBinding: async () => {
      for (let i = 0; i < N; i++) expect((await env.MCP_OAUTH.introspectAccessToken(forged('vza1', i), RESOURCE)).status).toBe('inactive')
    },
  }
  const out: Record<string, unknown> = {}
  for (const [name, run] of Object.entries(runs)) {
    gets.length = 0
    const a0 = alarms.set + alarms.del
    const w0 = await written()
    const t0 = performance.now()
    await run()
    const ms = (performance.now() - t0) / N
    out[name] = { msPerRequest: Number(ms.toFixed(3)), objectsReached: gets.length, alarmWrites: alarms.set + alarms.del - a0, rowsWritten: (await written()) - w0 }
  }
  console.log(`FORGED-COST ${JSON.stringify({ n: N, ...out })}`)
  for (const [name, r] of Object.entries(out) as [string, { objectsReached: number; alarmWrites: number; rowsWritten: number }][]) {
    // Through the binding the entrypoint has its own namespace, not this proxy; its writes are counted all the same.
    if (name !== 'introspectViaBinding') expect(r.objectsReached, name).toBe(0)
    expect(r.alarmWrites, name).toBe(0)
    expect(r.rowsWritten, name).toBe(0)
  }
})
