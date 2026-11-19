/**
 * Versioned storage (contracts/COMPATIBILITY.md §2), on the real `Tenant` class:
 *
 *   - the schema of every released version is pinned (golden files);
 *   - storage written by the pre-versioning code (a checked-in dump with data) is adopted
 *     as version 1 without a row changing, then migrated to the latest by additive steps
 *     only, and the result survives eviction;
 *   - storage at every earlier version, with data, migrates to the latest once and serves;
 *   - the previous release stays a valid rollback target (every migration since is additive);
 *   - storage a newer release migrated past what this code may read is refused on every
 *     entry point, and nothing is written;
 *   - storage a newer release declared readable by this code is served and left at its version;
 *   - a failing migration leaves storage as it was.
 *
 * "A newer release" is simulated by running the shared runner with this component's
 * migrations plus one more, on the object's storage, then evicting the object so the real
 * class (which knows only its own migrations) constructs itself on that storage.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { canOpen, describeSchema, type Migration, openSchema, SchemaError, schemaRelease, type SchemaSpec } from '../../contracts/schema'
import type { Identity } from '../src/identity'
import type { OpInput, OpName, OpResult } from '../src/routes'
import { TENANT_SCHEMA } from '../src/schema'
import type { Tenant } from '../src/tenant'
import v0 from './fixtures/storage-v0.json'
import { expectGolden, goldenDir } from './golden'
import { call, createDashboard, example, get, newTenant, post, stubOf } from './helpers'
import { type Dump, dumpOf, install, replaceWith, schemaRow, withoutVersion } from './storage'

const V0 = v0 as unknown as Dump & { tenant: string; admin: { id: string }; agent: { id: string; keyId: string } }
/** A valid spec from the old storage (dashboard "red"), to propose a new dashboard with. */
const V0_SPEC = JSON.parse(V0.rows.revisions!.find((r) => r.dashboard === 'red' && r.number === 1)!.spec as string)
const LATEST = TENANT_SCHEMA.migrations.length
const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim()
/** Tables a later migration created, empty: what upgraded old storage holds of them (migration 3: OAuth). */
const ADDED_TABLES = ['oauth_clients', 'oauth_codes', 'oauth_grants', 'oauth_tokens']
const addedEmpty = (have: Record<string, unknown>): Record<string, never[]> => Object.fromEntries(ADDED_TABLES.filter((t) => !(t in have)).map((t) => [t, []]))
const withMigration = (m: Omit<Migration, 'version'>): SchemaSpec => ({ ...TENANT_SCHEMA, migrations: [...TENANT_SCHEMA.migrations, { ...m, version: LATEST + 1 }] })
let n = 0
const fresh = (label: string) => `${label}-${Date.now().toString(36)}-${n++}`

describe('versioned storage: the schema of every released version is pinned', () => {
  it('a fresh object records control.Tenant at the latest version, and its schema is the golden file for that version', async () => {
    const t = await newTenant('fresh')
    const { row, schema } = await runInDurableObject(stubOf(t.tenant), (_i, s) => ({ row: schemaRow(s), schema: describeSchema(s.storage.sql) }))
    expect(row).toMatchObject({ component: 'control.Tenant', version: LATEST, compat: schemaRelease(TENANT_SCHEMA).compat })
    expectGolden(`schema/v${LATEST}.json`, { version: LATEST, schema })
  })

  it('applying migrations 1..N to empty storage gives exactly the golden schema of N, for every N with a golden file', async () => {
    const files = goldenDir('schema')
    expect(Object.keys(files).sort()).toEqual(Array.from({ length: LATEST }, (_, i) => `v${i + 1}.json`).sort())
    for (let v = 1; v <= LATEST; v++) {
      const schema = await runInDurableObject(stubOf(fresh('scratch')), (_i, s) => {
        replaceWith(s, { schema: [], rows: {} })
        openSchema(s.storage, { ...TENANT_SCHEMA, migrations: TENANT_SCHEMA.migrations.slice(0, v) })
        return describeSchema(s.storage.sql)
      })
      expect({ version: v, schema }, `version ${v}`).toEqual(files[`v${v}.json`])
    }
  })

  it('version 1 is exactly the schema the pre-versioning code created (so adopting it changes nothing)', () => {
    const v1 = (goldenDir('schema')['v1.json'] as { schema: { type: string; name: string; sql: string }[] }).schema.filter((s) => s.name !== 'viz_schema')
    const before = V0.schema.map((s) => ({ type: s.type, name: s.name, sql: norm(s.sql) }))
    expect(v1).toEqual(before)
  })
})

