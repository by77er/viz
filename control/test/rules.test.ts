import { describe, expect, it } from 'vitest'
import audit from '../src/ops-audit.ts?raw'
import dashboards from '../src/ops-dashboards.ts?raw'
import keys from '../src/ops-keys.ts?raw'
import proposals from '../src/ops-proposals.ts?raw'
import settings from '../src/ops-settings.ts?raw'
import index from '../src/index.ts?raw'
import tenant from '../src/tenant.ts?raw'

/** House rules (AGENTS.md, "Durable Objects") that can be checked by reading the source. */
const sources: Record<string, string> = { audit, dashboards, keys, proposals, settings, tenant }

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
        else expect(sql, `${file}: ${sql}`).toMatch(/\btenant = \?|\$\{where\.join|s\.tenant = \?/)
      }
    }
    expect(seen).toBeGreaterThan(70)
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
    // no blockConcurrencyWhile, no eval, and the Worker never reads a tenant from the request
    for (const src of [...Object.values(sources), index]) expect(src).not.toMatch(/blockConcurrencyWhile|\beval\(|new Function\(/)
    expect(index).not.toMatch(/searchParams\.get\('tenant'\)|headers\.get\('X-(Scope|Tenant)/i)
    expect([...index.matchAll(/idFromName\(/g)]).toHaveLength(1)
    expect(index).toContain('idFromName(identity.tenant)')
  })
})
