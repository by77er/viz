/**
 * The production wiring (README, "Deployment"): rules evaluated through viz-query's HTTP API,
 * recorded series written through Remote Write, both with the shard's service key from the
 * tenant's control plane; notifications sent to the destination set in control. The callees
 * are fakes behind real service bindings (`FakeQuery`, `FakeIngest` in test/harness.ts) that
 * check the presented key with edge's real `authenticate` and take the tenant from it; the
 * control plane is control's real `Tenant` object.
 *
 * Properties held here:
 *   - tenant isolation: every engine and ingest call a tenant's ruler makes carries a key whose
 *     tenant is that tenant; each tenant's alerts reach only its own destination;
 *   - no secret in logs, bodies or answers: the service key, the webhook secret and a
 *     credential in the webhook URL appear in no API answer, no notification body, no stored
 *     error and no console output;
 *   - delivery is at least once with one idempotency key per notification, the same bytes on
 *     every attempt, and one processed notification at a de-duplicating receiver;
 *   - one engine call in flight per Ruler object (the six-connection budget).
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAuthCache } from '../../edge/src/auth'
import type { Identity } from '../../control/src/identity'
import type { OpName } from '../../control/src/routes'
import worker, { health } from '../src/index'
import { PROPAGATION_GRACE_MS, REISSUE_MIN_INTERVAL_MS } from '../src/credential'
import { CONTROL_REFRESH_MS } from '../src/notifier'
import { verifySignature } from '../src/signature'
import { apiKey, call } from './api'
import { services, tenantWorld, T0, world, type HttpCall } from './harness'
import { MIN, newTenant, notifierStub, ok, rulerStub, runNotifierUntil, vec } from './helpers'

const SECRET = 'whsec-wiring-0123456789-SECRET'
const HOOK = 'https://hooks.receiver.test/alerts/T0K3N-in-path?token=Q5ecret'

/** A tenant provisioned in control, with an admin identity to change its settings and keys. */
async function provisioned(prefix: string) {
  const tenant = newTenant(prefix)
  const control = env.TENANT.get(env.TENANT.idFromName(tenant))
  const { key } = await control.provision(tenant)
  const keyId = /^viz_([A-Za-z0-9]+)_/.exec(key)![1]!
  const admin: Identity = { tenant, subject: 'key:admin', kind: 'key', scopes: ['admin'], keyId }
  const invoke = async (op: OpName, input: { params?: Record<string, string>; query?: Record<string, string[]>; body?: unknown }) =>
    (await control.invoke(admin, op, { params: {}, query: {}, body: null, ...input })) as unknown as { status: number; body: any }
  const w = tenantWorld(tenant)
  w.http = true
  const monitors = await apiKey(tenant)
  const ruler = rulerStub(tenant)
  ok(await ruler.configure(tenant, { deadman: false }))
  return { tenant, control, invoke, w, monitors, ruler, notifier: notifierStub(tenant) }
}

type Scene = Awaited<ReturnType<typeof provisioned>>

/** The ruler's next alarm, then everything the notifier has due by then. */
async function tick(s: Scene): Promise<number> {
  const h = ok(await s.ruler.health(s.tenant))
  world.now = Math.max(h.alarmAtMs as number, world.now)
  expect(await runDurableObjectAlarm(s.ruler)).toBe(true)
  await runNotifierUntil(s.notifier, s.tenant, world.now)
  return world.now
}

/** The service keys control holds for a tenant, by name. */
async function serviceKeys(s: Scene): Promise<{ name: string; prefix: string; disabled: boolean; id: string }[]> {
  const r = await s.invoke('keys.list', { query: { limit: ['200'] } })
  return r.body.items.filter((k: { name: string }) => k.name.startsWith('service:'))
}

const callsFor = (tenantKeyPrefix: string) => services.calls.filter((c) => c.authorization?.startsWith(`Bearer ${tenantKeyPrefix}`))

let logged: string[] = []
beforeEach(() => {
  world.now = T0
  services.calls = []
  services.inFlight = 0
  services.maxInFlight = 0
  services.delayMs = 0
  services.fail = []
  logged = []
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
})
afterEach(() => {
  vi.restoreAllMocks()
})

