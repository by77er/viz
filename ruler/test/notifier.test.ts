/**
 * Alertmanager behaviour, on a fake clock. The cases follow the documented semantics of
 * alertmanager's dispatcher (group_wait / group_interval / repeat_interval), the notify
 * pipeline's dedup stage (`needsUpdate`), inhibit/inhibit.go and silence matching; the
 * upstream sources were fetched for reference on 2026-11-18.
 */
import { evictDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { AlertUpdate, WebhookPayload } from '../contracts-proposal/rules'
import { fingerprint } from '../src/util'
import { T0, tenantWorld, world, type TestNotifier } from './harness'
import { MIN, newTenant, notifierStub, ok, runNotifierUntil } from './helpers'

const SEC = 1000
const HOUR = 60 * MIN

const upd = (labels: Record<string, string>, status: 'firing' | 'resolved', at: number, extra: Partial<AlertUpdate> = {}): AlertUpdate => ({
  fingerprint: fingerprint(labels), labels, annotations: { summary: `${labels.alertname} on ${labels.instance ?? '-'}` }, status,
  startsAt: at, endsAt: status === 'resolved' ? at : null, value: 1, at, generator: { group: 'g', rule: labels.alertname ?? '' }, expiresAt: null, ...extra,
})

const baseConfig = (route: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  route: { receiver: 'hook', group_by: ['alertname'], group_wait: '30s', group_interval: '5m', repeat_interval: '4h', ...route },
  receivers: [
    { name: 'hook', webhook_configs: [{ url: 'https://receiver.test/hook' }] },
    { name: 'db', webhook_configs: [{ url: 'https://receiver.test/db' }] },
    { name: 'chat', slack_configs: [{ api_url: 'https://receiver.test/slack', channel: '#alerts' }] },
  ],
  ...extra,
})

async function start(config: unknown = baseConfig()) {
  const tenant = newTenant('n')
  world.now = T0
  const stub = notifierStub(tenant)
  ok(await stub.setConfig(tenant, config))
  const w = tenantWorld(tenant)
  const source = `${tenant}/0`
  /** Deliver an update at clock time `at` (the notifier is first run up to that time). */
  const send = async (at: number, ...updates: AlertUpdate[]) => {
    await runNotifierUntil(stub, tenant, at)
    world.now = at
    return ok(await stub.ingest(tenant, source, updates))
  }
  const run = (until: number) => runNotifierUntil(stub, tenant, until)
  /** [seconds since T0, status, firing instances, resolved instances] per webhook request. */
  const log = (url = 'https://receiver.test/hook') =>
    w.received.filter((r) => r.url === url).map((r) => {
      const p = r.body as WebhookPayload
      const names = (st: string) => p.alerts.filter((a) => a.status === st).map((a) => a.labels.instance ?? a.labels.alertname).sort().join('+')
      return [(r.at - T0) / SEC, p.status, names('firing'), names('resolved')]
    })
  return { tenant, stub, w, send, run, log }
}

const A = (instance: string, extra: Record<string, string> = {}) => ({ alertname: 'Down', instance, ...extra })

