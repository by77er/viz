/**
 * D75: the public address moved from vis.bitcru.sh to viz.bitcru.sh, so the resource is now
 * https://viz.bitcru.sh/mcp. What a client registered and approved under the old address meets:
 *   - its client id (a signed registration, which names no issuer) is still accepted at /oauth/authorize;
 *   - asking for the old resource there is invalid_target;
 *   - its access tokens are inactive (audience) at the new resource;
 *   - its refresh token is invalid_grant (nothing spent, nothing issued), and so is a code approved
 *     before the move, so the client authorizes again instead of refreshing into refused tokens.
 * A grant made under the old address is simulated by rewriting its resource in storage.
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { OAUTH_SCOPES } from '../../contracts/oauth'
import { makeKey, newTenant, stubOf } from './helpers'
import { RESOURCE, approve, authorize, codeOf, connect, exchange, introspect, newClient, pkce, refresh } from './oauth'

const OLD = 'https://vis.bitcru.sh/mcp'
const moveGrant = (tenant: string, grant: string) =>
  runInDurableObject(stubOf(tenant), (_i, s) => void s.storage.sql.exec('UPDATE oauth_grants SET resource = ? WHERE tenant = ? AND id = ?', OLD, tenant, grant))
const tokens = (tenant: string) => runInDurableObject(stubOf(tenant), (_i, s) => s.storage.sql.exec('SELECT kind, rotated_at FROM oauth_tokens WHERE tenant = ? ORDER BY kind', tenant).toArray())

describe('D75: clients of the old address', () => {
  it('the resource is the new address', () => {
    expect(env.PUBLIC_URL).toBe('https://viz.bitcru.sh')
    expect(RESOURCE).toBe('https://viz.bitcru.sh/mcp')
  })

  it('an old access token is inactive (audience) at the new resource; its refresh token is invalid_grant and spends nothing', async () => {
    const t = await newTenant('moved')
    const dana = await makeKey(t.admin, ['admin', ...OAUTH_SCOPES], { name: 'dana' })
    const c = await connect(dana.key)
    expect(await introspect(t.tenant, c.access)).toMatchObject({ status: 'active' })
    await moveGrant(t.tenant, c.grant.id)
    expect(await introspect(t.tenant, c.access)).toEqual({ v: 1, status: 'inactive', reason: 'audience' })
    const before = await tokens(t.tenant)
    const r = await refresh(c.clientId, c.refresh)
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ error: 'invalid_grant' })
    expect(r.body.error_description).toContain(RESOURCE)
    expect(await tokens(t.tenant)).toEqual(before)
    // Asking for the old resource explicitly is no way round it.
    expect((await refresh(c.clientId, c.refresh, { resource: OLD })).body).toMatchObject({ error: 'invalid_grant' })
  })

  it('a code approved before the move is invalid_grant at the token endpoint', async () => {
    const t = await newTenant('moved-code')
    const dana = await makeKey(t.admin, ['admin', ...OAUTH_SCOPES], { name: 'dana' })
    const client = await newClient()
    const { verifier, challenge } = await pkce()
    const { handle } = await authorize(client, challenge)
    const ap = await approve(dana.key, handle!)
    expect(ap.status).toBe(201)
    await moveGrant(t.tenant, ap.body.grant.id)
    const tok = await exchange(client, codeOf(ap.body.redirect).code, verifier)
    expect(tok.status).toBe(400)
    expect(tok.body).toMatchObject({ error: 'invalid_grant' })
  })

  it('an old client id is still accepted at /oauth/authorize (registrations name no issuer); the old resource is invalid_target', async () => {
    const client = await newClient() // signed with the same OAUTH_CLIENT_KEY, as one registered at vis was
    const { challenge } = await pkce()
    expect((await authorize(client, challenge)).res.status).toBe(200)
    expect((await authorize(client, challenge, { resource: RESOURCE })).res.status).toBe(200)
    const old = await authorize(client, challenge, { resource: OLD })
    expect(old.res.status).toBe(400)
    expect(old.res.text).toContain('invalid_target')
  })
})