const THRESHOLD = { name: 'checkout errors', query: 'sum(rate(errors_total{service="checkout"}[5m]))', condition: { op: '>', threshold: 5 }, for: '0s', interval: '1m', message: 'errors at {{ $value }}' }

describe('rule evaluation through the query API, with a service key from control', () => {
  it('evaluates every tick with ONE key, issued by control for this tenant and shard, at the tick time', async () => {
    const s = await provisioned('wire')
    s.w.evaluate = () => vec([{ service: 'checkout' }, 9])
    const created = await call(s.monitors.auth, 'POST', '/api/v1/monitors', THRESHOLD)
    expect(created.status, created.text).toBe(201)
    const t1 = await tick(s)
    const t2 = await tick(s)
    const keys = await serviceKeys(s)
    expect(keys.map((k) => [k.name, k.disabled])).toEqual([['service:viz-ruler/0', false]])
    const queries = services.calls.filter((c) => c.path === '/api/v1/query')
    expect(queries.length).toBeGreaterThanOrEqual(2)
    for (const c of queries) {
      expect(c.tenant).toBe(s.tenant)
      expect(c.authorization).toMatch(new RegExp(`^Bearer ${keys[0]!.prefix}_`))
    }
    expect(queries.map((c) => Math.round(Number(c.params.time) * 1000))).toEqual(expect.arrayContaining([t1, t2]))
    const rules = ok(await s.ruler.rules(s.tenant)).rules
    expect(rules.map((r) => [r.health, r.lastError])).toEqual([['ok', null]])
    expect(rules[0]!.alerts.map((a) => [a.state, a.value])).toEqual([['firing', 9]])
    // Saving validated the expression through /api/v1/plan with the same key.
    expect(services.calls.some((c) => c.path === '/api/v1/plan' && c.tenant === s.tenant)).toBe(true)
  })

  it('tenant isolation: two tenants in one isolate each read only their own data, each with its own key', async () => {
    const a = await provisioned('iso-a')
    const b = await provisioned('iso-b')
    a.w.evaluate = () => vec([{ service: 'checkout', who: 'A' }, 7])
    b.w.evaluate = () => vec([{ service: 'checkout', who: 'B' }, 8])
    for (const s of [a, b]) expect((await call(s.monitors.auth, 'POST', '/api/v1/monitors', THRESHOLD)).status).toBe(201)
    for (let i = 0; i < 2; i++) for (const s of [a, b]) await tick(s)
    const [ka] = await serviceKeys(a)
    const [kb] = await serviceKeys(b)
    expect(callsFor(ka!.prefix).length).toBeGreaterThan(0)
    expect(callsFor(kb!.prefix).length).toBeGreaterThan(0)
    for (const c of callsFor(ka!.prefix)) expect(c.tenant).toBe(a.tenant)
    for (const c of callsFor(kb!.prefix)) expect(c.tenant).toBe(b.tenant)
    expect(services.calls.every((c) => c.tenant === a.tenant || c.tenant === b.tenant)).toBe(true)
    const alertsOf = async (s: Scene) => ok(await s.ruler.rules(s.tenant)).rules.flatMap((r) => r.alerts.map((x) => x.labels.who))
    expect(await alertsOf(a)).toEqual(['A'])
    expect(await alertsOf(b)).toEqual(['B'])
  })

  it('a refused key is kept while KV may still be propagating, replaced after; a key a person disabled stops evaluation, and enabling it resumes', async () => {
    const s = await provisioned('rot')
    s.w.evaluate = () => vec([{ service: 'checkout' }, 1])
    expect((await call(s.monitors.auth, 'POST', '/api/v1/monitors', { ...THRESHOLD, interval: '20s' })).status).toBe(201)
    await tick(s)
    const [first] = await serviceKeys(s)
    // A person disables the ruler's key in the control plane.
    expect((await s.invoke('keys.disable', { params: { key: first!.id }, body: {} })).status).toBe(200)
    clearAuthCache()
    await tick(s)
    let rule = ok(await s.ruler.rules(s.tenant)).rules[0]!
    expect(rule.health).toBe('err')
    expect(rule.lastError).toMatch(/^unauthorized: /)
    expect((await serviceKeys(s))[0]!.prefix).toBe(first!.prefix) // still inside the grace: nothing asked
    // Evicted (what is in memory about earlier requests is gone): the key's stored age alone
    // keeps the ruler from asking control while KV may still be propagating.
    await evictDurableObject(s.ruler)
    await tick(s)
    await tick(s)
    rule = ok(await s.ruler.rules(s.tenant)).rules[0]!
    expect(rule.lastError, 'a refused key younger than the propagation grace is kept').toMatch(/^unauthorized: /)
    // Old enough that KV propagation is not the reason, and past the minimum interval between requests to control.
    world.now += Math.max(PROPAGATION_GRACE_MS, REISSUE_MIN_INTERVAL_MS)
    await tick(s)
    rule = ok(await s.ruler.rules(s.tenant)).rules[0]!
    expect(rule.lastError).toMatch(/disabled the ruler's service key \(service:viz-ruler\/0\)/)
    expect(await serviceKeys(s)).toHaveLength(1)
    // Enabled again: the next request to control (after the minimum interval) issues a new key.
    expect((await s.invoke('keys.enable', { params: { key: first!.id }, body: {} })).status).toBe(200)
    world.now += REISSUE_MIN_INTERVAL_MS
    await tick(s)
    rule = ok(await s.ruler.rules(s.tenant)).rules[0]!
    expect([rule.health, rule.lastError]).toEqual(['ok', null])
    const [second] = await serviceKeys(s)
    expect(second!.prefix).not.toBe(first!.prefix)
    const audit = await s.invoke('audit.list', { query: { action: ['key.service'], limit: ['200'] } })
    expect(audit.body.items).toHaveLength(2)
  })

  it('six connections: one engine call in flight per Ruler object, across groups due together', async () => {
    const s = await provisioned('gate')
    services.delayMs = 15
    s.w.evaluate = () => vec([{ service: 'checkout' }, 1])
    for (let g = 0; g < 4; g++) {
      const res = await call(s.monitors.auth, 'PUT', `/api/v1/monitors/groups/g${g}`, { interval: '1m', rules: [0, 1, 2].map((i) => ({ alert: `A${g}x${i}`, expr: `up{g="${g}",i="${i}"} > 0` })) })
      expect(res.status, res.text).toBe(200)
    }
    services.calls = []
    services.maxInFlight = 0
    // A late alarm: all four groups are due at once and run concurrently (maxConcurrentGroups 4).
    world.now = T0 + 3 * MIN
    expect(await runDurableObjectAlarm(s.ruler)).toBe(true)
    expect(services.calls.filter((c) => c.path === '/api/v1/query').length).toBe(12)
    expect(services.maxInFlight).toBe(1)
  })

  it('save-time validation through /api/v1/plan: a parse error refuses the save with the engine\'s message; an unreachable query service does not block it', async () => {
    const s = await provisioned('plan')
    const bad = await call(s.monitors.auth, 'POST', '/api/v1/monitors', { ...THRESHOLD, query: 'sum(syntax(x))' })
    expect(bad.status).toBe(422)
    expect(JSON.stringify(bad.json.problems)).toContain('parse error')
    services.fail = [503]
    const saved = await call(s.monitors.auth, 'POST', '/api/v1/monitors', THRESHOLD)
    expect(saved.status, saved.text).toBe(201)
  })

  it('recording rules write their series through Remote Write with the service key, at the tick time', async () => {
    const s = await provisioned('rec')
    s.w.evaluate = () => vec([{ job: 'api' }, 3.5], [{ job: 'web' }, '+Inf'])
    const res = await call(s.monitors.auth, 'PUT', '/api/v1/monitors/groups/rec', { interval: '1m', rules: [{ record: 'job:up:sum', expr: 'sum by (job) (up)' }] })
    expect(res.status, res.text).toBe(200)
    const t = await tick(s)
    const writes = services.calls.filter((c) => c.path === '/api/v1/write')
    expect(writes).toHaveLength(1)
    expect(writes[0]!.tenant).toBe(s.tenant)
    expect(writes[0]!.series!.map((x) => [x.labels, x.samples]).sort((p, q) => (JSON.stringify(p) < JSON.stringify(q) ? -1 : 1))).toEqual([
      [{ __name__: 'job:up:sum', job: 'api' }, [[t, 3.5]]],
      [{ __name__: 'job:up:sum', job: 'web' }, [[t, Infinity]]],
    ])
    expect(ok(await s.ruler.health(s.tenant)).samplesDropped).toBe(0)
  })

  it('backtests read through /api/v1/query_range', async () => {
    const s = await provisioned('bt')
    s.w.range = () => ({ resultType: 'matrix', result: [{ metric: { service: 'checkout' }, values: [[T0 / 1000 - 120, '9'], [T0 / 1000 - 60, '9']] }] })
    const res = await call(s.monitors.auth, 'POST', '/api/v1/monitors/backtest', { monitor: THRESHOLD, fromMs: T0 - 3 * MIN, toMs: T0, step: '1m' })
    expect(res.status, res.text).toBe(200)
    expect(services.calls.some((c) => c.path === '/api/v1/query_range' && c.tenant === s.tenant)).toBe(true)
  })

  it('warm-ups and backtests ask /api/v1/plan (start, end, step) for every read before any /api/v1/query_range; over budget nothing is fetched', async () => {
    const s = await provisioned('plan')
    const sli = { bad: 'sum(increase(errors_total[$window]))', total: 'sum(increase(requests_total[$window]))' }
    s.w.evaluate = () => vec([{ viz_slo_part: 'total' }, 100], [{ viz_slo_part: 'bad' }, 0])
    s.w.range = (_q, start, end, step) => {
      const values: [number, string][] = []
      for (let t = start; t <= end; t += step) values.push([t / 1000, '100'])
      return { resultType: 'matrix', result: [{ metric: { viz_slo_part: 'total' }, values }] }
    }
    const created = await call(s.monitors.auth, 'POST', '/api/v1/monitors', { name: 'Checkout availability', slo: { objective: 0.999, sli } })
    expect(created.status, created.text).toBe(201)
    const from = services.calls.length
    await tick(s)
    const mine = services.calls.slice(from).filter((c) => c.tenant === s.tenant)
    expect(mine.map((c) => c.path)).toEqual(['/api/v1/plan', '/api/v1/plan', '/api/v1/query_range', '/api/v1/query_range', '/api/v1/query'])
    // Each plan names the range it prices, as the query that follows reads it.
    expect(mine.slice(0, 2).map((c) => [c.params.start, c.params.end, c.params.step])).toEqual(mine.slice(2, 4).map((c) => [c.params.start, c.params.end, c.params.step]))
    expect(mine.slice(0, 2).map((c) => c.params.step)).toEqual(['60', '3600'])
    const m = (await call(s.monitors.auth, 'GET', `/api/v1/monitors/${created.json.id}`)).json.monitor
    expect(m.slo.status.warmup).toMatchObject({ status: 'done', plan: { scanSamples: 0, bytesToRead: 0, queries: 2 } })
    // The engine's plan says a backtest would read too much: refused before any range query.
    s.w.plan = () => ({ scanSamples: 50_000_000, bytesToRead: 1 << 20, seriesEstimate: 2, refusal: null })
    const before = services.calls.filter((c) => c.path === '/api/v1/query_range').length
    const bt = await call(s.monitors.auth, 'POST', `/api/v1/monitors/${created.json.id}/backtest`, { fromMs: T0 - 60 * MIN, toMs: T0 })
    expect([bt.status, bt.json.error.code, bt.json.plan.scanSamples, bt.json.budget.scanSamples]).toEqual([422, 'over_budget', 100_000_000, 20_000_000])
    expect(services.calls.filter((c) => c.path === '/api/v1/query_range').length).toBe(before)
  })

  it('/healthz: 200 with the production bindings, 503 naming a missing one, no credential needed', async () => {
    const res = await worker.fetch(new Request('https://ruler.internal/healthz') as never, env as never)
    expect([res.status, await res.text()]).toEqual([200, 'ok\n'])
    const without = health(new Request('https://ruler.internal/healthz'), { ...(env as unknown as Record<string, unknown>), TENANT: undefined, QUERY: undefined } as never)
    expect([without.status, await without.text()]).toEqual([503, 'missing binding: TENANT, QUERY\n'])
    expect(health(new Request('https://ruler.internal/healthz', { method: 'POST' }), env as never).status).toBe(405)
  })
})

describe('notifications to the destination set in control', () => {
  async function withDestination(prefix: string, value: Record<string, unknown>) {
    const s = await provisioned(prefix)
    const put = await s.invoke('settings.put', { params: { section: 'notifications' }, body: { value } })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    s.w.evaluate = () => vec([{ service: 'checkout' }, 9])
    expect((await call(s.monitors.auth, 'POST', '/api/v1/monitors', THRESHOLD)).status).toBe(201)
    return s
  }

  it('the plain JSON form: what fired, its value, labels and annotations; signed; no secret or URL in the body; the same key in the header and the body', async () => {
    const s = await withDestination('json', { webhookUrl: HOOK, webhookFormat: 'json', webhookSecret: SECRET })
    for (let i = 0; i < 3 && s.w.received.length === 0; i++) await tick(s)
    expect(s.w.received).toHaveLength(1)
    const got = s.w.received[0]!
    expect(got.url).toBe(HOOK)
    const body = got.body as any
    expect(body).toMatchObject({ version: 'viz.notification/v1', status: 'firing', receiver: 'viz:default', idempotencyKey: got.key, truncatedAlerts: 0 })
    expect(body.alerts).toHaveLength(1)
    expect(body.alerts[0]).toMatchObject({ status: 'firing', name: 'checkout errors', value: 9, endsAt: null, labels: { alertname: 'checkout errors', service: 'checkout' }, annotations: { summary: 'errors at 9' } })
    expect(await verifySignature(SECRET, got.signature ?? null, got.key!, got.raw!, got.at)).toBe(true)
    for (const secret of [SECRET, 'T0K3N', 'Q5ecret', 'hooks.receiver.test']) expect(got.raw!, secret).not.toContain(secret)
  })

  it('the Alertmanager form through a tenant route that names viz:default, and a URL change in control is followed', async () => {
    const s = await withDestination('am', { webhookUrl: HOOK, webhookFormat: 'alertmanager' })
    const cfg = await call(s.monitors.auth, 'PUT', '/api/v1/monitors/notifier', { route: { receiver: 'viz:default', group_wait: '0s', group_interval: '1m' }, receivers: [] })
    expect(cfg.status, cfg.text).toBe(200)
    expect((await call(s.monitors.auth, 'PUT', '/api/v1/monitors/notifier', { route: { receiver: 'viz:default' }, receivers: [{ name: 'viz:default', webhook_configs: [{ url: 'https://x.test' }] }] })).status).toBe(422)
    for (let i = 0; i < 3 && s.w.received.length === 0; i++) await tick(s)
    expect((s.w.received[0]!.body as any)).toMatchObject({ version: '4', status: 'firing', receiver: 'viz:default', alerts: [{ labels: { alertname: 'checkout errors' } }] })
    // control's URL changes; after the refresh interval the next notification goes there.
    expect((await s.invoke('settings.put', { params: { section: 'notifications' }, body: { value: { webhookUrl: 'https://second.receiver.test/h', webhookFormat: 'alertmanager' } } })).status).toBe(200)
    world.now += CONTROL_REFRESH_MS
    s.w.evaluate = () => vec()
    for (let i = 0; i < 4 && s.w.received.length < 2; i++) await tick(s)
    expect(s.w.received.map((r) => [r.url, (r.body as any).status])).toEqual([[HOOK, 'firing'], ['https://second.receiver.test/h', 'resolved']])
  })

  it('at least once, never twice processed: 500, a dropped connection, then 200 send the same bytes under one key; no URL or secret is stored, shown or logged', async () => {
    const s = await withDestination('retry', { webhookUrl: HOOK, webhookFormat: 'json', webhookSecret: SECRET })
    s.w.respond = (_r, n) => (n === 0 ? 500 : n === 1 ? 'network' : 200)
    for (let i = 0; i < 3 && s.w.received.length === 0; i++) await tick(s)
    // Let the notifier retry on its own schedule.
    await runNotifierUntil(s.notifier, s.tenant, world.now + 10 * MIN)
    const attempts = s.w.received
    expect(attempts.length).toBe(3)
    expect(new Set(attempts.map((a) => a.key)).size).toBe(1)
    expect(new Set(attempts.map((a) => a.raw)).size).toBe(1)
    const processed = new Map(attempts.filter((_a, i) => i === 2).map((a) => [a.key, a]))
    expect(processed.size).toBe(1)
    // Everything a person, an agent or an operator can read afterwards.
    const id = (await call(s.monitors.auth, 'GET', '/api/v1/monitors')).json.monitors[0].id
    const readable = [
      (await call(s.monitors.auth, 'GET', '/api/v1/monitors')).text,
      (await call(s.monitors.auth, 'GET', `/api/v1/monitors/${id}`)).text,
      (await call(s.monitors.auth, 'GET', '/api/v1/monitors/notifier')).text,
      (await call(s.monitors.auth, 'GET', '/api/v1/rules')).text,
      JSON.stringify(await s.notifier.outbox(s.tenant)),
      JSON.stringify(await s.notifier.health(s.tenant)),
      JSON.stringify(await s.ruler.health(s.tenant)),
      ...attempts.map((a) => a.raw!),
      logged.join('\n'),
    ].join('\n')
    const [key] = await serviceKeys(s)
    const stored = await runInDurableObject(s.ruler, (_i, st) => JSON.parse(st.storage.sql.exec(`SELECT v FROM meta WHERE k = 'service_key'`).one().v as string).key as string)
    expect(stored.startsWith(`${key!.prefix}_`)).toBe(true)
    for (const secret of [SECRET, 'T0K3N', 'Q5ecret', stored.split('_')[2]!]) expect(readable, secret).not.toContain(secret)
    // The history shows the failures, without the URL.
    const history = (await call(s.monitors.auth, 'GET', `/api/v1/monitors/${id}`)).json.history.entries.filter((e: any) => e.kind === 'notified')
    expect(history.map((e: any) => e.deliveredAt !== null)).toEqual([true])
  })

  it('a stored delivery error never quotes the receiver URL', async () => {
    const s = await withDestination('err', { webhookUrl: HOOK, webhookFormat: 'json' })
    s.w.respond = () => 'network'
    for (let i = 0; i < 3 && s.w.received.length === 0; i++) await tick(s)
    const entries = ok(await s.notifier.outbox(s.tenant)).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]!.lastError).toMatch(/^TypeError: Network connection lost while sending to <url>/)
    expect(JSON.stringify(entries.map((e) => e.lastError))).not.toContain('T0K3N')
  })

  it('tenant isolation: each tenant\'s alerts reach only its own destination', async () => {
    const a = await withDestination('dest-a', { webhookUrl: 'https://a.receiver.test/h', webhookFormat: 'json', webhookSecret: `${SECRET}-A` })
    const b = await withDestination('dest-b', { webhookUrl: 'https://b.receiver.test/h', webhookFormat: 'json', webhookSecret: `${SECRET}-B` })
    a.w.evaluate = () => vec([{ service: 'checkout', who: 'A' }, 9])
    b.w.evaluate = () => vec([{ service: 'checkout', who: 'B' }, 9])
    for (let i = 0; i < 3 && (a.w.received.length === 0 || b.w.received.length === 0); i++) {
      await tick(a)
      await tick(b)
    }
    const urls = (s: Scene) => s.w.received.map((r) => [r.url, (r.body as any).alerts.map((x: any) => x.labels.who).join()])
    expect(urls(a)).toEqual([['https://a.receiver.test/h', 'A']])
    expect(urls(b)).toEqual([['https://b.receiver.test/h', 'B']])
    expect(await verifySignature(`${SECRET}-A`, a.w.received[0]!.signature ?? null, a.w.received[0]!.key!, a.w.received[0]!.raw!, a.w.received[0]!.at)).toBe(true)
    expect(await verifySignature(`${SECRET}-B`, b.w.received[0]!.signature ?? null, b.w.received[0]!.key!, b.w.received[0]!.raw!, b.w.received[0]!.at)).toBe(true)
  })
})

export type { HttpCall }