describe('grouping timers', () => {
  it('group_wait: the first notification waits, so alerts that fire together arrive together', async () => {
    const t = await start()
    await t.send(T0, upd(A('a'), 'firing', T0))
    await t.send(T0 + 10 * SEC, upd(A('b'), 'firing', T0 + 10 * SEC))
    await t.run(T0 + 29 * SEC)
    expect(t.log()).toEqual([]) // nothing before group_wait
    await t.run(T0 + 10 * MIN)
    expect(t.log()).toEqual([[30, 'firing', 'a+b', '']]) // one notification, both alerts, and no more
    expect((t.w.received[0]!.body as WebhookPayload)).toMatchObject({ version: '4', groupKey: '{}:{alertname="Down"}', receiver: 'hook', groupLabels: { alertname: 'Down' } })
  })

  it('group_wait is skipped for an alert that has already been firing longer than group_wait', async () => {
    const t = await start()
    await t.send(T0 + 5 * MIN, upd(A('a'), 'firing', T0)) // started 5m ago, arrives now
    await t.run(T0 + 5 * MIN)
    expect(t.log()).toEqual([[300, 'firing', 'a', '']])
  })

  it('group_interval: a change to a group that was already notified waits for the next interval tick', async () => {
    const t = await start()
    await t.send(T0, upd(A('a'), 'firing', T0))
    await t.run(T0 + 30 * SEC)
    await t.send(T0 + 2 * MIN, upd(A('b'), 'firing', T0 + 2 * MIN))
    await t.run(T0 + 5 * MIN + 29 * SEC)
    expect(t.log()).toEqual([[30, 'firing', 'a', '']]) // not yet: next tick is first flush + 5m
    await t.run(T0 + 5 * MIN + 30 * SEC)
    expect(t.log()).toEqual([[30, 'firing', 'a', ''], [330, 'firing', 'a+b', '']])
    // Ticks with no change send nothing.
    await t.run(T0 + 60 * MIN)
    expect(t.log().length).toBe(2)
  })

  it('repeat_interval: an unchanged firing group is re-sent after repeat_interval, as a new notification', async () => {
    const t = await start(baseConfig({ repeat_interval: '1h' }))
    await t.send(T0, upd(A('a'), 'firing', T0))
    await t.run(T0 + 59 * MIN)
    expect(t.log()).toEqual([[30, 'firing', 'a', '']])
    await t.run(T0 + 3 * HOUR)
    // Ticks are at 30s + k*5m; the first at or after 30s + 1h is exactly 1h later, and so on.
    expect(t.log()).toEqual([[30, 'firing', 'a', ''], [3630, 'firing', 'a', ''], [7230, 'firing', 'a', '']])
    expect(new Set(t.w.received.map((r) => r.key)).size).toBe(3) // a repeat is not a duplicate
    // The alarm sleeps until the next repeat: an idle group costs nothing in between.
    const h = ok(await t.stub.health(t.tenant))
    expect(h.alarmAtMs).toBe(T0 + 30 * SEC + 3 * HOUR)
  })

  it('a steadily firing group writes no rows and arms no alarms between notifications', async () => {
    const t = await start(baseConfig({ repeat_interval: '1h' }))
    await t.send(T0, upd(A('a'), 'firing', T0))
    await t.run(T0 + 30 * SEC)
    const h0 = ok(await t.stub.health(t.tenant))
    await t.run(T0 + 59 * MIN)
    const h1 = ok(await t.stub.health(t.tenant))
    expect(h1.counters.sqlRowsWritten).toBe(h0.counters.sqlRowsWritten)
    expect(h1.counters.alarmsSet).toBe(h0.counters.alarmsSet)
  })

  it('group_by makes one group, and one notification, per label value', async () => {
    const t = await start(baseConfig({ group_by: ['alertname', 'cluster'] }))
    await t.send(T0, upd(A('a', { cluster: 'eu' }), 'firing', T0), upd(A('b', { cluster: 'eu' }), 'firing', T0), upd(A('c', { cluster: 'us' }), 'firing', T0))
    await t.run(T0 + MIN)
    expect(t.log().sort()).toEqual([[30, 'firing', 'a+b', ''], [30, 'firing', 'c', '']])
    expect(t.w.received.map((r) => (r.body as WebhookPayload).groupKey).sort()).toEqual(['{}:{alertname="Down",cluster="eu"}', '{}:{alertname="Down",cluster="us"}'])
    expect(ok(await t.stub.health(t.tenant)).groups).toBe(2)
  })
})

