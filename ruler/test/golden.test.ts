/**
 * Golden formats (contracts/COMPATIBILITY.md §3, §8): what the ruler writes that another
 * release reads or relies on. One deterministic scenario on the fake clock with a fixed
 * tenant name produces the hand-off to the notifier, the stored hand-off row, the webhook
 * body, its signature and its idempotency key; pure functions give the hashes that name
 * stored state. Each file is `test/golden/formats/<format>.v<N>.json`, N = `FORMATS[format]`.
 */
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { indexPartition } from '../src/registry'
import { exportRuleFile } from '../src/rulefile'
import { bareRuleId } from '../src/ruler'
import { FORMATS } from '../src/schema'
import { jumpHash, shardOf } from '../src/placement'
import { verifySignature } from '../src/signature'
import { fingerprint, hash64 } from '../src/util'
import { expectGolden, goldenDir } from './golden'
import { tenantWorld, world } from './harness'
import { MIN, notifierStub, ok, setup, vec } from './helpers'

type Format = keyof typeof FORMATS
const file = (f: Format) => `formats/${f}.v${FORMATS[f]}.json`
const SECRET = 'golden-secret-0123456789'
const RULES = {
  groups: [
    {
      name: 'payments',
      interval: '1m',
      labels: { team: 'pay' },
      rules: [
        { alert: 'HighErrorRate', expr: 'rate(errors_total[5m]) > 0.5', for: '0s', labels: { severity: 'page' }, annotations: { summary: '{{ $labels.instance }} errors at {{ $value }}' } },
        { record: 'job:errors:rate5m', expr: 'sum by (job) (rate(errors_total[5m]))' },
      ],
    },
  ],
}

/** The scenario, once: a tenant with a fixed name, an alert that fires, a signed webhook. */
async function scenario() {
  const { tenant, stub, w } = await setup({ heartbeatMs: 30 * MIN }, 'goldenfmt')
  const notifier = notifierStub(tenant)
  ok(await notifier.setConfig(tenant, {
    route: { receiver: 'hook', group_by: ['alertname'], group_wait: '0s', group_interval: '1m', repeat_interval: '4h' },
    receivers: [{ name: 'hook', webhook_configs: [{ url: 'https://receiver.test/hook', secret: SECRET }, { url: 'https://receiver.test/plain', secret: SECRET, format: 'json' }] }],
    external_url: 'https://vis.bitcru.sh',
  }))
  const saved = ok(await stub.saveGroups(tenant, RULES))
  w.evaluate = (q) => (q.startsWith('rate(') ? vec([{ __name__: 'errors_total', instance: 'api-1', job: 'api' }, 0.75]) : vec([{ job: 'api' }, 0.75]))
  // First tick with the notifier unreachable, so the hand-off row stays and can be read as stored.
  w.notifierDown = true
  world.now = Math.max(world.now, ok(await stub.health(tenant)).alarmAtMs!)
  expect(await runDurableObjectAlarm(stub)).toBe(true)
  const handoffRow = await runInDurableObject(stub, (_i, s) => s.storage.sql.exec('SELECT updates FROM handoff WHERE tenant = ?', tenant).toArray()[0]?.updates as string)
  w.notifierDown = false
  world.now = Math.max(world.now, ok(await stub.health(tenant)).alarmAtMs!)
  expect(await runDurableObjectAlarm(stub)).toBe(true)
  for (let i = 0; i < 5 && w.received.length === 0; i++) {
    const h = ok(await notifier.health(tenant))
    if (h.alarmAtMs === null) break
    world.now = Math.max(world.now, h.alarmAtMs)
    await runDurableObjectAlarm(notifier)
  }
  const groups = ok(await stub.listGroups(tenant)).groups
  return { tenant, w, saved, handoffRow, groups }
}

