/**
 * Versioned storage (contracts/COMPATIBILITY.md §2) for the three classes: `Ruler`,
 * `Notifier` and `RulerIndex`.
 *
 * "A newer release" is simulated by running the shared runner with this component's
 * migrations plus one more on an object's storage, then evicting the object, so that the
 * real class (which knows only its own migrations) constructs itself on that storage.
 * "The pre-versioning release" is `test/fixtures/storage/v0.json`: every table of a ruler,
 * notifier and index object as the code before versioning left them after a scenario
 * (a firing alert, a recording rule, a silence, two notifications waiting for retry).
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { describeSchema, type Migration, openSchema, schemaRelease, type SchemaSpec } from '../../contracts/schema'
import { indexName } from '../src/registry'
import { INDEX_SCHEMA, NOTIFIER_SCHEMA, RULER_SCHEMA } from '../src/schema'
import { apiKey, call } from './api'
import { expectGolden, goldenDir } from './golden'
import { tenantWorld, world } from './harness'
import { MIN, newTenant, notifierStub, ok, rulerStub, runNotifierUntil, setup, vec } from './helpers'
import v0 from './fixtures/storage/v0.json'
import { type Dump, dumpOf, install, replaceWith, schemaRow, withoutVersion } from './storage'

const V0 = v0 as unknown as { tenant: string; now: number; ruler: Dump; notifier: Dump; index: Dump }
const indexStub = (name: string) => env.RULER_INDEX.get(env.RULER_INDEX.idFromName(name))
const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim()
const plus = (spec: SchemaSpec, m: Omit<Migration, 'version'>): SchemaSpec => ({ ...spec, migrations: [...spec.migrations, { ...m, version: spec.migrations.length + 1 }] })
const breaking = (spec: SchemaSpec) => plus(spec, { name: 'a breaking change (simulated release N+1)', readableFrom: spec.migrations.length + 1, up: (sql) => void sql.exec('CREATE TABLE future (x TEXT NOT NULL)') })
function canon(rows: Record<string, Record<string, unknown>[]>): Record<string, string[]> {
  const one = (r: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1))))
  return Object.fromEntries(Object.entries(rows).map(([t, rs]) => [t, rs.map(one).sort()]))
}

/** Runs a function on a fresh object's storage. */
type Runner = <R>(fn: (s: DurableObjectState) => R) => Promise<R>
const CLASSES: { name: 'ruler' | 'notifier' | 'index'; spec: SchemaSpec; fresh: () => Promise<Runner> }[] = [
  { name: 'ruler', spec: RULER_SCHEMA, fresh: async () => { const { stub } = await setup(); return (fn) => runInDurableObject(stub, (_i, s) => fn(s)) } },
  { name: 'notifier', spec: NOTIFIER_SCHEMA, fresh: async () => { const t = newTenant('n'); const st = notifierStub(t); ok(await st.health(t)); return (fn) => runInDurableObject(st, (_i, s) => fn(s)) } },
  { name: 'index', spec: INDEX_SCHEMA, fresh: async () => { const st = indexStub(`index/fresh-${newTenant()}`); await st.shardCount('x'); return (fn) => runInDurableObject(st, (_i, s) => fn(s)) } },
]

describe('versioned storage: the schema of every released version is pinned', () => {
  for (const c of CLASSES) {
    const latest = c.spec.migrations.length
    it(`${c.spec.component}: a fresh object is at the latest version and its schema is the golden file`, async () => {
      const { row, schema } = await (await c.fresh())((s) => ({ row: schemaRow(s), schema: describeSchema(s.storage.sql) }))
      expect(row).toMatchObject({ component: c.spec.component, version: latest, compat: schemaRelease(c.spec).compat })
      expectGolden(`schema/${c.name}.v${latest}.json`, { version: latest, schema })
    })

    it(`${c.spec.component}: migrations 1..N on empty storage give the golden schema of N, for every N`, async () => {
      const files = goldenDir('schema')
      for (let v = 1; v <= latest; v++) {
        const schema = await (await c.fresh())((s) => {
          replaceWith(s, { schema: [], rows: {} })
          openSchema(s.storage, { ...c.spec, migrations: c.spec.migrations.slice(0, v) })
          return describeSchema(s.storage.sql)
        })
        expect({ version: v, schema }).toEqual(files[`${c.name}.v${v}.json`])
      }
    })

    it(`${c.spec.component}: version 1 is exactly what the pre-versioning code created`, () => {
      const v1 = (goldenDir('schema')[`${c.name}.v1.json`] as { schema: { name: string; type: string; sql: string }[] }).schema.filter((s) => s.name !== 'viz_schema')
      expect(v1).toEqual(V0[c.name].schema.map((s) => ({ type: s.type, name: s.name, sql: norm(s.sql) })))
    })
  }
})

