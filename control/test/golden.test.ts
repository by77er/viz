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
})