describe('versioned storage: opening storage made by other code', () => {
  it('adopts storage written by the pre-versioning code (checked-in dump) as version 1, migrates it with no row changed but for the new NULL column, serves it, and keeps it across eviction', async () => {
    const tenant = fresh('adopt')
    const stub = stubOf(tenant)
    const rewrite = (_t: string, r: Record<string, unknown>) => ('tenant' in r ? { ...r, tenant } : r)
    await runInDurableObject(stub, () => undefined) // exists, empty
    await install(stub, V0, rewrite)
    const expected = { schema: V0.schema, rows: Object.fromEntries(Object.entries(V0.rows).map(([t, rows]) => [t, rows.map((r) => rewrite(t, r))])) }

    // The first call constructs the object on the old storage.
    const live = await stub.resolveKey(tenant, V0.agent.keyId)
    expect(live).toMatchObject({ kind: 'agent', name: 'bot', scopes: ['dashboards:read', 'dashboards:write'] })
    const after = await runInDurableObject(stub, (_i, s) => ({ row: schemaRow(s), dump: dumpOf(s) }))
    // Adopted as version 1 (no DDL ran: its statements are IF NOT EXISTS), then migrated on to the latest.
    expect(after.row).toMatchObject({ component: 'control.Tenant', version: LATEST, compat: 1 })
    const kept = withoutVersion(after.dump)
    // Every row is as it was; migration 2 gave each proposal a NULL spec and changed nothing else;
    // migration 3 added the OAuth tables, empty.
    expect(canon(kept.rows)).toEqual(canon({ ...expected.rows, proposals: expected.rows.proposals!.map((r) => ({ ...r, spec: null })), ...addedEmpty(expected.rows) }))
    // The schema is the old one except for the columns added since, which are those of the latest golden file,
    // plus the tables and indexes added since, exactly as the latest golden file has them.
    const latest = Object.fromEntries((goldenDir('schema')[`v${LATEST}.json`] as { schema: { name: string; sql: string }[] }).schema.map((s) => [s.name, s.sql]))
    const old = new Set(V0.schema.map((s) => s.name))
    expect(kept.schema.filter((s) => old.has(s.name)).map((s) => [s.name, norm(s.sql)])).toEqual(V0.schema.map((s) => [s.name, s.name === 'proposals' ? latest.proposals : norm(s.sql)]))
    const added = kept.schema.filter((s) => !old.has(s.name))
    expect(added.map((s) => s.name).sort()).toEqual(Object.keys(latest).filter((n) => !old.has(n) && n !== 'viz_schema').sort())
    for (const s of added) expect(norm(s.sql), s.name).toBe(latest[s.name])
    expect(latest.proposals).toBe(norm(V0.schema.find((s) => s.name === 'proposals')!.sql).replace(', PRIMARY KEY (tenant, id))', ', spec TEXT, PRIMARY KEY (tenant, id))'))

    // It serves the old data through the real operations.
    const adminKeyId = V0.rows.key_secrets!.find((r) => r.key === V0.admin.id)!.key_id as string
    const admin: Identity = { tenant, subject: `key:${V0.admin.id}`, kind: 'key', scopes: ['admin'], keyId: adminKeyId }
    const input = (query: Record<string, string[]> = {}, body: unknown = null, params: Record<string, string> = {}): OpInput => ({ params, query, body })
    const invoke = async (op: OpName, i: OpInput) => (await stub.invoke(admin, op, i)) as unknown as OpResult
    const list = await invoke('dashboards.list', input())
    expect(list.status).toBe(200)
    expect((list.body as { items: { id: string }[] }).items.map((d) => d.id).sort()).toEqual(['nodes', 'red'])
    const retention = await invoke('settings.get', input({}, null, { section: 'retention' }))
    expect(retention.body).toMatchObject({ value: { metric_samples_days: 60 }, version: 1 })
    const audit = await invoke('audit.list', input({ limit: ['200'] }))
    expect((audit.body as { items: unknown[] }).items).toHaveLength(V0.rows.audit!.length)
    // ... and takes writes.
    const put = await invoke('settings.put', input({}, { value: { metric_samples_days: 90 }, confirmShorter: false }, { section: 'retention' }))
    expect(put.status).toBe(200)

    // Eviction: nothing is migrated twice, the version row is untouched.
    await evictDurableObject(stub)
    const again = await runInDurableObject(stub, (_i, s) => ({ row: schemaRow(s), reopen: openSchema(s.storage, TENANT_SCHEMA) }))
    expect(again.row).toEqual(after.row)
    expect(again.reopen).toMatchObject({ status: 'ok', version: LATEST, migrated: [], adopted: false })
  })

  it('upgrades storage at every earlier version, with data, to the latest: once, keeping every row, and serving old and new kinds of proposal', async () => {
    for (let v = 1; v < LATEST; v++) {
      const tenant = fresh(`upgrade-v${v}`)
      const stub = stubOf(tenant)
      const rewrite = (_t: string, r: Record<string, unknown>) => ('tenant' in r ? { ...r, tenant } : r)
      await runInDurableObject(stub, () => undefined)
      // Storage as release v left it: the pre-versioning dump opened by migrations 1..v.
      const atV = await runInDurableObject(stub, (_i, s) => {
        replaceWith(s, V0, rewrite)
        expect(openSchema(s.storage, { ...TENANT_SCHEMA, migrations: TENANT_SCHEMA.migrations.slice(0, v) })).toMatchObject({ status: 'ok', version: v })
        return dumpOf(s)
      })
      await evictDurableObject(stub)

      // The real class constructs itself on it and migrates.
      expect(await stub.resolveKey(tenant, V0.agent.keyId)).toMatchObject({ kind: 'agent', name: 'bot' })
      const after = await runInDurableObject(stub, (_i, s) => ({ row: schemaRow(s), dump: withoutVersion(dumpOf(s)), schema: describeSchema(s.storage.sql) }))
      expect(after.row, `from v${v}`).toMatchObject({ component: 'control.Tenant', version: LATEST, compat: schemaRelease(TENANT_SCHEMA).compat })
      expect({ version: LATEST, schema: after.schema }).toEqual(goldenDir('schema')[`v${LATEST}.json`])
      const before = withoutVersion(atV).rows
      const added = (r: Record<string, unknown>) => ('spec' in r ? r : { ...r, spec: null })
      expect(canon(after.dump.rows), `from v${v}: rows`).toEqual(canon({ ...before, proposals: before.proposals!.map(added), ...addedEmpty(before) }))

      // It serves: the old proposal reads as a change to an existing dashboard; a new dashboard can be proposed and applied.
      const adminKeyId = V0.rows.key_secrets!.find((r) => r.key === V0.admin.id)!.key_id as string
      const admin: Identity = { tenant, subject: `key:${V0.admin.id}`, kind: 'key', scopes: ['admin'], keyId: adminKeyId }
      const invoke = async (op: OpName, i: Partial<OpInput>) => (await stub.invoke(admin, op, { params: {}, query: {}, body: null, ...i })) as unknown as OpResult & { body: any }
      const old = await invoke('proposals.get', { params: { proposal: V0.rows.proposals![0]!.id as string } })
      expect(old.status).toBe(200)
      expect(old.body.proposal).toMatchObject({ kind: 'patch', dashboard: 'red' })
      const proposed = await invoke('proposals.createDashboard', { body: { spec: { ...structuredClone(V0_SPEC), metadata: { ...V0_SPEC.metadata, id: 'upgraded' } }, message: 'after the upgrade' } })
      expect(proposed.status, JSON.stringify(proposed.body)).toBe(202)
      const applied = await invoke('proposals.apply', { params: { proposal: proposed.body.proposal.id } })
      expect(applied.status, JSON.stringify(applied.body)).toBe(200)
      expect(applied.body).toMatchObject({ number: 1, dashboard: { id: 'upgraded' } })

      // Not migrated twice.
      await evictDurableObject(stub)
      const again = await runInDurableObject(stub, (_i, s) => ({ row: schemaRow(s), reopen: openSchema(s.storage, TENANT_SCHEMA) }))
      expect(again.row).toEqual(after.row)
      expect(again.reopen).toMatchObject({ status: 'ok', version: LATEST, migrated: [] })
    }
  })

  it('refuses storage a newer release migrated past what it knows: 503 on every surface, the alarm kept, nothing written', async () => {
    const t = await newTenant('newer')
    const stub = stubOf(t.tenant)
    await createDashboard(t.admin, 'red')
    const keyId = /^viz_([A-Za-z0-9]+)_/.exec(t.admin)![1]!
    const next = withMigration({ name: 'a breaking change (simulated release N+1)', readableFrom: LATEST + 1, up: (sql) => void sql.exec('CREATE TABLE future (tenant TEXT NOT NULL, x TEXT NOT NULL)') })
    const before = await runInDurableObject(stub, async (_i, s) => {
      expect(openSchema(s.storage, next)).toMatchObject({ status: 'ok', version: LATEST + 1, compat: LATEST + 1, migrated: [LATEST + 1] })
      await s.storage.setAlarm(Date.now() + 3_600_000)
      return dumpOf(s)
    })
    await evictDurableObject(stub)

    for (const [method, path, body] of [['GET', '/dashboards'], ['GET', '/whoami'], ['POST', '/dashboards', { spec: { apiVersion: 'viz.dashboard/v1' } }], ['PUT', '/settings/retention', { value: { metric_samples_days: 5 } }]] as const) {
      const res = await call(t.admin, method, path, body)
      expect(res.status, `${method} ${path}`).toBe(503)
      expect(res.body).toMatchObject({ code: 'schema-too-new', status: 503 })
      expect(res.headers.get('Retry-After')).toBe('30')
    }
    expect(await stub.resolveKey(t.tenant, keyId)).toMatchObject({ status: 'schema_too_new', component: 'control.Tenant', found: LATEST + 1, compat: LATEST + 1, known: LATEST })
    expect(await stub.recordUsage(t.tenant, [{ keyId, at: Date.now(), samples: 5 }])).toMatchObject({ status: 'schema_too_new' })
    const provisioned = await stub.provision(t.tenant).then(() => null, (e: Error) => e.message)
    expect(provisioned).toMatch(/^schema_too_new/)

    const t0 = Date.now()
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const after = await runInDurableObject(stub, async (_i, s) => ({ dump: dumpOf(s), alarm: await s.storage.getAlarm() }))
    expect(after.dump).toEqual(before)
    expect(after.alarm, 'the refusing release re-arms the alarm for the release that owns the storage').toBeGreaterThanOrEqual(t0 + 25_000)
  })

  it('the previous release, which knows one version less, may open storage this release wrote (a proposal to create a dashboard in it), and changes nothing', async () => {
    const t = await newTenant('rollback')
    const proposed = await post(t.admin, '/proposals', { spec: example('service_red', 'proposed_red'), message: 'made by this release' })
    expect(proposed.status, proposed.text).toBe(202)
    const res = await runInDurableObject(stubOf(t.tenant), (_i, s) => {
      const before = dumpOf(s)
      const opened = openSchema(s.storage, { ...TENANT_SCHEMA, migrations: TENANT_SCHEMA.migrations.slice(0, LATEST - 1) })
      return { opened, before, after: dumpOf(s) }
    })
    expect(res.opened).toMatchObject({ status: 'ok', version: LATEST, compat: 1, known: LATEST - 1, migrated: [] })
    expect(res.after).toEqual(res.before)
  })

  it('serves newer storage that declares itself readable by this release, and leaves its version alone', async () => {
    const t = await newTenant('compatible')
    const stub = stubOf(t.tenant)
    const next = withMigration({
      name: 'an additive change (simulated release N+1): a nullable column and a table',
      readableFrom: LATEST,
      up: (sql) => void sql.exec('ALTER TABLE dashboards ADD COLUMN folder TEXT; CREATE TABLE IF NOT EXISTS folders (tenant TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (tenant, id))'),
    })
    await runInDurableObject(stub, (_i, s) => void openSchema(s.storage, next))
    await evictDurableObject(stub)

    expect((await createDashboard(t.admin, 'red')).status).toBe(201)
    expect((await get(t.admin, '/dashboards')).body.items).toHaveLength(1)
    const seen = await runInDurableObject(stub, (_i, s) => ({
      row: schemaRow(s),
      // The newer release, opening again, migrates nothing and must tolerate what the older one wrote.
      reopen: openSchema(s.storage, next),
      folder: s.storage.sql.exec("SELECT folder FROM dashboards WHERE tenant = ? AND id = 'red'", t.tenant).one().folder,
    }))
    expect(seen.row).toMatchObject({ version: LATEST + 1, compat: LATEST })
    expect(seen.reopen).toMatchObject({ status: 'ok', version: LATEST + 1, migrated: [] })
    expect(seen.folder).toBeNull()
  })

  it('a migration that throws leaves the storage exactly as it was', async () => {
    const t = await newTenant('broken')
    const broken = withMigration({
      name: 'fails half way',
      readableFrom: LATEST + 1,
      up: (sql) => {
        sql.exec('CREATE TABLE half (x TEXT)')
        sql.exec("INSERT INTO keys (tenant, id, name, kind, scopes, key_id, created_at, created_by) VALUES ('x', 'x', 'x', 'key', '[]', 'x', 0, 'x')")
        throw new Error('boom')
      },
    })
    const result = await runInDurableObject(stubOf(t.tenant), (_i, s) => {
      const before = dumpOf(s)
      let error = ''
      try {
        openSchema(s.storage, broken)
      } catch (e) {
        error = (e as Error).message
      }
      return { error, before, after: dumpOf(s) }
    })
    expect(result.error).toBe('boom')
    expect(result.after).toEqual(result.before)
  })
})

