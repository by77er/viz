/**
 * Captures for the independent readers in `tools/promcheck` (AGENTS.md, "Independent
 * readers"): the real `/api/v1/rules` and `/api/v1/alerts` responses in every state a rule
 * and an alert can be in, and each fixture rule file as viz imported and exported it.
 *
 * The files are handed to the host through the `CAPTURE` service binding (a Node function,
 * `vitest.config.ts`) and land in `ruler/.capture/`. `npm run independent` runs this file,
 * then the Go checks against Prometheus' own code. Run alone, the assertions here only
 * check that every capture was written; the shapes are judged by the Go side.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import edgeCases from './fixtures/edge-cases.yaml?raw'
import kubernetesApps from './fixtures/kubernetes-apps.yaml?raw'
import nodeExporter from './fixtures/node-exporter.yaml?raw'
import recording from './fixtures/recording.yaml?raw'
import { apiKey, call } from './api'
import { hash64 } from '../src/util'
import { tenantWorld, world, T0 } from './harness'
import { MIN, newTenant, nextTick, ok, rulerStub, vec } from './helpers'

/**
 * A group name whose evaluation times end in exactly `ms` milliseconds past the second, so
 * the capture holds times with trailing zeros (where JavaScript's and Go's printing differ).
 * Uses the ruler's offset rule; the test then checks the times really came out that way.
 */
function groupEndingIn(tenant: string, ms: number, intervalMs = MIN): string {
  for (let k = 0; ; k++) {
    const name = `round-${ms}-${k}`
    if ((parseInt(hash64(`${tenant}/0/${name}`).slice(0, 12), 16) % intervalMs) % 1000 === ms) return name
  }
}

async function capture(name: string, body: string): Promise<void> {
  const res = await env.CAPTURE.fetch(`http://capture/${name}`, { method: 'PUT', body })
  expect(res.status, name).toBe(200)
}