describe('golden formats', () => {
  it('no format is missing a file, and no file claims a version the code does not', () => {
    const files = goldenDir('formats')
    for (const f of Object.keys(FORMATS) as Format[]) expect(files[`${f}.v${FORMATS[f]}.json`], `test/golden/${file(f)}`).toMatchObject({ format: f, version: FORMATS[f] })
    for (const [name, g] of Object.entries(files)) {
      const { format, version } = g as { format: Format; version: number }
      expect(name).toBe(`${format}.v${version}.json`)
      expect(version).toBeLessThanOrEqual(FORMATS[format])
    }
  })

  it('the hand-off, the webhook, its signature and idempotency key, and the rule-file export', async () => {
    const { tenant, w, saved, handoffRow, groups } = await scenario()
    expect(handoffRow, 'a stored hand-off row').toBeTypeOf('string')
    expect(w.ingestCalls.length).toBeGreaterThan(0)
    expectGolden(file('rpc.alert-update'), { format: 'rpc.alert-update', version: FORMATS['rpc.alert-update'], stored: handoffRow, sent: w.ingestCalls[0] })

    const first = w.received[0]!
    expect(first, 'the receiver was called').toBeDefined()
    expect(await verifySignature(SECRET, first.signature ?? null, first.key!, first.raw!, first.at)).toBe(true)
    expectGolden(file('http.webhook'), { format: 'http.webhook', version: FORMATS['http.webhook'], body: first.raw, signature: first.signature })
    expectGolden(file('id.idempotency-key'), { format: 'id.idempotency-key', version: FORMATS['id.idempotency-key'], tenant, key: first.key })
    const plain = w.received.find((r) => r.url === 'https://receiver.test/plain')!
    expect(plain, 'the plain JSON receiver was called').toBeDefined()
    expect(await verifySignature(SECRET, plain.signature ?? null, plain.key!, plain.raw!, plain.at)).toBe(true)
    expect(JSON.parse(plain.raw!).idempotencyKey).toBe(plain.key)
    expectGolden(file('http.webhook-json'), { format: 'http.webhook-json', version: FORMATS['http.webhook-json'], body: plain.raw, signature: plain.signature })

    const keys = saved.groups[0]!.rules.map((r) => ({ name: r.name, key: r.key, bareId: bareRuleId('payments', r.key) }))
    expectGolden(file('id.hashes'), {
      format: 'id.hashes',
      version: FORMATS['id.hashes'],
      ruleKeys: keys,
      fingerprint: fingerprint({ alertname: 'HighErrorRate', instance: 'api-1', job: 'api', severity: 'page', team: 'pay' }),
      hash64: Object.fromEntries(['', 'a', `${tenant}/0/payments`].map((s) => [s, hash64(s)])),
    })
    expectGolden(file('file.rules-yaml'), {
      format: 'file.rules-yaml',
      version: FORMATS['file.rules-yaml'],
      prometheus: exportRuleFile(groups, { extensions: false }).yaml,
      extended: exportRuleFile(groups, { extensions: true }).yaml,
    })
  })

  it('anomaly rules: the stored rule and its key, the stored detector state, and the explanation an alert carries', async () => {
    const { tenant, stub, w } = await setup({ heartbeatMs: 30 * MIN }, 'goldenanom')
    const saved = ok(await stub.saveGroups(tenant, {
      groups: [{
        name: 'anomalies/1m',
        interval: '1m',
        rules: [{ alert: 'LatencyAnomaly', expr: 'sum by (service) (rate(latency_ms_sum[5m]))', annotations: { summary: '{{ $labels.service }} latency' }, anomaly: { detector: 'ewma', params: { halfLifePoints: 5, k: 4, minPoints: 5 }, unit: 'ms' } }],
      }],
    }))
    const values = [100, 102, 99, 101, 100, 98, 101, 100, 99, 160]
    let i = 0
    w.evaluate = () => vec([{ service: 'checkout' }, values[Math.min(i++, values.length - 1)]!])
    for (let t = 0; t < values.length; t++) {
      world.now = Math.max(world.now, ok(await stub.health(tenant)).alarmAtMs!)
      expect(await runDurableObjectAlarm(stub)).toBe(true)
    }
    const stored = await runInDurableObject(stub, (_i, s) => ({
      spec: s.storage.sql.exec('SELECT spec FROM rule_group WHERE tenant = ?', tenant).toArray()[0]?.spec as string,
      state: s.storage.sql.exec('SELECT rule_key, chunk, body FROM anomaly_state WHERE tenant = ? ORDER BY rule_key, chunk', tenant).toArray(),
    }))
    const rule = saved.groups[0]!.rules[0]!
    expectGolden(file('store.anomaly-rule'), {
      format: 'store.anomaly-rule',
      version: FORMATS['store.anomaly-rule'],
      stored: stored.spec,
      key: rule.key,
      bareId: bareRuleId('anomalies/1m', rule.key),
      history: rule.history,
      extended: exportRuleFile(ok(await stub.listGroups(tenant)).groups, { extensions: true }).yaml,
    })
    expectGolden(file('store.anomaly-state'), {
      format: 'store.anomaly-state',
      version: FORMATS['store.anomaly-state'],
      seriesKey: fingerprint({ service: 'checkout' }),
      rows: stored.state,
    })
    const firing = w.ingestCalls.flat().find((u) => u.status === 'firing')
    expect(firing, 'the anomaly fired').toBeDefined()
    expectGolden(file('annotation.anomaly-detail'), {
      format: 'annotation.anomaly-detail',
      version: FORMATS['annotation.anomaly-detail'],
      labels: firing!.labels,
      annotations: firing!.annotations,
    })
  })

  it('id.placement: the registry partition of a tenant and the shard of a group', () => {
    expectGolden(file('id.placement'), {
      format: 'id.placement',
      version: FORMATS['id.placement'],
      indexPartition: Object.fromEntries(['acme', 'globex', 'initech', 't-1'].map((t) => [t, indexPartition(t)])),
      shardOf: Object.fromEntries(['payments', 'checkout', 'monitors/60s'].map((g) => [g, [1, 2, 3, 8, 64].map((n) => shardOf(g, n))])),
      jumpHash: [0, 1, 2, 3].map((i) => jumpHash(`k${i}`, 10)),
    })
  })
})
