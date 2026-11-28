/**
 * Golden formats (contracts/COMPATIBILITY.md §3, §8): what this component writes that
 * another release reads, byte for byte where the bytes are deterministic, with random parts
 * (secrets, hashes of secrets, times, the test's tenant name) replaced by a placeholder
 * after their shape is checked. Each file is `test/golden/formats/<format>.v<N>.json`,
 * where N is `FORMATS[<format>]` in `src/schema.ts`.
 */
import { describe, expect, it } from 'vitest'
import { revisionOf } from '../../dashboard/src/index.ts'
import { FORMATS } from '../src/schema'
import { OAUTH_SCOPES, credentialExpiresAt } from '../../contracts/oauth'
import { sha256Hex } from '../../dashboard/src/index.ts'
import { decodeRequest, encodeRequest, seal, signRegistration, unseal, verifyClientId } from '../src/oauth'
import { RESOURCE, approve, authorize, codeOf, connect, newClient, pkce, revokeAtServer } from './oauth'
import { goldenFile } from './golden'
import { decodeCursor, encodeCursor } from '../src/util'
import { expectGolden, goldenDir } from './golden'
import { EXAMPLES, call, makeKey, newTenant, post } from './helpers'
import { env } from 'cloudflare:workers'

type Format = keyof typeof FORMATS
const file = (f: Format) => `formats/${f}.v${FORMATS[f]}.json`
const raw = async (key: string): Promise<string> => {
  const v = await env.CONFIG.get(key)
  if (v === null) throw new Error(`no KV record ${key}`)
  return v
}
/** Replace what differs between runs, after checking its shape. */
function scrub(text: string, tenant: string): string {
  return text
    .replaceAll(tenant, '<tenant>')
    .replace(/"secretSha256":"[0-9a-f]{64}"/g, '"secretSha256":"<sha256>"')
    .replace(/"revokedBefore":\d{13}/g, '"revokedBefore":"<ms>"')
}