describe('versioned storage: storage written by the pre-versioning release', () => {
  it('is adopted as version 1 by all three classes without a row changing, keeps working, and delivers the old decisions under their old idempotency keys', async () => {
    const t = V0.tenant
    world.now = V0.now
    const ruler = rulerStub(t)
    const notifier = notifierStub(t)
    const index = indexStub('index/adopted')
    await runInDurableObject(ruler, () => undefined)
    await runInDurableObject(notifier, () => undefined)
    await index.shardCount('x')
    // A dump has no alarm; the old objects had one each (the ruler's next tick, the notifier's retry).
    await runInDurableObject(ruler, (_i, st) => st.storage.setAlarm(V0.now))
    await runInDurableObject(notifier, (_i, st) => st.storage.setAlarm(V0.now))
    await install(ruler, V0.ruler)
    await install(notifier, V0.notifier)
    await install(index, V0.index)

    // Served as the old release left it.
    const rules = ok(await ruler.rules(t)).rules
    expect(rules.map((r) => r.name).sort()).toEqual(['DeadMansSwitch', 'Down', 'job:up:sum'])
    expect(rules.find((r) => r.name === 'Down')!.alerts.map((a) => [a.labels.instance, a.state])).toEqual([['a', 'firing']])
    expect(ok(await notifier.listSilences(t)).silences).toHaveLength(1)
    const pending = ok(await notifier.outbox(t)).entries
    expect(pending.length).toBe(V0.notifier.rows.outbox!.length)
    expect(await index.registered(t)).toEqual({ status: 'ok', shards: ['0'] })
    expect(await index.shardCount(t)).toEqual({ status: 'ok', shards: 2 })

    // Nothing was changed by adopting it.
    const look = (s: DurableObjectState) => ({ row: schemaRow(s), dump: withoutVersion(dumpOf(s)) })
    const seen = {
      ruler: await runInDurableObject(ruler, (_i, s) => look(s)),
      notifier: await runInDurableObject(notifier, (_i, s) => look(s)),
      index: await runInDurableObject(index, (_i, s) => look(s)),
    }
    for (const name of ['ruler', 'notifier', 'index'] as const) {
      const after = seen[name]
      expect(after.row, name).toMatchObject({ version: 1, compat: 1 })
      expect(canon(after.dump.rows), name).toEqual(canon(V0[name].rows))
    }

    // It keeps working: the next tick changes nothing (still down), and the two notifications the old
    // release decided are delivered now with the idempotency keys it chose, so a receiver de-duplicates.
    const w = tenantWorld(t)
    w.evaluate = (q) => (q === 'up == 0' ? vec([{ __name__: 'up', instance: 'a', job: 'j' }, 0]) : vec([{}, 3]))
    expect(ok(await ruler.health(t)).alarmAtMs, 'the alarm the old release left').toBe(V0.now)
    expect(await runDurableObjectAlarm(ruler)).toBe(true)
    expect(ok(await ruler.health(t)).groups.find((g) => g.name === 'g')!.lastEvaluationMs, 'the adopted group was evaluated').not.toBeNull()
    expect(w.ingestCalls.filter((u) => u.some((x) => x.labels.alertname === 'Down'))).toEqual([])
    w.respond = () => 200
    await runNotifierUntil(notifier, t, world.now + 10 * MIN)
    const keys = new Set(w.received.map((r) => r.key))
    for (const row of V0.notifier.rows.outbox!) expect(keys.has(row.idem_key as string), `old decision ${row.id} delivered with its key`).toBe(true)

    // Eviction does not migrate again.
    const before = await runInDurableObject(ruler, (_i, s) => schemaRow(s))
    await evictDurableObject(ruler)
    expect(await runInDurableObject(ruler, (_i, s) => ({ row: schemaRow(s), reopen: openSchema(s.storage, RULER_SCHEMA) }))).toMatchObject({ row: before, reopen: { status: 'ok', migrated: [] } })
  })
})

