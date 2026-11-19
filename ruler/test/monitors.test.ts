/**
 * viz's own API, /api/v1/monitors/...: what the Monitors, Monitor and New monitor screens
 * need (design-system/reviews/flows-v1/review.md: B3 "firing since" vs "above threshold
 * since", M1 who was notified and whether anyone has it, M2 acknowledge / silence with
 * undo, M11 message, runbook and no-data fields).
 */
import { describe, expect, it } from 'vitest'
import type { MonitorView, TimelineEntry } from '../contracts-proposal/rules.v2'
import { DEFAULT_NOTIFIER_LIMITS } from '../src/notifier'
import { verifySignature } from '../src/signature'
import { ALL_SCOPES, apiKey, call } from './api'
import kubernetesApps from './fixtures/kubernetes-apps.yaml?raw'
import { tenantWorld, world, T0 } from './harness'
import { expectWindows, MIN, newTenant, notifierStub, ok, rulerStub, runNotifierUntil, vec } from './helpers'

const HOUR = 60 * MIN
const SECRET = 'whsec-0123456789abcdef-payments'
const SLACK_URL = 'https://hooks.slack.test/services/T000/B000/veryprivatetoken'

const notifierConfig = (secret: string | undefined = SECRET) => ({
  route: { receiver: 'default', group_by: ['alertname'], group_wait: '0s', group_interval: '1m', repeat_interval: '4h' },
  receivers: [
    { name: 'default', webhook_configs: [{ url: 'https://receiver.test/default' }] },
    { name: 'payments-oncall', webhook_configs: [{ url: 'https://pager.test/hook?routing=abc123', ...(secret === undefined ? {} : { secret }) }], slack_configs: [{ api_url: SLACK_URL, channel: '#payments-alerts', send_resolved: true }] },
  ],
})

async function scene(opts: { config?: boolean; rulerConfig?: Record<string, unknown> } = {}) {
  world.now = T0
  const tenant = newTenant('mon')
  const key = await apiKey(tenant)
  const w = tenantWorld(tenant)
  const ruler = rulerStub(tenant)
  const notifier = notifierStub(tenant)
  ok(await ruler.configure(tenant, { deadman: false, ...opts.rulerConfig }))
  if (opts.config !== false) expect((await call(key.auth, 'PUT', '/api/v1/monitors/notifier', notifierConfig())).status).toBe(200)
  /** Advance to the ruler's next alarm, then let the notifier run everything due up to that time. */
  const tick = async (): Promise<number> => {
    const h = ok(await ruler.health(tenant))
    world.now = Math.max(h.alarmAtMs as number, world.now)
    await (await import('./helpers')).alarmAt(ruler, world.now)
    await runNotifierUntil(notifier, tenant, world.now)
    return world.now
  }
  /** Let time pass with both objects running at the times they ask for. */
  const until = async (at: number) => {
    for (;;) {
      const h = ok(await ruler.health(tenant))
      if (h.alarmAtMs === null || h.alarmAtMs > at) break
      await tick()
    }
    await runNotifierUntil(notifier, tenant, at)
  }
  const get = async (id: string) => (await call(key.auth, 'GET', `/api/v1/monitors/${id}`)).json as { monitor: MonitorView; history: { entries: TimelineEntry[]; dropped: number } }
  const list = async (q = '') => (await call(key.auth, 'GET', `/api/v1/monitors${q}`)).json as { monitors: MonitorView[]; counts: Record<string, number>; total: number }
  return { tenant, key, w, ruler, notifier, tick, until, get, list }
}

const checkout = {
  name: 'checkout p99 latency',
  query: 'histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{service="checkout-api"}[5m]))) * 1000',
  condition: { op: '>', threshold: 500, unit: 'ms' },
  for: '5m',
  interval: '1m',
  description: 'p99 of checkout-api against the 500 ms objective',
  message: 'checkout p99 is {{ $value | humanize }} ms',
  runbookUrl: 'https://runbooks.example.test/checkout-latency',
  owner: 'payments',
  notify: 'payments-oncall',
  noData: 'keep',
  startInvestigation: true,
}

const kinds = (entries: TimelineEntry[]) => entries.map((e) => (e.kind === 'notified' ? `notified:${e.integration}:${e.status}${e.repeat ? ':repeat' : ''}` : e.kind))

