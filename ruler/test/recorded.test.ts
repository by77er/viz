/**
 * Recorded samples through viz-ingest's `RecordedSamples` entrypoint (contracts/ingest.ts, D45),
 * and the Remote Write fallback for an ingest release without it (D52).
 *
 * The entrypoint is `FakeRecordedSamples` (test/harness.ts) behind a real service binding with
 * the production binding's `props`; it validates the caller, the tenant and the batch ids, and
 * keeps one value per (tenant, series, timestamp), as the write path does. Rules are evaluated
 * through the production wiring (viz-query's HTTP API with a service key from control's real
 * `Tenant`), so the only thing that differs from production is the callees.
 *
 * Properties held here:
 *   - the tenant is the Ruler object's own, passed as the first argument; no key goes with the
 *     write, and nothing goes through Remote Write while the entrypoint answers by its contract;
 *   - a write counts only once the entrypoint resolved (a rule reading the recorded series in the
 *     same tick sees it; a refusal is reported on the rule);
 *   - refusals are treated as the contract says: `unauthorized`, `invalid`, `series_limit` at
 *     once and never retried; `too_large` split by whole batches; `backpressure`, `overloaded`,
 *     `unavailable` retried in the tick, after the hint;
 *   - an ingest release without the entrypoint (a rollback window) gets the same samples by
 *     Remote Write; once the entrypoint answers again, Remote Write is not used;
 *   - a crash after the write and before the tick commits re-sends the same batches, which the
 *     write path keeps once.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiKey, call } from './api'
import { Crash, rowKey, services, T0, tenantWorld, world, type TestRuler } from './harness'
import { newTenant, notifierStub, ok, rulerStub, runNotifierUntil, vec } from './helpers'

/** A tenant provisioned in control (the queries' service key), its rules on the production wiring. */
async function provisioned(prefix: string) {
  const tenant = newTenant(prefix)
  const control = env.TENANT.get(env.TENANT.idFromName(tenant))
  await control.provision(tenant)
  const w = tenantWorld(tenant)
  w.http = true
  const monitors = await apiKey(tenant)
  const ruler = rulerStub(tenant)
  ok(await ruler.configure(tenant, { deadman: false }))
  return { tenant, w, monitors, ruler, notifier: notifierStub(tenant) }
}

type Scene = Awaited<ReturnType<typeof provisioned>>

async function putGroup(s: Scene, rules: unknown[], name = 'rec') {
  const res = await call(s.monitors.auth, 'PUT', `/api/v1/monitors/groups/${name}`, { interval: '1m', rules })
  expect(res.status, res.text).toBe(200)
}

/** The ruler's next alarm, then everything the notifier has due by then. */
async function tick(s: Scene): Promise<number> {
  const h = ok(await s.ruler.health(s.tenant))
  world.now = Math.max(h.alarmAtMs as number, world.now)
  expect(await runDurableObjectAlarm(s.ruler)).toBe(true)
  await runNotifierUntil(s.notifier, s.tenant, world.now)
  return world.now
}

const callsOf = (s: Scene) => services.recorded.filter((c) => c.tenant === s.tenant)
const remoteWrites = () => services.calls.filter((c) => c.path === '/api/v1/write')
const rulesOf = async (s: Scene) => ok(await s.ruler.rules(s.tenant)).rules
const dropped = async (s: Scene) => ok(await s.ruler.health(s.tenant)).samplesDropped
/** What the write path holds for a tenant: `<labels>@<time>` → value. */
const rowsOf = (tenant: string) =>
  Object.fromEntries([...services.rows].filter(([k]) => k.startsWith(`${tenant}|`)).map(([k, v]) => [k.slice(tenant.length + 1), v]))
const row = (labels: Record<string, string>, t: number) => rowKey('', labels, t).slice(1)

const RECORD = { record: 'job:up:sum', expr: 'sum by (job) (up)' }