describe('golden formats: every format this component writes has a golden file for its current version', () => {
  it('no format is missing a file, and no file claims a version the code does not', () => {
    const files = goldenDir('formats')
    for (const f of Object.keys(FORMATS) as Format[]) {
      expect(files[`${f}.v${FORMATS[f]}.json`], `test/golden/${file(f)}`).toMatchObject({ format: f, version: FORMATS[f] })
    }
    for (const [name, g] of Object.entries(files)) {
      const { format, version } = g as { format: Format; version: number }
      expect(name).toBe(`${format}.v${version}.json`)
      expect(version, `${name} is newer than the code's ${format}`).toBeLessThanOrEqual(FORMATS[format])
    }
  })

  it('kv.key and kv.revocation: the records edge reads, as written (enabled, then disabled)', async () => {
    const t = await newTenant('golden')
    const k = await makeKey(t.admin, ['write'], { name: 'collectors' })
    const enabled = scrub(await raw(`key:${k.keyId}`), t.tenant)
    await post(t.admin, `/keys/${k.id}/disable`)
    const disabled = scrub(await raw(`key:${k.keyId}`), t.tenant)
    const revocation = scrub(await raw(`revocation:${t.tenant}`), t.tenant)
    expectGolden(file('kv.key'), { format: 'kv.key', version: FORMATS['kv.key'], enabled, disabled })
    expectGolden(file('kv.revocation'), { format: 'kv.revocation', version: FORMATS['kv.revocation'], afterDisable: revocation })
  })

  it('kv.settings and kv.pool: retention, limits and the pool map', async () => {
    const t = await newTenant('golden')
    expect((await call(t.admin, 'PUT', '/settings/retention', { value: { metric_samples_days: 60, metric_5m_days: 90 } })).status).toBe(200)
    expect((await call(t.admin, 'PUT', '/settings/limits', { value: { active_series: 50_000, query_max_series: 10_000 } })).status).toBe(200)
    expect((await call(t.admin, 'PUT', '/settings/pool', { value: { pool: `tenant/${t.tenant}`, slots: 4, spread: 2 } })).status).toBe(200)
    expectGolden(file('kv.settings'), {
      format: 'kv.settings',
      version: FORMATS['kv.settings'],
      retention: scrub(await raw(`retention:${t.tenant}`), t.tenant),
      limits: scrub(await raw(`limits:${t.tenant}`), t.tenant),
    })
    expectGolden(file('kv.pool'), { format: 'kv.pool', version: FORMATS['kv.pool'], pool: scrub(await raw(`pool:${t.tenant}`), t.tenant) })
  })

  it('kv.oauth-dead: a credential its object called dead, as the Worker lists it (src/deadlist.ts, D70 round 2)', async () => {
    const t = await newTenant('golden')
    const c = await connect(t.admin)
    expect((await revokeAtServer(c.clientId, c.access)).status).toBe(200)
    const { keys } = await env.CONFIG.list({ prefix: `oauth-dead:${t.tenant}:` })
    expect(keys.map((k) => k.name)).toEqual([`oauth-dead:${t.tenant}:${sha256Hex(c.access)}`])
    // It expires with the credential: its encoded expiry plus the Worker's 60 s of grace.
    expect(keys[0]!.expiration).toBe(Math.ceil((credentialExpiresAt(c.access)! + 60_000) / 1000))
    expectGolden(file('kv.oauth-dead'), {
      format: 'kv.oauth-dead',
      version: FORMATS['kv.oauth-dead'],
      key: keys[0]!.name.replace(t.tenant, '<tenant>').replace(/[0-9a-f]{64}$/, '<SHA-256 of the whole credential, hex>'),
      value: await raw(keys[0]!.name),
      expiration: 'KV expiration: the credential\'s encoded expiry plus 60 s, in whole seconds, rounded up',
    })
  })

  it('credential.api-key: the shape of a key handed out, which edge must keep accepting', async () => {
    const t = await newTenant('golden')
    const k = await makeKey(t.admin, ['read'])
    const shape = k.key.replace(/^viz_[A-Za-z0-9]{16}_[A-Za-z0-9]{40}$/, 'viz_<keyId: 16 base62>_<secret: 40 base62>')
    expectGolden(file('credential.api-key'), { format: 'credential.api-key', version: FORMATS['credential.api-key'], shape })
  })

  it('cursor.list: a cursor handed to a client decodes the same in the next release', () => {
    const g = { format: 'cursor.list', version: FORMATS['cursor.list'], position: ['k_abc', 1_700_000_000_000], cursor: encodeCursor(['k_abc', 1_700_000_000_000]) }
    expectGolden(file('cursor.list'), g)
    expect(decodeCursor(g.cursor, ['string', 'number'])).toEqual(g.position)
  })

  it('id.revision: the revision id (ETag) of each example dashboard', () => {
    const ids = Object.fromEntries(Object.entries(EXAMPLES).map(([name, spec]) => [name, revisionOf(spec as never)]))
    expectGolden(file('id.revision'), { format: 'id.revision', version: FORMATS['id.revision'], ids })
  })

  it('credential.oauth: the shapes of codes, access and refresh tokens handed to clients', async () => {
    const t = await newTenant('golden')
    const dana = await makeKey(t.admin, ['admin', ...OAUTH_SCOPES], { name: 'dana' })
    const c = await connect(dana.key)
    const shape = (s: string) => s.replace(`.${t.tenant}.`, '.<tenant>.').replace(/\.[A-Za-z0-9]{43}$/, '.<43 base62>')
    expectGolden(file('credential.oauth'), { format: 'credential.oauth', version: FORMATS['credential.oauth'], code: shape(c.code), access: shape(c.access), refresh: shape(c.refresh) })
  })

  it('id.oauth-client, oauth.request, oauth.sealed: fixed inputs give fixed bytes, and the decoders read the checked-in ones', async () => {
    const key = 'golden-registration-key-0123456789abcdef'
    const registration = { v: 1 as const, n: 'AAAAAAAAAAAAAAAA', iat: 1_800_000_000, name: 'Golden client', uris: ['http://127.0.0.1:33418/callback'] }
    expectGolden(file('id.oauth-client'), { format: 'id.oauth-client', version: FORMATS['id.oauth-client'], key, registration, clientId: await signRegistration(key, registration) })
    const g1 = goldenFile(file('id.oauth-client')) as { clientId: string }
    expect(await verifyClientId(key, g1.clientId)).toEqual(registration)

    const request = { v: 1 as const, client_id: g1.clientId, redirect_uri: registration.uris[0]!, scope: ['read' as const, 'dashboards:read' as const], code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', state: 'xyz', resource: 'https://vis.bitcru.sh/mcp' }
    expectGolden(file('oauth.request'), { format: 'oauth.request', version: FORMATS['oauth.request'], request, handle: encodeRequest(request) })
    expect(decodeRequest((goldenFile(file('oauth.request')) as { handle: string }).handle)).toEqual(request)

    const credential = `vza1.golden.${'a'.repeat(43)}`
    const aad = 'golden/g_AAAAAAAAAAAAAAAAAAAAAA'
    const plaintext = 'the grant key secret, forty base62 chars'
    expectGolden(file('oauth.sealed'), { format: 'oauth.sealed', version: FORMATS['oauth.sealed'], credential, aad, plaintext, iv: '000000000000000000000000', sealed: await seal(credential, plaintext, aad, new Uint8Array(12)) })
    const g2 = goldenFile(file('oauth.sealed')) as { sealed: string }
    expect(await unseal(credential, g2.sealed, aad)).toBe(plaintext)
    expect(await unseal(credential, g2.sealed, 'golden/g_other')).toBeNull()
  })

  it('rpc.oauth: the token, introspection and revocation results, as the endpoints and the agent surface read them', async () => {
    const t = await newTenant('golden')
    const dana = await makeKey(t.admin, ['admin', ...OAUTH_SCOPES], { name: 'dana' })
    const client = await newClient()
    const { verifier, challenge } = await pkce()
    const ap = await approve(dana.key, (await authorize(client, challenge, { scope: 'read dashboards:read' })).handle!)
    const stub = env.TENANT.get(env.TENANT.idFromName(t.tenant))
    const token = await stub.oauthToken(t.tenant, { grant_type: 'authorization_code', client_id: client, code: codeOf(ap.body.redirect).code, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:33418/callback', resource: RESOURCE })
    if (token.status !== 'ok') throw new Error(JSON.stringify(token))
    const access = token.tokens.access_token
    const active = await stub.introspectAccessToken(t.tenant, access, RESOURCE)
    const scrubbed = (v: unknown) =>
      JSON.parse(
        JSON.stringify(v)
          .replaceAll(t.tenant, '<tenant>')
          .replace(/(vz[a-z]1)\.<tenant>\.[A-Za-z0-9]{43}/g, '$1.<tenant>.<43 base62>')
          .replace(/viz_[A-Za-z0-9]{16}_[A-Za-z0-9]{40}/g, 'viz_<keyId 16>_<secret 40>')
          .replace(/g_[A-Za-z0-9]{22}/g, 'g_<22>')
          .replace(/k_[A-Za-z0-9]{22}/g, 'k_<22>')
          .replace(/"expiresAt":\d{13}/g, '"expiresAt":"<ms>"'),
      )
    expectGolden(file('rpc.oauth'), {
      format: 'rpc.oauth',
      version: FORMATS['rpc.oauth'],
      token: scrubbed(token),
      error: await stub.oauthToken(t.tenant, { grant_type: 'refresh_token', client_id: client, refresh_token: `vzr1.${t.tenant}.${'b'.repeat(43)}` }),
      active: scrubbed(active),
      inactive: await stub.introspectAccessToken(t.tenant, `vza1.${t.tenant}.${'c'.repeat(43)}`, RESOURCE),
      revoked: await stub.oauthRevoke(t.tenant, access, client),
      otherTenant: await stub.introspectAccessToken('someone-else', access, RESOURCE),
    })
  })
})