describe('creating a monitor: validation with a path and a fix, dry run, cost class', () => {
  it('every problem names the monitor\'s own field and says what to change; nothing is saved', async () => {
    const { key, list } = await scene()
    const res = await call(key.auth, 'POST', '/api/v1/monitors', {
      name: '', query: 'ratio', condition: { op: '=>', threshold: '1%' }, notify: 'nobody', runbookUrl: 'see wiki', noData: 'resolve', colour: 'red', startInvestigation: 'yes',
    })
    expect(res.status).toBe(422)
    expect(res.json.error.code).toBe('invalid')
    const problems = res.json.problems as { path: string; message: string; fix: string }[]
    expect(problems.map((p) => p.path).sort()).toEqual(['colour', 'condition.op', 'condition.threshold', 'name', 'noData', 'notify', 'runbookUrl', 'startInvestigation'])
    for (const p of problems) expect(p.fix.length, p.path).toBeGreaterThan(8)
    expect(problems.find((p) => p.path === 'condition.threshold')!.fix).toMatch(/a ratio of 1% is 0\.01/) // review M11
    // viz:default is the destination set in the control plane (contracts/rules.ts CONTROL_RECEIVER).
    expect(problems.find((p) => p.path === 'notify')!.fix).toBe('Use one of: default, payments-oncall, viz:default.')
    expect((await list()).total).toBe(0)
  })

  it('problems the ruler finds in the rule come back under the monitor\'s field names too', async () => {
    const { key } = await scene()
    const res = await call(key.auth, 'POST', '/api/v1/monitors', { ...checkout, for: 'five minutes', noData: 'alerting', noDataFor: '10 min', message: '{{ if $value }}x{{ end }}', query: 'sum(rate(x[5m])' })
    expect(res.status).toBe(422)
    expect((res.json.problems as { path: string }[]).map((p) => p.path).sort()).toEqual(['for', 'message', 'noDataFor', 'query', 'query'])
    const both = await call(key.auth, 'POST', '/api/v1/monitors', { name: 'x', expr: 'a > 1', query: 'a', condition: { op: '>', threshold: 1 } })
    expect(both.json.problems).toMatchObject([{ path: 'expr' }])
    const neither = await call(key.auth, 'POST', '/api/v1/monitors', { name: 'x' })
    expect(neither.json.problems).toMatchObject([{ path: 'query' }])
  })

  it('dryRun reports what would be saved, including the cost class, and saves nothing; the real save returns the same', async () => {
    const { key, list } = await scene()
    const dry = await call(key.auth, 'POST', '/api/v1/monitors?dryRun=true', checkout)
    expect(dry.status).toBe(200)
    expect(dry.json).toMatchObject({ dryRun: true, group: 'monitors/1m', shard: '0', cost: { class: 'tail', windowMs: 5 * MIN }, warnings: [] })
    expect(dry.json.expr).toBe(`(${checkout.query}) > 500`)
    expect((await list()).total).toBe(0)
    const inBody = await call(key.auth, 'POST', '/api/v1/monitors', { ...checkout, dryRun: true })
    expect(inBody.json.dryRun).toBe(true)
    expect((await list()).total).toBe(0)
    const real = await call(key.auth, 'POST', '/api/v1/monitors', checkout)
    expect(real.status).toBe(201)
    expect(real.json).toMatchObject({ dryRun: false, group: 'monitors/1m', cost: { class: 'tail' } })
    expect(real.json.id).toMatch(/^mon_[0-9a-f]{16}$/)
    expect((await list()).total).toBe(1)
  })

  it('the cost class follows the query window, and a questionable setting is a warning, not a refusal', async () => {
    const { key } = await scene()
    const week = await call(key.auth, 'POST', '/api/v1/monitors', { name: 'weekly', query: 'avg_over_time(x[7d])', condition: { op: '<', threshold: 1 }, for: '10s', interval: '1m' })
    expect(week.status).toBe(201)
    expect(week.json.cost).toMatchObject({ class: 'rollup', windowMs: 7 * 24 * HOUR })
    expect(week.json.warnings).toMatchObject([{ path: 'for' }])
    const day = await call(key.auth, 'POST', '/api/v1/monitors', { name: 'daily', expr: 'increase(errors_total[6h]) > 10' })
    expect(day.json.cost.class).toBe('recent')
  })

  it('without a notifier config, naming a receiver is a problem with a fix; a monitor without "notify" can still be saved', async () => {
    const { key } = await scene({ config: false })
    const res = await call(key.auth, 'POST', '/api/v1/monitors', checkout)
    expect(res.json.problems).toMatchObject([{ path: 'notify', fix: expect.stringMatching(/Save the notifier config/) }])
    const { notify: _n, ...rest } = checkout
    expect((await call(key.auth, 'POST', '/api/v1/monitors', rest)).status).toBe(201)
  })
})

