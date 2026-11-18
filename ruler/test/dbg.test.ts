import { evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test'
import { it } from 'vitest'
import { fingerprint } from '../src/util'
import { T0, tenantWorld, world } from './harness'
import { MIN, newTenant, notifierStub, ok } from './helpers'
const SEC = 1000
const upd = (labels: Record<string, string>, status: 'firing' | 'resolved', at: number) => ({
  fingerprint: fingerprint(labels), labels, annotations: {}, status, startsAt: at, endsAt: status === 'resolved' ? at : null, value: 1, at, generator: { group: 'g', rule: 'r' }, expiresAt: null,
})
it('dbg', async () => {
  const tenant = newTenant('n')
  world.now = T0
  const stub = notifierStub(tenant)
  ok(await stub.setConfig(tenant, {
    route: { receiver: 'hook', group_by: ['alertname'], group_wait: '30s', group_interval: '5m', repeat_interval: '30m', routes: [{ receiver: 'db', match: { team: 'db' }, continue: true }] },
    receivers: [{ name: 'hook', webhook_configs: [{ url: 'https://receiver.test/hook' }] }, { name: 'db', webhook_configs: [{ url: 'https://receiver.test/db' }] }],
    inhibit_rules: [{ source_match: { alertname: 'ClusterDown' }, target_match: { severity: 'warning' }, equal: ['cluster'] }],
  }))
  ok(await stub.createSilence(tenant, { matchers: [{ name: 'instance', value: 'quiet', isRegex: false }], startsAt: T0, endsAt: T0 + 22 * MIN, createdBy: 'x', comment: 'y' }))
  const A = (instance: string, extra: Record<string, string> = {}) => ({ alertname: 'Down', instance, ...extra })
  const steps: [number, any][] = [
    [0, upd(A('a', { team: 'db' }), 'firing', T0)],
    [5 * SEC, upd(A('quiet'), 'firing', T0 + 5 * SEC)],
    [40 * SEC, upd({ alertname: 'ClusterDown', cluster: 'eu' }, 'firing', T0 + 40 * SEC)],
    [50 * SEC, upd({ alertname: 'Slow', severity: 'warning', cluster: 'eu' }, 'firing', T0 + 50 * SEC)],
    [8 * MIN, upd(A('b'), 'firing', T0 + 8 * MIN)],
    [12 * MIN, upd({ alertname: 'ClusterDown', cluster: 'eu' }, 'resolved', T0 + 12 * MIN)],
    [26 * MIN, upd(A('a', { team: 'db' }), 'resolved', T0 + 26 * MIN)],
  ]
  let si = 0
  const seen: number[] = []
  for (let i = 0; i < 60; i++) {
    await evictDurableObject(stub)
    const h = ok(await stub.health(tenant))
    const nextStep = si < steps.length ? T0 + steps[si]![0] : Infinity
    if (h.alarmAtMs !== null && h.alarmAtMs <= nextStep) {
      world.now = Math.max(world.now, h.alarmAtMs)
      seen.push((world.now - T0) / SEC)
      await runDurableObjectAlarm(stub)
    } else if (si < steps.length) {
      world.now = nextStep
      await stub.ingest(tenant, `${tenant}/0`, [steps[si++]![1]])
    } else break
  }
  console.log(JSON.stringify(seen), tenantWorld(tenant).received.length, JSON.stringify(await stub.health(tenant)))
})