describe('versioned storage: newer storage', () => {
  it('Ruler: refused on every RPC and over HTTP when a newer release migrated it past what this code knows; the alarm is re-armed, nothing written', async () => {
    const { tenant, stub } = await setup()
    ok(await stub.saveGroups(tenant, { groups: [{ name: 'g', interval: '1m', rules: [{ alert: 'Down', expr: 'up == 0' }] }] }))
    const before = await runInDurableObject(stub, (_i, s) => {
      expect(openSchema(s.storage, breaking(RULER_SCHEMA))).toMatchObject({ status: 'ok', version: 2, compat: 2 })
      return dumpOf(s)
    })
    await evictDurableObject(stub)
    const refused = { status: 'schema_too_new', component: 'ruler.Ruler', found: 2, compat: 2, known: 1, retryAfterMs: 30_000 }
    expect(await stub.rules(tenant)).toEqual(refused)
    expect(await stub.health(tenant)).toEqual(refused)
    expect(await stub.configure(tenant, { heartbeatMs: 0 })).toEqual(refused)
    expect(await stub.saveGroups(tenant, { groups: [] })).toEqual(refused)
    expect(await stub.ensureArmed(tenant)).toEqual(refused)
    expect(await stub.deleteGroup(tenant, 'g')).toEqual(refused)

    const key = await apiKey(tenant)
    const prom = await call(key.auth, 'GET', '/api/v1/rules')
    expect([prom.status, prom.json]).toMatchObject([503, { status: 'error', errorType: 'unavailable' }])
    const monitors = await call(key.auth, 'GET', '/api/v1/monitors')
    expect([monitors.status, monitors.json?.error?.code, monitors.headers.get('Retry-After')]).toEqual([503, 'schema_too_new', '30'])

    const t0 = Date.now()
    await runInDurableObject(stub, (_i, s) => s.storage.setAlarm(Date.now() + 3_600_000))
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const after = await runInDurableObject(stub, async (_i, s) => ({ dump: dumpOf(s), alarm: await s.storage.getAlarm() }))
    expect(after.dump).toEqual(before)
    expect(after.alarm).toBeGreaterThanOrEqual(t0 + 25_000)
  })

  it('Notifier: refused, and a current ruler handing alerts to it keeps them in its outbox (nothing acknowledged, nothing lost)', async () => {
    const { tenant, stub, notifier, w } = await setup({ heartbeatMs: 30 * MIN })
    ok(await notifier.setConfig(tenant, { route: { receiver: 'hook', group_wait: '0s' }, receivers: [{ name: 'hook', webhook_configs: [{ url: 'https://receiver.test/hook' }] }] }))
    ok(await stub.saveGroups(tenant, { groups: [{ name: 'g', interval: '1m', rules: [{ alert: 'Down', expr: 'up == 0' }] }] }))
    const before = await runInDurableObject(notifier, (_i, s) => {
      openSchema(s.storage, breaking(NOTIFIER_SCHEMA))
      return dumpOf(s)
    })
    await evictDurableObject(notifier)
    expect(await notifier.ingest(tenant, `${tenant}/0`, [])).toMatchObject({ status: 'schema_too_new', component: 'ruler.Notifier' })
    expect(await notifier.listAlerts(tenant)).toMatchObject({ status: 'schema_too_new' })

    w.evaluate = () => vec([{ __name__: 'up', instance: 'a' }, 0])
    const at = ok(await stub.health(tenant)).alarmAtMs!
    world.now = Math.max(world.now, at)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const h = ok(await stub.health(tenant))
    expect(h.outboxDepth, 'the firing transition waits in the ruler').toBe(1)
    expect(h.lastHandoffError).toMatch(/schema_too_new/)
    expect(await runInDurableObject(notifier, (_i, s) => dumpOf(s))).toEqual(before)
  })

  it('RulerIndex: refused by an exception (its results have one shape), which the HTTP API answers with 503', async () => {
    const tenant = newTenant('idx')
    const index = indexStub(indexName(tenant))
    await index.shardCount(tenant)
    await runInDurableObject(index, (_i, s) => void openSchema(s.storage, breaking(INDEX_SCHEMA)))
    await evictDurableObject(index)
    for (const p of [index.shardCount(tenant), index.register(tenant, '0'), index.sweepPage(null, 10)] as Promise<unknown>[]) {
      expect(await p.then(() => 'answered', (e: Error) => e.message)).toMatch(/^schema_too_new/)
    }
    const key = await apiKey(tenant)
    const res = await call(key.auth, 'PUT', '/api/v1/monitors/groups/g', { name: 'g', rules: [{ alert: 'Down', expr: 'up == 0' }] })
    expect([res.status, res.json?.error?.code]).toEqual([503, 'schema_too_new'])
  })

  it('Ruler: newer storage that declares itself readable by this release is served, written to, and left at its version', async () => {
    const { tenant, stub, w } = await setup()
    ok(await stub.saveGroups(tenant, { groups: [{ name: 'g', interval: '1m', rules: [{ alert: 'Down', expr: 'up == 0' }] }] }))
    const next = plus(RULER_SCHEMA, { name: 'an additive change: a nullable column', readableFrom: 1, up: (sql) => void sql.exec('ALTER TABLE alert ADD COLUMN acked_by TEXT') })
    await runInDurableObject(stub, (_i, s) => void openSchema(s.storage, next))
    await evictDurableObject(stub)
    w.evaluate = () => vec([{ __name__: 'up', instance: 'a' }, 0])
    world.now = Math.max(world.now, ok(await stub.health(tenant)).alarmAtMs!)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const seen = await runInDurableObject(stub, (_i, s) => ({ row: schemaRow(s), alerts: s.storage.sql.exec('SELECT acked_by FROM alert WHERE tenant = ?', tenant).toArray(), reopen: openSchema(s.storage, next) }))
    expect(seen.row).toMatchObject({ version: 2, compat: 1 })
    expect(seen.alerts).toEqual([{ acked_by: null }])
    expect(seen.reopen).toMatchObject({ status: 'ok', migrated: [] })
  })
})