describe('the Monitors and Monitor screens', () => {
  it('pending, firing, notified, acknowledged, silenced, resolved: every field the screens show, and a complete history with who, what and when', async () => {
    const s = await scene()
    const other = await apiKey(s.tenant, ALL_SCOPES)
    const id = (await call(s.key.auth, 'POST', '/api/v1/monitors', checkout)).json.id as string
    const createdAt = world.now
    let value = 531
    s.w.evaluate = (q) => (q.includes('> 500') ? (value > 500 ? vec([{ service: 'checkout-api' }, value]) : vec()) : vec([{ service: 'checkout-api' }, value]))

    // 13:02 in the mock-up: the value goes above the threshold. Pending.
    const above = await s.tick()
    let m = (await s.list()).monitors[0]!
    expect(m).toMatchObject({
      id, name: 'checkout p99 latency', state: 'pending', activeAt: above, firingSince: null, value: 531, thresholdText: '> 500 ms for 5m',
      owner: 'payments', notify: 'payments-oncall', noData: 'keep', startInvestigation: true, intervalMs: MIN, forMs: 5 * MIN,
      message: 'checkout p99 is {{ $value | humanize }} ms', runbookUrl: 'https://runbooks.example.test/checkout-latency', description: 'p99 of checkout-api against the 500 ms objective',
      acknowledged: null, silencedUntil: null, health: 'ok', historyRecorded: true,
    })
    // Who is notified and how, before anything fires. No URL, no secret.
    expect(m.notifies).toEqual([{ name: 'payments-oncall', integrations: [{ kind: 'webhook', channel: null, signed: true }, { kind: 'slack', channel: '#payments-alerts', signed: false }] }])
    expect(m.alerts).toMatchObject([{ state: 'pending', activeAt: above, firingSince: null, firesAt: above + 5 * MIN, value: 531, handedOff: false, acknowledged: null }])
    expect((await s.list('?filter=attention')).monitors.length).toBe(1)
    expect((await s.list()).counts).toMatchObject({ pending: 1, firing: 0 })

    // 13:07: five minutes above. Firing. "Firing since" and "above threshold since" are two different times.
    value = 742
    let fired = 0
    for (let i = 0; i < 5; i++) fired = await s.tick()
    expect(fired).toBe(above + 5 * MIN)
    m = (await s.list()).monitors[0]!
    expect(m).toMatchObject({ state: 'firing', firingSince: fired, activeAt: above, value: 742 })
    const fp = m.alerts[0]!.fingerprint
    expect(m.alerts[0]).toMatchObject({ state: 'firing', firingSince: fired, activeAt: above, firesAt: null, handedOff: true, lastNotifiedAt: fired, nextRepeatAt: fired + 4 * HOUR, acknowledged: null })
    expect(s.w.received.map((r) => r.url).sort()).toEqual(['https://hooks.slack.test/services/T000/B000/veryprivatetoken', 'https://pager.test/hook?routing=abc123'])
    expect((s.w.received.find((r) => r.url.includes('pager'))!.body as { alerts: { annotations: Record<string, string> }[] }).alerts[0]!.annotations).toMatchObject({ summary: 'checkout p99 is 742 ms', runbook_url: checkout.runbookUrl })

    // Acknowledge: recorded with who and when; the alert stays listed and firing.
    world.now = fired + 9 * MIN
    const ack = await call(other.auth, 'POST', `/api/v1/monitors/${id}/acknowledge`, {})
    expect(ack.json).toEqual({ dryRun: false, id, acknowledged: [fp], notYetHandedOff: [], by: other.by, at: fired + 9 * MIN })
    m = (await s.list('?filter=attention')).monitors[0]!
    expect(m).toMatchObject({ state: 'firing', acknowledged: { by: other.by, at: fired + 9 * MIN } })
    expect(m.alerts[0]).toMatchObject({ acknowledged: { by: other.by, at: fired + 9 * MIN }, nextRepeatAt: null })
    // A second acknowledgement does not rewrite who took it.
    await call(s.key.auth, 'POST', `/api/v1/monitors/${id}/acknowledge`, {})
    expect((await s.get(id)).monitor.acknowledged).toEqual({ by: other.by, at: fired + 9 * MIN })

    // Repeats stop while it is acknowledged: 4 h and more pass, nothing new is sent.
    await s.until(fired + 4 * HOUR + 30 * MIN)
    expect(s.w.received.length).toBe(2)

    // Un-acknowledge: the overdue repeat goes out.
    const unack = await call(s.key.auth, 'POST', `/api/v1/monitors/${id}/unacknowledge`, {})
    expect(unack.json).toMatchObject({ unacknowledged: [fp], by: s.key.by })
    await s.until(world.now + 2 * MIN)
    expect(s.w.received.length).toBe(4)
    expect((await s.get(id)).monitor.acknowledged).toBeNull()

    // Silence for 1 h: scoped to this alert, undoable for a short window.
    const t0 = world.now
    const sil = await call(s.key.auth, 'POST', `/api/v1/monitors/${id}/silence`, { duration: '1h' })
    expect(sil.json).toMatchObject({ dryRun: false, silenced: [fp], undoUntil: t0 + 60_000 })
    expect(sil.json.undoToken).toMatch(/^[0-9a-f]{32}$/)
    expect(sil.json.silences[0]).toMatchObject({ endsAt: t0 + HOUR, createdBy: s.key.by, state: 'active' })
    expect(sil.json.silences[0].matchers).toEqual([
      { name: 'alertname', value: 'checkout p99 latency', isRegex: false, isEqual: true }, { name: 'service', value: 'checkout-api', isRegex: false, isEqual: true }, { name: 'viz_receiver', value: 'payments-oncall', isRegex: false, isEqual: true },
    ])
    m = (await s.list('?filter=silenced')).monitors[0]!
    expect(m).toMatchObject({ state: 'firing', silencedUntil: t0 + HOUR })
    expect(m.alerts[0]).toMatchObject({ silencedUntil: t0 + HOUR, nextRepeatAt: null })
    const silences = await call(s.key.auth, 'GET', '/api/v1/monitors/silences')
    expect(silences.json.silences.length).toBe(1)
    expect(silences.text).not.toContain(sil.json.undoToken) // the token is returned once, by the call that made it
    // Undo: as if it had never been made.
    world.now = t0 + 20_000
    expect((await call(s.key.auth, 'POST', '/api/v1/monitors/silences/undo', { undoToken: sil.json.undoToken })).json).toEqual({ dryRun: false, removed: [sil.json.silences[0].id] })
    expect((await call(s.key.auth, 'GET', '/api/v1/monitors/silences')).json.silences).toEqual([])
    expect((await s.list()).monitors[0]!.silencedUntil).toBeNull()
    expect((await call(s.key.auth, 'POST', '/api/v1/monitors/silences/undo', { undoToken: sil.json.undoToken })).status).toBe(404)

    // Silence again; after the window the token no longer undoes, and the silence is ended instead.
    const sil2 = await call(s.key.auth, 'POST', `/api/v1/monitors/${id}/silence`, { duration: '4h', comment: 'deploy in progress' })
    world.now += 61_000
    const late = await call(s.key.auth, 'POST', '/api/v1/monitors/silences/undo', { undoToken: sil2.json.undoToken })
    expect(late.status).toBe(410)
    expect((await s.list()).monitors[0]!.silencedUntil).toBe(sil2.json.silences[0].endsAt)
    const sid = sil2.json.silences[0].id as string
    expect((await call(s.key.auth, 'DELETE', `/api/v1/monitors/silences/${sid}?dryRun=true`)).json).toEqual({ dryRun: true, expired: sid })
    expect((await s.list()).monitors[0]!.silencedUntil).not.toBeNull()
    expect((await call(s.key.auth, 'DELETE', `/api/v1/monitors/silences/${sid}`)).status).toBe(200)
    expect((await call(s.key.auth, 'GET', '/api/v1/monitors/silences')).json.silences).toMatchObject([{ id: sid, state: 'expired', comment: 'deploy in progress' }])
    expect((await s.list()).monitors[0]!.silencedUntil).toBeNull()

    // Below the threshold again: resolved, and the receivers are told.
    await s.tick()
    value = 402
    const resolved = await s.tick()
    await s.until(resolved + 2 * MIN)
    m = (await s.list()).monitors[0]!
    expect(m).toMatchObject({ state: 'ok', firingSince: null, activeAt: null, value: null, alerts: [], acknowledged: null })
    expect((await s.list('?filter=attention')).monitors).toEqual([])

    // The history: complete, in order, with who and what.
    const h = (await s.get(id)).history
    expect(h.dropped).toBe(0)
    expect(kinds(h.entries)).toEqual([
      'created', 'pending', 'firing', 'notified:webhook[0]:firing', 'notified:slack[0]:firing', 'acknowledged', 'unacknowledged',
      'notified:webhook[0]:firing:repeat', 'notified:slack[0]:firing:repeat', 'silenced', 'silence_undone', 'silenced', 'silence_expired', 'resolved', 'notified:webhook[0]:resolved', 'notified:slack[0]:resolved',
    ])
    expect(h.entries[0]).toEqual({ at: createdAt, source: 'ruler', kind: 'created', by: s.key.by })
    expect(h.entries[1]).toMatchObject({ at: above, kind: 'pending', value: 531, fingerprint: fp, labels: { service: 'checkout-api' }, noData: false })
    expect(h.entries[2]).toMatchObject({ at: fired, kind: 'firing', value: 742 })
    expect(h.entries[3]).toMatchObject({ at: fired, kind: 'notified', receiver: 'payments-oncall', integration: 'webhook[0]', channel: null, status: 'firing', repeat: false, fingerprints: [fp], deliveredAt: fired, failed: null })
    expect(h.entries[4]).toMatchObject({ receiver: 'payments-oncall', integration: 'slack[0]', channel: '#payments-alerts', deliveredAt: fired })
    expect(h.entries[5]).toEqual({ at: fired + 9 * MIN, source: 'notifier', kind: 'acknowledged', by: other.by, fingerprints: [fp] })
    expect(h.entries[6]).toMatchObject({ kind: 'unacknowledged', by: s.key.by })
    expect(h.entries[9]).toMatchObject({ kind: 'silenced', by: s.key.by, until: t0 + HOUR, fingerprints: [fp] })
    expect(h.entries[13]).toMatchObject({ at: resolved, kind: 'resolved', value: 742 })
    // Each notification's key in the history is the key the receiver saw.
    const sentKeys = s.w.received.map((r) => r.key).sort()
    expect(h.entries.flatMap((e) => (e.kind === 'notified' ? [e.idempotencyKey] : [])).sort()).toEqual(sentKeys)
    for (let i = 1; i < h.entries.length; i++) expect(h.entries[i]!.at).toBeGreaterThanOrEqual(h.entries[i - 1]!.at)
  })

  it('acknowledge and silence dry runs say what they would touch and change nothing; a pending alert cannot be acted on yet', async () => {
    const s = await scene()
    const id = (await call(s.key.auth, 'POST', '/api/v1/monitors', { ...checkout, for: '0s' })).json.id as string
    s.w.evaluate = () => vec([{ service: 'a' }, 900], [{ service: 'b' }, 800])
    await s.tick()
    const fps = (await s.get(id)).monitor.alerts.map((a) => a.fingerprint).sort()
    const dry = await call(s.key.auth, 'POST', `/api/v1/monitors/${id}/acknowledge?dryRun=true`, {})
    expect(dry.json).toMatchObject({ dryRun: true })
    expect(dry.json.acknowledged.sort()).toEqual(fps)
    const drySilence = await call(s.key.auth, 'POST', `/api/v1/monitors/${id}/silence`, { duration: '15m', dryRun: true })
    expect(drySilence.json).toMatchObject({ dryRun: true, undoToken: null })
    expect(drySilence.json.silences.length).toBe(2)
    const m = (await s.get(id)).monitor
    expect(m.acknowledged).toBeNull()
    expect(m.silencedUntil).toBeNull()
    expect((await call(s.key.auth, 'GET', '/api/v1/monitors/silences')).json.silences).toEqual([])
    // One alert of two: the monitor as a whole is not "acknowledged" until both are.
    const one = await call(s.key.auth, 'POST', `/api/v1/monitors/${id}/acknowledge`, { fingerprint: fps[0] })
    expect(one.json.acknowledged).toEqual([fps[0]])
    const after = (await s.get(id)).monitor
    expect(after.acknowledged).toBeNull()
    expect(after.alerts.map((a) => a.acknowledged !== null).sort()).toEqual([false, true])
    expect((await call(s.key.auth, 'POST', `/api/v1/monitors/${id}/acknowledge`, { fingerprint: 'ffffffffffffffff' })).status).toBe(404)
    expect((await call(s.key.auth, 'POST', `/api/v1/monitors/${id}/silence`, {})).json.problems).toMatchObject([{ path: 'duration' }])
    expect((await call(s.key.auth, 'POST', `/api/v1/monitors/${id}/silence`, { duration: '90d' })).json.problems).toMatchObject([{ path: 'duration' }])
  })

  it('the history is bounded: the oldest entries are dropped and counted, in the ruler\'s transition log and in the notifier\'s log', async () => {
    const s = await scene({ rulerConfig: { timelineLimit: 12 } })
    const saved = DEFAULT_NOTIFIER_LIMITS.logLimit
    DEFAULT_NOTIFIER_LIMITS.logLimit = 8
    try {
      const id = (await call(s.key.auth, 'POST', '/api/v1/monitors', { name: 'flappy', expr: 'flap > 0', notify: 'default' })).json.id as string
      let up = false
      s.w.evaluate = () => (up ? vec([{ i: '1' }, 1]) : vec())
      let last = 0
      for (let i = 0; i < 60; i++) {
        up = !up
        last = await s.tick()
      }
      await s.until(last + 2 * MIN)
      const fromRuler = ok(await s.ruler.timeline(s.tenant, id))
      expect(fromRuler.entries.length).toBe(12)
      expect(fromRuler.dropped).toBe(1 + 60 - 12) // "created" and 60 transitions were written
      expect(fromRuler.entries.at(-1)).toMatchObject({ at: last, kind: 'resolved' })
      const fromNotifier = ok(await s.notifier.notificationLog(s.tenant, id))
      expect(fromNotifier.entries.length).toBe(8)
      expect(fromNotifier.dropped).toBeGreaterThan(20)
      const h = (await s.get(id)).history
      expect(h.entries.length).toBe(20)
      expect(h.dropped).toBe(fromRuler.dropped + fromNotifier.dropped) // the reader is told the history is cut
      // The stored rows stay small however long the monitor flaps.
      const more = ok(await s.ruler.timeline(s.tenant, id))
      expect(JSON.stringify(more).length).toBeLessThan(4000)
    } finally {
      DEFAULT_NOTIFIER_LIMITS.logLimit = saved
    }
  })

  it('a failing rule is state "error" with the engine\'s message; missing data under "keep" is state "no_data"', async () => {
    const s = await scene()
    const a = (await call(s.key.auth, 'POST', '/api/v1/monitors', { name: 'broken', expr: 'nope(' + 'x) > 1' })).json.id as string
    const b = (await call(s.key.auth, 'POST', '/api/v1/monitors', { name: 'quiet', query: 'gone', condition: { op: '>', threshold: 1 }, noData: 'keep' })).json.id as string
    s.w.evaluate = (q) => {
      if (q.startsWith('nope')) throw new Error('1:1: parse error: unknown function "nope"')
      return vec()
    }
    await s.tick()
    expect((await s.get(a)).monitor).toMatchObject({ state: 'error', health: 'err', lastError: '1:1: parse error: unknown function "nope"' })
    expect((await s.get(b)).monitor).toMatchObject({ state: 'no_data', health: 'ok', noData: 'keep' })
    expect((await s.list()).counts).toMatchObject({ error: 1, no_data: 1 })
    expect((await s.list('?filter=attention')).total).toBe(2)
    expect((await call(s.key.auth, 'GET', '/api/v1/monitors?filter=mine')).status).toBe(400)
  })
})