describe('resolved notifications', () => {
  it('sends a resolved notification at the next tick, then forgets the group', async () => {
    const t = await start()
    await t.send(T0, upd(A('a'), 'firing', T0), upd(A('b'), 'firing', T0))
    await t.run(T0 + MIN)
    await t.send(T0 + 2 * MIN, upd(A('a'), 'resolved', T0 + 2 * MIN))
    await t.run(T0 + 6 * MIN)
    // The group is still firing (b), and the notification carries the resolved alert too.
    expect(t.log()).toEqual([[30, 'firing', 'a+b', ''], [330, 'firing', 'b', 'a']])
    const resolvedAlert = (t.w.received[1]!.body as WebhookPayload).alerts.find((a) => a.status === 'resolved')!
    expect(resolvedAlert.endsAt).toBe(new Date(T0 + 2 * MIN).toISOString())
    expect((t.w.received[1]!.body as WebhookPayload).alerts.find((a) => a.status === 'firing')!.endsAt).toBe('0001-01-01T00:00:00Z')
    await t.send(T0 + 7 * MIN, upd(A('b'), 'resolved', T0 + 7 * MIN))
    await t.run(T0 + 3 * HOUR)
    // a's resolution is not repeated; the last notification is the group resolving.
    expect(t.log()).toEqual([[30, 'firing', 'a+b', ''], [330, 'firing', 'b', 'a'], [630, 'resolved', '', 'b']])
    expect(ok(await t.stub.health(t.tenant))).toMatchObject({ groups: 0, alerts: { firing: 0, resolved: 0 }, alarmAtMs: null })
  })

  it('an alert that fires and resolves within group_wait is never notified', async () => {
    const t = await start()
    await t.send(T0, upd(A('a'), 'firing', T0))
    await t.send(T0 + 10 * SEC, upd(A('a'), 'resolved', T0 + 10 * SEC))
    await t.run(T0 + HOUR)
    expect(t.log()).toEqual([])
    expect(ok(await t.stub.health(t.tenant))).toMatchObject({ groups: 0, alerts: { firing: 0, resolved: 0 } })
  })

  it('an alert that fires again after resolving is a new notification', async () => {
    const t = await start()
    await t.send(T0, upd(A('a'), 'firing', T0))
    await t.run(T0 + MIN)
    await t.send(T0 + 2 * MIN, upd(A('a'), 'resolved', T0 + 2 * MIN))
    await t.run(T0 + 6 * MIN)
    await t.send(T0 + 20 * MIN, upd(A('a'), 'firing', T0 + 20 * MIN))
    await t.run(T0 + 30 * MIN)
    expect(t.log()).toEqual([[30, 'firing', 'a', ''], [330, 'resolved', '', 'a'], [1230, 'firing', 'a', '']])
  })

  it('a receiver with send_resolved: false (the Slack default) gets firing notifications only', async () => {
    const t = await start(baseConfig({ receiver: 'chat' }))
    await t.send(T0, upd(A('a'), 'firing', T0), upd(A('b'), 'firing', T0))
    await t.run(T0 + MIN)
    await t.send(T0 + 2 * MIN, upd(A('a'), 'resolved', T0 + 2 * MIN))
    await t.send(T0 + 7 * MIN, upd(A('b'), 'resolved', T0 + 7 * MIN))
    await t.run(T0 + HOUR)
    expect(t.w.received.map((r) => [r.url, (r.at - T0) / SEC, (r.body as { text: string }).text])).toEqual([['https://receiver.test/slack', 30, '[FIRING:2] Down']])
    expect(t.w.received[0]!.body).toMatchObject({ channel: '#alerts', username: 'viz', attachments: [{ color: 'danger', text: '• Down on a\n• Down on b' }] })
    expect(ok(await t.stub.health(t.tenant))).toMatchObject({ groups: 0, outboxDepth: 0 })
  })
})

describe('routing', () => {
  const routed = baseConfig({
    routes: [
      { receiver: 'chat', match: { severity: 'page' }, continue: true, group_wait: '10s' },
      { receiver: 'db', match_re: { service: 'mysql|postgres' }, group_by: ['alertname', 'service'] },
    ],
  })

  it('`continue` delivers one alert through two routes, each with its own receiver, grouping and timers', async () => {
    const t = await start(routed)
    await t.send(T0, upd(A('a', { severity: 'page', service: 'mysql' }), 'firing', T0))
    await t.run(T0 + MIN)
    expect(t.w.received.map((r) => [r.url.split('/').pop(), (r.at - T0) / SEC])).toEqual([['slack', 10], ['db', 30]])
    const db = t.w.received[1]!.body as WebhookPayload
    expect(db).toMatchObject({ receiver: 'db', groupLabels: { alertname: 'Down', service: 'mysql' }, groupKey: '{}/{service=~"mysql|postgres"}/1:{alertname="Down",service="mysql"}' })
    expect(ok(await t.stub.listAlerts(t.tenant)).alerts[0]!.receivers).toEqual(['chat', 'db'])
  })

  it('without `continue` the first matching route wins; with no match the root receiver gets it', async () => {
    const t = await start(routed)
    await t.send(T0, upd(A('a', { service: 'postgres' }), 'firing', T0), upd(A('b'), 'firing', T0), upd(A('c', { severity: 'page' }), 'firing', T0))
    await t.run(T0 + MIN)
    expect(t.w.received.map((r) => r.url.split('/').pop()).sort()).toEqual(['db', 'hook', 'slack'])
    expect(t.log()).toEqual([[30, 'firing', 'b', '']])
    expect(t.log('https://receiver.test/db')).toEqual([[30, 'firing', 'a', '']])
  })

  it('a new config re-routes alerts that are firing', async () => {
    const t = await start()
    await t.send(T0, upd(A('a', { service: 'mysql' }), 'firing', T0))
    await t.run(T0 + MIN)
    expect(t.log()).toEqual([[30, 'firing', 'a', '']])
    world.now = T0 + 2 * MIN
    ok(await t.stub.setConfig(t.tenant, routed))
    await t.run(T0 + 10 * MIN)
    expect(t.log('https://receiver.test/db')).toEqual([[120, 'firing', 'a', '']]) // already firing longer than group_wait
    expect(t.log().length).toBe(1)
  })
})

