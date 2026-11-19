import { describe, expect, it } from 'vitest'
import audit from '../src/ops-audit.ts?raw'
import dashboards from '../src/ops-dashboards.ts?raw'
import keys from '../src/ops-keys.ts?raw'
import proposals from '../src/ops-proposals.ts?raw'
import settings from '../src/ops-settings.ts?raw'
import index from '../src/index.ts?raw'
import tenant from '../src/tenant.ts?raw'
import oauthOps from '../src/ops-oauth.ts?raw'
import oauthHttp from '../src/oauth-http.ts?raw'
import oauthLib from '../src/oauth.ts?raw'

/** House rules (AGENTS.md, "Durable Objects") that can be checked by reading the source. */
const sources: Record<string, string> = { audit, dashboards, keys, proposals, settings, tenant, oauthOps, oauthHttp, oauthLib }

/** Every SQL string literal in a source file: quoted with ', " or `, starting with a statement keyword. */
function statements(src: string): string[] {
  const out: string[] = []
  const re = /(['"`])\s*((?:SELECT|UPDATE|DELETE FROM|INSERT (?:OR IGNORE )?INTO)\b[\s\S]*?)\1\s*[,)]/g
  for (const m of src.matchAll(re)) out.push(m[2]!.replace(/\s+/g, ' '))
  return out
}

describe('house rules, read from the source', () => {
  it('every SQL statement on tenant data names the tenant', () => {
    let seen = 0
    for (const [file, src] of Object.entries(sources)) {
      for (const sql of statements(src)) {
        seen++
        if (/^INSERT/.test(sql)) expect(sql, `${file}: ${sql}`).toMatch(/\(\s*tenant\b/)
        // The one statement that cannot: reading which tenant this object belongs to.
        else if (sql.includes("FROM tenant_meta WHERE k = 'bound'")) continue
        // Nor this one: whether the object has any storage at all (an unprovisioned object writes none).
        else if (sql.startsWith("SELECT name FROM sqlite_master WHERE type = 'table'")) continue
        else expect(sql, `${file}: ${sql}`).toMatch(/\btenant = \?|\$\{where\.join|s\.tenant = \?/)
      }
    }
    expect(seen).toBeGreaterThan(100)
  })

  it('the audit table is only ever inserted into, and KV is only written from the outbox', () => {
    for (const [file, src] of Object.entries(sources)) {
      expect(src, file).not.toMatch(/UPDATE audit|DELETE FROM audit/)
      if (file !== 'tenant') expect(src, `${file} touches KV directly`).not.toMatch(/\.kv\.|CONFIG\.(put|delete)/)
    }
    // in the Tenant object, the only KV writes are in drainOnce
    const writes = [...tenant.matchAll(/this\.kv\.(put|delete)\(/g)]
    expect(writes).toHaveLength(2)
    const drain = tenant.slice(tenant.indexOf('private async drainOnce'), tenant.indexOf('override async alarm'))
    expect([...drain.matchAll(/this\.kv\.(put|delete)\(/g)]).toHaveLength(2)
    // blockConcurrencyWhile only once: in the constructor, around opening (migrating) local SQLite,
    // with no await inside (AGENTS.md: never hold it across R2 or network I/O)
    for (const src of [...Object.values(sources), index]) expect(src).not.toMatch(/\beval\(|new Function\(/)
    for (const [file, src] of Object.entries({ ...sources, index })) if (file !== 'tenant') expect(src, file).not.toMatch(/blockConcurrencyWhile/)
    expect([...tenant.matchAll(/blockConcurrencyWhile/g)]).toHaveLength(1)
    const block = tenant.slice(tenant.indexOf('blockConcurrencyWhile'), tenant.indexOf('\n    })\n', tenant.indexOf('blockConcurrencyWhile')))
    expect(tenant.slice(tenant.indexOf('constructor('), tenant.indexOf('refusal(): SchemaTooNew'))).toContain(block)
    expect(block).toContain('openSchema(ctx.storage, TENANT_SCHEMA)')
    expect(block).not.toMatch(/\bawait\b|fetch\(|\.kv\.|BUCKET/)
    expect(index).not.toMatch(/searchParams\.get\('tenant'\)|headers\.get\('X-(Scope|Tenant)/i)
    expect([...index.matchAll(/idFromName\(/g)]).toHaveLength(1)
    expect(index).toContain('idFromName(identity.tenant)')
    // The OAuth endpoints pick a Tenant object in one place, by the tenant the presented credential
    // names (whose object holds only that credential's hash), and read no tenant from anything else.
    expect([...oauthHttp.matchAll(/idFromName\(/g)]).toHaveLength(1)
    expect(oauthHttp).toContain('env.TENANT.idFromName(tenant)')
    expect([...oauthHttp.matchAll(/tenantStub\(env, ([a-z.]+)\)/g)].map((m) => m[1])).toEqual(['cred.tenant', 'cred.tenant'])
    expect(oauthHttp).not.toMatch(/searchParams\.get\('tenant'\)|form\.tenant|headers\.get\('X-/i)
    // nothing OAuth logs a request's parameters: the one log line names the path and the error's class
    for (const src of [oauthOps, oauthHttp, oauthLib]) expect([...src.matchAll(/console\.(log|error|warn|info)\(([^)]*)\)/g)].map((m) => m[2])).toEqual(src === oauthHttp ? ["'control: oauth endpoint failed', path, e instanceof Error ? e.name : 'error'"] : [])
  })
})