describe('updating and deleting a monitor', () => {
  it('an edit keeps the id and the history; alert state survives when the expression is unchanged and restarts when it changes', async () => {
    const s = await scene()
    const editor = await apiKey(s.tenant)
    const id = (await call(s.key.auth, 'POST', '/api/v1/monitors', checkout)).json.id as string
    s.w.evaluate = () => vec([{ service: 'checkout-api' }, 900])
    const above = await s.tick()
    world.now += 10_000
    // Only the message changes: same rule, same alert, `for` keeps counting.
    const edit1 = await call(editor.auth, 'PUT', `/api/v1/monitors/${id}`, { ...checkout, message: 'checkout is slow' })
    expect(edit1.status).toBe(200)
    expect(edit1.json).toMatchObject({ id, group: 'monitors/1m' })
    expect((await s.get(id)).monitor).toMatchObject({ id, message: 'checkout is slow', state: 'pending', activeAt: above })
    for (let i = 0; i < 5; i++) await s.tick()
    expect((await s.get(id)).monitor).toMatchObject({ state: 'firing', activeAt: above, firingSince: above + 5 * MIN })
    // The threshold changes: a different expression, so the old alert is resolved and the new rule starts from nothing.
    world.now += 10_000
    const edit2 = await call(editor.auth, 'PUT', `/api/v1/monitors/${id}`, { ...checkout, condition: { op: '>', threshold: 800, unit: 'ms' } })
    expect(edit2.json.expr).toMatch(/> 800$/)
    expect((await s.get(id)).monitor).toMatchObject({ id, thresholdText: '> 800 ms for 5m', state: 'unknown', alerts: [] })
    const h = (await s.get(id)).history
    expect(kinds(h.entries).filter((k) => !k.startsWith('notified'))).toEqual(['created', 'pending', 'edited', 'firing', 'edited', 'resolved'])
    expect(h.entries.filter((e) => e.kind === 'edited').map((e) => 'by' in e && e.by)).toEqual([editor.by, editor.by])
    // A dry-run edit changes nothing.
    await call(editor.auth, 'PUT', `/api/v1/monitors/${id}?dryRun=true`, { ...checkout, name: 'renamed' })
    expect((await s.get(id)).monitor.name).toBe('checkout p99 latency')
    expect((await call(editor.auth, 'PUT', `/api/v1/monitors/${id}`, { ...checkout, for: 'x' })).json.problems).toMatchObject([{ path: 'for' }])
  })

  it('a new interval moves the monitor to the group for that interval; the id and history follow', async () => {
    const s = await scene()
    const id = (await call(s.key.auth, 'POST', '/api/v1/monitors', checkout)).json.id as string
    const other = (await call(s.key.auth, 'POST', '/api/v1/monitors', { name: 'other', expr: 'x > 1' })).json.id as string
    world.now += 30_000
    const moved = await call(s.key.auth, 'PUT', `/api/v1/monitors/${id}`, { ...checkout, interval: '5m' })
    expect(moved.json).toMatchObject({ id, group: 'monitors/5m' })
    const all = (await s.list()).monitors
    expect(all.map((m) => [m.id, m.group, m.intervalMs]).sort()).toEqual([[id, 'monitors/5m', 5 * MIN], [other, 'monitors/1m', MIN]].sort())
    expect(kinds((await s.get(id)).history.entries)).toEqual(['created', 'edited'])
    // Moving the last monitor out of a group removes the group.
    await call(s.key.auth, 'PUT', `/api/v1/monitors/${other}`, { name: 'other', expr: 'x > 1', interval: '5m' })
    expect((await call(s.key.auth, 'GET', '/api/v1/monitors/groups')).json.groups.map((g: { name: string }) => g.name)).toEqual(['monitors/5m'])
  })

  it('delete resolves the firing alert, tells the receiver, and drops the history; a dry run does none of it', async () => {
    const s = await scene()
    const id = (await call(s.key.auth, 'POST', '/api/v1/monitors', { ...checkout, for: '0s' })).json.id as string
    s.w.evaluate = () => vec([{ service: 'checkout-api' }, 900])
    await s.tick()
    expect((await call(s.key.auth, 'DELETE', `/api/v1/monitors/${id}?dryRun=true`)).json).toEqual({ dryRun: true, deleted: true, id, firingAlertsResolved: 1 })
    expect((await s.get(id)).monitor.state).toBe('firing')
    expect((await call(s.key.auth, 'DELETE', `/api/v1/monitors/${id}`)).json).toMatchObject({ dryRun: false, deleted: true })
    expect((await call(s.key.auth, 'GET', `/api/v1/monitors/${id}`)).status).toBe(404)
    await s.until(world.now + 3 * MIN)
    expect(s.w.received.map((r) => (r.body as { status?: string; text?: string }).status ?? 'slack')).toEqual(['firing', 'slack', 'resolved', 'slack'])
    expect(ok(await s.ruler.timeline(s.tenant, id))).toMatchObject({ entries: [], dropped: 0 })
    expect(ok(await s.notifier.notificationLog(s.tenant, id))).toMatchObject({ entries: [], dropped: 0 })
    expect((await call(s.key.auth, 'DELETE', `/api/v1/monitors/${id}`)).status).toBe(404)
  })

  it('a rule saved without monitor metadata is listed, can be read and deleted, and says it has no history; editing it as a monitor is refused with the way out', async () => {
    const s = await scene()
    ok(await s.ruler.saveGroups(s.tenant, { groups: [{ name: 'raw', interval: '1m', rules: [{ alert: 'Bare', expr: 'up == 0', annotations: { summary: 'down', runbook_url: 'https://r.test/x' } }] }] }))
    const m = (await s.list()).monitors[0]!
    expect(m).toMatchObject({ name: 'Bare', group: 'raw', historyRecorded: false, message: 'down', runbookUrl: 'https://r.test/x', thresholdText: null })
    expect(m.id).toMatch(/^r_[0-9a-f]{16}$/)
    expect((await s.get(m.id)).history).toEqual({ entries: [], dropped: 0 })
    const edit = await call(s.key.auth, 'PUT', `/api/v1/monitors/${m.id}`, { name: 'Bare', expr: 'up == 0' })
    expect(edit.status).toBe(409)
    expect(edit.json.error.message).toMatch(/\/api\/v1\/monitors\/groups/)
    expect((await call(s.key.auth, 'DELETE', `/api/v1/monitors/${m.id}`)).status).toBe(200)
    expect((await s.list()).total).toBe(0)
  })
})