describe('inhibition', () => {
  const config = baseConfig({ group_by: ['alertname'] }, { inhibit_rules: [{ source_match: { alertname: 'ClusterDown' }, target_match: { severity: 'warning' }, equal: ['cluster'] }] })

  it('a firing source mutes matching targets with equal labels; they are notified once the source resolves', async () => {
    const t = await start(config)
    const src = { alertname: 'ClusterDown', cluster: 'eu' }
    await t.send(T0, upd(src, 'firing', T0))
    await t.send(T0 + SEC, upd({ alertname: 'HighLatency', instance: 'x', severity: 'warning', cluster: 'eu' }, 'firing', T0 + SEC),
      upd({ alertname: 'HighLatency', instance: 'y', severity: 'warning', cluster: 'us' }, 'firing', T0 + SEC),
      upd({ alertname: 'DiskFull', instance: 'z', severity: 'critical', cluster: 'eu' }, 'firing', T0 + SEC))
    await t.run(T0 + 4 * MIN)
    // eu/warning is inhibited; us/warning (different cluster) and eu/critical (not a target) are not.
    expect(t.log().sort()).toEqual([[30, 'firing', 'ClusterDown', ''], [31, 'firing', 'y', ''], [31, 'firing', 'z', '']])
    const listed = ok(await t.stub.listAlerts(t.tenant)).alerts
    expect(listed.filter((a) => a.inhibited).map((a) => a.labels.instance)).toEqual(['x'])
    await t.send(T0 + 4 * MIN, upd(src, 'resolved', T0 + 4 * MIN))
    await t.run(T0 + 12 * MIN)
    // x joins its group's notification at that group's next tick (31s + 5m) after the inhibitor is gone.
    expect(t.log().slice(3).sort()).toEqual([[330, 'resolved', '', 'ClusterDown'], [331, 'firing', 'x+y', '']])
    expect(ok(await t.stub.listAlerts(t.tenant)).alerts.filter((a) => a.inhibited)).toEqual([])
  })

  it('an inhibited alert that resolves while inhibited is never notified', async () => {
    const t = await start(config)
    await t.send(T0, upd({ alertname: 'ClusterDown', cluster: 'eu' }, 'firing', T0), upd({ alertname: 'HighLatency', instance: 'x', severity: 'warning', cluster: 'eu' }, 'firing', T0))
    await t.send(T0 + 2 * MIN, upd({ alertname: 'HighLatency', instance: 'x', severity: 'warning', cluster: 'eu' }, 'resolved', T0 + 2 * MIN))
    await t.run(T0 + HOUR)
    expect(t.log()).toEqual([[30, 'firing', 'ClusterDown', '']])
  })
})