describe('captures for tools/promcheck', () => {
  it('/api/v1/rules and /api/v1/alerts in every state: unknown, pending, firing, err, keep_firing_for, no data, filtered, paged, errors', async () => {
    world.now = T0
    const tenant = newTenant('cap')
    const stub = rulerStub(tenant)
    const w = tenantWorld(tenant)
    ok(await stub.configure(tenant, { deadman: true, externalLabels: { cluster: 'eu-1' } }))
    let phase = 0
    w.evaluate = (q) => {
      if (q === 'broken') throw new Error('engine: query timed out')
      if (q === 'rec') return vec([{ job: 'api' }, 3], [{ job: 'web' }, '1e21'])
      if (q === 'held') return phase < 3 ? vec([{ instance: 'h' }, 2]) : vec()
      if (q === 'missing_bare') return vec()
      if (q.startsWith('(missing_bare)')) return vec()
      if (q === 'tiny') return vec([{ instance: 't' }, 1.5e-7])
      return vec([{ instance: 'a', __name__: 'm' }, 0.75], [{ instance: 'b', __name__: 'm' }, -2])
    }
    ok(await stub.saveGroups(tenant, {
      groups: [
        {
          name: 'example', interval: '1m', limit: 7, query_offset: '30s',
          rules: [
            { alert: 'HighRequestLatency', expr: 'job:request_latency_seconds:mean5m{job="myjob"} > 0.5', for: '10m', keep_firing_for: '5m', labels: { severity: 'page' }, annotations: { summary: 'High request latency on {{ $labels.instance }}', value: '{{ $value }}' } },
            { record: 'job:http_inprogress_requests:sum', expr: 'rec', labels: { source: 'viz' } },
            { alert: 'Broken', expr: 'broken' },
            { alert: 'Now', expr: 'now_expr', labels: { severity: 'ticket' } },
            { alert: 'Tiny', expr: 'tiny' },
          ],
        },
        { name: 'quiet', interval: '5m', rules: [{ alert: 'Held', expr: 'held', keep_firing_for: '30m' }] },
        { name: 'nodata', interval: '1m', rules: [{ alert: 'NoData', expr: '(missing_bare) > 1', no_data: 'alerting', no_data_for: '2m', no_data_expr: 'missing_bare' }] },
        { name: groupEndingIn(tenant, 0), interval: '1m', rules: [{ alert: 'OnTheSecond', expr: 'tiny' }] },
        { name: groupEndingIn(tenant, 500), interval: '1m', rules: [{ alert: 'OnTheHalf', expr: 'tiny' }] },
      ],
    }))
    const key = await apiKey(tenant, ['monitors:read'])
    const both = async (label: string) => {
      await capture(`api/${label}.rules.json`, (await call(key.auth, 'GET', '/api/v1/rules')).text)
      await capture(`api/${label}.alerts.json`, (await call(key.auth, 'GET', '/api/v1/alerts')).text)
    }
    await both('0-before-first-evaluation')
    const until = async (t: number) => {
      while (world.now < t) await nextTick(stub, tenant)
    }
    await until(T0 + 3 * MIN)
    phase = 1
    await both('1-pending-err-nodata')
    await until(T0 + 15 * MIN)
    phase = 2
    await both('2-firing')
    // Times with trailing zeros (".000" and ".500" in JavaScript's form) are really in the
    // capture. Only the instant is checked here; how it is printed is for the Go side to judge.
    const alerts = (await call(key.auth, 'GET', '/api/v1/alerts')).json.data.alerts as { labels: { alertname: string }; activeAt: string }[]
    expect(Date.parse(alerts.find((a) => a.labels.alertname === 'OnTheSecond')!.activeAt) % 1000).toBe(0)
    expect(Date.parse(alerts.find((a) => a.labels.alertname === 'OnTheHalf')!.activeAt) % 1000).toBe(500)
    phase = 3
    await until(T0 + 21 * MIN)
    await both('3-keep-firing-for')
    for (const [label, q] of [['type-alert', 'type=alert'], ['type-record', 'type=record'], ['exclude-alerts', 'exclude_alerts=true'], ['rule-name', 'rule_name[]=Now&rule_name[]=Held'], ['rule-group', 'rule_group[]=quiet'], ['file', 'file[]=shard-0'], ['nothing-matches', 'rule_name[]=nope']] as const) {
      const res = await call(key.auth, 'GET', `/api/v1/rules?${q}`)
      expect(res.status, q).toBe(200)
      await capture(`api/4-${label}.rules.json`, res.text)
    }
    const page1 = await call(key.auth, 'GET', '/api/v1/rules?group_limit=2')
    expect(typeof page1.json.data.groupNextToken).toBe('string')
    await capture('api/5-page-1.rules.json', page1.text)
    await capture('api/5-page-2.rules.json', (await call(key.auth, 'GET', `/api/v1/rules?group_limit=2&group_next_token=${page1.json.data.groupNextToken}`)).text)
    for (const [label, path, auth] of [
      ['bad-type', '/api/v1/rules?type=both', key.auth], ['bad-token', '/api/v1/rules?group_limit=1&group_next_token=00', key.auth], ['match', '/api/v1/rules?match[]={a="b"}', key.auth],
      ['no-key', '/api/v1/alerts', null], ['wrong-scope', '/api/v1/rules', (await apiKey(tenant, ['monitors:ack'])).auth],
    ] as const) {
      const res = await call(auth, 'GET', path)
      expect(res.status, label).toBeGreaterThanOrEqual(400)
      await capture(`api/6-${label}.${res.status}.error.json`, res.text)
    }
  })

  it('each fixture rule file as imported, and as exported with and without viz\'s fields', async () => {
    for (const [name, text] of [['kubernetes-apps', kubernetesApps], ['node-exporter', nodeExporter], ['recording', recording], ['edge-cases', edgeCases]] as const) {
      world.now = T0
      const tenant = newTenant('capfile')
      ok(await rulerStub(tenant).configure(tenant, { deadman: false }))
      const key = await apiKey(tenant)
      const imported = await call(key.auth, 'POST', '/api/v1/monitors/rulefile', text)
      expect(imported.status, `${name}: ${imported.text.slice(0, 300)}`).toBe(200)
      const plain = await call(key.auth, 'GET', '/api/v1/monitors/rulefile?extensions=false')
      const extended = await call(key.auth, 'GET', '/api/v1/monitors/rulefile')
      expect(plain.status).toBe(200)
      await capture(`rulefile/${name}.input.yaml`, text)
      await capture(`rulefile/${name}.export.yaml`, plain.text)
      await capture(`rulefile/${name}.extensions.yaml`, extended.text)
    }
  })
})