describe('rule groups and rule files over HTTP', () => {
  it('imports a kube-prometheus style YAML file (dry run first), lists it, exports it back, and a re-import changes nothing', async () => {
    const s = await scene()
    const dry = await call(s.key.auth, 'POST', '/api/v1/monitors/rulefile?dryRun=true', kubernetesApps)
    expect(dry.status).toBe(200)
    expect(dry.json).toMatchObject({ dryRun: true, groups: [{ name: 'kubernetes-apps', shard: '0', intervalMs: 30_000 }] })
    expect(dry.json.groups[0].rules.map((r: { name: string; cost: { class: string } }) => [r.name, r.cost.class])).toEqual([['KubePodCrashLooping', 'tail'], ['KubeDeploymentReplicasMismatch', 'recent'], ['KubeJobFailed', 'tail']].map(([n, c], i) => [n, i === 1 ? expect.any(String) : c]))
    expect((await s.list()).total).toBe(0)
    const saved = await call(s.key.auth, 'POST', '/api/v1/monitors/rulefile', kubernetesApps)
    expect(saved.json.dryRun).toBe(false)
    const monitors = (await s.list()).monitors
    expect(monitors.map((m) => m.name)).toEqual(['KubePodCrashLooping', 'KubeDeploymentReplicasMismatch', 'KubeJobFailed'])
    // Rules saved through the API are monitors: an id, a history, and the presentation taken from the annotations.
    expect(monitors.every((m) => /^mon_[0-9a-f]{16}$/.test(m.id) && m.historyRecorded)).toBe(true)
    expect(monitors[0]).toMatchObject({ message: 'Pod is crash looping.', runbookUrl: 'https://runbooks.prometheus-operator.dev/runbooks/kubernetes/kubepodcrashlooping', forMs: 15 * MIN })
    expect(monitors[1]!.keepFiringForMs).toBe(5 * MIN)

    s.w.evaluate = (q) => (q.includes('CrashLoopBackOff') ? vec([{ namespace: 'shop', pod: 'cart-1', container: 'cart' }, 1]) : vec())
    const t1 = await s.tick()
    const before = (await s.get(monitors[0]!.id))
    expect(before.monitor).toMatchObject({ state: 'pending', activeAt: t1 })

    // Export without viz's fields: a file Prometheus loads, saying what was left out.
    const plain = await call(s.key.auth, 'GET', '/api/v1/monitors/rulefile?extensions=false')
    expect(plain.headers.get('content-type')).toMatch(/application\/yaml/)
    expect(plain.headers.get('x-viz-dropped-fields')).toBe('3')
    expect(plain.text).toMatch(/^# Left out because Prometheus has no such field \(3\):/)
    expect(plain.text).not.toMatch(/^\s*monitor:/m)
    // Re-importing that export is a no-op: same ids, no "edited" entry, alert state intact.
    world.now += 5_000
    expect((await call(s.key.auth, 'POST', '/api/v1/monitors/rulefile', plain.text)).status).toBe(200)
    const after = await s.get(monitors[0]!.id)
    expect(after.monitor).toMatchObject({ id: monitors[0]!.id, state: 'pending', activeAt: t1 })
    expect(kinds(after.history.entries)).toEqual(['created', 'pending'])
    // With extensions the export carries the monitor blocks and round-trips exactly.
    const full = await call(s.key.auth, 'GET', '/api/v1/monitors/rulefile')
    expect(full.text).toMatch(/monitor:/)
    expect((await call(s.key.auth, 'POST', '/api/v1/monitors/rulefile?dryRun=true', full.text)).status).toBe(200)
    const groupsBefore = (await call(s.key.auth, 'GET', '/api/v1/monitors/groups')).json
    await call(s.key.auth, 'POST', '/api/v1/monitors/rulefile', full.text)
    expect((await call(s.key.auth, 'GET', '/api/v1/monitors/groups')).json).toEqual(groupsBefore)
  })

  it('a YAML file with an anchor, and a file with a bad rule, are refused with the place and a fix', async () => {
    const s = await scene()
    const anchored = await call(s.key.auth, 'POST', '/api/v1/monitors/rulefile', 'groups:\n  - name: g\n    rules:\n      - alert: A\n        expr: up == 0\n        labels: &l\n          severity: page\n')
    expect(anchored.status).toBe(422)
    expect(anchored.json.problems).toEqual([{ path: 'line 6', message: 'line 6: anchors (&name) are not supported', fix: 'Write the value out where it is used.' }])
    const bad = await call(s.key.auth, 'POST', '/api/v1/monitors/rulefile', 'groups:\n  - name: g\n    rules:\n      - alert: A\n        expr: up == 0\n      - alert: B\n        expr: up == 0\n        for: soon\n  - name: h\n    interval: 1s\n    rules: []\n')
    expect((bad.json.problems as { path: string }[]).map((p) => p.path).sort()).toEqual(['groups[0].rules[1].for', 'groups[1].interval'])
    expect((await s.list()).total).toBe(0)
    expect((await call(s.key.auth, 'POST', '/api/v1/monitors/rulefile', { groups: 'none' })).status).toBe(422)
  })

  it('a group is created, replaced, listed and deleted by name; JSON and YAML are the same document', async () => {
    const s = await scene()
    const put = await call(s.key.auth, 'PUT', '/api/v1/monitors/groups/http.rules', { interval: '1m', rules: [{ record: 'job:req:rate5m', expr: 'sum by (job) (rate(http_requests_total[5m]))' }, { alert: 'High', expr: 'job:req:rate5m > 100', for: '2m', labels: { severity: 'page' } }] })
    expect(put.status).toBe(200)
    expect(put.json.groups[0].rules.map((r: { kind: string }) => r.kind)).toEqual(['record', 'alert'])
    expect((await call(s.key.auth, 'PUT', '/api/v1/monitors/groups/http.rules', { name: 'other', rules: [] })).json.problems).toMatchObject([{ path: 'name' }])
    expect((await call(s.key.auth, 'PUT', '/api/v1/monitors/groups/http.rules?dryRun=true', { rules: [{ alert: 'Only', expr: 'up' }] })).json.dryRun).toBe(true)
    const listed = (await call(s.key.auth, 'GET', '/api/v1/monitors/groups')).json.groups
    expect(listed).toMatchObject([{ name: 'http.rules', interval: '1m', shard: '0', rules: [{ record: 'job:req:rate5m' }, { alert: 'High', for: '2m', labels: { severity: 'page' }, monitor: { id: expect.stringMatching(/^mon_/) } }] }])
    expect((await call(s.key.auth, 'PUT', '/api/v1/monitors/groups/viz:deadman', { rules: [{ alert: 'x', expr: 'up' }] })).status).toBe(422)
    expect((await call(s.key.auth, 'DELETE', '/api/v1/monitors/groups/http.rules?dryRun=true')).json).toEqual({ dryRun: true, deleted: 'http.rules', monitors: 1 })
    expect((await call(s.key.auth, 'DELETE', '/api/v1/monitors/groups/http.rules')).status).toBe(200)
    expect((await call(s.key.auth, 'GET', '/api/v1/monitors/groups')).json.groups).toEqual([])
    expect((await call(s.key.auth, 'DELETE', '/api/v1/monitors/groups/http.rules')).status).toBe(404)
  })

  it('backtest over HTTP takes the monitor about to be saved and returns intervals and summary', async () => {
    const s = await scene()
    s.w.range = (q, from, to, step) => ({
      resultType: 'matrix',
      // By time, as an engine evaluates (a backtest may read the range in several windows).
      result: [{ metric: { service: 'cart' }, values: Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i): [number, string] => [(from + i * step) / 1000, (from + i * step - T0) / step >= 10 && (from + i * step - T0) / step < 30 ? '0.02' : '0.004']).filter((v) => !q.includes('>') || Number(v[1]) > 0.01) }],
    })
    const body = { monitor: { name: 'cart error rate', query: 'ratio', condition: { op: '>', threshold: 0.01 }, for: '10m', noData: 'keep' }, fromMs: T0, toMs: T0 + HOUR, step: '1m' }
    const res = await call(s.key.auth, 'POST', '/api/v1/monitors/backtest', body)
    expect(res.status).toBe(200)
    expect(res.json.intervals.map((i: { state: string; startMs: number; endMs: number }) => [i.state, (i.startMs - T0) / MIN, (i.endMs - T0) / MIN])).toEqual([['pending', 10, 20], ['firing', 20, 30]])
    expect(res.json.summary).toMatchObject({ firingCount: 1, firingMs: 10 * MIN })
    expect(res.json.resolution.note).toMatch(/Evaluated every 1m/)
    expect(new Set(s.w.rangeCalls.map((c) => c[0]))).toEqual(new Set(['(ratio) > 0.01', 'ratio']))
    expectWindows(s.w.rangeCalls, '(ratio) > 0.01', T0, T0 + HOUR, MIN)
    expect((await s.list()).total).toBe(0) // a backtest saves nothing
    expect((await call(s.key.auth, 'POST', '/api/v1/monitors/backtest', { ...body, step: undefined })).json.problems).toMatchObject([{ path: 'step' }])
    expect((await call(s.key.auth, 'POST', '/api/v1/monitors/backtest', { ...body, monitor: { name: 'x' } })).json.problems).toMatchObject([{ path: 'monitor.query' }])
    s.w.range = () => {
      throw new Error('engine: range too long')
    }
    const failed = await call(s.key.auth, 'POST', '/api/v1/monitors/backtest', body)
    expect(failed.status).toBe(502)
    expect(failed.json.error).toEqual({ code: 'evaluation_failed', message: 'engine: range too long' })
  })
})

