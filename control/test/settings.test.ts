/// <reference path="../../engine/wasm/js/wasm.d.ts" />
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { dedicatedPool, slotFor, tenantSlots, validBasePool } from '../../shard/src/pool'
import { clearMapCache, poolMap, type RouteEnv } from '../../edge/src/route'
import { DEFAULT_SIGNAL_DAYS, parseRetention, readRetention } from '../../janitor/src/janitor'
import { ROUTES } from '../src/routes'
import { authorize, newClient, pkce } from './oauth'
import { auditOf, call, example, get, kvGet, makeKey, newTenant, post, stubOf } from './helpers'

const put = (key: string, section: string, body: unknown) => call(key, 'PUT', `/settings/${section}`, body)

/** Edge's own reader of `pool:<tenant>` (edge/src/route.ts `poolMap`), on the record control published: the map it routes on, or its refusal. */
async function edgeRoutes(tenant: string, defaultPool?: unknown): Promise<{ routes: true; map: unknown } | { routes: false; status: number }> {
  clearMapCache()
  try {
    const map = await poolMap({ CONFIG: env.CONFIG, ...(defaultPool !== undefined ? { DEFAULT_POOL: JSON.stringify(defaultPool) } : {}) } as unknown as RouteEnv, tenant, true)
    return { routes: true, map }
  } catch (e) {
    return { routes: false, status: (e as { status: number }).status }
  }
}

/** The janitor's own reading of the tenant's published retention record (janitor/src/janitor.ts): the days it keeps per table group. */
async function janitorKeeps(tenant: string): Promise<{ metric_samples_days: number; trace_days: number | null; log_days: number | null }> {
  const r = await readRetention({ CONFIG: env.CONFIG }, tenant)
  if (r.status !== 'ok') throw new Error(`the janitor cannot read retention:${tenant}: ${r.reason}`)
  return r.policy
}
const JANITOR_FIELDS = ['metric_samples_days', 'trace_days', 'log_days'] as const