describe('silences', () => {
  const silence = (over: Record<string, unknown> = {}) => ({
    matchers: [{ name: 'alertname', value: 'Down', isRegex: false }, { name: 'instance', value: 'a|b', isRegex: true }],
    startsAt: T0, endsAt: T0 + HOUR, createdBy: 'ops@example.test', comment: 'maintenance', ...over,
  })

  it('a silenced alert is not notified; expiring the silence through RPC lets it through at the next tick', async () => {
    const t = await start()
    world.now = T0
    const created = ok(await t.stub.createSilence(t.tenant, silence()))
    await t.send(T0, upd(A('a'), 'firing', T0), upd(A('c'), 'firing', T0))
    await t.run(T0 + 12 * MIN)
    expect(t.log()).toEqual([[30, 'firing', 'c', '']]) // a is silenced, c is not
    expect(ok(await t.stub.listAlerts(t.tenant)).alerts.map((a) => [a.labels.instance, a.silencedBy])).toEqual([['a', [created.id]], ['c', []]])
    expect(ok(await t.stub.listSilences(t.tenant)).silences).toEqual([{ id: created.id, ...silence(), updatedAt: T0, state: 'active' }])
    world.now = T0 + 12 * MIN
    expect(await t.stub.expireSilence(t.tenant, created.id)).toEqual({ status: 'ok' })
    expect(await t.stub.expireSilence(t.tenant, 'nope')).toEqual({ status: 'not_found' })
    expect(ok(await t.stub.listSilences(t.tenant)).silences[0]).toMatchObject({ state: 'expired', endsAt: T0 + 12 * MIN })
    await t.run(T0 + 20 * MIN)
    expect(t.log()).toEqual([[30, 'firing', 'c', ''], [930, 'firing', 'a+c', '']]) // tick at 30s + 3*5m
  })

  it('a silence that ends by itself wakes the notifier; one that starts later mutes repeats from then on', async () => {
    const t = await start(baseConfig({ repeat_interval: '30m' }))
    world.now = T0
    ok(await t.stub.createSilence(t.tenant, silence({ endsAt: T0 + 17 * MIN })))
    const later = ok(await t.stub.createSilence(t.tenant, silence({ startsAt: T0 + 40 * MIN, endsAt: T0 + 3 * HOUR })))
    expect(ok(await t.stub.listSilences(t.tenant)).silences.map((s) => s.state).sort()).toEqual(['active', 'pending'])
    await t.send(T0, upd(A('a'), 'firing', T0))
    await t.run(T0 + 2 * HOUR)
    // Silenced until 17m: first tick after is 30s + 20m. The repeat due at 50m30s falls in the second silence.
    expect(t.log()).toEqual([[1230, 'firing', 'a', '']])
    world.now = T0 + 2 * HOUR
    ok(await t.stub.expireSilence(t.tenant, later.id))
    await t.run(T0 + 2 * HOUR + 10 * MIN)
    expect(t.log().length).toBe(2)
  })

  it('validates silences and reports problems with paths', async () => {
    const t = await start()
    const r = await t.stub.createSilence(t.tenant, silence({ matchers: [{ name: 'x', value: '(', isRegex: true }], endsAt: T0 - 1, comment: '' }) as never)
    expect(r.status).toBe('invalid')
    if (r.status === 'invalid') expect(r.errors.map((e) => e.path).sort()).toEqual(['comment', 'endsAt', 'endsAt', 'matchers[0].value'])
    expect(ok(await t.stub.listSilences(t.tenant)).silences).toEqual([])
  })
})

