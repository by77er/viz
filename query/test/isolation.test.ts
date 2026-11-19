/**
 * Tenant isolation over HTTP. Two tenants share BOTH shard objects (and the bucket, the
 * leaves and the cache); tenant B's key must never see anything of tenant A's through any
 * endpoint, and nothing in a request can change which tenant it is for.
 *
 * Tenant A's data is recognisable: metric `a_only_metric`, label `a_only_label`, values
 * `a-only-value` and `tenant-a`. Tenant B has the mirror image. Both have series with
 * byte-identical label sets (the same series ids) and different values.
 */
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeKey } from '../../edge/test/helpers'
import { QUERIES, type Tenant, type World, api, discardAll, expected, flushAll, ingest, run, sealAll, seriesIn, shardOf, workload, world } from './world'

let w: World
const END = workload.end
const sec = (ms: number): string => String(ms / 1000)
const MARKS = { a: ['a_only_metric', 'a_only_label', 'a-only-value', 'tenant-a'], b: ['b_only_metric', 'b_only_label', 'b-only-value', 'tenant-b'] }
const other = (t: Tenant): Tenant => (t.which === 'a' ? w.b : w.a)

/** Calls that between them list everything a tenant has, through every endpoint. */
const SWEEP: [string, [string, string][]][] = [
  ['/api/v1/labels', []],
  ['/api/v1/label/__name__/values', []],
  ['/api/v1/label/owner/values', []],
  ['/api/v1/label/a_only_label/values', []],
  ['/api/v1/label/b_only_label/values', []],
  ['/api/v1/label/job/values', [['match[]', '{job="private"}']]],
  ['/api/v1/series', [['match[]', '{__name__=~".+"}']]],
  ['/api/v1/series', [['match[]', 'a_only_metric'], ['match[]', 'b_only_metric']]],
  ['/api/v1/query', [['query', '{__name__=~".+"}'], ['time', sec(END)]]],
  ['/api/v1/query', [['query', 'a_only_metric or b_only_metric'], ['time', sec(END)]]],
  ['/api/v1/query', [['query', 'count by (__name__, owner)({job="private"})'], ['time', sec(END)]]],
  ['/api/v1/query', [['query', '{__name__=~".+"}[30m]'], ['time', sec(END)]]],
  ['/api/v1/query_range', [['query', '{owner=~"tenant-.*"}'], ['start', sec(END - 600_000)], ['end', sec(END)], ['step', '60']]],
  ['/api/v1/query_range', [['query', 'sum by (owner)(rate({__name__=~".+_only_metric"}[5m]))'], ['start', sec(END - 600_000)], ['end', sec(END)], ['step', '60']]],
]

async function sweep(t: Tenant, moment: string): Promise<void> {
  for (const [path, params] of SWEEP) {
    const res = await api(t.key, path, params)
    const body = await res.text()
    expect(res.status, `${moment} ${path}`).toBe(200)
    // Not vacuous: the tenant's own marks are there when asked for …
    if (path.endsWith('/labels') || path.endsWith('__name__/values') || params.some(([, v]) => v.includes('.+'))) expect(MARKS[t.which].some((m) => body.includes(m)), `${moment} ${path}: ${t.which} does not see its own data`).toBe(true)
    // … and none of the other tenant's, ever.
    for (const mark of MARKS[other(t).which]) expect(body, `${moment}: ${t.which} sees ${mark} via ${path} ${JSON.stringify(params)}`).not.toContain(mark)
  }
}

beforeAll(async () => {
  w = await world()
  await ingest(w)
})

