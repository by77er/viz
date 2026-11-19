import { describe, expect, it } from 'vitest'
import { authenticate } from '../../edge/src/auth'
import mcpAuth from '../../mcp/src/auth.ts?raw'
import rulerHttp from '../../ruler/src/http.ts?raw'
import { ROUTES, SCOPES } from '../src/routes'
import { call, clearAuthCache, createDashboard, env, get, kvGet, makeKey, newTenant, post } from './helpers'

/**
 * Scopes this control plane issues for other services, and `whoami`.
 *
 * The ruler checks `monitors:read`, `monitors:write` and `monitors:ack` literally, with edge's
 * verifier against the KV record this component writes; mcp asks for `monitors:read`. A key
 * can only carry a scope this component knows, so every scope those services check must be
 * one of `SCOPES`. Read from their source, so a scope added there and not here fails here.
 */

const quoted = (s: string): string[] => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
const rulerScopes = (): string[] => {
  const declared = quoted(/export type Scope = ([^\n]+)/.exec(rulerHttp)![1]!)
  const used = [...rulerHttp.matchAll(/route\('[A-Z]+', '[^']+', '([^']+)'/g)].map((m) => m[1]!)
  return [...new Set([...declared, ...used])]
}
const mcpScopes = (): string[] => quoted(/export const SCOPES = \[([^\]]+)\]/.exec(mcpAuth)![1]!)

describe('scopes for other services', () => {
  it('every scope the ruler and mcp check is one a key can be created with', () => {
    const ruler = rulerScopes()
    expect(ruler.sort()).toEqual(['monitors:ack', 'monitors:read', 'monitors:write'])
    for (const s of [...ruler, ...mcpScopes()]) expect(SCOPES as readonly string[], s).toContain(s)
  })

  it('a key with each monitors scope is issued, published to KV with it, and accepted by edge\'s verifier for exactly that scope (as the ruler calls it)', async () => {
    const t = await newTenant('monitors')
    for (const scope of ['monitors:read', 'monitors:write', 'monitors:ack']) {
      const k = await makeKey(t.admin, [scope], { kind: 'agent', name: `ruler ${scope}` })
      expect((await kvGet(`key:${k.keyId}`)).scopes).toEqual([scope])
      const req = () => new Request('https://vis.bitcru.sh/api/v1/monitors', { headers: { Authorization: `Bearer ${k.key}` } })
      clearAuthCache()
      // ruler/src/http.ts: `authenticate(req, env.CONFIG, def.scope as never)`
      expect((await authenticate(req(), env.CONFIG, scope as never)).tenant).toBe(t.tenant)
      for (const other of ['monitors:read', 'monitors:write', 'monitors:ack', 'read'].filter((s) => s !== scope)) {
        await expect(authenticate(req(), env.CONFIG, other as never)).rejects.toMatchObject({ status: 403 })
      }
    }
    const all = await post(t.admin, '/keys', { name: 'on-call', scopes: ['monitors:read', 'monitors:ack', 'dashboards:read'] })
    expect(all.status, all.text).toBe(201)
    expect(all.body.key.scopes).toEqual(['monitors:read', 'monitors:ack', 'dashboards:read'])
    for (const bad of [['monitors:admin'], ['monitors'], ['monitors:read', 'root']]) {
      const res = await post(t.admin, '/keys', { name: `bad ${bad.join()}`, scopes: bad })
      expect(res.status).toBe(422)
      expect(res.body.fix).toContain('monitors:ack')
    }
  })

  it('a monitors scope opens nothing here but whoami: every other route is 403 missing-scope', async () => {
    const t = await newTenant('monitors-only')
    await createDashboard(t.admin, 'red')
    const k = await makeKey(t.admin, ['monitors:read', 'monitors:write', 'monitors:ack'], { kind: 'agent', name: 'ruler only' })
    const who = await get(k.key, '/whoami')
    expect(who.status, who.text).toBe(200)
    expect(who.body).toMatchObject({ tenant: t.tenant, kind: 'agent', name: 'ruler only', scopes: ['monitors:read', 'monitors:write', 'monitors:ack'], mayApply: false })
    let refused = 0
    for (const route of ROUTES.filter((r) => r.op !== 'whoami')) {
      const path = route.path.replace(/\{([a-z]+)\}/g, (_m, n: string) => (n === 'dashboard' ? 'red' : n === 'number' ? '1' : n === 'section' ? 'limits' : 'x'))
      const res = await call(k.key, route.method, path, route.method === 'GET' ? undefined : {})
      expect(res.status, `${route.method} ${path}`).toBe(403)
      expect(res.body.code).toBe('missing-scope')
      refused++
    }
    expect(refused).toBe(ROUTES.length - 1)
  })
})

describe('whoami: mayApply', () => {
  it('says whether direct dashboard writes take effect, and agrees with what a write actually does', async () => {
    const t = await newTenant('may-apply')
    await createDashboard(t.admin, 'red')
    const keys = {
      admin: t.admin,
      dana: (await makeKey(t.admin, ['dashboards:read', 'dashboards:apply'], { name: 'Dana' })).key,
      sam: (await makeKey(t.admin, ['dashboards:read', 'dashboards:write'], { name: 'Sam' })).key,
      agent: (await makeKey(t.admin, ['dashboards:read', 'dashboards:write'], { kind: 'agent', name: 'agent' })).key,
      agentApply: (await makeKey(t.admin, ['dashboards:read', 'dashboards:write', 'dashboards:apply'], { kind: 'agent', name: 'agent with apply' })).key,
      reader: (await makeKey(t.admin, ['read'], { name: 'reader' })).key,
    }
    const expected = (agentsMayApply: boolean): Record<string, boolean> => ({ admin: true, dana: true, sam: false, agent: false, agentApply: agentsMayApply, reader: false })
    for (const agentsMayApply of [false, true]) {
      expect((await call(t.admin, 'PUT', '/settings/general', { value: { agentsMayApply } })).status).toBe(200)
      const base = (await get(t.admin, '/dashboards/red')).body.revision
      for (const [name, key] of Object.entries(keys)) {
        const who = await get(key, '/whoami')
        expect(who.body.mayApply, `${name}, agentsMayApply ${agentsMayApply}`).toBe(expected(agentsMayApply)[name])
        if (name === 'reader') continue
        // A direct patch is applied (200) exactly when mayApply; otherwise it would become a proposal (202).
        const patch = await call(key, 'PATCH', '/dashboards/red', { ops: [{ op: 'replace', path: '/metadata/title', value: `t ${name}` }], baseRevision: base, dryRun: true })
        expect(patch.status, `${name}: ${patch.text}`).toBe(who.body.mayApply ? 200 : 202)
      }
    }
  })
})