describe('settings', () => {
  it('defaults are shown as effective; nothing is in KV until something is set', async () => {
    const t = await newTenant()
    const all = await get(t.admin, '/settings')
    expect(all.body.items.map((s: any) => [s.section, s.version, s.value])).toEqual([['general', 0, null], ['retention', 0, null], ['limits', 0, null], ['pool', 0, null], ['notifications', 0, null]])
    expect((await get(t.admin, '/settings/general')).body.effective).toEqual({ agentsMayApply: false, proposalTtlDays: 30 })
    expect((await get(t.admin, '/settings/retention')).body.effective).toEqual({ metric_samples_days: 30 })
    expect((await get(t.admin, '/settings/nope')).status).toBe(404)
    for (const k of ['retention', 'limits', 'pool']) expect(await kvGet(`${k}:${t.tenant}`)).toBeNull()
  })

  it('retention: per signal and tier, published as retention:<tenant>; shortening has to be confirmed', async () => {
    const t = await newTenant()
    // Logs 14 days and traces 7 are shorter than the 30 days the janitor keeps without a record
    // (review B-1: judged on what the readers keep, not on the fields the old value names).
    const unconfirmed = await put(t.admin, 'retention', { value: { metric_samples_days: 45, metric_5m_days: 180, metric_1h_days: 730, log_days: 14, trace_days: 7 } })
    expect(unconfirmed.body).toMatchObject({ code: 'confirmation-required', shortened: ['log_days', 'trace_days'] })
    expect(await kvGet(`retention:${t.tenant}`)).toBeNull()
    const r1 = await put(t.admin, 'retention', { value: { metric_samples_days: 45, metric_5m_days: 180, metric_1h_days: 730, log_days: 14, trace_days: 7 }, confirmShorter: true })
    expect(r1.status, r1.text).toBe(200)
    expect(r1.body).toMatchObject({ outcome: 'applied', version: 1, kv: 'published', publishedTo: 'retention:<tenant>' })
    expect(await kvGet(`retention:${t.tenant}`)).toEqual({ metric_samples_days: 45, metric_5m_days: 180, metric_1h_days: 730, log_days: 14, trace_days: 7 })

    for (const value of [{}, { metric_samples_days: 0 }, { metric_samples_days: 1.5 }, { metric_samples_days: '30' }, { metric_samples_days: 30, metrics_days: 3 }, { metric_samples_days: 90, metric_5m_days: 30 }, { metric_samples_days: 30, metric_5m_days: 400, metric_1h_days: 300 }, { metric_samples_days: 4000 }]) {
      const res = await put(t.admin, 'retention', { value, confirmShorter: true })
      expect(res.status, JSON.stringify(value)).toBe(422)
      expect(res.body.fix).toBeTruthy()
    }
    expect((await put(t.admin, 'retention', { value: [] })).status).toBe(422)

    const shorter = await put(t.admin, 'retention', { value: { metric_samples_days: 7, metric_5m_days: 180, metric_1h_days: 730, log_days: 14, trace_days: 7 } })
    expect(shorter.status).toBe(422)
    expect(shorter.body).toMatchObject({ code: 'confirmation-required', shortened: ['metric_samples_days'] })
    expect((await kvGet(`retention:${t.tenant}`)).metric_samples_days).toBe(45)
    const confirmed = await put(t.admin, 'retention', { value: { metric_samples_days: 7, metric_5m_days: 180, metric_1h_days: 730, log_days: 14, trace_days: 7 }, confirmShorter: true })
    expect(confirmed.body).toMatchObject({ outcome: 'applied', version: 2 })
    expect((await kvGet(`retention:${t.tenant}`)).metric_samples_days).toBe(7)
    // unchanged: no new version, no audit entry
    const same = await put(t.admin, 'retention', { value: { metric_samples_days: 7, metric_5m_days: 180, metric_1h_days: 730, log_days: 14, trace_days: 7 } })
    expect(same.body).toMatchObject({ outcome: 'unchanged', version: 2 })
    // the first setting below the 30-day default is a shortening too
    const t2 = await newTenant()
    expect((await put(t2.admin, 'retention', { value: { metric_samples_days: 3 } })).body.code).toBe('confirmation-required')

    const audit = await auditOf(t.admin, '&action=settings.retention')
    expect(audit).toHaveLength(2)
    expect(audit[0]).toMatchObject({ by: { subject: `key:${t.adminId}`, kind: 'key' }, target: { type: 'setting', id: 'retention' }, before: { version: 1, value: { metric_samples_days: 45 } }, after: { version: 2, value: { metric_samples_days: 7 } } })
    expect(audit[1]).toMatchObject({ before: { version: 0, value: null }, after: { version: 1 } })
  })

  // Review B-1 (design/reviews/signals-end-to-end.md): a PUT replaces the value, so a field left
  // out returns to its reader's default; when that is shorter, it is a shortening like any other.
  // The oracle is the janitor's own reader of the published record (`readRetention`).
  it('retention: a field left out returns to its default, and a shorter default needs confirmShorter (review B-1)', async () => {
    const t = await newTenant()
    expect((await put(t.admin, 'retention', { value: { metric_samples_days: 30, trace_days: 365, log_days: 400 } })).status).toBe(200)
    expect(await janitorKeeps(t.tenant)).toEqual({ metric_samples_days: 30, trace_days: 365, log_days: 400 })

    // The review's scenario: raising metric retention, naming nothing else.
    for (const dryRun of [true, false]) {
      const res = await put(t.admin, 'retention', { value: { metric_samples_days: 60 }, dryRun })
      expect(res.status, res.text).toBe(422)
      expect(res.body).toMatchObject({ code: 'confirmation-required', shortened: ['log_days', 'trace_days'], leftOut: ['log_days', 'trace_days'] })
      expect(res.body.detail).toContain('trace_days: 365 → 30 (left out: the default)')
      expect(res.body.fix).toContain('replaces the whole value')
    }
    expect(await kvGet(`retention:${t.tenant}`)).toEqual({ metric_samples_days: 30, trace_days: 365, log_days: 400 })
    expect(await janitorKeeps(t.tenant)).toEqual({ metric_samples_days: 30, trace_days: 365, log_days: 400 })
    expect((await get(t.admin, '/settings/retention')).body.version).toBe(1)

    // Sending every field keeps them; a longer metric retention needs no confirmation.
    expect((await put(t.admin, 'retention', { value: { metric_samples_days: 60, trace_days: 365, log_days: 400 } })).body).toMatchObject({ outcome: 'applied', version: 2 })
    expect(await janitorKeeps(t.tenant)).toEqual({ metric_samples_days: 60, trace_days: 365, log_days: 400 })
    // Dropping one field to its default is refused for that field only.
    expect((await put(t.admin, 'retention', { value: { metric_samples_days: 60, trace_days: 365 } })).body).toMatchObject({ code: 'confirmation-required', shortened: ['log_days'] })
    // A rollup tier that was set and is left out: nothing says what its reader would keep, so it counts as shortened.
    expect((await put(t.admin, 'retention', { value: { metric_samples_days: 60, metric_5m_days: 90, trace_days: 365, log_days: 400 } })).status).toBe(200)
    const tier = await put(t.admin, 'retention', { value: { metric_samples_days: 60, trace_days: 365, log_days: 400 } })
    expect(tier.body).toMatchObject({ code: 'confirmation-required', shortened: ['metric_5m_days'], leftOut: ['metric_5m_days'] })
    expect(tier.body.detail).toContain('metric_5m_days: 90 → not set')
    // Confirmed, the replace goes through and the janitor then keeps spans and logs its default.
    expect((await put(t.admin, 'retention', { value: { metric_samples_days: 60 }, confirmShorter: true })).body).toMatchObject({ outcome: 'applied', version: 4 })
    expect(await janitorKeeps(t.tenant)).toEqual({ metric_samples_days: 60, trace_days: DEFAULT_SIGNAL_DAYS, log_days: DEFAULT_SIGNAL_DAYS })

    // A signal set for the first time below the default is a shortening too; at or above it, not.
    const t2 = await newTenant()
    expect((await put(t2.admin, 'retention', { value: { metric_samples_days: 30, trace_days: DEFAULT_SIGNAL_DAYS - 1 } })).body).toMatchObject({ code: 'confirmation-required', shortened: ['trace_days'] })
    expect((await put(t2.admin, 'retention', { value: { metric_samples_days: 45 } })).status).toBe(200)
    expect((await put(t2.admin, 'retention', { value: { metric_samples_days: 45, log_days: DEFAULT_SIGNAL_DAYS - 1 } })).body).toMatchObject({ code: 'confirmation-required', shortened: ['log_days'] })
    expect((await put(t2.admin, 'retention', { value: { metric_samples_days: 45, trace_days: DEFAULT_SIGNAL_DAYS, log_days: DEFAULT_SIGNAL_DAYS + 1 } })).status).toBe(200)
  })

  // The same property over random sequences of PUTs, judged by the janitor's own parser, with
  // values on both sides of the janitor's default: control and the janitor cannot drift apart.
  it('retention: no PUT without confirmShorter shortens what the janitor keeps, and every refusal names exactly the fields it would shorten', async () => {
    const D = DEFAULT_SIGNAL_DAYS
    const days = fc.constantFrom(1, D - 1, D, D + 1, 400)
    const step = fc.record({
      metric_samples_days: days,
      trace_days: fc.option(days, { nil: undefined }),
      log_days: fc.option(days, { nil: undefined }),
      metric_5m_days: fc.option(fc.constantFrom(400, 500), { nil: undefined }),
      confirm: fc.boolean(),
    })
    const seen = { applied: 0, refused: 0, confirmed: 0 }
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 6 }), async (steps) => {
        const t = await newTenant('ret')
        for (const { confirm, ...raw } of steps) {
          const value = Object.fromEntries(Object.entries(raw).filter(([, x]) => x !== undefined))
          const before = await janitorKeeps(t.tenant)
          const stored = await kvGet(`retention:${t.tenant}`)
          const parsed = parseRetention(JSON.stringify(value))
          if (parsed.status !== 'ok') throw new Error(`the janitor cannot read ${JSON.stringify(value)}`)
          const after = parsed.policy
          const shortens = JANITOR_FIELDS.filter((k) => after[k]! < before[k]!)
          const res = await put(t.admin, 'retention', { value, ...(confirm ? { confirmShorter: true } : {}) })
          if (res.status === 200) {
            expect(await janitorKeeps(t.tenant)).toEqual(after)
            // The safety property: nothing the janitor keeps is shortened without the confirmation.
            if (!confirm) expect(shortens, `${JSON.stringify(stored)} → ${JSON.stringify(value)}`).toEqual([])
            if (confirm) seen.confirmed++
            else seen.applied++
          } else {
            expect(res.status, res.text).toBe(422)
            expect(res.body.code).toBe('confirmation-required')
            expect(confirm).toBe(false)
            // Exactly the janitor's shortened fields, plus a rollup tier left out; nothing stored.
            expect((res.body.shortened as string[]).filter((k) => k !== 'metric_5m_days'), `${JSON.stringify(stored)} → ${JSON.stringify(value)}`).toEqual([...shortens].sort((a, b) => ['metric_samples_days', 'log_days', 'trace_days'].indexOf(a) - ['metric_samples_days', 'log_days', 'trace_days'].indexOf(b)))
            if (shortens.length === 0) expect(res.body.shortened).toEqual(['metric_5m_days'])
            expect(await kvGet(`retention:${t.tenant}`)).toEqual(stored)
            seen.refused++
          }
        }
      }),
      { numRuns: 60, seed: 4242 },
    )
    // Not vacuous: each outcome happened.
    expect(seen.applied).toBeGreaterThan(10)
    expect(seen.refused).toBeGreaterThan(10)
    expect(seen.confirmed).toBeGreaterThan(10)
  })

  it('limits: published as limits:<tenant>; versioned with an optional precondition; operator ceilings hold', async () => {
    const t = await newTenant()
    const r = await put(t.admin, 'limits', { value: { active_series: 250_000, samples_per_second: 50_000, query_max_series: 100_000, query_timeout_seconds: 60 }, version: 0 })
    expect(r.status, r.text).toBe(200)
    expect(await kvGet(`limits:${t.tenant}`)).toEqual({ active_series: 250_000, samples_per_second: 50_000, query_max_series: 100_000, query_timeout_seconds: 60 })
    for (const value of [{}, { active_series: 0 }, { active_series: -1 }, { active_series: 2e9 }, { active_series: 1, burst: 2 }, { query_timeout_seconds: 601 }]) expect((await put(t.admin, 'limits', { value })).status, JSON.stringify(value)).toBe(422)

    const stale = await put(t.admin, 'limits', { value: { active_series: 1 }, version: 0 })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ code: 'stale-version', currentVersion: 1 })
    expect((await put(t.admin, 'limits', { value: { active_series: 300_000 }, version: 1 })).body.version).toBe(2)
    expect(await kvGet(`limits:${t.tenant}`)).toEqual({ active_series: 300_000 })

    const dry = await put(t.admin, 'limits', { value: { active_series: 9 }, dryRun: true })
    expect(dry.body).toMatchObject({ dryRun: true, version: 3, value: { active_series: 9 } })
    expect((await get(t.admin, '/settings/limits')).body).toMatchObject({ version: 2, value: { active_series: 300_000 } })
    expect(await kvGet(`limits:${t.tenant}`)).toEqual({ active_series: 300_000 })

    await runInDurableObject(stubOf(t.tenant), (i) => void Object.defineProperty(i, 'limitCeilings', { get: () => ({ active_series: 500_000 }) }))
    const over = await put(t.admin, 'limits', { value: { active_series: 500_001 } })
    expect(over.status).toBe(422)
    expect(over.body.ceiling).toBe(500_000)
    expect((await put(t.admin, 'limits', { value: { active_series: 500_000 } })).status).toBe(200)
  })

  it('pool map: the first map and a larger spread bump the epoch and publish a PoolMap; everything else is refused', async () => {
    const t = await newTenant()
    const mine = `tenant/${t.tenant}`
    for (const value of [{ pool: mine, slots: 4 }, { pool: mine, slots: 4, spread: 5 }, { pool: mine, slots: 0, spread: 1 }, { pool: mine, slots: 4, spread: 2, epoch: 9 }, { pool: 'tenant/someone-else', slots: 4, spread: 2 }, { pool: 'shared/c1', slots: 16, spread: 2 }, { pool: 7, slots: 4, spread: 2 }]) {
      const res = await put(t.admin, 'pool', { value })
      expect(res.status, JSON.stringify(value)).toBe(422)
    }
    expect(await kvGet(`pool:${t.tenant}`)).toBeNull()

    const first = await put(t.admin, 'pool', { value: { pool: mine, slots: 4, spread: 2 } })
    expect(first.status, first.text).toBe(200)
    // the shared map (DEFAULT_POOL) is at epoch 1, so the tenant's first own map is epoch 2
    expect(first.body.value).toEqual({ pool: mine, slots: 4, spread: 2, epoch: 2 })
    const published = await kvGet(`pool:${t.tenant}`)
    expect(published).toEqual({ pool: mine, slots: 4, spread: 2, epoch: 2 })
    // it is a PoolMap the shard's routing accepts
    expect(tenantSlots(published, t.tenant)).toHaveLength(2)
    expect(slotFor(published, t.tenant, 'job=a\u0000instance=b')).toBeGreaterThanOrEqual(0)

    const same = await put(t.admin, 'pool', { value: { pool: mine, slots: 4, spread: 2 } })
    expect(same.body).toMatchObject({ outcome: 'unchanged', value: { epoch: 2 } })

    const wider = await put(t.admin, 'pool', { value: { pool: mine, slots: 4, spread: 3 } })
    expect(wider.body.value).toEqual({ pool: mine, slots: 4, spread: 3, epoch: 3 })
    expect(await kvGet(`pool:${t.tenant}`)).toEqual({ pool: mine, slots: 4, spread: 3, epoch: 3 })

    for (const value of [{ pool: mine, slots: 4, spread: 2 }, { pool: mine, slots: 8, spread: 3 }, { pool: mine, slots: 3, spread: 3 }, { pool: 'shared/c1', slots: 8, spread: 3 }]) {
      const res = await put(t.admin, 'pool', { value })
      expect(res.status, JSON.stringify(value)).toBe(409)
      expect(res.body.code).toBe('pool-change-unsupported')
      expect(res.body.detail).toContain('drain-and-handover')
      expect(res.body.current).toEqual({ pool: mine, slots: 4, spread: 3, epoch: 3 })
    }
    expect(await kvGet(`pool:${t.tenant}`)).toEqual({ pool: mine, slots: 4, spread: 3, epoch: 3 })
    expect((await auditOf(t.admin, '&action=settings.pool')).map((a) => a.after.value.epoch)).toEqual([3, 2])

    // a tenant may also take a larger share of the shared pool
    const t2 = await newTenant()
    expect((await put(t2.admin, 'pool', { value: { pool: 'shared/c1', slots: 8, spread: 4 } })).body.value).toEqual({ pool: 'shared/c1', slots: 8, spread: 4, epoch: 2 })
  })

  // contracts/BATCH.md "Streams per signal", D66. The oracle is edge's own test of a pool map's
  // pool (`validBasePool`, shared with edge since review M-5) and edge's reader of the published
  // record (`poolMap`): control must never publish a map the data path refuses for this.
  it('pool map: a pool ending in /traces or /logs is refused, so tenants "traces" and "logs" keep the shared pool', async () => {
    for (const id of ['traces', 'logs']) {
      // The tenant id itself is allowed (TENANT_ID is unchanged).
      const { key } = await stubOf(id).provision(id)
      const mine = `tenant/${id}`
      expect(validBasePool(mine)).toBe(false)
      for (const dryRun of [true, false]) {
        const res = await put(key, 'pool', { value: { pool: mine, slots: 4, spread: 2 }, dryRun })
        expect(res.status, res.text).toBe(422)
        expect(res.body).toMatchObject({ code: 'invalid', field: 'pool' })
        expect(res.body.detail).toContain(`ends in "/${id}"`)
      }
      expect(await kvGet(`pool:${id}`)).toBeNull()
      expect((await get(key, '/settings/pool')).body.version).toBe(0)
      expect(await auditOf(key, '&action=settings.pool')).toEqual([])
      // The shared pool is still theirs, and edge accepts that map.
      const shared = await put(key, 'pool', { value: { pool: 'shared/c1', slots: 8, spread: 4 } })
      expect(shared.status, shared.text).toBe(200)
      expect(await kvGet(`pool:${id}`)).toEqual({ pool: 'shared/c1', slots: 8, spread: 4, epoch: 2 })
      expect(validBasePool((await kvGet(`pool:${id}`)).pool)).toBe(true)
      expect(await edgeRoutes(id)).toEqual({ routes: true, map: { pool: 'shared/c1', slots: 8, spread: 4, epoch: 2 } })
    }
    // Ids that only resemble them keep their dedicated pool, and edge accepts each map published.
    for (const id of ['Traces', 'xlogs', 'traces-1', 'logs-traces-x']) {
      const { key } = await stubOf(id).provision(id)
      const res = await put(key, 'pool', { value: { pool: `tenant/${id}`, slots: 4, spread: 2 } })
      expect(res.status, `${id}: ${res.text}`).toBe(200)
      const published = await kvGet(`pool:${id}`)
      expect(published).toEqual({ pool: `tenant/${id}`, slots: 4, spread: 2, epoch: 2 })
      expect(validBasePool(published.pool)).toBe(true)
      expect(await edgeRoutes(id)).toEqual({ routes: true, map: published })
    }
  })

  // Review M-5: control checks the whole of edge's base-pool rule (one function, `validBasePool`),
  // and the dedicated pool it accepts and suggests is `dedicatedPool(tenant)`: `tenant/<id>` with
  // `_` written `-`. Both directions, with edge's own reader as the oracle.
  it('pool map: the dedicated pool is dedicatedPool(tenant); control publishes exactly the maps edge routes on (review M-5)', async () => {
    // (Ids `traces` and `logs`, whose dedicatedPool breaks the rule, are the test above.)
    const ids = ['acme_prod', 'acme-prod', '_x', 'x_', 'a__b', 'Plain', `${'a_'.repeat(31)}zz`, 'my_traces', 'logs_', 'x_traces']
    for (const id of ids) {
      const { key } = await stubOf(id).provision(id)
      const own = dedicatedPool(id, 4, 0).pool
      expect(own).toBe(`tenant/${id.replaceAll('_', '-')}`)
      // The id verbatim, when it has `_`: refused, naming the pool to use; edge would refuse it too.
      if (id.includes('_')) {
        const verbatim = await put(key, 'pool', { value: { pool: `tenant/${id}`, slots: 4, spread: 2 } })
        expect(verbatim.status, verbatim.text).toBe(422)
        expect(verbatim.body).toMatchObject({ code: 'invalid', field: 'pool' })
        expect(verbatim.body.detail).toContain(`dedicated pool is "${own}"`)
        expect(validBasePool(`tenant/${id}`)).toBe(false)
      }
      // dedicatedPool(id) is accepted, and edge routes on the map published.
      expect(validBasePool(own)).toBe(true)
      const res = await put(key, 'pool', { value: { pool: own, slots: 4, spread: 2 } })
      expect(res.status, `${id}: ${res.text}`).toBe(200)
      expect(await kvGet(`pool:${id}`)).toEqual({ pool: own, slots: 4, spread: 2, epoch: 2 })
      expect(await edgeRoutes(id)).toEqual({ routes: true, map: { pool: own, slots: 4, spread: 2, epoch: 2 } })
    }
    // Two ids that differ only in `_` and `-` share the dedicated pool's objects (D38), each with a map of its own.
    expect((await kvGet('pool:acme_prod')).pool).toBe((await kvGet('pool:acme-prod')).pool)

    // The shared pool is checked by the same rule: a DEFAULT_POOL outside POOL_NAME, or ending in a
    // derived suffix, is refused here, and edge refuses it too (for every tenant, as DEFAULT_POOL).
    for (const bad of ['shared/c_1', 'shared/logs', `shared/${'c'.repeat(120)}`]) {
      const t = await newTenant()
      await runInDurableObject(stubOf(t.tenant), (i) => void Object.defineProperty(i, 'sharedPool', { get: () => ({ pool: bad, slots: 8, epoch: 1 }) }))
      const res = await put(t.admin, 'pool', { value: { pool: bad, slots: 8, spread: 2 } })
      expect(res.status, `${bad}: ${res.text}`).toBe(422)
      expect(res.body).toMatchObject({ code: 'invalid', field: 'pool' })
      expect(res.body.fix).toContain('DEFAULT_POOL')
      expect(await kvGet(`pool:${t.tenant}`)).toBeNull()
      expect(validBasePool(bad)).toBe(false)
      expect(await edgeRoutes(t.tenant, { pool: bad, slots: 8, spread: 8, epoch: 1 })).toEqual({ routes: false, status: 503 })
    }
  })

  it('general and notifications: validated, versioned, not published', async () => {
    const t = await newTenant()
    expect((await put(t.admin, 'general', { value: { agentsMayApply: 'yes' } })).status).toBe(422)
    expect((await put(t.admin, 'general', { value: { proposalTtlDays: 0 } })).status).toBe(422)
    expect((await put(t.admin, 'general', { value: { agentsCanApply: true } })).status).toBe(422)
    expect((await put(t.admin, 'general', { value: { agentsMayApply: true } })).body.value).toEqual({ agentsMayApply: true, proposalTtlDays: 30 })
    expect((await put(t.admin, 'notifications', { value: { email: ['oncall@example.com'], webhookUrl: 'https://hooks.example.com/x' } })).body).toMatchObject({ version: 1, publishedTo: null })
    for (const value of [{ email: 'a@b.c' }, { email: ['nope'] }, { webhookUrl: 'http://insecure.example.com' }, { webhookUrl: 'not a url' }, { sms: [] }]) expect((await put(t.admin, 'notifications', { value })).status, JSON.stringify(value)).toBe(422)
    expect((await put(t.admin, 'retention', { value: { metric_samples_days: 30 }, comment: 'x' })).status).toBe(422)
    // settings are for admins
    const k = await makeKey(t.admin, ['dashboards:read', 'dashboards:write', 'dashboards:apply', 'read', 'write'])
    for (const [m, p] of [['GET', '/settings'], ['GET', '/settings/limits'], ['PUT', '/settings/general'], ['GET', '/audit']] as const) expect((await call(k.key, m, p, m === 'PUT' ? { value: { agentsMayApply: true } } : undefined)).status).toBe(403)
  })
})