describe('tenant isolation', () => {
  it('no endpoint shows one tenant the other tenant’s series, names or values: in the tail, in lake + tail, and in the lake', async () => {
    // Both tenants have a stream in both shards.
    for (const t of [w.a, w.b]) for (const s of w.shards) expect((await shardOf(s).describe(t.name))?.nextSeq).toBeGreaterThan(1)
    const shared = async (t: Tenant) => (await (await api(t.key, '/api/v1/query', { query: 'shared_metric', time: sec(END) })).json<{ data: { result: { metric: Record<string, string>; value: [number, string] }[] } }>()).data.result
    const moment = async (name: string) => {
      await sweep(w.a, name)
      await sweep(w.b, name)
      // The series with the SAME labels (and series id) in both tenants: each sees its own values.
      const [a, b] = [await shared(w.a), await shared(w.b)]
      expect(a.map((s) => s.metric)).toEqual(b.map((s) => s.metric))
      expect(a[0]!.value[1]).toBe('120')
      expect(b[0]!.value[1]).toBe('1120')
      // Label listings are exactly the tenant's own.
      for (const t of [w.a, w.b]) {
        const names = await (await api(t.key, '/api/v1/label/__name__/values')).json<{ data: string[] }>()
        expect(names.data, name).toEqual([...new Set(seriesIn(t.which).map((l) => l.__name__!))].sort())
      }
    }
    await moment('all tail')
    await flushAll(w)
    await moment('lake + tail')
    await sealAll(w)
    await flushAll(w)
    await discardAll(w)
    await moment('all lake')
    // The whole query table still answers per tenant (the files are in the shared cache now).
    for (const t of [w.a, w.b]) for (const q of QUERIES.slice(0, 12)) expect(await (await run(t.key, q)).json(), q.id).toEqual(expected[t.which][q.id])
  })

  it('a tenant with no data sees nothing, whoever else uses the same shards', async () => {
    const empty = `tenant-empty-${Date.now().toString(36)}`
    await (await import('../../edge/test/helpers')).setPool(empty, w.map)
    const key = await makeKey(empty, { scopes: ['read'] })
    expect(await (await api(key, '/api/v1/labels')).json()).toEqual({ status: 'success', data: [] })
    expect(await (await api(key, '/api/v1/series', { 'match[]': '{__name__=~".+"}' })).json()).toEqual({ status: 'success', data: [] })
    expect(await (await api(key, '/api/v1/query', { query: '{__name__=~".+"}', time: sec(END) })).json()).toEqual({ status: 'success', data: { resultType: 'vector', result: [] } })
  })

  it('fuzz: no header, parameter or path trick makes a request read another tenant', async () => {
    let seed = 0x5eed
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
      return (seed >>> 8) % n
    }
    const pick = <T>(xs: T[]): T => xs[rnd(xs.length)]!
    const victim = w.a
    const attacker = w.b
    const names = [victim.name, `tenant=${victim.name}`, `../tenant=${victim.name}`, `${victim.name}/../${attacker.name}`, '*', '']
    const headerNames = ['X-Scope-OrgID', 'X-Tenant', 'X-Tenant-Id', 'X-Viz-Tenant', 'Tenant', 'X-Org-Id', 'X-Forwarded-User', 'X-Remote-User', 'Cookie', 'X-Api-Key', 'Host', 'X-Forwarded-Host', 'X-Original-URL', 'X-Rewrite-URL', 'Cf-Worker']
    const paramNames = ['tenant', 'tenant_id', 'tenantId', 'org', 'orgId', 'X-Scope-OrgID', 'namespace', 'cell', 'key', 'user', '__tenant__']
    const prefixes = ['', `/tenant/${victim.name}`, `/${victim.name}`, `/api/v1/tenant/${victim.name}`, `/prometheus/${victim.name}`, '/.', '//', `/api/v1/../../${victim.name}`, `/%2e%2e/${victim.name}`]
    const suffixes = ['', `/${victim.name}`, `;tenant=${victim.name}`, `%2f..%2f${victim.name}`, '/', `%00${victim.name}`]
    const queries = ['{__name__=~".+"}', 'a_only_metric', `{owner="tenant-a"}`, `{__name__=~".+", tenant="${victim.name}"}`, `{__tenant__="${victim.name}", __name__=~".+"}`, 'count({__name__=~".+"}) by (owner, __name__)']
    const endpoints: [string, () => [string, string][]][] = [
      ['/api/v1/query', () => [['query', pick(queries)], ['time', sec(END)]]],
      ['/api/v1/query_range', () => [['query', pick(queries)], ['start', sec(END - 300_000)], ['end', sec(END)], ['step', '60']]],
      ['/api/v1/labels', () => []],
      ['/api/v1/label/__name__/values', () => []],
      ['/api/v1/label/owner/values', () => []],
      ['/api/v1/series', () => [['match[]', '{__name__=~".+"}']]],
    ]
    const victimKeyId = victim.key.split('_')[1]!
    // Directed first: every tenant-looking header and parameter, set to the victim's exact
    // name, on every endpoint, with the attacker's valid key.
    for (const [path, mk] of endpoints) {
      for (const h of headerNames.filter((x) => x !== 'Host')) {
        const res = await api(attacker.key, path, mk(), { headers: { [h]: victim.name } })
        const body = await res.text()
        expect(res.status, `${path} with ${h}`).toBe(200)
        for (const mark of MARKS.a) expect(body, `${path} with header ${h}`).not.toContain(mark)
      }
      for (const p of paramNames) {
        for (const method of path.includes('/label/') ? (['GET'] as const) : (['GET', 'POST'] as const)) {
          const res = await api(attacker.key, path, [...mk(), [p, victim.name]], { method })
          const body = await res.text()
          expect(res.status, `${path} with ${p}`).toBe(200)
          for (const mark of MARKS.a) expect(body, `${path} with parameter ${p}`).not.toContain(mark)
        }
      }
    }
    let answered = 0
    let total = 0
    for (let i = 0; i < 400; i++) {
      const [path, mk] = pick(endpoints)
      const params = mk()
      for (let k = rnd(3); k > 0; k--) params.push([pick(paramNames), pick(names)])
      const headers: Record<string, string> = {}
      for (let k = rnd(3); k > 0; k--) headers[pick(headerNames)] = pick([...names, `Bearer ${victimKeyId}`, `tenant=${victim.name}`])
      // Sometimes the attacker's key in a second form, and the victim's KEY ID without its secret.
      const valid = [`Bearer ${attacker.key}`, `bearer ${attacker.key}`, `Basic ${btoa(`${victim.name}:${attacker.key}`)}`]
      const auth = rnd(10) < 7 ? pick(valid) : pick([`Bearer viz_${victimKeyId}_${attacker.key.split('_').slice(2).join('_')}`, `Bearer ${attacker.key}, Bearer viz_${victimKeyId}_x`, `Bearer viz_${victimKeyId}_`])
      // Most requests keep a real path (so they are answered, with extra parameters and headers); the rest try path tricks.
      const url = `https://viz.test${rnd(10) < 7 ? '' : pick(prefixes)}${path}${rnd(10) < 7 ? '' : pick(suffixes)}?${new URLSearchParams(params).toString()}`
      const method = pick(['GET', 'POST'])
      let res: Response
      try {
        res = await exports.default.fetch(url, {
          method,
          headers: { Authorization: auth, ...headers, ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
          body: method === 'POST' ? new URLSearchParams([[pick(paramNames), victim.name]]).toString() : undefined,
        })
      } catch {
        continue // a URL the runtime itself refuses
      }
      total++
      const body = await res.text()
      if (res.status === 200) answered++
      for (const mark of MARKS.a) expect(body, `${method} ${url} ${JSON.stringify(headers)} ${auth.slice(0, 12)}`).not.toContain(mark)
      // And the cost headers never say more than "this tenant's shards and files".
      expect(res.headers.get('X-Viz-Tenant')).toBeNull()
    }
    // The fuzz is not vacuous: many requests were answered with the attacker's own data.
    expect(total).toBeGreaterThan(300)
    expect(answered).toBeGreaterThan(100)
    // Control: with the victim's key the same sweep does show the marks.
    const control = await (await api(victim.key, '/api/v1/label/__name__/values')).text()
    expect(control).toContain('a_only_metric')
  })
})
