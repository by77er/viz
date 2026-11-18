/**
 * Robustness: the registry and the sweeper that re-arms rulers whose alarm was lost, and
 * ruler shard splitting (deterministic placement, no group split, state preserved on a move).
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { INDEX_PARTITIONS, type MonitorView } from '../contracts-proposal/rules.v2'
import { assign, DEFAULT_PLACEMENT, jumpHash, shardOf } from '../src/placement'
import { indexName, indexPartition, sweep } from '../src/registry'
import registrySource from '../src/registry.ts?raw'
import httpSource from '../src/http.ts?raw'
import { apiKey, call } from './api'
import { tenantWorld, world, T0, type TestRulerIndex } from './harness'
import { MIN, newTenant, nextTick, notifierStub, ok, rulerStub, runNotifierUntil, setup, vec } from './helpers'

const indexStub = (tenant: string) => env.RULER_INDEX.get(env.RULER_INDEX.idFromName(indexName(tenant))) as DurableObjectStub<TestRulerIndex>
const file = (rules: unknown[], name = 'g') => ({ groups: [{ name, interval: '1m', rules }] })
const alarmOf = (stub: ReturnType<typeof rulerStub>) => runInDurableObject(stub, (_i, state) => state.storage.getAlarm())

describe('the registry of ruler objects', () => {
  it('a ruler registers itself when it first has work and unregisters when it has none; asking again writes nothing', async () => {
    const { tenant, stub } = await setup()
    const index = indexStub(tenant)
    expect((await index.registered(tenant)).shards).toEqual([])
    ok(await stub.saveGroups(tenant, file([{ alert: 'A', expr: 'up' }])))
    expect((await index.registered(tenant)).shards).toEqual(['0'])
    const writes = ok(await stub.health(tenant)).counters.sqlRowsWritten
    ok(await stub.saveGroups(tenant, file([{ alert: 'B', expr: 'up' }], 'h')))
    expect(ok(await stub.health(tenant)).counters.sqlRowsWritten - writes).toBe(1) // the group row only: the registration is remembered
    expect(await index.register(tenant, '0')).toEqual({ status: 'ok', added: false })
    await evictDurableObject(stub)
    ok(await stub.deleteGroup(tenant, 'g'))
    expect((await index.registered(tenant)).shards).toEqual(['0'])
    ok(await stub.deleteGroup(tenant, 'h'))
    expect((await index.registered(tenant)).shards).toEqual([])
  })

  it('a tenant always lands in the same one of the index partitions, and tenants spread over them', () => {
    const parts = new Set<number>()
    for (let i = 0; i < 400; i++) {
      const p = indexPartition(`tenant-${i}`)
      expect(p).toBe(indexPartition(`tenant-${i}`))
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(INDEX_PARTITIONS)
      parts.add(p)
    }
    expect(parts.size).toBe(INDEX_PARTITIONS)
  })

  it('the shard count only grows', async () => {
    const tenant = newTenant('count')
    const index = indexStub(tenant)
    expect(await index.shardCount(tenant)).toEqual({ status: 'ok', shards: 1 })
    expect((await index.growShards(tenant, 3)).shards).toBe(3)
    expect((await index.growShards(tenant, 2)).shards).toBe(3)
    expect((await index.growShards(tenant, 0)).shards).toBe(3)
    expect((await index.shardCount(newTenant('other'))).shards).toBe(1)
  })

  it('every statement in the registry names the tenant, except the one platform sweep; the HTTP layer has no SQL at all', () => {
    const statements = [...registrySource.matchAll(/`((?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*)`/g)].map((m) => m[1]!)
    expect(statements.length).toBeGreaterThanOrEqual(6)
    const crossTenant = statements.filter((sql) => !(sql.startsWith('INSERT') ? /\(tenant,/.test(sql) : /WHERE tenant = \?/.test(sql)))
    expect(crossTenant).toEqual(['SELECT tenant, shard FROM ruler WHERE (tenant, shard) > (?, ?) ORDER BY tenant, shard LIMIT ?'])
    expect(registrySource).toMatch(/viz:sweep/)
    expect(httpSource).not.toMatch(/\.sql\b|storage\./)
  })
})

describe('the sweeper (a Cron Trigger calls sweep())', () => {
  async function tenants(n: number) {
    const out = []
    for (let i = 0; i < n; i++) {
      const t = await setup({}, newTenant('sweep'))
      ok(await t.stub.saveGroups(t.tenant, file([{ alert: 'A', expr: 'up' }])))
      out.push(t)
    }
    return out
  }

  it('re-arms exactly the rulers whose alarm was lost, and a second sweep changes nothing', async () => {
    const all = await tenants(6)
    expect(new Set(all.map((t) => indexPartition(t.tenant))).size).toBeGreaterThan(1) // spread over index partitions
    world.now = T0 + 30 * MIN
    const lost = all.slice(0, 3)
    const armed = all.slice(3)
    for (const t of lost) await runInDurableObject(t.stub, (_i, state) => state.storage.deleteAlarm())
    const before = await Promise.all(armed.map((t) => alarmOf(t.stub)))
    const countersBefore = await Promise.all(all.map(async (t) => ok(await t.stub.health(t.tenant)).counters.alarmsSet))

    const first = await sweep(env)
    expect(first.partitions).toBe(INDEX_PARTITIONS)
    expect(first.rearmed).toBe(3)
    expect(first.failed).toBe(0)
    expect(first.checked).toBeGreaterThanOrEqual(6)
    for (const t of lost) expect(await alarmOf(t.stub)).toBe(world.now) // armed for now: it will tick at once
    // The rulers that still had their alarm were not touched: same alarm time, no setAlarm call.
    expect(await Promise.all(armed.map((t) => alarmOf(t.stub)))).toEqual(before)
    const countersAfter = await Promise.all(all.map(async (t) => ok(await t.stub.health(t.tenant)).counters.alarmsSet))
    expect(countersAfter.map((c, i) => c - countersBefore[i]!)).toEqual([1, 1, 1, 0, 0, 0])

    const second = await sweep(env)
    expect(second.rearmed).toBe(0)
    expect(second.checked).toBe(first.checked)
    expect(await Promise.all(all.map(async (t) => ok(await t.stub.health(t.tenant)).counters.alarmsSet))).toEqual(countersAfter)

    // The re-armed rulers really evaluate again.
    for (const t of lost) {
      await nextTick(t.stub, t.tenant)
      expect(ok(await t.stub.health(t.tenant)).groups[0]!.evaluations).toBe(1)
    }
  })

  it('a ruler evicted without its alarm is still found: the registry, not the object\'s memory, knows it exists', async () => {
    const [t] = await tenants(1)
    await runInDurableObject(t!.stub, (_i, state) => state.storage.deleteAlarm())
    await evictDurableObject(t!.stub)
    expect((await sweep(env)).rearmed).toBe(1)
    expect(await alarmOf(t!.stub)).not.toBeNull()
  })

  it('a ruler with nothing to do is not armed, and one that cannot be reached is counted and left for the next sweep', async () => {
    const [idle, broken] = await tenants(2)
    // No groups left, but the registration is made to linger (a failed unregister).
    ok(await idle!.stub.deleteGroup(idle!.tenant, 'g'))
    await indexStub(idle!.tenant).register(idle!.tenant, '0')
    await runInDurableObject(broken!.stub, (_i, state) => state.storage.deleteAlarm())
    world.unreachableRulers.add(`${broken!.tenant}/0`)
    try {
      const r = await sweep(env)
      expect(r.failed).toBe(1)
      expect(await alarmOf(idle!.stub)).toBeNull()
      expect(await alarmOf(broken!.stub)).toBeNull()
    } finally {
      world.unreachableRulers.clear()
    }
    expect((await sweep(env)).rearmed).toBe(1)
    expect(await alarmOf(broken!.stub)).not.toBeNull()
  })

  it('pages through a partition: small pages reach every registered ruler exactly once', async () => {
    const tenant = newTenant('page')
    const index = indexStub(tenant)
    for (let s = 0; s < 7; s++) await index.register(tenant, String(s))
    let cursor: string | null = null
    const sizes: number[] = []
    let total = 0
    do {
      const page: { checked: number; next: string | null } = await index.sweepPage(cursor, 3)
      sizes.push(page.checked)
      total += page.checked
      cursor = page.next
    } while (cursor !== null)
    const all = await index.sweepPage(null, 500)
    expect(total).toBe(all.checked)
    expect(sizes.slice(0, -1).every((n) => n === 3)).toBe(true)
    for (let s = 0; s < 7; s++) await index.unregister(tenant, String(s))
  })
})

describe('placement of groups on shards (pure)', () => {
  it('jump hash: in range, stable, and growing by one shard only ever moves keys to the new shard', () => {
    for (let n = 1; n < 12; n++) {
      let moved = 0
      for (let k = 0; k < 500; k++) {
        const a = jumpHash(`group-${k}`, n)
        const b = jumpHash(`group-${k}`, n + 1)
        expect(a).toBeGreaterThanOrEqual(0)
        expect(a).toBeLessThan(n)
        expect(jumpHash(`group-${k}`, n)).toBe(a)
        if (a !== b) {
          expect(b).toBe(n)
          moved++
        }
      }
      // About 1/(n+1) of the keys move.
      expect(moved).toBeGreaterThan(500 / (n + 1) / 2)
      expect(moved).toBeLessThan((500 / (n + 1)) * 2)
    }
  })

  it('the assignment is the same whatever order the groups come in, keeps every shard within its limits, and never shrinks', () => {
    const groups = Array.from({ length: 40 }, (_, i) => ({ name: `team-${i}/rules`, rules: 20 + ((i * 37) % 90) }))
    const limits = { maxRulesPerShard: 400, maxGroupsPerShard: 8, maxShards: 64 }
    const a = assign(groups, 1, limits)
    const b = assign([...groups].reverse(), 1, limits)
    if (!a.ok || !b.ok) throw new Error('assignment failed')
    expect(b.shards).toBe(a.shards)
    expect([...b.placement].sort()).toEqual([...a.placement].sort())
    const rules = new Array<number>(a.shards).fill(0)
    const count = new Array<number>(a.shards).fill(0)
    for (const g of groups) {
      const s = a.placement.get(g.name)!
      expect(s).toBe(shardOf(g.name, a.shards)) // one shard per group: a group is never split
      rules[s]! += g.rules
      count[s]! += 1
    }
    expect(Math.max(...rules)).toBeLessThanOrEqual(400)
    expect(Math.max(...count)).toBeLessThanOrEqual(8)
    // One shard fewer would not have fitted.
    const fewer = new Array<number>(a.shards - 1).fill(0)
    const fewerCount = new Array<number>(a.shards - 1).fill(0)
    for (const g of groups) {
      fewer[shardOf(g.name, a.shards - 1)]! += g.rules
      fewerCount[shardOf(g.name, a.shards - 1)]! += 1
    }
    expect(Math.max(...fewer) > 400 || Math.max(...fewerCount) > 8).toBe(true)
    // Deleting groups does not shrink the shard count: the current count is a floor.
    const kept = assign(groups.slice(0, 3), a.shards, limits)
    expect(kept.ok && kept.shards).toBe(a.shards)
  })

  it('refuses a group larger than a shard, and a tenant that does not fit, with a fix', () => {
    expect(assign([{ name: 'huge', rules: 1001 }], 1)).toMatchObject({ ok: false, error: { path: 'groups', fix: 'Split the group.' } })
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `g${i}`, rules: 10 }))
    expect(assign(many, 1, { maxRulesPerShard: 10, maxGroupsPerShard: 64, maxShards: 4 })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/do not fit in 4 rule shards/) } })
    expect(assign([], 1)).toMatchObject({ ok: true, shards: 1 })
    expect(DEFAULT_PLACEMENT.maxRulesPerShard).toBe(1000)
  })
})

describe('shard splitting through the API', () => {
  const limits = { maxRulesPerShard: 10, maxGroupsPerShard: 64, maxShards: 16 }
  const group = (name: string, n: number) => ({ interval: '1m', rules: Array.from({ length: n }, (_, i) => ({ alert: `${name}-A${i}`, expr: `${name}_m${i} > 0`, for: '3m', annotations: { summary: `${name} ${i}` } })) })

  async function scene() {
    world.now = T0
    const tenant = newTenant('split')
    const key = await apiKey(tenant)
    const w = tenantWorld(tenant)
    ok(await rulerStub(tenant).configure(tenant, { deadman: false }))
    ok(await notifierStub(tenant).setConfig(tenant, { route: { receiver: 'hook', group_by: ['alertname'], group_wait: '0s', group_interval: '1m', repeat_interval: '4h' }, receivers: [{ name: 'hook', webhook_configs: [{ url: 'https://receiver.test/hook' }] }] }))
    const where = async () => {
      const n = (await indexStub(tenant).shardCount(tenant)).shards
      const out = new Map<string, string[]>()
      const rules: number[] = []
      for (let s = 0; s < n; s++) {
        const groups = ok(await rulerStub(tenant, String(s)).listGroups(tenant)).groups
        rules.push(groups.reduce((x, g) => x + g.rules.length, 0))
        for (const g of groups) out.set(g.name, [...(out.get(g.name) ?? []), String(s)])
      }
      return { n, groups: out, rules }
    }
    return { tenant, key, w, where }
  }

  it('a shard that would exceed its rule limit splits: more shards, every shard within the limit, no group on two shards, each where the placement function says', async () => {
    const saved = world.placement
    world.placement = limits
    try {
      const s = await scene()
      for (let i = 0; i < 9; i++) expect((await call(s.key.auth, 'PUT', `/api/v1/monitors/groups/g${i}`, group(`g${i}`, 4))).status, `g${i}`).toBe(200)
      const at = await s.where()
      expect(at.n).toBeGreaterThanOrEqual(4) // 36 rules, 10 per shard
      expect(Math.max(...at.rules)).toBeLessThanOrEqual(10)
      expect([...at.groups.keys()].sort()).toEqual(Array.from({ length: 9 }, (_, i) => `g${i}`))
      for (const [name, shards] of at.groups) expect(shards, name).toEqual([String(shardOf(name, at.n))])
      // The registry knows every shard that has work, so the sweeper will find them.
      const used = [...new Set([...at.groups.values()].flat())].sort()
      expect((await indexStub(s.tenant).registered(s.tenant)).shards).toEqual(used)
      // Both faces of the API read across the shards.
      const listed = (await call(s.key.auth, 'GET', '/api/v1/monitors')).json.monitors as MonitorView[]
      expect(listed.length).toBe(36)
      expect(new Set(listed.map((m) => m.shard)).size).toBe(used.length)
      const prom = (await call(s.key.auth, 'GET', '/api/v1/rules')).json.data.groups as { name: string; file: string }[]
      expect(prom.map((g) => [g.name, g.file]).sort()).toEqual([...at.groups].map(([name, sh]) => [name, `shard-${sh[0]}`]).sort())
      // A second tenant given the same groups in the opposite order ends with the same placement.
      const t2 = await scene()
      for (let i = 8; i >= 0; i--) await call(t2.key.auth, 'PUT', `/api/v1/monitors/groups/g${i}`, group(`g${i}`, 4))
      const at2 = await t2.where()
      expect(at2.n).toBe(at.n)
      expect([...at2.groups].sort()).toEqual([...at.groups].sort())
      // A group that cannot fit in any shard is refused, and nothing changes.
      const big = await call(s.key.auth, 'PUT', '/api/v1/monitors/groups/big', group('big', 11))
      expect(big.status).toBe(422)
      expect(big.json.problems).toMatchObject([{ path: 'groups', fix: 'Split the group.' }])
      expect((await s.where()).groups.has('big')).toBe(false)
    } finally {
      world.placement = saved
    }
  })

  it('moving a group preserves its alert state: pending and firing alerts keep their times, `for` keeps counting, nothing is resolved or re-notified, and the history follows', async () => {
    const saved = world.placement
    world.placement = limits
    try {
      const s = await scene()
      // Fill shard 0 with groups until adding one more forces a split that moves at least one of them.
      // Two groups that the placement function moves off shard 0 at the first split (and, by the
      // jump-hash property, never back), and one that stays.
      const candidates = Array.from({ length: 200 }, (_, i) => `svc-${i}`)
      const movers = candidates.filter((n) => shardOf(n, 2) === 1).slice(0, 2)
      const stayer = candidates.find((n) => [2, 3, 4, 5, 6, 7, 8].every((k) => shardOf(n, k) === 0)) as string
      const names = [...movers, stayer]
      for (const n of names) expect((await call(s.key.auth, 'PUT', `/api/v1/monitors/groups/${n}`, group(n, 3))).status).toBe(200)
      expect((await s.where()).n).toBe(1)
      // m0 of each group fires; m1 is pending (it appeared later).
      let phase = 0
      s.w.evaluate = (q) => (/_m0 /.test(q) || (phase > 0 && /_m1 /.test(q)) ? vec([{ instance: 'i1' }, 2]) : vec())
      const ruler0 = rulerStub(s.tenant)
      const tickAll = async () => {
        const before = world.now
        const n = (await indexStub(s.tenant).shardCount(s.tenant)).shards
        for (let sh = 0; sh < n; sh++) {
          const stub = rulerStub(s.tenant, String(sh))
          for (;;) {
            const h = ok(await stub.health(s.tenant))
            if (h.alarmAtMs === null || h.alarmAtMs > before + MIN) break
            world.now = Math.max(before, h.alarmAtMs)
            await runInDurableObject(stub, (inst) => inst.alarm())
          }
        }
        world.now = before + MIN
        await runNotifierUntil(notifierStub(s.tenant), s.tenant, world.now)
      }
      for (let i = 0; i < 4; i++) await tickAll() // m0 alerts: pending, then firing after 3m
      phase = 1
      await tickAll() // m1 alerts appear: pending
      const alertsBefore = ((await call(s.key.auth, 'GET', '/api/v1/alerts')).json.data.alerts as { labels: Record<string, string>; state: string; activeAt: string }[])
        .map((a) => `${a.labels.alertname}:${a.state}:${a.activeAt}`).sort()
      expect(alertsBefore.filter((a) => a.includes(':firing:')).length).toBe(3)
      expect(alertsBefore.filter((a) => a.includes(':pending:')).length).toBe(3)
      const monitorsBefore = ((await call(s.key.auth, 'GET', '/api/v1/monitors')).json.monitors as MonitorView[]).filter((m) => m.alerts.length > 0)
      const histories = new Map<string, unknown>()
      for (const m of monitorsBefore) histories.set(m.id, (await call(s.key.auth, 'GET', `/api/v1/monitors/${m.id}`)).json.history)
      const received = s.w.received.length
      const ingests = s.w.ingestCalls.length
      expect(received).toBe(3)

      // Force the split.
      for (const n of ['a', 'b', 'c', 'd', 'e']) await call(s.key.auth, 'PUT', `/api/v1/monitors/groups/extra-${n}`, group(`extra-${n}`, 3))
      const at = await s.where()
      expect(at.n).toBeGreaterThan(1)
      const moved = names.filter((n) => at.groups.get(n)![0] !== '0')
      expect(moved.sort()).toEqual([...movers].sort())
      expect(at.groups.get(stayer)).toEqual(['0'])
      for (const n of names) expect(at.groups.get(n)).toEqual([String(shardOf(n, at.n))])
      expect(ok(await ruler0.listGroups(s.tenant)).groups.map((g) => g.name).some((g) => moved.includes(g))).toBe(false) // released at the source

      // Same alerts, same states, same activeAt; same firing-since; same history.
      const alertsAfter = ((await call(s.key.auth, 'GET', '/api/v1/alerts')).json.data.alerts as { labels: Record<string, string>; state: string; activeAt: string }[])
        .map((a) => `${a.labels.alertname}:${a.state}:${a.activeAt}`).sort()
      expect(alertsAfter).toEqual(alertsBefore)
      const monitorsAfter = new Map(((await call(s.key.auth, 'GET', '/api/v1/monitors')).json.monitors as MonitorView[]).map((m) => [m.id, m]))
      for (const m of monitorsBefore) {
        const now = monitorsAfter.get(m.id)!
        expect([now.state, now.activeAt, now.firingSince, now.alerts.map((a) => [a.fingerprint, a.state, a.activeAt, a.firingSince, a.lastNotifiedAt])]).toEqual(
          [m.state, m.activeAt, m.firingSince, m.alerts.map((a) => [a.fingerprint, a.state, a.activeAt, a.firingSince, a.lastNotifiedAt])])
        expect((await call(s.key.auth, 'GET', `/api/v1/monitors/${m.id}`)).json.history).toEqual(histories.get(m.id))
      }
      // The move told the notifier nothing: no resolve, no second "firing".
      expect(s.w.ingestCalls.length).toBe(ingests)
      expect(s.w.received.length).toBe(received)

      // `for` kept counting on the new shard: the pending alerts fire 3 minutes after they first appeared, not 3 minutes after the move.
      const pendingBefore = monitorsBefore.filter((m) => m.state === 'pending')
      expect(pendingBefore.length).toBe(3)
      const latest = Math.max(...pendingBefore.map((m) => m.activeAt as number))
      while (world.now < latest + 3 * MIN + 30_000) await tickAll()
      const finalById = new Map(((await call(s.key.auth, 'GET', '/api/v1/monitors')).json.monitors as MonitorView[]).map((m) => [m.id, m]))
      for (const m of pendingBefore) {
        const now = finalById.get(m.id)!
        expect([now.name, now.state, now.activeAt]).toEqual([m.name, 'firing', m.activeAt]) // the same alert, not a new one
        expect((now.firingSince as number) - (m.activeAt as number), now.name).toBeGreaterThanOrEqual(3 * MIN)
        expect((now.firingSince as number) - (m.activeAt as number), now.name).toBeLessThan(4 * MIN) // 3m after it first appeared (plus at most one interval: the new shard's tick grid)
      }
      // Exactly one "firing" notification per newly firing alert group, none repeated for the alerts that moved while firing.
      const firingBodies = s.w.received.map((r) => (r.body as { status: string; alerts: { labels: Record<string, string>; status: string }[] })).filter((b) => b.status === 'firing')
      const perAlert = new Map<string, number>()
      for (const b of firingBodies) for (const a of b.alerts) perAlert.set(a.labels.alertname!, (perAlert.get(a.labels.alertname!) ?? 0) + 1)
      for (const n of names) {
        expect(perAlert.get(`${n}-A0`), `${n}-A0`).toBe(1)
        expect(perAlert.get(`${n}-A1`), `${n}-A1`).toBe(1)
      }
      expect(s.w.received.some((r) => (r.body as { status: string }).status === 'resolved')).toBe(false)
    } finally {
      world.placement = saved
    }
  })

  it('a move interrupted after the copy and before the release is finished by the next write: the group ends on one shard', async () => {
    const saved = world.placement
    world.placement = limits
    try {
      const s = await scene()
      for (const n of ['pay', 'cart', 'search', 'extra-a', 'extra-b', 'extra-c', 'extra-d', 'extra-e']) await call(s.key.auth, 'PUT', `/api/v1/monitors/groups/${n}`, group(n, 3))
      const at = await s.where()
      const [name, [home]] = [...at.groups].find(([, sh]) => sh[0] !== '0') as [string, string[]]
      // Recreate the interrupted state by hand: the group is copied back to shard 0 as well.
      const bundle = ok(await rulerStub(s.tenant, home).exportGroup(s.tenant, name))
      if (bundle.status !== 'ok') throw new Error('no bundle')
      ok(await rulerStub(s.tenant, '0').importGroup(s.tenant, bundle.bundle))
      expect((await s.where()).groups.get(name)!.sort()).toEqual(['0', home!].sort())
      // Reads already see it once, on its assigned shard.
      const listed = (await call(s.key.auth, 'GET', '/api/v1/monitors/groups')).json.groups as { name: string; shard: string }[]
      expect(listed.filter((g) => g.name === name)).toMatchObject([{ shard: home }])
      // Any write reconciles.
      expect((await call(s.key.auth, 'PUT', '/api/v1/monitors/groups/one-more', group('one-more', 1))).status).toBe(200)
      expect((await s.where()).groups.get(name)).toEqual([String(shardOf(name, (await s.where()).n))])
      // importGroup is idempotent and export of a missing group says so.
      expect(await rulerStub(s.tenant, '0').exportGroup(s.tenant, 'nope')).toEqual({ status: 'not_found' })
      expect(await rulerStub(s.tenant, '0').releaseGroup(s.tenant, 'nope')).toEqual({ status: 'ok', existed: false })
    } finally {
      world.placement = saved
    }
  })

  it('single monitors go to the group for their interval, and that group moves as one when the shard fills', async () => {
    const saved = world.placement
    world.placement = { ...limits, maxRulesPerShard: 6 }
    try {
      const s = await scene()
      const ids: string[] = []
      for (let i = 0; i < 5; i++) ids.push((await call(s.key.auth, 'POST', '/api/v1/monitors', { name: `one-${i}`, expr: `m${i} > 0`, interval: '1m' })).json.id)
      for (let i = 0; i < 5; i++) ids.push((await call(s.key.auth, 'POST', '/api/v1/monitors', { name: `five-${i}`, expr: `n${i} > 0`, interval: '5m' })).json.id)
      const at = await s.where()
      expect([...at.groups.keys()].sort()).toEqual(['monitors/1m', 'monitors/5m'])
      expect(at.n).toBeGreaterThan(1)
      expect(Math.max(...at.rules)).toBeLessThanOrEqual(6)
      const listed = (await call(s.key.auth, 'GET', '/api/v1/monitors')).json.monitors as MonitorView[]
      expect(listed.map((m) => m.id).sort()).toEqual([...ids].sort())
      // A monitor on a shard other than 0 can be read, updated and deleted like any other.
      const far = listed.find((m) => m.shard !== '0')!
      expect((await call(s.key.auth, 'GET', `/api/v1/monitors/${far.id}`)).json.monitor.name).toBe(far.name)
      expect((await call(s.key.auth, 'PUT', `/api/v1/monitors/${far.id}`, { name: far.name, expr: far.expr, interval: `${far.intervalMs / MIN}m`, message: 'edited' })).status).toBe(200)
      expect((await call(s.key.auth, 'GET', `/api/v1/monitors/${far.id}`)).json.monitor.message).toBe('edited')
      expect((await call(s.key.auth, 'DELETE', `/api/v1/monitors/${far.id}`)).status).toBe(200)
      expect((await call(s.key.auth, 'GET', '/api/v1/monitors')).json.total).toBe(9)
    } finally {
      world.placement = saved
    }
  })
})