describe('outbound webhook authentication: a per-route secret, never returned', () => {
  async function hmac(secret: string, text: string) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  it('signs each request with HMAC-SHA256 over time, idempotency key and body; a receiver can verify it, and a tampered body or a stale time fails', async () => {
    const s = await scene()
    await call(s.key.auth, 'POST', '/api/v1/monitors', { ...checkout, for: '0s' })
    s.w.evaluate = () => vec([{ service: 'checkout-api' }, 900])
    const at = await s.tick()
    const pager = s.w.received.find((r) => r.url.includes('pager'))!
    const slack = s.w.received.find((r) => r.url.includes('slack'))!
    expect(slack.signature).toBeNull() // no secret configured for that integration
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(pager.signature as string)!
    expect(Number(m[1])).toBe(Math.floor(at / 1000))
    // Computed here from the documented formula, independently of the notifier's code.
    expect(m[2]).toBe(await hmac(SECRET, `${m[1]}.${pager.key}.${pager.raw}`))
    expect(await verifySignature(SECRET, pager.signature!, pager.key!, pager.raw!, at)).toBe(true)
    expect(await verifySignature(SECRET, pager.signature!, pager.key!, pager.raw! + ' ', at)).toBe(false)
    expect(await verifySignature(SECRET, pager.signature!, 'another-key', pager.raw!, at)).toBe(false)
    expect(await verifySignature('wrong-secret-0123456789', pager.signature!, pager.key!, pager.raw!, at)).toBe(false)
    expect(await verifySignature(SECRET, pager.signature!, pager.key!, pager.raw!, at + 6 * MIN)).toBe(false)
    expect(await verifySignature(SECRET, null, pager.key!, pager.raw!, at)).toBe(false)
  })

  it('a retry is signed again with the time of the attempt, under the same idempotency key', async () => {
    const s = await scene()
    await call(s.key.auth, 'POST', '/api/v1/monitors', { ...checkout, for: '0s' })
    s.w.evaluate = () => vec([{ service: 'checkout-api' }, 900])
    s.w.respond = (req, n) => (req.url.includes('pager') && n < 2 ? 500 : 200)
    const at = await s.tick()
    await s.until(at + MIN)
    const attempts = s.w.received.filter((r) => r.url.includes('pager'))
    expect(attempts.length).toBeGreaterThanOrEqual(2)
    expect(new Set(attempts.map((r) => r.key)).size).toBe(1)
    expect(new Set(attempts.map((r) => r.signature)).size).toBe(attempts.length)
    for (const r of attempts) expect(await verifySignature(SECRET, r.signature!, r.key!, r.raw!, r.at)).toBe(true)
  })

  it('no API response and no RPC returns the secret or the Slack URL; saving again without the secret keeps it; an empty secret removes it', async () => {
    const s = await scene()
    const id = (await call(s.key.auth, 'POST', '/api/v1/monitors', { ...checkout, for: '0s' })).json.id as string
    s.w.evaluate = () => vec([{ service: 'checkout-api' }, 900])
    await s.tick()
    const everything = [
      await call(s.key.auth, 'GET', '/api/v1/monitors/notifier'), await call(s.key.auth, 'GET', '/api/v1/monitors'), await call(s.key.auth, 'GET', `/api/v1/monitors/${id}`),
      await call(s.key.auth, 'GET', '/api/v1/monitors/groups'), await call(s.key.auth, 'GET', '/api/v1/monitors/rulefile'), await call(s.key.auth, 'GET', '/api/v1/rules'), await call(s.key.auth, 'GET', '/api/v1/alerts'),
      await call(s.key.auth, 'GET', '/api/v1/monitors/silences'), await call(s.key.auth, 'PUT', '/api/v1/monitors/notifier', notifierConfig()), await call(s.key.auth, 'PUT', '/api/v1/monitors/notifier?dryRun=true', notifierConfig()),
    ].map((r) => r.text).join('\n') + JSON.stringify([await s.notifier.getConfig(s.tenant), await s.notifier.outbox(s.tenant), await s.notifier.listAlerts(s.tenant), await s.notifier.health(s.tenant), await s.notifier.describe(s.tenant, [])])
    expect(everything).not.toContain(SECRET)
    expect(everything).not.toContain('veryprivatetoken')
    expect(everything).not.toContain('routing=abc123')
    const shown = (await call(s.key.auth, 'GET', '/api/v1/monitors/notifier')).json
    expect(shown.config.receivers[1]).toEqual({
      name: 'payments-oncall',
      webhook_configs: [{ url: 'https://pager.test/hook?…', has_secret: true }],
      slack_configs: [{ api_url: 'https://hooks.slack.test/…', channel: '#payments-alerts', send_resolved: true }],
    })
    expect(shown.receivers[1]).toEqual({ name: 'payments-oncall', integrations: [{ kind: 'webhook', channel: null, signed: true }, { kind: 'slack', channel: '#payments-alerts', signed: false }] })

    // What the API showed can be sent straight back: the stored secret and URLs are kept.
    expect((await call(s.key.auth, 'PUT', '/api/v1/monitors/notifier', shown.config)).status).toBe(200)
    s.w.received.length = 0
    s.w.evaluate = (q) => (q.includes('> 500') ? vec() : vec([{ service: 'checkout-api' }, 100])) // data present, below the threshold
    const t = await s.tick()
    await s.until(t + 2 * MIN)
    const pager = s.w.received.find((r) => r.url.includes('pager'))!
    expect(pager.url).toBe('https://pager.test/hook?routing=abc123')
    expect(await verifySignature(SECRET, pager.signature!, pager.key!, pager.raw!, pager.at)).toBe(true)
    expect(s.w.received.some((r) => r.url === SLACK_URL)).toBe(true)

    // An empty secret removes it: the next notification is unsigned.
    const cfg = notifierConfig('')
    expect((await call(s.key.auth, 'PUT', '/api/v1/monitors/notifier', cfg)).json.receivers[1].integrations[0].signed).toBe(false)
    s.w.received.length = 0
    s.w.evaluate = () => vec([{ service: 'checkout-api' }, 900])
    const t2 = await s.tick()
    await s.until(t2 + 2 * MIN)
    expect(s.w.received.find((r) => r.url.includes('pager'))!.signature).toBeNull()
    // A secret that is too short to be one is refused.
    expect((await call(s.key.auth, 'PUT', '/api/v1/monitors/notifier', notifierConfig('short'))).json.problems).toMatchObject([{ path: 'receivers[1].webhook_configs[0].secret' }])
  })
})