describe('the runner refuses what no retry can fix, and the rollback rule', () => {
  it('a spec with a gap, a migration readable from the future, or storage that belongs to another class', async () => {
    const t = await newTenant('runner')
    const errors = await runInDurableObject(stubOf(t.tenant), (_i: Tenant, s) => {
      const out: string[] = []
      for (const spec of [
        { ...TENANT_SCHEMA, migrations: [{ ...TENANT_SCHEMA.migrations[0]!, version: 2 }] },
        { ...TENANT_SCHEMA, migrations: [{ ...TENANT_SCHEMA.migrations[0]!, readableFrom: 2 }] },
        { ...TENANT_SCHEMA, component: 'ruler.Ruler' },
      ]) {
        try {
          openSchema(s.storage, spec)
          out.push('opened')
        } catch (e) {
          out.push(e instanceof SchemaError ? 'SchemaError' : String(e))
        }
      }
      return out
    })
    expect(errors).toEqual(['SchemaError', 'SchemaError', 'SchemaError'])
  })

  it('what this release declares, and when a rollback may cross it', () => {
    expect(schemaRelease(TENANT_SCHEMA)).toEqual({ component: 'control.Tenant', latest: LATEST, compat: 1 })
    // Every migration so far is additive, so every earlier release may still open this storage:
    // the previous release stays a valid rollback target (COMPATIBILITY.md §2.3, §6).
    const release = schemaRelease(TENANT_SCHEMA)
    for (let known = 1; known < LATEST; known++) expect(canOpen(known, { version: release.latest, compat: release.compat }), `a release that knows ${known}`).toBe(true)
    expect(TENANT_SCHEMA.migrations.map((m) => m.readableFrom)).toEqual(TENANT_SCHEMA.migrations.map(() => 1))
    expect(canOpen(1, { version: 2, compat: 2 })).toBe(false)
    expect(canOpen(1, { version: 2, compat: 1 })).toBe(true)
    expect(canOpen(2, { version: 1, compat: 1 })).toBe(true)
  })
})

/** Rows as a comparable value: each row's JSON with sorted keys, sorted. */
function canon(rows: Record<string, Record<string, unknown>[]>): Record<string, string[]> {
  const one = (r: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1))))
  return Object.fromEntries(Object.entries(rows).map(([t, rs]) => [t, rs.map(one).sort()]))
}