describe('the outbox: retries, backoff, dead letters', () => {
  const fast = baseConfig({ group_wait: '0s' }, { delivery: { max_attempts: 4, base_backoff: '1s', max_backoff: '1m', timeout: '5s' } })

  it('retries a failing receiver with exponential, seeded backoff under one idempotency key', async () => {
    const t = await start(fast)
    t.w.respond = (_req, n) => (n < 2 ? 503 : 200)
    await t.send(T0, upd(A('a'), 'firing', T0))
    await t.run(T0)
    let h = ok(await t.stub.health(t.tenant))
    expect(h).toMatchObject({ outboxDepth: 1, oldestUndeliveredAgeMs: 0, deadLetters: 0 })
    const entry = ok(await t.stub.outbox(t.tenant)).entries[0]!
    expect(entry).toMatchObject({ status: 'pending', attempts: 1, lastError: 'HTTP 503', receiver: 'hook', integration: 'webhook[0]', url: 'https://receiver.test/hook' })
    await t.run(T0 + 10 * MIN)
    expect(t.w.received.length).toBe(3)
    expect(new Set(t.w.received.map((r) => r.key))).toEqual(new Set([entry.idempotencyKey]))
    const gaps = t.w.received.slice(1).map((r, i) => r.at - t.w.received[i]!.at)
    // attempt 1 failed -> wait in [0.5s, 1s); attempt 2 failed -> wait in [1s, 2s)
    expect(gaps[0]).toBeGreaterThanOrEqual(500)
    expect(gaps[0]).toBeLessThan(1000)
    expect(gaps[1]).toBeGreaterThanOrEqual(1000)
    expect(gaps[1]).toBeLessThan(2000)
    h = ok(await t.stub.health(t.tenant))
    expect(h).toMatchObject({ outboxDepth: 0, oldestUndeliveredAgeMs: null, counters: { delivered: 1, attempts: 3 } })
    // The schedule is a function of the key alone: a second tenant-independent run with the same key backs off identically.
    expect(entry.nextAttemptAt - T0).toBe(gaps[0])
  })

  it('dead-letters after max_attempts, shows it through RPC, and can retry it with the same key or discard it', async () => {
    const t = await start(fast)
    t.w.respond = () => 500
    await t.send(T0, upd(A('a'), 'firing', T0))
    await t.run(T0 + HOUR)
    expect(t.w.received.length).toBe(4)
    const dead = ok(await t.stub.outbox(t.tenant)).entries
    expect(dead).toEqual([expect.objectContaining({ status: 'dead', attempts: 4, lastError: 'HTTP 500' })])
    expect(ok(await t.stub.health(t.tenant))).toMatchObject({ outboxDepth: 0, deadLetters: 1 })
    t.w.respond = () => 200
    expect(await t.stub.retryDeadLetter(t.tenant, 999)).toEqual({ status: 'not_found' })
    expect(await t.stub.retryDeadLetter(t.tenant, dead[0]!.id)).toEqual({ status: 'ok' })
    await t.run(world.now)
    expect(t.w.received.length).toBe(5)
    expect(new Set(t.w.received.map((r) => r.key)).size).toBe(1)
    expect(ok(await t.stub.health(t.tenant))).toMatchObject({ outboxDepth: 0, deadLetters: 0 })
    // A dead letter can also be discarded.
    t.w.respond = () => 500
    await t.send(world.now + MIN, upd({ alertname: 'Other' }, 'firing', world.now + MIN))
    await t.run(world.now + HOUR)
    const d2 = ok(await t.stub.outbox(t.tenant)).entries.find((e) => e.status === 'dead')!
    expect(await t.stub.discardDeadLetter(t.tenant, d2.id)).toEqual({ status: 'ok' })
    expect(await t.stub.discardDeadLetter(t.tenant, d2.id)).toEqual({ status: 'not_found' })
    expect(ok(await t.stub.health(t.tenant)).deadLetters).toBe(0)
  })

  it('a 4xx (other than 408/429) is dead-lettered at once: resending the same request cannot help', async () => {
    const t = await start(fast)
    t.w.respond = () => 404
    await t.send(T0, upd(A('a'), 'firing', T0))
    await t.run(T0 + HOUR)
    expect(t.w.received.length).toBe(1)
    expect(ok(await t.stub.outbox(t.tenant)).entries[0]).toMatchObject({ status: 'dead', attempts: 1, lastError: 'HTTP 404' })
    const u = await start(fast)
    u.w.respond = (_r, n) => (n === 0 ? 429 : 200)
    await u.send(T0, upd(A('a'), 'firing', T0))
    await u.run(T0 + HOUR)
    expect(u.w.received.length).toBe(2)
  })

  it('a dead receiver does not hold up another receiver', async () => {
    const t = await start(baseConfig({ group_wait: '0s', routes: [{ receiver: 'db', match: { team: 'db' }, continue: true }, { receiver: 'hook' }] }, { delivery: { max_attempts: 3 } }))
    t.w.respond = (req) => (req.url.endsWith('/db') ? 500 : 200)
    await t.send(T0, upd(A('a', { team: 'db' }), 'firing', T0))
    await t.run(T0)
    expect(t.log()).toEqual([[0, 'firing', 'a', '']])
  })
})