describe('audit log', () => {
  it('is complete: every mutating route, done once, leaves exactly one entry; reads, failures and dry runs leave none', async () => {
    const t = await newTenant()
    const done = new Set<string>()
    const expected: string[] = ['tenant.provision']
    const count = async () => (await auditOf(t.admin)).length
    /** Perform one mutation and require exactly one new entry with this action, by this actor. */
    async function once(op: string, action: string, method: string, path: string, body: unknown, key = t.admin): Promise<any> {
      const before = await count()
      const dry = await call(key, method, path, { ...(body as object), dryRun: true })
      expect(dry.status, `${op} dry: ${dry.text}`).toBeLessThan(300)
      expect(await count(), `${op}: a dry run was audited`).toBe(before)
      const res = await call(key, method, path, body)
      expect(res.status, `${op}: ${res.text}`).toBeLessThan(300)
      const after = await auditOf(t.admin)
      expect(after.length, `${op}: entries added`).toBe(before + 1)
      expect(after[0].action).toBe(action)
      expect(Date.parse(after[0].at)).toBeGreaterThan(Date.now() - 60_000)
      done.add(op)
      expected.unshift(action)
      return res.body
    }
    const spec = example('service_red', 'red')
    const p0 = Object.keys(spec.panels)[0]
    const title = (v: string) => [{ op: 'replace', path: `/panels/${p0}/title`, value: v }]

    const k = await once('keys.create', 'key.create', 'POST', '/keys', { name: 'k', scopes: ['admin', 'dashboards:write'] })
    await once('keys.disable', 'key.disable', 'POST', `/keys/${k.key.id}/disable`, {})
    await once('keys.enable', 'key.enable', 'POST', `/keys/${k.key.id}/enable`, {})
    await once('keys.rotate', 'key.rotate', 'POST', `/keys/${k.key.id}/rotate`, {})
    await once('keys.delete', 'key.delete', 'DELETE', `/keys/${k.key.id}`, { confirmName: 'k' })
    const d = await once('dashboards.create', 'dashboard.create', 'POST', '/dashboards', { spec })
    const p = await once('dashboards.patch', 'dashboard.patch', 'PATCH', '/dashboards/red', { ops: title('one'), baseRevision: d.revision })
    await once('dashboards.setOwner', 'dashboard.owner', 'PUT', '/dashboards/red/owner', { owner: 'payments' })
    const rv = await once('revisions.revert', 'dashboard.revert', 'POST', '/dashboards/red/revisions/1/revert', { baseRevision: p.revision })
    await once('dashboards.delete', 'dashboard.delete', 'DELETE', '/dashboards/red', {})
    await once('dashboards.restore', 'dashboard.restore', 'POST', '/dashboards/red/restore', {})
    const pr = await once('proposals.create', 'proposal.create', 'POST', '/dashboards/red/proposals', { message: 'm', baseRevision: rv.revision, ops: title('two') })
    await once('proposals.edit', 'proposal.edit', 'PUT', `/proposals/${pr.proposal.id}`, { ops: title('three') })
    await once('proposals.apply', 'proposal.apply', 'POST', `/proposals/${pr.proposal.id}/apply`, {})
    const base = (await get(t.admin, '/dashboards/red')).body.revision
    const pr2 = (await post(t.admin, '/dashboards/red/proposals', { message: 'm', baseRevision: base, ops: title('four') })).body
    expected.unshift('proposal.create')
    await once('proposals.decline', 'proposal.decline', 'POST', `/proposals/${pr2.proposal.id}/decline`, { reason: 'no' })
    const cp = await once('proposals.createDashboard', 'proposal.create', 'POST', '/proposals', { spec: example('k8s_node_overview', 'nodes'), message: 'a new one' })
    await once('proposals.edit', 'proposal.edit', 'PUT', `/proposals/${cp.proposal.id}`, { spec: { ...example('k8s_node_overview', 'nodes'), metadata: { ...example('k8s_node_overview', 'nodes').metadata, title: 'Nodes' } } })
    await once('proposals.apply', 'proposal.apply', 'POST', `/proposals/${cp.proposal.id}/apply`, {})
    await once('settings.put', 'settings.general', 'PUT', '/settings/general', { value: { proposalTtlDays: 10 } })
    // OAuth: approving a client is one entry; revoking the grant is one entry (its key goes with it, in the same entry)
    const { challenge } = await pkce()
    const handle = (await authorize(await newClient(), challenge, { scope: 'dashboards:read' })).handle!
    const ap = await once('oauth.approve', 'oauth.grant.approve', 'POST', '/oauth/approve', { request: handle })
    await once('oauth.grants.revoke', 'oauth.grant.revoke', 'POST', `/oauth/grants/${ap.grant.id}/revoke`, {})

    // every mutating route of the API was exercised above
    expect([...done].sort()).toEqual(ROUTES.filter((r) => r.mutation).map((r) => r.op).sort())

    // reads, refusals and no-ops add nothing
    const before = await count()
    for (const r of ROUTES.filter((x) => !x.mutation)) await get(t.admin, r.path.replace('{dashboard}', 'red').replace('{number}', '1').replace('{proposal}', pr.proposal.id).replace('{key}', t.adminId).replace('{section}', 'limits').replace('{entry}', 'a_x').replace('{grant}', ap.grant.id))
    await call(t.admin, 'PATCH', '/dashboards/red', { ops: title('x'), baseRevision: 'f'.repeat(32) }) // 409
    await post(t.admin, '/dashboards', { spec: { nope: true } }) // 422
    await post(t.admin, '/keys', { name: 'bad', scopes: ['root'] }) // 422
    await post(t.admin, '/proposals', { spec: example('k8s_node_overview', 'nodes'), message: 'again' }) // 409: the id is taken now
    await post(t.admin, `/proposals/${cp.proposal.id}/apply`, {}) // 409: applied already
    await call(t.admin, 'PUT', '/settings/general', { value: { proposalTtlDays: 10 } }) // unchanged
    await call(t.admin, 'PATCH', '/dashboards/red', { ops: [{ op: 'test', path: '/metadata/id', value: 'red' }], baseRevision: base }) // unchanged
    await post(null, '/keys', { name: 'anon', scopes: ['admin'] }) // 401
    await post(t.admin, `/oauth/grants/${ap.grant.id}/revoke`, {}) // unchanged: already revoked
    await post(t.admin, '/oauth/approve', { request: handle, scopes: ['read'] }) // 422: not asked for
    await post(t.admin, '/oauth/approve', { request: 'nope' }) // 422
    expect(await count()).toBe(before)

    // the log is exactly the list of what was done, newest first
    const log = await auditOf(t.admin)
    expect(log.map((a) => a.action)).toEqual(expected)
    expect(new Set(log.map((a) => a.id)).size).toBe(log.length)
    for (const a of log.slice(0, -1)) expect(a.by).toEqual({ subject: `key:${t.adminId}`, kind: 'key', name: 'first admin key' })
  })

  it('is queryable by action, target, actor and time, pages with a cursor, and each entry can be fetched', async () => {
    const t = await newTenant()
    const agent = await makeKey(t.admin, ['dashboards:read', 'dashboards:write'], { kind: 'agent', name: 'bot' })
    const d = (await post(t.admin, '/dashboards', { spec: example('service_red', 'red') })).body
    const p0 = Object.keys(example().panels)[0]
    await call(agent.key, 'PATCH', '/dashboards/red', { ops: [{ op: 'replace', path: `/panels/${p0}/title`, value: 'bot' }], baseRevision: d.revision })
    for (let i = 0; i < 5; i++) await call(t.admin, 'PUT', '/dashboards/red/owner', { owner: `team-${i}` })

    const q = async (qs: string) => (await get(t.admin, `/audit?${qs}`)).body.items
    expect((await q('action=dashboard.owner')).length).toBe(5)
    expect((await q('kind=agent')).map((a: any) => a.action)).toEqual(['proposal.create'])
    expect((await q(`subject=key:${agent.id}`)).length).toBe(1)
    expect((await q('targetType=dashboard&targetId=red')).length).toBe(6)
    expect((await q('targetType=key')).length).toBe(1)
    expect((await q('since=2999-01-01T00:00:00Z')).length).toBe(0)
    expect((await q(`until=${new Date(Date.now() + 60_000).toISOString()}&since=${new Date(Date.now() - 60_000).toISOString()}`)).length).toBe(9)
    expect((await get(t.admin, '/audit?since=yesterday')).status).toBe(400)
    // before/after of a change
    expect((await q('action=dashboard.owner'))[0]).toMatchObject({ before: { owner: 'team-3' }, after: { owner: 'team-4' } })

    const all = await auditOf(t.admin)
    const paged: any[] = []
    let cursor: string | null = null
    do {
      const res: any = await get(t.admin, `/audit?limit=4${cursor ? `&cursor=${cursor}` : ''}`)
      paged.push(...res.body.items)
      cursor = res.body.next
    } while (cursor)
    expect(paged).toEqual(all)
    const one = await get(t.admin, `/audit/${all[3].id}`)
    expect(one.body).toEqual(all[3])
    expect((await get(t.admin, '/audit/a_doesnotexist')).status).toBe(404)
  })

  it('cannot be altered: no route writes to it, and SQLite itself refuses UPDATE and DELETE', async () => {
    const t = await newTenant()
    await makeKey(t.admin, ['read'])
    const log = await auditOf(t.admin)
    const id = log[0].id
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/audit', `/audit/${id}`]) {
        const res = await call(t.admin, method, path, { action: 'nothing.happened', dryRun: false })
        expect(res.status, `${method} ${path}`).toBe(405)
        expect(res.headers.get('Allow')).toBe('GET')
      }
    }
    // the only audit routes are reads
    expect(ROUTES.filter((r) => r.path.startsWith('/audit')).map((r) => [r.method, r.mutation])).toEqual([['GET', false], ['GET', false]])
    // even code inside the object cannot rewrite history
    const attempts = await runInDurableObject(stubOf(t.tenant), (_i, s) => {
      const errors: string[] = []
      for (const sql of ["UPDATE audit SET action = 'forged'", 'DELETE FROM audit', "UPDATE audit SET at = 0 WHERE id = '" + id + "'"]) {
        try {
          s.storage.sql.exec(sql)
          errors.push('no error')
        } catch (e) {
          errors.push(String((e as Error).message))
        }
      }
      return errors
    })
    expect(attempts).toHaveLength(3)
    for (const e of attempts) expect(e).toContain('append-only')
    expect(await auditOf(t.admin)).toEqual(log)
  })
})