let logged: string[] = []
beforeEach(() => {
  world.now = T0
  services.calls = []
  services.fail = []
  services.recorded = []
  services.refuse = []
  services.recordDelayMs = 0
  services.maxSamplesPerCall = Infinity
  services.rows = new Map()
  logged = []
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('recorded samples through the RecordedSamples entrypoint', () => {
  it('each tenant\'s samples go out with its own tenant as the argument and only its own batches; no key, no Remote Write', async () => {
    const a = await provisioned('rs-a')
    const b = await provisioned('rs-b')
    a.w.evaluate = () => vec([{ job: 'api', who: 'A' }, 3.5], [{ job: 'web', who: 'A' }, '+Inf'])
    b.w.evaluate = () => vec([{ job: 'api', who: 'B' }, 'NaN'])
    for (const s of [a, b]) await putGroup(s, [RECORD])
    for (let i = 0; i < 2; i++) for (const s of [a, b]) await tick(s)
    for (const s of [a, b]) {
      expect(callsOf(s)).toHaveLength(2)
      expect((await rulesOf(s)).map((r) => [r.health, r.lastError])).toEqual([['ok', null]])
      expect(await dropped(s)).toBe(0)
    }
    for (const c of services.recorded) {
      expect([c.caller, c.outcome]).toEqual(['viz-ruler', 'ok'])
      expect(c.batches.every((x) => x.id.startsWith(`${c.tenant as string}/0/rec/`))).toBe(true)
    }
    // Each tenant's write path holds its own series, at the two tick times the batch ids name.
    const want: [Scene, [Record<string, string>, string][]][] = [
      [a, [[{ job: 'api', who: 'A' }, '3.5'], [{ job: 'web', who: 'A' }, '+Inf']]],
      [b, [[{ job: 'api', who: 'B' }, 'NaN']]],
    ]
    for (const [s, series] of want) {
      const ts = callsOf(s).map((c) => Number(c.batches[0]!.id.split('@')[1]))
      expect(new Set(ts).size).toBe(2)
      expect(rowsOf(s.tenant)).toEqual(Object.fromEntries(ts.flatMap((t) => series.map(([l, v]) => [row({ __name__: 'job:up:sum', ...l }, t), v]))))
    }
    // The service key still reads (queries), and writes nothing.
    expect(remoteWrites()).toEqual([])
    expect(services.calls.some((c) => c.path === '/api/v1/query')).toBe(true)
  })

  it('a write counts only once the entrypoint resolved: a rule reading the recorded series in the same tick sees it, and a refusal is reported on the rule', async () => {
    const s = await provisioned('rs-ack')
    services.recordDelayMs = 60
    s.w.evaluate = (q, t) => {
      if (q === RECORD.expr) return vec([{ job: 'api' }, 2])
      // The engine sees what the write path holds at the time of the query.
      return services.rows.has(rowKey(s.tenant, { __name__: 'job:up:sum', job: 'api' }, t)) ? vec([{ job: 'api' }, 2]) : vec()
    }
    await putGroup(s, [RECORD, { alert: 'RecordedSeen', expr: 'job:up:sum > 0' }])
    await tick(s)
    const [rec, seen] = await rulesOf(s)
    expect([rec!.health, seen!.health]).toEqual(['ok', 'ok'])
    expect(seen!.alerts.map((x) => [x.state, x.labels.job])).toEqual([['firing', 'api']])
    // Refused: nothing written, and the rule says so.
    services.recordDelayMs = 0
    services.refuse = ['invalid: batch x: value "1,5" is not a Prometheus sample value; nothing was written']
    const before = callsOf(s).length
    await tick(s)
    expect(callsOf(s).length - before).toBe(1)
    const after = (await rulesOf(s))[0]!
    expect([after.health, after.lastError]).toEqual(['err', 'sink: invalid: batch x: value "1,5" is not a Prometheus sample value; nothing was written'])
    expect(await dropped(s)).toBe(1)
  })
})

describe('refusals (contracts/ingest.ts)', () => {
  it('unauthorized, invalid and series_limit are reported at once: one call each, never retried, never sent by Remote Write', async () => {
    const s = await provisioned('rs-perm')
    s.w.evaluate = () => vec([{ job: 'api' }, 1])
    await putGroup(s, [RECORD])
    // The binding's props name a caller the entrypoint does not allow: refused by the entrypoint itself.
    s.w.sinkBinding = 'OTHER_SINK'
    await tick(s)
    expect(callsOf(s).map((c) => [c.caller, c.outcome.split(':')[0]])).toEqual([['viz-mcp', 'unauthorized']])
    expect((await rulesOf(s))[0]!.lastError).toMatch(/^sink: unauthorized: /)
    s.w.sinkBinding = 'SINK'
    for (const refusal of ['invalid: tenant id must match [A-Za-z0-9_-]{1,64}', "series_limit: the tenant's limit is 10 active series; 1 new series with 1 samples refused, 0 samples of existing series written"]) {
      services.refuse = [refusal]
      const before = callsOf(s).length
      await tick(s)
      expect(callsOf(s).length - before, refusal).toBe(1)
      expect((await rulesOf(s))[0]!.lastError).toBe(`sink: ${refusal}`)
    }
    expect(await dropped(s)).toBe(3)
    expect(remoteWrites()).toEqual([])
  })

  it('overloaded and backpressure are retried in the tick after the hint; unavailable at once; three failures are reported and counted', async () => {
    const s = await provisioned('rs-retry')
    s.w.evaluate = () => vec([{ job: 'api' }, 1])
    await putGroup(s, [RECORD])
    services.refuse = ['overloaded: ingest shard is overloaded; retry after 300 ms', 'backpressure: ingest buffer is full; retry after 300 ms']
    const t1 = await tick(s)
    const calls = callsOf(s)
    expect(calls.map((c) => c.outcome.split(':')[0])).toEqual(['overloaded', 'backpressure', 'ok'])
    expect(calls[1]!.at - calls[0]!.at, 'waited for the hint').toBeGreaterThanOrEqual(280)
    expect(calls[2]!.at - calls[1]!.at, 'waited for the hint').toBeGreaterThanOrEqual(280)
    expect(rowsOf(s.tenant)).toEqual({ [row({ __name__: 'job:up:sum', job: 'api' }, t1)]: '1' })
    expect((await rulesOf(s))[0]!.health).toBe('ok')
    // One unavailable: retried, written.
    services.refuse = ['unavailable: ingest shard did not answer; retry']
    await tick(s)
    expect(callsOf(s).slice(3).map((c) => c.outcome.split(':')[0])).toEqual(['unavailable', 'ok'])
    expect((await rulesOf(s))[0]!.health).toBe('ok')
    expect(await dropped(s)).toBe(0)
    // Three in a row: given up on, reported and counted.
    services.refuse = ['unavailable: one', 'unavailable: two', 'unavailable: three']
    await tick(s)
    expect(callsOf(s).slice(5).map((c) => c.outcome)).toEqual(['unavailable: one', 'unavailable: two', 'unavailable: three'])
    expect((await rulesOf(s))[0]!.lastError).toBe('sink: unavailable: three')
    expect(await dropped(s)).toBe(1)
    expect(remoteWrites()).toEqual([])
  })

  it('too_large: the call is split by whole batches until each fits; a batch too large alone is reported, and the others are written', async () => {
    const s = await provisioned('rs-big')
    const width = new Map<string, number>([['r1', 1], ['r2', 1], ['r3', 1]])
    s.w.evaluate = (q) => {
      const r = /^sum by \(job\) \((r\d)\)$/.exec(q)![1]!
      return vec(...Array.from({ length: width.get(r)! }, (_, i) => [{ job: `j${i}` }, 1] as [Record<string, string>, number]))
    }
    await putGroup(s, ['r1', 'r2', 'r3'].map((r) => ({ record: `${r}:sum`, expr: `sum by (job) (${r})` })))
    services.maxSamplesPerCall = 2
    const t1 = await tick(s)
    let calls = callsOf(s)
    expect(calls.map((c) => [c.batches.length, c.outcome.split(':')[0]])).toEqual([[3, 'too_large'], [2, 'ok'], [1, 'ok']])
    // Batches go whole: each one that was written carries every sample of its rule.
    expect(calls.filter((c) => c.outcome === 'ok').flatMap((c) => c.batches.map((b) => b.samples.length))).toEqual([1, 1, 1])
    expect(Object.keys(rowsOf(s.tenant)).sort()).toEqual(['r1:sum', 'r2:sum', 'r3:sum'].map((n) => row({ __name__: n, job: 'j0' }, t1)).sort())
    expect((await rulesOf(s)).map((r) => r.health)).toEqual(['ok', 'ok', 'ok'])
    // r1 now records three series: too large alone.
    width.set('r1', 3)
    const t2 = await tick(s)
    calls = callsOf(s).slice(3)
    expect(calls.map((c) => [c.batches.length, c.outcome.split(':')[0]])).toEqual([[3, 'too_large'], [2, 'too_large'], [1, 'too_large'], [1, 'ok'], [1, 'ok']])
    const rows = Object.keys(rowsOf(s.tenant)).filter((k) => k.endsWith(`|${t2}`))
    expect(rows.sort()).toEqual(['r2:sum', 'r3:sum'].map((n) => row({ __name__: n, job: 'j0' }, t2)).sort())
    expect((await rulesOf(s))[0]!.lastError).toMatch(/^sink: too_large: 3 samples in one call/)
    expect(remoteWrites()).toEqual([])
  })
})

describe('upgrade in place: an ingest release without the entrypoint', () => {
  it('during a rollback window the same samples go through Remote Write with the service key; once the entrypoint answers again, Remote Write is not used', async () => {
    const s = await provisioned('rs-old')
    s.w.evaluate = () => vec([{ job: 'api' }, 3.5], [{ job: 'web' }, '+Inf'])
    await putGroup(s, [RECORD])
    // viz-ingest rolled back below the release that added RecordedSamples, while this ruler release still runs.
    s.w.sinkBinding = 'OLD_SINK'
    const t1 = await tick(s)
    expect(callsOf(s)).toEqual([]) // the old release has no entrypoint to answer
    const writes = remoteWrites()
    expect(writes).toHaveLength(1)
    expect(writes[0]!.tenant).toBe(s.tenant)
    expect(writes[0]!.authorization).toMatch(/^Bearer viz_/)
    expect(writes[0]!.series!.map((x) => [x.labels, x.samples]).sort((p, q) => (JSON.stringify(p) < JSON.stringify(q) ? -1 : 1))).toEqual([
      [{ __name__: 'job:up:sum', job: 'api' }, [[t1, 3.5]]],
      [{ __name__: 'job:up:sum', job: 'web' }, [[t1, Infinity]]],
    ])
    expect((await rulesOf(s)).map((r) => [r.health, r.lastError])).toEqual([['ok', null]])
    expect(await dropped(s)).toBe(0)
    // Said in the log, without the key.
    const key = writes[0]!.authorization!.slice('Bearer '.length)
    expect(logged.filter((l) => /did not answer by its contract/.test(l))).toHaveLength(1)
    for (const l of logged) expect(l).not.toContain(key)
    // viz-ingest is back on the release with the entrypoint.
    s.w.sinkBinding = 'SINK'
    const t2 = await tick(s)
    expect(remoteWrites()).toHaveLength(1)
    expect(callsOf(s).map((c) => c.outcome)).toEqual(['ok'])
    expect(rowsOf(s.tenant)).toEqual({
      [row({ __name__: 'job:up:sum', job: 'api' }, t2)]: '3.5',
      [row({ __name__: 'job:up:sum', job: 'web' }, t2)]: '+Inf',
    })
  })
})

describe('duplicate delivery after a crash', () => {
  it('a crash after the samples were written, before the tick committed: the replay sends the same batches again, and the write path holds one value per series and time', async () => {
    const s = await provisioned('rs-crash')
    s.w.evaluate = (q) => (q === RECORD.expr ? vec([{ job: 'api' }, 3.5], [{ job: 'web' }, '+Inf']) : vec([{ instance: 'a' }, 1]))
    await putGroup(s, [RECORD, { alert: 'Up', expr: 'up > 0' }])
    const at = ok(await s.ruler.health(s.tenant)).alarmAtMs as number
    world.now = at
    s.w.faults.add('ruler:commit')
    const crashed = await runInDurableObject(s.ruler as DurableObjectStub<TestRuler>, (inst) => inst.alarm()).then(
      () => false,
      (e) => e instanceof Crash || /injected crash/.test(String(e)),
    )
    expect(crashed).toBe(true)
    expect(callsOf(s)).toHaveLength(1) // written before the crash
    await evictDurableObject(s.ruler)
    // The retried alarm evaluates the same tick again.
    await runInDurableObject(s.ruler as DurableObjectStub<TestRuler>, (inst) => inst.alarm())
    const calls = callsOf(s)
    expect(calls.map((c) => c.outcome)).toEqual(['ok', 'ok'])
    expect(calls[1]!.batches).toEqual(calls[0]!.batches) // the same ids, samples and time
    expect(calls[0]!.batches.map((b) => b.id)).toEqual([expect.stringMatching(new RegExp(`^${s.tenant}/0/rec/.+@${at}$`))])
    expect(rowsOf(s.tenant)).toEqual({
      [row({ __name__: 'job:up:sum', job: 'api' }, at)]: '3.5',
      [row({ __name__: 'job:up:sum', job: 'web' }, at)]: '+Inf',
    })
    // The alert's transition was handed off once, and nothing was counted as dropped.
    expect(s.w.ingestCalls.flat().map((u) => [u.labels.instance, u.status])).toEqual([['a', 'firing']])
    expect(await dropped(s)).toBe(0)
  })
})