describe('ingest is idempotent and ordered by evaluation time', () => {
  it('a redelivered batch applies nothing; a stale or same-time "firing" cannot undo a "resolved"', async () => {
    const t = await start()
    const firing = upd(A('a'), 'firing', T0)
    expect(await t.send(T0, firing)).toEqual({ status: 'ok', applied: 1 })
    const writes = ok(await t.stub.health(t.tenant)).counters.sqlRowsWritten
    expect(await t.send(T0 + SEC, firing)).toEqual({ status: 'ok', applied: 0 })
    expect(ok(await t.stub.health(t.tenant)).counters.sqlRowsWritten).toBe(writes)
    await t.run(T0 + MIN)
    const resolved = upd(A('a'), 'resolved', T0 + 2 * MIN)
    expect(await t.send(T0 + 2 * MIN, resolved)).toEqual({ status: 'ok', applied: 1 })
    expect(await t.send(T0 + 2 * MIN + SEC, resolved)).toEqual({ status: 'ok', applied: 0 })
    expect(await t.send(T0 + 2 * MIN + 2 * SEC, firing)).toEqual({ status: 'ok', applied: 0 }) // older than the resolution
    expect(await t.send(T0 + 2 * MIN + 3 * SEC, upd(A('a'), 'firing', T0 + 2 * MIN))).toEqual({ status: 'ok', applied: 0 }) // same evaluation time
    expect(await t.send(T0 + 2 * MIN + 4 * SEC, upd(A('zzz'), 'resolved', T0))).toEqual({ status: 'ok', applied: 0 }) // never seen firing
    await t.run(T0 + HOUR)
    expect(t.log()).toEqual([[30, 'firing', 'a', ''], [330, 'resolved', '', 'a']])
  })

  it('refuses new alerts over the tenant cap with a retryable status, applying nothing', async () => {
    const t = await start()
    const many = Array.from({ length: 5001 }, (_, i) => upd(A(`i${i}`), 'firing', T0))
    world.now = T0
    expect(await t.stub.ingest(t.tenant, `${t.tenant}/0`, many)).toEqual({ status: 'overloaded', retryAfterMs: 30_000 })
    expect(ok(await t.stub.health(t.tenant)).alerts.firing).toBe(0)
  })
})

describe('storage is the source of truth', () => {
  it('evicting the notifier between every step changes nothing about what is sent or when', async () => {
    const scenario = async (evict: boolean) => {
      const t = await start(baseConfig({ repeat_interval: '30m', routes: [{ receiver: 'db', match: { team: 'db' }, continue: true }] }, {
        inhibit_rules: [{ source_match: { alertname: 'ClusterDown' }, target_match: { severity: 'warning' }, equal: ['cluster'] }],
      }))
      const bump = async (stub: DurableObjectStub<TestNotifier>) => {
        if (evict) await evictDurableObject(stub)
      }
      world.now = T0
      ok(await t.stub.createSilence(t.tenant, { matchers: [{ name: 'instance', value: 'quiet', isRegex: false }], startsAt: T0, endsAt: T0 + 22 * MIN, createdBy: 'x', comment: 'y' }))
      const steps: [number, AlertUpdate][] = [
        [0, upd(A('a', { team: 'db' }), 'firing', T0)],
        [5 * SEC, upd(A('quiet'), 'firing', T0 + 5 * SEC)],
        [40 * SEC, upd({ alertname: 'ClusterDown', cluster: 'eu' }, 'firing', T0 + 40 * SEC)],
        [50 * SEC, upd({ alertname: 'Slow', severity: 'warning', cluster: 'eu' }, 'firing', T0 + 50 * SEC)],
        [8 * MIN, upd(A('b'), 'firing', T0 + 8 * MIN)],
        [12 * MIN, upd({ alertname: 'ClusterDown', cluster: 'eu' }, 'resolved', T0 + 12 * MIN)],
        [26 * MIN, upd(A('a', { team: 'db' }), 'resolved', T0 + 26 * MIN)],
      ]
      for (const [dt, u] of steps) {
        await bump(t.stub)
        await t.send(T0 + dt, u)
      }
      // Run to the end one alarm at a time, evicting before each.
      for (let i = 0; i < 200; i++) {
        await bump(t.stub)
        const h = ok(await t.stub.health(t.tenant))
        if (h.alarmAtMs === null || h.alarmAtMs > T0 + 2 * HOUR) break
        await t.run(h.alarmAtMs)
      }
      return t.w.received.map((r) => [r.url, (r.at - T0) / SEC, JSON.stringify(r.body), r.key!.length])
    }
    const steady = await scenario(false)
    const evicted = await scenario(true)
    expect(steady.length).toBeGreaterThan(8)
    // Group keys, bodies and times are identical; only the tenant-specific idempotency keys differ.
    expect(evicted).toEqual(steady)
  })
})
